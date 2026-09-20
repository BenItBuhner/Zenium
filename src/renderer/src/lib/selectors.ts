import type { Container, Space, SplitGroup, SplitLayout, Tab, UIState } from '@shared/types'
import { isBlankTabUrl } from '@shared/url'

export function activeSpace(state: UIState): Space {
  return state.spaces.find((s) => s.id === state.activeSpaceId) ?? state.spaces[0]
}

export function activeTab(state: UIState): Tab | null {
  const space = activeSpace(state)
  return (space.activeTabId && state.tabs[space.activeTabId]) || null
}

export function essentialsFor(state: UIState, space: Space): Tab[] {
  return state.essentialTabIds
    .map((id) => state.tabs[id])
    .filter((t): t is Tab => Boolean(t))
    .filter(
      (t) => !state.settings.containerSpecificEssentials || t.containerId === space.containerId
    )
}

export function tabsOf(state: UIState, space: Space): Tab[] {
  return space.tabIds.map((id) => state.tabs[id]).filter((t): t is Tab => Boolean(t))
}

export function pinnedOf(state: UIState, space: Space): Tab[] {
  return tabsOf(state, space).filter((t) => t.pinned)
}

export function regularOf(state: UIState, space: Space): Tab[] {
  return tabsOf(state, space).filter((t) => !t.pinned)
}

/**
 * Every tab a space shows, in the order of the sidebar: Essentials, pinned tabs, the tabs of each
 * folder, then the loose ones. This is the track the phone's swipe-to-switch moves along.
 */
export function tabOrderOf(state: UIState, space: Space): Tab[] {
  const regular = regularOf(state, space)
  const folders = Object.values(state.folders).filter((f) => f.spaceId === space.id)
  const inFolders = folders.flatMap((f) => regular.filter((t) => t.folderId === f.id))
  const loose = regular.filter((t) => !t.folderId || !state.folders[t.folderId])
  return [...essentialsFor(state, space), ...pinnedOf(state, space), ...inFolders, ...loose]
}

/** Ids of the tabs that should be visible in the content area right now. */
export function visibleTabIds(state: UIState): string[] {
  const tab = activeTab(state)
  if (!tab) return []
  if (tab.splitGroupId) {
    const group = state.splitGroups[tab.splitGroupId]
    if (group) return group.tabIds
  }
  return [tab.id]
}

/**
 * Whether `tabId` is an empty pane of the split on screen (split-04): a blank tab of the active
 * tab's split. The chrome draws that pane itself – its field, its "Choose a tab" button and the
 * URL bar floating in it – and places no view there (`useLayoutReporter`).
 */
export function isEmptySplitPane(state: UIState, tabId: string | null | undefined): boolean {
  const tab = tabId ? state.tabs[tabId] : undefined
  if (!tab?.splitGroupId || !isBlankTabUrl(tab.url)) return false
  const group = state.splitGroups[tab.splitGroupId]
  return Boolean(group && group.tabIds.length > 1 && activeTab(state)?.splitGroupId === group.id)
}

/** What the split glyph draws for one pane: the group's layout, its pane count, the pane's own cell. */
export interface SplitMark {
  layout: SplitLayout
  count: number
  index: number
}

/**
 * The split glyph of a tab in a split of two or more panes (split-05): `null` for a tab out of
 * one, or in a group that has no other pane left.
 */
export function splitMarkOf(group: SplitGroup | null | undefined, tabId: string): SplitMark | null {
  if (!group || group.tabIds.length < 2) return null
  const index = group.tabIds.indexOf(tabId)
  return index < 0 ? null : { layout: group.layout, count: group.tabIds.length, index }
}

/** The tooltip of the pill's split chip: "In a split view – 2 panes". */
export function splitChipLabel(count: number): string {
  return `In a split view – ${count} panes`
}

/** The part of the split card's frame a row draws (`SpacePanel`, split-05). */
export type SplitCardEdge = 'only' | 'first' | 'middle' | 'last'

/**
 * Which rows of one list draw the split card's frame, and which part of it (split-05): each
 * run of neighbouring rows in one split group is a card, one frame around them. The model does
 * not keep a split's tabs next to each other in the strip, so a group whose rows lie apart gets
 * a frame per run, the glyph on every row naming the group.
 */
export function splitCardEdges(state: UIState, tabs: Tab[]): Map<string, SplitCardEdge> {
  const edges = new Map<string, SplitCardEdge>()
  const groupOf = (t: Tab | undefined): string | null => {
    const g = t?.splitGroupId ? state.splitGroups[t.splitGroupId] : undefined
    return g && g.tabIds.length > 1 ? g.id : null
  }
  tabs.forEach((t, i) => {
    const g = groupOf(t)
    if (!g) return
    const up = groupOf(tabs[i - 1]) === g
    const down = groupOf(tabs[i + 1]) === g
    edges.set(t.id, up && down ? 'middle' : up ? 'last' : down ? 'first' : 'only')
  })
  return edges
}

export function tabTitle(tab: Tab): string {
  return tab.customTitle ?? tab.title
}

/**
 * What a tab row's native tooltip says: the full title, which the row clips (BUG-004), then the
 * state the row is in – asleep (with what the page held, when the governor could tell), frozen,
 * driven by an agent.
 */
export function tabTooltip(tab: Tab, agentName: string | null = null): string {
  return [tabTitle(tab), ...tabStateLines(tab, agentName)].join('\n')
}

/** The state a row is in, one line each: driven by an agent, asleep (and what it held), frozen. */
export function tabStateLines(tab: Tab, agentName: string | null = null): string[] {
  const lines: string[] = []
  if (agentName) lines.push(`Driven by ${agentName}`)
  if (tab.discarded) {
    lines.push('Sleeping – click to wake')
    if (tab.sleepSavedMb) lines.push(`Memory saved: ${tab.sleepSavedMb} MB`)
  } else if (tab.frozen) lines.push('Frozen by the resource governor')
  return lines
}

export function isDarkScheme(state: UIState): boolean {
  if (state.settings.colorScheme === 'dark') return true
  if (state.settings.colorScheme === 'light') return false
  return state.systemDark ?? window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function containerOf(state: UIState, id: string): Container | undefined {
  return state.containers.find((c) => c.id === id)
}

/** Blank and private windows own a temporary tab list without spaces / Essentials. */
export function isLocalWindow(state: UIState): boolean {
  return state.window.kind !== 'synced'
}

export function isPrivateWindow(state: UIState): boolean {
  return state.window.kind === 'private'
}

/** The active tab's live page is currently shown in another window (Zen shows a dimmed preview). */
export function isForeignTab(state: UIState, tabId: string | null | undefined): boolean {
  return Boolean(tabId) && state.foreignTabIds.includes(tabId as string)
}
