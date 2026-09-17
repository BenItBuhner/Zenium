import type { ExtensionInfo, Rect } from '@shared/types'
import type { Browser } from '@core/browser'
import type { ZenWindow } from '@core/window'
import { JsonStore } from '@core/store/JsonStore'
import type { EngineContextKind } from '@core/extensions/api/engine'
import { localeCandidates, type LocaleMessages } from '@core/extensions/api/i18n'
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
import type { NetRule } from '@core/extensions/runtime/dnr'
import { parseRuntimeManifest } from '@core/extensions/runtime/manifest'
import { extensionUrl, type RegisteredContentScript } from '@core/extensions/runtime/plan'
import { MessageRouter, type Endpoint } from '@core/extensions/runtime/router'
import { planUnits, sameUnits, type ExtensionUnits } from '@core/extensions/runtime/units'
import {
  ExtensionApi,
  asRecord,
  asStringArray,
  type ApiHost,
  type AttachedExtension,
  type ExecRequest,
  type ExtensionRules
} from './extensionApi'
import { AndroidExtensions, type AndroidExtensionsOptions } from './extensionHost'
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
 * Kotlin protocol (runtime → Kotlin), every call keyed by extension id:
 *  ext.env                                  → { token, uiLanguage, isolatedWorlds, worldSlots }
 *  ext.open { id, path }                    → { manifest, locales: { <locale>: <messages.json> } }
 *  ext.configure { id, version, path, units, served, debug } → { units: [{ key, chars, cached }], ms }
 *  ext.detach { id }
 *  ext.background.start / stop { id }, ext.popup.open { id, url, context }, ext.popup.close
 *  ext.send { ep, message }, ext.exec {…}, ext.readFile { id, path }, ext.cookies.get / set
 *  ext.setRules { static, dynamic }, ext.observeRequests { on }
 * Kotlin → runtime (host events): ext.message, ext.gone, ext.popupClosed, ext.request.
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

export interface ExtRequestEvent {
  tabId: string | null
  url: string
  type: string
  method: string
  initiator: string | null
  decision: string
  micros: number
}

/** Runtime state that outlives the session (`extensions-runtime.json`). */
interface RuntimeData {
  version: 1
  /** id → the version `runtime.onInstalled` last fired for. */
  installed: Record<string, string>
  registered: Record<string, RegisteredContentScript[]>
  /** id → `userScripts.configureWorld({ messaging })`. */
  userScriptMessaging: Record<string, boolean>
  alarms: Record<string, Alarm[]>
  dynamicRules: Record<string, NetRule[]>
  enabledRulesets: Record<string, string[]>
  /** id → `chrome.<ns>.<event>` names the background listened for: what wakes a stopped worker. */
  listeners: Record<string, string[]>
}

type StorageDoc = { local: StorageItems; sync: StorageItems }

interface StorageEntry {
  store: JsonStore<StorageDoc>
  doc: StorageDoc
  session: StorageItems
  /** `storage.session.setAccessLevel`: whether content scripts may use the session area. */
  sessionUntrusted: boolean
}

interface Attached extends AttachedExtension {
  /** The last plan Kotlin was given, to skip a configure that would change nothing. */
  units: ExtensionUnits | null
  configureStats: ConfigureStats | null
}

/** The store, as far as the runtime needs it (`runtime.reload`, `management.uninstallSelf`). */
export interface RuntimeStoreLink {
  record(id: string): ExtensionRecord | undefined
  records(): readonly ExtensionRecord[]
  reload(id: string): Promise<void>
  remove(id: string): Promise<void>
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
    dynamicRules: {},
    enabledRulesets: {},
    listeners: {}
  }
}

function readData(saved: Partial<RuntimeData> | null): RuntimeData {
  const data = emptyData()
  if (!saved || saved.version !== 1) return data
  data.installed = saved.installed ?? {}
  data.registered = saved.registered ?? {}
  data.userScriptMessaging = saved.userScriptMessaging ?? {}
  data.alarms = saved.alarms ?? {}
  data.dynamicRules = saved.dynamicRules ?? {}
  data.enabledRulesets = saved.enabledRulesets ?? {}
  data.listeners = saved.listeners ?? {}
  return data
}

function storageDocName(id: string): string {
  return `ext-storage-${id}.json`
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

export class AndroidExtensionRuntime implements ExtensionRuntimeHooks, ApiHost {
  readonly router: MessageRouter
  readonly api: ExtensionApi
  readonly background: BackgroundLifecycle
  /** The store, once it has been constructed around this runtime. */
  store: RuntimeStoreLink | null = null

  private env: RuntimeEnv | null = null
  private envPromise: Promise<RuntimeEnv> | null = null
  private readonly extensions = new Map<string, Attached>()
  private readonly dataStore: JsonStore<RuntimeData>
  private readonly data: RuntimeData
  private readonly storage = new Map<string, StorageEntry>()
  /** Endpoint id → `ns.event` names it listens to. */
  private readonly listening = new Map<string, Set<string>>()
  /** Extension id → the endpoint of its background's main frame. */
  private readonly backgroundEps = new Map<string, string>()
  /** Extensions whose `runtime.onInstalled` waits for the first background ready: previous version or null. */
  private readonly installEvents = new Map<string, string | null>()
  private readonly startupFired = new Set<string>()
  /** `tabId\u0000docId` → frame id, so every world of one sub-frame reports the same one. */
  private readonly frameIds = new Map<string, number>()
  private nextFrameId = 1
  private readonly alarmTimers = new Map<string, unknown>()
  private readonly sessionRules = new Map<string, NetRule[]>()
  /** The `ext.setRules` in flight, and whether another is owed after it (see `pushRules`). */
  private rulesPush: Promise<void> | null = null
  private rulesDirty = false
  /**
   * Relayed `MessagePort`s of the emulated service-worker platform (`extensionServiceWorker.ts`):
   * port id → the client page it belongs to; the other end is always the extension's worker.
   */
  private readonly swPorts = new Map<string, { client: string; extensionId: string }>()
  private popupOpen: string | null = null
  private observing = false
  private subscribed = false
  private activeTabId: string | null = null
  private knownTabIds = new Set<string>()
  private readonly debug: boolean
  private readonly now: () => number
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

  /** Reads the environment from Kotlin and drops runtime data of extensions the store no longer has. */
  async start(): Promise<void> {
    await this.ensureEnv()
    if (this.store) {
      const known = new Set(this.store.records().map((r) => r.id))
      let pruned = false
      for (const table of [
        this.data.installed,
        this.data.registered,
        this.data.userScriptMessaging,
        this.data.alarms,
        this.data.dynamicRules,
        this.data.enabledRulesets,
        this.data.listeners
      ] as Record<string, unknown>[]) {
        for (const id of Object.keys(table)) {
          if (known.has(id)) continue
          delete table[id]
          pruned = true
        }
      }
      if (pruned) this.save()
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
            : 0
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
    this.knownTabIds = new Set(Object.keys(this.browser.tabs.model.tabs))
    this.activeTabId = this.browser.tabs.activeTabFor(this.windowOf())?.id ?? null
    this.browser.state.subscribe(() => this.onStateChanged())
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
      configureStats: previous?.configureStats ?? null
    }
    this.extensions.set(record.id, ext)
    this.background.configure(
      record.id,
      backgroundKindOf(manifest),
      this.data.listeners[record.id] ?? []
    )
    await this.configure(ext)
    if (manifest.permissions.includes('declarativeNetRequest')) await this.pushRules()
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
    this.clearAlarmTimer(id)
    for (const endpoint of this.router.of(id)) {
      this.router.unregister(endpoint.id)
      this.listening.delete(endpoint.id)
    }
    for (const [port, owner] of [...this.swPorts])
      if (owner.extensionId === id) this.swPorts.delete(port)
    if (this.popupOpen === id) this.closePopup()
    this.updateObserving()
    await this.bridge.call('ext.detach', { id })
    if (ext.manifest.permissions.includes('declarativeNetRequest')) await this.pushRules()
    this.browser.state.commitVolatile()
  }

  async reconfigure(record: ExtensionRecord): Promise<void> {
    const ext = this.extensions.get(record.id)
    if (!ext) return
    ext.record = record
    await this.configure(ext)
  }

  /** The extension was uninstalled: its persisted runtime state and `chrome.storage` go too. */
  async forget(id: string): Promise<void> {
    await this.detach(id)
    delete this.data.installed[id]
    delete this.data.registered[id]
    delete this.data.userScriptMessaging[id]
    delete this.data.alarms[id]
    delete this.data.dynamicRules[id]
    delete this.data.enabledRulesets[id]
    delete this.data.listeners[id]
    this.sessionRules.delete(id)
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
    if (sameUnits(ext.units, units)) return
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
      allowFileAccess: ext.record.allowFileAccess,
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

  /**
   * Static rulesets (enabled ones, read by Kotlin) plus the normalised dynamic and session
   * rules. Every attach and detach of a declarativeNetRequest extension asks for a push, and
   * Kotlin rebuilds the whole set each time: pushes arriving while one is in flight coalesce
   * into a single one after it, and each caller's promise settles once its rules are in place.
   */
  private pushRules(): Promise<void> {
    this.rulesDirty = true
    if (!this.rulesPush) {
      this.rulesPush = (async () => {
        try {
          while (this.rulesDirty) {
            this.rulesDirty = false
            await this.bridge.call('ext.setRules', this.rulesPayload())
          }
        } finally {
          this.rulesPush = null
        }
      })()
    }
    return this.rulesPush
  }

  private rulesPayload(): { static: Array<{ ext: string; paths: string[] }>; dynamic: NetRule[] } {
    const statics: Array<{ ext: string; paths: string[] }> = []
    const dynamic: NetRule[] = []
    for (const ext of this.extensions.values()) {
      const manifest = ext.manifest
      if (!manifest.permissions.includes('declarativeNetRequest')) continue
      const rules = this.rules(ext.record.id)
      const enabled = new Set(
        rules.enabledRulesets ?? manifest.rulesets.filter((r) => r.enabled).map((r) => r.id)
      )
      const paths = manifest.rulesets.filter((r) => enabled.has(r.id)).map((r) => r.path)
      if (paths.length > 0) statics.push({ ext: ext.record.id, paths })
      dynamic.push(...rules.dynamic, ...rules.session)
    }
    return { static: statics, dynamic }
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

  rules(id: string): ExtensionRules {
    return {
      dynamic: this.data.dynamicRules[id] ?? [],
      session: this.sessionRules.get(id) ?? [],
      enabledRulesets: this.data.enabledRulesets[id] ?? null
    }
  }

  async setRules(id: string, rules: ExtensionRules): Promise<void> {
    if (rules.dynamic.length > 0) this.data.dynamicRules[id] = rules.dynamic
    else delete this.data.dynamicRules[id]
    if (rules.enabledRulesets) this.data.enabledRulesets[id] = rules.enabledRulesets
    else delete this.data.enabledRulesets[id]
    if (rules.session.length > 0) this.sessionRules.set(id, rules.session)
    else this.sessionRules.delete(id)
    this.save()
    await this.pushRules()
  }

  /**
   * Raise `chrome.<ns>.<name>` in every endpoint of one extension that registered a listener.
   * Pages, popups and content scripts get it now; the background gets it now when it runs, held
   * while it starts, and is woken for it when it is stopped but persisted a listener.
   */
  emit(extensionId: string, ns: string, name: string, args: unknown[]): void {
    const key = `${ns}.${name}`
    const message = { t: 'event', ns, name, args }
    const sendTo = (filter: (endpoint: Endpoint) => boolean): void => {
      for (const endpoint of this.router.of(extensionId)) {
        if (!filter(endpoint) || !this.listening.get(endpoint.id)?.has(key)) continue
        this.sendTo(endpoint.id, message)
      }
    }
    sendTo((endpoint) => endpoint.context !== 'background')
    if (this.background.has(extensionId))
      this.background.deliver(extensionId, key, () =>
        sendTo((endpoint) => endpoint.context === 'background')
      )
  }

  private emitAll(ns: string, name: string, args: unknown[]): void {
    for (const id of this.extensions.keys()) this.emit(id, ns, name, args)
  }

  readFile(id: string, path: string): Promise<string | null> {
    if (!path) return Promise.resolve(null)
    return this.bridge.call<string | null>('ext.readFile', { id, path })
  }

  exec(request: ExecRequest): Promise<unknown> {
    return this.bridge.call<unknown>('ext.exec', {
      tabId: request.tabId,
      ext: request.extensionId,
      kind: request.kind,
      payload: request.payload,
      code: request.code,
      funcSource: request.funcSource,
      args: request.args
    })
  }

  cookieHeader(url: string): Promise<string | null> {
    return this.bridge.call<string | null>('ext.cookies.get', { url })
  }

  setCookie(url: string, cookie: string): Promise<void> {
    return this.bridge.call('ext.cookies.set', { url, cookie })
  }

  openPopup(id: string, win: ZenWindow = this.windowOf()): void {
    const ext = this.extensions.get(id)
    if (!ext) return
    const action = this.api.actionFor(id)
    if (!action.popup) {
      const tab = this.browser.tabs.activeTabFor(win)
      const ns = ext.manifest.manifestVersion === 3 ? 'action' : 'browserAction'
      this.emit(id, ns, 'onClicked', [tab ? this.api.tabs.chromeTab(tab) : null])
      return
    }
    this.popupOpen = id
    this.bridge.send('ext.popup.open', {
      id,
      url: extensionUrl(id, action.popup),
      context: 'popup'
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
    this.bridge.send('ext.popup.open', { id, url, context: 'options' })
  }

  closePopup(): void {
    if (!this.popupOpen) return
    this.popupOpen = null
    this.bridge.send('ext.popup.close')
  }

  /** The popup path `action.setPopup` left (null when clicks fire `onClicked`); undefined when not attached. */
  popupFor(id: string): string | null | undefined {
    if (!this.extensions.has(id)) return undefined
    return this.api.actionFor(id).popup
  }

  async reload(id: string): Promise<void> {
    if (this.store) await this.store.reload(id)
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
        let set = this.listening.get(ep)
        if (!set) {
          set = new Set()
          this.listening.set(ep, set)
        }
        if (message.on) set.add(key)
        else set.delete(key)
        if (endpoint.context === 'background') {
          this.background.listen(id, key, message.on === true)
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
    const inFrame = context === 'content' || context === 'userScript'
    let frameId = 0
    if (inFrame && !event.top) {
      const key = `${event.tabId ?? ''}\u0000${ep.split('.')[0]}`
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
      }
      this.backgroundEps.set(extensionId, ep)
    }
  }

  onGone(eps: string[]): void {
    for (const ep of eps) {
      const endpoint = this.router.endpoint(ep)
      this.router.unregister(ep)
      this.listening.delete(ep)
      if (endpoint) this.closeServiceWorkerPorts(endpoint)
      if (
        endpoint?.context === 'background' &&
        this.backgroundEps.get(endpoint.extensionId) === ep
      ) {
        this.backgroundEps.delete(endpoint.extensionId)
        this.background.onGone(endpoint.extensionId)
      }
    }
    this.updateObserving()
  }

  onPopupClosed(): void {
    this.popupOpen = null
  }

  /** Observational `webRequest` from `shouldInterceptRequest` (only while someone listens). */
  onRequest(event: ExtRequestEvent): void {
    const tabId = event.tabId ? this.api.tabs.chromeIdFor(event.tabId) : -1
    const now = this.now()
    const details = {
      requestId: String(now),
      url: event.url,
      method: event.method,
      frameId: 0,
      parentFrameId: -1,
      tabId,
      type: event.type,
      timeStamp: now,
      initiator: event.initiator ?? undefined
    }
    for (const id of this.extensions.keys()) {
      this.emit(id, 'webRequest', 'onBeforeRequest', [details])
      if (event.decision === 'block')
        this.emit(id, 'webRequest', 'onErrorOccurred', [
          { ...details, error: 'net::ERR_BLOCKED_BY_CLIENT', fromCache: false }
        ])
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
    const nav = (event: string, url: string, extra: Record<string, unknown> = {}): void =>
      this.emitAll('webNavigation', event, [
        {
          tabId: chromeTabId,
          url,
          frameId: 0,
          parentFrameId: -1,
          timeStamp: this.now(),
          ...extra
        }
      ])
    const updated = (change: Record<string, unknown>): void => {
      if (tab)
        this.emitAll('tabs', 'onUpdated', [chromeTabId, change, this.api.tabs.chromeTab(tab)])
    }
    switch (name) {
      case 'navigated': {
        const p = payload as ViewEventPayloads['navigated']
        if (p.inPage) {
          const previous = tab?.url ?? ''
          const fragmentOnly = previous.split('#')[0] === p.url.split('#')[0]
          nav(fragmentOnly ? 'onReferenceFragmentUpdated' : 'onHistoryStateUpdated', p.url, {
            transitionType: 'link',
            transitionQualifiers: []
          })
        } else {
          this.router.unregisterTab(tabId)
          nav('onBeforeNavigate', p.url)
          nav('onCommitted', p.url, { transitionType: 'link', transitionQualifiers: [] })
        }
        updated({ status: 'loading', url: p.url })
        return
      }
      case 'stopLoading': {
        const url = (payload as ViewEventPayloads['stopLoading']).url
        nav('onDOMContentLoaded', url)
        nav('onCompleted', url)
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
        nav('onErrorOccurred', p.url, { error: p.description })
        return
      }
      case 'destroyed':
        this.router.unregisterTab(tabId)
        return
      default:
        return
    }
  }

  /** The core's state snapshot changed: diff tabs for onCreated / onRemoved / onActivated. */
  private onStateChanged(): void {
    if (this.extensions.size === 0) return
    const win = this.windowOf()
    const active = this.browser.tabs.activeTabFor(win)?.id ?? null
    const tabs = Object.values(this.browser.tabs.model.tabs)
    const ids = new Set(tabs.map((t) => t.id))
    for (const tab of tabs) {
      if (!this.knownTabIds.has(tab.id))
        this.emitAll('tabs', 'onCreated', [this.api.tabs.chromeTab(tab)])
    }
    for (const id of this.knownTabIds) {
      if (ids.has(id)) continue
      // Every tab has an id in Chrome, seen by the extension or not; a closed one keeps its number.
      this.emitAll('tabs', 'onRemoved', [
        this.api.tabs.chromeIdFor(id),
        { windowId: 1, isWindowClosing: false }
      ])
      this.router.unregisterTab(id)
    }
    this.knownTabIds = ids
    if (active !== this.activeTabId) {
      this.activeTabId = active
      if (active)
        this.emitAll('tabs', 'onActivated', [
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

  private updateObserving(): void {
    let wanted = false
    for (const set of this.listening.values()) {
      for (const key of set) if (key.startsWith('webRequest.')) wanted = true
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
      default:
        return this.api.call(ext, endpoint, ns, method, args)
    }
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
        sessionUntrusted: false
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
    if (area === 'session' && untrusted && !entry.sessionUntrusted)
      throw new Error('Access to storage is not allowed from this context.')
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
      if (Object.keys(changes).length > 0) this.emit(id, 'storage', 'onChanged', [changes, area])
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
        if (area !== 'session')
          throw new Error('setAccessLevel is only available on storage.session.')
        if (untrusted) throw new Error('Context cannot set the storage access level')
        const level = asRecord(args[1]).accessLevel
        entry.sessionUntrusted = level === 'TRUSTED_AND_UNTRUSTED_CONTEXTS'
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

/**
 * The store host with the runtime behind it: installs, updates and the registry are the store's
 * (`AndroidExtensions`), running the extensions is the runtime's. Toolbar popups and options
 * pages open as the runtime's sheets (or, for `open_in_tab`, as tabs), an uninstall takes the
 * runtime's persisted state with it, and the list shows the popup `action.setPopup` left.
 */
export class AndroidExtensionHost extends AndroidExtensions {
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

  override list(): ExtensionInfo[] {
    return super.list().map((info) => {
      const popup = this.runtime.popupFor(info.id)
      return popup === undefined ? info : { ...info, popup }
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

  override openPopup(id: string, _anchor: Rect, win: ZenWindow): void {
    this.runtime.openPopup(id, win)
  }

  override closePopup(): void {
    this.runtime.closePopup()
  }

  override flushSync(): void {
    super.flushSync()
    this.runtime.flushSync()
  }
}
