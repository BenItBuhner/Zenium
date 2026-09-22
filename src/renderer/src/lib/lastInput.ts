/**
 * The last input the chrome heard, on the document's root as `data-input="touch" | "keyboard"`
 * (v2 §1's ring on a phone; A11Y-09). The phone's chrome hides its legacy buttons'
 * `:focus-visible` rings under the coarse pointer (`main.css`, the suppressor beside the other
 * `data-pointer='coarse'` rules): a focus a script moves – a sheet's first row, the omnibox as
 * it opens – matches `:focus-visible` while no pointer has been used yet, and would ring under
 * a finger. But a hardware keyboard's Tab on the same phone must show the shared ring on the
 * pill and the bar's buttons, and the `:focus-visible` heuristic alone cannot make the
 * suppressor see the difference. This says whether the keyboard is what the user is driving
 * with, so the suppressor stands down while it is
 * (`:root[data-pointer='coarse']:where(:not([data-input='keyboard']))`) and the heuristic's
 * own reading of each focus shows through. TalkBack moves the accessibility focus, not the
 * document's, and sends no key: it never sets the attribute (#237's stops are unchanged).
 *
 * Keyboard means navigation: Tab, the arrows, Home / End / Page, Escape, the function keys and
 * any shortcut with Ctrl, Alt or Meta – what a hardware keyboard sends and a soft keyboard does
 * not. The soft keyboard's Enter, Backspace and characters, and IME composition, leave the
 * attribute as it is: typing in the omnibox is no reason to ring what is focused after. Any
 * pointer down is a touch – a finger, a pen, a mouse alike: which pointer the device has is
 * `data-pointer`'s reading (`formFactor.ts`), this is only what came last.
 */

export type InputKind = 'touch' | 'keyboard'

/** What `keydown` and `pointerdown` carry that decides the input kind. */
export interface InputEventLike {
  type: string
  key?: string
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  isComposing?: boolean
}

const NAVIGATION_KEYS = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Escape'
])

/**
 * The input kind an event stands for: a pointer down is a touch; a key down is the keyboard
 * when it navigates (see the module note); anything else – a character, Enter, Backspace, a
 * lone modifier, composition – says nothing (`null`), and the attribute keeps its last value.
 */
export function inputKindOf(event: InputEventLike): InputKind | null {
  if (event.type === 'pointerdown') return 'touch'
  if (event.type !== 'keydown' || event.isComposing) return null
  const key = event.key ?? ''
  if (NAVIGATION_KEYS.has(key) || /^F\d{1,2}$/.test(key)) return 'keyboard'
  // A shortcut (Ctrl+L, Alt+D, Ctrl+Tab): the modifier held with a key, not the modifier alone.
  const modifier = key === 'Control' || key === 'Alt' || key === 'Meta' || key === 'Shift'
  if ((event.ctrlKey || event.altKey || event.metaKey) && !modifier) return 'keyboard'
  return null
}

/** Record `kind` as the last input on the root; the same kind again writes nothing. */
export function noteInput(kind: InputKind, root: HTMLElement = document.documentElement): void {
  if (root.dataset.input !== kind) root.dataset.input = kind
}

/** Watch the window's key and pointer events (capture, so a handler that stops them still counts). */
export function watchLastInput(target: Window = window): () => void {
  const listener = (event: Event): void => {
    const kind = inputKindOf(event as unknown as InputEventLike)
    if (kind) noteInput(kind)
  }
  target.addEventListener('keydown', listener, true)
  target.addEventListener('pointerdown', listener, true)
  return () => {
    target.removeEventListener('keydown', listener, true)
    target.removeEventListener('pointerdown', listener, true)
  }
}

const flags = globalThis as unknown as { __zenLastInputWatched?: boolean }
if (!flags.__zenLastInputWatched && typeof window !== 'undefined' && typeof document !== 'undefined') {
  flags.__zenLastInputWatched = true
  watchLastInput()
}
