import {
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
import type {
  KeyEventInput,
  PageFlags,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowOpenDisposition
} from '../../core/platform'
import type { SessionManager } from './sessions'
import { downloadDir } from './downloads'

const pagePreload = join(__dirname, '../preload/page.js')

/** A tab page hosted in a `WebContentsView` child of the browser window. */
export class ElectronTabView implements TabView {
  readonly view: WebContentsView
  private visible = false

  constructor(
    private readonly win: BrowserWindow,
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
    this.view.setVisible(false)
    this.wire(tab)
    if (!win.isDestroyed()) win.contentView.addChildView(this.view)
  }

  get webContents(): WebContents {
    return this.view.webContents
  }

  private wire(tab: Tab): void {
    const wc = this.view.webContents
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
    wc.on('media-started-playing', () => ev.onMediaStateChanged())
    wc.on('media-paused', () => ev.onMediaStateChanged())
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
      const choice = dialog.showMessageBoxSync(this.win, {
        type: 'question',
        buttons: ['Leave Page', 'Stay on Page'],
        defaultId: 0,
        cancelId: 1,
        message: `This page is asking you to confirm that you want to leave — ${wc.getTitle() || tab.title}`,
        detail: 'Information you’ve entered may not be saved.',
        noLink: true
      })
      if (choice === 0) event.preventDefault()
    })
    wc.on('dom-ready', () => ev.onDomReady())
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

  // --- navigation -----------------------------------------------------------

  loadURL(url: string): void {
    void this.view.webContents.loadURL(url).catch(() => undefined)
  }

  getURL(): string {
    return this.view.webContents.getURL()
  }

  getTitle(): string {
    return this.view.webContents.getTitle()
  }

  canGoBack(): boolean {
    return this.view.webContents.navigationHistory.canGoBack()
  }

  canGoForward(): boolean {
    return this.view.webContents.navigationHistory.canGoForward()
  }

  goBack(): void {
    this.view.webContents.navigationHistory.goBack()
  }

  goForward(): void {
    this.view.webContents.navigationHistory.goForward()
  }

  reload(ignoreCache: boolean): void {
    if (ignoreCache) this.view.webContents.reloadIgnoringCache()
    else this.view.webContents.reload()
  }

  stop(): void {
    this.view.webContents.stop()
  }

  hasDocument(): boolean {
    const url = this.view.webContents.getURL()
    return url !== '' && url !== 'about:blank'
  }

  // --- media / zoom / find ----------------------------------------------------

  setMuted(muted: boolean): void {
    this.view.webContents.setAudioMuted(muted)
  }

  isCurrentlyAudible(): boolean {
    return this.view.webContents.isCurrentlyAudible()
  }

  setZoom(factor: number): void {
    this.view.webContents.setZoomFactor(factor)
  }

  getZoom(): number {
    return this.view.webContents.getZoomFactor()
  }

  findInPage(text: string, forward: boolean, newSession: boolean): void {
    // Electron: findNext=true begins a new session, false continues the current one.
    this.view.webContents.findInPage(text, { forward, findNext: newSession })
  }

  stopFind(action: 'clearSelection' | 'keepSelection'): void {
    this.view.webContents.stopFindInPage(action)
  }

  executeJavaScript(code: string): Promise<unknown> {
    return this.view.webContents.executeJavaScript(code, true)
  }

  sendPageFlags(flags: PageFlags): void {
    this.view.webContents.send('zen:page-flags', flags)
  }

  setBackgroundColor(color: string): void {
    this.view.setBackgroundColor(color)
  }

  focus(): void {
    this.view.webContents.focus()
  }

  isDestroyed(): boolean {
    return this.view.webContents.isDestroyed()
  }

  destroy(): void {
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(this.view)
    if (!this.view.webContents.isDestroyed()) {
      this.view.webContents.close({ waitForBeforeUnload: false })
    }
  }

  // --- placement ---------------------------------------------------------------

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
    if (!this.win.isDestroyed()) this.win.contentView.addChildView(this.view)
  }

  // --- page operations -----------------------------------------------------------

  openDevTools(mode: 'toggle' | 'inspect' | 'console'): void {
    const wc = this.view.webContents
    if (mode === 'toggle' && wc.isDevToolsOpened()) {
      wc.closeDevTools()
      return
    }
    wc.openDevTools({ mode: 'detach', activate: true })
    if (mode === 'inspect') wc.inspectElement(0, 0)
  }

  downloadURL(url: string): void {
    this.view.webContents.downloadURL(url)
  }

  print(): void {
    this.view.webContents.print()
  }

  async savePage(suggestedName: string): Promise<string | null> {
    const result = await dialog.showSaveDialog(this.win, {
      title: 'Save Page As',
      defaultPath: join(downloadDir(), suggestedName),
      filters: [{ name: 'Web Page, complete', extensions: ['html', 'htm'] }]
    })
    if (result.canceled || !result.filePath) return null
    await this.view.webContents.savePage(result.filePath, 'HTMLComplete')
    return result.filePath
  }

  /** JPEG snapshot of the page, used to keep a dimmed preview behind overlays (URL bar, Glance). */
  async snapshot(): Promise<string | null> {
    try {
      const image = await this.view.webContents.capturePage()
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
      const image = await this.view.webContents.capturePage()
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
      this.view.webContents.copyImageAt(x, y)
      return true
    } catch {
      return false
    }
  }

  replaceMisspelling(word: string): void {
    this.view.webContents.replaceMisspelling(word)
  }

  addWordToDictionary(word: string): void {
    this.view.webContents.session.addWordToSpellCheckerDictionary(word)
  }
}

/** Creates `WebContentsView`s inside the (single) browser window. */
export class ElectronTabViewHost implements TabViewHost {
  private readonly byWebContentsId = new Map<number, string>()
  private readonly views = new Set<ElectronTabView>()
  private getWindow: () => BrowserWindow | null = () => null

  constructor(private readonly sessions: SessionManager) {}

  bindWindow(getWindow: () => BrowserWindow | null): void {
    this.getWindow = getWindow
  }

  createView(tab: Tab, events: TabViewEvents): TabView {
    const win = this.getWindow()
    if (!win) throw new Error('Browser window not created yet')
    const view = new ElectronTabView(win, tab, this.sessions, events, (v) => {
      this.views.delete(v)
      for (const [id, tabId] of this.byWebContentsId)
        if (tabId === tab.id) this.byWebContentsId.delete(id)
    })
    this.views.add(view)
    this.byWebContentsId.set(view.webContents.id, tab.id)
    return view
  }

  tabIdForWebContents(wc: WebContents): string | undefined {
    return this.byWebContentsId.get(wc.id)
  }
}

/** Copy an image on the clipboard from a URL (data: or remote). */
export async function copyImageFromUrl(url: string): Promise<boolean> {
  try {
    if (url.startsWith('data:')) {
      clipboard.writeImage(nativeImage.createFromDataURL(url))
      return true
    }
    const res = await net.fetch(url)
    const buf = Buffer.from(await res.arrayBuffer())
    clipboard.writeImage(nativeImage.createFromBuffer(buf))
    return true
  } catch {
    return false
  }
}

export function defaultDownloadsDirectory(): string {
  return app.getPath('downloads')
}
