import type { Container, Space, Tab, UIState } from '@shared/types'

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

export function tabTitle(tab: Tab): string {
  return tab.customTitle ?? tab.title
}

export function isDarkScheme(state: UIState): boolean {
  if (state.settings.colorScheme === 'dark') return true
  if (state.settings.colorScheme === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
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
