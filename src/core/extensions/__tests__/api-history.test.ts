import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_RANGE_MS,
  ERROR_INVALID_PARAM,
  ERROR_INVALID_URL,
  ERROR_NO_PERMISSION,
  foldVisitsToItems,
  fromChromeTransition,
  historyItemFromVisit,
  historyItemId,
  normalizeAddUrl,
  normalizeHistoryRange,
  normalizeHistorySearch,
  normalizeUrlDetails,
  sameHistoryUrl,
  toChromeTransition,
  toHistoryItem,
  toVisitItem,
  visitsSince
} from '../api/history'
import { HistoryService } from '../../history'
import type { StoreIO } from '../../platform'
import type { HistoryEntry, HistoryVisit } from '../../../shared/types'
import { HistoryApi } from '../../../main/platform/extensionApi/history'
import type {
  ApiContext,
  ApiHost,
  LoadedExtension
} from '../../../main/platform/extensionApi/types'

const NOW = 1_700_000_000_000

const entry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
  url: 'https://a.example/',
  title: 'A',
  visitCount: 3,
  lastVisit: NOW,
  favicon: null,
  typedCount: 1,
  ...overrides
})

const visit = (overrides: Partial<HistoryVisit> = {}): HistoryVisit => ({
  id: 'v1',
  url: 'https://a.example/',
  title: 'A',
  favicon: null,
  visitTime: NOW,
  transition: 'link',
  ...overrides
})

describe('shapes', () => {
  it('maps aggregates to HistoryItems with a stable decimal id', () => {
    expect(toHistoryItem(entry())).toEqual({
      id: historyItemId('https://a.example/'),
      url: 'https://a.example/',
      title: 'A',
      lastVisitTime: NOW,
      visitCount: 3,
      typedCount: 1
    })
    expect(historyItemId('https://a.example/')).toMatch(/^\d+$/)
    expect(historyItemId('https://a.example/')).not.toBe(historyItemId('https://b.example/'))
    expect(toHistoryItem(entry({ typedCount: undefined })).typedCount).toBe(0)
    expect(historyItemFromVisit(visit({ transition: 'typed' }))).toMatchObject({
      visitCount: 1,
      typedCount: 1,
      lastVisitTime: NOW
    })
  })

  it('maps visits to VisitItems with Chrome transition names', () => {
    expect(toVisitItem(visit({ transition: 'restored' }))).toEqual({
      id: historyItemId('https://a.example/'),
      visitId: 'v1',
      visitTime: NOW,
      referringVisitId: '0',
      transition: 'reload',
      isLocal: true
    })
    expect(toChromeTransition('typed')).toBe('typed')
    expect(toChromeTransition('redirect')).toBe('link')
    expect(toChromeTransition('other')).toBe('link')
    expect(fromChromeTransition(undefined)).toBe('link')
    expect(fromChromeTransition('reload')).toBe('reload')
    expect(fromChromeTransition('auto_bookmark')).toBe('other')
  })
})

describe('arguments', () => {
  it('search defaults to the last day and 100 results', () => {
    expect(normalizeHistorySearch({ text: 'a' }, NOW)).toEqual({
      text: 'a',
      startTime: NOW - DEFAULT_SEARCH_RANGE_MS,
      endTime: null,
      maxResults: DEFAULT_MAX_RESULTS
    })
    expect(
      normalizeHistorySearch({ text: '', startTime: 5, endTime: 9, maxResults: 0 }, NOW)
    ).toEqual({ text: '', startTime: 5, endTime: 9, maxResults: 0 })
    expect(normalizeHistorySearch({}, NOW).text).toBe('')
    expect(() => normalizeHistorySearch({ text: 4 }, NOW)).toThrow(/'text'/)
    expect(() => normalizeHistorySearch({ maxResults: -1 }, NOW)).toThrow(/'maxResults'/)
    expect(() => normalizeHistorySearch({ startTime: 'x' }, NOW)).toThrow(/'startTime'/)
    expect(() => normalizeHistorySearch('a', NOW)).toThrow(ERROR_INVALID_PARAM)
  })

  it('validates and canonicalises URLs', () => {
    expect(normalizeUrlDetails({ url: 'HTTPS://A.example' })).toBe('https://a.example/')
    expect(() => normalizeUrlDetails({ url: 'nope' })).toThrow(ERROR_INVALID_URL)
    expect(() => normalizeUrlDetails({})).toThrow(ERROR_INVALID_URL)
    expect(sameHistoryUrl('https://a.example', 'https://a.example/')).toBe(true)
    expect(sameHistoryUrl('https://a.example/x', 'https://a.example/')).toBe(false)
    expect(sameHistoryUrl('junk', 'junk')).toBe(true)
  })

  it('addUrl takes a title and a Chrome transition, tolerating visitTime', () => {
    expect(normalizeAddUrl({ url: 'https://a.example/' })).toEqual({
      url: 'https://a.example/',
      title: '',
      transition: 'link'
    })
    expect(
      normalizeAddUrl({ url: 'https://a.example/', title: 'T', transition: 'typed', visitTime: 1 })
    ).toEqual({ url: 'https://a.example/', title: 'T', transition: 'typed' })
    expect(() => normalizeAddUrl({ url: 'https://a.example/', transition: 'warp' })).toThrow(
      /'transition'/
    )
    expect(() => normalizeAddUrl({ url: 'x' })).toThrow(ERROR_INVALID_URL)
  })

  it('deleteRange needs both bounds', () => {
    expect(normalizeHistoryRange({ startTime: 1, endTime: 2 })).toEqual({
      startTime: 1,
      endTime: 2
    })
    expect(() => normalizeHistoryRange({ startTime: 1 })).toThrow(ERROR_INVALID_PARAM)
    expect(() => normalizeHistoryRange({ startTime: 'a', endTime: 2 })).toThrow(/'startTime'/)
  })
})

describe('folding and the visit watermark', () => {
  it('folds newest-first visits to one item per URL, capped unless the cap is 0', () => {
    const entries = new Map([
      ['https://a.example/', entry()],
      ['https://b.example/', entry({ url: 'https://b.example/', title: 'B', visitCount: 1 })]
    ])
    const visits = [
      visit({ id: 'v3', url: 'https://b.example/', visitTime: NOW + 2 }),
      visit({ id: 'v2', visitTime: NOW + 1 }),
      visit({ id: 'v1', visitTime: NOW }),
      visit({ id: 'v0', url: 'https://gone.example/', visitTime: NOW - 1 })
    ]
    const items = foldVisitsToItems(visits, (url) => entries.get(url), 0)
    expect(items.map((i) => i.url)).toEqual([
      'https://b.example/',
      'https://a.example/',
      'https://gone.example/'
    ])
    expect(items[1]).toMatchObject({ visitCount: 3, lastVisitTime: NOW })
    expect(items[2]).toMatchObject({ visitCount: 1, title: 'A' })
    expect(foldVisitsToItems(visits, (url) => entries.get(url), 1)).toHaveLength(1)
  })

  it('reports visits newer than the watermark once, oldest first', () => {
    const since = [
      visit({ id: 'c', visitTime: NOW + 5 }),
      visit({ id: 'b', visitTime: NOW + 5 }),
      visit({ id: 'a', visitTime: NOW })
    ]
    const first = visitsSince(since, { time: NOW, ids: ['a'] })
    expect(first.fresh.map((v) => v.id)).toEqual(['c', 'b'])
    expect(first.watermark).toEqual({ time: NOW + 5, ids: ['c', 'b'] })
    const again = visitsSince(since.slice(0, 2), first.watermark)
    expect(again.fresh).toEqual([])
    expect(again.watermark).toBe(first.watermark)
    const more = visitsSince(
      [visit({ id: 'd', visitTime: NOW + 5 }), ...since.slice(0, 2)],
      first.watermark
    )
    expect(more.fresh.map((v) => v.id)).toEqual(['d'])
    expect([...more.watermark.ids].sort()).toEqual(['b', 'c', 'd'])
  })
})

function fakeIo(): StoreIO {
  const files: Record<string, string> = {}
  return {
    readSync: (name) => files[name] ?? null,
    write: async (name, text) => {
      files[name] = text
    },
    writeSync: (name, text) => {
      files[name] = text
    }
  }
}

interface Delivery {
  extensionId: string
  event: string
  args: unknown[]
}

function harness(
  grants: Record<string, string[]>,
  now: () => number
): { api: HistoryApi; service: HistoryService; ctx: (id: string) => ApiContext; out: Delivery[] } {
  const service = new HistoryService(fakeIo(), now)
  const out: Delivery[] = []
  const loaded = new Map<string, LoadedExtension>()
  for (const id of Object.keys(grants)) {
    loaded.set(id, { id, sessions: [] } as unknown as LoadedExtension)
  }
  const host = {
    browser: { history: service },
    allLoaded: () => [...loaded.values()],
    grants: (id: string) => ({ permissions: grants[id] ?? [], origins: [] }),
    broadcast(
      namespace: string,
      event: string,
      argsFor: (ext: LoadedExtension) => unknown[] | null
    ): void {
      for (const ext of loaded.values()) {
        const args = argsFor(ext)
        if (args) out.push({ extensionId: ext.id, event: `${namespace}.${event}`, args })
      }
    },
    scheduleTick(): void {
      /* nothing to defer */
    }
  }
  const api = new HistoryApi(host as unknown as ApiHost)
  const ctx = (id: string): ApiContext =>
    ({ extensionId: id, extension: loaded.get(id) }) as unknown as ApiContext
  return { api, service, ctx, out }
}

describe('HistoryApi over the history service', () => {
  let clock = NOW
  const now = (): number => clock

  beforeEach(() => {
    clock = NOW
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('requires the history permission', () => {
    const h = harness({ ext: [] }, now)
    expect(() => h.api.handlers.deleteAll(h.ctx('ext'))).toThrow(ERROR_NO_PERMISSION)
  })

  it('searches the last day by default, one item per URL, newest first', () => {
    const h = harness({ ext: ['history'] }, now)
    const ctx = h.ctx('ext')
    clock = NOW - 3 * 86_400_000
    h.service.visit('https://old.example/', 'Old', null)
    clock = NOW - 1000
    h.service.visit('https://a.example/', 'Alpha', null, { transition: 'typed' })
    clock = NOW - 500
    h.service.visit('https://b.example/', 'Beta', null)
    clock = NOW
    h.service.visit('https://a.example/', 'Alpha', null)
    const items = h.api.handlers.search(ctx, { text: '' }) as Array<Record<string, unknown>>
    expect(items.map((i) => i.url)).toEqual(['https://a.example/', 'https://b.example/'])
    expect(items[0]).toMatchObject({
      title: 'Alpha',
      visitCount: 2,
      typedCount: 1,
      lastVisitTime: NOW
    })
    const all = h.api.handlers.search(ctx, { text: '', startTime: 0 }) as Array<{ url: string }>
    expect(all.map((i) => i.url)).toEqual([
      'https://a.example/',
      'https://b.example/',
      'https://old.example/'
    ])
    expect(h.api.handlers.search(ctx, { text: 'beta', startTime: 0 })).toMatchObject([
      { url: 'https://b.example/' }
    ])
    expect(h.api.handlers.search(ctx, { text: '', startTime: 0, maxResults: 1 })).toHaveLength(1)
    expect(
      h.api.handlers.search(ctx, { text: '', startTime: 0, endTime: NOW - 600 })
    ).toMatchObject([{ url: 'https://a.example/' }, { url: 'https://old.example/' }])
  })

  it('lists a URL\u2019s visits oldest first and adds visits with the mapped transition', () => {
    const h = harness({ ext: ['history'] }, now)
    const ctx = h.ctx('ext')
    h.service.visit('https://a.example/', 'A', null, { transition: 'typed' })
    clock += 10
    h.service.visit('https://a.example/', 'A', null, { transition: 'reload' })
    h.api.handlers.addUrl(ctx, { url: 'https://a.example', transition: 'auto_bookmark' })
    const visits = h.api.handlers.getVisits(ctx, { url: 'https://a.example' }) as Array<
      Record<string, unknown>
    >
    expect(visits.map((v) => v.transition)).toEqual(['typed', 'reload', 'link'])
    expect(visits[0]).toMatchObject({ referringVisitId: '0', isLocal: true, visitTime: NOW })
    expect(h.api.handlers.getVisits(ctx, { url: 'https://none.example/' })).toEqual([])
    expect(() => h.api.handlers.getVisits(ctx, { url: 'nope' })).toThrow(ERROR_INVALID_URL)
  })

  it('deletes by URL, range and everything, firing onVisitRemoved for holders', () => {
    const h = harness({ ext: ['history'], other: [] }, now)
    const ctx = h.ctx('ext')
    h.api.attach()
    h.service.visit('https://a.example/', 'A', null)
    clock += 10
    h.service.visit('https://b.example/', 'B', null)
    clock += 10
    h.service.visit('https://c.example/', 'C', null)
    vi.advanceTimersByTime(600)
    h.out.length = 0

    h.api.handlers.deleteUrl(ctx, { url: 'https://a.example' })
    expect(h.out).toEqual([
      {
        extensionId: 'ext',
        event: 'history.onVisitRemoved',
        args: [{ allHistory: false, urls: ['https://a.example/'] }]
      }
    ])
    h.out.length = 0
    h.api.handlers.deleteRange(ctx, { startTime: NOW + 5, endTime: NOW + 15 })
    expect(h.out).toEqual([
      {
        extensionId: 'ext',
        event: 'history.onVisitRemoved',
        args: [{ allHistory: false, urls: ['https://b.example/'] }]
      }
    ])
    h.out.length = 0
    h.api.handlers.deleteAll(ctx)
    expect(h.out).toEqual([
      {
        extensionId: 'ext',
        event: 'history.onVisitRemoved',
        args: [{ allHistory: true, urls: [] }]
      }
    ])
    expect(h.service.count(0, Infinity)).toBe(0)
  })

  it('fires onVisited for visits after attach, once each, with the aggregate', () => {
    const h = harness({ ext: ['history'] }, now)
    h.service.visit('https://before.example/', 'Before', null)
    vi.advanceTimersByTime(600)
    h.api.attach()
    clock += 100
    h.service.visit('https://a.example/', 'A', null)
    clock += 100
    h.service.visit('https://a.example/', 'A', null, { transition: 'typed' })
    vi.advanceTimersByTime(600)
    expect(h.out.map((d) => d.event)).toEqual(['history.onVisited', 'history.onVisited'])
    expect(h.out[1].args[0]).toMatchObject({
      url: 'https://a.example/',
      visitCount: 2,
      typedCount: 1,
      lastVisitTime: NOW + 200
    })
    h.service.updateTitle('https://a.example/', 'Renamed')
    vi.advanceTimersByTime(600)
    expect(h.out).toHaveLength(2)
  })
})
