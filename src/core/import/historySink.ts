import type { ImportVisitsOptions, ImportVisitsResult } from '../history'
import type { ImportedVisit } from './types'

/**
 * The history API the import writes through, owned by the desktop program (`core/history.ts`,
 * #252): a bulk `importVisits(visits, { source })` that stamps each visit with its own time,
 * dedupes by (url, time) against what is stored and within the batch, and notifies once. The
 * import only ever depends on this slice, and `historyImportSink` is the feature check a host
 * with another history model fails: it then offers no source browsing history.
 */

export type HistoryImportOutcome = ImportVisitsResult

export interface HistoryImportSink {
  importVisits(
    visits: ImportedVisit[],
    options: ImportVisitsOptions
  ): HistoryImportOutcome | Promise<HistoryImportOutcome>
}

/** The history service as an import sink when it has the API, else null (the feature check). */
export function historyImportSink(history: unknown): HistoryImportSink | null {
  if (!history || typeof history !== 'object') return null
  const candidate = history as Partial<HistoryImportSink>
  return typeof candidate.importVisits === 'function' ? (history as HistoryImportSink) : null
}
