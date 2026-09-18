import { describe, expect, it, vi } from 'vitest'
import type { EventName, Events } from '@shared/types'
import {
  createHistoryAdapter,
  labelDayGroups,
  type HistoryDayGroup,
  type HistoryVisit,
  type Invoke,
  type Subscribe
} from '../historyAdapter'

const TZ = 'UTC'
// 2026-09-17 12:00 UTC
const NOW = Date.UTC(2026, 8, 17, 12)
const H = 3_600_000

const visit = (id: string, url: string, visitTime: number, title = url): HistoryVisit => ({
  id,
  url,
  title,
  favicon: null,
  visitTime,
  transition: 'link'
})

/** A core that speaks contract v0, remembering what it was asked and whom it told. */
function contractCore(groups: HistoryDayGroup[]): {
  invoke: Invoke
  on: Subscribe
  calls: Array<[string, unknown]>
  fire<K extends EventName>(name: K, payload: Events[K]): void
  subscriptions(): string[]
} {
  const calls: Array<[string, unknown]> = []
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const invoke: Invoke = async (name, args) => {
    calls.push([name, args])
    switch (name) {
      case 'history.grouped':
        return groups
      case 'history.count':
        return groups.reduce<number>((n, g) => n + g.visits.length, 0)
      case 'session.recentlyClosed':
        return [
          {
            id: 'c1',
            kind: 'tab',
            title: 'Closed',
            url: 'https://closed.example/',
            favicon: null,
            closedAt: NOW - H,
            tabCount: 1
          }
        ]
      case 'history.deleteVisits':
      case 'history.deleteUrls':
      case 'history.deleteDay':
      case 'history.clear':
      case 'session.restoreClosed':
        return undefined
      default:
        throw new Error(`Unknown command: ${name}`)
    }
  }
  const on: Subscribe = (name, listener) => {
    const set = listeners.get(name) ?? new Set()
    listeners.set(name, set)
    set.add(listener as (payload: unknown) => void)
    return () => {
      set.delete(listener as (payload: unknown) => void)
    }
  }
  return {
    invoke,
    on,
    calls,
    fire: (name, payload) => {
      for (const listener of listeners.get(name) ?? []) listener(payload)
    },
    subscriptions: () =>
      [...listeners.entries()].filter(([, set]) => set.size > 0).map(([name]) => name)
  }
}

const groups: HistoryDayGroup[] = [
  { dayKey: '2026-09-17', visits: [visit('v2', 'https://a.example/', NOW - H, 'A')] },
  {
    dayKey: '2026-09-16',
    visits: [
      {
        ...visit('v1', 'https://b.example/', NOW - 30 * H, 'B'),
        favicon: 'https://b.example/i.png'
      }
    ]
  }
]

describe('labelDayGroups', () => {
  it('keeps the core’s buckets and gives them the renderer’s headings', () => {
    const buckets: HistoryDayGroup[] = [
      { dayKey: '2026-09-17', visits: [] },
      { dayKey: '2026-09-16', visits: [] },
      { dayKey: '2026-09-14', visits: [] }
    ]
    const labelled = labelDayGroups(buckets, NOW, { timeZone: TZ, locale: 'en-US' })
    expect(labelled.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Monday'])
    expect(labelled.map((g) => g.dayKey)).toEqual(buckets.map((g) => g.dayKey))
  })

  it('does not copy the visits: the rows are the core’s objects', () => {
    const [today] = labelDayGroups(groups, NOW, { timeZone: TZ })
    expect(today!.items).toBe(groups[0]!.visits)
  })
})

describe('createHistoryAdapter', () => {
  it('takes the core’s day groups as they are and labels them', async () => {
    const core = contractCore(groups)
    const adapter = createHistoryAdapter(core.invoke, core.on)
    const result = await adapter.loadGroups('b', 20, NOW, { timeZone: TZ, locale: 'en-US' })
    expect(core.calls).toEqual([['history.grouped', { query: { text: 'b', limit: 20 } }]])
    expect(result).toEqual([
      { dayKey: '2026-09-17', label: 'Today', items: groups[0]!.visits },
      { dayKey: '2026-09-16', label: 'Yesterday', items: groups[1]!.visits }
    ])
  })

  it('leaves an empty search text out of the query', async () => {
    const core = contractCore([])
    await createHistoryAdapter(core.invoke, core.on).loadGroups('', 300, NOW)
    expect(core.calls).toEqual([['history.grouped', { query: { limit: 300 } }]])
  })

  it('counts every visit there is, for what "Clear history" is about to remove', async () => {
    const core = contractCore(groups)
    expect(await createHistoryAdapter(core.invoke, core.on).count()).toBe(2)
    expect(core.calls).toEqual([['history.count', { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }]])
  })

  it('deletes by visit id, URL and day with the contract’s commands, and clears', async () => {
    const core = contractCore(groups)
    const adapter = createHistoryAdapter(core.invoke, core.on)
    await adapter.deleteRows([groups[0]!.visits[0]!, groups[1]!.visits[0]!])
    await adapter.deleteUrls(['https://a.example/'])
    await adapter.deleteDay('2026-09-16')
    await adapter.clear()
    expect(core.calls).toEqual([
      ['history.deleteVisits', { ids: ['v2', 'v1'] }],
      ['history.deleteUrls', { urls: ['https://a.example/'] }],
      ['history.deleteDay', { dayKey: '2026-09-16' }],
      ['history.clear', undefined]
    ])
  })

  it('lists recently closed entries and restores one by id', async () => {
    const core = contractCore([])
    const adapter = createHistoryAdapter(core.invoke, core.on)
    const closed = await adapter.recentlyClosed()
    expect(closed.map((e) => e.id)).toEqual(['c1'])
    await adapter.restoreClosed('c1')
    expect(core.calls[1]).toEqual(['session.restoreClosed', { id: 'c1' }])
  })

  it('tells the list to look again on history.changed and session.recentlyClosedChanged', () => {
    const core = contractCore([])
    const adapter = createHistoryAdapter(core.invoke, core.on)
    const changed = vi.fn()
    const closedChanged = vi.fn()
    const offChanged = adapter.onChanged(changed)
    const offClosed = adapter.onRecentlyClosedChanged(closedChanged)
    expect(core.subscriptions().sort()).toEqual([
      'history.changed',
      'session.recentlyClosedChanged'
    ])

    core.fire('history.changed', { kind: 'delete' })
    expect(changed).toHaveBeenCalledTimes(1)
    // The listener is told to look again, not what happened: the payload stays with the adapter.
    expect(changed).toHaveBeenCalledWith()
    expect(closedChanged).not.toHaveBeenCalled()

    core.fire('session.recentlyClosedChanged', undefined)
    expect(closedChanged).toHaveBeenCalledTimes(1)

    offChanged()
    offClosed()
    core.fire('history.changed', { kind: 'clear' })
    core.fire('session.recentlyClosedChanged', undefined)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(closedChanged).toHaveBeenCalledTimes(1)
    expect(core.subscriptions()).toEqual([])
  })

  it('does not swallow failures', async () => {
    const invoke: Invoke = async () => {
      throw new Error('disk on fire')
    }
    const core = contractCore([])
    const adapter = createHistoryAdapter(invoke, core.on)
    await expect(adapter.loadGroups('', 10, NOW)).rejects.toThrow('disk on fire')
  })
})
