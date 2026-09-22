/**
 * Ad and tracker blocking, the host-neutral half: owns the {@link RuleEngine} and its
 * persistence, turns Settings → Privacy and security into rule sets (levels, per-list switches,
 * the user's filters), keeps the filter lists fresh from their canonical URLs and counts what the
 * hosts' request engines block. Both hosts read the rule sets this service writes under
 * `blocking/` in the profile.
 *
 * The master switch and the per-site exceptions are content settings in the permission store
 * ({@link BLOCKING_PERMISSION}: `allow` as the default switches blocking off, `allow` for an
 * origin excepts that site), so the site-information sheet lists and resets them with the other
 * permissions; this service turns them into two builtin rule sets. A third builtin set, the
 * connectivity-probe exceptions (`connectivityProbes.ts`), is fixed and always on.
 *
 * Sets another layer feeds the engine on behalf of an owner (an extension's `ext:` sets) are
 * persisted like the rest and reconciled with the owners present at that layer's start
 * ({@link BlockingService.reconcileOwners}).
 */
import {
  BLOCKING_PERMISSION,
  DEFAULT_FILTER_LISTS,
  FILTER_LIST_MAX_AGE_MS,
  enabledListsFor,
  normalizeSiteException,
  siteOriginOf,
  type BlockingSettings,
  type BlockingStatus,
  type FilterListDefinition,
  type FilterListStatus
} from '../../shared/blocking'
import { PREPARE_LIST_TASK } from '../background/tasks'
import type { Browser } from '../browser'
import type { BundledFilterList } from '../platform'
import { connectivityProbesRuleSet } from './connectivityProbes'
import { RuleEngine } from './engine'
import { prepareListText, validateFilterText, type FilterSyntaxError } from './lists'
import {
  BUILTIN_RULE_SETS,
  RULE_SET_PRIORITY,
  USER_RULE_SET_ID,
  type Rule,
  type RuleSet,
  type RuleSetAttribution,
  type RuleSetSource
} from './rules'
import { RuleSetStore } from './store'

/**
 * The first refresh sweep waits for the browser to settle; the Safe Browsing service's follows
 * at 35 s, and both go through `Browser.background` (one worker, one task at a time), so the
 * two never parse in the same window. Held while the host's `holdBackgroundWork` says so (the
 * demo harness).
 */
export const STARTUP_SWEEP_DELAY_MS = 20_000
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

/**
 * Who the persisted sets of one source belong to, for {@link BlockingService.reconcileOwners}.
 * A layer that feeds the engine on behalf of others – the extension layer's `ext:` sets
 * (`source: 'dnr'`), one owner per extension – describes its sets here; the layer itself does
 * not have to be running for its sets to apply (they are read from `blocking/index.json` at
 * start), which is why the owners' presence is declared rather than inferred.
 */
export interface RuleSetOwnership {
  /** The source whose sets are owned. */
  source: RuleSetSource
  /**
   * The owner of one of the source's sets (for `ext:` sets the extension id), or undefined for a
   * set no owner can claim – such a set is dropped by the reconciliation too, since nobody could
   * ever remove it.
   */
  ownerOf(setId: string): string | undefined
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
  /** Cancels the armed startup sweep (`BackgroundWork.armStartup`). */
  private cancelStartupSweep: (() => void) | null = null
  private counterTimer: ReturnType<typeof setTimeout> | null = null
  private queue: Promise<void> = Promise.resolve()
  private stopped = false
  private unsubscribePermissions: (() => void) | null = null
  /** What the last `syncSets` applied, so the next one only touches what changed. */
  private synced: { userFilters: string; lists: Set<string> } | null = null
  /** The fire-and-forget work started and not finished yet (see `whenSettled`). */
  private readonly inflight = new Set<Promise<unknown>>()
  private settleWaiters: (() => void)[] = []

  constructor(private readonly browser: Browser) {
    this.store = new RuleSetStore(browser.platform.io)
  }

  /**
   * Resolves once the work this service set off on its own – the bundled snapshot's seeding, the
   * list fetches queued by a settings change or a sweep, and the store's writes of what they
   * produced – has finished, including work started in turn. The engine and `blocking/` are
   * final at that point; tests and demo drivers wait on this instead of guessing how many ticks a
   * fetch and its persistence take.
   */
  async whenSettled(): Promise<void> {
    for (;;) {
      while (this.inflight.size > 0)
        await new Promise<void>((resolve) => this.settleWaiters.push(resolve))
      await this.store.whenSettled()
      if (this.inflight.size === 0) return
    }
  }

  /** Runs `work` in the background and keeps it in `inflight` until it settles. */
  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight.add(work)
    const done = (): void => {
      this.inflight.delete(work)
      if (this.inflight.size > 0) return
      const waiters = this.settleWaiters
      this.settleWaiters = []
      for (const wake of waiters) wake()
    }
    work.then(done, done)
    return work
  }

  private get settings(): BlockingSettings {
    return this.browser.state.settings.blocking
  }

  /** The master switch: blocking is on unless the permission's default allows ads everywhere. */
  get enabled(): boolean {
    return this.browser.permissions.defaultFor(BLOCKING_PERMISSION) !== 'allow'
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
    this.syncSets()
    this.unsubscribePermissions = this.browser.permissions.subscribe((change) => {
      if (change.permission !== BLOCKING_PERMISSION) return
      this.syncSets()
      this.browser.state.commitVolatile()
    })
    this.ready = true
    void this.track(
      this.seedBundled().then(() => {
        if (this.stopped) return
        const sweep = (): void => void this.track(this.sweep())
        this.cancelStartupSweep = this.browser.background.armStartup(
          STARTUP_SWEEP_DELAY_MS,
          sweep
        )
        this.sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS)
      })
    )
    this.browser.state.commitVolatile()
  }

  stop(): void {
    this.stopped = true
    this.unsubscribePermissions?.()
    this.unsubscribePermissions = null
    this.cancelStartupSweep?.()
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    if (this.counterTimer) clearTimeout(this.counterTimer)
    this.cancelStartupSweep = this.sweepTimer = this.counterTimer = null
  }

  flushSync(): void {
    this.store.flushSync()
  }

  status(): BlockingStatus {
    const s = this.settings
    const enabled = enabledListsFor(s, this.enabled)
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
      enabled: this.enabled,
      siteExceptions: this.siteExceptions(),
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
  // Settings, the master switch and per-site exceptions
  // ---------------------------------------------------------------------------

  /** `settings.blocking` changed (the caller commits). */
  onSettingsChanged(): void {
    this.syncSets()
  }

  /** Switch blocking on or off everywhere (the permission's default; the store notifies us). */
  setEnabled(enabled: boolean): void {
    this.browser.permissions.setDefault(BLOCKING_PERMISSION, enabled ? null : 'allow')
  }

  /** Origins the user excepted from blocking, sorted. */
  siteExceptions(): string[] {
    return this.browser.permissions
      .listForPermission(BLOCKING_PERMISSION)
      .filter((entry) => entry.decision === 'allow')
      .map((entry) => entry.origin)
  }

  /** Is `url` on a site the user excepted from blocking? */
  isExcepted(url: string): boolean {
    const origin = siteOriginOf(url)
    return origin !== null && this.browser.permissions.get(BLOCKING_PERMISSION, origin) === 'allow'
  }

  /** The origin a per-site exception for `url` would use, or null for pages without a site. */
  siteFor(url: string): string | null {
    return siteOriginOf(url)
  }

  /**
   * Except (or stop excepting) a site; `site` may be an origin, a URL or a bare host. Stored as
   * an `allow` decision of the permission for the origin; the store's notification re-syncs the
   * builtin set.
   */
  setSiteException(site: string, excepted: boolean): void {
    const origin = normalizeSiteException(site)
    if (!origin) return
    this.browser.permissions.set(BLOCKING_PERMISSION, origin, excepted ? 'allow' : null)
  }

  // ---------------------------------------------------------------------------
  // Filter lists
  // ---------------------------------------------------------------------------

  /** Refresh one list, or every enabled one, from its canonical URL now. */
  async updateLists(id?: string): Promise<void> {
    const enabled = enabledListsFor(this.settings, this.enabled)
    const targets = id
      ? this.sources().filter((s) => s.id === id)
      : this.sources().filter((s) => enabled.has(s.id))
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
    const enabled = enabledListsFor(this.settings, this.enabled)
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
    const enabled = enabledListsFor(this.settings, this.enabled)
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
    const run = this.track(this.queue.then(() => this.fetchList(id)))
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
      if (/^\s*</.test(response.text)) throw new Error('the download is not a filter list')
      // The list is reduced to its network filters in the host's worker where it has one
      // (`Browser.background`); the main thread receives the prepared text and its count.
      const prepared = await this.browser.background.run(PREPARE_LIST_TASK, {
        text: response.text
      })
      if (prepared.count === 0) throw new Error('the download is not a filter list')
      if (this.stopped) return false
      const header = prepared.header
      const set = this.listSet(source, enabledListsFor(this.settings, this.enabled).has(id))
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
      this.engine.setRuleSet(set, { filterCount: prepared.count })
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
   * Make the engine reflect the settings and the permission store: the three builtin sets, the
   * user's filters, which lists are on, and which custom lists exist. Sets are only touched when
   * something changed since the last sync.
   */
  private syncSets(): void {
    const s = this.settings
    const previous = this.synced
    const exceptions = this.siteExceptions()
    this.ensureBuiltin({
      id: BUILTIN_RULE_SETS.globalOff,
      source: 'builtin',
      priority: RULE_SET_PRIORITY.globalOff,
      enabled: !this.enabled || s.level === 'off',
      rules: [{ id: 1, action: { type: 'allow' }, condition: {} }]
    })
    this.ensureBuiltin({
      id: BUILTIN_RULE_SETS.siteExceptions,
      source: 'builtin',
      priority: RULE_SET_PRIORITY.siteExceptions,
      enabled: exceptions.length > 0,
      rules: exceptions.map(siteExceptionRule)
    })
    // Not a setting: the probes are allowed whatever the level, so the set is written once and
    // re-written only when a build changes it (the signature covers its rules).
    this.ensureBuiltin(connectivityProbesRuleSet())

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

    const enabled = enabledListsFor(s, this.enabled)
    const wasEnabled = previous?.lists ?? new Set<string>()
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
    this.synced = { userFilters: s.userFilters, lists: enabled }
  }

  private ensureBuiltin(set: RuleSet & { rules: Rule[] }): void {
    const signature = `${set.enabled ? 1 : 0}:${JSON.stringify(set.rules)}`
    if (this.builtinSignatures.get(set.id) === signature && this.engine.has(set.id)) return
    this.builtinSignatures.set(set.id, signature)
    this.engine.setRuleSet(set)
  }

  // ---------------------------------------------------------------------------
  // Owned sets
  // ---------------------------------------------------------------------------

  /**
   * Reconcile the persisted sets of one source with the owners that are present: every set of
   * `ownership.source` whose owner is not among `alive` (or has none) is dropped, from the engine
   * and, through the attached store, from `blocking/index.json` – the same removal as
   * `removeRuleSet`, which the Kotlin engine follows by rebuilding without the set.
   *
   * Sets outlive their owner when the owner goes while the app is closed: an extension removed or
   * disabled between two runs leaves its `ext:` sets in the index, `start()` loads them like every
   * other set and they keep filtering. The layer that owns a source calls this once at its start,
   * after `start()` here, with the owners it is about to bring up; an owner that is alive keeps its
   * sets (its own layer replaces or removes them as it loads), so the order relative to those
   * loads does not matter. Returns the ids dropped, for the caller's log.
   */
  reconcileOwners(ownership: RuleSetOwnership, alive: Iterable<string>): string[] {
    const living = new Set(alive)
    const dropped: string[] = []
    for (const summary of this.engine.listRuleSets()) {
      if (summary.source !== ownership.source) continue
      const owner = ownership.ownerOf(summary.id)
      if (owner !== undefined && living.has(owner)) continue
      this.engine.removeRuleSet(summary.id)
      dropped.push(summary.id)
    }
    return dropped
  }
}

/**
 * Everything under a document of `origin` is allowed. `|origin/` matches exactly that origin's
 * documents (scheme, host and port; the slash stops `origin.evil` and other ports).
 */
export function siteExceptionRule(origin: string, index: number): Rule {
  return {
    id: index + 1,
    action: { type: 'allowAllRequests' },
    condition: { urlFilter: `|${origin}/`, resourceTypes: ['main_frame', 'sub_frame'] }
  }
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error:\s*/, '') || 'unknown error'
}
