/**
 * The phone app menu's user order (Edge's Change menu, TB-22) as data. The menu's items carry a
 * stable key from one opening to the next (`MenuItemTemplate.key` / `MenuItemDescriptor.key`:
 * `icon.forward`, `row.settings`, `sep.3`); the sheet's edit mode saves the keys in the user's
 * order as `settings.menuOrder`, and the core reads that order against the build's default when
 * it composes the menu. This module owns the reading and the sanitising so the core can persist
 * and sync the setting and the sheet can be tested without a DOM.
 *
 * The icon row and the list under it are two sections ordered independently (§9.13 keeps the
 * row's membership fixed): the same saved list is applied to each, and each takes the keys it
 * has items for.
 */

/** The prefix of an icon-row item's key. */
export const MENU_KEY_ICON = 'icon.'
/** The prefix of a list row's key. */
export const MENU_KEY_ROW = 'row.'
/** The prefix of a hairline's key (the list's groups reorder as one list, hairlines included). */
export const MENU_KEY_SEP = 'sep.'

/** A saved order longer than this is cut: the phone menu has a few dozen items at most. */
export const MENU_ORDER_MAX = 96

/**
 * A persisted or synced `menuOrder` read like a profile's own: unique non-empty strings, capped.
 * Nothing valid – or an empty list, the Reset row's write – reads as the default (`undefined`),
 * so the setting is absent rather than empty.
 */
export function sanitizeMenuOrder(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const order: string[] = []
  for (const key of raw) {
    if (typeof key !== 'string' || key === '' || seen.has(key)) continue
    if (order.length >= MENU_ORDER_MAX) break
    seen.add(key)
    order.push(key)
  }
  return order.length > 0 ? order : undefined
}

/**
 * `items` in the saved order: the items the order names come first, in its order; the items it
 * never named – a newer build's additions, an item that was on the bar when the order was saved
 * – follow in the default order; a key the build has no item for (an older build's item, another
 * device's) is dropped. Items without a key are never named and keep to the second part. No
 * saved order, or an empty one, is the default order itself.
 */
export function applyMenuOrder<T>(
  items: readonly T[],
  keyOf: (item: T) => string | undefined,
  saved: readonly string[] | undefined
): T[] {
  if (!saved || saved.length === 0) return [...items]
  const byKey = new Map<string, T>()
  for (const item of items) {
    const key = keyOf(item)
    if (key !== undefined && !byKey.has(key)) byKey.set(key, item)
  }
  const placed = new Set<T>()
  const ordered: T[] = []
  for (const key of saved) {
    const item = byKey.get(key)
    if (item === undefined || placed.has(item)) continue
    placed.add(item)
    ordered.push(item)
  }
  for (const item of items) {
    if (placed.has(item)) continue
    placed.add(item)
    ordered.push(item)
  }
  return ordered
}

/**
 * Whether the saved order changes nothing about `items`: the Reset row is disabled when it
 * would restore what is already shown.
 */
export function isDefaultMenuOrder<T>(
  items: readonly T[],
  keyOf: (item: T) => string | undefined,
  saved: readonly string[] | undefined
): boolean {
  const ordered = applyMenuOrder(items, keyOf, saved)
  return ordered.every((item, index) => item === items[index])
}

/** The keys of `items`, in their order, for the edit mode's save (unkeyed items contribute none). */
export function menuOrderOf<T>(items: readonly T[], keyOf: (item: T) => string | undefined): string[] {
  const order: string[] = []
  for (const item of items) {
    const key = keyOf(item)
    if (key !== undefined) order.push(key)
  }
  return order
}

/**
 * `items` with the item at `from` moved to `to` (both indices into `items`; a move out of range
 * or onto itself leaves the list as it is). The edit mode's accessibility actions – Move up,
 * Move down, Move to start – and the drag's re-targeting all reduce to this.
 */
export function moveMenuItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return [...items]
  }
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved as T)
  return next
}
