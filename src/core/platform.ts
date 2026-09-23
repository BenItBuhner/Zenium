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
  AppWindowInfo,
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
  LongCapture,
  LongCaptureCrop,
  MenuGlyph,
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
  ScreenCaptureSource,
  ScreenshotSaved,
  SharePayload,
  ShortcutAction,
  SidePanelInfo,
  Suggestion,
  SyncDeviceTabs,
  SyncScope,
  SyncStatus,
  Tab,
  ThumbnailPicture,
  WindowChrome,
  WindowMaterial
} from '../shared/types'
import type { AppIconId } from '../shared/appIcon'
import type { PageViewport } from '../shared/capture'
import type { DisplayMode } from '../shared/displayMode'
import type { PageFontSettings } from '../shared/fonts'
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
import type { QrStartOutcome } from '../shared/qrScan'
import type { InterstitialAction } from '../shared/interstitial'
import type { PdfRenderOptions, PrinterDescription, PrintJobOptions } from '../shared/print'
import type { PdfViewerReport } from '../shared/pdfViewerProtocol'
import type {
  MediaReport,
  MediaSessionAction,
  MediaSessionHostMessage,
  MediaSessionInfo
} from '../shared/mediaSession'
import type { NotificationHostMessage, NotificationPageRequest } from '../shared/notifications'
import type { ReadAloudHostMessage, ReadAloudVoice } from '../shared/readAloud'
import type { TextFragmentHostMessage } from '../shared/textFragmentScript'
import type { FocusEdge, FocusEdgeHostMessage } from '../shared/focusEdge'
import type { PrivacyFlags, SafeBrowsingHit } from '../shared/privacy'
import type { RawWebAppManifest, ShortcutIconKind } from '../shared/webApp'
import type { VoiceStartOutcome } from '../shared/voice'
import type { SpellcheckDictionaryStatus } from '../shared/spellcheck'
import type { GeoPosition, GeolocationErrorCode, WifiAccessPoint } from '../shared/geolocation'
import type { ShareFile, ShareOutcome } from '../shared/share'
import type { Browser } from './browser'
import type { ZenWindow } from './window'
import type { AgentHttpRequest, AgentHttpResponse } from './agent/http'
import type { BackgroundWorkerHandle } from './background/work'
import type { RuleSet } from './blocking/rules'

export interface PlatformInfo {
  os: PlatformOs
  version: string
  /**
   * The OS's languages (BCP 47), the UI locale first: what a profile without a preferred
   * languages list of its own starts from (`defaultLanguages`, CT-41). Hosts that leave it out
   * start such a profile from English.
   */
  locales?: readonly string[]
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
  /**
   * Asynchronous read of a document the core does not need at start (a Safe Browsing feed
   * document, megabytes once the feeds were refreshed): a host may bring it in off its main
   * thread (Android fetches it from the document handler). `null` when it does not exist. Hosts
   * without it are read through `readSync`.
   */
  read?(name: string): Promise<string | null>
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
    /** The `Notification` polyfill asks or shows (hosts whose engine hides the API). */
    | 'notification'
    /** A `zen://reader` page's toolbar changed the text preferences (`reader`). */
    | 'reader'
    /** The PDF viewer document (`zen://pdf`) reports where it stands (`shared/pdfPage.ts`). */
    | 'pdf'
    /**
     * The page links an OpenSearch description (`<link rel="search"
     * type="application/opensearchdescription+xml">`): `url` is the description's absolute
     * address, `title` the link's title if any. The core fetches and parses it (`shared/search`).
     */
    | 'opensearch'
    /** The page called `navigator.share` (`shared/share`): a share sheet request. */
    | 'share'
    /** The page's `navigator.geolocation` shim asks for, watches or drops a position (`shared/geolocation`). */
    | 'geolocation'
    /** The page script answers a `readAloud.extract` request with the text as blocks (`shared/readAloud`). */
    | 'readAloud'
    /**
     * One frame's live capture state – camera, microphone, display sharing, picture-in-picture
     * (`shared/captureState`); the tab's alert indicator is folded from every frame's (tabs-43).
     */
    | 'capture-state'
    /** The page script answers a `textFragment` / `generate` request with the selection's directive (`shared/textFragmentScript`). */
    | 'textFragment'
    /**
     * A frame that holds the keyboard says whether it is on a text field (`shared/editingFocus`;
     * the Electron preload alone): the caret's ⌘← / ⌘→ stay the field's (`KeyboardHandler`).
     */
    | 'editing'
  url?: string
  /** `editing`: whether a text field of the reporting frame has the keyboard. */
  editing?: boolean
  /** `textFragment`: the request's id, and the encoded `text=` directive – null when the selection cannot be linked to. */
  id?: string
  directive?: string | null
  /** `opensearch`: the link's `title` attribute, the engine's name when the XML has none. */
  title?: string
  x?: number
  y?: number
  background?: boolean
  /** `media`: whether any media element is currently playing. */
  playing?: boolean
  /**
   * `media`: the page's media in full – the element playing, its position, the page's
   * `navigator.mediaSession` metadata and handlers – from hosts whose page script tracks it
   * (Android); the OS media controls are fed from it.
   */
  media?: MediaReport
  /** `notification`: what the `Notification` polyfill asks (see `shared/notifications`). */
  notification?: NotificationPageRequest
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
  /** `reader`: the changed keys, as the page sent them (the core validates them). */
  reader?: unknown
  /** `pdf`: the viewer's state (page count and page, zoom, find results, the outline). */
  pdf?: PdfViewerReport
  /**
   * `pdf`: the document's token, as the core wrote it into the viewer's shell
   * (`PdfDocumentInfo.token`). Not `token`: on Android that field is the page bridge's session
   * token, which Kotlin checks and strips before the message reaches the core.
   */
  pdfToken?: string
  /** `share`: what the page asked to share (validated by the core). */
  share?: unknown
  /** `geolocation`: the shim's request (validated by the core). */
  geolocation?: unknown
  /** `readAloud`: the extraction (`ReadAloudExtraction`, validated by the core). */
  readAloud?: unknown
  /** `capture-state`: the frame's report (`CaptureStateReport`, validated by the core). */
  capture?: unknown
}

/** The web-app polyfill's messages: `installable` fires `beforeinstallprompt`, `result` settles a `prompt()`, `installed` fires `appinstalled`. */
export interface WebAppHostMessage {
  type: 'webapp'
  action: 'installable' | 'result' | 'installed'
  outcome?: 'accepted' | 'dismissed'
}

/** How a `navigator.share` call ended: the page's promise resolves (`shared`) or rejects. */
export interface ShareHostMessage {
  type: 'share'
  id: string
  result: 'shared' | 'aborted'
}

/** A position, or an error, for one request of the page's geolocation shim. */
export interface GeolocationHostMessage {
  type: 'geolocation'
  id: string
  position?: GeoPosition
  error?: { code: GeolocationErrorCode; message: string }
}

/** The page's `display-mode` changed (`shared/displayMode`): its window went fullscreen, or it moved. */
export interface DisplayModeHostMessage {
  type: 'display-mode'
  mode: DisplayMode
}

/**
 * Messages the browser posts into a page for its page scripts (`TabView.postToPage`): the
 * web-app polyfill's events, the media session's actions (the OS controls, the in-app player),
 * the notification polyfill's answers and events, a share call's outcome, a position, the
 * page's display mode, read aloud's extraction request and highlight, the request for the
 * selection's text directive (a link to the highlight, SH-11), and where a Tab entering the
 * page from the chrome lands (`focus`, A11Y-09).
 */
export type PageHostMessage =
  | WebAppHostMessage
  | MediaSessionHostMessage
  | NotificationHostMessage
  | ShareHostMessage
  | GeolocationHostMessage
  | DisplayModeHostMessage
  | ReadAloudHostMessage
  | TextFragmentHostMessage
  | FocusEdgeHostMessage

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
  /**
   * Click position in the view's coordinates (DIP), as the host's `context-menu` event gives it;
   * for the keyboard (Shift+F10, the Menu key) Chromium reports the caret or the focused
   * element's middle.
   */
  x: number
  y: number
  /**
   * What asked for the menu, as Chromium names it (`menuSourceType`): `'keyboard'` opens the
   * menu at `x`,`y` with its first item selected; a pointer opens it at the pointer.
   */
  menuSourceType?: MenuSourceType
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

/** Chromium's `ui::MenuSourceType` names, as Electron's `context-menu` event reports them. */
export type MenuSourceType =
  | 'none'
  | 'mouse'
  | 'keyboard'
  | 'touch'
  | 'touchMenu'
  | 'longPress'
  | 'longTap'
  | 'touchHandle'
  | 'stylus'
  | 'adjustSelection'
  | 'adjustSelectionReset'

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
  /** Click position in chrome CSS pixels (the caret or the focused element's middle for the keyboard). */
  x: number
  y: number
  /** Raised by Shift+F10 or the Menu key: the menu opens at `x`,`y` with its first item selected. */
  keyboard?: boolean
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

/**
 * Why a page's renderer went away: Electron's `render-process-gone` reasons, and two the Android
 * host adds for a renderer the OS or the user ended (`RenderProcessGoneDetail`, `RendererExit.kt`):
 * `oom-kill`, the system killed the renderer for memory while the page was in front (the page's
 * fault or not; `oom` is a page's own heap running out), and `hung`, the user chose Exit page on
 * an unresponsive page and the browser ended its renderer.
 */
export type CrashReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'oom-kill'
  | 'hung'
  | 'launch-failed'
  | 'integrity-failure'
  | 'memory-eviction'
  | string

/** What a host knows about a crash besides its reason. */
export interface CrashDetails {
  /**
   * The same tab's renderer went away less than a minute ago (the Android host counts, since
   * it outlives the core's renderer): the crash page suggests closing other tabs (ERR-15).
   */
  repeat?: boolean
}

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

/** What `TabView.screenshot` saves: the visible area (default) or the whole page. */
export interface ScreenshotOptions {
  fullPage?: boolean
}

export interface AgentCapture {
  /** Base64 image data (no `data:` prefix). */
  data: string
  mimeType: string
  /** The picture's pixels (device pixels; the core reads the bytes' own header where it can). */
  width: number
  height: number
  /**
   * A full page or region the host could not paint as asked, answered with the visible area
   * (cropped to the region where one was given): the debugger is another's (DevTools open, an
   * extension's `chrome.debugger` session, `pageDebugger.ts`), the paint failed, or the page's
   * geometry could not be read. Absent when the picture is what was asked for.
   */
  fallback?: 'viewport'
}

/** Callbacks a host fires for one tab view. */
export interface TabViewEvents {
  onStartLoading(): void
  onStopLoading(): void
  /** Load progress 0…1 from hosts that measure it (Android); optional between start and stop. */
  onProgress(progress: number): void
  /**
   * A main-frame navigation to `url` began (Electron's `did-start-navigation`), before any
   * response: `sameDocument` for a pushState / hash change, which shows no throbber (tabs-41)
   * although the frame's loading state toggles around it. Hosts that cannot tell need not call
   * it: the throbber then waits from `onStartLoading` to the commit.
   */
  onStartNavigation?(url: string, sameDocument: boolean): void
  /** Main-frame navigation committed (`inPage` for pushState / hash changes). */
  onNavigated(url: string, inPage: boolean): void
  /**
   * The page is about to navigate its main frame to `url` on its own – a link, a script, a form
   * submission (not a load the browser asked for, and not a server redirect, which hosts report
   * as part of the navigation it belongs to). Returns true when the browser takes the navigation
   * over and the host must cancel it: an app window's page leaving the app's scope opens in a
   * browser tab instead (MW-23). Hosts that cannot intercept navigations need not call it.
   */
  onWillNavigate(url: string): boolean
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
  /**
   * The page's renderer went away; `exitCode` is the process's where the host has it (Electron's
   * `render-process-gone` details), for the sad tab's code line; `details` what else the host
   * knows (a repeat within the minute).
   */
  onCrashed(reason: CrashReason, exitCode?: number, details?: CrashDetails): void
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
  /**
   * The view took the keyboard – the user clicked or tabbed into the page, or the core gave it
   * the focus. Hosts that can tell fire it; the chrome lets go of its focused control.
   */
  onFocused?(): void
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

/** The cascade origin of a stylesheet a host injects into a page (`TabView.insertCSS`). */
export type InsertedCssOrigin = 'user' | 'author'

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
  /**
   * Inject a stylesheet; resolves with a key for `removeInsertedCSS`. `origin` is the sheet's
   * cascade origin on hosts that distinguish one (Electron; absent, `user`, under the page's own
   * rules); `author` for rules Blink honours only from author sheets – `::highlight()` among
   * them (a highlight rule in a user-origin sheet registers but never paints). Hosts that inject
   * a `<style>` element (Android) are author-origin either way.
   */
  insertCSS(css: string, origin?: InsertedCssOrigin): Promise<string>
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
  /**
   * Give the page the keyboard with the focus landed on its first or last tabbable control: a
   * hardware keyboard's Tab or Shift+Tab entering the page from the chrome (A11Y-09). Hosts
   * whose engine walks the focus between the page and the chrome itself leave this out.
   */
  focusEdge?(edge: FocusEdge): void
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
  /** Print through the engine's own flow: Electron's system dialog, Android's print manager. */
  print(): void
  /**
   * Render the page to a PDF with the preview's options (`pdfRenderOptions` in
   * `shared/print.ts`): Electron's `webContents.printToPDF`. Resolves with the document's bytes;
   * rejects when the engine could not render (a page that is gone, a print already running).
   * Hosts without it have no print preview (`capabilities.printPreview` off).
   */
  printToPDF?(options: PdfRenderOptions): Promise<Uint8Array>
  /** Save the page (host decides where / whether to ask); resolves with the saved path or null. */
  savePage(suggestedName: string): Promise<string | null>
  /** Downscaled JPEG data URL of the current paint, for the dimmed preview behind overlays. */
  snapshot(): Promise<string | null>
  /**
   * Full-resolution PNG saved to the downloads location; resolves with the saved path. The
   * visible area, or with `fullPage` the whole document beyond the viewport (hosts that cannot
   * paint beyond it – the debugger taken by DevTools – save the visible area instead).
   */
  screenshot(fileName: string, options?: ScreenshotOptions): Promise<string | null>
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
  /**
   * The page's geometry for the chrome's capture overlay (`shared/capture.ts`, `page.viewport`):
   * the scroll offset, the viewport and document sizes in the page's CSS pixels, the viewport
   * minus its scrollbar gutters (`clientWidth` × `clientHeight`, what a visible-area capture
   * paints; the viewport itself where scrollbars overlay the page) and the direction, the page
   * zoom and the device pixels per CSS pixel. Null when the page cannot be read (nothing
   * loaded, a renderer gone). Hosts without it leave the chrome to `Tab.zoom` and no scroll
   * offset.
   */
  viewport?(): Promise<PageViewport | null>

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
  /**
   * The window is a kiosk (the desktop's `--kiosk`): fullscreen for its life, without the
   * chrome, the fullscreen hint or a way out by keyboard – the host refuses `setFullScreen(false)`.
   * Hosts without the mode leave it out.
   */
  readonly kiosk?: boolean
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
  /**
   * Show the popup surface – a second chrome document (`index.html?surface=autofill`) floated
   * above the page views – at `bounds` (window CSS pixels), or take it down with null. It never
   * takes the keyboard when shown; the page the picker hangs from keeps it. Hosts without a
   * layered view (`HostCapabilities.popupSurface` false) leave this out.
   */
  setPopupSurface?(bounds: Rect | null): void
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
  /**
   * The web app of a standalone window (`chrome` `app`): hosts show its icon on the frame and
   * in the taskbar where they can; null for browser windows.
   */
  app: AppWindowInfo | null
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
  /**
   * An icon-row item of a renderer-drawn menu (the phone app menu's first group, design language
   * v2 §9.3): the chrome draws the glyph in a 44 px button named by `label`. Native menu hosts
   * have no such row and ignore it; the phone layout alone builds one.
   */
  glyph?: MenuGlyph
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
  /**
   * The same chord as the user reads it (`formatChord`: `Ctrl+Shift+N`, `⌘⇧N` on macOS), for a
   * menu the renderer draws itself (`RendererMenuHost`, the desktop's in-chrome app menu): a
   * native menu draws `accelerator` in the OS's own spelling and ignores this.
   */
  hint?: string
  /**
   * A plain sentence rather than a command – a menu's empty state (design language v2 §9.17:
   * "No recently closed tabs", sentence case, no full stop). A renderer-drawn menu writes it in
   * the deemphasised ink on a row of its own that takes no focus and answers no click; a native
   * host has no such row and shows the disabled item `enabled: false` makes of it.
   */
  note?: boolean
  /**
   * A destructive item (Close Group, Delete Group): a renderer-drawn menu writes it in the
   * danger ink (v2 §9.1, as the phone's sheets do), a native host draws it as any other.
   */
  danger?: boolean
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
  /** An extension's toolbar button's context menu (a context menu: native on the desktop). */
  | 'extension'
  | 'bookmark'
  | 'history'
  | 'download'
  | 'urlbar'
  | 'translate'

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
  /**
   * Let the user pick text files (e.g. CSS mods); resolves with their contents. `maxBytes` lifts
   * a host's default size cap for files that are legitimately large (a bookmarks HTML with its
   * favicons inline); a file over the cap is left out of the result.
   */
  pickTextFiles(
    options: { title: string; extensions: string[]; maxBytes?: number },
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
  /**
   * The clip on the clipboard now was OPENED through the row (the pick, not a reveal): `peek`
   * answers `none` for it until the clipboard changes (Chrome's `SuppressClipboardContent`),
   * so the row does not offer the same link again on the next focus. Hosts without it offer it
   * again.
   */
  markUsed?(): void
}

export interface ShellHost {
  openExternal(url: string): void
  openPath(path: string): Promise<void>
  showItemInFolder(path: string): void
  /**
   * The system share sheet (`capabilities.share`). Resolves once the sheet is up – or, with
   * `payload.awaitOutcome`, once it has closed, with how it ended (`shared`: a target took the
   * share; `aborted`: the sheet was dismissed), for a page's `navigator.share` promise. Hosts
   * without one leave it out and the core copies the link instead.
   */
  share?(payload: SharePayload): Promise<ShareOutcome | void>
  /** The OS screen for which links open in this app (`capabilities.appLinkSettings`). */
  openAppLinkSettings?(): void
  /**
   * The OS screen where encrypted DNS is set for every app (Android's Private DNS); for hosts
   * without a resolver of their own (`capabilities.secureDns` false).
   */
  openPrivateDnsSettings?(): void
  /**
   * The OS's keyboard settings (Android's "On-screen keyboard"), where the spell checker that
   * checks the WebView's fields is chosen; for hosts without a spellchecker of the browser's own.
   */
  openKeyboardSettings?(): void
}

/**
 * The host's spellchecker: Chromium's per-session Hunspell checker on Electron (Windows, Linux;
 * dictionaries download from Chromium's CDN on a language's first use), the OS's checker with the
 * OS's languages on macOS. Android's WebView has none of the browser's own – the system spell
 * checker service the keyboard settings name checks its fields – so that host leaves this out,
 * and Settings shows the limit with `ShellHost.openKeyboardSettings`.
 */
export interface SpellcheckHost {
  /**
   * The host follows the OS's languages and ignores the list it is given (macOS): the languages
   * are shown, not chosen.
   */
  readonly systemLanguages: boolean
  /** The UI languages (BCP-47), most preferred first: a fresh profile checks in the first with a dictionary. */
  readonly locales: readonly string[]
  /** Every dictionary code the host can check in (`session.availableSpellCheckerLanguages`). */
  availableLanguages(): string[]
  /** Check (or stop checking) the fields, in these languages, in every session present and future. */
  apply(enabled: boolean, languages: readonly string[]): void
  /** A dictionary's download and initialisation as Chromium reports them, by language code. */
  onDictionaryStatus(listener: (code: string, status: SpellcheckDictionaryStatus) => void): void
  /** The custom dictionary – the words "Add to Dictionary" collected – one per profile. */
  listWords(): Promise<string[]>
  /** False when the word was there already (or is not a word). */
  addWord(word: string): Promise<boolean>
  removeWord(word: string): Promise<boolean>
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
  /**
   * Who holds the Safe Browsing tables. `'core'` (the default): the service loads them from the
   * feed documents at start and answers `lookup` itself; Electron's request handler asks it for
   * every request. `'host'`: the host reads the documents the service writes and checks
   * requests against tables of its own (Android's Kotlin engine, `privacy/SafeBrowsing.kt`,
   * which reports a refused navigation as the `unsafe` view event); the service then builds no
   * table, reads the documents after start – off the boot path – for their metadata alone (the
   * refresh schedule, the status card) and asks {@link lookupSafeBrowsing} where it needs a
   * table's word (a download's verdict).
   */
  readonly safeBrowsingTables?: 'core' | 'host'
  /**
   * With `safeBrowsingTables: 'host'`: the host's tables' word on `url` under its own switch and
   * bypasses – the hit, or null for nothing listed (or tables not loaded yet).
   */
  lookupSafeBrowsing?(url: string): Promise<SafeBrowsingHit | null>
}

/**
 * The device's connectivity as the host sees it (`core/connectivity.ts`): Android's
 * `ConnectivityManager` reports a network with internet access that has been validated
 * (`ConnectivityMonitor.kt`). The host's word is raw – a Wi-Fi to mobile switch reports lost
 * then available within a second – and the core debounces it before the chrome shows anything.
 * Hosts without it are online for good: no banner, no self-reloading error pages.
 */
export interface ConnectivityHost {
  /** The host's current verdict. */
  isOnline(): boolean
  /** Hear every change of the verdict as the host reports it; returns the unsubscribe. */
  onChange(listener: (online: boolean) => void): () => void
}

/**
 * What the host does for the core's background work (`core/background/work.ts`): the worker the
 * heavy parsing and hashing of the Safe Browsing feeds and the filter lists runs in, and the
 * hold a demo harness puts on the startup sweeps. Both optional: without a worker the work runs
 * on the main thread in chunks; without a hold the sweeps run on their schedule.
 */
export interface PerformanceHost {
  /**
   * Spawn the background worker (a module Web Worker in the Android chrome, a `worker_threads`
   * worker in Electron's main process) serving `CORE_BACKGROUND_TASKS` and the host's own tasks;
   * null when this host cannot (the preview host, a test).
   */
  createBackgroundWorker?(): BackgroundWorkerHandle | null
  /**
   * Whether the startup sweeps should wait: true while the demo harness's scenes run (Android:
   * the `holdBackgroundWork` boot flag from the launch intent's extra; Electron:
   * `--hold-background-work`). Consulted every `HOLD_RECHECK_MS` by a sweep whose time has come;
   * the `performance.releaseBackgroundWork` command ends the hold whatever this says. Never true
   * in production: no host sets it on its own.
   */
  holdBackgroundWork?(): boolean
}

export interface NetHost {
  fetchText(
    url: string,
    options: {
      signal?: AbortSignal
      headers?: Record<string, string>
      /** Overall time limit; hosts default to a few seconds (suggestions, Live Folders). */
      timeoutMs?: number
      /**
       * The most body bytes the host reads: a body past it fails the fetch (`ok: false`) with
       * the download stopped there, so a caller's cap (an OpenSearch description's 64 KB)
       * bounds the transfer and not only what is kept of it. Unset: the host's own limit.
       */
      maxBytes?: number
      /** `POST` with `body` (the network location query); GET without. */
      method?: 'GET' | 'POST'
      body?: string
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
  /**
   * Who retries a transient network interruption: the core (default) schedules `resume` with
   * backoff once the host reports the network back, or the host's own downloader does before
   * the interruption ever reaches the core (Android's `Downloads.kt`), in which case the core
   * schedules nothing so no interruption is retried twice.
   */
  readonly autoResume?: 'core' | 'host'
  /**
   * Whether the machine has a network right now (Electron `net.isOnline()`); the core holds an
   * automatic resume until it does. Hosts without an answer leave it out: the core assumes online.
   */
  isOnline?(): boolean
  /** Call `listener` once the network is back (or is up already); returns the unsubscribe. */
  onOnline?(listener: () => void): () => void
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
  /**
   * Chrome's "Open with": the system's chooser of apps for the file, whatever the default is
   * (the PDF viewer's escape to another app). Hosts without a chooser leave it out and the core
   * opens the file as `open` would.
   */
  openWith?(item: DownloadItem): Promise<void>
  /** The system share sheet with the file itself (`capabilities.share`); hosts without one leave it out. */
  share?(item: DownloadItem): Promise<void>
  showInFolder(item: DownloadItem): void
  /** Folder picker for Settings › Downloads; resolves with the chosen directory or null. */
  chooseDirectory?(win?: ZenWindow): Promise<string | null>
  /**
   * The folder new downloads go to right now (the setting when it names one, else the
   * platform's Downloads folder), for Settings › Downloads › Location; hosts that cannot name
   * one leave it out.
   */
  currentDirectory?(): string
  /**
   * Write a file the browser made itself – the capture UI's Save, holding the picture as bytes
   * – into the folder new downloads go to (the setting, else the platform's), under `name` or
   * the first free variant of it, never over a file there; resolves with where it landed (a
   * path, or Android's `content:` address), null when it could not be written. The core lists
   * the file as a completed download. Hosts without it have no capture save.
   */
  saveFile?(file: { name: string; mimeType: string; data: string }): Promise<string | null>
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

/** One origin of the site-data viewer as the engine holds it (`SiteDataHost.listOrigins`). */
export interface SiteDataOriginReading {
  /** `scheme://host[:port]`. */
  origin: string
  /** Cookies a page of the origin receives (Electron: the cookies stored under the host). */
  cookies: number
  /** Quota-managed storage in bytes; null where the engine cannot size an origin (Electron). */
  usageBytes: number | null
}

/**
 * Cookies and stored data of one site inside a container, for the site-information sheet and
 * the site-data viewer. Cookie values never cross this boundary – names and attributes are all
 * the chrome shows.
 */
export interface SiteDataHost {
  /** The cookies a page at `url` receives (its host's and its parent domains'). */
  cookies(containerId: string, url: string): Promise<SiteCookie[]>
  storage(containerId: string, site: string): Promise<SiteStorageReading>
  /** Remove the cookies a page at `url` receives; resolves with how many went away. */
  clearCookies(containerId: string, url: string): Promise<number>
  /**
   * Delete the stored data of `site` (hosts that can; an empty `site` asks for the origins
   * alone) or of the given origins (the rest).
   */
  clearStorage(containerId: string, site: string, origins: string[]): Promise<void>
  /**
   * The site-data viewer's raw material for one container: every origin the engine holds
   * cookies or quota-managed storage for. `probe` names origins the core knows of (visited,
   * with permissions) for an engine that cannot enumerate its cookie jar (Android's
   * `CookieManager`) to look up one by one; an engine that can (Electron) ignores it. Hosts
   * without the reading leave it out: the viewer then lists the permissions' origins alone.
   */
  listOrigins?(containerId: string, probe: string[]): Promise<SiteDataOriginReading[]>
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
  /**
   * What the system does to a window whose title bar is double-clicked, read live from the
   * user's setting: macOS's System Settings › Desktop & Dock › "Double-click a window's title bar
   * to" (the `AppleActionOnDoubleClick` user default). Only the macOS host has it; the chrome's
   * empty caption room follows it (`captionDoubleClickEffect`), and toggles maximise elsewhere.
   */
  titleBarDoubleClickAction?(): TitleBarDoubleClickAction
}

/** The three choices of macOS's title-bar double-click setting. */
export type TitleBarDoubleClickAction = 'zoom' | 'minimize' | 'none'

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

/**
 * The page fonts (Settings › Appearance › Customize fonts, CT-25) as the engine takes them:
 * the Electron host puts them into every new page view's web preferences and, where the view's
 * debugger is free, applies them to open pages through the DevTools protocol; the Android host
 * sets every tab WebView's `WebSettings`. Called at boot and whenever the setting changes (a
 * Settings row, a sync merge). Hosts without page fonts of their own leave this out.
 */
export interface PageFontsHost {
  apply(fonts: PageFontSettings): void
}

/**
 * The preferred languages (Settings › Languages, CT-41) as the pages see them: the Electron
 * host sets every session's `Accept-Language` from the list (`session.setUserAgent(ua,
 * acceptLanguages)`), at boot and on change, private session included. Android's WebView sends
 * the system's languages and offers no way to set them (`capabilities.pageLanguages` is off
 * there), so that host has no `LanguagesHost`; the list still drives translate and spellcheck.
 *
 * Recorded limit (desktop): only the request header follows. Electron fills a renderer's
 * `navigator.languages` from the application locale when its WebContents is made and exposes
 * no way to set it, so a page's script reads the app locale while its requests carry the list.
 */
export interface LanguagesHost {
  apply(languages: readonly string[]): void
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
  /**
   * Whether an action popup is up right now. Chrome refuses `chrome.action.openPopup()` while
   * one shows ("Failed to open popup."): a popup whose worker answers its first message with
   * `openPopup` would otherwise replace itself forever.
   */
  popupOpen(): boolean
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

/**
 * Cross-device sync through a shared folder, as the chrome's `sync.*` commands see it. The
 * core's `sync/engine.ts` implements it on top of a host's `SyncPlatformHost`; hosts without
 * one get the built-in stand-in (`NoSync`).
 */
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
  /** Re-point a configured device at a folder (after `folderLost`, or to move); the key stays. */
  setFolder(folder: string, win: ZenWindow): Promise<void>
  syncNow(): Promise<void>
  confirmMerge(merge: boolean): Promise<void>
  disconnect(wipeRemote: boolean): void
  flushSync(): void
  /** The other devices' open tabs as they last published them (ID-28); [] with Open tabs off. */
  tabsFromDevices(): SyncDeviceTabs[]
  /** Send a page to another device, where it opens as a tab once (ID-27). */
  sendTab(
    opts: { deviceId: string; url: string; title?: string; tabId?: string },
    win: ZenWindow
  ): Promise<void>
}

/**
 * The bytes of a sync folder: text documents by name inside the folder's `zenium-sync`
 * directory (`core/sync/transport.ts` has the full contract and the shared helpers).
 */
export interface SyncTransport {
  list(): Promise<string[]>
  read(name: string): Promise<string | null>
  write(name: string, text: string): Promise<void>
  remove(name: string): Promise<void>
  removeAll(): Promise<void>
  watch?(onChange: () => void): () => void
}

/** A host's own scrypt (Node's native one is quicker than the shared JavaScript implementation). */
export type SyncScryptFn = (
  passphrase: Uint8Array,
  salt: Uint8Array,
  params: { N: number; r: number; p: number; dkLen: number }
) => Promise<Uint8Array>

/**
 * What the platform-neutral sync engine needs from a host: a folder picker, a name for this
 * device, and a transport for the folder the user picked. The passphrase prompt, the merge
 * question and every other piece of UI are the chrome's.
 */
export interface SyncPlatformHost {
  /**
   * The platform's folder picker: an absolute path on desktop, a persisted document-tree URI
   * on Android (opaque to the core), or null when the user dismissed it.
   */
  chooseFolder(win: ZenWindow): Promise<string | null>
  /** The folder as the user knows it (the path itself; a tree's display name), for the status. */
  folderName?(folder: string): Promise<string>
  /** What this device is called until the user renames it (the hostname; `Build.MODEL`). */
  deviceNameDefault(): string
  createTransport(folder: string): SyncTransport
  /** Native scrypt, when the host has one; must equal the shared implementation bit for bit. */
  scrypt?: SyncScryptFn
  /**
   * How often the engine re-reads the folder on its own; the default (45 s) suits a desktop
   * whose transport also watches. 0 leaves polling to the transport's `watch`.
   */
  pollMs?: number
  /** False while the app is in the background: the poll skips its turn (Android, no service). */
  foreground?(): boolean
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
 * Launcher shortcuts (Android's `ShortcutManagerCompat.requestPinShortcut`; on desktop a
 * launcher – Start menu / desktop `.lnk`, `.desktop` entry, `.app` bundle – that runs the app in
 * a window of its own, `zenium --app=<url>`). `pin` resolves once the request reached the
 * launcher; the launcher's confirmation arrives later through `Browser.webApps.onPinned` because
 * Android's system dialog has no cancel callback (desktop hosts confirm as soon as the files are
 * written, with the icon they kept).
 */
export interface ShortcutHost {
  pin(request: ShortcutRequest): Promise<boolean>
  /**
   * Remove the launcher `pin` made for `id` (its files and icon). Hosts whose launcher owns its
   * shortcuts (Android) leave it out; the core then only forgets the record.
   */
  unpin?(id: string): Promise<void>
}

/**
 * Voice search on a host with a speech recogniser (Android's `SpeechRecognizer`, `Voice.kt`).
 * `start` asks for the microphone – the runtime permission prompt may show – and starts the
 * recogniser in the user's language; while it listens the host raises `voice.event`s, which the
 * platform hands to the window (`Browser.emit`). One session at a time: a start while one runs
 * cancels the first.
 */
export interface VoiceHost {
  start(): Promise<VoiceStartOutcome>
  cancel(): void
  /** The app's system settings screen, for a microphone refused for good. */
  openSettings(): void
}

/**
 * Tab card thumbnails the host keeps on disk, one picture per tab (`thumbnail.*` in `Commands`).
 * The host captures on its own – a page leaving the screen, the app going to the background,
 * the cover it takes for a sheet – and raises `thumbnail.captured` to the window; the chrome
 * reads a card's picture when it shows the card, and says which pictures are to go.
 */
export interface ThumbnailHost {
  /** How wide a card is, in device pixels: what captures are scaled to. */
  configure(width: number): void
  /** The persisted picture of a tab at `url`, or null when there is none (or none of that page). */
  load(tabId: string, url: string): Promise<ThumbnailPicture | null>
  /**
   * The tab left `url`: its picture of that page is not to be shown again (one of another page,
   * a newer capture the word overtook, stays). Without `url` the tab is gone for good, and so
   * is whatever picture is under its id.
   */
  drop(tabId: string, url?: string): void
  /** Once at boot: every picture but those of `keep` (the session's tabs) goes. */
  sweep(keep: readonly string[]): void
}

/**
 * QR scanning on a host with a back camera (Android's camera2 behind `QrScan.kt`). `start` asks
 * for the camera – the runtime permission prompt may show – and opens it into a native preview
 * the host lays over the sheet's slot (`layout`); while it scans the host raises `qr.event`s,
 * which the platform hands to the window (`Browser.emit`). One session at a time: a start while
 * one runs cancels the first.
 */
export interface QrScanHost {
  start(): Promise<QrStartOutcome>
  cancel(): void
  layout(slot: { rect: Rect; radius: number; visible: boolean }): void
  setTorch(on: boolean): void
  /** The app's system settings screen, for a camera refused for good. */
  openSettings(): void
}

/**
 * The host side of the print preview (`capabilities.printPreview`; `core/print.ts`): the
 * system's printers, the job that takes the rendered document to one, and the file Save as PDF
 * writes. The render itself is the tab's (`TabView.printToPDF`), as the engine hangs it on the
 * page.
 */
export interface PrintingHost {
  /** The system's printers (`webContents.getPrintersAsync`), the default one flagged. */
  printers(): Promise<PrinterDescription[]>
  /**
   * Send `document` – the PDF the preview rendered, its pages laid out for the paper the job
   * names – to the printer the job names, without asking anything more (the preview asked
   * everything; Electron prints it silently from Chromium's PDF viewer, page for page). Resolves
   * once the job is handed to the system; rejects with the engine's reason when it is not.
   */
  print(document: Uint8Array, job: PrintJobOptions): Promise<void>
  /**
   * Save as PDF: ask where to save – Chrome's save dialog, with `defaultName` filled in – and
   * write `bytes` there. Resolves with the file's path, or null when the dialog was dismissed.
   */
  savePdf(
    bytes: Uint8Array,
    options: { defaultName: string },
    win?: ZenWindow
  ): Promise<string | null>
}

/**
 * The OS media controls on a host whose engine feeds none of its own (the Android WebView), or
 * whose own instance Zenium replaces (Linux MPRIS, so the desktop sees "Zenium" and one player;
 * Windows' SMTC and macOS's Now Playing stay Chromium's). The core resolves one session – the
 * page playing, or the last one that did – from the pages' reports and hands it over; the host
 * shows it (a `MediaSessionCompat` behind a media-style notification, the lock screen and the
 * headset buttons; a D-Bus player) and sends the controls' actions back through
 * `Browser.mediaSession.act`.
 */
export interface MediaSessionHost {
  /** Show `session` on the OS controls, or take them down with null. */
  update(session: MediaSessionInfo | null): void
  /**
   * Put the window into the OS's picture-in-picture for the video of `session`'s tab
   * (`enterPictureInPictureMode` on Android). Resolves false when the OS refused (no video, PiP
   * off for the app, another app's window on top); hosts without it leave it out.
   */
  enterPictureInPicture?(session: MediaSessionInfo): Promise<boolean>
}

/** What the read-aloud core asks the speech host to say an utterance with. */
export interface SpeechUtteranceOptions {
  /** The voice's id (`ReadAloudVoice.id`), or null for the engine's default for `lang`. */
  voiceId: string | null
  /** BCP-47 tag of the utterance's text ('' when unknown). */
  lang: string
  /** 0.5–4 (`READ_ALOUD_RATES`). */
  rate: number
  /**
   * `chrome.tts`'s prosody, when an extension speaks through the host (Chrome's 0–2, 1 the
   * voice's own; 0–1, 1 full): read aloud leaves both out, and a host without the knobs ignores them.
   */
  pitch?: number
  volume?: number
}

/** What a speech host reports about an utterance it was given. */
export interface SpeechHostEvent {
  type: 'start' | 'word' | 'end' | 'error'
  /** `word`: where the word starts in the utterance's text. */
  charIndex?: number
  /** `word`: how many characters the word spans (hosts that cannot tell leave it out). */
  length?: number
  /**
   * `error`: the host's message. `interrupted` (`SPEECH_INTERRUPTED`) when another speaker's
   * utterance replaced this one, or a `stop` dropped it, before it ended: the host says so about
   * the one it dropped, so no listener waits on an `end` that never comes (each listener knows
   * its own stops and speaks, and drops the reports about those).
   */
  message?: string
}

/** `SpeechHostEvent.message` of an utterance another speaker (or a `stop`) cut short. */
export const SPEECH_INTERRUPTED = 'interrupted'

/**
 * The speech engine behind read aloud (`capabilities.readAloud`): the voices on the device, one
 * utterance at a time – the core speaks a sentence per utterance – and the utterance's events
 * back. Desktop: an adapter over the hidden `speechSynthesis` page (`main/platform/speech.ts`);
 * Android: `TextToSpeech` (the Android program's host half). Hosts without one leave it out.
 */
export interface SpeechHost {
  voices(): Promise<ReadAloudVoice[]>
  /**
   * Optional: ask the engine to list its voices again (a `readAloud.voices` re-ask after an empty
   * first answer, a picker's refresh); hosts without it answer `voices()` again.
   */
  refreshVoices?(): Promise<ReadAloudVoice[]>
  onVoicesChanged(listener: () => void): void
  /** Speak one utterance now (any utterance in progress is replaced); events name `utteranceId`. */
  speak(utteranceId: string, text: string, options: SpeechUtteranceOptions): void
  /** Optional: get the next utterance ready so it starts without a gap after the current one ends. */
  prepare?(utteranceId: string, text: string, options: SpeechUtteranceOptions): void
  stop(): void
  /** Hosts without it: the core stops and resumes from the sentence's start. */
  pause?(): void
  resume?(): void
  /**
   * `word` events carry `charIndex` / `length` within the utterance's text; a host that cannot
   * report words sends none (the core then highlights sentences only). The core needs no
   * `sentence` events: one sentence per utterance.
   */
  onEvent(listener: (utteranceId: string, event: SpeechHostEvent) => void): void
}

/** One notification a page shows, as the host posts it under the site's channel. */
export interface WebNotificationRequest {
  /** Browser-wide id (the tab's id and the page's own), what the host's events name. */
  id: string
  /** The origin of the page (the channel's identity and the notification's sub text). */
  origin: string
  tabId: string
  /** The page's URL: what a tap opens when the tab (or the core) is gone by then. */
  url: string
  title: string
  body: string
  /** Absolute URL of the icon, '' for none; the host fetches and decodes it. */
  icon: string
  /** The page's tag: a notification with the same one under the same origin replaces it. */
  tag: string
  silent: boolean
  requireInteraction: boolean
  /** With a tag: alert again on the replace (else the replace is quiet). */
  renotify: boolean
  /** Epoch ms shown as the notification's time. */
  timestamp: number
  /**
   * The browser's own notification rather than a page's: posted under the app's "Sharing"
   * channel (Chrome Android's for tabs sent from another device), not the site's, and never
   * counted against the site's permission. Absent for a page's notification.
   */
  channel?: 'sharing'
}

/**
 * Web Notifications on a host whose engine has no `Notification` for pages (the Android
 * WebView): the page script polyfills the API and the core routes it here – one notification
 * channel per site (Chrome Android's), the shade's tap and swipe reported back through
 * `Browser.webNotifications.onHostEvent`. Desktop hosts leave it out: Chromium shows theirs.
 */
export interface WebNotificationHost {
  /** Post (or replace, by origin and tag) a notification; resolves false when the OS refused. */
  show(request: WebNotificationRequest): Promise<boolean>
  /** Take a notification down without an event (the page's `close()`). */
  close(id: string): void
  /** The site's permission was withdrawn: its notifications and its channel go. */
  forgetOrigin(origin: string): void
  /**
   * The app itself may post notifications (Android 13+'s runtime permission): ask once the
   * site was allowed, so the first notification is not lost to a prompt. Resolves the grant.
   */
  ensureAllowed(): Promise<boolean>
}

/**
 * The private session as a host shows it outside the chrome (Android: Chrome's "Close all
 * Incognito tabs" notification while private tabs are open, gone with the last of them). Hosts
 * with private windows leave it out; the window is the session's presence there.
 */
export interface PrivateSessionHost {
  /** How many private tabs are open now (0: the session ended, the wipe is on its way). */
  setOpenTabs(count: number): void
}

export type { MediaSessionAction }

// ---------------------------------------------------------------------------
// Screen capture, share sheet, network location (desktop platform rows)
// ---------------------------------------------------------------------------

/**
 * The host's side of screen capture (MW-19): it lists what can be shared and hands the picked
 * source to the engine. The core owns the picker (`ScreenCaptureService`), one request at a time
 * per tab.
 */
export interface ScreenCaptureHost {
  /**
   * The screens and windows the OS offers right now, with thumbnails. On Wayland the portal's
   * own dialog is what the user sees; the list then holds the one source it granted.
   */
  sources(kinds: Array<'screen' | 'window'>): Promise<ScreenCaptureSource[]>
  /** Whether a screen share may come with the system's audio (Windows' loopback). */
  systemAudio(): boolean
}

/**
 * Extras behind the chrome's share sheet (`capabilities.shareSheet`): the files a page shared
 * go to the downloads folder, and an OS with a share sheet of its own (macOS) offers it too.
 */
export interface ShareSheetHost {
  /** Write shared files to the downloads folder; resolves with where they landed. */
  saveFiles(files: ShareFile[]): Promise<string[]>
  /**
   * The OS's share sheet for the payload, anchored to the window (macOS's `ShareMenu`);
   * resolves once the sheet is up. Hosts without one leave it out and the chrome offers no
   * "More…" row.
   */
  system?(
    payload: { title: string; text: string; url: string; files: ShareFile[] },
    win: ZenWindow
  ): Promise<void>
}

/**
 * Screenshots to the device's gallery (Android; SH-07, SH-08): Take Screenshot flashes the page
 * and puts the visible area in `MediaStore.Images` under Pictures/Zenium, the card's Capture
 * more takes the whole page for the editor to crop. Hosts without a gallery leave it out and
 * Take Screenshot saves a PNG to Downloads, as it always did.
 */
export interface ScreenshotHost {
  /**
   * Flash the page (120 ms white to clear over the content frame) and save the visible area to
   * the gallery; null when the page could not be drawn or the write failed.
   */
  capture(tabId: string): Promise<ScreenshotSaved | null>
  /** The whole page from the top, cut at about ten screens, held for `saveLong`; null when it could not be drawn. */
  captureLong(tabId: string): Promise<LongCapture | null>
  /** Crop the held capture, save it to the gallery and – with `share` – offer it on the system share sheet. */
  saveLong(id: string, crop: LongCaptureCrop, share: boolean): Promise<ScreenshotSaved | null>
  /** Let a held capture go. */
  discardLong(id: string): void
  /** The system share sheet with the picture. */
  share(uri: string): Promise<void>
  /** Take the picture out of the gallery; false when it could not be. */
  delete(uri: string): Promise<boolean>
  /** The picture in the system's viewer. */
  open(uri: string): Promise<void>
}

/**
 * What a network location provider needs from the host (MW-04, Linux): the Wi-Fi networks in
 * range. Hosts whose engine locates on its own (Windows, macOS, Android) leave the whole host out.
 */
export interface GeolocationHost {
  /** The access points in range (BSSID, signal, frequency); empty when there is no Wi-Fi or no scanner. */
  scanWifi(): Promise<WifiAccessPoint[]>
}

export type ImportFileKind = 'file' | 'dir' | 'symlink' | 'missing'

/** A SQLite database opened read-only on a copy of a browser's file (`ImportHost.openSqlite`). */
export interface ImportDatabase {
  /** Every row of a `SELECT`; column names as keys, SQLite's values (numbers, strings, blobs as bytes, null). */
  all(sql: string): Record<string, unknown>[]
  close(): void
}

export interface ImportTempCopy {
  /** The temporary directory holding the copies; the core removes it with `removeTemp`. */
  dir: string
  /** The copy of each requested path in order, null for a source that does not exist. */
  copies: (string | null)[]
}

/**
 * The file access the import from other browsers needs (desktop hosts; `core/import`). Every
 * path decision – where Chrome, Edge, Firefox and Safari keep their profiles, which files hold
 * what, how a running browser shows – is the core's; the host only reads, lists, copies and opens.
 * Databases are never opened in place: the core copies them (with their `-wal` / `-journal`
 * companions) into a temp dir first, the way Chrome's importer does, so the source browser's own
 * locks are the only thing that can refuse the read.
 */
export interface ImportHost {
  /** The user's home directory. */
  readonly homeDir: string
  /** The process environment (`LOCALAPPDATA`, `APPDATA`, `XDG_CONFIG_HOME`). */
  readonly env: Readonly<Record<string, string | undefined>>
  /** What is at `path`, without following a symlink (Chrome's `SingletonLock` is one). */
  stat(path: string): Promise<ImportFileKind>
  readText(path: string): Promise<string>
  readBytes(path: string): Promise<Uint8Array>
  /** The entries of a directory (names, not paths); empty when it does not exist. */
  list(dir: string): Promise<string[]>
  /**
   * Copy the files that exist among `paths` into a fresh temporary directory. Throws when a copy
   * fails for a reason other than the source missing (a browser holding an exclusive lock).
   */
  copyToTemp(paths: string[]): Promise<ImportTempCopy>
  removeTemp(dir: string): Promise<void>
  /** Open a database read-only (`node:sqlite`); the core always passes a temp copy. */
  openSqlite(path: string): Promise<ImportDatabase>
  /**
   * The OS keyring secret Chrome / Chromium / Edge encrypt their v11 (Linux) and v10 (macOS)
   * logins with ("Chrome Safe Storage"), or null when the OS has none to give (Windows, no
   * `secret-tool`, a locked keyring).
   */
  safeStorageSecret(browser: 'chrome' | 'chromium' | 'edge'): Promise<string | null>
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
  /** The page fonts in the engine's page views (CT-25); hosts without it leave pages at the engine's fonts. */
  readonly pageFonts?: PageFontsHost
  /** The preferred languages in the pages' `Accept-Language` (CT-41); omit when `capabilities.pageLanguages` is off. */
  readonly languages?: LanguagesHost
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
  /** Voice search through the device's recogniser; omit when `capabilities.voiceSearch` is off. */
  readonly voice?: VoiceHost
  /** Tab card thumbnails kept across restarts; hosts without it show placeholder cards. */
  readonly thumbnails?: ThumbnailHost
  /** QR scanning through the device's back camera; omit when `capabilities.qrScan` is off. */
  readonly qrScan?: QrScanHost
  /** OS media controls fed by the core (Android); hosts whose engine feeds them itself leave it out. */
  readonly mediaSession?: MediaSessionHost
  /** The speech engine behind read aloud (`capabilities.readAloud`); hosts without one leave it out. */
  readonly speech?: SpeechHost
  /** Web Notifications for pages of a host whose engine lacks the API (Android). */
  readonly webNotifications?: WebNotificationHost
  /** The private session's presence outside the chrome (Android's notification); optional. */
  readonly privateSession?: PrivateSessionHost
  /** Source of Mozilla's Readability library for Reader View, or null when unavailable. */
  readabilitySource(file: 'Readability.js' | 'Readability-readerable.js'): string | null
  /** Offline page translation; hosts without it report the feature as unavailable. */
  readonly translate?: TranslateHost
  /** Spell checking of text fields; hosts without a checker of their own leave it out. */
  readonly spellcheck?: SpellcheckHost
  /** The print preview's printers and Save as PDF; omit when `capabilities.printPreview` is off. */
  readonly printing?: PrintingHost
  /** Screens, windows and tabs a page may capture (`capabilities.screenCapture`). */
  readonly screenCapture?: ScreenCaptureHost
  /** Extras of the chrome's share sheet: saving shared files, the OS's own sheet where there is one. */
  readonly shareSheet?: ShareSheetHost
  /** Screenshots to the device's gallery (Android); hosts without one save to Downloads. */
  readonly screenshots?: ScreenshotHost
  /** A network location source's inputs (the Wi-Fi networks in range) for hosts whose engine has no location provider. */
  readonly geolocation?: GeolocationHost
  /** The folder picker, device name and folder transport behind cross-device sync (`capabilities.sync`). */
  readonly sync?: SyncPlatformHost
  /** Other browsers' profiles on this machine (desktop); hosts without it import from files only. */
  readonly importHost?: ImportHost
  /** The background worker and the demo harness's hold on the startup sweeps; omit for neither. */
  readonly performance?: PerformanceHost
  /** The device's connectivity (Android); hosts without it are online for good. */
  readonly connectivity?: ConnectivityHost
  /** Host-backed services; omit for the built-in no-op versions. */
  createGovernor?(browser: Browser): Governor
  createExtensions?(browser: Browser): ExtensionHost
  createAgentTransport?(browser: Browser): AgentTransport
  createUpdateHost?(browser: Browser): UpdateHost
}

/** Schedule work for the next macrotask in Node and browsers alike. */
export function defer(fn: () => void): void {
  const g = globalThis as { setImmediate?: (cb: () => void) => void }
  if (typeof g.setImmediate === 'function') g.setImmediate(fn)
  else setTimeout(fn, 0)
}
