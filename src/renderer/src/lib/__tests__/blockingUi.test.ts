import { describe, expect, it } from 'vitest'
import type { BlockedSite, Tab } from '@shared/types'
import {
  DEFAULT_BLOCKING_SETTINGS,
  emptyBlockingStatus,
  type BlockingStatus,
  type FilterListStatus
} from '@shared/blocking'
import {
  blockedChipLabel,
  blockedSiteCategoryLabel,
  chipCount,
  exceptionHost,
  listDetail,
  listOverrides,
  requests,
  siteBlockingState,
  statusCardText,
  TRACKER_REPORT_EMPTY,
  TRACKER_REPORT_SETTINGS,
  TRACKER_REPORT_TITLE,
  trackerReportChipLabel,
  trackerReportOrder,
  trackerReportRows
} from '../blockingUi'

function tab(url: string, blockedCount = 0): Tab {
  return { url, blockedCount } as unknown as Tab
}

function list(over: Partial<FilterListStatus>): FilterListStatus {
  return {
    id: 'easylist',
    name: 'EasyList',
    description: 'Ads.',
    url: 'https://example.com/easylist.txt',
    homepage: 'https://example.com',
    licence: 'GPL-3.0',
    tier: 'balanced',
    enabled: true,
    version: null,
    updatedAt: null,
    filterCount: 0,
    bundled: false,
    updating: false,
    lastError: null,
    ...over
  }
}

const ago = (): string => '2 h ago'

describe('siteBlockingState', () => {
  const status = { enabled: true, siteExceptions: ['https://news.example'] }
  const level = { level: 'balanced' as const }

  it('has no site for zen:// pages and empty tabs', () => {
    expect(siteBlockingState(null, status, level)).toBe('no-site')
    expect(siteBlockingState(tab('zen://blank'), status, level)).toBe('no-site')
  })

  it('is off when the master switch or the level is off', () => {
    expect(siteBlockingState(tab('https://a.example/'), { ...status, enabled: false }, level)).toBe(
      'off'
    )
    expect(siteBlockingState(tab('https://a.example/'), status, { level: 'off' })).toBe('off')
  })

  it('tells excepted origins from blocked ones by the stored origin', () => {
    expect(siteBlockingState(tab('https://news.example/story'), status, level)).toBe('excepted')
    expect(siteBlockingState(tab('https://www.news.example/'), status, level)).toBe('blocking')
    expect(siteBlockingState(tab('http://news.example/'), status, level)).toBe('blocking')
  })
})

describe('the chip', () => {
  it('says what was blocked, or why nothing is', () => {
    expect(blockedChipLabel('blocking', 0)).toBe(
      'Nothing blocked on this page yet · Site information'
    )
    expect(blockedChipLabel('blocking', 1)).toBe(
      '1 request blocked on this page · Site information'
    )
    expect(blockedChipLabel('blocking', 1234)).toBe(
      '1,234 requests blocked on this page · Site information'
    )
    expect(blockedChipLabel('excepted', 5)).toBe('Blocking is off for this site · Site information')
    expect(blockedChipLabel('off', 5)).toBe('Ad and tracker blocking is off · Site information')
  })

  it('keeps the count to a few characters', () => {
    expect(chipCount(0)).toBe('0')
    expect(chipCount(999)).toBe('999')
    expect(chipCount(1000)).toBe('1k')
    expect(chipCount(1480)).toBe('1.5k')
    expect(chipCount(2040)).toBe('2k')
    expect(chipCount(12_345)).toBe('12k')
  })

  it('pluralises requests', () => {
    expect(requests(1)).toBe('1 request')
    expect(requests(0)).toBe('0 requests')
    expect(requests(2500)).toBe('2,500 requests')
  })
})

describe('the tracker report', () => {
  const site = (domain: string, count: number, category: BlockedSite['category'] = 'tracker') => ({
    domain,
    category,
    count
  })

  it('carries the lead words as they were passed', () => {
    expect(TRACKER_REPORT_TITLE).toBe('Trackers blocked')
    expect(TRACKER_REPORT_EMPTY).toBe('No trackers blocked on this page')
    expect(TRACKER_REPORT_SETTINGS).toBe('Tracking prevention settings…')
  })

  it('names the count pill after the count and the list it opens', () => {
    expect(trackerReportChipLabel(1)).toBe('1 request blocked on this page · Trackers blocked')
    expect(trackerReportChipLabel(1234)).toBe(
      '1,234 requests blocked on this page · Trackers blocked'
    )
  })

  it('names the kind of rule that blocked a site on the 13 line', () => {
    expect(blockedSiteCategoryLabel('tracker')).toBe('Tracker')
    expect(blockedSiteCategoryLabel('user')).toBe('Your filter')
    expect(blockedSiteCategoryLabel('extension')).toBe('Extension')
    expect(blockedSiteCategoryLabel('unsafe')).toBe('Unsafe site')
  })

  it('sorts by count when the list opens, ties in first-seen order', () => {
    const sites = [site('a.example', 1), site('b.example', 3), site('c.example', 3)]
    expect(trackerReportOrder([], sites)).toEqual(['b.example', 'c.example', 'a.example'])
  })

  it('never re-sorts an open list and appends what the engine meets later', () => {
    const order = trackerReportOrder([], [site('a.example', 1), site('b.example', 3)])
    const grown = [site('a.example', 9), site('b.example', 3), site('c.example', 5)]
    expect(trackerReportOrder(order, grown)).toEqual(['b.example', 'a.example', 'c.example'])
    // Nothing new: the very same array comes back, so nothing re-renders for it.
    expect(trackerReportOrder(order, [site('a.example', 2), site('b.example', 3)])).toBe(order)
  })

  it('starts over when the report empties under it', () => {
    const order = ['b.example', 'a.example']
    expect(trackerReportOrder(order, undefined)).toEqual([])
    expect(trackerReportOrder(order, [])).toEqual([])
    const empty: readonly string[] = []
    expect(trackerReportOrder(empty, undefined)).toBe(empty)
  })

  it('reads the rows in the held order with their live counts', () => {
    const order = ['b.example', 'a.example', 'gone.example']
    const rows = trackerReportRows(order, [site('a.example', 4, 'user'), site('b.example', 3)])
    expect(rows).toEqual([site('b.example', 3), site('a.example', 4, 'user')])
    expect(trackerReportRows(order, undefined)).toEqual([])
  })
})

describe('statusCardText', () => {
  const ready: BlockingStatus = {
    ...emptyBlockingStatus(),
    ready: true,
    sessionBlocked: 42,
    lists: [
      list({ filterCount: 1000, bundled: true }),
      list({ id: 'easyprivacy', name: 'EasyPrivacy', filterCount: 500, bundled: true }),
      list({ id: 'ubo-privacy', enabled: false, filterCount: 9999 })
    ]
  }

  it('explains an off master switch and an Off level differently', () => {
    expect(statusCardText({ ...ready, enabled: false }, false, null, ago)).toEqual({
      headline: 'Ad and tracker blocking is off',
      detail: 'Turn on "Block ads and trackers" to block with the filter lists.'
    })
    expect(statusCardText(ready, false, null, ago).detail).toMatch(/^The level is Off/)
  })

  it('waits for the lists before counting', () => {
    expect(statusCardText({ ...ready, ready: false }, true, null, ago).headline).toBe(
      'Loading the filter lists…'
    )
  })

  it('counts only the enabled lists and names the bundled snapshot', () => {
    expect(statusCardText(ready, true, null, ago)).toEqual({
      headline: '42 requests blocked since Zenium started',
      detail: '2 lists, 1,500 filters · Using the lists bundled with this build'
    })
  })

  it('prefers the refresh time and adds the page', () => {
    const text = statusCardText(
      { ...ready, lastUpdatedAt: 1 },
      true,
      { blocked: 3, site: 'news.example' },
      ago
    )
    expect(text.detail).toBe('2 lists, 1,500 filters · Lists updated 2 h ago · 3 on news.example')
    expect(statusCardText({ ...ready, updating: true }, true, null, ago).detail).toContain(
      'Updating lists…'
    )
  })

  it('keeps the refresh time in sentence case inside its sentence', () => {
    const justNow = (): string => 'Just now'
    expect(statusCardText({ ...ready, lastUpdatedAt: 1 }, true, null, justNow).detail).toBe(
      '2 lists, 1,500 filters · Lists updated just now'
    )
    expect(listDetail(list({ updatedAt: 5 }), justNow)).toBe('Ads. · Updated just now')
  })
})

describe('listDetail', () => {
  it('reads description, size and freshness in that order', () => {
    expect(listDetail(list({ filterCount: 12, updatedAt: 5 }), ago)).toBe(
      'Ads. · 12 filters · Updated 2 h ago'
    )
    expect(listDetail(list({ bundled: true }), ago)).toBe('Ads. · Bundled with this build')
    expect(listDetail(list({ updating: true, bundled: true }), ago)).toBe('Ads. · Updating…')
    expect(listDetail(list({ lastError: 'HTTP 404', updating: true }), ago)).toBe(
      'Ads. · Update failed: HTTP 404'
    )
  })

  it('leaves the blurb out where a narrow row has no room for it', () => {
    expect(listDetail(list({ filterCount: 12, updatedAt: 5 }), ago, { blurb: false })).toBe(
      '12 filters · Updated 2 h ago'
    )
    expect(listDetail(list({}), ago, { blurb: false })).toBe('')
  })
})

describe('listOverrides', () => {
  it('stores only what differs from the level', () => {
    const s = { ...DEFAULT_BLOCKING_SETTINGS, level: 'balanced' as const }
    expect(listOverrides(s, 'easylist', false)).toEqual({ easylist: false })
    expect(listOverrides(s, 'ubo-privacy', true)).toEqual({ 'ubo-privacy': true })
    expect(listOverrides({ ...s, lists: { easylist: false } }, 'easylist', true)).toEqual({})
    expect(listOverrides(s, 'custom-1', true)).toEqual({ 'custom-1': true })
  })
})

describe('exceptionHost', () => {
  it('drops https and keeps anything else visible', () => {
    expect(exceptionHost('https://news.example')).toBe('news.example')
    expect(exceptionHost('https://localhost:3000')).toBe('localhost:3000')
    expect(exceptionHost('http://intranet.example')).toBe('http://intranet.example')
    expect(exceptionHost('not a url')).toBe('not a url')
  })
})
