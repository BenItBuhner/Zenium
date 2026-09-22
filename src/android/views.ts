import type {
  ContentCover,
  KeyBinding,
  NavigationSnapshot,
  PageRules,
  Rect,
  Tab
} from '@shared/types'
import type { SafeBrowsingHit } from '@shared/privacy'
import type { FormsCommand } from '@shared/forms'
import { isCertificateError, type SiteCertificate } from '@shared/siteInfo'
import { certificateDetailsFrom } from '@shared/url'
import type { NavigationReport } from './extensionWebNavigation'
import { zenPageHtml, type ImagePageLookup, type ReaderPageLookup } from '@shared/zenPages'
import { pdfPageDownloadId, pdfViewerBaseUrl, type PdfPageLookup } from '@shared/pdfPage'
import type {
  AgentCapture,
  AgentCaptureOptions,
  ScreenshotOptions,
  AgentInputEvent,
  FindResultInfo,
  KeyEventInput,
  PageContextParams,
  PageFlags,
  PageHostMessage,
  PageMessage,
  TabView,
  TabViewEvents,
  TabViewHost
} from '@core/platform'
import { looksLikeStatements } from '@core/agent/util'
import { isKeepableHostState, NAVIGATION_ENTRIES_MAX, sanitizeSnapshot } from '@core/session'
import type { Bridge } from './bridge'

/** Navigation state Kotlin mirrors into JS on every navigation event. */
export interface ViewNavState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
}

/**
 * The WebView's back/forward list as Kotlin reports it (`copyBackForwardList()`): a
 * `historyChanged` push or the reply to `view.navigationEntries`. Entry URLs are the ones its
 * `navigated` events name, so the two can be matched; `index` is the list's current index (-1
 * with no list: a view whose WebView is not created); `hostState` is the `WebView.saveState`
 * bundle of that list (base64), when the host chooses to hand it over with the list.
 */
export interface HostHistory {
  entries: Array<{ url: string; title?: string; originalUrl?: string }>
  index: number
  hostState?: string
}

/** Events Kotlin raises for one view (`__zenHost.viewEvent(tabId, name, payload)`). */
export interface ViewEventPayloads {
  startLoading: void
  /**
   * The document's DOM is ready (Electron's `dom-ready`): Kotlin raises it once per document at
   * the page script's DOMContentLoaded, before `stopLoading`. The core injects the page's Boost,
   * runs Reader View and language detection on it (`browser.onPageReady`).
   */
  domReady: void
  stopLoading: ViewNavState
  /** `WebChromeClient.onProgressChanged`, throttled by Kotlin, as a fraction. */
  progress: { progress: number }
  /**
   * A navigation committed. `document` is the tab's document generation (Kotlin's
   * `BlockingTab.documentGeneration`), by which the extension runtime tells this document's
   * request decisions from the last one's.
   */
  navigated: ViewNavState & { inPage: boolean; document?: number }
  /**
   * The WebView's back/forward list changed (`doUpdateVisitedHistory`, `onPageFinished`): the
   * view keeps it, so the core's synchronous `navigationEntries()` has the stack without a round
   * trip. Also accepted as the app-wide `historyChanged` host event carrying the `tabId`.
   */
  historyChanged: HostHistory
  title: { title: string }
  favicon: { url: string }
  /** A failed load; a refused certificate (`ERR_CERT_*`) comes with what the interstitial shows of it. */
  failLoad: { code: number; description: string; url: string; certificate?: unknown }
  /**
   * The WebView's navigation listener reported a phase of a main-frame navigation (only on a
   * WebView with `NAVIGATION_LISTENER`); the extension runtime derives `webNavigation` from it.
   */
  navigation: NavigationReport
  /** HTTPS-only mode's rule sent the navigation to `to` instead of `from` (before it loads). */
  upgraded: { from: string; to: string }
  /** The Safe Browsing guard refused the navigation (a `failLoad` of the URL follows). */
  unsafe: { url: string; hit: SafeBrowsingHit }
  /**
   * The renderer went away (`onRenderProcessGone`, `RendererExit.kt`): `reason` is `crashed`
   * (`didCrash()`), `oom-kill` (the system took the memory back from a page in front) or
   * `hung` (the user chose Exit page on an unresponsive page); `repeat` says the same tab's
   * renderer went less than a minute ago too, which the host counts since it outlives the core.
   */
  crashed: { reason: string; repeat?: boolean }
  audio: { audible: boolean }
  /** The Kotlin request engine blocked `count` more requests of the page. */
  blocked: { count: number }
  enterFullscreen: void
  leaveFullscreen: void
  found: FindResultInfo
  contextMenu: Partial<PageContextParams>
  pageMessage: PageMessage
  /** A trusted touch or key reached the WebView (user activation for the pop-up blocker). */
  activation: void
  destroyed: void
}

/**
 * A page living in a Kotlin `WebView`. Every method is a bridge call; the read accessors answer
 * from the mirror Kotlin keeps up to date, so the core never has to await a round trip.
 */
export class AndroidTabView implements TabView {
  private nav: ViewNavState = { url: '', title: '', canGoBack: false, canGoForward: false }
  /**
   * The back/forward list as the host last reported it (a `historyChanged` push or a
   * `view.navigationEntries` reply), null until one has: then the snapshot is the current
   * page alone (an older APK, the preview host).
   */
  private hostHistory: NavigationSnapshot | null = null
  private zoom = 1
  private visible = false
  private destroyed = false
  private audible = false
  private pendingHtml = false
  private cssSeq = 0
  private cover: ContentCover = { top: 0, bottom: 0 }
  events!: TabViewEvents

  constructor(
    readonly tabId: string,
    private readonly bridge: Bridge,
    private readonly pages: ZenPageLookups = {
      reader: () => null,
      image: () => null,
      pdf: () => null
    },
    private readonly navigation: NavigationBridge = new NavigationBridge(bridge)
  ) {}

  /** Route a Kotlin event to the core. */
  dispatch<K extends keyof ViewEventPayloads>(name: K, payload: ViewEventPayloads[K]): void {
    if (this.destroyed && name !== 'destroyed') return
    const ev = this.events
    switch (name) {
      case 'startLoading':
        ev.onStartLoading()
        return
      case 'domReady':
        ev.onDomReady()
        return
      case 'stopLoading':
        this.nav = { ...this.nav, ...(payload as ViewNavState) }
        ev.onStopLoading()
        return
      case 'progress':
        ev.onProgress((payload as ViewEventPayloads['progress']).progress)
        return
      case 'navigated': {
        const p = payload as ViewEventPayloads['navigated']
        this.nav = {
          url: p.url,
          title: p.title,
          canGoBack: p.canGoBack,
          canGoForward: p.canGoForward
        }
        ev.onNavigated(p.url, p.inPage)
        return
      }
      case 'historyChanged':
        // A malformed push leaves the last good list in place.
        this.hostHistory = hostSnapshotFrom(payload) ?? this.hostHistory
        return
      case 'title': {
        const p = payload as ViewEventPayloads['title']
        this.nav.title = p.title
        ev.onTitleUpdated(p.title)
        return
      }
      case 'favicon':
        ev.onFaviconUpdated([(payload as ViewEventPayloads['favicon']).url])
        return
      case 'failLoad': {
        const p = payload as ViewEventPayloads['failLoad']
        ev.onFailLoad(
          p.code,
          p.description,
          p.url,
          isCertificateError(p.code)
            ? { certificate: certificateDetailsFrom(p.certificate) }
            : undefined
        )
        return
      }
      case 'upgraded': {
        const p = payload as ViewEventPayloads['upgraded']
        if (typeof p.from === 'string' && typeof p.to === 'string') ev.onUpgraded(p.from, p.to)
        return
      }
      case 'unsafe': {
        const p = payload as ViewEventPayloads['unsafe']
        if (typeof p.url === 'string' && p.hit && typeof p.hit === 'object')
          ev.onUnsafeNavigation(p.url, p.hit)
        return
      }
      case 'crashed': {
        const p = payload as ViewEventPayloads['crashed']
        ev.onCrashed(p.reason, undefined, { repeat: p.repeat === true })
        return
      }
      case 'audio': {
        const p = payload as ViewEventPayloads['audio']
        this.audible = p.audible
        ev.onAudioStateChanged(p.audible)
        return
      }
      case 'blocked': {
        const p = payload as ViewEventPayloads['blocked']
        if (typeof p.count === 'number' && p.count > 0) ev.onRequestsBlocked(p.count)
        return
      }
      case 'enterFullscreen':
        ev.onEnterHtmlFullscreen()
        return
      case 'leaveFullscreen':
        ev.onLeaveHtmlFullscreen()
        return
      case 'found':
        ev.onFoundInPage(payload as FindResultInfo)
        return
      case 'contextMenu': {
        const p = payload as Partial<PageContextParams>
        ev.onContextMenu({
          x: p.x ?? 0,
          y: p.y ?? 0,
          linkURL: p.linkURL ?? '',
          srcURL: p.srcURL ?? '',
          mediaType: p.mediaType ?? (p.srcURL ? 'image' : 'none'),
          selectionText: p.selectionText ?? '',
          isEditable: false,
          misspelledWord: '',
          dictionarySuggestions: [],
          editFlags: {
            canUndo: false,
            canRedo: false,
            canCut: false,
            canCopy: false,
            canPaste: false,
            canDelete: false,
            canSelectAll: false
          }
        })
        return
      }
      case 'pageMessage': {
        const message = payload as PageMessage
        if (message.type === 'media') this.audible = Boolean(message.playing)
        ev.onPageMessage(message)
        return
      }
      case 'activation':
        ev.onUserActivation()
        return
      case 'destroyed':
        this.destroyed = true
        ev.onDestroyed()
        return
    }
  }

  /** Key events Kotlin pre-filtered against the shortcut table. */
  key(input: KeyEventInput): boolean {
    return this.events.onKey(input)
  }

  // --- navigation -----------------------------------------------------------

  loadURL(url: string): void {
    if (url.startsWith('zen://')) {
      // Internal pages are rendered straight into the WebView; the URL stays `zen://…`.
      this.pendingHtml = true
      const pdfId = pdfPageDownloadId(url)
      const pdf = pdfId ? this.pages.pdf(pdfId) : null
      this.bridge.send('view.loadHtml', {
        tabId: this.tabId,
        url,
        html: zenPageHtml(url, this.pages.reader, this.pages.image, this.pages.pdf),
        // The PDF viewer's document runs under the PDF's own URL, as Chrome's viewer presents
        // its tab (`pdfViewerBaseUrl`: the viewer's origin for a PDF with none); pdf.js fetches
        // its worker and the document from the viewer's origin, which Kotlin serves
        // (`PdfViewer.kt`) from the app's assets and the file the download left.
        ...(pdf
          ? { baseUrl: pdfViewerBaseUrl(pdf), document: { path: pdf.path, name: pdf.name } }
          : {})
      })
      return
    }
    this.pendingHtml = false
    this.bridge.send('view.load', { tabId: this.tabId, url })
  }

  getURL(): string {
    return this.nav.url
  }

  getTitle(): string {
    return this.nav.title
  }

  canGoBack(): boolean {
    return this.nav.canGoBack
  }

  canGoForward(): boolean {
    return this.nav.canGoForward
  }

  goBack(): void {
    this.bridge.send('view.back', { tabId: this.tabId })
  }

  goForward(): void {
    this.bridge.send('view.forward', { tabId: this.tabId })
  }

  /**
   * A jump in the WebView's list (`view.goToIndex`, `goBackOrForward` on the host). Before the
   * host has reported a list (an older APK, the preview host) the snapshot is the current page
   * alone, so the only index the core can name is the current one: a no-op, as before.
   */
  goToIndex(index: number): void {
    if (!this.hostHistory) return
    this.bridge.send('view.goToIndex', { tabId: this.tabId, index })
  }

  /**
   * The WebView's back/forward list, synchronously (the core records it on every commit, on an
   * unload and at quit, and draws the back button's long-press list from it). The host's own
   * answer for this moment wins (`view.navigationEntries`, on a host with the sync method); then
   * the list it last pushed (`historyChanged`), set against the URL the view is on; a host that
   * has done neither leaves the snapshot as it was: the current page alone.
   */
  navigationEntries(): NavigationSnapshot {
    // An empty answer is the host's word too ("no list": a WebView not created), and the core
    // reads it as nothing to record, keeping what it remembered of the tab.
    const now = this.navigation.entries(this.tabId)
    if (now) {
      this.hostHistory = now
      return this.withHostState(now)
    }
    if (this.hostHistory) return this.withHostState(reconcileHistory(this.hostHistory, this.nav))
    if (!this.nav.url) return { entries: [], index: -1 }
    return { entries: [{ url: this.nav.url, title: this.nav.title }], index: 0 }
  }

  /**
   * `snapshot` with the host's serialisation of the list (`view.navigationHostState`, its
   * `WebView.saveState` bundle), fetched now – the blob is asked for only when the core records
   * a stack, not marshalled with every list change – unless the list came with one already, the
   * host has no such method, or the list is empty.
   */
  private withHostState(snapshot: NavigationSnapshot): NavigationSnapshot {
    if (snapshot.entries.length === 0 || snapshot.hostState !== undefined) return snapshot
    const hostState = this.navigation.hostState(this.tabId)
    return hostState === undefined ? snapshot : { ...snapshot, hostState }
  }

  /**
   * The host rebuilds the list from its own serialisation (`hostState`, `WebView.restoreState`)
   * and answers `{ restored: true }`. Every other outcome loads the current entry here, as
   * before: no `hostState` or one the host refuses (foreign, corrupt, another list: `restored:
   * false`), and a host without the handler at all (an older APK, the preview host). One path
   * for every fallback, so a `zen://` page gets its document (`loadURL`) rather than a bare URL.
   */
  async restoreNavigation(snapshot: NavigationSnapshot): Promise<void> {
    const entries = snapshot.entries.filter((e) => typeof e.url === 'string' && e.url !== '')
    const index = Math.min(Math.max(snapshot.index, 0), entries.length - 1)
    const current = entries[index]
    if (!current) return
    const args: {
      tabId: string
      entries: Array<{ url: string; title: string }>
      index: number
      hostState?: string
    } = {
      tabId: this.tabId,
      // The host takes URLs and titles; another engine's per-entry `pageState` is not for it.
      entries: entries.map((e) => ({ url: e.url, title: e.title })),
      index
    }
    if (isKeepableHostState(snapshot.hostState)) args.hostState = snapshot.hostState
    let restored = false
    try {
      restored = wasRestored(await this.bridge.call<unknown>('view.restoreNavigation', args))
    } catch {
      // "Unknown method": a host without the handler.
    }
    if (restored || this.destroyed) return
    this.loadURL(current.url)
  }

  reload(ignoreCache: boolean): void {
    this.bridge.send('view.reload', { tabId: this.tabId, ignoreCache })
  }

  stop(): void {
    this.bridge.send('view.stop', { tabId: this.tabId })
  }

  hasDocument(): boolean {
    return this.pendingHtml || (this.nav.url !== '' && this.nav.url !== 'about:blank')
  }

  // --- media / zoom / find ----------------------------------------------------

  setMuted(muted: boolean): void {
    this.bridge.send('view.setMuted', { tabId: this.tabId, muted })
  }

  isCurrentlyAudible(): boolean {
    return this.audible
  }

  /**
   * The effective page zoom. Kotlin hands it to the page script, which narrows the layout
   * viewport by the factor (a real reflow, like Chrome's page zoom); text zoom stays at 100.
   */
  setZoom(factor: number): void {
    this.zoom = factor
    this.bridge.send('view.setZoom', { tabId: this.tabId, factor })
  }

  getZoom(): number {
    return this.zoom
  }

  /** Desktop user agent, client hints and layout width from the next load on. */
  setDesktopMode(on: boolean): void {
    this.bridge.send('view.setDesktopMode', { tabId: this.tabId, on })
  }

  /** Algorithmic darkening (only takes effect while the chrome is dark; see TabWebView.kt). */
  setDarkening(on: boolean): void {
    this.bridge.send('view.setDarkening', { tabId: this.tabId, on })
  }

  findInPage(text: string, forward: boolean, newSession: boolean): void {
    this.bridge.send('view.find', { tabId: this.tabId, text, forward, newSession })
  }

  stopFind(action: 'clearSelection' | 'keepSelection'): void {
    this.bridge.send('view.stopFind', {
      tabId: this.tabId,
      keepSelection: action === 'keepSelection'
    })
  }

  /**
   * Like Electron's `executeJavaScript`: expressions and statement lists both run, and a returned
   * Promise is awaited (Kotlin does that). A statement list is wrapped into a function so the
   * Kotlin wrapper – which needs an expression – can take it; its completion value is lost, which
   * no caller relies on.
   */
  executeJavaScript(code: string): Promise<unknown> {
    const shaped = looksLikeStatements(code) ? `(() => { ${code}\n })()` : code
    return this.bridge.call<unknown>('view.eval', { tabId: this.tabId, code: shaped })
  }

  /** Trusted touch / key events synthesised by Kotlin on the tab's WebView. */
  sendInput(event: AgentInputEvent): Promise<void> {
    return this.bridge.call('view.input', { tabId: this.tabId, event })
  }

  /** Stylesheets are injected as `<style>` elements; the key is the element id. */
  async insertCSS(css: string): Promise<string> {
    const key = `zen-css-${this.tabId}-${++this.cssSeq}`
    await this.executeJavaScript(
      `(() => { const s = document.createElement('style'); s.id = ${JSON.stringify(key)}; s.textContent = ${JSON.stringify(css)}; (document.head || document.documentElement).appendChild(s); return true })()`
    )
    return key
  }

  async removeInsertedCSS(key: string): Promise<void> {
    await this.executeJavaScript(
      `(() => { const s = document.getElementById(${JSON.stringify(key)}); if (s) s.remove(); return true })()`
    )
  }

  sendPageFlags(flags: PageFlags): void {
    this.bridge.send('view.setFlags', { tabId: this.tabId, flags })
  }

  setPopupsAllowed(allowed: boolean): void {
    this.bridge.send('view.setPopupsAllowed', { tabId: this.tabId, allowed })
  }

  setZapMode(on: boolean): void {
    this.bridge.send('view.setZap', { tabId: this.tabId, on })
  }

  /** Autofill: a fill for the page's forms script, or its on/off configuration (Kotlin keeps the latter for new documents). */
  sendFormsCommand(command: FormsCommand): void {
    this.bridge.send('view.forms', { tabId: this.tabId, command })
  }

  postToPage(message: PageHostMessage): void {
    this.bridge.send('view.postMessage', { tabId: this.tabId, message })
  }

  setBackgroundColor(color: string): void {
    this.bridge.send('view.setBackground', { tabId: this.tabId, color })
  }

  focus(): void {
    this.bridge.send('view.focus', { tabId: this.tabId })
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.bridge.send('view.destroy', { tabId: this.tabId })
  }

  // --- placement ---------------------------------------------------------------
  //
  // The core places every view of a layout report in one go (`window.ts` `applyLayout`: the
  // bounds, the radius, the cover, a flip of visibility, the glance to the front), and nothing
  // reads the answers: these go `batched`, one hop for the report instead of one per op, the
  // host applying them in order in one main-thread task (#312's H3b; `bridge.ts` has the why).

  attachTo(): void {
    // One window on Android: every view already lives in it.
  }

  detach(): void {
    // See attachTo().
  }

  setBounds(rect: Rect): void {
    this.bridge.batched('view.setBounds', { tabId: this.tabId, rect })
  }

  setBorderRadius(radius: number): void {
    this.bridge.batched('view.setRadius', { tabId: this.tabId, radius })
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.bridge.batched('view.setVisible', { tabId: this.tabId, visible })
  }

  isVisible(): boolean {
    return this.visible
  }

  bringToFront(): void {
    this.bridge.batched('view.bringToFront', { tabId: this.tabId })
  }

  setCover(cover: ContentCover): void {
    // Every layout report carries the cover; only a change is worth a spring on the host.
    if (this.cover.top === cover.top && this.cover.bottom === cover.bottom) return
    this.cover = cover
    this.bridge.batched('view.setCover', { tabId: this.tabId, cover })
  }

  // --- page operations -----------------------------------------------------------

  openDevTools(): void {
    // Android WebViews are inspected from desktop Chrome (chrome://inspect); nothing to open here.
  }

  downloadURL(url: string): void {
    this.bridge.send('view.download', { tabId: this.tabId, url })
  }

  print(): void {
    this.bridge.send('view.print', { tabId: this.tabId })
  }

  savePage(suggestedName: string): Promise<string | null> {
    return this.bridge.call<string | null>('view.savePage', {
      tabId: this.tabId,
      name: suggestedName
    })
  }

  snapshot(): Promise<string | null> {
    return this.bridge.call<string | null>('view.snapshot', { tabId: this.tabId })
  }

  /**
   * The visible area, or with `fullPage` the whole document: Kotlin scrolls the page in
   * viewport-sized steps and stitches the strips (`PageCapture`), the same path as the agents'
   * full-page capture, and saves the PNG to Downloads.
   */
  screenshot(fileName: string, options: ScreenshotOptions = {}): Promise<string | null> {
    return this.bridge.call<string | null>('view.screenshot', {
      tabId: this.tabId,
      name: fileName,
      fullPage: options.fullPage === true
    })
  }

  /**
   * Agent screenshots beyond the viewport: Kotlin scrolls the page in viewport-sized steps and
   * stitches the window pixels of each step (a WebView never paints what is off screen).
   */
  capture(options: AgentCaptureOptions): Promise<AgentCapture | null> {
    return this.bridge.call<AgentCapture | null>('view.capture', {
      tabId: this.tabId,
      mode: options.mode,
      region: options.mode === 'region' ? (options.region ?? null) : null,
      format: options.format
    })
  }

  async copyImageAt(): Promise<boolean> {
    return false
  }

  /** `WebView.getCertificate()` of the main frame (null on http pages). */
  async certificate(): Promise<SiteCertificate | null> {
    const raw = await this.bridge.call<Partial<SiteCertificate> | null>('view.certificate', {
      tabId: this.tabId
    })
    if (!raw || typeof raw !== 'object') return null
    const time = (v: unknown): number | null => (typeof v === 'number' && v > 0 ? v : null)
    return {
      subject: typeof raw.subject === 'string' ? raw.subject : '',
      issuer: typeof raw.issuer === 'string' ? raw.issuer : '',
      validFrom: time(raw.validFrom),
      validTo: time(raw.validTo),
      protocol: typeof raw.protocol === 'string' && raw.protocol ? raw.protocol : null
    }
  }

  replaceMisspelling(): void {
    // The system keyboard owns spelling on Android.
  }

  addWordToDictionary(): void {
    // See above.
  }
}

/**
 * The host's word on a view's list (a push or a sync reply), checked: null when it is not one
 * (a malformed payload counts as no answer). An empty list is an answer – "no list right now" –
 * and stays apart from the URL-only fallback. Entries go through the stored stack's sanitiser:
 * URL and title, `NAVIGATION_ENTRIES_MAX` entries, the state blob within its cap and only when
 * the list it describes survived whole.
 */
export function hostSnapshotFrom(raw: unknown): NavigationSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const h = raw as Partial<HostHistory>
  if (!Array.isArray(h.entries) || typeof h.index !== 'number') return null
  if (h.entries.length === 0) return { entries: [], index: -1 }
  return sanitizeSnapshot(raw)
}

/**
 * The list the host last pushed, set against the URL the view is on now. Kotlin reports a
 * commit as `navigated` and `historyChanged` from the same callback, but the core records the
 * stack on `onNavigated`, which may run between the two; a list whose current entry is not the
 * view's URL is moved on the way the WebView's own list did: to the nearest entry with that URL
 * (where back or forward went), or with the URL on top and the forward entries gone, as in
 * Chrome. A list changed here is not the one the host's state blob described, so it carries none.
 */
export function reconcileHistory(
  history: NavigationSnapshot,
  nav: ViewNavState
): NavigationSnapshot {
  if (!nav.url) return history
  const { entries, index } = history
  if (entries[index]?.url === nav.url) return history
  let at = -1
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].url !== nav.url) continue
    if (at === -1 || Math.abs(i - index) < Math.abs(at - index)) at = i
  }
  if (at !== -1) return { entries, index: at }
  const kept = entries.slice(0, Math.max(index, -1) + 1)
  const grown = [...kept, { url: nav.url, title: nav.title }].slice(-NAVIGATION_ENTRIES_MAX)
  return { entries: grown, index: grown.length - 1 }
}

/** The `view.restoreNavigation` reply: only an explicit `{ restored: true }` means the host rebuilt the list. */
function wasRestored(reply: unknown): boolean {
  return (
    typeof reply === 'object' &&
    reply !== null &&
    (reply as { restored?: unknown }).restored === true
  )
}

/**
 * The host's synchronous answers about a view's back/forward list: its list right now
 * (`view.navigationEntries { tabId }`, the contract's option (a)) and the `WebView.saveState`
 * bundle of that list (`view.navigationHostState { tabId }`, fetched when the core records a
 * stack). A host without one of the methods answers nothing at all (the bridge's `""` for an
 * unknown sync method: an older APK, the preview host), and is not asked for it again this run;
 * `null` is an answer ("nothing for this view") and keeps the method in use.
 */
export class NavigationBridge {
  private entriesOffered = true
  private hostStateOffered = true

  constructor(private readonly bridge: Bridge) {}

  /** The host's list right now (empty for a view without one), or undefined from a host without the method. */
  entries(tabId: string): NavigationSnapshot | undefined {
    if (!this.entriesOffered) return undefined
    const raw = this.sync('view.navigationEntries', tabId)
    if (raw === undefined) {
      this.entriesOffered = false
      return undefined
    }
    return hostSnapshotFrom(raw) ?? undefined
  }

  /** The host's serialisation of the view's list, within the cap, or undefined when there is none to keep. */
  hostState(tabId: string): string | undefined {
    if (!this.hostStateOffered) return undefined
    const raw = this.sync('view.navigationHostState', tabId)
    if (raw === undefined) {
      this.hostStateOffered = false
      return undefined
    }
    return isKeepableHostState(raw) ? raw : undefined
  }

  private sync(method: string, tabId: string): unknown {
    try {
      return this.bridge.callSync<unknown>(method, { tabId })
    } catch {
      return undefined
    }
  }
}

/** What the `zen://` pages need from the core (bound once it exists). */
export interface ZenPageLookups {
  /** Resolves `zen://reader` articles. */
  reader: ReaderPageLookup
  /** Resolves `zen://image` pictures shared into the browser. */
  image: ImagePageLookup
  /** `zen://pdf?id=…` → the download it shows (`core/pdf.ts`), or null once the file is gone. */
  pdf: PdfPageLookup
}

/** Creates and tracks the JS mirrors of Kotlin's tab WebViews. */
export class AndroidTabViewHost implements TabViewHost {
  private readonly views = new Map<string, AndroidTabView>()
  readonly pages: ZenPageLookups = { reader: () => null, image: () => null, pdf: () => null }
  /** Shared by the views: what the host offers is learnt once for the run, not per view. */
  private readonly navigation: NavigationBridge

  constructor(private readonly bridge: Bridge) {
    this.navigation = new NavigationBridge(bridge)
  }

  createView(tab: Tab, events: TabViewEvents): TabView {
    const view = new AndroidTabView(tab.id, this.bridge, this.pages, this.navigation)
    view.events = events
    this.views.set(tab.id, view)
    this.bridge.send('view.create', { tabId: tab.id, containerId: tab.containerId })
    return view
  }

  /** Register a view Kotlin created itself (a `window.open` popup adopted as a tab). */
  registerAdopted(tabId: string): AndroidTabView {
    const view = new AndroidTabView(tabId, this.bridge, this.pages, this.navigation)
    this.views.set(tabId, view)
    return view
  }

  get(tabId: string): AndroidTabView | undefined {
    return this.views.get(tabId)
  }

  forget(tabId: string): void {
    this.views.delete(tabId)
  }

  setShortcuts(bindings: KeyBinding[]): void {
    this.bridge.send('keys.setShortcuts', { bindings })
  }

  /** Kotlin keeps the policy so a navigation gets its user agent and viewport before it starts. */
  setPageRules(rules: PageRules): void {
    this.bridge.send('view.setPageRules', rules)
  }
}
