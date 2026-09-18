/**
 * Types shared between the main process, the preload script and the renderer.
 * Everything here must be JSON-serialisable (it crosses the IPC boundary).
 */
import type { AppIconId } from './appIcon'
import type { SiteInfo, SiteInfoSnapshot } from './siteInfo'
import type { TranslatePreferences, TranslateSelectionResult, TranslateUIState } from './translate'
import type { EngineRelayRequest, EngineRelayResponse } from './translateEngine'
import type { UpdateSettings, UpdateStatus } from './updates'
import type { BlockingSettings, BlockingStatus } from './blocking'
import type { PrivacySettings, PrivacyStatus } from './privacy'

export type Platform = 'linux' | 'win32' | 'darwin' | 'android'

/**
 * How the chrome lays itself out, decided by the renderer from the window and its pointer (see
 * `lib/formFactor.ts`) and reported to the core, which builds menus and command lists for it.
 *
 *  - `phone`   – bottom bar, sidebar in a drawer, sheets instead of popovers.
 *  - `tablet`  – desktop layout with touch-sized controls.
 *  - `desktop` – everything else.
 */
export type FormFactor = 'phone' | 'tablet' | 'desktop'

/**
 * What the host can do for the chrome. The renderer adapts its UI to these rather than to the
 * platform name (e.g. a DeX desktop session is still `android`, but has a mouse and keyboard).
 */
export interface HostCapabilities {
  /** Host draws its own window frame – no minimise / maximise / close buttons in the chrome. */
  windowControls: boolean
  /**
   * The OS draws native minimise / maximise / close buttons over the chrome's top corner
   * (Windows 11's Window Controls Overlay, which is what gives the maximise button Snap
   * Layouts). The chrome keeps that region clear and draws no buttons of its own.
   */
  windowControlsOverlay: boolean
  /** Windows can be backed by a system material (Windows 11 Mica) behind a translucent chrome. */
  windowMaterial: boolean
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
  /** The host checks GitHub Releases for new versions and can fetch / apply them. */
  updates: boolean
  /** The host has a system share sheet (`app.share`); menus offer Share items when true. */
  share: boolean
  /**
   * The OS itself confirms copies with a clipboard chip (Android 13+); the chrome then stays
   * quiet instead of toasting "Link copied" a second time.
   */
  clipboardChip: boolean
  /** The host has a system screen for which links open in this app (Android's Open by default). */
  appLinkSettings: boolean
  /** Touch hosts: dragging down from the top of a page can reload it (Settings → Look and Feel). */
  pullToRefresh: boolean
  /** The host can protect the password vault's key (OS keystore) – the password manager is on. */
  passwords: boolean
  /**
   * The host can tell whether this app is the system's default browser and ask the system to make
   * it one (Android's browser role). Desktop hosts leave this to the platform's own settings.
   */
  defaultBrowser: boolean
  /** The host runs a request engine that blocks ads and trackers (Settings → Privacy and security). */
  requestBlocking: boolean
  /**
   * Pages follow the page controls (desktop site, dark theme for sites, page zoom and its
   * sheet); hosts without them keep the plain zoom menu.
   */
  pageControls: boolean
  /**
   * Extensions run, but their content scripts share the page's world (an Android WebView below
   * Chromium 146 has no isolated worlds; the emulation layer falls back to a scope proxy). Pages
   * can then observe the scripts' DOM work; the extensions UI says so.
   */
  reducedExtensionIsolation: boolean
  /**
   * Private browsing as tabs inside the one window (`tab.newPrivate`): hosts without separate
   * windows. Desktop hosts offer private windows instead (`windows`).
   */
  privateTabs: boolean
  /** The host can point the resolver at DNS-over-HTTPS servers (desktop); Android uses the system's Private DNS. */
  secureDns: boolean
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
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
/**
 * What a window's chrome shows: the sidebar with spaces and tabs, or – for the sized windows
 * pages open with `window.open(url, name, 'width=…')` – a single toolbar row above the page.
 */
export type WindowChrome = 'full' | 'popup'
/** System-drawn material behind a translucent chrome (Windows 11). */
export type WindowMaterial = 'none' | 'mica'

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
  /**
   * Memory (MB) the page held when it was put to sleep, for the sleeping tab's tooltip; absent
   * when the host could not tell (or the tab was never loaded this session).
   */
  sleepSavedMb?: number
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
  /** Requests the blocking engine stopped for the current document (resets on navigation). */
  blockedCount: number
  /**
   * Tab whose page opened this one (a link into a new tab, `window.open`). Mobile system back at
   * the tab's first page closes it and returns there, as Chrome does for a child tab.
   */
  openerTabId: string | null
  /** Opened by another app's intent or share; system back at its first page returns to that app. */
  fromIntent: boolean
}

/** Colours a tab group (folder) can wear; the phone chrome paints group cards with them. */
export type FolderColor =
  'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange'

export interface Folder {
  id: string
  spaceId: string
  name: string
  icon: string
  collapsed: boolean
  /** Group colour; folders made before groups had colours (or on desktop) carry none. */
  color?: FolderColor | null
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

/** Where an extension came from; store installs update through their store. */
export type ExtensionSource = 'chrome-web-store' | 'edge-add-ons' | 'crx' | 'zip' | 'unpacked'

/** What the last update check found for an extension (`unknown` until one ran or when it cannot update). */
export type ExtensionUpdateState = 'unknown' | 'up-to-date' | 'available' | 'updating' | 'error'

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
  source: ExtensionSource
  /** Who signed the package: a store, or `unknown` for other signed CRX files; null when unsigned. */
  publisher: 'chrome-web-store' | 'edge-add-ons' | 'unknown' | null
  /** Where updates come from (the store endpoint or `manifest.update_url`); null when it cannot update. */
  updateUrl: string | null
  installedAt: number
  updatedAt: number
  /** Pinned extensions are left out of update checks. */
  pinned: boolean
  /** Chrome's "Allow access to file URLs"; off by default. */
  allowFileAccess: boolean
  /**
   * Chrome's "Allow in Incognito": whether the extension's request rules (declarativeNetRequest,
   * webRequest listeners) apply in private windows. Off by default.
   */
  allowPrivate: boolean
  manifestVersion: number
  permissions: string[]
  hostPermissions: string[]
  /** `options_ui.page` or `options_page`, relative to the extension root. */
  optionsPage: string | null
  /** `chrome_url_overrides.newtab`, relative to the extension root; null when not declared. */
  newTabPage: string | null
  /** New tabs open `newTabPage` (`extension.setNewTabOverride`); off by default, one at most. */
  newTabOverride: boolean
  /** The install prompt's warning lines Chrome would show for this manifest. */
  warnings: string[]
  /** Warning lines an update added; the extension stays disabled until they are approved. */
  pendingWarnings: string[] | null
  updateState: ExtensionUpdateState
  /** The version the last check offered, while `updateState` is `available` or `updating`. */
  availableVersion: string | null
  /** Why the last update check or install failed, while `updateState` is `error`. */
  updateError: string | null
  /** When this extension was last checked for updates, or null when never. */
  updateCheckedAt: number | null
  /** Effective `chrome.action` state for the active tab; absent while the extension is not loaded. */
  action?: ExtensionAction
  /** The manifest's `commands` with the shortcut each one is bound to; absent while not loaded. */
  commands?: ExtensionCommandInfo[]
  /** Why some commands stayed unbound (a Zenium shortcut or another extension holds the key). */
  commandConflicts?: string[]
}

/** The extension side panel a window is showing (`chrome.sidePanel`), beside the page. */
export interface SidePanelInfo {
  extensionId: string
  name: string
  /** Data URL of the extension's icon, when it has one. */
  icon: string | null
}

/** One `chrome.commands` entry as the extensions page shows it. */
export interface ExtensionCommandInfo {
  name: string
  description: string
  /** The bound key in the user's shortcut label form, or null when unbound. */
  shortcut: string | null
  /** The `_execute_action` family: the key opens the toolbar action instead of `onCommand`. */
  executesAction: boolean
}

/** What an extension's toolbar button should show: `chrome.action` state for the active tab. */
export interface ExtensionAction {
  badgeText: string
  /** CSS colour, or null for the host's default badge colour. */
  badgeBackgroundColor: string | null
  badgeTextColor: string | null
  title: string
  /** Data URL set through `action.setIcon`, or null for the manifest icon. */
  icon: string | null
  /** Full popup URL, or null when a click fires `action.onClicked` instead. */
  popup: string | null
  enabled: boolean
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
// Passwords (the encrypted credential vault)
// ---------------------------------------------------------------------------

export interface PasswordSettings {
  /** Offer to save logins submitted in pages (the prompt itself arrives with in-page fill). */
  offerToSave: boolean
  /**
   * Seconds a successful re-authentication keeps covering reveals, copies and exports before the
   * user is asked again (Chrome uses about a minute); 0 asks every time.
   */
  reauthGraceSeconds: number
}

/**
 * A saved login. The password only ever leaves the core through the re-authenticated commands
 * (`passwords.reveal`, `passwords.copy`, `passwords.export`).
 */
export interface Credential {
  id: string
  /** Origin the login belongs to, e.g. `https://accounts.example.com`. */
  origin: string
  /** Page the login was saved from when known (fill and "change password" links), else ''. */
  url: string
  username: string
  password: string
  /** HTTP authentication realm (Basic / Digest prompts); `null` for form logins. */
  realm: string | null
  notes: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}

/** What the chrome lists: a credential without its secret. */
export interface CredentialSummary extends Omit<Credential, 'password'> {
  /** Registrable domain (`example.com`) used for grouping and matching. */
  domain: string
  favicon: string | null
}

/** Password checkup: which entries are compromised, weak or reused (ids only, no secrets). */
export interface CheckupState {
  running: boolean
  /** Entries processed so far and the total, while running. */
  checked: number
  total: number
  finishedAt: number | null
  error: string | null
  compromised: string[]
  weak: string[]
  /** Groups of entries sharing one password; each group has at least two members. */
  reused: string[][]
  /** Entries the breach lookup could not check (network); neither safe nor compromised. */
  unchecked: string[]
}

export interface PasswordsStatus {
  /** The data key is not in memory; `passwords.unlock` (with the passphrase where needed) opens the vault. */
  locked: boolean
  /** How the data key is protected: by the OS keystore, by a passphrase, or both. */
  protection: { os: boolean; passphrase: boolean }
  /** The OS keystore is usable on this device right now. */
  osKeystore: boolean
  /** The OS can verify the user (Touch ID, Windows Hello, Android biometrics or device credential). */
  osReauth: boolean
  count: number
  /** Registrable domains the user never wants to save logins for. */
  neverSave: string[]
  /** Increments on every change so the chrome re-fetches its lists. */
  revision: number
  /** The vault file could not be read; the manager offers to start over. */
  error: string | null
  checkup: CheckupState
}

/** Outcome of a command that needs the user to re-authenticate first. */
export type ReauthOutcome<T> =
  | { status: 'ok'; value: T }
  /** Ask for the vault passphrase and call again with it. */
  | { status: 'passphrase' }
  /** The OS cannot verify the user here: a vault passphrase must be set first. */
  | { status: 'setup-passphrase' }
  /**
   * The user cancelled, the OS refused or the passphrase was wrong; `reason` carries the host's
   * explanation when it gave one ("Authentication was cancelled").
   */
  | { status: 'denied'; reason?: string }

export interface GeneratorOptions {
  mode: 'password' | 'passphrase'
  /** Password mode: characters (clamped to the site's rules when a domain is given). */
  length: number
  upper: boolean
  lower: boolean
  digits: boolean
  symbols: boolean
  /** Passphrase mode: number of words and how they are joined. */
  words: number
  separator: string
  capitalize: boolean
  includeDigit: boolean
}

export type ImportConflict = 'skip' | 'replace' | 'keep-both'

export interface ImportResult {
  /** Which export the file looked like (`chrome`, `firefox`, `bitwarden`…); null when unrecognised. */
  format: string | null
  total: number
  added: number
  replaced: number
  skipped: number
  invalid: number
}

// ---------------------------------------------------------------------------
// History, bookmarks, downloads
// ---------------------------------------------------------------------------

/** Per-URL aggregate (the "place"): what the omnibox ranks and the top-sites tiles read. */
export interface HistoryEntry {
  url: string
  title: string
  visitCount: number
  lastVisit: number
  favicon: string | null
  firstVisit?: number
  /** Visits that started from typed input (weigh more in frecency). */
  typedCount?: number
}

export type HistoryTransition = 'link' | 'typed' | 'reload' | 'redirect' | 'restored' | 'other'

/** One visit of a page (the history page lists these, newest first, grouped by day). */
export interface HistoryVisit {
  /** Stable and unique per visit. */
  id: string
  url: string
  title: string
  favicon: string | null
  /** Milliseconds since the epoch. */
  visitTime: number
  transition: HistoryTransition
  tabId?: string
}

export interface HistoryQuery {
  /** Every whitespace-separated term must occur in the title or URL (case-insensitive). */
  text?: string
  /** Inclusive lower bound of `visitTime`. */
  fromMs?: number
  /** Exclusive upper bound of `visitTime`. */
  toMs?: number
  /** Only visits of this host (or its subdomains). */
  host?: string
  limit: number
  offset?: number
}

export interface HistoryDayGroup {
  /** Local calendar day, `YYYY-MM-DD`. */
  dayKey: string
  visits: HistoryVisit[]
}

export interface TopSite {
  url: string
  title: string
  favicon: string | null
  score: number
}

/** Legacy flat bookmark (state.json v1–v2); migrated into the tree on load. */
export interface Bookmark {
  id: string
  url: string
  title: string
  favicon: string | null
  createdAt: number
}

export type BookmarkNodeType = 'url' | 'folder'

/** When the bookmarks bar shows above the content frame (Edge's "Show favorites bar"). */
export type BookmarksBarMode = 'always' | 'newtab' | 'never'

/** Where a bookmark opens: the current tab, a new tab (foreground), a new window or a private window. */
export type BookmarkOpenTarget = 'current' | 'tab' | 'window' | 'private'

/**
 * One node of the bookmark tree, shaped like `chrome.bookmarks.BookmarkTreeNode`. The three
 * roots (Bookmarks bar, Other bookmarks, Mobile bookmarks) have fixed ids and `parentId: null`;
 * every other node sits at a contiguous `index` among its parent's children.
 */
export interface BookmarkNode {
  id: string
  parentId: string | null
  index: number
  type: BookmarkNodeType
  title: string
  /** Bookmarks only. */
  url?: string
  /** Bookmarks only: favicon URL or data URI, when known. */
  favicon?: string
  dateAdded: number
  /** Folders: last time a direct child was added, removed or moved. */
  dateGroupModified?: number
  /** Bookmarks: last time the user opened it. */
  dateLastUsed?: number
}

/** The persisted bookmark tree (`state.json` v3 and the export/import programs). */
export interface BookmarkTreeData {
  schemaVersion: 1
  nodes: BookmarkNode[]
}

/** Result of a Netscape HTML import (shown in a toast and returned to the caller). */
export interface BookmarkImportResult {
  bookmarks: number
  folders: number
  /** Folder the import landed in. */
  folderId: string
}

export type DownloadState = 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted'

export type DownloadDangerLevel = 'safe' | 'suspicious' | 'dangerous'

/**
 * Machine reason behind a danger level. File-type reasons follow Chromium's download_file_types
 * categories (`executable`, `script`, `archive`, `office-macro`, `file-type` for the rest of the
 * list); `insecure-download` is an http transfer started from an https page; `url-verdict` came
 * from a `DangerVerdictProvider` (Safe Browsing and friends). `none` while `level` is `safe`.
 */
export type DownloadDangerReason =
  | 'none'
  | 'executable'
  | 'script'
  | 'archive'
  | 'office-macro'
  | 'file-type'
  | 'insecure-download'
  | 'url-verdict'

export interface DownloadDanger {
  level: DownloadDangerLevel
  reason: DownloadDangerReason
  /** One sentence for the row ("This file type can harm your device."); empty when safe. */
  message: string
}

export interface DownloadItem {
  id: string
  url: string
  /** Page the download came from (empty when unknown); a retry sends it as the Referer again. */
  referrer: string
  /** Name the server suggested (or the `download` attribute / URL gave), before uniquifying. */
  filename: string
  /** Name the file ends up under: `filename` made unique (`report(1).pdf`) or the one the user typed. */
  finalName: string
  /**
   * Where the bytes are right now: the partial file while in progress, the final file once
   * completed. On Android this can be a `content:` URI.
   */
  savePath: string
  totalBytes: number
  receivedBytes: number
  state: DownloadState
  startedAt: number
  /** When the file was complete on disk (still set while a flagged file waits for Keep / Discard). */
  completedAt?: number
  /** When the transfer stopped for any reason: completed, cancelled or interrupted. */
  endedAt?: number
  mimeType: string
  /** The server honours Range requests, so paused and interrupted transfers can continue. */
  canResume: boolean
  /** Why an interrupted download stopped (Chromium's `net::` error name or a short reason). */
  error?: string
  danger: DownloadDanger
  /** The user chose "Keep" for a flagged file: it left quarantine and may be opened. */
  dangerAccepted: boolean
  /** Open the file as soon as the download completes (Chrome's "Open when done"). */
  openWhenDone: boolean
  /** Recent transfer rate; 0 while paused or unknown. */
  bytesPerSecond: number
  /** Estimated time to completion; null without a size or a rate. */
  etaMs: number | null
  /** Set on the copy that rides the `removed` event: the row left the list, the file stays. */
  removed?: boolean
  /** Started from a private window or the Android private profile; never written to disk. */
  private: boolean
  /** Container the download belongs to (`PRIVATE_CONTAINER_ID` when `private`). */
  containerId: string
  /** HTTP validators the host uses for `If-Range` on resume (empty when the server sent none). */
  etag: string
  lastModified: string
}

export type DownloadChangeKind = 'started' | 'progress' | 'done' | 'removed'

/** Aggregate of the in-flight downloads a window sees (its toolbar indicator, the OS progress bar). */
export interface DownloadsProgress {
  received: number
  total: number
  /** A transfer without a known size is running, so `received / total` says nothing. */
  indeterminate: boolean
  /** In-flight downloads, paused ones included; 0 clears the indicator. */
  active: number
}

export interface DownloadSettings {
  /** Folder new downloads go to; null means the platform's Downloads folder. */
  directory: string | null
  /** Firefox's "Always ask you where to save files" (mirrors `Settings.askWhereToSave`). */
  askWhereToSave: boolean
  /** Completion notifications (desktop: the system notification centre; Android: the downloader's). */
  notifyOnComplete: boolean
  /** Open the downloads panel whenever a download starts; off shows the toolbar indicator only. */
  openPanelOnStart: boolean
  /** Open the downloads panel when a download finishes (Chrome 112+). */
  openPanelOnComplete: boolean
  /**
   * Lower-case extensions opened automatically once downloaded (Chrome's "Open certain file
   * types automatically"); dangerous types never auto-open.
   */
  autoOpenTypes: string[]
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

/**
 * Which default binding table the shortcuts start from: Chrome's and Edge's chords (`chrome`,
 * the default) or the Zen Browser set Zenium grew up with (`zen`). User overrides sit on top
 * of either.
 */
export type ShortcutPreset = 'chrome' | 'zen'

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
  /** Chrome's tab search (Ctrl+Shift+A); reserved, does nothing until the tab search ships. */
  | 'tab.search'
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
  | 'window.minimize'
  | 'app.quit'
  /** Open the application menu from the keyboard (Alt+F / F10 on Windows and Linux). */
  | 'menu.app'
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
  | 'urlbar.pasteAndGo'
  | 'urlbar.pasteAndSearch'
  | 'find.open'
  | 'find.next'
  | 'find.prev'
  /** Chrome's "Use Selection for Find" (Cmd+E on macOS). */
  | 'find.useSelection'
  | 'page.savePage'
  | 'page.openFile'
  | 'page.emailLink'
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
  | 'bookmark.allTabs'
  | 'bookmark.toggleBar'
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
  /** Reserved for a feature that has not shipped: bound (a no-op) but left out of the list. */
  hidden?: boolean
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
/** Screen edge the phone layout docks its address bar to. */
export type PhoneBarPosition = 'top' | 'bottom'
/**
 * A control the phone's bar can host (see `shared/phoneBar.ts` for the catalogue). The address
 * pill is not one of them: it is always there, in the flexible slot between the two sides.
 */
export type PhoneBarItemId =
  | 'back'
  | 'forward'
  | 'reload'
  | 'home'
  | 'share'
  | 'bookmark'
  | 'bookmarks'
  | 'history'
  | 'downloads'
  | 'tabs'
  | 'new-tab'
  | 'menu'
  | 'spaces'
  | 'find'
/** Which controls sit on either side of the address pill; both sides read left to right as drawn. */
export interface PhoneBarLayout {
  left: PhoneBarItemId[]
  right: PhoneBarItemId[]
}
/** Haptic feedback the chrome asks the host for (mobile hosts; no-op elsewhere). */
export type HapticKind = 'lift' | 'tick' | 'dock'

export interface CompactModeSettings {
  enabled: boolean
  hideSidebar: boolean
  hideToolbar: boolean
  /** Ctrl+Alt+S – keep the sidebar visible until toggled again. */
  sidebarPersistent: boolean
}

export interface Settings {
  colorScheme: ColorScheme
  /** Colour of the app icon (launcher alias on Android, window / Dock icon on desktop). */
  appIcon: AppIconId
  toolbarLayout: ToolbarLayout
  sidebarSide: SidebarSide
  sidebarWidth: number
  /** Expanded (titles shown) vs collapsed (favicons only). */
  sidebarExpanded: boolean
  sidebarExpandOnHover: boolean
  /** Remove the browser padding / rounded content area. */
  borderless: boolean
  /** Windows 11: draw new windows on the system's Mica material behind a translucent chrome. */
  windowMaterial: WindowMaterial
  compactMode: CompactModeSettings
  urlbarBehavior: UrlbarBehavior
  /** Phone layout: where the address bar (and its gestures) live. Long-press the pill to move it. */
  phoneBarPosition: PhoneBarPosition
  /** Phone layout: the controls either side of the address pill (Settings › Navigation bar). */
  phoneBar: PhoneBarLayout
  /** Touch hosts: drag down from the top of a page to reload it. */
  pullToRefresh: boolean
  glanceEnabled: boolean
  glanceTrigger: GlanceTrigger
  pinnedCloseBehavior: PinnedCloseBehavior
  pinnedResetOnStartup: boolean
  thirdPartyOnPinned: ThirdPartyPinnedBehavior
  unloadEnabled: boolean
  unloadTimeoutMinutes: number
  unloadExcludedDomains: string[]
  /**
   * Hosts the user chose "Mute Site" for (lower-case hostnames without `www.`): every tab on
   * such a host is muted, new pages of the host start muted, and leaving the host lifts the mute.
   */
  mutedHosts: string[]
  searchEngineId: string
  searchSuggestions: boolean
  /**
   * Chrome's "Always show full URLs": the address pill keeps the scheme and `www.` instead of
   * eliding them at rest. Absent in profiles from before it existed (read as false).
   */
  showFullUrls?: boolean
  containerSpecificEssentials: boolean
  essentialsMax: number
  newTabPosition: NewTabPosition
  restoreSession: boolean
  /** Ask before a window with more than one tab closes (Firefox's warning; Edge has the setting). */
  warnOnCloseWindow: boolean
  /** After an unclean exit: offer the last session's pages, bring them back, or start fresh. */
  crashRestore: CrashRestoreMode
  /** Firefox's "Always ask you where to save files"; off saves straight into the Downloads folder. */
  askWhereToSave: boolean
  /**
   * Downloads folder, panel behaviour, auto-open types and notifications; absent in profiles from
   * before it existed (`resolveDownloadSettings` fills the defaults). `askWhereToSave` above is
   * the older sibling and stays the source of truth for that switch.
   */
  downloads?: Partial<DownloadSettings>
  onboardingDone: boolean
  showTabSeparator: boolean
  ctrlTabCyclesWithinSection: boolean
  spaceRouting: Record<string, string>
  /** Zen's window sync: mirror all tabs across windows, only pinned tabs, or keep windows independent. */
  windowSync: WindowSyncMode
  resources: ResourceSettings
  agents: AgentSettings
  updates: UpdateSettings
  /**
   * Non-web schemes (`mailto`, `tel`, `sms`, `market`, …) the user chose "Always allow" for in the
   * external-protocol sheet: pages may hand links of that scheme to the app without asking again.
   */
  externalProtocols: Record<string, boolean>
  passwords: PasswordSettings
  /** Session counter and cooldowns of the "make Zenium your default browser" prompts. */
  defaultBrowserPromo: DefaultBrowserPromoState
  /**
   * Desktop: the app version in which the user answered "Not now" to the "Make Zenium your
   * default browser" strip; it stays away until the next feature release (`major.minor`).
   */
  defaultBrowserPromptDismissed: string | null
  /** Ad and tracker blocking (Settings → Privacy and security). */
  blocking: BlockingSettings
  /** How pages are presented: desktop site, dark theme for sites, page zoom (Chrome's page controls). */
  pageControls: PageControlsSettings
  /** The bookmarks bar above the content frame: always, only on the new tab page, or never. */
  bookmarksBar: BookmarksBarMode
  /**
   * Which built-in key table the user's overrides sit on. New profiles follow Chrome; a profile
   * from before the setting existed keeps the Zen set when it had customised bindings.
   */
  shortcutPreset: ShortcutPreset
  /** Safe Browsing, HTTPS-only, secure DNS, cookies, GPC / DNT (Settings → Privacy and security). */
  privacy: PrivacySettings
}

// ---------------------------------------------------------------------------
// Sharing and external protocols
// ---------------------------------------------------------------------------

/** What `app.share` hands to the system share sheet. */
export interface SharePayload {
  /** Shown as the preview's title (the page title, or the link text). */
  title?: string
  /** Plain text to share when there is no URL. */
  text?: string
  url?: string
  /**
   * An image to share as a file: the host fetches it (with the tab's cookies) and shares the
   * bytes rather than the address.
   */
  imageUrl?: string
  /** The tab the share started from (the sheet's own actions – screenshot, print – work on it). */
  tabId?: string
  /** The page's favicon (a `data:` or `http(s)` URL) for the preview thumbnail. */
  favicon?: string
}

/**
 * One of the browser's own buttons in the system share sheet (Android 14's action row): the
 * host reports the tap, the core carries it out on the tab the share started from.
 */
export interface ShareAction {
  kind: 'copy' | 'screenshot' | 'print'
  url: string
  tabId: string | null
}

/**
 * A page wants to leave the web (`mailto:`, `tel:`, `intent://`, a custom scheme) or a site's
 * native app could open the link: the chrome shows a confirm sheet and answers through
 * `externalProtocol.respond`.
 */
export interface ExternalProtocolRequest {
  requestId: string
  /** The address the page wants to open, as the page gave it. */
  url: string
  /** Its scheme, lower-case (`mailto`, `tel`, `intent`, `https` for an app link). */
  scheme: string
  /** Name of the app that would open it, when the host could tell; null for "another app". */
  appName: string | null
  /** Host of the page that asked; empty when unknown. */
  site: string
  /** Whether the sheet offers to remember the choice for this scheme. */
  canRemember: boolean
}

// ---------------------------------------------------------------------------
// Default browser (Android's browser role)
// ---------------------------------------------------------------------------

/**
 * Persisted bookkeeping of the default-browser prompts. Sessions are counted from the end of
 * onboarding; the sheet comes up after a few of them and again after a cooldown, the banner fills
 * the sessions in between. Pure rules over this state live in `shared/defaultBrowser.ts`.
 */
export interface DefaultBrowserPromoState {
  /** Sessions (app starts) since onboarding finished. */
  sessions: number
  /** Session in which the promo sheet last came up (null = never). */
  promptedAt: number | null
  /** How often the sheet was answered with "Not now". */
  dismissals: number
  /** "Set as default" was chosen from a prompt: never ask again. */
  done: boolean
  /** Session in which the banner last came up (null = never). */
  bannerAt: number | null
}

/** What the chrome should show for the default-browser prompts right now. */
export type DefaultBrowserPrompt = 'sheet' | 'banner' | null

export interface DefaultBrowserStatus {
  /** Whether this app holds the browser role; null until the host answered (or when it cannot tell). */
  isDefault: boolean | null
  prompt: DefaultBrowserPrompt
}

/** Where a request to become the default browser was made from. */
export type DefaultBrowserRequestSource = 'onboarding' | 'sheet' | 'banner' | 'settings'

// ---------------------------------------------------------------------------
// Page controls (desktop site, dark theme for sites, page zoom)
// ---------------------------------------------------------------------------

/**
 * Whether sites get the desktop layout by default. `auto` is Chrome's rule: on large screens
 * (tablets, foldables open) or with a keyboard and mouse attached.
 */
export type DesktopSiteDefault = 'auto' | 'on' | 'off'

/**
 * The per-site keys are registrable domains (`getDomain`), the way Chrome remembers "desktop
 * site" and zoom per site. A site is listed only when it differs from the default.
 */
export interface PageControlsSettings {
  desktopSite: DesktopSiteDefault
  /** Desktop-site exceptions: domain → on / off. */
  desktopSites: Record<string, boolean>
  /** Apply a dark theme to sites without one while Zenium itself is dark (algorithmic darkening). */
  darkenSites: boolean
  /** Darkening exceptions: domain → on / off ("Turn off for this site"). */
  darkenSiteExceptions: Record<string, boolean>
  /** Default page zoom (1 = 100 %). */
  zoom: number
  /** Multiply the system font size (Android `fontScale`) into the default zoom. */
  zoomIncludesOsFontSize: boolean
  /** Per-site zoom: domain → factor. */
  siteZooms: Record<string, number>
  /** Override `user-scalable=no` and `maximum-scale` so pinch zoom works everywhere. */
  forceZoom: boolean
}

/**
 * The page-controls policy a host keeps a copy of, so a navigation gets its user agent and its
 * viewport before the request leaves and before the document starts: the defaults already
 * resolved for this device, plus the sites that differ. Sites are registrable domains
 * (`siteKey`); a host matches a URL's host against them by suffix (`siteValue`).
 */
export interface PageRules {
  desktop: { default: boolean; sites: Record<string, boolean> }
  darken: { default: boolean; sites: Record<string, boolean> }
  /** A site's factor (or the default) times `scale` – the system font size when included. */
  zoom: { default: number; sites: Record<string, number>; scale: number }
  forceZoom: boolean
}

/**
 * What the host knows about the device that the settings alone do not: `auto` desktop mode
 * follows the screen and the peripherals, the default zoom may follow the system font size.
 */
export interface PageEnvironment {
  /** The smallest width of the screen is 600 dp or more (a tablet, an open foldable, DeX). */
  largeScreen: boolean
  /** A hardware keyboard and a mouse are attached. */
  pointerAndKeyboard: boolean
  /** The system font scale (Android `Configuration.fontScale`); 1 on hosts without one. */
  fontScale: number
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
  chrome: WindowChrome
  /** The material this window was created with (windows keep it for their lifetime). */
  material: WindowMaterial
  maximized: boolean
  fullscreen: boolean
  focused: boolean
  /** Tab id currently in HTML (element) fullscreen – its view covers the whole window. */
  htmlFullscreenTabId: string | null
  /** A window-modal question waiting for an answer ("Close N tabs?"), if any. */
  prompt: WindowPrompt | null
}

export interface MediaState {
  tabId: string
  playing: boolean
}

/** A tab from another window being dragged over this one (`tab.dragOver`). */
export interface TabDragOver {
  tabId: string
  title: string
  favicon: string | null
  /** Pointer position in this window's chrome (CSS px). */
  x: number
  y: number
}

// ---------------------------------------------------------------------------
// Security: blocked pop-ups, site rules, HTTP authentication, client certificates
// ---------------------------------------------------------------------------

/**
 * A window a page tried to open without the user asking for it, or (Android) a link to another
 * application it tried to launch without a gesture.
 */
export interface BlockedPopup {
  url: string
  at: number
  kind: 'popup' | 'external'
}

/** One remembered per-site answer (`permission` may carry a qualifier: `openExternal:zoommtg`). */
export interface PermissionRule {
  origin: string
  permission: string
  decision: 'allow' | 'deny'
}

/** The user's answer to a permission prompt; `dismiss` refuses this request without remembering. */
export type PermissionPromptAnswer = 'allow' | 'block' | 'allow-once' | 'dismiss'

/**
 * A pending permission question the chrome shows over a tab, non-modal, one at a time per tab:
 * "Allow example.com to use your camera?" with Allow / Block / Allow once, answered by
 * `permissions.respond`. Withdrawn when the page navigates or the tab closes.
 */
export interface PermissionPrompt {
  id: string
  /** Tab whose page asked; null when the host could not say (the focused window shows it). */
  tabId: string | null
  origin: string
  /** Base permission name (`camera`, `media`, `geolocation`), for the prompt's glyph. */
  permission: string
  message: string
  detail: string
  allowLabel: string
  blockLabel: string
  /** Whether "Allow once" (until the tab leaves the site) is offered. */
  allowOnce: boolean
  requestedAt: number
}

// ---------------------------------------------------------------------------
// Clear browsing data and Safety check
// ---------------------------------------------------------------------------

/** Chrome's time ranges: the last hour, 24 hours, 7 days, 4 weeks, or everything. */
export type BrowsingDataRange = 'hour' | 'day' | 'week' | 'month' | 'all'

/**
 * What "Clear browsing data" can remove. `history`, `cookies` and `cache` are Chrome's Basic
 * set; the rest is Advanced. `cookies` covers cookies and every other kind of site data.
 */
export type BrowsingDataType =
  | 'history'
  | 'cookies'
  | 'cache'
  | 'downloads'
  | 'passwords'
  | 'autofill'
  | 'sitePermissions'
  | 'recentlyClosed'

export const BROWSING_DATA_BASIC: readonly BrowsingDataType[] = ['history', 'cookies', 'cache']
export const BROWSING_DATA_ADVANCED: readonly BrowsingDataType[] = [
  'history',
  'cookies',
  'cache',
  'downloads',
  'passwords',
  'autofill',
  'sitePermissions',
  'recentlyClosed'
]

/** The preview line of one type in the dialog: how much would go. */
export interface BrowsingDataCount {
  type: BrowsingDataType
  /** Items of `unit` in the range; null when the engine cannot count this type. */
  count: number | null
  unit: 'visits' | 'sites' | 'bytes' | 'downloads' | 'logins' | 'entries' | 'permissions'
  /** False when the engine cannot limit this type to the range: clearing removes all of it. */
  rangeApplies: boolean
  /** Why the type cannot be cleared right now (the vault is locked), or null. */
  unavailable: string | null
}

export interface ClearBrowsingDataResult {
  /** Types that were cleared. */
  cleared: BrowsingDataType[]
}

export type SafetyState = 'safe' | 'info' | 'warning' | 'unavailable'

/** One row of Safety check: a state for the glyph and a sentence for the row. */
export interface SafetyCheckRow {
  state: SafetyState
  summary: string
}

export interface SafetyCheckResult {
  checkedAt: number
  updates: SafetyCheckRow & { currentVersion: string; latestVersion: string | null }
  safeBrowsing: SafetyCheckRow & { configured: boolean; enabled: boolean | null }
  passwords: SafetyCheckRow & {
    compromised: number
    weak: number
    reused: number
    /** The vault is locked or the checkup never ran: counts are unknown. */
    known: boolean
  }
  /** Sites holding several granted permissions, or granted ones not visited for weeks. */
  permissions: SafetyCheckRow & {
    grantedSites: number
    review: Array<{ origin: string; permissions: string[]; reason: 'many' | 'unused' }>
  }
  /** Sites allowed to send notifications, busiest first (`shown` counts this session). */
  notifications: SafetyCheckRow & { sites: Array<{ origin: string; shown: number }> }
  extensions: SafetyCheckRow & {
    flagged: Array<{ id: string; name: string; reasons: string[] }>
  }
}

export interface ClientCertificateInfo {
  fingerprint: string
  subject: string
  issuer: string
  serialNumber: string
  /** Unix milliseconds. */
  validFrom: number
  validTo: number
}

/** A server or proxy asked for credentials (Basic, Digest, NTLM, Negotiate). */
export interface HttpAuthPrompt {
  id: string
  kind: 'http-auth'
  /** Tab whose page triggered it; null for proxy challenges outside any page. */
  tabId: string | null
  host: string
  port: number
  realm: string
  /** Lower-case challenge scheme ('basic', 'digest', 'ntlm', 'negotiate'); '' when unknown. */
  scheme: string
  isProxy: boolean
  /** Whether the credentials travel over TLS. */
  secure: boolean
  /** The previous answer for this realm was refused. */
  failedBefore: boolean
  /** The username of that refused answer, so only the password needs retyping; '' otherwise. */
  username: string
}

export interface ClientCertificatePrompt {
  id: string
  kind: 'client-certificate'
  tabId: string | null
  host: string
  certificates: ClientCertificateInfo[]
}

export type SecurityPrompt = HttpAuthPrompt | ClientCertificatePrompt

/** The user's answer; cancelling a prompt sends null instead. */
export type SecurityPromptResponse =
  | { kind: 'http-auth'; username: string; password: string; remember: boolean }
  | { kind: 'client-certificate'; index: number }

// ---------------------------------------------------------------------------
// Page dialogs: alert / confirm / prompt and "Leave site?"
// ---------------------------------------------------------------------------

export type PageDialogKind = 'alert' | 'confirm' | 'prompt' | 'beforeunload'

/**
 * A dialog a page opened (`alert`, `confirm`, `prompt`) or the "Leave site?" question its
 * `beforeunload` handler raised. The chrome shows it tab-modal, as Chrome does; the page waits
 * for the answer.
 */
export interface PageDialog {
  id: string
  kind: PageDialogKind
  tabId: string
  /** The site that opened it, the way Chrome titles the dialog ("example.com says"); '' when unknown. */
  site: string
  /** A frame of another site opened it ("An embedded page at example.com says"). */
  embedded: boolean
  message: string
  /** `prompt`: the field's initial text. */
  defaultValue: string
}

/** The user's answer; `value` carries the prompt's text when accepted. */
export interface PageDialogResponse {
  accepted: boolean
  value: string | null
}

/**
 * A question the chrome asks about a window as a whole (window-modal): whether to close the
 * window with its tabs, or to quit Zenium with every open tab.
 */
export interface WindowPrompt {
  id: string
  kind: 'close-tabs' | 'quit'
  /** How many tabs close. */
  count: number
}

/** The last run ended without a clean shutdown; the chrome offers to bring its pages back. */
export interface CrashRestoreOffer {
  tabCount: number
  windowCount: number
}

/** What Zenium does with the previous session's pages after an unclean exit. */
export type CrashRestoreMode = 'ask' | 'always' | 'never'

// ---------------------------------------------------------------------------
// The full UI state snapshot broadcast to the renderer
// ---------------------------------------------------------------------------

export interface UIState {
  platform: Platform
  capabilities: HostCapabilities
  version: string
  /**
   * Whether the host resolves the OS colour scheme to dark (the `system` choice); null when the
   * host has no say and the chrome reads `prefers-color-scheme` itself.
   */
  systemDark: boolean | null
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
  /** Newest first; private windows also see their private downloads, other windows never do. */
  downloads: DownloadItem[]
  downloadsProgress: DownloadsProgress
  /** Every bookmark node (roots included), ordered parent-first, then by index. */
  bookmarks: BookmarkNode[]
  recentlyClosedCount: number
  /** Newest first, at most 10 – enough for menus to render without a round trip. */
  recentlyClosed: ClosedEntrySummary[]
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
  /** The extension side panel this window shows beside the page, if one is open for its tab. */
  sidePanel: SidePanelInfo | null
  mods: Mod[]
  sync: SyncStatus
  /** Connected AI agents (MCP sessions) and the tabs they drive. */
  agents: AgentInfo[]
  agentServer: AgentServerStatus
  /** Automatic updates: what the browser knows about the latest release and how far it got. */
  updates: UpdateStatus
  /** The password vault: lock state, protection, counts and the last checkup (never secrets). */
  passwords: PasswordsStatus
  /** Default-browser role: whether Zenium holds it and which prompt (if any) is due. */
  defaultBrowser: DefaultBrowserStatus
  /** Pop-ups the blocker refused, per tab (the URL bar shows an indicator). */
  blockedPopups: Record<string, BlockedPopup[]>
  /** Every remembered per-site permission answer (Settings lists and revokes them). */
  permissionRules: PermissionRule[]
  /** Pending permission prompts, oldest first; the chrome shows its active tab's first one. */
  permissionPrompts: PermissionPrompt[]
  /** Pending HTTP authentication and client-certificate prompts, oldest first. */
  securityPrompts: SecurityPrompt[]
  /** Pending `alert` / `confirm` / `prompt` and "Leave site?" dialogs of pages, oldest first. */
  pageDialogs: PageDialog[]
  /** The pages of an unclean exit the chrome should offer to restore; null when there are none. */
  crashRestore: CrashRestoreOffer | null
  /** Ad and tracker blocking: lists, their freshness and the session counter. */
  blocking: BlockingStatus
  /** Safe Browsing feeds, HTTPS-only exceptions and the resolver's secure DNS state. */
  privacy: PrivacyStatus
  /** Page translation: preferences, models on the device and the per-tab translation state. */
  translate: TranslateUIState
  /** The device facts the page controls resolve against (screen class, peripherals, font scale). */
  pageEnvironment: PageEnvironment
}

export interface FindResult {
  tabId: string
  activeMatchOrdinal: number
  matches: number
}

// ---------------------------------------------------------------------------
// URL bar suggestions
// ---------------------------------------------------------------------------

/**
 * `answer`: a calculator, unit, currency, weather, time or dictionary row (the answer is the
 * title, the question the subtitle). `entity`: a Wikipedia summary row (name, description,
 * thumbnail). Both open their `url` on Enter, never inline-complete.
 */
export type SuggestionKind =
  | 'url'
  | 'search'
  | 'history'
  | 'bookmark'
  | 'tab'
  | 'space'
  | 'command'
  | 'engine'
  | 'answer'
  | 'entity'
  /** A `chrome.omnibox` row: the input belongs to an extension whose keyword starts it. */
  | 'omnibox'

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
  /**
   * Set on the first row when it is the default match to complete inline: `fill` starts with
   * what was typed and the row outranks the verbatim query (Chrome's rule), so the field shows
   * the remainder selected and Enter accepts it.
   */
  inline?: boolean
  /** Chromium-style relevance the rows were ordered by (1300 is the verbatim query). */
  relevance?: number
  /** The row's owner lets the user remove it (Delete; `omnibox.onDeleteSuggestion`). */
  deletable?: boolean
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
    | 'tab.moveToNewWindow'
    | 'page.toggleMuteSite'
    | 'resources.trim'
    | 'resources.open'
  /** The host capability the command needs; not offered where it is false. */
  requires?: keyof HostCapabilities
  /** The layouts the command does something in; absent means all of them. */
  layouts?: FormFactor[]
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
  /** A favicon (`data:` or remote URL) the renderer may show before the label. */
  icon?: string | null
  submenu: MenuItemDescriptor[] | null
}

export interface MenuDescriptor {
  id: string
  items: MenuItemDescriptor[]
  source:
    | 'page'
    | 'tab'
    | 'selection'
    | 'space'
    | 'folder'
    | 'newtab'
    | 'app'
    | 'bookmark'
    | 'history'
    | 'urlbar'
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
  /** Where the extension side panel's view goes (`UIState.sidePanel`), or null when none shows. */
  sidePanel?: Rect | null
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
  /** System share sheet (`capabilities.share`); hosts without one copy the link and toast. */
  'app.share': { args: SharePayload; result: void }
  /** Android's "Open by default" screen for this app (`capabilities.appLinkSettings`). */
  'app.openAppLinkSettings': { args: void; result: void }
  /** The external-protocol sheet's answer (`always` remembers the scheme in settings). */
  'externalProtocol.respond': {
    args: { requestId: string; allow: boolean; always: boolean }
    result: void
  }

  'layout.report': { args: LayoutReport; result: void }

  /**
   * The user asked for a new tab: the URL bar in new-tab mode, or the page an extension
   * overrides new tabs with (`chrome_url_overrides.newtab`, opted in per extension).
   */
  'tab.new': { args: void; result: void }
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
  /**
   * A private tab in this window (`capabilities.privateTabs`): the in-memory private container,
   * no history, no persisted downloads; its session is wiped when the last private tab closes.
   * Resolves with the tab id, or null on hosts that offer private windows instead.
   */
  'tab.newPrivate': { args: { url?: string }; result: string | null }
  /** Close every private tab (and so end the private session). */
  'tab.closePrivate': { args: void; result: void }
  'tab.closeOthers': { args: { tabId: string }; result: void }
  'tab.closeBelow': { args: { tabId: string }; result: void }
  'tab.closeAbove': { args: { tabId: string }; result: void }
  'tab.navigate': { args: { tabId: string; input: string }; result: void }
  'tab.back': { args: { tabId: string }; result: void }
  'tab.forward': { args: { tabId: string }; result: void }
  'tab.reload': { args: { tabId: string; skipCache?: boolean }; result: void }
  'tab.stop': { args: { tabId: string }; result: void }
  'tab.toggleMute': { args: { tabId: string }; result: void }
  /** "Mute Site" / "Unmute Site": every tab of the host, remembered in `settings.mutedHosts`. */
  'tab.toggleMuteSite': { args: { tabId: string }; result: void }
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
  /**
   * A sidebar drag let go over a drop target of this window. `key` is the target's `data-drop`
   * (`tab:<id>:before|after`, `section:<section>:<spaceId>`, `folder:<id>`, `space:<id>`,
   * `split:<side>`, `bookmark:<folderId>:<index>`); the core resolves it against the model.
   */
  'tab.drop': { args: { tabId: string; key: string }; result: void }
  /** A sidebar tab drag began in this window (the core tracks it across windows from here on). */
  'tab.dragStart': { args: { tabId: string }; result: void }
  /**
   * The pointer moved during a tab drag. `x`/`y` are chrome coordinates of this window (they run
   * past its edges while the pointer is outside it); `inSidebar` is true while the pointer is
   * over this window's own sidebar, where no other window can be the target.
   */
  'tab.dragMove': {
    args: { tabId: string; x: number; y: number; inSidebar: boolean }
    result: void
  }
  /** The window a drag from another window hovers reports the drop target under the pointer. */
  'tab.dragTarget': { args: { tabId: string; key: string | null }; result: void }
  /**
   * The drag ended outside this window's drop targets (chrome coordinates as for `tab.dragMove`):
   * `release` moves the tab into the other Zenium window under the pointer or tears it off into
   * a new window there; `cancel` (Escape) just ends the drag.
   */
  'tab.dragEnd': {
    args: { tabId: string; x: number; y: number; outcome: 'release' | 'cancel' }
    result: void
  }
  /** "Move Tab to New Window" from the tab menu: the new window opens beside this one. */
  'tab.moveToNewWindow': { args: { tabId: string }; result: void }
  /** Restore the newest recently closed entry (a window entry as a whole window). */
  'tab.reopenClosed': { args: void; result: void }
  /** The tab's back/forward stack for the long-press list on the back / forward buttons. */
  'tab.navigationEntries': { args: { tabId: string }; result: NavigationSnapshot }
  'tab.goToIndex': { args: { tabId: string; index: number }; result: void }
  /** The back/forward list as a menu (long press / right click on the back and forward buttons). */
  'tab.navigationMenu': { args: { tabId: string }; result: void }
  'tab.setZoom': { args: { tabId: string; delta: number | null }; result: void }
  /** Set the tab's site to an exact zoom factor (remembered per site). */
  'tab.setZoomFactor': { args: { tabId: string; factor: number }; result: void }
  /** "Desktop site" for the tab's site (remembered per site; null clears the exception). */
  'tab.setDesktopSite': { args: { tabId: string; on: boolean | null }; result: void }
  /** "Dark theme for this site" (remembered per site; null clears the exception). */
  'tab.setDarkenSite': { args: { tabId: string; on: boolean | null }; result: void }
  /** Per-site lists in Settings: drop one site's exception (`kind` picks the map). */
  'pageControls.forgetSite': {
    args: { kind: 'desktop' | 'darken' | 'zoom'; domain: string }
    result: void
  }
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

  'folder.create': {
    args: {
      spaceId: string
      name: string
      icon: string
      color?: FolderColor
      /** Start an inline rename of the new folder (default); off for folders made by a gesture. */
      rename?: boolean
    }
    result: string
  }
  'folder.update': {
    args: {
      folderId: string
      patch: Partial<Pick<Folder, 'name' | 'icon' | 'collapsed' | 'color'>>
    }
    result: void
  }
  'folder.delete': { args: { folderId: string; unpack: boolean }; result: void }
  'folder.contextMenu': { args: { folderId: string }; result: void }
  'newtab.contextMenu': { args: void; result: void }
  /**
   * The "⋯" application menu. `anchor` is the menu button in chrome CSS pixels: the menu opens
   * along its bottom edge; without it the menu opens at the pointer. `keyboard` marks a menu
   * opened by a shortcut, whose first item starts selected.
   */
  'app.menu': { args: { anchor?: Rect; keyboard?: boolean }; result: void }
  /** Renderer-hosted menus: an item was picked / the menu was dismissed. */
  'menu.click': { args: { menuId: string; itemId: string }; result: void }
  'menu.close': { args: { menuId: string }; result: void }
  /** Renderer → main: chrome UI closed, give keyboard focus back to the active page. */
  'focus.content': { args: void; result: void }
  /** Renderer → main: chrome UI opened, take keyboard focus. */
  'focus.chrome': { args: void; result: void }
  /** Renderer → host: a gesture reached a landmark (pick-up, midpoint, dock); vibrate briefly. */
  haptic: { args: { kind: HapticKind }; result: void }
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
  /**
   * Chrome's URL-bar menu items: the clipboard's text goes where typed text would (a URL
   * navigates, anything else searches), or is always searched with the default engine. Nothing
   * happens when the clipboard holds no text or the host cannot read it.
   */
  'urlbar.pasteAndGo': { args: { tabId: string | null }; result: void }
  'urlbar.pasteAndSearch': { args: { tabId: string | null }; result: void }
  /** The URL bar closed without an entry (Escape, a click away): an omnibox session ends. */
  'urlbar.cancel': { args: void; result: void }
  /** Delete on a row its owner marked `deletable` (`omnibox.onDeleteSuggestion`). */
  'urlbar.deleteSuggestion': { args: { input: string }; result: void }

  'overlay.snapshot': { args: { tabId: string }; result: string | null }

  /** Connection, cookies, storage and permissions of the tab's site (null for an unknown tab). */
  'site.info': { args: { tabId: string }; result: SiteInfo | null }
  /** Remove the cookies of the tab's site; resolves with how many were removed. */
  'site.clearCookies': { args: { tabId: string }; result: { removed: number } }
  /** Remove cookies, storage and permissions of the tab's site and reload the page. */
  'site.clearData': { args: { tabId: string }; result: void }
  /** Forget one permission decision of the site (or all of them) and reload the page. */
  'site.resetPermissions': { args: { tabId: string; permission?: string }; result: void }
  /**
   * Everything the desktop site-information popover shows for a tab: `site.info` plus the
   * requests the blocker refused on the page and whether the site is excepted from blocking.
   */
  'siteInfo.snapshot': { args: { tabId: string }; result: SiteInfoSnapshot | null }

  /**
   * Clear browsing data of the chosen types in the range. Passwords need re-authentication
   * (`passphrase` carries the vault passphrase when the chrome was asked for it); when it fails
   * nothing is cleared and the outcome says which step is needed.
   */
  'privacy.clearBrowsingData': {
    args: { range: BrowsingDataRange; types: BrowsingDataType[]; passphrase?: string }
    result: ReauthOutcome<ClearBrowsingDataResult>
  }
  /** How much of each type the range holds, for the dialog's preview lines. */
  'privacy.clearBrowsingDataCounts': {
    args: { range: BrowsingDataRange }
    result: BrowsingDataCount[]
  }
  /** Run Safety check now: updates, Safe Browsing, passwords, permissions, notifications, extensions. */
  'privacy.safetyCheck': { args: void; result: SafetyCheckResult }

  /** Take a fresh resource sample right now and return it. */
  'resources.snapshot': { args: void; result: ResourceSnapshot }
  /** Purge, freeze and discard as if every budget were exceeded ("free up memory now"). */
  'resources.trim': { args: void; result: void }
  /** Restart the browser so changed startup switches take effect. */
  'resources.relaunch': { args: void; result: void }

  'settings.update': { args: Partial<Settings>; result: void }
  'shortcuts.update': { args: { id: string; binding: KeyBinding | null }; result: void }
  /** Drop every override: the table goes back to the active preset. */
  'shortcuts.reset': { args: void; result: void }
  /**
   * The Settings recorder is (or stopped) listening for a chord: while it is, key presses in the
   * chrome are captured by the renderer and no shortcut runs.
   */
  'shortcuts.recording': { args: { recording: boolean }; result: void }
  'sidebar.setWidth': { args: { width: number }; result: void }
  'sidebar.toggleExpanded': { args: void; result: void }

  'history.search': { args: { query: string; limit: number }; result: HistoryEntry[] }
  'history.recent': { args: { limit: number }; result: HistoryEntry[] }
  'history.delete': { args: { url: string }; result: void }
  'history.clear': { args: void; result: void }
  'history.visits': { args: { query: HistoryQuery }; result: HistoryVisit[] }
  'history.grouped': { args: { query: HistoryQuery }; result: HistoryDayGroup[] }
  'history.topSites': { args: { n: number; excludedHosts?: string[] }; result: TopSite[] }
  /** Visits with `fromMs <= visitTime < toMs`. */
  'history.count': { args: { fromMs: number; toMs: number }; result: number }
  'history.deleteVisits': { args: { ids: string[] }; result: void }
  'history.deleteUrls': { args: { urls: string[] }; result: void }
  'history.deleteDay': { args: { dayKey: string }; result: void }
  /** Removes the visits in range and returns how many went. */
  'history.deleteRange': { args: { fromMs: number; toMs: number }; result: number }
  /** Open the history page (`zen://history`). */
  'history.open': { args: void; result: void }
  /** Context menu of a history row (open in new tab / window / private window, copy, remove…). */
  'history.contextMenu': { args: { visitId: string; url: string }; result: void }
  /** Menu of a day heading on the history page (delete the day). */
  'history.dayMenu': { args: { dayKey: string; count: number }; result: void }

  'session.recentlyClosed': { args: void; result: ClosedEntrySummary[] }
  'session.restoreClosed': { args: { id: string }; result: void }
  'session.clearRecentlyClosed': { args: void; result: void }

  /** Copy arbitrary text (history rows, menus) through the host clipboard. */
  'clipboard.writeText': { args: { text: string }; result: void }

  /** Bookmark the tab's page in the default folder, or remove its bookmarks (toast feedback). */
  'bookmark.toggle': { args: { tabId: string }; result: void }
  /** Star the tab's page: bookmarks it when needed, then opens the star dialog. */
  'bookmark.star': { args: { tabId: string }; result: void }
  'bookmark.create': {
    args: {
      parentId?: string
      index?: number
      title: string
      url?: string
      type?: BookmarkNodeType
      /** Known icon of the page (a tab dropped on the bar brings its own). */
      favicon?: string | null
    }
    result: BookmarkNode | null
  }
  'bookmark.update': {
    args: { id: string; title?: string; url?: string }
    result: void
  }
  /** Move nodes (in the given order) so that the first lands at `index` of `parentId`. */
  'bookmark.move': { args: { ids: string[]; parentId: string; index?: number }; result: void }
  /** Remove bookmarks and folders (folders with all their contents). */
  'bookmark.remove': { args: { ids: string[] }; result: void }
  /** Open a bookmark (records `dateLastUsed`). */
  'bookmark.open': { args: { id: string; newTab: boolean; tabId: string | null }; result: void }
  /** Open every bookmark in the given folders / selection in new tabs. */
  'bookmark.openAll': { args: { ids: string[] }; result: void }
  /** Open the bookmarks below the given nodes in a new (or private) window. */
  'bookmark.openInWindow': { args: { ids: string[]; private: boolean }; result: void }
  /** "Bookmark all tabs": asks for the folder's name and place (`bookmark.allTabs` event). */
  'bookmark.allTabs': { args: void; result: void }
  /** The dialog's answer: one new folder with a bookmark per tab, in tab order. */
  'bookmark.createFromTabs': {
    args: { tabIds: string[]; title: string; parentId: string }
    result: BookmarkNode | null
  }
  'bookmark.contextMenu': {
    args: {
      ids: string[]
      folderId: string
      x: number
      y: number
      /** The bar and its folder panels get Chrome's bar menu (open targets, "Show bookmarks bar"). */
      surface?: 'manager' | 'bar'
    }
    result: void
  }
  /** The bookmarks surface's overflow menu (bookmark all tabs, import, export) at `x`,`y`. */
  'bookmark.menu': { args: { x: number; y: number }; result: void }
  /** Ctrl+Shift+B: flips the bar between always shown and never shown. */
  'bookmark.toggleBar': { args: void; result: void }
  'bookmark.cut': { args: { ids: string[] }; result: void }
  'bookmark.copy': { args: { ids: string[] }; result: void }
  /** Paste the app's bookmark clipboard; false when it is empty (a URL on the host clipboard is the caller's). */
  'bookmark.paste': { args: { folderId: string; index?: number }; result: boolean }
  /** Netscape bookmark HTML import through the host's file picker. */
  'bookmark.import': { args: void; result: BookmarkImportResult | null }
  /** Netscape bookmark HTML export through the host's save dialog. */
  'bookmark.export': { args: void; result: boolean }

  'download.pause': { args: { id: string }; result: void }
  'download.resume': { args: { id: string }; result: void }
  'download.cancel': { args: { id: string }; result: void }
  'download.showInFolder': { args: { id: string }; result: void }
  'download.open': { args: { id: string }; result: void }
  /** Take the row out of the list; the file stays where it is. */
  'download.remove': { args: { id: string }; result: void }
  /** "Clear all": every finished row leaves the list (`download.clearCompleted` is the older name). */
  'download.removeCompleted': { args: void; result: void }
  'download.clearCompleted': { args: void; result: void }
  /** Start over: a new request for the same URL with the same referrer, replacing the row. */
  'download.retry': { args: { id: string }; result: void }
  /** "Keep": release a flagged file from quarantine. */
  'download.acceptDanger': { args: { id: string }; result: void }
  /** "Discard": delete a flagged file (or what is left of a failed one) and drop the row. */
  'download.discard': { args: { id: string }; result: void }
  'download.setOpenWhenDone': { args: { id: string; on: boolean }; result: void }
  /** Let the user pick the default downloads folder; resolves with it (or null when dismissed). */
  'download.chooseDirectory': { args: void; result: string | null }
  /** Show the downloads panel (Ctrl/Cmd+J, the app menu, a completion notification). */
  'download.openPanel': { args: void; result: void }

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
  /** Renderer → main: the layout the chrome settled on (sent on start and whenever it changes). */
  'window.formFactor': { args: { formFactor: FormFactor }; result: void }
  /** Zen: a new synced window starts at the current space showing the same tabs. */
  'window.new': { args: void; result: void }
  /** Zen's "New blank window" (Ctrl+Shift+N): an independent, temporary tab list. */
  'window.newUnsynced': { args: void; result: void }
  'window.newPrivate': { args: void; result: void }
  /** Open a URL in a new window of the given kind (history rows: "Open in New / Private Window"). */
  'window.openUrl': { args: { url: string; kind: WindowKind }; result: void }
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

  /**
   * Ask the system to make Zenium the default browser (Android's role dialog, or the default-apps
   * settings on older versions); resolves with whether it now is (null when the host cannot tell).
   */
  'defaultBrowser.request': {
    args: { source: DefaultBrowserRequestSource }
    result: boolean | null
  }
  /** "Not now" on the sheet, or the banner's close button. */
  'defaultBrowser.dismiss': { args: { prompt: 'sheet' | 'banner' }; result: void }
  /** Read the role again (the settings row opens; the app came back from the system dialog). */
  'defaultBrowser.refresh': { args: void; result: boolean | null }

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
  /** Picks a `.crx` or `.zip` file and installs it. */
  'extension.installFromFile': { args: void; result: void }
  /** Installs from the Chrome Web Store or Edge Add-ons by id or listing URL. */
  'extension.installFromStore': {
    args: { ref: string; store?: 'chrome-web-store' | 'edge-add-ons' }
    result: void
  }
  'extension.remove': { args: { id: string }; result: void }
  'extension.setEnabled': { args: { id: string; enabled: boolean }; result: void }
  'extension.setPinned': { args: { id: string; pinned: boolean }; result: void }
  /** Lets (or stops letting) this extension's `chrome_url_overrides.newtab` page open new tabs. */
  'extension.setNewTabOverride': { args: { id: string; enabled: boolean }; result: void }
  /** Opens this extension's `chrome.sidePanel` beside the page, or closes it when it is showing. */
  'extension.toggleSidePanel': { args: { id: string }; result: void }
  'extension.closeSidePanel': { args: void; result: void }
  /** Chrome's "Allow in Incognito": let the extension's request rules reach private windows. */
  'extension.setAllowPrivate': { args: { id: string; allowed: boolean }; result: void }
  'extension.reload': { args: { id: string }; result: void }
  'extension.checkForUpdates': { args: void; result: void }
  'extension.update': { args: { id: string }; result: void }
  'extension.openOptions': { args: { id: string }; result: void }
  'extension.openPopup': { args: { id: string; anchor: Rect }; result: void }
  'extension.closePopup': { args: void; result: void }
  /** Context menu of an extension's toolbar button (its `contextMenus` items plus Zenium's). */
  'extension.actionContextMenu': { args: { id: string; x?: number; y?: number }; result: void }

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

  /** Look for a newer release now (Settings → Updates → "Check now"). */
  'updates.check': { args: void; result: void }
  /** Fetch and verify the release found by the last check. */
  'updates.download': { args: void; result: void }
  /** Apply a downloaded update: restart into it, open the installer, or hand it to the OS. */
  'updates.install': { args: void; result: void }
  'updates.cancel': { args: void; result: void }
  /** Open the release notes on GitHub in a tab. */
  'updates.openRelease': { args: void; result: void }

  /**
   * Open (or first create) the vault. `passphrase` answers a `passphrase` outcome, and creates
   * the vault after a `setup-passphrase` one (no OS keystore on this device).
   */
  'passwords.unlock': { args: { passphrase?: string }; result: ReauthOutcome<null> }
  'passwords.lock': { args: void; result: void }
  /** Throw the unreadable vault away and start empty (offered when `PasswordsStatus.error` is set). */
  'passwords.reset': { args: void; result: void }
  /**
   * Set or change the vault passphrase (the desktop fallback when no OS keystore exists, and
   * the re-authentication secret where the OS cannot verify the user). Changing an existing
   * passphrase needs the current one.
   */
  'passwords.setPassphrase': {
    args: { passphrase: string; current?: string }
    result: ReauthOutcome<null>
  }
  /** Saved logins without their secrets, newest first; `query` filters by site and username. */
  'passwords.list': { args: { query?: string }; result: CredentialSummary[] }
  /** The password of one login, behind re-authentication. */
  'passwords.reveal': { args: { id: string; passphrase?: string }; result: ReauthOutcome<string> }
  /** Copy a login's username, or (behind re-authentication) its password. */
  'passwords.copy': {
    args: { id: string; field: 'username' | 'password'; passphrase?: string }
    result: ReauthOutcome<null>
  }
  'passwords.add': {
    args: { url: string; username: string; password: string; notes?: string }
    result: CredentialSummary
  }
  'passwords.update': {
    args: {
      id: string
      patch: Partial<Pick<Credential, 'url' | 'username' | 'password' | 'notes'>>
    }
    result: CredentialSummary | null
  }
  /** Delete a login; it can be brought back with `passwords.restore` for a short while. */
  'passwords.remove': { args: { id: string }; result: void }
  'passwords.restore': { args: { id: string }; result: boolean }
  'passwords.neverSaveAdd': { args: { domain: string }; result: void }
  'passwords.neverSaveRemove': { args: { domain: string }; result: void }
  /** A fresh strong password; `domain` applies the site's published password rules. */
  'passwords.generate': {
    args: { options: GeneratorOptions; domain?: string }
    result: { password: string; rules: string | null }
  }
  'passwords.checkupRun': { args: void; result: void }
  'passwords.checkupCancel': { args: void; result: void }
  /** Pick a CSV export (Chrome, Edge, Firefox, Bitwarden, Safari, LastPass) and import it. */
  'passwords.import': { args: { conflict: ImportConflict }; result: ImportResult | null }
  /**
   * Write every login to a Chrome-compatible CSV where the user chooses, behind
   * re-authentication; `saved` is false when the save dialog was cancelled.
   */
  'passwords.export': {
    args: { passphrase?: string }
    result: ReauthOutcome<{ saved: boolean; count: number }>
  }
  /** "Open anyway" for one blocked pop-up of a tab. */
  'popups.open': { args: { tabId: string; url: string }; result: void }
  'popups.dismiss': { args: { tabId: string }; result: void }
  /** Always allow (or stop allowing) pop-ups on the site of the tab's current page. */
  'popups.setSiteAllowed': { args: { tabId: string; allow: boolean }; result: void }
  /** Forget one remembered per-site answer; the site asks (or is blocked) again. */
  'permissions.forget': { args: { origin: string; permission: string }; result: void }
  'permissions.reset': { args: void; result: void }
  /** Answer (or dismiss) a pending permission prompt. */
  'permissions.respond': { args: { id: string; answer: PermissionPromptAnswer }; result: void }
  /**
   * Settings › Site settings: the default for a content type (`ask` and the built-in default
   * both clear the stored default), and the sites with a decision of their own.
   */
  'permissions.setDefault': {
    args: { permission: string; decision: 'allow' | 'deny' | 'ask' }
    result: void
  }
  'permissions.defaults': { args: void; result: Record<string, 'allow' | 'deny' | 'ask'> }
  'permissions.listForPermission': {
    args: { permission: string }
    result: Array<{ origin: string; decision: 'allow' | 'deny' }>
  }
  /** Decide for a site without a prompt (an exception row), or forget with null. */
  'permissions.set': {
    args: { origin: string; permission: string; decision: 'allow' | 'deny' | null }
    result: void
  }
  /** Forget every decision of a site (Settings' per-site list). */
  'permissions.resetOrigin': { args: { origin: string }; result: void }
  /** Answer a pending HTTP authentication or client-certificate prompt (null cancels). */
  'security.respond': {
    args: { id: string; response: SecurityPromptResponse | null }
    result: void
  }
  /** Answer a page's `alert` / `confirm` / `prompt` or "Leave site?" dialog. */
  'pageDialog.respond': { args: { id: string; response: PageDialogResponse }; result: void }
  /** Answer the window-modal question the window is showing ("Close N tabs?"). */
  'window.respondPrompt': { args: { id: string; accepted: boolean }; result: void }
  /** After an unclean exit: bring the last session's pages back, or start without them. */
  'session.crashRestore': { args: { restore: boolean }; result: void }
  /** Drop the credentials and certificate choices remembered for this session. */
  'security.forgetSession': { args: void; result: void }
  /** Refresh one filter list (or every enabled one) from its canonical URL now. */
  'blocking.updateLists': { args: { id?: string }; result: void }
  /** The master switch of ad and tracker blocking (the `ads` permission's default). */
  'blocking.setEnabled': { args: { enabled: boolean }; result: void }
  /** Except a site (origin, URL or host) from blocking, or block on it again. */
  'blocking.setSiteException': { args: { site: string; excepted: boolean }; result: void }
  /** Translate the tab's page (into the default target when `target` is omitted). */
  'translate.page': {
    args: { tabId: string; target?: string; source?: string }
    result: void
  }
  /** Show the original page again. */
  'translate.revert': { args: { tabId: string }; result: void }
  /** Close the translation offer for this page load. */
  'translate.dismiss': { args: { tabId: string }; result: void }
  /** Translate the tab's selection (or `text`); null when nothing is selected. */
  'translate.selection': {
    args: { tabId: string; text?: string; target?: string }
    result: TranslateSelectionResult | null
  }
  'translate.setPreferences': { args: Partial<TranslatePreferences>; result: void }
  /** Always translate, never translate, or ask for pages in `language`. */
  'translate.setLanguageRule': {
    args: { language: string; rule: 'always' | 'never' | 'ask' }
    result: void
  }
  /** Never offer to translate the tab's site (or offer again). */
  'translate.setSiteRule': { args: { tabId: string; never: boolean }; result: void }
  'translate.downloadModel': { args: { from: string; to: string }; result: void }
  'translate.removeModel': { args: { from: string; to: string }; result: void }
  /** The chrome renderer hands back an answer of the engine worker it runs for the core. */
  'translate.engineResponse': { args: EngineRelayResponse; result: void }
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
  /** Open the find bar; `text` replaces what it holds and is searched for at once ("use selection for find"). */
  'find.open': { tabId: string; again?: 'next' | 'prev'; text?: string }
  /**
   * A shortcut asked for the application menu: the renderer focuses the menu button and opens
   * the menu from it (`app.menu` with `keyboard`), so Escape leaves the keyboard on the button.
   */
  'menu.app': void
  /**
   * A download row changed. `progress` is throttled to 4 Hz per item, state changes arrive at
   * once; `done` covers completed, cancelled and interrupted (read `item.state`). Private items
   * only reach private windows. The full list also rides in `state.downloads`.
   */
  'download.changed': { item: DownloadItem; kind: DownloadChangeKind }
  /** A dangerous or suspicious download finished and waits for Keep / Discard. */
  'download.danger': { id: string }
  toast: { message: string; kind?: 'info' | 'error' }
  /** Link hover status text (Firefox shows this in the bottom corner). */
  status: { text: string }
  'sidebar.toggle': void
  'compact.reveal': { revealed: boolean }
  'theme.open': { spaceId: string }
  'space.new': void
  'tab.startRename': { tabId: string }
  /**
   * A tab dragged from another window hovers this one: show its ghost at the given chrome
   * coordinates and light up the drop target under it (null once it leaves or the drag ends).
   */
  'tab.dragOver': TabDragOver | null
  'folder.startRename': { folderId: string }
  /** Open the pinned-URL editor for a pinned/essential tab. */
  'tab.editPinnedUrl': { tabId: string }
  /** Open the emoji/icon picker for a tab. */
  'tab.pickIcon': { tabId: string }
  /** Show the star dialog for a bookmark that was just created (or already existed). */
  'bookmark.star': { tabId: string; nodeId: string; created: boolean }
  /** The bookmark manager should edit a node, or create one (`id: null`) inside `parentId`. */
  'bookmark.edit': { id: string | null; parentId: string; type: BookmarkNodeType }
  /** Open the "Bookmark all tabs" dialog for these tabs. */
  'bookmark.allTabs': { tabIds: string[]; defaultTitle: string }
  'space.edit': { spaceId: string }
  'space.switched': { fromIndex: number; toIndex: number }
  /** Hosts without native menus ask the renderer to show one. */
  'menu.show': MenuDescriptor
  'menu.hide': { menuId: string }
  /** A page wants to open another app: show the confirm sheet (answered by `externalProtocol.respond`). */
  'externalProtocol.request': ExternalProtocolRequest
  /** The request was withdrawn (its tab closed, another one took its place). */
  'externalProtocol.cancel': { requestId: string }
  /** History changed: visits are throttled to twice a second, deletions arrive at once. */
  'history.changed': { kind: 'visit' | 'delete' | 'clear' }
  'session.recentlyClosedChanged': void
  /** Safe-area insets of the host window in CSS pixels (mobile status bar, IME, cutouts). */
  insets: { top: number; right: number; bottom: number; left: number }
  /** A login was deleted; `passwords.restore` brings it back for a while. */
  'passwords.removed': { id: string; site: string }
  /**
   * The core asks this window's renderer to run a translation engine request (Electron only;
   * the payload carries `ArrayBuffer`s, so it is structured-cloned rather than JSON).
   */
  'translate.engine': EngineRelayRequest
}

export type EventName = keyof Events

// ---------------------------------------------------------------------------
// Recently closed tabs and windows (persisted in state.json, summaries in the snapshot)
// ---------------------------------------------------------------------------

/**
 * A page's back/forward stack and which entry is current. `pageState` is Chromium's serialised
 * state of an entry – scroll offset and form control values – handed back on restore so a page
 * comes back where it was; absent when the engine has none for the entry (or it was too large
 * to keep).
 */
export interface NavigationSnapshot {
  entries: NavigationSnapshotEntry[]
  index: number
}

export interface NavigationSnapshotEntry {
  url: string
  title: string
  pageState?: string
}

export interface ClosedTabEntry {
  kind: 'tab'
  id: string
  closedAt: number
  tab: Tab
  spaceId: string | null
  folderId: string | null
  /** Position inside its section (essentials, pinned or regular) when it was closed. */
  index: number
  windowId: string | null
  navigation: NavigationSnapshot | null
}

export interface ClosedWindowEntry {
  kind: 'window'
  id: string
  closedAt: number
  windowKind: WindowKind
  bounds: Rect | null
  activeTabId: string | null
  tabs: ClosedTabEntry[]
}

export type ClosedEntry = ClosedTabEntry | ClosedWindowEntry

/** What menus and the history page show for a closed entry (no full tab records). */
export interface ClosedEntrySummary {
  id: string
  kind: 'tab' | 'window'
  title: string
  url: string | null
  favicon: string | null
  closedAt: number
  tabCount: number
}

/** The pre-visit-model name; new code uses `ClosedTabEntry`. */
export type ClosedTab = ClosedTabEntry
