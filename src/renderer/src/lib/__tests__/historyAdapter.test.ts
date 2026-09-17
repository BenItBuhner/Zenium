import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '@shared/types'
import {
  isTopSiteCandidate,
  isUnknownCommandError,
  parseTopSites,
  rankTopSites,
  scoreFrecency,
  topSiteHost
} from '../historyAdapter'

const DAY = 24 * 60 * 60 * 1000
const now = 1_800_000_000_000

const entry = (
  url: string,
  visitCount: number,
  daysAgo: number,
  extra: Partial<HistoryEntry> = {}
): HistoryEntry => ({
  url,
  title: extra.title ?? url,
  visitCount,
  lastVisit: now - daysAgo * DAY,
  favicon: extra.favicon ?? null,
  ...extra
})

describe('scoreFrecency', () => {
  it('weights the visit count by how recently the site was last seen', () => {
    expect(scoreFrecency({ visitCount: 3, lastVisit: now }, now)).toBe(300)
    expect(scoreFrecency({ visitCount: 3, lastVisit: now - 10 * DAY }, now)).toBe(210)
    expect(scoreFrecency({ visitCount: 3, lastVisit: now - 20 * DAY }, now)).toBe(150)
    expect(scoreFrecency({ visitCount: 3, lastVisit: now - 60 * DAY }, now)).toBe(90)
    expect(scoreFrecency({ visitCount: 3, lastVisit: now - 365 * DAY }, now)).toBe(30)
  })

  it('counts a visit even when the aggregate says none, and ignores clock skew', () => {
    expect(scoreFrecency({ visitCount: 0, lastVisit: now }, now)).toBe(100)
    expect(scoreFrecency({ visitCount: 1, lastVisit: now + DAY }, now)).toBe(100)
  })
})

describe('candidates', () => {
  it('only web pages make a tile', () => {
    expect(isTopSiteCandidate('https://example.com/')).toBe(true)
    expect(isTopSiteCandidate('http://example.com')).toBe(true)
    expect(isTopSiteCandidate('zen://blank')).toBe(false)
    expect(isTopSiteCandidate('zen://error?url=https%3A%2F%2Fx.example')).toBe(false)
    expect(isTopSiteCandidate('about:blank')).toBe(false)
    expect(isTopSiteCandidate('view-source:https://example.com')).toBe(false)
    expect(isTopSiteCandidate('data:text/html,hi')).toBe(false)
    expect(isTopSiteCandidate('file:///tmp/a.html')).toBe(false)
    expect(isTopSiteCandidate('https://')).toBe(false)
  })

  it('a tile stands for a host, without www.', () => {
    expect(topSiteHost('https://www.Example.com/path')).toBe('example.com')
    expect(topSiteHost('https://news.example.com/')).toBe('news.example.com')
  })
})

describe('rankTopSites', () => {
  it('recent visits outrank many old ones', () => {
    const out = rankTopSites(
      [entry('https://old.example/', 20, 100), entry('https://fresh.example/', 5, 0)],
      { now, n: 8 }
    )
    expect(out.map((s) => s.url)).toEqual(['https://fresh.example/', 'https://old.example/'])
    expect(out[0].score).toBe(500)
    expect(out[1].score).toBe(200)
  })

  it('dedupes by host: one tile per site, its pages summed, its best page in front', () => {
    const out = rankTopSites(
      [
        entry('https://www.example.com/deep/page', 4, 0, { title: 'Deep' }),
        entry('https://example.com/', 4, 0, { title: 'Home', favicon: 'data:x' }),
        entry('https://example.com/other', 1, 0),
        entry('https://b.example/', 6, 0)
      ],
      { now, n: 8 }
    )
    expect(out).toHaveLength(2)
    // 400 + 400 + 100 for example.com against 600 for b.example.
    expect(out[0]).toMatchObject({ url: 'https://example.com/', title: 'Home', favicon: 'data:x' })
    expect(out[0].score).toBe(900)
    expect(out[1].url).toBe('https://b.example/')
  })

  it('leaves out internal pages, junk and the hosts the user removed', () => {
    const out = rankTopSites(
      [
        entry('zen://blank', 50, 0),
        entry('zen://error?url=x', 50, 0),
        entry('about:blank', 50, 0),
        entry('https://gone.example/', 50, 0),
        { url: 42 } as unknown as HistoryEntry,
        null as unknown as HistoryEntry,
        entry('https://kept.example/', 1, 0)
      ],
      { now, n: 8, excludedHosts: ['Gone.example'] }
    )
    expect(out.map((s) => s.url)).toEqual(['https://kept.example/'])
  })

  it('caps the list and orders ties by the latest visit', () => {
    const entries = Array.from({ length: 12 }, (_, i) => entry(`https://s${i}.example/`, 12 - i, 0))
    const out = rankTopSites(entries, { now, n: 8 })
    expect(out).toHaveLength(8)
    expect(out[0].url).toBe('https://s0.example/')
    expect(out[7].url).toBe('https://s7.example/')

    const tie = rankTopSites(
      [entry('https://older.example/', 2, 2), entry('https://newer.example/', 2, 1)],
      { now, n: 8 }
    )
    expect(tie.map((s) => s.url)).toEqual(['https://newer.example/', 'https://older.example/'])
    expect(rankTopSites(entries, { now, n: 0 })).toEqual([])
    expect(rankTopSites([], { now, n: 8 })).toEqual([])
  })
})

describe('the history.topSites contract', () => {
  it('accepts the contract shape and nothing else', () => {
    const site = { url: 'https://a.example/', title: 'A', favicon: null, score: 12 }
    expect(parseTopSites([site, { ...site, favicon: 'data:image/png;base64,' }])).toHaveLength(2)
    expect(parseTopSites([])).toEqual([])
    expect(parseTopSites(null)).toBeNull()
    expect(parseTopSites({ page: [site] })).toBeNull()
    expect(parseTopSites([{ url: 'https://a.example/', title: 'A' }])).toBeNull()
    expect(parseTopSites([{ ...site, score: '12' }])).toBeNull()
  })

  it('tells a core without the command from a command that failed', () => {
    expect(
      isUnknownCommandError(new Error('Unknown command: history.topSites'), 'history.topSites')
    ).toBe(true)
    expect(isUnknownCommandError('Unknown command: history.topSites', 'history.topSites')).toBe(
      true
    )
    expect(isUnknownCommandError(new Error('Unknown command: other'), 'history.topSites')).toBe(
      false
    )
    expect(
      isUnknownCommandError(new Error('history.topSites: store closed'), 'history.topSites')
    ).toBe(false)
  })
})
