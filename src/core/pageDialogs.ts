import type {
  AgentDialogAnswer,
  PageDialog,
  PageDialogAnswered,
  PageDialogKind,
  PageDialogResponse
} from '../shared/types'
import { newId } from '../shared/ids'
import type { Browser } from './browser'
import type { PageDialogRequest } from './platform'

export const CANCELLED: PageDialogResponse = { accepted: false, value: null }

/**
 * The line Chrome shows in a "Leave site?" / "Reload site?" dialog whatever the page's handler
 * set – and so the message a report of one carries (`PageDialogAnswered.message`).
 */
export const LEAVE_SITE_MESSAGE = 'Changes you made may not be saved.'

interface Pending {
  dialog: PageDialog
  resolve: (response: PageDialogResponse) => void
}

/**
 * The site a dialog is titled after, as Chrome shows it: the host of an http(s) page (the scheme
 * dropped), '' for pages without one (files, `data:` and `about:blank` documents, opaque origins),
 * which the chrome words as "This page says".
 */
export function dialogSite(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : ''
  } catch {
    return ''
  }
}

/** The words for a dialog's kind as an agent reads them: "a confirm dialog", 'a prompt (default "…")'… */
function describeKind(kind: PageDialogKind, defaultValue: string): string {
  return kind === 'alert'
    ? 'an alert'
    : kind === 'confirm'
      ? 'a confirm dialog'
      : kind === 'prompt'
        ? `a prompt${defaultValue ? ` (default ${JSON.stringify(defaultValue)})` : ''}`
        : 'a "Leave site?" dialog'
}

/** Which page of the tab opened the dialog: its site, an embedded frame's, or "the page" when unknown. */
function describeFrom(site: string, embedded: boolean): string {
  return site ? `${site}${embedded ? ' (an embedded frame)' : ''}` : 'the page'
}

/** One line for an agent: which page of its tab asked what. */
export function describeDialog(d: PageDialog): string {
  return `The page in tab ${d.tabId} (${describeFrom(d.site, d.embedded)}) opened ${describeKind(d.kind, d.defaultValue)}: ${JSON.stringify(d.message.slice(0, 500))}`
}

/** The words for the answer a dialog got without its agent: OK, Cancel, with "…", left, stayed. */
export function describeAnswer(answer: AgentDialogAnswer): string {
  if (typeof answer === 'object') return `with ${JSON.stringify(answer.text)}`
  switch (answer) {
    case 'ok':
      return 'OK'
    case 'cancel':
      return 'Cancel'
    case 'leave':
      return 'left'
    case 'stay':
      return 'stayed'
  }
}

/** What a report of an answered dialog names about the dialog itself. */
export type AnsweredDialog = Pick<
  PageDialog,
  'tabId' | 'kind' | 'site' | 'embedded' | 'message' | 'defaultValue'
>

/**
 * The `Notice:` line an agent reads when a dialog on one of its tabs was answered without it –
 * by its dialog policy (`browser_dialog_policy`) or by the default answer when no rule covered
 * the kind. Every host's report goes through this one builder (the core's own answers; what a
 * host that answers dialogs itself sends through `TabViewEvents.onPageDialogAnswered`), so an
 * agent reads the same words everywhere.
 */
export function describeAnsweredDialog(
  d: AnsweredDialog,
  answer: AgentDialogAnswer,
  byPolicy: boolean
): string {
  const by = byPolicy ? 'by your dialog policy' : '(no policy; browser_dialog_policy sets one)'
  return `Notice: the page in tab ${d.tabId} (${describeFrom(d.site, d.embedded)}) opened ${describeKind(d.kind, d.defaultValue)}: ${JSON.stringify(d.message.slice(0, 500))} – answered ${describeAnswer(answer)} ${by}.`
}

/** A host's report of a dialog it answered itself, as the Notice builder reads it. */
export function answeredDialogOf(tabId: string, report: PageDialogAnswered): AnsweredDialog {
  return {
    tabId,
    kind: report.kind,
    site: dialogSite(report.url),
    embedded: false,
    message: report.message,
    defaultValue: report.kind === 'prompt' ? report.defaultValue : ''
  }
}

/** Whether `frameUrl` belongs to another origin than the page's top document. */
export function isEmbeddedDialog(frameUrl: string, pageUrl: string): boolean {
  try {
    const frame = new URL(frameUrl)
    const page = new URL(pageUrl)
    // `about:srcdoc` and `about:blank` frames inherit their parent's origin.
    if (frame.protocol === 'about:') return false
    return frame.origin !== page.origin
  } catch {
    return false
  }
}

/**
 * The dialogs pages open – `alert`, `confirm`, `prompt` – and the "Leave site?" question a
 * `beforeunload` handler raises, shown by the chrome as tab-modal Zenium dialogs (Chrome's
 * behaviour; the engine's own message boxes never appear). The page's renderer waits for the
 * answer; hosts only report the call and forward the response.
 */
export class PageDialogService {
  private readonly pending: Pending[] = []

  constructor(private readonly browser: Browser) {}

  list(): PageDialog[] {
    return this.pending.map((p) => p.dialog)
  }

  /** Whether a dialog of `tabId` is waiting for an answer. */
  hasPending(tabId: string): boolean {
    return this.pending.some((p) => p.dialog.tabId === tabId)
  }

  /**
   * A page opened a dialog. Resolves once the user answered (an alert counts as accepted when
   * dismissed) or the dialog became moot (its tab went away, or is being checked for unload).
   * A dialog of a background tab waits, unseen, until its tab is on screen again.
   */
  ask(tabId: string, request: PageDialogRequest): Promise<PageDialogResponse> {
    if (!this.browser.tabs.tab(tabId)) return Promise.resolve(CANCELLED)
    const dialog: PageDialog = {
      id: newId('dialog'),
      kind: request.kind,
      tabId,
      site: dialogSite(request.frameUrl),
      embedded: isEmbeddedDialog(request.frameUrl, request.pageUrl),
      message: request.message,
      defaultValue: request.kind === 'prompt' ? request.defaultValue : ''
    }
    // An agent's page is the agent's to answer: the user never sees it, and the page – blocked
    // until it is answered – never waits on a tab the user is not looking at.
    const agents = this.browser.agents
    if (agents?.takesDialog(tabId))
      return agents.onPageDialog(dialog).then((r) => sanitizeResponse(dialog, r))
    return this.show(dialog)
  }

  /**
   * A page's `beforeunload` handler objects to the page going away: ask whether to leave. The
   * tab is brought to the front first, as Chrome does, since the dialog is tab-modal. Resolves
   * true when the user leaves (or the tab is gone), false when the page stays. An agent's own
   * navigation (and its page's) is answered by the agent's dialog policy – `stay` keeps the
   * page, anything else leaves – and reported to the agent (`AgentService.onLeaveSite`); its
   * tab is never brought in front of the user nor its window focused. A close or navigation
   * the USER makes on an agent's tab is the user's question, policy or not (`takesLeave`).
   */
  async confirmLeave(tabId: string, reload: boolean): Promise<boolean> {
    const tabs = this.browser.tabs
    const tab = tabs.tab(tabId)
    if (!tab) return true
    const agents = this.browser.agents
    if (agents?.takesLeave(tabId)) return agents.onLeaveSite(tabId, reload)
    // A host without the policy (`HostCapabilities.agentDialogPolicy`) keeps today's answer:
    // an agent's page leaves without a question, and the agent hears nothing of it.
    if (agents?.takesDialog(tabId) && !this.browser.platform.capabilities.agentDialogPolicy)
      return true
    const win = tabs.windowFor(tabId)
    if (tabs.activeTabFor(win)?.id !== tabId) tabs.activateTab(tabId, win)
    if (!win.host.isFocused()) win.host.focus()
    const answer = await this.show({
      id: newId('dialog'),
      kind: 'beforeunload',
      tabId,
      site: dialogSite(tab.url),
      embedded: false,
      message: reload ? 'reload' : 'leave',
      defaultValue: ''
    })
    return answer.accepted
  }

  /** The chrome answered (or dismissed) a dialog. */
  respond(id: string, response: PageDialogResponse): void {
    const i = this.pending.findIndex((p) => p.dialog.id === id)
    if (i < 0) return
    const [entry] = this.pending.splice(i, 1)
    this.browser.state.commitVolatile()
    entry.resolve(sanitizeResponse(entry.dialog, response))
  }

  /** A tab went away, or is about to be checked for unload: its dialogs are moot. */
  cancelForTab(tabId: string): void {
    for (const p of this.pending.filter((p) => p.dialog.tabId === tabId))
      this.respond(p.dialog.id, CANCELLED)
  }

  /** Queue the dialog; the chrome shows it once its tab is the one on screen (tab-modal). */
  private show(dialog: PageDialog): Promise<PageDialogResponse> {
    return new Promise((resolve) => {
      this.pending.push({ dialog, resolve })
      this.browser.state.commitVolatile()
    })
  }
}

/** Keep the answer within what the call can return: alerts are always accepted, only prompts carry text. */
function sanitizeResponse(dialog: PageDialog, response: PageDialogResponse): PageDialogResponse {
  if (dialog.kind === 'alert') return { accepted: true, value: null }
  if (dialog.kind !== 'prompt') return { accepted: response.accepted, value: null }
  return response.accepted
    ? { accepted: true, value: typeof response.value === 'string' ? response.value : '' }
    : CANCELLED
}
