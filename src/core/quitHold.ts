import type { Browser } from './browser'
import type { ZenWindow } from './window'

/** The quit chord held this long quits (Chrome's `kTimeToConfirmQuit`, `confirm_quit_panel_controller.mm`). */
export const QUIT_HOLD_MS = 1500

/**
 * Chrome's hold-to-quit (session-08): on macOS, while "Warn Before Quitting (⌘Q)" is set, the
 * quit chord does not quit on its press – the front window's chrome shows "Hold ⌘Q to Quit"
 * with the hold's progress, and the app quits once the keys were down for {@link QUIT_HOLD_MS}.
 * A key coming up before that ends the hold and nothing quits. The hold is the confirmation
 * (design language v2 §10.5): a quit it agreed to skips the tab-count question, and keeps the
 * downloads warning and every page's "Leave site?", which are about other things.
 *
 * The keys reach here through the key table (`KeyboardHandler`): the chord's `keyDown` in a
 * window's chrome or in one of its pages arms the hold (Chromium hands a ⌘ chord to the web
 * view before the menu bar sees it, and a consumed chord never reaches the bar's Quit role), a
 * key repeat while it runs is the same hold, and any `keyUp` releases it – Chrome's rule, whose
 * panel waits for the next key up. Timers are injected so the rule can be tested without waiting.
 *
 * The hold is the macOS host's: elsewhere the chord quits at once, unless the host says
 * otherwise (`AppHost.quitHoldEverywhere`, the desktop drives' flag, so the overlay can be
 * measured under an X server).
 */
export class QuitHoldService {
  /** The window whose chrome shows the hold, while one runs. */
  private win: ZenWindow | null = null
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
    win.quitHold = { startedAt: this.now(), durationMs: QUIT_HOLD_MS }
    this.browser.state.commitVolatile()
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

  private clearWindow(): void {
    const win = this.win
    this.win = null
    if (!win) return
    win.quitHold = null
    this.browser.state.commitVolatile()
  }

  /** The keys were down for the whole hold: the overlay goes and the quit runs, confirmed. */
  private held(): void {
    this.timer = null
    const win = this.win
    this.clearWindow()
    void this.browser.requestQuit(win?.alive ? win : undefined, { held: true })
  }
}
