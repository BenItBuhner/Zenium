import type { HostCapabilities, PhoneBarItemId, PhoneBarLayout, Tab } from './types'
import { BLANK_URL } from './url'

/**
 * The phone's bar as data: which controls sit either side of the address pill. The pill itself
 * is fixed – always present, in the flexible slot – so a layout is two ordered lists. What each
 * item looks like and does lives with the renderer (`components/phone/barItems.tsx`); this module
 * owns the catalogue of ids, the defaults, how many items a screen fits, and the edits the
 * editor makes, so the browser core can sanitise what it persists and syncs and the UI can be
 * tested without a DOM.
 */

/** Every control the bar can host, in the order the editor offers them. */
export const PHONE_BAR_ITEM_IDS: readonly PhoneBarItemId[] = [
  'back',
  'forward',
  'reload',
  'home',
  'share',
  'bookmark',
  'bookmarks',
  'history',
  'downloads',
  'tabs',
  'new-tab',
  'menu',
  'spaces',
  'find'
]

/** The host abilities an item can depend on. */
type Requirement = keyof Pick<HostCapabilities, 'share'>
/** What a host must be able to do for an item to be offered; items not listed are always offered. */
const REQUIRES: Partial<Record<PhoneBarItemId, Requirement>> = {
  share: 'share'
}

/**
 * The catalogue as one host offers it: an item whose command the host lacks (Share without a
 * system share sheet) is neither listed by the editor nor drawn if a synced layout carries it.
 */
export function phoneBarOffered(
  capabilities: Pick<HostCapabilities, Requirement>
): PhoneBarItemId[] {
  return PHONE_BAR_ITEM_IDS.filter((id) => {
    const needs = REQUIRES[id]
    return needs === undefined || capabilities[needs]
  })
}

/** `layout` without the items `offered` leaves out (the layout itself when it has none). */
export function phoneBarForHost(
  layout: PhoneBarLayout,
  offered: readonly PhoneBarItemId[]
): PhoneBarLayout {
  const keep = (side: PhoneBarItemId[]): PhoneBarItemId[] =>
    side.filter((id) => offered.includes(id))
  const left = keep(layout.left)
  const right = keep(layout.right)
  if (left.length === layout.left.length && right.length === layout.right.length) return layout
  return { left, right }
}

/** Today's bar: back, the pill, new tab, tabs, menu. */
export const DEFAULT_PHONE_BAR: PhoneBarLayout = {
  left: ['back'],
  right: ['new-tab', 'tabs', 'menu']
}

/** Size (CSS px) of a bar button and of the gap between neighbours; the bar's side padding. */
export const BAR_BUTTON = 44
export const BAR_GAP = 4
export const BAR_PADDING = 8
/** The pill keeps at least this much: the site icon, a few characters of address and the lock. */
export const PILL_MIN_WIDTH = 88
/** Items besides the pill, whatever the screen: past this the bar is a toolbar, not a bar. */
export const PHONE_BAR_MAX_ITEMS = 6

export type PhoneBarSide = keyof PhoneBarLayout

/** A slot an item can be placed in: a side and an index within it. */
export interface PhoneBarSlot {
  side: PhoneBarSide
  index: number
}

const KNOWN = new Set<string>(PHONE_BAR_ITEM_IDS)

export function isPhoneBarItemId(value: unknown): value is PhoneBarItemId {
  return typeof value === 'string' && KNOWN.has(value)
}

export function defaultPhoneBar(): PhoneBarLayout {
  return { left: [...DEFAULT_PHONE_BAR.left], right: [...DEFAULT_PHONE_BAR.right] }
}

/**
 * A layout as read from disk or received from another device: ids this build does not know
 * (an older or newer build's) and repeats are dropped silently; anything that is not a layout
 * at all falls back to the default.
 */
export function sanitizePhoneBar(raw: unknown): PhoneBarLayout {
  if (!raw || typeof raw !== 'object') return defaultPhoneBar()
  const { left, right } = raw as Record<string, unknown>
  if (!Array.isArray(left) || !Array.isArray(right)) return defaultPhoneBar()
  const seen = new Set<PhoneBarItemId>()
  const take = (side: unknown[]): PhoneBarItemId[] => {
    const out: PhoneBarItemId[] = []
    for (const id of side) {
      if (!isPhoneBarItemId(id) || seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
    return out
  }
  return { left: take(left), right: take(right) }
}

/** The items in drawing order, without the pill. */
export function phoneBarItems(layout: PhoneBarLayout): PhoneBarItemId[] {
  return [...layout.left, ...layout.right]
}

export function phoneBarCount(layout: PhoneBarLayout): number {
  return layout.left.length + layout.right.length
}

export function phoneBarHas(layout: PhoneBarLayout, id: PhoneBarItemId): boolean {
  return layout.left.includes(id) || layout.right.includes(id)
}

export function phoneBarLayoutsEqual(a: PhoneBarLayout, b: PhoneBarLayout): boolean {
  return (
    a.left.length === b.left.length &&
    a.right.length === b.right.length &&
    a.left.every((id, i) => id === b.left[i]) &&
    a.right.every((id, i) => id === b.right[i])
  )
}

export function isDefaultPhoneBar(layout: PhoneBarLayout): boolean {
  return phoneBarLayoutsEqual(layout, DEFAULT_PHONE_BAR)
}

/**
 * How many items besides the pill fit in a bar `width` px wide (the window minus its side
 * insets): 44 px targets with 4 px gaps, the bar's own padding, and the pill keeping its minimum.
 * Five at 360 px, six from 392 px up, never more than six.
 */
export function phoneBarCapacity(width: number): number {
  const room = width - 2 * BAR_PADDING - PILL_MIN_WIDTH
  const fit = Math.floor(room / (BAR_BUTTON + BAR_GAP))
  return Math.max(0, Math.min(PHONE_BAR_MAX_ITEMS, fit))
}

/** Width (px) the pill gets in a bar `width` px wide holding `items` items `button` px wide. */
export function pillWidth(width: number, items: number, button = BAR_BUTTON): number {
  return Math.max(0, width - 2 * BAR_PADDING - items * (button + BAR_GAP))
}

export interface PhoneBarGeometry {
  /** Left edge (px) of each item's box (`button` px wide). */
  items: Map<PhoneBarItemId, number>
  /** The pill's left edge and width (px). */
  pill: { left: number; width: number }
}

/**
 * Where everything sits in a bar `width` px wide drawing `layout`: items `button` px wide (the
 * 44 px target by default; the live preview passes the size the bar renders its buttons at) at
 * 4 px gaps from either edge (inside the 8 px padding), the pill filling what is left between
 * them. Capacity stays a matter of 44 px targets whatever the buttons measure.
 */
export function phoneBarGeometry(
  layout: PhoneBarLayout,
  width: number,
  button = BAR_BUTTON
): PhoneBarGeometry {
  const step = button + BAR_GAP
  const items = new Map<PhoneBarItemId, number>()
  layout.left.forEach((id, i) => items.set(id, BAR_PADDING + i * step))
  const right = layout.right.length
  layout.right.forEach((id, j) => items.set(id, width - BAR_PADDING - (right - j) * step + BAR_GAP))
  return {
    items,
    pill: {
      left: BAR_PADDING + layout.left.length * step,
      width: pillWidth(width, layout.left.length + right, button)
    }
  }
}

/** Items not yet in the bar, in catalogue order, restricted to `available` when given. */
export function phoneBarAvailable(
  layout: PhoneBarLayout,
  available: readonly PhoneBarItemId[] = PHONE_BAR_ITEM_IDS
): PhoneBarItemId[] {
  return available.filter((id) => !phoneBarHas(layout, id))
}

// ---------------------------------------------------------------------------
// Edits (pure: every function returns a new layout)
// ---------------------------------------------------------------------------

export function removePhoneBarItem(layout: PhoneBarLayout, id: PhoneBarItemId): PhoneBarLayout {
  return {
    left: layout.left.filter((x) => x !== id),
    right: layout.right.filter((x) => x !== id)
  }
}

/**
 * Put `id` at `slot` (its index within the side, clamped; the end of the side by default),
 * moving it there if it is already in the bar. An unknown id or a full bar leaves the layout
 * as it was.
 */
export function addPhoneBarItem(
  layout: PhoneBarLayout,
  id: PhoneBarItemId,
  slot: PhoneBarSlot = { side: 'right', index: Infinity },
  capacity = PHONE_BAR_MAX_ITEMS
): PhoneBarLayout {
  if (!isPhoneBarItemId(id)) return layout
  if (!phoneBarHas(layout, id) && phoneBarCount(layout) >= capacity) return layout
  const without = removePhoneBarItem(layout, id)
  const side = [...without[slot.side]]
  const index = Math.max(0, Math.min(side.length, Math.floor(slot.index)))
  side.splice(index, 0, id)
  return { ...without, [slot.side]: side }
}

/** Move an item already in the bar to `slot` (no-op for an item that is not in it). */
export function movePhoneBarItem(
  layout: PhoneBarLayout,
  id: PhoneBarItemId,
  slot: PhoneBarSlot
): PhoneBarLayout {
  if (!phoneBarHas(layout, id)) return layout
  return addPhoneBarItem(layout, id, slot)
}

/** Marker for the pill's place in a flattened layout. */
export const PILL = 'pill'
export type PhoneBarSequenceEntry = PhoneBarItemId | typeof PILL

/** The layout as one list with the pill in its place – what a reorder list shows. */
export function phoneBarSequence(layout: PhoneBarLayout): PhoneBarSequenceEntry[] {
  return [...layout.left, PILL, ...layout.right]
}

/** Back from a sequence (the pill's position decides the sides; a missing pill ends the left side). */
export function layoutFromSequence(sequence: readonly PhoneBarSequenceEntry[]): PhoneBarLayout {
  const at = sequence.indexOf(PILL)
  const items = (part: readonly PhoneBarSequenceEntry[]): PhoneBarItemId[] =>
    part.filter((e): e is PhoneBarItemId => e !== PILL)
  if (at < 0) return { left: items(sequence), right: [] }
  return { left: items(sequence.slice(0, at)), right: items(sequence.slice(at + 1)) }
}

/**
 * The slot an item lands in when dropped at position `position` of the sequence (0 = before
 * everything, `sequence.length` = after everything), the pill counted as a member of it.
 */
export function slotAtSequencePosition(layout: PhoneBarLayout, position: number): PhoneBarSlot {
  const pillAt = layout.left.length
  const p = Math.max(
    0,
    Math.min(layout.left.length + layout.right.length + 1, Math.round(position))
  )
  return p <= pillAt ? { side: 'left', index: p } : { side: 'right', index: p - pillAt - 1 }
}

// ---------------------------------------------------------------------------
// Enabled predicates
// ---------------------------------------------------------------------------

/** What an item's enabled state depends on. */
export interface PhoneBarItemContext {
  tab: Pick<Tab, 'url' | 'loading' | 'canGoBack' | 'canGoForward' | 'bookmarked'> | null
}

/** Whether the item does anything right now (a disabled button is drawn dimmed). */
export function phoneBarItemEnabled(id: PhoneBarItemId, ctx: PhoneBarItemContext): boolean {
  const { tab } = ctx
  switch (id) {
    case 'back':
      return Boolean(tab?.canGoBack)
    case 'forward':
      return Boolean(tab?.canGoForward)
    case 'reload':
    case 'find':
      return tab !== null && tab.url !== '' && tab.url !== BLANK_URL
    case 'bookmark':
    case 'share':
      return tab !== null && /^https?:/i.test(tab.url)
    default:
      return true
  }
}
