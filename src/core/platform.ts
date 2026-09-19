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
  CertificateDetails,
  ClipboardPeekKind,
  ColorScheme,
  ContentCover,
  DownloadItem,
  EventName,
  Events,
  ExtensionInfo,
  ExtensionUpdateCheck,
  HapticKind,
  HostCapabilities,
  KeyBinding,
  NavigationSnapshot,
  NewTabPageAction,
  NewTabPageCommand,
  NewTabPageState,
  PageDialogResponse,
  PageRules,
  PermissionPrompt,
  PermissionPromptAnswer,
  Platform as PlatformOs,
  Rect,
  ResourceSnapshot,
  SharePayload,
  ShortcutAction,
  SidePanelInfo,
  Suggestion,
  SyncScope,
  SyncStatus,
  Tab,
  WindowChrome,
  WindowMaterial
} from '../shared/types'
import type { AppIconId } from '../shared/appIcon'
import type { FormsCommand, FormsEvent } from '../shared/forms'
import type { PageHint } from '../shared/fullscreenHint'
import type { CaptionColors } from '../shared/theme'
import type { KeyInput } from '../shared/shortcuts'
import type { SiteCertificate, SiteCookie } from '../shared/siteInfo'
import type {
  ByteSource,
  EngineAssets,
  EngineRelayResponse,
  EngineTransport
} from '../shared/translateEngine'
import type { UpdateAsset, UpdateProgress, UpdateRelease, UpdateTarget } from '../shared/updates'
import type { InterstitialAction } from '../shared/interstitial'
import type { PrivacyFlags, SafeBrowsingHit } from '../shared/privacy'
import type { RawWebAppManifest, ShortcutIconKind } from '../shared/webApp'
import type { Browser } from './browser'
import type { ZenWindow } from './window'
import type { AgentHttpRequest, AgentHttpResponse } from './agent/http'
import type { RuleSet } from './blocking/rules'

export interface PlatformInfo {
  os: PlatformOs
  version: string
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Raw text storage for the JSON stores (one document per name). */
/** How a document is written. */
export interface StoreWriteOptions {
  /**
   * Keep the previous version as `<name>.bak` (rolling: every write moves the document that was
   * there aside). For the profile's core documents, whose loss would be the loss of the session.
   * Hosts that cannot leave this out; the core reads the backup when the document is gone or
   * unreadable.
   */
  backup?: boolean
}

export interface StoreIO {
  /** Synchronous read at startup; `null` when the document does not exist. */
  readSync(name: string): string | null
  /** Atomic write; the promise settles once the document is durable. */
  write(name: string, text: string, options?: StoreWriteOptions): Promise<void>
  /** Synchronous write used when the process is about to go away. */
  writeSync(name: string, text: string, options?: StoreWriteOptions): void
  /** Delete a document (missing documents are not an error). Hosts without it get a `{}` tombstone. */
  remove?(name: string): Promise<void>
  /** Whether a document exists without reading it (large documents such as filter lists). */
  exists?(name: string): boolean
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

/**
 * How a page is about to navigate itself (its Navigation API `navigate` event), reported just
 * before its `beforeunload` handlers run. A host whose engine answers `beforeunload` at once
 * (Electron) keeps the page and asks the user asynchronously; the record tells it what the
 * page was doing (a reload is asked about differently) and that the page can redo it.
 */
export interface NavigationIntent {
  /** Where the page is going. */
  url: string
  navigationType: 'push' | 'replace' | 'reload' | 'traverse'
  /** A form submission with a body. */
  post: boolean
}

/** Messages the page script sends back to the browser. */
export interface PageMessage {
  type:
    | 'glance'
    | 'open-tab'
    | 'navigate'
    | 'media'
    | 'zap'
    | 'activation'
    | 'popup-blocked'
    /** The page called `window.focus()` with a gesture (a notification was clicked): show its tab. */
    | 'focus'
    | 'interstitial'
    | 'navigate-intent'
    /** The forms script reports fields, submissions and passkey requests (`forms`). */
    | 'forms'
    /** The page script posted the web app manifest, or the site's `beforeinstallprompt` moves. */
    | 'webapp'
    /**
     * The page links an OpenSearch description (`<link rel="search"
     * type="application/opensearchdescription+xml">`): `url` is the description's absolute
     * address, `title` the link's title if any. The core fetches and parses it (`shared/search`).
     */
    | 'opensearch'
  url?: string
  /** `opensearch`: the link's `title` attribute, the engine's name when the XML has none. */
  title?: string
  x?: number
  y?: number
  background?: boolean
  /** `media`: whether any media element is currently playing. */
  playing?: boolean
  /** `zap`: CSS selector of the element the user picked in Boost zap mode. */
  selector?: string
  /** `interstitial`: the button pressed on a Zenium warning page (see `shared/zenPages`). */
  action?: InterstitialAction
  /** `navigate-intent`: the navigation the page is starting (consumed by the host, not the core). */
  intent?: NavigationIntent
  /** `forms`: what the forms script saw (a focused field, a submit, a passkey). */
  forms?: FormsEvent
  /**
   * `webapp`: `manifest` carries the page's web app manifest (or only its URL when the page
   * could not fetch it), `deferred` says the site took over the install prompt
   * (`beforeinstallprompt` was cancelled) and `prompt` that it now wants the prompt shown.
   */
  webapp?: 'manifest' | 'deferred' | 'prompt'
  manifestUrl?: string
  manifest?: RawWebAppManifest | null
}

/** Messages the browser posts into a page for its page script (the web-app polyfill). */
export interface PageHostMessage {
  type: 'webapp'
  /**
   * `installable`: fire `beforeinstallprompt`; `result`: settle a pending `prompt()` with
   * `outcome`; `installed`: fire `appinstalled`.
   */
  action: 'installable' | 'result' | 'installed'
  outcome?: 'accepted' | 'dismissed'
}

/** What a host reports when a page calls `alert`, `confirm` or `prompt`. */
export interface PageDialogRequest {
  kind: 'alert' | 'confirm' | 'prompt'
  message: string
  /** `prompt`: the second argument, already a string ('' when absent). */
  defaultValue: string
  /** URL of the frame that called; the dialog is titled after its site. */
  frameUrl: string
  /** URL of the top document, to tell an embedded page's dialog from the page's own. */
  pageUrl: string
}

/** What a host knows about a failed main-frame load beyond its code. */
export interface LoadDetails {
  /**
   * An `ERR_CERT_*` failure: the server certificate Zenium refused, which the interstitial shows
   * and the session's exception is keyed by. Null when the host could not describe it.
   */
  certificate?: CertificateDetails | null
}

export interface PageContextParams {
  /** Click position in the view's coordinates (DIP), as the host's `context-menu` event gives it. */
  x: number
  y: number
  linkURL: string
  /** Text of the clicked link (Edge's "Copy link text"); empty for image links. */
  linkText?: string
  srcURL: string
  mediaType: 'none' | 'image' | 'audio' | 'video' | 'canvas' | 'file' | 'plugin'
  /** State of the clicked `<video>` / `<audio>`; hosts that cannot tell leave it out. */
  mediaFlags?: MediaContextFlags
  selectionText: string
  isEditable: boolean
  misspelledWord: string
  dictionarySuggestions: string[]
  /** URL of the top-level document (extension context menus report it as `pageUrl`). */
  pageURL?: string
  /** URL of the sub-frame the click landed in; empty for the top-level document. */
  frameURL?: string
  /** Chrome's frame id of the clicked frame: 0 for the top-level document. */
  frameId?: number
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

/** Chromium's media flags of a clicked media element (the subset the menus read). */
export interface MediaContextFlags {
  inError: boolean
  isPaused: boolean
  isMuted: boolean
  hasAudio: boolean
  isLooping: boolean
  isControlsVisible: boolean
  canToggleControls: boolean
  canSave: boolean
  canShowPictureInPicture: boolean
  isShowingPictureInPicture: boolean
  canLoop: boolean
}

/**
 * Chrome elements with a context menu of their own, marked `data-zen-menu` in the renderer: the
 * URL bar's field and pill, the reload button.
 */
export type ChromeMenuTarget = 'urlbar' | 'urlpill' | 'reload'

export const CHROME_MENU_TARGETS: readonly ChromeMenuTarget[] = ['urlbar', 'urlpill', 'reload']

/**
 * A right-click inside the chrome document (URL bar, toolbar, overlays): what the host's own
 * `context-menu` event says about the spot, plus which marked chrome element it landed on
 * (`data-zen-menu` in the renderer; null when none).
 */
export interface ChromeContextParams {
  /** Click position in chrome CSS pixels. */
  x: number
  y: number
  /** `data-zen-menu` of the innermost marked element under the pointer, or null. */
  target: ChromeMenuTarget | null
  /** Tab the marked element acts on (`data-zen-menu-tab`); null for a new-tab URL bar. */
  tabId: string | null
  isEditable: boolean
  selectionText: string
  editFlags: PageContextParams['editFlags']
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
 * One frame of a page's frame tree, for agents that reach into iframes. Ids are Chrome's frame
 * ids (`PageContextParams.frameId`): `0` for the top frame, the frame tree node id – stable for
 * the frame's lifetime, across its navigations – for every other frame.
 */
export interface AgentFrame {
  id: number
  /** `null` for the top frame. */
  parentId: number | null
  url: string
  /** The serialised origin; `"null"` for opaque origins (sandboxed frames, `data:` documents). */
  origin: string
  /** The frame's `window.name`. */
  name: string
  /** Whether this frame holds the page's keyboard focus. */
  focused: boolean
}

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
  /** Load progress 0…1 from hosts that measure it (Android); optional between start and stop. */
  onProgress(progress: number): void
  /** Main-frame navigation committed (`inPage` for pushState / hash changes). */
  onNavigated(url: string, inPage: boolean): void
  onTitleUpdated(title: string): void
  onFaviconUpdated(favicons: string[]): void
  /**
   * Main-frame load failure (Chromium `net::` error code; hosts map their own codes). For an
   * `ERR_CERT_*` failure `details.certificate` describes the certificate the host refused.
   */
  onFailLoad(code: number, description: string, url: string, details?: LoadDetails): void
  /**
   * The host's request engine upgraded a main-frame navigation from `from` (http) to `to`
   * (HTTPS-only mode's rule); if `to` then fails, the tab offers `from`.
   */
  onUpgraded(from: string, to: string): void
  /**
   * The host's request engine refused a main-frame navigation to `url` on Safe Browsing's word
   * (Android, whose guard reads the tables itself); `onFailLoad` follows with the same URL.
   */
  onUnsafeNavigation(url: string, hit: SafeBrowsingHit): void
  onCrashed(reason: CrashReason): void
  onAudioStateChanged(audible: boolean): void
  onMediaStateChanged(playing: boolean): void
  /** The host's own request engine blocked `count` more requests of this page (Android). */
  onRequestsBlocked(count: number): void
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
  /** The page went away underneath the tab (it called `window.close()`, or the host tore it down). */
  onDestroyed(): void
  /**
   * `window.open` / Shift+click / `target=_blank`: how the core wants the new page placed, or
   * null to refuse it (the pop-up blocker said no, or the URL cannot be opened). The host never
   * shows Chromium's own bare window. `userGesture` is the host's own knowledge of whether the
   * user asked for it (null when it has none: the core then relies on the activation it tracked
   * through `onUserActivation`). `features` is the `window.open` features string (empty for
   * Shift+click).
   */
  onOpenWindow(
    url: string,
    disposition: WindowOpenDisposition,
    userGesture: boolean | null,
    features?: string
  ): WindowOpenTicket | null
  /** A trusted input event (click, key, tap) was delivered to the page. */
  onUserActivation(): void
  onPageMessage(message: PageMessage): void
  /**
   * The page called `alert`, `confirm` or `prompt`; resolves with the chrome's answer. The
   * page's renderer waits for it, as in Chrome.
   */
  onDialog(request: PageDialogRequest): Promise<PageDialogResponse>
  /**
   * The page's `beforeunload` handler objects to it going away – under a navigation, a reload,
   * or the close the host is carrying out. Resolves true when the user leaves anyway.
   */
  onLeaveSite(reload: boolean): Promise<boolean>
  /** `zen://newtab` asked for something (hosts route the page's dedicated channel here). */
  onNewTabAction(action: NewTabPageAction): void
}

/**
 * The core's answer to a page opening a window: a tab in the opener's window or a Zenium window
 * (toolbar-only for a sized popup, full for Shift+click). The host completes it once by handing
 * over the page that goes into the new tab: the opener-linked one Chromium already created for a
 * script `window.open` (so `window.opener` and the call's return value keep working, as in
 * Chrome), or a fresh page the host then points at `url` for a window opened from a link. The
 * window and tab only exist once `adopt` runs, so a request Chromium abandons leaves nothing
 * behind.
 */
export interface WindowOpenTicket {
  action: 'tab' | 'window'
  url: string
  /** Register `view` as the new tab's page; returns the tab and the events to wire to the view. */
  adopt(view: TabView): { tab: Tab; events: TabViewEvents }
}

/**
 * One live web page. Mirrors the subset of Electron's `WebContentsView` + `WebContents` the core
 * uses; on Android every method is a call into the Kotlin host.
 */
export interface TabView {
  loadURL(url: string): void
  /**
   * Show the `zen://error` page `url` in place of the document a failed load left behind, under
   * the failed address's own history entry, so back leads to the page before and a load of the
   * address asks for it again (Chrome's interstitials live in the failed entry). The core uses it
   * for the certificate interstitial; hosts without it get the page loaded as a document of its
   * own, and the core then keeps `zen://error` as the tab's URL.
   */
  showErrorPage?(url: string): void
  getURL(): string
  getTitle(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  /** Jump to an entry of the back/forward stack (an index of `navigationEntries()`). */
  goToIndex(index: number): void
  /** The back/forward stack as URLs and titles, and which entry is current. */
  navigationEntries(): NavigationSnapshot
  /**
   * Replace the back/forward stack with `snapshot` and load its current entry (a reopened tab
   * gets its history back). Hosts that cannot rebuild the stack load the current URL instead.
   */
  restoreNavigation(snapshot: NavigationSnapshot): Promise<void>
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
  /**
   * Run `code` in the page's main frame, or in the sub-frame `frameId`
   * (`PageContextParams.frameId`) on hosts that can address frames – rejecting when that frame
   * is gone; hosts without frames run it in the main frame.
   */
  executeJavaScript(code: string, frameId?: number): Promise<unknown>
  /** Inject a stylesheet; resolves with a key for `removeInsertedCSS`. */
  insertCSS(css: string): Promise<string>
  removeInsertedCSS(key: string): Promise<void>
  sendPageFlags(flags: PageFlags): void
  /**
   * Hosts whose engine blocks pop-ups itself (the Android WebView) learn whether the page's site
   * may open windows without a gesture; Electron leaves the decision to the core.
   */
  setPopupsAllowed?(allowed: boolean): void
  /** Boost "zap element" picker on/off. */
  setZapMode(on: boolean): void
  /** Autofill: fill values into the page's form, or reconfigure the forms script. */
  sendFormsCommand?(command: FormsCommand): void

  /**
   * Draw a fullscreen hint over the page (null takes it down): a page in fullscreen covers the
   * chrome, so the hint is the page script's. Hosts whose chrome stands over such a page leave
   * this out and draw their own.
   */
  showHint?(hint: PageHint | null): void
  setBackgroundColor(color: string): void
  focus(): void
  /** Whether this page holds the keyboard right now. Hosts that cannot tell leave it out. */
  isFocused?(): boolean
  isDestroyed(): boolean
  destroy(): void
  /**
   * Whether the page may be unloaded: runs its `beforeunload` handlers and, when one objects,
   * has the chrome ask ("Leave site?"). Resolves true when the page can go – no objection, the
   * user chose to leave, or the page is gone already – and false when it stays. A page with no
   * objection may be destroyed by the check itself (its close simply goes ahead). Hosts whose
   * engine cannot run the handlers without unloading leave this out.
   */
  confirmUnload?(): Promise<boolean>

  // Placement (driven by the renderer's layout reports). A view belongs to one window at a time.
  attachTo(host: WindowHost): void
  detach(): void
  setBounds(rect: Rect): void
  setBorderRadius(radius: number): void
  setVisible(visible: boolean): void
  isVisible(): boolean
  bringToFront(): void
  /**
   * Chrome messages (toasts, banners) cover these strips of the view's edges. Hosts whose pages
   * are layered above the chrome clip the page out of the strips – animating the clip so it
   * moves with the message – and hand touches inside them to the chrome. Optional: on Electron
   * the chrome draws over the page as it is.
   */
  setCover?(cover: ContentCover): void

  // Page operations.
  openDevTools(mode: 'toggle' | 'inspect' | 'console'): void
  /**
   * Open the developer tools on the element at (`x`, `y`) in the view's coordinates (the
   * "Inspect Element" of the context menu). Hosts without an inspector leave it out.
   */
  inspectElementAt?(x: number, y: number): void
  /**
   * Start a download of `url`. `saveAs` asks where to save first, whatever the download setting
   * says (Chrome's "Save link / image / video as…" always ask); hosts without a picker save to
   * the downloads folder.
   */
  downloadURL(url: string, options?: { saveAs?: boolean }): void
  /** Reload one sub-frame of the page (`PageContextParams.frameId`); hosts without frames leave it out. */
  reloadFrame?(frameId: number): void
  /** Drop the HTTP cache of the page's session ("Empty Cache and Hard Reload"); optional. */
  clearCache?(): Promise<void>
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
  /**
   * Deliver trusted input to the page, at top-viewport CSS coordinates. The host routes it to
   * the frame under the point (content inside cross-origin iframes included), so it behaves as
   * a person's input would: `isTrusted`, user activation, pop-ups and autoplay allowed.
   */
  sendInput?(event: AgentInputEvent): Promise<void>
  /** Run script in a world the page cannot observe (Electron's isolated world). */
  executeIsolatedJavaScript?(code: string): Promise<unknown>
  /**
   * The page's frame tree (the top frame first, then every sub-frame, parents before children).
   * Hosts that cannot address frames leave it out; agents then only see the top document plus
   * the same-origin frames its script can enter.
   */
  frames?(): AgentFrame[]
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

  // Page controls (optional – hosts without them, Electron today, present pages as they are).
  /**
   * Desktop site: a desktop user agent and client hints plus the desktop layout width. Takes
   * effect on the next load; the core reloads when the user asks for it.
   */
  setDesktopMode?(on: boolean): void
  /**
   * Darken a page that has no dark theme of its own (algorithmic darkening). Hosts apply it only
   * while the chrome itself is dark; pages that declare `color-scheme: dark` are left alone.
   */
  setDarkening?(on: boolean): void

  // The new tab page (optional – hosts without `capabilities.newTabPage` leave it out).
  /** Push fresh state into a `zen://newtab` page (theme, settings, shortcuts, most visited). */
  sendNewTabState?(state: NewTabPageState): void
  /** Tell a `zen://newtab` page to carry out what its tile menu picked (remove, with Undo). */
  sendNewTabCommand?(command: NewTabPageCommand): void
  // Web apps (optional): browser → page-script messages for the install-prompt polyfill.
  postToPage?(message: PageHostMessage): void
}

export type { PageRules } from '../shared/types'

export interface TabViewHost {
  /** Create the live page for `tab`, attached to `host`'s window. */
  createView(tab: Tab, events: TabViewEvents, host: WindowHost): TabView
  /**
   * A view created for one tab id now belongs to another (a new tab page preloaded under a
   * placeholder id becomes a real tab); hosts that map their web contents to tabs update the map.
   */
  retargetView?(view: TabView, tabId: string): void
  /** Shortcut table changed – hosts that pre-filter native key events refresh their copy. */
  setShortcuts?(bindings: KeyBinding[]): void
  /** Page controls changed – hosts that decide per navigation refresh their copy of the rules. */
  setPageRules?(rules: PageRules): void
}

/**
 * The custom background image of the new tab page. The host owns the bytes (a copy of the picked
 * file in its profile directory, served to the page under `zen://newtab-background`); the core
 * only ever sees the address it hands the page.
 */
export interface NewTabBackgroundHost {
  /**
   * Address of the current image, or null when none is set: a `zen://` address where the host
   * serves the file (the desktop's page), a data URL where the chrome paints the page itself
   * (the phone's).
   */
  current(): string | null
  /**
   * Let the user pick an image file with the host's dialog; resolves with its new address, or
   * null when cancelled. Hosts without a file dialog leave it out and take `set` instead.
   */
  pick?(win: ZenWindow): Promise<string | null>
  /**
   * Keep an image the chrome read itself (the phone's file chooser hands the page a data URL),
   * or with null let it go. Throws when the data is not an image or too large to keep.
   */
  set?(dataUrl: string | null): Promise<void>
  clear(): Promise<void>
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/** The host side of one browser window: its chrome web view and native frame. */
export interface WindowHost {
  readonly alive: boolean
  send<K extends EventName>(name: K, payload: Events[K]): void
  focusChrome(): void
  /**
   * Which document holds the keyboard: the chrome's own, some other web view (a tab view, which
   * the core recognises through `TabView.isFocused`, or a view another surface owns, such as an
   * extension's popup), or none. Hosts that cannot tell leave it out.
   */
  focusedDocument?(): 'chrome' | 'other' | 'none'
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
  /**
   * Where the chrome's document sits on the screen right now (DIP), for turning a screen point
   * into chrome coordinates; hosts without movable windows leave this out.
   */
  contentBounds?(): Rect | null
  /** The display the window is on (the host's id), remembered with its bounds; hosts with one display leave this out. */
  displayId?(): number | null
  /** Brief vibration for a gesture landmark; hosts without haptics leave this out. */
  haptic?(kind: HapticKind): void
  /** Recolour the native caption buttons drawn over the chrome (hosts with an overlay). */
  setCaptionColors?(colors: CaptionColors): void
  /**
   * The marked chrome element (`data-zen-menu`) under a point of the chrome document, for the
   * chrome's own context menus; hosts whose chrome draws its menus itself leave it out.
   */
  menuTargetAt?(x: number, y: number): Promise<{ target: string; tabId: string | null } | null>
}

export interface WindowCreateInit {
  bounds: Rect | null
  /** The display `bounds` were saved on; the window goes back to it when it is still there. */
  displayId: number | null
  maximized: boolean
  /** Offset the new window from this one (new windows cascade like Firefox). */
  cascadeFrom: ZenWindow | null
  title: string
  chrome: WindowChrome
  material: WindowMaterial
  /** Solid colour approximating the space gradient, painted before the chrome loads. */
  backgroundColor: string
  /** Colours for native caption buttons drawn over the chrome. */
  captionColors: CaptionColors
}

export interface WindowHostFactory {
  create(win: ZenWindow, init: WindowCreateInit): WindowHost
}

// ---------------------------------------------------------------------------
// Menus, dialogs, misc
// ---------------------------------------------------------------------------

/**
 * Items the host implements itself. The editing roles work in every menu; the rest are the
 * standard entries of a macOS menu bar (`window`, `help` and `services` mark a whole submenu as
 * the system's Window, Help or Services menu).
 */
export type MenuRole =
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'pasteAndMatchStyle'
  | 'delete'
  | 'selectAll'
  | 'startSpeaking'
  | 'stopSpeaking'
  | 'about'
  | 'services'
  | 'hide'
  | 'hideOthers'
  | 'unhide'
  | 'quit'
  | 'minimize'
  | 'zoom'
  | 'front'
  | 'window'
  | 'help'

export interface MenuItemTemplate {
  type?: 'normal' | 'separator' | 'checkbox' | 'radio'
  label?: string
  enabled?: boolean
  checked?: boolean
  role?: MenuRole
  /**
   * A favicon or extension icon (`data:` URL) shown before the label where the host's menus can
   * (recently closed entries, `chrome.contextMenus` items).
   */
  icon?: string | null
  submenu?: MenuItemTemplate[]
  click?: () => void
  /**
   * The shortcut action the item stands for. The core fills `accelerator` from the active key
   * table, and runs the action when the item has no `click` of its own.
   */
  action?: ShortcutAction
  /**
   * The chord shown after the label, in Electron's accelerator syntax (`Ctrl+Shift+N`; macOS
   * draws it as glyphs). Display only: the key table handles the keys, so hosts must not
   * register it.
   */
  accelerator?: string
}

export type MenuSource =
  | 'page'
  | 'tab'
  | 'selection'
  | 'space'
  | 'folder'
  | 'newtab'
  | 'topsite'
  | 'app'
  | 'bookmark'
  | 'history'
  | 'download'
  | 'urlbar'

export interface MenuPopupOptions {
  source: MenuSource
  win: ZenWindow
  /**
   * Where to open, in chrome CSS pixels: the anchor of renderer-hosted menus, and of native menus
   * opened from a control rather than the pointer. Omitted: native menus open at the pointer.
   */
  x?: number
  y?: number
  /** Opened by the keyboard: the first item starts selected so the arrow keys take over at once. */
  keyboard?: boolean
}

export interface MenuHost {
  popup(items: MenuItemTemplate[], options: MenuPopupOptions): void
  /** Renderer-hosted menus report clicks/dismissals back through these. */
  activate?(menuId: string, itemId: string): void
  dismiss?(menuId: string): void
  /**
   * Hosts with a menu bar (macOS) show `menus` as the application menu: one entry per top-level
   * menu, roles where the system provides the menu. Called at start and whenever what the menus
   * show changed; hosts without a menu bar leave it out.
   */
  setApplicationMenu?(menus: MenuItemTemplate[]): void
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
  /**
   * Let the user pick files to open as pages ("Open File…"); resolves with their paths, empty
   * when cancelled. Hosts whose pages cannot show local files leave it out.
   */
  pickFiles?(options: { title: string }, win?: ZenWindow): Promise<string[]>
}

/**
 * Where permission prompts are shown. The core's own implementation queues them per tab for the
 * chrome to render as non-modal bubbles (answered by `permissions.respond`); a host may supply
 * its own through `Platform.permissionPrompts` instead.
 */
export interface PermissionPromptHost {
  /** Show the prompt; resolves with the user's answer, or null when it was withdrawn unanswered. */
  show(request: PermissionPrompt): Promise<PermissionPromptAnswer | null>
  /** Withdraw a pending prompt (its page navigated away, its tab closed). */
  cancel(id: string): void
}

export interface ClipboardHost {
  /**
   * `sensitive` marks a password or card number: hosts whose clipboard has a preview (Android 13+
   * `ClipDescription.EXTRA_IS_SENSITIVE`) hide the value there; the core clears it again after
   * the configured timeout through `clearText`.
   */
  writeText(text: string, sensitive?: boolean): void
  /** Fetch an image and put it on the clipboard; resolves false when unsupported / failed. */
  writeImageFromUrl(url: string): Promise<boolean>
  /**
   * The clipboard's plain text ('' when it holds none). Hosts that cannot read the clipboard
   * leave it out; the URL bar's paste-and-go actions then do nothing.
   */
  readText?(): Promise<string>
  /**
   * Empty the clipboard if it still holds exactly `expected` (a secret copied earlier); a
   * clipboard the user has meanwhile used for something else is left alone. Hosts without it
   * cannot clear, and the core says so in the copy toast.
   */
  clearText?(expected: string): Promise<void>
  /**
   * What the clipboard holds, from its DESCRIPTION alone (Android's
   * `getPrimaryClipDescription()`: mime types, the system's URL classification, the sensitive
   * flag, the timestamp) – never its content, which Android 12+ announces to the user with a
   * toast. Hosts with it get the URL bar's "Link you copied" / "Text you copied" row; `none`
   * for an empty, stale (over ten minutes), sensitive or unreadable clip.
   */
  peek?(): Promise<ClipboardPeekKind>
  /**
   * The clipboard's text, read ONCE when the user reveals or picks the clipboard row (the
   * system may toast the read); '' when it holds none.
   */
  read?(): Promise<string>
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

/**
 * What the host does with the privacy settings the core cannot enforce from inside the request
 * engine's rule sets: the third-party cookie policy, the `Sec-GPC` / `DNT` headers and their
 * `navigator` flags, the plaintext exemptions of HTTPS-only mode (applied at once, before the
 * rule set catches up on hosts that compile it asynchronously) and, on desktop, secure DNS.
 * `apply` runs once the browser is up and again after every change; the host keeps the copy.
 */
export interface PrivacyHost {
  apply(flags: PrivacyFlags): void
  /**
   * The Safe Browsing feed table this build ships for `id` (the JSON document
   * `SafeBrowsingService` persists, as text), or null when the build has no snapshot of it.
   */
  bundledSafeBrowsingFeed?(id: string): Promise<string | null>
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
  ): Promise<{
    ok: boolean
    status: number
    text: string
    /** Response headers the caller may condition a later fetch on (`etag`, `last-modified`), lowercase names. */
    headers?: Record<string, string>
  }>
  /**
   * Whether `host` resolves in DNS (Chrome's intranet probe behind "Did you mean to go to
   * http://host/?"). Resolves false on any failure; hosts without a resolver leave it out and
   * the URL bar offers no such row.
   */
  resolveHost?(host: string, options: { signal?: AbortSignal }): Promise<boolean>
}

/**
 * Live-download control; the core keeps the records, the host owns the transfers. Hosts write
 * in-flight files under `PARTIAL_SUFFIX` and hand the final name over only in `release`, which
 * is how flagged files stay quarantined until the user keeps them.
 */
export interface DownloadHost {
  pause(id: string): void
  /** Continue a paused or resumable interrupted transfer; after a restart only the record is known. */
  resume(item: DownloadItem): void
  cancel(id: string): void
  /**
   * A fresh request for the same URL and referrer, reported through `begin` with
   * `resumes: item.id` so the row keeps its identity.
   */
  retry(item: DownloadItem): void
  /**
   * Rename the finished partial file to `item.finalName`; resolves with where it ended up.
   * `notify` is the "notify on complete" setting for hosts whose downloader owns the completion
   * notification (Android); desktop notifications are the desktop program's, from `download.changed`.
   */
  release(
    item: DownloadItem,
    options: { notify: boolean }
  ): Promise<{ savePath: string; finalName: string } | null>
  /** Delete the partial or quarantined file (nothing to do when it is already gone). */
  deletePartial(item: DownloadItem): Promise<void>
  /**
   * Whether a completed download's file is still at `item.savePath` (a stat on desktop, a
   * content query on Android): cheap, run over the list when it loads and on demand.
   */
  exists(item: DownloadItem): Promise<boolean>
  /**
   * Delete a completed download's file (Chrome's "Delete file"; desktop `fs.rm`, Android the
   * MediaStore or SAF document behind the recorded URI): `missing` when it was gone already,
   * `failed` when it is still there (locked, a folder, no permission).
   */
  deleteFile(item: DownloadItem): Promise<'deleted' | 'missing' | 'failed'>
  open(item: DownloadItem): Promise<void>
  showInFolder(item: DownloadItem): void
  /** Folder picker for Settings › Downloads; resolves with the chosen directory or null. */
  chooseDirectory?(win?: ZenWindow): Promise<string | null>
  /**
   * The app is quitting and the host's engine is about to tear the in-flight transfer down
   * (Chromium cancels it and deletes its file): keep the partial file and return where it now
   * lives, or null when it could not be kept. Synchronous: it runs from the quit handler.
   */
  park?(item: DownloadItem): string | null
  /** Desktop UI plumbing: begin a native drag of a finished file out of the chrome. */
  startFileDrag?(item: DownloadItem, win: ZenWindow): void
  /** Desktop UI plumbing: open the folder downloads land in with the system file manager. */
  openDownloadsFolder?(): void
}

/** What "Clear browsing data" asks the engine to drop, across containers. */
export type EngineDataKind = 'cookies' | 'storage' | 'cache'

/** Engine-side readings for the clear-browsing-data preview; null when the engine cannot count. */
export interface EngineDataCounts {
  /** Distinct cookie domains across the given containers. */
  cookieSites: number | null
  cacheBytes: number | null
}

export interface SessionHost {
  clearContainerData(containerId: string): Promise<void>
  /** Wipe the private-browsing session once its last window closed. */
  clearPrivate(): Promise<void>
  /**
   * Drop the HTTP credentials and client-certificate choices the engine itself cached for this
   * session, so a site asks again (the core forgets its own copies alongside).
   */
  clearAuthCache?(): Promise<void>
  /**
   * The user proceeded past the certificate interstitial: engines that decide certificate errors
   * on their own side (the Android WebView) mirror the core's exception (`CertificateExceptions`)
   * so the next request for the site of `url` over this certificate goes ahead. Resolves once
   * mirrored; the core loads the address again after. Electron asks the core directly.
   */
  allowCertificate?(containerId: string, url: string, fingerprint: string): Promise<void>
  /**
   * Clear browsing data: `kinds` of every listed container. Engines cannot limit these to a
   * time range (Chromium's session API has none), so the core tells the user everything goes.
   */
  clearBrowsingData?(containerIds: string[], kinds: EngineDataKind[]): Promise<void>
  /** Readings for the clear-browsing-data preview across the listed containers. */
  browsingDataCounts?(containerIds: string[]): Promise<EngineDataCounts>
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
  /**
   * The OS emoji picker for the focused text field (Chrome's "Emoji" in editable menus); present
   * only where the system has one (Windows, macOS).
   */
  showEmojiPanel?(): void
}

/**
 * The OS colour scheme as the engine sees it. Desktop hosts read it from the native theme so the
 * chrome follows a system-wide flip without waiting for the renderer's media query, which on
 * Windows can lag behind or disagree with it; hosts without this leave the renderer to
 * `prefers-color-scheme`.
 */
export interface ThemeHost {
  /** Whether the engine resolves the scheme to dark right now. */
  systemDark(): boolean
  onChanged(listener: () => void): void
  /** Which scheme pages and native UI use; `system` follows the OS. */
  setSource(scheme: ColorScheme): void
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
  /**
   * Memory (MB) attributed to a tab's page at the last sample, for the "memory saved" line of a
   * tab put to sleep; null when the governor has no figure for it. Hosts that do not measure
   * leave this out.
   */
  memoryOf?(tabId: string): number | null
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
  /** Paths dropped on the management page: packages install, folders load unpacked after a prompt. */
  installFromDrop(paths: string[], win: ZenWindow): Promise<void>
  remove(id: string): Promise<void>
  setEnabled(id: string, enabled: boolean, win?: ZenWindow): Promise<void>
  /** Pin to a version: left out of update checks. */
  setPinned(id: string, pinned: boolean): void
  /** Show as a toolbar button. */
  setToolbarPinned(id: string, pinned: boolean): void
  setAllowFileAccess(id: string, allow: boolean): Promise<void>
  /** Lets this extension's `chrome_url_overrides.newtab` page open new tabs (one at most), or stops it. */
  setNewTabOverride(id: string, enabled: boolean): void
  /** The page new tabs open with while an enabled extension holds the override, else null. */
  newTabUrl(): string | null
  /** Chrome's "Allow in Incognito": whether the extension's request rules reach private windows. */
  setAllowPrivate(id: string, allowed: boolean): void
  /** Chrome's "Allow user scripts": whether `chrome.userScripts` works for the extension. */
  setAllowUserScripts(id: string, allowed: boolean): void
  reload(id: string): Promise<void>
  /** Empties the extension's error console (`ExtensionInfo.errors`). */
  clearErrors(id: string): void
  checkForUpdates(win?: ZenWindow): Promise<void>
  update(id: string, win?: ZenWindow): Promise<void>
  /** The last update check across all extensions, for the management page's caption. */
  updateCheck(): ExtensionUpdateCheck
  openOptions(id: string, win: ZenWindow): void
  /** `frame` is where the renderer's popup panel wants the view (see `extension.openPopup`). */
  openPopup(id: string, anchor: Rect, win: ZenWindow, frame?: PopupFrame): void
  /** Move the open popup view (and show it once the renderer's frame has popped in). */
  resizePopup(bounds: Rect, visible: boolean): void
  closePopup(): void
  /** The `chrome.sidePanel` a window shows beside its page right now (for `UIState.sidePanel`). */
  sidePanel(win: ZenWindow): SidePanelInfo | null
  /** Open an extension's side panel in `win`, or close it when that extension's panel is showing. */
  toggleSidePanel(id: string, win: ZenWindow): void
  closeSidePanel(win: ZenWindow): void
  /** The chrome laid the side panel out here (null: it is not showing); place the panel's view. */
  placeSidePanel(win: ZenWindow, rect: Rect | null): void
  /**
   * `chrome.omnibox`: input starting with an extension's manifest keyword and a space belongs
   * to that extension. `omniboxSuggest` answers the rows for such input (null: no keyword
   * matched, the URL bar suggests as usual), `omniboxSubmit` hands an entered input over (true
   * when an extension took it), `omniboxCancel` ends a session without an entry, and
   * `omniboxDeleteSuggestion` reports a deleted row.
   */
  omniboxSuggest(input: string, win: ZenWindow): Promise<Suggestion[] | null>
  omniboxSubmit(input: string, newTab: boolean, background: boolean, win: ZenWindow): boolean
  omniboxCancel(win: ZenWindow): void
  omniboxDeleteSuggestion(input: string, win: ZenWindow): void
  /**
   * The `chrome.contextMenus` items extensions add to a page's context menu, already grouped
   * per extension the way Chrome does; empty when nothing matches the click.
   */
  pageContextMenuItems(tabId: string, params: PageContextParams, win: ZenWindow): MenuItemTemplate[]
  /** The items an extension adds to its own toolbar button's context menu. */
  actionContextMenuItems(id: string, win: ZenWindow): MenuItemTemplate[]
  /**
   * A key press no Zenium shortcut claimed: true when an extension command is bound to it and
   * the host dispatched it (`commands.onCommand`, or the toolbar action for `_execute_action`).
   */
  handleKey(input: KeyEventInput, win: ZenWindow): boolean
  /** The user answered an install or permission prompt the host raised. */
  respondPrompt(requestId: string, accept: boolean): void
  /**
   * A running extension's `permissions.request` whose new permissions carry warnings (Chrome
   * prompts only for a privilege increase): the chrome's dialog when a window can show it
   * (`extensionPermissionRequest`, kind `request`, answered through `respondPrompt`), else a
   * native message box. Resolves with the user's decision.
   */
  confirmPermissionRequest(id: string, warnings: string[], win?: ZenWindow): Promise<boolean>
  flushSync(): void
}

/** Where the renderer's popup frame puts the popup view: exact bounds and the inner corner. */
export interface PopupFrame {
  bounds: Rect
  radius: number
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

/** What Android's autofill framework says about the device (`AutofillManager`). */
export interface SystemAutofillStatus {
  /** A system autofill service is set for the user (Google, Bitwarden, 1Password, …). */
  enabled: boolean
  /** The service's component name when the system reveals it (API 28+), else null. */
  service: string | null
}

/**
 * The host side of in-page autofill beyond the page script: on Android the WebView is always a
 * client of the system Autofill Framework, so the core needs to know whether a service is set
 * and be able to keep it off the pages when Zenium is the chosen provider. Desktop hosts leave
 * this out.
 */
export interface AutofillHost {
  systemStatus(): Promise<SystemAutofillStatus>
  /** `zenium`: the pages stop taking part in system autofill; `system`: the framework fills them. */
  setProvider(provider: 'system' | 'zenium'): void
  /** Status changes while the app runs (the user set a service in the system settings). */
  onSystemStatusChanged?(listener: (status: SystemAutofillStatus) => void): void
}

/** A default filter list whose snapshot is built into the app (`resources/blocking/`). */
export interface BundledFilterList {
  id: string
  /** `! Version:` of the snapshot, when the list has one. */
  version: string | null
  /** When the snapshot was built (ms since epoch). */
  builtAt: number
  filterCount: number
}

/**
 * The host side of ad and tracker blocking. Matching itself is the core's `RuleEngine` plus the
 * platform's text matcher (Ghostery's engine behind Electron's `webRequest`, the Kotlin engine
 * inside `shouldInterceptRequest`); this interface only hands over the bundled snapshot of the
 * default lists so the very first run is protected before any list has been downloaded.
 */
export interface BlockingHost {
  /** The lists this build ships a snapshot of. */
  bundledLists(): Promise<BundledFilterList[]>
  /**
   * Write the bundled snapshot of `set.id` to `file` (a path under the profile, as the
   * `RuleSetStore` names it) as a complete rule-set document: `set` plus the snapshot's
   * `filterText`. Copying host-side keeps megabytes of filter text out of the core. Resolves
   * with the snapshot's metadata, or null when the build has no snapshot for the list.
   */
  installBundled(set: RuleSet, file: string): Promise<BundledFilterList | null>
}

/** One file of a translation model to fetch from the registry's CDN. */
export interface TranslateModelDownload {
  url: string
  /** File name inside the host's model directory. */
  name: string
  /** Byte count and hex SHA-256 the registry states; a mismatch fails the download. */
  size: number
  sha256: string
}

/**
 * Translation model files on the device (`<userData>/zen/translate/` on desktop, the app's files
 * on Android). Models are downloaded on first use and never bundled.
 */
export interface TranslateModelStore {
  /** Names and sizes of the stored files. */
  list(): Promise<{ name: string; size: number }[]>
  /**
   * Fetch one file, verifying size and checksum; `onProgress` receives the bytes so far. A failed
   * or aborted download leaves nothing behind.
   */
  download(
    file: TranslateModelDownload,
    onProgress: (received: number) => void,
    signal?: AbortSignal
  ): Promise<void>
  delete(names: string[]): Promise<void>
  /** A stored file as the engine worker takes it: its bytes, or a URL of the chrome's own origin. */
  source(name: string): Promise<ByteSource>
}

/**
 * The host side of page translation. The Bergamot engine runs in a Web Worker of the chrome
 * document; the core drives it through the transport and keeps the models the store holds.
 */
export interface TranslateHost {
  /** Start an engine worker (the core creates one lazily and stops it when idle). */
  createEngine(): EngineTransport
  /** The runtime binaries shipped with the app (Bergamot, fastText and its lid.176 model). */
  assets(): Promise<EngineAssets>
  readonly models: TranslateModelStore
  /** The user's UI languages (BCP-47), most preferred first; seeds the preferred-language list. */
  readonly locales: readonly string[]
  /** Hosts whose engine is relayed through the chrome receive its answers here. */
  onRelayResponse?(response: EngineRelayResponse): void
}

/** What the host needs to put a page on the launcher / Home screen. */
export interface ShortcutRequest {
  /** Stable id (the app's manifest id or the page URL); pinning it again updates the tile. */
  id: string
  /** URL the shortcut opens (an ACTION_VIEW back into the browser on Android). */
  url: string
  title: string
  /** Icon image to fetch and decode; null draws a letter tile. */
  iconUrl: string | null
  /** How the icon is meant to be drawn (see `shortcutIcon`); ignored without an icon. */
  iconKind: ShortcutIconKind | null
  /** Colour behind an inset `any` icon / the letter tile: manifest theme, else the space accent. */
  background: string
  /** The `any` icon's own background when the manifest names one (fills the safe zone edges). */
  iconBackground: string | null
}

/**
 * Launcher shortcuts (Android's `ShortcutManagerCompat.requestPinShortcut`). `pin` resolves once
 * the request reached the launcher; the launcher's confirmation arrives later through
 * `Browser.webApps.onPinned` because the system dialog has no cancel callback.
 */
export interface ShortcutHost {
  pin(request: ShortcutRequest): Promise<boolean>
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
  /** The OS colour scheme; hosts without it leave the renderer to `prefers-color-scheme`. */
  readonly theme?: ThemeHost
  /** Cookies and storage per site; hosts without it show a sheet with the connection only. */
  readonly siteData?: SiteDataHost
  /** Native permission prompts; omit to have the chrome render the core's per-tab queue. */
  readonly permissionPrompts?: PermissionPromptHost
  /** Hosts that ask before a page may open another app (Android). */
  readonly externalProtocols?: ExternalProtocolHost
  /** Key protection and re-authentication for the password vault; omit when `capabilities.passwords` is off. */
  readonly passwords?: PasswordsHost
  /** The system autofill framework (Android); desktop hosts have none. */
  readonly autofill?: AutofillHost
  /** Bundled filter-list snapshots; hosts without it start unprotected until the lists download. */
  readonly blocking?: BlockingHost
  /**
   * The privacy policy the host enforces itself (cookies, GPC / DNT, HTTPS-only exemptions, secure
   * DNS) and the Safe Browsing snapshot it ships; hosts without it get none of those.
   */
  readonly privacy?: PrivacyHost
  /** The new tab page's custom background image; hosts without it offer no "Image" option. */
  readonly newTabBackground?: NewTabBackgroundHost
  /** Home-screen shortcuts; hosts without it hide "Add to Home screen". */
  readonly shortcuts?: ShortcutHost
  /** Source of Mozilla's Readability library for Reader View, or null when unavailable. */
  readabilitySource(file: 'Readability.js' | 'Readability-readerable.js'): string | null
  /** Offline page translation; hosts without it report the feature as unavailable. */
  readonly translate?: TranslateHost
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
