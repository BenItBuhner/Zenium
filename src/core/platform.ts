/**
 * The seam between Zen's browser core and the host it runs on.
 *
 * The core (`src/core`) owns every behaviour the user can observe – tabs, spaces, split views,
 * Glance, shortcuts, history, downloads – and talks to the outside world only through the
 * interfaces in this file. Electron implements them with `WebContentsView`/`Menu`/`dialog`
 * (`src/main/platform`); Android implements them with a Kotlin host reached over a JS bridge
 * (`src/android`). Nothing in `src/core` may import from `electron`, `node:*` or the DOM.
 */
import type {
  DownloadItem,
  EventName,
  Events,
  KeyBinding,
  Platform as PlatformOs,
  Rect,
  Tab
} from '../shared/types'
import type { KeyInput } from '../shared/shortcuts'

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
  type: 'glance' | 'open-tab' | 'navigate' | 'media'
  url?: string
  x?: number
  y?: number
  background?: boolean
  /** `media`: whether any media element is currently playing. */
  playing?: boolean
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

/** Callbacks a host fires for one tab view. All are optional to implement on the host side. */
export interface TabViewEvents {
  onStartLoading(): void
  onStopLoading(): void
  /** Main-frame navigation committed (`inPage` for pushState / hash changes). */
  onNavigated(url: string, inPage: boolean): void
  onTitleUpdated(title: string): void
  onFaviconUpdated(favicons: string[]): void
  /** Main-frame load failure (Chromium `net::` error code; hosts map their own codes). */
  onFailLoad(code: number, description: string, url: string): void
  onCrashed(reason: string): void
  onAudioStateChanged(audible: boolean): void
  onMediaStateChanged(): void
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
  sendPageFlags(flags: PageFlags): void
  setBackgroundColor(color: string): void
  focus(): void
  isDestroyed(): boolean
  destroy(): void

  // Placement (driven by the renderer's layout reports).
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
  createView(tab: Tab, events: TabViewEvents): TabView
  /** Shortcut table changed – hosts that pre-filter native key events refresh their copy. */
  setShortcuts?(bindings: KeyBinding[]): void
}

// ---------------------------------------------------------------------------
// Chrome (the renderer) & window
// ---------------------------------------------------------------------------

export interface ChromeHost {
  send<K extends EventName>(name: K, payload: Events[K]): void
  focus(): void
  openDevTools(): void
}

export interface WindowHost {
  contentSize(): { width: number; height: number }
  isFullScreen(): boolean
  setFullScreen(fullscreen: boolean): void
  isMaximized(): boolean
  minimize(): void
  maximize(): void
  unmaximize(): void
  close(): void
}

// ---------------------------------------------------------------------------
// Menus, dialogs, misc
// ---------------------------------------------------------------------------

export type MenuRole =
  'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle' | 'delete' | 'selectAll'

export interface MenuItemTemplate {
  type?: 'normal' | 'separator' | 'checkbox'
  label?: string
  enabled?: boolean
  checked?: boolean
  role?: MenuRole
  submenu?: MenuItemTemplate[]
  click?: () => void
}

export type MenuSource = 'page' | 'tab' | 'space' | 'folder' | 'newtab' | 'app'

export interface MenuPopupOptions {
  source: MenuSource
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

export interface DialogHost {
  confirm(options: ConfirmOptions): Promise<boolean>
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
  ): Promise<{ ok: boolean; text: string }>
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
}

export interface AppHost {
  quit(): void
  downloadsDirectory(): string
}

export interface Platform {
  readonly info: PlatformInfo
  readonly io: StoreIO
  readonly chrome: ChromeHost
  readonly window: WindowHost
  readonly views: TabViewHost
  readonly menus: MenuHost
  readonly dialogs: DialogHost
  readonly clipboard: ClipboardHost
  readonly shell: ShellHost
  readonly net: NetHost
  readonly downloads: DownloadHost
  readonly sessions: SessionHost
  readonly app: AppHost
}

/** Schedule work for the next macrotask in Node and browsers alike. */
export function defer(fn: () => void): void {
  const g = globalThis as { setImmediate?: (cb: () => void) => void }
  if (typeof g.setImmediate === 'function') g.setImmediate(fn)
  else setTimeout(fn, 0)
}
