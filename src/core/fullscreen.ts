import {
  HINT_DELAY_MS,
  HINT_SNOOZE_MS,
  browserFullscreenHint,
  htmlFullscreenHint
} from '../shared/fullscreenHint'
import { siteKey } from '../shared/pageControls'
import { formatBinding } from '../shared/shortcuts'
import type { Browser } from './browser'
import type { KeyEventInput } from './platform'
import type { ZenWindow } from './window'

/** Esc held this long leaves the window's fullscreen (Chrome's `kHoldEscapeTime`). */
export const ESCAPE_HOLD_MS = 1500

/**
 * A press-and-hold Esc: `down` starts the clock (a key repeat does not restart it), `up` or
 * `cancel` stops it, and `onHeld` runs once the key was down for `ESCAPE_HOLD_MS`. Timers are
 * injected so the rule can be tested without waiting.
 */
export class EscapeHold {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly onHeld: () => void,
    private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (
      fn,
      ms
    ) => setTimeout(fn, ms),
    private readonly clearTimer: (t: ReturnType<typeof setTimeout>) => void = (t) => clearTimeout(t)
  ) {}

  get holding(): boolean {
    return this.timer !== null
  }

  down(): void {
    if (this.timer !== null) return
    this.timer = this.setTimer(() => {
      this.timer = null
      this.onHeld()
    }, ESCAPE_HOLD_MS)
  }

  up(): void {
    this.cancel()
  }

  cancel(): void {
    if (this.timer === null) return
    this.clearTimer(this.timer)
    this.timer = null
  }
}

/**
 * Chrome's fullscreen hints and exits. Two fullscreens meet here: the window's own (F11; the
 * chrome hides and the page fills the window) and a page's element in fullscreen (`enter-html-
 * full-screen`; the engine's Esc handling leaves it). On entering either, the hint comes up in
 * the page after 500 ms – the page covers the chrome, so the page script draws it – and fades
 * after 3.8 s. A site's element-fullscreen hint is snoozed for 15 minutes once shown, so a
 * video player toggling fullscreen does not nag. A page that locked the keyboard (a remote
 * desktop) keeps Esc, so the hint says to hold Esc, which the engine's keyboard-lock controller
 * honours; the window's own fullscreen leaves on Esc held 1.5 s as well as on F11.
 */
export class FullscreenService {
  /** Site key → the time until which its element-fullscreen hint stays quiet. */
  private readonly snoozed = new Map<string, number>()
  /** Tabs whose page asked for the keyboard lock since its last navigation. */
  private readonly keyboardLocked = new Set<string>()
  /** Hints waiting out their 500 ms, by tab. */
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>()
  /** The last fullscreen flag seen per window, to tell an entry from any other state change. */
  private readonly windowFullscreen = new Map<string, boolean>()
  /** The window whose Esc hold is running. */
  private holdWindow: ZenWindow | null = null
  private readonly hold: EscapeHold

  constructor(
    private readonly browser: Browser,
    private readonly now: () => number = Date.now
  ) {
    this.hold = new EscapeHold(() => {
      const win = this.holdWindow
      this.holdWindow = null
      if (win?.alive && win.host.isFullScreen() && !win.htmlFullscreenTabId)
        this.browser.toggleFullscreen(win)
    })
  }

  // ---------------------------------------------------------------------------
  // Keyboard lock
  // ---------------------------------------------------------------------------

  /**
   * The page asked to lock the keyboard (`navigator.keyboard.lock`): Esc is the page's now. A
   * page already in fullscreen gets its hint back, snoozed or not, as Chrome's keyboard-lock
   * controller forces the bubble: the way out changed to holding Esc.
   */
  keyboardLockRequested(tabId: string): void {
    if (this.keyboardLocked.has(tabId)) return
    this.keyboardLocked.add(tabId)
    if (this.browser.tabs.windowFor(tabId).htmlFullscreenTabId === tabId)
      this.showHtmlHint(tabId, true)
  }

  /** Whether the tab's page holds (or asked for) the keyboard lock. */
  isKeyboardLocked(tabId: string): boolean {
    return this.keyboardLocked.has(tabId)
  }

  /** A new document starts without a lock, and without a hint waiting for the old one. */
  onNavigated(tabId: string): void {
    this.keyboardLocked.delete(tabId)
    this.cancelHint(tabId)
  }

  onTabGone(tabId: string): void {
    this.keyboardLocked.delete(tabId)
    this.cancelHint(tabId)
  }

  // ---------------------------------------------------------------------------
  // A page's element in fullscreen
  // ---------------------------------------------------------------------------

  /** The tab's page entered (or left) HTML fullscreen. */
  onHtmlFullscreen(tabId: string, entered: boolean): void {
    this.cancelHint(tabId)
    if (!entered) {
      this.browser.tabs.view(tabId)?.showHint?.(null)
      return
    }
    this.showHtmlHint(tabId, false)
  }

  /** The element-fullscreen hint after its delay; `force` shows it through the site's snooze. */
  private showHtmlHint(tabId: string, force: boolean): void {
    const tabs = this.browser.tabs
    const tab = tabs.tab(tabId)
    const view = tabs.view(tabId)
    if (!tab || !view?.showHint) return
    const host = hostOf(tab.url)
    const key = siteKey(tab.url) ?? host
    if (!force && this.isSnoozed(key)) return
    this.schedule(tabId, () => {
      const win = tabs.windowFor(tabId)
      if (win.htmlFullscreenTabId !== tabId) return
      this.snooze(key)
      view.showHint?.(htmlFullscreenHint(this.keyboardLocked.has(tabId), this.browser.darkScheme()))
    })
  }

  isSnoozed(key: string): boolean {
    const until = this.snoozed.get(key)
    if (until === undefined) return false
    if (until > this.now()) return true
    this.snoozed.delete(key)
    return false
  }

  private snooze(key: string): void {
    this.snoozed.set(key, this.now() + HINT_SNOOZE_MS)
  }

  // ---------------------------------------------------------------------------
  // The window's fullscreen (F11)
  // ---------------------------------------------------------------------------

  /** The window's flags changed: on entering fullscreen the exit hint is due in the active page. */
  onWindowStateChanged(win: ZenWindow): void {
    if (!win.alive) return
    const fullscreen = win.host.isFullScreen()
    const before = this.windowFullscreen.get(win.id) ?? false
    if (fullscreen === before) return
    this.windowFullscreen.set(win.id, fullscreen)
    // Its pages' `display-mode` is `fullscreen` now (or no longer), as in Chrome.
    this.browser.pushDisplayMode(win)
    // A kiosk has no way out to hint at (Chrome's kiosk mode shows no exit bubble either).
    if (win.host.kiosk) return
    const active = this.browser.tabs.activeTabFor(win)
    if (!fullscreen) {
      if (this.holdWindow === win) {
        this.hold.cancel()
        this.holdWindow = null
      }
      if (active) {
        this.cancelHint(active.id)
        // The page's own fullscreen has its own hint and keeps it.
        if (win.htmlFullscreenTabId !== active.id)
          this.browser.tabs.view(active.id)?.showHint?.(null)
      }
      return
    }
    // A page going fullscreen takes the window along on some platforms: its hint is the one.
    if (win.htmlFullscreenTabId || !active) return
    const view = this.browser.tabs.view(active.id)
    if (!view?.showHint) return
    this.schedule(active.id, () => {
      if (!win.alive || !win.host.isFullScreen() || win.htmlFullscreenTabId) return
      if (this.browser.tabs.activeTabFor(win)?.id !== active.id) return
      view.showHint?.(browserFullscreenHint(this.fullscreenShortcut(), this.browser.darkScheme()))
    })
  }

  onWindowClosed(win: ZenWindow): void {
    this.windowFullscreen.delete(win.id)
    if (this.holdWindow === win) {
      this.hold.cancel()
      this.holdWindow = null
    }
  }

  /** "F11" on Windows and Linux, the platform's binding on macOS. */
  fullscreenShortcut(): string {
    const shortcut = this.browser.state.shortcuts.find((s) => s.action === 'page.fullscreen')
    const bound = shortcut?.binding ?? shortcut?.extraBindings[0] ?? null
    return bound ? formatBinding(bound, this.browser.state.platform) : 'F11'
  }

  /**
   * Esc in a fullscreen window (from the chrome or a page): held 1.5 s it leaves the window's
   * fullscreen; a short press is left to whoever else wants it (the page's own fullscreen has
   * the engine's Esc). Returns false always: the key itself goes on.
   */
  onEscape(input: KeyEventInput, win: ZenWindow): boolean {
    if (input.key !== 'Escape') return false
    if (input.type === 'keyUp') {
      if (this.holdWindow === win) {
        this.hold.up()
        this.holdWindow = null
      }
      return false
    }
    if (input.type !== 'keyDown' || input.isAutoRepeat) return false
    if (input.alt || input.control || input.meta || input.shift) return false
    if (!win.alive || !win.host.isFullScreen() || win.htmlFullscreenTabId) return false
    // Esc held leaves a kiosk no more than F11 does.
    if (win.host.kiosk) return false
    if (this.holdWindow && this.holdWindow !== win) this.hold.cancel()
    this.holdWindow = win
    this.hold.down()
    return false
  }

  // ---------------------------------------------------------------------------

  private schedule(tabId: string, show: () => void): void {
    this.cancelHint(tabId)
    this.pending.set(
      tabId,
      setTimeout(() => {
        this.pending.delete(tabId)
        show()
      }, HINT_DELAY_MS)
    )
  }

  private cancelHint(tabId: string): void {
    const timer = this.pending.get(tabId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.pending.delete(tabId)
  }
}

/** The host the hint names: "youtube.com", "localhost:8787"; a file's or internal page's scheme. */
export function hostOf(url: string): string {
  try {
    const u = new URL(url)
    if (u.host) return u.host
    return u.protocol.replace(/:$/, '')
  } catch {
    return url
  }
}
