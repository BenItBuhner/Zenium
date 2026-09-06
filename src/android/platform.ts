import type { EventName, Events, HostCapabilities } from '@shared/types'
import { newId } from '@shared/ids'
import { Browser } from '@core/browser'
import { RendererMenuHost } from '@core/rendererMenus'
import type {
  AppHost,
  ChromeHost,
  ClipboardHost,
  DialogHost,
  DownloadHost,
  KeyEventInput,
  NetHost,
  Platform,
  PlatformInfo,
  SessionHost,
  ShellHost,
  StoreIO,
  WindowHost
} from '@core/platform'
import type { Bridge } from './bridge'
import { AndroidTabViewHost, type ViewEventPayloads } from './views'

export const ANDROID_CAPABILITIES: HostCapabilities = {
  windowControls: false,
  nativeMenus: false,
  windowDrag: false,
  devtools: false,
  compactReveal: false,
  pictureInPicture: false,
  viewSource: false
}

/** Everything Kotlin hands over synchronously before the chrome renders. */
export interface BootInfo {
  version: string
  /** Persisted JSON documents by name (state.json, history.json, …). */
  files: Record<string, string>
  downloadsDir: string
  insets: { top: number; right: number; bottom: number; left: number }
  fullscreen: boolean
}

/** Events Kotlin raises for the whole app (`__zenHost.hostEvent(name, payload)`). */
export interface HostEventPayloads {
  insets: { top: number; right: number; bottom: number; left: number }
  focus: { focused: boolean }
  fullscreen: { fullscreen: boolean }
  openUrl: { url: string }
  pause: void
  'download.started': {
    token: string
    url: string
    filename: string
    totalBytes: number
    mimeType: string
    sourceTabId: string | null
  }
  'download.progress': {
    token: string
    receivedBytes: number
    totalBytes: number
    state: 'progressing' | 'paused' | 'interrupted'
  }
  'download.done': {
    token: string
    state: 'completed' | 'cancelled' | 'interrupted'
    savePath: string
    filename: string
  }
  'permission.request': { requestId: string; permission: string; url: string }
  'view.adopt': { viewId: string; parentTabId: string | null; active: boolean }
}

type Listener = (payload: unknown) => void

/** In-process event fan-out: the chrome runs in the same document as the core. */
class InProcessChrome implements ChromeHost {
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(private readonly bridge: Bridge) {}

  send<K extends EventName>(name: K, payload: Events[K]): void {
    const set = this.listeners.get(name)
    if (!set) return
    for (const listener of [...set]) {
      try {
        listener(payload)
      } catch (error) {
        console.error(`[zen] event listener for ${name} failed`, error)
      }
    }
  }

  on<K extends EventName>(name: K, listener: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(name)
    if (!set) {
      set = new Set()
      this.listeners.set(name, set)
    }
    const wrapped = listener as Listener
    set.add(wrapped)
    return () => {
      set?.delete(wrapped)
    }
  }

  focus(): void {
    this.bridge.send('chrome.focus')
  }

  openDevTools(): void {
    // Chrome's remote inspector (chrome://inspect) attaches to the chrome WebView.
  }
}

class AndroidStoreIO implements StoreIO {
  constructor(
    private readonly bridge: Bridge,
    private readonly files: Record<string, string>
  ) {}

  readSync(name: string): string | null {
    return this.files[name] ?? null
  }

  async write(name: string, text: string): Promise<void> {
    this.files[name] = text
    await this.bridge.call('storage.write', { name, text })
  }

  writeSync(name: string, text: string): void {
    this.files[name] = text
    this.bridge.callSync('storage.writeSync', { name, text })
  }
}

/**
 * Zen's browser core running inside the chrome WebView on Android. Kotlin owns the tab
 * WebViews, downloads, permissions and dialogs; this class turns the `Platform` contract into
 * bridge calls and routes Kotlin's events back into the core.
 */
export class AndroidPlatform implements Platform {
  readonly info: PlatformInfo
  readonly io: AndroidStoreIO
  readonly chrome: InProcessChrome
  readonly window: WindowHost
  readonly views: AndroidTabViewHost
  readonly menus: RendererMenuHost
  readonly dialogs: DialogHost
  readonly clipboard: ClipboardHost
  readonly shell: ShellHost
  readonly net: NetHost
  readonly downloads: DownloadHost
  readonly sessions: SessionHost
  readonly app: AppHost
  browser!: Browser
  private fullscreen: boolean
  private readonly downloadTokens = new Map<string, string>()

  constructor(
    private readonly bridge: Bridge,
    boot: BootInfo
  ) {
    this.info = { os: 'android', version: boot.version }
    this.fullscreen = boot.fullscreen
    this.io = new AndroidStoreIO(bridge, boot.files)
    this.chrome = new InProcessChrome(bridge)
    this.views = new AndroidTabViewHost(bridge)
    this.menus = new RendererMenuHost(this.chrome)
    this.window = {
      contentSize: () => ({ width: window.innerWidth, height: window.innerHeight }),
      isFullScreen: () => this.fullscreen,
      setFullScreen: (fullscreen) => bridge.send('window.setFullscreen', { fullscreen }),
      isMaximized: () => true,
      minimize: () => bridge.send('app.background'),
      maximize: () => undefined,
      unmaximize: () => undefined,
      close: () => bridge.send('app.quit')
    }
    this.dialogs = {
      confirm: (options) => bridge.call<boolean>('dialog.confirm', options)
    }
    this.clipboard = {
      writeText: (text) => bridge.send('clipboard.writeText', { text }),
      writeImageFromUrl: (url) => bridge.call<boolean>('clipboard.writeImage', { url })
    }
    this.shell = {
      openExternal: (url) => bridge.send('app.openExternal', { url }),
      openPath: (path) => bridge.call('app.openPath', { path }),
      showItemInFolder: () => bridge.send('download.showAll')
    }
    this.net = {
      fetchText: async (url, options) => {
        const result = await bridge.call<{ ok: boolean; text: string }>('net.fetch', {
          url,
          headers: options.headers ?? {}
        })
        if (options.signal?.aborted) throw new Error('aborted')
        return result
      }
    }
    this.downloads = {
      pause: (id) => bridge.send('download.pause', { id }),
      resume: (id) => bridge.send('download.resume', { id }),
      cancel: (id) => bridge.send('download.cancel', { id }),
      open: (item) =>
        bridge.call('download.open', {
          id: item.id,
          savePath: item.savePath,
          mimeType: item.mimeType
        }),
      showInFolder: () => bridge.send('download.showAll')
    }
    this.sessions = {
      clearContainerData: (containerId) => bridge.call('profile.clear', { containerId })
    }
    this.app = {
      quit: () => bridge.send('app.quit'),
      downloadsDirectory: () => boot.downloadsDir
    }
    this.chrome.on('insets', () => undefined)
    this.chrome.send('insets', boot.insets)
  }

  bind(browser: Browser): void {
    this.browser = browser
  }

  // ---------------------------------------------------------------------------
  // Kotlin → JS
  // ---------------------------------------------------------------------------

  viewEvent<K extends keyof ViewEventPayloads>(
    tabId: string,
    name: K,
    payload: ViewEventPayloads[K]
  ): void {
    const view = this.views.get(tabId)
    if (!view) return
    view.dispatch(name, payload)
    if (name === 'destroyed') this.views.forget(tabId)
  }

  /** A physical key pressed while a page WebView had focus (already matched by Kotlin). */
  viewKey(tabId: string | null, input: KeyEventInput): boolean {
    if (tabId === null) return this.browser.keys.handle(input, null)
    const view = this.views.get(tabId)
    return view ? view.key(input) : this.browser.keys.handle(input, null)
  }

  hostEvent<K extends keyof HostEventPayloads>(name: K, payload: HostEventPayloads[K]): void {
    const { browser } = this
    switch (name) {
      case 'insets':
        this.chrome.send('insets', payload as HostEventPayloads['insets'])
        return
      case 'focus': {
        const { focused } = payload as HostEventPayloads['focus']
        browser.state.window.focused = focused
        browser.state.commitVolatile()
        return
      }
      case 'fullscreen': {
        const { fullscreen } = payload as HostEventPayloads['fullscreen']
        this.fullscreen = fullscreen
        browser.state.window.fullscreen = fullscreen
        browser.state.commitVolatile()
        return
      }
      case 'openUrl':
        browser.openExternalUrl((payload as HostEventPayloads['openUrl']).url)
        return
      case 'pause':
        browser.flushSync()
        return
      case 'download.started': {
        const p = payload as HostEventPayloads['download.started']
        const record = browser.downloads.begin({
          url: p.url,
          filename: p.filename,
          totalBytes: p.totalBytes,
          mimeType: p.mimeType
        })
        this.downloadTokens.set(p.token, record.id)
        this.bridge.send('download.bind', { token: p.token, id: record.id })
        browser.onDownloadStarted(p.sourceTabId)
        return
      }
      case 'download.progress': {
        const p = payload as HostEventPayloads['download.progress']
        const id = this.downloadTokens.get(p.token)
        if (id)
          browser.downloads.progress(id, {
            receivedBytes: p.receivedBytes,
            totalBytes: p.totalBytes,
            state: p.state
          })
        return
      }
      case 'download.done': {
        const p = payload as HostEventPayloads['download.done']
        const id = this.downloadTokens.get(p.token)
        this.downloadTokens.delete(p.token)
        if (id)
          browser.downloads.finish(id, p.state, { savePath: p.savePath, filename: p.filename })
        return
      }
      case 'permission.request': {
        const p = payload as HostEventPayloads['permission.request']
        void browser.permissions
          .decide(p.permission, p.url)
          .then((allow) =>
            this.bridge.send('permission.respond', { requestId: p.requestId, allow })
          )
        return
      }
      case 'view.adopt': {
        const p = payload as HostEventPayloads['view.adopt']
        // Kotlin created the WebView for a popup. Pick the tab id first and bind it before the
        // core issues any placement calls for the new view (bridge calls are delivered in order).
        const tabId = newId('tab')
        const view = this.views.registerAdopted(tabId)
        this.bridge.send('view.bind', { viewId: p.viewId, tabId })
        const { events } = browser.tabs.adoptView(view, {
          tabId,
          parentTabId: p.parentTabId,
          active: p.active
        })
        view.events = events
        return
      }
    }
  }
}
