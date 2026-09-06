import type {
  Bookmark,
  ClosedTab,
  Container,
  DownloadItem,
  FindResult,
  Folder,
  GlanceState,
  HostCapabilities,
  KeyBinding,
  MediaState,
  Platform,
  Rect,
  SearchEngine,
  Settings,
  Shortcut,
  Space,
  SplitGroup,
  Tab,
  UIState,
  WindowState
} from '../shared/types'
import { DEFAULT_CONTAINER_ID } from '../shared/types'
import { DEFAULT_CONTAINERS, DEFAULT_SETTINGS } from '../shared/defaults'
import { DEFAULT_SEARCH_ENGINES } from '../shared/search'
import { applyShortcutOverrides, defaultShortcuts } from '../shared/shortcuts'
import { JsonStore } from './store/JsonStore'
import { createSpace, createTabRecord, type Model } from './model'
import { BLANK_URL } from '../shared/url'
import { defer, type StoreIO } from './platform'

interface Persisted {
  version: 1
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
  windowBounds: Rect | null
  maximized: boolean
}

export type StateListener = (state: UIState) => void

/**
 * Single source of truth for everything the UI shows. Mutate freely, then call `commit()`;
 * broadcasts to renderers and disk writes are coalesced.
 */
export class BrowserState {
  model: Model
  settings: Settings = structuredClone(DEFAULT_SETTINGS)
  shortcutOverrides: Record<string, KeyBinding | null> = {}
  bookmarks: Bookmark[] = []
  downloads: DownloadItem[] = []
  recentlyClosed: ClosedTab[] = []
  glance: GlanceState | null = null
  compactSidebarRevealed = false
  window: WindowState = {
    maximized: false,
    fullscreen: false,
    focused: true,
    htmlFullscreenTabId: null
  }
  media: MediaState[] = []
  findResult: FindResult | null = null
  devtoolsOpenFor = new Set<string>()
  windowBounds: Rect | null = null
  searchEngines: SearchEngine[] = DEFAULT_SEARCH_ENGINES
  readonly version: string

  private readonly store: JsonStore<Persisted>
  private readonly listeners = new Set<StateListener>()
  private scheduled = false
  private shortcutsCache: Shortcut[] | null = null

  constructor(
    io: StoreIO,
    readonly platform: Platform,
    readonly capabilities: HostCapabilities,
    version: string
  ) {
    this.version = version
    this.store = new JsonStore<Persisted>(io, 'state.json')
    this.model = {
      tabs: {},
      essentialTabIds: [],
      spaces: [],
      activeSpaceId: '',
      containers: structuredClone(DEFAULT_CONTAINERS),
      folders: {},
      splitGroups: {}
    }
  }

  /** Load the profile from disk (or create the first-run defaults). */
  load(): void {
    const data = this.store.readSync()
    if (data && data.version === 1) {
      this.applyPersisted(data)
    }
    this.ensureValid()
  }

  private applyPersisted(data: Persisted): void {
    this.settings = { ...structuredClone(DEFAULT_SETTINGS), ...data.settings }
    this.settings.compactMode = { ...DEFAULT_SETTINGS.compactMode, ...data.settings?.compactMode }
    // Compact mode's "persistent sidebar" toggle is transient by design.
    this.settings.compactMode.sidebarPersistent = false
    this.shortcutOverrides = data.shortcutOverrides ?? {}
    this.bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : []
    this.windowBounds = data.windowBounds ?? null
    this.window.maximized = Boolean(data.maximized)
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
      )
    }
  }

  /** Repair any inconsistencies so the UI never sees dangling references. */
  private ensureValid(): void {
    const m = this.model
    if (m.spaces.length === 0) {
      const space = createSpace('Default', '')
      m.spaces.push(space)
    }
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

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot(): UIState {
    const m = this.model
    return {
      platform: this.platform,
      capabilities: this.capabilities,
      version: this.version,
      tabs: m.tabs,
      essentialTabIds: m.essentialTabIds,
      spaces: m.spaces,
      activeSpaceId: m.activeSpaceId,
      containers: m.containers,
      folders: m.folders,
      splitGroups: m.splitGroups,
      settings: this.settings,
      shortcuts: this.shortcuts,
      searchEngines: this.searchEngines,
      glance: this.glance,
      compactSidebarRevealed: this.compactSidebarRevealed,
      window: this.window,
      downloads: this.downloads,
      bookmarks: this.bookmarks,
      recentlyClosedCount: this.recentlyClosed.length,
      media: this.media,
      findResult: this.findResult,
      devtoolsOpenFor: [...this.devtoolsOpenFor]
    }
  }

  /** Broadcast + persist, coalesced to once per tick. */
  commit(): void {
    if (this.scheduled) return
    this.scheduled = true
    defer(() => {
      this.scheduled = false
      const snap = this.snapshot()
      for (const listener of this.listeners) listener(snap)
      this.store.write(this.toPersisted())
    })
  }

  /** Update only volatile UI state (no disk write). */
  commitVolatile(): void {
    if (this.scheduled) return
    this.scheduled = true
    defer(() => {
      this.scheduled = false
      const snap = this.snapshot()
      for (const listener of this.listeners) listener(snap)
    })
  }

  private toPersisted(): Persisted {
    const m = this.model
    // Glance tabs are transient – never persist them.
    const glanceTabId = this.glance?.tabId
    return {
      version: 1,
      spaces: m.spaces,
      tabs: Object.values(m.tabs)
        .filter((t) => t.id !== glanceTabId)
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
      splitGroups: Object.values(m.splitGroups),
      settings: this.settings,
      shortcutOverrides: this.shortcutOverrides,
      bookmarks: this.bookmarks,
      windowBounds: this.windowBounds,
      maximized: this.window.maximized
    }
  }

  async flush(): Promise<void> {
    this.store.write(this.toPersisted())
    await this.store.flush()
  }

  flushSync(): void {
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
