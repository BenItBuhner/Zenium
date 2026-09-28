import type { BookmarkNode } from './types'

/**
 * The phone's bookmark rows: how a folder (or a search) is ordered and how a row is drawn.
 * Chrome's `BookmarkUiPrefs` (chrome/browser/bookmarks/android/.../BookmarkUiPrefs.java):
 * `BookmarkRowSortOrder` (MANUAL default) and `BookmarkRowDisplayPref` (VISUAL default), both
 * kept in the device's SharedPreferences (`Chrome.Bookmarks.BookmarkRowSortOrder`,
 * `Chrome.Bookmarks.BookmarkRowDisplay`) and never synced – so both are `DEVICE_LOCAL_SETTINGS`
 * here. One stated deviation: the display's default is COMPACT, not Chrome's VISUAL (design
 * language v2 §9.29 – a taller row carrying the same favicon is not a view; Visual becomes the
 * default the day the tile has pictures to show). The model (`./bookmarks`) is the
 * shared-services program's and is only read.
 */

/** Chrome's six orders, `BookmarkRowSortOrder` in the menu's order. */
export type BookmarkRowSortOrder = 'manual' | 'newest' | 'oldest' | 'last-opened' | 'a-z' | 'z-a'
export const BOOKMARK_ROW_SORT_ORDERS: readonly BookmarkRowSortOrder[] = [
  'manual',
  'newest',
  'oldest',
  'last-opened',
  'a-z',
  'z-a'
]
/** Chrome's `BookmarkUiPrefs.getBookmarkRowSortOrder` default: `MANUAL`. */
export const DEFAULT_BOOKMARK_ROW_SORT_ORDER: BookmarkRowSortOrder = 'manual'

/** Chrome's `BookmarkRowDisplayPref`: `VISUAL` (an image tile) or `COMPACT` (the favicon). */
export type BookmarkRowDisplay = 'visual' | 'compact'
export const BOOKMARK_ROW_DISPLAYS: readonly BookmarkRowDisplay[] = ['visual', 'compact']
/**
 * The default display: `compact` – a STATED DEVIATION from Chrome's `VISUAL`
 * (`BookmarkUiPrefs.getBookmarkRowDisplayPref`), by v2 §9.29: Zenium has no page-image service,
 * so a visual tile mostly carries the favicon the compact row already shows. Also the
 * sanitiser's fallback and `DEFAULT_SETTINGS.bookmarkRowDisplay`.
 */
export const DEFAULT_BOOKMARK_ROW_DISPLAY: BookmarkRowDisplay = 'compact'

/** A stored order, or the default for a profile from before the key or a hand-edited one. */
export function sanitizeBookmarkRowSortOrder(value: unknown): BookmarkRowSortOrder {
  return typeof value === 'string' &&
    (BOOKMARK_ROW_SORT_ORDERS as readonly string[]).includes(value)
    ? (value as BookmarkRowSortOrder)
    : DEFAULT_BOOKMARK_ROW_SORT_ORDER
}

/** A stored display, or the default for a profile from before the key or a hand-edited one. */
export function sanitizeBookmarkRowDisplay(value: unknown): BookmarkRowDisplay {
  return typeof value === 'string' && (BOOKMARK_ROW_DISPLAYS as readonly string[]).includes(value)
    ? (value as BookmarkRowDisplay)
    : DEFAULT_BOOKMARK_ROW_DISPLAY
}

const collate = (x: string, y: string): number =>
  x.localeCompare(y, undefined, { sensitivity: 'base', numeric: true })

/** Chrome's `getDateLastOpened()`: 0 for a bookmark that was never opened. */
const lastOpened = (node: BookmarkNode): number => node.dateLastUsed ?? 0

/** Chrome's `ImprovedBookmarkQueryHandler.sortCompare`: the order's key alone. */
function compareByKey(a: BookmarkNode, b: BookmarkNode, order: BookmarkRowSortOrder): number {
  switch (order) {
    case 'oldest':
      return a.dateAdded - b.dateAdded
    case 'newest':
      return b.dateAdded - a.dateAdded
    case 'a-z':
      return collate(a.title, b.title)
    case 'z-a':
      return collate(b.title, a.title)
    case 'last-opened':
      return lastOpened(b) - lastOpened(a)
    case 'manual':
      return 0
  }
}

/**
 * Chrome's `ImprovedBookmarkQueryHandler.sortByStoredPref`: `manual` leaves the rows as they
 * came (the stored order – the model's `index`, or the search's rank); every other order puts
 * folders before bookmarks, compares the key, and falls back to the id so that ties come out
 * the same each time. Chrome compares titles with `compareToIgnoreCase`; this collates them
 * case-insensitively and numerically, as the desktop manager's `sortManagerRows` does.
 * Applied to a folder's rows and to search results alike, as Chrome applies it to both.
 */
export function sortBookmarkRows(
  nodes: readonly BookmarkNode[],
  order: BookmarkRowSortOrder
): BookmarkNode[] {
  if (order === 'manual') return [...nodes]
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    const byKey = compareByKey(a, b, order)
    if (byKey !== 0) return byKey
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}
