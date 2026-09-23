import type { Tab } from '@shared/types'

/**
 * The horizontal strip's arithmetic (design language v2 §9.37): the numbers of the band and its
 * tabs, the width the regular tabs share, the trailing slot's mode at a width. Pure – the strip
 * (`components/strip/TabStrip.tsx`) reads its measurements and asks here; the tests read the
 * same functions.
 */

/** The caption band the strip lies in: the 6 inset over §5's 32 row. */
export const STRIP_BAND = 38
export const STRIP_INSET = 6
export const STRIP_ROW = 32
/** A regular tab's width at rest, and the floor it holds at before the region scrolls. */
export const STRIP_TAB_MAX = 240
export const STRIP_TAB_MIN = 120
/** Between tabs, between a chip and its members, between the last tab and the +. */
export const STRIP_GAP = 4
/** Under this width an inactive tab gives its trailing slot to the title (unless a glyph fills it). */
export const STRIP_SLOT_THRESHOLD = 160
/** The trailing slot: the sidebar row's 24 box. */
export const STRIP_SLOT = 24
/** After a close the widths hold while the pointer is in the band, and re-lay out this long after it leaves. */
export const STRIP_HOLD_MS = 120
/** The scrolling region's edge fades. */
export const STRIP_FADE = 24
/** A pinned tab: favicon-only, square. */
export const STRIP_PINNED = 32
/** The +, the All tabs button, the Linux window controls: §9.3's 28 box. */
export const STRIP_BUTTON = 28
/** The drag spring between the + and the window controls, at the least. */
export const STRIP_DRAG_SPRING = 24
/** A drag this far past the band (below it) tears the tab off. */
export const STRIP_TEAR_PAST = 16
/** The rail the sidebar becomes, and where the toolbar row and the frame start. */
export const STRIP_RAIL_WIDTH = 56
export const STRIP_TOOLBAR_TOP = 42
export const STRIP_TOOLBAR_HEIGHT = 32
export const STRIP_FRAME_TOP = 82
/** macOS: the traffic lights lead; the strip starts past them. */
export const STRIP_MAC_INSET = 84

export interface StripWidths {
  /** The width every regular tab draws at. */
  width: number
  /** The tabs at the floor no longer fit: the region scrolls. */
  overflow: boolean
}

/**
 * The width the regular tabs share: even, 240 at the most, shrinking as they come until the
 * 120 floor and holding there – past it the region overflows and scrolls. `available` is the
 * room the region has for the tabs alone (the group chips and every gap taken out already);
 * `count` the tabs (a split group's row is one).
 */
export function stripTabWidth(available: number, count: number): StripWidths {
  if (count <= 0) return { width: STRIP_TAB_MAX, overflow: false }
  const each = Math.floor(Math.max(0, available) / count)
  const width = Math.min(STRIP_TAB_MAX, Math.max(STRIP_TAB_MIN, each))
  return { width, overflow: width * count > available + 0.5 }
}

/** The room the regular tabs have in a region `regionWidth` wide holding `fixed` px of chips and `count` tabs (the gaps between every item taken). */
export function stripTabRoom(
  regionWidth: number,
  fixed: number,
  chips: number,
  count: number
): number {
  const items = chips + count
  return Math.max(0, regionWidth - fixed - Math.max(0, items - 1) * STRIP_GAP)
}

/**
 * The trailing slot's mode for a tab drawn `width` wide (§9.37): `reserved` – the 24 slot is
 * there at rest, the state glyph in it, the × arriving on hover (and standing on the active
 * tab); `glyph` – under 160, a tab with a state glyph keeps the slot for the glyph, the × in
 * its place on hover; `title` – under 160, an inactive tab with nothing to show gives the slot
 * to its title, the × arriving on hover at the title's end.
 */
export type StripSlot = 'reserved' | 'glyph' | 'title'

export function stripSlot(width: number, active: boolean, hasGlyph: boolean): StripSlot {
  if (width >= STRIP_SLOT_THRESHOLD || active) return 'reserved'
  return hasGlyph ? 'glyph' : 'title'
}

/** Whether the row carries a state glyph in its trailing slot: sleeping, frozen or throttled, an alert, sound or a mute. */
export function hasStateGlyph(
  tab: Pick<Tab, 'discarded' | 'frozen' | 'cpuThrottle' | 'audible' | 'muted' | 'alert'>
): boolean {
  if (tab.discarded) return true
  if (tab.frozen || tab.cpuThrottle > 1) return true
  if (tab.alert) return true
  return tab.audible || tab.muted
}

/**
 * Whether widths hold after a close: they do while the pointer stays in the band (Chrome's one
 * rule kept); the re-layout comes `STRIP_HOLD_MS` after it leaves. `heldWidth` is the width
 * the tabs had when the close happened; null once nothing is held.
 */
export function heldTabWidth(
  heldWidth: number | null,
  pointerInBand: boolean,
  natural: number
): number {
  if (heldWidth === null || !pointerInBand) return natural
  return heldWidth
}
