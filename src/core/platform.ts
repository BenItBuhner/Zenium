/**
 * The seam between Zen's browser core and the host it runs on.
 *
 * The core (`src/core`) owns every behaviour the user can observe – tabs, spaces, split views,
 * Glance, windows, shortcuts, history, downloads, Boosts, Reader View, Live Folders, Mods – and
 * talks to the outside world only through the interfaces in this file. Electron implements them
 * with `BrowserWindow`/`WebContentsView`/`Menu`/`dialog` (`src/main/platform`); Android implements
 * them with a Kotlin host reached over a JS bridge (`src/android`). Nothing in `src/core` may
 * import from `electron`, `node:*` or the DOM.
 */
import type {
  DownloadItem,
  EventName,
  Events,
  ExtensionInfo,
  HapticKind,
  HostCapabilities,
  KeyBinding,
  Platform as PlatformOs,
  Rect,
  ResourceSnapshot,
  SharePayload,
  SyncScope,
  SyncStatus,
  Tab
} from '../shared/types'
import type { AppIconId } from '../shared/appIcon'
import type { KeyInput } from '../shared/shortcuts'
import type { SiteCertificate, SiteCookie } from '../shared/siteInfo'
import type { UpdateAsset, UpdateProgress, UpdateRelease, UpdateTarget } from '../shared/updates'
import type { Browser } from './browser'
import type { ZenWindow } from './window'
import type { AgentHttpRequest, AgentHttpResponse } from './agent/http'

export interface PlatformInfo {
  os: PlatformOs
  version: string
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Raw text storage for the JSON stores (one document per name). */
export interface StoreIO {
  /** Synchronous read at startup; `null` when the document does not exist. */
  readSync(name: string): string | null
  /** Atomic write; the promise settles once the document is durable. */
  write(name: string, text: string): Promise<void>
  /** Synchronous write used when the process is about to go away. */
  writeSync(name: string, text: string): void
}

// ---------------------------------------------------------------------------
// Pages (tab views)
// ---------------------------------------------------------------------------

/** Behaviour flags pushed into every page (consumed by the page script). */
export interface PageFlags {
  glanceEnabled: boolean
  glanceTrigger: 'alt' | 'ctrl' | 'shift'
  /** How plain clicks on third-party links behave on pinned/essential tabs (null = normal tab). */
  thirdParty: 'new-tab' | 'glance' | 'same-tab' | null
}

/** Messages the page script sends back to the browser. */
export interface PageMessage {
  type: 'glance' | 'open-tab' | 'navigate' | 'media' | 'zap'
  url?: string
  x?: number
  y?: number
  background?: boolean
  /** `media`: whether any media element is currently playing. */
  playing?: boolean
  /** `zap`: CSS selector of the element the user picked in Boost zap mode. */
  selector?: string
}

export interface PageContextParams {
  x: number
  y: number
  linkURL: string
  srcURL: string
  mediaType: 'none' | 'image' | 'audio' | 'video' | 'canvas' | 'file' | 'plugin'
  selectionText: string
  isEditable: boolean
  misspelledWord: string
  dictionarySuggestions: string[]
  editFlags: {
    canUndo: boolean
    canRedo: boolean
    canCut: boolean
    canCopy: boolean
    canPaste: boolean
    canDelete: boolean
    canSelectAll: boolean
  }
}

export interface FindResultInfo {
  activeMatchOrdinal: number
  matches: number
  finalUpdate: boolean
}

export type WindowOpenDisposition =
  'default' | 'foreground-tab' | 'background-tab' | 'new-window' | 'save-to-disk' | 'other'

export interface KeyEventInput extends KeyInput {
  type: 'keyDown' | 'keyUp' | 'char' | 'rawKeyDown'
  isAutoRepeat: boolean
}

/** Why a page's renderer went away. */
export type CrashReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'launch-failed'
  | 'integrity-failure'
  | 'memory-eviction'
  | string

export type InputModifier = 'Shift' | 'Control' | 'Alt' | 'Meta'

/**
 * Synthetic input an AI agent sends to a page, in view CSS pixels. Hosts turn it into trusted
 * events (Electron: `sendInputEvent`; Android: `MotionEvent`/`KeyEvent` on the WebView).
 */
export type AgentInputEvent =
  | { type: 'mouseMove'; x: number; y: number }
  | {
      type: 'click'
      x: number
      y: number
      button: 'left' | 'right' | 'middle'
      clickCount: number
      modifiers: InputModifier[]
    }
  | { type: 'key'; key: string; modifiers: InputModifier[] }
  | { type: 'text'; text: string }

/**
 * What an agent wants captured: the visible viewport, the whole scrollable page, or a region
 * given in CSS pixels relative to the document (viewport position plus scroll offset).
 */
export interface AgentCaptureOptions {
  mode: 'viewport' | 'fullPage' | 'region'
  region?: Rect
  format: 'jpeg' | 'png'
}

export interface AgentCapture {
  /** Base64 image data (no `data:` prefix). */
  data: string
  mimeType: string
  width: number
  height: number
}

/** Callbacks a host fires for one tab view. */
export interface TabViewEvents {
  onStartLoading(): void
  onStopLoading(): void
  /** Main-frame navigation committed (`inPage` for pushState / hash changes). */
  onNavigated(url: string, inPage: boolean): void
  onTitleUpdated(title: string): void
  onFaviconUpdated(favicons: string[]): void
  /** Main-frame load failure (Chromium `net::` error code; hosts map their own codes). */
  onFailLoad(code: number, description: string, url: string): void
  onCrashed(reason: CrashReason): void
  onAudioStateChanged(audible: boolean): void
  onMediaStateChanged(playing: boolean): void
  onEnterHtmlFullscreen(): void
  onLeaveHtmlFullscreen(): void
  onDevtoolsOpened(): void
  onDevtoolsClosed(): void
  onFoundInPage(result: FindResultInfo): void
  onZoomChanged(direction: 'in' | 'out'): void
  onContextMenu(params: PageContextParams): void
  /** Returns true when the key was consumed by a browser shortcut. */
  onKey(input: KeyEventInput): boolean
  onTargetUrl(url: string): void
  onDomReady(): void
  onDestroyed(): void
  /** `window.open` / `target=_blank`. Return how the host should proceed. */
  onOpenWindow(url: string, disposition: WindowOpenDisposition): 'deny' | 'tab' | 'popup'
  onPageMessage(message: PageMessage): void
}

/**
 * One live web page. Mirrors the subset of Electron's `WebContentsView` + `WebContents` the core
 * uses; on Android every method is a call into the Kotlin host.
 */
export interface TabView {
  loadURL(url: string): void
  getURL(): string
  getTitle(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(ignoreCache: boolean): void
  stop(): void
  /** True once a document has committed (a view that only ever triggered a download has none). */
  hasDocument(): boolean
  setMuted(muted: boolean): void
  isCurrentlyAudible(): boolean
  setZoom(factor: number): void
  getZoom(): number
  findInPage(text: string, forward: boolean, newSession: boolean): void
  stopFind(action: 'clearSelection' | 'keepSelection'): void
  executeJavaScript(code: string): Promise<unknown>
  /** Inject a stylesheet; resolves with a key for `removeInsertedCSS`. */
  insertCSS(css: string): Promise<string>
  removeInsertedCSS(key: string): Promise<void>
  sendPageFlags(flags: PageFlags): void
  /** Boost "zap element" picker on/off. */
  setZapMode(on: boolean): void
  setBackgroundColor(color: string): void
  focus(): void
  isDestroyed(): boolean
  destroy(): void

  // Placement (driven by the renderer's layout reports). A view belongs to one window at a time.
  attachTo(host: WindowHost): void
  detach(): void
  setBounds(rect: Rect): void
  setBorderRadius(radius: number): void
  setVisible(visible: boolean): void
  isVisible(): boolean
  bringToFront(): void

  // Page operations.
  openDevTools(mode: 'toggle' | 'inspect' | 'console'): void
  downloadURL(url: string): void
  print(): void
  /** Save the page (host decides where / whether to ask); resolves with the saved path or null. */
  savePage(suggestedName: string): Promise<string | null>
  /** Downscaled JPEG data URL of the current paint, for the dimmed preview behind overlays. */
  snapshot(): Promise<string | null>
  /** Full-resolution PNG saved to the downloads location; resolves with the saved path. */
  screenshot(fileName: string): Promise<string | null>
  copyImageAt(x: number, y: number): Promise<boolean>
  replaceMisspelling(word: string): void
  addWordToDictionary(word: string): void

  // AI agents (optional – the core falls back to in-page JavaScript when missing).
  /** Deliver trusted input to the page. */
  sendInput?(event: AgentInputEvent): Promise<void>
  /** Run script in a world the page cannot observe (Electron's isolated world). */
  executeIsolatedJavaScript?(code: string): Promise<unknown>
  /** Let a hidden page keep running at full speed while an agent drives it. */
  setBackgroundThrottling?(allowed: boolean): void
  /**
   * Screenshot for agents: the viewport, the full page or a region. Hosts without it fall back
   * to `snapshot()` (viewport only).
   */
  capture?(options: AgentCaptureOptions): Promise<AgentCapture | null>

  // Site information (optional).
  /** Certificate of the main frame's connection; null on http pages or when unavailable. */
  certificate?(): Promise<SiteCertificate | null>
}

export interface TabViewHost {
  /** Create the live page for `tab`, attached to `host`'s window. */
  createView(tab: Tab, events: TabViewEvents, host: WindowHost): TabView
  /** Shortcut table changed – hosts that pre-filter native key events refresh their copy. */
  setShortcuts?(bindings: KeyBinding[]): void
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/** The host side of one browser window: its chrome web view and native frame. */
export interface WindowHost {
  readonly alive: boolean
  send<K extends EventName>(name: K, payload: Events[K]): void
  focusChrome(): void
  openChromeDevTools(): void
  contentSize(): { width: number; height: number }
  isFullScreen(): boolean
  setFullScreen(fullscreen: boolean): void
  isMaximized(): boolean
  isFocused(): boolean
  isVisible(): boolean
  minimize(): void
  maximize(): void
  unmaximize(): void
  show(): void
  focus(): void
  close(): void
  /** Set the native window title (Alt+Tab / taskbar / Dock); hosts throttle rapid updates. */
  setTitle(title: string): void
  /** Bounds to remember for session restore (null when the host has no movable windows). */
  normalBounds(): Rect | null
  /** Brief vibration for a gesture landmark; hosts without haptics leave this out. */
  haptic?(kind: HapticKind): void
}

export interface WindowCreateInit {
  bounds: Rect | null
  maximized: boolean
  /** Offset the new window from this one (new windows cascade like Firefox). */
  cascadeFrom: ZenWindow | null
  title: string
  /** Solid colour approximating the space gradient, painted before the chrome loads. */
  backgroundColor: string
}

export interface WindowHostFactory {
  create(win: ZenWindow, init: WindowCreateInit): WindowHost
}

// ---------------------------------------------------------------------------
// Menus, dialogs, misc
// ---------------------------------------------------------------------------

export type MenuRole =
  'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle' | 'delete' | 'selectAll'

export interface MenuItemTemplate {
  type?: 'normal' | 'separator' | 'checkbox' | 'radio'
  label?: string
  enabled?: boolean
  checked?: boolean
  role?: MenuRole
  submenu?: MenuItemTemplate[]
  click?: () => void
}

export type MenuSource =
  'page' | 'tab' | 'selection' | 'space' | 'folder' | 'newtab' | 'app' | 'bookmark'

export interface MenuPopupOptions {
  source: MenuSource
  win: ZenWindow
  /** Anchor in chrome CSS pixels (renderer-hosted menus); omitted for native menus. */
  x?: number
  y?: number
}

export interface MenuHost {
  popup(items: MenuItemTemplate[], options: MenuPopupOptions): void
  /** Renderer-hosted menus report clicks/dismissals back through these. */
  activate?(menuId: string, itemId: string): void
  dismiss?(menuId: string): void
}

export interface ConfirmOptions {
  message: string
  detail?: string
  okLabel: string
  cancelLabel: string
  /** Visual hint for destructive confirmations. */
  danger?: boolean
}

export interface PickedTextFile {
  name: string
  text: string
}

export interface SaveTextFileOptions {
  title: string
  /** Suggested file name, extension included (e.g. `bookmarks.html`). */
  defaultName: string
  extensions: string[]
  /** MIME type for hosts whose pickers filter by type (Android's document picker). */
  mimeType: string
  text: string
}

export interface DialogHost {
  confirm(options: ConfirmOptions, win?: ZenWindow): Promise<boolean>
  /** Let the user pick text files (e.g. CSS mods); resolves with their contents. */
  pickTextFiles(
    options: { title: string; extensions: string[] },
    win?: ZenWindow
  ): Promise<PickedTextFile[]>
  /** Save text where the user chooses (bookmark export); false when cancelled or failed. */
  saveTextFile(options: SaveTextFileOptions, win?: ZenWindow): Promise<boolean>
}

export interface ClipboardHost {
  writeText(text: string): void
  /** Fetch an image and put it on the clipboard; resolves false when unsupported / failed. */
  writeImageFromUrl(url: string): Promise<boolean>
}

export interface ShellHost {
  openExternal(url: string): void
  openPath(path: string): Promise<void>
  showItemInFolder(path: string): void
  /**
   * The system share sheet (`capabilities.share`). Resolves once the sheet is up; hosts without
   * one leave it out and the core copies the link instead.
   */
  share?(payload: SharePayload): Promise<void>
  /** The OS screen for which links open in this app (`capabilities.appLinkSettings`). */
  openAppLinkSettings?(): void
}

/**
 * A page asked to leave the web. The host holds the navigation, describes it to the core with
 * `Browser.externalProtocols.request`, and the core answers here once the user (or a remembered
 * choice) has decided; `allow` hands the link to the other app.
 */
export interface ExternalProtocolHost {
  respond(requestId: string, allow: boolean): void
}

export interface NetHost {
  fetchText(
    url: string,
    options: {
      signal?: AbortSignal
      headers?: Record<string, string>
      /** Overall time limit; hosts default to a few seconds (suggestions, Live Folders). */
      timeoutMs?: number
    }
  ): Promise<{ ok: boolean; status: number; text: string }>
}

/** Live-download control; the core keeps the records, the host owns the transfers. */
export interface DownloadHost {
  pause(id: string): void
  resume(id: string): void
  cancel(id: string): void
  open(item: DownloadItem): Promise<void>
  showInFolder(item: DownloadItem): void
}

export interface SessionHost {
  clearContainerData(containerId: string): Promise<void>
  /** Wipe the private-browsing session once its last window closed. */
  clearPrivate(): Promise<void>
}

/** Stored data of a site as the host's storage layer reports it. */
export interface SiteStorageReading {
  usageBytes: number | null
  quotaBytes: number | null
  /** Origins of the site that hold data. */
  origins: string[]
}

/**
 * Cookies and stored data of one site inside a container, for the site-information sheet.
 * Cookie values never cross this boundary – names and attributes are all the chrome shows.
 */
export interface SiteDataHost {
  /** The cookies a page at `url` receives (its host's and its parent domains'). */
  cookies(containerId: string, url: string): Promise<SiteCookie[]>
  storage(containerId: string, site: string): Promise<SiteStorageReading>
  /** Remove the cookies a page at `url` receives; resolves with how many went away. */
  clearCookies(containerId: string, url: string): Promise<number>
  /** Delete the stored data of `site` (hosts that can) or of the given origins (the rest). */
  clearStorage(containerId: string, site: string, origins: string[]): Promise<void>
}

export interface AppHost {
  quit(): void
  /** Quit and start again (after changing the process profile). */
  relaunch(): void
  /** The last browser window closed (desktop hosts quit here except on macOS). */
  lastWindowClosed(): void
  /**
   * Show the app under this icon colour from now on: the launcher alias on Android, the window
   * and taskbar icons (Windows, Linux) or the Dock icon (macOS) on desktop. Called once at start
   * with the persisted choice and again whenever the setting changes.
   */
  setAppIcon?(id: AppIconId): void
  /**
   * Whether this app is the system's default browser. Android answers from the browser role
   * (`app.isDefaultBrowser` over the bridge); hosts without `capabilities.defaultBrowser` resolve
   * null, meaning "not supported here".
   */
  isDefaultBrowser(): Promise<boolean | null>
  /**
   * Ask the system to make this app the default browser (`app.requestDefaultBrowser`): the role
   * dialog on Android 10+, which answers with the outcome; the default-apps settings screen on
   * Android 8–9, which resolves null once the user comes back so the core reads the role again.
   * Unsupported hosts resolve null without doing anything.
   */
  requestDefaultBrowser(): Promise<boolean | null>
}

// ---------------------------------------------------------------------------
// Host-backed services (Electron-only features expose a no-op on other hosts)
// ---------------------------------------------------------------------------

/**
 * The resource governor keeps every Chromium process within the budgets from Settings →
 * Resources. Only Electron can reach the lifecycle machinery (DevTools protocol), so the core
 * talks to it through this interface; `NoopGovernor` loads pages straight away and never acts.
 */
export interface Governor {
  start(): void
  stop(): void
  watchWindow(win: ZenWindow): void
  /**
   * Ask for a background load. Returns true when the page may load now; otherwise it is queued
   * and the governor calls `TabManager.load` once a slot is free.
   */
  requestLoad(tabId: string, windowId: string | undefined): boolean
  /** A page was created outside the queue (visible load); keep the scheduler's counts right. */
  trackLoad(tabId: string): void
  /** Evict a hidden page if the live-page cap would otherwise be exceeded by loading `tabId`. */
  makeRoomFor(tabId: string): void
  onViewCreated(tabId: string, view: TabView): void
  onViewDestroyed(tabId: string, view: TabView): void
  onTabRemoved(tabId: string): void
  onLoadFinished(tabId: string): void
  onMedia(tabId: string, playing: boolean): void
  /** Visible pages of `win` (or every window) must not stay frozen / throttled. */
  wakeVisible(win?: ZenWindow): void
  onSettingsChanged(): void
  /** A frozen page cannot navigate; wake it (quietly) before touching it. */
  thaw(tabId: string, quiet?: boolean): Promise<void>
  record(kind: string, tabId: string | null, reason: string, title?: string): void
  freezeTab(tabId: string): Promise<void>
  wakeTab(tabId: string): Promise<void>
  freezeOthers(): Promise<void>
  wakeAll(): Promise<void>
  sample(): Promise<ResourceSnapshot>
  trim(): Promise<void>
  relaunch(): void
}

/** Browser extensions (Chromium extension API); Electron only. */
export interface ExtensionHost {
  start(): Promise<void>
  list(): ExtensionInfo[]
  /** Load an unpacked folder picked in a native dialog. */
  addFromDialog(win: ZenWindow): Promise<void>
  /** Install a `.crx` or `.zip` picked in a native dialog. */
  installFromFileDialog(win: ZenWindow): Promise<void>
  /** Install from a store by extension id or listing URL. */
  installFromStore(
    ref: string,
    store: 'chrome-web-store' | 'edge-add-ons' | null,
    win?: ZenWindow
  ): Promise<void>
  remove(id: string): Promise<void>
  setEnabled(id: string, enabled: boolean, win?: ZenWindow): Promise<void>
  setPinned(id: string, pinned: boolean): void
  reload(id: string): Promise<void>
  checkForUpdates(win?: ZenWindow): Promise<void>
  update(id: string, win?: ZenWindow): Promise<void>
  openOptions(id: string, win: ZenWindow): void
  openPopup(id: string, anchor: Rect, win: ZenWindow): void
  closePopup(): void
  flushSync(): void
}

/** Cross-device sync through a shared folder; Electron only for now. */
export interface SyncHost {
  start(): void
  status(): SyncStatus
  chooseFolder(win: ZenWindow): Promise<string | null>
  setup(
    opts: { folder: string; passphrase: string; deviceName: string; scope: SyncScope },
    win: ZenWindow
  ): Promise<void>
  setScope(patch: Partial<SyncScope>): void
  setDeviceName(name: string): void
  syncNow(): Promise<void>
  confirmMerge(merge: boolean): Promise<void>
  disconnect(wipeRemote: boolean): void
  flushSync(): void
}

/**
 * The byte transport of the MCP server for AI agents. The core owns the protocol (`agent/http.ts`
 * turns HTTP requests into responses); hosts only listen on a socket and hand requests over.
 */
export interface AgentTransport {
  /** Listen and resolve with the port actually bound plus the LAN addresses (when `lan`). */
  start(options: {
    port: number
    lan: boolean
    onRequest: (request: AgentHttpRequest) => Promise<AgentHttpResponse>
  }): Promise<{ port: number; lanAddresses: string[] }>
  stop(): Promise<void>
}

/**
 * The host side of automatic updates. The core (`updates.ts`) finds the release, validates the
 * manifest and decides which package applies; the host knows how it was installed and does the
 * platform-specific fetch and install: electron-updater on desktop installs that can be swapped
 * in place, a checksummed download plus the system installer elsewhere.
 */
export interface UpdateHost {
  /** How this app was installed (fixed for the lifetime of the process). */
  target(): UpdateTarget
  /** Base64 raw ed25519 public keys built into this app; empty = manifest signatures not enforced. */
  publicKeys(): string[]
  /** Android: hex SHA-256 of the certificate the running app is signed with. */
  signer(): string | null
  /** Android: the running app's applicationId; null on hosts where packages have no identity. */
  packageName(): string | null
  /**
   * Fetch and verify `asset`. Resolves with the local file for `installer` mode (opened by
   * `install`) or null when the update is staged for an in-place install. Rejects with an error
   * named `AbortError` after `cancel()`.
   */
  download(
    release: UpdateRelease,
    asset: UpdateAsset,
    onProgress: (progress: UpdateProgress) => void
  ): Promise<string | null>
  /** Apply the downloaded update: restart into it, or hand the file to the system installer. */
  install(release: UpdateRelease, downloadedPath: string | null): Promise<void>
  cancel(): void
}

// ---------------------------------------------------------------------------
// Passwords: key protection and re-authentication
// ---------------------------------------------------------------------------

/** Passphrase key derivation parameters, recorded in the vault so the writing host can undo it. */
export type KdfParams =
  { kdf: 'scrypt'; n: number; r: number; p: number } | { kdf: 'pbkdf2-sha256'; iterations: number }

/**
 * Why a `KeyWrapHost` refused. Everything but `'invalidated'` is worth asking again for: the user
 * dismissed or failed the system prompt (`'cancelled'`), or the keystore cannot be used right now
 * (`'unavailable'`: a locked keychain, a denied Keychain access request, a silent call against a
 * key that wants a fresh authentication). `'invalidated'` means the wrapped key is gone for good
 * on this device (the screen lock was removed, the keychain item deleted).
 */
export type KeyWrapFailure = 'cancelled' | 'unavailable' | 'invalidated'

export class KeyWrapError extends Error {
  constructor(
    readonly code: KeyWrapFailure,
    message: string
  ) {
    super(message)
    this.name = 'KeyWrapError'
  }
}

/**
 * Protects the vault's random data key with something only this device and user can undo:
 * Electron's `safeStorage` (Keychain, DPAPI, libsecret) on desktop, an Android Keystore key on
 * Android. `wrap` / `unwrap` may show system UI (Android asks for the device credential when the
 * Keystore key demands a recent authentication).
 */
export interface KeyWrapHost {
  /** The OS keystore is usable right now (false on Linux without a secret service). */
  osAvailable(): Promise<boolean>
  /**
   * Opaque, host-specific blob; only this host on this device can `unwrap` it. Rejects with a
   * `KeyWrapError` when the user dismisses the system prompt or the keystore is not usable.
   */
  wrap(dataKey: Uint8Array): Promise<string>
  /**
   * Rejects with a `KeyWrapError` when the OS refuses, the user cancels or the blob was not
   * written here; only `'invalidated'` means the blob will never open again on this device. Only
   * an `interactive` call may put up system UI (Android's device-credential prompt); the silent
   * variant runs at startup and simply fails when the key wants a fresh authentication.
   */
  unwrap(blob: string, interactive: boolean): Promise<Uint8Array>
  /** Parameters this host uses for new passphrase wrappings. */
  kdfParams(): KdfParams
  /** Derive the 32-byte passphrase key (`node:crypto` scrypt on desktop, PBKDF2 elsewhere). */
  deriveKey(passphrase: string, salt: Uint8Array, params: KdfParams): Promise<Uint8Array>
}

/** The OS verifies the user before a password is shown, copied or exported. */
export interface ReauthHost {
  /** Touch ID, Windows Hello, or Android biometrics / device credential can be used right now. */
  available(): Promise<boolean>
  /** Show the OS prompt; resolves true only when the user verified themselves. */
  verify(reason: string, win?: ZenWindow): Promise<boolean>
}

export interface PasswordsHost {
  keys: KeyWrapHost
  reauth: ReauthHost
}

export interface Platform {
  readonly info: PlatformInfo
  readonly capabilities: HostCapabilities
  readonly io: StoreIO
  readonly windows: WindowHostFactory
  readonly views: TabViewHost
  readonly menus: MenuHost
  readonly dialogs: DialogHost
  readonly clipboard: ClipboardHost
  readonly shell: ShellHost
  readonly net: NetHost
  readonly downloads: DownloadHost
  readonly sessions: SessionHost
  readonly app: AppHost
  /** Cookies and storage per site; hosts without it show a sheet with the connection only. */
  readonly siteData?: SiteDataHost
  /** Hosts that ask before a page may open another app (Android). */
  readonly externalProtocols?: ExternalProtocolHost
  /** Key protection and re-authentication for the password vault; omit when `capabilities.passwords` is off. */
  readonly passwords?: PasswordsHost
  /** Source of Mozilla's Readability library for Reader View, or null when unavailable. */
  readabilitySource(file: 'Readability.js' | 'Readability-readerable.js'): string | null
  /** Host-backed services; omit for the built-in no-op versions. */
  createGovernor?(browser: Browser): Governor
  createExtensions?(browser: Browser): ExtensionHost
  createSync?(browser: Browser): SyncHost
  createAgentTransport?(browser: Browser): AgentTransport
  createUpdateHost?(browser: Browser): UpdateHost
}

/** Schedule work for the next macrotask in Node and browsers alike. */
export function defer(fn: () => void): void {
  const g = globalThis as { setImmediate?: (cb: () => void) => void }
  if (typeof g.setImmediate === 'function') g.setImmediate(fn)
  else setTimeout(fn, 0)
}
