import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { Trash2 } from 'lucide-react'
import type { UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { folderDeleteWords } from '@renderer/lib/folderDelete'
import { returnFocusTo, wrapTab } from '@renderer/lib/popover'
import { POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import { closeFolderDeleteConfirm, type UiState } from '@renderer/lib/ui'
import { useEscapeTrap } from '../bookmarks/escape'

/**
 * "Delete <folder>?" (TAB-16's desktop half; the phone's `DeleteGroupSheet` in the desktop's
 * dialog form): a §9.23 prompt – the title block with the question at 17/600 and one line at 15
 * in the deemphasised ink, then Cancel and the danger verb, no primary – as a frame dialog at
 * §9.20's 320 (a confirmation is a notice) over the active page's picture, centred in the
 * content frame under the frame's scrim (§9.5), through TabDialogs' `FrameDialogHost`. Deleting
 * an open folder closes its tabs with it (each to Recently Closed); deleting a saved folder
 * forgets the pages it kept, which nothing brings back.
 *
 * The keyboard (§9.22 as the #340 verdict reads it): a prompt preselects no verb. The dialog
 * itself takes the focus as it opens – its root is `tabIndex -1`, the container the keyboard is
 * sent to and cannot reach by Tab, so the chassis draws no ring on it
 * (`[role='alertdialog'][tabindex='-1']:focus-visible` in main.css) and none lands on Cancel –
 * and the first Tab enters at Cancel, Shift+Tab at Delete; between the two the keys wrap at the
 * ends (lib/popover.ts `wrapTab`). Escape and the scrim are Cancel; a Cancel from the keyboard
 * hands the keyboard back to the folder's header row (§9.5: one hop down), a pointer's to the
 * page. The header stands in the window chrome, which the frame's host keeps inert through the
 * prompt's way out (§9.5), so it refuses the focus as the prompt leaves: the shared
 * `returnFocusTo` gives it the focus as the chrome's `inert` lifts.
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
  const words = folderDeleteWords(name, count, saved)
  const titleId = 'zen-folder-delete-title'
  const bodyId = 'zen-folder-delete-body'
  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true })
  }, [])
  const cancel = (): void => {
    closeFolderDeleteConfirm(keyboard)
    if (!keyboard) return
    const header = document.querySelector<HTMLElement>(`[data-tab-folder="${folderId}"]`)
    if (header) returnFocusTo(header)
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
      tabIndex={-1}
      className="zen-animate-pop zen-bm-dialog flex max-w-[calc(100%-24px)] flex-col"
      style={{ width: POPOVER_WIDTH.list }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' && dialogRef.current) wrapTab(dialogRef.current, e.nativeEvent)
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
          <button type="button" className="zen-button" onClick={cancel}>
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
