/**
 * The state machine of `identity.launchWebAuthFlow`, with no host in it: the host opens the
 * provider's first page in a view of its own (a window on the desktop, a tab or a sheet on a
 * phone) and reports what happens to it; the flow ends on the first top-frame navigation back
 * to the extension's redirect origin (`https://<id>.chromiumapp.org/`, the whole URL being the
 * result), when the view closes (cancelled), when its page fails to load, when a silent flow
 * reaches a page that wants the user, or on the silent flow's timeout. An interactive flow shows
 * the view once a page has loaded; a silent one never does. Same events and errors as
 * `main/platform/extensionApi/identity.ts`, so either host can run on this.
 */
import {
  ERROR_INTERACTION_REQUIRED,
  ERROR_PAGE_LOAD_FAILED,
  ERROR_TIMEOUT,
  ERROR_USER_CANCELLED,
  IdentityError,
  isRedirectBack,
  type WebAuthFlowDetails
} from './identity'

/** What the view the provider's pages show in reports to the flow. */
export interface AuthViewEvents {
  /** A top-frame navigation is about to start, or was redirected, to `url`. */
  navigating(url: string): void
  /** The top frame finished loading a page (the provider's UI is up). */
  loaded(): void
  /** The top frame failed to load (network error, blocked, ...). */
  failed(): void
  /** The view was closed, by the user or by `close`. */
  closed(): void
}

/** The view the provider's pages show in. */
export interface AuthView {
  /** Bring the view up for the user (an interactive flow, or a silent one that needs them after all). */
  show(): void
  close(): void
}

export type OpenAuthView = (url: string, events: AuthViewEvents) => AuthView

export interface AuthFlowTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface WebAuthFlow {
  /** The URL the provider sent the user back with, or the flow's `IdentityError`. */
  readonly result: Promise<string>
  /** Ends the flow the way a closed view does (the extension is unloading). */
  cancel(): void
}

const REAL_TIMERS: AuthFlowTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export function runWebAuthFlow(
  extensionId: string,
  details: WebAuthFlowDetails,
  open: OpenAuthView,
  timers: AuthFlowTimers = REAL_TIMERS
): WebAuthFlow {
  let settle: (outcome: { url: string } | { error: string }) => void = () => undefined
  const result = new Promise<string>((resolve, reject) => {
    let done = false
    let timer: unknown = null
    let view: AuthView | null = null
    settle = (outcome) => {
      if (done) return
      done = true
      if (timer !== null) timers.clearTimeout(timer)
      view?.close()
      if ('url' in outcome) resolve(outcome.url)
      else reject(new IdentityError(outcome.error))
    }
    view = open(details.url, {
      navigating: (url) => {
        if (isRedirectBack(extensionId, url)) settle({ url })
      },
      loaded: () => {
        if (done) return
        // The provider is showing a page: an interactive flow shows it to the user; a silent
        // one has failed, unless the extension asked to wait for a redirect regardless.
        if (details.interactive) view?.show()
        else if (details.abortOnLoadForNonInteractive) settle({ error: ERROR_INTERACTION_REQUIRED })
      },
      failed: () => settle({ error: ERROR_PAGE_LOAD_FAILED }),
      closed: () => settle({ error: ERROR_USER_CANCELLED })
    })
    // A view that reported inside `open` already ended the flow before it could be closed.
    if (done) view.close()
    else if (!details.interactive) {
      timer = timers.setTimeout(
        () => settle({ error: ERROR_TIMEOUT }),
        details.timeoutMsForNonInteractive
      )
    }
  })
  return { result, cancel: () => settle({ error: ERROR_USER_CANCELLED }) }
}
