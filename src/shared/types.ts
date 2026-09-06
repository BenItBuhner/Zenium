/**
 * Types shared between the main process, the preload script and the renderer.
 * Everything here must be JSON-serialisable (it crosses the IPC boundary).
 */

export type Platform = 'linux' | 'win32' | 'darwin'

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
  folderId: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  audible: boolean
  muted: boolean
  /** True when the tab has no live WebContents (Zen calls these "pending"/unloaded tabs). */
  discarded: boolean
  zoom: number
  splitGroupId: string | null
  createdAt: number
  lastActiveAt: number
  /** Set when a navigation failed – rendered by the zen://error page. */
  errorCode: number | null
  /** Whether the current URL is bookmarked (denormalised for the UI). */
  bookmarked: boolean
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
  activeTabId: string | null
  pinnedCollapsed: boolean
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

export interface WindowState {
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
  'tab.pickIcon': { args: { tabId: string }; result: void }

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

  'window.minimize': { args: void; result: void }
  'window.toggleMaximize': { args: void; result: void }
  'window.close': { args: void; result: void }
  'window.toggleFullscreen': { args: void; result: void }

  'page.screenshot': { args: { tabId: string }; result: void }
  'page.print': { args: { tabId: string }; result: void }
  'page.savePage': { args: { tabId: string }; result: void }
  'page.viewSource': { args: { tabId: string }; result: void }

  'onboarding.complete': {
    args: { searchEngineId: string; colorScheme: ColorScheme; essentials: string[] }
    result: void
  }
}

export type CommandName = keyof Commands
export type CommandArgs<K extends CommandName> = Commands[K]['args']
export type CommandResult<K extends CommandName> = Commands[K]['result']

export type UrlbarOpenMode = 'new-tab' | 'edit' | 'search'

export interface Events {
  state: UIState
  'urlbar.toggle': { mode: UrlbarOpenMode; text?: string }
  'urlbar.close': void
  'overlay.open': { kind: OverlayKind }
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
  'space.edit': { spaceId: string }
  'space.switched': { fromIndex: number; toIndex: number }
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
