import type { KeyBinding, NavigationSnapshot, PageRules, Rect, Tab } from '@shared/types'
import type { SafeBrowsingHit } from '@shared/privacy'
import type { FormsCommand } from '@shared/forms'
import { isCertificateError, type SiteCertificate } from '@shared/siteInfo'
import { certificateDetailsFrom } from '@shared/url'
import { zenPageHtml, type ImagePageLookup, type ReaderPageLookup } from '@shared/zenPages'
import type {
  AgentCapture,
  AgentCaptureOptions,
  AgentInputEvent,
  FindResultInfo,
  KeyEventInput,
  PageContextParams,
  PageFlags,
  PageMessage,
  TabView,
  TabViewEvents,
  TabViewHost
} from '@core/platform'
import { looksLikeStatements } from '@core/agent/util'
import type { Bridge } from './bridge'

/** Navigation state Kotlin mirrors into JS on every navigation event. */
export interface ViewNavState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
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
  navigated: ViewNavState & { inPage: boolean }
  title: { title: string }
  favicon: { url: string }
  /** A failed load; a refused certificate (`ERR_CERT_*`) comes with what the interstitial shows of it. */
  failLoad: { code: number; description: string; url: string; certificate?: unknown }
  /** HTTPS-only mode's rule sent the navigation to `to` instead of `from` (before it loads). */
  upgraded: { from: string; to: string }
  /** The Safe Browsing guard refused the navigation (a `failLoad` of the URL follows). */
  unsafe: { url: string; hit: SafeBrowsingHit }
  crashed: { reason: string }
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
  private zoom = 1
  private visible = false
  private destroyed = false
  private audible = false
  private pendingHtml = false
  private cssSeq = 0
  events!: TabViewEvents

  constructor(
    readonly tabId: string,
    private readonly bridge: Bridge,
    private readonly pages: ZenPageLookups = { reader: () => null, image: () => null }
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
      case 'crashed':
        ev.onCrashed((payload as ViewEventPayloads['crashed']).reason)
        return
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
      this.bridge.send('view.loadHtml', {
        tabId: this.tabId,
        url,
        html: zenPageHtml(url, this.pages.reader, this.pages.image)
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
   * URL-only fallback until the Kotlin host exposes the WebView's back/forward list: the
   * snapshot is the current page alone, so index 0 is the only reachable entry.
   */
  goToIndex(index: number): void {
    void index
  }

  navigationEntries(): NavigationSnapshot {
    if (!this.nav.url) return { entries: [], index: -1 }
    return { entries: [{ url: this.nav.url, title: this.nav.title }], index: 0 }
  }

  async restoreNavigation(snapshot: NavigationSnapshot): Promise<void> {
    const current =
      snapshot.entries[snapshot.index] ?? snapshot.entries[snapshot.entries.length - 1]
    if (current?.url) this.loadURL(current.url)
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

  attachTo(): void {
    // One window on Android: every view already lives in it.
  }

  detach(): void {
    // See attachTo().
  }

  setBounds(rect: Rect): void {
    this.bridge.send('view.setBounds', { tabId: this.tabId, rect })
  }

  setBorderRadius(radius: number): void {
    this.bridge.send('view.setRadius', { tabId: this.tabId, radius })
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.bridge.send('view.setVisible', { tabId: this.tabId, visible })
  }

  isVisible(): boolean {
    return this.visible
  }

  bringToFront(): void {
    this.bridge.send('view.bringToFront', { tabId: this.tabId })
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

  screenshot(fileName: string): Promise<string | null> {
    return this.bridge.call<string | null>('view.screenshot', { tabId: this.tabId, name: fileName })
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

/** What the `zen://` pages need from the core (bound once it exists). */
export interface ZenPageLookups {
  /** Resolves `zen://reader` articles. */
  reader: ReaderPageLookup
  /** Resolves `zen://image` pictures shared into the browser. */
  image: ImagePageLookup
}

/** Creates and tracks the JS mirrors of Kotlin's tab WebViews. */
export class AndroidTabViewHost implements TabViewHost {
  private readonly views = new Map<string, AndroidTabView>()
  readonly pages: ZenPageLookups = { reader: () => null, image: () => null }

  constructor(private readonly bridge: Bridge) {}

  createView(tab: Tab, events: TabViewEvents): TabView {
    const view = new AndroidTabView(tab.id, this.bridge, this.pages)
    view.events = events
    this.views.set(tab.id, view)
    this.bridge.send('view.create', { tabId: tab.id, containerId: tab.containerId })
    return view
  }

  /** Register a view Kotlin created itself (a `window.open` popup adopted as a tab). */
  registerAdopted(tabId: string): AndroidTabView {
    const view = new AndroidTabView(tabId, this.bridge, this.pages)
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
