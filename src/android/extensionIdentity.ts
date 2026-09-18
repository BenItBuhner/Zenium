import type { Browser } from '@core/browser'
import type { ZenWindow } from '@core/window'
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
import type { ViewEventPayloads } from './views'

/**
 * `chrome.identity` on Android, on the shared flow (`api/webAuthFlow.ts`). Until W2-2's auth
 * sheet, `launchWebAuthFlow` runs the provider's pages in a tab of the window: an interactive
 * flow opens it in front; a silent one loads it in the background and closes it again, unseen,
 * when the provider redirects straight back or (the usual case) its first page asks for the user.
 * The way back is Chrome's `https://<id>.chromiumapp.org/…`, which providers have registered:
 * Kotlin knows which tab is in a flow (`ext.authFlow`), cancels that tab's navigation there
 * before any request goes out and reports it as `ext.identityRedirect`; one that committed anyway
 * (a POST the WebView does not ask about) ends the flow from the tab's `navigated` event. The
 * emulated origin only ever serves the extension's files.
 *
 * `getAuthToken` needs Chrome's signed-in Google account and is refused, `getProfileUserInfo` is
 * empty, the token cache members are no-ops, all as on the desktop.
 */
export interface AuthTabHost {
  readonly browser: Browser
  window(): ZenWindow
  /** Tell Kotlin which extension's flow runs in the tab (null: none any more). */
  authFlowTab(tabId: string, extensionId: string | null): void
}

interface TabView {
  tabId: string
  extensionId: string
  events: AuthViewEvents
  closed: boolean
}

const NOT_IMPLEMENTED = 'is not implemented on Zenium for Android'

export class AndroidIdentity {
  /** Extension id → its running flow. */
  private readonly flows = new Map<string, WebAuthFlow>()
  /** Tab id → the flow view it carries. */
  private readonly tabs = new Map<string, TabView>()

  constructor(
    private readonly host: AuthTabHost,
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

  /** The tab an extension's flow runs in, if one is. */
  flowTab(extensionId: string): string | null {
    for (const [tabId, view] of this.tabs) if (view.extensionId === extensionId) return tabId
    return null
  }

  /** Kotlin cancelled the flow tab's navigation back to the redirect origin. */
  onRedirect(tabId: string, url: string): void {
    this.tabs.get(tabId)?.events.navigating(url)
  }

  /** The tab's view events, as the runtime receives them from Kotlin. */
  onViewEvent<K extends keyof ViewEventPayloads>(
    tabId: string,
    name: K,
    payload: ViewEventPayloads[K]
  ): void {
    const view = this.tabs.get(tabId)
    if (!view) return
    switch (name) {
      case 'navigated': {
        const p = payload as ViewEventPayloads['navigated']
        if (!p.inPage) view.events.navigating(p.url)
        return
      }
      case 'stopLoading':
        view.events.loaded()
        return
      case 'failLoad':
        view.events.failed()
        return
      case 'destroyed':
        this.tabGone(view)
        return
      default:
        return
    }
  }

  /** The state snapshot lost the tab (closed by the user, or by the flow itself). */
  onTabRemoved(tabId: string): void {
    const view = this.tabs.get(tabId)
    if (view) this.tabGone(view)
  }

  /** The extension is unloading: an open flow fails the way a closed tab does. */
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
        (url, events) => this.openTab(extensionId, url, details.interactive, events),
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

  private openTab(
    extensionId: string,
    url: string,
    interactive: boolean,
    events: AuthViewEvents
  ): AuthView {
    const win = this.host.window()
    const tab = this.host.browser.tabs.createTab({ url, active: interactive }, win)
    const view: TabView = { tabId: tab.id, extensionId, events, closed: false }
    this.tabs.set(tab.id, view)
    this.host.authFlowTab(tab.id, extensionId)
    return {
      show: () => {
        if (!view.closed) this.host.browser.tabs.activateTab(tab.id, win)
      },
      close: () => {
        if (view.closed) return
        this.forget(view)
        this.host.browser.tabs.closeTab(tab.id, true, win)
        view.events.closed()
      }
    }
  }

  /** The tab went away under the flow. */
  private tabGone(view: TabView): void {
    this.forget(view)
    view.events.closed()
  }

  private forget(view: TabView): void {
    view.closed = true
    this.tabs.delete(view.tabId)
    this.host.authFlowTab(view.tabId, null)
  }
}
