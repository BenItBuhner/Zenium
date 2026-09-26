import type { JSX } from 'react'
import { useId, useRef, useState } from 'react'
import type { Platform } from '@shared/types'
import type { BookmarkTree } from '@shared/bookmarks'
import { cmd, run } from '@renderer/lib/api'
import { movableIds, moveTargets, sharedParentId } from '@renderer/lib/bookmarkList'
import type { BottomSheetHandle } from '../sheet/BottomSheet'
import { PhoneSheet } from './PhoneSheet'

/**
 * Move to… on a phone (HB-12 / HB-15; Chrome 152's `BookmarkFolderPickerMediator`, the picker
 * behind its row menu's and its selection toolbar's Move): a §9.13 picker sheet in the frame's
 * dialog host over the Bookmarks panel, of every folder the picked nodes can land in – the
 * whole tree in reading order, each level 16 further in (`moveTargets`: the moved folders and
 * their subtrees left out, as Chrome's list leaves out the moved rows), the folder they stand
 * in now checked and holding the focus as the sheet opens (§9.22), so the eye lands on where
 * they are. A tap checks a row; the footer's Move (§9.11, the primary trailing) slides the sheet
 * away and runs the core's `bookmark.move` once it is gone – disabled while the checked folder
 * is the one they came from, Chrome's `Move here` on the original parent; Cancel, the scrim, the
 * back gesture and Escape leave everything as it was. The header's trailing control is Chrome's
 * `Create new folder`: a §9.12 one-field sheet over this one (§9.24, depth two) names a folder
 * inside the checked one; created, it is checked in turn, ready for Move. Chrome shows no
 * snackbar for a move and neither does this – the move is on the core's bookmark undo stack.
 */
export function BookmarkMoveSheet({
  tree,
  platform,
  ids,
  onClose,
  onMoved
}: {
  tree: BookmarkTree
  platform: Platform
  /** The picked rows; roots and nodes carried by a picked ancestor are dropped (`movableIds`). */
  ids: readonly string[]
  /** The sheet has left the screen, moved or not. */
  onClose: () => void
  /** Move was chosen: the panel leaves its selection. Runs before the command does. */
  onMoved?: () => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const moving = movableIds(tree, ids)
  const origin = sharedParentId(tree, moving)
  const [chosen, setChosen] = useState<string | null>(origin)
  const [naming, setNaming] = useState(false)
  const rows = moveTargets(tree, moving, platform)
  // The checked folder may have gone (deleted elsewhere while the sheet stood): nothing checked.
  const checked = chosen !== null && rows.some((r) => r.node.id === chosen) ? chosen : null
  const canMove = moving.length > 0 && checked !== null && checked !== origin

  const move = (): void => {
    if (!canMove || checked === null) return
    const parentId = checked
    onMoved?.()
    sheet.current?.dismiss(() => run('bookmark.move', { ids: moving, parentId }))
  }

  const create = async (title: string): Promise<void> => {
    if (checked === null) return
    const node = await cmd('bookmark.create', { parentId: checked, title, type: 'folder' })
    if (node) setChosen(node.id)
  }

  return (
    <>
      <PhoneSheet
        name="bookmark-move"
        title={{
          pose: 'header',
          text: 'Move to',
          trailing: (
            // Disabled (§9.30, laid out at .4) while no folder is checked to hold the new one –
            // Chrome's Create new folder at its root, where a folder cannot be made.
            <button
              type="button"
              className="zen-sheet-header-control disabled:opacity-40"
              data-side="trailing"
              data-text
              disabled={checked === null}
              onClick={() => setNaming(true)}
            >
              New folder
            </button>
          )
        }}
        focus="checked"
        onClose={onClose}
        body="list"
        openExpanded="overflow"
        under={naming}
        handleLabel="Resize folder list"
        sheetRef={sheet}
        footer={
          <div className="zen-sheet-footer">
            <button
              type="button"
              className="zen-v2-button"
              onClick={() => sheet.current?.dismiss()}
            >
              Cancel
            </button>
            <button
              type="button"
              className="zen-v2-button"
              data-primary
              disabled={!canMove}
              onClick={move}
            >
              Move
            </button>
          </div>
        }
      >
        <div role="radiogroup" aria-label="Folder" className="pb-2">
          {rows.map(({ node, depth }) => (
            <button
              key={node.id}
              type="button"
              role="radio"
              aria-checked={node.id === checked}
              className="zen-v2-row"
              style={depth ? { paddingInlineStart: 16 + depth * 16 } : undefined}
              onClick={() => setChosen(node.id)}
            >
              <span className="zen-v2-radio" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{node.title}</span>
              {node.id === origin && <span className="zen-list-value shrink-0">Current</span>}
            </button>
          ))}
        </div>
      </PhoneSheet>
      {naming && (
        <NewFolderSheet
          parentTitle={checked !== null ? (tree.get(checked)?.title ?? '') : ''}
          onClose={() => setNaming(false)}
          onCreate={(title) => void create(title)}
        />
      )}
    </>
  )
}

/**
 * The picker's `New folder`: a §9.12 one-field sheet – the field labelled by the header that
 * reads its name, no autofocus (§9.22: the keyboard would come up with the sheet), the footer's
 * Cancel · Create (disabled until the name has a character). Create slides the sheet away and
 * makes the folder once it is gone, inside the picker's checked folder.
 */
function NewFolderSheet({
  parentTitle,
  onClose,
  onCreate
}: {
  parentTitle: string
  onClose: () => void
  onCreate: (title: string) => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const [name, setName] = useState('')
  const titleId = useId()
  const trimmed = name.trim()
  const submit = (): void => {
    if (!trimmed) return
    sheet.current?.dismiss(() => onCreate(trimmed))
  }
  return (
    <PhoneSheet
      name="bookmark-move-new-folder"
      title={{ pose: 'header', text: 'New folder' }}
      titleId={titleId}
      focus="dialog"
      onClose={onClose}
      handleLabel="Resize editor"
      sheetRef={sheet}
    >
      <form
        className="zen-phone-form"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="zen-phone-form-field">
          <span className="zen-phone-field">
            <input
              value={name}
              placeholder={parentTitle ? `Folder in ${parentTitle}` : 'Folder name'}
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="done"
              aria-labelledby={titleId}
              onChange={(e) => setName(e.target.value)}
            />
          </span>
        </div>
        <div className="zen-sheet-footer">
          <button type="button" className="zen-v2-button" onClick={() => sheet.current?.dismiss()}>
            Cancel
          </button>
          <button type="submit" className="zen-v2-button" data-primary disabled={!trimmed}>
            Create
          </button>
        </div>
      </form>
    </PhoneSheet>
  )
}
