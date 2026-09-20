import { describe, expect, it } from 'vitest'
import {
  matchField,
  mediaTabs,
  rankClosed,
  rankTabs,
  RECENTLY_CLOSED_LIMIT,
  scoreTab,
  searchHost
} from '../tabSearch'
import type { ClosedEntrySummary, TabSearchCandidate } from '../types'

function candidate(over: Partial<TabSearchCandidate> & { id: string }): TabSearchCandidate {
  return {
    title: over.id,
    url: `https://${over.id}.example/`,
    favicon: null,
    customIcon: null,
    containerId: 'default',
    windowLabel: null,
    active: false,
    audible: false,
    muted: false,
    loading: false,
    discarded: false,
    lastActiveAt: 0,
    ...over
  }
}

function closed(over: Partial<ClosedEntrySummary> & { id: string }): ClosedEntrySummary {
  return {
    kind: 'tab',
    title: over.id,
    url: `https://${over.id}.example/`,
    favicon: null,
    closedAt: 0,
    tabCount: 1,
    ...over
  }
}

describe('matchField', () => {
  it('matches nothing against an empty query, at score 0 with no ranges', () => {
    expect(matchField('GitHub', '')).toEqual({ score: 0, ranges: [] })
    expect(matchField('GitHub', '   ')).toEqual({ score: 0, ranges: [] })
  })

  it('finds a contiguous match case-insensitively and reports where', () => {
    expect(matchField('GitHub - Zenium', 'zen')).toEqual({
      score: expect.any(Number),
      ranges: [[9, 12]]
    })
  })

  it('ranks the start of the text over a word start over the middle of a word', () => {
    const start = matchField('news today', 'news')!.score
    const word = matchField('today news', 'news')!.score
    const inside = matchField('renewsletter', 'news')!.score
    expect(start).toBeGreaterThan(word)
    expect(word).toBeGreaterThan(inside)
  })

  it('prefers a word-start occurrence when the same text appears twice', () => {
    expect(matchField('renews the news', 'news')!.ranges).toEqual([[11, 15]])
  })

  it('matches scattered characters in order, below any contiguous match', () => {
    const scattered = matchField('GitHub', 'gh')
    expect(scattered).not.toBeNull()
    expect(scattered!.ranges).toEqual([
      [0, 1],
      [3, 4]
    ])
    expect(scattered!.score).toBeLessThan(matchField('gh pages', 'gh')!.score)
  })

  it('falls back to the plain left-to-right pass when reaching for word starts skips too far', () => {
    // "a" at a word start ("apple") would leave no "b" behind it; the plain pass matches "ab".
    expect(matchField('abc apple', 'ab')).not.toBeNull()
    expect(matchField('abc apple', 'ab')!.ranges).toEqual([[0, 2]])
  })

  it('returns null when a character of the query is missing', () => {
    expect(matchField('GitHub', 'gx')).toBeNull()
    expect(matchField('', 'a')).toBeNull()
  })

  it('never reads a scattered match as a contiguous one', () => {
    const scattered = matchField('a very long title with the letters spread far apart z', 'az')
    expect(scattered!.score).toBeLessThan(100)
    expect(matchField('az', 'az')!.score).toBeGreaterThanOrEqual(100)
  })
})

describe('searchHost', () => {
  it('shows the site without www, an internal page by its name, never a zen:// address', () => {
    expect(searchHost('https://www.github.com/BenItBuhner/Zenium')).toBe('github.com')
    expect(searchHost('zen://settings')).not.toMatch(/zen:\/\//)
    expect(searchHost('zen://settings')).toBe('Settings')
    expect(searchHost('')).toBe('')
  })
})

describe('scoreTab', () => {
  it('matches the title, the host and the address without its scheme', () => {
    const tab = {
      title: 'Pull requests · Zenium',
      url: 'https://github.com/BenItBuhner/Zenium/pulls'
    }
    expect(scoreTab(tab, 'pull')!.title).toEqual([[0, 4]])
    expect(scoreTab(tab, 'github')!.host).toEqual([[0, 6]])
    expect(scoreTab(tab, 'benitbuhner')).not.toBeNull()
    expect(scoreTab(tab, 'xyzzy')).toBeNull()
  })

  it('weights a title match over the same match in the host', () => {
    const inTitle = scoreTab({ title: 'example', url: 'https://other.test/' }, 'example')!.score
    const inHost = scoreTab({ title: 'other', url: 'https://example.test/' }, 'example')!.score
    expect(inTitle).toBeGreaterThan(inHost)
  })
})

describe('rankTabs', () => {
  const tabs = [
    candidate({ id: 'a', title: 'Alpha', lastActiveAt: 30, active: true }),
    candidate({ id: 'b', title: 'Beta', lastActiveAt: 20 }),
    candidate({ id: 'c', title: 'Gamma', lastActiveAt: 10 }),
    candidate({ id: 'd', title: 'Delta', lastActiveAt: 40, windowLabel: 'Other', active: true })
  ]

  it('lists most recently active first with the current tab last when nothing is typed', () => {
    expect(rankTabs(tabs, '').map((r) => r.tab.id)).toEqual(['d', 'b', 'c', 'a'])
    expect(rankTabs(tabs, '').every((r) => r.score === 0 && r.title.length === 0)).toBe(true)
  })

  it('keeps another window\u2019s active tab in its place: only this window\u2019s current tab goes last', () => {
    expect(rankTabs(tabs, '')[0].tab.id).toBe('d')
  })

  it('ranks matches best first and drops tabs that do not match', () => {
    const ranked = rankTabs(tabs, 'ta')
    // Beta and Delta match "ta" contiguously (word-inside); Alpha, Gamma do not contain "ta".
    expect(ranked.map((r) => r.tab.id).sort()).toEqual(['b', 'd'])
    expect(ranked.every((r) => r.score > 0)).toBe(true)
  })

  it('breaks a tie between equal matches by recency', () => {
    const tie = [
      candidate({ id: 'x', title: 'Same title', lastActiveAt: 1 }),
      candidate({ id: 'y', title: 'Same title', lastActiveAt: 2 })
    ]
    expect(rankTabs(tie, 'same').map((r) => r.tab.id)).toEqual(['y', 'x'])
  })

  it('finds a tab by its address when the title says nothing of it', () => {
    const list = [candidate({ id: 'docs', title: 'Home', url: 'https://docs.zenium.test/guide' })]
    expect(rankTabs(list, 'zenium')).toHaveLength(1)
    expect(rankTabs(list, 'guide')).toHaveLength(1)
  })
})

describe('rankClosed', () => {
  it('shows the newest few when nothing is typed, in the order given', () => {
    const entries = Array.from({ length: RECENTLY_CLOSED_LIMIT + 3 }, (_, i) =>
      closed({ id: `c${i}`, closedAt: 100 - i })
    )
    const ranked = rankClosed(entries, '')
    expect(ranked).toHaveLength(RECENTLY_CLOSED_LIMIT)
    expect(ranked[0].entry.id).toBe('c0')
  })

  it('filters by title or address with a query, and a window entry by its title', () => {
    const entries = [
      closed({ id: 'w', kind: 'window', title: 'Window with 3 tabs', url: null, tabCount: 3 }),
      closed({ id: 't', title: 'A page', url: 'https://zenium.test/' })
    ]
    expect(rankClosed(entries, 'window').map((r) => r.entry.id)).toEqual(['w'])
    expect(rankClosed(entries, 'zenium').map((r) => r.entry.id)).toEqual(['t'])
    expect(rankClosed(entries, 'nothing')).toEqual([])
  })
})

describe('mediaTabs', () => {
  it('keeps the tabs playing sound or muted', () => {
    const ranked = rankTabs(
      [
        candidate({ id: 'quiet' }),
        candidate({ id: 'loud', audible: true }),
        candidate({ id: 'shh', muted: true })
      ],
      ''
    )
    expect(
      mediaTabs(ranked)
        .map((r) => r.tab.id)
        .sort()
    ).toEqual(['loud', 'shh'])
  })
})
