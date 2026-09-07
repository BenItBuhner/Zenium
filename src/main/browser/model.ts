/**
 * Pure state model for the browser: spaces, tabs, essentials, split groups, folders.
 *
 * Everything here is free of Electron dependencies so it can be unit tested; the TabManager
 * layers WebContentsView lifecycle on top of these operations.
 *
 * Windows: every synced window shares this model (Zen's window sync). Blank and private windows
 * get a *local* space (`localSpaces`, keyed by `localSpaceId(windowId)`) that is never
 * persisted; tabs inside it carry `windowId`. With "sync only pinned tabs" unpinned tabs of a
 * synced window also carry `windowId` and are filtered per window.
 */
import { DEFAULT_CONTAINER_ID } from '../../shared/types'
import type {
  Container,
  Folder,
  Space,
  SplitGroup,
  SplitLayout,
  Tab,
  TabSection
} from '../../shared/types'
import { newId } from '../../shared/ids'
import { BLANK_URL, titleForUrl } from '../../shared/url'

export interface Model {
  tabs: Record<string, Tab>
  essentialTabIds: string[]
  spaces: Space[]
  /** Most recently active space – the default for new windows and the persisted value. */
  activeSpaceId: string
  containers: Container[]
  folders: Record<string, Folder>
  splitGroups: Record<string, SplitGroup>
  /** Per-window spaces of blank/private windows (transient). */
  localSpaces: Record<string, Space>
}

export const MAX_SPLIT_TABS = 4

export function emptyModel(containers: Container[]): Model {
  return {
    tabs: {},
    essentialTabIds: [],
    spaces: [],
    activeSpaceId: '',
    containers,
    folders: {},
    splitGroups: {},
    localSpaces: {}
  }
}

export function createSpace(name: string, icon: string, containerId = DEFAULT_CONTAINER_ID): Space {
  return {
    id: newId('space'),
    name,
    icon,
    containerId,
    theme: null,
    tabIds: [],
    activeTabId: null,
    pinnedCollapsed: false
  }
}

export function localSpaceId(windowId: string): string {
  return `win:${windowId}`
}

/** The private space of a blank / private window. */
export function createLocalSpace(
  windowId: string,
  name: string,
  icon: string,
  containerId: string,
  theme: Space['theme']
): Space {
  return {
    id: localSpaceId(windowId),
    name,
    icon,
    containerId,
    theme,
    tabIds: [],
    activeTabId: null,
    pinnedCollapsed: false,
    windowId
  }
}

export function createTabRecord(
  init: Partial<Tab> & { spaceId: string | null; containerId: string }
): Tab {
  const now = Date.now()
  const url = init.url ?? BLANK_URL
  return {
    id: init.id ?? newId('tab'),
    spaceId: init.spaceId,
    containerId: init.containerId,
    url,
    title: init.title ?? titleForUrl(url),
    favicon: init.favicon ?? null,
    pinned: init.pinned ?? false,
    essential: init.essential ?? false,
    pinnedUrl: init.pinnedUrl ?? (init.pinned || init.essential ? url : null),
    customTitle: init.customTitle ?? null,
    customIcon: init.customIcon ?? null,
    windowId: init.windowId ?? null,
    folderId: init.folderId ?? null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: init.muted ?? false,
    discarded: init.discarded ?? true,
    zoom: init.zoom ?? 1,
    splitGroupId: null,
    createdAt: init.createdAt ?? now,
    lastActiveAt: init.lastActiveAt ?? now,
    errorCode: null,
    bookmarked: init.bookmarked ?? false,
    readerable: false
  }
}

export function getSpace(model: Model, spaceId: string | null | undefined): Space | undefined {
  if (!spaceId) return undefined
  return model.spaces.find((s) => s.id === spaceId) ?? model.localSpaces[spaceId]
}

export function allSpaces(model: Model): Space[] {
  return [...model.spaces, ...Object.values(model.localSpaces)]
}

/** The most recently active real space (falls back to the first one). */
export function activeSpace(model: Model): Space {
  return model.spaces.find((s) => s.id === model.activeSpaceId) ?? model.spaces[0]
}

/** A tab is shown in a window when it is shared (`windowId === null`) or local to that window. */
export function tabVisibleIn(tab: Tab, windowId: string | undefined): boolean {
  return windowId === undefined || tab.windowId === null || tab.windowId === windowId
}

/** Essentials visible for a space (container specific when enabled). Local spaces have none. */
export function essentialsForSpace(model: Model, space: Space, containerSpecific: boolean): Tab[] {
  if (space.windowId) return []
  return model.essentialTabIds
    .map((id) => model.tabs[id])
    .filter((t): t is Tab => Boolean(t))
    .filter((t) => !containerSpecific || t.containerId === space.containerId)
}

export function pinnedTabs(model: Model, space: Space, windowId?: string): Tab[] {
  return space.tabIds
    .map((id) => model.tabs[id])
    .filter((t): t is Tab => Boolean(t) && t.pinned && tabVisibleIn(t, windowId))
}

export function regularTabs(model: Model, space: Space, windowId?: string): Tab[] {
  return space.tabIds
    .map((id) => model.tabs[id])
    .filter((t): t is Tab => Boolean(t) && !t.pinned && tabVisibleIn(t, windowId))
}

/** All tabs the user can cycle through in a space, in sidebar order. */
export function orderedTabsForSpace(
  model: Model,
  space: Space,
  containerSpecific: boolean,
  windowId?: string
): Tab[] {
  return [
    ...essentialsForSpace(model, space, containerSpecific),
    ...space.tabIds
      .map((id) => model.tabs[id])
      .filter((t): t is Tab => Boolean(t) && tabVisibleIn(t, windowId))
  ]
}

function firstRegularIndex(model: Model, space: Space): number {
  const idx = space.tabIds.findIndex((id) => !model.tabs[id]?.pinned)
  return idx === -1 ? space.tabIds.length : idx
}

/**
 * Insert a tab into a space's ordered list. Pinned tabs are kept in front of regular tabs.
 * `index` is relative to the section (pinned or regular).
 */
export function insertTabIntoSpace(model: Model, space: Space, tab: Tab, index?: number): void {
  space.tabIds = space.tabIds.filter((id) => id !== tab.id)
  const boundary = firstRegularIndex(model, space)
  if (tab.pinned) {
    const i = index === undefined ? boundary : Math.max(0, Math.min(index, boundary))
    space.tabIds.splice(i, 0, tab.id)
  } else {
    const regularCount = space.tabIds.length - boundary
    const i = index === undefined ? regularCount : Math.max(0, Math.min(index, regularCount))
    space.tabIds.splice(boundary + i, 0, tab.id)
  }
  tab.spaceId = space.id
  // Tabs inside a blank/private window's space always belong to that window.
  if (space.windowId) tab.windowId = space.windowId
}

export function removeTabFromLists(model: Model, tabId: string): void {
  model.essentialTabIds = model.essentialTabIds.filter((id) => id !== tabId)
  for (const space of allSpaces(model)) {
    if (space.tabIds.includes(tabId)) {
      space.tabIds = space.tabIds.filter((id) => id !== tabId)
    }
    if (space.activeTabId === tabId) space.activeTabId = null
  }
}

/** Index of a tab inside its section (used for restoring closed tabs). */
export function sectionIndexOf(model: Model, tab: Tab): number {
  if (tab.essential) return model.essentialTabIds.indexOf(tab.id)
  const space = getSpace(model, tab.spaceId)
  if (!space) return 0
  const list = tab.pinned ? pinnedTabs(model, space) : regularTabs(model, space)
  return list.findIndex((t) => t.id === tab.id)
}

/**
 * Pick the tab that should become active after `tabId` goes away (Firefox picks the next tab,
 * falling back to the previous one). Pinned/essential tabs are skipped when `skipPinned` is set,
 * which mirrors Zen's "switch to the next unpinned tab" behaviour on pinned-tab close.
 */
export function nextTabAfterClose(
  model: Model,
  space: Space,
  tabId: string,
  containerSpecific: boolean,
  skipPinned = false,
  windowId?: string
): string | null {
  const ordered = orderedTabsForSpace(model, space, containerSpecific, windowId)
  const candidates = ordered.filter((t) => !skipPinned || (!t.pinned && !t.essential))
  const idx = ordered.findIndex((t) => t.id === tabId)
  if (idx === -1) return candidates[0]?.id ?? null
  // Prefer the next tab in order, else the previous.
  for (let i = idx + 1; i < ordered.length; i++) {
    if (candidates.includes(ordered[i])) return ordered[i].id
  }
  for (let i = idx - 1; i >= 0; i--) {
    if (candidates.includes(ordered[i])) return ordered[i].id
  }
  return null
}

export function moveTab(
  model: Model,
  tab: Tab,
  target: { spaceId?: string; section: TabSection; index: number },
  essentialsMax: number
): void {
  const targetSpace = target.spaceId
    ? getSpace(model, target.spaceId)
    : (getSpace(model, tab.spaceId) ?? activeSpace(model))
  if (!targetSpace) return
  const cameFromLocalSpace = Boolean(getSpace(model, tab.spaceId)?.windowId)
  // Removing from the lists clears `activeTabId`; restore it where the tab is still visible.
  const wasActiveIn = allSpaces(model)
    .filter((s) => s.activeTabId === tab.id)
    .map((s) => s.id)
  removeTabFromLists(model, tab.id)
  if (target.section === 'essential' && !targetSpace.windowId) {
    if (model.essentialTabIds.length >= essentialsMax) {
      // Fall back to pinning inside the space when essentials are full.
      tab.essential = false
      tab.pinned = true
      tab.pinnedUrl = tab.pinnedUrl ?? tab.url
      tab.windowId = null
      insertTabIntoSpace(model, targetSpace, tab, 0)
    } else {
      tab.essential = true
      tab.pinned = false
      tab.spaceId = null
      tab.folderId = null
      tab.windowId = null
      tab.pinnedUrl = tab.pinnedUrl ?? tab.url
      tab.containerId = tab.containerId || targetSpace.containerId
      const i = Math.max(0, Math.min(target.index, model.essentialTabIds.length))
      model.essentialTabIds.splice(i, 0, tab.id)
    }
  } else {
    tab.essential = false
    tab.pinned = target.section === 'pinned'
    if (tab.pinned) tab.pinnedUrl = tab.pinnedUrl ?? tab.url
    else tab.pinnedUrl = null
    if (tab.spaceId !== targetSpace.id) tab.folderId = null
    // Pinned tabs are always shared, and a tab leaving a blank/private window becomes shared
    // too (the TabManager re-applies "sync only pinned tabs" ownership afterwards).
    if (!targetSpace.windowId && (tab.pinned || cameFromLocalSpace)) tab.windowId = null
    insertTabIntoSpace(model, targetSpace, tab, target.index)
  }
  for (const spaceId of wasActiveIn) {
    const space = getSpace(model, spaceId)
    if (space && (tab.essential || tab.spaceId === spaceId)) space.activeTabId = tab.id
  }
}

// ---------------------------------------------------------------------------
// Split views
// ---------------------------------------------------------------------------

export function equalSizes(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n)
}

export function createSplitGroup(
  model: Model,
  spaceId: string,
  tabIds: string[],
  layout: SplitLayout
): SplitGroup | null {
  const ids = tabIds.filter((id) => model.tabs[id]).slice(0, MAX_SPLIT_TABS)
  if (ids.length < 2) return null
  // Tabs already in other groups leave them first.
  for (const id of ids) removeTabFromSplit(model, id)
  const group: SplitGroup = {
    id: newId('split'),
    spaceId,
    tabIds: ids,
    layout,
    sizes: equalSizes(ids.length)
  }
  model.splitGroups[group.id] = group
  for (const id of ids) model.tabs[id].splitGroupId = group.id
  return group
}

export function dissolveSplitGroup(model: Model, groupId: string): void {
  const group = model.splitGroups[groupId]
  if (!group) return
  for (const id of group.tabIds) {
    const tab = model.tabs[id]
    if (tab) tab.splitGroupId = null
  }
  delete model.splitGroups[groupId]
}

export function removeTabFromSplit(model: Model, tabId: string): void {
  const tab = model.tabs[tabId]
  if (!tab?.splitGroupId) return
  const group = model.splitGroups[tab.splitGroupId]
  tab.splitGroupId = null
  if (!group) return
  group.tabIds = group.tabIds.filter((id) => id !== tabId)
  if (group.tabIds.length < 2) {
    dissolveSplitGroup(model, group.id)
  } else {
    group.sizes = equalSizes(group.tabIds.length)
  }
}

export function addTabToSplit(model: Model, groupId: string, tabId: string): boolean {
  const group = model.splitGroups[groupId]
  const tab = model.tabs[tabId]
  if (!group || !tab || group.tabIds.includes(tabId) || group.tabIds.length >= MAX_SPLIT_TABS)
    return false
  removeTabFromSplit(model, tabId)
  group.tabIds.push(tabId)
  group.sizes = equalSizes(group.tabIds.length)
  tab.splitGroupId = groupId
  return true
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export function createFolder(model: Model, spaceId: string, name: string, icon: string): Folder {
  const folder: Folder = { id: newId('folder'), spaceId, name, icon, collapsed: false }
  model.folders[folder.id] = folder
  return folder
}

export function deleteFolder(model: Model, folderId: string, unpack: boolean): string[] {
  const folder = model.folders[folderId]
  if (!folder) return []
  const members = Object.values(model.tabs).filter((t) => t.folderId === folderId)
  const closed: string[] = []
  for (const tab of members) {
    tab.folderId = null
    if (!unpack) closed.push(tab.id)
  }
  delete model.folders[folderId]
  return closed
}

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

export function spaceIndex(model: Model, spaceId: string): number {
  return model.spaces.findIndex((s) => s.id === spaceId)
}

/** The space `delta` steps away from `fromSpaceId` (wraps around). */
export function cycleSpace(model: Model, delta: number, fromSpaceId = model.activeSpaceId): Space {
  const idx = Math.max(0, spaceIndex(model, fromSpaceId))
  const n = model.spaces.length
  const next = (((idx + delta) % n) + n) % n
  return model.spaces[next]
}

export function reorderSpace(model: Model, spaceId: string, index: number): void {
  const idx = spaceIndex(model, spaceId)
  if (idx === -1) return
  const [space] = model.spaces.splice(idx, 1)
  model.spaces.splice(Math.max(0, Math.min(index, model.spaces.length)), 0, space)
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

/** Zen 1.22: containers can be reordered; "No Container" always stays first. */
export function reorderContainer(model: Model, containerId: string, index: number): void {
  const idx = model.containers.findIndex((c) => c.id === containerId)
  if (idx <= 0) return
  const [container] = model.containers.splice(idx, 1)
  model.containers.splice(Math.max(1, Math.min(index, model.containers.length)), 0, container)
}
