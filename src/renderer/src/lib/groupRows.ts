import type { Folder, Tab } from '@shared/types'
import { relativeTime } from './utils'

/**
 * The overview's Groups pane (TAB-16, Chrome's "Tab groups"): what each of a space's groups is
 * listed as. A group with live tabs is OPEN; one whose tabs have closed but that kept their
 * pages (`Folder.savedTabs`) is SAVED, and stays listed until it is opened again or deleted; one
 * with neither (made on the desktop and never filled, or whose only members were private tabs,
 * which a saved group never keeps) is EMPTY – listed with the open ones so it can be renamed or
 * deleted, since the grid has no card for it.
 */
export type GroupRowKind = 'open' | 'saved' | 'empty'

export interface GroupRow {
  folder: Folder
  kind: GroupRowKind
  /** Live tabs for an open group, the kept pages for a saved one, none for an empty one. */
  count: number
  /**
   * When the group was last used, ms since the epoch: the core's `lastUsedAt` (a member
   * activated, a tab joining, the group closed or opened), else the newest activation among its
   * live tabs for a group from before the core kept it; null when nothing says.
   */
  lastUsedAt: number | null
}

export interface GroupRows {
  /** Open groups in the grid's order (the space's folders' order), the empty ones among them. */
  open: GroupRow[]
  /** Saved groups, the most recently used first. */
  saved: GroupRow[]
}

/** The pane's rows for `groups` (the space's folders, in the grid's order) and their live members. */
export function groupRows(
  groups: readonly Folder[],
  membersOf: (folderId: string) => Tab[]
): GroupRows {
  const open: GroupRow[] = []
  const saved: GroupRow[] = []
  for (const folder of groups) {
    const members = membersOf(folder.id)
    if (members.length > 0) {
      const newest = members.reduce((t, tab) => Math.max(t, tab.lastActiveAt), 0)
      open.push({
        folder,
        kind: 'open',
        count: members.length,
        lastUsedAt: folder.lastUsedAt ?? (newest > 0 ? newest : null)
      })
    } else if (folder.savedTabs?.length) {
      saved.push({
        folder,
        kind: 'saved',
        count: folder.savedTabs.length,
        lastUsedAt: folder.lastUsedAt ?? null
      })
    } else {
      open.push({ folder, kind: 'empty', count: 0, lastUsedAt: folder.lastUsedAt ?? null })
    }
  }
  saved.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
  return { open, saved }
}

/**
 * The row's second line (§10.4's description, 13 at 69%): the count and, after a middle dot,
 * when the group was last used – "3 tabs · 2 h ago"; a saved group's is when it closed, which
 * was its last use. An empty group says so.
 */
export function groupRowDescription(row: GroupRow, now = Date.now()): string {
  if (row.kind === 'empty') return 'No tabs'
  const tabs = `${row.count} ${row.count === 1 ? 'tab' : 'tabs'}`
  return row.lastUsedAt === null ? tabs : `${tabs} · ${relativeTime(row.lastUsedAt, now)}`
}

/**
 * What TalkBack hears of the row (the group card's own sentence, `groupCardLabel`, with the
 * state a card never has): "Trip, tab group, 5 tabs, saved"; an empty group reads "no tabs".
 */
export function groupRowLabel(row: GroupRow): string {
  const name = row.folder.name.trim()
  const head = name ? `${name}, tab group` : 'Tab group'
  if (row.kind === 'empty') return `${head}, no tabs`
  const tabs = `${row.count} tab${row.count === 1 ? '' : 's'}`
  return row.kind === 'saved' ? `${head}, ${tabs}, saved` : `${head}, ${tabs}`
}
