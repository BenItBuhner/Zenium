import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryEntry, HistoryVisit } from '../../shared/types'
import type { StoreIO } from '../platform'
import {
  dayKeyOf,
  groupByDay,
  HistoryService,
  type ImportedVisit,
  isRecordableUrl,
  matchesAtWordStart,
  MAX_ENTRIES,
  MAX_VISITS,
  migrateHistory,
  prune,
  RETENTION_MS,
  scoreFrecency,
  scoreHistoryMatch,
  searchVisits,
  selectRange,
  topSites
} from '../history'
import { JsonStore } from '../store/JsonStore'

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

describe('matchesAtWordStart', () => {
  it('finds the term at the start of the text or after a non-letter, not inside a word', () => {
    expect(matchesAtWordStart('Docs home', 'docs')).toBe(true)
    expect(matchesAtWordStart('example.com/docs/intro', 'docs')).toBe(true)
    expect(matchesAtWordStart('example.com/my-docs', 'docs')).toBe(true)
    expect(matchesAtWordStart('Googledocs', 'docs')).toBe(false)
    expect(matchesAtWordStart('example.com/googledocs', 'docs')).toBe(false)
    // A later occurrence at a word start counts even when an earlier one is mid-word.
    expect(matchesAtWordStart('Googledocs – docs', 'docs')).toBe(true)
    expect(matchesAtWordStart('anything', '')).toBe(false)
  })

  it('reads letters and digits of every script as word characters', () => {
    expect(matchesAtWordStart('Überdocs', 'docs')).toBe(false)
    expect(matchesAtWordStart('über docs', 'docs')).toBe(true)
    expect(matchesAtWordStart('v2docs', 'docs')).toBe(false)
  })
})

describe('scoreHistoryMatch (omnibox-02: HistoryURL + HistoryQuick)', () => {
  const base = { visitCount: 3, lastVisit: NOW - DAY }

  it('is null when a term is missing, a number when every term is somewhere', () => {
    const e = entry({ url: 'https://news.example/', title: 'Daily news', ...base })
    expect(scoreHistoryMatch(e, ['news', 'weekly'], NOW)).toBeNull()
    expect(scoreHistoryMatch(e, ['daily', 'news'], NOW)).not.toBeNull()
  })

  it('typed visits count three times a plain visit', () => {
    const plain = entry({ url: 'https://a.example/', title: 'A', ...base, visitCount: 4 })
    const typed = entry({
      url: 'https://b.example/',
      title: 'B',
      ...base,
      visitCount: 1,
      typedCount: 1
    })
    expect(scoreHistoryMatch(typed, ['example'], NOW)).toBe(
      scoreHistoryMatch(plain, ['example'], NOW)
    )
    const typedMore = entry({ ...typed, typedCount: 3 })
    expect(scoreHistoryMatch(typedMore, ['example'], NOW)!).toBeGreaterThan(
      scoreHistoryMatch(plain, ['example'], NOW)!
    )
  })

  it('a term at a word start in the title or a path segment outranks one inside a word', () => {
    const wordStart = entry({ url: 'https://x.example/docs/', title: 'Team docs', ...base })
    const midWord = entry({ url: 'https://y.example/googledocs', title: 'Googledocs', ...base })
    expect(scoreHistoryMatch(wordStart, ['docs'], NOW)!).toBeGreaterThan(
      scoreHistoryMatch(midWord, ['docs'], NOW)!
    )
    // Every term must sit at a word start for the bonus.
    const oneMid = entry({ url: 'https://z.example/googledocs', title: 'Team pages', ...base })
    const bothStart = entry({ url: 'https://z.example/google/docs', title: 'Team pages', ...base })
    expect(scoreHistoryMatch(oneMid, ['google', 'docs'], NOW)!).toBeLessThan(
      scoreHistoryMatch(bothStart, ['google', 'docs'], NOW)!
    )
  })

  it('the start of the address (scheme and www. aside) counts on top of a word start', () => {
    const host = entry({ url: 'https://www.docs.example/', title: 'Home', ...base })
    const path = entry({ url: 'https://other.example/docs', title: 'Home', ...base })
    expect(scoreHistoryMatch(host, ['docs'], NOW)!).toBeGreaterThan(
      scoreHistoryMatch(path, ['docs'], NOW)!
    )
  })

  it('recency still tells two otherwise equal pages apart', () => {
    const fresh = entry({
      url: 'https://a.example/docs',
      title: 'Docs',
      visitCount: 2,
      lastVisit: NOW
    })
    const stale = entry({
      url: 'https://b.example/docs',
      title: 'Docs',
      visitCount: 2,
      lastVisit: NOW - 30 * DAY
    })
    expect(scoreHistoryMatch(fresh, ['docs'], NOW)!).toBeGreaterThan(
      scoreHistoryMatch(stale, ['docs'], NOW)!
    )
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

  /** The stored visit list, in the order it is kept. */
  function storedVisits(io: { docs: Record<string, string> }): HistoryVisit[] {
    return (JSON.parse(io.docs['history.json']) as { visits: HistoryVisit[] }).visits
  }

  describe('visit with at', () => {
    it('records a dated visit at its place: first/last and the count follow, the title and favicon only the newest', () => {
      const io = fakeIo()
      const h = new HistoryService(io, now)
      h.visit('https://a.test/', 'Current', 'data:new')
      h.visit('https://a.test/', 'Old title', 'data:old', {
        at: NOW - 2 * DAY,
        transition: 'typed'
      })
      h.visit('https://a.test/', 'Middle', null, { at: NOW - DAY })
      h.visit('https://b.test/', 'B', null, { at: NOW - 3 * DAY })
      expect(h.count(0, Infinity)).toBe(4)
      expect(h.visits({ limit: 10 }).map((v) => [v.title, v.visitTime])).toEqual([
        ['Current', NOW],
        ['Middle', NOW - DAY],
        ['Old title', NOW - 2 * DAY],
        ['B', NOW - 3 * DAY]
      ])
      expect(h.recent(5)[0]).toMatchObject({
        url: 'https://a.test/',
        title: 'Current',
        favicon: 'data:new',
        visitCount: 3,
        typedCount: 1,
        firstVisit: NOW - 2 * DAY,
        lastVisit: NOW
      })
      // The list itself is kept oldest first, the dated visits inserted at their place.
      h.flushSync()
      expect(storedVisits(io).map((v) => v.visitTime)).toEqual([
        NOW - 3 * DAY,
        NOW - 2 * DAY,
        NOW - DAY,
        NOW
      ])
      // Day groups put the dated visit on its own day.
      const groups = h.groupedByDay({ limit: 100 })
      expect(groups.map((g) => g.dayKey)).toEqual([
        dayKeyOf(NOW),
        dayKeyOf(NOW - DAY),
        dayKeyOf(NOW - 2 * DAY),
        dayKeyOf(NOW - 3 * DAY)
      ])
      expect(groups[2].visits.map((v) => v.title)).toEqual(['Old title'])
    })

    it('lets a newer dated visit retitle the page and keeps a visit ordered after an equal time', () => {
      const io = fakeIo()
      const h = new HistoryService(io, now)
      h.visit('https://a.test/', 'Old', null, { at: NOW - DAY })
      h.visit('https://a.test/', 'New', 'data:icon', { at: NOW - 3_600_000 })
      expect(h.recent(5)[0]).toMatchObject({
        title: 'New',
        favicon: 'data:icon',
        firstVisit: NOW - DAY,
        lastVisit: NOW - 3_600_000
      })
      h.visit('https://a.test/', 'Same time', null, { at: NOW - 3_600_000 })
      expect(h.recent(5)[0]).toMatchObject({ title: 'Same time', visitCount: 3 })
      h.flushSync()
      expect(storedVisits(io).map((v) => v.title)).toEqual(['Old', 'New', 'Same time'])
    })

    it('clamps a future or unusable at to now and records nothing past the retention window', () => {
      const h = new HistoryService(fakeIo(), now)
      h.visit('https://future.test/', 'F', null, { at: NOW + DAY })
      h.visit('https://nan.test/', 'N', null, { at: Number.NaN })
      expect(h.visits({ limit: 10 }).map((v) => v.visitTime)).toEqual([NOW, NOW])
      expect(h.recent(5).map((e) => [e.firstVisit, e.lastVisit])).toEqual([
        [NOW, NOW],
        [NOW, NOW]
      ])
      h.visit('https://old.test/', 'O', null, { at: NOW - RETENTION_MS - 1 })
      expect(h.count(0, Infinity)).toBe(2)
      expect(h.recent(5).some((e) => e.url === 'https://old.test/')).toBe(false)
      h.visit('https://edge.test/', 'E', null, { at: NOW - RETENTION_MS })
      expect(h.count(0, Infinity)).toBe(3)
    })
  })

  describe('importVisits', () => {
    beforeEach(() => {
      vi.spyOn(console, 'info').mockImplementation(() => undefined)
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('writes a batch, keeps the list sorted and answers newest first', () => {
      const io = fakeIo()
      const h = new HistoryService(io, now)
      const result = h.importVisits(
        [
          { url: 'https://a.test/', title: 'A', at: NOW - 3 * DAY },
          { url: 'https://b.test/', title: 'B', at: NOW - DAY, transition: 'typed' },
          { url: 'https://a.test/', title: 'A newer', at: NOW - 2 * DAY, favicon: 'data:a' }
        ],
        { source: 'chrome' }
      )
      expect(result).toEqual({ imported: 3, skipped: 0 })
      expect(h.visits({ limit: 10 }).map((v) => [v.url, v.visitTime, v.transition])).toEqual([
        ['https://b.test/', NOW - DAY, 'typed'],
        ['https://a.test/', NOW - 2 * DAY, 'link'],
        ['https://a.test/', NOW - 3 * DAY, 'link']
      ])
      expect(h.visits({ host: 'a.test', limit: 5 }).map((v) => v.favicon)).toEqual([
        'data:a',
        'data:a'
      ])
      expect(new Set(h.visits({ limit: 10 }).map((v) => v.id)).size).toBe(3)
      h.flushSync()
      expect(storedVisits(io).map((v) => v.visitTime)).toEqual([
        NOW - 3 * DAY,
        NOW - 2 * DAY,
        NOW - DAY
      ])
    })

    it('skips duplicates by (url, at) against stored visits and within the batch', () => {
      const h = new HistoryService(fakeIo(), now)
      h.visit('https://a.test/', 'A', null, { at: NOW - DAY })
      const result = h.importVisits(
        [
          { url: 'https://a.test/', at: NOW - DAY },
          { url: 'https://a.test/', at: NOW - 2 * DAY },
          { url: 'https://a.test/', at: NOW - 2 * DAY, title: 'Again' },
          { url: 'https://b.test/', at: NOW - 2 * DAY }
        ],
        { source: 'edge' }
      )
      expect(result).toEqual({ imported: 2, skipped: 2 })
      expect(h.count(0, Infinity)).toBe(3)
      expect(h.recent(5).find((e) => e.url === 'https://a.test/')).toMatchObject({
        visitCount: 2,
        firstVisit: NOW - 2 * DAY,
        lastVisit: NOW - DAY
      })
    })

    it('skips pages that never enter history, an unusable at, and visits past retention', () => {
      const h = new HistoryService(fakeIo(), now)
      const result = h.importVisits(
        [
          { url: 'zen://history', at: NOW - DAY },
          { url: 'data:text/html,hi', at: NOW - DAY },
          { url: 'view-source:https://a.test/', at: NOW - DAY },
          { url: '', at: NOW - DAY },
          { url: 'https://nan.test/', at: Number.NaN },
          { url: 'https://inf.test/', at: Infinity },
          { url: 'https://text.test/', at: '1' as unknown as number },
          { url: 'https://future.test/', at: NOW + 1 },
          { url: 'https://old.test/', at: NOW - RETENTION_MS - 1 },
          { url: 'https://edge.test/', at: NOW - RETENTION_MS },
          { url: 'https://ok.test/', at: NOW }
        ],
        { source: 'firefox' }
      )
      expect(result).toEqual({ imported: 2, skipped: 9 })
      expect(h.visits({ limit: 10 }).map((v) => v.url)).toEqual([
        'https://ok.test/',
        'https://edge.test/'
      ])
    })

    it('folds a batch into the aggregates once per page with the title and favicon rules', () => {
      const h = new HistoryService(fakeIo(), now)
      h.visit('https://a.test/', 'Live title', 'data:live', { at: NOW - DAY })
      h.visit('https://b.test/', '', null, { at: NOW - DAY })
      h.visit('https://e.test/', 'E old', 'data:eold', { at: NOW - DAY })
      const result = h.importVisits(
        [
          // Older than a.test's last visit: counted, never retitles it.
          {
            url: 'https://a.test/',
            title: 'Stale',
            favicon: 'data:stale',
            at: NOW - 5 * DAY,
            transition: 'typed'
          },
          { url: 'https://a.test/', title: 'Stale 2', at: NOW - 4 * DAY },
          // Older than b.test's last visit, but b.test has no title or icon: fills them.
          { url: 'https://b.test/', title: 'Filled', favicon: 'data:filled', at: NOW - 3 * DAY },
          // A new page: the newest visit's title and icon stand for it.
          { url: 'https://c.test/', title: 'C old', favicon: 'data:cold', at: NOW - 2 * DAY },
          { url: 'https://c.test/', title: 'C new', at: NOW - DAY, transition: 'typed' },
          { url: 'https://c.test/', at: NOW - 3_600_000 },
          // Newer than e.test's last visit: replaces its title and icon.
          { url: 'https://e.test/', title: 'E new', favicon: 'data:enew', at: NOW - 3_600_000 }
        ],
        { source: 'chrome' }
      )
      expect(result).toEqual({ imported: 7, skipped: 0 })
      const byUrl = new Map(h.recent(10).map((e) => [e.url, e]))
      expect(byUrl.get('https://a.test/')).toMatchObject({
        title: 'Live title',
        favicon: 'data:live',
        visitCount: 3,
        typedCount: 1,
        firstVisit: NOW - 5 * DAY,
        lastVisit: NOW - DAY
      })
      expect(byUrl.get('https://b.test/')).toMatchObject({
        title: 'Filled',
        favicon: 'data:filled',
        visitCount: 2,
        typedCount: 0,
        firstVisit: NOW - 3 * DAY,
        lastVisit: NOW - DAY
      })
      expect(byUrl.get('https://c.test/')).toMatchObject({
        title: 'C new',
        favicon: 'data:cold',
        visitCount: 3,
        typedCount: 1,
        firstVisit: NOW - 2 * DAY,
        lastVisit: NOW - 3_600_000
      })
      expect(byUrl.get('https://e.test/')).toMatchObject({
        title: 'E new',
        favicon: 'data:enew',
        visitCount: 2,
        firstVisit: NOW - DAY,
        lastVisit: NOW - 3_600_000
      })
      expect(h.visits({ host: 'c.test', limit: 1 })[0]).toMatchObject({
        title: 'https://c.test/',
        favicon: 'data:cold'
      })
    })

    it('applies retention and the caps once: a batch over MAX_VISITS keeps the newest', () => {
      const h = new HistoryService(fakeIo(), now)
      const writes = vi.spyOn(JsonStore.prototype, 'write')
      const batch: ImportedVisit[] = []
      for (let i = 0; i < 60_000; i++)
        batch.push({ url: `https://s${i % 100}.test/`, at: NOW - i * 1000 })
      expect(h.importVisits(batch, { source: 'chrome' })).toEqual({ imported: 60_000, skipped: 0 })
      expect(h.count(0, Infinity)).toBe(MAX_VISITS)
      const oldestKept = NOW - (MAX_VISITS - 1) * 1000
      expect(h.count(0, oldestKept)).toBe(0)
      expect(h.count(oldestKept, oldestKept + 1)).toBe(1)
      expect(h.visits({ limit: 1 })[0].visitTime).toBe(NOW)
      expect(h.recent(200)).toHaveLength(100)
      expect(writes).toHaveBeenCalledTimes(1)
    })

    it('notifies and persists once per batch, imports nothing twice, and is silent on an empty batch', () => {
      const io = fakeIo()
      const h = new HistoryService(io, now)
      const writes = vi.spyOn(JsonStore.prototype, 'write')
      const kinds: string[] = []
      h.onChange((kind) => kinds.push(kind))
      const batch: ImportedVisit[] = [
        { url: 'https://a.test/', title: 'A', at: NOW - DAY },
        { url: 'https://b.test/', title: 'B', at: NOW - 2 * DAY },
        { url: 'https://c.test/', title: 'C', at: NOW - 3 * DAY }
      ]
      expect(h.importVisits(batch, { source: 'safari' })).toEqual({ imported: 3, skipped: 0 })
      expect(writes).toHaveBeenCalledTimes(1)
      expect(kinds).toEqual([])
      vi.advanceTimersByTime(600)
      expect(kinds).toEqual(['visit'])
      expect(h.importVisits(batch, { source: 'safari' })).toEqual({ imported: 0, skipped: 3 })
      expect(h.importVisits([], { source: 'safari' })).toEqual({ imported: 0, skipped: 0 })
      expect(writes).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(600)
      expect(kinds).toEqual(['visit'])
      // Stored visits count as duplicates after a reload too.
      h.flushSync()
      expect(storedVisits(io)).toHaveLength(3)
      const again = new HistoryService(io, now)
      expect(again.importVisits(batch, { source: 'safari' })).toEqual({ imported: 0, skipped: 3 })
      expect(again.count(0, Infinity)).toBe(3)
    })
  })

  describe('exportVisits (sync, W4-3)', () => {
    it('pages the visits since a time, oldest first, in the import shape, without writing', () => {
      const io = fakeIo()
      const h = new HistoryService(io, now)
      for (let i = 0; i < 7; i += 1)
        h.visit(
          `https://p${i}.test/`,
          i === 3 ? '' : `P${i}`,
          i === 1 ? 'https://p1.test/icon.png' : 'data:icon',
          {
            at: NOW - (7 - i) * DAY,
            transition: i === 2 ? 'typed' : 'link'
          }
        )
      h.flushSync()
      const writes = vi.spyOn(JsonStore.prototype, 'write')
      const first = h.exportVisits({ since: NOW - 6 * DAY, limit: 3 })
      expect(first.visits).toEqual([
        {
          url: 'https://p1.test/',
          title: 'P1',
          at: NOW - 6 * DAY,
          transition: 'link',
          favicon: 'https://p1.test/icon.png'
        },
        { url: 'https://p2.test/', title: 'P2', at: NOW - 5 * DAY, transition: 'typed' },
        // An untitled page carries no title (the store's URL stand-in is not one); a data: icon stays home.
        { url: 'https://p3.test/', at: NOW - 4 * DAY, transition: 'link' }
      ])
      expect(first.next).not.toBeNull()
      const second = h.exportVisits({ since: NOW - 6 * DAY, limit: 3, cursor: first.next })
      expect(second.visits.map((v) => v.url)).toEqual([
        'https://p4.test/',
        'https://p5.test/',
        'https://p6.test/'
      ])
      expect(second.next).toBeNull()
      // `until` bounds the page and ends the export.
      const bounded = h.exportVisits({ since: NOW - 6 * DAY, until: NOW - 4 * DAY, limit: 10 })
      expect(bounded.visits.map((v) => v.url)).toEqual(['https://p1.test/', 'https://p2.test/'])
      expect(bounded.next).toBeNull()
      expect(h.exportVisits({ since: NOW + DAY })).toEqual({ visits: [], next: null })
      expect(writes).not.toHaveBeenCalled()
      // One device's export is another's import unchanged.
      const other = new HistoryService(fakeIo(), now)
      expect(other.importVisits([...first.visits, ...second.visits], { source: 'sync' })).toEqual({
        imported: 6,
        skipped: 0
      })
      expect(other.recent(10).find((e) => e.url === 'https://p2.test/')?.typedCount).toBe(1)
    })

    it('resumes after the cursor key among same-time visits and survives a deletion in between', () => {
      const h = new HistoryService(fakeIo(), now)
      const at = NOW - DAY
      for (const u of ['a', 'b', 'c', 'd']) h.visit(`https://${u}.test/`, u, null, { at })
      h.visit('https://e.test/', 'e', null, { at: at + 1 })
      const page1 = h.exportVisits({ since: 0, limit: 2 })
      expect(page1.visits.map((v) => v.url)).toEqual(['https://a.test/', 'https://b.test/'])
      const page2 = h.exportVisits({ since: 0, limit: 2, cursor: page1.next })
      expect(page2.visits.map((v) => v.url)).toEqual(['https://c.test/', 'https://d.test/'])
      // The cursor's own visit is gone: the page starts at that time again (a repeat dedupes downstream).
      h.deleteUrls(['https://d.test/'])
      const page3 = h.exportVisits({ since: 0, limit: 5, cursor: page2.next })
      expect(page3.visits.map((v) => v.url)).toEqual([
        'https://a.test/',
        'https://b.test/',
        'https://c.test/',
        'https://e.test/'
      ])
      expect(page3.next).toBeNull()
      expect(h.exportVisits({ since: 0, cursor: 'garbage' }).visits).toHaveLength(4)
    })
  })

  describe('onVisits (sync, W4-3)', () => {
    it('reports additions with their payload, once per visit and once per import batch, beside onChange', () => {
      const h = new HistoryService(fakeIo(), now)
      const events: unknown[] = []
      const kinds: string[] = []
      h.onVisits((e) => events.push(e))
      h.onChange((k) => kinds.push(k))
      h.visit('https://a.test/', 'A', 'data:x', { transition: 'typed' })
      expect(events).toEqual([
        {
          type: 'added',
          visits: [{ url: 'https://a.test/', title: 'A', at: NOW, transition: 'typed' }]
        }
      ])
      h.visit('zen://settings', 'Settings', null)
      expect(events).toHaveLength(1)
      vi.spyOn(console, 'info').mockImplementation(() => undefined)
      h.importVisits(
        [
          { url: 'https://b.test/', title: 'B', at: NOW - DAY },
          { url: 'https://a.test/', at: NOW }, // duplicate by (url, at): not reported
          { url: 'https://c.test/', at: NOW - 2 * DAY, favicon: 'https://c.test/i.png' }
        ],
        { source: 'sync' }
      )
      expect(events).toHaveLength(2)
      expect(events[1]).toEqual({
        type: 'added',
        visits: [
          {
            url: 'https://c.test/',
            at: NOW - 2 * DAY,
            transition: 'link',
            favicon: 'https://c.test/i.png'
          },
          { url: 'https://b.test/', title: 'B', at: NOW - DAY, transition: 'link' }
        ]
      })
      // The payload-less channel is untouched: one throttled 'visit' for all of it.
      expect(kinds).toEqual([])
      vi.advanceTimersByTime(600)
      expect(kinds).toEqual(['visit'])
      vi.restoreAllMocks()
    })

    it('reports deletions as keys, ranges and clear; a range travels even when nothing matched here', () => {
      const h = new HistoryService(fakeIo(), now)
      h.visit('https://a.test/', 'A', null, { at: NOW - 3 * DAY })
      h.visit('https://b.test/', 'B', null, { at: NOW - 2 * DAY })
      h.visit('https://b.test/', 'B', null, { at: NOW - DAY })
      h.visit('https://c.test/', 'C', null, { at: NOW - 1000 })
      const events: unknown[] = []
      h.onVisits((e) => events.push(e))
      const id = h.visits({ host: 'a.test', limit: 1 })[0].id
      h.deleteVisits([id])
      h.deleteUrls(['https://b.test/'])
      expect(events).toEqual([
        { type: 'removed', keys: [{ url: 'https://a.test/', at: NOW - 3 * DAY }] },
        {
          type: 'removed',
          keys: [
            { url: 'https://b.test/', at: NOW - 2 * DAY },
            { url: 'https://b.test/', at: NOW - DAY }
          ]
        }
      ])
      expect(h.deleteRange(NOW - 10 * DAY, NOW - 9 * DAY)).toBe(0)
      expect(events[2]).toEqual({ type: 'range-removed', from: NOW - 10 * DAY, to: NOW - 9 * DAY })
      const day = dayKeyOf(NOW - 1000)
      h.deleteDay(day)
      const dayEvent = events[3] as { type: string; from: number; to: number }
      expect(dayEvent.type).toBe('range-removed')
      expect(dayEvent.from).toBeLessThanOrEqual(NOW - 1000)
      expect(dayEvent.to).toBeGreaterThan(NOW - 1000)
      expect(dayEvent.to - dayEvent.from).toBeGreaterThanOrEqual(23 * 3_600_000)
      expect(h.count(0, Infinity)).toBe(0)
      h.visit('https://d.test/', 'D', null)
      h.clear()
      expect(events.at(-1)).toEqual({ type: 'cleared' })
      // Nothing to delete: no keys event (the deletion changed nothing anywhere).
      h.deleteUrls(['https://never.test/'])
      expect(events).toHaveLength(6)
    })

    it('deleteByKeys removes by (url, at), recomputes the aggregate and reports the keys that went', () => {
      const h = new HistoryService(fakeIo(), now)
      h.visit('https://a.test/', 'A', null, { at: NOW - 2 * DAY, transition: 'typed' })
      h.visit('https://a.test/', 'A', null, { at: NOW - DAY })
      h.visit('https://b.test/', 'B', null, { at: NOW - DAY })
      const events: unknown[] = []
      h.onVisits((e) => events.push(e))
      expect(
        h.deleteByKeys([
          { url: 'https://a.test/', at: NOW - 2 * DAY },
          { url: 'https://a.test/', at: NOW - 5 * DAY }, // unknown: ignored
          { url: 'https://b.test/', at: NOW - DAY }
        ])
      ).toBe(2)
      expect(events).toEqual([
        {
          type: 'removed',
          keys: [
            { url: 'https://a.test/', at: NOW - 2 * DAY },
            { url: 'https://b.test/', at: NOW - DAY }
          ]
        }
      ])
      expect(h.recent(5)).toHaveLength(1)
      expect(h.recent(5)[0]).toMatchObject({ url: 'https://a.test/', visitCount: 1, typedCount: 0 })
      expect(h.deleteByKeys([{ url: 'https://a.test/', at: 0 }])).toBe(0)
      expect(events).toHaveLength(1)
    })
  })
})
