/**
 * Types shared between the main process, the preload script and the renderer.
 * Everything here must be JSON-serialisable (it crosses the IPC boundary).
 */

export type Platform = 'linux' | 'win32' | 'darwin' | 'android'

/**
 * What the host can do for the chrome. The renderer adapts its UI to these rather than to the
 * platform name (e.g. a DeX desktop session is still `android`, but has a mouse and keyboard).
 */
export interface HostCapabilities {
  /** Host draws its own window frame – no minimise / maximise / close buttons in the chrome. */
  windowControls: boolean
  /** Context menus are native popups; when false the renderer renders `menu.show` events. */
  nativeMenus: boolean
  /** The chrome can be dragged by `-webkit-app-region: drag` regions. */
  windowDrag: boolean
  /** Developer tools can be opened for pages. */
  devtools: boolean
  /** Compact-mode edge reveal works (the host tracks the pointer). */
  compactReveal: boolean
  /** Pages can be opened in Picture-in-Picture. */
  pictureInPicture: boolean
  /** The host can show a `view-source:` document. */
  viewSource: boolean
  /** More than one window can be open (new / blank / private windows). */
  windows: boolean
  /** Chromium extensions can be installed. */
  extensions: boolean
  /** The resource governor (budgets, freezing, process profile) runs on this host. */
  resourceGovernor: boolean
  /** Cross-device sync through a shared folder is available. */
  sync: boolean
  /** Pages can be printed. */
  print: boolean
  /** The host can run the MCP server that lets AI agents control the browser. */
  agents: boolean
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

// ---------------------------------------------------------------------------
// Containers (Firefox "Multi-Account Containers" → Chromium session partitions)
// ---------------------------------------------------------------------------

export type ContainerColor =
  'blue' | 'turquoise' | 'green' | 'yellow' | 'orange' | 'red' | 'pink' | 'purple' | 'toolbar'

export type ContainerIcon =
  | 'fingerprint'
  | 'briefcase'
  | 'dollar'
  | 'cart'
  | 'circle'
  | 'gift'
  | 'vacation'
  | 'food'
  | 'fruit'
  | 'pet'
  | 'tree'
  | 'chill'
  | 'fence'

export interface Container {
  id: string
  name: string
  color: ContainerColor
  icon: ContainerIcon
}

/** Id used for tabs that are not in any container ("No Container"). */
export const DEFAULT_CONTAINER_ID = 'default'
/** Pseudo container backing private windows: an in-memory session that is wiped when the last private window closes. */
export const PRIVATE_CONTAINER_ID = 'private'

// ---------------------------------------------------------------------------
// Windows (Zen's window sync)
// ---------------------------------------------------------------------------

/**
 * `synced` windows mirror the shared tabs/spaces (Zen's window sync). `unsynced` ("blank")
 * windows and `private` windows own a temporary tab list that is never restored.
 */
export type WindowKind = 'synced' | 'unsynced' | 'private'
/** Which tabs new synced windows share: everything, pinned/essential only, or nothing. */
export type WindowSyncMode = 'all' | 'pinned' | 'off'

// ---------------------------------------------------------------------------
// Themes (Zen's gradient theme picker)
// ---------------------------------------------------------------------------

export type ThemeAlgorithm =
  'floating' | 'complementary' | 'analogous' | 'splitComplementary' | 'triadic'

export interface ThemeColor {
  /** sRGB channels 0..255 */
  c: [number, number, number]
  /** Position inside the colour wheel, normalised 0..1 on both axes. */
  x: number
  y: number
  isPrimary?: boolean
}

export interface SpaceTheme {
  type: 'gradient'
  colors: ThemeColor[]
  /** 0..1 – how strongly the gradient tints the browser background. */
  opacity: number
  /** 0..1 – grain/noise texture intensity. */
  texture: number
  algorithm: ThemeAlgorithm
  monochrome: boolean
  /** Gradient rotation in degrees. */
  rotation: number
}

// ---------------------------------------------------------------------------
// Tabs, spaces, split views, folders
// ---------------------------------------------------------------------------

export interface Tab {
  id: string
  /** Space the tab belongs to. Essentials are global (per container) and have `spaceId: null`. */
  spaceId: string | null
  containerId: string
  url: string
  title: string
  favicon: string | null
  pinned: boolean
  essential: boolean
  /** URL a pinned/essential tab was pinned with ("reset pinned tab" restores this). */
  pinnedUrl: string | null
  /** User-provided title (rename). */
  customTitle: string | null
  /** User-picked emoji shown instead of the favicon ("Change Icon…"). */
  customIcon: string | null
  /**
   * Window the tab is local to. `null` for tabs shared by every synced window; set for tabs of
   * blank/private windows and, with "sync only pinned tabs", for unpinned tabs.
   */
  windowId: string | null
  folderId: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  audible: boolean
  muted: boolean
  /** True when the tab has no live WebContents (Zen calls these "pending"/unloaded tabs). */
  discarded: boolean
  /** Page lifecycle frozen by the resource governor (no timers, no script) – Chromium tab freezing. */
  frozen: boolean
  /** CPU throttling factor the governor applied to the renderer (1 = none, 4 = four times slower). */
  cpuThrottle: number
  zoom: number
  splitGroupId: string | null
  createdAt: number
  lastActiveAt: number
  /** Set when a navigation failed – rendered by the zen://error page. */
  errorCode: number | null
  /** Whether the current URL is bookmarked (denormalised for the UI). */
  bookmarked: boolean
  /** The page looks like an article Reader View can render (Firefox's "reader mode" icon). */
  readerable: boolean
}

export interface Folder {
  id: string
  spaceId: string
  name: string
  icon: string
  collapsed: boolean
}

export interface Space {
  id: string
  name: string
  /** Emoji (or empty string for the default monochrome icon). */
  icon: string
  containerId: string
  theme: SpaceTheme | null
  /** Ordered tab ids (pinned tabs always precede regular tabs). */
  tabIds: string[]
  /** Most recently selected tab in this space (each window keeps its own selection on top). */
  activeTabId: string | null
  pinnedCollapsed: boolean
  /** Set for the private space of a blank / private window (never persisted). */
  windowId?: string
}

export type SplitLayout = 'grid' | 'vertical' | 'horizontal'

export interface SplitGroup {
  id: string
  spaceId: string
  tabIds: string[]
  layout: SplitLayout
  /** Normalised sizes (fractions summing to 1) for the panes – one per tab. */
  sizes: number[]
}

// ---------------------------------------------------------------------------
// Boosts (Zen 1.20): per-site look customisation
// ---------------------------------------------------------------------------

export interface Boost {
  /** Registrable domain the boost applies to (e.g. `github.com`). */
  domain: string
  enabled: boolean
  /** Hex colour tinted over the page, `null` for none. */
  tint: string | null
  /** 0..1 strength of the tint. */
  tintIntensity: number
  /** Font family override, `null` keeps the site's fonts. */
  font: string | null
  /** Root font size in percent (100 = site default). */
  fontSize: number
  /** Force a dark rendering of light-only sites. */
  darkMode: boolean
  /** CSS selectors hidden with "Zap element". */
  zapped: string[]
  /** Additional user CSS for the site. */
  css: string
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Live Folders (Zen 1.19): folders filled from GitHub / RSS / REST sources
// ---------------------------------------------------------------------------

export type LiveFolderProvider = 'github-pulls' | 'github-issues' | 'rss' | 'rest'

export interface LiveFolderMapping {
  /** Dot path to the array of items (empty = the response itself). */
  items: string
  id: string
  title: string
  url: string
}

export interface LiveFolderConfig {
  folderId: string
  provider: LiveFolderProvider
  /** GitHub: username (or a full search query); RSS: feed URL; REST: endpoint URL. */
  source: string
  /** GitHub: include draft pull requests (Zen 1.21.11 lets you filter them out). */
  includeDrafts: boolean
  /** GitHub: optional personal access token (private repositories, higher rate limits). */
  token: string
  /** REST: how to read items out of the JSON response. */
  mapping: LiveFolderMapping | null
  intervalMinutes: number
  maxItems: number
  lastFetched: number | null
  lastError: string | null
  /** Item ids the user closed or ungrouped – they never come back. */
  dismissed: string[]
  /** Item id → tab id currently representing it. */
  items: Record<string, string>
}

// ---------------------------------------------------------------------------
// Extensions (unpacked Chrome extensions) and Mods (custom chrome CSS)
// ---------------------------------------------------------------------------

export interface ExtensionInfo {
  id: string
  name: string
  version: string
  description: string
  path: string
  enabled: boolean
  /** Data URL of the largest icon, when the manifest declares one. */
  icon: string | null
  /** `action.default_popup` (or the MV2 `browser_action` equivalent) if present. */
  popup: string | null
  /** Set when the extension could not be loaded (unsupported manifest, missing files…). */
  error: string | null
}

export interface Mod {
  id: string
  name: string
  /** Where the CSS was imported from (URL or file path) – informational. */
  source: string | null
  css: string
  enabled: boolean
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Cross-device sync (Zen 1.22: "Sync your Spaces across devices")
// ---------------------------------------------------------------------------

/** What gets synced; mirrors Zen's Sync engines. */
export interface SyncScope {
  spaces: boolean
  folders: boolean
  pinnedTabs: boolean
  essentials: boolean
  /** Unpinned tabs too (they arrive unloaded on other devices). */
  openTabs: boolean
  containers: boolean
  bookmarks: boolean
  settings: boolean
  shortcuts: boolean
  boosts: boolean
}

export interface SyncStatus {
  /** Sync is configured (folder + key) and enabled. */
  enabled: boolean
  /** Folder every device writes its encrypted records to (any cloud-drive / Syncthing folder). */
  folder: string | null
  deviceId: string
  deviceName: string
  scope: SyncScope
  lastSyncAt: number | null
  lastError: string | null
  syncing: boolean
  /** Other devices seen in the sync folder. */
  devices: Array<{ id: string; name: string; lastSeen: number }>
  /** Set while the first sync waits for the user to confirm merging with existing cloud data. */
  pendingMerge: boolean
}

// ---------------------------------------------------------------------------
// History, bookmarks, downloads
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  url: string
  title: string
  visitCount: number
  lastVisit: number
  favicon: string | null
}

export interface Bookmark {
  id: string
  url: string
  title: string
  favicon: string | null
  createdAt: number
}

export type DownloadState = 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted'

export interface DownloadItem {
  id: string
  url: string
  filename: string
  savePath: string
  totalBytes: number
  receivedBytes: number
  state: DownloadState
  startedAt: number
  mimeType: string
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchEngine {
  id: string
  name: string
  /** `%s` is replaced with the encoded query. */
  searchUrl: string
  suggestUrl: string | null
  keyword: string
  /** Simple glyph shown in the URL bar. */
  glyph: string
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

export type ShortcutGroup =
  | 'zen-compact-mode'
  | 'zen-workspace'
  | 'zen-split-view'
  | 'zen-other'
  | 'windowAndTabManagement'
  | 'navigation'
  | 'searchAndFind'
  | 'pageOperations'
  | 'historyAndBookmarks'
  | 'mediaAndDisplay'
  | 'devTools'

export interface KeyBinding {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  /** Normalised key: single lowercase character or a KeyboardEvent.key name (e.g. `ArrowLeft`, `F5`, `Tab`). */
  key: string
}

export type ShortcutAction =
  | 'compact.toggle'
  | 'compact.toggleSidebar'
  | 'space.next'
  | 'space.prev'
  | 'space.switch1'
  | 'space.switch2'
  | 'space.switch3'
  | 'space.switch4'
  | 'space.switch5'
  | 'space.switch6'
  | 'space.switch7'
  | 'space.switch8'
  | 'space.switch9'
  | 'space.switch10'
  | 'space.closeUnpinned'
  | 'split.grid'
  | 'split.vertical'
  | 'split.horizontal'
  | 'split.unsplit'
  | 'split.newEmpty'
  | 'tab.copyUrl'
  | 'tab.copyUrlMarkdown'
  | 'tab.togglePin'
  | 'tab.resetPinned'
  | 'tab.duplicate'
  | 'sidebar.toggle'
  | 'glance.expand'
  | 'space.new'
  | 'tab.new'
  | 'tab.close'
  | 'tab.reopenClosed'
  | 'window.new'
  | 'window.newUnsynced'
  | 'window.newPrivate'
  | 'window.close'
  | 'app.quit'
  | 'tab.next'
  | 'tab.prev'
  | 'tab.select1'
  | 'tab.select2'
  | 'tab.select3'
  | 'tab.select4'
  | 'tab.select5'
  | 'tab.select6'
  | 'tab.select7'
  | 'tab.select8'
  | 'tab.selectLast'
  | 'tab.moveBackward'
  | 'tab.moveForward'
  | 'tab.moveToStart'
  | 'tab.moveToEnd'
  | 'nav.back'
  | 'nav.forward'
  | 'nav.reload'
  | 'nav.reloadSkipCache'
  | 'nav.home'
  | 'nav.stop'
  | 'urlbar.focus'
  | 'urlbar.search'
  | 'find.open'
  | 'find.next'
  | 'find.prev'
  | 'page.savePage'
  | 'page.print'
  | 'page.viewSource'
  | 'page.fullscreen'
  | 'page.readerMode'
  | 'page.pip'
  | 'page.screenshot'
  | 'page.toggleMute'
  | 'zoom.in'
  | 'zoom.out'
  | 'zoom.reset'
  | 'bookmark.add'
  | 'bookmark.sidebar'
  | 'bookmark.library'
  | 'history.sidebar'
  | 'downloads.open'
  | 'devtools.toggle'
  | 'devtools.inspector'
  | 'devtools.console'
  | 'devtools.browserConsole'
  | 'settings.open'
  | 'addons.open'
  | 'boost.new'

export interface Shortcut {
  /** Zen's shortcut id (e.g. `zen-compact-mode-toggle`, `key_newNavigatorTab`). */
  id: string
  action: ShortcutAction
  group: ShortcutGroup
  label: string
  /** Primary binding – `null` when unbound. */
  binding: KeyBinding | null
  /** Secondary built-in bindings that are not user editable (e.g. F5 for reload). */
  extraBindings: KeyBinding[]
  /** Actions this build cannot perform yet (kept so the list matches Zen 1:1). */
  unsupported?: boolean
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type ToolbarLayout = 'single' | 'multiple' | 'collapsed'
export type UrlbarBehavior = 'float-typing' | 'always-float' | 'normal'
export type GlanceTrigger = 'alt' | 'ctrl' | 'shift'
export type PinnedCloseBehavior =
  'reset-unload-switch' | 'reset-unload' | 'reset' | 'unload' | 'unload-switch' | 'switch' | 'close'
export type ThirdPartyPinnedBehavior = 'new-tab' | 'glance' | 'same-tab'
export type ColorScheme = 'system' | 'light' | 'dark'
export type SidebarSide = 'left' | 'right'
export type NewTabPosition = 'end' | 'after-current'

export interface CompactModeSettings {
  enabled: boolean
  hideSidebar: boolean
  hideToolbar: boolean
  /** Ctrl+Alt+S – keep the sidebar visible until toggled again. */
  sidebarPersistent: boolean
}

export interface Settings {
  colorScheme: ColorScheme
  toolbarLayout: ToolbarLayout
  sidebarSide: SidebarSide
  sidebarWidth: number
  /** Expanded (titles shown) vs collapsed (favicons only). */
  sidebarExpanded: boolean
  sidebarExpandOnHover: boolean
  /** Remove the browser padding / rounded content area. */
  borderless: boolean
  compactMode: CompactModeSettings
  urlbarBehavior: UrlbarBehavior
  glanceEnabled: boolean
  glanceTrigger: GlanceTrigger
  pinnedCloseBehavior: PinnedCloseBehavior
  pinnedResetOnStartup: boolean
  thirdPartyOnPinned: ThirdPartyPinnedBehavior
  unloadEnabled: boolean
  unloadTimeoutMinutes: number
  unloadExcludedDomains: string[]
  searchEngineId: string
  searchSuggestions: boolean
  containerSpecificEssentials: boolean
  essentialsMax: number
  newTabPosition: NewTabPosition
  restoreSession: boolean
  /** Firefox's "Always ask you where to save files"; off saves straight into the Downloads folder. */
  askWhereToSave: boolean
  onboardingDone: boolean
  showTabSeparator: boolean
  ctrlTabCyclesWithinSection: boolean
  spaceRouting: Record<string, string>
  /** Zen's window sync: mirror all tabs across windows, only pinned tabs, or keep windows independent. */
  windowSync: WindowSyncMode
  resources: ResourceSettings
  agents: AgentSettings
}

// ---------------------------------------------------------------------------
// AI agents (the built-in MCP server)
// ---------------------------------------------------------------------------

/**
 * How an agent works in the browser. In `foreground` its tab is brought to the front before every
 * action so the user watches it work; in `background` it drives its tabs without ever changing
 * what the user is looking at.
 */
export type AgentMode = 'foreground' | 'background'

export interface AgentSettings {
  /** Run the MCP server so AI agents can control the browser. */
  enabled: boolean
  /** TCP port of the Streamable HTTP endpoint (`http://127.0.0.1:<port>/mcp`). */
  port: number
  /** Also listen on the local network (lets an agent on another device drive this browser). */
  lan: boolean
  /** Ask before an unknown agent may connect; agents presenting the token are let in directly. */
  approveNewAgents: boolean
  /** Agent names the user has allowed (matched against the MCP client name). */
  approvedNames: string[]
  /** Mode agents start in. */
  defaultMode: AgentMode
  /** Allow `browser_evaluate` (arbitrary JavaScript in pages). */
  allowScripts: boolean
  /** Draw the agent's cursor and name tag in the pages it drives. */
  showCursor: boolean
}

/** One connected agent (an MCP session). */
export interface AgentInfo {
  id: string
  name: string
  version: string
  /** Accent colour used for its cursor and tab indicators. */
  color: string
  mode: AgentMode
  transport: 'http' | 'stdio'
  connectedAt: number
  lastActiveAt: number
  /** Tabs this agent drives (indicated in the sidebar). */
  tabIds: string[]
  /** The tab its page tools act on when no `tabId` is given. */
  currentTabId: string | null
  /** Waiting for the user to allow it. */
  pending: boolean
  /** Tool calls handled so far. */
  calls: number
}

export interface AgentServerStatus {
  running: boolean
  /** Loopback endpoint, e.g. `http://127.0.0.1:41735/mcp`. */
  url: string | null
  /** Endpoints reachable from other devices (only when `lan` is on). */
  lanUrls: string[]
  /** Bearer token that lets an agent skip the approval prompt. */
  token: string
  error: string | null
}

// ---------------------------------------------------------------------------
// Resource governor (memory / CPU / GPU budgets)
// ---------------------------------------------------------------------------

/**
 * How far the governor may go to stay under budget.
 * - `balanced`: only hidden tabs are purged, throttled, frozen or discarded.
 * - `strict`: hidden tabs as above; visible split panes may be throttled and purged, the active
 *   tab may be purged.
 * - `extreme`: everything in `strict`, plus the active tab is CPU-throttled under CPU pressure
 *   and reloaded when it alone keeps the browser over the memory budget.
 */
export type ResourceEnforcement = 'balanced' | 'strict' | 'extreme'

/**
 * GPU usage profile (restart required).
 * - `auto`: hardware acceleration as Chromium decides.
 * - `low`: hardware compositing stays on, GPU rasterization / video decode / 2D canvas go to CPU.
 * - `off`: hardware acceleration disabled entirely (software compositing).
 */
export type GpuMode = 'auto' | 'low' | 'off'

/** Chromium / V8 switches applied at startup; changing them needs a relaunch. */
export interface ResourceProcessProfile {
  /** Maximum number of renderer processes Chromium may keep alive (0 = Chromium default). */
  rendererProcessLimit: number
  /** V8 old-space heap cap per renderer in MB (0 = default); pages exceeding it are unloaded. */
  rendererHeapMb: number
  /** Chromium's low-end-device mode: smaller caches and tile budgets everywhere. */
  lowEndDeviceMode: boolean
  /** Do not keep a warm spare renderer process waiting for the next navigation. */
  disableSpareRenderer: boolean
  /** Do not keep previous documents alive in the back/forward cache. */
  disableBackForwardCache: boolean
  /** Do not let pages prerender other pages in hidden renderers. */
  disablePrerender: boolean
  /** Raster worker threads per renderer (0 = default). */
  rasterThreads: number
  /** V8: favour a small memory footprint over peak speed. */
  v8OptimizeForSize: boolean
}

export interface ResourceSettings {
  enabled: boolean
  enforcement: ResourceEnforcement
  /** Memory budget for the whole browser (every Chromium process) in MB; 0 = use `memoryPercent`. */
  memoryMb: number
  /** Percentage of installed RAM used as the memory budget when `memoryMb` is 0. */
  memoryPercent: number
  /** CPU budget as a percentage of the whole machine (all cores together = 100). */
  cpuPercent: number
  /** GPU process memory budget in MB (0 = unlimited). */
  gpuMemoryMb: number
  gpuMode: GpuMode
  /** Freeze hidden tabs this many minutes after they were last shown (0 = immediately). */
  freezeAfterMinutes: number
  /** Freeze every hidden tab once the system has been idle this long (minutes, 0 = off). */
  idleFreezeMinutes: number
  /** Hard cap on live pages (WebContents); 0 = unlimited. */
  maxLoadedTabs: number
  /** Background page loads allowed at the same time; the rest wait in a queue. */
  maxConcurrentLoads: number
  /** Budgets are multiplied by this factor while on battery power (0.25..1). */
  batteryFactor: number
  protectPinned: boolean
  protectEssentials: boolean
  protectAudible: boolean
  process: ResourceProcessProfile
}

export type ResourceKind = 'memory' | 'cpu' | 'gpu'

export interface ResourceGauge {
  /** Current usage: MB for memory / GPU, percent of the whole machine for CPU. */
  used: number
  /** Effective budget after battery tightening (0 = unlimited). */
  budget: number
  /** Budget as configured, before battery tightening (0 = unlimited). */
  configured: number
}

export interface TabResourceUsage {
  tabId: string
  memoryMb: number
  /** Percent of the whole machine. */
  cpuPercent: number
  /** OS processes attributed to the tab (main renderer plus out-of-process iframes). */
  processes: number
}

export type GovernorActionKind =
  | 'purge'
  | 'throttle'
  | 'unthrottle'
  | 'freeze'
  | 'thaw'
  | 'discard'
  | 'reload'
  | 'pause-media'
  | 'defer'

export interface GovernorAction {
  at: number
  kind: GovernorActionKind
  tabId: string | null
  /** Tab title at the time of the action (tabs may be gone by the time the UI renders it). */
  title: string
  reason: string
}

export interface ResourceSnapshot {
  /** 0 until the governor has taken its first sample. */
  sampledAt: number
  memory: ResourceGauge
  cpu: ResourceGauge
  gpu: ResourceGauge
  system: {
    totalMemoryMb: number
    cpuCount: number
    onBattery: boolean
    /** System idle long enough for the idle-freeze rule to apply. */
    idle: boolean
  }
  tabs: TabResourceUsage[]
  /** Memory (MB) of processes that are not attributable to a tab: browser, GPU, network, utility. */
  overheadMb: number
  loadedTabs: number
  frozenTabs: number
  throttledTabs: number
  /** Background loads waiting for a free slot. */
  queuedLoads: number
  pressure: ResourceKind[]
  recentActions: GovernorAction[]
  /** Startup switches derived from the current settings differ from the ones this process runs with. */
  restartRequired: boolean
}

// ---------------------------------------------------------------------------
// Glance, overlays, layout
// ---------------------------------------------------------------------------

export interface GlanceState {
  tabId: string
  parentTabId: string
  /** Where the click happened (content-area relative, normalised 0..1) – drives the open animation. */
  originX: number
  originY: number
}

export type OverlayKind =
  | 'none'
  | 'urlbar'
  | 'settings'
  | 'history'
  | 'bookmarks'
  | 'downloads'
  | 'theme'
  | 'onboarding'
  | 'shortcuts'
  | 'space-editor'
  | 'boosts'
  | 'addons'
  | 'live-folder'
  | 'sync'

export interface WindowState {
  id: string
  kind: WindowKind
  maximized: boolean
  fullscreen: boolean
  focused: boolean
  /** Tab id currently in HTML (element) fullscreen – its view covers the whole window. */
  htmlFullscreenTabId: string | null
}

export interface MediaState {
  tabId: string
  playing: boolean
}

// ---------------------------------------------------------------------------
// The full UI state snapshot broadcast to the renderer
// ---------------------------------------------------------------------------

export interface UIState {
  platform: Platform
  capabilities: HostCapabilities
  version: string
  tabs: Record<string, Tab>
  /** Ordered essential tab ids (all containers – the UI filters by container). */
  essentialTabIds: string[]
  spaces: Space[]
  activeSpaceId: string
  containers: Container[]
  folders: Record<string, Folder>
  splitGroups: Record<string, SplitGroup>
  settings: Settings
  shortcuts: Shortcut[]
  searchEngines: SearchEngine[]
  glance: GlanceState | null
  compactSidebarRevealed: boolean
  window: WindowState
  downloads: DownloadItem[]
  bookmarks: Bookmark[]
  recentlyClosedCount: number
  media: MediaState[]
  findResult: FindResult | null
  /** Tab id whose devtools are open (for the toolbar indicator). */
  devtoolsOpenFor: string[]
  resources: ResourceSnapshot
  /**
   * Visible tabs whose live page is currently shown in another window. Zen renders a dimmed
   * preview for them; focusing this window moves the page here.
   */
  foreignTabIds: string[]
  /** Number of open windows (Zen shows "Move to…" helpers only when it matters). */
  windowCount: number
  boosts: Boost[]
  /** Tab whose page is in "zap element" mode, if any. */
  zappingTabId: string | null
  liveFolders: Record<string, LiveFolderConfig>
  extensions: ExtensionInfo[]
  mods: Mod[]
  sync: SyncStatus
  /** Connected AI agents (MCP sessions) and the tabs they drive. */
  agents: AgentInfo[]
  agentServer: AgentServerStatus
}

export interface FindResult {
  tabId: string
  activeMatchOrdinal: number
  matches: number
}

// ---------------------------------------------------------------------------
// URL bar suggestions
// ---------------------------------------------------------------------------

export type SuggestionKind =
  'url' | 'search' | 'history' | 'bookmark' | 'tab' | 'space' | 'command' | 'engine'

export interface Suggestion {
  id: string
  kind: SuggestionKind
  title: string
  subtitle: string
  /** URL to navigate to (or search URL). */
  url: string | null
  favicon: string | null
  /** For kind = tab: the tab to switch to. For kind = space: the space id. For command: the action. */
  targetId: string | null
  /** Text to place in the input when the suggestion is highlighted (for inline completion). */
  fill: string
}

export interface CommandDescriptor {
  id: string
  label: string
  keywords: string[]
  action:
    | ShortcutAction
    | 'settings.open'
    | 'theme.open'
    | 'space.new'
    | 'history.open'
    | 'bookmarks.open'
    | 'downloads.open'
    | 'tab.freezeOthers'
    | 'tab.wakeAll'
    | 'resources.trim'
    | 'resources.open'
}

// ---------------------------------------------------------------------------
// Renderer-hosted menus (hosts without native popup menus)
// ---------------------------------------------------------------------------

export interface MenuItemDescriptor {
  id: string
  type: 'normal' | 'separator' | 'checkbox' | 'radio'
  label: string
  enabled: boolean
  checked: boolean
  submenu: MenuItemDescriptor[] | null
}

export interface MenuDescriptor {
  id: string
  items: MenuItemDescriptor[]
  source: 'page' | 'tab' | 'selection' | 'space' | 'folder' | 'newtab' | 'app'
  /** Anchor in chrome CSS pixels, when known. */
  x: number | null
  y: number | null
}

// ---------------------------------------------------------------------------
// Layout reports (renderer → main)
// ---------------------------------------------------------------------------

export interface ViewPlacement {
  tabId: string
  rect: Rect
  radius: number
}

export interface LayoutReport {
  placements: ViewPlacement[]
  glance: { tabId: string; rect: Rect; radius: number } | null
  /** When true no tab views should be visible (a chrome overlay covers the content area). */
  contentHidden: boolean
}

// ---------------------------------------------------------------------------
// IPC: commands (renderer → main) and events (main → renderer)
// ---------------------------------------------------------------------------

export type TabSection = 'essential' | 'pinned' | 'regular'

export interface Commands {
  'app.getState': { args: void; result: UIState }
  /** Real spaces (blank / private windows only see their own space in the snapshot). */
  'app.listSpaces': { args: void; result: Array<{ id: string; name: string; icon: string }> }
  'app.openExternal': { args: { url: string }; result: void }
  'app.quit': { args: void; result: void }

  'layout.report': { args: LayoutReport; result: void }

  'tab.create': {
    args: {
      url?: string
      spaceId?: string
      active?: boolean
      containerId?: string
      pinned?: boolean
      essential?: boolean
      afterTabId?: string
    }
    result: string
  }
  'tab.activate': { args: { tabId: string }; result: void }
  'tab.close': { args: { tabId: string; force?: boolean }; result: void }
  'tab.closeOthers': { args: { tabId: string }; result: void }
  'tab.closeBelow': { args: { tabId: string }; result: void }
  'tab.closeAbove': { args: { tabId: string }; result: void }
  'tab.navigate': { args: { tabId: string; input: string }; result: void }
  'tab.back': { args: { tabId: string }; result: void }
  'tab.forward': { args: { tabId: string }; result: void }
  'tab.reload': { args: { tabId: string; skipCache?: boolean }; result: void }
  'tab.stop': { args: { tabId: string }; result: void }
  'tab.toggleMute': { args: { tabId: string }; result: void }
  'tab.togglePin': { args: { tabId: string }; result: void }
  'tab.toggleEssential': { args: { tabId: string }; result: void }
  'tab.resetPinned': { args: { tabId: string }; result: void }
  'tab.editPinnedUrl': { args: { tabId: string; url: string }; result: void }
  'tab.rename': { args: { tabId: string; title: string | null }; result: void }
  'tab.duplicate': { args: { tabId: string }; result: void }
  'tab.unload': { args: { tabId: string }; result: void }
  'tab.freeze': { args: { tabId: string }; result: void }
  'tab.wake': { args: { tabId: string }; result: void }
  'tab.move': {
    args: { tabId: string; spaceId?: string; section: TabSection; index: number }
    result: void
  }
  'tab.moveToSpace': { args: { tabId: string; spaceId: string }; result: void }
  'tab.moveToFolder': { args: { tabId: string; folderId: string | null }; result: void }
  'tab.reopenClosed': { args: void; result: void }
  'tab.setZoom': { args: { tabId: string; delta: number | null }; result: void }
  'tab.contextMenu': { args: { tabId: string }; result: void }
  'tab.toggleDevtools': { args: { tabId: string }; result: void }
  'tab.copyUrl': { args: { tabId: string; markdown?: boolean }; result: void }
  'tab.setIcon': { args: { tabId: string; icon: string | null }; result: void }
  /** Zen's "Add Route for Domain": route the tab's domain to a space. */
  'tab.addRoute': { args: { tabId: string; spaceId: string }; result: void }
  /** Alt+click on a sidebar tab: split it with (or separate it from) the active tab. */
  'tab.altClick': { args: { tabId: string }; result: void }
  /** Context menu for several selected tabs (Ctrl / Shift+click in the sidebar). */
  'tab.selectionContextMenu': { args: { tabIds: string[] }; result: void }

  'space.create': {
    args: { name: string; icon: string; containerId: string; theme: SpaceTheme | null }
    result: string
  }
  'space.update': {
    args: {
      spaceId: string
      patch: Partial<Pick<Space, 'name' | 'icon' | 'containerId' | 'theme'>>
    }
    result: void
  }
  'space.delete': { args: { spaceId: string }; result: void }
  'space.activate': { args: { spaceId: string }; result: void }
  'space.next': { args: void; result: void }
  'space.prev': { args: void; result: void }
  'space.reorder': { args: { spaceId: string; index: number }; result: void }
  'space.unload': { args: { spaceId: string }; result: void }
  'space.unloadOthers': { args: void; result: void }
  'space.togglePinnedCollapsed': { args: { spaceId: string }; result: void }
  'space.closeUnpinned': { args: { spaceId?: string }; result: void }
  'space.contextMenu': { args: { spaceId: string }; result: void }

  'folder.create': { args: { spaceId: string; name: string; icon: string }; result: string }
  'folder.update': {
    args: { folderId: string; patch: Partial<Pick<Folder, 'name' | 'icon' | 'collapsed'>> }
    result: void
  }
  'folder.delete': { args: { folderId: string; unpack: boolean }; result: void }
  'folder.contextMenu': { args: { folderId: string }; result: void }
  'newtab.contextMenu': { args: void; result: void }
  'app.menu': { args: void; result: void }
  /** Renderer-hosted menus: an item was picked / the menu was dismissed. */
  'menu.click': { args: { menuId: string; itemId: string }; result: void }
  'menu.close': { args: { menuId: string }; result: void }
  /** Renderer → main: chrome UI closed, give keyboard focus back to the active page. */
  'focus.content': { args: void; result: void }
  /** Renderer → main: chrome UI opened, take keyboard focus. */
  'focus.chrome': { args: void; result: void }
  'media.toggle': { args: { tabId: string }; result: void }

  'split.create': { args: { tabIds: string[]; layout: SplitLayout }; result: void }
  'split.toggleLayout': { args: { layout: SplitLayout }; result: void }
  'split.setLayout': { args: { groupId: string; layout: SplitLayout }; result: void }
  'split.unsplit': { args: { groupId?: string; tabId?: string }; result: void }
  'split.removeTab': { args: { tabId: string; focus: boolean }; result: void }
  'split.resize': { args: { groupId: string; sizes: number[] }; result: void }
  'split.newEmpty': { args: void; result: void }
  'split.addTab': { args: { groupId: string; tabId: string }; result: void }

  'glance.open': {
    args: { url: string; parentTabId: string; originX: number; originY: number }
    result: void
  }
  'glance.close': { args: void; result: void }
  'glance.expand': { args: void; result: void }
  'glance.split': { args: void; result: void }

  'compact.toggle': { args: void; result: void }
  'compact.setRevealed': { args: { revealed: boolean }; result: void }
  'compact.toggleSidebarPersistent': { args: void; result: void }
  'compact.setOptions': {
    args: Partial<Pick<CompactModeSettings, 'hideSidebar' | 'hideToolbar'>>
    result: void
  }

  'urlbar.suggest': { args: { query: string; tabId: string | null }; result: Suggestion[] }
  'urlbar.submit': {
    args: {
      input: string
      newTab: boolean
      tabId: string | null
      /** Alt+Enter in Firefox → open in new tab; Shift+Enter → new window (ignored). */
      background?: boolean
    }
    result: void
  }
  'urlbar.runCommand': { args: { action: string }; result: void }

  'overlay.snapshot': { args: { tabId: string }; result: string | null }

  /** Take a fresh resource sample right now and return it. */
  'resources.snapshot': { args: void; result: ResourceSnapshot }
  /** Purge, freeze and discard as if every budget were exceeded ("free up memory now"). */
  'resources.trim': { args: void; result: void }
  /** Restart the browser so changed startup switches take effect. */
  'resources.relaunch': { args: void; result: void }

  'settings.update': { args: Partial<Settings>; result: void }
  'shortcuts.update': { args: { id: string; binding: KeyBinding | null }; result: void }
  'shortcuts.reset': { args: void; result: void }
  'sidebar.setWidth': { args: { width: number }; result: void }
  'sidebar.toggleExpanded': { args: void; result: void }

  'history.search': { args: { query: string; limit: number }; result: HistoryEntry[] }
  'history.recent': { args: { limit: number }; result: HistoryEntry[] }
  'history.delete': { args: { url: string }; result: void }
  'history.clear': { args: void; result: void }

  'bookmark.toggle': { args: { tabId: string }; result: void }
  'bookmark.remove': { args: { id: string }; result: void }
  'bookmark.add': { args: { url: string; title: string }; result: void }

  'download.pause': { args: { id: string }; result: void }
  'download.resume': { args: { id: string }; result: void }
  'download.cancel': { args: { id: string }; result: void }
  'download.showInFolder': { args: { id: string }; result: void }
  'download.open': { args: { id: string }; result: void }
  'download.remove': { args: { id: string }; result: void }
  'download.clearCompleted': { args: void; result: void }

  'find.start': {
    /** `newSession` starts a fresh search for `text`; otherwise steps to the next/previous match. */
    args: { tabId: string; text: string; forward: boolean; newSession: boolean }
    result: void
  }
  'find.stop': { args: { tabId: string; keepSelection: boolean }; result: void }

  'container.create': {
    args: { name: string; color: ContainerColor; icon: ContainerIcon }
    result: string
  }
  'container.update': {
    args: { id: string; patch: Partial<Pick<Container, 'name' | 'color' | 'icon'>> }
    result: void
  }
  'container.delete': { args: { id: string }; result: void }
  'container.reorder': { args: { id: string; index: number }; result: void }

  'window.minimize': { args: void; result: void }
  'window.toggleMaximize': { args: void; result: void }
  'window.close': { args: void; result: void }
  'window.toggleFullscreen': { args: void; result: void }
  /** Zen: a new synced window starts at the current space showing the same tabs. */
  'window.new': { args: void; result: void }
  /** Zen's "New blank window" (Ctrl+Shift+N): an independent, temporary tab list. */
  'window.newUnsynced': { args: void; result: void }
  'window.newPrivate': { args: void; result: void }
  /** Blank windows: move every local tab back into one of the real spaces. */
  'window.moveTabsToSpace': { args: { spaceId: string }; result: void }

  'page.screenshot': { args: { tabId: string }; result: void }
  'page.print': { args: { tabId: string }; result: void }
  'page.savePage': { args: { tabId: string }; result: void }
  'page.viewSource': { args: { tabId: string }; result: void }
  /** Page context menu requested from the chrome side (touch long-press forwarded by the host). */
  'page.contextMenu': {
    args: { tabId: string; linkURL: string; srcURL: string; x: number; y: number }
    result: void
  }

  'onboarding.complete': {
    args: { searchEngineId: string; colorScheme: ColorScheme; essentials: string[] }
    result: void
  }

  'boost.update': {
    args: { domain: string; patch: Partial<Omit<Boost, 'domain' | 'updatedAt'>> }
    result: void
  }
  'boost.remove': { args: { domain: string }; result: void }
  'boost.startZap': { args: { tabId: string }; result: void }
  'boost.stopZap': { args: { tabId: string }; result: void }

  'reader.toggle': { args: { tabId: string }; result: void }

  'liveFolder.save': {
    args: {
      /** Existing folder to convert, or `null` to create a new folder in the current space. */
      folderId: string | null
      name: string
      config: Pick<
        LiveFolderConfig,
        | 'provider'
        | 'source'
        | 'includeDrafts'
        | 'token'
        | 'mapping'
        | 'intervalMinutes'
        | 'maxItems'
      >
    }
    result: string
  }
  'liveFolder.refresh': { args: { folderId: string }; result: void }
  'liveFolder.remove': { args: { folderId: string }; result: void }

  'extension.add': { args: void; result: void }
  'extension.remove': { args: { id: string }; result: void }
  'extension.setEnabled': { args: { id: string; enabled: boolean }; result: void }
  'extension.openPopup': { args: { id: string; anchor: Rect }; result: void }
  'extension.closePopup': { args: void; result: void }

  'mod.add': { args: { name: string; css: string; source?: string }; result: string }
  'mod.update': {
    args: { id: string; patch: Partial<Pick<Mod, 'name' | 'css' | 'enabled'>> }
    result: void
  }
  'mod.remove': { args: { id: string }; result: void }
  'mod.importFile': { args: void; result: void }
  'mod.importUrl': { args: { url: string }; result: void }

  'sync.chooseFolder': { args: void; result: string | null }
  'sync.setup': {
    args: { folder: string; passphrase: string; deviceName: string; scope: SyncScope }
    result: void
  }
  'sync.setScope': { args: Partial<SyncScope>; result: void }
  'sync.setDeviceName': { args: { name: string }; result: void }
  'sync.now': { args: void; result: void }
  'sync.confirmMerge': { args: { merge: boolean }; result: void }
  'sync.disconnect': { args: { wipeRemote: boolean }; result: void }

  /** End an agent's session and release its tabs. */
  'agent.disconnect': { args: { id: string }; result: void }
  'agent.setMode': { args: { id: string; mode: AgentMode }; result: void }
  /** Take a tab back from the agent driving it. */
  'agent.releaseTab': { args: { tabId: string }; result: void }
  /** Forget a previously approved agent name. */
  'agent.forget': { args: { name: string }; result: void }
  /** Issue a new token (existing HTTP sessions stay valid until they end). */
  'agent.regenerateToken': { args: void; result: string }
}

export type CommandName = keyof Commands
export type CommandArgs<K extends CommandName> = Commands[K]['args']
export type CommandResult<K extends CommandName> = Commands[K]['result']

export type UrlbarOpenMode = 'new-tab' | 'edit' | 'search'

export interface Events {
  state: UIState
  'urlbar.toggle': { mode: UrlbarOpenMode; text?: string }
  'urlbar.close': void
  'overlay.open': { kind: OverlayKind; folderId?: string; section?: string }
  'find.open': { tabId: string; again?: 'next' | 'prev' }
  toast: { message: string; kind?: 'info' | 'error' }
  /** Link hover status text (Firefox shows this in the bottom corner). */
  status: { text: string }
  'sidebar.toggle': void
  'compact.reveal': { revealed: boolean }
  'theme.open': { spaceId: string }
  'space.new': void
  'tab.startRename': { tabId: string }
  'folder.startRename': { folderId: string }
  /** Open the pinned-URL editor for a pinned/essential tab. */
  'tab.editPinnedUrl': { tabId: string }
  /** Open the emoji/icon picker for a tab. */
  'tab.pickIcon': { tabId: string }
  'space.edit': { spaceId: string }
  'space.switched': { fromIndex: number; toIndex: number }
  /** Hosts without native menus ask the renderer to show one. */
  'menu.show': MenuDescriptor
  'menu.hide': { menuId: string }
  /** Safe-area insets of the host window in CSS pixels (mobile status bar, IME, cutouts). */
  insets: { top: number; right: number; bottom: number; left: number }
}

export type EventName = keyof Events

// ---------------------------------------------------------------------------
// Recently closed tabs (kept in main only, count exposed to UI)
// ---------------------------------------------------------------------------

export interface ClosedTab {
  tab: Tab
  spaceId: string | null
  index: number
  closedAt: number
}
