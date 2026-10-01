import type { PageDialog, PageDialogResponse } from '../shared/types'
import { newId } from '../shared/ids'
import type { Browser } from './browser'
import type { PageDialogRequest } from './platform'

export const CANCELLED: PageDialogResponse = { accepted: false, value: null }

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

/** One line for an agent: which page of its tab asked what. */
export function describeDialog(d: PageDialog): string {
  const from = d.site ? `${d.site}${d.embedded ? ' (an embedded frame)' : ''}` : 'the page'
  const what =
    d.kind === 'alert'
      ? 'an alert'
      : d.kind === 'confirm'
        ? 'a confirm dialog'
        : d.kind === 'prompt'
          ? `a prompt${d.defaultValue ? ` (default ${JSON.stringify(d.defaultValue)})` : ''}`
          : 'a "Leave site?" dialog'
  return `The page in tab ${d.tabId} (${from}) opened ${what}: ${JSON.stringify(d.message.slice(0, 500))}`
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
   * true when the user leaves (or the tab is gone), false when the page stays. An agent's page
   * leaves without a question: the agent asked for the navigation or the close, and its tab is
   * never brought in front of the user nor its window focused.
   */
  async confirmLeave(tabId: string, reload: boolean): Promise<boolean> {
    const tabs = this.browser.tabs
    const tab = tabs.tab(tabId)
    if (!tab) return true
    if (this.browser.agents?.takesDialog(tabId)) return true
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
