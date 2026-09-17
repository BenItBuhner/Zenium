import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryEntry, HistoryVisit } from '../../shared/types'
import type { StoreIO } from '../platform'
import {
  groupByDay,
  HistoryService,
  isRecordableUrl,
  MAX_ENTRIES,
  MAX_VISITS,
  migrateHistory,
  prune,
  RETENTION_MS,
  scoreFrecency,
  searchVisits,
  selectRange,
  topSites
} from '../history'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 17, 12, 0, 0)

function visit(partial: Partial<HistoryVisit> & { url: string; visitTime: number }): HistoryVisit {
  return {
    id: partial.id ?? `visit_${partial.url}_${partial.visitTime}`,
    url: partial.url,
    title: partial.title ?? partial.url,
    favicon: partial.favicon ?? null,
    visitTime: partial.visitTime,
    transition: partial.transition ?? 'link',
    ...(partial.tabId ? { tabId: partial.tabId } : {})
  }
}

function entry(partial: Partial<HistoryEntry> & { url: string }): HistoryEntry {
  return {
    url: partial.url,
    title: partial.title ?? partial.url,
    visitCount: partial.visitCount ?? 1,
    lastVisit: partial.lastVisit ?? NOW,
    favicon: partial.favicon ?? null,
    firstVisit: partial.firstVisit,
    typedCount: partial.typedCount
  }
}

function fakeIo(initial: Record<string, string> = {}): StoreIO & { docs: Record<string, string> } {
  const io = {
    docs: { ...initial },
    readSync: (name: string) => io.docs[name] ?? null,
    write: async (name: string, text: string) => {
      io.docs[name] = text
    },
    writeSync: (name: string, text: string) => {
      io.docs[name] = text
    }
  }
  return io
}

describe('isRecordableUrl', () => {
  it('keeps chrome pages, view-source and inline documents out of history', () => {
    for (const url of [
      'zen://blank',
      'zen://newtab',
      'zen://history',
      'zen://error?code=-105',
      'about:blank',
      'chrome://gpu',
      'view-source:https://example.com/',
      'data:text/html,hi',
      ''
    ])
      expect(isRecordableUrl(url), url).toBe(false)
    expect(isRecordableUrl('https://example.com/')).toBe(true)
    expect(isRecordableUrl('http://localhost:8000/a.html')).toBe(true)
    expect(isRecordableUrl('file:///tmp/a.html')).toBe(true)
  })
})

describe('migrateHistory', () => {
  it('turns a v1 document into aggregates plus one restored visit each', () => {
    const data = migrateHistory({
      version: 1,
      entries: [
        { url: 'https://a.test/', title: 'A', visitCount: 7, lastVisit: 1000, favicon: null },
        { url: 'https://b.test/', title: 'B', visitCount: 2, lastVisit: 3000, favicon: 'data:x' }
      ]
    })
    expect(data.entries).toHaveLength(2)
    expect(data.entries[0]).toMatchObject({
      url: 'https://a.test/',
      visitCount: 7,
      firstVisit: 1000
    })
    expect(data.visits.map((v) => v.url)).toEqual(['https://a.test/', 'https://b.test/'])
    expect(data.visits.every((v) => v.transition === 'restored')).toBe(true)
    expect(data.visits[1]).toMatchObject({ visitTime: 3000, favicon: 'data:x', title: 'B' })
    expect(new Set(data.visits.map((v) => v.id)).size).toBe(2)
  })

  it('keeps a v2 document, sorted oldest first, dropping malformed records', () => {
    const data = migrateHistory({
      version: 2,
      entries: [
        { url: 'https://a.test/', title: 'A', visitCount: 1, lastVisit: 5, favicon: null },
        7
      ],
      visits: [
        visit({ url: 'https://a.test/', visitTime: 9 }),
        { nope: true },
        visit({ url: 'https://a.test/', visitTime: 5 })
      ]
    })
    expect(data.entries).toHaveLength(1)
    expect(data.visits.map((v) => v.visitTime)).toEqual([5, 9])
  })

  it('starts empty for garbage or unknown versions', () => {
    expect(migrateHistory(null)).toEqual({ entries: [], visits: [] })
    expect(migrateHistory('x')).toEqual({ entries: [], visits: [] })
    expect(migrateHistory({ version: 9, entries: [] })).toEqual({ entries: [], visits: [] })
  })
})

describe('prune', () => {
  it('expires visits older than the retention window and their aggregates', () => {
    const old = visit({ url: 'https://old.test/', visitTime: NOW - RETENTION_MS - 1 })
    const edge = visit({ url: 'https://edge.test/', visitTime: NOW - RETENTION_MS })
    const fresh = visit({ url: 'https://fresh.test/', visitTime: NOW - DAY })
    const out = prune(
      [fresh, old, edge],
      [
        entry({ url: 'https://old.test/', lastVisit: old.visitTime }),
        entry({ url: 'https://edge.test/', lastVisit: edge.visitTime }),
        entry({ url: 'https://fresh.test/', lastVisit: fresh.visitTime })
      ],
      NOW
    )
    expect(out.visits.map((v) => v.url)).toEqual(['https://edge.test/', 'https://fresh.test/'])
    expect(out.entries.map((e) => e.url).sort()).toEqual([
      'https://edge.test/',
      'https://fresh.test/'
    ])
  })

  it('caps visits at the newest MAX_VISITS', () => {
    const visits: HistoryVisit[] = []
    for (let i = 0; i < MAX_VISITS + 10; i++)
      visits.push(visit({ id: `v${i}`, url: 'https://a.test/', visitTime: NOW - i * 1000 }))
    const out = prune(visits, [entry({ url: 'https://a.test/' })], NOW)
    expect(out.visits).toHaveLength(MAX_VISITS)
    expect(out.visits[out.visits.length - 1].id).toBe('v0')
    expect(out.visits[0].id).toBe(`v${MAX_VISITS - 1}`)
  })

  it('caps aggregates at the most recent MAX_ENTRIES and drops their orphaned visits', () => {
    const entries: HistoryEntry[] = []
    const visits: HistoryVisit[] = []
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      const url = `https://s${i}.test/`
      entries.push(entry({ url, lastVisit: NOW - i * 1000 }))
      visits.push(visit({ url, visitTime: NOW - i * 1000 }))
    }
    const out = prune(visits, entries, NOW)
    expect(out.entries).toHaveLength(MAX_ENTRIES)
    expect(out.visits).toHaveLength(MAX_ENTRIES)
    expect(out.entries.some((e) => e.url === `https://s${MAX_ENTRIES + 4}.test/`)).toBe(false)
    expect(out.entries.some((e) => e.url === 'https://s0.test/')).toBe(true)
  })
})

describe('scoreFrecency', () => {
  it('weighs recent pages more and typed visits double', () => {
    const today = entry({ url: 'https://a.test/', visitCount: 3, lastVisit: NOW - DAY })
    const lastMonth = entry({ url: 'https://b.test/', visitCount: 3, lastVisit: NOW - 20 * DAY })
    const ancient = entry({ url: 'https://c.test/', visitCount: 3, lastVisit: NOW - 200 * DAY })
    expect(scoreFrecency(today, NOW)).toBeGreaterThan(scoreFrecency(lastMonth, NOW))
    expect(scoreFrecency(lastMonth, NOW)).toBeGreaterThan(scoreFrecency(ancient, NOW))
    const typed = entry({
      url: 'https://d.test/',
      visitCount: 3,
      typedCount: 1,
      lastVisit: NOW - DAY
    })
    expect(scoreFrecency(typed, NOW)).toBe(scoreFrecency(today, NOW) + 2 * 100)
  })
})

describe('selectRange', () => {
  it('takes fromMs inclusive, toMs exclusive, newest first', () => {
    const visits = [1, 2, 3, 4].map((t) => visit({ url: `https://t${t}.test/`, visitTime: t }))
    expect(selectRange(visits, 2, 4).map((v) => v.visitTime)).toEqual([3, 2])
  })
})

describe('searchVisits', () => {
  const visits = [
    visit({ url: 'https://docs.example.com/guide', title: 'The Guide', visitTime: 30 }),
    visit({ url: 'https://example.com/', title: 'Example Domain', visitTime: 20 }),
    visit({ url: 'https://other.test/guide', title: 'Other guide', visitTime: 10 })
  ]

  it('matches every term against title and URL, case-insensitively, newest first', () => {
    expect(searchVisits(visits, { text: 'GUIDE', limit: 10 }).map((v) => v.visitTime)).toEqual([
      30, 10
    ])
    expect(searchVisits(visits, { text: 'guide other', limit: 10 }).map((v) => v.url)).toEqual([
      'https://other.test/guide'
    ])
    expect(searchVisits(visits, { text: 'nothing here', limit: 10 })).toEqual([])
  })

  it('filters by host including subdomains, by time range, and pages with offset/limit', () => {
    expect(
      searchVisits(visits, { host: 'example.com', limit: 10 }).map((v) => v.visitTime)
    ).toEqual([30, 20])
    expect(searchVisits(visits, { host: 'www.example.com', limit: 10 })).toHaveLength(2)
    expect(
      searchVisits(visits, { fromMs: 10, toMs: 30, limit: 10 }).map((v) => v.visitTime)
    ).toEqual([20, 10])
    expect(searchVisits(visits, { limit: 1, offset: 1 }).map((v) => v.visitTime)).toEqual([20])
    expect(searchVisits(visits, { limit: 0 })).toEqual([])
  })
})

describe('groupByDay', () => {
  it('groups by local calendar day, newest day and newest visit first', () => {
    const d1 = Date.UTC(2026, 8, 15, 23, 30)
    const d2a = Date.UTC(2026, 8, 16, 0, 10)
    const d2b = Date.UTC(2026, 8, 16, 18, 0)
    const groups = groupByDay(
      [
        visit({ url: 'https://a.test/', visitTime: d2a }),
        visit({ url: 'https://b.test/', visitTime: d1 }),
        visit({ url: 'https://c.test/', visitTime: d2b })
      ],
      'UTC'
    )
    expect(groups.map((g) => g.dayKey)).toEqual(['2026-09-16', '2026-09-15'])
    expect(groups[0].visits.map((v) => v.url)).toEqual(['https://c.test/', 'https://a.test/'])
  })

  it('honours the time zone when splitting days', () => {
    const late = Date.UTC(2026, 8, 16, 23, 30)
    expect(groupByDay([visit({ url: 'https://a.test/', visitTime: late })], 'UTC')[0].dayKey).toBe(
      '2026-09-16'
    )
    expect(
      groupByDay([visit({ url: 'https://a.test/', visitTime: late })], 'Asia/Tokyo')[0].dayKey
    ).toBe('2026-09-17')
  })
})

describe('topSites', () => {
  it('folds pages by host, ranks by summed frecency and skips excluded or non-web pages', () => {
    const entries = [
      entry({ url: 'https://news.test/a', visitCount: 2, lastVisit: NOW - DAY }),
      entry({ url: 'https://news.test/b', visitCount: 5, lastVisit: NOW - DAY, title: 'News B' }),
      entry({ url: 'https://www.shop.test/', visitCount: 6, lastVisit: NOW - DAY }),
      entry({ url: 'https://hidden.test/', visitCount: 50, lastVisit: NOW - DAY }),
      entry({ url: 'file:///tmp/x.html', visitCount: 50, lastVisit: NOW - DAY })
    ]
    const sites = topSites(entries, 5, ['www.hidden.test'], NOW)
    expect(sites.map((s) => s.url)).toEqual(['https://news.test/b', 'https://www.shop.test/'])
    expect(sites[0]).toMatchObject({ title: 'News B', score: 700 })
    expect(topSites(entries, 1, [], NOW)).toHaveLength(1)
  })
})

describe('HistoryService', () => {
  let clock = NOW
  const now = (): number => clock

  beforeEach(() => {
    clock = NOW
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('records visits with aggregates, keeps the 3-argument call working, and skips chrome pages', () => {
    const io = fakeIo()
    const h = new HistoryService(io, now)
    h.visit('https://a.test/', 'A', null)
    clock += 1000
    h.visit('https://a.test/', 'A again', 'data:icon', { transition: 'typed', tabId: 't1' })
    h.visit('zen://blank', 'Blank', null)
    h.visit('zen://newtab', 'New Tab', null)
    h.visit('view-source:https://a.test/', 'src', null)
    expect(h.count(0, Infinity)).toBe(2)
    const [latest, first] = h.visits({ limit: 10 })
    expect(latest).toMatchObject({ url: 'https://a.test/', transition: 'typed', tabId: 't1' })
    expect(first.transition).toBe('link')
    expect(latest.favicon).toBe('data:icon')
    expect(h.recent(5)[0]).toMatchObject({
      url: 'https://a.test/',
      title: 'A again',
      visitCount: 2,
      typedCount: 1,
      firstVisit: NOW,
      lastVisit: NOW + 1000
    })
  })

  it('persists as version 2 and migrates a version 1 file on load', async () => {
    const io = fakeIo({
      'history.json': JSON.stringify({
        version: 1,
        entries: [
          { url: 'https://a.test/', title: 'A', visitCount: 3, lastVisit: NOW - DAY, favicon: null }
        ]
      })
    })
    const h = new HistoryService(io, now)
    expect(h.visits({ limit: 10 })).toHaveLength(1)
    expect(h.visits({ limit: 10 })[0].transition).toBe('restored')
    h.flushSync()
    const stored = JSON.parse(io.docs['history.json']) as { version: number; visits: unknown[] }
    expect(stored.version).toBe(2)
    expect(stored.visits).toHaveLength(1)
    // The migrated document loads again unchanged.
    const again = new HistoryService(io, now)
    expect(again.recent(5)[0].visitCount).toBe(3)
  })

  it('prunes expired visits when loading', () => {
    const io = fakeIo({
      'history.json': JSON.stringify({
        version: 2,
        entries: [entry({ url: 'https://old.test/', lastVisit: NOW - RETENTION_MS - DAY })],
        visits: [visit({ url: 'https://old.test/', visitTime: NOW - RETENTION_MS - DAY })]
      })
    })
    const h = new HistoryService(io, now)
    expect(h.count(0, Infinity)).toBe(0)
    expect(h.recent(5)).toEqual([])
  })

  it('deletes single visits and recomputes the aggregate; the last visit takes the page with it', () => {
    const h = new HistoryService(fakeIo(), now)
    h.visit('https://a.test/', 'A', null, { transition: 'typed' })
    clock += 1000
    h.visit('https://a.test/', 'A', null)
    const visits = h.visits({ limit: 10 })
    h.deleteVisits([visits[0].id])
    expect(h.recent(5)[0]).toMatchObject({ visitCount: 1, lastVisit: NOW, typedCount: 1 })
    h.deleteVisits([visits[1].id])
    expect(h.recent(5)).toEqual([])
  })

  it('deletes by URL, by day and by range', () => {
    const h = new HistoryService(fakeIo(), now)
    clock = Date.UTC(2026, 8, 15, 12)
    h.visit('https://a.test/', 'A', null)
    clock = Date.UTC(2026, 8, 16, 12)
    h.visit('https://b.test/', 'B', null)
    h.visit('https://c.test/', 'C', null)
    clock = Date.UTC(2026, 8, 17, 12)
    h.visit('https://d.test/', 'D', null)
    h.deleteUrls(['https://d.test/'])
    expect(h.count(0, Infinity)).toBe(3)
    const dayOfB = h
      .groupedByDay({ limit: 100 })
      .find((g) => g.visits.some((v) => v.url === 'https://b.test/'))
    h.deleteDay(dayOfB!.dayKey)
    expect(h.visits({ limit: 10 }).map((v) => v.url)).toEqual(['https://a.test/'])
    expect(h.deleteRange(0, Date.UTC(2026, 8, 16))).toBe(1)
    expect(h.deleteRange(0, Infinity)).toBe(0)
  })

  it('groups visits by day and ranks top sites', () => {
    const h = new HistoryService(fakeIo(), now)
    h.visit('https://a.test/x', 'A', null)
    h.visit('https://a.test/y', 'A2', null)
    h.visit('https://b.test/', 'B', null)
    expect(h.groupedByDay({ limit: 100 })).toHaveLength(1)
    expect(h.groupedByDay({ limit: 100 })[0].visits).toHaveLength(3)
    expect(h.topSites(5).map((s) => s.url)).toEqual(['https://a.test/x', 'https://b.test/'])
    expect(h.topSites(5, ['b.test'])).toHaveLength(1)
  })

  it('notifies listeners: visits throttled, deletions at once', () => {
    const h = new HistoryService(fakeIo(), now)
    const kinds: string[] = []
    const off = h.onChange((kind) => kinds.push(kind))
    h.visit('https://a.test/', 'A', null)
    h.visit('https://b.test/', 'B', null)
    expect(kinds).toEqual([])
    vi.advanceTimersByTime(600)
    expect(kinds).toEqual(['visit'])
    h.deleteUrls(['https://a.test/'])
    expect(kinds).toEqual(['visit', 'delete'])
    h.clear()
    expect(kinds).toEqual(['visit', 'delete', 'clear'])
    off()
    h.visit('https://c.test/', 'C', null)
    vi.advanceTimersByTime(600)
    expect(kinds).toHaveLength(3)
  })

  it('propagates title updates to the visits of a page', () => {
    const h = new HistoryService(fakeIo(), now)
    h.visit('https://a.test/', '', null)
    h.updateTitle('https://a.test/', 'Real Title')
    expect(h.visits({ limit: 1 })[0].title).toBe('Real Title')
    expect(h.search('real', 5)[0].title).toBe('Real Title')
  })
})
