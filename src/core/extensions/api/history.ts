/**
 * `chrome.history`, the host-neutral part: Chrome's `HistoryItem` (one per URL) and `VisitItem`
 * (one per visit) over Zenium's per-visit history model (`core/history`: `HistoryEntry`
 * aggregates and `HistoryVisit`s), the `search` defaults and folding of `history_api.cc`,
 * the transition names of both sides, and the bookkeeping that turns the model's payload-free
 * change notification into `onVisited` deliveries. Hosts own the service and the fan-out.
 */
import type { HistoryEntry, HistoryTransition, HistoryVisit } from '../../../shared/types'

export type ChromeTransitionType =
  | 'link'
  | 'typed'
  | 'auto_bookmark'
  | 'auto_subframe'
  | 'manual_subframe'
  | 'generated'
  | 'auto_toplevel'
  | 'form_submit'
  | 'reload'
  | 'keyword'
  | 'keyword_generated'

/** `history.HistoryItem`: a URL with its aggregate counts. */
export interface ChromeHistoryItem {
  id: string
  url: string
  title: string
  lastVisitTime: number
  visitCount: number
  typedCount: number
}

/** `history.VisitItem`: one visit of a URL. */
export interface ChromeVisitItem {
  id: string
  visitId: string
  visitTime: number
  referringVisitId: string
  transition: ChromeTransitionType
  isLocal: boolean
}

export interface HistorySearchQuery {
  text: string
  startTime: number
  endTime: number | null
  /** 0 means no cap, as in Chrome's `QueryOptions`. */
  maxResults: number
}

export interface HistoryAddUrl {
  url: string
  title: string
  transition: HistoryTransition
}

export interface HistoryRange {
  startTime: number
  endTime: number
}

export const CHROME_TRANSITIONS: readonly ChromeTransitionType[] = [
  'link',
  'typed',
  'auto_bookmark',
  'auto_subframe',
  'manual_subframe',
  'generated',
  'auto_toplevel',
  'form_submit',
  'reload',
  'keyword',
  'keyword_generated'
]

/** Chrome's defaults: the last day, 100 results. */
export const DEFAULT_SEARCH_RANGE_MS = 24 * 60 * 60 * 1000
export const DEFAULT_MAX_RESULTS = 100

// Chrome's messages, verbatim (`history_api.cc`).
export const ERROR_INVALID_URL = 'Url is invalid.'
export const ERROR_INVALID_PARAM = 'Invalid parameter.'
export const ERROR_NO_PERMISSION = "The 'history' permission is required."

/** A failure `history.*` reports through `runtime.lastError`. */
export class HistoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HistoryError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * Chrome's `HistoryItem.id` is the URL row's database id; Zenium's aggregates are keyed by URL
 * and have no id, so a stable hash of the URL stands in (decimal, like Chrome's).
 */
export function historyItemId(url: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < url.length; i += 1) {
    hash ^= url.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return String(hash)
}

export function toHistoryItem(entry: HistoryEntry): ChromeHistoryItem {
  return {
    id: historyItemId(entry.url),
    url: entry.url,
    title: entry.title,
    lastVisitTime: entry.lastVisit,
    visitCount: entry.visitCount,
    typedCount: entry.typedCount ?? 0
  }
}

/** A visit whose aggregate is gone already (deleted between the visit and the look). */
export function historyItemFromVisit(visit: HistoryVisit): ChromeHistoryItem {
  return {
    id: historyItemId(visit.url),
    url: visit.url,
    title: visit.title,
    lastVisitTime: visit.visitTime,
    visitCount: 1,
    typedCount: visit.transition === 'typed' ? 1 : 0
  }
}

/**
 * The model's transitions onto Chrome's core types. A redirect is a qualifier on the original
 * transition in Chrome, so it reads as a link; a restored tab is Chrome's reload.
 */
export function toChromeTransition(transition: HistoryTransition): ChromeTransitionType {
  switch (transition) {
    case 'typed':
      return 'typed'
    case 'reload':
    case 'restored':
      return 'reload'
    default:
      return 'link'
  }
}

/** Chrome's transition names onto the model's; anything without a counterpart is `other`. */
export function fromChromeTransition(transition: string | undefined): HistoryTransition {
  switch (transition) {
    case undefined:
    case 'link':
      return 'link'
    case 'typed':
      return 'typed'
    case 'reload':
      return 'reload'
    default:
      return 'other'
  }
}

/** Zenium keeps no referrer chain: every visit is a root visit (`referringVisitId` "0"). */
export function toVisitItem(visit: HistoryVisit): ChromeVisitItem {
  return {
    id: historyItemId(visit.url),
    visitId: visit.id,
    visitTime: visit.visitTime,
    referringVisitId: '0',
    transition: toChromeTransition(visit.transition),
    isLocal: true
  }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** GURL validity as `new URL` sees it; the canonical form is what Chrome compares. */
export function canonicalHistoryUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  try {
    return new URL(raw).href
  } catch {
    return null
  }
}

/** Two URLs naming the same page once both are canonicalised. */
export function sameHistoryUrl(a: string, b: string): boolean {
  if (a === b) return true
  const ca = canonicalHistoryUrl(a)
  return ca !== null && ca === canonicalHistoryUrl(b)
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HistoryError(`Invalid value for '${name}'.`)
  }
  return value
}

/** `search(query)`: `text` matched against title and URL, the last day unless told otherwise. */
export function normalizeHistorySearch(raw: unknown, now: number): HistorySearchQuery {
  if (!isRecord(raw)) throw new HistoryError(ERROR_INVALID_PARAM)
  const text = raw.text === undefined || raw.text === null ? '' : raw.text
  if (typeof text !== 'string') throw new HistoryError("Invalid value for 'text'.")
  const startTime = optionalNumber(raw.startTime, 'startTime')
  const endTime = optionalNumber(raw.endTime, 'endTime')
  const maxResults = optionalNumber(raw.maxResults, 'maxResults')
  if (maxResults !== undefined && (maxResults < 0 || !Number.isInteger(maxResults))) {
    throw new HistoryError("Invalid value for 'maxResults'.")
  }
  return {
    text,
    startTime: startTime ?? now - DEFAULT_SEARCH_RANGE_MS,
    endTime: endTime ?? null,
    maxResults: maxResults ?? DEFAULT_MAX_RESULTS
  }
}

/** `getVisits` / `deleteUrl` details: a valid URL, canonicalised. */
export function normalizeUrlDetails(raw: unknown): string {
  if (!isRecord(raw)) throw new HistoryError(ERROR_INVALID_PARAM)
  const url = canonicalHistoryUrl(raw.url)
  if (url === null) throw new HistoryError(ERROR_INVALID_URL)
  return url
}

/** `addUrl(details)`: a valid URL, an optional title and Chrome transition. */
export function normalizeAddUrl(raw: unknown): HistoryAddUrl {
  if (!isRecord(raw)) throw new HistoryError(ERROR_INVALID_PARAM)
  const url = canonicalHistoryUrl(raw.url)
  if (url === null) throw new HistoryError(ERROR_INVALID_URL)
  const title = raw.title === undefined || raw.title === null ? '' : raw.title
  if (typeof title !== 'string') throw new HistoryError("Invalid value for 'title'.")
  const transition =
    raw.transition === undefined || raw.transition === null ? 'link' : raw.transition
  if (typeof transition !== 'string' || !CHROME_TRANSITIONS.includes(transition as never)) {
    throw new HistoryError("Invalid value for 'transition'.")
  }
  optionalNumber(raw.visitTime, 'visitTime')
  return { url, title, transition: fromChromeTransition(transition) }
}

/** `deleteRange(range)`: both bounds required, in ms since the epoch. */
export function normalizeHistoryRange(raw: unknown): HistoryRange {
  if (!isRecord(raw)) throw new HistoryError(ERROR_INVALID_PARAM)
  const startTime = optionalNumber(raw.startTime, 'startTime')
  const endTime = optionalNumber(raw.endTime, 'endTime')
  if (startTime === undefined || endTime === undefined) throw new HistoryError(ERROR_INVALID_PARAM)
  return { startTime, endTime }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * Chrome's `QueryHistory` with duplicates removed: the visits that matched (newest first) fold
 * to one item per URL in the order of their newest matching visit, the aggregate supplying the
 * counts and last visit; `maxResults` 0 is no cap.
 */
export function foldVisitsToItems(
  visits: readonly HistoryVisit[],
  entryFor: (url: string) => HistoryEntry | undefined,
  maxResults: number
): ChromeHistoryItem[] {
  const seen = new Set<string>()
  const out: ChromeHistoryItem[] = []
  for (const visit of visits) {
    if (seen.has(visit.url)) continue
    seen.add(visit.url)
    const entry = entryFor(visit.url)
    out.push(entry ? toHistoryItem(entry) : historyItemFromVisit(visit))
    if (maxResults > 0 && out.length >= maxResults) break
  }
  return out
}

/** Where the `onVisited` scan left off: the newest visit time seen and the ids at that time. */
export interface VisitWatermark {
  time: number
  ids: readonly string[]
}

/**
 * The visits recorded since the watermark, oldest first, and the watermark to carry on from.
 * `since` is whatever the model returns for "visits from the watermark's time on" (newest
 * first); several visits can share a millisecond, hence the ids.
 */
export function visitsSince(
  since: readonly HistoryVisit[],
  watermark: VisitWatermark
): { fresh: HistoryVisit[]; watermark: VisitWatermark } {
  const fresh = since
    .filter((v) => v.visitTime > watermark.time || !watermark.ids.includes(v.id))
    .sort((a, b) => a.visitTime - b.visitTime)
  if (fresh.length === 0) return { fresh, watermark }
  const time = fresh[fresh.length - 1].visitTime
  const ids = since.filter((v) => v.visitTime === time).map((v) => v.id)
  if (time === watermark.time) {
    for (const id of watermark.ids) if (!ids.includes(id)) ids.push(id)
  }
  return { fresh, watermark: { time, ids } }
}
