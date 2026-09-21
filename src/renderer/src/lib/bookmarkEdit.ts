import { defaultBookmarkFolderId } from '@shared/bookmarks'
import { activeTab } from './selectors'
import { browserStore, closeBookmarkChrome, openBookmarkChrome, pushToast, uiStore } from './ui'
import type { BookmarkEditRequest } from './ui'

export type { BookmarkEditRequest }

/**
 * Open the editor for a bookmark or folder. The node may not have reached the renderer yet (a
 * `bookmark.star` that overtook the state push); the editor then waits for it rather than
 * treating the gap as a deletion (design review of #38, item 1).
 *
 * The editor is a sheet over the page, so it opens in the order every surface over the page
 * keeps (`openBookmarkChrome`): the live page is captured first, and only then does the flag ask
 * the host to hide it, so the sheet's chassis comes up over the page's picture and never over
 * the window behind a page that was hidden with nothing in its place. Over the phone's
 * bookmarks panel the picture is the panel's already and the sheet opens in place.
 */
export function editBookmark(id: string): void {
  const state = browserStore.get().state
  if (!state) return
  const node = state.bookmarks.find((n) => n.id === id)
  const edit: BookmarkEditRequest = {
    id,
    parentId: node?.parentId ?? defaultBookmarkFolderId(state.platform),
    type: node?.type ?? 'url'
  }
  if (uiStore.get().overlay === 'bookmarks') uiStore.set({ bookmarkEdit: edit })
  else void openBookmarkChrome({ bookmarkEdit: edit }, activeTab(state)?.id ?? null)
}

/**
 * The editor has left (or is leaving): the picture is let go once the page is drawn back and,
 * with no other chrome needing the keyboard, the page gets it (`closeBookmarkChrome`).
 */
export function closeBookmarkEditor(): void {
  if (!uiStore.get().bookmarkEdit) return
  if (uiStore.get().overlay === 'bookmarks') uiStore.set({ bookmarkEdit: null })
  else closeBookmarkChrome({ bookmarkEdit: null })
}

/**
 * The star on a phone (HB-19): the page was saved the moment the star was pressed, so a fresh
 * bookmark only needs a toast – with the star that just filled and an Edit that opens the
 * editor. Pressing the star on a page that is bookmarked already goes straight to the editor.
 */
export function starredOnPhone(star: { nodeId: string; created: boolean }): void {
  if (!star.created) {
    editBookmark(star.nodeId)
    return
  }
  pushToast('Saved to Bookmarks', 'info', {
    icon: 'star',
    action: { label: 'Edit', onPick: () => editBookmark(star.nodeId) }
  })
}
