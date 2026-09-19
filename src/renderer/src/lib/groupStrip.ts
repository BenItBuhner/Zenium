import type { Folder, Tab, UIState } from '@shared/types'
import { groupOf } from './groups'
import { activeSpace, activeTab, regularOf } from './selectors'

/**
 * The tab group strip (TAB-14): while the active tab belongs to a group the bar band gains a
 * second row next to the pill – the group's tabs as favicon chips, a plus that opens a tab in
 * the group and a chip that shows the group in the overview. This module is the strip's model;
 * `components/phone/GroupStrip.tsx` draws it and `useGroupStrip` runs its presence.
 */

/** The tray the chips sit in: a 44 pill, concentric with the address pill beside it. */
export const GROUP_STRIP_TRAY = 44
/** Between the tray and the bar's row of controls. */
export const GROUP_STRIP_GAP = 6
/**
 * What the strip adds to the bar band (px): the tray and its gap. Published on the document
 * root as `--zen-group-strip` while the strip is present (0 otherwise); `--zen-phone-band`
 * (main.css) is the bar plus this, the height the content column and the overview leave free.
 */
export const GROUP_STRIP_HEIGHT = GROUP_STRIP_TRAY + GROUP_STRIP_GAP
/** The custom property the shell writes the strip's share of the band into. */
export const GROUP_STRIP_VAR = '--zen-group-strip'

export interface GroupStripModel {
  group: Folder
  /** The group's tabs, in the order the overview and the swipe track show them. */
  members: Tab[]
  /** The active tab (one of `members`); none on a strip whose tab has left its group. */
  activeTabId: string | null
}

/** Key of a member's chip in the strip's FLIP set (`data-cell`). */
export function stripCellKey(tabId: string): string {
  return `strip:${tabId}`
}

/**
 * What the strip shows for `state`: the active tab's group and its members, or null when the
 * active tab is loose (or its group is gone). Members are the regular tabs of the space that
 * carry the group's id, as `tabOrderOf` walks them, so the chips read left to right in the
 * order a sideways swipe on the pill moves through.
 */
export function groupStripFor(state: UIState): GroupStripModel | null {
  const tab = activeTab(state)
  const group = groupOf(state, tab)
  if (!tab || !group) return null
  const members = membersOf(state, group)
  if (!members.some((t) => t.id === tab.id)) return null
  return { group, members, activeTabId: tab.id }
}

/**
 * The strip of group `groupId` as it stands now, for a strip on its way out after the active
 * tab left the group: the group's remaining members, none of them active. Null once the group
 * itself is gone (dissolved) or the user is in another space, when there is nothing to slide out.
 */
export function leavingStripFor(state: UIState, groupId: string | null): GroupStripModel | null {
  const group = groupId ? (state.folders[groupId] ?? null) : null
  if (!group || group.spaceId !== activeSpace(state).id) return null
  return { group, members: membersOf(state, group), activeTabId: null }
}

function membersOf(state: UIState, group: Folder): Tab[] {
  return regularOf(state, activeSpace(state)).filter((t) => t.folderId === group.id)
}

/**
 * Where the plus chip's new tab goes: after the group's last member, so `tab.create` files it
 * in the group (a tab created after a grouped tab inherits its group) and its chip appears at
 * the end of the strip.
 */
export function newTabAnchor(model: GroupStripModel): string | undefined {
  return model.members[model.members.length - 1]?.id ?? model.activeTabId ?? undefined
}
