import {
  app,
  ipcMain,
  type BrowserWindow,
  type Extension,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type IpcMainServiceWorkerEvent,
  type IpcMainServiceWorkerInvokeEvent,
  type ServiceWorkerMain,
  type Session
} from 'electron'
import { join } from 'node:path'
import {
  DEFAULT_CONTAINER_ID,
  type ExtensionAction,
  type ExtensionInfo
} from '../../../shared/types'
import type { StoreIO } from '../../../core/platform'
import type { Browser } from '../../../core/browser'
import type { ZenWindow } from '../../../core/window'
import type { ExtensionManifest } from '../../../core/extensions/manifest'
import type { PermissionSet } from '../../../core/extensions/api/permissions'
import type { InvokeResult } from '../../../core/extensions/api/shim'
import { API_SPEC, STORAGE_METHODS, isSpecMethod } from '../../../core/extensions/api/spec'
import type { RegistryEvent } from '../extensions'
import type { SessionManager } from '../sessions'
import type { ElectronTabViewHost } from '../views'
import { ActionApi } from './action'
import { AlarmsApi } from './alarms'
import {
  ContextRegistry,
  type DispatchOptions,
  type FrameContext,
  type FrameKind,
  type HelloPayload
} from './contexts'
import { ExtensionApi } from './extension'
import { ManagementApi } from './management'
import { ApiModel, type ModelSnapshot } from './model'
import { PermissionsApi } from './permissions'
import { RuntimeApi } from './runtime'
import { ApiStore } from './store'
import { StorageApi } from './storage'
import { TabsApi } from './tabs'
import {
  ApiError,
  extensionIdFromUrl,
  extensionIdOfFrame,
  extensionUrl,
  isRecord,
  type ApiContext,
  type ApiHost,
  type LoadedExtension,
  type NamespaceHandlers,
  type Sender
} from './types'
import { WindowsApi } from './windows'

/** IPC channels between the context-side shim (through its preload) and this router. */
export const CHANNELS = {
  call: 'zen-ext:call',
  notify: 'zen-ext:notify',
  event: 'zen-ext:event'
} as const

const FRAME_PRELOAD_ID = 'zen-extension-frame'
const WORKER_PRELOAD_ID = 'zen-extension-worker'
/** One bundle for both context types: a sandboxed preload cannot load a shared chunk. */
const extensionPreload = join(__dirname, '../preload/extension.js')

/** What `ExtensionService` asks the API layer (the only coupling between the two). */
export interface ExtensionApiHooks {
  /** Effective `chrome.action` state for the active tab, for `ExtensionInfo.action`. */
  actionState(extensionId: string): ExtensionAction | null
  /**
   * The popup page a toolbar click should open (extension-relative), or null when nothing opens:
   * the action is disabled on the tab, or it has no popup and `action.onClicked` was fired instead.
   */
  popupForClick(extensionId: string, win: ZenWindow): string | null
}

type FrameSender = Extract<Sender, { kind: 'frame' }>

/**
 * The Zenium browser layer for extensions: everything Electron's engine leaves inert or absent
 * in `chrome.*`, implemented in the main process and reached from extension contexts through the
 * shim in `core/extensions/api`. One module per namespace; this class owns the transport (IPC
 * from documents and MV3 service workers), authorisation (the sender's extension id comes from
 * its frame URL or worker scope, never from the message), the context registry that fans events
 * out, and the tick that turns tab-model changes into `tabs.*` / `windows.*` events.
 */
export class ExtensionApiHost implements ApiHost, ExtensionApiHooks {
  readonly model: ApiModel
  readonly registry: ContextRegistry
  readonly store: ApiStore
  readonly tabs: TabsApi
  readonly windows: WindowsApi
  readonly runtime: RuntimeApi
  readonly action: ActionApi
  readonly storage: StorageApi
  readonly alarms: AlarmsApi
  readonly permissions: PermissionsApi
  readonly extension: ExtensionApi
  readonly management: ManagementApi

  private readonly namespaces: Record<string, NamespaceHandlers>
  private readonly extensions = new Map<string, LoadedExtension>()
  /** Loaded at least once in this process: `runtime.onStartup` goes with the first load only. */
  private readonly seen = new Set<string>()
  private readonly attachedSessions = new WeakSet<Session>()
  private readonly wiredWorkers = new WeakSet<ServiceWorkerMain>()
  private readonly watchedWindows = new WeakSet<BrowserWindow>()
  private snapshot: ModelSnapshot | null = null
  private tickTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly browser: Browser,
    readonly sessions: SessionManager,
    private readonly views: ElectronTabViewHost,
    io: StoreIO,
    userDataDir: string
  ) {
    this.model = new ApiModel(browser, views)
    this.store = new ApiStore(io, userDataDir)
    this.registry = new ContextRegistry({
      sessionsFor: (extensionId) => this.extensions.get(extensionId)?.sessions ?? [],
      persistWorkerEvents: (extensionId, events) => this.store.setWorkerEvents(extensionId, events),
      placeFrame: (frame) => this.placeFrame(frame)
    })
    this.tabs = new TabsApi(this)
    this.windows = new WindowsApi(this)
    this.runtime = new RuntimeApi(this)
    this.action = new ActionApi(this)
    this.storage = new StorageApi(this)
    this.alarms = new AlarmsApi(this)
    this.permissions = new PermissionsApi(this)
    this.extension = new ExtensionApi(this)
    this.management = new ManagementApi(this)
    this.namespaces = {
      tabs: this.tabs.handlers,
      windows: this.windows.handlers,
      runtime: this.runtime.handlers,
      action: this.action.handlers,
      storage: this.storage.handlers,
      alarms: this.alarms.handlers,
      permissions: this.permissions.handlers,
      extension: this.extension.handlers,
      management: this.management.handlers
    }
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  /** Register the document-side IPC and start following the tab model. */
  install(): void {
    ipcMain.handle(CHANNELS.call, (event, namespace, method, args) =>
      this.call(frameSender(event), namespace, method, args)
    )
    ipcMain.on(CHANNELS.notify, (event, kind, payload) =>
      this.notify(frameSender(event), kind, payload)
    )
    this.browser.state.subscribe(() => this.scheduleTick())
    app.on('before-quit', () => this.flushSync())
  }

  /**
   * The registry's own events: `management.on*` for the other extensions, and the uninstall URL
   * once an extension is gone for good (a disable or a reload keeps its stored state).
   */
  registryChanged(event: RegistryEvent): void {
    switch (event.type) {
      case 'installed':
      case 'updated':
        this.tellOthers('onInstalled', event.id)
        return
      case 'enabled':
        this.tellOthers('onEnabled', event.id)
        return
      case 'disabled':
        this.tellOthers('onDisabled', event.id)
        return
      case 'uninstalled':
        this.seen.delete(event.id)
        this.runtime.openUninstallUrl(event.id)
        this.store.forget(event.id)
        this.registry.forget(event.id, { keepWorkerEvents: false })
        this.broadcast('management', 'onUninstalled', () => [event.id])
        return
    }
  }

  /** A persistent (extension-capable) session: preloads, worker IPC, load / unload tracking. */
  attachSession(ses: Session): void {
    if (this.attachedSessions.has(ses)) return
    this.attachedSessions.add(ses)
    const registered = ses.getPreloadScripts().map((script) => script.id)
    if (!registered.includes(FRAME_PRELOAD_ID)) {
      ses.registerPreloadScript({
        type: 'frame',
        id: FRAME_PRELOAD_ID,
        filePath: extensionPreload
      })
    }
    if (!registered.includes(WORKER_PRELOAD_ID)) {
      ses.registerPreloadScript({
        type: 'service-worker',
        id: WORKER_PRELOAD_ID,
        filePath: extensionPreload
      })
    }
    ses.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
      if (runningStatus === 'starting' || runningStatus === 'running') {
        const worker = ses.serviceWorkers.getWorkerFromVersionID(versionId)
        if (worker) this.wireWorker(worker, ses)
      }
      this.registry.workerStatus(versionId, ses, runningStatus)
    })
    ses.extensions.on('extension-loaded', (_event, ext) => this.onLoaded(ext, ses))
    ses.extensions.on('extension-unloaded', (_event, ext) => this.onUnloaded(ext, ses))
    for (const ext of ses.extensions.getAllExtensions()) this.onLoaded(ext, ses)
  }

  /** The IPC of an MV3 worker is per worker; attach once it starts (before its script runs). */
  private wireWorker(worker: ServiceWorkerMain, ses: Session): void {
    if (this.wiredWorkers.has(worker) || !worker.scope.startsWith('chrome-extension://')) return
    this.wiredWorkers.add(worker)
    worker.ipc.handle(CHANNELS.call, (event, namespace, method, args) =>
      this.call(workerSender(event, ses), namespace, method, args)
    )
    worker.ipc.on(CHANNELS.notify, (event, kind, payload) =>
      this.notify(workerSender(event, ses), kind, payload)
    )
  }

  // ---------------------------------------------------------------------------
  // Extension lifecycle
  // ---------------------------------------------------------------------------

  private onLoaded(ext: Extension, ses: Session): void {
    const existing = this.extensions.get(ext.id)
    if (existing) {
      if (!existing.sessions.includes(ses)) existing.sessions.push(ses)
      this.orderSessions(existing)
      return
    }
    const info = this.infoFor(ext)
    const loaded: LoadedExtension = {
      id: ext.id,
      extension: ext,
      manifest: ext.manifest as ExtensionManifest,
      path: ext.path,
      sessions: [ses],
      unpacked: isUnpacked(info)
    }
    this.extensions.set(ext.id, loaded)
    this.registry.restoreWorkerEvents(ext.id, this.store.workerEvents(ext.id))
    this.permissions.load(loaded)
    this.alarms.load(ext.id)
    // Existing tabs are the baseline, not a burst of `tabs.onCreated`.
    if (!this.snapshot) this.snapshot = this.model.snapshot()
    const firstEver = this.store.installedVersion(ext.id) === undefined
    this.runtime.lifecycle(ext.id, ext.version, !this.seen.has(ext.id) && !firstEver)
    this.seen.add(ext.id)
    this.commitUi()
  }

  private onUnloaded(ext: Extension, ses: Session): void {
    const loaded = this.extensions.get(ext.id)
    if (!loaded) return
    loaded.sessions = loaded.sessions.filter((s) => s !== ses)
    if (loaded.sessions.length > 0) return
    this.extensions.delete(ext.id)
    this.alarms.unload(ext.id)
    this.permissions.unload(ext.id)
    this.action.forget(ext.id)
    this.storage.forget(ext.id)
    this.registry.forget(ext.id, { keepWorkerEvents: true })
    this.commitUi()
  }

  /** `management.on*` about one extension goes to every other loaded extension. */
  private tellOthers(event: 'onInstalled' | 'onEnabled' | 'onDisabled', subjectId: string): void {
    const info = this.management.infoFor(subjectId)
    if (!info) return
    this.broadcast('management', event, (ext) => (ext.id === subjectId ? null : [info]))
  }

  /** The default container's session is the primary one (workers are woken there). */
  private orderSessions(loaded: LoadedExtension): void {
    const primary = this.sessions.get(DEFAULT_CONTAINER_ID)
    loaded.sessions.sort((a, b) => Number(b === primary) - Number(a === primary))
  }

  private infoFor(ext: Extension): ExtensionInfo | undefined {
    return this.browser.extensions.list().find((info) => info.path === ext.path)
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  /** Who is calling, verified from the frame URL / worker scope; never from the payload. */
  private contextFor(sender: Sender | null): ApiContext {
    if (!sender) throw new ApiError('Unauthorised')
    const extensionId =
      sender.kind === 'frame'
        ? extensionIdOfFrame(sender.frame)
        : extensionIdFromUrl(sender.worker.scope)
    const extension = extensionId ? this.extensions.get(extensionId) : undefined
    if (!extensionId || !extension) throw new ApiError('Unauthorised')
    const session = sender.kind === 'frame' ? sender.webContents.session : sender.session
    if (!extension.sessions.includes(session)) throw new ApiError('Unauthorised')
    if (sender.kind === 'worker') {
      return { extensionId, extension, session, sender, tabId: null, window: undefined }
    }
    return {
      extensionId,
      extension,
      session,
      sender,
      tabId: this.views.tabIdForWebContents(sender.webContents) ?? null,
      window: this.model.zenWindowForWebContents(sender.webContents)
    }
  }

  private hello(ctx: ApiContext, payload: unknown): void {
    const hello = helloPayloadFrom(payload)
    if (ctx.sender.kind === 'worker') {
      this.registry.helloWorker(ctx.extensionId, ctx.sender.worker, ctx.sender.session)
      return
    }
    const kind = this.frameKind(ctx, hello)
    this.registry.helloFrame(ctx.extensionId, ctx.sender.frame, ctx.sender.webContents, hello, kind)
  }

  private async call(
    sender: Sender | null,
    namespace: unknown,
    method: unknown,
    args: unknown
  ): Promise<InvokeResult> {
    let task: { end(): void } | null = null
    try {
      const ctx = this.contextFor(sender)
      if (typeof namespace !== 'string' || typeof method !== 'string') {
        throw new ApiError('Invalid call')
      }
      const routed = namespace === 'browserAction' ? 'action' : namespace
      const known =
        routed === 'storage'
          ? (STORAGE_METHODS as readonly string[]).includes(method)
          : isSpecMethod(API_SPEC, namespace, method)
      const handlers = this.namespaces[routed]
      if (!known || !handlers || !Object.prototype.hasOwnProperty.call(handlers, method)) {
        throw new ApiError(`${namespace}.${method} is not available in Zenium.`)
      }
      // Chrome keeps a worker alive while one of its API calls is in flight.
      if (ctx.sender.kind === 'worker') task = startTask(ctx.sender.worker)
      const value = await handlers[method](ctx, ...(Array.isArray(args) ? args : []))
      return { ok: true, value }
    } catch (error) {
      if (!(error instanceof ApiError)) {
        console.warn(`[zen] extension api ${String(namespace)}.${String(method)}:`, error)
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      task?.end()
    }
  }

  private notify(sender: Sender | null, kind: unknown, payload: unknown): void {
    let ctx: ApiContext
    try {
      ctx = this.contextFor(sender)
    } catch {
      return
    }
    if (kind === 'hello') {
      this.hello(ctx, payload)
      return
    }
    const context =
      ctx.sender.kind === 'frame'
        ? this.registry.frameFor(ctx.sender.frame)
        : this.registry.workerFor(ctx.sender.worker, ctx.sender.session)
    switch (kind) {
      case 'listen':
      case 'unlisten':
        if (context && isRecord(payload) && typeof payload.event === 'string') {
          this.registry.listen(context, payload.event, kind === 'listen')
        }
        return
      case 'storage-changed':
        this.storage.changed(ctx, payload)
        return
      default:
        return
    }
  }

  private frameKind(ctx: ApiContext, hello: HelloPayload): FrameKind {
    if (hello.isBackgroundPage) return 'background'
    const sender = ctx.sender as FrameSender
    const wc = sender.webContents
    if (this.views.tabIdForWebContents(wc) || this.model.popupForTabId(wc.id)) return 'tab'
    if (wc.getType() === 'backgroundPage') return 'background'
    const popup = this.action.clickState(ctx.extensionId, ctx.window ?? this.lastWindow()).popup
    if (popup && hello.url.split('#')[0] === extensionUrl(ctx.extensionId, popup)) return 'popup'
    return ctx.window ? 'popup' : 'other'
  }

  private lastWindow(): ZenWindow {
    return this.model.lastFocusedWindow() ?? this.browser.focusedWindow()
  }

  private placeFrame(frame: FrameContext): { tabId?: number; windowId?: number } {
    const zenTabId = this.views.tabIdForWebContents(frame.webContents)
    const tab = zenTabId ? this.model.tab(zenTabId) : undefined
    if (tab) {
      const win = this.model.windowOfTab(tab)
      return {
        tabId: this.model.chromeTabId(tab),
        windowId: win ? this.model.windowIdOf(win) : undefined
      }
    }
    const popup = this.model.popupForTabId(frame.webContents.id)
    if (popup) return { tabId: frame.webContents.id, windowId: popup.bw.id }
    const win = this.model.zenWindowForWebContents(frame.webContents)
    return { windowId: win ? this.model.windowIdOf(win) : undefined }
  }

  // ---------------------------------------------------------------------------
  // ApiHost
  // ---------------------------------------------------------------------------

  loaded(extensionId: string): LoadedExtension | undefined {
    return this.extensions.get(extensionId)
  }

  allLoaded(): LoadedExtension[] {
    return [...this.extensions.values()]
  }

  dispatch(
    extensionId: string,
    namespace: string,
    event: string,
    args: unknown[],
    options?: DispatchOptions
  ): void {
    if (!this.extensions.has(extensionId)) return
    this.registry.dispatch(extensionId, namespace, event, args, options)
  }

  broadcast(
    namespace: string,
    event: string,
    argsFor: (extension: LoadedExtension) => unknown[] | null
  ): void {
    for (const ext of this.extensions.values()) {
      const args = argsFor(ext)
      if (args) this.registry.dispatch(ext.id, namespace, event, args)
    }
  }

  canSeeTab(extension: LoadedExtension, url: string): boolean {
    return this.permissions.canSeeTab(extension.id, url)
  }

  grants(extensionId: string): PermissionSet {
    return this.permissions.grants(extensionId)
  }

  commitUi(): void {
    this.browser.state.commitVolatile()
  }

  scheduleTick(): void {
    if (this.tickTimer) return
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null
      this.tick()
    }, 0)
  }

  openPopup(extensionId: string, win: ZenWindow): void {
    // No toolbar button asked for this one: anchor the popup below the top-right corner.
    const width = this.model.browserWindowOf(win)?.getContentBounds().width ?? 1200
    this.browser.extensions.openPopup(
      extensionId,
      { x: width - 56, y: 8, width: 40, height: 32 },
      win
    )
  }

  confirm(
    options: { message: string; detail?: string; okLabel: string; danger?: boolean },
    win?: ZenWindow
  ): Promise<boolean> {
    return this.browser.platform.dialogs.confirm({ ...options, cancelLabel: 'Cancel' }, win)
  }

  // ---------------------------------------------------------------------------
  // ExtensionApiHooks (what ExtensionService asks)
  // ---------------------------------------------------------------------------

  actionState(extensionId: string): ExtensionAction | null {
    return this.action.stateFor(extensionId)
  }

  popupForClick(extensionId: string, win: ZenWindow): string | null {
    const { popup, enabled } = this.action.clickState(extensionId, win)
    if (!enabled) return null
    if (popup) return popup
    this.action.clicked(extensionId, win)
    return null
  }

  // ---------------------------------------------------------------------------
  // The tick: model snapshots into tabs.* / windows.* events
  // ---------------------------------------------------------------------------

  private tick(): void {
    if (this.extensions.size === 0) {
      this.snapshot = null
      return
    }
    this.watchWindows()
    const next = this.model.snapshot()
    const prev = this.snapshot
    this.snapshot = next
    if (!prev) return
    for (const [zenId, before] of prev.tabs) {
      if (!next.tabs.has(zenId)) this.action.tabRemoved(before.chrome.id)
    }
    this.tabs.diff(prev, next)
    this.windows.diff(prev, next)
  }

  /** Bounds changes never commit state; follow the windows themselves for `onBoundsChanged`. */
  private watchWindows(): void {
    for (const win of this.browser.allWindows()) {
      const bw = this.model.browserWindowOf(win)
      if (!bw || this.watchedWindows.has(bw)) continue
      this.watchedWindows.add(bw)
      const tick = (): void => this.scheduleTick()
      bw.on('resize', tick)
      bw.on('move', tick)
      bw.on('closed', tick)
    }
  }

  flushSync(): void {
    this.alarms.flushSync()
    this.store.flushSync()
  }
}

function frameSender(event: IpcMainInvokeEvent | IpcMainEvent): Sender | null {
  const frame = event.senderFrame
  return frame ? { kind: 'frame', frame, webContents: event.sender } : null
}

function workerSender(
  event: IpcMainServiceWorkerInvokeEvent | IpcMainServiceWorkerEvent,
  ses: Session
): Sender {
  return { kind: 'worker', worker: event.serviceWorker, session: event.session ?? ses }
}

function startTask(worker: ServiceWorkerMain): { end(): void } | null {
  try {
    return worker.startTask()
  } catch {
    return null
  }
}

function helloPayloadFrom(payload: unknown): HelloPayload {
  const p = isRecord(payload) ? payload : {}
  return {
    kind: p.kind === 'worker' ? 'worker' : 'frame',
    url: typeof p.url === 'string' ? p.url : '',
    manifestVersion: p.manifestVersion === 2 ? 2 : 3,
    isBackgroundPage: p.isBackgroundPage === true,
    browserAliased: p.browserAliased === true
  }
}

/** Unpacked folders are Chrome's "development" installs: no 30-second alarm floor, for one. */
function isUnpacked(info: ExtensionInfo | undefined): boolean {
  return info === undefined || info.source === 'unpacked'
}
