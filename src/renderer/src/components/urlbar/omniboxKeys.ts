/**
 * The omnibox's keyboard model (omnibox-50, Chrome's `OmniboxViewViews::HandleKeyEvent` and
 * `OmniboxPopupSelection`): what a key does given where the highlight is and what the field
 * holds, as pure decisions the bar applies. No DOM here, so the model is tested on its own.
 *
 * The highlight is a row index (`-1` is the typed text, no row) and, within a row, an action
 * index (`-1` is the field itself; `0…` the row's trailing controls, such as the remove X).
 */

/** Where Escape goes next, Chrome's staged reverting. */
export type EscapeIntent =
  /** Keyword mode is left first; the keyword text comes back into the field. */
  | 'exit-keyword'
  /** The popup closes, what was typed stays in the field. */
  | 'close-popup'
  /** The field reverts to the page's address (or empties over no page). */
  | 'revert'
  /** The bar closes; the keyboard goes back to the page. */
  | 'close-bar'

export interface EscapeContext {
  /** The bar is in keyword or search mode (a "Search <engine>" chip is up). */
  keywordMode: boolean
  /** Rows are shown under the field. */
  popupOpen: boolean
  /** The field holds the text it rests at over this page (its address, or nothing over none). */
  atRestText: boolean
}

/**
 * Esc, one stage at a time: leave keyword mode, close the popup (the typed text kept), revert
 * the field to the page's address, close the bar. A field already at rest with no popup closes
 * the bar at once.
 */
export function escapeIntent(ctx: EscapeContext): EscapeIntent {
  if (ctx.keywordMode) return 'exit-keyword'
  if (ctx.popupOpen) return 'close-popup'
  if (!ctx.atRestText) return 'revert'
  return 'close-bar'
}

/**
 * Down / Up: the next row, wrapping through the typed text (`-1`) at either end (Chrome's
 * `kWholeLine` step).
 */
export function arrowStep(selected: number, rowCount: number, dir: 1 | -1): number {
  const next = selected + dir
  if (next < -1) return rowCount - 1
  if (next >= rowCount) return -1
  return next
}

/**
 * PageDown / PageUp: a page of rows on, clamped to the last row and to the typed text (Chrome's
 * `kAllLines` step, which stops at the ends instead of wrapping). `pageSize` is how many rows
 * the list shows at once; the whole list when it shows them all.
 */
export function pageStep(
  selected: number,
  rowCount: number,
  dir: 1 | -1,
  pageSize: number
): number {
  const step = Math.max(1, pageSize)
  if (dir === 1) return Math.min(rowCount - 1, selected + step)
  return Math.max(-1, selected - step)
}

/** Where Tab or Shift+Tab put the highlight, or that it leaves the bar for the toolbar. */
export type TabIntent =
  { kind: 'focus'; selected: number; action: number } | { kind: 'leave'; dir: 1 | -1 }

/**
 * Tab / Shift+Tab (Chrome's `kStateOrLine` step): through the highlighted row's actions, then
 * on to the next row (its field first, then its actions); past the last row's last action the
 * keyboard leaves the popup for the toolbar, and back past the typed text it leaves the other
 * way. `actions[i]` is how many trailing controls row `i` has.
 */
export function tabStep(
  selected: number,
  action: number,
  actions: readonly number[],
  dir: 1 | -1
): TabIntent {
  const count = (row: number): number => (row >= 0 ? (actions[row] ?? 0) : 0)
  if (dir === 1) {
    if (action + 1 < count(selected)) return { kind: 'focus', selected, action: action + 1 }
    if (selected + 1 < actions.length) return { kind: 'focus', selected: selected + 1, action: -1 }
    return { kind: 'leave', dir: 1 }
  }
  if (action > -1) return { kind: 'focus', selected, action: action - 1 }
  if (selected > -1) {
    const prev = selected - 1
    return { kind: 'focus', selected: prev, action: count(prev) - 1 }
  }
  return { kind: 'leave', dir: -1 }
}

/**
 * After a row is removed (Shift+Delete, the X): the highlight moves to the row that took its
 * place, or the new last row, instead of clearing (Chrome); none when the list is empty.
 */
export function selectionAfterRemoval(removed: number, remaining: number): number {
  if (remaining <= 0) return -1
  return Math.min(removed, remaining - 1)
}

/** Where a submit or a row pick opens (omnibox-24, -25). */
export type OpenWhere = 'current' | 'tab' | 'background' | 'window'

export interface SubmitModifiers {
  ctrl: boolean
  shift: boolean
  alt: boolean
}

/**
 * Enter with modifiers, Chrome's table with Zenium's one extra: Ctrl adds `www.` and `.com`
 * around what was typed (Ctrl+Shift into a new window, Ctrl+Alt into a new tab); Shift opens a
 * new window; Alt a new foreground tab (the page stays); Alt+Shift a background tab (Zenium).
 */
export function submitTarget(mods: SubmitModifiers): { where: OpenWhere; wwwCom: boolean } {
  if (mods.ctrl) {
    return { wwwCom: true, where: mods.shift ? 'window' : mods.alt ? 'tab' : 'current' }
  }
  if (mods.shift && mods.alt) return { where: 'background', wwwCom: false }
  if (mods.shift) return { where: 'window', wwwCom: false }
  if (mods.alt) return { where: 'tab', wwwCom: false }
  return { where: 'current', wwwCom: false }
}

export interface ClickModifiers {
  /** `MouseEvent.button`: 1 is the middle button. */
  button: number
  ctrl: boolean
  shift: boolean
  alt: boolean
}

/**
 * A row picked with the mouse: Ctrl+click or a middle click opens it in a background tab
 * (Chrome), Shift+click in a new window, Alt+click in a new foreground tab (Zenium, as
 * Alt+Enter), a plain click where a plain Enter would.
 */
export function clickTarget(mods: ClickModifiers): OpenWhere {
  if (mods.button === 1 || mods.ctrl) return 'background'
  if (mods.shift) return 'window'
  if (mods.alt) return 'tab'
  return 'current'
}
