import type { Folder } from '@shared/types'
import { run } from '@renderer/lib/api'
import { uiStore } from '@renderer/lib/ui'

/**
 * One of a tab group's actions on the phone: a row of the card's hold sheet (`GroupSheet`, the
 * header's ⋯) and, under touch exploration, one of the card's accessible controls (`GroupCard`),
 * by the same name and to the same effect.
 */
export interface GroupAction {
  id: 'rename' | 'new-tab' | 'ungroup' | 'close' | 'delete'
  label: string
  /** Rendered in the danger ink where a row is drawn: destroys the group and its tabs. */
  destructive?: boolean
  run: () => void
}

/** What the overview does with the actions that ask, wait or animate beyond the card. */
export interface GroupActionHandlers {
  /** New Tab in Group: a tab at the group's end, and the overview leaves on it (`folder.newTab`). */
  newTabInGroup: (folder: Folder) => void
  /** Close Group: its tabs close, the group stays saved with their pages (TAB-16, `folder.close`). */
  closeGroup: (folder: Folder) => void
  /** Delete Group: asks first (§9.23) since the group holds tabs. */
  deleteGroup: (folder: Folder) => void
}

/**
 * The group's actions in the sheet's order (`docs/tab-overview-cleanup-spec.md` §2: Rename,
 * Colour, New Tab in Group, Ungroup, Close Group, Delete Group – Colour is the sheet's palette
 * in its header, `GroupColorPalette`, so it is no row here): Rename; New Tab in Group; Ungroup;
 * Close Group – its tabs close and the group stays saved with their pages, a card with the
 * saved ring at the grid's end (TAB-16) – and Delete Group, which asks first (§9.23). The fold
 * is no row: the header's tap folds and unfolds the card, and its `aria-expanded` puts Collapse /
 * Expand in TalkBack's actions menu. Menu items, so Title Case (v2 §9.1): the count keeps its
 * unit, capitalised with the rest.
 */
export function groupActions(
  folder: Folder,
  count: number,
  on: GroupActionHandlers
): GroupAction[] {
  return [
    {
      id: 'rename',
      label: 'Rename',
      run: () => uiStore.set({ renamingFolderId: folder.id })
    },
    {
      id: 'new-tab',
      label: 'New Tab in Group',
      run: () => on.newTabInGroup(folder)
    },
    {
      id: 'ungroup',
      label: 'Ungroup',
      run: () => run('folder.delete', { folderId: folder.id, unpack: true })
    },
    // Close Group destroys nothing the saved group does not keep (`folder.close`): the plain
    // ink, as on the saved card's sheet and the tablet's menu; Delete Group alone is danger.
    {
      id: 'close',
      label: `Close Group (${count} ${count === 1 ? 'Tab' : 'Tabs'})`,
      run: () => on.closeGroup(folder)
    },
    {
      id: 'delete',
      label: 'Delete Group',
      destructive: true,
      run: () => on.deleteGroup(folder)
    }
  ]
}

/**
 * The actions a group card gives a reader as accessible controls under touch exploration
 * (A11Y-10): the sheet's rows, every one – the fold is the header itself (its tap, and its
 * `aria-expanded`), and the colour is the sheet's palette, reached through the ⋯.
 */
export function groupCardControls(
  folder: Folder,
  count: number,
  on: GroupActionHandlers
): GroupAction[] {
  return groupActions(folder, count, on)
}
