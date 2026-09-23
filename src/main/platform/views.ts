import {
  ClipboardItem,
  WebContentsView,
  app,
  clipboard,
  dialog,
  nativeImage,
  nativeTheme,
  net,
  screen,
  type BrowserWindow,
  type BrowserWindowConstructorOptions,
  type LoadURLOptions,
  type Session,
  type WebContents,
  type WebPreferences
} from 'electron'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import type {
  CertificateDetails,
  NavigationSnapshot,
  NavigationSnapshotEntry,
  NewTabPageCommand,
  NewTabPageState,
  PageDialogResponse,
  Rect,
  Tab
} from '../../shared/types'
import { refusedFromDocument } from '../../shared/internalPages'
import { PAGE_HOST_CHANNEL } from '../../shared/pageScript'
import type { SafeBrowsingHit } from '../../shared/privacy'
import { isCertificateError, type SiteCertificate } from '../../shared/siteInfo'
import { inPlaceErrorPageScript } from '../../shared/zenPages'
import { certificateSiteOf } from '../../core/security'
import type { PageHint } from '../../shared/fullscreenHint'
import {
  DISMISSED_ANSWER,
  LEAVE_SITE_CHANNEL,
  type PageDialogAnswer,
  type PageDialogCall
} from '../../shared/pageDialogIpc'
import type { FormsCommand } from '../../shared/forms'
import {
  cdpFontFamilies,
  cdpFontFamilyChanges,
  chromiumFontPreferences,
  DEFAULT_FONT_SETTINGS,
  electronFontDefaults,
  FONT_RESTYLE_SCRIPT,
  fontSizesMove,
  sanitizeFontSettings,
  type ChromiumFontPreferences,
  type FontFamilySlot,
  type PageFontSettings
} from '../../shared/fonts'
import { defer } from '../../core/platform'
import { standinScale } from '../../shared/pageStandin'
import { clientSide, imageDimensions, type PageViewport } from '../../shared/capture'
import { hasForeignDebuggerOwner, recycleDebugger } from './pageDebugger'
import type { PdfRenderOptions } from '../../shared/print'
import type {
  AgentCapture,
  AgentCaptureOptions,
  ScreenshotOptions,
  AgentFrame,
  AgentInputEvent,
  InputModifier,
  InsertedCssOrigin,
  KeyEventInput,
  NavigationIntent,
  PageFlags,
  PageHostMessage,
  PageMessage,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost,
  WindowOpenDisposition,
  WindowOpenTicket
} from '../../core/platform'
import type { SessionManager } from './sessions'
import { downloadDir } from './downloads'
import { uniquePath } from './uniquePath'
import { frameById, frameIdOf } from './extensionApi/frames'
import type { ElectronWindow } from './window'

const pagePreload = join(__dirname, '../preload/page.js')

/** How long a page gets to hand over a frame before an overlay opens without its picture. */
const SNAPSHOT_TIMEOUT_MS = 600
/**
 * The stand-in's TRIGGER, in device pixels (design language v2 draft §9.5): a capture whose area
 * is at or under it is encoded as captured, 1:1 – no CSS-pixel width clamp; one past it is
 * scaled down to `SNAPSHOT_TARGET_PIXELS` before the encode (`snapshot`, `standinScale`). Set
 * where the two costs that matter reach their budgets on the runner-class machine (a 4-core
 * Xeon, the packaged build): the JPEG 90 encode, which holds the main thread, about two frames
 * (5–7 ms per Mpx: 35 ms at the 6.05 Mpx edge), and the renderer's decode, which gates the swap,
 * about three (6–9 ms per Mpx: 54 ms there). 6.2 Mpx serves every DPR-1 monitor through a
 * 3440 × 1440 ultrawide and a DPR-2 laptop's 1600 × 1000 window (3072 × 1968, 6.05 Mpx – the
 * documented edge, crisp) at 1:1; a 4K monitor at 200 % (3712 × 2128 of page, 7.9 Mpx) is past
 * it. The trigger follows the decode alone should the encode ever leave the main thread. The
 * numbers behind it are in `snapshot`'s JSDoc.
 */
const SNAPSHOT_MAX_PIXELS = 6_200_000
/**
 * The TARGET a capture past the trigger is scaled down to, in device pixels, with Skia's
 * Hamming-1 filter (`quality: 'good'`) rather than the default Lanczos-3 (`'best'`). Two numbers
 * and not one because a resize pays for itself only when it removes more than about a fifth of
 * the pixels on the swap (Hamming-1 costs 2–3.5 ms per input Mpx against the 6–9 per Mpx of
 * decode and 5–7 of encode it saves) or nearly half on the held stall (against the encode alone;
 * Lanczos-3, at 3.5–6.5 ms per input Mpx, costs about the encode it saves and pays there never),
 * so a single scale-to-the-ceiling policy hands the frames just past the ceiling a .8–1 scale
 * that loses on every axis – time, bytes and edges (a 4K-at-200 % page scaled to the trigger
 * measured 85.7 ms held against 42.1 for its 1:1 encode; a 2560 × 1440 page taken to 2.5 Mpx
 * 38.7 against 19.2, both softer) – hence trigger + target. 3.7 Mpx is a 2560 × 1440 monitor's
 * own area, so the drop lands on a picture no softer than that monitor's 1:1 (the 4K-at-200 %
 * page, 3712 × 2128, comes down to 2540 × 1456 at .68), and Hamming-1 on a picture already being
 * softened costs a point of fidelity for half Lanczos-3's time.
 */
const SNAPSHOT_TARGET_PIXELS = 3_700_000
/** The stand-in's JPEG quality (`snapshot`: the numbers behind it). */
const SNAPSHOT_JPEG_QUALITY = 90

/** Keys that never count as a gesture in Chromium's user-activation model. */
const NON_ACTIVATING_KEYS = new Set(['Escape', 'Shift', 'Control', 'Alt', 'Meta', 'AltGr'])

/**
 * Whether an input event on its way to the page grants it user activation: mouse and touch
 * presses, taps and key presses other than Escape and bare modifiers (as in Chromium).
 */
export function isActivatingInput(input: Electron.InputEvent): boolean {
  switch (input.type) {
    case 'mouseDown':
    case 'pointerDown':
    case 'touchEnd':
    case 'gestureTap':
      return true
    case 'rawKeyDown':
    case 'keyDown': {
      // Electron hands keyboard events over in the `before-input-event` shape (`key`); the typed
      // structure says `keyCode`. Accept either.
      const k = input as Partial<Electron.KeyboardInputEvent> & { key?: string }
      const key = k.key ?? k.keyCode ?? ''
      return !NON_ACTIVATING_KEYS.has(key)
    }
    default:
      return false
  }
}

/**
 * What the host knows about a navigation it started itself, for `webNavigation.onCommitted`'s
 * transition type; consumed by the next main-frame commit.
 */
export interface ViewNavigationHint {
  reload?: boolean
  history?: boolean
  typed?: boolean
}

/** What Electron hands `createWindow`: the window options plus the page Chromium made, if any. */
type ChildWindowOptions = BrowserWindowConstructorOptions & { webContents?: WebContents }

/**
 * A navigation the host started (address bar, back, reload) that the page's `beforeunload` may
 * object to; replayed when the user chooses to leave. Stale after this long.
 */
const HOST_NAVIGATION_TTL_MS = 30_000
/** A `confirmUnload` whose page neither goes nor objects by then is treated as not objecting. */
const UNLOAD_CHECK_TIMEOUT_MS = 5_000
/**
 * An entry's page state (scroll offset, form values) is kept up to this size; a larger one –
 * a page with a huge form – is left out rather than written into the profile on every commit.
 */
const PAGE_STATE_MAX_CHARS = 64 * 1024

/** A stored entry: URL and title, plus the engine's page state when it has one worth keeping. */
function snapshotEntry(entry: Electron.NavigationEntry): NavigationSnapshotEntry {
  const out: NavigationSnapshotEntry = { url: entry.url, title: entry.title }
  const state = entry.pageState
  if (typeof state === 'string' && state !== '' && state.length <= PAGE_STATE_MAX_CHARS) {
    out.pageState = state
  }
  return out
}

interface HostNavigation {
  at: number
  reload: boolean
  replay: () => void
}

/** A `confirmUnload` in flight: settled by the page going away or by the user's answer. */
interface UnloadCheck {
  promise: Promise<boolean>
  settle: (leave: boolean) => void
}

/**
 * The page fonts every new page view is made with (Settings › Appearance › Customize fonts,
 * CT-25): the setting as the core last handed it over (`ElectronTabViewHost.applyFonts`), in
 * the engine's terms. Web preferences are read once, as a page's contents are made; a page
 * already open takes a change over the DevTools protocol (`ElectronTabView.applyFonts`).
 */
let pageFonts: ChromiumFontPreferences = chromiumFontPreferences(DEFAULT_FONT_SETTINGS)
/** The setting behind `pageFonts` (what an open page is brought to). */
let pageFontSettings: PageFontSettings = DEFAULT_FONT_SETTINGS
/** The families a page has where the setting names none: Chrome's for this OS, as Electron installs them. */
const FONT_DEFAULTS = electronFontDefaults(process.platform)

/** One string per font setting, so a page knows whether it has the one that stands. */
function fontsKey(fonts: PageFontSettings): string {
  return JSON.stringify(fonts)
}

/** The setting behind a page's `fontsKey` (what it has), for the restyle decision in `sendFonts`. */
function fontsOf(key: string): PageFontSettings {
  return sanitizeFontSettings(JSON.parse(key))
}

/** What every tab page runs with; `session` picks the container (omitted for pages that exist). */
function pageWebPreferences(session?: Session): WebPreferences {
  return {
    ...(session ? { session } : {}),
    ...pageFonts,
    preload: pagePreload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    // Preloads reach sub-frames too: the extension API layer's preload installs `chrome.*`
    // in extension iframes (content-script UIs, extension pages embedding their own
    // frames); `page.ts` keeps to the top document.
    nodeIntegrationInSubFrames: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    spellcheck: true,
    safeDialogs: true,
    autoplayPolicy: 'document-user-activation-required',
    backgroundThrottling: true,
    scrollBounce: true,
    enableWebSQL: false
  }
}

/**
 * A tab page hosted in a `WebContentsView`. The view is a child of whichever window currently
 * owns the tab's live page (Zen's window sync moves it between windows). Built by
 * `ElectronTabViewHost`, which wires the core's events once the tab exists – a page Chromium
 * created for `window.open` is adopted after the fact.
 */
export class ElectronTabView implements TabView {
  /** Captured up front: on Electron 44 `view.webContents` is already undefined when `destroyed` fires. */
  readonly webContentsId: number
  /**
   * The page's `WebContents`, captured at creation. `WebContentsView.webContents` stops returning
   * the object once the contents are destroyed (a page closing itself, window close, quit), so
   * every method reads this stable reference instead – the object stays usable for
   * `isDestroyed()` and its id after teardown, and the core's late calls cannot throw.
   */
  private readonly wc: WebContents
  private host: ElectronWindow | null = null
  private visible = false
  private navigationHint: ViewNavigationHint | null = null
  /**
   * The main-frame certificate the current navigation was refused over (`certificate-error`),
   * handed to the core with the `did-fail-load` that follows so the interstitial can show it.
   */
  private refusedCertificate: { url: string; certificate: CertificateDetails } | null = null
  /**
   * A `window.open` / `target=_blank` the core may turn into a tab (`onCreatedNavigationTarget`);
   * returns the function that withdraws the announcement when it does not.
   */
  onNavigationTarget: ((source: WebContents, url: string) => () => void) | null = null
  private events!: TabViewEvents
  /** The user chose to leave: the next `beforeunload` objection is overruled. */
  private leaveApproved = false
  /** The last navigation this host started, for the "Leave site?" replay. */
  private hostNavigation: HostNavigation | null = null
  /** What the page itself was about to do, as its preload reported it (`navigate-intent`). */
  private pageIntent: { at: number; intent: NavigationIntent } | null = null
  private unloadCheck: UnloadCheck | null = null
  /**
   * The core asked for the keyboard (`focus()`) and the page has not answered yet. A tab being
   * activated is focused first and shown when the chrome reports the layout, a frame or two
   * later: its `focus` event arrives while it is still hidden, and is its own.
   */
  private keyboardAsked = false

  /**
   * The page fonts this page has (`fontsKey`): the setting its web preferences were made from,
   * then whatever a live change brought it to. Compared with the setting on each change and
   * each navigation (`applyFonts`, `refreshFonts`).
   */
  private fontsApplied = fontsKey(pageFontSettings)
  /** The families the page has by slot, so `Page.setFontFamilies` (once per agent) names only what changes. */
  private familiesApplied: Record<FontFamilySlot, string> = cdpFontFamilies(
    pageFontSettings,
    FONT_DEFAULTS
  )
  /** What the page's web preferences were made from: where the engine takes it back to. */
  private readonly fontsBorn = this.fontsApplied
  private readonly familiesBorn = this.familiesApplied
  /** Live font changes in flight, one after the other. */
  private fontsTurn: Promise<void> = Promise.resolve()

  constructor(
    readonly view: WebContentsView,
    private readonly owner: ElectronTabViewHost
  ) {
    this.wc = this.view.webContents
    this.webContentsId = this.wc.id
    this.view.setVisible(false)
    this.wc.on('blur', () => {
      this.keyboardAsked = false
      const win = this.win
      if (win) this.owner.keyboardLeft(win, this.wc)
    })
    this.wc.on('focus', () => {
      const asked = this.keyboardAsked
      this.keyboardAsked = false
      if (asked || this.visible) {
        this.events?.onFocused?.()
        return
      }
      // A page that is not on screen took the keyboard without the core asking for it. Electron
      // 44 gives a new WebContentsView the keyboard once its renderer is up, hidden or not, so a
      // tab opened in the background (a middle-clicked link, `target=_blank`) would leave the
      // next Ctrl+1..9 or Ctrl+W with a page nobody sees: a hidden widget drops its key events.
      // Deferred, and asked again then: the core may activate this very tab meanwhile. Not
      // reported as the page taking the keyboard either (`onFocused`), or the chrome would let
      // go of the control it is typing in over a focus that is handed back a moment later – the
      // empty pane's URL field (split-04) lost its cursor to the blank page made for the pane.
      defer(() => {
        const win = this.win
        if (!win || this.wc.isDestroyed() || !this.wc.isFocused()) return
        if (this.visible || this.keyboardAsked) {
          // Shown or asked for meanwhile: the keyboard is the page's own after all.
          this.events?.onFocused?.()
          return
        }
        this.owner.keyboardTaken(win, this.wc)
      })
    })
  }

  get webContents(): WebContents {
    return this.wc
  }

  /** The window the view is currently a child of (null while detached). */
  private get win(): BrowserWindow | null {
    const bw = this.host?.win
    return bw && !bw.isDestroyed() ? bw : null
  }

  /** Connect the page's events to its tab; called exactly once, right after the tab exists. */
  wire(events: TabViewEvents): void {
    this.events = events
    const wc = this.wc
    const ev = events
    const id = wc.id
    this.fontsRenderer = this.rendererPid()
    wc.on('did-start-loading', () => ev.onStartLoading())
    wc.on('did-stop-loading', () => ev.onStopLoading())
    wc.on('did-navigate', (_e, url) => {
      ev.onNavigated(url, false)
      this.fontsAfterNavigation()
    })
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) ev.onNavigated(url, true)
    })
    wc.on('page-title-updated', (_e, title) => ev.onTitleUpdated(title))
    wc.on('page-favicon-updated', (_e, favicons) => ev.onFaviconUpdated(favicons))
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (!isMainFrame || wc.isDestroyed()) return
      const refused = this.refusedCertificate
      this.refusedCertificate = null
      // The certificate the failure is about: refused for this site in this navigation.
      const certificate =
        refused &&
        isCertificateError(code) &&
        certificateSiteOf(refused.url) === certificateSiteOf(url)
          ? refused.certificate
          : null
      ev.onFailLoad(code, description, url, isCertificateError(code) ? { certificate } : undefined)
    })
    wc.on('render-process-gone', (_e, details) => ev.onCrashed(details.reason, details.exitCode))
    wc.on('audio-state-changed', (e) => ev.onAudioStateChanged(e.audible))
    wc.on('media-started-playing', () => ev.onMediaStateChanged(true))
    wc.on('media-paused', () => ev.onMediaStateChanged(false))
    wc.on('enter-html-full-screen', () => ev.onEnterHtmlFullscreen())
    wc.on('leave-html-full-screen', () => ev.onLeaveHtmlFullscreen())
    wc.on('devtools-opened', () => ev.onDevtoolsOpened())
    wc.on('devtools-closed', () => ev.onDevtoolsClosed())
    wc.on('found-in-page', (_e, result) => ev.onFoundInPage(result))
    wc.on('zoom-changed', (_e, direction) => ev.onZoomChanged(direction))
    wc.on('context-menu', (_e, params) => {
      // Extension context menus need Chrome's frame view of the click: the top document's URL,
      // the clicked sub-frame's URL (empty for the top document) and its frame id.
      const frame = params.frame ?? null
      const frameId = frame ? frameIdOf(frame) : 0
      // `linkText` and `mediaFlags` ride along in the spread for the link and media menus.
      ev.onContextMenu({
        ...params,
        pageURL: params.pageURL || wc.getURL(),
        frameURL: frameId === 0 ? '' : params.frameURL,
        frameId
      })
    })
    wc.on('before-input-event', (event, input) => {
      const key: KeyEventInput = {
        type: input.type as KeyEventInput['type'],
        key: input.key,
        control: input.control,
        alt: input.alt,
        shift: input.shift,
        meta: input.meta,
        isAutoRepeat: input.isAutoRepeat
      }
      if (ev.onKey(key)) event.preventDefault()
    })
    // `focus` is reported (`onFocused`) by the constructor's listener, which tells the page
    // taking the keyboard from a hidden view being handed it by mistake.
    wc.on('update-target-url', (_e, url) => ev.onTargetUrl(url))
    wc.on('will-prevent-unload', (event) => this.onWillPreventUnload(event))
    // Internal pages are the user's to open, never a web page's (Chrome's rule for chrome://):
    // a document's own navigation to zen:// or zenium:// is refused; loadURL (typed, a menu, a
    // deep link) does not raise this event and goes through. One rule with Android's WebView.
    wc.on('will-navigate', (event, url) => {
      if (refusedFromDocument(wc.getURL(), url)) {
        event.preventDefault()
        return
      }
      // An app window's page leaving its app: the core opens the address in a browser tab.
      if (ev.onWillNavigate(url)) event.preventDefault()
    })
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame) return
      // The row's throbber learns here whether the load is a same-document one (tabs-41).
      ev.onStartNavigation?.(details.url, details.isSameDocument)
      // The page is unloading (its `beforeunload` let it): nothing is left to replay.
      if (details.isSameDocument) return
      this.leaveApproved = false
      this.hostNavigation = null
      this.pageIntent = null
      // A refused certificate belongs to the navigation it happened in (which asks after this).
      this.refusedCertificate = null
    })
    wc.on('dom-ready', () => ev.onDomReady())
    // By the time this fires `this.view.webContents` no longer returns the object (Electron drops
    // the view's reference before emitting), which is why the captured `wc` is used throughout.
    wc.on('destroyed', () => {
      ev.onDestroyed()
      this.owner.forget(id)
    })
    // Trusted input on its way to the page: the core's user-activation clock for pop-ups.
    wc.on('input-event', (_e, input) => {
      if (isActivatingInput(input)) ev.onUserActivation()
    })
    wc.setWindowOpenHandler(({ url, disposition, features, referrer, postBody }) => {
      // Announced before the core creates the tab, so the new view finds the pending target.
      const cancelTarget = this.onNavigationTarget?.(wc, url)
      // Electron does not say whether the user asked; the core knows from the activation clock
      // and its pop-up blocker answers null for a window the page may not open.
      const ticket = ev.onOpenWindow(
        url,
        disposition as WindowOpenDisposition,
        null,
        features ?? ''
      )
      if (!ticket) {
        cancelTarget?.()
        return { action: 'deny' }
      }
      // Chromium's own bare window never shows. The page it creates for a script `window.open`
      // keeps its opener link and is adopted into the Zenium tab or window the core asked for; a
      // link's new window (Shift+click) gets a fresh page there. Only security preferences are
      // inherited, so the page preload is handed down explicitly. Like Chrome, the new page is
      // not torn down when its opener navigates away or closes.
      return {
        action: 'allow',
        outlivesOpener: true,
        overrideBrowserWindowOptions: { webPreferences: pageWebPreferences() },
        // Electron passes the page it created (if any) alongside the window options.
        createWindow: (options) =>
          this.owner.openTicket(ticket, this, (options as ChildWindowOptions).webContents, {
            httpReferrer: referrer,
            ...(postBody
              ? {
                  postData: postBody.data,
                  extraHeaders: `content-type: ${postBody.contentType}${
                    postBody.boundary ? `; boundary=${postBody.boundary}` : ''
                  }`
                }
              : {})
          })
      }
    })
  }

  /** A message from the page script (routed here by the platform's IPC handler). */
  dispatchPageMessage(message: PageMessage): void {
    if (message.type === 'navigate-intent') {
      // The page is about to navigate itself; kept for the "Leave site?" flow, not the core's.
      if (message.intent) this.pageIntent = { at: Date.now(), intent: message.intent }
      return
    }
    this.events.onPageMessage(message)
  }

  /** The request engine upgraded this page's navigation from `from` to `to` (HTTPS-only mode). */
  noteUpgraded(from: string, to: string): void {
    this.events.onUpgraded(from, to)
  }

  /** The request engine refused this page's navigation to `url` on Safe Browsing's word. */
  noteUnsafeNavigation(url: string, hit: SafeBrowsingHit): void {
    this.events.onUnsafeNavigation(url, hit)
  }

  // --- dialogs and beforeunload ----------------------------------------------

  /**
   * The page called `alert`, `confirm` or `prompt` (its preload asks over synchronous IPC, so
   * the page waits). `frameUrl` is the calling frame's; the dialog is titled after its site.
   */
  async askDialog(call: PageDialogCall, frameUrl: string): Promise<PageDialogAnswer> {
    if (this.wc.isDestroyed()) return DISMISSED_ANSWER
    const response: PageDialogResponse = await this.events.onDialog({
      kind: call.kind,
      message: call.message,
      defaultValue: call.defaultValue,
      frameUrl,
      pageUrl: this.wc.getURL()
    })
    return { accepted: response.accepted, value: response.value }
  }

  /**
   * The page's `beforeunload` handler objects to it going away. Electron decides synchronously,
   * so the page is kept (the event is not prevented) and the chrome asks; when the user chooses
   * to leave, the action is redone with the objection overruled: the host's own navigation from
   * its record, the page's own by the page (its preload replays what it was about to do), and a
   * close by the core, which carries on with the destroy once its check resolves.
   */
  private onWillPreventUnload(event: Electron.Event): void {
    if (this.leaveApproved) {
      this.leaveApproved = false
      event.preventDefault()
      return
    }
    const wc = this.wc
    const check = this.unloadCheck
    const now = Date.now()
    const host =
      this.hostNavigation && now - this.hostNavigation.at < HOST_NAVIGATION_TTL_MS
        ? this.hostNavigation
        : null
    const page =
      this.pageIntent && now - this.pageIntent.at < HOST_NAVIGATION_TTL_MS
        ? this.pageIntent.intent
        : null
    this.hostNavigation = null
    this.pageIntent = null
    const reload = !check && (host ? host.reload : page?.navigationType === 'reload')
    void this.events.onLeaveSite(reload).then((leave) => {
      if (check) {
        check.settle(leave)
        return
      }
      if (!leave || wc.isDestroyed()) return
      this.leaveApproved = true
      if (host) host.replay()
      else wc.send(LEAVE_SITE_CHANNEL)
    })
  }

  /**
   * Run the page's `beforeunload` handlers by closing with `waitForBeforeUnload`: a page that does
   * not object is gone at once (the core hears `destroyed` and closes the tab); one that objects
   * stays, and the answer to the chrome's question settles the promise.
   */
  confirmUnload(): Promise<boolean> {
    const wc = this.wc
    if (wc.isDestroyed()) return Promise.resolve(true)
    if (this.unloadCheck) return this.unloadCheck.promise
    let settle: (leave: boolean) => void = () => undefined
    const promise = new Promise<boolean>((resolve) => {
      const onGone = (): void => settle(true)
      // A renderer that never answers (hung) does not hold the close up, as in Chrome.
      const timer = setTimeout(() => settle(true), UNLOAD_CHECK_TIMEOUT_MS)
      settle = (leave) => {
        if (this.unloadCheck?.promise !== promise) return
        this.unloadCheck = null
        clearTimeout(timer)
        wc.off('destroyed', onGone)
        resolve(leave)
      }
      wc.once('destroyed', onGone)
      wc.once('will-prevent-unload', () => clearTimeout(timer))
    })
    this.unloadCheck = { promise, settle }
    wc.close({ waitForBeforeUnload: true })
    return promise
  }

  private recordHostNavigation(reload: boolean, replay: () => void): void {
    this.hostNavigation = { at: Date.now(), reload, replay }
  }

  // --- navigation -----------------------------------------------------------

  loadURL(url: string): void {
    // Address-bar entries and programmatic loads both arrive here; Chrome reports the latter as
    // `link` too, so no `typed` claim is made without knowing the source.
    this.navigationHint = {}
    this.recordHostNavigation(false, () => this.loadURL(url))
    void this.wc.loadURL(url).catch(() => undefined)
  }

  /**
   * `certificate-error` refused the main frame's certificate for `url`: kept for the failure
   * Chromium reports next, so the core can render the interstitial with it.
   */
  expectCertificateFailure(url: string, certificate: CertificateDetails): void {
    this.refusedCertificate = { url, certificate }
  }

  /**
   * The certificate interstitial, written into the empty document Chromium committed for the
   * failed load rather than loaded as a document of its own: the entry stays the failed
   * address's, so the tab shows that address, back leads to the page before and a load of the
   * address asks for it again. The error document is complete by the time `did-fail-load`
   * reports, so the script runs at once; the page preload is in that document and relays the
   * interstitial's controls like in any other.
   */
  showErrorPage(url: string): void {
    if (this.wc.isDestroyed()) return
    void this.wc
      .executeJavaScript(inPlaceErrorPageScript(new URL(url)), true)
      .catch(() => undefined)
  }

  /** The hint for the next main-frame commit, consumed once (`webNavigation.onCommitted`). */
  takeNavigationHint(): ViewNavigationHint {
    const hint = this.navigationHint ?? {}
    this.navigationHint = null
    return hint
  }

  getURL(): string {
    return this.wc.getURL()
  }

  getTitle(): string {
    return this.wc.getTitle()
  }

  canGoBack(): boolean {
    return this.wc.navigationHistory.canGoBack()
  }

  canGoForward(): boolean {
    return this.wc.navigationHistory.canGoForward()
  }

  goBack(): void {
    this.recordHostNavigation(false, () => this.goBack())
    this.wc.navigationHistory.goBack()
  }

  goForward(): void {
    this.recordHostNavigation(false, () => this.goForward())
    this.wc.navigationHistory.goForward()
  }

  goToIndex(index: number): void {
    if (this.wc.isDestroyed()) return
    const history = this.wc.navigationHistory
    if (index < 0 || index >= history.length()) return
    this.recordHostNavigation(false, () => this.goToIndex(index))
    history.goToIndex(index)
  }

  navigationEntries(): NavigationSnapshot {
    const wc = this.wc
    if (wc.isDestroyed()) return { entries: [], index: -1 }
    const history = wc.navigationHistory
    return {
      entries: history.getAllEntries().map((e) => snapshotEntry(e)),
      index: history.getActiveIndex()
    }
  }

  async restoreNavigation(snapshot: NavigationSnapshot): Promise<void> {
    const wc = this.wc
    if (wc.isDestroyed()) return
    const entries = snapshot.entries.filter((e) => typeof e.url === 'string' && e.url !== '')
    const index = Math.min(Math.max(snapshot.index, 0), entries.length - 1)
    const current = entries[index]
    if (!current) return
    // `navigationHistory.restore` arrived in Electron 34; older hosts (and a rejected restore,
    // e.g. on an entry the renderer refuses) fall back to loading the current entry alone.
    const history = wc.navigationHistory as Partial<Electron.NavigationHistory>
    if (typeof history.restore === 'function') {
      try {
        await history.restore({ entries, index })
        return
      } catch {
        if (wc.isDestroyed()) return
      }
    }
    await wc.loadURL(current.url).catch(() => undefined)
  }

  reload(ignoreCache: boolean): void {
    this.recordHostNavigation(true, () => this.reload(ignoreCache))
    if (ignoreCache) this.wc.reloadIgnoringCache()
    else this.wc.reload()
  }

  stop(): void {
    this.wc.stop()
  }

  hasDocument(): boolean {
    const url = this.wc.getURL()
    return url !== '' && url !== 'about:blank'
  }

  // --- media / zoom / find ----------------------------------------------------

  setMuted(muted: boolean): void {
    this.wc.setAudioMuted(muted)
  }

  isCurrentlyAudible(): boolean {
    return this.wc.isCurrentlyAudible()
  }

  setZoom(factor: number): void {
    this.wc.setZoomFactor(factor)
  }

  getZoom(): number {
    return this.wc.getZoomFactor()
  }

  findInPage(text: string, forward: boolean, newSession: boolean): void {
    // Electron: findNext=true begins a new session, false continues the current one.
    this.wc.findInPage(text, { forward, findNext: newSession })
  }

  stopFind(action: 'clearSelection' | 'keepSelection'): void {
    this.wc.stopFindInPage(action)
  }

  executeJavaScript(code: string, frameId?: number): Promise<unknown> {
    if (frameId) {
      const frame = frameById(this.wc, frameId)
      if (!frame || frame.detached)
        return Promise.reject(new Error(`Frame ${frameId} is no longer part of the page`))
      return frame.executeJavaScript(code, true)
    }
    return this.wc.executeJavaScript(code, true)
  }

  insertCSS(css: string, origin: InsertedCssOrigin = 'user'): Promise<string> {
    return this.wc.insertCSS(css, { cssOrigin: origin })
  }

  removeInsertedCSS(key: string): Promise<void> {
    return this.wc.removeInsertedCSS(key)
  }

  sendPageFlags(flags: PageFlags): void {
    this.wc.send('zen:page-flags', flags)
  }

  sendFormsCommand(command: FormsCommand): void {
    if (!this.wc.isDestroyed()) this.wc.send('zen:forms', command)
  }

  /** To the top document's page script (`preload/page.ts` listens on `PAGE_HOST_CHANNEL`). */
  postToPage(message: PageHostMessage): void {
    if (!this.wc.isDestroyed()) this.wc.send(PAGE_HOST_CHANNEL, message)
  }

  setZapMode(on: boolean): void {
    this.wc.send('zen:zap', on)
  }

  showHint(hint: PageHint | null): void {
    if (!this.wc.isDestroyed()) this.wc.send('zen:page-hint', hint)
  }

  /** Fresh `NewTabPageState` for a `zen://newtab` page (its preload listens on this channel). */
  sendNewTabState(state: NewTabPageState): void {
    if (!this.wc.isDestroyed()) this.wc.send('zen:newtab-state', state)
  }

  /** What a `zen://newtab` page's tile menu picked, for the page to carry out. */
  sendNewTabCommand(command: NewTabPageCommand): void {
    if (!this.wc.isDestroyed()) this.wc.send('zen:newtab-command', command)
  }

  setBackgroundColor(color: string): void {
    this.view.setBackgroundColor(color)
  }

  focus(): void {
    this.keyboardAsked = true
    this.wc.focus()
  }

  isFocused(): boolean {
    return !this.wc.isDestroyed() && this.wc.isFocused()
  }

  isDestroyed(): boolean {
    return this.wc.isDestroyed()
  }

  destroy(): void {
    this.detach()
    if (!this.wc.isDestroyed()) {
      this.wc.close({ waitForBeforeUnload: false })
    }
  }

  // --- placement ---------------------------------------------------------------

  attachTo(host: WindowHost): void {
    const target = host as ElectronWindow
    if (this.host === target) return
    this.detach()
    this.host = target
    const win = this.win
    if (!win) return
    this.owner.watchKeyboard(win)
    win.contentView.addChildView(this.view)
  }

  detach(): void {
    const win = this.win
    if (win) win.contentView.removeChildView(this.view)
    this.host = null
  }

  setBounds(rect: Rect): void {
    this.view.setBounds(rect)
  }

  setBorderRadius(radius: number): void {
    this.view.setBorderRadius(radius)
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.view.setVisible(visible)
  }

  isVisible(): boolean {
    return this.visible && this.view.getVisible()
  }

  bringToFront(): void {
    // Re-adding moves the view to the top of the z-order.
    const win = this.win
    if (win) win.contentView.addChildView(this.view)
  }

  // --- page operations -----------------------------------------------------------

  openDevTools(mode: 'toggle' | 'inspect' | 'console'): void {
    const wc = this.wc
    if (mode === 'toggle' && wc.isDevToolsOpened()) {
      wc.closeDevTools()
      return
    }
    wc.openDevTools({ mode: 'detach', activate: true })
    if (mode === 'inspect') wc.inspectElement(0, 0)
  }

  /**
   * Chrome's "Inspect": the inspector opens (detached, like every tab view's) on the node under
   * the click. `inspectElement` takes the `context-menu` event's own coordinates.
   */
  inspectElementAt(x: number, y: number): void {
    const wc = this.wc
    if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach', activate: true })
    wc.inspectElement(x, y)
  }

  downloadURL(url: string, options?: { saveAs?: boolean }): void {
    if (options?.saveAs) this.owner.downloads?.expectSaveAs(url)
    this.wc.downloadURL(url)
  }

  reloadFrame(frameId: number): void {
    const frame = frameById(this.wc, frameId)
    if (frame && !frame.detached) frame.reload()
  }

  clearCache(): Promise<void> {
    return this.wc.session.clearCache()
  }

  print(): void {
    this.wc.print()
  }

  /**
   * The preview's render: `printToPDF` takes the paper in inches, the margins in inches, the
   * scale as a factor and the ranges as Chrome's text – the form `pdfRenderOptions` already
   * gives. Header and footer are Chromium's own template (title and date above, address and page
   * numbers below), as Chrome's preview shows them.
   */
  async printToPDF(options: PdfRenderOptions): Promise<Uint8Array> {
    const buffer = await this.wc.printToPDF({
      landscape: options.landscape,
      printBackground: options.printBackground,
      scale: options.scale,
      pageSize: { width: options.pageSize.width, height: options.pageSize.height },
      margins: {
        top: options.margins.top,
        right: options.margins.right,
        bottom: options.margins.bottom,
        left: options.margins.left
      },
      ...(options.pageRanges ? { pageRanges: options.pageRanges } : {}),
      displayHeaderFooter: options.displayHeaderFooter,
      preferCSSPageSize: options.preferCSSPageSize
    })
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  }

  async savePage(suggestedName: string): Promise<string | null> {
    const options = {
      title: 'Save Page As',
      defaultPath: join(downloadDir(), suggestedName),
      filters: [{ name: 'Web Page, complete', extensions: ['html', 'htm'] }]
    }
    const win = this.win
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await this.wc.savePage(result.filePath, 'HTMLComplete')
    return result.filePath
  }

  /**
   * JPEG snapshot of the page, used to keep a preview behind overlays: dimmed under the URL bar,
   * Glance and a dialog, plain under a popover or the app menu (§6), where it stands in for the
   * live page for as long as the menu is up. A page that has not painted yet (still in its TLS
   * handshake, waiting on a sign-in) gives `capturePage` nothing to copy and the promise never
   * settles: the overlay that asked must not wait on it, so an unanswered capture counts as no
   * picture.
   *
   * Quality 90: at 65 the encoder haloed the text edges under an undimmed menu (#299's 5–7 % of
   * pixels off). Measured on the packaged build over a 1600×1000 window of prose: 90 takes the
   * frame's pixels more than 32 levels off the live page from 14.3 % to 13.8 % (10.6 → 8.6 % on
   * the default layout's 1352-wide page, where nothing is resampled), the mean channel error down
   * 9 % / 23 %, for 8.0 ms and 413 KB against 6.7 ms and 228 KB – PNG would be exact where the
   * page is not resampled, at 51 ms an encode, over the frame budget.
   *
   * The size (v2 draft §9.5, the stand-in's rule): the frame's capture at device pixels, 1:1 up
   * to a trigger area (`SNAPSHOT_MAX_PIXELS`, 6.2 Mpx) and past it scaled down, both sides
   * alike, to a target (`SNAPSHOT_TARGET_PIXELS`, 3.7 Mpx) with Hamming-1 – never a CSS-pixel
   * width clamp: under an undimmed popover the page must read as the page, and a resample
   * softens every text edge where a lower quality only costs the gradients. The 1400 clamp this
   * replaces resampled every frame wider than 1400 and, `capturePage` handing the device pixels
   * over as a 1x bitmap, every DPR-2 frame to a fifth of its pixels. Measured on the packaged
   * build (a 4-core Xeon under Xvfb, `--disable-gpu`; the #340 prose fixture; medians of 25
   * after 3 warm-ups; the text-edge crop is 420 × 144 CSS px of 16 px prose, its share of pixels
   * more than 32 levels off the live page): at 1920 × 1200 the page (1856 × 1184, 2.20 Mpx)
   * encodes 1:1 in 13.9 ms at 595 KB with the crop at 13.5 % (the codec alone), where the clamp
   * cost 11.9 ms of resize + 7.5 ms of encode for 24.3 %; at 2560 × 1440 (3.55 Mpx) 1:1 is
   * 19.2 ms at 657 KB for 13.5 %, against the clamp's 31.0 %; at DPR 2 (1600 × 1000 DIP,
   * 3072 × 1968, 6.05 Mpx – the trigger's edge) 1:1 is 34.9 ms at 1.2 MB for 5.6 % with the
   * renderer's decode at 54 ms, against the clamp's 19.7 %; a 4K monitor at 200 % (1920 × 1080
   * DIP, 3712 × 2128, 7.9 Mpx) is past the trigger and drops to 2540 × 1456: 20.9 ms of
   * Hamming-1 resize + 20.7 ms of encode at 760 KB for 13.0 %, the decode 29.9 ms – the main
   * thread held for what the 1:1 encode alone holds it (42.1 ms, for 1.3 MB, a 53 ms decode and
   * 5.4 %), the swap gated a frame and a half sooner, the payload near halved; Lanczos-3 to the
   * same target would hold it 68.9 ms, and scaling to the trigger 85.7, worse than 1:1 on every
   * axis. The capture itself is the frame's cost whatever the policy – 16 ms at 1920 and 2560,
   * 32–36 ms at DPR 2 – and is awaited, not held. Skia's Lanczos-3 resample (the default quality,
   * 3.5–6.5 ms per input Mpx) costs about what the encode of the source would (5–7 per Mpx), so a
   * frame scaled by it pays more than it saves on the main thread; Hamming-1 (1.9–3.5) halves the
   * resize and is what the target is reached with. The picture is drawn at the page's CSS size
   * whatever its pixels (`CoverImage`, `object-cover`), so a 1:1 capture at DPR 2 does not
   * double. The Android host's cover is its own copy and encode (`TabWebView.snapshot`).
   */
  async snapshot(): Promise<string | null> {
    try {
      const image = await Promise.race([
        this.wc.capturePage(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), SNAPSHOT_TIMEOUT_MS))
      ])
      if (!image || image.isEmpty()) return null
      const size = image.getSize()
      // `capturePage` hands the device pixels over as a 1x bitmap (`getScaleFactors()` is [1],
      // `getSize()` device pixels); the representation's scale is read all the same, so the
      // arithmetic stays in device pixels should a capture ever come with one of its own.
      const scales = image.getScaleFactors()
      const fit = standinScale(size.width, size.height, scales.length ? Math.max(...scales) : 1, {
        trigger: SNAPSHOT_MAX_PIXELS,
        target: SNAPSHOT_TARGET_PIXELS
      })
      // Past the trigger: Hamming-1 (`good`), not the default Lanczos-3 – half the time on a
      // picture that is being softened anyway (`SNAPSHOT_TARGET_PIXELS`).
      const scaled =
        fit.scale < 1
          ? image.resize({ width: fit.width, height: fit.height, quality: 'good' })
          : image
      return `data:image/jpeg;base64,${scaled.toJPEG(SNAPSHOT_JPEG_QUALITY).toString('base64')}`
    } catch {
      return null
    }
  }

  /**
   * The visible area through `capturePage`, or the whole document through the DevTools
   * protocol (`captureBeyondViewport`, cut at `MAX_CAPTURE_HEIGHT`); a full page the debugger
   * cannot paint (DevTools holds it, the page is gone) falls back to the visible area.
   */
  async screenshot(fileName: string, options: ScreenshotOptions = {}): Promise<string | null> {
    try {
      let png: Buffer | null = null
      if (options.fullPage) {
        try {
          const capture = await this.captureWithDevtools(
            { mode: 'fullPage', format: 'png' },
            'image/png',
            this.fullPageCut()
          )
          png = Buffer.from(capture.data, 'base64')
        } catch {
          /* the visible area below */
        }
      }
      if (!png) {
        const image = await this.wc.capturePage()
        if (image.isEmpty()) return null
        png = nativeImage.createFromBuffer(image.toPNG()).toPNG()
      }
      // Two screenshots in one second keep both files (`… (1).png`), as a download would.
      const filePath = uniquePath(downloadDir(), fileName)
      await writeFile(filePath, png)
      return filePath
    } catch {
      return null
    }
  }

  async copyImageAt(x: number, y: number): Promise<boolean> {
    try {
      this.wc.copyImageAt(x, y)
      return true
    } catch {
      return false
    }
  }

  replaceMisspelling(word: string): void {
    this.wc.replaceMisspelling(word)
  }

  addWordToDictionary(word: string): void {
    this.wc.session.addWordToSpellCheckerDictionary(word)
  }

  // --- AI agents -------------------------------------------------------------------

  /**
   * Trusted input for agents. It goes through the DevTools protocol's Input domain: unlike
   * `webContents.sendInputEvent`, which hands events straight to the main frame's widget, CDP
   * routes them through Chromium's input router, so a point inside a cross-origin iframe reaches
   * the frame's own process – as a person's click would – and the keyboard goes to the focused
   * frame. Coordinates are CSS pixels of the top viewport (CDP takes them as such at any zoom).
   * When the debugger cannot be attached the widget-level API is the fallback (in DIPs, main
   * frame only).
   */
  async sendInput(event: AgentInputEvent): Promise<void> {
    const wc = this.wc
    if (wc.isDestroyed()) return
    try {
      await this.withDebugger((dbg) => dispatchInputViaCdp(dbg, event))
      return
    } catch {
      /* no debugger for this page: fall back to the widget */
    }
    if (wc.isDestroyed()) return
    const zoom = wc.getZoomFactor()
    const px = (v: number): number => Math.round(v * zoom)
    switch (event.type) {
      case 'mouseMove':
        wc.sendInputEvent({ type: 'mouseMove', x: px(event.x), y: px(event.y) })
        return
      case 'click': {
        const modifiers = electronModifiers(event.modifiers)
        const x = px(event.x)
        const y = px(event.y)
        wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers })
        await nextTick()
        for (let i = 1; i <= Math.max(1, event.clickCount); i++) {
          wc.sendInputEvent({
            type: 'mouseDown',
            x,
            y,
            button: event.button,
            clickCount: i,
            modifiers
          })
          wc.sendInputEvent({
            type: 'mouseUp',
            x,
            y,
            button: event.button,
            clickCount: i,
            modifiers
          })
          await nextTick()
        }
        return
      }
      case 'key': {
        const keyCode = electronKeyCode(event.key)
        const modifiers = electronModifiers(event.modifiers)
        wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
        if (event.key.length === 1 || event.key === 'Enter')
          wc.sendInputEvent({ type: 'char', keyCode, modifiers })
        wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
        await nextTick()
        return
      }
      case 'text':
        await wc.insertText(event.text)
    }
  }

  /** The preload's isolated world: pages cannot see the agent runtime or tamper with it. */
  executeIsolatedJavaScript(code: string): Promise<unknown> {
    return this.wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code }], true)
  }

  /**
   * The page's frame tree for agents: the top frame first, then every sub-frame (parents before
   * children, siblings in insertion order), each with Chrome's frame id (see `frameIdOf`).
   */
  frames(): AgentFrame[] {
    const wc = this.wc
    if (wc.isDestroyed()) return []
    const focused = wc.focusedFrame
    const out: AgentFrame[] = []
    for (const frame of wc.mainFrame.framesInSubtree) {
      if (frame.detached) continue
      const parent = frame.parent
      out.push({
        id: frameIdOf(frame),
        parentId: parent ? frameIdOf(parent) : null,
        url: frame.url,
        origin: frame.origin,
        name: frame.name,
        focused: focused !== null && focused.frameTreeNodeId === frame.frameTreeNodeId
      })
    }
    return out
  }

  /**
   * Run `fn` with a DevTools session on the page, for the duration of the action only – the way
   * the resource governor holds its sessions (`resources/lifecycle.ts`): attached on demand when
   * the first action starts, detached when the last pending action ends, so no session lingers
   * on a page between tool calls. A session another client already holds (DevTools, the
   * governor's overrides) is used as is and left in place. Actions only send commands of the
   * domain they need (`Input.*`, `Page.*`); nothing here enables `Runtime`, so the page sees no
   * debugger-side script evaluation and nothing becomes attached to its JavaScript contexts.
   */
  private async withDebugger<T>(fn: (dbg: Electron.Debugger) => Promise<T>): Promise<T> {
    const dbg = this.wc.debugger
    if (this.cdpPending === 0 && !dbg.isAttached()) {
      dbg.attach('1.3')
      this.cdpAttachedHere = true
    }
    this.cdpPending++
    try {
      return await fn(dbg)
    } finally {
      this.cdpPending--
      if (this.cdpPending === 0 && this.cdpAttachedHere) {
        this.cdpAttachedHere = false
        if (!this.wc.isDestroyed() && dbg.isAttached()) {
          try {
            dbg.detach()
          } catch {
            /* already detached */
          }
        }
      }
    }
  }

  /** Actions in flight that hold the debugger through `withDebugger`. */
  private cdpPending = 0
  /** Whether the current session was opened by `withDebugger` (and is ours to close). */
  private cdpAttachedHere = false

  // --- page fonts (CT-25) -----------------------------------------------------------

  /**
   * Bring an open page to the page fonts that stand (`pageFontSettings`), over the DevTools
   * protocol: the web preferences a page's contents were made with cannot be changed after,
   * so `Page.setFontFamilies` and `Page.setFontSizes` do what a new page's preferences do. The
   * session is Zenium's shared one (`pageDebugger.ts`: the resource governor's overrides keep
   * it open on most pages); a page an extension's `chrome.debugger` holds is left alone, and
   * takes the change on its next load (`did-navigate` tries again; the setting's description
   * says so). The minimum font size has no protocol command: an open page keeps its floor until
   * its contents are remade (a sleeping tab waking, a new tab).
   *
   * `Page.setFontFamilies` may be sent once per agent lifetime ("Font families can only be set
   * once"): a page with no session of the governor's gets a fresh agent for every change (the
   * session is attached for the commands and detached after); on a long-lived session a second
   * family change recycles the session (`recycleDebugger`: the governor puts its overrides back
   * on the new one) and the fonts and the dark theme hold are re-sent on it.
   *
   * A size change restyles the open document by itself; a family change alone does not (Blink
   * recomputes only the elements whose style depends on font metrics, `FONT_RESTYLE_SCRIPT`
   * says why), so the top document is asked to, from the preload's isolated world, once the
   * commands are in. A same-process sub-frame's document follows at its next restyle (the
   * recorded limit; a frame in another process keeps the fonts it was made with until its next
   * load, as before).
   */
  refreshFonts(): void {
    if (this.wc.isDestroyed()) return
    const wanted = fontsKey(pageFontSettings)
    if (wanted === this.fontsApplied) return
    const fonts = pageFontSettings
    this.fontsTurn = this.fontsTurn.then(() => this.sendFonts(fonts, wanted)).catch(() => {})
  }

  /**
   * The engine re-applied the page's web preferences (a colour scheme flip re-reads them, and
   * with them the fonts the page was made with): what a live change brought is gone, so the
   * page reads as made and is brought to the setting again where it differs.
   */
  fontsChangedByEngine(): void {
    this.fontsApplied = this.fontsBorn
    this.familiesApplied = this.familiesBorn
    this.refreshFonts()
  }

  /** The renderer process the page's fonts were last accounted for in (seeded in `wire`). */
  private fontsRenderer: number | null = null

  private rendererPid(): number | null {
    try {
      return this.wc.getOSProcessId() || null
    } catch {
      return null
    }
  }

  /**
   * A navigation committed. Within one renderer the page's settings – and a live font change
   * with them – outlive the document; a new renderer starts from the web preferences the
   * contents were made with, unless a DevTools session stayed attached across the swap and
   * restored what it had set (the agent's state travels with the session). So a swap without a
   * session reads the page as made, and the setting goes out again where it differs.
   */
  private fontsAfterNavigation(): void {
    if (this.wc.isDestroyed()) return
    const renderer = this.rendererPid()
    const swapped = this.fontsRenderer !== null && renderer !== this.fontsRenderer
    this.fontsRenderer = renderer
    if (swapped && !this.wc.debugger.isAttached()) {
      this.fontsApplied = this.fontsBorn
      this.familiesApplied = this.familiesBorn
    }
    this.refreshFonts()
  }

  private async sendFonts(fonts: PageFontSettings, key: string): Promise<void> {
    if (this.wc.isDestroyed()) return
    // An extension's session is left alone: the change waits for the page's next load.
    if (hasForeignDebuggerOwner(this.wc.id)) return
    const families = cdpFontFamilies(fonts, FONT_DEFAULTS)
    // Only the slots that move are named: a family the user never chose keeps the engine's face.
    const changes = cdpFontFamilyChanges(this.familiesApplied, families)
    const sizes = chromiumFontPreferences(fonts)
    // What the page shows follows a size on its own; a family alone must be asked for.
    const restyle = changes !== null && !fontSizesMove(fontsOf(this.fontsApplied), fonts)
    try {
      await this.withDebugger(async (session) => {
        if (changes) {
          try {
            await session.sendCommand('Page.setFontFamilies', { fontFamilies: changes })
          } catch (error) {
            if (!/only be set once/i.test(String(error))) throw error
            // A long-lived session (the governor's overrides, the dark theme hold) set families
            // before: a fresh agent takes the new ones, the holds' overrides go back on it.
            await this.recycleSession()
            await session.sendCommand('Page.setFontFamilies', { fontFamilies: changes })
          }
          this.familiesApplied = families
        }
        await session.sendCommand('Page.setFontSizes', {
          fontSizes: { standard: sizes.defaultFontSize, fixed: sizes.defaultMonospaceFontSize }
        })
      })
      this.fontsApplied = key
      if (restyle && !this.wc.isDestroyed())
        await this.wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [
          { code: FONT_RESTYLE_SCRIPT }
        ])
    } catch {
      /* the page went away, or the engine refused: the next load or change tries again */
    }
  }

  /**
   * A fresh agent while an action holds the session (`withDebugger`): the governor drops the
   * session and puts its own overrides back on a new one (`recycleDebugger`); where it had none
   * the page is left detached and the hold attaches again. The dark theme override is re-sent,
   * being the session's.
   */
  private async recycleSession(): Promise<void> {
    await recycleDebugger(this.wc)
    if (this.wc.isDestroyed()) return
    const dbg = this.wc.debugger
    if (!dbg.isAttached()) {
      dbg.attach('1.3')
      this.cdpAttachedHere = true
    } else {
      // The governor's new session: it stays when the hold ends.
      this.cdpAttachedHere = false
    }
    if (this.darkeningApplied)
      await dbg.sendCommand('Emulation.setAutoDarkModeOverride', { enabled: true })
  }

  // --- dark theme for sites (CT-18) -------------------------------------------------

  /** The core's policy for this page's site ("Apply dark theme to sites" and its exceptions). */
  private darkening = false
  /** What the page is rendered with right now (the policy while the chrome is dark). */
  private darkeningApplied = false
  /** Resolves once the override in flight has been sent (the next change waits for it). */
  private darkeningTurn: Promise<void> = Promise.resolve()

  /**
   * Dark theme for sites: Chromium's auto dark mode over the DevTools protocol
   * (`Emulation.setAutoDarkModeOverride`), the engine behind Chrome Android's "Auto-darken web
   * content" – the page's colours are inverted and its images left alone, and a page with a dark
   * style of its own (`color-scheme: dark`) is left to it. Like the WebView's algorithmic
   * darkening it acts only while the chrome is dark (`nativeTheme` follows the Appearance
   * setting; a flip re-applies through the host). Chromium's `WebContentsForceDark` feature
   * switch would darken Zenium's own chrome too, hence the per-page override.
   *
   * The debugger stays attached while the override is on: an emulation override belongs to the
   * session and goes with it. `withDebugger` shares the attachment with captures and input.
   */
  setDarkening(on: boolean): void {
    this.darkening = on
    this.refreshDarkening()
  }

  /** The chrome's scheme or the policy changed: bring the page in line. */
  refreshDarkening(): void {
    if (this.wc.isDestroyed()) return
    const wanted = this.darkening && nativeTheme.shouldUseDarkColors
    if (wanted === this.darkeningApplied) return
    this.darkeningApplied = wanted
    this.darkeningTurn = this.darkeningTurn.then(() => this.sendDarkening(wanted)).catch(() => {})
  }

  /** Whether the override counts as one pending action in `cdpPending` (its hold). */
  private darkeningHold = false

  private async sendDarkening(on: boolean): Promise<void> {
    if (this.wc.isDestroyed()) return
    const dbg = this.wc.debugger
    if (on) {
      // Take a hold of the debugger for as long as the override is on.
      if (!this.darkeningHold) {
        if (this.cdpPending === 0 && !dbg.isAttached()) {
          try {
            dbg.attach('1.3')
            this.cdpAttachedHere = true
          } catch {
            this.darkeningApplied = false
            return
          }
        }
        this.cdpPending++
        this.darkeningHold = true
      }
      try {
        await dbg.sendCommand('Emulation.setAutoDarkModeOverride', { enabled: true })
        return
      } catch {
        /* the page went away, or the debugger is not ours: release the hold, retry on the next change */
        this.darkeningApplied = false
      }
    } else {
      try {
        if (dbg.isAttached()) await dbg.sendCommand('Emulation.setAutoDarkModeOverride', {})
      } catch {
        /* already gone */
      }
    }
    if (!this.darkeningHold) return
    this.darkeningHold = false
    this.cdpPending--
    if (this.cdpPending === 0 && this.cdpAttachedHere) {
      this.cdpAttachedHere = false
      if (!this.wc.isDestroyed() && dbg.isAttached()) {
        try {
          dbg.detach()
        } catch {
          /* already detached */
        }
      }
    }
  }

  setBackgroundThrottling(allowed: boolean): void {
    if (!this.wc.isDestroyed()) this.wc.setBackgroundThrottling(allowed)
  }

  /**
   * Full-page and region captures go through the DevTools protocol (`captureBeyondViewport`
   * paints what is scrolled out of view); the viewport uses the cheaper `capturePage`. When the
   * debugger cannot be attached (DevTools already open), the paint fails, or the session is an
   * extension's (`pageDebugger.ts`: `captureBeyondViewport` sets and clears a device-metrics
   * override, which would clobber the extension's own, so such a page is left to it), a full
   * page or region falls back to cropping the viewport paint and the answer says so
   * (`fallback: 'viewport'`).
   *
   * `capturePage` paints the whole widget, the page's classic scrollbar gutters included
   * (Linux, Windows; macOS's overlay scrollbars take no room); the visible-area picture – the
   * `viewport` mode and the fallback stand-in alike – is cut to the layout viewport minus the
   * gutters (`visibleAreaClip`), as Chrome's visible-area capture is, and a region's crop is
   * cut at that area's edge: the gutter is never part of a picture. Without the page's
   * geometry (it did not answer) the bitmap stands as it is.
   */
  async capture(options: AgentCaptureOptions): Promise<AgentCapture | null> {
    const wc = this.wc
    if (wc.isDestroyed()) return null
    const format = options.format
    const mimeType = format === 'png' ? 'image/png' : 'image/jpeg'
    let fallback: AgentCapture['fallback']
    if (options.mode !== 'viewport') {
      if (!hasForeignDebuggerOwner(wc.id)) {
        try {
          return await this.captureWithDevtools(options, mimeType, this.fullPageCut())
        } catch {
          /* fall through to capturePage */
        }
      }
      fallback = 'viewport'
    }
    try {
      let image = await wc.capturePage()
      if (image.isEmpty()) return null
      // `capturePage` hands the device pixels over as a 1x bitmap: CSS px times the page's device
      // pixel ratio (the display's scale times the zoom – `window.devicePixelRatio` carries both).
      const geometry = await this.viewport()
      const bitmap = image.getSize()
      const visible = geometry
        ? visibleAreaClip(geometry, bitmap)
        : { x: 0, y: 0, width: bitmap.width, height: bitmap.height }
      if (options.mode === 'region' && options.region) {
        // The region's CSS px minus the scroll offset, cut at the visible area's edge: the
        // gutter is never part of a region.
        const scroll = geometry ?? { scrollX: 0, scrollY: 0 }
        const ratio = geometry?.devicePixelRatio ?? wc.getZoomFactor()
        const r = options.region
        const x = Math.max(0, Math.round((r.x - scroll.scrollX) * ratio))
        const y = Math.max(0, Math.round((r.y - scroll.scrollY) * ratio))
        const width = Math.min(visible.width - x, Math.round(r.width * ratio))
        const height = Math.min(visible.height - y, Math.round(r.height * ratio))
        if (width <= 0 || height <= 0) return null
        image = image.crop({ x, y, width, height })
      } else if (visible.width < bitmap.width || visible.height < bitmap.height) {
        image = image.crop(visible)
      }
      const size = image.getSize()
      const buffer = format === 'png' ? image.toPNG() : image.toJPEG(75)
      const result: AgentCapture = {
        data: buffer.toString('base64'),
        mimeType,
        width: size.width,
        height: size.height
      }
      if (fallback) result.fallback = fallback
      return result
    } catch {
      return null
    }
  }

  /**
   * The page's geometry for the chrome's capture overlay (`shared/capture.ts`): read in the
   * isolated world (the page sees no script of ours), with the zoom factor from the engine.
   * `window.devicePixelRatio` in a Chromium page is the display's scale times the page zoom,
   * so it is the device pixels per page CSS pixel as `capturePage`'s bitmap has them. A page
   * that has not finished loading holds script evaluation until it has: an unanswered read
   * within `VIEWPORT_TIMEOUT_MS` counts as no geometry.
   */
  async viewport(): Promise<PageViewport | null> {
    const wc = this.wc
    if (wc.isDestroyed()) return null
    try {
      const raw = await Promise.race([
        wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code: VIEWPORT_SCRIPT }], true),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), VIEWPORT_TIMEOUT_MS))
      ])
      return pageViewportFrom(raw, wc.getZoomFactor())
    } catch {
      return null
    }
  }

  /**
   * The certificate behind the page, from the DevTools protocol's Security domain (enabling it
   * reports the current state at once). Null when the page is not https or the debugger is
   * taken (DevTools open).
   */
  async certificate(): Promise<SiteCertificate | null> {
    const wc = this.wc
    if (wc.isDestroyed() || !wc.getURL().startsWith('https:')) return null
    const dbg = wc.debugger
    const attachedHere = !dbg.isAttached()
    try {
      if (attachedHere) dbg.attach('1.3')
      const state = await new Promise<SecurityStateParams | null>((resolve) => {
        const done = (value: SecurityStateParams | null): void => {
          clearTimeout(timer)
          dbg.off('message', onMessage)
          resolve(value)
        }
        const onMessage = (_e: Electron.Event, method: string, params: unknown): void => {
          if (method === 'Security.visibleSecurityStateChanged') done(params as SecurityStateParams)
        }
        const timer = setTimeout(() => done(null), 1500)
        dbg.on('message', onMessage)
        dbg.sendCommand('Security.enable').catch(() => done(null))
      })
      await dbg.sendCommand('Security.disable').catch(() => undefined)
      const cert = state?.visibleSecurityState?.certificateSecurityState
      if (!cert) return null
      return {
        subject: cert.subjectName ?? '',
        issuer: cert.issuer ?? '',
        validFrom: typeof cert.validFrom === 'number' ? cert.validFrom * 1000 : null,
        validTo: typeof cert.validTo === 'number' ? cert.validTo * 1000 : null,
        protocol: cert.protocol ?? null
      }
    } catch {
      return null
    } finally {
      if (attachedHere) {
        try {
          dbg.detach()
        } catch {
          /* already detached */
        }
      }
    }
  }

  /**
   * A full page or a region of the document through `Page.captureScreenshot`. The rectangle is
   * measured in CSS pixels of the document (`AgentCaptureOptions.region`, the layout metrics'
   * `cssContentSize`) and handed over as `protocolClip` has it – in the page's zoomed pixels,
   * which is how Chromium reads a clip – so the picture is the rectangle at the page's device
   * pixel ratio, as `capturePage`'s bitmap is, whatever the zoom. `maxHeight` cuts a full page
   * in CSS pixels. The size reported is the picture's own, from its header.
   */
  private captureWithDevtools(
    options: AgentCaptureOptions,
    mimeType: string,
    maxHeight = MAX_CAPTURE_HEIGHT
  ): Promise<AgentCapture> {
    return this.withDebugger(async (dbg) => {
      const zoom = zoomFactorOf(this.wc)
      const metrics = (await dbg.sendCommand('Page.getLayoutMetrics')) as {
        cssContentSize?: { width: number; height: number }
        contentSize?: { width: number; height: number }
      }
      const content = cssContentSize(metrics, zoom)
      const cut = Math.max(1, Math.min(maxHeight, MAX_CAPTURE_HEIGHT))
      const area =
        options.mode === 'region' && options.region
          ? options.region
          : {
              x: 0,
              y: 0,
              width: Math.max(1, Math.round(content.width)),
              height: Math.max(1, Math.min(Math.round(content.height), cut))
            }
      const clip = protocolClip(area, zoom)
      const result = (await dbg.sendCommand('Page.captureScreenshot', {
        format: options.format,
        quality: options.format === 'jpeg' ? 75 : undefined,
        clip,
        captureBeyondViewport: true,
        fromSurface: true
      })) as { data: string }
      const size = imageDimensions(Buffer.from(result.data, 'base64')) ?? {
        width: Math.round(clip.width),
        height: Math.round(clip.height)
      }
      return { data: result.data, mimeType, width: size.width, height: size.height }
    })
  }

  /** Where this page's full-page paint is cut, for its zoom on the most scaled display. */
  private fullPageCut(): number {
    return fullPageCut(zoomFactorOf(this.wc), largestDisplayScale())
  }
}

/** The most scaled display's factor; 1 when the screen module cannot say (before the app is ready). */
function largestDisplayScale(): number {
  try {
    return Math.max(...screen.getAllDisplays().map((d) => d.scaleFactor), 1)
  } catch {
    return 1
  }
}

/** Chromium refuses textures much taller than this; very long pages are cut, not failed. */
const MAX_CAPTURE_HEIGHT = 12_000
/** The same limit in painted pixels, for a capture at the page's zoom on a scaled display. */
const MAX_CAPTURE_PIXELS = 16_000

/** The page's zoom factor, 1 for a view that cannot say (destroyed, or a host without one). */
function zoomFactorOf(wc: WebContents): number {
  try {
    const zoom = wc.getZoomFactor()
    return Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  } catch {
    return 1
  }
}

/**
 * The document's size in CSS pixels from `Page.getLayoutMetrics`: `cssContentSize` says so
 * directly; an older protocol's `contentSize` is in the page's zoomed pixels and is divided by
 * the zoom.
 */
function cssContentSize(
  metrics: {
    cssContentSize?: { width: number; height: number }
    contentSize?: { width: number; height: number }
  },
  zoom: number
): { width: number; height: number } {
  if (metrics.cssContentSize) return metrics.cssContentSize
  if (metrics.contentSize)
    return { width: metrics.contentSize.width / zoom, height: metrics.contentSize.height / zoom }
  return { width: 0, height: 0 }
}

/**
 * A rectangle of the document, in CSS pixels, as `Page.captureScreenshot`'s clip. Chromium lays
 * a zoomed page out in CSS pixels times the zoom factor and reads the clip in those (the page's
 * zoomed pixels: at 150 % the box at CSS (200, 900) is asked for at (300, 1350)); `scale` stays
 * 1 because the protocol adds the display's scale on its own, so the picture comes back at the
 * page's device pixel ratio – the display's scale times the zoom, `window.devicePixelRatio` –
 * as `capturePage`'s bitmap does. Measured in Electron 44 (Chromium 152): a CSS-pixel clip at
 * 150 % painted the area two thirds of the way to the box, and `scale: zoom` only enlarged it.
 */
export function protocolClip(
  rect: { x: number; y: number; width: number; height: number },
  zoom: number
): { x: number; y: number; width: number; height: number; scale: 1 } {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  return {
    x: rect.x * z,
    y: rect.y * z,
    width: rect.width * z,
    height: rect.height * z,
    scale: 1
  }
}

/**
 * Where a full-page paint is cut, in CSS pixels: at `MAX_CAPTURE_HEIGHT`, or sooner so the
 * painted picture – the document at the page's zoom times the display's scale – stays under
 * Chromium's texture height on the most scaled display.
 */
export function fullPageCut(zoom: number, displayScale: number): number {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const d = Number.isFinite(displayScale) && displayScale > 0 ? displayScale : 1
  return Math.max(1, Math.min(MAX_CAPTURE_HEIGHT, Math.floor(MAX_CAPTURE_PIXELS / (z * d))))
}

/** A page that has not finished loading holds script evaluation; the geometry read gives up after this. */
const VIEWPORT_TIMEOUT_MS = 1500

/**
 * The page's geometry, read in the isolated world: the layout viewport's scroll offset and
 * size (`innerWidth` × `innerHeight`, the scrollbar gutters included), the same minus the
 * gutters (`cw` × `ch`: the scrolling element's `clientWidth` × `clientHeight` – the root's in
 * standards mode, the body's in quirks mode, either way the viewport less a rendered
 * scrollbar), whether the document runs right-to-left (`direction: rtl` on the root – for the
 * chrome's information; the main frame's scrollbar stays on the right either way, see
 * `visibleAreaClip`), `devicePixelRatio` (the display's scale times the page zoom in a Chromium
 * page) and the document's scrollable size (the larger of the root's and the body's, never
 * smaller than the viewport). One expression, so a single evaluation answers it.
 */
const VIEWPORT_SCRIPT = `(function () {
  var d = document.documentElement, b = document.body, s = document.scrollingElement || d
  return {
    sx: window.scrollX, sy: window.scrollY,
    vw: window.innerWidth, vh: window.innerHeight,
    cw: s ? s.clientWidth : 0, ch: s ? s.clientHeight : 0,
    rtl: !!d && getComputedStyle(d).direction === 'rtl',
    dpr: window.devicePixelRatio,
    dw: Math.max(d ? d.scrollWidth : 0, b ? b.scrollWidth : 0, window.innerWidth),
    dh: Math.max(d ? d.scrollHeight : 0, b ? b.scrollHeight : 0, window.innerHeight)
  }
})()`

/**
 * `VIEWPORT_SCRIPT`'s answer as the chrome's `PageViewport`, with the engine's zoom factor
 * (the page cannot read its own). Null for anything but a full answer with finite numbers – a
 * page that did not answer in time, a view with no document – and null too for a viewport
 * of no size (a view not yet laid out), which nothing could be captured from. The area minus
 * the gutters (`cw` / `ch`) is taken within the visible area and is the visible area itself
 * when not reported (an answer from before it was read) or not laid out (0): no gutter then.
 */
export function pageViewportFrom(raw: unknown, zoom: number): PageViewport | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const num = (key: string): number | null => {
    const v = r[key]
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }
  const sx = num('sx')
  const sy = num('sy')
  const vw = num('vw')
  const vh = num('vh')
  const dpr = num('dpr')
  const dw = num('dw')
  const dh = num('dh')
  if (sx === null || sy === null || vw === null || vh === null || dw === null || dh === null)
    return null
  if (!(vw > 0) || !(vh > 0)) return null
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  return {
    scrollX: Math.max(0, sx),
    scrollY: Math.max(0, sy),
    width: vw,
    height: vh,
    clientWidth: clientSide(num('cw'), vw),
    clientHeight: clientSide(num('ch'), vh),
    rtl: r.rtl === true,
    zoom: z,
    devicePixelRatio: dpr !== null && dpr > 0 ? dpr : z,
    documentWidth: Math.max(dw, vw),
    documentHeight: Math.max(dh, vh)
  }
}

/**
 * The part of a `capturePage` bitmap that is page content – the layout viewport minus the
 * scrollbar gutters, as Chrome's visible-area capture paints it – in the bitmap's pixels: the
 * page's `clientWidth` × `clientHeight` at its device pixel ratio (the display's scale times
 * the zoom, which is what the bitmap is in), cut at the bitmap's edge and anchored at the
 * bitmap's top-left corner: Chromium draws the main frame's vertical scrollbar in the
 * right-hand columns and a horizontal one in the bottom rows whatever the document's direction
 * (Blink puts a right-to-left main frame's scrollbar on the left only under its
 * `placeRTLScrollbarsOnLeftSideInMainFrame` setting, which Chrome and Electron leave off –
 * measured on the packaged build with `dir="rtl"` on the root, on the body and by CSS; only
 * an element's own scroller follows `direction`). With overlay scrollbars
 * (`clientWidth === width`) this is the whole bitmap.
 *
 * Floored, not rounded: `clientWidth` is an integer of CSS pixels, so at a fractional ratio
 * (150 %: a 15 px scrollbar is 10 CSS px, but 769 content rows are 512.67 CSS px, reported as
 * 513) the product can overshoot the content by up to half a CSS pixel – rounding would keep a
 * one-pixel sliver of the scrollbar's track (measured in the proof at 150 %); flooring drops
 * at most one row or column of page content instead, which nothing can see. At an integer
 * ratio the cut is exact either way.
 */
export function visibleAreaClip(
  viewport: Pick<PageViewport, 'clientWidth' | 'clientHeight' | 'devicePixelRatio'>,
  bitmap: { width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const ratio =
    Number.isFinite(viewport.devicePixelRatio) && viewport.devicePixelRatio > 0
      ? viewport.devicePixelRatio
      : 1
  const width = Math.max(1, Math.min(bitmap.width, Math.floor(viewport.clientWidth * ratio)))
  const height = Math.max(1, Math.min(bitmap.height, Math.floor(viewport.clientHeight * ratio)))
  return { x: 0, y: 0, width, height }
}

/** The parts of `Security.visibleSecurityStateChanged` the site-information sheet uses. */
interface SecurityStateParams {
  visibleSecurityState?: {
    securityState?: string
    certificateSecurityState?: {
      protocol?: string
      subjectName?: string
      issuer?: string
      validFrom?: number
      validTo?: number
    }
  }
}

/** Electron runs `contextIsolation` preloads in world 999. */
const ISOLATED_WORLD_ID = 999

function nextTick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 12))
}

function electronModifiers(mods: InputModifier[]): Array<'shift' | 'control' | 'alt' | 'meta'> {
  const out: Array<'shift' | 'control' | 'alt' | 'meta'> = []
  for (const m of mods) {
    if (m === 'Shift') out.push('shift')
    else if (m === 'Control') out.push('control')
    else if (m === 'Alt') out.push('alt')
    else if (m === 'Meta') out.push('meta')
  }
  return out
}

/** CDP's `Input.*` modifier bit field: Alt=1, Ctrl=2, Meta=4, Shift=8. */
function cdpModifiers(mods: InputModifier[]): number {
  let bits = 0
  for (const m of mods) {
    if (m === 'Alt') bits |= 1
    else if (m === 'Control') bits |= 2
    else if (m === 'Meta') bits |= 4
    else if (m === 'Shift') bits |= 8
  }
  return bits
}

/** Named keys agents press: DOM `code` and Windows virtual key code (what `keyCode` reports). */
const CDP_NAMED_KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9, text: '\t' },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  Insert: { code: 'Insert', vk: 45 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  Shift: { code: 'ShiftLeft', vk: 16 },
  Control: { code: 'ControlLeft', vk: 17 },
  Alt: { code: 'AltLeft', vk: 18 },
  Meta: { code: 'MetaLeft', vk: 91 },
  CapsLock: { code: 'CapsLock', vk: 20 },
  ContextMenu: { code: 'ContextMenu', vk: 93 }
}

/** US layout: printable characters → DOM `code` and virtual key code (shifted ones share both). */
const CDP_CHAR_KEYS: Record<string, { code: string; vk: number }> = {
  ' ': { code: 'Space', vk: 32 },
  '`': { code: 'Backquote', vk: 192 },
  '~': { code: 'Backquote', vk: 192 },
  '-': { code: 'Minus', vk: 189 },
  _: { code: 'Minus', vk: 189 },
  '=': { code: 'Equal', vk: 187 },
  '+': { code: 'Equal', vk: 187 },
  '[': { code: 'BracketLeft', vk: 219 },
  '{': { code: 'BracketLeft', vk: 219 },
  ']': { code: 'BracketRight', vk: 221 },
  '}': { code: 'BracketRight', vk: 221 },
  '\\': { code: 'Backslash', vk: 220 },
  '|': { code: 'Backslash', vk: 220 },
  ';': { code: 'Semicolon', vk: 186 },
  ':': { code: 'Semicolon', vk: 186 },
  "'": { code: 'Quote', vk: 222 },
  '"': { code: 'Quote', vk: 222 },
  ',': { code: 'Comma', vk: 188 },
  '<': { code: 'Comma', vk: 188 },
  '.': { code: 'Period', vk: 190 },
  '>': { code: 'Period', vk: 190 },
  '/': { code: 'Slash', vk: 191 },
  '?': { code: 'Slash', vk: 191 },
  '!': { code: 'Digit1', vk: 49 },
  '@': { code: 'Digit2', vk: 50 },
  '#': { code: 'Digit3', vk: 51 },
  $: { code: 'Digit4', vk: 52 },
  '%': { code: 'Digit5', vk: 53 },
  '^': { code: 'Digit6', vk: 54 },
  '&': { code: 'Digit7', vk: 55 },
  '*': { code: 'Digit8', vk: 56 },
  '(': { code: 'Digit9', vk: 57 },
  ')': { code: 'Digit0', vk: 48 }
}

/** A DOM key name as the `Input.dispatchKeyEvent` fields Chromium wants. */
function cdpKey(key: string): { key: string; code: string; vk: number; text: string | undefined } {
  const named = CDP_NAMED_KEYS[key]
  if (named) return { key, code: named.code, vk: named.vk, text: named.text }
  const fn = /^F(\d{1,2})$/.exec(key)
  if (fn && Number(fn[1]) >= 1 && Number(fn[1]) <= 24)
    return { key, code: key, vk: 111 + Number(fn[1]), text: undefined }
  if (key.length !== 1) return { key, code: key, vk: 0, text: undefined }
  if (/[a-z]/i.test(key))
    return { key, code: `Key${key.toUpperCase()}`, vk: key.toUpperCase().charCodeAt(0), text: key }
  if (/\d/.test(key)) return { key, code: `Digit${key}`, vk: key.charCodeAt(0), text: key }
  const punct = CDP_CHAR_KEYS[key]
  return { key, code: punct?.code ?? '', vk: punct?.vk ?? 0, text: key }
}

/**
 * Deliver an agent input event through the DevTools protocol (`Input.dispatchMouseEvent`,
 * `Input.dispatchKeyEvent`, `Input.insertText`); each command resolves once the page has
 * handled the event.
 */
async function dispatchInputViaCdp(dbg: Electron.Debugger, event: AgentInputEvent): Promise<void> {
  switch (event.type) {
    case 'mouseMove':
      await dbg.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: event.x,
        y: event.y,
        button: 'none'
      })
      return
    case 'click': {
      const modifiers = cdpModifiers(event.modifiers)
      const { x, y, button } = event
      await dbg.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: 'none',
        modifiers
      })
      for (let i = 1; i <= Math.max(1, event.clickCount); i++) {
        await dbg.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button,
          clickCount: i,
          modifiers
        })
        await dbg.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button,
          clickCount: i,
          modifiers
        })
      }
      return
    }
    case 'key': {
      const modifiers = cdpModifiers(event.modifiers)
      const k = cdpKey(event.key)
      // A keyDown that carries text is what produces the keypress/input; with Control, Alt or
      // Meta held the key is a shortcut and types nothing (a bare rawKeyDown instead).
      const shortcut = (modifiers & 7) !== 0
      const base = {
        key: k.key,
        code: k.code,
        windowsVirtualKeyCode: k.vk,
        nativeVirtualKeyCode: k.vk,
        modifiers
      }
      await dbg.sendCommand('Input.dispatchKeyEvent', {
        ...base,
        type: !shortcut && k.text ? 'keyDown' : 'rawKeyDown',
        ...(!shortcut && k.text ? { text: k.text, unmodifiedText: k.text } : {})
      })
      await dbg.sendCommand('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
      return
    }
    case 'text':
      await dbg.sendCommand('Input.insertText', { text: event.text })
  }
}

/** DOM key names → Electron accelerator key codes. */
function electronKeyCode(key: string): string {
  switch (key) {
    case 'ArrowUp':
      return 'Up'
    case 'ArrowDown':
      return 'Down'
    case 'ArrowLeft':
      return 'Left'
    case 'ArrowRight':
      return 'Right'
    case ' ':
      return 'Space'
    default:
      return key
  }
}

/** The downloads host's side of "Save … As…": the next transfer of the URL asks where to save. */
export interface SaveAsDownloads {
  expectSaveAs(url: string): void
}

/** Creates `WebContentsView`s and maps their web contents back to tabs. */
export class ElectronTabViewHost implements TabViewHost {
  private readonly byWebContentsId = new Map<number, ElectronTabView>()
  private readonly byTabId = new Map<string, ElectronTabView>()
  private readonly tabIds = new Map<number, string>()
  private readonly viewListeners = new Set<(view: ElectronTabView) => void>()
  /** Per window, the page or chrome that last lost the keyboard – a hidden page gives it back there. */
  private readonly lastKeyboard = new WeakMap<BrowserWindow, WebContents>()
  private readonly keyboardWatched = new WeakSet<BrowserWindow>()

  constructor(
    private readonly sessions: SessionManager,
    readonly downloads: SaveAsDownloads | null = null
  ) {
    // Dark theme for sites acts only while the chrome is dark: a scheme flip (the OS, the
    // Appearance setting) turns every page's override on or off.
    nativeTheme.on('updated', () => {
      for (const view of this.byWebContentsId.values()) {
        view.refreshDarkening()
        // The engine re-reads every page's web preferences on a scheme flip, which takes a
        // live font change back to the fonts the page was made with: sent again.
        view.fontsChangedByEngine()
      }
    })
  }

  /**
   * The page fonts (CT-25) for every page view to come – the web preferences they are made
   * with – and for every page open now, live where the page's debugger is free
   * (`ElectronTabView.refreshFonts`).
   */
  applyFonts(fonts: PageFontSettings): void {
    pageFontSettings = fonts
    pageFonts = chromiumFontPreferences(fonts)
    for (const view of this.byWebContentsId.values()) view.refreshFonts()
  }

  /** The page fonts every new page view is made with right now (for the tests). */
  static currentFonts(): PageFontSettings {
    return pageFontSettings
  }

  /** Follow the window's own chrome for the keyboard, as every tab page in it is followed. */
  watchKeyboard(win: BrowserWindow): void {
    if (this.keyboardWatched.has(win)) return
    this.keyboardWatched.add(win)
    win.webContents.on('blur', () => this.keyboardLeft(win, win.webContents))
  }

  keyboardLeft(win: BrowserWindow, contents: WebContents): void {
    this.lastKeyboard.set(win, contents)
  }

  /**
   * A page not on screen has the keyboard: back to the page or chrome that lost it, when that
   * is still something the user can see; the chrome otherwise (its shortcuts always work).
   */
  keyboardTaken(win: BrowserWindow, taker: WebContents): void {
    if (win.isDestroyed()) return
    if (!win.isFocused()) {
      // Focusing a page focuses its window as well (Linux, macOS): when the user is in another
      // window, the keyboard stays there and the hidden page is looked at again on their return.
      win.once('focus', () => {
        const view = this.byWebContentsId.get(taker.id)
        if (view && !view.isVisible() && !taker.isDestroyed() && taker.isFocused()) {
          this.keyboardTaken(win, taker)
        }
      })
      return
    }
    const previous = this.lastKeyboard.get(win)
    const view = previous ? this.byWebContentsId.get(previous.id) : undefined
    const visible =
      previous !== undefined &&
      !previous.isDestroyed() &&
      previous !== taker &&
      (previous === win.webContents || (view !== undefined && view.isVisible()))
    if (visible) previous.focus()
    else win.webContents.focus()
  }

  createView(tab: Tab, events: TabViewEvents, host: WindowHost): TabView {
    const view = new ElectronTabView(
      new WebContentsView({
        webPreferences: pageWebPreferences(this.sessions.get(tab.containerId))
      }),
      this
    )
    view.wire(events)
    view.attachTo(host)
    this.track(view, tab.id)
    return view
  }

  /** Follow every tab view for its lifetime (the ones already alive included). */
  onViewCreated(listener: (view: ElectronTabView) => void): () => void {
    this.viewListeners.add(listener)
    for (const view of this.byWebContentsId.values()) listener(view)
    return () => this.viewListeners.delete(listener)
  }

  /**
   * Complete the core's answer to a page opening a window (Electron's `createWindow` callback).
   * The new tab adopts `guest`, the opener-linked page Chromium made for a script `window.open`;
   * a window opened from a link has no page yet and gets a fresh one in the opener's session,
   * pointed at the URL. Returns the page Electron should consider the child window's.
   *
   * The adopted page is given the tab page preferences again: Electron applies a `webPreferences`
   * handed in next to an existing `webContents` to that page (`CreateFromWebPreferences`), and
   * without them the page preload the window-open handler named never runs in the pop-up – no
   * tab-modal dialogs, no password forms, no `window.chrome` completion, so a "Sign in with
   * Google" pop-up was refused where the same page in a tab was not.
   */
  openTicket(
    ticket: WindowOpenTicket,
    opener: ElectronTabView,
    guest: WebContents | undefined,
    load: LoadURLOptions
  ): WebContents {
    const view = new ElectronTabView(
      guest
        ? new WebContentsView({ webContents: guest, webPreferences: pageWebPreferences() })
        : new WebContentsView({
            webPreferences: pageWebPreferences(opener.webContents.session)
          }),
      this
    )
    const { tab, events } = ticket.adopt(view)
    view.wire(events)
    this.track(view, tab.id)
    // A link's new window navigates from here (Electron only does so for windows it creates);
    // the referrer and any form body come along as they would in Chrome.
    if (!guest) void view.webContents.loadURL(ticket.url, load).catch(() => undefined)
    return guest ?? view.webContents
  }

  /** A page went away; its web contents id no longer maps to a tab. */
  forget(webContentsId: number): void {
    const view = this.byWebContentsId.get(webContentsId)
    const tabId = this.tabIds.get(webContentsId)
    this.byWebContentsId.delete(webContentsId)
    this.tabIds.delete(webContentsId)
    if (tabId !== undefined && this.byTabId.get(tabId) === view) this.byTabId.delete(tabId)
  }

  /** Map the page to its tab, then let the followers (the extension API layer) see the view. */
  private track(view: ElectronTabView, tabId: string): void {
    this.byWebContentsId.set(view.webContentsId, view)
    this.byTabId.set(tabId, view)
    this.tabIds.set(view.webContentsId, tabId)
    for (const listener of this.viewListeners) listener(view)
  }

  /**
   * A preloaded new tab page became a real tab: its messages (and the extension API's view of
   * it) now route to that tab instead of the placeholder it loaded under.
   */
  retargetView(view: TabView, tabId: string): void {
    const target = view as ElectronTabView
    if (this.byWebContentsId.get(target.webContentsId) !== target) return
    const previous = this.tabIds.get(target.webContentsId)
    if (previous !== undefined && this.byTabId.get(previous) === target)
      this.byTabId.delete(previous)
    this.tabIds.set(target.webContentsId, tabId)
    this.byTabId.set(tabId, target)
  }

  tabIdForWebContents(wc: WebContents): string | undefined {
    return this.tabIds.get(wc.id)
  }

  viewForWebContents(wc: WebContents): ElectronTabView | undefined {
    return this.byWebContentsId.get(wc.id)
  }

  /** Every live tab view. */
  all(): Iterable<ElectronTabView> {
    return this.byWebContentsId.values()
  }

  /** The live view of the tab `tabId` (what a request's `tabId` names). */
  viewForTab(tabId: string): ElectronTabView | undefined {
    return this.byTabId.get(tabId)
  }
}

/** Copy an image on the clipboard from a URL (data: or remote). */
export async function copyImageFromUrl(url: string): Promise<boolean> {
  try {
    let image: Electron.NativeImage
    if (url.startsWith('data:')) {
      image = nativeImage.createFromDataURL(url)
    } else {
      const res = await net.fetch(url)
      image = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()))
    }
    if (image.isEmpty()) return false
    // Electron 44 replaced clipboard.writeImage with the W3C-shaped clipboard.write(ClipboardItem[]).
    const png = new Uint8Array(image.toPNG())
    await clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })
    ])
    return true
  } catch {
    return false
  }
}

export function defaultDownloadsDirectory(): string {
  return app.getPath('downloads')
}
