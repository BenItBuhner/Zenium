/**
 * Ad and tracker blocking, the host-neutral half: owns the {@link RuleEngine} and its
 * persistence, turns Settings → Privacy and security into rule sets (levels, per-list switches,
 * the user's filters, per-site exceptions, the master switch), keeps the filter lists fresh from
 * their canonical URLs and counts what the hosts' request engines block. Both hosts read the
 * rule sets this service writes under `blocking/` in the profile.
 */
import {
  DEFAULT_FILTER_LISTS,
  FILTER_LIST_MAX_AGE_MS,
  enabledListsFor,
  normalizeSiteException,
  type BlockingSettings,
  type BlockingStatus,
  type FilterListDefinition,
  type FilterListStatus
} from '../../shared/blocking'
import type { Browser } from '../browser'
import type { BundledFilterList } from '../platform'
import { hostMatchesDomain, hostnameOf, registrableDomain } from './domain'
import { RuleEngine } from './engine'
import {
  parseListHeader,
  prepareListText,
  validateFilterText,
  type FilterSyntaxError
} from './lists'
import {
  BUILTIN_RULE_SETS,
  RULE_SET_PRIORITY,
  USER_RULE_SET_ID,
  type Rule,
  type RuleSet,
  type RuleSetAttribution
} from './rules'
import { RuleSetStore } from './store'

/** The first refresh sweep waits for the browser to settle. */
const STARTUP_SWEEP_DELAY_MS = 20_000
const SWEEP_INTERVAL_MS = 60 * 60 * 1000
/** Lists are a few megabytes; mobile networks need more than the hosts' default. */
const FETCH_TIMEOUT_MS = 90_000
/** Blocked-request counters reach the chrome at most this often. */
const COUNTER_COMMIT_INTERVAL_MS = 200

interface ListRuntime {
  updating: boolean
  lastError: string | null
}

interface ListSource {
  id: string
  name: string
  url: string
  homepage: string
  licence: string
  custom: boolean
}

export class BlockingService {
  readonly engine = new RuleEngine()
  readonly store: RuleSetStore
  private ready = false
  private sessionBlocked = 0
  private readonly runtime = new Map<string, ListRuntime>()
  /** Snapshot metadata per list id, once the host reported what it bundles. */
  private readonly bundled = new Map<string, BundledFilterList>()
  private userFilterErrors: FilterSyntaxError[] = []
  private builtinSignatures = new Map<string, string>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private counterTimer: ReturnType<typeof setTimeout> | null = null
  private queue: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(private readonly browser: Browser) {
    this.store = new RuleSetStore(browser.platform.io)
  }

  private get settings(): BlockingSettings {
    return this.browser.state.settings.blocking
  }

  /** Load the persisted rule sets, apply the settings and seed the bundled snapshot. */
  start(): void {
    const loaded = this.store.load()
    this.store.attach(this.engine)
    for (const l of loaded)
      this.engine.setRuleSet(l.set, {
        persisted: true,
        filterCount: l.filterCount,
        hasFilterText: l.hasFilterText
      })
    this.syncSets(null)
    this.ready = true
    void this.seedBundled().then(() => {
      if (this.stopped) return
      this.startupTimer = setTimeout(() => void this.sweep(), STARTUP_SWEEP_DELAY_MS)
      this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS)
    })
    this.browser.state.commitVolatile()
  }

  stop(): void {
    this.stopped = true
    if (this.startupTimer) clearTimeout(this.startupTimer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    if (this.counterTimer) clearTimeout(this.counterTimer)
    this.startupTimer = this.sweepTimer = this.counterTimer = null
  }

  flushSync(): void {
    this.store.flushSync()
  }

  status(): BlockingStatus {
    const s = this.settings
    const enabled = enabledListsFor(s)
    const lists: FilterListStatus[] = []
    let lastUpdatedAt: number | null = null
    let updating = false
    for (const source of this.sources()) {
      const summary = this.engine.summary(source.id)
      const rt = this.runtime.get(source.id)
      const def = DEFAULT_FILTER_LISTS.find((d) => d.id === source.id)
      const bundled = this.isBundledCopy(source.id)
      const updatedAt = summary?.hasFilterText ? (summary.updatedAt ?? null) : null
      if (updatedAt !== null && !bundled) lastUpdatedAt = Math.max(lastUpdatedAt ?? 0, updatedAt)
      if (rt?.updating) updating = true
      lists.push({
        id: source.id,
        name: source.name,
        description: def?.description ?? source.url,
        url: source.url,
        homepage: source.homepage,
        licence: source.licence,
        tier: def?.tier ?? null,
        enabled: enabled.has(source.id),
        version: summary?.version ?? null,
        updatedAt,
        filterCount: summary?.filterCount ?? 0,
        bundled,
        updating: rt?.updating ?? false,
        lastError: rt?.lastError ?? null
      })
    }
    return {
      ready: this.ready,
      sessionBlocked: this.sessionBlocked,
      lists,
      updating,
      lastUpdatedAt,
      userFilterErrors: this.userFilterErrors
    }
  }

  // ---------------------------------------------------------------------------
  // Counters
  // ---------------------------------------------------------------------------

  /** A host engine blocked `count` requests, `tabId` when it knows the page they belonged to. */
  recordBlocked(tabId: string | undefined, count = 1): void {
    if (count <= 0) return
    this.sessionBlocked += count
    const tab = tabId ? this.browser.tabs.tab(tabId) : undefined
    if (tab) tab.blockedCount += count
    if (this.counterTimer) return
    this.counterTimer = setTimeout(() => {
      this.counterTimer = null
      this.browser.state.commitVolatile()
    }, COUNTER_COMMIT_INTERVAL_MS)
  }

  /** A tab committed a new document: its counter starts over (the caller commits). */
  onNavigated(tabId: string): void {
    const tab = this.browser.tabs.tab(tabId)
    if (tab) tab.blockedCount = 0
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  onSettingsChanged(previous: BlockingSettings): void {
    this.syncSets(previous)
  }

  /** Is `url` on a site the user excepted from blocking? */
  isExcepted(url: string): boolean {
    const host = hostnameOf(url)
    return host !== null && this.settings.siteExceptions.some((d) => hostMatchesDomain(host, d))
  }

  /** The domain a per-site exception for `url` would use, or null for pages without a site. */
  siteFor(url: string): string | null {
    const host = hostnameOf(url)
    if (!host || !/^https?:/i.test(url)) return null
    return registrableDomain(host)
  }

  /** Except (or stop excepting) a site; `site` may be a domain or a URL. */
  setSiteException(site: string, excepted: boolean): void {
    const domain = normalizeSiteException(site)
    if (!domain) return
    const previous = this.settings
    const current = previous.siteExceptions.filter((d) => d !== domain)
    if (excepted) current.push(domain)
    if (current.length === previous.siteExceptions.length && !excepted) return
    this.browser.state.settings.blocking = { ...previous, siteExceptions: current }
    this.syncSets(previous)
    this.browser.state.commit()
  }

  // ---------------------------------------------------------------------------
  // Filter lists
  // ---------------------------------------------------------------------------

  /** Refresh one list, or every enabled one, from its canonical URL now. */
  async updateLists(id?: string): Promise<void> {
    const targets = id
      ? this.sources().filter((s) => s.id === id)
      : this.sources().filter((s) => enabledListsFor(this.settings).has(s.id))
    if (targets.length === 0) return
    const results = await Promise.all(targets.map((s) => this.enqueue(s.id)))
    const failed = results.filter((ok) => !ok).length
    if (failed === 0) {
      this.browser.toast(
        targets.length === 1 ? `${targets[0].name} is up to date.` : 'Filter lists are up to date.'
      )
    } else {
      this.browser.toast(
        failed === targets.length
          ? 'Zenium could not update the filter lists. Check your connection and try again.'
          : `${failed} of ${targets.length} filter lists could not be updated.`,
        'error'
      )
    }
  }

  private sources(): ListSource[] {
    const out: ListSource[] = DEFAULT_FILTER_LISTS.map((d) => ({
      id: d.id,
      name: d.name,
      url: d.url,
      homepage: d.homepage,
      licence: d.licence,
      custom: false
    }))
    for (const c of this.settings.customLists)
      out.push({ id: c.id, name: c.name, url: c.url, homepage: c.url, licence: '', custom: true })
    return out
  }

  private source(id: string): ListSource | undefined {
    return this.sources().find((s) => s.id === id)
  }

  private runtimeFor(id: string): ListRuntime {
    let rt = this.runtime.get(id)
    if (!rt) {
      rt = { updating: false, lastError: null }
      this.runtime.set(id, rt)
    }
    return rt
  }

  private isBundledCopy(id: string): boolean {
    const info = this.bundled.get(id)
    const summary = this.engine.summary(id)
    return Boolean(info && summary?.hasFilterText && summary.updatedAt === info.builtAt)
  }

  private listSet(source: ListSource, enabled: boolean): RuleSet {
    const attribution: RuleSetAttribution = {
      name: source.name,
      url: source.homepage,
      licence: source.licence
    }
    return {
      id: source.id,
      source: 'filter-list',
      priority: RULE_SET_PRIORITY.filterList,
      enabled,
      attribution
    }
  }

  /** Copy the snapshot built into the app for every default list that has no fresher copy. */
  private async seedBundled(): Promise<void> {
    const host = this.browser.platform.blocking
    if (!host) return
    let infos: BundledFilterList[]
    try {
      infos = await host.bundledLists()
    } catch (error) {
      console.warn('[zenium] bundled filter lists unavailable:', describeError(error))
      return
    }
    const enabled = enabledListsFor(this.settings)
    for (const info of infos) {
      const def = DEFAULT_FILTER_LISTS.find((d) => d.id === info.id)
      if (!def || this.stopped) continue
      this.bundled.set(info.id, info)
      const current = this.engine.summary(def.id)
      if (current?.hasFilterText && (current.updatedAt ?? 0) >= info.builtAt) continue
      const set = this.listSet(this.sourceOf(def), enabled.has(def.id))
      if (info.version) set.version = info.version
      set.updatedAt = info.builtAt
      try {
        const installed = await host.installBundled(set, this.store.filePathFor(def.id))
        if (!installed) continue
        this.engine.setRuleSet(set, {
          persisted: true,
          hasFilterText: true,
          filterCount: installed.filterCount
        })
      } catch (error) {
        console.warn(`[zenium] bundled list ${def.id} not installed:`, describeError(error))
      }
    }
    this.browser.state.commitVolatile()
  }

  private sourceOf(def: FilterListDefinition): ListSource {
    return {
      id: def.id,
      name: def.name,
      url: def.url,
      homepage: def.homepage,
      licence: def.licence,
      custom: false
    }
  }

  /**
   * Fetch enabled lists that have no copy at all, and – with automatic updates on – refresh the
   * copies older than {@link FILTER_LIST_MAX_AGE_MS}.
   */
  private async sweep(): Promise<void> {
    if (this.stopped) return
    const now = Date.now()
    const enabled = enabledListsFor(this.settings)
    for (const source of this.sources()) {
      if (!enabled.has(source.id) || this.runtime.get(source.id)?.updating) continue
      const summary = this.engine.summary(source.id)
      const missing = !summary?.hasFilterText
      const stale = (summary?.updatedAt ?? 0) + FILTER_LIST_MAX_AGE_MS < now
      if (missing || (stale && this.settings.autoUpdate)) await this.enqueue(source.id)
    }
  }

  /** Fetch `id` after the fetches already queued; resolves with whether it succeeded. */
  private enqueue(id: string): Promise<boolean> {
    const rt = this.runtimeFor(id)
    rt.updating = true
    this.browser.state.commitVolatile()
    const run = this.queue.then(() => this.fetchList(id))
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async fetchList(id: string): Promise<boolean> {
    const rt = this.runtimeFor(id)
    const source = this.source(id)
    if (!source || this.stopped) {
      rt.updating = false
      this.browser.state.commitVolatile()
      return false
    }
    try {
      const response = await this.browser.platform.net.fetchText(source.url, {
        headers: { Accept: 'text/plain, */*;q=0.5' },
        timeoutMs: FETCH_TIMEOUT_MS
      })
      if (!response.ok)
        throw new Error(
          response.status ? `the server answered ${response.status}` : 'you appear to be offline'
        )
      const prepared = prepareListText(response.text)
      if (prepared.count === 0 || /^\s*</.test(response.text))
        throw new Error('the download is not a filter list')
      const header = parseListHeader(response.text)
      const set = this.listSet(source, enabledListsFor(this.settings).has(id))
      set.filterText = prepared.text
      set.updatedAt = Date.now()
      if (header.version) set.version = header.version
      if (source.custom) {
        const name = header.title ?? source.name
        set.attribution = {
          name,
          url: header.homepage ?? source.url,
          licence: header.licence ?? ''
        }
        this.renameCustomList(id, name)
      }
      this.engine.setRuleSet(set)
      rt.lastError = null
      return true
    } catch (error) {
      rt.lastError = describeError(error)
      console.warn(`[zenium] filter list ${id} not updated:`, rt.lastError)
      return false
    } finally {
      rt.updating = false
      this.browser.state.commitVolatile()
    }
  }

  private renameCustomList(id: string, name: string): void {
    const s = this.settings
    const list = s.customLists.find((c) => c.id === id)
    if (!list || list.name === name) return
    this.browser.state.settings.blocking = {
      ...s,
      customLists: s.customLists.map((c) => (c.id === id ? { ...c, name } : c))
    }
    this.browser.state.commit()
  }

  // ---------------------------------------------------------------------------
  // Settings → rule sets
  // ---------------------------------------------------------------------------

  /**
   * Make the engine reflect the settings: the two builtin sets, the user's filters, which lists
   * are on, and which custom lists exist. Sets are only touched when something changed.
   */
  private syncSets(previous: BlockingSettings | null): void {
    const s = this.settings
    const off = !s.enabled || s.level === 'off'
    this.ensureBuiltin({
      id: BUILTIN_RULE_SETS.globalOff,
      source: 'builtin',
      priority: RULE_SET_PRIORITY.globalOff,
      enabled: off,
      rules: [{ id: 1, action: { type: 'allow' }, condition: {} }]
    })
    this.ensureBuiltin({
      id: BUILTIN_RULE_SETS.siteExceptions,
      source: 'builtin',
      priority: RULE_SET_PRIORITY.siteExceptions,
      enabled: s.siteExceptions.length > 0,
      rules: s.siteExceptions.map(siteExceptionRule)
    })

    const userText = s.userFilters.trim()
    if (
      !previous ||
      previous.userFilters !== s.userFilters ||
      (userText && !this.engine.has(USER_RULE_SET_ID))
    ) {
      if (userText) {
        const prepared = prepareListText(s.userFilters)
        this.userFilterErrors = validateFilterText(s.userFilters)
        this.engine.setRuleSet({
          id: USER_RULE_SET_ID,
          source: 'user',
          priority: RULE_SET_PRIORITY.user,
          enabled: true,
          filterText: prepared.text,
          updatedAt: Date.now()
        })
      } else {
        this.userFilterErrors = []
        if (this.engine.has(USER_RULE_SET_ID)) this.engine.removeRuleSet(USER_RULE_SET_ID)
      }
    }

    const enabled = enabledListsFor(s)
    const wasEnabled = previous ? enabledListsFor(previous) : new Set<string>()
    const wanted = new Set(this.sources().map((source) => source.id))
    for (const summary of this.engine.listRuleSets()) {
      if (summary.source !== 'filter-list') continue
      if (!wanted.has(summary.id)) {
        // A custom list the user removed.
        this.engine.removeRuleSet(summary.id)
        this.runtime.delete(summary.id)
        continue
      }
      this.engine.setEnabled(summary.id, enabled.has(summary.id))
    }
    for (const source of this.sources()) {
      const summary = this.engine.summary(source.id)
      const on = enabled.has(source.id)
      if (!summary) {
        // Unknown to the engine: register it (disabled sets keep their place in the index).
        this.engine.setRuleSet(this.listSet(source, on))
      }
      // Just switched on without content (a custom list added, a stricter level on a build
      // without a snapshot): fetch now instead of waiting for the next sweep.
      const fresh = on && !wasEnabled.has(source.id) && !(summary?.hasFilterText ?? false)
      if (fresh && this.ready && !this.runtime.get(source.id)?.updating)
        void this.enqueue(source.id)
    }
  }

  private ensureBuiltin(set: RuleSet & { rules: Rule[] }): void {
    const signature = `${set.enabled ? 1 : 0}:${JSON.stringify(set.rules)}`
    if (this.builtinSignatures.get(set.id) === signature && this.engine.has(set.id)) return
    this.builtinSignatures.set(set.id, signature)
    this.engine.setRuleSet(set)
  }
}

/** Everything under a document on `domain` (or its subdomains) is allowed. */
export function siteExceptionRule(domain: string, index: number): Rule {
  return {
    id: index + 1,
    action: { type: 'allowAllRequests' },
    condition: { requestDomains: [domain], resourceTypes: ['main_frame', 'sub_frame'] }
  }
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error:\s*/, '') || 'unknown error'
}
