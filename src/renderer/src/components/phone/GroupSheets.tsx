import type { CSSProperties, JSX } from 'react'
import { useRef } from 'react'
import { Trash2 } from 'lucide-react'
import type { Folder } from '@shared/types'
import { OVERVIEW_LABELS } from '@shared/overviewMenu'
import { run } from '@renderer/lib/api'
import { folderDeleteWords } from '@renderer/lib/folderDelete'
import { GROUP_PALETTE, groupColorVars } from '@renderer/lib/groups'
import type { GroupRow } from '@renderer/lib/groupRows'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import type { BottomSheetHandle } from '../sheet/BottomSheet'
import { OverviewSheet, type SheetAction } from './OverviewSheet'
import { PhoneSheet } from './PhoneSheet'

/**
 * The tab overview's group sheets (TAB-16; `docs/tab-overview-cleanup-spec.md` §2): the colour
 * palette the group sheets share, the saved group's card's sheet and the Delete Group prompt.
 * The Groups pane these once stood beside is gone (§2, §9: a group is a card in the grid, a
 * saved one a card with the saved ring at its end).
 */

/**
 * The group's colour as a row of swatches (Chrome's nine, `GROUP_PALETTE`): a radio group in
 * the sheet's header slot, between the title and the rows, the group's own colour checked; a
 * tap recolours the group at once, the sheet staying up. Shared by the group card's sheet and
 * the saved card's, so the two read alike.
 */
export function GroupColorPalette({ folder }: { folder: Folder }): JSX.Element {
  return (
    <div
      className="flex items-center gap-2 px-3 pb-2 pt-1"
      role="radiogroup"
      aria-label={OVERVIEW_LABELS.colour}
    >
      {GROUP_PALETTE.map(({ color, name }) => {
        const selected = (folder.color ?? null) === color
        return (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={name}
            className={cn(
              'zen-group-swatch flex h-8 w-8 items-center justify-center rounded-full',
              selected && 'zen-group-swatch-selected'
            )}
            data-group-rgb=""
            style={groupColorVars(color) as CSSProperties}
            onClick={() => run('folder.update', { folderId: folder.id, patch: { color } })}
          >
            <span className="h-5 w-5 rounded-full bg-[rgb(var(--zen-group-rgb))]" />
          </button>
        )
      })}
    </div>
  )
}

/**
 * A saved group's card's sheet (TAB-16; §2: its hold): the colour swatches under the group's
 * name, then the menu items – Title Case (§9.1) – by the group's state as the sheet reads it
 * live. A SAVED group: Open (N Tabs) (its pages come back as tabs, what the card's tap does),
 * Rename, Delete Group in the danger ink; an EMPTY one: Rename, Delete Group; a group that has
 * come OPEN under the sheet (its pages back as tabs meanwhile): Show in Tabs, Rename, Close
 * Group (N Tabs) in the plain ink (its tabs close, the group stays saved with their pages:
 * nothing of the user's is destroyed, §6), Delete Group. Delete asks first when the group holds
 * anything (`DeleteGroupSheet`, §9.23); the caller decides.
 */
export function GroupRowSheet({
  row,
  onClose,
  onOpen,
  onCloseGroup,
  onDelete
}: {
  row: GroupRow
  onClose: () => void
  onOpen: (row: GroupRow) => void
  onCloseGroup: (folder: Folder) => void
  onDelete: (row: GroupRow) => void
}): JSX.Element {
  const { folder, kind, count } = row
  const actions: SheetAction[] = []
  if (kind === 'open')
    actions.push({ id: 'show', label: OVERVIEW_LABELS.showInTabs, onPick: () => onOpen(row) })
  if (kind === 'saved')
    actions.push({ id: 'open', label: OVERVIEW_LABELS.openGroup(count), onPick: () => onOpen(row) })
  actions.push({
    id: 'rename',
    label: OVERVIEW_LABELS.rename,
    onPick: () => uiStore.set({ renamingFolderId: folder.id })
  })
  if (kind === 'open')
    actions.push({
      id: 'close',
      label: OVERVIEW_LABELS.closeGroup(count),
      onPick: () => onCloseGroup(folder)
    })
  actions.push({
    id: 'delete',
    label: OVERVIEW_LABELS.deleteGroup,
    destructive: true,
    onPick: () => onDelete(row)
  })
  return (
    <OverviewSheet
      title={folder.name}
      header={<GroupColorPalette folder={folder} />}
      actions={actions}
      onClose={onClose}
    />
  )
}

/**
 * "Delete group" asks first when the group holds anything (TAB-16; v2 §9.23: a prompt sheet
 * with the title block, the one paragraph, the §9.11 footer with Cancel and the verb in the
 * danger ink): an open group's tabs close with it, each to Recently Closed – the ask is the
 * guard, so no Undo follows on a toast (TAB-13, the Design Lead's option C) – and a saved
 * group's pages are forgotten with no way back. The words are `folderDeleteWords`'s in the
 * touch hosts' noun (v2 §6: "this group" for a group with no name), the one source the tablet's
 * dialog and the desktop's read from too. Escape, the scrim, the back gesture and Cancel keep
 * the group. Focus lands on the sheet itself, the title announced first (§9.22: a
 * title-and-notice sheet focuses its container; landing on Cancel would announce the way out
 * first).
 */
export function DeleteGroupSheet({
  row,
  onClose,
  onConfirm
}: {
  row: GroupRow
  onClose: () => void
  onConfirm: (row: GroupRow) => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const { folder, kind, count } = row
  const words = folderDeleteWords(folder.name, count, kind === 'saved', 'group')
  return (
    <PhoneSheet
      name="overview-delete-group"
      title={{
        pose: 'block',
        text: words.title,
        icon: <Trash2 className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />,
        description: words.detail
      }}
      focus="dialog"
      onClose={onClose}
      handleLabel="Dismiss"
      sheetRef={sheet}
    >
      <div className="zen-sheet-footer">
        <button type="button" className="zen-v2-button" onClick={() => sheet.current?.dismiss()}>
          Cancel
        </button>
        <button
          type="button"
          className="zen-v2-button"
          data-danger
          data-testid="overview-delete-group-confirm"
          onClick={() => sheet.current?.dismiss(() => onConfirm(row))}
        >
          Delete
        </button>
      </div>
    </PhoneSheet>
  )
}
