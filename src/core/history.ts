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
import { dayKeyOf } from '../shared/dayKey'
import { newId } from '../shared/ids'
import type { StoreIO } from './platform'

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
}

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
    const visits = (Array.isArray(doc.visits) ? doc.visits : []).filter(isVisit)
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

/** Whitespace-separated terms of a query, lower-cased. */
export function queryTerms(text: string | undefined): string[] {
  return (text ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * Visits matching a query (every term in title or URL, host, time range), newest first, then
 * `offset` / `limit` applied.
 */
export function searchVisits(visits: HistoryVisit[], query: HistoryQuery): HistoryVisit[] {
  const terms = queryTerms(query.text)
  const host = query.host?.toLowerCase().replace(/^www\./, '') ?? null
  const from = query.fromMs ?? -Infinity
  const to = query.toMs ?? Infinity
  const matched = visits.filter((v) => {
    if (v.visitTime < from || v.visitTime >= to) return false
    if (host !== null && !hostMatches(v.url, host)) return false
    if (terms.length === 0) return true
    const hay = `${v.title} ${v.url}`.toLowerCase()
    return terms.every((t) => hay.includes(t))
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
    const existing = this.entries.get(url)
    if (existing) {
      existing.visitCount += 1
      if (transition === 'typed') existing.typedCount = (existing.typedCount ?? 0) + 1
      existing.firstVisit = Math.min(existing.firstVisit ?? existing.lastVisit, at)
      if (at >= existing.lastVisit) {
        existing.lastVisit = at
        if (title) existing.title = title
        if (favicon) existing.favicon = favicon
        // Re-insert to keep the map in recency order.
        this.entries.delete(url)
        this.entries.set(url, existing)
      }
    } else {
      this.entries.set(url, {
        url,
        title: title || url,
        visitCount: 1,
        lastVisit: at,
        firstVisit: at,
        typedCount: transition === 'typed' ? 1 : 0,
        favicon
      })
    }
    this.insertVisit({
      id: newId('visit'),
      url,
      title: title || url,
      favicon: null,
      visitTime: at,
      transition,
      ...(opts.tabId ? { tabId: opts.tabId } : {})
    })
    this.enforceRetention(now)
    this.persist()
    this.notify('visit')
  }

  /** Add one visit to the chronological list: appended when newest, else at its place. */
  private insertVisit(v: HistoryVisit): void {
    const last = this.visitList[this.visitList.length - 1]
    if (!last || v.visitTime >= last.visitTime) this.visitList.push(v)
    else this.visitList.splice(insertionIndex(this.visitList, v.visitTime), 0, v)
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
        transition
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
      this.enforceRetention(now)
      this.persist()
      this.notify('visit')
    }
    console.info(
      `[zenium] history import from ${opts.source}: ${fresh.length} visit(s) written, ${skipped} skipped`
    )
    return { imported: fresh.length, skipped }
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
    this.entries = new Map(pruned.entries.map((e) => [e.url, e]))
  }

  updateTitle(url: string, title: string): void {
    if (!title) return
    const e = this.entries.get(url)
    let changed = false
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
    if (changed) {
      this.persist()
      this.notify('visit')
    }
  }

  updateFavicon(url: string, favicon: string): void {
    const e = this.entries.get(url)
    if (e && favicon && e.favicon !== favicon) {
      e.favicon = favicon
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

  /** Simple frecency-style ranking: substring matches weighted by visits and recency. */
  search(query: string, limit: number): HistoryEntry[] {
    const q = query.trim().toLowerCase()
    if (!q) return this.recent(limit)
    const terms = q.split(/\s+/)
    const now = this.now()
    const scored: Array<{ e: HistoryEntry; score: number }> = []
    for (const e of this.entries.values()) {
      const hay = `${e.title} ${e.url}`.toLowerCase()
      if (!terms.every((t) => hay.includes(t))) continue
      const ageDays = (now - e.lastVisit) / DAY_MS
      const recency = 1 / (1 + ageDays)
      const hostMatch = e.url
        .toLowerCase()
        .replace(/^https?:\/\/(www\.)?/, '')
        .startsWith(q)
        ? 2
        : 0
      scored.push({ e, score: Math.log1p(e.visitCount) + recency * 2 + hostMatch })
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.e)
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

  /** Visits with `fromMs <= visitTime < toMs`. */
  count(fromMs: number, toMs: number): number {
    let n = 0
    for (const v of this.visitList) if (v.visitTime >= fromMs && v.visitTime < toMs) n += 1
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

  // --- deletion ---------------------------------------------------------------

  deleteVisits(ids: string[]): void {
    const gone = new Set(ids)
    this.removeVisits((v) => gone.has(v.id))
  }

  deleteUrls(urls: string[]): void {
    const gone = new Set(urls)
    let changed = false
    for (const url of gone) if (this.entries.delete(url)) changed = true
    // removeVisits() persists and notifies itself; an aggregate without visits needs it done here.
    if (this.removeVisits((v) => gone.has(v.url)) === 0 && changed) {
      this.persist()
      this.notify('delete')
    }
  }

  deleteDay(dayKey: string): void {
    this.removeVisits((v) => dayKeyOf(v.visitTime) === dayKey)
  }

  /** Remove the visits in `[fromMs, toMs)`; returns how many went. */
  deleteRange(fromMs: number, toMs: number): number {
    return this.removeVisits((v) => v.visitTime >= fromMs && v.visitTime < toMs)
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
    this.persist()
    this.notify('clear')
  }

  /**
   * Drop the visits matching `gone` and bring the aggregates of the affected pages in line
   * (visit count and last visit recomputed; a page without visits left is forgotten).
   */
  private removeVisits(gone: (v: HistoryVisit) => boolean): number {
    const affected = new Set<string>()
    const kept: HistoryVisit[] = []
    for (const v of this.visitList) {
      if (gone(v)) affected.add(v.url)
      else kept.push(v)
    }
    const removed = this.visitList.length - kept.length
    if (removed === 0) return 0
    this.visitList = kept
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
    return removed
  }

  // --- change notification ----------------------------------------------------

  onChange(listener: HistoryChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
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
