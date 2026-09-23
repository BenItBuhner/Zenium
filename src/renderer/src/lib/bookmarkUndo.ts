import type { Events } from '@shared/types'
import { run } from './api'
import { dismissToast, pushToast } from './ui'

/**
 * The toast a bookmark delete leaves, on every layout (bookmarks-31, v2 §9.33: one line, one
 * action): "Bookmark deleted" with Undo, which names the delete's own token so it brings back
 * that delete and nothing edited since. On the phone it is the tab row's Remove Bookmark that
 * speaks through it; the phone panels' deletes carry their own Undo and commit `quiet`, so the
 * core says nothing for them. One such toast is live at a time – a second delete replaces the
 * first's, whose delete stays undoable from the manager (Ctrl+Z). Its clock runs longer than a
 * plain action toast's: an accidental delete is noticed late.
 */
// 8 s: §9.33's grant for Undo toasts (the lead's, #357), above the 5 s a plain action toast keeps (`TOAST_ACTION_DURATION`).
export const BOOKMARK_UNDO_TOAST_MS = 8000

let liveToastId: number | null = null
/** The delete the live toast offers to undo. */
let liveToken: number | null = null

/** What the toast says for `count` top-level nodes of `kind`. */
export function bookmarkDeletedMessage(removal: Events['bookmark.deleted']): string {
  const { count, kind } = removal
  if (count === 1) return kind === 'folder' ? 'Folder deleted' : 'Bookmark deleted'
  const noun = kind === 'bookmark' ? 'bookmarks' : kind === 'folder' ? 'folders' : 'items'
  return `${count} ${noun} deleted`
}

export function showBookmarkDeleted(removal: Events['bookmark.deleted']): void {
  if (liveToastId !== null) dismissToast(liveToastId)
  liveToken = removal.token
  liveToastId = pushToast(bookmarkDeletedMessage(removal), 'info', {
    duration: BOOKMARK_UNDO_TOAST_MS,
    action: { label: 'Undo', onPick: () => run('bookmark.undo', { token: removal.token }) }
  })
}

/**
 * An edit was taken back somewhere – the manager's Ctrl+Z, another window's toast: when it is
 * the delete the live toast offers, the toast goes down, its Undo having nothing left to do.
 */
export function bookmarkEditUndone(undone: Events['bookmark.undone']): void {
  if (liveToastId === null || undone.token !== liveToken) return
  dismissToast(liveToastId)
  liveToastId = null
  liveToken = null
}
