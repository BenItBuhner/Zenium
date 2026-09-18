import type {
  ClosedEntrySummary,
  CommandArgs,
  CommandName,
  CommandResult,
  EventName,
  Events,
  HistoryDayGroup,
  HistoryVisit,
  TopSite
} from '@shared/types'
import { cmd, onEvent } from './api'
import { dayKey, dayLabel, type DayGroup, type DayGroupOptions } from './historyGroups'

/**
 * The seam between the phone history UI and the history model: the desktop program's history
 * contract v0 (`history.grouped`, `history.deleteVisits` / `deleteUrls` / `deleteDay`,
 * `history.clear`, `session.recentlyClosed` / `restoreClosed`, and the `history.changed` /
 * `session.recentlyClosedChanged` events that say when to look again). The core buckets visits
 * by calendar day; the renderer only names the days ("Today", a weekday, a date), which is a
 * matter of the device's language and zone rather than of the model. The new tab page's most
 * visited sites come through the same seam (`topSites`, below) and nowhere else.
 */

export type { ClosedEntrySummary, HistoryDayGroup, HistoryVisit, TopSite }

/** What the list renders: the contract's visit. */
export type HistoryRow = HistoryVisit

/** The typed bridge to the core (`cmd`); tests hand in their own. */
export type Invoke = <K extends CommandName>(
  name: K,
  args: CommandArgs<K>
) => Promise<CommandResult<K>>
/** The typed event subscription (`onEvent`); returns the unsubscribe. */
export type Subscribe = <K extends EventName>(
  name: K,
  listener: (payload: Events[K]) => void
) => () => void

export interface HistoryAdapter {
  /** The most recent visits, or the ones matching `text`, bucketed by day newest first. */
  loadGroups(
    text: string,
    limit: number,
    now: number,
    options?: DayGroupOptions
  ): Promise<DayGroup<HistoryRow>[]>
  /** How many visits there are in all (what "Clear history" is about to remove). */
  count(): Promise<number>
  /** Remove these visits. */
  deleteRows(rows: readonly HistoryRow[]): Promise<void>
  /** Remove every visit to these URLs. */
  deleteUrls(urls: readonly string[]): Promise<void>
  /** Remove a whole day. */
  deleteDay(dayKey: string): Promise<void>
  /** Forget everything. */
  clear(): Promise<void>
  /** Tabs and windows closed recently, newest first. */
  recentlyClosed(): Promise<ClosedEntrySummary[]>
  /** Bring one back. */
  restoreClosed(id: string): Promise<void>
  /** The history changed (a visit, a delete, a clear): the list should load again. */
  onChanged(listener: () => void): () => void
  /** The recently closed list changed. */
  onRecentlyClosedChanged(listener: () => void): () => void
}

/** Contract day groups as the list's groups: the heading is the renderer's, from the day key. */
export function labelDayGroups(
  groups: readonly HistoryDayGroup[],
  now: number,
  options: DayGroupOptions = {}
): DayGroup<HistoryRow>[] {
  const todayKey = dayKey(now, options.timeZone)
  return groups.map((group) => ({
    dayKey: group.dayKey,
    label: dayLabel(group.dayKey, todayKey, options.locale),
    items: group.visits
  }))
}

/** An adapter over `invoke` and `on`; the app uses {@link historyAdapter}, tests build their own. */
export function createHistoryAdapter(invoke: Invoke, on: Subscribe): HistoryAdapter {
  return {
    loadGroups: async (text, limit, now, options = {}) => {
      const groups = await invoke('history.grouped', { query: { text: text || undefined, limit } })
      return labelDayGroups(groups, now, options)
    },
    count: () => invoke('history.count', { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }),
    deleteRows: (rows) => invoke('history.deleteVisits', { ids: rows.map((row) => row.id) }),
    deleteUrls: (urls) => invoke('history.deleteUrls', { urls: [...urls] }),
    deleteDay: (dayKey) => invoke('history.deleteDay', { dayKey }),
    clear: () => invoke('history.clear', undefined),
    recentlyClosed: () => invoke('session.recentlyClosed', undefined),
    restoreClosed: (id) => invoke('session.restoreClosed', { id }),
    onChanged: (listener) => on('history.changed', () => listener()),
    onRecentlyClosedChanged: (listener) => on('session.recentlyClosedChanged', () => listener())
  }
}

/** The app's adapter, over the chrome's bridge to the core. */
export const historyAdapter: HistoryAdapter = createHistoryAdapter(cmd, onEvent)

/**
 * The most visited sites for the new tab page's tiles, `n` at most, without the hosts the user
 * removed: `history.topSites { n, excludedHosts } -> TopSite[]`, folded by host and ranked by
 * frecency in the core (contract v0). A failed call (logged by `cmd`) reads as no sites, so the
 * page shows its empty state rather than nothing.
 */
export async function topSites(
  n: number,
  excludedHosts: readonly string[] = []
): Promise<TopSite[]> {
  return cmd('history.topSites', {
    n,
    excludedHosts: excludedHosts.length ? [...excludedHosts] : undefined
  }).catch(() => [])
}
