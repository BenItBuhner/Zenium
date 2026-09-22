import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SITE_DATA_POLICY,
  SITE_DATA_FILE,
  carriesCookie,
  cookieRequests,
  owedClear,
  owedClearOf,
  sessionClearsSince,
  withOwedClear
} from './site-data.mjs'

describe('owedClear', () => {
  it('is the marker readPendingClear takes back: types, patterns and when', () => {
    expect(owedClear({ types: ['cookies'], at: 1700000000000 })).toEqual({
      types: ['cookies'],
      patterns: [],
      at: 1700000000000
    })
    expect(
      owedClear({ types: ['cookies', 'cache'], patterns: ['[*.]shop.example'], at: 5 })
    ).toEqual({ types: ['cookies', 'cache'], patterns: ['[*.]shop.example'], at: 5 })
  })

  it('stamps the marker with the clock when no time is given, and copies its lists', () => {
    const types = ['cache']
    const marker = owedClear({ types }, () => 42)
    expect(marker).toEqual({ types: ['cache'], patterns: [], at: 42 })
    types.push('history')
    expect(marker.types).toEqual(['cache'])
  })

  it('refuses a marker that clears nothing', () => {
    expect(() => owedClear({ types: [] })).toThrow(/at least one type/)
    expect(() => owedClear({})).toThrow(/at least one type/)
  })
})

describe('withOwedClear', () => {
  const marker = { types: ['cookies'], patterns: [], at: 1 }

  it('writes the engine document around the marker for a profile without one', () => {
    expect(withOwedClear(null, marker)).toEqual({
      version: 1,
      policy: DEFAULT_SITE_DATA_POLICY,
      pendingClear: marker
    })
    expect(withOwedClear(undefined, marker).policy).toEqual(DEFAULT_SITE_DATA_POLICY)
  })

  it('keeps the policy of an existing document', () => {
    const policy = { blockAll: true, allow: ['bank.example'], clearOnExit: [], block: [] }
    expect(withOwedClear({ version: 1, policy, pendingClear: null }, marker)).toEqual({
      version: 1,
      policy,
      pendingClear: marker
    })
    // A document without a usable policy gets the default one.
    expect(withOwedClear({ version: 1, policy: 'broken' }, marker).policy).toEqual(
      DEFAULT_SITE_DATA_POLICY
    )
  })

  it('names the file the engine keeps', () => {
    expect(SITE_DATA_FILE).toBe('sitedata.json')
  })
})

describe('owedClearOf', () => {
  it('tells no document from a document owing nothing from a marker', () => {
    expect(owedClearOf(undefined)).toBeUndefined()
    expect(owedClearOf(null)).toBeUndefined()
    expect(owedClearOf({ version: 1, policy: DEFAULT_SITE_DATA_POLICY })).toBeNull()
    expect(
      owedClearOf({ version: 1, policy: DEFAULT_SITE_DATA_POLICY, pendingClear: null })
    ).toBeNull()
    const marker = { types: ['cookies'], patterns: [], at: 3 }
    expect(
      owedClearOf({ version: 1, policy: DEFAULT_SITE_DATA_POLICY, pendingClear: marker })
    ).toBe(marker)
  })

  it('reads anything that is not an object as owing nothing', () => {
    expect(owedClearOf({ pendingClear: 'soon' })).toBeNull()
    expect(owedClearOf({ pendingClear: 7 })).toBeNull()
    expect(owedClearOf('not a document')).toBeNull()
  })
})

describe('carriesCookie', () => {
  it('finds the cookie by name among the pairs of a Cookie header', () => {
    expect(carriesCookie('zenium_smoke=set-by-the-fixture', 'zenium_smoke')).toBe(true)
    expect(carriesCookie('other=1; zenium_smoke=v; third=x', 'zenium_smoke')).toBe(true)
    expect(carriesCookie('other=1', 'zenium_smoke')).toBe(false)
    // The name has to be the whole name.
    expect(carriesCookie('zenium_smoke_old=1', 'zenium_smoke')).toBe(false)
    expect(carriesCookie('smoke=1', 'zenium_smoke')).toBe(false)
  })

  it('is false without a header', () => {
    expect(carriesCookie(undefined, 'zenium_smoke')).toBe(false)
    expect(carriesCookie(null, 'zenium_smoke')).toBe(false)
    expect(carriesCookie('', 'zenium_smoke')).toBe(false)
  })
})

describe('cookieRequests', () => {
  const log = [
    { path: '/cookie-set.html', host: 'h', dest: 'document', cookie: undefined },
    { path: '/cookie.html', host: 'h', dest: 'document', cookie: 'zenium_smoke=v' },
    { path: '/favicon.ico', host: 'h', dest: 'image', cookie: 'zenium_smoke=v' },
    { path: '/cookie.html', host: 'h', dest: 'document', cookie: undefined },
    { path: '/cookie.html', host: 'h', dest: 'document', cookie: 'other=1' }
  ]

  it('counts the requests for the path and how many carried the cookie', () => {
    expect(cookieRequests(log, '/cookie.html', 'zenium_smoke')).toEqual({
      total: 3,
      withCookie: 1,
      withoutCookie: 2,
      cookies: ['zenium_smoke=v', null, 'other=1']
    })
  })

  it('starts from the watermark a launch took, and is empty past the end of the log', () => {
    expect(cookieRequests(log, '/cookie.html', 'zenium_smoke', 2)).toEqual({
      total: 2,
      withCookie: 0,
      withoutCookie: 2,
      cookies: [null, 'other=1']
    })
    expect(cookieRequests(log, '/cookie.html', 'zenium_smoke', 99)).toEqual({
      total: 0,
      withCookie: 0,
      withoutCookie: 0,
      cookies: []
    })
    expect(cookieRequests([], '/cookie.html', 'zenium_smoke').total).toBe(0)
  })
})

describe('sessionClearsSince', () => {
  const events = [
    {
      t: 30,
      type: 'session-clear',
      method: 'clearCache',
      storagePath: '/p/zen-default',
      ok: true,
      ms: 4
    },
    { t: 10, type: 'console', level: 'error', message: 'unrelated' },
    {
      t: 20,
      type: 'session-clear',
      method: 'clearStorageData',
      storagePath: '/p/zen-default',
      options: { storages: ['cookies'] },
      ok: true,
      ms: 12
    },
    { t: 5, type: 'session-clear', method: 'clearStorageData', storagePath: null, ok: true, ms: 1 },
    { t: 40, type: 'session-clear', method: 'clearCodeCaches', ok: false, error: 'refused', ms: 2 }
  ]

  it('keeps the engine clears from the time given on, oldest first, with their outcome', () => {
    expect(sessionClearsSince(events, 20)).toEqual([
      {
        t: 20,
        method: 'clearStorageData',
        storagePath: '/p/zen-default',
        options: { storages: ['cookies'] },
        ok: true,
        error: undefined,
        ms: 12
      },
      {
        t: 30,
        method: 'clearCache',
        storagePath: '/p/zen-default',
        options: undefined,
        ok: true,
        error: undefined,
        ms: 4
      },
      {
        t: 40,
        method: 'clearCodeCaches',
        storagePath: null,
        options: undefined,
        ok: false,
        error: 'refused',
        ms: 2
      }
    ])
  })

  it('takes every clear of a launch from 0, and none from an empty or missing log', () => {
    expect(sessionClearsSince(events).map((c) => c.t)).toEqual([5, 20, 30, 40])
    expect(sessionClearsSince(events, 41)).toEqual([])
    expect(sessionClearsSince([], 0)).toEqual([])
    expect(sessionClearsSince(undefined)).toEqual([])
  })
})
