import type { CSSProperties, JSX } from 'react'
import { useRef } from 'react'
import { Ellipsis, Trash2 } from 'lucide-react'
import type { Folder } from '@shared/types'
import { FOLDER_COLORS } from '@shared/defaults'
import { run } from '@renderer/lib/api'
import { GROUP_PALETTE, groupColorHex } from '@renderer/lib/groups'
import {
  groupRowDescription,
  groupRowLabel,
  type GroupRow,
  type GroupRows
} from '@renderer/lib/groupRows'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { useNow } from '../extensions/useNow'
import type { BottomSheetHandle } from '../sheet/BottomSheet'
import { GroupRename } from './GroupCard'
import { OverviewSheet, type SheetAction } from './OverviewSheet'
import { PhoneEmptyNote, PhoneGroupHeading, PhoneIconButton, PhoneListRow } from './PhoneList'
import { PhoneSheet } from './PhoneSheet'

interface Props {
  rows: GroupRows
  /** The group whose name is being edited in place (`uiStore.renamingFolderId`). */
  renamingId: string | null
  /** A row was tapped: an open group is shown in the Tabs pane, a saved one opened first. */
  onOpen: (row: GroupRow) => void
  /** A row's hold or its trailing button: the group's sheet. */
  onMenu: (row: GroupRow) => void
}

/** A section's props: the pane's, with the moment the rows' "last used" is told from. */
type SectionProps = Omit<Props, 'rows'> & { heading: string; rows: GroupRow[]; now: number }

/**
 * The overview's Groups pane (TAB-16; Chrome's "Tab groups" pane): the space's tab groups as
 * rows on the overview's window backdrop – the phone panels' 64 two-line row (v2 §9.2, §9.13;
 * `PhoneListRow`) in the window family (§9.29, `.zen-overview-groups` in main.css) – under two
 * §10.3 headings with their counts: OPEN groups in the grid's order, then SAVED ones, whose tabs
 * have closed but whose pages the group kept (`Folder.savedTabs`), the most recently used first.
 * A row is the group's colour in the leading box (a dot for an open group, a ring for a saved
 * one), its name, and "N tabs · when it was last used"; its trailing 44 button and its hold open
 * the group's sheet (`GroupRowSheet`). A tap on an open group's row shows the group in the Tabs
 * pane, expanded and scrolled to; a tap on a saved group's row opens it – its pages come back as
 * tabs of the group – and shows it the same way. An empty group (no tabs, nothing saved) is
 * listed with the open ones for its sheet, at the one disabled number (§9.30), since it has
 * nothing to show; a name being edited takes the row's title slot (`GroupRenameRow`).
 */
export function GroupsPane({ rows, renamingId, onOpen, onMenu }: Props): JSX.Element {
  const total = rows.open.length + rows.saved.length
  // The rows' "last used" is told from now, refreshed every half minute while the pane is up.
  const now = useNow()
  return (
    <div
      className="zen-overview-groups zen-phone-list min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-4"
      data-pane="groups"
      data-testid="overview-groups"
      style={{ touchAction: 'pan-y', overscrollBehavior: 'contain' }}
    >
      {total === 0 ? (
        <GroupsEmpty />
      ) : (
        <>
          {rows.open.length > 0 && (
            <GroupSection
              heading="Open"
              rows={rows.open}
              renamingId={renamingId}
              now={now}
              onOpen={onOpen}
              onMenu={onMenu}
            />
          )}
          {rows.saved.length > 0 && (
            <GroupSection
              heading="Saved"
              rows={rows.saved}
              renamingId={renamingId}
              now={now}
              onOpen={onOpen}
              onMenu={onMenu}
            />
          )}
        </>
      )}
    </div>
  )
}

/** One heading with its count as the §10.3 aside, and the rows under it. */
function GroupSection({
  heading,
  rows,
  renamingId,
  now,
  onOpen,
  onMenu
}: SectionProps): JSX.Element {
  return (
    <section
      aria-label={`${heading} groups`}
      data-testid={`overview-groups-${heading.toLowerCase()}`}
    >
      <PhoneGroupHeading>
        <span>{heading}</span>
        <span className="zen-overview-groups-aside">{rows.length}</span>
      </PhoneGroupHeading>
      {rows.map((row) =>
        row.folder.id === renamingId ? (
          <GroupRenameRow key={row.folder.id} row={row} />
        ) : (
          <PhoneListRow
            key={row.folder.id}
            icon={<GroupGlyph folder={row.folder} saved={row.kind === 'saved'} />}
            title={row.folder.name}
            subtitle={groupRowDescription(row, now)}
            ariaLabel={groupRowLabel(row)}
            disabled={row.kind === 'empty'}
            trailing={
              <PhoneIconButton
                label={`More options for ${row.folder.name}`}
                onClick={() => onMenu(row)}
              >
                <Ellipsis className="h-5 w-5" strokeWidth={1.75} />
              </PhoneIconButton>
            }
            onTap={() => onOpen(row)}
            onLongPress={() => onMenu(row)}
          />
        )
      )}
    </section>
  )
}

/**
 * The row while its group's name is edited (§9.13's row anatomy kept: the glyph in the leading
 * box, the field in the title's place at the row's 15): a static row – not a target while the
 * field is – holding the group card's own rename field (`GroupRename`), which saves on Enter and
 * blur and gives the old name back on Escape.
 */
function GroupRenameRow({ row }: { row: GroupRow }): JSX.Element {
  return (
    <div
      className="zen-v2-row zen-phone-row"
      data-static
      data-two-line="true"
      data-testid="overview-group-rename"
    >
      <div className="zen-list-main">
        <span className="zen-list-lead" aria-hidden>
          <GroupGlyph folder={row.folder} saved={row.kind === 'saved'} />
        </span>
        <span className="zen-list-text">
          <GroupRename folder={row.folder} className="zen-overview-group-rename" />
        </span>
      </div>
    </div>
  )
}

/** The group's colour in the row's 20 box: a 12 px dot for an open group, a 2 px ring for a saved one. */
function GroupGlyph({ folder, saved }: { folder: Folder; saved: boolean }): JSX.Element {
  return (
    <span
      className="zen-overview-group-glyph"
      data-saved={saved || undefined}
      style={{ '--zen-group-color': groupColorHex(folder.color) } as CSSProperties}
    />
  )
}

/**
 * The pane with no group in it: a list's empty room (§9.17, as §9.34 writes it for this pane) –
 * the phone panels' one-sentence note (`PhoneEmptyNote`: 15/400 at 69%, centred in the 32
 * gutter, top-anchored), its first line 48 under the segment that stays put above the list
 * (`.zen-overview-groups > .zen-phone-empty` in main.css: the segment carries no air under it,
 * so the note takes the 48 itself), no title, no button – the grid is where a group is made. A
 * child of the pane's flow, as a list's rows are, so it stands in the pane's box under the
 * segment whatever the pane's height.
 */
function GroupsEmpty(): JSX.Element {
  return <PhoneEmptyNote>Hold a tab’s card and drop it on another to group them</PhoneEmptyNote>
}

/**
 * The group's colour as a row of swatches (Chrome's nine, `GROUP_PALETTE`): a radio group in
 * the sheet's header slot, between the title and the rows, the group's own colour checked; a
 * tap recolours the group at once, the sheet staying up. Shared by the group card's sheet on
 * the Tabs pane and the Groups pane's row sheet, so the two read alike.
 */
export function GroupColorPalette({ folder }: { folder: Folder }): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-3 pb-2 pt-1" role="radiogroup" aria-label="Colour">
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
            style={{ '--zen-swatch': FOLDER_COLORS[color] } as CSSProperties}
            onClick={() => run('folder.update', { folderId: folder.id, patch: { color } })}
          >
            <span className="h-5 w-5 rounded-full" style={{ background: FOLDER_COLORS[color] }} />
          </button>
        )
      })}
    </div>
  )
}

/**
 * A Groups pane row's sheet (TAB-16): the colour swatches under the group's name, then the menu
 * items – Title Case (§9.1) – by the group's state. An OPEN group: Show in Tabs (what the row's
 * tap does), Rename, Close Group (N Tabs) in the plain ink (its tabs close, the group stays
 * saved with their pages: nothing of the user's is destroyed, §6) and Delete Group in the danger
 * ink; a SAVED one: Open (its pages come back as tabs), Rename, Delete Group; an EMPTY one:
 * Rename, Delete Group. Delete asks first when the group holds anything (`DeleteGroupSheet`,
 * §9.23); the caller decides.
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
  const tabs = `${count} ${count === 1 ? 'Tab' : 'Tabs'}`
  const actions: SheetAction[] = []
  if (kind === 'open')
    actions.push({ id: 'show', label: 'Show in Tabs', onPick: () => onOpen(row) })
  if (kind === 'saved')
    actions.push({ id: 'open', label: `Open (${tabs})`, onPick: () => onOpen(row) })
  actions.push({
    id: 'rename',
    label: 'Rename',
    onPick: () => uiStore.set({ renamingFolderId: folder.id })
  })
  if (kind === 'open')
    actions.push({
      id: 'close',
      label: `Close Group (${tabs})`,
      onPick: () => onCloseGroup(folder)
    })
  actions.push({
    id: 'delete',
    label: 'Delete Group',
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
 * danger ink): an open group's tabs close with it – Undo on the toast brings them back, loose,
 * the group itself being gone – and a saved group's pages are forgotten with no way back.
 * Escape, the scrim, the back gesture and Cancel keep the group. Focus lands on the sheet
 * itself, the title announced first (§9.22: a title-and-notice sheet focuses its container;
 * landing on Cancel would announce the way out first).
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
  const name = folder.name.trim() || 'this group'
  const tabs = `${count} ${count === 1 ? 'tab' : 'tabs'}`
  const description =
    kind === 'saved'
      ? `Its ${tabs} are forgotten with it. There is no undo.`
      : `Its ${tabs} close and the group goes; Undo on the toast brings the tabs back, ungrouped.`
  return (
    <PhoneSheet
      name="overview-delete-group"
      title={{
        pose: 'block',
        text: `Delete ${name}?`,
        icon: <Trash2 className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />,
        description
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
