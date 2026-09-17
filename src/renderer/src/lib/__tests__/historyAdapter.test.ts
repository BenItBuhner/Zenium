import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '@shared/types'
import {
  createHistoryAdapter,
  isUnknownCommand,
  labelDayGroups,
  rowsFromEntries,
  type HistoryDayGroup,
  type Invoke
} from '../historyAdapter'

const TZ = 'UTC'
// 2026-09-17 12:00 UTC
const NOW = Date.UTC(2026, 8, 17, 12)
const H = 3_600_000

const entry = (url: string, lastVisit: number, title = url): HistoryEntry => ({
  url,
  title,
  visitCount: 1,
  lastVisit,
  favicon: null
})

/** A core that only has today's commands: everything else is unknown. */
function legacyCore(entries: HistoryEntry[]): { invoke: Invoke; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = []
  const invoke: Invoke = async (name, args) => {
    calls.push([name, args])
    switch (name) {
      case 'history.search':
        return entries
      case 'history.delete':
      case 'history.clear':
      case 'tab.reopenClosed':
        return undefined
      default:
        throw new Error(`Unknown command: ${name}`)
    }
  }
  return { invoke, calls }
}

/** A core that speaks contract v0. */
function contractCore(groups: HistoryDayGroup[]): {
  invoke: Invoke
  calls: Array<[string, unknown]>
} {
  const calls: Array<[string, unknown]> = []
  const invoke: Invoke = async (name, args) => {
    calls.push([name, args])
    switch (name) {
      case 'history.grouped':
        return groups
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
  return { invoke, calls }
}

describe('rowsFromEntries', () => {
  it('turns a per-URL aggregate into one visit at its last visit, keyed by URL', () => {
    const entries: HistoryEntry[] = [
      {
        url: 'https://example.com/a',
        title: 'Example',
        visitCount: 3,
        lastVisit: 1_700_000_000_000,
        favicon: 'https://example.com/favicon.ico'
      },
      { url: 'https://example.com/b', title: '', visitCount: 1, lastVisit: 1, favicon: null }
    ]
    expect(rowsFromEntries(entries)).toEqual([
      {
        id: 'https://example.com/a',
        url: 'https://example.com/a',
        title: 'Example',
        favicon: 'https://example.com/favicon.ico',
        visitTime: 1_700_000_000_000
      },
      {
        id: 'https://example.com/b',
        url: 'https://example.com/b',
        title: 'https://example.com/b',
        favicon: null,
        visitTime: 1
      }
    ])
  })

  it('keeps the input order', () => {
    const entries: HistoryEntry[] = ['z', 'a', 'm'].map((k) => entry(`https://${k}.example/`, 0, k))
    expect(rowsFromEntries(entries).map((r) => r.title)).toEqual(['z', 'a', 'm'])
  })
})

describe('labelDayGroups', () => {
  it('keeps the core’s buckets and gives them the renderer’s headings', () => {
    const groups: HistoryDayGroup[] = [
      { dayKey: '2026-09-17', visits: [] },
      { dayKey: '2026-09-16', visits: [] },
      { dayKey: '2026-09-14', visits: [] }
    ]
    const labelled = labelDayGroups(groups, NOW, { timeZone: TZ, locale: 'en-US' })
    expect(labelled.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Monday'])
    expect(labelled.map((g) => g.dayKey)).toEqual(groups.map((g) => g.dayKey))
  })
})

describe('isUnknownCommand', () => {
  it('recognises the core’s answer through either bridge', () => {
    expect(isUnknownCommand(new Error('Unknown command: history.grouped'))).toBe(true)
    expect(
      isUnknownCommand(
        new Error("Error invoking remote method 'zen:cmd': Error: Unknown command: history.grouped")
      )
    ).toBe(true)
    expect(isUnknownCommand(new Error('boom'))).toBe(false)
    expect(isUnknownCommand('Unknown command')).toBe(false)
  })
})

describe('createHistoryAdapter on today’s core', () => {
  it('falls back to history.search and groups in the renderer, once', async () => {
    const core = legacyCore([
      entry('https://a.example/', NOW - H),
      entry('https://b.example/', NOW - 30 * H)
    ])
    const adapter = createHistoryAdapter(core.invoke)
    expect(adapter.source).toBeNull()

    const groups = await adapter.loadGroups('', 100, NOW, { timeZone: TZ, locale: 'en-US' })
    expect(adapter.source).toBe('legacy')
    expect(groups.map((g) => [g.label, g.items.map((r) => r.url)])).toEqual([
      ['Today', ['https://a.example/']],
      ['Yesterday', ['https://b.example/']]
    ])
    expect(core.calls.map(([name]) => name)).toEqual(['history.grouped', 'history.search'])

    core.calls.length = 0
    await adapter.loadGroups('a', 50, NOW)
    // The unknown name is not tried again.
    expect(core.calls).toEqual([['history.search', { query: 'a', limit: 50 }]])
  })

  it('deletes visits, URLs and days as per-URL deletes, each URL once', async () => {
    const core = legacyCore([])
    const adapter = createHistoryAdapter(core.invoke)
    const rows = rowsFromEntries([
      entry('https://a.example/', NOW),
      entry('https://a.example/', NOW - H),
      entry('https://b.example/', NOW)
    ])
    await adapter.deleteRows(rows)
    expect(core.calls.map(([name, args]) => [name, args])).toEqual([
      [
        'history.deleteVisits',
        { ids: ['https://a.example/', 'https://a.example/', 'https://b.example/'] }
      ],
      ['history.delete', { url: 'https://a.example/' }],
      ['history.delete', { url: 'https://b.example/' }]
    ])

    core.calls.length = 0
    await adapter.deleteDay('2026-09-17', rows.slice(0, 1))
    expect(core.calls).toEqual([['history.delete', { url: 'https://a.example/' }]])

    core.calls.length = 0
    await adapter.deleteUrls(['https://b.example/'])
    expect(core.calls).toEqual([['history.delete', { url: 'https://b.example/' }]])
  })

  it('has no recently closed list and can only reopen the newest tab', async () => {
    const core = legacyCore([])
    const adapter = createHistoryAdapter(core.invoke)
    expect(await adapter.recentlyClosed()).toEqual([])
    await adapter.restoreClosed('anything')
    expect(core.calls.map(([name]) => name)).toEqual(['session.recentlyClosed', 'tab.reopenClosed'])
  })

  it('still clears through history.clear', async () => {
    const core = legacyCore([])
    const adapter = createHistoryAdapter(core.invoke)
    await adapter.clear()
    expect(core.calls).toEqual([['history.clear', undefined]])
  })
})

describe('createHistoryAdapter on a contract v0 core', () => {
  const groups: HistoryDayGroup[] = [
    {
      dayKey: '2026-09-17',
      visits: [
        {
          id: 'v2',
          url: 'https://a.example/',
          title: 'A',
          favicon: null,
          visitTime: NOW - H
        }
      ]
    },
    {
      dayKey: '2026-09-16',
      visits: [
        {
          id: 'v1',
          url: 'https://b.example/',
          title: 'B',
          favicon: 'https://b.example/icon.png',
          visitTime: NOW - 30 * H
        }
      ]
    }
  ]

  it('takes the core’s day groups as they are and labels them', async () => {
    const core = contractCore(groups)
    const adapter = createHistoryAdapter(core.invoke)
    const result = await adapter.loadGroups('b', 20, NOW, { timeZone: TZ, locale: 'en-US' })
    expect(adapter.source).toBe('contract')
    expect(core.calls).toEqual([['history.grouped', { query: { text: 'b', limit: 20 } }]])
    expect(result).toEqual([
      { dayKey: '2026-09-17', label: 'Today', items: groups[0].visits },
      { dayKey: '2026-09-16', label: 'Yesterday', items: groups[1].visits }
    ])
  })

  it('leaves an empty search text out of the query', async () => {
    const core = contractCore([])
    await createHistoryAdapter(core.invoke).loadGroups('', 300, NOW)
    expect(core.calls).toEqual([['history.grouped', { query: { limit: 300 } }]])
  })

  it('deletes by visit id, URL and day with the contract’s commands', async () => {
    const core = contractCore(groups)
    const adapter = createHistoryAdapter(core.invoke)
    await adapter.deleteRows([groups[0].visits[0], groups[1].visits[0]])
    await adapter.deleteUrls(['https://a.example/'])
    await adapter.deleteDay('2026-09-16', groups[1].visits)
    expect(core.calls).toEqual([
      ['history.deleteVisits', { ids: ['v2', 'v1'] }],
      ['history.deleteUrls', { urls: ['https://a.example/'] }],
      ['history.deleteDay', { dayKey: '2026-09-16' }]
    ])
  })

  it('lists recently closed entries and restores one by id', async () => {
    const core = contractCore([])
    const adapter = createHistoryAdapter(core.invoke)
    const closed = await adapter.recentlyClosed()
    expect(closed.map((e) => e.id)).toEqual(['c1'])
    await adapter.restoreClosed('c1')
    expect(core.calls[1]).toEqual(['session.restoreClosed', { id: 'c1' }])
  })

  it('treats a result of the wrong shape as an error, not as data', async () => {
    const invoke: Invoke = async () => [{ dayKey: 1, visits: 'no' }]
    await expect(createHistoryAdapter(invoke).loadGroups('', 10, NOW)).rejects.toThrow(
      'history.grouped: unexpected result'
    )
  })

  it('does not swallow other failures', async () => {
    const invoke: Invoke = async () => {
      throw new Error('disk on fire')
    }
    const adapter = createHistoryAdapter(invoke)
    await expect(adapter.loadGroups('', 10, NOW)).rejects.toThrow('disk on fire')
    expect(adapter.source).toBeNull()
  })
})
