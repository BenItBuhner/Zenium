import type { BookmarkNode, BookmarksBarMode } from './types'
import { type BookmarkSort, type BookmarkTree, sortBookmarkNodes } from './bookmarks'
import { isEmptyTabUrl } from './url'

/**
 * View-side helpers on the bookmark model for the desktop chrome: when the bar shows, how the
 * manager orders a folder and what Chrome's "Sort by name" does to one. The model itself
 * (`./bookmarks`) is owned by the shared-services program and is only read here.
 */

/**
 * Whether the bookmarks bar shows for the page on screen: `always`, `never`, or (Edge's default)
 * only on the new tab page. Compact mode hides it with the rest of the chrome regardless.
 */
export function bookmarksBarVisible(mode: BookmarksBarMode, url: string | null): boolean {
  if (mode === 'always') return true
  if (mode === 'never') return false
  return isEmptyTabUrl(url)
}

/** Ctrl+Shift+B: a visible bar hides for good, a hidden (or new-tab-only) bar shows for good. */
export function toggledBookmarksBarMode(
  mode: BookmarksBarMode,
  url: string | null
): BookmarksBarMode {
  return bookmarksBarVisible(mode, url) ? 'never' : 'always'
}

/** The manager's view orders: the model's sorts plus Chrome's "URL" column. */
export type ManagerSort = BookmarkSort | 'url'

const collate = (x: string, y: string): number =>
  x.localeCompare(y, undefined, { sensitivity: 'base', numeric: true })

/**
 * Order a folder's rows for the manager. Folders always come first: sorted by name they are
 * A to Z, sorted by URL (which they do not have) they keep their manual order; "Date added"
 * shows the newest first.
 */
export function sortManagerRows(nodes: readonly BookmarkNode[], sort: ManagerSort): BookmarkNode[] {
  if (sort !== 'url') return sortBookmarkNodes(nodes, sort, sort === 'dateAdded')
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    if (a.type === 'folder') return a.index - b.index
    return collate(a.url ?? '', b.url ?? '')
  })
}

/** Chrome asks before "Open all" opens this many pages at once (`kNumBookmarkUrlsBeforePrompting`). */
export const OPEN_ALL_PROMPT_AT = 15

/**
 * The confirmation "Open all" shows for `count` pages, or null when they open without asking.
 * The shape is the dialog host's `ConfirmOptions`.
 */
export function openAllPrompt(
  count: number
): { message: string; detail: string; okLabel: string; cancelLabel: string } | null {
  if (count < OPEN_ALL_PROMPT_AT) return null
  return {
    message: 'Open all bookmarks?',
    detail: `You are about to open ${count} tabs. Are you sure?`,
    okLabel: 'Open All',
    cancelLabel: 'Cancel'
  }
}

/**
 * Chrome's "Sort by name" on a folder: its direct children, folders first, then A to Z, as the
 * ids to hand `move(ids, folderId, 0)` in one call. Null when the folder is missing or already
 * in that order, so nothing is written.
 */
export function sortedByNameOrder(tree: BookmarkTree, folderId: string): string[] | null {
  const folder = tree.get(folderId)
  if (!folder || folder.type !== 'folder') return null
  const children = tree.children(folderId)
  const sorted = sortBookmarkNodes(children, 'name')
  if (sorted.every((n, i) => n.id === children[i]?.id)) return null
  return sorted.map((n) => n.id)
}
