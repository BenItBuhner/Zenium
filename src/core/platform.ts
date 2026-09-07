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
  HostCapabilities,
  KeyBinding,
  Platform as PlatformOs,
  Rect,
  ResourceSnapshot,
  SyncScope,
  SyncStatus,
  Tab
} from '../shared/types'
import type { KeyInput } from '../shared/shortcuts'
import type { Browser } from './browser'
import type { ZenWindow } from './window'

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
  /** Bounds to remember for session restore (null when the host has no movable windows). */
  normalBounds(): Rect | null
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

export type MenuSource = 'page' | 'tab' | 'selection' | 'space' | 'folder' | 'newtab' | 'app'

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

export interface DialogHost {
  confirm(options: ConfirmOptions, win?: ZenWindow): Promise<boolean>
  /** Let the user pick text files (e.g. CSS mods); resolves with their contents. */
  pickTextFiles(
    options: { title: string; extensions: string[] },
    win?: ZenWindow
  ): Promise<PickedTextFile[]>
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
}

export interface NetHost {
  fetchText(
    url: string,
    options: { signal?: AbortSignal; headers?: Record<string, string> }
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

export interface AppHost {
  quit(): void
  /** Quit and start again (after changing the process profile). */
  relaunch(): void
  /** The last browser window closed (desktop hosts quit here except on macOS). */
  lastWindowClosed(): void
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
  addFromDialog(win: ZenWindow): Promise<void>
  remove(id: string): void
  setEnabled(id: string, enabled: boolean): Promise<void>
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
  /** Source of Mozilla's Readability library for Reader View, or null when unavailable. */
  readabilitySource(file: 'Readability.js' | 'Readability-readerable.js'): string | null
  /** Host-backed services; omit for the built-in no-op versions. */
  createGovernor?(browser: Browser): Governor
  createExtensions?(browser: Browser): ExtensionHost
  createSync?(browser: Browser): SyncHost
}

/** Schedule work for the next macrotask in Node and browsers alike. */
export function defer(fn: () => void): void {
  const g = globalThis as { setImmediate?: (cb: () => void) => void }
  if (typeof g.setImmediate === 'function') g.setImmediate(fn)
  else setTimeout(fn, 0)
}
