import type { HistoryChangeKind, HistoryService } from '../../../core/history'
import type { HistoryEntry } from '../../../shared/types'
import {
  ERROR_NO_PERMISSION,
  HistoryError,
  foldVisitsToItems,
  historyItemFromVisit,
  normalizeAddUrl,
  normalizeHistoryRange,
  normalizeHistorySearch,
  normalizeUrlDetails,
  sameHistoryUrl,
  toHistoryItem,
  toVisitItem,
  visitsSince,
  type ChromeHistoryItem,
  type ChromeVisitItem,
  type VisitWatermark
} from '../../../core/extensions/api/history'
import {
  ApiError,
  type ApiContext,
  type ApiHost,
  type LoadedExtension,
  type NamespaceHandlers
} from './types'

/**
 * `chrome.history` over Zenium's history (`core/history`, owned by the history program):
 * `search` folds the model's matching visits to Chrome's one-item-per-URL results, `getVisits`
 * lists a page's visits, the writes go through the service, and the events come from the
 * service's change feed. That feed carries no payload, so `onVisited` is a scan for visits
 * newer than the last one seen and `onVisitRemoved` a diff of the aggregate URL set; both run
 * only while an extension holding `history` is loaded.
 */
export class HistoryApi {
  private watermark: VisitWatermark = { time: 0, ids: [] }
  /** Aggregate URLs at the last look, for naming what a deletion took; null until baselined. */
  private urls: Set<string> | null = null
  private detach: (() => void) | null = null

  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    search: (ctx, query) => this.search(ctx, query),
    getVisits: (ctx, details) => this.getVisits(ctx, details),
    addUrl: (ctx, details) => this.addUrl(ctx, details),
    deleteUrl: (ctx, details) => this.deleteUrl(ctx, details),
    deleteRange: (ctx, range) => this.deleteRange(ctx, range),
    deleteAll: (ctx) => this.deleteAll(ctx)
  }

  private get service(): HistoryService {
    return this.host.browser.history
  }

  /** Start following the model; visits already recorded are history, not events. */
  attach(): void {
    if (this.detach) return
    const latest = this.service.visits({ limit: 1 })[0]
    this.watermark = latest
      ? {
          time: latest.visitTime,
          ids: this.service.visits({ fromMs: latest.visitTime, limit: Infinity }).map((v) => v.id)
        }
      : { time: 0, ids: [] }
    this.detach = this.service.onChange((kind) => this.changed(kind))
  }

  private requirePermission(ext: LoadedExtension): void {
    if (!hasHistory(this.host, ext)) throw new ApiError(ERROR_NO_PERMISSION)
  }

  /** Every aggregate by URL (the service exposes them sorted, not keyed). */
  private entries(): Map<string, HistoryEntry> {
    return new Map(this.service.recent(Infinity).map((entry) => [entry.url, entry]))
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  private search(ctx: ApiContext, raw: unknown): ChromeHistoryItem[] {
    this.requirePermission(ctx.extension)
    const query = checked(() => normalizeHistorySearch(raw, Date.now()))
    const visits = this.service.visits({
      text: query.text,
      fromMs: query.startTime,
      ...(query.endTime === null ? {} : { toMs: query.endTime }),
      limit: Infinity
    })
    const entries = this.entries()
    return foldVisitsToItems(visits, (url) => entries.get(url), query.maxResults)
  }

  private getVisits(ctx: ApiContext, raw: unknown): ChromeVisitItem[] {
    this.requirePermission(ctx.extension)
    const url = checked(() => normalizeUrlDetails(raw))
    return this.service
      .visits({ limit: Infinity })
      .filter((visit) => sameHistoryUrl(visit.url, url))
      .sort((a, b) => a.visitTime - b.visitTime)
      .map(toVisitItem)
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  private addUrl(ctx: ApiContext, raw: unknown): void {
    this.requirePermission(ctx.extension)
    const details = checked(() => normalizeAddUrl(raw))
    this.service.visit(details.url, details.title, null, { transition: details.transition })
  }

  private deleteUrl(ctx: ApiContext, raw: unknown): void {
    this.requirePermission(ctx.extension)
    const url = checked(() => normalizeUrlDetails(raw))
    const stored = [...this.entries().keys()].filter((known) => sameHistoryUrl(known, url))
    this.service.deleteUrls(stored.length > 0 ? stored : [url])
  }

  private deleteRange(ctx: ApiContext, raw: unknown): void {
    this.requirePermission(ctx.extension)
    const range = checked(() => normalizeHistoryRange(raw))
    this.service.deleteRange(range.startTime, range.endTime)
  }

  private deleteAll(ctx: ApiContext): void {
    this.requirePermission(ctx.extension)
    this.service.clear()
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  private changed(kind: HistoryChangeKind): void {
    const holders = this.host.allLoaded().filter((ext) => hasHistory(this.host, ext))
    // The watermark moves regardless, so a later listener never replays old visits.
    const scan = visitsSince(
      this.service.visits({ fromMs: this.watermark.time, limit: Infinity }),
      this.watermark
    )
    this.watermark = scan.watermark
    if (holders.length === 0) {
      this.urls = null
      return
    }
    const entries = this.entries()
    const previous = this.urls
    this.urls = new Set(entries.keys())
    const deliver = (event: string, args: unknown[]): void => {
      this.host.broadcast('history', event, (ext) => (hasHistory(this.host, ext) ? args : null))
    }
    if (kind === 'clear') {
      deliver('onVisitRemoved', [{ allHistory: true, urls: [] }])
    } else if (kind === 'delete' && previous) {
      const removed = [...previous].filter((url) => !entries.has(url))
      if (removed.length > 0) deliver('onVisitRemoved', [{ allHistory: false, urls: removed }])
    }
    // The first look with a holder loaded is the baseline for deletions, not for visits: a
    // visit is an event the moment it happens.
    for (const visit of scan.fresh) {
      const entry = entries.get(visit.url)
      deliver('onVisited', [entry ? toHistoryItem(entry) : historyItemFromVisit(visit)])
    }
  }
}

function hasHistory(host: ApiHost, ext: LoadedExtension): boolean {
  return host.grants(ext.id).permissions.includes('history')
}

/** Chrome's argument errors become `runtime.lastError` messages, verbatim. */
function checked<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof HistoryError) throw new ApiError(error.message)
    throw error
  }
}
