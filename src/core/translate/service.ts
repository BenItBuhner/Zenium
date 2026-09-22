import type {
  ReaderTranslateState,
  TranslateBatch,
  TranslateModelInfo,
  TranslatePageSample,
  TranslatePreferences,
  TranslateRuntimeStatus,
  TranslateSelectionResult,
  TranslateTabState,
  TranslateUIState
} from '../../shared/translate'
import type { EngineRelayResponse, LanguagePair } from '../../shared/translateEngine'
import {
  TRANSLATE_RUNTIME_MISSING,
  translateCall,
  translateInstallCall,
  type TranslatePageRuntime,
  type TranslateWaitResult
} from '../../shared/translateScript'
import type { Browser } from '../browser'
import type { TabView, TranslateHost } from '../platform'
import type { ZenWindow } from '../window'
import type { ReaderArticle, ReaderArticleTranslation } from '../reader'
import { JsonStore } from '../store/JsonStore'
import { articleSampleText, rebuildUnitHtml, type ArticleUnit } from './articleHtml'
import { decideLanguage, MIN_SAMPLE_CHARS, registryCodeForLabel } from './detect'
import { WorkerEngine, type TranslationEngine } from './engine'
import {
  defaultPreferences,
  defaultTarget,
  languageRule,
  languagesForPreferred,
  offerFor,
  preferredFromLanguages,
  sanitizePreferences,
  siteOf,
  withLanguageRule,
  withSiteRule,
  type LanguageRule
} from './languages'
import { languagesKey, sanitizeLanguages } from '../../shared/languages'
import { ModelManager } from './models'
import {
  condenseRecords,
  ModelRegistry,
  REGISTRY_RECORDS_URL,
  type RegistryCache,
  type RegistryRecord
} from './registry'

/** Characters of page text sampled for language detection. */
const SAMPLE_CHARS = 2000
/** The first batch is small so the viewport changes quickly; later ones fill the engine. */
const FIRST_BATCH = { items: 12, chars: 2500 }
const BATCH = { items: 32, chars: 6000 }
/** How long one long-poll for new page content lasts (well under Android's evaluation limit). */
const WAIT_MS = 15_000
/** The engine (and its loaded models) is dropped after this long without work. */
const ENGINE_IDLE_MS = 5 * 60_000
const SELECTION_MAX_CHARS = 5000
/** Selection detection is trusted from this probability; below it the page language is used. */
const SELECTION_CONFIDENCE = 0.5

interface Persisted {
  preferences: TranslatePreferences
  registry: RegistryCache | null
}

interface TabEntry {
  state: TranslateTabState
  /** Runtime token of the document the state belongs to (0 until the page was sampled). */
  doc: number
  /** Bumped when the page changes or the user reverts; async work checks it before acting. */
  gen: number
  /** The page runtime's session id while a translation runs (0 otherwise). */
  session: number
  abort: AbortController | null
}

export interface TranslatePageOptions {
  /** Translate into this language instead of the default target. */
  target?: string
  /** The page language, when the user corrected the detector. */
  source?: string
  /** Started by the auto-translate rules rather than the user. */
  auto?: boolean
}

export interface TranslateSelectionOptions {
  /** The text to translate; the page's current selection when omitted. */
  text?: string
  target?: string
}

export interface TranslateReaderOptions {
  /** Translate into this language instead of the first preferred one. */
  target?: string
  /** The article's language, when the user corrected the detector. */
  source?: string
}

/** A reader tab's translation (CT-36): its state for the chrome and the run behind it. */
interface ReaderEntry {
  state: ReaderTranslateState
  /** The article the translation is of; the entry goes when the tab leaves it. */
  articleId: string
  /** Bumped when the run is cancelled or restarted; async work checks it before acting. */
  gen: number
  abort: AbortController | null
}

function emptyState(tabId: string): TranslateTabState {
  return {
    tabId,
    status: 'idle',
    source: null,
    confidence: null,
    target: null,
    progress: null,
    download: null,
    error: null,
    auto: false,
    dismissed: false
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Pages whose document can be translated in place: web and file documents. Not the `zen://`
 * documents – Reader View among them, whose article is translated in the core on the user's
 * word alone (`translateReader`, CT-36), so no offer bar stands on a reader tab.
 */
export function translatablePageUrl(url: string): boolean {
  return /^(https?|file):\/\//i.test(url)
}

/** How a reader tab is told to use the Text preferences' Translate row (`open`). */
const READER_TRANSLATE_HINT = 'Translate this article from the reader’s Text preferences.'

/**
 * Invoke a method of the page runtime, installing the runtime (once per document) when the page
 * does not have it yet.
 */
async function callPage<T>(
  view: TabView,
  method: keyof TranslatePageRuntime,
  ...args: unknown[]
): Promise<T> {
  const result = await view.executeJavaScript(translateCall(method, ...args))
  if (result !== TRANSLATE_RUNTIME_MISSING) return result as T
  return (await view.executeJavaScript(translateInstallCall(method, ...args))) as T
}

/**
 * Page translation: per-tab state (detect, offer, translate, revert), the language preferences,
 * the models on the device and the engine that runs them. The page side is
 * `shared/translateScript.ts`, driven through the tab view's `executeJavaScript`; the engine is
 * a Web Worker of the chrome that the host starts (`TranslateHost`).
 */
export class TranslateService {
  readonly registry: ModelRegistry
  readonly models: ModelManager | null
  private readonly host: TranslateHost | null
  private readonly store: JsonStore<Persisted>
  private prefs: TranslatePreferences
  private engine: WorkerEngine | null = null
  private starting: Promise<WorkerEngine> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private busy = 0
  private sessions = 0
  private readonly tabs = new Map<string, TabEntry>()
  /** Reader View translations by tab (CT-36). */
  private readonly readers = new Map<string, ReaderEntry>()

  constructor(private readonly browser: Browser) {
    this.host = browser.platform.translate ?? null
    this.registry = new ModelRegistry()
    this.models = this.host ? new ModelManager(this.registry, this.host.models) : null
    this.store = new JsonStore<Persisted>(browser.platform.io, 'translate.json', 300)
    const persisted = this.store.readSync()
    this.prefs = sanitizePreferences(
      persisted?.preferences,
      defaultPreferences(this.host?.locales ?? [])
    )
    // The languages the user reads are the preferred languages setting (CT-41). A profile from
    // before the setting existed took the OS's languages as it loaded; the languages its
    // translate document listed (the rows it had) are folded into that list once, so nothing the
    // user chose is lost, and from here on the setting is the one list.
    const state = browser.state
    if (state.languagesDefaulted) {
      state.languagesDefaulted = false
      const own = (persisted?.preferences as { preferred?: unknown } | undefined)?.preferred
      if (Array.isArray(own) && own.length > 0) {
        const folded = sanitizeLanguages(
          languagesForPreferred(state.settings.languages, own as string[]),
          state.settings.languages
        )
        if (languagesKey(folded) !== languagesKey(state.settings.languages)) {
          state.settings.languages = folded
          state.commit()
        }
      }
    }
    this.prefs = this.withPreferred(this.prefs)
    const cached = persisted?.registry
    if (cached && Array.isArray(cached.models) && typeof cached.fetchedAt === 'number')
      this.registry.replace(cached.models, cached.fetchedAt)
    if (this.models) {
      void this.models
        .refresh()
        .then(() => this.changed())
        .catch(() => undefined)
    }
  }

  /** Called once the browser runs: ask Remote Settings for new models when the copy is old. */
  start(): void {
    void this.refreshRegistry()
  }

  get available(): boolean {
    return this.host !== null
  }

  get preferences(): TranslatePreferences {
    return this.prefs
  }

  // ---------------------------------------------------------------------------
  // UI state
  // ---------------------------------------------------------------------------

  uiState(): TranslateUIState {
    for (const tabId of [...this.tabs.keys()]) {
      if (!this.browser.tabs.tab(tabId)) this.tabs.delete(tabId)
    }
    for (const [tabId, entry] of [...this.readers]) {
      if (this.browser.reader.articleOf(tabId)?.id !== entry.articleId)
        this.dropReader(tabId, entry)
    }
    const models = this.modelInfo()
    const tabs: Record<string, TranslateTabState> = {}
    for (const [tabId, entry] of this.tabs) tabs[tabId] = entry.state
    const reader: Record<string, ReaderTranslateState> = {}
    for (const [tabId, entry] of this.readers) reader[tabId] = entry.state
    return {
      available: this.available,
      preferences: this.prefs,
      languages: this.registry.languages(),
      installed: models.filter((m) => m.installed),
      downloading: models.filter((m) => m.downloading),
      registryDate: new Date(this.registry.fetchedAt || Date.parse(ModelRegistry.snapshotDate))
        .toISOString()
        .slice(0, 10),
      modelLicense: ModelRegistry.modelLicense,
      tabs,
      reader
    }
  }

  tabState(tabId: string): TranslateTabState | null {
    return this.tabs.get(tabId)?.state ?? null
  }

  /** The reader translation's state for a tab (CT-36), null while its reader never translated. */
  readerState(tabId: string): ReaderTranslateState | null {
    return this.readers.get(tabId)?.state ?? null
  }

  private changed(): void {
    this.browser.state.commitVolatile()
  }

  // ---------------------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------------------

  setPreferences(patch: Partial<TranslatePreferences>): void {
    const { preferred, ...rest } = patch
    this.prefs = this.withPreferred(sanitizePreferences({ ...this.prefs, ...rest }, this.prefs))
    this.persist()
    this.changed()
    // The languages the user reads are the preferred languages setting: a change to the rows
    // is written onto the list, which comes back through `onLanguagesChanged`.
    if (preferred) {
      this.browser.languages.set(
        languagesForPreferred(this.browser.state.settings.languages, preferred)
      )
    }
  }

  /**
   * The preferred languages changed (a Settings row, a sync merge): the languages-you-read list
   * follows, an open offer for a language now read comes down, the always list loses it.
   */
  onLanguagesChanged(): void {
    const next = this.withPreferred(this.prefs)
    if (next.preferred.join(',') === this.prefs.preferred.join(',')) return
    this.prefs = next
    for (const entry of this.tabs.values())
      if (
        entry.state.status === 'offered' &&
        entry.state.source &&
        this.prefs.preferred.includes(entry.state.source)
      )
        this.update(entry, { status: 'idle' })
    this.persist()
    this.changed()
  }

  /** `prefs` with the languages-you-read list read from the preferred languages setting. */
  private withPreferred(prefs: TranslatePreferences): TranslatePreferences {
    const preferred = preferredFromLanguages(this.browser.state.settings.languages)
    return sanitizePreferences({ ...prefs, preferred }, prefs)
  }

  setLanguageRule(language: string, rule: LanguageRule): void {
    this.prefs = withLanguageRule(this.prefs, language, rule)
    this.persist()
    // A language the user never wants translated takes its open offers down with it.
    if (rule === 'never')
      for (const entry of this.tabs.values())
        if (entry.state.status === 'offered' && entry.state.source === language)
          this.update(entry, { status: 'idle' })
    this.changed()
  }

  /** The rule `language` is under (for the chrome's menus). */
  languageRule(language: string): LanguageRule {
    return languageRule(this.prefs, language)
  }

  /** The site key of the tab's page ('' when it is not a web page). */
  siteOf(tabId: string): string {
    const tab = this.browser.tabs.tab(tabId)
    return tab ? siteOf(tab.url) : ''
  }

  /** Whether the tab shows a document the translation UI can work on. */
  canTranslate(tabId: string): boolean {
    return this.available && this.view(tabId) !== null
  }

  /** Never offer to translate the site of `tabId` (or offer again). */
  setSiteRule(tabId: string, never: boolean): void {
    const tab = this.browser.tabs.tab(tabId)
    const site = tab ? siteOf(tab.url) : ''
    if (!site) return
    this.prefs = withSiteRule(this.prefs, site, never)
    this.persist()
    const entry = this.tabs.get(tabId)
    if (never && entry && entry.state.status === 'offered') this.update(entry, { status: 'idle' })
    this.changed()
  }

  private persist(): void {
    this.store.write({
      preferences: this.prefs,
      registry:
        this.registry.fetchedAt > 0
          ? { fetchedAt: this.registry.fetchedAt, models: this.registry.packed() }
          : null
    })
  }

  flushSync(): void {
    this.store.flushSync()
  }

  stop(): void {
    for (const entry of this.tabs.values()) this.cancel(entry)
    for (const entry of this.readers.values()) this.cancelReader(entry)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.engine?.dispose()
    this.engine = null
  }

  // ---------------------------------------------------------------------------
  // Registry and models
  // ---------------------------------------------------------------------------

  private async refreshRegistry(): Promise<void> {
    if (!this.host || !this.registry.stale(Date.now())) return
    try {
      const response = await this.browser.platform.net.fetchText(REGISTRY_RECORDS_URL, {
        timeoutMs: 20_000
      })
      if (!response.ok) return
      const parsed = JSON.parse(response.text) as { data?: RegistryRecord[] }
      const models = condenseRecords(Array.isArray(parsed.data) ? parsed.data : [])
      if (models.length === 0) return
      this.registry.replace(models, Date.now())
      this.persist()
      this.changed()
      if (this.models) await this.models.prune().catch(() => undefined)
    } catch {
      /* offline, blocked or malformed: the bundled snapshot stands */
    }
  }

  /** Fetch a pair ahead of its first use (the Languages settings); the list shows it arriving. */
  async downloadModel(pair: LanguagePair): Promise<void> {
    const models = this.requireModels()
    const running = models.ensure(pair)
    this.changed()
    try {
      await running
    } finally {
      this.changed()
    }
  }

  async removeModel(pair: LanguagePair): Promise<void> {
    const models = this.requireModels()
    if (this.engine && !this.engine.disposed) await this.engine.unload(pair).catch(() => undefined)
    await models.remove(pair)
    this.changed()
  }

  /** `translate.models`: every pair the registry offers, installed or not (the Languages settings). */
  modelInfo(): TranslateModelInfo[] {
    return this.models ? this.models.info() : []
  }

  private requireModels(): ModelManager {
    if (!this.models) throw new Error('Zenium cannot translate pages on this device.')
    return this.models
  }

  private requireHost(): TranslateHost {
    if (!this.host) throw new Error('Zenium cannot translate pages on this device.')
    return this.host
  }

  // ---------------------------------------------------------------------------
  // Engine
  // ---------------------------------------------------------------------------

  private engineReady(): Promise<WorkerEngine> {
    if (this.engine && !this.engine.disposed) return Promise.resolve(this.engine)
    if (this.starting) return this.starting
    const host = this.requireHost()
    this.starting = (async () => {
      const assets = await host.assets()
      const engine = new WorkerEngine(host.createEngine(), assets)
      try {
        await engine.whenReady()
      } catch (error) {
        engine.dispose()
        throw error
      }
      this.engine = engine
      this.touch()
      return engine
    })().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  /** The engine hosts relay their worker answers here (Electron). */
  onRelayResponse(response: EngineRelayResponse): void {
    this.host?.onRelayResponse?.(response)
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.idle(), ENGINE_IDLE_MS)
  }

  private idle(): void {
    this.idleTimer = null
    if (this.busy > 0) {
      this.touch()
      return
    }
    this.engine?.dispose()
    this.engine = null
  }

  /** Make the models of `route` available: download what is missing, load them into the engine. */
  private async prepare(
    route: LanguagePair[],
    engine: TranslationEngine,
    onDownload: (received: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const models = this.requireModels()
    const total = models.bytesToDownload(route)
    let base = 0
    let downloaded = false
    for (const pair of route) {
      const record = this.registry.find(pair)
      const missing = record !== null && !models.isInstalled(record)
      await models.ensure(
        pair,
        (received) => onDownload(Math.min(total, base + received), total),
        signal
      )
      if (missing && record) {
        base += record.bytes
        downloaded = true
      }
      await engine.loadPair(pair, await models.files_(pair))
    }
    if (downloaded) {
      this.changed()
      void models.prune().catch(() => undefined)
    }
  }

  // ---------------------------------------------------------------------------
  // Page lifecycle
  // ---------------------------------------------------------------------------

  /** A new document is ready in the tab: detect its language and apply the offer rules. */
  onPageReady(tabId: string): void {
    if (!this.host) return
    const entry = this.tabs.get(tabId)
    if (entry) {
      this.cancel(entry)
      this.tabs.delete(tabId)
      this.browser.state.commitVolatile()
    }
    if (!this.prefs.autoOffer && this.prefs.alwaysTranslate.length === 0) return
    void this.detect(tabId).catch(() => undefined)
  }

  /**
   * The tab's URL changed. A new document resets the state (its `dom-ready` follows); a
   * same-document navigation keeps the translation running.
   */
  onNavigated(tabId: string): void {
    // A reader translation is of one article: the tab leaving it (the page behind it, another
    // reader article, anywhere) ends the translation, and the article shows as written again.
    const reader = this.readers.get(tabId)
    if (reader && this.browser.reader.articleOf(tabId)?.id !== reader.articleId)
      this.dropReader(tabId, reader)
    const entry = this.tabs.get(tabId)
    if (!entry || entry.doc === 0) return
    const view = this.browser.tabs.view(tabId)
    if (!view) {
      this.forget(tabId, entry)
      return
    }
    const gen = entry.gen
    void view
      .executeJavaScript(translateCall('status'))
      .then((result) => {
        if (this.tabs.get(tabId) !== entry || entry.gen !== gen) return
        // A document without the runtime is a new one; only same-document navigations keep it.
        const status =
          result && typeof result === 'object' ? (result as TranslateRuntimeStatus) : null
        if (!status || status.doc !== entry.doc) this.forget(tabId, entry)
      })
      .catch(() => {
        if (this.tabs.get(tabId) === entry && entry.gen === gen) this.forget(tabId, entry)
      })
  }

  private forget(tabId: string, entry: TabEntry): void {
    this.cancel(entry)
    if (this.tabs.get(tabId) === entry) this.tabs.delete(tabId)
    this.browser.state.commitVolatile()
  }

  private entry(tabId: string): TabEntry {
    let entry = this.tabs.get(tabId)
    if (!entry) {
      entry = { state: emptyState(tabId), doc: 0, gen: 0, session: 0, abort: null }
      this.tabs.set(tabId, entry)
    }
    return entry
  }

  private update(entry: TabEntry, patch: Partial<TranslateTabState>): void {
    Object.assign(entry.state, patch)
    this.browser.state.commitVolatile()
  }

  /** Stop whatever runs for the tab; the page keeps whatever it shows. */
  private cancel(entry: TabEntry): void {
    entry.gen++
    entry.session = 0
    entry.abort?.abort()
    entry.abort = null
  }

  private view(tabId: string): TabView | null {
    const tab = this.browser.tabs.tab(tabId)
    const view = this.browser.tabs.view(tabId)
    if (!tab || !view || !translatablePageUrl(tab.url)) return null
    return view
  }

  private async sample(tabId: string, view: TabView): Promise<TranslatePageSample | null> {
    const result = await callPage<TranslatePageSample | null>(view, 'sample', SAMPLE_CHARS)
    if (!result || typeof result !== 'object') return null
    const entry = this.entry(tabId)
    entry.doc = result.doc
    return result
  }

  /**
   * Identify the page language: sample the page, run the detector, reconcile with the page's
   * hints. Records the outcome in the tab state; returns the language or null.
   */
  private async identify(tabId: string, view: TabView): Promise<string | null> {
    const entry = this.entry(tabId)
    const gen = entry.gen
    const sample = await this.sample(tabId, view)
    if (!sample || entry.gen !== gen) return null
    if (sample.notranslate) return null
    const chars = Math.max(sample.chars, sample.text.length)
    const detection =
      chars >= MIN_SAMPLE_CHARS
        ? await (await this.engineReady()).detect(sample.text).catch(() => null)
        : null
    if (entry.gen !== gen) return null
    const supported = new Set(this.registry.languages())
    const decision = decideLanguage(sample, detection, supported)
    entry.state.source = decision.language
    entry.state.confidence = decision.confidence
    return decision.language
  }

  private async detect(tabId: string): Promise<void> {
    const view = this.view(tabId)
    const tab = this.browser.tabs.tab(tabId)
    if (!view || !tab) return
    const site = siteOf(tab.url)
    if (site && this.prefs.neverTranslateSites.includes(site)) return
    const entry = this.entry(tabId)
    const gen = entry.gen
    this.update(entry, { status: 'detecting' })
    let language: string | null = null
    try {
      language = await this.identify(tabId, view)
    } catch {
      language = null
    }
    if (entry.gen !== gen || this.tabs.get(tabId) !== entry) return
    if (!language) {
      this.update(entry, { status: 'idle' })
      return
    }
    const target = defaultTarget(this.prefs, language)
    const decision = this.registry.route({ from: language, to: target })
      ? offerFor(this.prefs, language, site)
      : 'none'
    if (decision === 'translate') {
      this.update(entry, { status: 'idle', target, auto: true })
      await this.translatePage(tabId, { target, auto: true })
    } else if (decision === 'offer') {
      this.update(entry, { status: 'offered', target, auto: true, dismissed: false })
    } else {
      this.update(entry, { status: 'idle', target })
    }
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /**
   * `translate.offer`: the user asked for the translation UI. Puts the offer up for the tab,
   * identifying the page language first when it is not known yet; the never-translate rules do
   * not apply to an explicit request. A running or finished translation only gets its bar shown
   * again. Throws when the tab shows nothing that can be translated.
   */
  async offer(tabId: string): Promise<void> {
    const view = this.view(tabId)
    if (!view) throw new Error('This page cannot be translated.')
    const entry = this.entry(tabId)
    const status = entry.state.status
    if (status === 'downloading' || status === 'translating' || status === 'translated') {
      this.update(entry, { dismissed: false })
      return
    }
    if (status === 'detecting') return
    const gen = entry.gen
    if (!entry.state.source) {
      this.update(entry, { status: 'detecting', error: null, auto: false, dismissed: false })
      this.busy++
      try {
        await this.identify(tabId, view)
      } catch {
        // Unknown language: the offer goes up without a source and the user picks one.
      } finally {
        this.busy--
        this.touch()
      }
      if (entry.gen !== gen || this.tabs.get(tabId) !== entry) return
    }
    this.update(entry, {
      status: 'offered',
      target: entry.state.target ?? defaultTarget(this.prefs, entry.state.source),
      error: null,
      progress: null,
      download: null,
      auto: false,
      dismissed: false
    })
  }

  /**
   * `translate.retarget`: change the languages the tab's offer would translate from or into
   * (the bar's menulists, the options menu) without translating yet. Unknown codes are ignored.
   */
  retarget(tabId: string, patch: { source?: string; target?: string }): void {
    const entry = this.tabs.get(tabId)
    if (!entry) return
    const supported = this.registry.languages()
    const update: Partial<TranslateTabState> = {}
    if (patch.source && supported.includes(patch.source) && patch.source !== entry.state.source) {
      update.source = patch.source
      update.confidence = null
    }
    if (patch.target && supported.includes(patch.target)) update.target = patch.target
    if (Object.keys(update).length) this.update(entry, update)
  }

  /** The menu and command-bar entry to `offer`: a toast, not an error, for other pages. */
  async open(tabId: string, win?: ZenWindow): Promise<void> {
    if (this.browser.reader.articleOf(tabId)) {
      // The reader's translate lives in one place, the Text preferences' Translate row.
      this.browser.toast(READER_TRANSLATE_HINT, 'info', win)
      return
    }
    try {
      await this.offer(tabId)
    } catch (error) {
      this.browser.toast(messageOf(error), 'info', win)
    }
  }

  /**
   * `translate.showSelection`: put the selection popover up for `text` (the page's current
   * selection when omitted; nothing happens when there is none). `anchor` is where the user
   * asked, in CSS pixels of the page view.
   */
  async showSelection(
    tabId: string,
    text?: string,
    anchor: { x: number; y: number } | null = null,
    win?: ZenWindow
  ): Promise<void> {
    if (!this.available) return
    let value = text?.replace(/\s+/g, ' ').trim() ?? ''
    if (!value) {
      const view = this.view(tabId)
      if (!view) return
      value = String((await callPage<string>(view, 'selection', SELECTION_MAX_CHARS)) ?? '')
    }
    value = value.slice(0, SELECTION_MAX_CHARS)
    if (!value || !this.browser.tabs.tab(tabId)) return
    this.browser.emit(
      'translate.selection',
      { tabId, text: value, x: anchor?.x ?? null, y: anchor?.y ?? null },
      win ?? this.browser.tabs.windowFor(tabId)
    )
  }

  /** `translate.page`: translate the tab's document (into `target`, the default when omitted). */
  async translatePage(tabId: string, options: TranslatePageOptions = {}): Promise<void> {
    const view = this.view(tabId)
    if (!view) throw new Error('This page cannot be translated.')
    const entry = this.entry(tabId)
    const running = entry.state.status === 'translating' || entry.state.status === 'translated'
    if (running && entry.session !== 0) {
      const sameTarget = !options.target || options.target === entry.state.target
      const sameSource = !options.source || options.source === entry.state.source
      if (sameTarget && sameSource) return
    }
    this.cancel(entry)
    const gen = entry.gen
    const controller = new AbortController()
    entry.abort = controller
    this.busy++
    try {
      if (options.source) {
        if (!this.registry.languages().includes(options.source))
          throw new Error(`Zenium has no translation model for ${options.source}.`)
        entry.state.source = options.source
        entry.state.confidence = null
      }
      if (!entry.state.source) {
        this.update(entry, { status: 'detecting', error: null, auto: Boolean(options.auto) })
        await this.identify(tabId, view)
        if (entry.gen !== gen) return
      }
      const source = entry.state.source
      if (!source) throw new Error('Zenium could not tell what language this page is in.')
      const target = options.target ?? entry.state.target ?? defaultTarget(this.prefs, source)
      if (source === target) throw new Error(`This page is already in ${target}.`)
      const route = this.registry.route({ from: source, to: target })
      if (!route) throw new Error(`Zenium has no translation model from ${source} to ${target}.`)
      const engine = await this.engineReady()
      if (entry.gen !== gen) return
      const models = this.requireModels()
      const toDownload = models.bytesToDownload(route)
      this.update(entry, {
        status: toDownload > 0 ? 'downloading' : 'translating',
        target,
        error: null,
        progress: null,
        download: toDownload > 0 ? { received: 0, total: toDownload } : null,
        auto: Boolean(options.auto),
        dismissed: false
      })
      await this.prepare(
        route,
        engine,
        (received, total) => {
          if (entry.gen === gen) this.update(entry, { download: { received, total } })
        },
        controller.signal
      )
      if (entry.gen !== gen) return
      this.update(entry, { status: 'translating', download: null })
      await this.run(tabId, entry, gen, engine, route)
    } catch (error) {
      if (entry.gen !== gen) return
      this.fail(entry, gen, error)
      throw error
    } finally {
      this.busy--
      this.touch()
      if (entry.abort === controller) entry.abort = null
    }
  }

  /**
   * Start a page session and translate everything the page has; then keep following the page
   * (content it adds later) in the background until the document goes away or the user reverts.
   * Resolves once the initial pass is done so `translate.page` answers promptly.
   */
  private async run(
    tabId: string,
    entry: TabEntry,
    gen: number,
    engine: TranslationEngine,
    route: LanguagePair[]
  ): Promise<void> {
    const first = this.liveView(tabId, entry, gen)
    if (!first) return
    const session = ++this.sessions
    entry.session = session
    const started = await callPage<TranslateRuntimeStatus>(first, 'start', session)
    if (entry.gen !== gen) return
    entry.doc = started.doc
    this.update(entry, { progress: { done: started.done, total: started.total } })
    if (!(await this.drain(tabId, entry, gen, engine, route, session, FIRST_BATCH))) return
    void this.follow(tabId, entry, gen, route, session).catch((error) =>
      this.fail(entry, gen, error)
    )
  }

  private liveView(tabId: string, entry: TabEntry, gen: number): TabView | undefined {
    return entry.gen === gen ? this.browser.tabs.view(tabId) : undefined
  }

  /**
   * Translate the page's pending units batch by batch until none is left. Returns false when the
   * tab or the session went away meanwhile.
   */
  private async drain(
    tabId: string,
    entry: TabEntry,
    gen: number,
    engine: TranslationEngine,
    route: LanguagePair[],
    session: number,
    firstBatch: { items: number; chars: number }
  ): Promise<boolean> {
    let batchSize = firstBatch
    for (;;) {
      const current = this.liveView(tabId, entry, gen)
      if (!current) return false
      const batch = await callPage<TranslateBatch>(
        current,
        'next',
        session,
        batchSize.items,
        batchSize.chars
      )
      if (entry.gen !== gen) return false
      if (batch.items.length === 0) {
        if (entry.state.status !== 'translated')
          this.update(entry, {
            status: 'translated',
            progress: { done: batch.done, total: batch.total }
          })
        return true
      }
      batchSize = BATCH
      this.touch()
      const translations = await engine.translate(
        batch.items.map((item) => item.html),
        { route, html: true }
      )
      const applying = this.liveView(tabId, entry, gen)
      if (!applying) return false
      const status = await callPage<TranslateRuntimeStatus>(
        applying,
        'apply',
        session,
        batch.items.map((item, index) => ({ id: item.id, html: translations[index] ?? null }))
      )
      if (entry.gen !== gen) return false
      this.update(entry, {
        status: status.pending > 0 || status.done < status.total ? 'translating' : 'translated',
        progress: { done: status.done, total: status.total }
      })
    }
  }

  /**
   * Long-poll the page for content it adds after the initial pass and translate it. The engine is
   * taken fresh each time: it may have been dropped while the page sat idle.
   */
  private async follow(
    tabId: string,
    entry: TabEntry,
    gen: number,
    route: LanguagePair[],
    session: number
  ): Promise<void> {
    for (;;) {
      const waiting = this.liveView(tabId, entry, gen)
      if (!waiting) return
      const wait = await callPage<TranslateWaitResult>(waiting, 'wait', session, WAIT_MS)
      if (entry.gen !== gen || wait.ended) return
      if (wait.pending === 0) continue
      this.busy++
      try {
        this.update(entry, { status: 'translating' })
        const engine = await this.engineReady()
        if (entry.gen !== gen) return
        await this.prepare(route, engine, (received, total) => {
          if (entry.gen === gen) this.update(entry, { download: { received, total } })
        })
        if (entry.gen !== gen) return
        if (entry.state.download) this.update(entry, { download: null })
        if (!(await this.drain(tabId, entry, gen, engine, route, session, BATCH))) return
      } finally {
        this.busy--
        this.touch()
      }
    }
  }

  private fail(entry: TabEntry, gen: number, error: unknown): void {
    if (entry.gen !== gen) return
    entry.session = 0
    this.update(entry, { status: 'error', error: messageOf(error), download: null })
  }

  /** `translate.revert`: show the original page again. */
  revert(tabId: string): void {
    const entry = this.tabs.get(tabId)
    if (!entry) return
    const hadSession = entry.session !== 0
    this.cancel(entry)
    const view = this.browser.tabs.view(tabId)
    if (hadSession && view)
      void view.executeJavaScript(translateCall('revert')).catch(() => undefined)
    const source = entry.state.source
    const offer =
      source !== null &&
      entry.state.target !== null &&
      this.registry.route({ from: source, to: entry.state.target }) !== null
    this.update(entry, {
      status: offer ? 'offered' : 'idle',
      progress: null,
      download: null,
      error: null,
      dismissed: false
    })
  }

  /** `translate.dismiss`: the user closed the offer for this page. */
  dismiss(tabId: string): void {
    const entry = this.tabs.get(tabId)
    if (!entry) return
    this.update(entry, { dismissed: true })
  }

  // ---------------------------------------------------------------------------
  // Reader View (CT-36)
  // ---------------------------------------------------------------------------

  /**
   * `translate.reader`: translate the Reader View article the tab shows, in the core – the
   * article's units (`articleHtml.ts`, the page runtime's rules) through the same engine and
   * models, batched as a page is, each batch swapped into the open document as it comes; the
   * original kept for the Show original toggle; a reload renders the translation from the core.
   * The target defaults to the first preferred language; asked again for the same languages a
   * translation that shows the original shows again, one for other languages is redone. Throws
   * when the tab shows no reader article, the language cannot be told, or no model reaches the
   * target; an explicit action, never offered (`translatablePageUrl` is false for `zen://`).
   */
  async translateReader(tabId: string, options: TranslateReaderOptions = {}): Promise<void> {
    const article = this.browser.reader.articleOf(tabId)
    if (!article) throw new Error('This page cannot be translated.')
    this.requireHost()
    let entry = this.readers.get(tabId)
    if (entry && entry.articleId !== article.id) {
      this.dropReader(tabId, entry)
      entry = undefined
    }
    if (entry) {
      // The same languages, translated or under way: nothing to redo; the translation shows.
      const { status, target, source } = entry.state
      const sameTarget = !options.target || options.target === target
      const sameSource = !options.source || options.source === source
      if ((entry.abort !== null || status === 'translated') && sameTarget && sameSource) {
        if (entry.state.showOriginal) this.showReaderOriginal(tabId, false)
        return
      }
    }
    if (!entry) {
      entry = {
        state: {
          tabId,
          status: 'detecting',
          source: null,
          target: null,
          progress: null,
          download: null,
          error: null,
          showOriginal: false
        },
        articleId: article.id,
        gen: 0,
        abort: null
      }
      this.readers.set(tabId, entry)
    }
    this.cancelReader(entry)
    const gen = entry.gen
    const controller = new AbortController()
    entry.abort = controller
    this.busy++
    try {
      if (options.source) {
        if (!this.registry.languages().includes(options.source))
          throw new Error(`Zenium has no translation model for ${options.source}.`)
        entry.state.source = options.source
      }
      if (!entry.state.source) {
        this.updateReader(entry, { status: 'detecting', error: null })
        entry.state.source = await this.identifyArticle(article)
        if (entry.gen !== gen) return
      }
      const source = entry.state.source
      if (!source) throw new Error('Zenium could not tell what language this article is in.')
      const target = options.target ?? entry.state.target ?? defaultTarget(this.prefs, source)
      if (source === target) throw new Error(`This article is already in ${target}.`)
      const route = this.registry.route({ from: source, to: target })
      if (!route) throw new Error(`Zenium has no translation model from ${source} to ${target}.`)
      const engine = await this.engineReady()
      if (entry.gen !== gen) return
      const models = this.requireModels()
      const toDownload = models.bytesToDownload(route)
      this.updateReader(entry, {
        status: toDownload > 0 ? 'downloading' : 'translating',
        target,
        error: null,
        progress: null,
        download: toDownload > 0 ? { received: 0, total: toDownload } : null,
        showOriginal: false
      })
      await this.prepare(
        route,
        engine,
        (received, total) => {
          if (entry.gen === gen) this.updateReader(entry, { download: { received, total } })
        },
        controller.signal
      )
      if (entry.gen !== gen) return
      this.updateReader(entry, { status: 'translating', download: null })
      await this.runReader(tabId, entry, gen, engine, route, article, source, target)
    } catch (error) {
      if (entry.gen !== gen) return
      this.updateReader(entry, { status: 'error', error: messageOf(error), download: null })
      throw error
    } finally {
      this.busy--
      this.touch()
      if (entry.abort === controller) entry.abort = null
    }
  }

  /**
   * `translate.readerShowOriginal`: show the article as written (`true`) or its translation, the
   * translation kept either way (and a run in progress carries on, its batches shown again when
   * the toggle comes back). Read aloud on the tab follows what is shown.
   */
  showReaderOriginal(tabId: string, original: boolean): void {
    const entry = this.readers.get(tabId)
    const article = this.browser.reader.articleOf(tabId)
    if (!entry || !article || article.id !== entry.articleId) return
    const translation = article.translation
    if (!translation || entry.state.showOriginal === original) return
    translation.showOriginal = original
    this.updateReader(entry, { showOriginal: original })
    this.browser.reader.pushShown(tabId, article)
    this.browser.readAloud.onReaderTextChanged(tabId)
  }

  /**
   * The article's language: Readability's `lang` (the page's `<html lang>`) as the hint, the
   * detector run on the article's text, reconciled as a page's sample is.
   */
  private async identifyArticle(article: ReaderArticle): Promise<string | null> {
    const split = this.browser.reader.split(article)
    const text = articleSampleText(split, SAMPLE_CHARS)
    const detection =
      text.length >= MIN_SAMPLE_CHARS
        ? await (await this.engineReady()).detect(text).catch(() => null)
        : null
    const sample: TranslatePageSample = {
      doc: 0,
      text,
      lang: article.lang ?? '',
      contentLanguage: '',
      notranslate: false,
      chars: text.length
    }
    return decideLanguage(sample, detection, new Set(this.registry.languages())).language
  }

  /**
   * Translate the article's units in batches (the first small so the top of the article changes
   * quickly, the rest filling the engine), the title with the first; each batch rebuilt with the
   * article's own tags, stored with the article and swapped into the document unless the toggle
   * shows the original. Resolves once every unit is done.
   */
  private async runReader(
    tabId: string,
    entry: ReaderEntry,
    gen: number,
    engine: TranslationEngine,
    route: LanguagePair[],
    article: ReaderArticle,
    source: string,
    target: string
  ): Promise<void> {
    const split = this.browser.reader.split(article)
    const translation: ReaderArticleTranslation = {
      source,
      target,
      title: null,
      units: split.units.map(() => null),
      showOriginal: false
    }
    article.translation = translation
    const total = split.units.length
    this.updateReader(entry, { progress: { done: 0, total } })
    let index = 0
    let batchSize = FIRST_BATCH
    let first = true
    while (first || index < total) {
      const items: ArticleUnit[] = []
      let chars = 0
      while (
        index < total &&
        items.length < batchSize.items &&
        (items.length === 0 || chars < batchSize.chars)
      ) {
        const unit = split.units[index++]
        items.push(unit)
        chars += unit.source.length
      }
      this.touch()
      const [answers, titles] = await Promise.all([
        items.length > 0
          ? engine.translate(
              items.map((unit) => unit.source),
              { route, html: true }
            )
          : Promise.resolve([] as (string | null)[]),
        first && article.title
          ? engine.translate([article.title], { route, html: false })
          : Promise.resolve(null)
      ])
      if (entry.gen !== gen) return
      items.forEach((unit, k) => {
        const answer = answers[k]
        translation.units[unit.id] =
          answer === null || answer === undefined ? null : rebuildUnitHtml(unit, answer)
      })
      if (titles) translation.title = titles[0]?.trim() || null
      if (!translation.showOriginal) {
        this.browser.reader.pushShown(
          tabId,
          article,
          items.map((unit) => unit.id)
        )
      }
      this.updateReader(entry, {
        status: index < total ? 'translating' : 'translated',
        progress: { done: index, total }
      })
      first = false
      batchSize = BATCH
    }
    // What is read follows what is shown: a session on the tab starts over on the translation.
    if (!translation.showOriginal) this.browser.readAloud.onReaderTextChanged(tabId)
  }

  private updateReader(entry: ReaderEntry, patch: Partial<ReaderTranslateState>): void {
    Object.assign(entry.state, patch)
    this.browser.state.commitVolatile()
  }

  /** Stop whatever runs for the reader tab; the article keeps whatever it shows. */
  private cancelReader(entry: ReaderEntry): void {
    entry.gen++
    entry.abort?.abort()
    entry.abort = null
  }

  /** The tab left the article (or closed): its run stops, the article shows as written again. */
  private dropReader(tabId: string, entry: ReaderEntry): void {
    this.cancelReader(entry)
    if (this.readers.get(tabId) === entry) this.readers.delete(tabId)
    const article = this.browser.reader.article(entry.articleId)
    if (article?.translation) article.translation = null
    this.browser.state.commitVolatile()
  }

  /** `translate.selection`: translate the selected text (or `options.text`) of a tab. */
  async translateSelection(
    tabId: string,
    options: TranslateSelectionOptions = {}
  ): Promise<TranslateSelectionResult | null> {
    const view = this.view(tabId)
    let text = options.text?.replace(/\s+/g, ' ').trim() ?? ''
    if (!text) {
      if (!view) return null
      text = String((await callPage<string>(view, 'selection', SELECTION_MAX_CHARS)) ?? '')
    }
    text = text.slice(0, SELECTION_MAX_CHARS)
    if (!text) return null
    this.busy++
    try {
      const engine = await this.engineReady()
      const detection = await engine.detect(text).catch(() => null)
      const supported = new Set(this.registry.languages())
      let source: string | null = null
      if (detection?.language && detection.confidence >= SELECTION_CONFIDENCE) {
        const code = registryCodeForLabel(detection.language, text)
        if (supported.has(code)) source = code
      }
      if (!source) source = this.tabs.get(tabId)?.state.source ?? null
      if (!source && detection?.language) {
        const code = registryCodeForLabel(detection.language, text)
        if (supported.has(code)) source = code
      }
      if (!source) throw new Error('Zenium could not tell what language the selection is in.')
      let target = options.target ?? this.prefs.preferred[0] ?? defaultTarget(this.prefs, source)
      if (target === source) target = defaultTarget(this.prefs, source)
      // Already in the only language the user reads (a selection on a translated page, say).
      if (target === source) return { text, source, target, translation: text }
      const route = this.registry.route({ from: source, to: target })
      if (!route) throw new Error(`Zenium has no translation model from ${source} to ${target}.`)
      const entry = this.tabs.get(tabId)
      await this.prepare(route, engine, (received, total) => {
        if (entry) this.update(entry, { download: { received, total } })
      })
      if (entry) this.update(entry, { download: null })
      const [translation] = await engine.translate([text], { route, html: false })
      return { text, source, target, translation: translation ?? text }
    } finally {
      this.busy--
      this.touch()
    }
  }
}
