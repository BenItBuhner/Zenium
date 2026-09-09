import type { KeyBinding, Rect, Tab } from '@shared/types'
import { zenPageHtml, type ReaderPageLookup } from '@shared/zenPages'
import type {
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
  stopLoading: ViewNavState
  navigated: ViewNavState & { inPage: boolean }
  title: { title: string }
  favicon: { url: string }
  failLoad: { code: number; description: string; url: string }
  crashed: { reason: string }
  audio: { audible: boolean }
  enterFullscreen: void
  leaveFullscreen: void
  found: FindResultInfo
  contextMenu: Partial<PageContextParams>
  pageMessage: PageMessage
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
    private readonly reader: ReaderPageLookup
  ) {}

  /** Route a Kotlin event to the core. */
  dispatch<K extends keyof ViewEventPayloads>(name: K, payload: ViewEventPayloads[K]): void {
    if (this.destroyed && name !== 'destroyed') return
    const ev = this.events
    switch (name) {
      case 'startLoading':
        ev.onStartLoading()
        return
      case 'stopLoading':
        this.nav = { ...this.nav, ...(payload as ViewNavState) }
        ev.onStopLoading()
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
        ev.onFailLoad(p.code, p.description, p.url)
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
        html: zenPageHtml(url, this.reader)
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

  setZoom(factor: number): void {
    this.zoom = factor
    this.bridge.send('view.setZoom', { tabId: this.tabId, factor })
  }

  getZoom(): number {
    return this.zoom
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

  executeJavaScript(code: string): Promise<unknown> {
    return this.bridge.call<unknown>('view.eval', { tabId: this.tabId, code })
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

  setZapMode(on: boolean): void {
    this.bridge.send('view.setZap', { tabId: this.tabId, on })
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

  async copyImageAt(): Promise<boolean> {
    return false
  }

  replaceMisspelling(): void {
    // The system keyboard owns spelling on Android.
  }

  addWordToDictionary(): void {
    // See above.
  }
}

/** Creates and tracks the JS mirrors of Kotlin's tab WebViews. */
export class AndroidTabViewHost implements TabViewHost {
  private readonly views = new Map<string, AndroidTabView>()
  /** Resolves `zen://reader` articles; bound once the core exists. */
  reader: ReaderPageLookup = () => null

  constructor(private readonly bridge: Bridge) {}

  createView(tab: Tab, events: TabViewEvents): TabView {
    const view = new AndroidTabView(tab.id, this.bridge, (id) => this.reader(id))
    view.events = events
    this.views.set(tab.id, view)
    this.bridge.send('view.create', { tabId: tab.id, containerId: tab.containerId })
    return view
  }

  /** Register a view Kotlin created itself (a `window.open` popup adopted as a tab). */
  registerAdopted(tabId: string): AndroidTabView {
    const view = new AndroidTabView(tabId, this.bridge, (id) => this.reader(id))
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
}
