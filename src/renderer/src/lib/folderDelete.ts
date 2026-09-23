import { run } from './api'
import { openedFromKeyboard } from './popover'
import { activeTab } from './selectors'
import { browserStore, openFolderDeleteConfirm, uiStore } from './ui'

/*
 * Deleting a folder – the sidebar's tab group (TAB-16's desktop half) – the way the desktop asks
 * it: the folder menu's "Delete Folder" (the core's `folder.confirmDelete`) and the group editor
 * bubble's "Delete folder" both land here. A folder holding tabs or saved pages goes only through
 * the "Delete <folder>?" prompt (components/sidebar/FolderDeleteDialog.tsx); an empty one goes at
 * once, there being nothing to lose.
 */

/**
 * The prompt's words (the phone's group sheet's, in the desktop's vocabulary): the question with
 * the folder's name, and one line on what the deletion takes – an open folder's tabs close with
 * it, each to Recently Closed; a saved folder's pages are forgotten, with no way back.
 */
export function folderDeleteWords(
  name: string,
  count: number,
  saved: boolean
): { title: string; detail: string } {
  const one = count === 1
  const unit = saved ? `${count} saved page${one ? '' : 's'}` : `${count} tab${one ? '' : 's'}`
  return {
    title: `Delete ${name.trim() || 'folder'}?`,
    detail: saved
      ? `Its ${unit} ${one ? 'is' : 'are'} forgotten with it. There is no undo.`
      : `Its ${unit} close${one ? 's' : ''} with it; Recently Closed keeps ${one ? 'its page' : 'their pages'}.`
  }
}

/** Whether `folderId` holds anything a deletion would take: a live tab, or the pages it kept. */
export function folderHoldsAnything(folderId: string): boolean {
  const state = browserStore.get().state
  const folder = state?.folders[folderId]
  if (!state || !folder) return false
  return (
    Boolean(folder.savedTabs?.length) ||
    Object.values(state.tabs).some((t) => t.folderId === folderId)
  )
}

/**
 * Delete the folder, asking first when it holds tabs or pages. `keyboard` is whether a chrome
 * control had the keyboard (the header, a focused row; the folder menu opened from it), so the
 * prompt's Cancel hands it back to the header rather than the page (§9.22); read off the focus
 * ring when not given.
 */
export function requestFolderDelete(folderId: string, keyboard = openedFromKeyboard()): void {
  const state = browserStore.get().state
  if (!state?.folders[folderId]) return
  if (!folderHoldsAnything(folderId)) {
    run('folder.delete', { folderId, unpack: false })
    return
  }
  // The prompt replaces the bubble it may have come from (§9.20, one popover at a time), and
  // keeps the bubble's own word on whether the header had the keyboard when it opened.
  const bubble = uiStore.get().groupEditor
  const fromKeyboard = keyboard || (bubble?.folderId === folderId && bubble.keyboard)
  void openFolderDeleteConfirm(folderId, activeTab(state)?.id ?? null, fromKeyboard)
}
