import { BLANK_URL, isEmptyTabUrl } from '@shared/url'
import type { Tab } from '@shared/types'
import type { Browser } from '@core/browser'
import { tabVisibleIn } from '@core/model'
import type { ZenWindow } from '@core/window'
import type { Bridge } from './bridge'

/**
 * The blank tab #490's first tab left in every phone profile made on v0.4.71–v0.4.76
 * (`Browser.ensureFirstTab` opened one `zen://blank` tab for a startup window without a tab; #503
 * stopped that on a host without the new tab page): restored, it shows the phone's new tab page
 * where the space was EMPTY before #490 – the phone's own view with no tab. Closed here, once,
 * right after `browser.start()` and before anything of this boot opens a tab (the widget's or a
 * shortcut's landing, an intent's page), so the space is empty again and READY's arm reads the
 * healed state. Only the tab that rule made can match: on the phone (the tablet placed and kept
 * #490's tab as a page view; what it shows is the coordinator's question, not this seam's), the
 * window's ACTIVE tab, exactly `zen://blank`, the ONLY tab the active space has in this window
 * (a blank tab among other restored tabs stays, where Chrome keeps a new tab page tab too), and
 * never navigated – no back/forward stack in the profile (`BrowserState.tabNavigation`, what a
 * restored tab carries of its history) and none on the tab. A blank tab the user opened and left
 * alone as the space's only tab is the same tab to every rule here and goes the same way: the
 * pre-#490 empty space stands in for it. Returns whether a tab was closed. A healed profile has
 * no such tab and heals no further.
 */
export function healRestoredBlankTab(browser: Browser, win: ZenWindow, phone: boolean): boolean {
  if (!phone) return false
  const active = browser.tabs.activeTabFor(win)
  if (active === undefined || active.url !== BLANK_URL) return false
  if (!lonelyIn(browser, win, active) || hasHistory(browser, active)) return false
  browser.tabs.closeTab(active.id, false, win)
  return true
}

/** Whether `tab` is the only tab of the window's active space that the window shows. */
function lonelyIn(browser: Browser, win: ZenWindow, tab: Tab): boolean {
  const tabs = browser.state.model.tabs
  const own = win.activeSpace().tabIds.filter((id) => {
    const t = tabs[id]
    return t !== undefined && tabVisibleIn(t, win.id)
  })
  return own.length === 1 && own[0] === tab.id
}

/** Whether the profile holds a back/forward stack for `tab` with a page in it, or the tab says so. */
function hasHistory(browser: Browser, tab: Tab): boolean {
  if (tab.canGoBack || tab.canGoForward) return true
  const stack = browser.state.tabNavigation.get(tab.id)
  return stack !== undefined && stack.entries.some((entry) => !isEmptyTabUrl(entry.url))
}

/**
 * What `bootAndroid` arms READY with once the core has started: whether the boot has a page to
 * place – the active tab restored as a page view – before the first frame counts. A window with
 * no tab (the phone's first run, a space emptied of its tabs: `Browser.ensureFirstTab` opens no
 * tab on a host without the new tab page, the chrome draws its own surfaces there) and a chrome
 * page (a registry page the chrome draws) have no view, so there is nothing to wait for.
 *
 * Nor has the blank page on the phone (`phone`: the chrome's layout class as `lib/formFactor`
 * reads it): the phone draws its new tab page in the chrome for a `zen://blank` tab and leaves
 * that tab out of every layout report (`useLayoutReporter`), so its view is never placed – a
 * profile restored on it (one #490's first tab left behind, v0.4.71–v0.4.74) would hold READY to
 * the host's watchdog. The tablet places the blank view and waits for it as for any page.
 */
export function bootNeedsPlacement(browser: Browser, win: ZenWindow, phone: boolean): boolean {
  const active = browser.tabs.activeTabFor(win)
  if (active === undefined || browser.pages.isChromePage(active)) return false
  return !(phone && active.url === BLANK_URL)
}

/** The four sides as the host sends them and the chrome's store keeps them. */
export interface ReadyInsets {
  top: number
  right: number
  bottom: number
  left: number
}

/** What `ChromeReady` reads of the chrome's UI store (`@renderer/lib/ui`'s `uiStore`). */
export interface ReadyStore {
  get(): { insets: ReadyInsets }
  subscribe(listener: () => void): () => void
}

export interface ChromeReadyOptions {
  /** The insets the host measured for the boot payload (`BootInfo.insets`). */
  insets: ReadyInsets
  store: ReadyStore
  /** Where the theme's first paint is announced (`THEME_PAINTED_EVENT` on `window`). */
  paintTarget: EventTarget
  paintEvent: string
  /** `requestAnimationFrame`, injectable for the test. */
  frame?: (callback: () => void) => void
}

/**
 * The chrome's READY for the host (OS-26, OS-27): its first real frame, the moment the cold
 * start's splash may lift and the launch's mark (`reportFullyDrawn`) is set. Not a timer: four
 * facts, each from the thing itself, and one `chrome.ready` post on the frame after the last of
 * them –
 *
 * - the core has started (`browser.start()` returned with the session restored, the host's queue
 *   flushed): `arm`;
 * - the chrome has painted its theme: `useTheme` writes the variables on the root and announces
 *   `THEME_PAINTED_EVENT`, in an effect after React's first paint – so the first painted frame is
 *   the stylesheet's defaults, and the frame after the announcement is the chrome's own;
 * - the chrome has applied the insets the host last sent: `useMainEvents` subscribes to the
 *   sticky `insets` in an effect (#277's replay) and `applyHostInsets` writes them to the store
 *   and the root; READY reads the store against the host's number, so a frame laid out under the
 *   status bar never counts;
 * - the page slot is placed, when the boot has a page to place (a restored tab that is not a
 *   chrome page): the first `view.setBounds` sent AFTER the insets were applied – a placement
 *   from the inset-less first layout does not count, the re-measure that follows the insets does.
 *
 * Then one animation frame, so the post rides behind the frame that carries all four, and the
 * host confirms the paint itself (`postVisualStateCallback`, MainActivity.onChromeReady) before
 * it lifts the splash. The host's watchdog is the safety net for a boot that never gets here.
 */
export class ChromeReady {
  private expected: ReadyInsets
  private armed = false
  private needsPlacement = false
  private placedUnderInsets = false
  private themePainted = false
  private sent = false
  private readonly frame: (callback: () => void) => void
  private readonly unsubscribe: () => void
  private readonly onPainted: () => void

  constructor(
    private readonly bridge: Bridge,
    private readonly options: ChromeReadyOptions
  ) {
    this.expected = { ...options.insets }
    this.frame = options.frame ?? ((callback) => void requestAnimationFrame(() => callback()))
    this.unsubscribe = options.store.subscribe(() => this.check())
    this.onPainted = () => {
      this.themePainted = true
      this.check()
    }
    options.paintTarget.addEventListener(options.paintEvent, this.onPainted, { once: true })
  }

  /** The host sent new insets (the `insets` event): what the chrome must have applied moves with them. */
  hostInsets(insets: ReadyInsets): void {
    if (this.sent) return
    const moved =
      insets.top !== this.expected.top ||
      insets.right !== this.expected.right ||
      insets.bottom !== this.expected.bottom ||
      insets.left !== this.expected.left
    this.expected = {
      top: insets.top,
      right: insets.right,
      bottom: insets.bottom,
      left: insets.left
    }
    // A placement under the old insets is not one under these – whichever the host's event
    // reached first, the store or this call (boot.ts writes the store, then calls here, so the
    // store already holds the new numbers by now; the store's lag was never the test).
    if (moved) this.placedUnderInsets = false
    this.check()
  }

  /** A page view was placed (`view.setBounds`, `AndroidTabViewHost`). */
  placed(): void {
    if (this.sent) return
    if (this.insetsApplied()) this.placedUnderInsets = true
    this.check()
  }

  /** The core has started: `needsPlacement` when a page view must be placed before the frame counts. */
  arm(needsPlacement: boolean): void {
    if (this.sent) return
    this.armed = true
    this.needsPlacement = needsPlacement
    this.check()
  }

  /** The four facts as they stand, for the boot log. */
  get state(): {
    armed: boolean
    themePainted: boolean
    insetsApplied: boolean
    placed: boolean
    sent: boolean
  } {
    return {
      armed: this.armed,
      themePainted: this.themePainted,
      insetsApplied: this.insetsApplied(),
      placed: !this.needsPlacement || this.placedUnderInsets,
      sent: this.sent
    }
  }

  private insetsApplied(): boolean {
    const have = this.options.store.get().insets
    const want = this.expected
    return (
      have.top === want.top &&
      have.right === want.right &&
      have.bottom === want.bottom &&
      have.left === want.left
    )
  }

  private check(): void {
    if (this.sent || !this.armed || !this.themePainted || !this.insetsApplied()) return
    if (this.needsPlacement && !this.placedUnderInsets) return
    this.sent = true
    this.unsubscribe()
    this.options.paintTarget.removeEventListener(this.options.paintEvent, this.onPainted)
    this.frame(() => this.bridge.post('chrome.ready', {}))
  }
}
