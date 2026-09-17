import type { BookmarkNodeType } from '@shared/types'
import { defaultBookmarkFolderId } from '@shared/bookmarks'
import { browserStore, pushToast, uiStore } from './ui'
import type { BookmarkEditRequest } from './ui'

export type { BookmarkEditRequest }

/** Open the editor for an existing bookmark or folder; a node that is gone opens nothing. */
export function editBookmark(id: string): void {
  const state = browserStore.get().state
  const node = state?.bookmarks.find((n) => n.id === id)
  if (!state || !node) return
  uiStore.set({
    bookmarkEdit: {
      id,
      parentId: node.parentId ?? defaultBookmarkFolderId(state.platform),
      type: node.type
    }
  })
}

export function closeBookmarkEditor(): void {
  if (uiStore.get().bookmarkEdit) uiStore.set({ bookmarkEdit: null })
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
    action: { label: 'Edit', run: () => editBookmark(star.nodeId) }
  })
}
