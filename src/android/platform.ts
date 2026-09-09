import type { EventName, Events, HostCapabilities } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import { newId } from '@shared/ids'
import { Browser } from '@core/browser'
import { RendererMenuHost } from '@core/rendererMenus'
import type { ZenWindow } from '@core/window'
import type {
  AgentTransport,
  AppHost,
  ClipboardHost,
  DialogHost,
  DownloadHost,
  KeyEventInput,
  NetHost,
  PickedTextFile,
  Platform,
  PlatformInfo,
  SessionHost,
  ShellHost,
  StoreIO,
  WindowHost,
  WindowHostFactory
} from '@core/platform'
import readabilityJs from '@mozilla/readability/Readability.js?raw'
import readabilityReaderableJs from '@mozilla/readability/Readability-readerable.js?raw'
import type { AgentHttpRequest, AgentHttpResponse } from '@core/agent/http'
import type { Bridge } from './bridge'
import { AndroidTabViewHost, type ViewEventPayloads } from './views'

export const ANDROID_CAPABILITIES: HostCapabilities = {
  windowControls: false,
  nativeMenus: false,
  windowDrag: false,
  devtools: false,
  compactReveal: false,
  pictureInPicture: false,
  viewSource: false,
  windows: false,
  extensions: false,
  resourceGovernor: false,
  sync: false,
  print: true,
  agents: true
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
  /** An HTTP request reached the Kotlin MCP socket server; answered with `agent.reply`. */
  'agent.request': { id: number } & AgentHttpRequest
}

/**
 * The MCP server's socket lives in Kotlin (a foreground service keeps it alive while the app is
 * in the background); requests are relayed into the core and answered through the bridge.
 */
class AndroidAgentTransport implements AgentTransport {
  private onRequest: ((request: AgentHttpRequest) => Promise<AgentHttpResponse>) | null = null

  constructor(private readonly bridge: Bridge) {}

  async start(options: {
    port: number
    lan: boolean
    onRequest: (request: AgentHttpRequest) => Promise<AgentHttpResponse>
  }): Promise<{ port: number; lanAddresses: string[] }> {
    this.onRequest = options.onRequest
    return this.bridge.call<{ port: number; lanAddresses: string[] }>('agent.start', {
      port: options.port,
      lan: options.lan
    })
  }

  async stop(): Promise<void> {
    this.onRequest = null
    await this.bridge.call('agent.stop')
  }

  handle(payload: HostEventPayloads['agent.request']): void {
    const { id, ...request } = payload
    const reply = (response: AgentHttpResponse): void => {
      this.bridge.send('agent.reply', { id, ...response })
    }
    if (!this.onRequest) {
      reply({ status: 503, headers: { 'content-type': 'text/plain' }, body: 'MCP server stopped' })
      return
    }
    this.onRequest(request)
      .then(reply)
      .catch((error: Error) =>
        reply({
          status: 500,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: error.message }
          })
        })
      )
  }
}

type Listener = (payload: unknown) => void

/** In-process event fan-out: the chrome runs in the same document as the core. */
export class InProcessEvents {
  private readonly listeners = new Map<string, Set<Listener>>()

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
}

/**
 * The one window of the Android app. Its "chrome" is the document the core runs in, so events
 * are delivered in-process; the frame (fullscreen, focus, backgrounding) is the Activity.
 */
export class AndroidWindowHost implements WindowHost {
  focused = true
  fullscreen = false
  readonly alive = true

  constructor(
    private readonly bridge: Bridge,
    private readonly events: InProcessEvents
  ) {}

  send<K extends EventName>(name: K, payload: Events[K]): void {
    this.events.send(name, payload)
  }

  focusChrome(): void {
    this.bridge.send('chrome.focus')
  }

  openChromeDevTools(): void {
    // Chrome's remote inspector (chrome://inspect) attaches to the chrome WebView.
  }

  contentSize(): { width: number; height: number } {
    return { width: window.innerWidth, height: window.innerHeight }
  }

  isFullScreen(): boolean {
    return this.fullscreen
  }

  setFullScreen(fullscreen: boolean): void {
    this.bridge.send('window.setFullscreen', { fullscreen })
  }

  isMaximized(): boolean {
    return true
  }

  isFocused(): boolean {
    return this.focused
  }

  isVisible(): boolean {
    return true
  }

  minimize(): void {
    this.bridge.send('app.background')
  }

  /* eslint-disable @typescript-eslint/no-empty-function -- the Activity is always maximised */
  maximize(): void {}
  unmaximize(): void {}
  show(): void {}
  focus(): void {}
  /* eslint-enable @typescript-eslint/no-empty-function */

  close(): void {
    this.bridge.send('app.quit')
  }

  normalBounds(): null {
    return null
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
  readonly capabilities = ANDROID_CAPABILITIES
  readonly io: AndroidStoreIO
  readonly events = new InProcessEvents()
  readonly windows: WindowHostFactory
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
  private windowHost: AndroidWindowHost | null = null
  private zenWindow: ZenWindow | null = null
  private readonly downloadTokens = new Map<string, string>()
  private readonly agentTransport: AndroidAgentTransport

  constructor(
    private readonly bridge: Bridge,
    boot: BootInfo
  ) {
    this.info = { os: 'android', version: boot.version }
    this.io = new AndroidStoreIO(bridge, boot.files)
    this.agentTransport = new AndroidAgentTransport(bridge)
    this.views = new AndroidTabViewHost(bridge)
    this.menus = new RendererMenuHost()
    this.windows = {
      create: (win: ZenWindow): WindowHost => {
        if (this.windowHost) throw new Error('Android hosts a single window')
        const host = new AndroidWindowHost(bridge, this.events)
        host.fullscreen = boot.fullscreen
        this.windowHost = host
        this.zenWindow = win
        // The chrome document is already running; report it ready once the core has the host.
        queueMicrotask(() => win.onChromeReady())
        return host
      }
    }
    this.dialogs = {
      confirm: (options) => bridge.call<boolean>('dialog.confirm', options),
      pickTextFiles: (options) => bridge.call<PickedTextFile[]>('dialog.openText', options)
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
        const result = await bridge.call<{ ok: boolean; status?: number; text: string }>(
          'net.fetch',
          { url, headers: options.headers ?? {} }
        )
        if (options.signal?.aborted) throw new Error('aborted')
        return { ok: result.ok, status: result.status ?? (result.ok ? 200 : 0), text: result.text }
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
      clearContainerData: (containerId) => bridge.call('profile.clear', { containerId }),
      clearPrivate: () => bridge.call('profile.clear', { containerId: PRIVATE_CONTAINER_ID })
    }
    this.app = {
      quit: () => bridge.send('app.quit'),
      relaunch: () => bridge.send('app.quit'),
      lastWindowClosed: () => undefined
    }
    this.events.send('insets', boot.insets)
  }

  bind(browser: Browser): void {
    this.browser = browser
    this.views.reader = (id) => browser.reader.pageHtml(id)
  }

  createAgentTransport(): AgentTransport {
    return this.agentTransport
  }

  /** Mozilla's Readability, bundled with the chrome. */
  readabilitySource(file: 'Readability.js' | 'Readability-readerable.js'): string {
    return file === 'Readability.js' ? readabilityJs : readabilityReaderableJs
  }

  /** The app's single window (created by `Browser.start`). */
  get window(): ZenWindow {
    if (!this.zenWindow) throw new Error('Browser not started')
    return this.zenWindow
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
    if (tabId === null) return this.browser.keys.handle(input, null, this.window)
    const view = this.views.get(tabId)
    return view ? view.key(input) : this.browser.keys.handle(input, null, this.window)
  }

  hostEvent<K extends keyof HostEventPayloads>(name: K, payload: HostEventPayloads[K]): void {
    const { browser } = this
    switch (name) {
      case 'insets':
        this.events.send('insets', payload as HostEventPayloads['insets'])
        return
      case 'focus': {
        const { focused } = payload as HostEventPayloads['focus']
        if (!this.windowHost) return
        this.windowHost.focused = focused
        if (focused) this.window.onFocused()
        else this.window.onWindowStateChanged()
        return
      }
      case 'fullscreen': {
        const { fullscreen } = payload as HostEventPayloads['fullscreen']
        if (!this.windowHost) return
        this.windowHost.fullscreen = fullscreen
        this.window.onWindowStateChanged()
        return
      }
      case 'openUrl':
        browser.openExternalUrl((payload as HostEventPayloads['openUrl']).url, this.window)
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
      case 'agent.request':
        this.agentTransport.handle(payload as HostEventPayloads['agent.request'])
        return
      case 'view.adopt': {
        const p = payload as HostEventPayloads['view.adopt']
        // Kotlin created the WebView for a popup. Pick the tab id first and bind it before the
        // core issues any placement calls for the new view (bridge calls are delivered in order).
        const tabId = newId('tab')
        const view = this.views.registerAdopted(tabId)
        this.bridge.send('view.bind', { viewId: p.viewId, tabId })
        const { events } = browser.tabs.adoptView(
          view,
          { tabId, parentTabId: p.parentTabId, active: p.active },
          this.window
        )
        view.events = events
        return
      }
    }
  }
}
