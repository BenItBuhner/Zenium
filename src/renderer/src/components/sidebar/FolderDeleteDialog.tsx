import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { Trash2 } from 'lucide-react'
import type { UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { folderDeleteWords } from '@renderer/lib/folderDelete'
import { closeFolderDeleteConfirm, type UiState } from '@renderer/lib/ui'
import { ConfirmDialog } from '../dialogs/ConfirmDialog'

/**
 * "Delete <folder>?" (TAB-16's desktop half; the phone's `DeleteGroupSheet` in the desktop's
 * dialog form): the §9.23 confirmation (`ConfirmDialog`) – the question at 17/600 with the trash
 * glyph, one line at 15 in the deemphasised ink on what goes, then Cancel and the danger verb,
 * no primary (§6) – at §9.20's 320 over the active page's picture, centred in the content frame
 * under the frame's scrim (§9.5), through TabDialogs' `FrameDialogHost`. Deleting an open folder
 * closes its tabs with it (each to Recently Closed); deleting a saved folder forgets the pages
 * it kept, which nothing brings back.
 *
 * The keyboard is the primitive's (§9.22 as the #340 verdict reads it, amended on #392): the
 * prompt preselects no verb and holds its container, Tab enters at Cancel, Shift+Tab at Delete;
 * a destructive prompt has no default, so Enter from the held container answers nothing – only
 * a focused Delete's own Enter or Space deletes – and Escape and the scrim are Cancel. A Cancel
 * from the keyboard hands the keyboard
 * back to the folder's header row (§9.5: one hop down) – which stands in the window chrome, kept
 * inert through the prompt's way out, so the primitive's return waits for that `inert` to lift;
 * a pointer's Cancel, and a Delete (whose header goes with the folder), give it to the page.
 */
export function FolderDeleteDialog({
  state,
  request
}: {
  state: UIState
  request: NonNullable<UiState['folderDeleteConfirm']>
}): JSX.Element | null {
  const folder = state.folders[request.folderId]
  const live = Object.values(state.tabs).filter((t) => t.folderId === request.folderId).length
  const saved = live === 0 ? (folder?.savedTabs?.length ?? 0) : 0
  const count = live || saved
  // The folder went, or emptied, under the question (deleted or opened in another window): the
  // question goes with it.
  useEffect(() => {
    if (!folder || count === 0) closeFolderDeleteConfirm(request.keyboard)
  }, [folder, count, request.keyboard])
  if (!folder || count === 0) return null
  return (
    <FolderDeletePrompt
      key={folder.id}
      folderId={folder.id}
      name={folder.name}
      count={count}
      saved={live === 0}
      keyboard={request.keyboard}
    />
  )
}

function FolderDeletePrompt({
  folderId,
  name,
  count,
  saved,
  keyboard
}: {
  folderId: string
  name: string
  count: number
  saved: boolean
  keyboard: boolean
}): JSX.Element {
  const words = folderDeleteWords(name, count, saved)
  /** How the prompt was answered, for the return: only a keyboard's Cancel goes to the header. */
  const answer = useRef<'cancel' | 'delete' | null>(null)
  const cancel = (): void => {
    answer.current ??= 'cancel'
    closeFolderDeleteConfirm(keyboard)
  }
  const confirm = (): void => {
    answer.current ??= 'delete'
    // The header the prompt hung from goes with the folder: the page takes the keyboard back.
    closeFolderDeleteConfirm(false)
    run('folder.delete', { folderId, unpack: false })
  }
  return (
    <ConfirmDialog
      name="folder-delete"
      title={words.title}
      glyph={<Trash2 strokeWidth={1.5} aria-hidden />}
      description={words.detail}
      action="Delete"
      destructive
      onCancel={cancel}
      onConfirm={confirm}
      returnFocus={() =>
        // A keyboard's Cancel: the header (or, should it have gone under the prompt, the
        // primitive's fallback to the opener). A pointer's Cancel and a Delete: nowhere of the
        // prompt's own – `closeFolderDeleteConfirm` hands the keyboard to the page.
        keyboard && answer.current !== 'delete'
          ? document.querySelector<HTMLElement>(`[data-tab-folder="${folderId}"]`)
          : false
      }
      data={{ 'data-folder-delete': folderId }}
    />
  )
}
