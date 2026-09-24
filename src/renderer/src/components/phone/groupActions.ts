import type { Folder } from '@shared/types'
import { run } from '@renderer/lib/api'
import { uiStore } from '@renderer/lib/ui'

/**
 * One of a tab group's actions on the phone: a row of the card's hold sheet (`GroupSheet`, the
 * header's menu) and, under touch exploration, one of the card's accessible controls
 * (`GroupCard`), by the same name and to the same effect.
 */
export interface GroupAction {
  id: 'rename' | 'collapse' | 'ungroup' | 'close' | 'delete'
  label: string
  /** Rendered in the danger ink where a row is drawn: destroys the group and its tabs. */
  destructive?: boolean
  run: () => void
}

/** What the overview does with the two actions that ask or animate beyond the card. */
export interface GroupActionHandlers {
  /** Close Group: its tabs close, the group stays saved with their pages (TAB-16, `folder.close`). */
  closeGroup: (folder: Folder) => void
  /** Delete Group: asks first (§9.23) since the group holds tabs. */
  deleteGroup: (folder: Folder) => void
}

/**
 * The group's actions in the hold sheet's order: Rename, Collapse / Expand, Ungroup, then Close
 * Group – its tabs close and the group stays saved with their pages on the Groups pane (TAB-16) –
 * and Delete Group, which asks first (§9.23). Menu items, so Title Case (v2 §9.1): the count keeps
 * its unit, capitalised with the rest.
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
      id: 'collapse',
      label: folder.collapsed ? 'Expand' : 'Collapse',
      run: () =>
        run('folder.update', { folderId: folder.id, patch: { collapsed: !folder.collapsed } })
    },
    {
      id: 'ungroup',
      label: 'Ungroup',
      run: () => run('folder.delete', { folderId: folder.id, unpack: true })
    },
    // Close Group destroys nothing the saved group does not keep (`folder.close`): the plain
    // ink, as on the Groups pane's row sheet and the tablet's menu; Delete Group alone is danger.
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
 * (A11Y-10): the hold sheet's rows but the fold, which the header is itself – its tap toggles
 * the group and its `aria-expanded` puts Collapse / Expand in TalkBack's actions menu already.
 */
export function groupCardControls(
  folder: Folder,
  count: number,
  on: GroupActionHandlers
): GroupAction[] {
  return groupActions(folder, count, on).filter((action) => action.id !== 'collapse')
}
