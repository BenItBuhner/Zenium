import type { BookmarkNode, Tab } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import {
  BOOKMARK_ROW_DISPLAYS,
  BOOKMARK_ROW_SORT_ORDERS,
  type BookmarkRowDisplay,
  type BookmarkRowSortOrder
} from '@shared/bookmarkRows'
import { MENU_GAP, type LocalMenuItem } from './ui'

/**
 * The phone bookmarks panel's "Sort and view options" (HB-13): Chrome 152's submenu behind the
 * manager's toolbar (`bookmark_toolbar_menu_improved.xml`: the `sort_opts` radio group, then
 * the `view_opts` radio group) with its words verbatim (`android_chrome_strings.grd`,
 * `IDS_SORT_SUBMENU`, `IDS_SORT_BY_*`, `IDS_VISUAL_VIEW`, `IDS_COMPACT_VIEW`) and the
 * announcements it makes on a pick (`IDS_SORT_BY_*_ANNOUNCEMENT`, `IDS_*_VIEW_ANNOUNCEMENT`).
 * Radio rows are sentence case as Chrome's are (v2 §9.1).
 */

export const SORT_VIEW_MENU_TITLE = 'Sort and view options'

export const SORT_ORDER_LABELS: Readonly<Record<BookmarkRowSortOrder, string>> = {
  manual: 'Sort by manual order',
  newest: 'Sort by newest',
  oldest: 'Sort by oldest',
  'last-opened': 'Sort by last opened',
  'a-z': 'Sort by A to Z',
  'z-a': 'Sort by Z to A'
}

export const SORT_ORDER_ANNOUNCEMENTS: Readonly<Record<BookmarkRowSortOrder, string>> = {
  manual: 'Sorting by manual order',
  newest: 'Sorting by newest',
  oldest: 'Sorting by oldest',
  'last-opened': 'Sorting by last opened',
  'a-z': 'Sorting from A to Z',
  'z-a': 'Sorting from Z to A'
}

export const DISPLAY_LABELS: Readonly<Record<BookmarkRowDisplay, string>> = {
  visual: 'Visual view',
  compact: 'Compact view'
}

export const DISPLAY_ANNOUNCEMENTS: Readonly<Record<BookmarkRowDisplay, string>> = {
  visual: 'Showing visual view',
  compact: 'Showing compact view'
}

export interface SortViewChoice {
  sortOrder: BookmarkRowSortOrder
  display: BookmarkRowDisplay
}

/**
 * The menu's rows: the six orders as one radio group, a gap, the two views as another – the
 * current one of each checked. A pick hands the new value on; a pick of the checked row is a
 * no-op, as Chrome's `BookmarkToolbarMediator` writes the same pref again to no effect.
 */
export function sortViewMenuItems(
  current: SortViewChoice,
  onSortOrder: (order: BookmarkRowSortOrder) => void,
  onDisplay: (display: BookmarkRowDisplay) => void
): Array<LocalMenuItem | typeof MENU_GAP> {
  return [
    ...BOOKMARK_ROW_SORT_ORDERS.map((order): LocalMenuItem => ({
      type: 'radio',
      label: SORT_ORDER_LABELS[order],
      checked: order === current.sortOrder,
      onSelect: () => {
        if (order !== current.sortOrder) onSortOrder(order)
      }
    })),
    MENU_GAP,
    ...BOOKMARK_ROW_DISPLAYS.map((display): LocalMenuItem => ({
      type: 'radio',
      label: DISPLAY_LABELS[display],
      checked: display === current.display,
      onSelect: () => {
        if (display !== current.display) onDisplay(display)
      }
    }))
  ]
}

/** The document a URL names – the address without its fragment – or the string itself when it is no URL. */
function documentOf(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    return u.href
  } catch {
    return url
  }
}

/**
 * The open tab whose page a bookmark's visual tile can show, or null. Chrome's visual row draws
 * the page's image from its image service (`BookmarkImageFetcher.fetchImageForBookmarkWithFaviconFallback`);
 * Zenium has no such service and shows the card picture of an open tab on the same document
 * (`lib/thumbnails.ts`) – never a private tab's: a private page's picture shows on no surface
 * outside its own space. Ties go to the first tab in the state's order.
 */
export function pictureTabFor(
  node: BookmarkNode,
  tabs: Readonly<Record<string, Tab>>
): string | null {
  if (node.type !== 'url' || !node.url) return null
  const wanted = documentOf(node.url)
  for (const tab of Object.values(tabs)) {
    if (tab.containerId === PRIVATE_CONTAINER_ID) continue
    if (documentOf(tab.url) === wanted) return tab.id
  }
  return null
}
