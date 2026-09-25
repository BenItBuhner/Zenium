import type {
  TabView,
  TabViewEvents,
  WindowOpenDisposition,
  WindowOpenTicket
} from '../../core/platform'
import type { ZenWindow } from '../../core/window'
import { isOpenableUrl, openedWindowKind, planWindowOpen } from '../../core/windowOpen'
import { newId } from '../../shared/ids'
import type { Rect, Tab, WindowChrome, WindowKind } from '../../shared/types'

/** Chromium reports `window.open()` with no URL as `about:blank`. */
const BLANK = 'about:blank'

/** What completing a popup's `window.open` needs from the browser. */
export interface PopupOpenerHost {
  /** The popup document's own address. */
  openerUrl: string
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
 * location – gets a page at about:blank that the caller navigates itself. A sized open (Secure
 * Shell asks for 900x600 with `chrome=no`) becomes a toolbar-only window as it does from a
 * tab; everything else a tab next to the active one.
 */
export function popupWindowOpenTicket(
  url: string,
  disposition: WindowOpenDisposition,
  features: string,
  host: PopupOpenerHost
): WindowOpenTicket | null {
  const blank = url === BLANK
  if (!blank && !isOpenableUrl(url)) return null
  // The core refuses about:blank as a page's target; the plan is read here for its placement
  // alone, so an empty open plans as the popup's own document would.
  const plan = planWindowOpen(blank ? host.openerUrl : url, disposition, features)
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
