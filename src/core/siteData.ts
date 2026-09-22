import {
  DEFAULT_CONTAINER_ID,
  PRIVATE_CONTAINER_ID,
  type BrowsingDataType,
  type PermissionRule
} from '../shared/types'
import {
  CLEAR_ON_EXIT_TYPES,
  SITE_DATA_LIST_LIMIT,
  SITE_DATA_ORIGIN_CAP,
  compareSiteDataRows,
  resolveSiteData,
  sanitizeClearOnExit,
  sanitizeSiteDataPolicy,
  siteDataPolicyEquals,
  sortSitePatterns,
  type ClearOnExitType,
  type SiteDataAddResult,
  type SiteDataDefault,
  type SiteDataList,
  type SiteDataListing,
  type SiteDataOriginRow,
  type SiteDataPolicy,
  type SiteDataResolution,
  type SiteDataSiteState,
  type SiteDataStatus
} from '../shared/siteData'
import {
  normalizeSitePattern,
  parseSitePattern,
  sitePatternForHost,
  urlInSitePatterns
} from '../shared/sitePatterns'
import { registrableDomain } from './blocking/domain'
import type { Browser } from './browser'
import type { SiteDataHost } from './platform'
import { JsonStore } from './store/JsonStore'
import type { ZenWindow } from './window'

/**
 * A launch-time clear the last close left owed: the desktop writes it before the on-exit run
 * and drops it once the run completed inside its budget; Android writes it every time the app
 * goes to the background (process death is not observable there) and drops it when the app
 * comes back, so only a close the process did not survive is followed by a clear.
 */
export interface PendingClear {
  types: ClearOnExitType[]
  /** The clear-on-exit and never lists as they stood: whose data goes. */
  patterns: string[]
  at: number
}

interface Persisted {
  version: 1
  policy: SiteDataPolicy
  pendingClear: PendingClear | null
}

/** The document's name in the profile. */
export const SITE_DATA_FILE = 'sitedata.json'

/** What the desktop's quit waits for the on-exit run; the rest happens at the next launch. */
export const ON_EXIT_BUDGET_MS = 3000

/** Visited origins the viewer and the on-exit run consider, from the newest visit back. */
const HISTORY_ORIGIN_LIMIT = 2000

/** Where the on-exit run happens on this host. */
export type OnExitTiming = 'quit' | 'next-launch'

/**
 * Per-site cookie and site-data exceptions (Chrome's `chrome://settings/content/siteData`), the
 * on-exit clearing of browsing data, and the site-data viewer.
 *
 * The policy – the "block all" default and the three lists of patterns (`shared/sitePatterns.ts`)
 * – is persisted in `sitedata.json` and travels as the `site-data` sync record of the settings
 * scope (one record, last writer wins; a peer on a build without it ignores the record). It is
 * enforced by the hosts' header stages through `PrivacyFlags.siteData`: the desktop's
 * `PrivacyRequestHandler` and the Kotlin engine's header-stage relay withhold `Cookie` and
 * `Set-Cookie` for a never-site (`cookiesWithheld` in `protection/policy.ts`), and the desktop's
 * cookie jar drops a never-site's cookies as they land. What the header stages cannot reach is
 * recorded in `internal/parity-services/site-data-interface.md`.
 *
 * On exit, the types of `Settings.privacy.clearOnExit` go through `PrivacyService.clearBrowsingData`
 * (the same code path as the dialog; passwords are not a choice) and the sites of the clear-on-exit
 * and never lists lose their cookies and stored data. The desktop runs it from the quit path with
 * {@link ON_EXIT_BUDGET_MS} to spend; Android at the next launch ({@link PendingClear}).
 */
export class SiteDataService {
  private readonly store: JsonStore<Persisted>
  private policyDoc: SiteDataPolicy
  private pending: PendingClear | null
  private running: Promise<void> | null = null
  private started = false
  /** The desktop's quit path ran (or deferred) the on-exit clear: `noteExiting` says nothing more. */
  private ranOnExit = false

  constructor(
    private readonly browser: Browser,
    private readonly now: () => number = Date.now
  ) {
    this.store = new JsonStore<Persisted>(browser.platform.io, SITE_DATA_FILE, 300)
    const raw = this.store.readSync()
    this.policyDoc = sanitizeSiteDataPolicy(raw?.policy)
    this.pending = readPendingClear(raw?.pendingClear)
  }

  // ---------------------------------------------------------------------------
  // The policy
  // ---------------------------------------------------------------------------

  /** The persisted policy (lists in stored order; the status sorts them for display). */
  policy(): SiteDataPolicy {
    return this.policyDoc
  }

  /** What sites on no list may do: `blockAll`, else the third-party cookie mode's word. */
  default(): SiteDataDefault {
    if (this.policyDoc.blockAll) return 'block-all'
    return this.browser.state.settings.privacy.thirdPartyCookies === 'allow'
      ? 'allow'
      : 'block-third-party'
  }

  /**
   * Chrome's default radio: `allow` and `block-third-party` are the third-party cookie mode
   * (`block-third-party` keeps a stricter `block` and turns `allow` into Zenium's default,
   * `block-private`); `block-all` is the policy's own bit.
   */
  setDefault(value: SiteDataDefault, win?: ZenWindow): void {
    if (value !== 'allow' && value !== 'block-third-party' && value !== 'block-all')
      throw new Error(`Unknown site-data default: ${String(value)}`)
    const privacy = this.browser.state.settings.privacy
    const blockAll = value === 'block-all'
    if (blockAll !== this.policyDoc.blockAll) this.update({ ...this.policyDoc, blockAll })
    const mode =
      value === 'allow'
        ? 'allow'
        : value === 'block-third-party' && privacy.thirdPartyCookies === 'allow'
          ? 'block-private'
          : privacy.thirdPartyCookies
    if (mode !== privacy.thirdPartyCookies && win)
      this.browser.updateSettings({ privacy: { ...privacy, thirdPartyCookies: mode } }, win)
  }

  /**
   * Add `input` (a pattern in Chrome's grammar, or a bare host, which gets `[*.]`) to `list`.
   * A pattern already on another list moves. Refused with the reason when it is not a pattern
   * or the list is full.
   */
  add(list: SiteDataList, input: string): SiteDataAddResult {
    if (list !== 'allow' && list !== 'clearOnExit' && list !== 'block')
      return { ok: false, problem: 'Unknown list' }
    const trimmed = input.trim()
    const pattern = normalizeSitePattern(trimmed) ?? sitePatternForHost(trimmed)
    if (!pattern)
      return {
        ok: false,
        problem:
          'Enter a site such as example.com, [*.]example.com for its subdomains too, or https://example.com:8443'
      }
    const next = withoutPattern(this.policyDoc, pattern)
    if (next[list].length >= SITE_DATA_LIST_LIMIT)
      return { ok: false, problem: `This list holds ${SITE_DATA_LIST_LIMIT} sites at most` }
    next[list] = [...next[list], pattern]
    this.update(next)
    return { ok: true, pattern }
  }

  /** The site of `url` (its host, subdomains included, as Chrome's "Add" does) onto `list`. */
  addSite(list: SiteDataList, url: string): SiteDataAddResult {
    const host = hostOf(url)
    if (!host) return { ok: false, problem: 'This page has no site to add' }
    return this.add(list, host)
  }

  /** Remove `input` from whichever list holds it. */
  remove(input: string): void {
    const pattern = normalizeSitePattern(input)
    if (!pattern) return
    const next = withoutPattern(this.policyDoc, pattern)
    if (!siteDataPolicyEquals(next, this.policyDoc)) this.update(next)
  }

  /** The policy's word for `url`. */
  resolve(url: string): SiteDataResolution {
    return resolveSiteData(this.policyDoc, url)
  }

  /** What the site-information sheet shows for a page at `url`, and what adding it would add. */
  siteState(url: string): SiteDataSiteState {
    const { state, pattern } = this.resolve(url)
    const host = hostOf(url)
    return {
      state,
      pattern,
      addable: host ? sitePatternForHost(host) : null,
      default: this.default()
    }
  }

  /** A synced copy of the policy won the merge: taken whole, as the settings record is. */
  applySynced(data: unknown): void {
    const next = sanitizeSiteDataPolicy(data)
    if (siteDataPolicyEquals(next, this.policyDoc)) return
    this.update(next)
  }

  private update(next: SiteDataPolicy): void {
    const previous = this.policyDoc
    this.policyDoc = next
    this.persist()
    // The header stages read the lists through the flags; the Settings page through the state.
    this.browser.protection.onSiteDataChanged()
    this.browser.state.commitVolatile()
    // A site newly on the never list loses what it holds: the header stages keep its cookies
    // off the wire from here and the desktop's jar drops what lands, but its stored data – and,
    // on the phone, the cookies WebView's own network stack still carries – would stay otherwise.
    const added = next.block.filter((pattern) => !previous.block.includes(pattern))
    if (added.length > 0) void this.clearSites(added)
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  /** The types cleared on exit, read through the sanitiser: a synced settings record may predate them. */
  clearOnExitTypes(): ClearOnExitType[] {
    return sanitizeClearOnExit(
      (this.browser.state.settings.privacy as { clearOnExit?: unknown }).clearOnExit
    ).types
  }

  status(): SiteDataStatus {
    return {
      default: this.default(),
      allow: sortSitePatterns(this.policyDoc.allow),
      clearOnExit: sortSitePatterns(this.policyDoc.clearOnExit),
      block: sortSitePatterns(this.policyDoc.block),
      clearOnExitTypes: this.clearOnExitTypes(),
      clearsAtNextLaunch: this.onExitTiming() === 'next-launch',
      pendingClear: this.pending !== null
    }
  }

  /** Whether anything at all is cleared when the browser closes. */
  clearsOnExit(): boolean {
    return (
      this.clearOnExitTypes().length > 0 ||
      this.policyDoc.clearOnExit.length > 0 ||
      this.policyDoc.block.length > 0
    )
  }

  /**
   * Hosts whose quit the core runs (`Browser.requestQuit`) clear at quit; the rest – Android,
   * where the process goes away without a word – at the next launch.
   */
  onExitTiming(): OnExitTiming {
    return this.browser.state.capabilities.quitsThroughCore ? 'quit' : 'next-launch'
  }

  // ---------------------------------------------------------------------------
  // Clear browsing data on exit
  // ---------------------------------------------------------------------------

  /**
   * From `Browser.start`, ahead of the session's windows: a clear the last close left owed
   * starts now, so that its engine calls (the cookie jar, the storage) are queued before the
   * first restored page asks for its cookies; the rest of the run completes off the boot path.
   */
  start(): void {
    this.started = true
    if (this.pending) void this.runPending()
  }

  /** The launch-time half: whatever the last close left owed. */
  runPending(): Promise<void> {
    const pending = this.pending
    if (!pending) return Promise.resolve()
    return this.run(pending)
  }

  /**
   * The browser is closing (the desktop's quit path; the phone's background): write down what
   * is owed so a close the run does not survive is finished at the next launch. Synchronous,
   * it runs from the quit path before the profile's final write. Nothing once the desktop's
   * on-exit run has taken place in this process ({@link runOnExit} keeps or drops the marker).
   */
  noteExiting(): void {
    if (this.ranOnExit) return
    if (!this.clearsOnExit()) {
      if (this.pending) this.setPending(null)
      return
    }
    this.setPending({
      types: this.clearOnExitTypes(),
      patterns: [...this.policyDoc.clearOnExit, ...this.policyDoc.block],
      at: this.now()
    })
  }

  /**
   * The app came back to the foreground without the process having gone away (Android): the
   * close the marker anticipated did not happen. A marker a run is working through stays.
   */
  noteResumed(): void {
    if (this.pending && !this.running && this.onExitTiming() === 'next-launch')
      this.setPending(null)
  }

  /**
   * The desktop's on-exit run, from the quit path once the quit is agreed and before
   * `shutdown` freezes the profile (what the run clears from the core's own stores – the
   * history, the downloads, the recently closed tabs – is written by the final write then):
   * the marker first ({@link noteExiting}), so a run the process does not survive is finished
   * at the next launch; then the run with `budgetMs` to spend – the marker is dropped when the
   * run completes in time, else kept for the next launch. Resolves once either happened;
   * `nothing` when nothing is cleared on exit.
   */
  async runOnExit(budgetMs: number = ON_EXIT_BUDGET_MS): Promise<'done' | 'deferred' | 'nothing'> {
    this.noteExiting()
    this.ranOnExit = true
    const pending = this.pending
    if (!pending) return 'nothing'
    let timer: ReturnType<typeof setTimeout> | null = null
    const budget = new Promise<'deferred'>((resolve) => {
      timer = setTimeout(() => resolve('deferred'), budgetMs)
    })
    const outcome = await Promise.race([this.run(pending).then(() => 'done' as const), budget])
    if (timer) clearTimeout(timer)
    return outcome
  }

  private run(pending: PendingClear): Promise<void> {
    if (this.running) return this.running
    this.running = this.clear(pending)
      .then(() => {
        // The run this marker asked for is done; one written since (another background) stays.
        if (this.pending === pending) this.setPending(null)
      })
      .catch((error) => {
        console.warn('[zenium] clear on exit did not complete:', (error as Error).message)
      })
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  /**
   * The run itself: the types through the dialog's path, and the listed sites – unless the
   * cookies are among the types, which takes every site's cookies and storage anyway. Both
   * halves start at once, so that their first engine calls are queued before whatever follows.
   */
  private async clear(pending: PendingClear): Promise<void> {
    const types = pending.types.filter((t): t is ClearOnExitType => CLEAR_ON_EXIT_TYPES.includes(t))
    const typesDone =
      types.length > 0
        ? this.browser.privacy.clearBrowsingData('all', types as BrowsingDataType[])
        : null
    const sitesDone =
      pending.patterns.length > 0 && !types.includes('cookies')
        ? this.clearSites(pending.patterns)
        : null
    if (typesDone) {
      const outcome = await typesDone
      if (outcome.status !== 'ok') throw new Error(`clear refused: ${outcome.status}`)
    }
    if (sitesDone) await sitesDone
  }

  /**
   * Take the cookies and stored data of every origin the browser knows of under `patterns`:
   * the visited ones, the ones with permissions and the patterns' own hosts (a site that left
   * no other trace) first – their engine calls go out at once – then the origins the engine
   * alone holds cookies for (a frame's site, visited from no history entry).
   */
  async clearSites(patterns: readonly string[]): Promise<void> {
    const host = this.browser.platform.siteData
    if (!host) return
    const known = new Set<string>(this.knownOrigins())
    for (const text of patterns) {
      const pattern = parseSitePattern(text)
      if (!pattern || pattern.host.startsWith('[')) continue
      for (const scheme of pattern.scheme ? [pattern.scheme] : ['https', 'http'])
        known.add(`${scheme}://${pattern.host}${pattern.port ? `:${pattern.port}` : ''}`)
    }
    const covered = [...known].filter((origin) => urlInSitePatterns(patterns, origin))
    // A site whose every host, scheme and port a pattern covers goes as a whole (the phone's
    // one-shot site delete takes the cookies and the storage of every subdomain); a pattern
    // that names one host of a site takes that host's origins alone.
    const wholeSite = (site: string): boolean => patternsCoverSite(patterns, site)
    const containers = this.containerIds()
    await Promise.all(containers.map((id) => this.clearOrigins(host, id, covered, wholeSite)))
    if (!host.listOrigins) return
    for (const containerId of containers) {
      const readings = await quiet(host.listOrigins(containerId, []), [])
      const more = readings
        .map((reading) => reading.origin)
        .filter((origin) => !known.has(origin) && urlInSitePatterns(patterns, origin))
      if (more.length > 0) await this.clearOrigins(host, containerId, more, wholeSite)
    }
  }

  /** Every call for the origins goes out at once; resolves when the engine has answered them all. */
  private async clearOrigins(
    host: SiteDataHost,
    containerId: string,
    origins: string[],
    wholeSite: (site: string) => boolean = () => false
  ): Promise<void> {
    if (origins.length === 0) return
    const bySite = new Map<string, string[]>()
    for (const origin of origins) {
      const h = hostOf(origin)
      if (!h) continue
      const site = registrableDomain(h)
      bySite.set(site, [...(bySite.get(site) ?? []), origin])
    }
    const work: Promise<unknown>[] = []
    for (const [site, list] of bySite) {
      work.push(quiet(host.clearStorage(containerId, wholeSite(site) ? site : '', list), undefined))
      for (const origin of list) work.push(quiet(host.clearCookies(containerId, `${origin}/`), 0))
    }
    await Promise.all(work)
    this.browser.security.certificateExceptions.forgetContainer(containerId)
  }

  // ---------------------------------------------------------------------------
  // The viewer
  // ---------------------------------------------------------------------------

  /**
   * Every origin with data across the persistent containers – cookies, stored data, the
   * permissions the user decided – most data first, capped at {@link SITE_DATA_ORIGIN_CAP}.
   */
  async list(): Promise<SiteDataListing> {
    const host = this.browser.platform.siteData
    const rows = new Map<string, SiteDataOriginRow>()
    const rowFor = (origin: string): SiteDataOriginRow => {
      let row = rows.get(origin)
      if (!row) {
        const h = hostOf(origin) ?? origin
        row = {
          origin,
          site: registrableDomain(h),
          cookies: 0,
          usageBytes: null,
          permissions: [],
          state: this.resolve(origin).state
        }
        rows.set(origin, row)
      }
      return row
    }
    for (const rule of this.browser.permissions.rules()) {
      const origin = originOf(rule.origin)
      if (!origin) continue
      rowFor(origin).permissions.push({ permission: rule.permission, decision: rule.decision })
    }
    let sized = false
    if (host?.listOrigins) {
      const probe = this.knownOrigins()
      for (const containerId of this.containerIds()) {
        for (const reading of await quiet(host.listOrigins(containerId, probe), [])) {
          const origin = originOf(reading.origin)
          if (!origin || (reading.cookies <= 0 && (reading.usageBytes ?? 0) <= 0)) continue
          const row = rowFor(origin)
          row.cookies += Math.max(0, reading.cookies)
          if (reading.usageBytes !== null) {
            sized = true
            row.usageBytes = (row.usageBytes ?? 0) + Math.max(0, reading.usageBytes)
          }
        }
      }
    }
    const all = [...rows.values()].sort(compareSiteDataRows)
    return {
      rows: all.slice(0, SITE_DATA_ORIGIN_CAP),
      total: all.length,
      truncated: all.length > SITE_DATA_ORIGIN_CAP,
      sized
    }
  }

  /** Take one origin's cookies and stored data away in every container (its permissions stay). */
  async clearSite(origin: string): Promise<void> {
    const host = this.browser.platform.siteData
    const canonical = originOf(origin)
    if (!host || !canonical) return
    for (const containerId of this.containerIds()) await this.clearOrigins(host, containerId, [canonical])
    this.browser.state.commitVolatile()
  }

  /** Every site's cookies and data: the dialog's "Cookies and site data" over all time. */
  async clearAll(): Promise<void> {
    await this.browser.privacy.clearBrowsingData('all', ['cookies'])
  }

  // ---------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------

  /** Origins the core knows of: visited (newest first, bounded) and with permissions. */
  private knownOrigins(): string[] {
    const out = new Set<string>()
    for (const entry of this.browser.history.recent(HISTORY_ORIGIN_LIMIT)) {
      const origin = originOf(entry.url)
      if (origin) out.add(origin)
    }
    for (const rule of this.browser.permissions.rules() as PermissionRule[]) {
      const origin = originOf(rule.origin)
      if (origin) out.add(origin)
    }
    return [...out]
  }

  /** Every persistent container; the private session is wiped when its last tab closes. */
  private containerIds(): string[] {
    const ids = new Set<string>([DEFAULT_CONTAINER_ID])
    for (const container of this.browser.state.model.containers) ids.add(container.id)
    ids.delete(PRIVATE_CONTAINER_ID)
    return [...ids]
  }

  private setPending(pending: PendingClear | null): void {
    this.pending = pending
    this.persist()
    if (this.started) this.browser.state.commitVolatile()
  }

  private persist(): void {
    this.store.write({ version: 1, policy: this.policyDoc, pendingClear: this.pending })
  }

  flushSync(): void {
    this.store.flushSync()
  }
}

/**
 * Whether `patterns` cover every host of `site` (a registrable domain) on every scheme and
 * port: a `[*.]` pattern of the site or of a domain above it, with no scheme or port.
 */
export function patternsCoverSite(patterns: readonly string[], site: string): boolean {
  for (const text of patterns) {
    const pattern = parseSitePattern(text)
    if (!pattern || !pattern.subdomains || pattern.scheme || pattern.port) continue
    if (pattern.host === site || (site.endsWith(`.${pattern.host}`) && site.length > pattern.host.length))
      return true
  }
  return false
}

/** `policy` without `pattern` on any list. */
function withoutPattern(policy: SiteDataPolicy, pattern: string): SiteDataPolicy {
  return {
    blockAll: policy.blockAll,
    allow: policy.allow.filter((p) => p !== pattern),
    clearOnExit: policy.clearOnExit.filter((p) => p !== pattern),
    block: policy.block.filter((p) => p !== pattern)
  }
}

function readPendingClear(raw: unknown): PendingClear | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<PendingClear>
  const types = sanitizeClearOnExit({ types: r.types }).types
  const patterns = Array.isArray(r.patterns)
    ? r.patterns.filter((p): p is string => typeof p === 'string')
    : []
  if (types.length === 0 && patterns.length === 0) return null
  return { types, patterns, at: typeof r.at === 'number' ? r.at : 0 }
}

/** The lowercase host of a URL or origin; null without one. */
export function hostOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '')
    return host || null
  } catch {
    return null
  }
}

/** The origin of a web URL (`scheme://host[:port]`); null for anything else. */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.origin === 'null' ? null : parsed.origin
  } catch {
    return null
  }
}

async function quiet<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise
  } catch {
    return fallback
  }
}
