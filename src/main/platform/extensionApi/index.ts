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
  type Session,
  type WebContents
} from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_CONTAINER_ID,
  PRIVATE_CONTAINER_ID,
  type ExtensionAction,
  type ExtensionCommandInfo,
  type ExtensionInfo,
  type Rect,
  type SidePanelInfo,
  type Suggestion
} from '../../../shared/types'
import type { StoreIO } from '../../../core/platform'
import type { Browser } from '../../../core/browser'
import type { ZenWindow } from '../../../core/window'
import type { ExtensionManifest } from '../../../core/extensions/manifest'
import type { PermissionSet } from '../../../core/extensions/api/permissions'
import type { InvokeResult } from '../../../core/extensions/api/shim'
import {
  API_SPEC,
  CONTENT_SETTINGS_INTERNAL_METHODS,
  DESKTOP_CAPTURE_INTERNAL_METHODS,
  PRIVACY_INTERNAL_METHODS,
  PROXY_INTERNAL_METHODS,
  STORAGE_INTERNAL_METHODS,
  STORAGE_METHODS,
  TAB_CAPTURE_INTERNAL_METHODS,
  USER_SCRIPTS_INTERNAL_METHODS,
  WEB_REQUEST_INTERNAL_METHODS,
  isSpecMethod
} from '../../../core/extensions/api/spec'
import { CONTENT_SCRIPT_PRELUDE_FILE } from '../../../core/extensions/api/contentScriptStorage'
import {
  hasWithheldPermissions,
  noWithheldPermissions
} from '../../../core/extensions/withheldPermissions'
import {
  USER_SCRIPTS_CHANNELS,
  USER_SCRIPTS_SHIM,
  type HostShimOptions
} from '../../../shared/userScripts'
import { normalizeEventFilters, type UrlFilter } from '../../../core/extensions/api/urlFilter'
import type { KeyEventInput, MenuItemTemplate, PageContextParams } from '../../../core/platform'
import type { RegistryEvent } from '../extensions'
import type { SessionManager } from '../sessions'
import type { ElectronTabViewHost } from '../views'
import { ActionApi } from './action'
import { ActiveTabGrants } from './activeTab'
import { AlarmsApi } from './alarms'
import { BookmarksApi } from './bookmarks'
import { BrowsingDataApi, electronDataClearer } from './browsingData'
import { CommandsApi } from './commands'
import { ContextMenusApi } from './contextMenus'
import {
  ContextRegistry,
  type DispatchOptions,
  type FrameContext,
  type FrameKind,
  type HelloPayload,
  type ListenPayload
} from './contexts'
import { CookiesApi } from './cookies'
import { DeclarativeNetRequestHostApi } from './declarativeNetRequest'
import type { ScopedRuleSink } from './dnrSink'
import { DownloadsApi, type DownloadBridge } from './downloads'
import { ExtensionApi } from './extension'
import { HistoryApi } from './history'
import { IdentityApi } from './identity'
import { electronAuthWindowHost } from './identityBridge'
import { ManagementApi } from './management'
import { ApiModel, type ModelSnapshot } from './model'
import { NotificationsApi } from './notifications'
import { OffscreenApi } from './offscreen'
import { electronOffscreenDocumentHost } from './offscreenBridge'
import { OmniboxApi } from './omnibox'
import { PermissionsApi } from './permissions'
import { PrivacyApi } from './privacy'
import { ProxyApi } from './proxy'
import { ContentSettingsApi } from './contentSettings'
import { RuntimeApi } from './runtime'
import { SearchProviderApi } from './searchProvider'
import { SessionsApi } from './sessions'
import { SidePanelApi } from './sidePanel'
import { DebuggerApi } from './debugger'
import { electronPanelViewHost } from './sidePanelBridge'
import { ApiStore } from './store'
import { StorageApi } from './storage'
import { TabGroupsApi } from './tabGroups'
import { SystemDisplayApi } from './systemDisplay'
import { electronDisplayScreen } from './systemDisplayBridge'
import { SystemStorageApi } from './systemStorage'
import { SystemInfoApi } from './systemInfo'
import { TabCaptureApi } from './tabCapture'
import { electronStreamRegistrar } from './tabCaptureBridge'
import { TabsApi } from './tabs'
import { TopSitesApi } from './topSites'
import { InstanceIdApi } from './instanceId'
import { TtsApi } from './tts'
import { sharedSpeechEngine } from './ttsBridge'
import { UserScriptsApi } from './userScripts'
import {
  ApiError,
  extensionIdFromUrl,
  extensionIdOfFrame,
  extensionUrl,
  isInteger,
  isRecord,
  type ApiContext,
  type ApiHost,
  type LoadedExtension,
  type NamespaceHandlers,
  type Sender
} from './types'
import { WebNavigationApi } from './webNavigation'
import { WebRequestApi } from './webRequest'
import { WindowsApi } from './windows'
import { acquireOnIncomingIpc, WiredWorkers } from './workers'

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
  /** The manifest's commands with their bindings, for `ExtensionInfo.commands`; null when not loaded. */
  commandsInfo(
    extensionId: string
  ): { commands: ExtensionCommandInfo[]; conflicts: string[] } | null
  /**
   * The popup page a toolbar click should open (extension-relative), or null when nothing opens:
   * the action is disabled on the tab, or it has no popup and `action.onClicked` was fired instead.
   * The click is a user gesture on the extension: it grants `activeTab` on the active tab.
   */
  popupForClick(extensionId: string, win: ZenWindow): string | null
  /** `chrome.contextMenus` items for a page's context menu (see `ExtensionHost`). */
  pageContextMenuItems(tabId: string, params: PageContextParams): MenuItemTemplate[]
  /** The items an extension adds to its own toolbar button's context menu. */
  actionContextMenuItems(extensionId: string, win: ZenWindow): MenuItemTemplate[]
  /** A key press no Zenium shortcut claimed; true when an extension command took it. */
  handleKey(input: KeyEventInput, win: ZenWindow): boolean
  /** The `chrome.sidePanel` a window shows beside its page (see `ExtensionHost.sidePanel`). */
  sidePanelInfo(win: ZenWindow): SidePanelInfo | null
  toggleSidePanel(extensionId: string, win: ZenWindow): void
  closeSidePanel(win: ZenWindow): void
  placeSidePanel(win: ZenWindow, rect: Rect | null): void
  /** `chrome.omnibox` (see `ExtensionHost.omnibox*`). */
  omniboxSuggest(input: string, win: ZenWindow): Promise<Suggestion[] | null>
  omniboxSubmit(input: string, newTab: boolean, background: boolean, win: ZenWindow): boolean
  omniboxCancel(win: ZenWindow): void
  omniboxDeleteSuggestion(input: string): void
}

type FrameSender = Extract<Sender, { kind: 'frame' }>
type WorkerSender = Extract<Sender, { kind: 'worker' }>

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
  readonly activeTab: ActiveTabGrants
  readonly webNavigation: WebNavigationApi
  readonly contextMenus: ContextMenusApi
  readonly commands: CommandsApi
  readonly notifications: NotificationsApi
  readonly cookies: CookiesApi
  readonly declarativeNetRequest: DeclarativeNetRequestHostApi
  readonly webRequest: WebRequestApi
  readonly privacy: PrivacyApi
  readonly proxy: ProxyApi
  readonly contentSettings: ContentSettingsApi
  readonly bookmarks: BookmarksApi
  readonly history: HistoryApi
  readonly downloads: DownloadsApi
  /** `chrome.sessions` (recently closed); `sessions` is taken by the engine's session manager. */
  readonly recentlyClosed: SessionsApi
  readonly topSites: TopSitesApi
  readonly instanceId: InstanceIdApi
  readonly systemDisplay: SystemDisplayApi
  readonly systemStorage: SystemStorageApi
  readonly systemInfo: SystemInfoApi
  readonly tabGroups: TabGroupsApi
  readonly sidePanel: SidePanelApi
  readonly offscreen: OffscreenApi
  /** `chrome.tabCapture` and `chrome.desktopCapture`; the platform's media permission gate. */
  readonly tabCapture: TabCaptureApi
  readonly debugger: DebuggerApi
  readonly identity: IdentityApi
  readonly omnibox: OmniboxApi
  /** `chrome_settings_overrides.search_provider`: manifest-driven, no namespace of its own. */
  readonly searchProvider: SearchProviderApi
  readonly browsingData: BrowsingDataApi
  readonly tts: TtsApi
  readonly userScripts: UserScriptsApi

  private readonly namespaces: Record<string, NamespaceHandlers>
  private readonly extensions = new Map<string, LoadedExtension>()
  /** Loaded at least once in this process: `runtime.onStartup` goes with the first load only. */
  private readonly seen = new Set<string>()
  private readonly attachedSessions = new WeakSet<Session>()
  /** The container id of every attached (extension-capable) session. */
  private readonly sessionContainers = new Map<Session, string>()
  /** Extensions the user allowed in private windows (`ExtensionInfo.allowPrivate`). */
  private readonly privateAllowed = new Set<string>()
  /**
   * Extensions whose loaded directory carries the content-script storage prelude
   * (`CONTENT_SCRIPT_PRELUDE_FILE`): their contexts install the shim with `storagePrelude`.
   */
  private readonly preluded = new Set<string>()
  /** The MV3 worker wrappers carrying this router's IPC handlers (see `WiredWorkers`). */
  private readonly wiredWorkers = new WiredWorkers((worker, ses) =>
    this.installWorkerIpc(worker, ses)
  )
  private readonly watchedWindows = new WeakSet<BrowserWindow>()
  private snapshot: ModelSnapshot | null = null
  private tickTimer: ReturnType<typeof setTimeout> | null = null
  /** The shortcut table the commands were last resolved against. */
  private shortcutsSeen: unknown = null

  constructor(
    readonly browser: Browser,
    readonly sessions: SessionManager,
    private readonly views: ElectronTabViewHost,
    io: StoreIO,
    userDataDir: string,
    /** Where `declarativeNetRequest` rule sets go: the request-blocking engine. */
    ruleSink: ScopedRuleSink,
    /** The platform's download host, for `downloads.download` and the file-name step. */
    downloadBridge: DownloadBridge
  ) {
    this.model = new ApiModel(browser, views)
    this.store = new ApiStore(io, userDataDir)
    this.registry = new ContextRegistry({
      sessionsFor: (extensionId) => this.extensions.get(extensionId)?.sessions ?? [],
      persistWorkerEvents: (extensionId, events) => this.store.setWorkerEvents(extensionId, events),
      placeFrame: (frame) => this.placeFrame(frame),
      acquireWorker: (versionId, ses) => this.wiredWorkers.acquire(versionId, ses)
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
    this.activeTab = new ActiveTabGrants(this)
    this.webNavigation = new WebNavigationApi(this)
    this.contextMenus = new ContextMenusApi(this, this.activeTab)
    this.sidePanel = new SidePanelApi(this, electronPanelViewHost(this.model))
    this.offscreen = new OffscreenApi(electronOffscreenDocumentHost())
    this.tabCapture = new TabCaptureApi(this, this.activeTab, electronStreamRegistrar())
    this.debugger = new DebuggerApi(this)
    this.commands = new CommandsApi(this, this.action, this.activeTab, this.sidePanel)
    this.notifications = new NotificationsApi(this)
    this.cookies = new CookiesApi(this)
    this.declarativeNetRequest = new DeclarativeNetRequestHostApi(
      this,
      ruleSink,
      this.action,
      this.activeTab,
      join(userDataDir, 'zen', 'extension-dnr')
    )
    this.webRequest = new WebRequestApi(this)
    this.privacy = new PrivacyApi(this)
    this.proxy = new ProxyApi(this, {
      configure: (hook) =>
        this.sessions.configure((ses, containerId) =>
          hook(ses, containerId === PRIVATE_CONTAINER_ID)
        )
    })
    this.contentSettings = new ContentSettingsApi(this)
    this.bookmarks = new BookmarksApi(this)
    this.history = new HistoryApi(this)
    this.downloads = new DownloadsApi(this, downloadBridge)
    this.recentlyClosed = new SessionsApi(this)
    this.topSites = new TopSitesApi(this)
    this.instanceId = new InstanceIdApi(this)
    this.systemDisplay = new SystemDisplayApi(this, electronDisplayScreen())
    this.systemStorage = new SystemStorageApi(this)
    this.systemInfo = new SystemInfoApi(this)
    this.tabGroups = new TabGroupsApi(this)
    this.identity = new IdentityApi(electronAuthWindowHost(this.model))
    this.omnibox = new OmniboxApi(this)
    this.searchProvider = new SearchProviderApi(this)
    this.browsingData = new BrowsingDataApi(this, electronDataClearer)
    this.tts = new TtsApi(this, sharedSpeechEngine())
    this.userScripts = new UserScriptsApi(this, this.webNavigation)
    this.namespaces = {
      tabs: { ...this.tabs.handlers, ...this.tabGroups.tabHandlers },
      windows: this.windows.handlers,
      runtime: this.runtime.handlers,
      action: this.action.handlers,
      storage: this.storage.handlers,
      alarms: this.alarms.handlers,
      permissions: this.permissions.handlers,
      extension: this.extension.handlers,
      management: this.management.handlers,
      webNavigation: this.webNavigation.handlers,
      contextMenus: this.contextMenus.handlers,
      commands: this.commands.handlers,
      notifications: this.notifications.handlers,
      cookies: this.cookies.handlers,
      declarativeNetRequest: this.declarativeNetRequest.handlers,
      webRequest: this.webRequest.handlers,
      privacy: this.privacy.handlers,
      proxy: this.proxy.handlers,
      contentSettings: this.contentSettings.handlers,
      bookmarks: this.bookmarks.handlers,
      history: this.history.handlers,
      downloads: this.downloads.handlers,
      sessions: this.recentlyClosed.handlers,
      topSites: this.topSites.handlers,
      instanceID: this.instanceId.handlers,
      'system.display': this.systemDisplay.handlers,
      'system.storage': this.systemStorage.handlers,
      'system.cpu': this.systemInfo.cpuHandlers,
      'system.memory': this.systemInfo.memoryHandlers,
      tabGroups: this.tabGroups.handlers,
      sidePanel: this.sidePanel.handlers,
      offscreen: this.offscreen.handlers,
      tabCapture: this.tabCapture.handlers,
      desktopCapture: this.tabCapture.desktopHandlers,
      debugger: this.debugger.handlers,
      identity: this.identity.handlers,
      omnibox: this.omnibox.handlers,
      browsingData: this.browsingData.handlers,
      tts: this.tts.handlers,
      userScripts: this.userScripts.handlers
    }
    // A tab's outermost document changed: `activeTab` grants for another origin end and the
    // declarativeNetRequest action counts start over.
    this.webNavigation.onMainFrameCommitted = (tabId, url) => {
      this.activeTab.navigated(tabId, url)
      this.declarativeNetRequest.tabNavigated(tabId)
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
    // An extension document's preload asks for its shim options before the shim installs.
    ipcMain.on(USER_SCRIPTS_CHANNELS.toggles, (event) => {
      event.returnValue = this.shimOptionsFor(frameSender(event))
    })
    // The page preload's side of `chrome.userScripts`, from every frame of every tab page:
    // the plan (synchronous, at document start), the worlds' messaging, and the answers to
    // deliveries and executions. `returnValue` is always set: the page blocks on it.
    ipcMain.on(USER_SCRIPTS_CHANNELS.plan, (event, request) => {
      let plan: unknown = []
      try {
        plan = this.userScripts.plan(event.sender, event.senderFrame, request)
      } catch (error) {
        console.warn('[zen] userScripts plan failed:', error)
      }
      event.returnValue = plan
    })
    ipcMain.handle(USER_SCRIPTS_CHANNELS.message, (event, message) =>
      this.userScripts.worldMessage(event.sender, event.senderFrame, message)
    )
    ipcMain.on(USER_SCRIPTS_CHANNELS.port, (event, wire) =>
      this.userScripts.worldPort(event.sender, event.senderFrame, wire)
    )
    ipcMain.on(USER_SCRIPTS_CHANNELS.answer, (event, answer) =>
      this.userScripts.answer(event.sender, event.senderFrame, answer)
    )
    this.browser.state.subscribe(() => this.scheduleTick())
    // Every tab view, the ones alive already included: `webNavigation.*` comes from their
    // events, the pages follow `privacy.network.webRTCIPHandlingPolicy`, and the user-script
    // worlds' pending answers die with their documents.
    this.views.onViewCreated((view) => {
      this.webNavigation.attach(view)
      this.privacy.pageCreated(view.webContents, this.isPrivateView(view.webContents))
      this.userScripts.pageCreated(view.webContents)
    })
    this.history.attach()
    this.downloads.attach()
    app.on('before-quit', () => this.flushSync())
  }

  /** Whether a tab page belongs to a private window (its tab lives in the private container). */
  private isPrivateView(wc: WebContents): boolean {
    const zenTabId = this.views.tabIdForWebContents(wc)
    const tab = zenTabId ? this.model.tab(zenTabId) : undefined
    return tab?.containerId === PRIVATE_CONTAINER_ID
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
        // A newer install ranks above the older extensions' declarativeNetRequest rules and
        // privacy values.
        this.declarativeNetRequest.installOrderChanged()
        this.privacy.installOrderChanged()
        this.proxy.installOrderChanged()
        this.contentSettings.installOrderChanged()
        return
      case 'enabled':
        this.tellOthers('onEnabled', event.id)
        return
      case 'disabled':
        this.tellOthers('onDisabled', event.id)
        return
      case 'allowPrivate':
        if (event.allowed) this.privateAllowed.add(event.id)
        else this.privateAllowed.delete(event.id)
        this.declarativeNetRequest.sessionsChanged(event.id)
        this.privacy.privateAccessChanged()
        this.proxy.privateAccessChanged()
        return
      case 'allowUserScripts':
        this.userScripts.setAllowed(event.id, event.allowed)
        return
      case 'uninstalled':
        this.seen.delete(event.id)
        this.privateAllowed.delete(event.id)
        this.runtime.openUninstallUrl(event.id)
        this.privacy.forget(event.id)
        this.proxy.forget(event.id)
        this.contentSettings.forget(event.id)
        this.userScripts.uninstalled(event.id)
        this.store.forget(event.id)
        this.declarativeNetRequest.uninstalled(event.id)
        this.registry.forget(event.id, { keepWorkerEvents: false })
        this.broadcast('management', 'onUninstalled', () => [event.id])
        return
    }
  }

  /** A persistent (extension-capable) session: preloads, worker IPC, load / unload tracking. */
  attachSession(ses: Session, containerId: string): void {
    if (this.attachedSessions.has(ses)) return
    this.attachedSessions.add(ses)
    this.sessionContainers.set(ses, containerId)
    this.cookies.attachSession(ses, containerId)
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
    // Every status, not only the starting ones: Electron destroys a version's wrapper inside this
    // very event (a redundant version stopping, the version object gone) and a fresh wrapper for
    // a version that is still live must carry the handlers before the worker's next call.
    ses.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
      if (runningStatus === 'stopped') this.wiredWorkers.release(versionId, ses)
      else this.acquireWorker(versionId, ses)
      this.registry.workerStatus(versionId, ses, runningStatus)
    })
    // A line from a worker whose wrapper was replaced meanwhile (the error console asks the
    // engine for one, which creates it bare) is the moment to wire the replacement.
    ses.serviceWorkers.on('console-message', (_event, { versionId }) => {
      if (isExtensionWorkerRunning(ses, versionId)) this.acquireWorker(versionId, ses)
    })
    // A message from a worker whose wrapper is gone from Electron's map (destroyed, or evicted by
    // the finalizer of an older wrapper of the version) would otherwise fail before any handler
    // of this router could see it: the map is checked and the wrapper recreated, wired, ahead of
    // Electron's dispatch.
    acquireOnIncomingIpc(ses, (versionId) => this.acquireWorker(versionId, ses))
    // Workers already running when the session is attached never announce themselves again.
    for (const versionId of runningExtensionWorkers(ses)) {
      if (this.acquireWorker(versionId, ses)) this.registry.workerStatus(versionId, ses, 'running')
    }
    ses.extensions.on('extension-loaded', (_event, ext) => this.onLoaded(ext, ses))
    ses.extensions.on('extension-unloaded', (_event, ext) => this.onUnloaded(ext, ses))
    for (const ext of ses.extensions.getAllExtensions()) this.onLoaded(ext, ses)
  }

  /**
   * The engine's current wrapper for a worker version, wired, and the registry told about it so
   * a context holding a destroyed wrapper switches over and its queued deliveries go out.
   */
  private acquireWorker(versionId: number, ses: Session): ServiceWorkerMain | undefined {
    const worker = this.wiredWorkers.acquire(versionId, ses)
    if (worker) this.registry.workerAcquired(worker, ses)
    return worker
  }

  /**
   * The IPC of an MV3 worker lives on its `ServiceWorkerMain` wrapper; `WiredWorkers` calls this
   * once per wrapper, from whichever path obtained it (the status event before the worker's
   * script runs, a wake, a console line, a message the worker sent).
   */
  private installWorkerIpc(worker: ServiceWorkerMain, ses: Session): void {
    const sender = (
      event: IpcMainServiceWorkerInvokeEvent | IpcMainServiceWorkerEvent
    ): WorkerSender => {
      const from = workerSender(event, ses)
      // `event.serviceWorker` is the engine's wrapper of the moment (the one this handler is on,
      // normally); wiring it is a no-op then and keeps the version's key current after a release.
      this.wiredWorkers.wire(from.worker, from.session)
      return from
    }
    worker.ipc.handle(CHANNELS.call, (event, namespace, method, args) =>
      this.call(sender(event), namespace, method, args)
    )
    worker.ipc.on(CHANNELS.notify, (event, kind, payload) =>
      this.notify(sender(event), kind, payload)
    )
    worker.ipc.on(USER_SCRIPTS_CHANNELS.toggles, (event) => {
      event.returnValue = this.shimOptionsFor(sender(event))
    })
  }

  /**
   * What the calling extension context installs its shim with: `ShimOptions.toggles`, the
   * content-script storage prelude when its install directory carries one, the withheld
   * permissions and the granted API permissions. Every toggle off, no prelude and no grants
   * for a stranger.
   */
  private shimOptionsFor(sender: Sender | null): HostShimOptions {
    try {
      const { extensionId, extension } = this.contextFor(sender)
      return {
        toggles: this.userScripts.togglesFor(extensionId),
        storagePrelude: this.preluded.has(extensionId) ? CONTENT_SCRIPT_PRELUDE_FILE : null,
        withheld: hasWithheldPermissions(extension.withheld) ? extension.withheld : null,
        granted: [...this.permissions.grants(extensionId).permissions]
      }
    } catch {
      return {
        toggles: { userScripts: false },
        storagePrelude: null,
        withheld: null,
        granted: null
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Extension lifecycle
  // ---------------------------------------------------------------------------

  private onLoaded(ext: Extension, ses: Session): void {
    const existing = this.extensions.get(ext.id)
    if (existing) {
      if (!existing.sessions.includes(ses)) {
        existing.sessions.push(ses)
        this.orderSessions(existing)
        this.declarativeNetRequest.sessionsChanged(ext.id)
      }
      return
    }
    const info = this.infoFor(ext)
    const loaded: LoadedExtension = {
      id: ext.id,
      extension: ext,
      manifest: ext.manifest as ExtensionManifest,
      path: ext.path,
      sessions: [ses],
      unpacked: isUnpacked(info),
      withheld: info?.withheld ?? noWithheldPermissions()
    }
    this.extensions.set(ext.id, loaded)
    if (existsSync(join(ext.path, CONTENT_SCRIPT_PRELUDE_FILE))) this.preluded.add(ext.id)
    else this.preluded.delete(ext.id)
    if (info?.allowPrivate) this.privateAllowed.add(ext.id)
    else this.privateAllowed.delete(ext.id)
    this.registry.restoreWorkerEvents(ext.id, this.store.workerEvents(ext.id))
    this.permissions.load(loaded)
    this.alarms.load(ext.id)
    this.commands.load(loaded)
    this.contextMenus.load(loaded)
    this.sidePanel.load(loaded)
    this.omnibox.load(loaded)
    this.searchProvider.load(loaded)
    // After the permissions: the state exists only for extensions holding the permission.
    this.declarativeNetRequest.load(loaded)
    this.privacy.load(ext.id)
    this.proxy.load(ext.id)
    this.contentSettings.load(ext.id)
    this.systemDisplay.load(loaded)
    this.userScripts.load(loaded, info?.allowUserScripts === true)
    // Existing tabs, bookmarks, downloads and folders are the baseline, not a burst of `onCreated`.
    if (!this.snapshot) {
      this.snapshot = this.model.snapshot()
      this.bookmarks.tick()
      this.downloads.tick()
      this.recentlyClosed.tick()
      this.tabGroups.tick(null, this.snapshot)
    }
    const firstEver = this.store.installedVersion(ext.id) === undefined
    this.runtime.lifecycle(ext.id, ext.version, !this.seen.has(ext.id) && !firstEver)
    this.seen.add(ext.id)
    this.commitUi()
  }

  private onUnloaded(ext: Extension, ses: Session): void {
    const loaded = this.extensions.get(ext.id)
    if (!loaded) return
    loaded.sessions = loaded.sessions.filter((s) => s !== ses)
    if (loaded.sessions.length > 0) {
      this.declarativeNetRequest.sessionsChanged(ext.id)
      return
    }
    this.extensions.delete(ext.id)
    this.preluded.delete(ext.id)
    this.alarms.unload(ext.id)
    this.permissions.unload(ext.id)
    this.commands.unload(ext.id)
    this.sidePanel.unload(ext.id)
    this.offscreen.unload(ext.id)
    this.tabCapture.unload(ext.id)
    this.debugger.unload(ext.id)
    this.systemDisplay.unload()
    this.identity.unload(ext.id)
    this.omnibox.unload(ext.id)
    this.searchProvider.unload(ext.id)
    this.tts.unload(ext.id)
    this.declarativeNetRequest.unload(ext.id)
    this.webRequest.unload(ext.id)
    this.privacy.unload(ext.id)
    this.proxy.unload(ext.id)
    this.contentSettings.unload(ext.id)
    this.userScripts.unload(ext.id)
    this.contextMenus.forget(ext.id)
    this.notifications.forget(ext.id)
    this.activeTab.forget(ext.id)
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

  /** By id first: an unpacked folder is loaded from its shadow, not from the path its record has. */
  private infoFor(ext: Extension): ExtensionInfo | undefined {
    const infos = this.browser.extensions.list()
    return infos.find((info) => info.id === ext.id) ?? infos.find((info) => info.path === ext.path)
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
          ? (STORAGE_METHODS as readonly string[]).includes(method) ||
            (STORAGE_INTERNAL_METHODS as readonly string[]).includes(method)
          : routed === 'webRequest'
            ? (WEB_REQUEST_INTERNAL_METHODS as readonly string[]).includes(method)
            : routed === 'privacy'
              ? (PRIVACY_INTERNAL_METHODS as readonly string[]).includes(method)
              : routed === 'proxy'
                ? (PROXY_INTERNAL_METHODS as readonly string[]).includes(method)
                : routed === 'contentSettings'
                  ? (CONTENT_SETTINGS_INTERNAL_METHODS as readonly string[]).includes(method)
                  : routed === 'userScripts' &&
                      (USER_SCRIPTS_INTERNAL_METHODS as readonly string[]).includes(method)
                    ? true
                    : routed === 'tabCapture' &&
                        (TAB_CAPTURE_INTERNAL_METHODS as readonly string[]).includes(method)
                      ? true
                      : routed === 'desktopCapture' &&
                          (DESKTOP_CAPTURE_INTERNAL_METHODS as readonly string[]).includes(method)
                        ? true
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
      case 'unlisten': {
        // A registration from a worker the registry does not know: its hello went to a wrapper
        // without handlers (the worker started before this router could wire it), so the first
        // message that does arrive stands in for the hello.
        const target =
          context ??
          (ctx.sender.kind === 'worker'
            ? this.registry.helloWorker(ctx.extensionId, ctx.sender.worker, ctx.sender.session)
            : undefined)
        if (target && isRecord(payload) && typeof payload.event === 'string') {
          const listen: ListenPayload = { event: payload.event }
          if (isInteger(payload.filterId)) {
            listen.filterId = payload.filterId
            listen.filters = eventFilters(payload.filters)
          }
          this.registry.listen(target, listen, kind === 'listen')
        }
        return
      }
      case 'storage-changed':
        this.storage.changed(ctx, payload)
        return
      case 'downloads-determined':
        this.downloads.determined(ctx, payload)
        return
      case 'omnibox-suggest':
        this.omnibox.suggested(ctx, payload)
        return
      case 'webRequest-answer':
        this.webRequest.answer(ctx, payload)
        return
      case USER_SCRIPTS_SHIM.answer:
        this.userScripts.answerMessage(ctx, payload)
        return
      case USER_SCRIPTS_SHIM.port:
        this.userScripts.shimPort(ctx, payload)
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
    if (this.sidePanel.hosts(wc)) return 'other'
    if (this.offscreen.hosts(wc)) return 'offscreen'
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
    return (
      this.permissions.canSeeTab(extension.id, url) || this.activeTab.allowsUrl(extension.id, url)
    )
  }

  hostAccess(extensionId: string, url: string): boolean {
    return (
      this.permissions.hasHostAccess(extensionId, url) || this.activeTab.allowsUrl(extensionId, url)
    )
  }

  grants(extensionId: string): PermissionSet {
    return this.permissions.grants(extensionId)
  }

  partitionsOf(extensionId: string): readonly string[] {
    const loaded = this.extensions.get(extensionId)
    if (!loaded) return []
    const partitions: string[] = []
    for (const ses of loaded.sessions) {
      const containerId = this.sessionContainers.get(ses)
      if (containerId !== undefined && !partitions.includes(containerId))
        partitions.push(containerId)
    }
    if (this.privateAllowed.has(extensionId)) partitions.push(PRIVATE_CONTAINER_ID)
    return partitions
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

  confirmPermissions(extensionId: string, warnings: string[], win?: ZenWindow): Promise<boolean> {
    return this.browser.extensions.confirmPermissionRequest(extensionId, warnings, win)
  }

  // ---------------------------------------------------------------------------
  // ExtensionApiHooks (what ExtensionService asks)
  // ---------------------------------------------------------------------------

  actionState(extensionId: string): ExtensionAction | null {
    return this.action.stateFor(extensionId)
  }

  commandsInfo(
    extensionId: string
  ): { commands: ExtensionCommandInfo[]; conflicts: string[] } | null {
    return this.commands.infoFor(extensionId)
  }

  popupForClick(extensionId: string, win: ZenWindow): string | null {
    const { popup, enabled } = this.action.clickState(extensionId, win)
    if (!enabled) return null
    const active = this.browser.tabs.activeTabFor(win)
    if (active) this.activeTab.grant(extensionId, active)
    // `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`: the click toggles the panel.
    if (this.sidePanel.opensOnActionClick(extensionId, win)) {
      this.sidePanel.toggle(extensionId, win)
      return null
    }
    if (popup) return popup
    this.action.clicked(extensionId, win)
    return null
  }

  sidePanelInfo(win: ZenWindow): SidePanelInfo | null {
    return this.sidePanel.info(win)
  }

  toggleSidePanel(extensionId: string, win: ZenWindow): void {
    this.sidePanel.toggle(extensionId, win)
  }

  closeSidePanel(win: ZenWindow): void {
    this.sidePanel.close(win)
  }

  placeSidePanel(win: ZenWindow, rect: Rect | null): void {
    this.sidePanel.place(win, rect)
  }

  omniboxSuggest(input: string, win: ZenWindow): Promise<Suggestion[] | null> {
    return this.omnibox.suggest(input, win)
  }

  omniboxSubmit(input: string, newTab: boolean, background: boolean, win: ZenWindow): boolean {
    return this.omnibox.submit(input, newTab, background, win)
  }

  omniboxCancel(win: ZenWindow): void {
    this.omnibox.cancel(win)
  }

  omniboxDeleteSuggestion(input: string): void {
    this.omnibox.deleteSuggestion(input)
  }

  pageContextMenuItems(tabId: string, params: PageContextParams): MenuItemTemplate[] {
    const tab = this.model.tab(tabId)
    if (!tab) return []
    return this.contextMenus.pageMenuItems(tab, params)
  }

  actionContextMenuItems(extensionId: string, win: ZenWindow): MenuItemTemplate[] {
    return this.contextMenus.actionMenuItems(extensionId, win)
  }

  handleKey(input: KeyEventInput, win: ZenWindow): boolean {
    return this.commands.handleKey(input, win)
  }

  // ---------------------------------------------------------------------------
  // The tick: model snapshots into tabs.* / windows.* events
  // ---------------------------------------------------------------------------

  private tick(): void {
    if (this.extensions.size === 0) {
      this.snapshot = null
      this.bookmarks.reset()
      this.downloads.reset()
      this.recentlyClosed.reset()
      this.tabGroups.reset()
      return
    }
    this.watchWindows()
    this.bookmarks.tick()
    this.downloads.tick()
    this.recentlyClosed.tick()
    const { shortcuts } = this.browser.state
    if (shortcuts !== this.shortcutsSeen) {
      // The user rebound a Zenium shortcut: commands are resolved against the new table.
      const first = this.shortcutsSeen === null
      this.shortcutsSeen = shortcuts
      if (!first) this.commands.refresh()
    }
    const next = this.model.snapshot()
    const prev = this.snapshot
    this.snapshot = next
    this.tabGroups.tick(prev, next)
    if (!prev) return
    for (const [zenId, before] of prev.tabs) {
      if (next.tabs.has(zenId)) continue
      this.action.tabRemoved(before.chrome.id)
      this.activeTab.tabRemoved(before.chrome.id)
      this.tabCapture.tabRemoved(before.chrome.id)
      this.declarativeNetRequest.tabRemoved(before.chrome.id)
      this.sidePanel.tabRemoved(before.chrome.id)
    }
    this.tabs.diff(prev, next)
    this.windows.diff(prev, next)
    // The active tab may have changed: an open panel follows it to the page for that tab.
    this.sidePanel.refresh()
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
): WorkerSender {
  return { kind: 'worker', worker: event.serviceWorker, session: event.session ?? ses }
}

/** Version ids of the session's running workers that belong to extensions. */
function runningExtensionWorkers(ses: Session): number[] {
  const out: number[] = []
  let running: Record<number, { scope: string }>
  try {
    running = ses.serviceWorkers.getAllRunning()
  } catch {
    return out
  }
  for (const [id, info] of Object.entries(running)) {
    const versionId = Number(id)
    if (Number.isInteger(versionId) && info.scope.startsWith('chrome-extension://'))
      out.push(versionId)
  }
  return out
}

/** Whether `versionId` is a running worker of an extension (the engine only knows running ones). */
function isExtensionWorkerRunning(ses: Session, versionId: number): boolean {
  try {
    return ses.serviceWorkers
      .getInfoFromVersionID(versionId)
      .scope.startsWith('chrome-extension://')
  } catch {
    return false
  }
}

function startTask(worker: ServiceWorkerMain): { end(): void } | null {
  try {
    return worker.startTask()
  } catch {
    return null
  }
}

/** The `UrlFilter`s of a filtered listener; a malformed list matches nothing but is not fatal. */
function eventFilters(raw: unknown): UrlFilter[] {
  try {
    return normalizeEventFilters({ url: raw }) ?? []
  } catch {
    return [{ urlEquals: '\u0000' }]
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
