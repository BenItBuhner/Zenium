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
import { defer } from '../../core/platform'
import type { PdfRenderOptions, PrintJobOptions } from '../../shared/print'
import type {
  AgentCapture,
  AgentCaptureOptions,
  ScreenshotOptions,
  AgentFrame,
  AgentInputEvent,
  InputModifier,
  KeyEventInput,
  NavigationIntent,
  PageFlags,
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
import { frameById, frameIdOf } from './extensionApi/frames'
import type { ElectronWindow } from './window'

const pagePreload = join(__dirname, '../preload/page.js')

/** How long a page gets to hand over a frame before an overlay opens without its picture. */
const SNAPSHOT_TIMEOUT_MS = 600

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

/** What every tab page runs with; `session` picks the container (omitted for pages that exist). */
function pageWebPreferences(session?: Session): WebPreferences {
  return {
    ...(session ? { session } : {}),
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
      if (asked || this.visible) return
      // A page that is not on screen took the keyboard without the core asking for it. Electron
      // 44 gives a new WebContentsView the keyboard once its renderer is up, hidden or not, so a
      // tab opened in the background (a middle-clicked link, `target=_blank`) would leave the
      // next Ctrl+1..9 or Ctrl+W with a page nobody sees: a hidden widget drops its key events.
      // Deferred, and asked again then: the core may activate this very tab meanwhile.
      defer(() => {
        const win = this.win
        if (!win || this.visible || this.keyboardAsked) return
        if (this.wc.isDestroyed() || !this.wc.isFocused()) return
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
    wc.on('did-start-loading', () => ev.onStartLoading())
    wc.on('did-stop-loading', () => ev.onStopLoading())
    wc.on('did-navigate', (_e, url) => ev.onNavigated(url, false))
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
    wc.on('render-process-gone', (_e, details) => ev.onCrashed(details.reason))
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
    wc.on('update-target-url', (_e, url) => ev.onTargetUrl(url))
    wc.on('will-prevent-unload', (event) => this.onWillPreventUnload(event))
    // Internal pages are the user's to open, never a web page's (Chrome's rule for chrome://):
    // a document's own navigation to zen:// or zenium:// is refused; loadURL (typed, a menu, a
    // deep link) does not raise this event and goes through. One rule with Android's WebView.
    wc.on('will-navigate', (event, url) => {
      if (refusedFromDocument(wc.getURL(), url)) event.preventDefault()
    })
    wc.on('did-start-navigation', (details) => {
      // The page is unloading (its `beforeunload` let it): nothing is left to replay.
      if (!details.isMainFrame || details.isSameDocument) return
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

  insertCSS(css: string): Promise<string> {
    return this.wc.insertCSS(css, { cssOrigin: 'user' })
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

  /**
   * The job: `print` with `silent`, the printer's device name and the rest of the options as
   * `printJobOptions` shaped them (microns, a percentage, 0-based ranges, pixel margins). The
   * callback's failure reason becomes the rejection.
   */
  printWith(options: PrintJobOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const { header, footer, ...rest } = options
      this.wc.print(
        {
          ...rest,
          margins: options.margins as Electron.Margins,
          ...(header !== undefined ? { header } : {}),
          ...(footer !== undefined ? { footer } : {})
        },
        (success, failureReason) => {
          if (success) resolve()
          else reject(new Error(failureReason || 'The print job failed'))
        }
      )
    })
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
   * JPEG snapshot of the page, used to keep a dimmed preview behind overlays (URL bar, Glance).
   * A page that has not painted yet (still in its TLS handshake, waiting on a sign-in) gives
   * `capturePage` nothing to copy and the promise never settles: the overlay that asked must not
   * wait on it, so an unanswered capture counts as no picture.
   */
  async snapshot(): Promise<string | null> {
    try {
      const image = await Promise.race([
        this.wc.capturePage(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), SNAPSHOT_TIMEOUT_MS))
      ])
      if (!image || image.isEmpty()) return null
      const size = image.getSize()
      const scaled = size.width > 1400 ? image.resize({ width: 1400 }) : image
      return `data:image/jpeg;base64,${scaled.toJPEG(65).toString('base64')}`
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
            fullPagePaint(
              this.wc.getZoomFactor(),
              Math.max(...screen.getAllDisplays().map((d) => d.scaleFactor), 1)
            )
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
      const filePath = join(downloadDir(), fileName)
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
   * debugger cannot be attached (DevTools already open) regions fall back to cropping the
   * viewport paint.
   */
  async capture(options: AgentCaptureOptions): Promise<AgentCapture | null> {
    const wc = this.wc
    if (wc.isDestroyed()) return null
    const format = options.format
    const mimeType = format === 'png' ? 'image/png' : 'image/jpeg'
    if (options.mode !== 'viewport') {
      try {
        return await this.captureWithDevtools(options, mimeType)
      } catch {
        /* fall through to capturePage */
      }
    }
    try {
      let image = await wc.capturePage()
      if (image.isEmpty()) return null
      if (options.mode === 'region' && options.region) {
        // capturePage works in DIPs relative to the view: CSS px × zoom, minus the scroll offset.
        const zoom = wc.getZoomFactor()
        const scroll = (await wc
          .executeJavaScript('({x: window.scrollX, y: window.scrollY})', true)
          .catch(() => ({ x: 0, y: 0 }))) as { x: number; y: number }
        const size = image.getSize()
        const r = options.region
        const x = Math.max(0, Math.round((r.x - scroll.x) * zoom))
        const y = Math.max(0, Math.round((r.y - scroll.y) * zoom))
        const width = Math.min(size.width - x, Math.round(r.width * zoom))
        const height = Math.min(size.height - y, Math.round(r.height * zoom))
        if (width <= 0 || height <= 0) return null
        image = image.crop({ x, y, width, height })
      }
      const size = image.getSize()
      const buffer = format === 'png' ? image.toPNG() : image.toJPEG(75)
      return { data: buffer.toString('base64'), mimeType, width: size.width, height: size.height }
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
   * `paint.scale` multiplies the CSS pixels of the clip (1 for the agents, who reason in CSS
   * pixels; the page zoom for a person's full-page screenshot); `paint.maxHeight` cuts the
   * document in CSS pixels.
   */
  private captureWithDevtools(
    options: AgentCaptureOptions,
    mimeType: string,
    paint: { scale: number; maxHeight: number } = { scale: 1, maxHeight: MAX_CAPTURE_HEIGHT }
  ): Promise<AgentCapture> {
    return this.withDebugger(async (dbg) => {
      const metrics = (await dbg.sendCommand('Page.getLayoutMetrics')) as {
        cssContentSize?: { width: number; height: number }
        contentSize?: { width: number; height: number }
        cssLayoutViewport?: { clientWidth: number; clientHeight: number }
      }
      const content = metrics.cssContentSize ?? metrics.contentSize ?? { width: 0, height: 0 }
      const maxHeight = Math.max(1, Math.min(paint.maxHeight, MAX_CAPTURE_HEIGHT))
      const clip =
        options.mode === 'region' && options.region
          ? { ...options.region, scale: 1 }
          : {
              x: 0,
              y: 0,
              width: Math.max(1, Math.round(content.width)),
              height: Math.max(1, Math.min(Math.round(content.height), maxHeight)),
              scale: paint.scale
            }
      const result = (await dbg.sendCommand('Page.captureScreenshot', {
        format: options.format,
        quality: options.format === 'jpeg' ? 75 : undefined,
        clip,
        captureBeyondViewport: true,
        fromSurface: true
      })) as { data: string }
      return {
        data: result.data,
        mimeType,
        width: Math.round(clip.width),
        height: Math.round(clip.height)
      }
    })
  }
}

/** Chromium refuses textures much taller than this; very long pages are cut, not failed. */
const MAX_CAPTURE_HEIGHT = 12_000
/** The same limit in painted pixels, for a capture at the page's zoom on a scaled display. */
const MAX_CAPTURE_PIXELS = 16_000

/**
 * How a person's full-page screenshot is painted: at the page's zoom, as the visible area's
 * `capturePage` is (the protocol adds the display's scale on its own), and cut in CSS pixels
 * so the whole picture stays under Chromium's texture height on the most scaled display.
 */
export function fullPagePaint(
  zoom: number,
  displayScale: number
): { scale: number; maxHeight: number } {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const d = Number.isFinite(displayScale) && displayScale > 0 ? displayScale : 1
  return {
    scale: z,
    maxHeight: Math.max(1, Math.min(MAX_CAPTURE_HEIGHT, Math.floor(MAX_CAPTURE_PIXELS / (z * d))))
  }
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
      for (const view of this.byWebContentsId.values()) view.refreshDarkening()
    })
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
