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
  /**
   * The window the chord's press is in progress in: the one whose chrome shows the hold while
   * one runs, and the one a fired hold's keys are still down in (`latched`).
   */
  private win: ZenWindow | null = null
  /** The page view the panel was posted to, to take it down from the same one. */
  private view: TabView | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /**
   * A hold fired and its keys have not come up yet: the chord's auto-repeats go on arriving
   * (macOS repeats a ⌘ chord every few tens of ms, and the finger is normally still down when
   * the hold completes) and must arm nothing – a fresh hold would pop the panel again over the
   * downloads prompt or a page's "Leave site?" the fired quit is asking. Cleared by the next key
   * up, or by the window losing the keyboard or closing (the key up will not be seen then).
   */
  private latched = false

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
   * Whether the chord's press is still in progress: a hold running, or one that fired whose
   * keys are still down. Either way the press has a quit request of its own in flight or
   * decided, and any other request that reaches the browser meanwhile is the chord's – the
   * menu bar's Quit role firing on the unconsumed key and its repeats (`Browser.requestQuit`).
   */
  get engaged(): boolean {
    return this.timer !== null || this.latched
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
   * up), or a hold fired and the keys are still down (a repeat after the fire arms nothing until
   * a key up). False when the chord is to quit at once – the setting is off, this host never
   * holds, or the window is gone.
   */
  keyDown(win: ZenWindow): boolean {
    if (!this.applies()) return false
    if (this.timer !== null || this.latched) return true
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

  /**
   * A key came up: a hold running ends here and nothing quits; the press of a hold that fired is
   * over, and the next key down begins a hold afresh.
   */
  keyUp(): void {
    this.cancel()
  }

  /**
   * End a running hold without quitting, and the press of a fired one (a release, the window
   * losing the keyboard or closing).
   */
  cancel(): void {
    this.latched = false
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
      this.clearPanel()
    }
    this.win = null
  }

  /** The window went away: a hold it showed is moot. */
  onWindowClosing(win: ZenWindow): void {
    if (this.win === win) this.cancel()
  }

  /**
   * The hold's window lost the keyboard – ⌘Tab to another app, a notification banner clicked,
   * Spotlight summoned, another window brought forward – so the key up will be delivered
   * elsewhere and never seen here. The hold ends and nothing quits: a held quit only ever
   * completes with the keys still down in a focused Zenium window, where the panel can be
   * seen (the hold is the confirmation only while the user watches it, §10.5). A blur of some
   * other window is nothing to a hold.
   */
  onWindowBlur(win: ZenWindow): void {
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

  /** Take the panel down, from the page it was posted to and from the window's chrome. */
  private clearPanel(): void {
    const win = this.win
    const view = this.view
    this.view = null
    if (view && !view.isDestroyed()) view.showQuitHold?.(null)
    if (!win) return
    win.quitHold = null
    this.browser.state.commitVolatile()
  }

  /**
   * The keys were down for the whole hold: the panel goes and the quit runs, confirmed. The
   * press stays latched until a key comes up – its repeats arm nothing more.
   */
  private held(): void {
    this.timer = null
    this.latched = true
    this.clearPanel()
    const win = this.win
    void this.browser.requestQuit(win?.alive ? win : undefined, { held: true })
  }
}
