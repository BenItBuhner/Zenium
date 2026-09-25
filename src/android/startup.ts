import type { Browser } from '@core/browser'
import type { ZenWindow } from '@core/window'
import type { Bridge } from './bridge'

/**
 * What `bootAndroid` arms READY with once the core has started: whether the boot has a page to
 * place – the active tab restored as a page view – before the first frame counts. A window with
 * no tab (the phone's first run, a space emptied of its tabs: `Browser.ensureFirstTab` opens no
 * tab on a host without the new tab page, the chrome draws its own surfaces there) and a chrome
 * page (the new tab page) have no view, so there is nothing to wait for.
 */
export function bootNeedsPlacement(browser: Browser, win: ZenWindow): boolean {
  const active = browser.tabs.activeTabFor(win)
  return active !== undefined && !browser.pages.isChromePage(active)
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
