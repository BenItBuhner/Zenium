import { formatBinding } from '../shared/shortcuts'
import { resolveTheme, rgbToHex } from '../shared/theme'
import type { QuitHoldPanel } from '../shared/quitHoldPanel'
import type { QuitHoldState } from '../shared/types'
import type { Browser } from './browser'
import type { TabView } from './platform'
import type { ZenWindow } from './window'

/** The quit chord held this long quits (Chrome's `kTimeToConfirmQuit`, `confirm_quit_panel_controller.mm`). */
export const QUIT_HOLD_MS = 1500

/**
 * Chrome's hold-to-quit (session-08): on macOS, while "Warn Before Quitting (⌘Q)" is set, the
 * quit chord does not quit on its press – "Hold ⌘Q to quit" comes up over the front window with
 * the hold's progress, and the app quits once the keys were down for {@link QUIT_HOLD_MS}. A key
 * coming up before that ends the hold and nothing quits. The hold is the confirmation (design
 * language v2 §10.5): a quit it agreed to skips the tab-count question, and keeps the downloads
 * warning and every page's "Leave site?", which are about other things.
 *
 * The keys reach here through the key table (`KeyboardHandler`): the chord's `keyDown` in a
 * window's chrome or in one of its pages arms the hold (Chromium hands a ⌘ chord to the web
 * view – and so to `before-input-event` – before the menu bar sees it), a key repeat while it
 * runs is the same hold, and any `keyUp` releases it – Chrome's rule, whose panel waits for the
 * next key up. The arming key down and its repeats are left UNCONSUMED: a key down the browser
 * handles has Chromium drop the key up that follows it before Electron sees it
 * (`suppress_events_until_keydown_`), and the release is the whole point. So the chord goes on
 * to the page as a plain key and, on macOS, to the menu bar's Quit role, whose quit request
 * `Browser.requestQuit` refuses while the hold runs. Timers are injected so the rule can be
 * tested without waiting.
 *
 * The panel is drawn where the keyboard is and stays: by the page script of the window's active
 * page (`TabView.showQuitHold`, `shared/quitHoldPanel`) – the page's view lies over the chrome,
 * and hiding it for a chrome-drawn panel would drop the key up the hold waits for – and by the
 * chrome itself (`WindowState.quitHold`) where no live page is in the frame (a chrome page, the
 * URL bar or a menu over the page). Both read the same hold.
 *
 * The hold is the macOS host's: elsewhere the chord quits at once, unless the host says
 * otherwise (`AppHost.quitHoldEverywhere`, the desktop drives' flag, so the panel can be
 * measured under an X server).
 */
export class QuitHoldService {
  /** The window whose chrome shows the hold, while one runs. */
  private win: ZenWindow | null = null
  /** The page view the panel was posted to, to take it down from the same one. */
  private view: TabView | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly browser: Browser,
    private readonly now: () => number = Date.now,
    private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (
      fn,
      ms
    ) => setTimeout(fn, ms),
    private readonly clearTimer: (t: ReturnType<typeof setTimeout>) => void = (t) => clearTimeout(t)
  ) {}

  /** Whether the quit chord holds on this host right now: macOS (or the drives' flag) with the setting on. */
  applies(): boolean {
    const { platform, state } = this.browser
    const everywhere = platform.app.quitHoldEverywhere?.() === true
    if (!everywhere && platform.info.os !== 'darwin') return false
    return state.settings.warnBeforeQuitting
  }

  /** Whether a hold is running. */
  get holding(): boolean {
    return this.timer !== null
  }

  /** The quit chord as the platform spells it ("⌘Q"; "Ctrl + Shift + Q" under the drives' flag). */
  chord(): string {
    const { state } = this.browser
    const shortcut = state.shortcuts.find((s) => s.action === 'app.quit')
    const bound = shortcut?.binding ?? shortcut?.extraBindings[0] ?? null
    return bound
      ? formatBinding(bound, state.platform)
      : state.platform === 'darwin'
        ? '⌘Q'
        : 'Ctrl + Q'
  }

  /**
   * The quit chord went down in `win`. True when the hold took the key: a hold began in the
   * window, or the one running goes on (a key repeat, or a second press before the first key came
   * up). False when the chord is to quit at once – the setting is off, this host never holds, or
   * the window is gone.
   */
  keyDown(win: ZenWindow): boolean {
    if (!this.applies()) return false
    if (this.timer !== null) return true
    if (!win.alive) return false
    this.win = win
    const hold: QuitHoldState = {
      startedAt: this.now(),
      durationMs: QUIT_HOLD_MS,
      chord: this.chord()
    }
    win.quitHold = hold
    this.browser.state.commitVolatile()
    this.showInPage(win, hold)
    this.timer = this.setTimer(() => this.held(), QUIT_HOLD_MS)
    return true
  }

  /** A key came up while the hold ran: it ends here and nothing quits. */
  keyUp(): void {
    this.cancel()
  }

  /** End a running hold without quitting (a release, the window closing). */
  cancel(): void {
    if (this.timer === null) return
    this.clearTimer(this.timer)
    this.timer = null
    this.clearWindow()
  }

  /** The window went away: a hold it showed is moot. */
  onWindowClosing(win: ZenWindow): void {
    if (this.win === win) this.cancel()
  }

  /** The panel as the window's active page paints it: the hold with the chrome's scheme and accent. */
  panelFor(win: ZenWindow, hold: QuitHoldState): QuitHoldPanel {
    const dark = this.browser.darkScheme()
    const accent = rgbToHex(resolveTheme(win.activeSpace().theme, dark).accent)
    return { ...hold, dark, accent }
  }

  private showInPage(win: ZenWindow, hold: QuitHoldState): void {
    const tab = this.browser.tabs.activeTabFor(win)
    const view = tab ? this.browser.tabs.view(tab.id) : undefined
    if (!view?.showQuitHold) return
    this.view = view
    view.showQuitHold(this.panelFor(win, hold))
  }

  private clearWindow(): void {
    const win = this.win
    const view = this.view
    this.win = null
    this.view = null
    if (view && !view.isDestroyed()) view.showQuitHold?.(null)
    if (!win) return
    win.quitHold = null
    this.browser.state.commitVolatile()
  }

  /** The keys were down for the whole hold: the panel goes and the quit runs, confirmed. */
  private held(): void {
    this.timer = null
    const win = this.win
    this.clearWindow()
    void this.browser.requestQuit(win?.alive ? win : undefined, { held: true })
  }
}
