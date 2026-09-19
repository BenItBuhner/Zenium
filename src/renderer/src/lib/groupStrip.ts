import type { Folder, Tab, UIState } from '@shared/types'
import { groupOf } from './groups'
import { activeSpace, activeTab, regularOf, tabTitle } from './selectors'

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
 * What a strip on its way out shows, after the active tab left its group: the group as it stands
 * now – its remaining members, none of them active – while it is still a group of this space.
 * A group that is gone (dissolved) or left behind in another space has no present to show, so
 * the strip slides out as it last stood (`last`, the model it drew before), its mark gone: a
 * surface whose state is gone still runs its own dismissal from where it is (v2 §11.2).
 */
export function leavingStripFor(state: UIState, last: GroupStripModel): GroupStripModel {
  const group = state.folders[last.group.id]
  if (!group || group.spaceId !== activeSpace(state).id) return { ...last, activeTabId: null }
  return { group, members: membersOf(state, group), activeTabId: null }
}

function membersOf(state: UIState, group: Folder): Tab[] {
  return regularOf(state, activeSpace(state)).filter((t) => t.folderId === group.id)
}

/**
 * Everything the strip draws of a model, as one string: two models with the same key show the
 * same strip. The presence keeps the model it showed last while the key holds, so a browser
 * state that changed nothing the strip shows – a tick of another tab's loading, a scroll – hands
 * the strip the very same model and it neither re-renders nor re-measures its chips; when the
 * key changes (a member joins or leaves, the mark moves, a favicon or title arrives, the group
 * is renamed or recoloured) it re-renders once.
 */
/**
 * Length of the cross-fade when the strip's content changes in place – the active tab moves
 * from one group to another and the chips of the second take the first's slots (v2 §11.4: on
 * opacity, in the same slot, no slide and no cut; the same fade under reduced motion).
 */
export const GROUP_SWITCH_FADE_MS = 120

export function stripKey(model: GroupStripModel): string {
  const { group, members, activeTabId } = model
  return [
    group.id,
    group.name,
    group.color,
    group.icon,
    activeTabId ?? '',
    ...members.map(chipKey)
  ].join('\u001f')
}

/** What a member's chip draws: its label and the inputs of its `Favicon`. */
function chipKey(tab: Tab): string {
  return [
    tab.id,
    tabTitle(tab),
    tab.url,
    tab.favicon ?? '',
    tab.customIcon ?? '',
    tab.loading && !tab.discarded ? 'loading' : '',
    tab.containerId
  ].join('\u001e')
}

/**
 * Where the plus chip's new tab goes: after the group's last member, so `tab.create` files it
 * in the group (a tab created after a grouped tab inherits its group) and its chip appears at
 * the end of the strip.
 */
export function newTabAnchor(model: GroupStripModel): string | undefined {
  return model.members[model.members.length - 1]?.id ?? model.activeTabId ?? undefined
}
