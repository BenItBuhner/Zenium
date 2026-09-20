import type { ImportedVisit } from './types'

/**
 * The history API the import writes through, owned by the desktop program (`core/history.ts`):
 * a bulk `importVisits(visits, { source })` that stamps each visit with its own time, dedupes
 * by (url, time) and fires no per-visit UI events. Until it lands, `historyImportSink` finds
 * nothing and no source offers browsing history; the day it exists the import uses it as is.
 */

export interface HistoryImportOutcome {
  /** Visits written. */
  added: number
  /** Visits already present (same url and time). */
  skipped: number
}

export interface HistoryImportSink {
  importVisits(
    visits: readonly ImportedVisit[],
    options: { source: string }
  ): HistoryImportOutcome | Promise<HistoryImportOutcome>
}

/** The history service as an import sink when it has the API, else null (the feature check). */
export function historyImportSink(history: unknown): HistoryImportSink | null {
  if (!history || typeof history !== 'object') return null
  const candidate = history as Partial<HistoryImportSink>
  return typeof candidate.importVisits === 'function' ? (history as HistoryImportSink) : null
}
