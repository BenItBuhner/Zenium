import type {
  AgentInfo,
  AgentServerStatus,
  AutofillUIState,
  BlockedPopup,
  Bookmark,
  BookmarkNode,
  BookmarkTreeData,
  Boost,
  ClosedEntry,
  ImportProgress,
  NavigationSnapshot,
  Container,
  CrashRestoreOffer,
  DefaultBrowserStatus,
  DownloadItem,
  DownloadsProgress,
  ExtensionInfo,
  ExtensionUpdateCheck,
  Folder,
  HostCapabilities,
  KeyBinding,
  LiveFolderConfig,
  MediaState,
  Mod,
  NewTabDeviceState,
  NewTabShortcut,
  PageDialog,
  PasswordsDeviceState,
  PrivateDeviceState,
  ScreenCaptureRequest,
  ShareRequest,
  PasswordsStatus,
  PageEnvironment,
  PermissionPrompt,
  PermissionRule,
  Platform,
  Rect,
  ResourceSnapshot,
  SafetyCheckResult,
  SearchEngine,
  SearchEngineControl,
  SecurityPrompt,
  Settings,
  Shortcut,
  ShortcutPreset,
  SidePanelInfo,
  Space,
  SplitGroup,
  SyncStatus,
  Tab,
  UIState
} from '../shared/types'
import type { TranslateUIState } from '../shared/translate'
import type { ContentDefault } from '../shared/contentSettings'
import {
  DEFAULT_CONTAINER_ID,
  PRIVATE_CONTAINER_ID,
  emptyPasswordsDevice,
  emptyPrivateDevice,
  sanitizePasswordsDevice,
  sanitizePrivateDevice
} from '../shared/types'
import { sanitizeAppIcon } from '../shared/appIcon'
import { isChromePageUrl, parseInternalPageUrl } from '../shared/internalPages'
import {
  DEFAULT_CONTAINERS,
  DEFAULT_SETTINGS,
  emptyAgentServerStatus,
  emptyAutofillUIState,
  emptyPasswordsStatus,
  emptyResourceSnapshot,
  sanitizeAutofillSettings,
  sanitizePasswordSettings
} from '../shared/defaults'
import { sanitizePhoneBar } from '../shared/phoneBar'
import {
  allSearchEngines,
  defaultSearchEngineOf,
  isPickableSearchEngine,
  sanitizeSearchEngines
} from '../shared/search'
import {
  applyShortcutOverrides,
  defaultShortcuts,
  isShortcutPreset,
  migrateShortcutPreset
} from '../shared/shortcuts'
import {
  BOOKMARK_SCHEMA_VERSION,
  BookmarkTree,
  createBookmarkRoots,
  defaultBookmarkFolderId,
  migrateLegacyBookmarks,
  normalizeBookmarkNodes
} from '../shared/bookmarks'
import { JsonStore } from './store/JsonStore'
import { createSpace, createTabRecord, emptyModel, tabVisibleIn, type Model } from './model'
import { sanitizeResourceSettings } from './resources/switches'
import { sanitizeAgentSettings } from './agent/settings'
import {
  emptyUpdateStatus,
  sanitizeUpdateSettings,
  updateOsOf,
  type UpdateStatus
} from '../shared/updates'
import { BLANK_URL } from '../shared/url'
import { sanitizePromoState } from '../shared/defaultBrowser'
import {
  emptyBlockingStatus,
  sanitizeBlockingSettings,
  type BlockingStatus
} from '../shared/blocking'
import { DEFAULT_PAGE_ENVIRONMENT, sanitizePageControls } from '../shared/pageControls'
import { emptyPrivacyStatus, sanitizePrivacySettings, type PrivacyStatus } from '../shared/privacy'
import { emptySiteDataStatus, type SiteDataStatus } from '../shared/siteData'
import {
  UNAVAILABLE_SPELLCHECK,
  sanitizeSpellcheck,
  type SpellcheckStatus
} from '../shared/spellcheck'
import { sanitizeReaderPreferences } from '../shared/reader'
import { sanitizeReadAloudSettings, type ReadAloudState } from '../shared/readAloud'
import {
  emptyNewTabDevice,
  migrateNewTabDevice,
  migrateNewTabSettings,
  sanitizeNewTabSettings
} from '../shared/newTab'
import { defer, type StoreIO } from './platform'
import { sanitizeClosedEntries, sanitizeSnapshot, summarizeClosed } from './session'
import { defaultScope } from './sync/records'
import {
  closedNavigationOf,
  closedTabIds,
  NavigationStateStore,
  withoutClosedHostState,
  withoutHostState
} from './navigationState'
import type { ZenWindow } from './window'

const BOOKMARKS_BAR_MODES: ReadonlyArray<Settings['bookmarksBar']> = ['always', 'newtab', 'never']

/** A synced window as remembered between sessions (blank / private windows are never restored). */
export interface PersistedWindow {
  id: string
  bounds: Rect | null
  /** The display `bounds` were on (the host's id), so the window goes back to it when it is still there. */
  displayId?: number | null
  maximized: boolean
  activeSpaceId: string
  /** Per-space selected tab. */
  selection: Record<string, string>
  compact: boolean
}

/**
 * `state.json`. v1: one window; v2: every synced window; v3: the bookmark tree; v4: the new tab
 * page's shortcuts and its "Most visited" block list; v5: the new tab page's one model.
 */
export interface Persisted {
  version: 1 | 2 | 3 | 4 | 5
  spaces: Space[]
  tabs: Tab[]
  essentialTabIds: string[]
  activeSpaceId: string
  containers: Container[]
  folders: Folder[]
  splitGroups: SplitGroup[]
  settings: Settings
  shortcutOverrides: Record<string, KeyBinding | null>
  /** v1–v2: a flat list (newest first); v3: the tree, see `bookmarkTree`. */
  bookmarks?: Bookmark[]
  /** v3: the bookmark tree as a flat node list with its own schema version. */
  bookmarkTree?: BookmarkTreeData
  /** v1: the single window's bounds. */
  windowBounds?: Rect | null
  maximized?: boolean
  /** v2: every synced window. */
  windows?: PersistedWindow[]
  /** v3: recently closed tabs and windows (newest first, 25 deep). */
  recentlyClosed?: ClosedEntry[]
  /**
   * v3: the back/forward stack of every open tab, by tab id, so a restored tab has its history
   * and (through each entry's page state) its scroll position back. Refreshed on every commit
   * of a navigation and once more, for the page on screen, at a graceful shutdown. Never with a
   * stack's `hostState`: that blob lives in `navigation/<tabId>.json` (`NavigationStateStore`).
   */
  navigation?: Record<string, NavigationSnapshot>
  /**
   * The clean-exit marker: false from the first write of a run, true only in the write a
   * graceful shutdown makes. A profile that starts with it false was left by a crash, a kill or
   * a power cut; the chrome then offers the pages instead of loading them (`crashRestore`).
   */
  cleanExit?: boolean
  /** v4 only: the desktop's "My shortcuts" of the new tab page (local to this device). */
  newTabShortcuts?: NewTabShortcut[]
  /** v4 only: hosts removed from the new tab page's "Most visited" grid (local to this device). */
  newTabHiddenHosts?: string[]
  /**
   * v5: the new tab page's device-local sets in one document – the user's shortcuts (the phone's
   * pins of v4's `settings.newTabPhone` among them) and the removed hosts. Never synced.
   */
  newTabDevice?: NewTabDeviceState
  /**
   * Private browsing's device-local choices (the shape of `newTabDevice`): the phone's "Lock
   * private tabs when you leave Zenium". Never synced; missing before the switch existed.
   */
  privateDevice?: PrivateDeviceState
  /**
   * The password manager's device-local state (the same shape): the last Password Checkup's
   * counts and time, which Safety Check reads while the vault is locked. Never synced; missing
   * before the summary existed.
   */
  passwordsDevice?: PasswordsDeviceState
}

/**
 * v5 folds the phone's `settings.newTabPhone` into `settings.newTab` and moves its pins and
 * removed hosts, with the desktop's two v4 lists, into `newTabDevice` (`shared/newTab.ts`).
 */
export const PERSISTED_VERSION = 5

export type StateListener = () => void

/** Feature state owned by other services but shown in the UI. */
export interface StateExtras {
  boosts: Boost[]
  zappingTabId: string | null
  liveFolders: Record<string, LiveFolderConfig>
  extensions: ExtensionInfo[]
  /** Extensions UI (W1-D): reconcile with the store PR on rebase. */
  extensionUpdates: ExtensionUpdateCheck
  sidePanel: SidePanelInfo | null
  mods: Mod[]
  sync: SyncStatus
  agents: AgentInfo[]
  agentServer: AgentServerStatus
  updates: UpdateStatus
  passwords: PasswordsStatus
  defaultBrowser: DefaultBrowserStatus
  blockedPopups: Record<string, BlockedPopup[]>
  permissionRules: PermissionRule[]
  permissionDefaults: Record<string, ContentDefault>
  lastSafetyCheck: SafetyCheckResult | null
  permissionPrompts: PermissionPrompt[]
  securityPrompts: SecurityPrompt[]
  pageDialogs: PageDialog[]
  screenCaptureRequests: ScreenCaptureRequest[]
  shareRequests: ShareRequest[]
  crashRestore: CrashRestoreOffer | null
  autofill: AutofillUIState
  blocking: BlockingStatus
  privacy: PrivacyStatus
  siteData: SiteDataStatus
  translate: TranslateUIState
  spellcheck: SpellcheckStatus
  readAloud: ReadAloudState | null
  import: ImportProgress | null
}

/** Translation state of a host without an engine (and before the service exists). */
export function emptyTranslateState(): TranslateUIState {
  return {
    available: false,
    preferences: {
      preferred: ['en'],
      alwaysTranslate: [],
      neverTranslate: [],
      neverTranslateSites: [],
      autoOffer: true
    },
    languages: [],
    installed: [],
    downloading: [],
    registryDate: '',
    modelLicense: '',
    tabs: {}
  }
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
  /**
   * The bookmark tree as a flat node list in display order (roots first, then each subtree
   * depth first). Always a valid tree: `ensureValid` runs it through `normalizeBookmarkNodes`.
   */
  bookmarks: BookmarkNode[] = createBookmarkRoots(0)
  /**
   * The downloads a window may show and their aggregate progress; provided by the Browser once the
   * download service exists (private windows see more than the rest).
   */
  downloadsFor: (win: ZenWindow) => {
    downloads: DownloadItem[]
    downloadsProgress: DownloadsProgress
  } = () => ({
    downloads: [],
    downloadsProgress: { received: 0, total: 0, indeterminate: false, active: 0 }
  })
  /** Newest first; the `SessionService` owns the list, this is where it persists. */
  recentlyClosed: ClosedEntry[] = []
  /**
   * What loading the profile changed under the user (a migration that moved settings): shown as
   * toasts once a window is ready, then forgotten. Never persisted.
   */
  readonly migrationNotices: string[] = []
  /** Back/forward stacks of the open tabs, by tab id (`TabManager` keeps them current). */
  readonly tabNavigation = new Map<string, NavigationSnapshot>()
  /** The stacks' host-state blobs, one document per tab, kept out of `state.json`. */
  readonly navigationState: NavigationStateStore
  /** The new tab page's custom background image; provided by the Browser (the host owns the file). */
  newTabBackgroundFor: () => UIState['newTabBackground'] = () => ({ image: false, canPick: false })
  /**
   * The new tab page's device-local sets: the user's shortcuts in grid order and the hosts
   * removed from the most-visited tiles. Replaced whole by the `NewTabService` (never mutated in
   * place), persisted with the profile, never synced.
   */
  newTabDevice: NewTabDeviceState = emptyNewTabDevice()
  /**
   * Private browsing's device-local choices, the same shape: the phone's "Lock private tabs when
   * you leave Zenium" switch (INC-05 / SET-17). Replaced whole, persisted with the profile,
   * never synced – Chrome's "Lock Incognito tabs" is per device too, as it names this device's
   * screen lock. The lock itself is the phone host's, in memory; the core keeps only the switch.
   */
  privateDevice: PrivateDeviceState = emptyPrivateDevice()
  /**
   * The password manager's device-local state, the same shape: the last Password Checkup's
   * counts and time (`PasswordsStatus.checkupSummary`, Safety Check's Passwords row), kept
   * outside the vault so a locked vault still tells what the last run found. Replaced whole by
   * the `PasswordService`, persisted with the profile, never synced (the counts are this
   * device's view of the vault; another device runs its own checkup).
   */
  passwordsDevice: PasswordsDeviceState = emptyPasswordsDevice()
  media: MediaState[] = []
  devtoolsOpenFor = new Set<string>()
  resources: ResourceSnapshot = emptyResourceSnapshot()
  /** Device facts from the host (Android reports them at boot and on configuration changes). */
  pageEnvironment: PageEnvironment = { ...DEFAULT_PAGE_ENVIRONMENT }
  /** The host's reading of the OS colour scheme (null: the renderer reads its media query). */
  systemDark: boolean | null = null
  windowBounds: Rect | null = null
  /** Windows to restore on startup (from the previous session). */
  restoredWindows: PersistedWindow[] = []
  /** Live windows, registered by the Browser so persistence can capture them. */
  liveWindows: () => ZenWindow[] = () => []
  /** Provided by the Browser once its feature services exist. */
  extras: (win: ZenWindow) => StateExtras = () => ({
    boosts: [],
    zappingTabId: null,
    liveFolders: {},
    extensions: [],
    extensionUpdates: { lastCheckedAt: null, checking: false },
    sidePanel: null,
    mods: [],
    sync: {
      enabled: false,
      folder: null,
      folderName: null,
      folderLost: false,
      deviceId: '',
      deviceName: '',
      scope: defaultScope(),
      lastSyncAt: null,
      lastError: null,
      syncing: false,
      devices: [],
      pendingMerge: false,
      remoteTabsVersion: 0
    },
    agents: [],
    agentServer: emptyAgentServerStatus(),
    updates: emptyUpdateStatus(this.version, {
      os: updateOsOf(this.platform),
      arch: 'universal',
      kind: 'dev'
    }),
    passwords: emptyPasswordsStatus(),
    defaultBrowser: { isDefault: null, prompt: null },
    blockedPopups: {},
    permissionRules: [],
    permissionDefaults: {},
    lastSafetyCheck: null,
    permissionPrompts: [],
    securityPrompts: [],
    pageDialogs: [],
    screenCaptureRequests: [],
    shareRequests: [],
    crashRestore: null,
    autofill: emptyAutofillUIState(),
    blocking: emptyBlockingStatus(),
    privacy: emptyPrivacyStatus(),
    siteData: emptySiteDataStatus(),
    translate: emptyTranslateState(),
    spellcheck: UNAVAILABLE_SPELLCHECK,
    readAloud: null,
    import: null
  })
  /**
   * The shipped engines plus the installed extensions' (`chrome_settings_overrides`) plus the
   * user's (`settings.searchEngines`: added by hand or discovered through OpenSearch, synced with
   * the settings), rebuilt when either list changes.
   */
  get searchEngines(): SearchEngine[] {
    const user = this.settings.searchEngines
    const extension = this.extensionSearch.engines
    if (
      !this.enginesCache ||
      this.enginesCache.user !== user ||
      this.enginesCache.extension !== extension
    ) {
      this.enginesCache = { user, extension, list: allSearchEngines(user, extension) }
    }
    return this.enginesCache.list
  }
  private enginesCache: {
    user: SearchEngine[] | undefined
    extension: SearchEngine[]
    list: SearchEngine[]
  } | null = null

  /**
   * What the installed extensions declare (`chrome_settings_overrides.search_provider`): their
   * engines, and the one holding the default if any. Set by the extension host on load and
   * unload; never persisted here, the extension is the record.
   */
  private extensionSearch: { engines: SearchEngine[]; control: SearchEngineControl | null } = {
    engines: [],
    control: null
  }

  setExtensionSearch(engines: SearchEngine[], control: SearchEngineControl | null): void {
    this.extensionSearch = { engines, control }
    this.commit()
  }

  get searchEngineControl(): SearchEngineControl | null {
    return this.extensionSearch.control
  }

  /**
   * The engine a search goes to: the extension-controlled one while an extension holds the
   * default, else the user's pick, else the first (`defaultSearchEngineOf`).
   */
  defaultSearchEngine(): SearchEngine {
    return defaultSearchEngineOf(
      this.searchEngines,
      this.settings.searchEngineId,
      this.extensionSearch.control
    )
  }
  readonly version: string

  private readonly store: JsonStore<Persisted>
  private readonly listeners = new Set<StateListener>()
  private scheduled = false
  /** A persistent commit is waiting for the scheduled tick. */
  private dirty = false
  /** Callbacks waiting for the scheduled broadcast to have gone out. */
  private afterBroadcastQueue: Array<() => void> = []
  private shortcutsCache: { preset: ShortcutPreset; table: Shortcut[] } | null = null
  /** The last set of synced windows written to disk (used once they are all closed). */
  private lastWindows: PersistedWindow[] = []
  /** After shutdown nothing may be written any more (windows closing would shrink the list). */
  private frozen = false
  /** The run is ending gracefully: what is written from now on carries the clean-exit marker. */
  private exiting = false
  /** The previous run did not end with a graceful shutdown (its profile lacks the marker). */
  uncleanExit = false

  constructor(
    io: StoreIO,
    readonly platform: Platform,
    readonly capabilities: HostCapabilities,
    version: string
  ) {
    this.version = version
    this.store = new JsonStore<Persisted>(io, 'state.json', { backup: true })
    this.navigationState = new NavigationStateStore(io, (tabId) => this.navigationFor(tabId))
    this.model = emptyModel(structuredClone(DEFAULT_CONTAINERS))
  }

  /** Load the profile from disk (or create the first-run defaults). */
  load(): void {
    const data = this.store.readSync()
    if (data && [1, 2, 3, 4, 5].includes(data.version)) {
      this.applyPersisted(data)
      // Profiles from before the marker count as clean; only an explicit false is a crash.
      this.uncleanExit = data.cleanExit === false
    }
    this.ensureValid()
    // The blobs' folder hears which ids the session refers to; the documents of the others go at
    // the store's first fire (nothing is read here).
    this.navigationState.load(
      new Set([...this.tabNavigation.keys(), ...closedTabIds(this.recentlyClosed)])
    )
  }

  /**
   * What `navigation/<tabId>.json` is to hold: the open tab's stack (a private tab's never),
   * else the stack a recently-closed entry keeps for the id, else nothing.
   */
  private navigationFor(tabId: string): NavigationSnapshot | null {
    const tab = this.model.tabs[tabId]
    if (tab) {
      if (tab.containerId === PRIVATE_CONTAINER_ID) return null
      return this.tabNavigation.get(tabId) ?? null
    }
    return closedNavigationOf(this.recentlyClosed, tabId)
  }

  /** The app is shutting down gracefully: the next write marks the profile as cleanly exited. */
  markExiting(): void {
    this.exiting = true
  }

  /**
   * v3 stores the tree; v1/v2 stored a flat list that becomes the platform's default folder
   * ("Other bookmarks", "Mobile bookmarks" on Android) in the same order with its dates kept.
   * Both paths end in `normalizeBookmarkNodes`, so loading the result again changes nothing.
   */
  private loadBookmarks(data: Persisted): BookmarkNode[] {
    const now = Date.now()
    const fallback = defaultBookmarkFolderId(this.platform)
    const tree = data.bookmarkTree
    if (tree && typeof tree === 'object' && Array.isArray(tree.nodes)) {
      return normalizeBookmarkNodes(tree.nodes, now, fallback)
    }
    if (Array.isArray(data.bookmarks)) return migrateLegacyBookmarks(data.bookmarks, fallback, now)
    return createBookmarkRoots(now)
  }

  private applyPersisted(data: Persisted): void {
    // Before v3 the recently closed list was in memory only: it starts empty.
    this.recentlyClosed = data.version >= 3 ? sanitizeClosedEntries(data.recentlyClosed) : []
    this.tabNavigation.clear()
    if (data.navigation && typeof data.navigation === 'object') {
      for (const [tabId, raw] of Object.entries(data.navigation)) {
        const snapshot = sanitizeSnapshot(raw)
        if (snapshot) this.tabNavigation.set(tabId, snapshot)
      }
    }
    // The phone's frozen key of 0.3.x profiles (`settings.newTabPhone`) is folded into `newTab`
    // below and kept nowhere else: it must not ride along into the settings (or a sync record).
    const { newTabPhone, ...persistedSettings } = (data.settings ?? {}) as Settings & {
      newTabPhone?: unknown
    }
    this.settings = { ...structuredClone(DEFAULT_SETTINGS), ...persistedSettings }
    this.settings.compactMode = { ...DEFAULT_SETTINGS.compactMode, ...data.settings?.compactMode }
    // Compact mode's "persistent sidebar" toggle is transient by design.
    this.settings.compactMode.sidebarPersistent = false
    this.settings.appIcon = sanitizeAppIcon(data.settings?.appIcon)
    this.settings.resources = sanitizeResourceSettings(data.settings?.resources)
    this.settings.agents = sanitizeAgentSettings(data.settings?.agents)
    this.settings.updates = sanitizeUpdateSettings(data.settings?.updates)
    this.settings.phoneBar = sanitizePhoneBar(data.settings?.phoneBar)
    this.settings.passwords = sanitizePasswordSettings(data.settings?.passwords)
    this.settings.autofill = sanitizeAutofillSettings(data.settings?.autofill)
    this.settings.defaultBrowserPromo = sanitizePromoState(data.settings?.defaultBrowserPromo)
    this.settings.blocking = sanitizeBlockingSettings(data.settings?.blocking)
    this.settings.pageControls = sanitizePageControls(data.settings?.pageControls)
    // Off only when the profile says so: an older profile, or anything but a boolean, reads on.
    this.settings.splitEdgeZones = data.settings?.splitEdgeZones !== false
    if (!BOOKMARKS_BAR_MODES.includes(this.settings.bookmarksBar)) {
      this.settings.bookmarksBar = DEFAULT_SETTINGS.bookmarksBar
    }
    this.settings.mutedHosts = Array.isArray(this.settings.mutedHosts)
      ? this.settings.mutedHosts.filter((h): h is string => typeof h === 'string' && h !== '')
      : []
    // The user's engines (Settings > Search, OpenSearch discovery); the default among them is
    // never dropped by the caps. `repair()` below falls the default back if its engine is gone.
    this.settings.searchEngines = sanitizeSearchEngines(
      data.settings?.searchEngines,
      typeof data.settings?.searchEngineId === 'string' ? data.settings.searchEngineId : undefined
    )
    this.settings.privacy = sanitizePrivacySettings(data.settings?.privacy)
    this.settings.spellcheck = sanitizeSpellcheck(data.settings?.spellcheck)
    this.settings.reader = sanitizeReaderPreferences(data.settings?.reader)
    this.settings.readAloud = sanitizeReadAloudSettings(data.settings?.readAloud)
    // The new tab page's one model (v5). The migration reads the desktop's first shape and the
    // phone's key, and runs before the sanitiser, which knows nothing of the earlier fields; it
    // reads its own result unchanged, so a migrated profile loads as it was written.
    this.settings.newTab = sanitizeNewTabSettings(
      migrateNewTabSettings({ newTab: data.settings?.newTab, newTabPhone })
    )
    this.shortcutOverrides = data.shortcutOverrides ?? {}
    const preset = migrateShortcutPreset(data.settings?.shortcutPreset, this.shortcutOverrides)
    this.settings.shortcutPreset = preset.preset
    // Shortcuts matter where there is a keyboard; a phone is not told about them.
    if (preset.notice && this.platform !== 'android') this.migrationNotices.push(preset.notice)
    this.bookmarks = this.loadBookmarks(data)
    // v5's one document, or v4's two lists and the phone key's pins and removed hosts (before v4
    // the page did not exist: every source is missing and the sets start empty).
    this.newTabDevice = migrateNewTabDevice({
      newTabDevice: data.newTabDevice,
      newTabShortcuts: data.newTabShortcuts,
      newTabHiddenHosts: data.newTabHiddenHosts,
      newTabPhone
    })
    this.privateDevice = sanitizePrivateDevice(data.privateDevice)
    this.passwordsDevice = sanitizePasswordsDevice(data.passwordsDevice)
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
        // A chrome page (Settings) holds no page to unload: it never reads as pending.
        discarded: !isChromePageUrl(typeof raw.url === 'string' ? raw.url : ''),
        // Opener relationships are a session's own (Chrome forgets them too).
        openerTabId: null
      })
      tab.splitGroupId = raw.splitGroupId ?? null
      tab.loading = false
      tab.waiting = false
      tab.progress = 0
      tab.audible = false
      // Live capture is a session's own: a restored page holds no camera until it asks again.
      tab.alert = null
      tab.errorCode = null
      // A chrome page tab restored inside a section has the landing beneath it (PageService).
      if (isChromePageUrl(tab.url)) tab.canGoBack = parseInternalPageUrl(tab.url)?.section != null
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

  /**
   * "Restore previous session" is off: the open tabs of the last session are forgotten (pinned
   * tabs and Essentials are part of the sidebar's structure and stay) and one window comes back
   * with a fresh tab instead of its selection.
   */
  forgetSession(): void {
    const m = this.model
    for (const space of m.spaces) {
      for (const id of space.tabIds) {
        const tab = m.tabs[id]
        if (tab && !tab.pinned && !tab.essential) delete m.tabs[id]
      }
      space.tabIds = space.tabIds.filter((id) => m.tabs[id])
      space.activeTabId = null
    }
    this.restoredWindows = this.restoredWindows.slice(0, 1).map((w) => ({ ...w, selection: {} }))
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
    // The tree is repaired as a whole (sync applies nodes one by one and repairs once here).
    this.bookmarks = normalizeBookmarkNodes(
      this.bookmarks,
      Date.now(),
      defaultBookmarkFolderId(this.platform)
    )
    const bookmarkTree = new BookmarkTree(this.bookmarks)
    for (const tab of Object.values(m.tabs)) tab.bookmarked = bookmarkTree.hasUrl(tab.url)
    if (!isPickableSearchEngine(this.searchEngines, this.settings.searchEngineId)) {
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

  /** The active preset (a value another device synced that this build does not know falls back to Chrome). */
  get shortcutPreset(): ShortcutPreset {
    const preset = this.settings.shortcutPreset
    return isShortcutPreset(preset) ? preset : 'chrome'
  }

  /** The active table: the preset's defaults under the user's overrides; rebuilt when either changes. */
  get shortcuts(): Shortcut[] {
    const preset = this.shortcutPreset
    if (!this.shortcutsCache || this.shortcutsCache.preset !== preset) {
      this.shortcutsCache = {
        preset,
        table: applyShortcutOverrides(
          defaultShortcuts(this.platform, preset),
          this.shortcutOverrides
        )
      }
    }
    return this.shortcutsCache.table
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
      systemDark: this.systemDark,
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
      searchEngineControl: this.extensionSearch.control,
      glance: win.glance,
      compactSidebarRevealed: win.compactSidebarRevealed,
      window: win.windowState(),
      ...this.downloadsFor(win),
      bookmarks: this.bookmarks,
      newTabShortcuts: this.newTabDevice.shortcuts,
      newTabHiddenHosts: this.newTabDevice.hiddenHosts,
      privateLockOnLeave: this.privateDevice.lockOnLeave,
      newTabBackground: this.newTabBackgroundFor(),
      recentlyClosedCount: this.recentlyClosed.length,
      recentlyClosed: this.recentlyClosed.slice(0, 10).map(summarizeClosed),
      media: this.media,
      findResult: win.findResult,
      devtoolsOpenFor: [...this.devtoolsOpenFor],
      foreignTabIds: win.foreignTabIds(),
      windowCount: this.liveWindows().length,
      ...this.extras(win),
      resources: this.resources,
      pageEnvironment: this.pageEnvironment
    }
  }

  /** Broadcast + persist, coalesced to once per tick. */
  commit(): void {
    this.dirty = true
    this.schedule()
  }

  /**
   * Run `fn` once the broadcast a pending commit scheduled has gone out, or right away when
   * nothing is pending. Events that name a freshly created record go through here so the window
   * holds the record before it hears about it (the broadcast is deferred, a plain `emit` is not).
   */
  afterBroadcast(fn: () => void): void {
    if (this.scheduled) this.afterBroadcastQueue.push(fn)
    else fn()
  }

  /**
   * One deferred broadcast per tick, whichever kind of commit asked first. A volatile commit that
   * gets in ahead of a persistent one in the same tick must not swallow the disk write.
   */
  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    defer(() => {
      this.scheduled = false
      const persist = this.dirty
      this.dirty = false
      for (const listener of this.listeners) listener()
      if (persist && !this.frozen) this.store.write(this.toPersisted())
      const queued = this.afterBroadcastQueue
      this.afterBroadcastQueue = []
      for (const fn of queued) fn()
    })
  }

  /** Stop persisting (called once the final state has been flushed on quit). */
  freeze(): void {
    this.frozen = true
    this.navigationState.freeze()
  }

  /** Update only volatile UI state (no disk write). */
  commitVolatile(): void {
    this.schedule()
  }

  private toPersisted(): Persisted {
    const m = this.model
    const windows = this.liveWindows().filter((w) => w.kind === 'synced')
    if (windows.length > 0) this.lastWindows = windows.map((w) => w.toPersisted())
    const persistedWindows: PersistedWindow[] =
      this.lastWindows.length > 0 ? this.lastWindows : this.restoredWindows
    // Glance tabs, tabs of blank / private windows and private tabs are transient – never
    // persist them.
    const transient = new Set<string>()
    for (const w of this.liveWindows()) if (w.glance) transient.add(w.glance.tabId)
    return {
      version: PERSISTED_VERSION,
      spaces: m.spaces,
      tabs: Object.values(m.tabs)
        .filter(
          (t) =>
            !transient.has(t.id) &&
            !(t.spaceId && m.localSpaces[t.spaceId]) &&
            t.containerId !== PRIVATE_CONTAINER_ID
        )
        .map((t) => ({
          ...t,
          loading: false,
          waiting: false,
          progress: 0,
          audible: false,
          alert: null,
          errorCode: null,
          // A certificate proceeded past is a decision of the session, not of the tab.
          certificateError: null,
          blockedCount: 0,
          // Restored by us, not sent by an app that is long gone (Chrome: FROM_RESTORE).
          fromIntent: false,
          // The page posts its manifest again on the next load; the document stays compact.
          webApp: null,
          url: t.url.startsWith('zen://error') ? (safeOriginalUrl(t.url) ?? BLANK_URL) : t.url
        })),
      essentialTabIds: m.essentialTabIds,
      activeSpaceId: m.activeSpaceId,
      containers: m.containers,
      folders: Object.values(m.folders),
      splitGroups: Object.values(m.splitGroups).filter((g) => !m.localSpaces[g.spaceId]),
      settings: this.settings,
      shortcutOverrides: this.shortcutOverrides,
      bookmarkTree: { schemaVersion: BOOKMARK_SCHEMA_VERSION, nodes: this.bookmarks },
      windows: persistedWindows,
      // The stacks travel without their host-state blobs, which `navigation/` holds.
      recentlyClosed: withoutClosedHostState(this.recentlyClosed),
      navigation: this.persistedNavigation(m.tabs),
      cleanExit: this.exiting,
      newTabDevice: this.newTabDevice,
      privateDevice: this.privateDevice,
      passwordsDevice: this.passwordsDevice
    }
  }

  /** The stacks of the tabs being written (a stack whose tab is gone goes with it). */
  private persistedNavigation(tabs: Record<string, Tab>): Record<string, NavigationSnapshot> {
    const out: Record<string, NavigationSnapshot> = {}
    for (const [tabId, snapshot] of this.tabNavigation) {
      const tab = tabs[tabId]
      if (!tab || tab.containerId === PRIVATE_CONTAINER_ID) {
        this.tabNavigation.delete(tabId)
        // Its document follows: a closed entry holding the id keeps it, else it goes.
        this.navigationState.touch(tabId)
        continue
      }
      out[tabId] = withoutHostState(snapshot)
    }
    return out
  }

  async flush(): Promise<void> {
    if (this.frozen) return
    this.store.write(this.toPersisted())
    await this.store.flush()
    await this.navigationState.flush()
  }

  flushSync(): void {
    if (this.frozen) return
    this.store.write(this.toPersisted())
    this.store.flushSync()
    this.navigationState.flushSync()
  }
}

function safeOriginalUrl(errorUrl: string): string | null {
  try {
    return new URL(errorUrl).searchParams.get('url')
  } catch {
    return null
  }
}
