import type { Folder, Tab } from '@shared/types'
import { isPrivateTab } from './privateTabs'
import { relativeTime } from './utils'

/**
 * The overview's Groups pane (TAB-16, Chrome's "Tab groups"): what each of a space's groups is
 * listed as. A group with live tabs is OPEN; one whose tabs have closed but that kept their
 * pages (`Folder.savedTabs`) is SAVED, and stays listed until it is opened again or deleted; one
 * with neither (made on the desktop and never filled) is EMPTY – listed with the open ones so it
 * can be renamed or deleted, since the grid has no card for it. A PRIVATE group
 * (`isPrivateGroup`) is the Private pane's, where its tabs are its cards (v2 §9.34: private
 * groups stay in the Private pane), and is no row of this pane.
 */
export type GroupRowKind = 'open' | 'saved' | 'empty'

/**
 * Whether `folder`, with `live` its live members, is a PRIVATE group: filled by private tabs
 * alone – no regular member, nothing saved. Private browsing leaks nothing outside its mode, and
 * a row or a menu entry for such a group would show a private group's existence and its NAME on
 * a regular surface: it is no row of the Groups pane or of the tablet's sidebar and no entry of
 * the Tabs pane's group sheets (the core keeps it out of a regular tab's folder menus the same
 * way, `isPrivateFolder`). A host that keeps private browsing in tabs can make one – a private
 * tab dropped into a folder of the space on the tablet's sidebar; the phone's Private pane does
 * not group. Saved pages are regular (the core keeps no private page when a group closes), so a
 * group with pages saved and private tabs alone live is a SAVED group, its private members no
 * part of its count; and a group's private members are never its regular surface's, which counts
 * and lists its regular tabs.
 */
export function isPrivateGroup(folder: Folder, live: readonly Tab[]): boolean {
  return live.length > 0 && live.every(isPrivateTab) && !folder.savedTabs?.length
}

/** `live` less the private tabs: the members a regular surface counts and lists. */
export function regularMembers(live: readonly Tab[]): Tab[] {
  return live.filter((tab) => !isPrivateTab(tab))
}

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

/**
 * What one group is a row as, `members` being the tabs its surface lists as the group's (the
 * regular ones on a regular surface, `regularMembers`; every live one in a private window,
 * private mode itself): OPEN with its members and their count, SAVED with the pages it kept
 * once they all closed, EMPTY with neither. The Groups pane's rows and the sidebar's folder
 * rows – the tablet's and the desktop's, where a saved folder stays in the strip as a saved
 * group (TAB-16's desktop half) – read a group through this one builder, so the surfaces never
 * disagree on what a group is.
 */
export function groupRowOf(folder: Folder, members: readonly Tab[]): GroupRow {
  if (members.length > 0) {
    const newest = members.reduce((t, tab) => Math.max(t, tab.lastActiveAt), 0)
    return {
      folder,
      kind: 'open',
      count: members.length,
      lastUsedAt: folder.lastUsedAt ?? (newest > 0 ? newest : null)
    }
  }
  if (folder.savedTabs?.length) {
    return {
      folder,
      kind: 'saved',
      count: folder.savedTabs.length,
      lastUsedAt: folder.lastUsedAt ?? null
    }
  }
  return { folder, kind: 'empty', count: 0, lastUsedAt: folder.lastUsedAt ?? null }
}

/**
 * The pane's rows for `groups` (the space's folders, in the grid's order), `liveOf` naming a
 * group's live members, the private ones included: those count for nothing here, and a private
 * group (`isPrivateGroup`) takes no row.
 */
export function groupRows(
  groups: readonly Folder[],
  liveOf: (folderId: string) => Tab[]
): GroupRows {
  const open: GroupRow[] = []
  const saved: GroupRow[] = []
  for (const folder of groups) {
    const live = liveOf(folder.id)
    const row = groupRowOf(folder, regularMembers(live))
    if (row.kind === 'saved') saved.push(row)
    else if (row.kind === 'open' || !isPrivateGroup(folder, live)) open.push(row)
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
