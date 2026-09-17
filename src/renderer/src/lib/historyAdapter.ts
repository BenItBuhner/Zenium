import type { HistoryEntry } from '@shared/types'
import { dayKey, dayLabel, groupByDay, type DayGroup, type DayGroupOptions } from './historyGroups'

/**
 * The seam between the phone history UI and the history model.
 *
 * The UI is written against the desktop program's history contract v0 (internal/desktop-parity/
 * history-interface.md): visits come grouped by day from `history.grouped`, are removed with
 * `history.deleteVisits` / `history.deleteUrls` / `history.deleteDay`, and recently closed tabs
 * come from `session.recentlyClosed`. Those commands are not on `main` yet, so every call here
 * tries the contract's name first and, when the core answers "Unknown command", falls back for
 * the rest of the session to what `main` has today: per-URL aggregates (`HistoryEntry`) behind
 * `history.search`, `history.delete` and `history.clear`, grouped here in the renderer. When the
 * contract lands, the fallbacks and the mirrored types below go, and nothing in the panel changes.
 */

// --- contract v0 shapes, mirrored until they are in @shared/types ------------------------------

export interface HistoryVisit {
  /** Stable per visit (the URL while rows are aggregates). */
  id: string
  url: string
  title: string
  favicon: string | null
  visitTime: number
}

export interface HistoryDayGroup {
  /** Local `YYYY-MM-DD`. */
  dayKey: string
  visits: HistoryVisit[]
}

export interface HistoryQuery {
  text?: string
  limit: number
}

export interface ClosedEntrySummary {
  id: string
  kind: 'tab' | 'window'
  title: string
  url: string | null
  favicon: string | null
  closedAt: number
  tabCount: number
}

/** What the list renders: contract v0's visit. */
export type HistoryRow = HistoryVisit

/** Which model answers: the contract's commands, or today's aggregates. */
export type HistorySource = 'contract' | 'legacy'

/** The bridge the adapter talks through; untyped because the contract's names are not in `Commands` yet. */
export type Invoke = (name: string, args: unknown) => Promise<unknown>

export interface HistoryAdapter {
  /** Decided by the first call that reached the core; `null` before that. */
  readonly source: HistorySource | null
  /** The most recent visits, or the ones matching `text`, bucketed by day newest first. */
  loadGroups(
    text: string,
    limit: number,
    now: number,
    options?: DayGroupOptions
  ): Promise<DayGroup<HistoryRow>[]>
  /** Remove these visits. */
  deleteRows(rows: readonly HistoryRow[]): Promise<void>
  /** Remove every visit to these URLs. */
  deleteUrls(urls: readonly string[]): Promise<void>
  /** Remove a whole day; `rows` are the visits the list shows for it (the fallback needs them). */
  deleteDay(dayKey: string, rows: readonly HistoryRow[]): Promise<void>
  /** Forget everything. */
  clear(): Promise<void>
  /** Tabs and windows closed recently, newest first; nothing until the contract lands. */
  recentlyClosed(): Promise<ClosedEntrySummary[]>
  /** Bring one back; the fallback can only reopen the newest. */
  restoreClosed(id: string): Promise<void>
}

// --- fallbacks over today's model --------------------------------------------------------------

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

/** The core's answer to a name it does not have (`Browser.handleCommand`), through either bridge. */
export function isUnknownCommand(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Unknown command')
}

// --- result checks (the contract's shapes, not trusted blindly) -------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isVisit(value: unknown): value is HistoryVisit {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.url === 'string' &&
    typeof value.title === 'string' &&
    (typeof value.favicon === 'string' || value.favicon === null) &&
    typeof value.visitTime === 'number'
  )
}

function isDayGroups(value: unknown): value is HistoryDayGroup[] {
  return (
    Array.isArray(value) &&
    value.every(
      (group) =>
        isRecord(group) &&
        typeof group.dayKey === 'string' &&
        Array.isArray(group.visits) &&
        group.visits.every(isVisit)
    )
  )
}

function isEntries(value: unknown): value is HistoryEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.url === 'string' &&
        typeof entry.title === 'string' &&
        typeof entry.lastVisit === 'number'
    )
  )
}

function isClosedEntries(value: unknown): value is ClosedEntrySummary[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.id === 'string' &&
        (entry.kind === 'tab' || entry.kind === 'window') &&
        typeof entry.title === 'string' &&
        (typeof entry.url === 'string' || entry.url === null) &&
        (typeof entry.favicon === 'string' || entry.favicon === null) &&
        typeof entry.closedAt === 'number' &&
        typeof entry.tabCount === 'number'
    )
  )
}

// --- the adapter -------------------------------------------------------------------------------

/** An adapter over `invoke`; the app uses {@link historyAdapter}, tests build their own. */
export function createHistoryAdapter(invoke: Invoke): HistoryAdapter {
  let source: HistorySource | null = null

  /**
   * Run the contract's command, or the fallback once the core has said it does not know the
   * name. A result of the wrong shape is a contract change and surfaces as an error.
   */
  async function contract<T>(
    name: string,
    args: unknown,
    check: (value: unknown) => value is T,
    fallback: () => Promise<T>
  ): Promise<T> {
    if (source === 'legacy') return fallback()
    let result: unknown
    try {
      result = await invoke(name, args)
    } catch (error) {
      if (!isUnknownCommand(error)) throw error
      source = 'legacy'
      return fallback()
    }
    if (!check(result)) throw new Error(`${name}: unexpected result`)
    source = 'contract'
    return result
  }

  /** The same for a command whose result does not matter. */
  async function contractCall(
    name: string,
    args: unknown,
    fallback: () => Promise<void>
  ): Promise<void> {
    if (source === 'legacy') return fallback()
    try {
      await invoke(name, args)
    } catch (error) {
      if (!isUnknownCommand(error)) throw error
      source = 'legacy'
      return fallback()
    }
    source = 'contract'
  }

  async function legacy<T>(
    name: string,
    args: unknown,
    check: (value: unknown) => value is T
  ): Promise<T> {
    const result = await invoke(name, args)
    if (!check(result)) throw new Error(`${name}: unexpected result`)
    return result
  }

  const legacyCall = async (name: string, args: unknown): Promise<void> => {
    await invoke(name, args)
  }

  const deleteEachUrl = async (urls: Iterable<string>): Promise<void> => {
    for (const url of new Set(urls)) await legacyCall('history.delete', { url })
  }

  return {
    get source() {
      return source
    },

    loadGroups: async (text, limit, now, options = {}) => {
      const query: HistoryQuery = { text: text || undefined, limit }
      const groups = await contract('history.grouped', { query }, isDayGroups, async () => {
        const entries = await legacy('history.search', { query: text, limit }, isEntries)
        return groupByDay(rowsFromEntries(entries), now, options).map((group) => ({
          dayKey: group.dayKey,
          visits: group.items
        }))
      })
      return labelDayGroups(groups, now, options)
    },

    deleteRows: (rows) =>
      contractCall('history.deleteVisits', { ids: rows.map((row) => row.id) }, () =>
        deleteEachUrl(rows.map((row) => row.url))
      ),

    deleteUrls: (urls) =>
      contractCall('history.deleteUrls', { urls: [...urls] }, () => deleteEachUrl(urls)),

    deleteDay: (dayKey, rows) =>
      contractCall('history.deleteDay', { dayKey }, () =>
        deleteEachUrl(rows.map((row) => row.url))
      ),

    clear: () => legacyCall('history.clear', undefined),

    recentlyClosed: () =>
      contract('session.recentlyClosed', undefined, isClosedEntries, async () => []),

    restoreClosed: (id) =>
      contractCall('session.restoreClosed', { id }, () => legacyCall('tab.reopenClosed', undefined))
  }
}

/** The app's adapter, over the chrome's bridge to the core. */
export const historyAdapter: HistoryAdapter = createHistoryAdapter((name, args) =>
  (window.zen.invoke as unknown as Invoke)(name, args)
)

/**
 * The "Delete browsing data" row. Shared services' clear-browsing-data sheet (PS-13) is not on
 * `main` yet; until it is, the row clears the history itself (undoable like every other delete
 * here). Once the sheet exists this returns its opener and the panel hands over to it.
 */
export function clearBrowsingDataSheet(): (() => void) | null {
  return null
}
