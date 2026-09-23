import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { Trash2 } from 'lucide-react'
import type { UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { folderDeleteWords } from '@renderer/lib/folderDelete'
import { POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import { closeFolderDeleteConfirm, type UiState } from '@renderer/lib/ui'
import { useEscapeTrap } from '../bookmarks/escape'
import { focusAnchor, wrapTab } from '../bookmarks/popover'

/**
 * "Delete <folder>?" (TAB-16's desktop half; the phone's `DeleteGroupSheet` in the desktop's
 * dialog form): a §9.23 prompt – the title block with the question at 17/600 and one line at 15
 * in the deemphasised ink, then Cancel and the danger verb, no primary – as a frame dialog at
 * §9.20's 320 (a confirmation is a notice) over the active page's picture, centred in the
 * content frame under the frame's scrim (§9.5), through TabDialogs' `FrameDialogHost`. Deleting
 * an open folder closes its tabs with it (each to Recently Closed); deleting a saved folder
 * forgets the pages it kept, which nothing brings back. The keyboard starts on Cancel (§9.22 –
 * destructive), Tab wraps, Escape and the scrim are Cancel; a Cancel from the keyboard hands the
 * keyboard back to the folder's header row (§9.5: one hop down), a pointer's to the page.
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
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const words = folderDeleteWords(name, count, saved)
  const titleId = 'zen-folder-delete-title'
  const bodyId = 'zen-folder-delete-body'
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])
  const cancel = (): void => {
    closeFolderDeleteConfirm(keyboard)
    if (keyboard) focusAnchor(`[data-tab-folder="${folderId}"]`)
  }
  const confirm = (): void => {
    // The header the prompt hung from goes with the folder: the page takes the keyboard back.
    closeFolderDeleteConfirm(false)
    run('folder.delete', { folderId, unpack: false })
  }
  useEscapeTrap(true, cancel)
  useFrameDialog({ onScrimPress: cancel })
  return (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-folder-delete={folderId}
      className="zen-animate-pop zen-bm-dialog flex max-w-[calc(100%-24px)] flex-col"
      style={{ width: POPOVER_WIDTH.list }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') wrapTab(e, dialogRef.current)
      }}
    >
      <div className="zen-bm-title-block">
        <h2 id={titleId} className="zen-bm-title flex items-center gap-2">
          <Trash2 className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden />
          <span className="min-w-0 truncate">{words.title}</span>
        </h2>
        <p id={bodyId} className="zen-bm-title-desc">
          {words.detail}
        </p>
      </div>
      <div className="zen-bm-form">
        <div className="zen-bm-footer justify-end">
          <button ref={cancelRef} type="button" className="zen-button" onClick={cancel}>
            Cancel
          </button>
          <button
            type="button"
            className="zen-button"
            data-variant="danger"
            data-action="delete"
            onClick={confirm}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
