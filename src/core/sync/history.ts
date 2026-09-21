import type { HistoryVisitKey, HistoryVisitsEvent, ImportedVisit } from '../history'
import { RETENTION_MS } from '../history'

/**
 * The `history` record (ID-13 / HB-48): browsing history synced through the folder as one
 * append-only STREAM per device, written in pages, rather than as records in the device file –
 * a visit is never edited, only added or deleted, and a device holds up to 50 000 of them, far
 * too many to rewrite (and re-hash) on every sync.
 *
 * Wire shape: a page is `HistoryPage`, an ordered list of `HistoryEntry`. A visit entry carries
 * the `ImportedVisit` the history model imports (`{ url, title?, at, transition?, favicon? }`),
 * so one device's export is another's import unchanged and the `(url, at)` dedupe makes every
 * retry idempotent. Deletions are the hard requirement (a deleted visit must not come back from
 * another device): they travel as tombstones by `(url, at)` – visit ids are per device – plus
 * range events for the bulk paths and `cleared`, in stream order, so "added then removed" and
 * "removed then re-imported" both end where the user left them.
 *
 * Pages: `<deviceId>.history.<seq>.zenpage`, `HISTORY_PAGE_ENTRIES` entries each, sealed once
 * full (never rewritten again), the newest page rewritten as entries arrive. Every other device
 * keeps a cursor `(seq, index)` per stream in its own `sync.json`, so it resumes where it left
 * and applies each entry once. A device turning history on publishes its backlog first – the
 * 90-day retention window, the newest `HISTORY_SEED_MAX` visits at most – through the model's
 * pure `exportVisits`. Pages whose newest event is past the retention window are removed by
 * their owner; a reader whose cursor fell behind that starts at the oldest page left.
 *
 * The device's own deletions and the ones it applied are remembered (`DeletionMemory`, bounded)
 * so a visit an older page brings back later – a third device's stream read after the
 * tombstone – stays deleted: deletions win over additions across streams.
 */

export type HistoryEntry =
  | { type: 'visit'; visit: ImportedVisit }
  | { type: 'removed'; at: number; keys: HistoryVisitKey[] }
  | { type: 'range-removed'; at: number; from: number; to: number }
  | { type: 'cleared'; at: number }

export interface HistoryPage {
  v: 1
  seq: number
  /** Full: never rewritten; a reader past its end moves to the next sequence number. */
  sealed: boolean
  entries: HistoryEntry[]
}

/** Entries per page; the size cap the folder transport wants (a page is ~60 KB of visits at most). */
export const HISTORY_PAGE_ENTRIES = 500
/** Newest visits a device publishes when it starts syncing history (the backlog). */
export const HISTORY_SEED_MAX = 10_000
/** Entries kept waiting while the folder cannot be written; the oldest visits go beyond it. */
export const HISTORY_OPEN_MAX = 20_000
/** Pages a device keeps in the folder at most (the oldest go, retention aside). */
export const HISTORY_PAGES_MAX = 200
/** Pages of one remote stream applied per sync round (the rest next round: the cursor resumes). */
export const HISTORY_PAGES_PER_ROUND = 10
/** Keys per `removed` entry at most (a larger deletion is split). */
export const REMOVED_KEYS_PER_ENTRY = 1_000
const DELETION_KEYS_MAX = 5_000
const DELETION_RANGES_MAX = 200

/** Deletions this device made or applied, so a later page cannot undo them. */
export interface DeletionMemory {
  /** `"<at>\n<url>"` → when it was deleted. */
  keys: Record<string, number>
  ranges: Array<{ from: number; to: number; at: number }>
  /** The newest `cleared`: every visit at or before it is gone. */
  clearedAt: number | null
}

export interface StreamCursor {
  seq: number
  /** Entries of page `seq` already applied. */
  index: number
  /** `updatedAt` of page `seq`'s document when it was last read: unchanged, it is not decrypted again. */
  updatedAt?: number
}

/** What `sync.json` keeps for the history record. */
export interface HistorySyncState {
  /** Sequence number of the page being appended to. */
  seq: number
  /** How many of `open`'s entries are in the folder already. */
  written: number
  /** The entries of page `seq` (written or waiting). */
  open: HistoryEntry[]
  /** Sealed pages in the folder, with the time of the newest event each (for expiry). */
  pages: Array<{ seq: number; to: number }>
  /** Where this device is in every other device's stream, by device id. */
  cursors: Record<string, StreamCursor>
  /**
   * The backlog export under way: visits in `[since, until)` through the model's `exportVisits`,
   * `cursor` its page cursor; null once done (or never started).
   */
  seed: { since: number; until: number; cursor: string | null } | null
  /** The newest visit time this device has published (the floor of a later re-seed). */
  publishedUntil: number
  deletions: DeletionMemory
}

export function emptyDeletions(): DeletionMemory {
  return { keys: {}, ranges: [], clearedAt: null }
}

export function initialHistoryState(): HistorySyncState {
  return {
    seq: 0,
    written: 0,
    open: [],
    pages: [],
    cursors: {},
    seed: null,
    publishedUntil: 0,
    deletions: emptyDeletions()
  }
}

/** A persisted state from any build, completed and sanitised. */
export function readHistoryState(raw: unknown): HistorySyncState {
  const base = initialHistoryState()
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Partial<HistorySyncState>
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  const out: HistorySyncState = {
    seq: Math.max(0, Math.floor(num(r.seq, 0))),
    written: Math.max(0, Math.floor(num(r.written, 0))),
    open: Array.isArray(r.open) ? r.open.filter(isEntry) : [],
    pages: Array.isArray(r.pages)
      ? r.pages
          .filter(
            (p): p is { seq: number; to: number } =>
              !!p && typeof p === 'object' && typeof p.seq === 'number' && typeof p.to === 'number'
          )
          .map((p) => ({ seq: p.seq, to: p.to }))
      : [],
    cursors: {},
    seed:
      r.seed &&
      typeof r.seed === 'object' &&
      typeof r.seed.since === 'number' &&
      typeof r.seed.until === 'number'
        ? {
            since: r.seed.since,
            until: r.seed.until,
            cursor: typeof r.seed.cursor === 'string' ? r.seed.cursor : null
          }
        : null,
    publishedUntil: num(r.publishedUntil, 0),
    deletions: readDeletions(r.deletions)
  }
  if (out.written > out.open.length) out.written = out.open.length
  if (r.cursors && typeof r.cursors === 'object') {
    for (const [id, c] of Object.entries(r.cursors as Record<string, Partial<StreamCursor>>)) {
      if (c && typeof c.seq === 'number' && typeof c.index === 'number') {
        out.cursors[id] = { seq: Math.max(0, c.seq), index: Math.max(0, c.index) }
        if (typeof c.updatedAt === 'number') out.cursors[id].updatedAt = c.updatedAt
      }
    }
  }
  return out
}

function readDeletions(raw: unknown): DeletionMemory {
  const out = emptyDeletions()
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Partial<DeletionMemory>
  if (r.keys && typeof r.keys === 'object')
    for (const [k, at] of Object.entries(r.keys)) if (typeof at === 'number') out.keys[k] = at
  if (Array.isArray(r.ranges))
    for (const range of r.ranges)
      if (
        range &&
        typeof range === 'object' &&
        typeof range.from === 'number' &&
        typeof range.to === 'number' &&
        typeof range.at === 'number'
      )
        out.ranges.push({ from: range.from, to: range.to, at: range.at })
  if (typeof r.clearedAt === 'number') out.clearedAt = r.clearedAt
  return out
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

function isKey(k: unknown): k is HistoryVisitKey {
  return (
    !!k &&
    typeof k === 'object' &&
    typeof (k as HistoryVisitKey).url === 'string' &&
    typeof (k as HistoryVisitKey).at === 'number'
  )
}

function isImportedVisit(v: unknown): v is ImportedVisit {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as ImportedVisit).url === 'string' &&
    typeof (v as ImportedVisit).at === 'number' &&
    Number.isFinite((v as ImportedVisit).at)
  )
}

/** Whether a value read from another device is a well-formed entry (garbage is skipped). */
export function isEntry(e: unknown): e is HistoryEntry {
  if (!e || typeof e !== 'object') return false
  const r = e as Record<string, unknown>
  switch (r.type) {
    case 'visit':
      return isImportedVisit(r.visit)
    case 'removed':
      return typeof r.at === 'number' && Array.isArray(r.keys) && r.keys.every(isKey)
    case 'range-removed':
      return typeof r.at === 'number' && typeof r.from === 'number' && typeof r.to === 'number'
    case 'cleared':
      return typeof r.at === 'number'
    default:
      return false
  }
}

/** Read a page another device wrote; null for garbage. Unknown entries are dropped, not fatal. */
export function readHistoryPage(data: unknown): HistoryPage | null {
  if (!data || typeof data !== 'object') return null
  const r = data as Partial<HistoryPage>
  if (r.v !== 1 || typeof r.seq !== 'number' || !Array.isArray(r.entries)) return null
  return { v: 1, seq: r.seq, sealed: r.sealed === true, entries: r.entries.filter(isEntry) }
}

/** A visit in the wire shape: only the fields with a value (`title` absent, not empty). */
function wireVisit(v: ImportedVisit): ImportedVisit {
  const out: ImportedVisit = { url: v.url, at: v.at }
  if (v.title) out.title = v.title
  if (v.transition && v.transition !== 'link') out.transition = v.transition
  if (v.favicon) out.favicon = v.favicon
  return out
}

/** The model's event as stream entries (a large addition or removal is split). */
export function entriesFromEvent(event: HistoryVisitsEvent, at: number): HistoryEntry[] {
  switch (event.type) {
    case 'added':
      return event.visits.map((visit) => ({ type: 'visit', visit: wireVisit(visit) }))
    case 'removed': {
      const out: HistoryEntry[] = []
      for (let i = 0; i < event.keys.length; i += REMOVED_KEYS_PER_ENTRY)
        out.push({
          type: 'removed',
          at,
          keys: event.keys
            .slice(i, i + REMOVED_KEYS_PER_ENTRY)
            .map((k) => ({ url: k.url, at: k.at }))
        })
      return out
    }
    case 'range-removed':
      return [{ type: 'range-removed', at, from: event.from, to: event.to }]
    case 'cleared':
      return [{ type: 'cleared', at }]
  }
}

/** Visits of an export page as stream entries. */
export function entriesFromVisits(visits: ImportedVisit[]): HistoryEntry[] {
  return visits.map((visit) => ({ type: 'visit', visit: wireVisit(visit) }))
}

/** The model's pure export, as the seed needs it. */
export interface HistoryExporter {
  exportVisits(query: { since: number; until?: number; limit?: number; cursor?: string | null }): {
    visits: ImportedVisit[]
    next: string | null
  }
}

/**
 * Where a backlog export starts: `since` (the retention window, or just past what was published
 * before), raised so that at most `HISTORY_SEED_MAX` visits – the newest – are in `[floor, until)`.
 * Pure reads of the model, page by page.
 */
export function seedFloor(history: HistoryExporter, since: number, until: number): number {
  const times: number[] = []
  let cursor: string | null = null
  do {
    const page = history.exportVisits({ since, until, cursor })
    for (const v of page.visits) times.push(v.at)
    cursor = page.next
  } while (cursor !== null)
  if (times.length <= HISTORY_SEED_MAX) return since
  return Math.max(since, times[times.length - HISTORY_SEED_MAX])
}

/** The newest time an entry speaks of (a visit's time, a deletion's moment). */
export function entryTime(entry: HistoryEntry): number {
  return entry.type === 'visit' ? entry.visit.at : entry.at
}

// ---------------------------------------------------------------------------
// The publisher's buffer
// ---------------------------------------------------------------------------

/**
 * Queue entries for the open page. Over `HISTORY_OPEN_MAX` (the folder unreachable for long)
 * the oldest visit entries go first; deletions are kept whatever happens.
 */
export function appendOpen(state: HistorySyncState, entries: HistoryEntry[]): void {
  if (entries.length === 0) return
  state.open.push(...entries)
  for (const e of entries)
    if (e.type === 'visit' && e.visit.at > state.publishedUntil) state.publishedUntil = e.visit.at
  if (state.open.length <= HISTORY_OPEN_MAX) return
  let excess = state.open.length - HISTORY_OPEN_MAX
  const kept: HistoryEntry[] = []
  // Never drop what is already in the folder out of the buffer's head: the written prefix stays.
  for (let i = 0; i < state.open.length; i += 1) {
    const e = state.open[i]
    if (excess > 0 && i >= state.written && e.type === 'visit') {
      excess -= 1
      continue
    }
    kept.push(e)
  }
  state.open = kept
}

/**
 * A page names itself after the navigation that recorded its visit (the model's `updateTitle`,
 * no `onVisits` event of its own): before the buffer goes out, the visits not yet in the folder
 * take the model's current title, so the other devices see the page's name rather than its
 * address. What is in the folder already stays as written (a reader applies each entry once).
 */
export function refreshTitles(
  state: HistorySyncState,
  titleFor: (url: string) => string | null
): void {
  for (let i = state.written; i < state.open.length; i += 1) {
    const e = state.open[i]
    if (e.type !== 'visit') continue
    const title = titleFor(e.visit.url)
    if (title && title !== e.visit.url && title !== e.visit.title) e.visit.title = title
  }
}

export interface PageWrite {
  seq: number
  page: HistoryPage
}

/** The publisher's fields `planWrites` moves: taken over once every write succeeded. */
export type PublisherState = Pick<HistorySyncState, 'seq' | 'written' | 'open' | 'pages'>

/**
 * Turn the buffer into the pages to write: every full `HISTORY_PAGE_ENTRIES` from the front is
 * sealed at the current sequence number and the number advances; what remains is the open page,
 * written when it holds entries not yet in the folder. Pure: `after` is the publisher's state
 * once the writes have succeeded (`takeWrites`); a caller whose write fails keeps `state` as it
 * was.
 */
export function planWrites(state: HistorySyncState): {
  writes: PageWrite[]
  after: PublisherState
} {
  const writes: PageWrite[] = []
  const after: PublisherState = {
    seq: state.seq,
    written: state.written,
    open: [...state.open],
    pages: [...state.pages]
  }
  while (after.open.length >= HISTORY_PAGE_ENTRIES) {
    const entries = after.open.slice(0, HISTORY_PAGE_ENTRIES)
    writes.push({ seq: after.seq, page: { v: 1, seq: after.seq, sealed: true, entries } })
    after.pages.push({ seq: after.seq, to: Math.max(...entries.map(entryTime)) })
    after.open = after.open.slice(HISTORY_PAGE_ENTRIES)
    after.seq += 1
    after.written = 0
  }
  if (after.open.length > 0 && after.open.length > after.written) {
    writes.push({
      seq: after.seq,
      page: { v: 1, seq: after.seq, sealed: false, entries: [...after.open] }
    })
    after.written = after.open.length
  }
  return { writes, after }
}

/**
 * The writes went through: the state takes `after` over, and whatever `state.open` gained while
 * they were in flight (it held `plannedOpen` entries when `planWrites` looked) is queued again
 * behind it.
 */
export function takeWrites(
  state: HistorySyncState,
  after: PublisherState,
  plannedOpen: number
): void {
  const appended = state.open.slice(plannedOpen)
  state.seq = after.seq
  state.written = after.written
  state.pages = after.pages
  state.open = after.open
  appendOpen(state, appended)
}

/** Sealed pages past the retention window or beyond the count cap: their sequence numbers. */
export function expiredPages(state: HistorySyncState, now: number): number[] {
  const cutoff = now - RETENTION_MS
  const sorted = [...state.pages].sort((a, b) => a.seq - b.seq)
  const gone = new Set<number>()
  for (const p of sorted) if (p.to < cutoff) gone.add(p.seq)
  const remaining = sorted.filter((p) => !gone.has(p.seq))
  for (const p of remaining.slice(0, Math.max(0, remaining.length - HISTORY_PAGES_MAX)))
    gone.add(p.seq)
  return [...gone]
}

// ---------------------------------------------------------------------------
// Deletions win
// ---------------------------------------------------------------------------

const keyOf = (url: string, at: number): string => `${at}\n${url}`

/** Remember a deletion (the device's own, or one applied from a stream). */
export function rememberDeletion(memory: DeletionMemory, entry: HistoryEntry, now: number): void {
  switch (entry.type) {
    case 'visit':
      return
    case 'removed':
      for (const k of entry.keys) memory.keys[keyOf(k.url, k.at)] = entry.at
      break
    case 'range-removed':
      memory.ranges.push({ from: entry.from, to: entry.to, at: entry.at })
      break
    case 'cleared':
      memory.clearedAt = Math.max(memory.clearedAt ?? 0, entry.at)
      break
  }
  pruneDeletions(memory, now)
}

/** Forget deletions older than the retention window; cap the rest (the oldest go). */
export function pruneDeletions(memory: DeletionMemory, now: number): void {
  const cutoff = now - RETENTION_MS
  const keys = Object.entries(memory.keys).filter(([, at]) => at >= cutoff)
  if (keys.length > DELETION_KEYS_MAX) {
    keys.sort((a, b) => a[1] - b[1])
    keys.splice(0, keys.length - DELETION_KEYS_MAX)
  }
  if (keys.length !== Object.keys(memory.keys).length) memory.keys = Object.fromEntries(keys)
  memory.ranges = memory.ranges.filter((r) => r.at >= cutoff)
  if (memory.ranges.length > DELETION_RANGES_MAX)
    memory.ranges = memory.ranges.slice(memory.ranges.length - DELETION_RANGES_MAX)
  if (memory.clearedAt !== null && memory.clearedAt < cutoff) memory.clearedAt = null
}

/** Whether a visit arriving now is one a remembered deletion already covers. */
export function isDeleted(memory: DeletionMemory, visit: ImportedVisit): boolean {
  if (memory.clearedAt !== null && visit.at <= memory.clearedAt) return true
  if (memory.keys[keyOf(visit.url, visit.at)] !== undefined) return true
  for (const r of memory.ranges) if (visit.at >= r.from && visit.at < r.to) return true
  return false
}

// ---------------------------------------------------------------------------
// Applying a stream
// ---------------------------------------------------------------------------

/** What the engine needs from the history model to apply a stream (the model's own methods). */
export interface HistoryApplyTarget {
  importVisits(visits: ImportedVisit[], opts: { source: string }): { imported: number }
  deleteByKeys(keys: HistoryVisitKey[]): number
  deleteRange(fromMs: number, toMs: number): number
}

export interface ApplyResult {
  imported: number
  deleted: number
}

/**
 * Apply a page's entries from `from` on, in order: runs of visits become ONE `importVisits`
 * batch each (the model recomputes aggregates once and fires one change per batch – no per-visit
 * notification), tombstones go through `deleteByKeys`, ranges through `deleteRange`, `cleared`
 * as the range up to its moment (a visit made after the clear on another device stays). Every
 * deletion is remembered; a visit a remembered deletion covers is not imported.
 */
export function applyEntries(
  target: HistoryApplyTarget,
  entries: HistoryEntry[],
  from: number,
  memory: DeletionMemory,
  now: number
): ApplyResult {
  const result: ApplyResult = { imported: 0, deleted: 0 }
  let batch: ImportedVisit[] = []
  const flush = (): void => {
    if (batch.length === 0) return
    const wanted = batch.filter((v) => !isDeleted(memory, v))
    if (wanted.length) result.imported += target.importVisits(wanted, { source: 'sync' }).imported
    batch = []
  }
  for (let i = from; i < entries.length; i += 1) {
    const e = entries[i]
    if (e.type === 'visit') {
      batch.push(e.visit)
      continue
    }
    flush()
    rememberDeletion(memory, e, now)
    switch (e.type) {
      case 'removed':
        result.deleted += target.deleteByKeys(e.keys)
        break
      case 'range-removed':
        result.deleted += target.deleteRange(e.from, e.to)
        break
      case 'cleared':
        result.deleted += target.deleteRange(0, e.at + 1)
        break
    }
  }
  flush()
  return result
}

/**
 * The pages of one remote stream to read this round, oldest first: from the cursor's page on
 * (the cursor's own page only while it may still grow, i.e. it was not known sealed), skipping
 * pages the owner has removed since (the cursor then starts at the oldest left), at most
 * `HISTORY_PAGES_PER_ROUND`.
 */
export function pagesToRead(available: number[], cursor: StreamCursor | undefined): number[] {
  const sorted = [...new Set(available)].sort((a, b) => a - b)
  const start = cursor?.seq ?? 0
  return sorted.filter((seq) => seq >= start).slice(0, HISTORY_PAGES_PER_ROUND)
}

/** The cursor after a page was applied to its end. */
export function advanceCursor(page: HistoryPage): StreamCursor {
  return page.sealed
    ? { seq: page.seq + 1, index: 0 }
    : { seq: page.seq, index: page.entries.length }
}
