import type { ExtensionInfo, Rect, Tab } from '@shared/types'
import type { Browser } from '@core/browser'
import type { ExtensionHost } from '@core/platform'
import { JsonStore } from '@core/store/JsonStore'
import type { ZenWindow } from '@core/window'
import {
  backgroundPageHtml,
  buildExtensionBoot,
  type ContentBootConfig,
  type ExtensionBoot,
  type IsolationMode,
  type PageBootConfig,
  type PageContext,
  worldNameFor
} from '@core/extensions/runtime/boot'
import { normalizeRule, normalizeRuleset, type NetRule } from '@core/extensions/runtime/dnr'
import {
  largestIcon,
  localeCandidates,
  ManifestError,
  parseRuntimeManifest,
  type LocaleMessages,
  type RunAt,
  type RuntimeManifest
} from '@core/extensions/runtime/manifest'
import {
  matchPatternTest,
  parseMatchPattern,
  splitUrl
} from '@core/extensions/runtime/matchPatterns'
import { extensionUrl, type RegisteredContentScript } from '@core/extensions/runtime/plan'
import { MessageRouter, type Endpoint } from '@core/extensions/runtime/router'
import type { ShimContextKind } from '@core/extensions/runtime/shim'
import type { Bridge } from './bridge'
import type { ViewEventPayloads } from './views'

/**
 * The browser-core half of the Android extension emulation layer. Kotlin (`ext/Extensions.kt`)
 * serves the fake origins, injects the document-start script units and relays bridge messages;
 * this class owns the extension model: it parses the sideloaded manifests, plans what Kotlin
 * injects where, routes `chrome.runtime`/`chrome.tabs` messages between endpoints, implements
 * every `chrome.*` call the shim forwards, persists `chrome.storage` and alarms, and raises the
 * tab / navigation / request events. Everything here is plain TypeScript on top of the core's
 * tab model, so the same class can back a desktop host that lacks Chromium's extension system.
 */

/** What `ext.scan` hands back per unpacked directory under `files/zen/extensions/`. */
interface Scanned {
  id: string
  path: string
  manifest: string
  locales: Record<string, string>
  icon: string | null
}

interface ScanResult {
  token: string
  uiLanguage: string
  extensions: Scanned[]
  /** The WebView can inject into named isolated worlds (Chromium 146+ via androidx.webkit 1.17). */
  isolatedWorlds?: boolean
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

interface Loaded {
  id: string
  path: string
  manifest: RuntimeManifest | null
  messages: LocaleMessages | null
  icon: string | null
  error: string | null
  raw: Record<string, unknown> | null
}

interface Alarm {
  name: string
  scheduledTime: number
  periodInMinutes?: number
}

interface Persisted {
  version: 1
  disabled: string[]
  /** id → version, for `runtime.onInstalled` reasons. */
  installed: Record<string, string>
  isolation: IsolationMode
  dynamicRules: Record<string, NetRule[]>
  enabledRulesets: Record<string, string[]>
  alarms: Record<string, Alarm[]>
  registered: Record<string, RegisteredContentScript[]>
}

type StorageArea = 'local' | 'sync' | 'session' | 'managed'
type StorageDoc = Record<StorageArea, Record<string, unknown>>

interface ActionState {
  title: string | null
  popup: string | null
  badgeText: string
  badgeBackgroundColor: string
  badgeTextColor: string
  enabled: boolean
}

const STORE_NAME = 'extensions-android.json'
const NOT_IMPLEMENTED = 'is not implemented on Zenium for Android'

function emptyStorageDoc(): StorageDoc {
  return { local: {}, sync: {}, session: {}, managed: {} }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** Rough UTF-16 byte count Chrome reports for `getBytesInUse`. */
function bytesOf(entries: Record<string, unknown>): number {
  let total = 0
  for (const [key, value] of Object.entries(entries))
    total += key.length + JSON.stringify(value).length
  return total
}

/**
 * `addDocumentStartJavaScript` filters by origin rule (`scheme://host[:port]`, `*` wildcards in
 * the host's leftmost label, or `*` for everything). A match pattern with a path is wider than
 * its origin, so the rule is the origin; anything the rule grammar cannot express becomes `*`
 * and the bootstrap's own matcher decides in the frame.
 */
export function originRulesFor(patterns: string[]): Set<string> {
  const rules = new Set<string>()
  for (const raw of patterns) {
    if (raw === '<all_urls>') return new Set(['*'])
    const pattern = parseMatchPattern(raw)
    if (!pattern) continue
    if (pattern.matchesAllUrls || pattern.host === '*' || pattern.host === '') return new Set(['*'])
    for (const scheme of pattern.schemes) {
      if (scheme !== 'http' && scheme !== 'https') return new Set(['*'])
      const port = pattern.port && pattern.port !== '*' ? `:${pattern.port}` : ''
      rules.add(`${scheme}://${pattern.host}${port}`)
    }
  }
  return rules.size === 0 ? new Set(['*']) : rules
}

export class AndroidExtensionHost implements ExtensionHost {
  private token = ''
  private uiLanguage = 'en'
  private loaded = new Map<string, Loaded>()
  private readonly store: JsonStore<Persisted>
  private data: Persisted
  private readonly storageDocs = new Map<
    string,
    { store: JsonStore<StorageDoc>; doc: StorageDoc }
  >()
  private readonly router: MessageRouter
  /** Endpoint id → `ns.event` names it listens to. */
  private readonly listening = new Map<string, Set<string>>()
  private readonly chromeTabIds = new Map<string, number>()
  private readonly coreTabIds = new Map<number, string>()
  private nextTabId = 1
  private nextFrameId = 1
  private readonly actions = new Map<string, ActionState>()
  private readonly alarmTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly sessionRules = new Map<string, NetRule[]>()
  private readonly contextMenus = new Map<string, Map<string, Record<string, unknown>>>()
  private popupOpen: string | null = null
  private started = false
  private activeTabId: string | null = null
  private knownTabIds = new Set<string>()
  private observing = false
  /** Reported by Kotlin: real isolated worlds are available, so the emulation proxy is not used. */
  private isolatedWorlds = false

  constructor(
    private readonly bridge: Bridge,
    private readonly browser: Browser,
    private readonly windowOf: () => ZenWindow
  ) {
    this.store = new JsonStore<Persisted>(browser.platform.io, STORE_NAME, 300)
    const saved = this.store.readSync()
    this.data =
      saved?.version === 1
        ? {
            version: 1,
            disabled: saved.disabled ?? [],
            installed: saved.installed ?? {},
            isolation: saved.isolation ?? 'with',
            dynamicRules: saved.dynamicRules ?? {},
            enabledRulesets: saved.enabledRulesets ?? {},
            alarms: saved.alarms ?? {},
            registered: saved.registered ?? {}
          }
        : {
            version: 1,
            disabled: [],
            installed: {},
            isolation: 'with',
            dynamicRules: {},
            enabledRulesets: {},
            alarms: {},
            registered: {}
          }
    this.router = new MessageRouter({
      send: (endpointId, message) => this.sendTo(endpointId, message),
      tabFor: (tabId) => {
        const tab = this.browser.tabs.tab(tabId)
        return tab ? this.chromeTab(tab) : null
      },
      tabIdFromChrome: (chromeTabId) => this.coreTabIds.get(chromeTabId) ?? null
    })
  }

  /**
   * One shim message to one endpoint (a frame's or an extension page's reply proxy in Kotlin).
   * Frames host several endpoints (one per extension) on one transport, so the message carries
   * the endpoint id; the bootstrap routes on it.
   */
  private sendTo(endpointId: string, message: Record<string, unknown>): void {
    this.bridge.send('ext.send', {
      ep: endpointId,
      message: JSON.stringify({ ...message, ep: endpointId })
    })
  }

  // ---------------------------------------------------------------------------
  // ExtensionHost
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    this.started = true
    this.browser.state.subscribe(() => this.onStateChanged())
    await this.rescan()
  }

  list(): ExtensionInfo[] {
    return [...this.loaded.values()].map((ext) => ({
      id: ext.id,
      name: ext.manifest?.name ?? ext.id,
      version: ext.manifest?.version ?? '',
      description: ext.manifest?.description ?? '',
      path: ext.path,
      enabled: !this.data.disabled.includes(ext.id),
      icon: ext.icon,
      popup: this.actionFor(ext.id).popup,
      error: ext.error
    }))
  }

  /** No directory picker on Android: unpacked extensions are sideloaded into the app's files. */
  async addFromDialog(win: ZenWindow): Promise<void> {
    const before = this.loaded.size
    await this.rescan()
    const added = this.loaded.size - before
    this.browser.toast(
      added > 0
        ? `Loaded ${added} sideloaded extension${added === 1 ? '' : 's'}.`
        : 'Sideload an unpacked extension into files/zen/extensions/<id>/ and try again.',
      'info',
      win
    )
  }

  remove(id: string): void {
    this.loaded.delete(id)
    this.data.disabled = this.data.disabled.filter((d) => d !== id)
    delete this.data.installed[id]
    delete this.data.dynamicRules[id]
    delete this.data.enabledRulesets[id]
    delete this.data.alarms[id]
    delete this.data.registered[id]
    this.save()
    this.bridge.send('ext.remove', { id })
    void this.configure()
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const disabled = new Set(this.data.disabled)
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    this.data.disabled = [...disabled]
    this.save()
    await this.configure()
  }

  openPopup(id: string, _anchor: Rect, win: ZenWindow): void {
    const ext = this.loaded.get(id)
    if (!ext?.manifest) return
    const action = this.actionFor(id)
    if (!action.popup) {
      const tab = this.browser.tabs.activeTabFor(win)
      const ns = ext.manifest.manifestVersion === 3 ? 'action' : 'browserAction'
      this.emit(id, ns, 'onClicked', [tab ? this.chromeTab(tab) : null])
      return
    }
    this.popupOpen = id
    this.bridge.send('ext.popup.open', {
      id,
      url: extensionUrl(id, action.popup),
      context: 'popup'
    })
  }

  closePopup(): void {
    if (!this.popupOpen) return
    this.popupOpen = null
    this.bridge.send('ext.popup.close')
  }

  flushSync(): void {
    this.store.flushSync()
    for (const entry of this.storageDocs.values()) entry.store.flushSync()
  }

  // ---------------------------------------------------------------------------
  // Loading and configuring
  // ---------------------------------------------------------------------------

  private async rescan(): Promise<void> {
    const result = await this.bridge.call<ScanResult>('ext.scan')
    this.token = result.token
    this.uiLanguage = result.uiLanguage || navigator.language || 'en'
    this.isolatedWorlds = result.isolatedWorlds === true
    const next = new Map<string, Loaded>()
    for (const entry of result.extensions) next.set(entry.id, this.load(entry))
    this.loaded = next
    await this.configure()
  }

  private load(entry: Scanned): Loaded {
    let raw: Record<string, unknown> | null = null
    try {
      raw = JSON.parse(entry.manifest) as Record<string, unknown>
    } catch (error) {
      return {
        id: entry.id,
        path: entry.path,
        manifest: null,
        messages: null,
        icon: entry.icon,
        error: `manifest.json: ${(error as Error).message}`,
        raw: null
      }
    }
    const defaultLocale = typeof raw.default_locale === 'string' ? raw.default_locale : null
    let messages: LocaleMessages | null = null
    for (const candidate of localeCandidates(this.uiLanguage, defaultLocale)) {
      const text = entry.locales[candidate]
      if (!text) continue
      try {
        messages = JSON.parse(text) as LocaleMessages
        break
      } catch {
        /* try the next locale */
      }
    }
    try {
      const manifest = parseRuntimeManifest(raw, messages)
      const icon = entry.icon ?? (largestIcon(manifest.icons) ? null : null)
      return { id: entry.id, path: entry.path, manifest, messages, icon, error: null, raw }
    } catch (error) {
      return {
        id: entry.id,
        path: entry.path,
        manifest: null,
        messages,
        icon: entry.icon,
        error: error instanceof ManifestError ? error.message : String(error),
        raw
      }
    }
  }

  private enabled(): Loaded[] {
    return [...this.loaded.values()].filter(
      (ext) => ext.manifest !== null && !this.data.disabled.includes(ext.id)
    )
  }

  private bootFor(ext: Loaded): ExtensionBoot {
    if (!ext.manifest) throw new Error('not loaded')
    return buildExtensionBoot(
      ext.id,
      ext.manifest,
      ext.messages,
      this.data.registered[ext.id] ?? [],
      this.isolatedWorlds ? 'world' : this.data.isolation
    )
  }

  /** Origins whose frames need this extension's bootstrap: content scripts plus scripting targets. */
  private originsFor(ext: Loaded, boot: ExtensionBoot): Set<string> {
    const manifest = ext.manifest
    if (!manifest) return new Set()
    const patterns: string[] = []
    for (const group of boot.groups) patterns.push(...group.matches)
    const scripts =
      manifest.permissions.includes('scripting') ||
      manifest.permissions.includes('userScripts') ||
      (manifest.manifestVersion === 2 && manifest.hostPermissions.length > 0)
    if (scripts) patterns.push(...manifest.hostPermissions)
    if (patterns.length === 0) return new Set()
    return originRulesFor(patterns)
  }

  /**
   * Tell Kotlin what to inject and serve. Extensions with identical origin rules share one
   * document-start unit; the bootstrap inside each unit still evaluates the full match patterns.
   * With real isolated worlds every extension gets its own unit in its own world (plus a
   * main-world unit when it declares `world: "MAIN"` scripts), since a world holds one extension.
   */
  private async configure(): Promise<void> {
    if (!this.started) return
    const units = new Map<
      string,
      { origins: string[]; extensions: ExtensionBoot[]; world: string | null }
    >()
    const served: Record<string, unknown> = {}
    const enabled = this.enabled()
    for (const ext of enabled) {
      const manifest = ext.manifest
      if (!manifest) continue
      const boot = this.bootFor(ext)
      const origins = this.originsFor(ext, boot)
      if (origins.size > 0) {
        if (this.isolatedWorlds) {
          const isolated = boot.groups.filter((g) => g.world !== 'MAIN')
          const main = boot.groups.filter((g) => g.world === 'MAIN')
          units.set(`${ext.id}/isolated`, {
            origins: [...origins],
            extensions: [{ ...boot, groups: isolated }],
            world: worldNameFor(ext.id)
          })
          if (main.length > 0)
            units.set(`${ext.id}/main`, {
              origins: [...origins],
              extensions: [{ ...boot, groups: main, isolation: 'none' }],
              world: null
            })
        } else {
          const key = [...origins].sort().join(' ')
          const unit = units.get(key) ?? { origins: [...origins], extensions: [], world: null }
          unit.extensions.push(boot)
          units.set(key, unit)
        }
      }
      const background = manifest.background
      const pageConfig: Omit<PageBootConfig, 'context'> = {
        kind: 'page',
        token: this.token,
        uiLanguage: this.uiLanguage,
        extension: boot
      }
      served[ext.id] = {
        webAccessible: manifest.webAccessibleResources.flatMap((set) => set.resources),
        backgroundHtml:
          background && background.kind !== 'page' ? backgroundPageHtml(manifest) : null,
        backgroundUrl: background
          ? background.kind === 'page'
            ? extensionUrl(ext.id, background.page)
            : extensionUrl(ext.id, '_generated_background_page.html')
          : null,
        page: JSON.stringify(pageConfig)
      }
    }
    const unitList = [...units.values()].map((unit) => {
      const config: ContentBootConfig = {
        kind: 'content',
        token: this.token,
        uiLanguage: this.uiLanguage,
        extensions: unit.extensions
      }
      const groups: Array<{ ext: string; index: number; js: string[]; isolation: IsolationMode }> =
        []
      const css: Array<{ ext: string; path: string }> = []
      for (const ext of unit.extensions) {
        for (const group of ext.groups) {
          if (group.js.length > 0)
            groups.push({
              ext: ext.id,
              index: group.index,
              js: group.js,
              isolation: group.world === 'MAIN' ? 'none' : ext.isolation
            })
          for (const path of group.css) css.push({ ext: ext.id, path })
        }
      }
      return {
        origins: unit.origins,
        config: JSON.stringify(config),
        groups,
        css,
        world: unit.world
      }
    })
    await this.bridge.call('ext.configure', { units: unitList, extensions: served, debug: true })
    await this.pushRules()
    for (const ext of enabled) {
      if (ext.manifest?.background) this.bridge.send('ext.background.start', { id: ext.id })
    }
    this.browser.state.commitVolatile()
  }

  /** Static rulesets (enabled ones, read by Kotlin) plus the normalised dynamic and session rules. */
  private async pushRules(): Promise<void> {
    const statics: Array<{ ext: string; paths: string[] }> = []
    const dynamic: NetRule[] = []
    for (const ext of this.enabled()) {
      const manifest = ext.manifest
      if (!manifest || !manifest.permissions.includes('declarativeNetRequest')) continue
      const enabledIds = new Set(
        this.data.enabledRulesets[ext.id] ??
          manifest.rulesets.filter((r) => r.enabled).map((r) => r.id)
      )
      const paths = manifest.rulesets.filter((r) => enabledIds.has(r.id)).map((r) => r.path)
      if (paths.length > 0) statics.push({ ext: ext.id, paths })
      dynamic.push(
        ...(this.data.dynamicRules[ext.id] ?? []),
        ...(this.sessionRules.get(ext.id) ?? [])
      )
    }
    await this.bridge.call('ext.setRules', { static: statics, dynamic })
  }

  private save(): void {
    this.store.write(this.data)
  }

  // ---------------------------------------------------------------------------
  // Kotlin → core
  // ---------------------------------------------------------------------------

  /** A bridge message from a content-script frame or an extension page. */
  onMessage(event: ExtMessageEvent): void {
    const { message, ep } = event
    const type = String(message.t)
    if (type === 'hello') {
      const extensionId = String(message.ext ?? '')
      if (!this.loaded.has(extensionId)) return
      const context = String(message.ctx ?? 'content') as ShimContextKind
      this.router.register({
        id: ep,
        extensionId,
        context,
        // Extension pages opened as tabs report their tab like content frames do (Chrome sets
        // `sender.tab` for them); popups and background pages have none.
        tabId: context === 'content' || context === 'page' ? event.tabId : null,
        frameId: context === 'content' ? (event.top ? 0 : this.nextFrameId++) : 0,
        url: String(message.url ?? event.origin)
      })
      return
    }
    const endpoint = this.router.endpoint(ep)
    if (!endpoint) return
    switch (type) {
      case 'call': {
        const id = Number(message.id)
        const ns = String(message.ns)
        const method = String(message.method)
        const args = Array.isArray(message.args) ? (message.args as unknown[]) : []
        this.call(endpoint, ns, method, args).then(
          (result) => this.sendTo(ep, { t: 'reply', id, ok: true, result: result ?? null }),
          (error: unknown) =>
            this.sendTo(ep, {
              t: 'reply',
              id,
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            })
        )
        return
      }
      case 'listen': {
        const key = `${String(message.ns)}.${String(message.name)}`
        let set = this.listening.get(ep)
        if (!set) {
          set = new Set()
          this.listening.set(ep, set)
        }
        if (message.on) set.add(key)
        else set.delete(key)
        this.updateObserving()
        return
      }
      case 'ready':
        if (endpoint.context === 'background') this.onBackgroundReady(endpoint.extensionId)
        return
      default:
        this.router.handle(ep, message)
    }
  }

  onGone(eps: string[]): void {
    for (const ep of eps) {
      this.router.unregister(ep)
      this.listening.delete(ep)
    }
    this.updateObserving()
  }

  onPopupClosed(): void {
    this.popupOpen = null
  }

  /** Observational `webRequest` from `shouldInterceptRequest` (only while someone listens). */
  onRequest(event: ExtRequestEvent): void {
    const tabId = event.tabId ? this.chromeTabIdFor(event.tabId) : -1
    const details = {
      requestId: String(Date.now()),
      url: event.url,
      method: event.method,
      frameId: 0,
      parentFrameId: -1,
      tabId,
      type: event.type,
      timeStamp: Date.now(),
      initiator: event.initiator ?? undefined
    }
    for (const ext of this.enabled()) {
      this.emit(ext.id, 'webRequest', 'onBeforeRequest', [details])
      if (event.decision === 'block')
        this.emit(ext.id, 'webRequest', 'onErrorOccurred', [
          { ...details, error: 'net::ERR_BLOCKED_BY_CLIENT', fromCache: false }
        ])
    }
  }

  /** Tab view events, forwarded by the platform: tabs.onUpdated and webNavigation. */
  onViewEvent<K extends keyof ViewEventPayloads>(
    tabId: string,
    name: K,
    payload: ViewEventPayloads[K]
  ): void {
    const tab = this.browser.tabs.tab(tabId)
    const chromeTabId = this.chromeTabIdFor(tabId)
    const nav = (event: string, url: string, extra: Record<string, unknown> = {}): void =>
      this.emitAll('webNavigation', event, [
        { tabId: chromeTabId, url, frameId: 0, parentFrameId: -1, timeStamp: Date.now(), ...extra }
      ])
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
        if (tab)
          this.emitAll('tabs', 'onUpdated', [
            chromeTabId,
            { status: 'loading', url: p.url },
            this.chromeTab(tab)
          ])
        return
      }
      case 'stopLoading': {
        const url = (payload as ViewEventPayloads['stopLoading']).url
        nav('onDOMContentLoaded', url)
        nav('onCompleted', url)
        if (tab)
          this.emitAll('tabs', 'onUpdated', [
            chromeTabId,
            { status: 'complete' },
            this.chromeTab(tab)
          ])
        return
      }
      case 'title':
        if (tab)
          this.emitAll('tabs', 'onUpdated', [
            chromeTabId,
            { title: (payload as ViewEventPayloads['title']).title },
            this.chromeTab(tab)
          ])
        return
      case 'favicon':
        if (tab)
          this.emitAll('tabs', 'onUpdated', [
            chromeTabId,
            { favIconUrl: (payload as ViewEventPayloads['favicon']).url },
            this.chromeTab(tab)
          ])
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
    const win = this.windowOf()
    const active = this.browser.tabs.activeTabFor(win)?.id ?? null
    const tabs = Object.values(this.browser.tabs.model.tabs)
    const ids = new Set(tabs.map((t) => t.id))
    for (const tab of tabs) {
      if (!this.knownTabIds.has(tab.id)) this.emitAll('tabs', 'onCreated', [this.chromeTab(tab)])
    }
    for (const id of this.knownTabIds) {
      if (!ids.has(id)) {
        const chromeId = this.chromeTabIds.get(id)
        if (chromeId !== undefined) {
          this.emitAll('tabs', 'onRemoved', [chromeId, { windowId: 1, isWindowClosing: false }])
          this.router.unregisterTab(id)
        }
      }
    }
    this.knownTabIds = ids
    if (active !== this.activeTabId) {
      this.activeTabId = active
      if (active)
        this.emitAll('tabs', 'onActivated', [{ tabId: this.chromeTabIdFor(active), windowId: 1 }])
    }
  }

  private onBackgroundReady(id: string): void {
    const ext = this.loaded.get(id)
    if (!ext?.manifest) return
    const previous = this.data.installed[id]
    if (previous !== ext.manifest.version) {
      this.data.installed[id] = ext.manifest.version
      this.save()
      this.emit(id, 'runtime', 'onInstalled', [
        previous ? { reason: 'update', previousVersion: previous } : { reason: 'install' }
      ])
    }
    this.emit(id, 'runtime', 'onStartup', [])
    this.restoreAlarms(id)
  }

  // ---------------------------------------------------------------------------
  // Events to endpoints
  // ---------------------------------------------------------------------------

  /** Raise `chrome.<ns>.<name>` in every endpoint of one extension that registered a listener. */
  private emit(
    extensionId: string,
    ns: string,
    name: string,
    args: unknown[],
    contexts?: ShimContextKind[]
  ): void {
    const key = `${ns}.${name}`
    for (const endpoint of this.router.of(extensionId)) {
      if (contexts && !contexts.includes(endpoint.context)) continue
      if (!this.listening.get(endpoint.id)?.has(key)) continue
      this.router['outbox'].send(endpoint.id, { t: 'event', ns, name, args })
    }
  }

  private emitAll(ns: string, name: string, args: unknown[]): void {
    for (const ext of this.enabled()) this.emit(ext.id, ns, name, args)
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
  // Tabs model mapping
  // ---------------------------------------------------------------------------

  private chromeTabIdFor(tabId: string): number {
    let id = this.chromeTabIds.get(tabId)
    if (id === undefined) {
      id = this.nextTabId++
      this.chromeTabIds.set(tabId, id)
      this.coreTabIds.set(id, tabId)
    }
    return id
  }

  private chromeTab(tab: Tab): Record<string, unknown> {
    const win = this.windowOf()
    const active = this.browser.tabs.activeTabFor(win)?.id === tab.id
    const space = tab.spaceId
      ? this.browser.tabs.model.spaces.find((s) => s.id === tab.spaceId)
      : undefined
    const index = space ? space.tabIds.indexOf(tab.id) : 0
    const size = win.host.contentSize()
    return {
      id: this.chromeTabIdFor(tab.id),
      index: index < 0 ? 0 : index,
      windowId: 1,
      groupId: -1,
      openerTabId: undefined,
      active,
      highlighted: active,
      selected: active,
      pinned: tab.pinned || tab.essential,
      audible: tab.audible,
      discarded: tab.discarded,
      autoDiscardable: true,
      frozen: tab.frozen,
      mutedInfo: { muted: tab.muted },
      url: tab.url,
      pendingUrl: tab.loading ? tab.url : undefined,
      title: tab.customTitle ?? tab.title,
      favIconUrl: tab.favicon ?? undefined,
      status: tab.loading ? 'loading' : tab.discarded ? 'unloaded' : 'complete',
      incognito: this.browser.tabs.isPrivate(tab),
      width: size.width,
      height: size.height,
      lastAccessed: tab.lastActiveAt
    }
  }

  private tabByChromeId(value: unknown): Tab {
    const id = asNumber(value)
    if (id === null) throw new Error('A tab id is required.')
    const coreId = this.coreTabIds.get(id)
    const tab = coreId ? this.browser.tabs.tab(coreId) : undefined
    if (!tab) throw new Error(`No tab with id: ${id}.`)
    return tab
  }

  private chromeWindow(): Record<string, unknown> {
    const win = this.windowOf()
    const size = win.host.contentSize()
    return {
      id: 1,
      focused: win.host.isFocused(),
      top: 0,
      left: 0,
      width: size.width,
      height: size.height,
      incognito: win.isPrivate,
      type: 'normal',
      state: win.host.isFullScreen() ? 'fullscreen' : 'maximized',
      alwaysOnTop: false,
      tabs: Object.values(this.browser.tabs.model.tabs).map((t) => this.chromeTab(t))
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
    const ext = this.loaded.get(endpoint.extensionId)
    if (!ext?.manifest) throw new Error('Extension is not loaded.')
    switch (ns) {
      case 'storage':
        return this.storageCall(ext.id, method, args)
      case 'tabs':
        return this.tabsCall(ext, endpoint, method, args)
      case 'windows':
        return this.windowsCall(method, args)
      case 'action':
      case 'browserAction':
      case 'pageAction':
        return this.actionCall(ext, endpoint, method, args)
      case 'scripting':
        return this.scriptingCall(ext, endpoint, method, args)
      case 'alarms':
        return this.alarmsCall(ext.id, method, args)
      case 'runtime':
        return this.runtimeCall(ext, endpoint, method)
      case 'declarativeNetRequest':
        return this.dnrCall(ext, method, args)
      case 'notifications':
        return this.notificationsCall(method, args)
      case 'contextMenus':
        return this.contextMenusCall(ext.id, method, args)
      case 'webNavigation':
        return this.webNavigationCall(ext.id, method, args)
      case 'cookies':
        return this.cookiesCall(method, args)
      case 'history':
        return this.historyCall(method, args)
      case 'bookmarks':
        return this.bookmarksCall(method, args)
      case 'permissions':
        return this.permissionsCall(ext.manifest, method, args)
      case 'management':
        return this.managementCall(ext, method, args)
      case 'commands':
        if (method === 'getAll')
          return ext.manifest.commands.map((c) => ({
            name: c.name,
            description: c.description,
            shortcut: ''
          }))
        break
      case 'idle':
        if (method === 'queryState') return 'active'
        break
      case 'offscreen':
        if (method === 'hasDocument') return false
        if (method === 'closeDocument') return undefined
        break
      case 'downloads':
        if (method === 'download') {
          const url = String(asRecord(args[0]).url ?? '')
          if (!url) throw new Error('A url is required.')
          this.browser.tabs.createTab({ url, active: false }, this.windowOf())
          return this.nextTabId
        }
        break
      case 'userScripts':
        return this.userScriptsCall(ext, method, args)
    }
    throw new Error(`chrome.${ns}.${method} ${NOT_IMPLEMENTED}`)
  }

  // --- storage ---------------------------------------------------------------

  private storageFor(id: string): { store: JsonStore<StorageDoc>; doc: StorageDoc } {
    let entry = this.storageDocs.get(id)
    if (!entry) {
      const store = new JsonStore<StorageDoc>(
        this.browser.platform.io,
        `ext-storage-${id}.json`,
        200
      )
      const saved = store.readSync()
      const doc = emptyStorageDoc()
      if (saved) {
        doc.local = asRecord(saved.local)
        doc.sync = asRecord(saved.sync)
      }
      entry = { store, doc }
      this.storageDocs.set(id, entry)
    }
    return entry
  }

  private storageCall(id: string, method: string, args: unknown[]): unknown {
    const area = String(args[0]) as StorageArea
    if (!['local', 'sync', 'session', 'managed'].includes(area))
      throw new Error(`Unknown storage area ${area}`)
    const entry = this.storageFor(id)
    const data = entry.doc[area]
    const persist = (): void => {
      if (area === 'local' || area === 'sync')
        entry.store.write({ ...entry.doc, session: {}, managed: {} })
    }
    const notify = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>): void => {
      if (Object.keys(changes).length === 0) return
      this.emit(id, 'storage', 'onChanged', [changes, area])
    }
    switch (method) {
      case 'get': {
        const keys = args[1] as string[] | null
        if (keys === null || keys === undefined) return structuredClone(data)
        const out: Record<string, unknown> = {}
        for (const key of keys) if (key in data) out[key] = structuredClone(data[key])
        return out
      }
      case 'getKeys':
        return Object.keys(data)
      case 'getBytesInUse': {
        const keys = args[1] as string[] | null
        if (!keys) return bytesOf(data)
        const subset: Record<string, unknown> = {}
        for (const key of keys) if (key in data) subset[key] = data[key]
        return bytesOf(subset)
      }
      case 'set': {
        if (area === 'managed') throw new Error('This is a read-only store.')
        const items = asRecord(args[1])
        const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {}
        for (const [key, value] of Object.entries(items)) {
          if (value === undefined) continue
          const cloned = structuredClone(value)
          const change: { oldValue?: unknown; newValue?: unknown } = { newValue: cloned }
          if (key in data) change.oldValue = data[key]
          data[key] = cloned
          changes[key] = change
        }
        persist()
        notify(changes)
        return undefined
      }
      case 'remove': {
        const keys = asStringArray(args[1])
        const changes: Record<string, { oldValue?: unknown }> = {}
        for (const key of keys) {
          if (!(key in data)) continue
          changes[key] = { oldValue: data[key] }
          delete data[key]
        }
        persist()
        notify(changes)
        return undefined
      }
      case 'clear': {
        const changes: Record<string, { oldValue?: unknown }> = {}
        for (const key of Object.keys(data)) {
          changes[key] = { oldValue: data[key] }
          delete data[key]
        }
        persist()
        notify(changes)
        return undefined
      }
    }
    throw new Error(`chrome.storage.${method} ${NOT_IMPLEMENTED}`)
  }

  // --- tabs ------------------------------------------------------------------

  private tabsCall(ext: Loaded, endpoint: Endpoint, method: string, args: unknown[]): unknown {
    const win = this.windowOf()
    const tabs = this.browser.tabs
    switch (method) {
      case 'query': {
        const q = asRecord(args[0])
        const active = tabs.activeTabFor(win)?.id
        const all = Object.values(tabs.model.tabs)
        return all
          .filter((tab) => {
            if (q.active !== undefined && (tab.id === active) !== Boolean(q.active)) return false
            if (q.pinned !== undefined && (tab.pinned || tab.essential) !== Boolean(q.pinned))
              return false
            if (q.audible !== undefined && tab.audible !== Boolean(q.audible)) return false
            if (q.discarded !== undefined && tab.discarded !== Boolean(q.discarded)) return false
            if (q.status !== undefined && (tab.loading ? 'loading' : 'complete') !== q.status)
              return false
            if (
              q.title !== undefined &&
              !globToRegExp(String(q.title)).test(tab.customTitle ?? tab.title)
            )
              return false
            if (q.url !== undefined) {
              const patterns = Array.isArray(q.url) ? q.url.map(String) : [String(q.url)]
              if (!patterns.some((p) => urlPatternMatches(p, tab.url))) return false
            }
            if (q.windowId !== undefined && q.windowId !== -2 && q.windowId !== 1) return false
            if (q.currentWindow !== undefined && q.currentWindow === false) return false
            if (q.lastFocusedWindow !== undefined && q.lastFocusedWindow === false) return false
            return true
          })
          .map((tab) => this.chromeTab(tab))
      }
      case 'get':
        return this.chromeTab(this.tabByChromeId(args[0]))
      case 'getCurrent': {
        // Extension pages have no tab of their own; content scripts get theirs.
        if (endpoint.context === 'content' && endpoint.tabId) {
          const tab = tabs.tab(endpoint.tabId)
          return tab ? this.chromeTab(tab) : undefined
        }
        return undefined
      }
      case 'create': {
        const props = asRecord(args[0])
        const tab = tabs.createTab(
          {
            url: typeof props.url === 'string' ? props.url : undefined,
            active: props.active === undefined ? true : Boolean(props.active),
            pinned: Boolean(props.pinned)
          },
          win
        )
        return this.chromeTab(tab)
      }
      case 'update': {
        const [first, second] = args
        const props = asRecord(second ?? first)
        const target = asNumber(first) !== null ? this.tabByChromeId(first) : tabs.activeTabFor(win)
        if (!target) throw new Error('No active tab.')
        if (typeof props.url === 'string') tabs.navigate(target.id, props.url)
        if (props.active === true) tabs.activateTab(target.id, win)
        if (props.muted !== undefined && Boolean(props.muted) !== target.muted)
          tabs.toggleMute(target.id)
        if (props.pinned !== undefined && Boolean(props.pinned) !== target.pinned)
          tabs.togglePin(target.id, win)
        return this.chromeTab(tabs.tab(target.id) ?? target)
      }
      case 'remove': {
        const ids = Array.isArray(args[0]) ? args[0] : [args[0]]
        for (const id of ids) tabs.closeTab(this.tabByChromeId(id).id, true, win)
        return undefined
      }
      case 'reload': {
        const target =
          asNumber(args[0]) !== null ? this.tabByChromeId(args[0]) : tabs.activeTabFor(win)
        if (target) tabs.reload(target.id, Boolean(asRecord(args[1]).bypassCache))
        return undefined
      }
      case 'duplicate': {
        const copy = tabs.duplicate(this.tabByChromeId(args[0]).id, win)
        return copy ? this.chromeTab(copy) : undefined
      }
      case 'getZoom':
        return (
          (asNumber(args[0]) !== null ? this.tabByChromeId(args[0]) : tabs.activeTabFor(win))
            ?.zoom ?? 1
        )
      case 'setZoom': {
        const [first, second] = args
        const factor = asNumber(second ?? first) ?? 1
        const target =
          asNumber(second) !== null ? this.tabByChromeId(first) : tabs.activeTabFor(win)
        if (target) tabs.setZoom(target.id, factor)
        return undefined
      }
      case 'discard': {
        const target = asNumber(args[0]) !== null ? this.tabByChromeId(args[0]) : undefined
        if (target) tabs.discard(target.id)
        return target ? this.chromeTab(tabs.tab(target.id) ?? target) : undefined
      }
      case 'goBack':
        tabs.goBack(
          (asNumber(args[0]) !== null ? this.tabByChromeId(args[0]) : tabs.activeTabFor(win))?.id ??
            ''
        )
        return undefined
      case 'goForward':
        tabs.goForward(
          (asNumber(args[0]) !== null ? this.tabByChromeId(args[0]) : tabs.activeTabFor(win))?.id ??
            ''
        )
        return undefined
      case 'executeScript': {
        // MV2: [tabId | null, details]
        const [tabIdArg, detailsArg] = args
        const target =
          asNumber(tabIdArg) !== null ? this.tabByChromeId(tabIdArg) : tabs.activeTabFor(win)
        if (!target) throw new Error('No active tab.')
        return this.mv2Inject(ext, target, 'js', asRecord(detailsArg))
      }
      case 'insertCSS': {
        const [tabIdArg, detailsArg] = args
        const target =
          asNumber(tabIdArg) !== null ? this.tabByChromeId(tabIdArg) : tabs.activeTabFor(win)
        if (!target) throw new Error('No active tab.')
        return this.mv2Inject(ext, target, 'css', asRecord(detailsArg))
      }
    }
    throw new Error(`chrome.tabs.${method} ${NOT_IMPLEMENTED}`)
  }

  /** `tabs.executeScript` / `tabs.insertCSS` (MV2): `{ code }` or `{ file }` into the tab's main frame. */
  private async mv2Inject(
    ext: Loaded,
    target: Tab,
    kind: 'js' | 'css',
    details: Record<string, unknown>
  ): Promise<unknown> {
    const code =
      typeof details.code === 'string'
        ? details.code
        : await this.readFile(ext.id, String(details.file ?? ''))
    if (kind === 'js') {
      const result = await this.exec(
        ext.id,
        target.id,
        'js',
        { world: 'ISOLATED' },
        code ?? '',
        null,
        null
      )
      return [result]
    }
    const id = typeof details.file === 'string' ? details.file : (code ?? '')
    return this.exec(ext.id, target.id, 'css', { id, code: code ?? '' }, null, null, null)
  }

  private windowsCall(method: string, args: unknown[]): unknown {
    switch (method) {
      case 'get':
      case 'getCurrent':
      case 'getLastFocused':
        return this.chromeWindow()
      case 'getAll':
        return [this.chromeWindow()]
      case 'create': {
        const props = asRecord(args[0])
        const url = Array.isArray(props.url) ? props.url[0] : props.url
        if (typeof url === 'string')
          this.browser.tabs.createTab({ url, active: true }, this.windowOf())
        return this.chromeWindow()
      }
      case 'update':
        return this.chromeWindow()
    }
    throw new Error(`chrome.windows.${method} ${NOT_IMPLEMENTED}`)
  }

  // --- action / browserAction ------------------------------------------------

  private actionFor(id: string): ActionState {
    let state = this.actions.get(id)
    if (!state) {
      const action = this.loaded.get(id)?.manifest?.action
      state = {
        title: action?.title ?? null,
        popup: action?.popup ?? null,
        badgeText: '',
        badgeBackgroundColor: '#5f6368',
        badgeTextColor: '#ffffff',
        enabled: true
      }
      this.actions.set(id, state)
    }
    return state
  }

  private actionCall(ext: Loaded, endpoint: Endpoint, method: string, args: unknown[]): unknown {
    const state = this.actionFor(ext.id)
    const details = asRecord(args[0])
    const refresh = (): void => this.browser.state.commitVolatile()
    switch (method) {
      case 'setTitle':
        state.title = typeof details.title === 'string' ? details.title : null
        return undefined
      case 'getTitle':
        return state.title ?? ext.manifest?.name ?? ''
      case 'setIcon':
        // Toolbar icons stay the manifest's; per-tab imageData / path variants are not drawn yet.
        return undefined
      case 'setPopup':
        state.popup =
          typeof details.popup === 'string' && details.popup !== '' ? details.popup : null
        refresh()
        return undefined
      case 'getPopup':
        return state.popup ? extensionUrl(ext.id, state.popup) : ''
      case 'setBadgeText':
        state.badgeText = typeof details.text === 'string' ? details.text : ''
        return undefined
      case 'getBadgeText':
        return state.badgeText
      case 'setBadgeBackgroundColor':
        state.badgeBackgroundColor = colorString(details.color) ?? state.badgeBackgroundColor
        return undefined
      case 'getBadgeBackgroundColor':
        return colorArray(state.badgeBackgroundColor)
      case 'setBadgeTextColor':
        state.badgeTextColor = colorString(details.color) ?? state.badgeTextColor
        return undefined
      case 'getBadgeTextColor':
        return colorArray(state.badgeTextColor)
      case 'enable':
      case 'show':
        state.enabled = true
        return undefined
      case 'disable':
      case 'hide':
        state.enabled = false
        return undefined
      case 'isEnabled':
        return state.enabled
      case 'openPopup':
        this.openPopup(ext.id, { x: 0, y: 0, width: 0, height: 0 }, this.windowOf())
        return undefined
      case 'getUserSettings':
        return { isOnToolbar: true }
    }
    void endpoint
    throw new Error(`chrome.action.${method} ${NOT_IMPLEMENTED}`)
  }

  // --- scripting -------------------------------------------------------------

  private async readFile(id: string, path: string): Promise<string | null> {
    if (!path) return null
    return this.bridge.call<string | null>('ext.readFile', { id, path })
  }

  private exec(
    extensionId: string,
    tabId: string,
    kind: 'js' | 'css',
    payload: Record<string, unknown>,
    code: string | null,
    funcSource: string | null,
    fnArgs: unknown[] | null
  ): Promise<unknown> {
    return this.bridge.call<unknown>('ext.exec', {
      tabId,
      ext: extensionId,
      kind,
      payload,
      code,
      funcSource,
      args: fnArgs
    })
  }

  private async scriptingCall(
    ext: Loaded,
    endpoint: Endpoint,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const injection = asRecord(args[0])
    const target = asRecord(injection.target)
    const resolveTab = (): Tab => {
      if (target.tabId !== undefined) return this.tabByChromeId(target.tabId)
      const tab = this.browser.tabs.activeTabFor(this.windowOf())
      if (!tab) throw new Error('No active tab.')
      return tab
    }
    switch (method) {
      case 'executeScript': {
        const tab = resolveTab()
        const world = injection.world === 'MAIN' ? 'MAIN' : 'ISOLATED'
        if (typeof injection.funcSource === 'string') {
          const result = await this.exec(
            ext.id,
            tab.id,
            'js',
            { world },
            null,
            injection.funcSource,
            Array.isArray(injection.args) ? injection.args : []
          )
          return [{ frameId: 0, documentId: '', result }]
        }
        const files = asStringArray(injection.files)
        const sources: string[] = []
        for (const file of files) {
          const text = await this.readFile(ext.id, file)
          if (text === null) throw new Error(`Could not load file: '${file}'.`)
          sources.push(text)
        }
        const result = await this.exec(
          ext.id,
          tab.id,
          'js',
          { world },
          sources.join('\n;\n'),
          null,
          null
        )
        return [{ frameId: 0, documentId: '', result }]
      }
      case 'insertCSS':
      case 'removeCSS': {
        const tab = resolveTab()
        const remove = method === 'removeCSS'
        if (typeof injection.css === 'string') {
          await this.exec(
            ext.id,
            tab.id,
            'css',
            { id: injection.css, code: injection.css, remove },
            null,
            null,
            null
          )
          return undefined
        }
        for (const file of asStringArray(injection.files)) {
          const text = remove ? '' : await this.readFile(ext.id, file)
          if (!remove && text === null) throw new Error(`Could not load file: '${file}'.`)
          await this.exec(
            ext.id,
            tab.id,
            'css',
            { id: file, code: text ?? '', remove },
            null,
            null,
            null
          )
        }
        return undefined
      }
      case 'registerContentScripts': {
        const list = this.data.registered[ext.id] ?? []
        for (const raw of Array.isArray(args[0]) ? args[0] : []) {
          const script = registeredFrom(asRecord(raw))
          if (list.some((s) => s.id === script.id))
            throw new Error(`Duplicate script ID '${script.id}'`)
          list.push(script)
        }
        this.data.registered[ext.id] = list
        this.save()
        await this.configure()
        return undefined
      }
      case 'getRegisteredContentScripts': {
        const filter = asStringArray(asRecord(args[0]).ids)
        return (this.data.registered[ext.id] ?? [])
          .filter((s) => filter.length === 0 || filter.includes(s.id))
          .map(registeredToChrome)
      }
      case 'unregisterContentScripts': {
        const filter = asStringArray(asRecord(args[0]).ids)
        this.data.registered[ext.id] = (this.data.registered[ext.id] ?? []).filter(
          (s) => filter.length > 0 && !filter.includes(s.id)
        )
        this.save()
        await this.configure()
        return undefined
      }
      case 'updateContentScripts': {
        const list = this.data.registered[ext.id] ?? []
        for (const raw of Array.isArray(args[0]) ? args[0] : []) {
          const patch = asRecord(raw)
          const index = list.findIndex((s) => s.id === patch.id)
          if (index === -1) throw new Error(`Script with ID '${String(patch.id)}' does not exist`)
          list[index] = registeredFrom({ ...registeredToChrome(list[index]), ...patch })
        }
        this.save()
        await this.configure()
        return undefined
      }
    }
    void endpoint
    throw new Error(`chrome.scripting.${method} ${NOT_IMPLEMENTED}`)
  }

  private async userScriptsCall(ext: Loaded, method: string, args: unknown[]): Promise<unknown> {
    // User scripts run in their own world in Chrome; here they share the extension's scope.
    switch (method) {
      case 'register':
        return this.scriptingCall(
          ext,
          this.router.of(ext.id)[0] ?? ({} as Endpoint),
          'registerContentScripts',
          [
            (Array.isArray(args[0]) ? args[0] : []).map((raw) => {
              const script = asRecord(raw)
              const js = Array.isArray(script.js) ? script.js.map((j) => asRecord(j).file) : []
              return { ...script, js: asStringArray(js) }
            })
          ]
        )
      case 'getScripts':
        return (this.data.registered[ext.id] ?? []).map(registeredToChrome)
      case 'unregister':
        return this.scriptingCall(ext, {} as Endpoint, 'unregisterContentScripts', args)
      case 'update':
        return this.scriptingCall(ext, {} as Endpoint, 'updateContentScripts', args)
    }
    throw new Error(`chrome.userScripts.${method} ${NOT_IMPLEMENTED}`)
  }

  // --- alarms ----------------------------------------------------------------

  private alarmsCall(id: string, method: string, args: unknown[]): unknown {
    const list = this.data.alarms[id] ?? []
    switch (method) {
      case 'create': {
        const [first, second] = args
        const name = typeof first === 'string' ? first : ''
        const info = asRecord(typeof first === 'string' ? second : first)
        const when = asNumber(info.when)
        const delay = asNumber(info.delayInMinutes)
        const period = asNumber(info.periodInMinutes)
        const scheduledTime = when ?? Date.now() + (delay ?? period ?? 0) * 60_000
        const alarm: Alarm = { name, scheduledTime }
        if (period !== null) alarm.periodInMinutes = period
        this.data.alarms[id] = [...list.filter((a) => a.name !== name), alarm]
        this.save()
        this.scheduleAlarm(id, alarm)
        return undefined
      }
      case 'get':
        return list.find((a) => a.name === (typeof args[0] === 'string' ? args[0] : ''))
      case 'getAll':
        return list
      case 'clear': {
        const name = typeof args[0] === 'string' ? args[0] : ''
        const existed = list.some((a) => a.name === name)
        this.data.alarms[id] = list.filter((a) => a.name !== name)
        this.cancelAlarm(id, name)
        this.save()
        return existed
      }
      case 'clearAll':
        for (const alarm of list) this.cancelAlarm(id, alarm.name)
        this.data.alarms[id] = []
        this.save()
        return true
    }
    throw new Error(`chrome.alarms.${method} ${NOT_IMPLEMENTED}`)
  }

  private restoreAlarms(id: string): void {
    for (const alarm of this.data.alarms[id] ?? []) this.scheduleAlarm(id, alarm)
  }

  private scheduleAlarm(id: string, alarm: Alarm): void {
    this.cancelAlarm(id, alarm.name)
    const delay = Math.max(0, alarm.scheduledTime - Date.now())
    const timer = setTimeout(() => {
      this.alarmTimers.delete(`${id}\u0000${alarm.name}`)
      const current = (this.data.alarms[id] ?? []).find((a) => a.name === alarm.name)
      if (!current) return
      this.emit(id, 'alarms', 'onAlarm', [{ ...current }], ['background'])
      if (current.periodInMinutes) {
        current.scheduledTime = Date.now() + current.periodInMinutes * 60_000
        this.scheduleAlarm(id, current)
      } else {
        this.data.alarms[id] = (this.data.alarms[id] ?? []).filter((a) => a.name !== alarm.name)
      }
      this.save()
    }, delay)
    this.alarmTimers.set(`${id}\u0000${alarm.name}`, timer)
  }

  private cancelAlarm(id: string, name: string): void {
    const key = `${id}\u0000${name}`
    const timer = this.alarmTimers.get(key)
    if (timer) clearTimeout(timer)
    this.alarmTimers.delete(key)
  }

  // --- runtime ---------------------------------------------------------------

  private async runtimeCall(ext: Loaded, endpoint: Endpoint, method: string): Promise<unknown> {
    switch (method) {
      case 'openOptionsPage': {
        const options = ext.manifest?.options
        if (!options) throw new Error('Could not create an options page.')
        this.popupOpen = ext.id
        this.bridge.send('ext.popup.open', {
          id: ext.id,
          url: extensionUrl(ext.id, options.page),
          context: 'options'
        })
        return undefined
      }
      case 'reload':
        await this.configure()
        return undefined
      case 'getContexts':
        return this.router.of(ext.id).map((e) => ({
          contextId: e.id,
          contextType: contextTypeOf(e.context),
          documentId: e.id,
          documentOrigin: e.url ? safeOrigin(e.url) : '',
          documentUrl: e.url,
          frameId: e.frameId,
          incognito: false,
          tabId: e.tabId ? this.chromeTabIdFor(e.tabId) : -1,
          windowId: 1
        }))
    }
    void endpoint
    throw new Error(`chrome.runtime.${method} ${NOT_IMPLEMENTED}`)
  }

  // --- declarativeNetRequest ---------------------------------------------------

  private async dnrCall(ext: Loaded, method: string, args: unknown[]): Promise<unknown> {
    const manifest = ext.manifest
    if (!manifest) throw new Error('Extension is not loaded.')
    const origin = extensionUrl(ext.id, '').replace(/\/$/, '')
    const options = asRecord(args[0])
    switch (method) {
      case 'updateDynamicRules':
      case 'updateSessionRules': {
        const dynamic = method === 'updateDynamicRules'
        const current = dynamic
          ? (this.data.dynamicRules[ext.id] ?? [])
          : (this.sessionRules.get(ext.id) ?? [])
        const removeIds = new Set(
          (Array.isArray(options.removeRuleIds) ? options.removeRuleIds : []).map(Number)
        )
        const added = normalizeRuleset(options.addRules ?? [], origin)
        const next = [...current.filter((r) => !removeIds.has(r.id)), ...added]
        if (dynamic) {
          this.data.dynamicRules[ext.id] = next
          this.save()
        } else this.sessionRules.set(ext.id, next)
        await this.pushRules()
        return undefined
      }
      case 'getDynamicRules':
        return (this.data.dynamicRules[ext.id] ?? []).map(ruleToChrome)
      case 'getSessionRules':
        return (this.sessionRules.get(ext.id) ?? []).map(ruleToChrome)
      case 'updateEnabledRulesets': {
        const enabled = new Set(
          this.data.enabledRulesets[ext.id] ??
            manifest.rulesets.filter((r) => r.enabled).map((r) => r.id)
        )
        for (const id of asStringArray(options.disableRulesetIds)) enabled.delete(id)
        for (const id of asStringArray(options.enableRulesetIds)) enabled.add(id)
        this.data.enabledRulesets[ext.id] = [...enabled]
        this.save()
        await this.pushRules()
        return undefined
      }
      case 'getEnabledRulesets':
        return (
          this.data.enabledRulesets[ext.id] ??
          manifest.rulesets.filter((r) => r.enabled).map((r) => r.id)
        )
      case 'updateStaticRules':
        // Per-rule disabling inside a static ruleset: accepted, not applied (the matcher has no per-id switch yet).
        return undefined
      case 'getDisabledRuleIds':
        return []
      case 'getMatchedRules':
        return { rulesMatchedInfo: [] }
    }
    throw new Error(`chrome.declarativeNetRequest.${method} ${NOT_IMPLEMENTED}`)
  }

  // --- notifications / contextMenus / webNavigation ----------------------------

  private notificationsCall(method: string, args: unknown[]): unknown {
    switch (method) {
      case 'create': {
        const [first, second] = args
        const id = typeof first === 'string' ? first : `n${Date.now()}`
        const options = asRecord(typeof first === 'string' ? second : first)
        const text = [options.title, options.message]
          .filter((v) => typeof v === 'string' && v)
          .join(': ')
        if (text) this.browser.toast(text, 'info', this.windowOf())
        return id
      }
      case 'update':
        return false
      case 'clear':
        return true
      case 'getAll':
        return {}
    }
    throw new Error(`chrome.notifications.${method} ${NOT_IMPLEMENTED}`)
  }

  private contextMenusCall(id: string, method: string, args: unknown[]): unknown {
    let menus = this.contextMenus.get(id)
    if (!menus) {
      menus = new Map()
      this.contextMenus.set(id, menus)
    }
    switch (method) {
      case 'create': {
        const props = asRecord(args[0])
        const menuId = String(props.id ?? menus.size + 1)
        menus.set(menuId, props)
        return menuId
      }
      case 'update': {
        const menuId = String(args[0])
        const existing = menus.get(menuId)
        if (!existing) throw new Error(`Cannot find menu item with id ${menuId}`)
        menus.set(menuId, { ...existing, ...asRecord(args[1]) })
        return undefined
      }
      case 'remove':
        menus.delete(String(args[0]))
        return undefined
      case 'removeAll':
        menus.clear()
        return undefined
    }
    throw new Error(`chrome.contextMenus.${method} ${NOT_IMPLEMENTED}`)
  }

  private webNavigationCall(id: string, method: string, args: unknown[]): unknown {
    const details = asRecord(args[0])
    const frames = (tabId: number): Array<Record<string, unknown>> => {
      const coreId = this.coreTabIds.get(tabId)
      return this.router
        .of(id, 'content')
        .filter((e) => e.tabId === coreId)
        .map((e) => ({
          frameId: e.frameId,
          parentFrameId: e.frameId === 0 ? -1 : 0,
          url: e.url,
          documentId: e.id,
          errorOccurred: false,
          processId: 0
        }))
    }
    switch (method) {
      case 'getFrame':
        return (
          frames(Number(details.tabId)).find((f) => f.frameId === Number(details.frameId ?? 0)) ??
          null
        )
      case 'getAllFrames':
        return frames(Number(details.tabId))
    }
    throw new Error(`chrome.webNavigation.${method} ${NOT_IMPLEMENTED}`)
  }

  // --- cookies / history / bookmarks / permissions / management ---------------

  private async cookiesCall(method: string, args: unknown[]): Promise<unknown> {
    const details = asRecord(args[0])
    const url = typeof details.url === 'string' ? details.url : ''
    switch (method) {
      case 'get':
      case 'getAll': {
        if (!url)
          throw new Error('A url is required (Zenium for Android reads cookies by URL only).')
        const header = await this.bridge.call<string | null>('ext.cookies.get', { url })
        const domain = safeHost(url)
        const cookies = (header ?? '')
          .split(';')
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            const eq = part.indexOf('=')
            return {
              name: eq === -1 ? part : part.slice(0, eq),
              value: eq === -1 ? '' : part.slice(eq + 1),
              domain,
              hostOnly: true,
              path: '/',
              secure: url.startsWith('https:'),
              httpOnly: false,
              sameSite: 'unspecified',
              session: true,
              storeId: '0'
            }
          })
        if (method === 'getAll')
          return cookies.filter((c) => details.name === undefined || c.name === details.name)
        return cookies.find((c) => c.name === details.name) ?? null
      }
      case 'set': {
        if (!url) throw new Error('A url is required.')
        const parts = [`${String(details.name ?? '')}=${String(details.value ?? '')}`]
        if (typeof details.path === 'string') parts.push(`Path=${details.path}`)
        if (typeof details.domain === 'string') parts.push(`Domain=${details.domain}`)
        if (details.secure) parts.push('Secure')
        if (typeof details.expirationDate === 'number')
          parts.push(`Expires=${new Date(details.expirationDate * 1000).toUTCString()}`)
        await this.bridge.call('ext.cookies.set', { url, cookie: parts.join('; ') })
        return {
          name: details.name,
          value: details.value,
          domain: safeHost(url),
          path: details.path ?? '/'
        }
      }
      case 'remove':
        await this.bridge.call('ext.cookies.set', {
          url,
          cookie: `${String(details.name ?? '')}=; Max-Age=0`
        })
        return { url, name: details.name, storeId: '0' }
    }
    throw new Error(`chrome.cookies.${method} ${NOT_IMPLEMENTED}`)
  }

  private historyCall(method: string, args: unknown[]): unknown {
    const history = this.browser.history
    const details = asRecord(args[0])
    switch (method) {
      case 'search': {
        const text = String(details.text ?? '')
        const max = asNumber(details.maxResults) ?? 100
        const entries = text ? history.search(text, max) : history.recent(max)
        return entries.map((e, i) => ({
          id: String(i),
          url: e.url,
          title: e.title,
          lastVisitTime: e.lastVisit,
          visitCount: e.visitCount,
          typedCount: 0
        }))
      }
      case 'addUrl':
        history.visit(String(details.url ?? ''), String(details.title ?? ''), null)
        return undefined
      case 'deleteUrl':
        history.delete(String(details.url ?? ''))
        return undefined
      case 'deleteAll':
        history.clear()
        return undefined
    }
    throw new Error(`chrome.history.${method} ${NOT_IMPLEMENTED}`)
  }

  private bookmarksCall(method: string, args: unknown[]): unknown {
    const bookmarks = this.browser.bookmarks
    const node = (
      b: { id: string; url: string; title: string; createdAt: number },
      index: number
    ): Record<string, unknown> => ({
      id: b.id,
      parentId: '1',
      index,
      url: b.url,
      title: b.title,
      dateAdded: b.createdAt
    })
    const root = (): Record<string, unknown> => ({
      id: '0',
      title: '',
      children: [
        {
          id: '1',
          parentId: '0',
          index: 0,
          title: 'Bookmarks',
          children: bookmarks.all().map(node)
        }
      ]
    })
    switch (method) {
      case 'getTree':
        return [root()]
      case 'getSubTree':
      case 'getChildren':
        return String(args[0]) === '0' ? [root()] : bookmarks.all().map(node)
      case 'getRecent':
        return bookmarks
          .all()
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, asNumber(args[0]) ?? 20)
          .map(node)
      case 'get': {
        const ids = new Set((Array.isArray(args[0]) ? args[0] : [args[0]]).map(String))
        return bookmarks
          .all()
          .filter((b) => ids.has(b.id))
          .map(node)
      }
      case 'search': {
        const query = typeof args[0] === 'string' ? args[0] : String(asRecord(args[0]).query ?? '')
        return bookmarks.search(query, 100).map(node)
      }
      case 'create': {
        const props = asRecord(args[0])
        const created =
          typeof props.url === 'string'
            ? bookmarks.add(props.url, String(props.title ?? props.url))
            : null
        if (!created) throw new Error('Could not create bookmark.')
        return node(created, bookmarks.all().length - 1)
      }
      case 'update': {
        const existing = bookmarks.all().find((b) => b.id === String(args[0]))
        if (!existing) throw new Error("Can't find bookmark for id.")
        const changes = asRecord(args[1])
        bookmarks.upsert({
          ...existing,
          title: typeof changes.title === 'string' ? changes.title : existing.title,
          url: typeof changes.url === 'string' ? changes.url : existing.url
        })
        return node(existing, 0)
      }
      case 'remove':
        bookmarks.remove(String(args[0]))
        return undefined
    }
    throw new Error(`chrome.bookmarks.${method} ${NOT_IMPLEMENTED}`)
  }

  private permissionsCall(manifest: RuntimeManifest, method: string, args: unknown[]): unknown {
    const wanted = asRecord(args[0])
    const permissions = asStringArray(wanted.permissions)
    const origins = asStringArray(wanted.origins)
    const has = (): boolean =>
      permissions.every((p) => manifest.permissions.includes(p)) &&
      origins.every(
        (o) =>
          manifest.hostPermissions.includes(o) || manifest.hostPermissions.includes('<all_urls>')
      )
    switch (method) {
      case 'contains':
        return has()
      case 'getAll':
        return { permissions: manifest.permissions, origins: manifest.hostPermissions }
      case 'request':
        // Optional permissions are granted without a prompt in the prototype (they are declared in the manifest).
        return (
          permissions.every(
            (p) => manifest.permissions.includes(p) || manifest.optionalPermissions.includes(p)
          ) &&
          origins.every(
            (o) =>
              manifest.hostPermissions.includes(o) || manifest.optionalHostPermissions.includes(o)
          )
        )
      case 'remove':
        return false
    }
    throw new Error(`chrome.permissions.${method} ${NOT_IMPLEMENTED}`)
  }

  private managementCall(ext: Loaded, method: string, args: unknown[]): unknown {
    const info = (e: Loaded): Record<string, unknown> => ({
      id: e.id,
      name: e.manifest?.name ?? e.id,
      shortName: e.manifest?.name ?? e.id,
      description: e.manifest?.description ?? '',
      version: e.manifest?.version ?? '',
      mayDisable: true,
      enabled: !this.data.disabled.includes(e.id),
      isApp: false,
      type: 'extension',
      installType: 'development',
      permissions: e.manifest?.permissions ?? [],
      hostPermissions: e.manifest?.hostPermissions ?? [],
      icons: Object.entries(e.manifest?.icons ?? {}).map(([size, path]) => ({
        size: Number(size),
        url: extensionUrl(e.id, path)
      }))
    })
    switch (method) {
      case 'getSelf':
        return info(ext)
      case 'getAll':
        return [...this.loaded.values()].map(info)
      case 'get': {
        const target = this.loaded.get(String(args[0]))
        if (!target) throw new Error(`Failed to find extension with id ${String(args[0])}.`)
        return info(target)
      }
      case 'uninstallSelf':
        this.remove(ext.id)
        return undefined
    }
    throw new Error(`chrome.management.${method} ${NOT_IMPLEMENTED}`)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Synchronous-looking await for the MV2 tab helpers that mix sync and async branches. */
function globToRegExp(glob: string): RegExp {
  return new RegExp(
    '^' +
      glob
        .split('*')
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$'
  )
}

/** `tabs.query({ url })` takes match patterns; the URL is compared scheme://host/path. */
function urlPatternMatches(pattern: string, url: string): boolean {
  const parsed = parseMatchPattern(pattern)
  const parts = splitUrl(url)
  return parsed !== null && parts !== null && matchPatternTest(parsed, parts)
}

function colorString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length >= 3) {
    const [r, g, b, a] = value.map(Number)
    return `rgba(${r}, ${g}, ${b}, ${a === undefined ? 1 : a / 255})`
  }
  return null
}

function colorArray(value: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value)
  if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16), 255]
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value)
  if (rgba) {
    const [r, g, b, a] = rgba[1].split(',').map((s) => Number(s.trim()))
    return [r || 0, g || 0, b || 0, a === undefined ? 255 : Math.round(a * 255)]
  }
  return [0, 0, 0, 255]
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function contextTypeOf(context: ShimContextKind): string {
  switch (context) {
    case 'background':
      return 'BACKGROUND'
    case 'popup':
      return 'POPUP'
    case 'options':
    case 'page':
      return 'TAB'
    case 'offscreen':
      return 'OFFSCREEN_DOCUMENT'
    default:
      return 'TAB'
  }
}

function registeredFrom(raw: Record<string, unknown>): RegisteredContentScript {
  const runAt = raw.runAt
  return {
    id: String(raw.id ?? ''),
    persistAcrossSessions: raw.persistAcrossSessions !== false,
    matches: asStringArray(raw.matches),
    excludeMatches: asStringArray(raw.excludeMatches),
    includeGlobs: asStringArray(raw.includeGlobs),
    excludeGlobs: asStringArray(raw.excludeGlobs),
    js: asStringArray(raw.js),
    css: asStringArray(raw.css),
    runAt: (runAt === 'document_start' || runAt === 'document_end'
      ? runAt
      : 'document_idle') as RunAt,
    allFrames: Boolean(raw.allFrames),
    matchAboutBlank: Boolean(raw.matchAboutBlank),
    matchOriginAsFallback: Boolean(raw.matchOriginAsFallback),
    world: raw.world === 'MAIN' ? 'MAIN' : 'ISOLATED'
  }
}

function registeredToChrome(script: RegisteredContentScript): Record<string, unknown> {
  return {
    id: script.id,
    matches: script.matches,
    excludeMatches: script.excludeMatches,
    js: script.js,
    css: script.css,
    runAt: script.runAt,
    allFrames: script.allFrames,
    matchOriginAsFallback: script.matchOriginAsFallback,
    world: script.world,
    persistAcrossSessions: script.persistAcrossSessions
  }
}

/** The normalised rule back in Chrome's shape (what `getDynamicRules` returns). */
function ruleToChrome(rule: NetRule): Record<string, unknown> {
  const condition: Record<string, unknown> = {}
  if (rule.urlFilter !== null) condition.urlFilter = rule.urlFilter
  if (rule.regexFilter !== null) condition.regexFilter = rule.regexFilter
  if (rule.caseSensitive) condition.isUrlFilterCaseSensitive = true
  if (rule.requestDomains.length) condition.requestDomains = rule.requestDomains
  if (rule.excludedRequestDomains.length)
    condition.excludedRequestDomains = rule.excludedRequestDomains
  if (rule.initiatorDomains.length) condition.initiatorDomains = rule.initiatorDomains
  if (rule.excludedInitiatorDomains.length)
    condition.excludedInitiatorDomains = rule.excludedInitiatorDomains
  if (rule.resourceTypes.length) condition.resourceTypes = rule.resourceTypes
  if (rule.excludedResourceTypes.length)
    condition.excludedResourceTypes = rule.excludedResourceTypes
  if (rule.requestMethods.length) condition.requestMethods = rule.requestMethods
  if (rule.excludedRequestMethods.length)
    condition.excludedRequestMethods = rule.excludedRequestMethods
  if (rule.domainType) condition.domainType = rule.domainType
  const action: Record<string, unknown> = { type: rule.action }
  if (rule.action === 'redirect' && rule.redirectUrl) action.redirect = { url: rule.redirectUrl }
  return { id: rule.id, priority: rule.priority, action, condition }
}

export { normalizeRule }
export type { PageContext }
