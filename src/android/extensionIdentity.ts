import {
  ERROR_FLOW_IN_PROGRESS,
  ERROR_GET_AUTH_TOKEN,
  IdentityError,
  emptyProfileUserInfo,
  normalizeWebAuthFlowDetails,
  redirectUrl
} from '@core/extensions/api/identity'
import {
  runWebAuthFlow,
  type AuthFlowTimers,
  type AuthView,
  type AuthViewEvents,
  type WebAuthFlow
} from '@core/extensions/api/webAuthFlow'

/**
 * `chrome.identity` on Android, on the shared flow (`api/webAuthFlow.ts`). `launchWebAuthFlow`
 * runs the provider's pages in an auth sheet of their own (`ExtensionAuthSheet.kt`: the v2 phone
 * sheet around a WebView on the regular profile, so a session the user already has with the
 * provider counts), hidden until the flow says so: an interactive flow shows it once the first
 * page has loaded, a silent one never does and ends unseen. The way back is Chrome's
 * `https://<id>.chromiumapp.org/…`, which providers have registered: Kotlin cancels the sheet's
 * navigation there before any request goes out and reports the URL as `navigating`; one that
 * committed anyway (a POST the WebView does not ask about) lands on an empty stand-in page and
 * reports the same. The emulated origin only ever serves the extension's files.
 *
 * `getAuthToken` needs Chrome's signed-in Google account and is refused, `getProfileUserInfo` is
 * empty, the token cache members are no-ops, all as on the desktop.
 */
export interface AuthSheetHost {
  /** Open the provider's first page in a new, hidden auth sheet known to Kotlin as `viewId`. */
  openAuthSheet(viewId: number, extensionId: string, url: string): void
  /** Bring the sheet up for the user. */
  showAuthSheet(viewId: number): void
  /** Take the sheet down without a `closed` event. */
  closeAuthSheet(viewId: number): void
}

/** What Kotlin reports about an auth sheet (`ext.authView`). */
export type AuthSheetEvent = 'navigating' | 'loaded' | 'failed' | 'closed'

export interface AuthSheetEventPayload {
  viewId: number
  event: AuthSheetEvent
  url?: string
}

interface SheetView {
  viewId: number
  extensionId: string
  events: AuthViewEvents
  closed: boolean
}

const NOT_IMPLEMENTED = 'is not implemented on Zenium for Android'

export class AndroidIdentity {
  /** Extension id → its running flow. */
  private readonly flows = new Map<string, WebAuthFlow>()
  /** Sheet id → the flow view it carries. */
  private readonly views = new Map<number, SheetView>()
  private nextViewId = 1

  constructor(
    private readonly host: AuthSheetHost,
    private readonly timers?: AuthFlowTimers
  ) {}

  /** A routed `chrome.identity.<method>` call. */
  call(extensionId: string, method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'launchWebAuthFlow':
        return this.launchWebAuthFlow(extensionId, args[0])
      case 'getRedirectURL':
        return Promise.resolve(redirectUrl(extensionId, args[0]))
      case 'getProfileUserInfo':
        return Promise.resolve(emptyProfileUserInfo())
      case 'getAuthToken':
        return Promise.reject(new Error(ERROR_GET_AUTH_TOKEN))
      case 'removeCachedAuthToken':
      case 'clearAllCachedAuthTokens':
        return Promise.resolve(undefined)
      case 'getAccounts':
        return Promise.resolve([])
      default:
        return Promise.reject(new Error(`chrome.identity.${method} ${NOT_IMPLEMENTED}`))
    }
  }

  /** Whether a flow is running for the extension. */
  running(extensionId: string): boolean {
    return this.flows.has(extensionId)
  }

  /** The sheet an extension's flow runs in, if one is. */
  flowSheet(extensionId: string): number | null {
    for (const [viewId, view] of this.views) if (view.extensionId === extensionId) return viewId
    return null
  }

  /** What happened to a sheet, as Kotlin reports it. */
  onSheetEvent(payload: AuthSheetEventPayload): void {
    const view = this.views.get(payload.viewId)
    if (!view) return
    switch (payload.event) {
      case 'navigating':
        if (typeof payload.url === 'string') view.events.navigating(payload.url)
        return
      case 'loaded':
        view.events.loaded()
        return
      case 'failed':
        view.events.failed()
        return
      case 'closed':
        // The user dismissed it (the flow's own close never reports back).
        this.forget(view)
        view.events.closed()
        return
    }
  }

  /** The extension is unloading: an open flow fails the way a dismissed sheet does. */
  unload(extensionId: string): void {
    this.flows.get(extensionId)?.cancel()
  }

  private launchWebAuthFlow(extensionId: string, raw: unknown): Promise<string> {
    let flow: WebAuthFlow
    try {
      const details = normalizeWebAuthFlowDetails(raw)
      if (this.flows.has(extensionId)) throw new IdentityError(ERROR_FLOW_IN_PROGRESS)
      flow = runWebAuthFlow(
        extensionId,
        details,
        (url, events) => this.openSheet(extensionId, url, events),
        this.timers
      )
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    this.flows.set(extensionId, flow)
    const done = (): void => {
      if (this.flows.get(extensionId) === flow) this.flows.delete(extensionId)
    }
    flow.result.then(done, done)
    return flow.result
  }

  private openSheet(extensionId: string, url: string, events: AuthViewEvents): AuthView {
    const viewId = this.nextViewId++
    const view: SheetView = { viewId, extensionId, events, closed: false }
    this.views.set(viewId, view)
    this.host.openAuthSheet(viewId, extensionId, url)
    return {
      show: () => {
        if (!view.closed) this.host.showAuthSheet(viewId)
      },
      close: () => {
        if (view.closed) return
        this.forget(view)
        this.host.closeAuthSheet(viewId)
        view.events.closed()
      }
    }
  }

  private forget(view: SheetView): void {
    view.closed = true
    this.views.delete(view.viewId)
  }
}

/** Shapes an `ext.authView` host event, or null for one the runtime cannot use. */
export function authSheetEvent(raw: unknown): AuthSheetEventPayload | null {
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Record<string, unknown>
  if (typeof p.viewId !== 'number') return null
  if (
    p.event !== 'navigating' &&
    p.event !== 'loaded' &&
    p.event !== 'failed' &&
    p.event !== 'closed'
  )
    return null
  return {
    viewId: p.viewId,
    event: p.event,
    url: typeof p.url === 'string' ? p.url : undefined
  }
}
