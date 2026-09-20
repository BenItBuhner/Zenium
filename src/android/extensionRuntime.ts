import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID, type ExtensionInfo } from '@shared/types'
import type { Browser } from '@core/browser'
import type { MenuItemTemplate, PageContextParams, StoreIO } from '@core/platform'
import type { ZenWindow } from '@core/window'
import { JsonStore } from '@core/store/JsonStore'
import type { EngineContextKind } from '@core/extensions/api/engine'
import type { EventDelivery } from '@core/extensions/api/shim'
import { localeCandidates, type LocaleMessages } from '@core/extensions/api/i18n'
import {
  matchesAnyUrlFilter,
  normalizeEventFilters,
  type UrlFilter
} from '@core/extensions/api/urlFilter'
import { netErrorName } from '@core/extensions/api/webNavigation'
import {
  WEB_REQUEST_EVENT_NAMES,
  compileRequestFilter,
  normalizeRequestListener,
  requestFilterMatches,
  type CompiledRequestFilter,
  type WebRequestEventName
} from '@core/extensions/api/webRequest'
import { RESOURCE_TYPES, type ResourceType } from '@core/blocking/rules'
import {
  msUntilNext,
  rescheduleAlarm,
  scheduleAlarm,
  splitDue,
  type Alarm
} from '@core/extensions/api/alarms'
import {
  applyClear,
  applyRemove,
  applySet,
  bytesInUse,
  LOCAL_QUOTA_BYTES,
  selectItems,
  SESSION_QUOTA_BYTES,
  SYNC_QUOTA,
  type StorageArea,
  type StorageChanges,
  type StorageItems
} from '@core/extensions/api/storage'
import type { ExtensionRecord } from '@core/extensions/registry'
import {
  BackgroundLifecycle,
  backgroundKindOf,
  type BackgroundStats
} from '@core/extensions/runtime/background'
import {
  buildExtensionBoot,
  type ContentBootConfig,
  type ExtensionBoot,
  type IsolationMode
} from '@core/extensions/runtime/boot'
import { DNR_OWNERSHIP, createDnrSink } from '@core/extensions/dnr/engineSink'
import type { EngineDecisionAction } from '@core/extensions/dnr/sink'
import { parseRuntimeManifest } from '@core/extensions/runtime/manifest'
import { extensionUrl, type RegisteredContentScript } from '@core/extensions/runtime/plan'
import { MessageRouter, type Endpoint } from '@core/extensions/runtime/router'
import { planUnits, sameUnits, type ExtensionUnits } from '@core/extensions/runtime/units'
import {
  ExtensionApi,
  LANGUAGE_SAMPLE_CHARS,
  asDetectedLanguage,
  asRecord,
  asStringArray,
  type ApiHost,
  type AttachedExtension,
  type DetectedLanguage,
  type ExecRequest
} from './extensionApi'
import type { JarReading } from './extensionCookies'
import {
  AndroidDeclarativeNetRequest,
  UNKNOWN_TAB_ID,
  usesDeclarativeNetRequest,
  type DnrHost
} from './extensionDnr'
import { notificationEvent, type ShownNotification } from './extensionNotifications'
import { AndroidWebNavigation, navigationReport, type DerivedEvent } from './extensionWebNavigation'
import {
  AndroidExtensions,
  type AndroidExtensionsOptions,
  type RequestUpdateCheckAnswer
} from './extensionHost'
import { AndroidIdentity, authSheetEvent } from './extensionIdentity'
import type { ExtensionRuntimeHooks } from './extensionRuntimeHooks'
import type { ClientInfo } from './extensionServiceWorker'
import type { AndroidExtensionStoreIo } from './extensionStoreIo'
import type { ViewEventPayloads } from './views'

/**
 * The browser-core half of the Android extension runtime: it runs the extensions the store
 * (`extensionHost.ts`) installed. The store hands over records through `ExtensionRuntimeHooks`;
 * per record this class reads the manifest from `record.path` (through Kotlin), plans the
 * extension's content-script units (`runtime/units.ts`) and tells Kotlin (`ext/Extensions.kt`)
 * what to compile, inject and serve, then owns everything that happens at run time: the
 * endpoints that say hello over the bridge, message and port routing, the `chrome.*` calls the
 * emulated engine forwards (storage and alarms here on the shared `api/` helpers, the rest in
 * `extensionApi.ts`), the background lifecycle (MV3 workers and MV2 event pages as pages that
 * idle out and wake on demand, `runtime/background.ts`), and the tab, navigation and request
 * events extensions listen for.
 *
 * `declarativeNetRequest` takes no Kotlin protocol of its own: the rule states
 * (`extensionDnr.ts`) feed the core's request-blocking engine, whose store persists every set
 * to `blocking/index.json`; the Kotlin engine (`blocking/Blocking.kt`) compiles that file and
 * decides every request of every tab from it, and reports the decisions that named a rule
 * (`ext.request`) back here for `getMatchedRules`, the badges and `onRuleMatchedDebug`.
 *
 * Kotlin protocol (runtime → Kotlin), every call keyed by extension id:
 *  ext.env                                  → { token, uiLanguage, isolatedWorlds, worldSlots, navigationListener }
 *  ext.open { id, path }                    → { manifest, locales: { <locale>: <messages.json> } }
 *  ext.configure { id, version, path, allowFileAccess, allowPrivate, units, served, debug }
 *                                           → { units: [{ key, chars, cached }], ms }
 *  ext.detach { id }
 *  ext.expect { ids }                       the extensions about to be attached (a restored tab's page on one is held, not 404'd)
 *  ext.background.start / stop { id }, ext.popup.open { id, url, context, title }, ext.popup.close,
 *  ext.offscreen.open { id, url } / close { id }   chrome.offscreen's one hidden page per extension
 *  ext.hosts { id, hosts } (optional host permissions granted at runtime)
 *  ext.send { ep, message }, ext.exec {…}, ext.readFile { id, path }, ext.cookies.read / write
 *  ext.i18n.detectLanguage { text }         → { isReliable, languages: [{ language, percentage }] } (the platform's classifier)
 *  ext.observeRequests { on }               every engine decision is reported, not just the rules' matches
 *  ext.auth.open { viewId, id, url, title } / show { viewId } / close { viewId }   identity.launchWebAuthFlow's sheet
 *  ext.notifications.show { id, notification } / hide { id, notificationId } / forget { id } / allowed
 *  view.capture { tabId, mode: 'viewport', format, quality }   tabs.captureVisibleTab
 * Kotlin → runtime (host events): ext.message, ext.gone, ext.popupClosed, ext.request,
 * ext.authView { viewId, event, url? }, ext.notification.
 */

/** The bridge calls the runtime makes (`Bridge` satisfies it; tests pass a fake). */
export interface RuntimeBridge {
  call<T = void>(method: string, args?: unknown): Promise<T>
  send(method: string, args?: unknown): void
}

interface RuntimeEnv {
  token: string
  uiLanguage: string
  /** The WebView can inject into named isolated worlds (Chromium 146+, androidx.webkit 1.17). */
  isolatedWorlds: boolean
  /**
   * How many isolated worlds a tab can host at once: Kotlin registers their bridge listeners
   * when a tab view is built (a listener added to a live view strands the bindings its documents
   * hold), so an extension beyond the budget runs under the emulation proxy instead.
   */
  worldSlots: number
  /** Tab views report navigations through the WebView's navigation listener (`navigation` view events). */
  navigationListener: boolean
}

interface OpenedExtension {
  manifest: string
  locales: Record<string, string>
}

/** What Kotlin reports after compiling and installing one extension's units. */
export interface ConfigureStats {
  units: Array<{ key: string; chars: number; cached: boolean }>
  ms: number
}

export interface ExtMessageEvent {
  ep: string
  tabId: string | null
  top: boolean
  origin: string
  message: Record<string, unknown>
}

/**
 * The engine's decision on one request of a tab, as Kotlin's `DecisionObserver` reports it
 * (`ext.request`): every decision that named a rule, and – while `ext.observeRequests` is on –
 * every decision at all, for the observational `webRequest` events.
 */
export interface ExtRequestEvent {
  tabId: string | null
  requestId: string
  url: string
  /** `chrome.declarativeNetRequest.ResourceType` name. */
  type: string
  method: string
  initiator: string | null
  mainFrame: boolean
  /**
   * The tab's document generation the request belonged to (Kotlin's
   * `BlockingTab.documentGeneration`: a main-frame request opens the next one, its subresources
   * carry it); 0 from a tab that keeps no count.
   */
  document: number
  /** `allow` | `block` | `redirect` | `upgrade`. */
  action: string
  /** The rule set and rule that decided, when one did (`ext:<id>:…` for an extension's). */
  matchedSet: string | null
  matchedRule: number | null
  /** What `EngineSnapshot.decide` took, wall-clock. */
  micros: number
  /** The CPU time the thread spent in it; null where the platform cannot tell. */
  cpuMicros: number | null
}

/** One `webRequest` listener of one endpoint: the event and its compiled `RequestFilter`. */
interface RequestListener {
  event: WebRequestEventName
  filter: CompiledRequestFilter
}

/** The `details` a `webRequest` event carries here (the observational subset of Chrome's). */
interface RequestDetails {
  requestId: string
  url: string
  method: string
  frameId: number
  parentFrameId: number
  tabId: number
  type: ResourceType
  timeStamp: number
  initiator?: string
  error?: string
  fromCache?: boolean
}

/** The single window of the phone, as `tabs`/`windows` number it. */
const WINDOW_ID = 1

const ENGINE_ACTIONS: readonly EngineDecisionAction[] = ['allow', 'block', 'redirect', 'upgrade']

/** Runtime state that outlives the session (`extensions-runtime.json`). */
interface RuntimeData {
  version: 1
  /** id → the version `runtime.onInstalled` last fired for. */
  installed: Record<string, string>
  registered: Record<string, RegisteredContentScript[]>
  /** id → `userScripts.configureWorld({ messaging })`. */
  userScriptMessaging: Record<string, boolean>
  alarms: Record<string, Alarm[]>
  /** id → `chrome.<ns>.<event>` names the background listened for: what wakes a stopped worker. */
  listeners: Record<string, string[]>
}

type StorageDoc = { local: StorageItems; sync: StorageItems }

interface StorageEntry {
  store: JsonStore<StorageDoc>
  doc: StorageDoc
  session: StorageItems
  /**
   * The areas content scripts and user scripts may use, as `storage.<area>.setAccessLevel`
   * leaves them: `local`, `sync` and `managed` open by default, `session` closed (Chrome's
   * defaults; 1Password closes `local` to content scripts at start, the sweep found).
   */
  openToUntrusted: Set<StorageArea>
}

interface Attached extends AttachedExtension {
  /** The last plan Kotlin was given, to skip a configure that would change nothing. */
  units: ExtensionUnits | null
  /** The record toggles Kotlin was given with that plan (`allowFileAccess`, `allowPrivate`). */
  configuredAccess: string | null
  configureStats: ConfigureStats | null
}

function accessKey(record: ExtensionRecord): string {
  return `${record.allowFileAccess === true}/${record.allowPrivate === true}`
}

/**
 * The store, as far as the runtime needs it (`runtime.reload`, `runtime.requestUpdateCheck`,
 * `management.uninstallSelf`, the word that an extension went idle).
 */
export interface RuntimeStoreLink {
  record(id: string): ExtensionRecord | undefined
  records(): readonly ExtensionRecord[]
  reload(id: string): Promise<void>
  remove(id: string): Promise<void>
  requestUpdateCheck(id: string): Promise<RequestUpdateCheckAnswer>
  /**
   * The extension has no page of its own open and its background is stopped (Chrome's
   * `IsExtensionIdle`): the moment a staged update lands (`ExtensionRuntimeHooks.delaysUpdate`).
   */
  idle?(id: string): void
}

export interface AndroidExtensionRuntimeOptions {
  /** Debug bootstraps expose `__zenExtStats` and Kotlin keeps its bridge trace (measurements). */
  debug?: boolean
  /** Quiet time before a worker or event page is torn down; Chrome's is 30 s. */
  idleMs?: number
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

const RUNTIME_STORE = 'extensions-runtime.json'
const STORAGE_AREAS: readonly StorageArea[] = ['local', 'sync', 'session', 'managed']
const NOT_IMPLEMENTED = 'is not implemented on Zenium for Android'
/** How long `offscreen.createDocument` waits for its page's hello (a first load on a cold WebView takes a few seconds). */
const OFFSCREEN_LOAD_MS = 20_000
const CONTEXTS: readonly EngineContextKind[] = [
  'content',
  'userScript',
  'background',
  'popup',
  'options',
  'offscreen',
  'page'
]

/** The extension's own pages are the clients of its service worker; frames in tabs are not. */
const isServiceWorkerClient = (endpoint: Endpoint): boolean =>
  endpoint.context !== 'background' &&
  endpoint.context !== 'content' &&
  endpoint.context !== 'userScript'

function emptyData(): RuntimeData {
  return {
    version: 1,
    installed: {},
    registered: {},
    userScriptMessaging: {},
    alarms: {},
    listeners: {}
  }
}

/**
 * The persisted runtime data; the prototype's `dynamicRules` / `enabledRulesets` tables (W2-1's
 * rule state, superseded by `extension-dnr/<id>.json`) are dropped on read.
 */
function readData(saved: Partial<RuntimeData> | null): RuntimeData {
  const data = emptyData()
  if (!saved || saved.version !== 1) return data
  data.installed = saved.installed ?? {}
  data.registered = saved.registered ?? {}
  data.userScriptMessaging = saved.userScriptMessaging ?? {}
  data.alarms = saved.alarms ?? {}
  data.listeners = saved.listeners ?? {}
  return data
}

/**
 * An extension's `chrome.storage` document (`local` and `sync`), in a folder of its own: folder
 * documents stay out of the boot payload and are read on first use, in pieces – a filter-list
 * extension's storage runs to tens of megabytes (Kotlin's `Storage.EXT_STORAGE_DIR`).
 */
export function storageDocName(id: string): string {
  return `ext-storage/${id}.json`
}

/** The locale messages an extension gets: the UI locale, its language, then the manifest default. */
export function pickMessages(
  locales: Record<string, string>,
  uiLanguage: string,
  defaultLocale: string | null
): LocaleMessages | null {
  for (const candidate of localeCandidates(uiLanguage, defaultLocale)) {
    const text = locales[candidate]
    if (!text) continue
    try {
      return JSON.parse(text) as LocaleMessages
    } catch {
      /* try the next locale */
    }
  }
  return null
}

export class AndroidExtensionRuntime implements ExtensionRuntimeHooks, ApiHost, DnrHost {
  readonly router: MessageRouter
  readonly api: ExtensionApi
  readonly identity: AndroidIdentity
  /** `chrome.declarativeNetRequest`: the rule states over the core's blocking engine. */
  readonly dnr: AndroidDeclarativeNetRequest
  readonly background: BackgroundLifecycle
  /** The store, once it has been constructed around this runtime. */
  store: RuntimeStoreLink | null = null

  private env: RuntimeEnv | null = null
  private envPromise: Promise<RuntimeEnv> | null = null
  private readonly extensions = new Map<string, Attached>()
  private readonly dataStore: JsonStore<RuntimeData>
  private readonly data: RuntimeData
  private readonly storage = new Map<string, StorageEntry>()
  /** Endpoint id → `ns.event` names it listens to (unfiltered listeners). */
  private readonly listening = new Map<string, Set<string>>()
  /** Endpoint id → `ns.event` → filter id → the `UrlFilter`s of one filtered listener (`webNavigation`). */
  private readonly filtered = new Map<string, Map<string, Map<number, UrlFilter[]>>>()
  /**
   * Endpoint id → listener id → one `webRequest.<event>.addListener(fn, filter, spec)`: the
   * shim registers each listener with its `RequestFilter` (`webRequest.addListener`), and a
   * decision is delivered to the listeners whose filter it matches, each addressed by its id.
   */
  private readonly requestListeners = new Map<string, Map<number, RequestListener>>()
  /** The `webNavigation` event family, derived from what the tab views report. */
  private readonly webNavigation = new AndroidWebNavigation(() => this.now())
  /** Extension id → the endpoint of its background's main frame. */
  private readonly backgroundEps = new Map<string, string>()
  /** Extensions whose `runtime.onInstalled` waits for the first background ready: previous version or null. */
  private readonly installEvents = new Map<string, string | null>()
  private readonly startupFired = new Set<string>()
  /** `tabId\u0000docId` → frame id, so every world of one sub-frame reports the same one. */
  private readonly frameIds = new Map<string, number>()
  private nextFrameId = 1
  private readonly alarmTimers = new Map<string, unknown>()
  /**
   * Relayed `MessagePort`s of the emulated service-worker platform (`extensionServiceWorker.ts`):
   * port id → the client page it belongs to; the other end is always the extension's worker.
   */
  private readonly swPorts = new Map<string, { client: string; extensionId: string }>()
  private popupOpen: string | null = null
  /**
   * `offscreen.createDocument` calls waiting for their page to say hello, by extension: the
   * document counts as present from the call on (a second call while it loads is refused, as in
   * Chrome), and the wait ends with the hello, a close, a detach or the load timeout.
   */
  private readonly offscreenOpening = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: unknown }
  >()
  private observing = false
  private subscribed = false
  private activeTabId: string | null = null
  /** The tabs of the last state snapshot and whether each is private (a closed tab is still one). */
  private knownTabs = new Map<string, boolean>()
  /** The container ids of the last snapshot: a change re-scopes every extension's rule sets. */
  private knownContainers = ''
  private readonly debug: boolean
  readonly now: () => number
  private readonly timers: {
    setTimeout: (fn: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  }

  constructor(
    private readonly bridge: RuntimeBridge,
    readonly browser: Browser,
    private readonly windowOf: () => ZenWindow,
    options: AndroidExtensionRuntimeOptions = {}
  ) {
    this.debug = options.debug ?? true
    this.now = options.now ?? (() => Date.now())
    this.timers = {
      setTimeout: options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimeout:
        options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    }
    this.dataStore = new JsonStore<RuntimeData>(browser.platform.io, RUNTIME_STORE, 300)
    this.data = readData(this.dataStore.readSync())
    this.router = new MessageRouter({
      send: (endpointId, message) => this.sendTo(endpointId, message),
      tabFor: (tabId) => {
        const tab = this.browser.tabs.tab(tabId)
        return tab ? this.api.tabs.chromeTab(tab) : null
      },
      tabIdFromChrome: (chromeTabId) => this.api.tabs.coreIdFor(chromeTabId)
    })
    this.identity = new AndroidIdentity(this, this.timers)
    // Extensions' rule sets go straight into the request-blocking engine, each scoped to the
    // containers the extension runs in (never the private one unless the user allowed it there).
    // The engine is read when the first set arrives: this runtime is built by `createExtensions`
    // inside the Browser constructor, before `browser.blocking` exists.
    this.dnr = new AndroidDeclarativeNetRequest(
      this,
      createDnrSink(() => this.browser.blocking.engine, undefined, {
        partitionsOf: (id) => this.partitionsOf(id)
      })
    )
    this.api = new ExtensionApi(this)
    this.background = new BackgroundLifecycle(
      {
        start: (id) => {
          // The page this start replaces (a stop whose gone has not arrived yet) is history: its
          // gone must not be read as the new page's.
          this.backgroundEps.delete(id)
          this.bridge.send('ext.background.start', { id })
        },
        stop: (id) => this.bridge.send('ext.background.stop', { id }),
        setTimeout: (fn, ms) => this.timers.setTimeout(fn, ms),
        clearTimeout: (handle) => this.timers.clearTimeout(handle)
      },
      { idleMs: options.idleMs }
    )
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Reads the environment from Kotlin and drops runtime data of extensions the store no longer
   * has – including their rule sets in the engine, which persist across runs in the blocking
   * store: an extension uninstalled or disabled since (an uninstall this runtime never saw
   * finish) must not filter anything before its state, if any, is loaded again. The engine does
   * that reconciliation itself, told which extensions are enabled (`reconcileOwners`).
   */
  async start(): Promise<void> {
    await this.ensureEnv()
    if (this.store) {
      const records = this.store.records()
      const known = new Set(records.map((r) => r.id))
      let pruned = false
      for (const table of [
        this.data.installed,
        this.data.registered,
        this.data.userScriptMessaging,
        this.data.alarms,
        this.data.listeners
      ] as Record<string, unknown>[]) {
        for (const id of Object.keys(table)) {
          if (known.has(id)) continue
          delete table[id]
          pruned = true
        }
      }
      if (pruned) this.save()
      const enabled = records.filter((r) => r.enabled).map((r) => r.id)
      const removed = this.browser.blocking.reconcileOwners(DNR_OWNERSHIP, enabled)
      if (removed.length > 0)
        console.info(`[zen] declarativeNetRequest: ${removed.length} stale rule set(s) removed`)
    }
  }

  private ensureEnv(): Promise<RuntimeEnv> {
    if (this.env) return Promise.resolve(this.env)
    if (!this.envPromise) {
      this.envPromise = this.bridge.call<RuntimeEnv>('ext.env').then((env) => {
        const isolatedWorlds = env.isolatedWorlds === true
        this.env = {
          token: env.token,
          uiLanguage:
            env.uiLanguage || (typeof navigator === 'undefined' ? 'en' : navigator.language),
          isolatedWorlds,
          worldSlots: isolatedWorlds
            ? typeof env.worldSlots === 'number' && env.worldSlots >= 0
              ? env.worldSlots
              : Number.POSITIVE_INFINITY
            : 0,
          navigationListener: env.navigationListener === true
        }
        return this.env
      })
      this.envPromise.catch(() => {
        this.envPromise = null
      })
    }
    return this.envPromise
  }

  /** Whether content scripts run in real isolated worlds (false before Kotlin answered). */
  get isolatedWorlds(): boolean {
    return this.env?.isolatedWorlds ?? false
  }

  private subscribe(): void {
    if (this.subscribed) return
    this.subscribed = true
    this.knownTabs = this.snapshotTabs()
    this.knownContainers = this.containerKey()
    this.activeTabId = this.browser.tabs.activeTabFor(this.windowOf())?.id ?? null
    this.browser.state.subscribe(() => this.onStateChanged())
  }

  private containerKey(): string {
    return this.browser.state.model.containers
      .map((c) => c.id)
      .sort()
      .join('\u0000')
  }

  // ---------------------------------------------------------------------------
  // ExtensionRuntimeHooks
  // ---------------------------------------------------------------------------

  async attach(record: ExtensionRecord): Promise<void> {
    const env = await this.ensureEnv()
    this.subscribe()
    const opened = await this.bridge.call<OpenedExtension>('ext.open', {
      id: record.id,
      path: record.path
    })
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(opened.manifest) as Record<string, unknown>
    } catch (error) {
      throw new Error(`manifest.json: ${(error as Error).message}`)
    }
    const defaultLocale = typeof raw.default_locale === 'string' ? raw.default_locale : null
    const messages = pickMessages(opened.locales, env.uiLanguage, defaultLocale)
    const manifest = parseRuntimeManifest(raw, messages)
    const previous = this.extensions.get(record.id)
    const ext: Attached = {
      record,
      manifest,
      messages,
      units: previous?.units ?? null,
      configuredAccess: previous?.configuredAccess ?? null,
      configureStats: previous?.configureStats ?? null
    }
    this.extensions.set(record.id, ext)
    this.background.configure(
      record.id,
      backgroundKindOf(manifest),
      this.data.listeners[record.id] ?? []
    )
    await this.configure(ext)
    // After the configure: the state reads its rulesets from the served directory. A re-attach
    // (an update, a reload) starts the rule state over from the new manifest.
    if (previous) this.dnr.unload(record.id)
    this.dnr.load(ext)
    const installedVersion = this.data.installed[record.id]
    if (installedVersion !== manifest.version) {
      this.data.installed[record.id] = manifest.version
      this.save()
      if (manifest.background) this.installEvents.set(record.id, installedVersion ?? null)
    }
    this.armAlarms(record.id)
    // Chrome starts the background at browser start and after an install; workers and event
    // pages idle out again, persistent MV2 pages stay.
    if (manifest.background) this.background.ensureStarted(record.id)
    // A webRequest listener persisted from the last session wants the decisions from the start.
    this.updateObserving()
    this.browser.state.commitVolatile()
  }

  async detach(id: string): Promise<void> {
    const ext = this.extensions.get(id)
    if (!ext) return
    this.extensions.delete(id)
    this.background.remove(id)
    this.backgroundEps.delete(id)
    this.installEvents.delete(id)
    this.api.forget(id)
    this.identity.unload(id)
    this.clearAlarmTimer(id)
    for (const endpoint of this.router.of(id)) {
      this.router.unregister(endpoint.id)
      this.listening.delete(endpoint.id)
      this.filtered.delete(endpoint.id)
      this.requestListeners.delete(endpoint.id)
    }
    for (const [port, owner] of [...this.swPorts])
      if (owner.extensionId === id) this.swPorts.delete(port)
    if (this.popupOpen === id) this.closePopup()
    // Kotlin's detach takes the offscreen page down with the background's.
    this.settleOffscreen(id, new Error('The extension was unloaded.'))
    this.updateObserving()
    // Its rule sets leave the engine with it (the store persists the removal).
    this.dnr.unload(id)
    await this.bridge.call('ext.detach', { id })
    this.browser.state.commitVolatile()
  }

  /**
   * Ahead of the attaches (before the browser restores its windows, so before any restored tab
   * asks for a page): Kotlin holds a tab's document on one of these origins until the
   * extension's configure serves it, and fails one of an extension that is not coming.
   */
  expect(ids: string[]): void {
    this.bridge.send('ext.expect', { ids })
  }

  /**
   * Chrome's `ShouldDelayExtensionUpdate`: an extension with a persistent background page has
   * its update delayed while the page listens for `runtime.onUpdateAvailable` (it will
   * `runtime.reload()` when ready); any other has it delayed while it is not idle. The listener
   * is the running page's, or the one persisted from an earlier run while the page comes back.
   */
  delaysUpdate(id: string): boolean {
    if (!this.extensions.has(id)) return false
    if (this.background.kind(id) === 'persistent') {
      const key = 'runtime.onUpdateAvailable'
      const ep = this.backgroundEps.get(id)
      if (ep !== undefined) return this.listens(ep, key)
      return this.background.persistedListeners(id).includes(key)
    }
    return !this.isIdle(id)
  }

  /** `runtime.onUpdateAvailable` with the staged version's manifest, as Chrome's `details`. */
  updateAvailable(id: string, details: Record<string, unknown>): void {
    if (!this.extensions.has(id)) return
    this.emit(id, 'runtime', 'onUpdateAvailable', [details])
  }

  /**
   * Chrome's `IsExtensionIdle`: no background host (the worker or event page stopped, its
   * endpoint gone) and no frame of the extension's own (a popup, an options or other page, an
   * offscreen document). Content scripts in tabs do not keep an extension busy.
   */
  isIdle(id: string): boolean {
    if (this.background.state(id) !== 'stopped') return false
    for (const endpoint of this.router.of(id))
      if (endpoint.context !== 'content' && endpoint.context !== 'userScript') return false
    return true
  }

  /** An endpoint of `id` went: the store hears when that left the extension idle. */
  private noteIdle(id: string): void {
    if (!this.extensions.has(id) || !this.isIdle(id)) return
    this.store?.idle?.(id)
  }

  async reconfigure(record: ExtensionRecord): Promise<void> {
    const ext = this.extensions.get(record.id)
    if (!ext) return
    ext.record = record
    await this.configure(ext)
    // Its rules apply in private tabs only while it is allowed there. Always re-scoped: the
    // host hands the runtime the record object it mutated in place (`setAllowPrivate`), so a
    // before/after comparison here would see no change; the engine skips an unchanged scope.
    this.dnr.sessionsChanged(record.id)
  }

  /** The extension was uninstalled: its persisted runtime state and `chrome.storage` go too. */
  async forget(id: string): Promise<void> {
    await this.detach(id)
    await this.dnr.uninstalled(id)
    delete this.data.installed[id]
    delete this.data.registered[id]
    delete this.data.userScriptMessaging[id]
    delete this.data.alarms[id]
    delete this.data.listeners[id]
    this.startupFired.delete(id)
    this.save()
    // Settle the debounced document first so no pending write brings it back after the remove.
    this.storage.get(id)?.store.flushSync()
    this.storage.delete(id)
    const io = this.browser.platform.io
    if (io.remove) await io.remove(storageDocName(id)).catch(() => undefined)
    else await io.write(storageDocName(id), '{}').catch(() => undefined)
  }

  /**
   * Plan the extension's units from its manifest, registered scripts and world configuration
   * and hand them to Kotlin; a plan identical to the last one is not sent again (Kotlin keeps
   * its compiled units per extension and version, so every other extension is untouched).
   */
  private async configure(ext: Attached): Promise<void> {
    const env = await this.ensureEnv()
    const id = ext.record.id
    const bootFor = (isolation: IsolationMode): ExtensionBoot =>
      buildExtensionBoot(id, ext.manifest, ext.messages, this.data.registered[id] ?? [], isolation)
    const plan = (isolatedWorlds: boolean): ExtensionUnits =>
      planUnits(bootFor(isolatedWorlds ? 'world' : 'with'), ext.manifest, {
        token: env.token,
        uiLanguage: env.uiLanguage,
        isolatedWorlds,
        userScriptMessaging: this.data.userScriptMessaging[id] === true
      })
    let units = plan(env.isolatedWorlds)
    if (env.isolatedWorlds && !this.worldsFit(id, units, env.worldSlots)) {
      console.warn(
        `[Zenium] extension ${id}: the tab's ${env.worldSlots} isolated worlds are taken; its content scripts run under the emulation proxy`
      )
      units = plan(false)
    }
    const access = accessKey(ext.record)
    if (sameUnits(ext.units, units) && ext.configuredAccess === access) return
    // A late boot: the bootstrap evaluated into a document that predates the extension's world
    // (or on a WebView without worlds), so `scripting.executeScript` has a scope to run in.
    const late: ContentBootConfig = {
      kind: 'content',
      token: env.token,
      uiLanguage: env.uiLanguage,
      world: 'isolated',
      late: true,
      extension: { ...bootFor('with'), groups: [] }
    }
    const stats = await this.bridge.call<ConfigureStats>('ext.configure', {
      id,
      version: ext.manifest.version,
      path: ext.record.path,
      allowFileAccess: ext.record.allowFileAccess === true,
      allowPrivate: ext.record.allowPrivate === true,
      units: units.units.map((unit) => ({
        key: unit.key,
        origins: unit.origins,
        world: unit.worldName,
        config: JSON.stringify(unit.config),
        groups: unit.groups,
        css: unit.css
      })),
      served: { ...units.served, late: JSON.stringify(late) },
      debug: this.debug
    })
    ext.units = units
    ext.configuredAccess = access
    ext.configureStats = stats
  }

  /**
   * Whether the worlds `units` needs fit next to the worlds every other attached extension
   * holds (an extension's own earlier worlds are its to keep: Kotlin maps the same names to the
   * same slots on a reconfigure).
   */
  private worldsFit(id: string, units: ExtensionUnits, budget: number): boolean {
    const held = new Set<string>()
    for (const other of this.extensions.values()) {
      if (other.record.id === id || !other.units) continue
      for (const unit of other.units.units) if (unit.worldName) held.add(unit.worldName)
    }
    const wanted = new Set(units.units.flatMap((unit) => (unit.worldName ? [unit.worldName] : [])))
    return held.size + wanted.size <= budget
  }

  private save(): void {
    this.dataStore.write(this.data)
  }

  flushSync(): void {
    this.dataStore.flushSync()
    for (const entry of this.storage.values()) entry.store.flushSync()
  }

  // ---------------------------------------------------------------------------
  // ApiHost
  // ---------------------------------------------------------------------------

  window(): ZenWindow {
    return this.windowOf()
  }

  attached(id: string): AttachedExtension | undefined {
    return this.extensions.get(id)
  }

  allAttached(): AttachedExtension[] {
    return [...this.extensions.values()]
  }

  registered(id: string): RegisteredContentScript[] {
    return this.data.registered[id] ?? []
  }

  async setRegistered(id: string, scripts: RegisteredContentScript[]): Promise<void> {
    if (scripts.length > 0) this.data.registered[id] = scripts
    else delete this.data.registered[id]
    this.save()
    const ext = this.extensions.get(id)
    if (ext) await this.configure(ext)
  }

  userScriptMessaging(id: string): boolean {
    return this.data.userScriptMessaging[id] === true
  }

  async setUserScriptMessaging(id: string, messaging: boolean): Promise<void> {
    if (messaging) this.data.userScriptMessaging[id] = true
    else delete this.data.userScriptMessaging[id]
    this.save()
    const ext = this.extensions.get(id)
    if (ext) await this.configure(ext)
  }

  // --- DnrHost ---------------------------------------------------------------

  get io(): StoreIO {
    return this.browser.platform.io
  }

  /**
   * The session partitions an extension's rules apply to: every persistent container (the
   * extension's content scripts run in all of them), plus the private one while the user allows
   * the extension there. A private tab's requests never meet an extension's rules otherwise.
   */
  partitionsOf(extensionId: string): readonly string[] {
    const ext = this.extensions.get(extensionId)
    if (!ext) return []
    const partitions = [DEFAULT_CONTAINER_ID]
    for (const container of this.browser.state.model.containers) {
      if (container.id === PRIVATE_CONTAINER_ID || partitions.includes(container.id)) continue
      partitions.push(container.id)
    }
    if (ext.record.allowPrivate === true) partitions.push(PRIVATE_CONTAINER_ID)
    return partitions
  }

  isValidTabId(chromeTabId: number): boolean {
    const tabId = this.api.tabs.coreIdFor(chromeTabId)
    return tabId !== null && this.browser.tabs.tab(tabId) !== undefined
  }

  hasActiveTabAccess(extensionId: string, chromeTabId: number): boolean {
    const tabId = this.api.tabs.coreIdFor(chromeTabId)
    return tabId !== null && this.api.activeTab.has(extensionId, tabId)
  }

  setBadgeText(extensionId: string, chromeTabId: number, text: string): void {
    this.api.setBadgeTextFor(extensionId, chromeTabId, text)
  }

  /** Extensions using the API, most recently installed first (Chrome ranks newer ones' rules higher). */
  installOrder(): string[] {
    return [...this.extensions.values()]
      .filter((ext) => usesDeclarativeNetRequest(ext))
      .sort((a, b) => b.record.installedAt - a.record.installedAt)
      .map((ext) => ext.record.id)
  }

  warn(message: string): void {
    console.warn(`[zen] ${message}`)
  }

  /**
   * Raise `chrome.<ns>.<name>` in every endpoint of one extension that registered a listener.
   * Pages, popups and content scripts get it now; the background gets it now when it runs, held
   * while it starts, and is woken for it when it is stopped but persisted a listener.
   */
  emit(
    extensionId: string,
    ns: string,
    name: string,
    args: unknown[],
    only: (endpoint: Endpoint) => boolean = () => true,
    url?: string
  ): void {
    const key = `${ns}.${name}`
    const sendTo = (filter: (endpoint: Endpoint) => boolean): void => {
      for (const endpoint of this.router.of(extensionId)) {
        if (!filter(endpoint) || !only(endpoint)) continue
        const delivery = this.deliveryFor(endpoint.id, key, url)
        if (delivery === null) continue
        this.sendTo(
          endpoint.id,
          delivery ? { t: 'event', ns, name, args, delivery } : { t: 'event', ns, name, args }
        )
      }
    }
    sendTo((endpoint) => endpoint.context !== 'background')
    if (this.background.has(extensionId))
      this.background.deliver(extensionId, key, () =>
        sendTo((endpoint) => endpoint.context === 'background')
      )
  }

  /**
   * What an endpoint should get of `key` for an event about `url`: `undefined` for every listener
   * (an unfiltered event, or the endpoint has no filtered listener), `{ unfiltered, matched }`
   * naming the filtered listeners whose `UrlFilter`s match, null when nothing there wants it.
   */
  private deliveryFor(
    endpointId: string,
    key: string,
    url: string | undefined
  ): EventDelivery | null | undefined {
    const unfiltered = this.listening.get(endpointId)?.has(key) === true
    const filters = this.filtered.get(endpointId)?.get(key)
    if (!filters || filters.size === 0 || url === undefined) return unfiltered ? undefined : null
    const matched: number[] = []
    for (const [id, list] of filters) if (matchesAnyUrlFilter(url, list)) matched.push(id)
    if (!unfiltered && matched.length === 0) return null
    return { unfiltered, matched }
  }

  /** Whether the endpoint registered any listener (filtered or not) for `key`. */
  private listens(endpointId: string, key: string): boolean {
    return (
      this.listening.get(endpointId)?.has(key) === true ||
      (this.filtered.get(endpointId)?.get(key)?.size ?? 0) > 0 ||
      this.requestListenersOf(endpointId, key).length > 0
    )
  }

  /** The endpoint's `webRequest` listeners for `key` (`webRequest.<event>`), with their ids. */
  private requestListenersOf(endpointId: string, key: string): Array<[number, RequestListener]> {
    const own = this.requestListeners.get(endpointId)
    if (!own) return []
    return [...own].filter(([, listener]) => `webRequest.${listener.event}` === key)
  }

  /**
   * One event to one endpoint whether it listens or not: the context that created a
   * `contextMenus` item with `onclick` runs the handler off `onClicked` without ever adding a
   * listener. Skipped when the endpoint listens (it got the event from `emit`).
   */
  emitTo(endpointId: string, ns: string, name: string, args: unknown[]): void {
    if (!this.router.endpoint(endpointId)) return
    if (this.listens(endpointId, `${ns}.${name}`)) return
    this.sendTo(endpointId, { t: 'event', ns, name, args })
  }

  icon(id: string): string | null {
    return this.browser.extensions.list().find((info) => info.id === id)?.icon ?? null
  }

  /**
   * An event about one tab: to the extensions that may see the tab. Chrome keeps an incognito
   * tab from an extension the user did not allow in incognito: no `tabs.*` or `webNavigation`
   * event about it, no `webRequest` details of its requests. A tab the model no longer has (an
   * `onRemoved`) is judged by what it was in the last snapshot.
   */
  private emitForTab(
    tabId: string | null,
    ns: string,
    name: string,
    args: unknown[],
    url?: string
  ): void {
    for (const [id, ext] of this.extensions) {
      if (tabId === null || this.sees(ext, tabId)) this.emit(id, ns, name, args, undefined, url)
    }
  }

  private sees(ext: Attached, tabId: string): boolean {
    if (ext.record.allowPrivate === true) return true
    const tab = this.browser.tabs.tab(tabId)
    const isPrivate = tab ? this.browser.tabs.isPrivate(tab) : this.knownTabs.get(tabId) === true
    return !isPrivate
  }

  private snapshotTabs(): Map<string, boolean> {
    const tabs = this.browser.tabs
    return new Map(Object.values(tabs.model.tabs).map((tab) => [tab.id, tabs.isPrivate(tab)]))
  }

  readFile(id: string, path: string): Promise<string | null> {
    if (!path) return Promise.resolve(null)
    return this.bridge.call<string | null>('ext.readFile', { id, path })
  }

  async detectTextLanguage(text: string): Promise<DetectedLanguage> {
    // A blank text is nobody's language; the host's classifier reads the leading part of a long one.
    const sample = text.trim().slice(0, LANGUAGE_SAMPLE_CHARS)
    if (!sample) return { isReliable: false, languages: [] }
    return asDetectedLanguage(
      await this.bridge.call<unknown>('ext.i18n.detectLanguage', { text: sample })
    )
  }

  exec(request: ExecRequest): Promise<unknown> {
    // A subframe is named to the host by its document id (the first segment of every endpoint
    // id of that document), which the frame's own bridge endpoint carries; the main frame needs none.
    let doc: string | null = null
    if (request.frameId !== 0) {
      const endpoint = this.router
        .of(request.extensionId, 'content')
        .find((e) => e.tabId === request.tabId && e.frameId === request.frameId)
      if (!endpoint)
        return Promise.reject(
          new Error(
            `No frame with id ${request.frameId} in tab ${this.api.tabs.chromeIdFor(request.tabId)}.`
          )
        )
      doc = endpoint.id.split('.')[0] ?? null
    }
    return this.bridge.call<unknown>('ext.exec', {
      tabId: request.tabId,
      ext: request.extensionId,
      doc,
      kind: request.kind,
      payload: request.payload,
      code: request.code,
      files: request.files,
      funcSource: request.funcSource,
      args: request.args
    })
  }

  async readCookies(containerId: string, url: string): Promise<JarReading> {
    const reading = await this.bridge.call<{ cookies?: unknown; detailed?: unknown } | null>(
      'ext.cookies.read',
      { container: containerId, url }
    )
    return {
      cookies: Array.isArray(reading?.cookies)
        ? reading.cookies.filter((c): c is string => typeof c === 'string')
        : [],
      detailed: reading?.detailed === true
    }
  }

  async writeCookie(containerId: string, url: string, setCookie: string): Promise<boolean> {
    const ok = await this.bridge.call<unknown>('ext.cookies.write', {
      container: containerId,
      url,
      cookie: setCookie
    })
    return ok === true
  }

  /** `identity.launchWebAuthFlow`'s sheet: opened hidden, titled after the extension until a page names its host. */
  openAuthSheet(viewId: number, extensionId: string, url: string): void {
    const ext = this.extensions.get(extensionId)
    this.bridge.send('ext.auth.open', {
      viewId,
      id: extensionId,
      url,
      title: ext?.manifest.name || extensionId
    })
  }

  showAuthSheet(viewId: number): void {
    this.bridge.send('ext.auth.show', { viewId })
  }

  closeAuthSheet(viewId: number): void {
    this.bridge.send('ext.auth.close', { viewId })
  }

  hostsGranted(id: string, hosts: string[]): void {
    this.bridge.send('ext.hosts', { id, hosts })
  }

  showNotification(extensionId: string, notification: ShownNotification): void {
    this.bridge.send('ext.notifications.show', { id: extensionId, notification })
  }

  hideNotification(extensionId: string, notificationId: string): void {
    this.bridge.send('ext.notifications.hide', { id: extensionId, notificationId })
  }

  forgetNotifications(extensionId: string): void {
    this.bridge.send('ext.notifications.forget', { id: extensionId })
  }

  async notificationsAllowed(): Promise<boolean> {
    return (await this.bridge.call<unknown>('ext.notifications.allowed')) === true
  }

  /** Kotlin: a tap, a button or a swipe on an extension's notification (`ext.notification`). */
  onNotification(payload: unknown): void {
    const event = notificationEvent(payload)
    if (event) this.api.notifications.onEvent(event)
  }

  /**
   * The tab view's on-screen pixels through the same `view.capture` the agent's screenshots
   * use (a PixelCopy of the activity window, so a sheet over the page, its own window, is not in
   * it), at Chrome's default JPEG quality unless the extension asked for another.
   */
  async captureTab(tabId: string, format: 'jpeg' | 'png', quality: number): Promise<string | null> {
    const shot = await this.bridge.call<{ data?: unknown; mimeType?: unknown } | null>(
      'view.capture',
      { tabId, mode: 'viewport', region: null, format, quality }
    )
    if (!shot || typeof shot.data !== 'string' || shot.data.length === 0) return null
    const mimeType = typeof shot.mimeType === 'string' ? shot.mimeType : `image/${format}`
    return `data:${mimeType};base64,${shot.data}`
  }

  openPopup(id: string): void {
    const ext = this.extensions.get(id)
    if (!ext) return
    // A toolbar click is the user gesture `activeTab` waits for. A private tab the extension may
    // not see is no tab (Chrome hides the action there).
    const tab = this.api.tabs.activeTabFor(ext)
    if (tab) this.api.activeTab.grant(id, tab)
    // The tab's own popup when `action.setPopup` named one for it, else the global one.
    const action = this.api.actionStateFor(id, tab ? this.api.tabs.chromeIdFor(tab.id) : undefined)
    if (!action.enabled) return
    if (!action.popup) {
      const ns = ext.manifest.manifestVersion === 3 ? 'action' : 'browserAction'
      this.emit(id, ns, 'onClicked', [tab ? this.api.tabs.chromeTab(tab) : null])
      return
    }
    this.popupOpen = id
    this.bridge.send('ext.popup.open', {
      id,
      url: extensionUrl(id, action.popup),
      context: 'popup',
      title: ext.manifest.name || id
    })
  }

  openOptions(id: string, win: ZenWindow = this.windowOf()): void {
    const ext = this.extensions.get(id)
    const options = ext?.manifest.options
    if (!ext || !options) return
    const url = extensionUrl(id, options.page)
    if (options.openInTab) {
      this.browser.tabs.createTab({ url, active: true }, win)
      return
    }
    this.popupOpen = id
    this.bridge.send('ext.popup.open', {
      id,
      url,
      context: 'options',
      title: ext.manifest.name || id
    })
  }

  closePopup(): void {
    if (!this.popupOpen) return
    this.popupOpen = null
    this.bridge.send('ext.popup.close')
  }

  /**
   * `offscreen.createDocument`: Kotlin puts up a hidden `ExtensionWebView` on the URL (the same
   * kind of view as the background page's); the promise settles when its bootstrap says hello
   * as an `offscreen` endpoint, or when [OFFSCREEN_LOAD_MS] pass without one.
   */
  openOffscreen(id: string, url: string): Promise<void> {
    this.settleOffscreen(id, new Error('The offscreen document was replaced.'))
    return new Promise<void>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        if (this.offscreenOpening.get(id)?.timer !== timer) return
        this.offscreenOpening.delete(id)
        this.bridge.send('ext.offscreen.close', { id })
        reject(new Error(`The offscreen document ${url} did not load.`))
      }, OFFSCREEN_LOAD_MS)
      this.offscreenOpening.set(id, { resolve, reject, timer })
      this.bridge.send('ext.offscreen.open', { id, url })
    })
  }

  closeOffscreen(id: string): void {
    this.settleOffscreen(id, new Error('The offscreen document was closed.'))
    this.bridge.send('ext.offscreen.close', { id })
  }

  hasOffscreen(id: string): boolean {
    return this.offscreenOpening.has(id) || this.router.of(id, 'offscreen').length > 0
  }

  /** The pending `createDocument` of an extension, if any, resolved (its page is up) or rejected. */
  private settleOffscreen(id: string, error: Error | null): void {
    const waiting = this.offscreenOpening.get(id)
    if (!waiting) return
    this.offscreenOpening.delete(id)
    this.timers.clearTimeout(waiting.timer)
    if (error) waiting.reject(error)
    else waiting.resolve()
  }

  /** The popup path `action.setPopup` left (null when clicks fire `onClicked`); undefined when not attached. */
  popupFor(id: string): string | null | undefined {
    if (!this.extensions.has(id)) return undefined
    return this.api.actionFor(id).popup || null
  }

  async reload(id: string): Promise<void> {
    if (this.store) await this.store.reload(id)
  }

  /** Without a store there is no updater, and an updater with nothing to install says `no_update`. */
  requestUpdateCheck(id: string): Promise<RequestUpdateCheckAnswer> {
    return this.store ? this.store.requestUpdateCheck(id) : Promise.resolve({ status: 'no_update' })
  }

  async uninstall(id: string): Promise<void> {
    if (this.store) await this.store.remove(id)
  }

  isEnabled(id: string): boolean {
    return this.store?.record(id)?.enabled ?? this.extensions.has(id)
  }

  backgroundStats(id: string): BackgroundStats | null {
    return this.background.stats(id)
  }

  configureStats(id: string): ConfigureStats | null {
    return this.extensions.get(id)?.configureStats ?? null
  }

  // ---------------------------------------------------------------------------
  // Kotlin → runtime
  // ---------------------------------------------------------------------------

  /**
   * One engine message to one endpoint (a frame's or an extension page's reply proxy in Kotlin).
   * Frames host several endpoints (one per extension and world) on one transport, so the
   * message carries the endpoint id; the bootstrap routes on it.
   */
  private sendTo(endpointId: string, message: Record<string, unknown>): void {
    this.bridge.send('ext.send', {
      ep: endpointId,
      message: JSON.stringify({ ...message, ep: endpointId })
    })
  }

  /** A bridge message from a content-script frame or an extension page. */
  onMessage(event: ExtMessageEvent): void {
    const { message, ep } = event
    const type = String(message.t)
    if (type === 'hello') {
      this.onHello(event)
      return
    }
    const endpoint = this.router.endpoint(ep)
    if (!endpoint) return
    const id = endpoint.extensionId
    if (endpoint.context === 'background') this.background.activity(id)
    switch (type) {
      case 'call': {
        const callId = Number(message.id)
        const ns = String(message.ns)
        const method = String(message.method)
        const args = Array.isArray(message.args) ? (message.args as unknown[]) : []
        this.call(endpoint, ns, method, args).then(
          (result) => this.sendTo(ep, { t: 'reply', id: callId, ok: true, result: result ?? null }),
          (error: unknown) =>
            this.sendTo(ep, {
              t: 'reply',
              id: callId,
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            })
        )
        return
      }
      case 'listen': {
        const key = String(message.event)
        if (typeof message.filterId === 'number') {
          // One filtered listener (`addListener(fn, { url: [...] })`): kept by its id.
          let byEvent = this.filtered.get(ep)
          if (!byEvent) {
            byEvent = new Map()
            this.filtered.set(ep, byEvent)
          }
          let byId = byEvent.get(key)
          if (!byId) {
            byId = new Map()
            byEvent.set(key, byId)
          }
          if (message.on) byId.set(message.filterId, eventFilters(message.filters))
          else byId.delete(message.filterId)
          if (byId.size === 0) byEvent.delete(key)
        } else {
          let set = this.listening.get(ep)
          if (!set) {
            set = new Set()
            this.listening.set(ep, set)
          }
          if (message.on) set.add(key)
          else set.delete(key)
        }
        if (endpoint.context === 'background') {
          this.background.listen(id, key, this.listens(ep, key))
          this.data.listeners[id] = this.background.persistedListeners(id)
          this.save()
        }
        this.updateObserving()
        return
      }
      case 'ready':
        if (endpoint.context === 'background' && this.backgroundEps.get(id) === ep) {
          this.background.onReady(id)
          this.onBackgroundReady(id)
        }
        return
      case 'msg':
      case 'connect': {
        // `runtime.sendMessage` / `connect` to the extension's pages start a stopped worker, as
        // in Chrome; the message waits until it is ready. Tab-directed and cross-extension
        // messages, and the background's own, go straight to the router.
        const target = asRecord(message.target)
        const toPages =
          (target.tabId === undefined || target.tabId === null) &&
          (!target.extensionId || target.extensionId === id)
        if (
          toPages &&
          endpoint.context !== 'background' &&
          this.background.has(id) &&
          this.background.state(id) !== 'running'
        ) {
          this.background.deliver(id, null, () => {
            if (this.router.endpoint(ep)) this.router.handle(ep, message)
          })
          return
        }
        this.router.handle(ep, message)
        return
      }
      case 'sw':
        this.onServiceWorkerMessage(endpoint, message)
        return
      default:
        this.router.handle(ep, message)
    }
  }

  /**
   * The emulated service-worker platform (`extensionServiceWorker.ts`): a page's
   * `navigator.serviceWorker.active.postMessage` (`post`) goes to the extension's worker and
   * starts it when it is stopped, as in Chrome; the worker's `client.postMessage` (`post` with
   * `to`) goes to that page; relayed port traffic (`port`, `close`) follows the port to the client
   * it was created for, or to the worker. `clients` lists the extension's pages for
   * `clients.matchAll`. A stopped worker is not started for a port: its end of the port died with
   * it, as it does in Chrome.
   */
  private onServiceWorkerMessage(endpoint: Endpoint, message: Record<string, unknown>): void {
    const id = endpoint.extensionId
    const op = String(message.op)
    const ports = Array.isArray(message.ports) ? message.ports.map(String) : []
    const portId = String(message.port ?? '')
    if (endpoint.context === 'background') {
      if (op === 'clients') {
        this.sendTo(endpoint.id, {
          t: 'sw',
          op: 'clients',
          id: message.id,
          clients: this.serviceWorkerClients(id)
        })
        return
      }
      const to = op === 'post' ? String(message.to ?? '') : this.swPorts.get(portId)?.client
      const client = to ? this.router.endpoint(to) : undefined
      if (!client || client.extensionId !== id || !isServiceWorkerClient(client)) return
      for (const port of ports) this.swPorts.set(port, { client: client.id, extensionId: id })
      if (op === 'close') this.swPorts.delete(portId)
      this.sendTo(
        client.id,
        op === 'post'
          ? { t: 'sw', op: 'message', data: message.data, ports }
          : { t: 'sw', op, port: portId, data: message.data, ports }
      )
      return
    }
    if (op === 'clients' || !isServiceWorkerClient(endpoint) || !this.background.has(id)) return
    for (const port of ports) this.swPorts.set(port, { client: endpoint.id, extensionId: id })
    if (op === 'close') this.swPorts.delete(portId)
    if (op !== 'post' && this.background.state(id) === 'stopped') return
    const payload =
      op === 'post'
        ? {
            t: 'sw',
            op: 'message',
            from: endpoint.id,
            url: endpoint.url,
            context: endpoint.context,
            focused: endpoint.context === 'popup' || endpoint.tabId === this.activeTabId,
            visible: endpoint.context === 'popup' || endpoint.tabId === this.activeTabId,
            data: message.data,
            ports
          }
        : { t: 'sw', op, port: portId, data: message.data, ports }
    this.background.deliver(id, null, () => {
      const worker = this.backgroundEps.get(id)
      if (worker) this.sendTo(worker, payload)
    })
  }

  /** The extension's pages as `WindowClient`s: popups, options and offscreen pages, its tabs. */
  private serviceWorkerClients(id: string): ClientInfo[] {
    return this.router
      .of(id)
      .filter(isServiceWorkerClient)
      .map((endpoint) => {
        const shown = endpoint.context === 'popup' || endpoint.tabId === this.activeTabId
        return {
          id: endpoint.id,
          url: endpoint.url,
          context: endpoint.context,
          focused: shown,
          visible: shown
        }
      })
  }

  /** An endpoint went away: the ports relayed to it are closed on the other side. */
  private closeServiceWorkerPorts(endpoint: Endpoint): void {
    const id = endpoint.extensionId
    const isWorker = endpoint.context === 'background'
    for (const [port, owner] of [...this.swPorts]) {
      if (owner.extensionId !== id) continue
      if (isWorker) {
        this.swPorts.delete(port)
        if (this.router.endpoint(owner.client))
          this.sendTo(owner.client, { t: 'sw', op: 'close', port })
      } else if (owner.client === endpoint.id) {
        this.swPorts.delete(port)
        const worker = this.backgroundEps.get(id)
        if (worker && this.background.state(id) === 'running')
          this.sendTo(worker, { t: 'sw', op: 'close', port })
      }
    }
  }

  private onHello(event: ExtMessageEvent): void {
    const { message, ep } = event
    const extensionId = String(message.ext ?? '')
    if (!this.extensions.has(extensionId)) return
    const ctx = String(message.ctx ?? 'content')
    const context: EngineContextKind = (CONTEXTS as readonly string[]).includes(ctx)
      ? (ctx as EngineContextKind)
      : 'content'
    // A subframe hosted in a tab is numbered per document, a content frame and an extension
    // page's own iframe alike (Chrome's `frameId`); the main frame is 0, and so is every
    // document outside a tab (popups, the background, offscreen pages).
    let frameId = 0
    if (event.tabId !== null && !event.top) {
      const key = `${event.tabId}\u0000${ep.split('.')[0]}`
      let known = this.frameIds.get(key)
      if (known === undefined) {
        known = this.nextFrameId++
        this.frameIds.set(key, known)
        if (this.frameIds.size > 4000) this.frameIds.clear()
      }
      frameId = known
    }
    this.router.register({
      id: ep,
      extensionId,
      context,
      // Extension pages opened as tabs report their tab like content frames do (Chrome sets
      // `sender.tab` for them); popups and background pages have none.
      tabId: event.tabId,
      frameId,
      url: String(message.url ?? event.origin)
    })
    if (context === 'background' && event.top) {
      const previous = this.backgroundEps.get(extensionId)
      if (previous && previous !== ep) {
        // The page reloaded itself (or Kotlin replaced it) before the old endpoint reported gone.
        this.router.unregister(previous)
        this.listening.delete(previous)
        this.filtered.delete(previous)
        this.requestListeners.delete(previous)
      }
      this.backgroundEps.set(extensionId, ep)
    }
    if (context === 'offscreen' && event.top) this.settleOffscreen(extensionId, null)
  }

  onGone(eps: string[]): void {
    const owners = new Set<string>()
    for (const ep of eps) {
      const endpoint = this.router.endpoint(ep)
      this.router.unregister(ep)
      this.listening.delete(ep)
      this.filtered.delete(ep)
      this.requestListeners.delete(ep)
      this.api.endpointGone(ep)
      if (endpoint) this.closeServiceWorkerPorts(endpoint)
      if (
        endpoint?.context === 'background' &&
        this.backgroundEps.get(endpoint.extensionId) === ep
      ) {
        this.backgroundEps.delete(endpoint.extensionId)
        this.background.onGone(endpoint.extensionId)
      }
      if (endpoint && endpoint.context !== 'content' && endpoint.context !== 'userScript')
        owners.add(endpoint.extensionId)
    }
    this.updateObserving()
    // The last page or the background of an extension went: a staged update may land now.
    for (const id of owners) this.noteIdle(id)
  }

  onPopupClosed(): void {
    this.popupOpen = null
  }

  /** An auth sheet's navigation (the way back ends the flow), load, failure or dismissal. */
  onAuthView(raw: unknown): void {
    const event = authSheetEvent(raw)
    if (event) this.identity.onSheetEvent(event)
  }

  /**
   * A decision of the Kotlin engine (`ext.request`): one an extension's rule took goes into that
   * extension's matched-rule log, action count and `onRuleMatchedDebug`; while an extension
   * listens for `webRequest`, every decision is reported and becomes the observational events
   * (`onBeforeRequest`, `onErrorOccurred` for a blocked request).
   */
  onRequest(event: ExtRequestEvent): void {
    const tabId = event.tabId ? this.api.tabs.chromeIdFor(event.tabId) : UNKNOWN_TAB_ID
    // The decision may be the first word of a new document (its `navigated` is posted at commit
    // and often lands after the page's first decisions): the tab's record turns over first.
    if (event.document > 0) this.dnr.document(tabId, event.document)
    const action = ENGINE_ACTIONS.find((a) => a === event.action)
    if (action && event.matchedSet && typeof event.matchedRule === 'number') {
      this.dnr.decided({
        tabId,
        requestId: event.requestId,
        url: event.url,
        method: event.method,
        type: event.type,
        initiator: event.initiator ?? undefined,
        mainFrame: event.mainFrame,
        action,
        matchedSet: event.matchedSet,
        matchedRule: event.matchedRule
      })
    }
    if (!this.observing) return
    const details: RequestDetails = {
      requestId: event.requestId,
      url: event.url,
      method: event.method,
      frameId: 0,
      parentFrameId: -1,
      tabId,
      type: (RESOURCE_TYPES as readonly string[]).includes(event.type)
        ? (event.type as ResourceType)
        : 'other',
      timeStamp: this.now()
    }
    if (event.initiator) details.initiator = event.initiator
    const tab = event.tabId ?? null
    this.emitRequest(tab, 'onBeforeRequest', details)
    if (event.action === 'block')
      this.emitRequest(tab, 'onErrorOccurred', {
        ...details,
        error: 'net::ERR_BLOCKED_BY_CLIENT',
        fromCache: false
      })
  }

  /**
   * One `webRequest` event to every listener whose `RequestFilter` the request matches, each
   * delivery addressed to the one listener (`delivery.matched`), as the desktop's host does.
   * Pages, popups and content scripts get it now; the background gets it when it runs, has it
   * held while it starts (its listeners register as its script runs, ahead of `ready`), and is
   * woken for it when it is stopped and persisted a listener for the event.
   */
  private emitRequest(
    tabId: string | null,
    event: WebRequestEventName,
    details: RequestDetails
  ): void {
    const key = `webRequest.${event}`
    const probe = {
      url: details.url,
      type: details.type,
      tabId: details.tabId,
      windowId: WINDOW_ID
    }
    const matching = (endpointId: string): number[] =>
      this.requestListenersOf(endpointId, key)
        .filter(([, listener]) => requestFilterMatches(listener.filter, probe))
        .map(([id]) => id)
    const send = (endpointId: string): void => {
      for (const listenerId of matching(endpointId))
        this.sendTo(endpointId, {
          t: 'event',
          ns: 'webRequest',
          name: event,
          args: [details],
          delivery: { unfiltered: false, matched: [listenerId] }
        })
    }
    for (const [id, ext] of this.extensions) {
      if (tabId !== null && !this.sees(ext, tabId)) continue
      for (const endpoint of this.router.of(id)) {
        if (endpoint.context !== 'background') send(endpoint.id)
      }
      if (!this.background.has(id)) continue
      const ep = this.backgroundEps.get(id) ?? null
      const state = this.background.state(id)
      const matched = ep !== null && matching(ep).length > 0
      const persisted = this.background.persistedListeners(id).includes(key)
      // A running background is written to for a match alone (a delivery counts as its
      // activity); a stopped one is woken for a listener it persisted; a starting one, not yet
      // through its script, waits for `ready` when it persisted the listener or registered a
      // matching one already.
      const wanted =
        state === 'running' ? matched : state === 'stopped' ? persisted : persisted || matched
      if (!wanted) continue
      this.background.deliver(id, key, () => {
        const current = this.backgroundEps.get(id)
        if (current) send(current)
      })
    }
  }

  /** Tab view events, forwarded by the platform: `tabs.onUpdated` and `webNavigation`. */
  onViewEvent<K extends keyof ViewEventPayloads>(
    tabId: string,
    name: K,
    payload: ViewEventPayloads[K]
  ): void {
    if (this.extensions.size === 0) return
    const tab = this.browser.tabs.tab(tabId)
    const chromeTabId = this.api.tabs.chromeIdFor(tabId)
    const facts = { chromeTabId, committedUrl: tab?.url ?? '' }
    // With the WebView's navigation listener the `navigation` reports carry the family; without
    // it, the client callbacks (commit, finish, failure) are what there is to infer from.
    const derived = this.env?.navigationListener === true
    const updated = (change: Record<string, unknown>): void => {
      if (tab)
        this.emitForTab(tabId, 'tabs', 'onUpdated', [
          chromeTabId,
          change,
          this.api.tabs.chromeTab(tab)
        ])
    }
    switch (name) {
      case 'navigation': {
        if (!derived) return
        const report = navigationReport(payload)
        if (report) this.webNavigationEvents(tabId, this.webNavigation.report(tabId, facts, report))
        return
      }
      case 'navigated': {
        const p = payload as ViewEventPayloads['navigated']
        if (!derived) {
          this.webNavigationEvents(
            tabId,
            this.webNavigation.inferredCommit(tabId, facts, p.url, p.inPage)
          )
        }
        // The previous document's endpoints are not dropped here: this event is posted from
        // Kotlin at commit and lands after the new document's bootstraps have said hello often
        // enough (measured on the emulator) that dropping the tab's endpoints now would take the
        // new document's with them, and every call they make afterwards would go unanswered.
        // Kotlin owns endpoint liveness and reports the old document through `ext.gone` (the
        // first hello of a new document, onPageStarted for a document without units, a dead
        // reply proxy).
        if (!p.inPage) {
          this.api.activeTab.navigated(tabId, p.url)
          // A new document: the tab's matched rules belong to no tab now, its action count
          // restarts – unless the document's first decisions, stamped with its generation,
          // turned the record over already.
          if (typeof p.document === 'number' && p.document > 0)
            this.dnr.document(chromeTabId, p.document)
          else this.dnr.tabNavigated(chromeTabId)
        }
        updated({ status: 'loading', url: p.url })
        return
      }
      case 'stopLoading': {
        const url = (payload as ViewEventPayloads['stopLoading']).url
        if (!derived)
          this.webNavigationEvents(tabId, this.webNavigation.inferredFinish(tabId, facts, url))
        updated({ status: 'complete' })
        return
      }
      case 'title':
        updated({ title: (payload as ViewEventPayloads['title']).title })
        return
      case 'favicon':
        updated({ favIconUrl: (payload as ViewEventPayloads['favicon']).url })
        return
      case 'audio':
        updated({ audible: (payload as ViewEventPayloads['audio']).audible })
        return
      case 'failLoad': {
        const p = payload as ViewEventPayloads['failLoad']
        if (!derived)
          this.webNavigationEvents(
            tabId,
            this.webNavigation.inferredFailure(
              tabId,
              facts,
              p.url,
              netErrorName(p.code, p.description)
            )
          )
        return
      }
      case 'destroyed':
        this.router.unregisterTab(tabId)
        this.webNavigation.tabRemoved(tabId)
        return
      default:
        return
    }
  }

  /** Raise derived `webNavigation` events about one tab, each addressed by its URL for filtered listeners. */
  private webNavigationEvents(tabId: string, events: DerivedEvent[]): void {
    for (const { event, details } of events)
      this.emitForTab(tabId, 'webNavigation', event, [details], details.url)
  }

  /** The core's state snapshot changed: diff tabs for onCreated / onRemoved / onActivated. */
  private onStateChanged(): void {
    if (this.extensions.size === 0) return
    const win = this.windowOf()
    const active = this.browser.tabs.activeTabFor(win)?.id ?? null
    const tabs = Object.values(this.browser.tabs.model.tabs)
    const now = this.snapshotTabs()
    for (const tab of tabs) {
      if (!this.knownTabs.has(tab.id))
        this.emitForTab(tab.id, 'tabs', 'onCreated', [this.api.tabs.chromeTab(tab)])
    }
    for (const id of this.knownTabs.keys()) {
      if (now.has(id)) continue
      // Every tab has an id in Chrome, seen by the extension or not; a closed one keeps its number.
      const chromeTabId = this.api.tabs.chromeIdFor(id)
      this.emitForTab(id, 'tabs', 'onRemoved', [
        chromeTabId,
        { windowId: 1, isWindowClosing: false }
      ])
      this.router.unregisterTab(id)
      this.api.activeTab.tabRemoved(id)
      this.api.tabRemoved(chromeTabId)
      this.dnr.tabRemoved(chromeTabId)
      this.webNavigation.tabRemoved(id)
    }
    this.knownTabs = now
    // A container created or deleted: every extension's sets follow (private is not a container here).
    const containers = this.containerKey()
    if (containers !== this.knownContainers) {
      this.knownContainers = containers
      for (const id of this.dnr.extensionIds()) this.dnr.sessionsChanged(id)
    }
    if (active !== this.activeTabId) {
      this.activeTabId = active
      if (active)
        this.emitForTab(active, 'tabs', 'onActivated', [
          { tabId: this.api.tabs.chromeIdFor(active), windowId: 1 }
        ])
    }
  }

  /** The background's main frame finished loading: install/update and startup events. */
  private onBackgroundReady(id: string): void {
    if (this.installEvents.has(id)) {
      const previous = this.installEvents.get(id) ?? null
      this.installEvents.delete(id)
      this.emit(id, 'runtime', 'onInstalled', [
        previous ? { reason: 'update', previousVersion: previous } : { reason: 'install' }
      ])
    }
    if (!this.startupFired.has(id)) {
      this.startupFired.add(id)
      this.emit(id, 'runtime', 'onStartup', [])
    }
  }

  /**
   * Kotlin reports every decision (`ext.observeRequests`) while a `webRequest` listener exists in
   * any endpoint – or a stopped worker persisted one: its listener is what wakes it (Chrome's
   * observational events start an MV3 worker), and without the decisions nothing would.
   */
  private updateObserving(): void {
    let wanted = false
    for (const own of this.requestListeners.values()) if (own.size > 0) wanted = true
    for (const id of this.extensions.keys()) {
      if (this.background.persistedListeners(id).some((key) => key.startsWith('webRequest.')))
        wanted = true
    }
    if (wanted !== this.observing) {
      this.observing = wanted
      this.bridge.send('ext.observeRequests', { on: wanted })
    }
  }

  // ---------------------------------------------------------------------------
  // chrome.* calls
  // ---------------------------------------------------------------------------

  private async call(
    endpoint: Endpoint,
    ns: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const ext = this.extensions.get(endpoint.extensionId)
    if (!ext) throw new Error('Extension is not loaded.')
    switch (ns) {
      case 'storage':
        return this.storageCall(ext, endpoint, method, args)
      case 'alarms':
        return this.alarmsCall(ext, method, args)
      case 'webRequest':
        return this.webRequestCall(ext, endpoint, method, args)
      default:
        return this.api.call(ext, endpoint, ns, method, args)
    }
  }

  // --- webRequest ------------------------------------------------------------

  /**
   * The shim's registration calls for `chrome.webRequest.<event>.addListener` /
   * `removeListener`: `[event, RequestFilter, extraInfoSpec, id]` and `[event, id]`, validated as
   * the binding validates them. A `blocking` listener is registered like any other: WebView
   * cannot hold a request for an answer, so it hears the request and its return value is not
   * applied (the delivery carries no token).
   */
  private webRequestCall(
    ext: Attached,
    endpoint: Endpoint,
    method: string,
    args: unknown[]
  ): unknown {
    const id = ext.record.id
    switch (method) {
      case 'addListener': {
        const event = webRequestEventNamed(args[0])
        const spec = normalizeRequestListener(event, args[1], args[2])
        const listenerId = args[3]
        if (typeof listenerId !== 'number' || !Number.isInteger(listenerId) || listenerId <= 0)
          throw new Error('Invalid listener id.')
        let own = this.requestListeners.get(endpoint.id)
        if (!own) {
          own = new Map()
          this.requestListeners.set(endpoint.id, own)
        }
        own.set(listenerId, { event, filter: compileRequestFilter(spec.filter) })
        this.requestListenersChanged(id, endpoint, event)
        return undefined
      }
      case 'removeListener': {
        const event = webRequestEventNamed(args[0])
        const own = this.requestListeners.get(endpoint.id)
        const listenerId = args[1]
        if (!own || typeof listenerId !== 'number' || own.get(listenerId)?.event !== event)
          return undefined
        own.delete(listenerId)
        if (own.size === 0) this.requestListeners.delete(endpoint.id)
        this.requestListenersChanged(id, endpoint, event)
        return undefined
      }
    }
    throw new Error(`chrome.webRequest.${method} ${NOT_IMPLEMENTED}`)
  }

  /** A background's `webRequest` listeners are what wake it: persisted like its other listeners. */
  private requestListenersChanged(
    id: string,
    endpoint: Endpoint,
    event: WebRequestEventName
  ): void {
    if (endpoint.context === 'background') {
      const key = `webRequest.${event}`
      this.background.listen(id, key, this.listens(endpoint.id, key))
      this.data.listeners[id] = this.background.persistedListeners(id)
      this.save()
    }
    this.updateObserving()
  }

  // --- storage ---------------------------------------------------------------

  private storageFor(id: string): StorageEntry {
    let entry = this.storage.get(id)
    if (!entry) {
      const store = new JsonStore<StorageDoc>(this.browser.platform.io, storageDocName(id), 200)
      const saved = store.readSync()
      entry = {
        store,
        doc: { local: asRecord(saved?.local), sync: asRecord(saved?.sync) },
        session: {},
        openToUntrusted: new Set(['local', 'sync', 'managed'])
      }
      this.storage.set(id, entry)
    }
    return entry
  }

  /** `chrome.storage.<area>.<method>`: the shim forwards `[area, ...arguments]`. */
  private storageCall(ext: Attached, endpoint: Endpoint, method: string, args: unknown[]): unknown {
    const area = String(args[0]) as StorageArea
    if (!STORAGE_AREAS.includes(area)) throw new Error(`Unknown storage area ${area}`)
    const id = ext.record.id
    const entry = this.storageFor(id)
    const untrusted = endpoint.context === 'content' || endpoint.context === 'userScript'
    const open = entry.openToUntrusted.has(area)
    if (untrusted && !open) throw new Error('Access to storage is not allowed from this context.')
    const items: StorageItems =
      area === 'local'
        ? entry.doc.local
        : area === 'sync'
          ? entry.doc.sync
          : area === 'session'
            ? entry.session
            : {}
    const commit = (next: StorageItems, changes: StorageChanges): void => {
      if (area === 'local') entry.doc.local = next
      else if (area === 'sync') entry.doc.sync = next
      else entry.session = next
      if (area === 'local' || area === 'sync') entry.store.write(entry.doc)
      // A closed area's changes stay with the trusted contexts.
      const hears = (e: Endpoint): boolean =>
        open || (e.context !== 'content' && e.context !== 'userScript')
      if (Object.keys(changes).length > 0)
        this.emit(id, 'storage', 'onChanged', [changes, area], hears)
    }
    const readOnly = (): never => {
      throw new Error('This is a read-only store.')
    }
    switch (method) {
      case 'get':
        return selectItems(items, args[1] as null | undefined | string | string[] | StorageItems)
      case 'getKeys':
        return Object.keys(items)
      case 'getBytesInUse':
        return bytesInUse(items, args[1] as null | undefined | string | string[])
      case 'set': {
        if (area === 'managed') return readOnly()
        const unlimited = ext.manifest.permissions.includes('unlimitedStorage')
        const quota =
          area === 'sync'
            ? SYNC_QUOTA
            : unlimited
              ? null
              : {
                  QUOTA_BYTES: area === 'session' ? SESSION_QUOTA_BYTES : LOCAL_QUOTA_BYTES,
                  QUOTA_BYTES_PER_ITEM: Infinity,
                  MAX_ITEMS: Infinity
                }
        const result = applySet(items, asRecord(args[1]), quota)
        if (result.error) throw new Error(result.error)
        commit(result.next, result.changes)
        return undefined
      }
      case 'remove': {
        if (area === 'managed') return readOnly()
        const keys = typeof args[1] === 'string' ? args[1] : asStringArray(args[1])
        const result = applyRemove(items, keys)
        commit(result.next, result.changes)
        return undefined
      }
      case 'clear': {
        if (area === 'managed') return readOnly()
        const result = applyClear(items)
        commit(result.next, result.changes)
        return undefined
      }
      case 'setAccessLevel': {
        if (untrusted) throw new Error('Context cannot set the storage access level')
        const level = asRecord(args[1]).accessLevel
        if (level !== 'TRUSTED_CONTEXTS' && level !== 'TRUSTED_AND_UNTRUSTED_CONTEXTS')
          throw new Error(
            "Error at parameter 'accessOptions': Error at property 'accessLevel': " +
              'Value must be one of TRUSTED_CONTEXTS, TRUSTED_AND_UNTRUSTED_CONTEXTS.'
          )
        if (level === 'TRUSTED_AND_UNTRUSTED_CONTEXTS') entry.openToUntrusted.add(area)
        else entry.openToUntrusted.delete(area)
        return undefined
      }
    }
    throw new Error(`chrome.storage.${area}.${method} ${NOT_IMPLEMENTED}`)
  }

  // --- alarms ----------------------------------------------------------------

  /** `alarms.create` arrives as `[name | null, alarmInfo]` after the shim's normalisation. */
  private alarmsCall(ext: Attached, method: string, args: unknown[]): unknown {
    const id = ext.record.id
    const list = this.data.alarms[id] ?? []
    switch (method) {
      case 'create': {
        const [first, second] = args
        const name = typeof first === 'string' ? first : ''
        const info = asRecord(typeof first === 'string' || first == null ? second : first)
        const result = scheduleAlarm(
          name,
          {
            when: typeof info.when === 'number' ? info.when : undefined,
            delayInMinutes:
              typeof info.delayInMinutes === 'number' ? info.delayInMinutes : undefined,
            periodInMinutes:
              typeof info.periodInMinutes === 'number' ? info.periodInMinutes : undefined
          },
          { now: this.now(), unpacked: ext.record.source === 'unpacked' }
        )
        if (result.error !== null) throw new Error(result.error)
        this.data.alarms[id] = [...list.filter((a) => a.name !== name), result.alarm]
        this.save()
        this.armAlarms(id)
        return undefined
      }
      case 'get': {
        const name = typeof args[0] === 'string' ? args[0] : ''
        return list.find((a) => a.name === name) ?? undefined
      }
      case 'getAll':
        return list.map((a) => ({ ...a }))
      case 'clear': {
        const name = typeof args[0] === 'string' ? args[0] : ''
        const existed = list.some((a) => a.name === name)
        this.data.alarms[id] = list.filter((a) => a.name !== name)
        this.save()
        this.armAlarms(id)
        return existed
      }
      case 'clearAll':
        this.data.alarms[id] = []
        this.save()
        this.armAlarms(id)
        return true
    }
    throw new Error(`chrome.alarms.${method} ${NOT_IMPLEMENTED}`)
  }

  /** One timer per extension, for its earliest alarm; firing wakes the background if it listens. */
  private armAlarms(id: string): void {
    this.clearAlarmTimer(id)
    const list = this.data.alarms[id] ?? []
    const ms = msUntilNext(list, this.now())
    if (ms === null) return
    this.alarmTimers.set(
      id,
      this.timers.setTimeout(() => {
        this.alarmTimers.delete(id)
        this.fireAlarms(id)
      }, ms)
    )
  }

  private fireAlarms(id: string): void {
    if (!this.extensions.has(id)) return
    const now = this.now()
    const { due, pending } = splitDue(this.data.alarms[id] ?? [], now)
    for (const alarm of due) {
      this.emit(id, 'alarms', 'onAlarm', [{ ...alarm }])
      const next = rescheduleAlarm(alarm, now)
      if (next) pending.push(next)
    }
    this.data.alarms[id] = pending
    this.save()
    this.armAlarms(id)
  }

  private clearAlarmTimer(id: string): void {
    const timer = this.alarmTimers.get(id)
    if (timer !== undefined) this.timers.clearTimeout(timer)
    this.alarmTimers.delete(id)
  }
}

/** The `webRequest` event a registration names; anything else is the desktop host's error. */
function webRequestEventNamed(raw: unknown): WebRequestEventName {
  const event = WEB_REQUEST_EVENT_NAMES.find((name) => name === raw)
  if (!event) throw new Error('Unknown webRequest event.')
  return event
}

/** The `UrlFilter`s of a filtered listener; a malformed list matches nothing but is not fatal. */
function eventFilters(raw: unknown): UrlFilter[] {
  try {
    return normalizeEventFilters({ url: raw }) ?? []
  } catch {
    return [{ urlEquals: '\u0000' }]
  }
}

/**
 * The store host with the runtime behind it: installs, updates and the registry are the store's
 * (`AndroidExtensions`), running the extensions is the runtime's. Toolbar popups and options
 * pages open as the runtime's sheets (or, for `open_in_tab`, as tabs), an uninstall takes the
 * runtime's persisted state with it, and the list shows the popup `action.setPopup` left.
 */
export class AndroidExtensionsWithRuntime extends AndroidExtensions {
  constructor(
    browser: Browser,
    io: AndroidExtensionStoreIo,
    readonly runtime: AndroidExtensionRuntime,
    options: Omit<AndroidExtensionsOptions, 'hooks'> = {}
  ) {
    super(browser, io, { ...options, hooks: runtime })
    runtime.store = this
  }

  override async start(): Promise<void> {
    await this.runtime.start()
    await super.start()
  }

  /** Running extensions carry their `chrome.action` state for the active tab (badge, title, popup). */
  override list(): ExtensionInfo[] {
    return super.list().map((info) => {
      const popup = this.runtime.popupFor(info.id)
      if (popup === undefined) return info
      const action = this.runtime.api.toolbarAction(info.id)
      return action ? { ...info, popup, action } : { ...info, popup }
    })
  }

  override async remove(id: string): Promise<void> {
    await super.remove(id)
    await this.runtime.forget(id)
  }

  override openOptions(id: string, win: ZenWindow): void {
    const record = this.record(id)
    if (!record) return
    if (!record.optionsPage) {
      this.browser.toast(`${record.name || 'This extension'} has no options page.`, 'info', win)
      return
    }
    this.runtime.openOptions(id, win)
  }

  /** The popup is a sheet over the one window; the toolbar anchor and window play no part. */
  override openPopup(id: string): void {
    this.runtime.openPopup(id)
  }

  override closePopup(): void {
    this.runtime.closePopup()
  }

  /** `chrome.contextMenus` items for the long-press menu of a tab (a link or image under the finger). */
  override pageContextMenuItems(tabId: string, params: PageContextParams): MenuItemTemplate[] {
    const tab = this.browser.tabs.tab(tabId)
    return tab ? this.runtime.api.pageContextMenuItems(tab, params) : []
  }

  override actionContextMenuItems(id: string): MenuItemTemplate[] {
    return this.runtime.api.actionContextMenuItems(id)
  }

  override flushSync(): void {
    super.flushSync()
    this.runtime.flushSync()
  }
}
