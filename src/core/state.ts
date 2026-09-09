import type {
  AgentInfo,
  AgentServerStatus,
  Bookmark,
  Boost,
  ClosedTab,
  Container,
  DownloadItem,
  ExtensionInfo,
  Folder,
  HostCapabilities,
  KeyBinding,
  LiveFolderConfig,
  MediaState,
  Mod,
  Platform,
  Rect,
  ResourceSnapshot,
  SearchEngine,
  Settings,
  Shortcut,
  Space,
  SplitGroup,
  SyncStatus,
  Tab,
  UIState
} from '../shared/types'
import { DEFAULT_CONTAINER_ID } from '../shared/types'
import {
  DEFAULT_CONTAINERS,
  DEFAULT_SETTINGS,
  emptyAgentServerStatus,
  emptyResourceSnapshot
} from '../shared/defaults'
import { DEFAULT_SEARCH_ENGINES } from '../shared/search'
import { applyShortcutOverrides, defaultShortcuts } from '../shared/shortcuts'
import { JsonStore } from './store/JsonStore'
import { createSpace, createTabRecord, emptyModel, tabVisibleIn, type Model } from './model'
import { sanitizeResourceSettings } from './resources/switches'
import { sanitizeAgentSettings } from './agent/settings'
import { BLANK_URL } from '../shared/url'
import { defer, type StoreIO } from './platform'
import type { ZenWindow } from './window'

/** A synced window as remembered between sessions (blank / private windows are never restored). */
export interface PersistedWindow {
  id: string
  bounds: Rect | null
  maximized: boolean
  activeSpaceId: string
  /** Per-space selected tab. */
  selection: Record<string, string>
  compact: boolean
}

interface Persisted {
  version: 1 | 2
  spaces: Space[]
  tabs: Tab[]
  essentialTabIds: string[]
  activeSpaceId: string
  containers: Container[]
  folders: Folder[]
  splitGroups: SplitGroup[]
  settings: Settings
  shortcutOverrides: Record<string, KeyBinding | null>
  bookmarks: Bookmark[]
  /** v1: the single window's bounds. */
  windowBounds?: Rect | null
  maximized?: boolean
  /** v2: every synced window. */
  windows?: PersistedWindow[]
}

export type StateListener = () => void

/** Feature state owned by other services but shown in the UI. */
export interface StateExtras {
  boosts: Boost[]
  zappingTabId: string | null
  liveFolders: Record<string, LiveFolderConfig>
  extensions: ExtensionInfo[]
  mods: Mod[]
  sync: SyncStatus
  agents: AgentInfo[]
  agentServer: AgentServerStatus
}

/**
 * Single source of truth for everything the UI shows. Mutate freely, then call `commit()`;
 * broadcasts to renderers and disk writes are coalesced. Shared between all windows – anything
 * that differs per window lives on the `ZenWindow` and is overlaid in `snapshot(win)`.
 */
export class BrowserState {
  model: Model
  settings: Settings = structuredClone(DEFAULT_SETTINGS)
  shortcutOverrides: Record<string, KeyBinding | null> = {}
  bookmarks: Bookmark[] = []
  downloads: DownloadItem[] = []
  recentlyClosed: ClosedTab[] = []
  media: MediaState[] = []
  devtoolsOpenFor = new Set<string>()
  resources: ResourceSnapshot = emptyResourceSnapshot()
  windowBounds: Rect | null = null
  /** Windows to restore on startup (from the previous session). */
  restoredWindows: PersistedWindow[] = []
  /** Live windows, registered by the Browser so persistence can capture them. */
  liveWindows: () => ZenWindow[] = () => []
  /** Provided by the Browser once its feature services exist. */
  extras: () => StateExtras = () => ({
    boosts: [],
    zappingTabId: null,
    liveFolders: {},
    extensions: [],
    mods: [],
    sync: {
      enabled: false,
      folder: null,
      deviceId: '',
      deviceName: '',
      scope: {
        spaces: true,
        folders: true,
        pinnedTabs: true,
        essentials: true,
        openTabs: false,
        containers: true,
        bookmarks: true,
        settings: true,
        shortcuts: true,
        boosts: true
      },
      lastSyncAt: null,
      lastError: null,
      syncing: false,
      devices: [],
      pendingMerge: false
    },
    agents: [],
    agentServer: emptyAgentServerStatus()
  })
  searchEngines: SearchEngine[] = DEFAULT_SEARCH_ENGINES
  readonly version: string

  private readonly store: JsonStore<Persisted>
  private readonly listeners = new Set<StateListener>()
  private scheduled = false
  private shortcutsCache: Shortcut[] | null = null
  /** The last set of synced windows written to disk (used once they are all closed). */
  private lastWindows: PersistedWindow[] = []
  /** After shutdown nothing may be written any more (windows closing would shrink the list). */
  private frozen = false

  constructor(
    io: StoreIO,
    readonly platform: Platform,
    readonly capabilities: HostCapabilities,
    version: string
  ) {
    this.version = version
    this.store = new JsonStore<Persisted>(io, 'state.json')
    this.model = emptyModel(structuredClone(DEFAULT_CONTAINERS))
  }

  /** Load the profile from disk (or create the first-run defaults). */
  load(): void {
    const data = this.store.readSync()
    if (data && (data.version === 1 || data.version === 2)) {
      this.applyPersisted(data)
    }
    this.ensureValid()
  }

  private applyPersisted(data: Persisted): void {
    this.settings = { ...structuredClone(DEFAULT_SETTINGS), ...data.settings }
    this.settings.compactMode = { ...DEFAULT_SETTINGS.compactMode, ...data.settings?.compactMode }
    // Compact mode's "persistent sidebar" toggle is transient by design.
    this.settings.compactMode.sidebarPersistent = false
    this.settings.resources = sanitizeResourceSettings(data.settings?.resources)
    this.settings.agents = sanitizeAgentSettings(data.settings?.agents)
    this.shortcutOverrides = data.shortcutOverrides ?? {}
    this.bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : []
    if (Array.isArray(data.windows) && data.windows.length) {
      this.restoredWindows = data.windows.filter((w) => w && typeof w.id === 'string')
    } else {
      // v1 profile: one window.
      this.restoredWindows = [
        {
          id: 'window_main',
          bounds: data.windowBounds ?? null,
          maximized: Boolean(data.maximized),
          activeSpaceId: data.activeSpaceId,
          selection: {},
          compact: Boolean(data.settings?.compactMode?.enabled)
        }
      ]
    }
    const containers =
      Array.isArray(data.containers) && data.containers.length
        ? data.containers
        : structuredClone(DEFAULT_CONTAINERS)
    if (!containers.some((c) => c.id === DEFAULT_CONTAINER_ID))
      containers.unshift(DEFAULT_CONTAINERS[0])
    const tabs: Record<string, Tab> = {}
    for (const raw of Array.isArray(data.tabs) ? data.tabs : []) {
      if (!raw || typeof raw.id !== 'string') continue
      const tab = createTabRecord({
        ...raw,
        spaceId: raw.spaceId ?? null,
        containerId: containers.some((c) => c.id === raw.containerId)
          ? raw.containerId
          : DEFAULT_CONTAINER_ID,
        // Everything starts unloaded; the active tab is loaded by the TabManager on startup.
        discarded: true
      })
      tab.splitGroupId = raw.splitGroupId ?? null
      tab.loading = false
      tab.audible = false
      tab.errorCode = null
      tabs[tab.id] = tab
    }
    this.model = {
      tabs,
      essentialTabIds: Array.isArray(data.essentialTabIds) ? data.essentialTabIds : [],
      spaces: Array.isArray(data.spaces) ? data.spaces : [],
      activeSpaceId: data.activeSpaceId,
      containers,
      folders: Object.fromEntries(
        (Array.isArray(data.folders) ? data.folders : []).map((f) => [f.id, f])
      ),
      splitGroups: Object.fromEntries(
        (Array.isArray(data.splitGroups) ? data.splitGroups : []).map((g) => [g.id, g])
      ),
      localSpaces: {}
    }
  }

  /** Re-run the consistency checks after bulk changes (sync). */
  repair(): void {
    this.ensureValid()
  }

  /** Repair any inconsistencies so the UI never sees dangling references. */
  private ensureValid(): void {
    const m = this.model
    if (m.spaces.length === 0) {
      const space = createSpace('Default', '')
      m.spaces.push(space)
    }
    // Local (blank / private window) spaces never survive a restart.
    m.spaces = m.spaces.filter((s) => !s.windowId)
    m.localSpaces = {}
    for (const space of m.spaces) {
      space.tabIds = (space.tabIds ?? []).filter((id) => m.tabs[id] && !m.tabs[id].essential)
      // Keep pinned tabs first.
      const pinned = space.tabIds.filter((id) => m.tabs[id].pinned)
      const regular = space.tabIds.filter((id) => !m.tabs[id].pinned)
      space.tabIds = [...pinned, ...regular]
      for (const id of space.tabIds) m.tabs[id].spaceId = space.id
      if (!m.containers.some((c) => c.id === space.containerId))
        space.containerId = DEFAULT_CONTAINER_ID
      space.pinnedCollapsed = Boolean(space.pinnedCollapsed)
      space.icon = space.icon ?? ''
      space.theme = space.theme ?? null
    }
    m.essentialTabIds = m.essentialTabIds.filter((id) => m.tabs[id]?.essential)
    for (const id of m.essentialTabIds) m.tabs[id].spaceId = null
    // Drop tabs that are not referenced anywhere.
    const referenced = new Set<string>([...m.essentialTabIds, ...m.spaces.flatMap((s) => s.tabIds)])
    for (const id of Object.keys(m.tabs)) {
      if (!referenced.has(id)) delete m.tabs[id]
    }
    // Window ownership: pinned tabs are always shared; with window sync on, so is everything
    // else. Tabs of windows that are gone are re-homed to the first restored window.
    const windowIds = new Set(this.restoredWindows.map((w) => w.id))
    const firstWindow = this.restoredWindows[0]?.id ?? null
    for (const tab of Object.values(m.tabs)) {
      if (tab.pinned || tab.essential || this.settings.windowSync !== 'pinned') tab.windowId = null
      else if (tab.windowId && !windowIds.has(tab.windowId)) tab.windowId = firstWindow
    }
    for (const space of m.spaces) {
      const valid = new Set([...space.tabIds, ...m.essentialTabIds])
      if (space.activeTabId && !valid.has(space.activeTabId)) space.activeTabId = null
      if (!space.activeTabId)
        space.activeTabId = space.tabIds.find((id) => !m.tabs[id].pinned) ?? space.tabIds[0] ?? null
    }
    if (!m.spaces.some((s) => s.id === m.activeSpaceId)) m.activeSpaceId = m.spaces[0].id
    for (const folder of Object.values(m.folders)) {
      if (!m.spaces.some((s) => s.id === folder.spaceId)) delete m.folders[folder.id]
    }
    for (const tab of Object.values(m.tabs)) {
      if (tab.folderId && !m.folders[tab.folderId]) tab.folderId = null
    }
    for (const group of Object.values(m.splitGroups)) {
      group.tabIds = group.tabIds.filter((id) => m.tabs[id] && m.tabs[id].spaceId === group.spaceId)
      if (group.tabIds.length < 2 || !m.spaces.some((s) => s.id === group.spaceId)) {
        for (const id of group.tabIds) if (m.tabs[id]) m.tabs[id].splitGroupId = null
        delete m.splitGroups[group.id]
        continue
      }
      if (group.sizes?.length !== group.tabIds.length)
        group.sizes = group.tabIds.map(() => 1 / group.tabIds.length)
      for (const id of group.tabIds) m.tabs[id].splitGroupId = group.id
    }
    for (const tab of Object.values(m.tabs)) {
      if (tab.splitGroupId && !m.splitGroups[tab.splitGroupId]) tab.splitGroupId = null
    }
    const bookmarked = new Set(this.bookmarks.map((b) => b.url))
    for (const tab of Object.values(m.tabs)) tab.bookmarked = bookmarked.has(tab.url)
    if (!this.searchEngines.some((e) => e.id === this.settings.searchEngineId)) {
      this.settings.searchEngineId = DEFAULT_SETTINGS.searchEngineId
    }
    for (const w of this.restoredWindows) {
      if (!m.spaces.some((s) => s.id === w.activeSpaceId)) w.activeSpaceId = m.activeSpaceId
      w.selection = Object.fromEntries(
        Object.entries(w.selection ?? {}).filter(([spaceId, tabId]) => {
          const space = m.spaces.find((s) => s.id === spaceId)
          return space && (space.tabIds.includes(tabId) || m.essentialTabIds.includes(tabId))
        })
      )
    }
  }

  get shortcuts(): Shortcut[] {
    if (!this.shortcutsCache) {
      this.shortcutsCache = applyShortcutOverrides(
        defaultShortcuts(this.platform),
        this.shortcutOverrides
      )
    }
    return this.shortcutsCache
  }

  setShortcutOverride(id: string, binding: KeyBinding | null): void {
    this.shortcutOverrides[id] = binding
    this.shortcutsCache = null
  }

  resetShortcuts(): void {
    this.shortcutOverrides = {}
    this.shortcutsCache = null
  }

  setShortcutOverrides(overrides: Record<string, KeyBinding | null>): void {
    this.shortcutOverrides = { ...overrides }
    this.shortcutsCache = null
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** What one window shows: the shared model filtered to that window plus its own UI state. */
  snapshot(win: ZenWindow): UIState {
    const m = this.model
    const windowId = win.id
    const cm = this.settings.compactMode
    const settings: Settings = {
      ...this.settings,
      compactMode: {
        ...cm,
        enabled: win.compactEnabled,
        sidebarPersistent: win.compactSidebarPersistent
      }
    }
    let spaces: Space[]
    let tabs: Record<string, Tab>
    let essentialTabIds: string[]
    let folders: Record<string, Folder>
    let splitGroups: Record<string, SplitGroup>
    if (win.kind === 'synced') {
      spaces = m.spaces.map((s) => ({
        ...s,
        tabIds: s.tabIds.filter((id) => m.tabs[id] && tabVisibleIn(m.tabs[id], windowId)),
        activeTabId: win.selectedTabIn(s)
      }))
      tabs = {}
      for (const tab of Object.values(m.tabs)) {
        if (!tabVisibleIn(tab, windowId)) continue
        if (tab.spaceId && m.localSpaces[tab.spaceId]) continue
        tabs[tab.id] = tab
      }
      essentialTabIds = m.essentialTabIds
      folders = m.folders
      splitGroups = {}
      for (const g of Object.values(m.splitGroups))
        if (!m.localSpaces[g.spaceId]) splitGroups[g.id] = g
    } else {
      const space = win.localSpace!
      spaces = [{ ...space, activeTabId: win.selectedTabIn(space) }]
      tabs = {}
      for (const id of space.tabIds) if (m.tabs[id]) tabs[id] = m.tabs[id]
      essentialTabIds = []
      folders = {}
      splitGroups = {}
      for (const g of Object.values(m.splitGroups))
        if (g.spaceId === space.id) splitGroups[g.id] = g
    }
    return {
      platform: this.platform,
      capabilities: this.capabilities,
      version: this.version,
      tabs,
      essentialTabIds,
      spaces,
      activeSpaceId: win.activeSpaceId,
      containers: m.containers,
      folders,
      splitGroups,
      settings,
      shortcuts: this.shortcuts,
      searchEngines: this.searchEngines,
      glance: win.glance,
      compactSidebarRevealed: win.compactSidebarRevealed,
      window: win.windowState(),
      downloads: this.downloads,
      bookmarks: this.bookmarks,
      recentlyClosedCount: this.recentlyClosed.length,
      media: this.media,
      findResult: win.findResult,
      devtoolsOpenFor: [...this.devtoolsOpenFor],
      foreignTabIds: win.foreignTabIds(),
      windowCount: this.liveWindows().length,
      ...this.extras(),
      resources: this.resources
    }
  }

  /** Broadcast + persist, coalesced to once per tick. */
  commit(): void {
    if (this.scheduled) return
    this.scheduled = true
    defer(() => {
      this.scheduled = false
      for (const listener of this.listeners) listener()
      if (!this.frozen) this.store.write(this.toPersisted())
    })
  }

  /** Stop persisting (called once the final state has been flushed on quit). */
  freeze(): void {
    this.frozen = true
  }

  /** Update only volatile UI state (no disk write). */
  commitVolatile(): void {
    if (this.scheduled) return
    this.scheduled = true
    defer(() => {
      this.scheduled = false
      for (const listener of this.listeners) listener()
    })
  }

  private toPersisted(): Persisted {
    const m = this.model
    const windows = this.liveWindows().filter((w) => w.kind === 'synced')
    if (windows.length > 0) this.lastWindows = windows.map((w) => w.toPersisted())
    const persistedWindows: PersistedWindow[] =
      this.lastWindows.length > 0 ? this.lastWindows : this.restoredWindows
    // Glance tabs and tabs of blank / private windows are transient – never persist them.
    const transient = new Set<string>()
    for (const w of this.liveWindows()) if (w.glance) transient.add(w.glance.tabId)
    return {
      version: 2,
      spaces: m.spaces,
      tabs: Object.values(m.tabs)
        .filter((t) => !transient.has(t.id) && !(t.spaceId && m.localSpaces[t.spaceId]))
        .map((t) => ({
          ...t,
          loading: false,
          audible: false,
          errorCode: null,
          url: t.url.startsWith('zen://error') ? (safeOriginalUrl(t.url) ?? BLANK_URL) : t.url
        })),
      essentialTabIds: m.essentialTabIds,
      activeSpaceId: m.activeSpaceId,
      containers: m.containers,
      folders: Object.values(m.folders),
      splitGroups: Object.values(m.splitGroups).filter((g) => !m.localSpaces[g.spaceId]),
      settings: this.settings,
      shortcutOverrides: this.shortcutOverrides,
      bookmarks: this.bookmarks,
      windows: persistedWindows
    }
  }

  async flush(): Promise<void> {
    if (this.frozen) return
    this.store.write(this.toPersisted())
    await this.store.flush()
  }

  flushSync(): void {
    if (this.frozen) return
    this.store.write(this.toPersisted())
    this.store.flushSync()
  }
}

function safeOriginalUrl(errorUrl: string): string | null {
  try {
    return new URL(errorUrl).searchParams.get('url')
  } catch {
    return null
  }
}
