import type { HistoryEntry } from '@shared/types'
import { cmd, run } from './api'

/**
 * The seam between the phone history UI and the history model.
 *
 * The UI is written against the desktop program's history contract v0 (internal/desktop-parity/
 * history-interface.md): rows are visits (`HistoryVisit`) that come grouped by day from
 * `history.grouped` and are removed with `history.deleteVisits` / `history.deleteUrls`. Until
 * that PR lands, `main` only has per-URL aggregates (`HistoryEntry`) behind `history.search`,
 * `history.delete` and `history.clear`, so this file maps one onto the other: an aggregate
 * becomes a single visit at its `lastVisit`, keyed by URL, and grouping happens here in the
 * renderer. Swapping the bodies below for the real commands is the whole migration; nothing in
 * the panel changes.
 */

/** The shape of contract v0's `HistoryVisit` that the list needs. */
export interface HistoryRow {
  /** Stable per visit (the URL while rows are aggregates). */
  id: string
  url: string
  title: string
  favicon: string | null
  visitTime: number
}

/** One row per aggregate, at the time of its last visit. */
export function rowsFromEntries(entries: readonly HistoryEntry[]): HistoryRow[] {
  return entries.map((entry) => ({
    id: entry.url,
    url: entry.url,
    title: entry.title || entry.url,
    favicon: entry.favicon,
    visitTime: entry.lastVisit
  }))
}

/** The most recent rows, or the ones matching `query`. */
export async function loadHistoryRows(query: string, limit: number): Promise<HistoryRow[]> {
  // v0: `history.grouped { query: { text, limit } }` returns the day groups directly.
  return rowsFromEntries(await cmd('history.search', { query, limit }))
}

/** Remove the given visits. */
export function deleteHistoryRows(rows: readonly HistoryRow[]): void {
  // v0: `history.deleteVisits { ids }` in one call.
  const urls = new Set(rows.map((row) => row.url))
  for (const url of urls) run('history.delete', { url })
}

/** Forget everything. */
export function clearHistory(): void {
  run('history.clear', undefined)
}

/**
 * The "Delete browsing data" row. Shared services' clear-browsing-data sheet (PS-13) is not on
 * `main` yet; until it is, the row clears the history itself (undoable like every other delete
 * here). Once the sheet exists this returns its opener and the panel hands over to it.
 */
export function clearBrowsingDataSheet(): (() => void) | null {
  return null
}
