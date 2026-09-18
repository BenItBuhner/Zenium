import type {
  ClosedEntry,
  ClosedEntrySummary,
  ClosedTabEntry,
  ClosedWindowEntry,
  NavigationSnapshot,
  Rect,
  Tab,
  WindowKind
} from '../shared/types'
import { PRIVATE_CONTAINER_ID } from '../shared/types'
import { displayUrl } from '../shared/url'
import { newId } from '../shared/ids'
import type { Browser } from './browser'
import type { ZenWindow } from './window'
import { createTabRecord, getSpace, insertTabIntoSpace } from './model'

/** Entries remembered (a window with all its tabs counts as one). */
export const RECENTLY_CLOSED_MAX = 25

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Where a closed tab sat, so it can go back to the same place. */
export interface ClosedTabPlacement {
  spaceId: string | null
  folderId: string | null
  index: number
  windowId: string | null
}

export function closedTabEntry(
  tab: Tab,
  placement: ClosedTabPlacement,
  navigation: NavigationSnapshot | null,
  closedAt: number
): ClosedTabEntry {
  return {
    kind: 'tab',
    id: newId('closed'),
    closedAt,
    tab: {
      ...tab,
      splitGroupId: null,
      discarded: true,
      loading: false,
      audible: false,
      // Reopened by the user later, not by the app that once sent the URL.
      fromIntent: false
    },
    spaceId: placement.spaceId,
    folderId: placement.folderId,
    index: placement.index,
    windowId: placement.windowId,
    navigation
  }
}

export function closedWindowEntry(
  windowKind: WindowKind,
  bounds: Rect | null,
  activeTabId: string | null,
  tabs: ClosedTabEntry[],
  closedAt: number
): ClosedWindowEntry {
  return { kind: 'window', id: newId('closed'), closedAt, windowKind, bounds, activeTabId, tabs }
}

/** Newest first, capped; private tabs never make it in. */
export function pushClosed(list: ClosedEntry[], entry: ClosedEntry): ClosedEntry[] {
  return [entry, ...list].slice(0, RECENTLY_CLOSED_MAX)
}

export function summarizeClosed(entry: ClosedEntry): ClosedEntrySummary {
  if (entry.kind === 'tab') {
    const tab = entry.tab
    return {
      id: entry.id,
      kind: 'tab',
      title: tab.customTitle ?? tab.title ?? displayUrl(tab.url),
      url: tab.url,
      favicon: tab.favicon,
      closedAt: entry.closedAt,
      tabCount: 1
    }
  }
  const active = entry.tabs.find((t) => t.tab.id === entry.activeTabId) ?? entry.tabs[0]
  const activeTab = active?.tab
  return {
    id: entry.id,
    kind: 'window',
    title: activeTab ? (activeTab.customTitle ?? activeTab.title) : 'Window',
    url: activeTab?.url ?? null,
    favicon: activeTab?.favicon ?? null,
    closedAt: entry.closedAt,
    tabCount: entry.tabs.length
  }
}

/** Keep only well-formed entries of a stored list (a corrupt document must not take the UI down). */
export function sanitizeClosedEntries(raw: unknown): ClosedEntry[] {
  if (!Array.isArray(raw)) return []
  const out: ClosedEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const e = item as Partial<ClosedEntry>
    if (typeof e.id !== 'string' || typeof e.closedAt !== 'number') continue
    if (e.kind === 'tab') {
      const t = e as Partial<ClosedTabEntry>
      if (!t.tab || typeof t.tab !== 'object' || typeof t.tab.url !== 'string') continue
      if (t.tab.containerId === PRIVATE_CONTAINER_ID) continue
      out.push({
        kind: 'tab',
        id: e.id,
        closedAt: e.closedAt,
        tab: createTabRecord({
          ...t.tab,
          spaceId: t.tab.spaceId ?? null,
          containerId: t.tab.containerId ?? 'default',
          discarded: true
        }),
        spaceId: t.spaceId ?? null,
        folderId: t.folderId ?? null,
        index: typeof t.index === 'number' ? t.index : 0,
        windowId: t.windowId ?? null,
        navigation: isSnapshot(t.navigation) ? t.navigation : null
      })
    } else if (e.kind === 'window') {
      const w = e as Partial<ClosedWindowEntry>
      if (w.windowKind === 'private') continue
      const tabs = sanitizeClosedEntries(w.tabs).filter(
        (t): t is ClosedTabEntry => t.kind === 'tab'
      )
      if (tabs.length === 0) continue
      out.push({
        kind: 'window',
        id: e.id,
        closedAt: e.closedAt,
        windowKind: w.windowKind === 'unsynced' ? 'unsynced' : 'synced',
        bounds: w.bounds ?? null,
        activeTabId: typeof w.activeTabId === 'string' ? w.activeTabId : null,
        tabs
      })
    }
  }
  return out.slice(0, RECENTLY_CLOSED_MAX)
}

function isSnapshot(value: unknown): value is NavigationSnapshot {
  if (!value || typeof value !== 'object') return false
  const s = value as Partial<NavigationSnapshot>
  return Array.isArray(s.entries) && typeof s.index === 'number'
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Recently closed tabs and windows (Firefox's "Recently Closed" lists, Ctrl+Shift+T). Entries
 * live in `BrowserState.recentlyClosed` so they persist with the profile; restoring a tab puts
 * it back where it was, with its back/forward stack, and a window comes back whole.
 */
export class SessionService {
  constructor(private readonly browser: Browser) {}

  recentlyClosed(): ClosedEntry[] {
    return this.browser.state.recentlyClosed
  }

  summaries(): ClosedEntrySummary[] {
    return this.browser.state.recentlyClosed.map(summarizeClosed)
  }

  /** Remember a closed tab (private tabs are never kept). */
  pushTab(entry: ClosedTabEntry): void {
    if (entry.tab.containerId === PRIVATE_CONTAINER_ID) return
    this.push(entry)
  }

  /** Remember a closed window with the tabs that went with it. */
  pushWindow(entry: ClosedWindowEntry): void {
    if (entry.windowKind === 'private' || entry.tabs.length === 0) return
    this.push(entry)
  }

  private push(entry: ClosedEntry): void {
    const state = this.browser.state
    state.recentlyClosed = pushClosed(state.recentlyClosed, entry)
    this.changed()
  }

  /** Ctrl+Shift+T: bring back the newest entry (a window entry as a whole window). */
  reopenClosed(win: ZenWindow = this.browser.focusedWindow()): void {
    const newest = this.browser.state.recentlyClosed[0]
    if (newest) this.restoreClosed(newest.id, win)
  }

  restoreClosed(id: string, win: ZenWindow = this.browser.focusedWindow()): void {
    const state = this.browser.state
    const entry = state.recentlyClosed.find((e) => e.id === id)
    if (!entry) return
    state.recentlyClosed = state.recentlyClosed.filter((e) => e.id !== id)
    if (entry.kind === 'tab') {
      const tab = this.restoreTab(entry, win)
      this.browser.tabs.activateTab(tab.id, win)
    } else {
      this.restoreWindow(entry, win)
    }
    this.changed()
  }

  /** Bring back every entry, oldest first so positions line up with how they were closed. */
  restoreAll(win: ZenWindow = this.browser.focusedWindow()): void {
    const entries = [...this.browser.state.recentlyClosed].reverse()
    for (const entry of entries) this.restoreClosed(entry.id, win)
  }

  clearRecentlyClosed(): void {
    if (this.browser.state.recentlyClosed.length === 0) return
    this.browser.state.recentlyClosed = []
    this.changed()
  }

  private changed(): void {
    this.browser.state.commit()
    for (const w of this.browser.allWindows()) w.send('session.recentlyClosedChanged', undefined)
  }

  /**
   * Put a closed tab back: into its space (or the window's own space for blank windows), at
   * its old position, in its folder when that still exists. Its back/forward stack is replayed
   * once the page loads.
   */
  private restoreTab(closed: ClosedTabEntry, win: ZenWindow): Tab {
    const { tabs } = this.browser
    const m = this.browser.state.model
    let space = (closed.spaceId ? getSpace(m, closed.spaceId) : undefined) ?? win.activeSpace()
    if (win.localSpace) space = win.localSpace
    const tab = createTabRecord({
      ...closed.tab,
      spaceId: closed.tab.essential && !space.windowId ? null : space.id,
      containerId: win.isPrivate ? PRIVATE_CONTAINER_ID : closed.tab.containerId,
      folderId: closed.folderId && m.folders[closed.folderId] ? closed.folderId : null,
      discarded: true
    })
    if (m.tabs[tab.id]) tab.id = newId('tab')
    m.tabs[tab.id] = tab
    if (
      tab.essential &&
      !space.windowId &&
      m.essentialTabIds.length < this.browser.state.settings.essentialsMax
    ) {
      m.essentialTabIds.splice(Math.min(closed.index, m.essentialTabIds.length), 0, tab.id)
      tab.windowId = null
    } else {
      tab.essential = false
      if (tab.folderId && m.folders[tab.folderId]?.spaceId !== space.id) tab.folderId = null
      insertTabIntoSpace(m, space, tab, closed.index)
      tab.windowId = tabs.ownerWindowIdFor(tab, space, win)
    }
    tab.bookmarked = this.browser.bookmarks.has(tab.url)
    if (closed.navigation && closed.navigation.entries.length > 1)
      tabs.setPendingNavigation(tab.id, closed.navigation)
    return tab
  }

  /** A closed window comes back as a window of the same kind holding the same tabs. */
  private restoreWindow(closed: ClosedWindowEntry, from: ZenWindow): void {
    const { browser } = this
    if (!browser.state.capabilities.windows) {
      // One window only (Android): the tabs come back into the current one.
      let last: Tab | null = null
      for (const t of closed.tabs) last = this.restoreTab(t, from)
      if (last) browser.tabs.activateTab(last.id, from)
      return
    }
    const kind: WindowKind = closed.windowKind === 'unsynced' ? 'unsynced' : 'synced'
    const win = browser.createWindow({ kind, from, bounds: closed.bounds, empty: true })
    const restored = new Map<string, Tab>()
    for (const t of closed.tabs) restored.set(t.tab.id, this.restoreTab(t, win))
    const active =
      (closed.activeTabId ? restored.get(closed.activeTabId) : undefined) ??
      [...restored.values()][0]
    if (active) browser.tabs.activateTab(active.id, win)
    browser.state.commit()
  }
}
