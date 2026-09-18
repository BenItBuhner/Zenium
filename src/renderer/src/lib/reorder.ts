/**
 * The arithmetic of reordering a list by drag: which slot the pointer is over, how far the
 * neighbours slide to open the gap there, where the insertion caret sits in that gap, and the
 * drop key that names the slot. Positions run along the list's axis (y for the sidebar's tab
 * rows, x for the bookmarks bar); "others" are the list's items without the one in the hand, in
 * list order, and `liftedAt` is the slot the lifted item came out of, counted among them.
 */
export interface Span {
  start: number
  end: number
}

/**
 * The slot the pointer is over, read off the other items as drawn: crossing an item's midpoint
 * sends it to the other side of the pointer, never through it, so the gap keeps following the
 * pointer.
 */
export function slotAt(pointer: number, midpoints: readonly number[]): number {
  let index = 0
  for (const mid of midpoints) if (pointer > mid) index++
  return index
}

/**
 * Translations that open the gap at `index`: the others between the hole and the slot shift by
 * one item towards the hole. Returned by position among the others; 0 for items that stay.
 */
export function slideOffsets(
  liftedAt: number,
  index: number,
  count: number,
  shift: number
): number[] {
  const offsets: number[] = []
  for (let j = 0; j < count; j++) {
    if (j >= liftedAt && j < index) offsets.push(-shift)
    else if (j >= index && j < liftedAt) offsets.push(shift)
    else offsets.push(0)
  }
  return offsets
}

/**
 * Centre of the opened gap along the axis, from the resting spans: past the hole the gap opens
 * behind the item that slid up into the hole's place; before it, ahead of the item that slid
 * down; at the hole itself it is the lifted item's own slot.
 */
export function gapCentre(
  liftedAt: number,
  index: number,
  others: readonly Span[],
  own: Span
): number {
  const size = own.end - own.start
  if (index > liftedAt && others[index - 1]) return others[index - 1].end - size / 2
  if (index < liftedAt && others[index]) return others[index].start + size / 2
  return own.start + size / 2
}

/**
 * The drop key naming the slot: beside the neighbour the item lands next to. Landing back in
 * its own slot is `stay`; `keep` is the key that would pin the item where it is (for a drop
 * that must name a slot even then), null when it is alone in the list.
 */
export function slotKey(
  others: readonly string[],
  liftedAt: number,
  index: number
): { key: string | null; stay: boolean } {
  if (index === liftedAt) return { key: keepKey(others, liftedAt), stay: true }
  if (index > liftedAt) return { key: `tab:${others[index - 1]}:after`, stay: false }
  return { key: `tab:${others[index]}:before`, stay: false }
}

function keepKey(others: readonly string[], liftedAt: number): string | null {
  if (liftedAt > 0) return `tab:${others[liftedAt - 1]}:after`
  if (others.length > 0) return `tab:${others[0]}:before`
  return null
}
