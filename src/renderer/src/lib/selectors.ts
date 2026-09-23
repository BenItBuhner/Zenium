import type { Container, Space, SplitGroup, Tab, UIState } from '@shared/types'
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

/**
 * A row of one tab list of the sidebar (pinned, a folder's tabs, the loose tabs): a tab's own
 * row, or the split group's one row (design language v2 §9.35) holding every pane of the split
 * that this list has.
 */
export type StripRow =
  | { kind: 'tab'; tab: Tab }
  | {
      kind: 'split'
      group: SplitGroup
      /** The list's first pane of the split, in list order: the row stands in its slot. */
      anchor: Tab
      /** The list's panes of the split, in the split's own order – the panes as they are on screen. */
      tabs: Tab[]
    }

/**
 * A list's rows with its split groups folded into one row each (§9.35: Zen draws a split as one
 * row, the tabs side by side, not as stacked rows). The row stands where the list's first pane
 * of the split is and gathers the list's other panes into it, wherever they sit in the list –
 * the model keeps the panes where they were opened (a link from a pane, `newEmptySplit`'s blank
 * tab after the active one), so they need not be neighbours. A split with a single pane in this
 * list (its others pinned, in another folder, or Essentials) shows that pane as a plain row.
 */
export function stripRows(tabs: readonly Tab[], groups: Record<string, SplitGroup>): StripRow[] {
  const rows: StripRow[] = []
  const folded = new Set<string>()
  for (const tab of tabs) {
    const group = tab.splitGroupId ? groups[tab.splitGroupId] : undefined
    if (!group) {
      rows.push({ kind: 'tab', tab })
      continue
    }
    if (folded.has(group.id)) continue
    const here = new Map(tabs.filter((t) => t.splitGroupId === group.id).map((t) => [t.id, t]))
    const panes = group.tabIds.map((id) => here.get(id)).filter((t): t is Tab => Boolean(t))
    if (panes.length < 2) {
      rows.push({ kind: 'tab', tab })
      continue
    }
    folded.add(group.id)
    rows.push({ kind: 'split', group, anchor: tab, tabs: panes })
  }
  return rows
}

/** A row's identity (its React key): the tab's id, or the split row's anchor (the slot it stands in). */
export const rowKey = (row: StripRow): string => (row.kind === 'tab' ? row.tab.id : row.anchor.id)

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
