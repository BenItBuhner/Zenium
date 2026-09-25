import type { HandlerDetails, WebContents, WindowOpenHandlerResponse } from 'electron'
import type {
  TabView,
  TabViewEvents,
  WindowOpenDisposition,
  WindowOpenTicket
} from '../../core/platform'
import type { ZenWindow } from '../../core/window'
import { openedWindowKind, planWindowOpen } from '../../core/windowOpen'
import { newId } from '../../shared/ids'
import type { Rect, Tab, WindowChrome, WindowKind } from '../../shared/types'
import type { ElectronTabView, ElectronTabViewHost } from './views'

/** What completing a popup's `window.open` needs from the browser. */
export interface PopupOpenerHost {
  /** The window the popup hangs from: where a new tab goes. */
  win: ZenWindow
  /** The window's active tab: the new tab sits next to it, in its space. */
  activeTabId: string | null
  /** `HostCapabilities.windows`: whether a sized open may become a window of its own. */
  windowsCapable: boolean
  createWindow(opts: {
    kind: WindowKind
    from: ZenWindow
    chrome: WindowChrome
    bounds: Rect | null
    empty: true
  }): ZenWindow
  adoptView(
    view: TabView,
    opts: { tabId: string; parentTabId: string | null; active: boolean },
    win: ZenWindow
  ): { tab: Tab; events: TabViewEvents }
}

/**
 * How an action popup's `window.open` – or a link it opens in a new tab or window – is
 * honoured: the ticket the host completes by adopting the page Chromium made for the call, or
 * null for a URL no page may open (the browser's own documents).
 *
 * Chrome gives an extension popup a real window for the call and no gesture is needed
 * (extension origins are exempt from its pop-up blocker), so the call's return value is a live
 * window: `window.open()` with no URL – libdot's noopener idiom, which Secure Shell's popup
 * uses to open its connection dialog: open an empty window, cut its opener, then set its
 * location – gets a page at about:blank that the caller navigates itself (the core plans the
 * empty page as it plans any page a script may open, `isOpenableUrl`). A sized open (Secure
 * Shell asks for 900x600 with `chrome=no`) becomes a toolbar-only window as it does from a
 * tab; everything else a tab next to the active one.
 */
export function popupWindowOpenTicket(
  url: string,
  disposition: WindowOpenDisposition,
  features: string,
  host: PopupOpenerHost
): WindowOpenTicket | null {
  const plan = planWindowOpen(url, disposition, features)
  if (plan.action === 'deny') return null
  const opensWindow = plan.action === 'window' && host.windowsCapable
  return {
    action: opensWindow ? 'window' : 'tab',
    url,
    adopt: (view) => {
      const target = opensWindow
        ? host.createWindow({
            kind: openedWindowKind(host.win.kind, plan.chrome),
            from: host.win,
            chrome: plan.chrome,
            bounds: plan.bounds,
            empty: true
          })
        : host.win
      return host.adoptView(
        view,
        { tabId: newId('tab'), parentTabId: opensWindow ? null : host.activeTabId, active: true },
        target
      )
    }
  }
}

/** The tab-view host's part in honouring a ticket, as `ElectronTabViewHost` provides it. */
export type TicketViews = Pick<ElectronTabViewHost, 'viewForTab' | 'openTicket'>

/** What an extension page's `window.open` handler needs from the browser. */
export interface ExtensionPageOpenHost {
  /** The tab-view host when the platform is Electron's; undefined leaves the links-as-tabs path. */
  views: TicketViews | undefined
  /**
   * The window the page hangs from when the call comes: an action popup's or a side panel's
   * own, an API-created popup window's the last focused window of its profile; undefined when
   * none is left.
   */
  windowFor(): ZenWindow | undefined
  browser: {
    tabs: {
      activeTabFor(win: ZenWindow): Tab | undefined
      createTab(options: { url: string; active: boolean }, win?: ZenWindow): unknown
      adoptView: PopupOpenerHost['adoptView']
    }
    state: { capabilities: { windows: boolean } }
    createWindow: PopupOpenerHost['createWindow']
  }
  /** Runs a tick after Chromium hands the new page over (the action popup closes here). */
  opened?(): void
  /**
   * Runs when the call took the links-as-tabs path instead: a site or extension URL opened as a
   * tab, anything else refused (the action popup closes here too).
   */
  fellBack?(): void
}

/**
 * The `setWindowOpenHandler` callback of an extension's own pages – the action popup, a side
 * panel, a `windows.create({ type: 'popup' })` window: Chrome gives each a real window for
 * `window.open`, so the page Chromium made for the call is adopted into a tab of the page's
 * window (next to its active tab) or, for a sized open, into a toolbar-only window, through
 * `popupWindowOpenTicket` and the tab path a tab's own `window.open` takes
 * (`ElectronTabViewHost.openTicket`). Without that path – no Electron views, no window or no
 * view for its active tab – or for a URL no page may open, a site or extension URL still opens
 * as a tab and the call gets null, the answer every one of these pages got before.
 */
export function extensionPageOpenHandler(
  host: ExtensionPageOpenHost
): (details: HandlerDetails) => WindowOpenHandlerResponse {
  return ({ url, disposition, features, referrer }) => {
    const views = host.views
    const win = host.windowFor()
    const active = win ? host.browser.tabs.activeTabFor(win) : undefined
    const opener: ElectronTabView | undefined =
      views && active ? views.viewForTab(active.id) : undefined
    const ticket =
      views && win && active && opener
        ? popupWindowOpenTicket(url, disposition as WindowOpenDisposition, features ?? '', {
            win,
            activeTabId: active.id,
            windowsCapable: host.browser.state.capabilities.windows,
            createWindow: (opts) => host.browser.createWindow(opts),
            adoptView: (page, opts, target) => host.browser.tabs.adoptView(page, opts, target)
          })
        : null
    if (!ticket || !views || !opener) {
      if (/^(https?|chrome-extension):/.test(url))
        host.browser.tabs.createTab({ url, active: true }, win)
      host.fellBack?.()
      return { action: 'deny' }
    }
    return {
      action: 'allow',
      outlivesOpener: true,
      createWindow: (options) => {
        const guest = (options as { webContents?: WebContents }).webContents
        const contents = views.openTicket(ticket, opener, guest, { httpReferrer: referrer })
        // A tick later: Chromium is still handing the new page over when this runs.
        setTimeout(() => host.opened?.(), 0)
        return contents
      }
    }
  }
}
