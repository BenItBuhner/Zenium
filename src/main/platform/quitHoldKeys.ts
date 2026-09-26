import type { KeyBinding, Shortcut } from '../../shared/types'
import { quitChordOf } from './devtoolsKeys'

/**
 * The chrome's "Hold ⌘Q to quit" cover engaged over a hung page (`lib/quitHoldCover.ts`): the
 * chrome says so on this channel (`ZenApi.quitHoldCoverEngaged`), and the host makes the chord's
 * release audible in the chrome before the keyboard comes there.
 *
 * The hold waits for a key up. Over a live page the chord's keys go down and come up in the
 * page's widget, whose `before-input-event` hears both. Under the cover the page's view hides and
 * the core moves the keyboard to the chrome (`coveredTyping` → `focusChrome()`), so the release
 * arrives at the CHROME's RenderWidgetHost – and Chromium drops it there while that widget's
 * `suppress_events_until_keydown_` is set: the flag is raised when the browser handles a
 * RawKeyDown (a Zenium shortcut consumed in `before-input-event`, F6 or Escape out of the URL
 * bar), it drops every KeyUp and Char that follows, and it is cleared only by the next RawKeyDown
 * into the same widget (`RenderWidgetHostImpl::ForwardKeyboardEventWithCommands`,
 * content/browser/renderer_host/render_widget_host_impl.cc:1634-1652 at 132.0.6834.83; never by a
 * focus change). Measured on the Linux stand-in with real X key events (the closing items on
 * #486): with the flag stale a short tap's release was heard nowhere, the hold ran to 1.5 s and
 * the app quit with the notice showing; a press longer than the OS key-repeat delay was rescued
 * because the keyboard's own auto-repeat put a RawKeyDown of the chord into the chrome.
 *
 * So the host puts that RawKeyDown there itself, once per engagement of the cover: the chord as
 * bound, as an auto-repeat, through `webContents.sendInputEvent` – what the keyboard would have
 * sent. The key table reads it as the hold's own repeat (`KeyboardHandler.handle` →
 * `QuitHoldService.keyDown`, true while a hold runs, UNCONSUMED), so Chromium clears the flag and
 * hands the key on to the chrome's document as a plain repeat, as it does over Settings. Sent only
 * while a hold runs: a chord key down with no hold running would ARM one, with no finger on the
 * keys to release it – and `sendInputEvent` runs the key table synchronously, so the check and the
 * key are one step. On macOS the Q key up is dropped anyway by the Cocoa view that saw no key down
 * for it (`RenderWidgetHostViewCocoa keyEvent:`, `_unmatchedKeyDownCodes`); the ⌘ release is a
 * FlagsChanged, built as a KeyUp with no such guard, and is the release heard.
 */
export const QUIT_HOLD_COVER_CHANNEL = 'zen:quit-hold-cover'

/** Electron's `KeyboardInputEvent` as this module builds it: one key down of the chord, as a repeat. */
export interface ChordKeyDown {
  type: 'keyDown'
  keyCode: string
  modifiers: Array<'control' | 'alt' | 'shift' | 'meta' | 'isautorepeat'>
}

/** The widget the key goes into: the chrome's `WebContents`. */
export interface ChordKeyTarget {
  sendInputEvent(event: ChordKeyDown): void
}

/** The hold as the key needs it: whether one runs right now (`QuitHoldService.holding`). */
export interface HoldLike {
  readonly holding: boolean
}

/**
 * `KeyboardEvent.key` names the table stores (`normaliseKey`) that Electron's accelerator key
 * codes spell differently. Single characters (the space among them) and F-keys pass as they are.
 */
const KEY_CODES: Record<string, string> = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Enter: 'Return',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown'
}

/**
 * The quit chord as the key down its auto-repeat would be, for `sendInputEvent`; null while the
 * chord is unbound or bound to a key Electron's accelerator names cannot spell (the cover then
 * has the keyboard's own repeat alone, as before).
 */
export function quitChordRepeat(binding: KeyBinding | null): ChordKeyDown | null {
  if (!binding) return null
  const keyCode =
    binding.key.length === 1 || /^F([1-9]|1\d|2[0-4])$/.test(binding.key)
      ? binding.key
      : (KEY_CODES[binding.key] ?? null)
  if (keyCode === null) return null
  const modifiers: ChordKeyDown['modifiers'] = []
  if (binding.ctrl) modifiers.push('control')
  if (binding.alt) modifiers.push('alt')
  if (binding.shift) modifiers.push('shift')
  if (binding.meta) modifiers.push('meta')
  modifiers.push('isautorepeat')
  return { type: 'keyDown', keyCode, modifiers }
}

/**
 * The cover engaged: one key down of the chord into `chrome` while a hold runs, so the widget's
 * key-up suppression is cleared before the release arrives there. True when the key was sent;
 * false with no hold running (nothing must arm one) or no chord to send.
 */
export function primeChromeForRelease(
  chrome: ChordKeyTarget,
  hold: HoldLike,
  shortcuts: readonly Shortcut[]
): boolean {
  if (!hold.holding) return false
  const repeat = quitChordRepeat(quitChordOf(shortcuts))
  if (!repeat) return false
  chrome.sendInputEvent(repeat)
  return true
}
