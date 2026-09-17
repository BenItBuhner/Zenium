import {
  ClipboardItem,
  WebContentsView,
  app,
  clipboard,
  dialog,
  nativeImage,
  net,
  type BrowserWindow,
  type WebContents
} from 'electron'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import type { Rect, Tab } from '../../shared/types'
import type { SiteCertificate } from '../../shared/siteInfo'
import type {
  AgentCapture,
  AgentCaptureOptions,
  AgentInputEvent,
  InputModifier,
  KeyEventInput,
  PageFlags,
  PageMessage,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost,
  WindowOpenDisposition
} from '../../core/platform'
import type { SessionManager } from './sessions'
import { downloadDir } from './downloads'
import type { ElectronWindow } from './window'

const pagePreload = join(__dirname, '../preload/page.js')

/**
 * A tab page hosted in a `WebContentsView`. The view is a child of whichever window currently
 * owns the tab's live page (Zen's window sync moves it between windows).
 */
export class ElectronTabView implements TabView {
  readonly view: WebContentsView
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

  constructor(
    host: ElectronWindow,
    tab: Tab,
    sessions: SessionManager,
    private readonly events: TabViewEvents,
    private readonly onDestroyed: (view: ElectronTabView) => void
  ) {
    this.view = new WebContentsView({
      webPreferences: {
        session: sessions.get(tab.containerId),
        preload: pagePreload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: true,
        safeDialogs: true,
        autoplayPolicy: 'document-user-activation-required',
        backgroundThrottling: true,
        scrollBounce: true,
        enableWebSQL: false
      }
    })
    this.wc = this.view.webContents
    this.webContentsId = this.wc.id
    this.view.setVisible(false)
    this.wire(tab)
    this.attachTo(host)
  }

  get webContents(): WebContents {
    return this.wc
  }

  /** The window the view is currently a child of (null while detached). */
  private get win(): BrowserWindow | null {
    const bw = this.host?.win
    return bw && !bw.isDestroyed() ? bw : null
  }

  private wire(tab: Tab): void {
    const wc = this.wc
    const ev = this.events
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
      ev.onFailLoad(code, description, url)
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
    wc.on('context-menu', (_e, params) => ev.onContextMenu(params))
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
    wc.on('will-prevent-unload', (event) => {
      const options = {
        type: 'question' as const,
        buttons: ['Leave Page', 'Stay on Page'],
        defaultId: 0,
        cancelId: 1,
        message: `This page is asking you to confirm that you want to leave — ${wc.getTitle() || tab.title}`,
        detail: 'Information you’ve entered may not be saved.',
        noLink: true
      }
      const win = this.win
      const choice = win
        ? dialog.showMessageBoxSync(win, options)
        : dialog.showMessageBoxSync(options)
      if (choice === 0) event.preventDefault()
    })
    wc.on('dom-ready', () => ev.onDomReady())
    // By the time this fires `this.view.webContents` no longer returns the object (Electron drops
    // the view's reference before emitting), which is why the captured `wc` is used throughout.
    wc.on('destroyed', () => {
      ev.onDestroyed()
      this.onDestroyed(this)
    })
    wc.setWindowOpenHandler(({ url, disposition }) => {
      const verdict = ev.onOpenWindow(url, disposition as WindowOpenDisposition)
      if (verdict === 'popup') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 720,
            height: 640,
            autoHideMenuBar: true,
            webPreferences: { preload: undefined, sandbox: true, contextIsolation: true }
          }
        }
      }
      return { action: 'deny' }
    })
  }

  /** A message from the page script (routed here by the platform's IPC handler). */
  dispatchPageMessage(message: PageMessage): void {
    this.events.onPageMessage(message)
  }

  // --- navigation -----------------------------------------------------------

  loadURL(url: string): void {
    void this.wc.loadURL(url).catch(() => undefined)
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
    this.wc.navigationHistory.goBack()
  }

  goForward(): void {
    this.wc.navigationHistory.goForward()
  }

  reload(ignoreCache: boolean): void {
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

  executeJavaScript(code: string): Promise<unknown> {
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

  setZapMode(on: boolean): void {
    this.wc.send('zen:zap', on)
  }

  setBackgroundColor(color: string): void {
    this.view.setBackgroundColor(color)
  }

  focus(): void {
    this.wc.focus()
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
    if (win) win.contentView.addChildView(this.view)
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

  downloadURL(url: string): void {
    this.wc.downloadURL(url)
  }

  print(): void {
    this.wc.print()
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

  /** JPEG snapshot of the page, used to keep a dimmed preview behind overlays (URL bar, Glance). */
  async snapshot(): Promise<string | null> {
    try {
      const image = await this.wc.capturePage()
      if (image.isEmpty()) return null
      const size = image.getSize()
      const scaled = size.width > 1400 ? image.resize({ width: 1400 }) : image
      return `data:image/jpeg;base64,${scaled.toJPEG(65).toString('base64')}`
    } catch {
      return null
    }
  }

  async screenshot(fileName: string): Promise<string | null> {
    try {
      const image = await this.wc.capturePage()
      if (image.isEmpty()) return null
      const filePath = join(downloadDir(), fileName)
      await writeFile(filePath, nativeImage.createFromBuffer(image.toPNG()).toPNG())
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

  /** Trusted input events; coordinates arrive in CSS pixels and become DIPs via the zoom factor. */
  async sendInput(event: AgentInputEvent): Promise<void> {
    const wc = this.wc
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

  private async captureWithDevtools(
    options: AgentCaptureOptions,
    mimeType: string
  ): Promise<AgentCapture> {
    const wc = this.wc
    const dbg = wc.debugger
    const attachedHere = !dbg.isAttached()
    if (attachedHere) dbg.attach('1.3')
    try {
      const metrics = (await dbg.sendCommand('Page.getLayoutMetrics')) as {
        cssContentSize?: { width: number; height: number }
        contentSize?: { width: number; height: number }
        cssLayoutViewport?: { clientWidth: number; clientHeight: number }
      }
      const content = metrics.cssContentSize ?? metrics.contentSize ?? { width: 0, height: 0 }
      const clip =
        options.mode === 'region' && options.region
          ? { ...options.region, scale: 1 }
          : {
              x: 0,
              y: 0,
              width: Math.max(1, Math.round(content.width)),
              height: Math.max(1, Math.min(Math.round(content.height), MAX_CAPTURE_HEIGHT)),
              scale: 1
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
}

/** Chromium refuses textures much taller than this; very long pages are cut, not failed. */
const MAX_CAPTURE_HEIGHT = 12_000

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

/** Creates `WebContentsView`s and maps their web contents back to tabs. */
export class ElectronTabViewHost implements TabViewHost {
  private readonly byWebContentsId = new Map<number, ElectronTabView>()
  private readonly tabIds = new Map<number, string>()

  constructor(private readonly sessions: SessionManager) {}

  createView(tab: Tab, events: TabViewEvents, host: WindowHost): TabView {
    const view = new ElectronTabView(host as ElectronWindow, tab, this.sessions, events, (v) => {
      this.byWebContentsId.delete(v.webContentsId)
      this.tabIds.delete(v.webContentsId)
    })
    this.byWebContentsId.set(view.webContentsId, view)
    this.tabIds.set(view.webContentsId, tab.id)
    return view
  }

  tabIdForWebContents(wc: WebContents): string | undefined {
    return this.tabIds.get(wc.id)
  }

  viewForWebContents(wc: WebContents): ElectronTabView | undefined {
    return this.byWebContentsId.get(wc.id)
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
