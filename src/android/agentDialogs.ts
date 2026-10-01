import type { PageDialogRequest } from '@core/platform'
import type { PageDialogResponse } from '@shared/types'

/**
 * The Android side of an AI agent's page dialogs (OS-40 part B; `HostCapabilities.agentDialogs`,
 * `browser_handle_dialog`): while an agent drives a page the layout hides (`TabView.setAgentDriven`,
 * Kotlin's `TabWebView.agentDriven`), the page's `alert` / `confirm` / `prompt` is not Zenium's
 * native sheet – nobody is looking at the page, and the WebView's one renderer waits in the call
 * – but a `pageDialog` view event Kotlin raises with the `JsResult` held. The core routes it as it
 * routes the desktop's (`PageDialogService.ask` → `takesDialog` → `agents.onPageDialog`), and the
 * answer goes back as `view.pageDialogAnswer`. A tab that turns out not to be an agent's gets
 * `user`: Kotlin shows the sheet it would have, since the chrome cannot (its own script waits in
 * the same call). Kept pure so the shapes are tested without a bridge. Nothing the agent answers
 * is remembered for the user: Kotlin keeps an agent's dialog out of the visit's count and its
 * "Don't let this page create more dialogs"; the two-minute default is the core's.
 */

/** The kinds a page's call can be (`PageDialogRequest.kind`); a `beforeunload` is decided by Kotlin (`UnloadObjection`). */
const KINDS: ReadonlySet<string> = new Set(['alert', 'confirm', 'prompt'])

/** What Kotlin's `pageDialog` view event carries (`AgentPageDialogs.event`). */
export interface PageDialogEvent {
  dialogId: string
  kind?: unknown
  message?: unknown
  defaultValue?: unknown
  frameUrl?: unknown
  pageUrl?: unknown
}

/**
 * The core's `PageDialogRequest` for a dialog Kotlin holds, or null for an event the core
 * cannot be asked about (no id, an unknown kind): Kotlin then hears a dismissal, never a sheet.
 */
export function pageDialogRequestOf(event: PageDialogEvent): PageDialogRequest | null {
  if (typeof event?.dialogId !== 'string' || !event.dialogId) return null
  if (typeof event.kind !== 'string' || !KINDS.has(event.kind)) return null
  const kind = event.kind as PageDialogRequest['kind']
  return {
    kind,
    message: typeof event.message === 'string' ? event.message : '',
    defaultValue:
      kind === 'prompt' && typeof event.defaultValue === 'string' ? event.defaultValue : '',
    frameUrl: typeof event.frameUrl === 'string' ? event.frameUrl : '',
    pageUrl: typeof event.pageUrl === 'string' ? event.pageUrl : ''
  }
}

/** The `view.pageDialogAnswer` command's payload (without the tab and dialog ids). */
export type PageDialogAnswerWire =
  { user: true } | { user: false; accepted: boolean; value: string | null }

/** The core's answer as the bridge carries it to Kotlin (`AgentPageDialogs.answer`). */
export function pageDialogAnswerWire(response: PageDialogResponse): PageDialogAnswerWire {
  return {
    user: false,
    accepted: response.accepted === true,
    value: response.accepted === true && typeof response.value === 'string' ? response.value : null
  }
}

/** The word that hands a held dialog back to Kotlin's own sheet: the tab is not an agent's. */
export const USER_DIALOG: PageDialogAnswerWire = { user: true }

/**
 * What the views ask the core's agent service about a held dialog (`AndroidPlatform.bind` points
 * these at `browser.agents`): whose the dialog is before the core is asked to route it – a tab
 * the core would show the dialog for itself has no chrome to show it on here – and the word
 * that a dialog Kotlin dropped (the flag went, the view did) waits for nobody.
 */
export interface AgentDialogHooks {
  takes(tabId: string): boolean
  dismiss(tabId: string): void
}
