import type { HistoryTransition } from '../../shared/types'
import type { ImportDatabase } from '../platform'
import { coreDataToEpochMs, prTimeToEpochMs, webkitToEpochMs } from './time'
import { isImportableUrl, type ImportedVisit, type ImportedVisits } from './types'

/**
 * Other browsers' visit logs as neutral `ImportedVisit`s. Each browser stamps a different epoch
 * (`time.ts`) and codes the way a page was reached differently; both are mapped to Zenium's
 * `HistoryTransition`. Subframe loads, downloads and hidden pages never show in a browser's own
 * history, so they are skipped here too. Visits come back oldest first.
 */

// ---------------------------------------------------------------------------
// Chrome / Edge: the `History` database
// ---------------------------------------------------------------------------

export const CHROMIUM_HISTORY_SQL = `SELECT u.url AS url, u.title AS title, u.hidden AS hidden,
  v.visit_time AS visit_time, v.transition AS transition
FROM visits v JOIN urls u ON v.url = u.id
ORDER BY v.visit_time`

/** `ui::PageTransition`: the core type in the low byte, qualifiers in the high bits. */
const CORE_MASK = 0xff
const QUALIFIER_REDIRECT = 0x40000000 | 0x80000000
const CHROMIUM_CORE: Record<number, HistoryTransition | null> = {
  0: 'link', // LINK
  1: 'typed', // TYPED
  2: 'link', // AUTO_BOOKMARK
  3: null, // AUTO_SUBFRAME
  4: null, // MANUAL_SUBFRAME
  5: 'typed', // GENERATED (omnibox search)
  6: 'other', // AUTO_TOPLEVEL
  7: 'link', // FORM_SUBMIT
  8: 'reload', // RELOAD
  9: 'typed', // KEYWORD
  10: 'typed' // KEYWORD_GENERATED
}

export function chromiumTransition(raw: unknown): HistoryTransition | null {
  const value = Number(raw)
  if (!Number.isFinite(value)) return 'other'
  // The value is stored signed; bring the qualifiers back to an unsigned 32-bit word.
  const word = value >>> 0
  const core = CHROMIUM_CORE[word & CORE_MASK]
  if (core === null) return null
  if (core === undefined) return 'other'
  if (word & QUALIFIER_REDIRECT) return 'redirect'
  return core
}

export function chromiumHistoryVisits(
  db: ImportDatabase,
  now: number = Date.now()
): ImportedVisits {
  const out: ImportedVisits = { visits: [], skipped: 0 }
  for (const row of db.all(CHROMIUM_HISTORY_SQL)) {
    const url = typeof row.url === 'string' ? row.url : ''
    const at = webkitToEpochMs(row.visit_time, now)
    const transition = chromiumTransition(row.transition)
    if (
      !isImportableUrl(url) ||
      at === undefined ||
      transition === null ||
      Number(row.hidden) === 1
    ) {
      out.skipped += 1
      continue
    }
    out.visits.push({ url, title: typeof row.title === 'string' ? row.title : '', at, transition })
  }
  return out
}

// ---------------------------------------------------------------------------
// Firefox: `moz_historyvisits` in places.sqlite
// ---------------------------------------------------------------------------

export const FIREFOX_HISTORY_SQL = `SELECT p.url AS url, p.title AS title, p.hidden AS hidden,
  v.visit_date AS visit_date, v.visit_type AS visit_type
FROM moz_historyvisits v JOIN moz_places p ON v.place_id = p.id
ORDER BY v.visit_date`

/** `nsINavHistoryService::TRANSITION_*`. */
const FIREFOX_TYPES: Record<number, HistoryTransition | null> = {
  1: 'link', // LINK
  2: 'typed', // TYPED
  3: 'link', // BOOKMARK
  4: null, // EMBED
  5: 'redirect', // REDIRECT_PERMANENT
  6: 'redirect', // REDIRECT_TEMPORARY
  7: null, // DOWNLOAD
  8: null, // FRAMED_LINK
  9: 'reload' // RELOAD
}

export function firefoxTransition(raw: unknown): HistoryTransition | null {
  const value = Number(raw)
  const mapped = FIREFOX_TYPES[value]
  return mapped === undefined ? 'other' : mapped
}

export function firefoxHistoryVisits(db: ImportDatabase, now: number = Date.now()): ImportedVisits {
  const out: ImportedVisits = { visits: [], skipped: 0 }
  for (const row of db.all(FIREFOX_HISTORY_SQL)) {
    const url = typeof row.url === 'string' ? row.url : ''
    const at = prTimeToEpochMs(row.visit_date, now)
    const transition = firefoxTransition(row.visit_type)
    if (
      !isImportableUrl(url) ||
      at === undefined ||
      transition === null ||
      Number(row.hidden) === 1
    ) {
      out.skipped += 1
      continue
    }
    out.visits.push({ url, title: typeof row.title === 'string' ? row.title : '', at, transition })
  }
  return out
}

// ---------------------------------------------------------------------------
// Safari: `History.db`
// ---------------------------------------------------------------------------

export const SAFARI_HISTORY_SQL = `SELECT i.url AS url, v.title AS title, v.visit_time AS visit_time,
  v.redirect_source AS redirect_source, v.load_successful AS load_successful
FROM history_visits v JOIN history_items i ON v.history_item = i.id
ORDER BY v.visit_time`

export function safariHistoryVisits(db: ImportDatabase, now: number = Date.now()): ImportedVisits {
  const out: ImportedVisits = { visits: [], skipped: 0 }
  for (const row of db.all(SAFARI_HISTORY_SQL)) {
    const url = typeof row.url === 'string' ? row.url : ''
    const at = coreDataToEpochMs(row.visit_time, now)
    if (!isImportableUrl(url) || at === undefined || Number(row.load_successful ?? 1) === 0) {
      out.skipped += 1
      continue
    }
    const transition: HistoryTransition =
      row.redirect_source !== null && row.redirect_source !== undefined ? 'redirect' : 'link'
    out.visits.push({ url, title: typeof row.title === 'string' ? row.title : '', at, transition })
  }
  return out
}

/** Oldest first, the same (url, time) never twice. */
export function dedupeVisits(visits: ImportedVisit[]): {
  visits: ImportedVisit[]
  duplicates: number
} {
  const seen = new Set<string>()
  const out: ImportedVisit[] = []
  let duplicates = 0
  for (const v of [...visits].sort((a, b) => a.at - b.at)) {
    const key = `${v.at}\n${v.url}`
    if (seen.has(key)) {
      duplicates += 1
      continue
    }
    seen.add(key)
    out.push(v)
  }
  return { visits: out, duplicates }
}
