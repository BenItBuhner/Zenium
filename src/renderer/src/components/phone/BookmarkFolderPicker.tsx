import type { JSX } from 'react'
import { useId, useRef, useState } from 'react'
import type { MoveTarget } from '@renderer/lib/bookmarkList'
import type { BottomSheetHandle } from '../sheet/BottomSheet'
import { PhoneSheet } from './PhoneSheet'

/**
 * The phone's folder picker, shared by the Move sheet (`BookmarkMoveSheet`, HB-12 / HB-15) and
 * the bookmark editor's Folder row (`BookmarkEditSheet`, HB-16) – the form the lead passed on
 * #570: a §9.13 radio list of every folder the nodes can land in, the whole tree in reading
 * order (`moveTargets`), each level 16 further in, the checked row's glyph filled and the folder
 * the nodes stand in now saying `Current` aside at the value's 13/69 %. Chrome 152's
 * `BookmarkFolderPickerMediator` drills one folder a page with a chevron on every row and no
 * mark on the current parent (its Move here is merely disabled there); the flat list shows the
 * same folders at once. The ones the nodes cannot enter are already left out by `moveTargets`,
 * as Chrome leaves the moved ids out of its rows (Mediator l.182) with their subtree unreachable
 * by construction; Chrome's `isValidFolderForMovedBookmarks` (l.296-305) greys the special
 * folders instead – the root, managed and partner folders, the reading list – which
 * `moveTargets` never lists.
 *
 * The indent is the eye's reading of the tree; assistive technology reads each row's name as
 * "title, in parent" (and ", current folder" on the one the nodes stand in), the parent taken
 * from the rows themselves, so Work and Specs are not peers to a screen reader either. The
 * row's visible text stays the bare title.
 */
export function BookmarkFolderList({
  rows,
  checked,
  current,
  label = 'Folder',
  onPick
}: {
  /** Every folder that can take the nodes, in reading order with its depth (`moveTargets`). */
  rows: readonly MoveTarget[]
  /** The row that is checked; none when the checked folder has gone. */
  checked: string | null
  /** The folder the nodes stand in now, `Current` aside its title. */
  current: string | null
  /** The group's accessible name: the header the list stands under (`Folder`, `Parent folder`). */
  label?: string
  onPick: (id: string) => void
}): JSX.Element {
  const titles = new Map(rows.map(({ node }) => [node.id, node.title]))
  return (
    <div role="radiogroup" aria-label={label} className="pb-2">
      {rows.map(({ node, depth }) => (
        <button
          key={node.id}
          type="button"
          role="radio"
          aria-checked={node.id === checked}
          aria-label={[
            node.title,
            node.parentId !== null && titles.has(node.parentId)
              ? `in ${titles.get(node.parentId)}`
              : null,
            node.id === current ? 'current folder' : null
          ]
            .filter(Boolean)
            .join(', ')}
          className="zen-v2-row"
          style={depth ? { paddingInlineStart: 16 + depth * 16 } : undefined}
          onClick={() => onPick(node.id)}
        >
          <span className="zen-v2-radio" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{node.title}</span>
          {node.id === current && <span className="zen-list-value shrink-0">Current</span>}
        </button>
      ))}
    </div>
  )
}

/**
 * The picker's `New folder` (Chrome's `Create new folder`, a one-field modal over its picker):
 * a §9.12 one-field sheet – the field labelled by the header that reads its name, no autofocus
 * (§9.22: the keyboard would come up with the sheet), the footer's Cancel · Create (disabled
 * until the name has a character). Create slides the sheet away and makes the folder once it
 * is gone, inside the picker's checked folder.
 */
export function NewFolderSheet({
  name: sheetName,
  parentTitle,
  onClose,
  onCreate
}: {
  /** The sheet's name in the dialog host, after the surface it stands over. */
  name: string
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
      name={sheetName}
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
