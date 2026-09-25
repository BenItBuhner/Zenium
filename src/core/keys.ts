import { isModifierKey, matchShortcut } from '../shared/shortcuts'
import type { Browser } from './browser'
import type { KeyEventInput } from './platform'
import type { ZenWindow } from './window'

/**
 * Routes key events from every web view (chrome and pages) through Zen's shortcut table.
 * Matching shortcuts are consumed so pages never see them – the same precedence Firefox gives to
 * browser keybindings. Returns true when the host must swallow the event.
 */
export class KeyboardHandler {
  /** Tabs whose focused frame reports a text field under the keyboard (`setEditing`). */
  private readonly editing = new Set<string>()

  constructor(private readonly browser: Browser) {}

  /**
   * A frame of `tabId` that holds the keyboard said whether it is on a text field
   * (`shared/editingFocus`, over the page-message channel). The caret's chords yield to it.
   */
  setEditing(tabId: string, editing: boolean): void {
    if (editing) this.editing.add(tabId)
    else this.editing.delete(tabId)
    // A closed tab's last word is not taken back: forget the tabs that are gone (a handful).
    for (const id of this.editing) if (!this.browser.tabs.tab(id)) this.editing.delete(id)
  }

  handle(input: KeyEventInput, sourceTabId: string | null, win: ZenWindow): boolean {
    // Esc held in a fullscreen window leaves it (both edges of the key are needed for that).
    if (input.key === 'Escape') this.browser.fullscreen.onEscape(input, win)
    // The quit chord held quits (session-08): any key coming up while the hold runs releases it
    // – Chrome's panel waits for the next key up, whichever key – so the release is read here,
    // before the table, which sees key downs alone.
    if (input.type === 'keyUp') this.browser.quitHold.keyUp()
    if (input.type !== 'keyDown') return false
    if (isModifierKey(input.key)) return false
    // The Settings recorder owns the chrome's keys while it listens: the chord it records must
    // not also run (BUG-044). Pages keep their shortcuts; the recorder has no focus there.
    if (win.recordingShortcut && sourceTabId === null) return false

    const shortcut = matchShortcut(this.browser.state.shortcuts, input)
    if (shortcut) {
      // ⌘ with an arrow is the caret's on macOS (line start and end, document start and end),
      // and Chrome keeps it the text field's by giving the page the key first – Back on ⌘← is
      // for a page without a field under the keyboard (history-14). The table is matched before
      // any field sees the key here, so the chord yields where one may be under it: in the
      // chrome, whose fields say nothing, and in a page whose focused frame reports a field
      // (`setEditing`). Whatever action the chord is bound to.
      if (
        this.browser.platform.info.os === 'darwin' &&
        isCaretChord(input) &&
        (sourceTabId === null || this.editing.has(sourceTabId))
      )
        return false
      // The quit chord on a host that holds (macOS with Warn Before Quitting on): the press arms
      // the hold in this window instead of quitting, and the key is NOT consumed – nor are its
      // repeats while the hold runs. Chromium drops the key up (and char) that follow a key
      // down the browser handled (`RenderWidgetHostImpl`'s `suppress_events_until_keydown_`), so
      // a consumed chord's release would never reach `before-input-event`, and the release is
      // what the hold waits for (measured on Electron 44.4.5: a consumed key down's key up
      // reaches neither `before-input-event` nor `input-event`; an unconsumed one's does). The
      // chord goes on to the page as a plain key – no page action is bound to it – and, on
      // macOS, on to the menu bar's Quit, whose quit request yields to the running hold
      // (`Browser.requestQuit`). Off, the chord quits at once and is consumed as before.
      if (shortcut.action === 'app.quit' && this.browser.quitHold.keyDown(win)) return false
      if (input.isAutoRepeat && !REPEATABLE.has(shortcut.action)) return true
      if (shortcut.unsupported) {
        this.browser.toast(`"${shortcut.label}" is not available in this build yet.`, 'info', win)
        return true
      }
      this.browser.actions.run(shortcut.action, { sourceTabId, win })
      return true
    }

    // Extension commands come after Zenium's own shortcuts: an extension never overrides one.
    if (!input.isAutoRepeat && this.browser.extensions.handleKey(input, win)) return true

    if (
      input.key === 'Escape' &&
      sourceTabId !== null &&
      !input.alt &&
      !input.control &&
      !input.meta
    ) {
      // Escape inside a page: leave Boost zap mode / close Glance, else stop loading (Firefox).
      if (this.browser.boosts.isZapping(sourceTabId)) {
        this.browser.boosts.stopZap(sourceTabId)
        return true
      }
      if (win.glance) {
        this.browser.tabs.closeGlance(win)
        return true
      }
      const tab = this.browser.tabs.tab(sourceTabId)
      if (tab?.loading) this.browser.tabs.stop(sourceTabId)
    }
    return false
  }
}

/** ⌘ and an arrow, Shift or not: macOS's caret motion and selection in any text field. */
function isCaretChord(input: KeyEventInput): boolean {
  if (!input.meta || input.control || input.alt) return false
  return (
    input.key === 'ArrowLeft' ||
    input.key === 'ArrowRight' ||
    input.key === 'ArrowUp' ||
    input.key === 'ArrowDown'
  )
}

const REPEATABLE = new Set([
  'zoom.in',
  'zoom.out',
  'tab.next',
  'tab.prev',
  'space.next',
  'space.prev',
  'tab.moveBackward',
  'tab.moveForward',
  'find.next',
  'find.prev'
])
