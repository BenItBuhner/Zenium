import type {
  HistoryDayGroup,
  HistoryEntry,
  HistoryQuery,
  HistoryTransition,
  HistoryVisit,
  TopSite
} from '../shared/types'
import { JsonStore } from './store/JsonStore'
import { getDomain, getHost, isInternalUrl } from '../shared/url'
import { dayKeyOf, dayStart } from '../shared/dayKey'
import { newId } from '../shared/ids'
import {
  countTitleHits,
  matchableText,
  matchesAtWordStart,
  matchesEveryTerm,
  queryTerms
} from '../shared/wordMatch'
import type { StoreIO } from './platform'

export { matchesAtWordStart, queryTerms }

/** Aggregates (one per URL) kept at most. */
export const MAX_ENTRIES = 10_000
/** Visits kept at most. */
export const MAX_VISITS = 50_000
/** Visits older than this are expired. */
export const RETENTION_MS = 90 * 86_400_000

const DAY_MS = 86_400_000

interface PersistedV1 {
  version: 1
  entries: HistoryEntry[]
}

interface PersistedV2 {
  version: 2
  entries: HistoryEntry[]
  visits: HistoryVisit[]
}

export type PersistedHistory = PersistedV1 | PersistedV2

export interface HistoryData {
  entries: HistoryEntry[]
  visits: HistoryVisit[]
}

export { dayKeyOf }

export type HistoryChangeKind = 'visit' | 'delete' | 'clear'
export type HistoryChangeListener = (kind: HistoryChangeKind) => void

export interface VisitOptions {
  transition?: HistoryTransition
  tabId?: string
  /** The visit's time, ms since the epoch; absent means now. Values in the future clamp to now. */
  at?: number
  /**
   * The redirect chain the navigation went through before landing on `url`: the earlier
   * addresses, first hop to last (history-23). Each becomes a visit flagged `redirectSource` at
   * the landing's time, as Chrome records a chain (`HistoryBackend::AddPage`: one visit per hop,
   * one timestamp, only the last one `CHAIN_END`); the first hop keeps the navigation's
   * transition (the typed credit goes to the address the user asked for), the others and the
   * landing read `redirect`. Unrecordable addresses and the landing itself are skipped.
   */
  redirectedFrom?: string[]
}

/** One visit another browser recorded. */
export interface ImportedVisit {
  url: string
  title?: string
  /** ms since the epoch (required: an import is never "now"). */
  at: number
  /** Default `'link'`; importers map their source's transition when they have one. */
  transition?: HistoryTransition
  favicon?: string | null
  /** A redirect chain's hop, not the page landed on (`HistoryVisit.redirectSource`). */
  redirectSource?: true
  /** A landing's chain, first hop to last (`HistoryVisit.redirectedFrom`). */
  redirectedFrom?: string[]
}

/** Hops a chain keeps at most (Chrome's `net::URLRequest::kMaxRedirects`). */
export const MAX_REDIRECT_HOPS = 20

export interface ImportVisitsOptions {
  /**
   * `'chrome' | 'edge' | 'firefox' | 'safari'` or another importer id; for the result and
   * logging only, not persisted.
   */
  source: string
}

export interface ImportVisitsResult {
  /** Visits written. */
  imported: number
  /**
   * Visits skipped: duplicates by (url, at) against stored visits or within the batch,
   * unrecordable URLs, invalid `at`, and visits older than the 90-day retention window.
   */
  skipped: number
}

/**
 * A page of the visit list for another device (sync's export, W4-3): `visitTime >= since` (and
 * `< until` when given), oldest first, at most `limit` per page. `cursor` is the `next` of the
 * previous page; null or absent starts at `since`.
 */
export interface ExportVisitsQuery {
  since: number
  until?: number
  /** Default `EXPORT_PAGE_SIZE` (500); capped at that. */
  limit?: number
  cursor?: string | null
}

export interface ExportVisitsPage {
  /** In the import's shape, so a device's export is another's import unchanged. */
  visits: ImportedVisit[]
  /** Where the next page starts; null when this was the last. */
  next: string | null
}

/** The identity of a visit across devices: visit ids are per device, `(url, at)` is not. */
export interface HistoryVisitKey {
  url: string
  at: number
}

/**
 * What changed in the visit list, with its payload (the payload-less `onChange` stays for the
 * page, the omnibox and the new tab page): visits written (one event per `visit()` and one per
 * `importVisits` batch), visits removed by key, a time range removed (`deleteRange`, `deleteDay`:
 * `[from, to)`), or everything (`clear`). What sync records as its tombstones.
 */
export type HistoryVisitsEvent =
  | { type: 'added'; visits: ImportedVisit[] }
  | { type: 'removed'; keys: HistoryVisitKey[] }
  | { type: 'range-removed'; from: number; to: number }
  | { type: 'cleared' }
export type HistoryVisitsListener = (event: HistoryVisitsEvent) => void

/** Visits per `exportVisits` page at most. */
export const EXPORT_PAGE_SIZE = 500

// ---------------------------------------------------------------------------
// Pure helpers (importable by the renderer, the core and the hosts)
// ---------------------------------------------------------------------------

/** Pages that never enter history: chrome, view-source and inline documents. */
export function isRecordableUrl(url: string): boolean {
  if (!url) return false
  if (isInternalUrl(url)) return false
  return !url.startsWith('view-source:') && !url.startsWith('data:')
}

/**
 * Bring a stored document (any version, possibly corrupt) up to the current shape. A v1 file
 * had aggregates only: each becomes one synthetic `restored` visit at its last visit time, the
 * visit count stays as it was.
 */
export function migrateHistory(data: unknown): HistoryData {
  if (!data || typeof data !== 'object') return { entries: [], visits: [] }
  const doc = data as { version?: unknown; entries?: unknown; visits?: unknown }
  const entries = (Array.isArray(doc.entries) ? doc.entries : []).filter(isEntry).map((e) => ({
    ...e,
    firstVisit: e.firstVisit ?? e.lastVisit,
    typedCount: e.typedCount ?? 0
  }))
  if (doc.version === 1) {
    const visits: HistoryVisit[] = entries.map((e) => ({
      id: newId('visit'),
      url: e.url,
      title: e.title,
      favicon: e.favicon,
      visitTime: e.lastVisit,
      transition: 'restored'
    }))
    return { entries, visits: sortByTime(visits) }
  }
  if (doc.version === 2) {
    // The chain fields are read as written by this build or left out (an older store has
    // none; a hand-edited one may hold anything).
    const visits = (Array.isArray(doc.visits) ? doc.visits : []).filter(isVisit).map((v) => {
      const rest: HistoryVisit = { ...v }
      delete rest.redirectSource
      delete rest.redirectedFrom
      return { ...rest, ...chainFields(v) }
    })
    return { entries, visits: sortByTime(visits) }
  }
  return { entries: [], visits: [] }
}

function isEntry(e: unknown): e is HistoryEntry {
  if (!e || typeof e !== 'object') return false
  const x = e as Partial<HistoryEntry>
  return typeof x.url === 'string' && typeof x.lastVisit === 'number'
}

function isVisit(v: unknown): v is HistoryVisit {
  if (!v || typeof v !== 'object') return false
  const x = v as Partial<HistoryVisit>
  return typeof x.id === 'string' && typeof x.url === 'string' && typeof x.visitTime === 'number'
}

function sortByTime(visits: HistoryVisit[]): HistoryVisit[] {
  return [...visits].sort((a, b) => a.visitTime - b.visitTime)
}

/** A caller-supplied visit time: absent or unusable means now, the future clamps to now. */
function clampVisitTime(at: number | undefined, now: number): number {
  return typeof at === 'number' && Number.isFinite(at) ? Math.min(at, now) : now
}

/**
 * Where a visit at `time` goes in a chronological list so it stays sorted: after every visit at
 * the same time (binary search; the list's end when it is the newest).
 */
function insertionIndex(visits: HistoryVisit[], time: number): number {
  let lo = 0
  let hi = visits.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (visits[mid].visitTime <= time) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** One chronological list out of two (stable: `a`'s visit goes first at equal times). */
function mergeByTime(a: HistoryVisit[], b: HistoryVisit[]): HistoryVisit[] {
  const out: HistoryVisit[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) out.push(a[i].visitTime <= b[j].visitTime ? a[i++] : b[j++])
  while (i < a.length) out.push(a[i++])
  while (j < b.length) out.push(b[j++])
  return out
}

/** The identity of a visit for import deduplication. */
function visitKey(url: string, time: number): string {
  return `${time}\n${url}`
}

/**
 * A stored visit in the wire shape (`ImportedVisit`): the title only when the page has one (the
 * URL stands in for a missing title in the store), the favicon only when it is a fetchable
 * address – an inline `data:` icon can be tens of kilobytes, too heavy for a visit record; the
 * receiving device fetches its own.
 */
function exported(
  url: string,
  title: string,
  at: number,
  transition: HistoryTransition,
  favicon: string | null | undefined,
  chain?: Pick<HistoryVisit, 'redirectSource' | 'redirectedFrom'>
): ImportedVisit {
  const out: ImportedVisit = { url, at, transition }
  if (title && title !== url) out.title = title
  if (favicon && /^https?:/i.test(favicon)) out.favicon = favicon
  if (chain?.redirectSource) out.redirectSource = true
  if (chain?.redirectedFrom?.length) out.redirectedFrom = [...chain.redirectedFrom]
  return out
}

/**
 * A redirect chain as the store keeps it: recordable addresses only, the landing itself and
 * repeated hops dropped, the last `MAX_REDIRECT_HOPS` kept. Null when nothing is left.
 */
export function redirectChain(hops: unknown, landing: string): string[] | null {
  if (!Array.isArray(hops)) return null
  const out: string[] = []
  for (const hop of hops) {
    if (typeof hop !== 'string' || !isRecordableUrl(hop) || hop === landing) continue
    if (out.includes(hop)) continue
    out.push(hop)
  }
  if (out.length === 0) return null
  return out.length > MAX_REDIRECT_HOPS ? out.slice(out.length - MAX_REDIRECT_HOPS) : out
}

/**
 * Whether `to` is `from` moved from http to https and nothing else – Chrome's
 * `FormatUrlForRedirectComparison` (`history_backend.cc`): scheme, port, credentials and a
 * `www.` aside, the two addresses read the same.
 */
export function isHttpsUpgrade(from: string, to: string): boolean {
  if (!/^http:/i.test(from) || !/^https:/i.test(to)) return false
  const a = comparableAddress(from)
  return a !== null && a === comparableAddress(to)
}

function comparableAddress(url: string): string | null {
  try {
    const u = new URL(url)
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname}${u.search}${u.hash}`
  } catch {
    return null
  }
}

/** The chain fields a visit carries, read defensively (a peer's page, an older store). */
function chainFields(v: {
  redirectSource?: unknown
  redirectedFrom?: unknown
  url: string
}): Pick<HistoryVisit, 'redirectSource' | 'redirectedFrom'> {
  const out: Pick<HistoryVisit, 'redirectSource' | 'redirectedFrom'> = {}
  if (v.redirectSource === true) out.redirectSource = true
  const chain = redirectChain(v.redirectedFrom, v.url)
  if (chain) out.redirectedFrom = chain
  return out
}

/** The `removed` event of a deletion: the keys of the visits that went. */
function removedKeys(removed: HistoryVisit[]): HistoryVisitsEvent {
  return { type: 'removed', keys: removed.map((v) => ({ url: v.url, at: v.visitTime })) }
}

/** Local midnight after a day key (the day's end, exclusive; DST days are 23 or 25 hours). */
function dayEnd(dayKey: string): number {
  const [y, m, d] = dayKey.split('-').map(Number)
  return new Date(y, (m || 1) - 1, (d || 1) + 1).getTime()
}

function encodeExportCursor(at: number, url: string): string {
  return `${at}\n${url}`
}

function decodeExportCursor(cursor: string | null | undefined): HistoryVisitKey | null {
  if (!cursor) return null
  const nl = cursor.indexOf('\n')
  if (nl <= 0) return null
  const at = Number(cursor.slice(0, nl))
  const url = cursor.slice(nl + 1)
  return Number.isFinite(at) && url ? { url, at } : null
}

/**
 * Retention: expire visits older than 90 days, keep at most 50 000 visits and 10 000
 * aggregates (the newest of each). Aggregates that lost their last visit go too.
 */
export function prune(visits: HistoryVisit[], entries: HistoryEntry[], nowMs: number): HistoryData {
  const cutoff = nowMs - RETENTION_MS
  let kept = sortByTime(visits).filter((v) => v.visitTime >= cutoff)
  if (kept.length > MAX_VISITS) kept = kept.slice(kept.length - MAX_VISITS)
  const urls = new Set(kept.map((v) => v.url))
  const keptEntries = entries
    .filter((e) => urls.has(e.url))
    .sort((a, b) => b.lastVisit - a.lastVisit)
    .slice(0, MAX_ENTRIES)
  // Visits of aggregates that fell off the cap go with them.
  if (keptEntries.length < urls.size) {
    const remaining = new Set(keptEntries.map((e) => e.url))
    kept = kept.filter((v) => remaining.has(v.url))
  }
  return { visits: kept, entries: keptEntries }
}

/**
 * Frecency (Firefox's frequency + recency): visits weigh by how recently the page was last
 * seen; typed visits count double.
 */
export function scoreFrecency(entry: HistoryEntry, nowMs: number): number {
  const ageDays = Math.max(0, nowMs - entry.lastVisit) / DAY_MS
  const weight =
    ageDays <= 4 ? 100 : ageDays <= 14 ? 70 : ageDays <= 31 ? 50 : ageDays <= 90 ? 30 : 10
  return (entry.visitCount + 2 * (entry.typedCount ?? 0)) * weight
}

/** Visits with `fromMs <= visitTime < toMs`, newest first. */
export function selectRange(visits: HistoryVisit[], fromMs: number, toMs: number): HistoryVisit[] {
  return visits
    .filter((v) => v.visitTime >= fromMs && v.visitTime < toMs)
    .sort((a, b) => b.visitTime - a.visitTime)
}

/**
 * How well a history aggregate answers a typing (omnibox-02, HistoryURL + HistoryQuick): the
 * visits weighted by recency, typed visits counting three times (the address was wanted by
 * name), a start-of-address match on top, and the share of the terms that start a word in the
 * title over those found in the address alone (Chrome's HistoryQuick weighs title hits over URL
 * hits). A term that starts no word in the title or the address is no match (null): Chrome's
 * history providers find nothing inside a word (`shared/wordMatch.ts`), so "docs" does not bring
 * up "Googledocs".
 */
export function scoreHistoryMatch(
  entry: HistoryEntry,
  terms: readonly string[],
  nowMs: number
): number | null {
  const text = matchableText(entry.title, entry.url)
  if (terms.length === 0 || !matchesEveryTerm(text, terms)) return null
  const ageDays = Math.max(0, nowMs - entry.lastVisit) / DAY_MS
  const recency = 1 / (1 + ageDays)
  const typed = entry.typedCount ?? 0
  const hostMatch = text.url.startsWith(terms.join(' ')) ? 2 : 0
  const titleHits = countTitleHits(text, terms) / terms.length
  return Math.log1p(entry.visitCount + 3 * typed) + recency * 2 + hostMatch + titleHits
}

/**
 * Visits matching a query (every term at the start of a word in the title or URL – Chrome's
 * history page's rule, history-03; the host; the time range), newest first, then `offset` /
 * `limit` applied.
 */
export function searchVisits(visits: HistoryVisit[], query: HistoryQuery): HistoryVisit[] {
  const terms = queryTerms(query.text)
  const host = query.host?.toLowerCase().replace(/^www\./, '') ?? null
  const from = query.fromMs ?? -Infinity
  const to = query.toMs ?? Infinity
  const hops = query.includeRedirectSources === true
  const matched = visits.filter((v) => {
    // A redirect chain's hops are not what the user saw: Chrome's `QueryHistory` lists the
    // visits with `CHAIN_END` only (`visit_database.cc` `TransitionIsVisible`).
    if (v.redirectSource && !hops) return false
    if (v.visitTime < from || v.visitTime >= to) return false
    if (host !== null && !hostMatches(v.url, host)) return false
    if (terms.length === 0) return true
    return matchesEveryTerm(matchableText(v.title, v.url), terms)
  })
  matched.sort((a, b) => b.visitTime - a.visitTime)
  const offset = Math.max(0, query.offset ?? 0)
  return matched.slice(offset, offset + Math.max(0, query.limit))
}

function hostMatches(url: string, host: string): boolean {
  const h = getHost(url)
    .toLowerCase()
    .replace(/^www\./, '')
  return h === host || h.endsWith(`.${host}`)
}

/** Visits grouped by local day, newest day first, newest visit first inside a day. */
export function groupByDay(visits: HistoryVisit[], timeZone?: string): HistoryDayGroup[] {
  const groups = new Map<string, HistoryVisit[]>()
  for (const v of [...visits].sort((a, b) => b.visitTime - a.visitTime)) {
    const key = dayKeyOf(v.visitTime, timeZone)
    const list = groups.get(key)
    if (list) list.push(v)
    else groups.set(key, [v])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([dayKey, list]) => ({ dayKey, visits: list }))
}

/**
 * Most visited sites: aggregates folded by host, the best-scoring page of each host standing
 * for it, ordered by summed frecency. `excludedHosts` (with or without `www.`) are skipped, as
 * is anything that is not an http(s) page.
 */
export function topSites(
  entries: HistoryEntry[],
  n: number,
  excludedHosts: string[] = [],
  nowMs: number = Date.now()
): TopSite[] {
  const excluded = new Set(excludedHosts.map((h) => h.toLowerCase().replace(/^www\./, '')))
  const byHost = new Map<string, { best: HistoryEntry; bestScore: number; score: number }>()
  for (const e of entries) {
    if (!/^https?:\/\//i.test(e.url)) continue
    const host = getHost(e.url)
      .toLowerCase()
      .replace(/^www\./, '')
    if (!host || excluded.has(host)) continue
    const score = scoreFrecency(e, nowMs)
    const site = byHost.get(host)
    if (!site) byHost.set(host, { best: e, bestScore: score, score })
    else {
      site.score += score
      if (score > site.bestScore) {
        site.best = e
        site.bestScore = score
      }
    }
  }
  return [...byHost.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, n))
    .map(({ best, score }) => ({
      url: best.url,
      title: best.title,
      favicon: best.favicon,
      score
    }))
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** How often at most `history.changed` fires for visits. */
const VISIT_NOTIFY_MS = 500

/** What one import batch adds to a page's aggregate. */
interface ImportedPage {
  count: number
  first: number
  last: number
  typed: number
  /** The newest imported visit of the page that carried a title. */
  title: { at: number; text: string } | null
  /** The newest imported visit of the page that carried a favicon. */
  favicon: { at: number; icon: string } | null
}

/**
 * Browsing history: every visit of a page plus a per-URL aggregate for ranking. Persisted as
 * `history.json` (version 2); chrome pages, `view-source:` and `data:` URLs are never recorded.
 */
export class HistoryService {
  private entries = new Map<string, HistoryEntry>()
  /** Chronological (oldest first). */
  private visitList: HistoryVisit[] = []
  private readonly store: JsonStore<PersistedHistory>
  private readonly listeners = new Set<HistoryChangeListener>()
  private readonly visitsListeners = new Set<HistoryVisitsListener>()
  private visitNotifyTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    io: StoreIO,
    private readonly now: () => number = () => Date.now()
  ) {
    this.store = new JsonStore<PersistedHistory>(io, 'history.json', 2000)
    const raw = this.store.readSync()
    const loaded = migrateHistory(raw)
    const pruned = prune(loaded.visits, loaded.entries, this.now())
    for (const e of pruned.entries) this.entries.set(e.url, e)
    this.visitList = pruned.visits
    // A migrated or pruned document is written back in its new shape right away.
    const storedVisits = raw?.version === 2 && Array.isArray(raw.visits) ? raw.visits.length : -1
    if (raw && pruned.visits.length !== storedVisits) this.persist()
  }

  /**
   * Record a visit and update the page's aggregate. `opts.at` dates the visit (default now): an
   * older visit raises the count and may move `firstVisit` back, but the title, favicon and
   * `lastVisit` only follow the newest visit of the page.
   */
  visit(url: string, title: string, favicon: string | null, opts: VisitOptions = {}): void {
    if (!isRecordableUrl(url)) return
    const now = this.now()
    const at = clampVisitTime(opts.at, now)
    // Retention would expire it at once; the aggregate must not count what is not kept.
    if (at < now - RETENTION_MS) return
    const transition = opts.transition ?? 'link'
    const chain = redirectChain(opts.redirectedFrom, url)
    const added: ImportedVisit[] = []
    // The chain's hops first, at the landing's time (Chrome records every hop of a chain with
    // one timestamp, `history_backend.cc` `AddPage`): the navigation's transition belongs to
    // the first member – a typed address that redirected was still typed, and Chrome's typed
    // credit goes there (`IsTypedIncrement`) – and every later one was reached by the redirect.
    // One exception, Chrome's too: a typed http address that only moved to its https twin
    // credits the https one (`transfer_typed_credit_from_first_to_second_url`); the label moves
    // with the credit, because the label is what a later reader counts typed credit from – this
    // store's recount after a deletion, a peer's import of the chain – and the two must agree.
    const members = chain ? [...chain, url] : [url]
    const creditedMember =
      transition === 'typed' && chain && isHttpsUpgrade(members[0], members[1]) ? 1 : 0
    const memberTransition = (i: number): HistoryTransition =>
      i === creditedMember ? transition : 'redirect'
    if (chain) {
      for (let i = 0; i < chain.length; i += 1) {
        const hop = chain[i]
        const hopTransition = memberTransition(i)
        // No title of its own: a hop keeps the one its landing gave it (`updateTitle`).
        this.bumpEntry(hop, '', null, at, hopTransition === 'typed')
        this.insertVisit({
          id: newId('visit'),
          url: hop,
          title: hop,
          favicon: null,
          visitTime: at,
          transition: hopTransition,
          redirectSource: true,
          ...(opts.tabId ? { tabId: opts.tabId } : {})
        })
        added.push(exported(hop, '', at, hopTransition, null, { redirectSource: true }))
      }
    }
    const landingTransition = memberTransition(members.length - 1)
    this.bumpEntry(url, title, favicon, at, landingTransition === 'typed')
    this.insertVisit({
      id: newId('visit'),
      url,
      title: title || url,
      favicon: null,
      visitTime: at,
      transition: landingTransition,
      ...(opts.tabId ? { tabId: opts.tabId } : {}),
      ...(chain ? { redirectedFrom: chain } : {})
    })
    added.push(
      exported(url, title, at, landingTransition, favicon, chain ? { redirectedFrom: chain } : {})
    )
    this.enforceRetention(now)
    this.persist()
    this.notify('visit')
    this.emitVisits({ type: 'added', visits: added })
  }

  /**
   * One more visit of `url` at `at` on its aggregate (created when the page is new); `typed`
   * counts it among the typed ones.
   */
  private bumpEntry(
    url: string,
    title: string,
    favicon: string | null,
    at: number,
    typed: boolean
  ): void {
    const existing = this.entries.get(url)
    if (existing) {
      existing.visitCount += 1
      if (typed) existing.typedCount = (existing.typedCount ?? 0) + 1
      existing.firstVisit = Math.min(existing.firstVisit ?? existing.lastVisit, at)
      if (at >= existing.lastVisit) {
        existing.lastVisit = at
        if (title) existing.title = title
        if (favicon) existing.favicon = favicon
        // Re-insert to keep the map in recency order.
        this.entries.delete(url)
        this.entries.set(url, existing)
      }
      return
    }
    this.entries.set(url, {
      url,
      title: title || url,
      visitCount: 1,
      lastVisit: at,
      firstVisit: at,
      typedCount: typed ? 1 : 0,
      favicon
    })
  }

  /** Add one visit to the chronological list: appended when newest, else at its place. */
  private insertVisit(v: HistoryVisit): void {
    this.chains = null
    const last = this.visitList[this.visitList.length - 1]
    if (!last || v.visitTime >= last.visitTime) this.visitList.push(v)
    else this.visitList.splice(insertionIndex(this.visitList, v.visitTime), 0, v)
  }

  // --- redirect chains (history-23) --------------------------------------------

  /**
   * The most recent chain each address took part in (Chrome's `recent_redirects_`): by the
   * landing, the hops that led to it; by a hop, the landing it led to. Built from the visit list
   * on demand and dropped when the list changes.
   */
  private chains: { byLanding: Map<string, string[]>; byHop: Map<string, string> } | null = null

  private chainIndex(): NonNullable<HistoryService['chains']> {
    if (this.chains) return this.chains
    const byLanding = new Map<string, string[]>()
    const byHop = new Map<string, string>()
    for (let i = this.visitList.length - 1; i >= 0; i -= 1) {
      const v = this.visitList[i]
      if (!v.redirectedFrom?.length || byLanding.has(v.url)) continue
      byLanding.set(v.url, v.redirectedFrom)
      for (const hop of v.redirectedFrom) if (!byHop.has(hop)) byHop.set(hop, v.url)
    }
    this.chains = { byLanding, byHop }
    return this.chains
  }

  /**
   * The addresses of the most recent redirect chain `url` took part in, hops first and the
   * landing last: where the user landed from (the chain's landing) or what a hop led to. Just
   * `[url]` for a page no chain touched.
   */
  redirectChainOf(url: string): string[] {
    const { byLanding, byHop } = this.chainIndex()
    const landing = byLanding.has(url) ? url : byHop.get(url)
    if (!landing) return [url]
    return [...(byLanding.get(landing) ?? []), landing]
  }

  /** The `redirectSource` visits of the chain that landed with `landing` (same time, its hops). */
  private hopsOf(landing: HistoryVisit): HistoryVisit[] {
    const chain = landing.redirectedFrom
    if (!chain?.length) return []
    const hops = new Set(chain)
    const out: HistoryVisit[] = []
    const start = insertionIndex(this.visitList, landing.visitTime - 1)
    for (let i = start; i < this.visitList.length; i += 1) {
      const v = this.visitList[i]
      if (v.visitTime > landing.visitTime) break
      if (v.visitTime === landing.visitTime && v.redirectSource && hops.has(v.url)) out.push(v)
    }
    return out
  }

  /**
   * Write the visits another browser recorded, as one batch: the aggregates updated once per
   * page, retention and the caps applied once, one write, one change notification (the history
   * page, the new tab page and the omnibox refresh once, not per visit). Skipped and counted:
   * pages that never enter history, an `at` that is not a finite past time, visits already stored
   * or repeated in the batch (by url and time), and visits the retention window has passed.
   * Importing the same batch again therefore writes nothing.
   */
  importVisits(visits: ImportedVisit[], opts: ImportVisitsOptions): ImportVisitsResult {
    const now = this.now()
    const cutoff = now - RETENTION_MS
    const seen = new Set<string>()
    for (const v of this.visitList) seen.add(visitKey(v.url, v.visitTime))
    const fresh: HistoryVisit[] = []
    const pages = new Map<string, ImportedPage>()
    let skipped = 0
    for (const v of visits) {
      const at = v.at
      if (
        !isRecordableUrl(v.url) ||
        typeof at !== 'number' ||
        !Number.isFinite(at) ||
        at > now ||
        at < cutoff
      ) {
        skipped += 1
        continue
      }
      const key = visitKey(v.url, at)
      if (seen.has(key)) {
        skipped += 1
        continue
      }
      seen.add(key)
      const transition = v.transition ?? 'link'
      fresh.push({
        id: newId('visit'),
        url: v.url,
        title: v.title || v.url,
        favicon: null,
        visitTime: at,
        transition,
        ...chainFields(v)
      })
      const page = pages.get(v.url)
      if (!page) {
        pages.set(v.url, {
          count: 1,
          first: at,
          last: at,
          typed: transition === 'typed' ? 1 : 0,
          title: v.title ? { at, text: v.title } : null,
          favicon: v.favicon ? { at, icon: v.favicon } : null
        })
        continue
      }
      page.count += 1
      page.first = Math.min(page.first, at)
      page.last = Math.max(page.last, at)
      if (transition === 'typed') page.typed += 1
      if (v.title && (!page.title || at >= page.title.at)) page.title = { at, text: v.title }
      if (v.favicon && (!page.favicon || at >= page.favicon.at))
        page.favicon = { at, icon: v.favicon }
    }
    if (fresh.length > 0) {
      for (const [url, page] of pages) this.applyImportedPage(url, page)
      fresh.sort((a, b) => a.visitTime - b.visitTime)
      this.visitList = mergeByTime(this.visitList, fresh)
      this.chains = null
      this.enforceRetention(now)
      this.persist()
      this.notify('visit')
      // One event for the batch, in the shape it came in (the aggregate's favicon, when any).
      this.emitVisits({
        type: 'added',
        visits: fresh.map((v) =>
          exported(v.url, v.title, v.visitTime, v.transition, this.entries.get(v.url)?.favicon, v)
        )
      })
    }
    console.info(
      `[zenium] history import from ${opts.source}: ${fresh.length} visit(s) written, ${skipped} skipped`
    )
    return { imported: fresh.length, skipped }
  }

  /**
   * A page of the visits since `since` for another device (sync's export): a pure read of the
   * chronological list – nothing is written, so the store's cadence is untouched – in the
   * import's shape, oldest first, `limit` at most, with the cursor of the next page. A cursor
   * names the last visit of the page it followed by `(at, url)`; the list may have changed in
   * between (a deletion, an older visit inserted at its place), so the next page starts after
   * that key when it is still there, else at the first visit of that time or later – a visit
   * repeated across pages is harmless, the receiving import dedupes by the same key.
   */
  exportVisits(query: ExportVisitsQuery): ExportVisitsPage {
    const limit = Math.max(
      1,
      Math.min(EXPORT_PAGE_SIZE, Math.floor(query.limit ?? EXPORT_PAGE_SIZE))
    )
    const until = query.until ?? Infinity
    let start = insertionIndex(this.visitList, query.since - 1)
    const cursor = decodeExportCursor(query.cursor)
    if (cursor) {
      start = Math.max(start, insertionIndex(this.visitList, cursor.at - 1))
      let i = start
      while (i < this.visitList.length && this.visitList[i].visitTime === cursor.at) {
        if (this.visitList[i].url === cursor.url) {
          start = i + 1
          break
        }
        i += 1
      }
    }
    const visits: ImportedVisit[] = []
    let last: HistoryVisit | null = null
    let i = start
    for (; i < this.visitList.length && visits.length < limit; i += 1) {
      const v = this.visitList[i]
      if (v.visitTime >= until) break
      visits.push(
        exported(v.url, v.title, v.visitTime, v.transition, this.entries.get(v.url)?.favicon, v)
      )
      last = v
    }
    const more = last !== null && i < this.visitList.length && this.visitList[i].visitTime < until
    return { visits, next: more ? encodeExportCursor(last!.visitTime, last!.url) : null }
  }

  /**
   * Fold a batch's visits of one page into its aggregate. The imported title and favicon fill a
   * blank or replace what an older visit left; what a newer visit set stays.
   */
  private applyImportedPage(url: string, page: ImportedPage): void {
    const existing = this.entries.get(url)
    if (!existing) {
      this.entries.set(url, {
        url,
        title: page.title?.text ?? url,
        visitCount: page.count,
        lastVisit: page.last,
        firstVisit: page.first,
        typedCount: page.typed,
        favicon: page.favicon?.icon ?? null
      })
      return
    }
    existing.visitCount += page.count
    existing.typedCount = (existing.typedCount ?? 0) + page.typed
    existing.firstVisit = Math.min(existing.firstVisit ?? existing.lastVisit, page.first)
    const untitled = !existing.title || existing.title === url
    if (page.title && (page.title.at > existing.lastVisit || untitled))
      existing.title = page.title.text
    if (page.favicon && (page.favicon.at > existing.lastVisit || !existing.favicon))
      existing.favicon = page.favicon.icon
    if (page.last > existing.lastVisit) {
      existing.lastVisit = page.last
      // Re-insert to keep the map in recency order.
      this.entries.delete(url)
      this.entries.set(url, existing)
    }
  }

  /** Expire and cap cheaply on the hot path: only when something is actually over the line. */
  private enforceRetention(now: number): void {
    const oldest = this.visitList[0]
    const overCap = this.visitList.length > MAX_VISITS || this.entries.size > MAX_ENTRIES
    if (!overCap && (!oldest || oldest.visitTime >= now - RETENTION_MS)) return
    const pruned = prune(this.visitList, [...this.entries.values()], now)
    this.visitList = pruned.visits
    this.chains = null
    this.entries = new Map(pruned.entries.map((e) => [e.url, e]))
  }

  /**
   * The page's title arrived (or changed): its aggregate and visits take it, and so do the hops
   * of the chain that last landed on it – Chrome titles the whole redirect chain of a page
   * (`HistoryBackend::SetPageTitle` over `recent_redirects_`), so a shortener's address reads as
   * the page it led to wherever it is shown.
   */
  updateTitle(url: string, title: string): void {
    if (!title) return
    let changed = false
    const e = this.entries.get(url)
    if (e && e.title !== title) {
      e.title = title
      changed = true
    }
    for (const v of this.visitList) {
      if (v.url === url && v.title !== title) {
        v.title = title
        changed = true
      }
    }
    const hops = this.chainIndex().byLanding.get(url)
    if (hops) {
      const inChain = new Set(hops)
      for (const hop of hops) {
        const he = this.entries.get(hop)
        if (he && he.title !== title) {
          he.title = title
          changed = true
        }
      }
      for (const v of this.visitList) {
        if (v.redirectSource && inChain.has(v.url) && v.title !== title) {
          v.title = title
          changed = true
        }
      }
    }
    if (changed) {
      this.persist()
      this.notify('visit')
    }
  }

  /** The page's favicon: its aggregate's, and its last chain's hops' too (Chrome maps the icon onto the chain). */
  updateFavicon(url: string, favicon: string): void {
    if (!favicon) return
    let changed = false
    const targets = [url, ...(this.chainIndex().byLanding.get(url) ?? [])]
    for (const target of targets) {
      const e = this.entries.get(target)
      if (e && e.favicon !== favicon) {
        e.favicon = favicon
        changed = true
      }
    }
    if (changed) {
      this.persist()
      this.notify('visit')
    }
  }

  recent(limit: number): HistoryEntry[] {
    return [...this.entries.values()].sort((a, b) => b.lastVisit - a.lastVisit).slice(0, limit)
  }

  /** The most recently seen favicon per registrable domain (the password manager's site icons). */
  faviconsByDomain(): Map<string, string> {
    const out = new Map<string, string>()
    // The most recently visited page of a domain wins; the map's order is not relied on because
    // `prune` rebuilds it newest first while `visit` appends newest last.
    const newest = new Map<string, number>()
    for (const e of this.entries.values()) {
      if (!e.favicon) continue
      const domain = getDomain(e.url)
      if (!domain) continue
      const seen = newest.get(domain)
      if (seen !== undefined && seen > e.lastVisit) continue
      newest.set(domain, e.lastVisit)
      out.set(domain, e.favicon)
    }
    return out
  }

  /**
   * The pages a typing matches – every term at the start of a word in the title or the address
   * – best first (`scoreHistoryMatch`: typed and visit counts, recency, an address-start match,
   * title hits over address hits).
   */
  search(query: string, limit: number): HistoryEntry[] {
    const terms = queryTerms(query)
    if (terms.length === 0) return this.recent(limit)
    const now = this.now()
    const scored: Array<{ e: HistoryEntry; score: number }> = []
    for (const e of this.entries.values()) {
      const score = scoreHistoryMatch(e, terms, now)
      if (score !== null) scored.push({ e, score })
    }
    // A redirect chain's hop is a visited address Chrome's omnibox may offer (its URL row is not
    // hidden – `history_tab_helper.cc` hides sub-frames and error pages only), but one chain
    // makes one suggestion: the lower-ranked members of a chain a higher one already stands for
    // go (`HistoryURLProvider::CullRedirects`). At an equal score the page the user saw – the
    // chain's landing – stands for it, not the address that bounced there.
    const { byLanding, byHop } = this.chainIndex()
    const hopOnly = (url: string): number => (!byLanding.has(url) && byHop.has(url) ? 1 : 0)
    scored.sort((a, b) => b.score - a.score || hopOnly(a.e.url) - hopOnly(b.e.url))
    const taken = new Set<string>()
    const out: HistoryEntry[] = []
    for (const { e } of scored) {
      const chain = this.redirectChainOf(e.url)
      if (chain.some((member) => taken.has(member))) continue
      for (const member of chain) taken.add(member)
      out.push(e)
      if (out.length >= limit) break
    }
    return out
  }

  /**
   * Inline autofill candidate for the typed text, Chrome's HistoryURL default match. Up to the
   * host, it completes a visited host (`exam` → `example.org/`, the most frecent one); once a
   * slash has been typed it completes the most frecent visited URL with that prefix
   * (`example.org/d` → `example.org/docs/intro`). `fill` is the text the field shows (no scheme,
   * no `www.` unless typed), `url` what Enter opens. Null for text with spaces or a scheme.
   */
  autofill(query: string): { fill: string; url: string } | null {
    const q = query.trim().toLowerCase()
    if (!q || /\s/.test(q) || q.includes(':')) return null
    const now = this.now()
    const wantsPath = q.includes('/')
    const best = new Map<string, { fill: string; url: string; score: number }>()
    for (const e of this.entries.values()) {
      if (!/^https?:\/\//i.test(e.url)) continue
      let parsed: URL
      try {
        parsed = new URL(e.url)
      } catch {
        continue
      }
      const host = parsed.host.toLowerCase()
      const bare = host.replace(/^www\./, '')
      const shownHost = host.startsWith(q) && !bare.startsWith(q) ? host : bare
      const ageDays = (now - e.lastVisit) / DAY_MS
      const frecency = e.visitCount + 3 * (e.typedCount ?? 0) + 2 / (1 + ageDays)
      if (!wantsPath) {
        if (!(host.startsWith(q) || bare.startsWith(q))) continue
        const fill = `${shownHost}/`
        const hit = best.get(fill)
        // Every page of the host counts towards the host's completion.
        if (hit) hit.score += frecency
        else best.set(fill, { fill, url: `${parsed.protocol}//${host}/`, score: frecency })
        continue
      }
      const path = `${parsed.pathname}${parsed.search}${parsed.hash}`
      for (const candidate of new Set([`${host}${path}`, `${bare}${path}`])) {
        if (!candidate.toLowerCase().startsWith(q)) continue
        const hit = best.get(candidate)
        if (hit) hit.score += frecency
        else best.set(candidate, { fill: candidate, url: e.url, score: frecency })
      }
    }
    let winner: { fill: string; url: string; score: number } | null = null
    for (const c of best.values()) {
      if (
        !winner ||
        c.score > winner.score ||
        (c.score === winner.score && c.fill.length < winner.fill.length)
      )
        winner = c
    }
    if (!winner) return null
    let fill = winner.fill
    // Keep the user's casing for the part they typed, so the selection does not flicker.
    fill = query.trim() + fill.slice(q.length)
    return { fill, url: winner.url }
  }

  /**
   * A page of `url`'s site was visited on an earlier day, or more than once. Chromium's download
   * warnings treat such a site as familiar and skip the file-type warning for installers it serves.
   */
  visitedBeforeToday(url: string): boolean {
    let host: string
    try {
      host = new URL(url).host.toLowerCase()
    } catch {
      return false
    }
    if (!host) return false
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    const today = midnight.getTime()
    for (const e of this.entries.values()) {
      let entryHost: string
      try {
        entryHost = new URL(e.url).host.toLowerCase()
      } catch {
        continue
      }
      if (entryHost === host && (e.lastVisit < today || e.visitCount > 1)) return true
    }
    return false
  }

  // --- visits -----------------------------------------------------------------

  /** Matching visits, newest first; favicons come from the page's aggregate. */
  visits(query: HistoryQuery): HistoryVisit[] {
    return searchVisits(this.visitList, query).map((v) => this.withFavicon(v))
  }

  groupedByDay(query: HistoryQuery): HistoryDayGroup[] {
    return groupByDay(this.visits(query))
  }

  topSites(n: number, excludedHosts: string[] = []): TopSite[] {
    return topSites([...this.entries.values()], n, excludedHosts, this.now())
  }

  /**
   * Visits with `fromMs <= visitTime < toMs`, the redirect chains' hops aside (the clear-data
   * counter counts what the history page lists, as Chrome's `GetHistoryCount` counts `CHAIN_END`
   * visits).
   */
  count(fromMs: number, toMs: number): number {
    let n = 0
    for (const v of this.visitList)
      if (!v.redirectSource && v.visitTime >= fromMs && v.visitTime < toMs) n += 1
    return n
  }

  private withFavicon(v: HistoryVisit): HistoryVisit {
    const favicon = this.entries.get(v.url)?.favicon ?? v.favicon
    return favicon === v.favicon ? v : { ...v, favicon }
  }

  /** Last known favicon of a URL (the back/forward list decorates its rows with it). */
  faviconFor(url: string): string | null {
    return this.entries.get(url)?.favicon ?? null
  }

  /**
   * Whether `url` was ever visited: a page landed on, or an address a redirect chain went
   * through (Chrome counts a hop's URL row as visited, `AddPageVisit` bumps it like any other).
   */
  visited(url: string): boolean {
    return this.entries.has(url)
  }

  /** Last known title of a URL, null when the page was never visited (or is untitled). */
  titleFor(url: string): string | null {
    const title = this.entries.get(url)?.title
    return title && title !== url ? title : null
  }

  // --- deletion ---------------------------------------------------------------

  /**
   * Remove visits by id. A landing takes the hops of its redirect chain with it (Chrome deletes
   * a visit's redirect parents alongside, `ExpireHistoryBackend::GetVisitsAndRedirectParents`):
   * the user removing a page from the list leaves no trace of the address that led there.
   */
  deleteVisits(ids: string[]): void {
    const gone = new Set(ids)
    for (const v of this.visitList) {
      if (!gone.has(v.id) || !v.redirectedFrom?.length) continue
      for (const hop of this.hopsOf(v)) gone.add(hop.id)
    }
    this.removeVisits((v) => gone.has(v.id), removedKeys)
  }

  deleteUrls(urls: string[]): void {
    const gone = new Set(urls)
    let changed = false
    for (const url of gone) if (this.entries.delete(url)) changed = true
    // removeVisits() persists and notifies itself; an aggregate without visits needs it done here.
    if (this.removeVisits((v) => gone.has(v.url), removedKeys) === 0 && changed) {
      this.persist()
      this.notify('delete')
    }
  }

  /**
   * Remove the visits stored under `keys` (`(url, at)`, the identity another device knows a
   * visit by: sync applies its tombstones through this); returns how many went.
   */
  deleteByKeys(keys: HistoryVisitKey[]): number {
    const gone = new Set(keys.map((k) => visitKey(k.url, k.at)))
    return this.removeVisits((v) => gone.has(visitKey(v.url, v.visitTime)), removedKeys)
  }

  /** Remove the visits of a local day: a range event for the day's `[midnight, next midnight)`. */
  deleteDay(dayKey: string): void {
    const from = dayStart(dayKey)
    const to = dayEnd(dayKey)
    this.removeVisits(
      (v) => dayKeyOf(v.visitTime) === dayKey,
      () => ({ type: 'range-removed', from, to }),
      Number.isFinite(from) && Number.isFinite(to)
    )
  }

  /**
   * Remove the visits in `[fromMs, toMs)`; returns how many went. The range travels as one event
   * even when nothing here was in it: the deletion is meant for every device.
   */
  deleteRange(fromMs: number, toMs: number): number {
    return this.removeVisits(
      (v) => v.visitTime >= fromMs && v.visitTime < toMs,
      () => ({ type: 'range-removed', from: fromMs, to: toMs }),
      true
    )
  }

  /**
   * A favicon seen on `url`'s site: the page's own if it was visited, else the most visited
   * page's of the same host (`www.` and case aside). For new tab page tiles of pages history may
   * not hold itself.
   */
  siteFaviconFor(url: string): string | null {
    const exact = this.entries.get(url)
    if (exact?.favicon) return exact.favicon
    const host = getHost(url)
      .toLowerCase()
      .replace(/^www\./, '')
    if (!host) return null
    let best: HistoryEntry | null = null
    for (const e of this.entries.values()) {
      if (!e.favicon) continue
      const candidate = getHost(e.url)
        .toLowerCase()
        .replace(/^www\./, '')
      if (candidate === host && (!best || e.visitCount > best.visitCount)) best = e
    }
    return best?.favicon ?? null
  }

  delete(url: string): void {
    this.deleteUrls([url])
  }

  clear(): void {
    this.entries.clear()
    this.visitList = []
    this.chains = null
    this.persist()
    this.notify('clear')
    this.emitVisits({ type: 'cleared' })
  }

  /**
   * Drop the visits matching `gone` and bring the aggregates of the affected pages in line
   * (visit count and last visit recomputed; a page without visits left is forgotten). `event`
   * describes the removal to the `onVisits` listeners, built from what went; `always` sends it
   * even when nothing here matched (a range is a deletion for every device).
   */
  private removeVisits(
    gone: (v: HistoryVisit) => boolean,
    event: (removed: HistoryVisit[]) => HistoryVisitsEvent,
    always = false
  ): number {
    const affected = new Set<string>()
    const kept: HistoryVisit[] = []
    const dropped: HistoryVisit[] = []
    for (const v of this.visitList) {
      if (gone(v)) {
        affected.add(v.url)
        dropped.push(v)
      } else kept.push(v)
    }
    const removed = dropped.length
    if (removed === 0) {
      if (always) this.emitVisits(event(dropped))
      return 0
    }
    this.visitList = kept
    this.chains = null
    for (const url of affected) {
      const entry = this.entries.get(url)
      if (!entry) continue
      const remaining = kept.filter((v) => v.url === url)
      if (remaining.length === 0) {
        this.entries.delete(url)
        continue
      }
      entry.visitCount = remaining.length
      entry.lastVisit = remaining[remaining.length - 1].visitTime
      entry.firstVisit = remaining[0].visitTime
      entry.typedCount = remaining.filter((v) => v.transition === 'typed').length
    }
    this.persist()
    this.notify('delete')
    this.emitVisits(event(dropped))
    return removed
  }

  // --- change notification ----------------------------------------------------

  onChange(listener: HistoryChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * The visit list's changes with their payload (`HistoryVisitsEvent`), delivered synchronously
   * inside the call that made them – so a caller that writes through `importVisits` or the delete
   * paths can tell its own effects apart from the user's. Beside `onChange`, not instead of it:
   * `onChange('visit')` keeps its one throttled notification per batch.
   */
  onVisits(listener: HistoryVisitsListener): () => void {
    this.visitsListeners.add(listener)
    return () => this.visitsListeners.delete(listener)
  }

  private emitVisits(event: HistoryVisitsEvent): void {
    for (const listener of [...this.visitsListeners]) listener(event)
  }

  private notify(kind: HistoryChangeKind): void {
    if (kind !== 'visit') {
      if (this.visitNotifyTimer) {
        clearTimeout(this.visitNotifyTimer)
        this.visitNotifyTimer = null
      }
      for (const listener of this.listeners) listener(kind)
      return
    }
    if (this.visitNotifyTimer) return
    this.visitNotifyTimer = setTimeout(() => {
      this.visitNotifyTimer = null
      for (const listener of this.listeners) listener('visit')
    }, VISIT_NOTIFY_MS)
  }

  // --- persistence ------------------------------------------------------------

  private persist(): void {
    this.store.write({ version: 2, entries: [...this.entries.values()], visits: this.visitList })
  }

  flushSync(): void {
    this.store.flushSync()
  }
}
