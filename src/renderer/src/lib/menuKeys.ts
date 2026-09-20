import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { MenuAnchor, Platform } from '@shared/types'
import { isTextField } from './popover'
import { browserStore } from './ui'

/*
 * The keyboard of the chrome's menus (v2 draft §9.22; parity row a11y-08), with Chrome's native
 * menus – Chromium's `MenuController` on Windows and Linux, the system's on macOS – as the rule
 * book. Two halves: how a context menu is asked for from the keyboard (Shift+F10, the Menu key),
 * and how a menu the renderer draws itself answers the keys once it is open.
 */

// ---------------------------------------------------------------------------
// Asking for a context menu
// ---------------------------------------------------------------------------

/** What a `contextmenu` event tells about its source, on either side of React. */
interface ContextMenuEventLike {
  button: number
  clientX: number
  clientY: number
  /** Chromium marks the mouse events a touch gesture stands in for. */
  sourceCapabilities?: { firesTouchEvents?: boolean } | null
}

/**
 * Where the menu a `contextmenu` event asks for opens (`MenuAnchor`): a right-click's at the
 * pointer; Shift+F10's and the Menu key's – Chromium raises the event at the middle of the
 * focused element with no button (`button` is -1, its `kNoButton`) – there, in keyboard mode, so
 * the first item starts selected and the arrow keys take over at once (Chrome's rule). A touch's
 * long-press comes without the right button too but is marked as a touch's: it opens at the
 * finger, a pointer's menu all the same.
 */
export function contextMenuAnchor(
  e: ReactMouseEvent | MouseEvent
): MenuAnchor & { x: number; y: number } {
  const native: ContextMenuEventLike = 'nativeEvent' in e ? e.nativeEvent : e
  const pointer = e.button === 2 || Boolean(native.sourceCapabilities?.firesTouchEvents)
  return !pointer
    ? { x: Math.round(e.clientX), y: Math.round(e.clientY), keyboard: true }
    : { x: Math.round(e.clientX), y: Math.round(e.clientY) }
}

// ---------------------------------------------------------------------------
// Inside an open menu
// ---------------------------------------------------------------------------

/** What a key asks of a menu: move the highlight to an item, or run one. */
export type MenuKeyIntent = { kind: 'move'; index: number } | { kind: 'activate'; index: number }

/** The keys of a menu item, as any `KeyboardEvent` has them. */
export interface MenuKeyLike {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
}

/** Whether a menu runs a mnemonic's only match at once, as Chrome's menus do off macOS. */
export function mnemonicActivates(platform: Platform | undefined): boolean {
  return platform !== 'darwin'
}

/**
 * The letter a key press means as a mnemonic, or null when it is not one: one printable
 * character with no Control, Alt or Command held (Shift is fine – the letter is what counts).
 * Space is a menu's Enter, not a letter.
 */
export function mnemonicKey(e: MenuKeyLike): string | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null
  if ([...e.key].length !== 1 || e.key === ' ') return null
  return e.key.toLocaleLowerCase()
}

/**
 * Chromium's `MenuController::SelectByChar` over a menu's labels (`null` for an item the key
 * skips: disabled, hidden, a separator): the items whose label starts with the letter. Exactly
 * one match is meant – Chrome runs it; several move the highlight to the first match after the
 * current item, round to the first. No match: null, the key does nothing.
 */
export function mnemonicMatch(
  labels: ReadonlyArray<string | null>,
  key: string,
  current: number
): { index: number; unique: boolean } | null {
  const matches: number[] = []
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]
    if (label === null) continue
    const first = [...label.trimStart()][0]
    if (first !== undefined && first.toLocaleLowerCase() === key) matches.push(i)
  }
  if (matches.length === 0) return null
  if (matches.length === 1) return { index: matches[0], unique: true }
  const next = matches.find((i) => i > current)
  return { index: next ?? matches[0], unique: false }
}

/**
 * What the arrows, Home, End and – with `mnemonics` – a letter ask of a menu of `labels` (null
 * for an item the keys skip) with the highlight at `current` (-1 for none: Down starts at the
 * first item, Up at the last, as Chrome's menus do when opened by pointer). Enter, Space and
 * Escape are not the model's: the item is a button, the popover owns Escape. Null: not a menu key.
 */
export function menuKeyIntent(
  e: MenuKeyLike,
  labels: ReadonlyArray<string | null>,
  current: number,
  options: { mnemonics?: boolean; platform?: Platform } = {}
): MenuKeyIntent | null {
  const enabled = labels.map((label, i) => (label === null ? -1 : i)).filter((i) => i >= 0)
  if (enabled.length === 0) return null
  const at = enabled.indexOf(current)
  const step = (by: number): number => {
    if (at === -1) return by > 0 ? enabled[0] : enabled[enabled.length - 1]
    return enabled[(at + by + enabled.length) % enabled.length]
  }
  switch (e.key) {
    case 'ArrowDown':
      return { kind: 'move', index: step(1) }
    case 'ArrowUp':
      return { kind: 'move', index: step(-1) }
    case 'Home':
      return { kind: 'move', index: enabled[0] }
    case 'End':
      return { kind: 'move', index: enabled[enabled.length - 1] }
    default:
      break
  }
  if (!options.mnemonics) return null
  const letter = mnemonicKey(e)
  if (letter === null) return null
  const match = mnemonicMatch(labels, letter, current)
  if (!match) return null
  return match.unique && mnemonicActivates(options.platform)
    ? { kind: 'activate', index: match.index }
    : { kind: 'move', index: match.index }
}

/** The label a mnemonic reads: the item's accessible name, else its text. */
export function menuItemLabel(el: HTMLElement): string {
  return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()
}

function itemEnabled(el: HTMLElement): boolean {
  return !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true'
}

/**
 * Answers a key press for a menu drawn as DOM `items` (in order; disabled ones are skipped): the
 * arrows and Home/End move focus, a letter goes to or runs the item it names (`mnemonics`),
 * `tab` lets Tab and Shift+Tab walk the items too. Focus outside the items – the menu itself,
 * just opened by pointer – counts as no highlight. A letter typed into a text field inside the
 * menu is the field's. True when the key was the menu's (and its default is cancelled).
 */
export function handleMenuKey(
  e: KeyboardEvent | ReactKeyboardEvent,
  items: HTMLElement[],
  options: { mnemonics?: boolean; tab?: boolean } = {}
): boolean {
  const active = document.activeElement
  const current = active instanceof HTMLElement ? items.indexOf(active) : -1
  const like: MenuKeyLike = {
    key: e.key,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    metaKey: e.metaKey
  }
  const labels = items.map((el) => (itemEnabled(el) ? menuItemLabel(el) : null))
  let intent: MenuKeyIntent | null
  if (options.tab && e.key === 'Tab') {
    intent = menuKeyIntent({ ...like, key: e.shiftKey ? 'ArrowUp' : 'ArrowDown' }, labels, current)
  } else {
    if (options.mnemonics && active && isTextField(active) && mnemonicKey(like) !== null)
      return false
    intent = menuKeyIntent(like, labels, current, {
      mnemonics: options.mnemonics,
      platform: browserStore.get().state?.platform
    })
  }
  if (!intent) return false
  const target = items[intent.index]
  if (!target) return false
  e.preventDefault()
  if (intent.kind === 'activate') target.click()
  else target.focus()
  return true
}
