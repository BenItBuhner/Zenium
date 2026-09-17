import { describe, expect, it } from 'vitest'
import {
  compileMatchPattern,
  globToRegExp,
  matchesAnyPattern,
  patternContains
} from '../api/matchPattern'
import {
  detectTabMoves,
  tabChangeInfo,
  tabMatchesQuery,
  WINDOW_ID_CURRENT,
  type ChromeTab,
  type TabQueryContext
} from '../api/tabs'
import {
  applyClear,
  applyRemove,
  applySet,
  bytesInUse,
  diffItems,
  selectItems,
  SYNC_QUOTA
} from '../api/storage'
import { msUntilNext, rescheduleAlarm, scheduleAlarm, splitDue } from '../api/alarms'
import {
  manifestPermissionSets,
  missingPermissions,
  normalizePermissionSet,
  permissionSetContains,
  removePermissionSet,
  requestablePermissions
} from '../api/permissions'
import type { ExtensionManifest } from '../manifest'

describe('match patterns', () => {
  it('matches Chrome match pattern forms', () => {
    expect(compileMatchPattern('<all_urls>')!.test('https://a.b/c')).toBe(true)
    expect(compileMatchPattern('<all_urls>')!.test('chrome-extension://x/y')).toBe(false)
    expect(compileMatchPattern('*://*.example.com/*')!.test('https://www.example.com/x?y')).toBe(
      true
    )
    expect(compileMatchPattern('*://*.example.com/*')!.test('https://example.com/')).toBe(true)
    expect(compileMatchPattern('*://*.example.com/*')!.test('https://notexample.com/')).toBe(false)
    expect(compileMatchPattern('*://*.example.com/*')!.test('ftp://example.com/')).toBe(false)
    expect(compileMatchPattern('https://*/foo*')!.test('https://x.y/foobar')).toBe(true)
    expect(compileMatchPattern('https://*/foo*')!.test('https://x.y/bar')).toBe(false)
    expect(compileMatchPattern('file:///*')!.test('file:///tmp/a.html')).toBe(true)
    expect(compileMatchPattern('http://127.0.0.1/*')!.test('http://127.0.0.1/x')).toBe(true)
    expect(compileMatchPattern('http://localhost:8080/*')!.test('http://localhost:8080/a')).toBe(
      true
    )
  })

  it('rejects malformed patterns', () => {
    expect(compileMatchPattern('example.com')).toBeNull()
    expect(compileMatchPattern('https://*foo/*')).toBeNull()
    expect(compileMatchPattern('https://example.com')).toBeNull()
    expect(compileMatchPattern('')).toBeNull()
  })

  it('answers matchesAnyPattern and patternContains', () => {
    expect(matchesAnyPattern('https://a.com/x', ['*://b.com/*', 'https://a.com/*'])).toBe(true)
    expect(matchesAnyPattern('https://a.com/x', 'https://b.com/*')).toBe(false)
    expect(patternContains('<all_urls>', 'https://a.com/*')).toBe(true)
    expect(patternContains('*://*.a.com/*', 'https://sub.a.com/*')).toBe(true)
    expect(patternContains('https://a.com/*', '*://a.com/*')).toBe(false)
    expect(patternContains('https://a.com/*', 'https://a.com/*')).toBe(true)
  })

  it('turns Chrome title globs into regular expressions', () => {
    expect(globToRegExp('*GitHub*').test('Pull request - GitHub')).toBe(true)
    expect(globToRegExp('Exact').test('Exactly')).toBe(false)
    expect(globToRegExp('a.b?').test('a.bc')).toBe(true)
    expect(globToRegExp('a.b?').test('axbc')).toBe(false)
  })
})

function tab(overrides: Partial<ChromeTab> = {}): ChromeTab {
  return {
    id: 1,
    index: 0,
    windowId: 10,
    active: false,
    highlighted: false,
    selected: false,
    pinned: false,
    url: 'https://example.com/',
    title: 'Example',
    status: 'complete',
    audible: false,
    mutedInfo: { muted: false },
    discarded: false,
    frozen: false,
    autoDiscardable: true,
    incognito: false,
    groupId: -1,
    ...overrides
  }
}

const ctx: TabQueryContext = {
  currentWindowId: 10,
  lastFocusedWindowId: 11,
  windowTypeOf: () => 'normal'
}

describe('tabs.query matching', () => {
  it('applies boolean filters, window selectors and patterns', () => {
    const t = tab({ active: true, pinned: true, audible: true })
    expect(tabMatchesQuery(t, {}, ctx)).toBe(true)
    expect(tabMatchesQuery(t, { active: true, pinned: true }, ctx)).toBe(true)
    expect(tabMatchesQuery(t, { active: false }, ctx)).toBe(false)
    expect(tabMatchesQuery(t, { currentWindow: true }, ctx)).toBe(true)
    expect(tabMatchesQuery(t, { lastFocusedWindow: true }, ctx)).toBe(false)
    expect(tabMatchesQuery(t, { windowId: WINDOW_ID_CURRENT }, ctx)).toBe(true)
    expect(tabMatchesQuery(t, { windowId: 11 }, ctx)).toBe(false)
    expect(tabMatchesQuery(t, { url: '*://example.com/*' }, ctx)).toBe(true)
    expect(tabMatchesQuery(t, { url: ['*://other.com/*', '<all_urls>'] }, ctx)).toBe(true)
    expect(tabMatchesQuery(t, { url: 'https://other.com/*' }, ctx)).toBe(false)
    expect(tabMatchesQuery(t, { title: 'Exam*' }, ctx)).toBe(true)
    expect(tabMatchesQuery(t, { status: 'loading' }, ctx)).toBe(false)
    expect(tabMatchesQuery(t, { muted: false, audible: true, index: 0 }, ctx)).toBe(true)
    expect(tabMatchesQuery(t, { windowType: 'popup' }, ctx)).toBe(false)
    expect(tabMatchesQuery(t, { discarded: false, groupId: -1 }, ctx)).toBe(true)
  })
})

describe('tabs.onUpdated changeInfo', () => {
  it('reports only the properties Chrome reports, when they changed', () => {
    const before = tab({ status: 'loading', url: 'https://a/', title: 'A' })
    expect(tabChangeInfo(before, { ...before })).toBeNull()
    expect(
      tabChangeInfo(
        before,
        tab({ status: 'complete', url: 'https://b/', title: 'B', pinned: true })
      )
    ).toEqual({ status: 'complete', url: 'https://b/', title: 'B', pinned: true })
    expect(
      tabChangeInfo(before, { ...before, mutedInfo: { muted: true, reason: 'user' } })
    ).toEqual({
      mutedInfo: { muted: true, reason: 'user' }
    })
    expect(tabChangeInfo(before, { ...before, favIconUrl: 'data:x' })).toEqual({
      favIconUrl: 'data:x'
    })
    expect(tabChangeInfo(before, { ...before, discarded: true, audible: true })).toEqual({
      discarded: true,
      audible: true
    })
    // Index and activity changes are other events, not onUpdated.
    expect(tabChangeInfo(before, { ...before, index: 4, active: true })).toBeNull()
  })
})

describe('detectTabMoves', () => {
  it('reports the dragged tab only when one move explains the reorder', () => {
    expect(detectTabMoves([1, 2, 3, 4], [2, 3, 1, 4])).toEqual([
      { tabId: 1, fromIndex: 0, toIndex: 2 }
    ])
    expect(detectTabMoves([1, 2, 3, 4], [1, 4, 2, 3])).toEqual([
      { tabId: 4, fromIndex: 3, toIndex: 1 }
    ])
    expect(detectTabMoves([1, 2, 3], [1, 2, 3])).toEqual([])
    // Different tab sets are creations/removals, never moves.
    expect(detectTabMoves([1, 2, 3], [1, 2, 4])).toEqual([])
    expect(detectTabMoves([1, 2, 3], [1, 2])).toEqual([])
    // A shuffle nobody can explain with one move reports every displaced tab.
    expect(detectTabMoves([1, 2, 3, 4], [2, 1, 4, 3])).toHaveLength(4)
  })
})

describe('storage semantics', () => {
  it('counts bytes like Chrome and enforces sync quotas', () => {
    expect(bytesInUse({ a: 'xy' })).toBe(1 + 4)
    expect(bytesInUse({ a: 'xy', b: { c: 1 } }, 'b')).toBe(1 + 7)
    expect(bytesInUse({ a: 1, b: 2 }, ['a', 'zzz'])).toBe(2)
    const ok = applySet({ a: 1 }, { a: 2, b: 'x', gone: undefined }, SYNC_QUOTA)
    expect(ok.error).toBeNull()
    expect(ok.next).toEqual({ a: 2, b: 'x' })
    expect(ok.changes).toEqual({ a: { oldValue: 1, newValue: 2 }, b: { newValue: 'x' } })
    const big = applySet({}, { k: 'x'.repeat(SYNC_QUOTA.QUOTA_BYTES_PER_ITEM) }, SYNC_QUOTA)
    expect(big.error).toBe('QUOTA_BYTES_PER_ITEM quota exceeded')
    expect(big.next).toEqual({})
    const many: Record<string, number> = {}
    for (let i = 0; i < SYNC_QUOTA.MAX_ITEMS + 1; i++) many[`k${i}`] = i
    expect(applySet({}, many, SYNC_QUOTA).error).toBe('MAX_ITEMS quota exceeded')
    const total: Record<string, string> = {}
    for (let i = 0; i < 20; i++) total[`k${i}`] = 'y'.repeat(8000)
    expect(applySet({}, total, SYNC_QUOTA).error).toBe('QUOTA_BYTES quota exceeded')
    expect(applySet({}, total, null).error).toBeNull()
  })

  it('normalises values through JSON like Chrome', () => {
    const result = applySet({}, { d: new Date(0), f: () => 1, n: { u: undefined, v: 1 } }, null)
    expect(result.next).toEqual({ d: '1970-01-01T00:00:00.000Z', n: { v: 1 } })
  })

  it('removes, clears, selects and diffs', () => {
    expect(applyRemove({ a: 1, b: 2 }, 'a')).toEqual({
      next: { b: 2 },
      changes: { a: { oldValue: 1 } }
    })
    expect(applyRemove({ a: 1 }, ['zzz'])).toEqual({ next: { a: 1 }, changes: {} })
    expect(applyClear({ a: 1, b: 2 }).changes).toEqual({ a: { oldValue: 1 }, b: { oldValue: 2 } })
    expect(selectItems({ a: 1, b: 2 }, null)).toEqual({ a: 1, b: 2 })
    expect(selectItems({ a: 1, b: 2 }, 'a')).toEqual({ a: 1 })
    expect(selectItems({ a: 1, b: 2 }, ['b', 'c'])).toEqual({ b: 2 })
    expect(selectItems({ a: 1 }, { a: 0, c: 'default' })).toEqual({ a: 1, c: 'default' })
    expect(diffItems({ a: 1, b: 2, c: 3 }, { a: 1, b: 3, d: 4 })).toEqual({
      b: { oldValue: 2, newValue: 3 },
      c: { oldValue: 3 },
      d: { newValue: 4 }
    })
  })
})

describe('alarm scheduling', () => {
  const now = 1_000_000

  it('applies when / delayInMinutes / periodInMinutes with the packed-extension floor', () => {
    expect(scheduleAlarm('a', { delayInMinutes: 5 }, { now, unpacked: false })).toEqual({
      alarm: { name: 'a', scheduledTime: now + 5 * 60_000 },
      error: null
    })
    expect(
      scheduleAlarm('a', { when: now + 1000 }, { now, unpacked: false }).alarm?.scheduledTime
    ).toBe(now + 30_000)
    expect(
      scheduleAlarm('a', { when: now + 1000 }, { now, unpacked: true }).alarm?.scheduledTime
    ).toBe(now + 1000)
    expect(scheduleAlarm('a', { periodInMinutes: 0.1 }, { now, unpacked: false }).alarm).toEqual({
      name: 'a',
      scheduledTime: now + 30_000,
      periodInMinutes: 0.5
    })
    expect(scheduleAlarm('a', { periodInMinutes: 0.1 }, { now, unpacked: true }).alarm).toEqual({
      name: 'a',
      scheduledTime: now + 6_000,
      periodInMinutes: 0.1
    })
    expect(
      scheduleAlarm('a', { delayInMinutes: 1, periodInMinutes: 2 }, { now, unpacked: true }).alarm
    ).toEqual({ name: 'a', scheduledTime: now + 60_000, periodInMinutes: 2 })
  })

  it('rejects contradictory or malformed info', () => {
    expect(
      scheduleAlarm('a', { when: 1, delayInMinutes: 1 }, { now, unpacked: true }).error
    ).toMatch(/both/)
    expect(scheduleAlarm('a', {}, { now, unpacked: true }).error).toBeTruthy()
    expect(scheduleAlarm('a', { when: Number.NaN }, { now, unpacked: true }).error).toMatch(
      /Invalid/
    )
  })

  it('reschedules periodic alarms and collapses missed periods', () => {
    const alarm = { name: 'p', scheduledTime: now, periodInMinutes: 1 }
    expect(rescheduleAlarm(alarm, now)).toEqual({ ...alarm, scheduledTime: now + 60_000 })
    expect(rescheduleAlarm(alarm, now + 5 * 60_000)).toEqual({
      ...alarm,
      scheduledTime: now + 6 * 60_000
    })
    expect(rescheduleAlarm({ name: 'once', scheduledTime: now }, now)).toBeNull()
  })

  it('splits due alarms and computes the next wake-up', () => {
    const alarms = [
      { name: 'b', scheduledTime: now + 500 },
      { name: 'a', scheduledTime: now - 10 },
      { name: 'c', scheduledTime: now }
    ]
    const { due, pending } = splitDue(alarms, now)
    expect(due.map((a) => a.name)).toEqual(['a', 'c'])
    expect(pending.map((a) => a.name)).toEqual(['b'])
    expect(msUntilNext(alarms, now)).toBe(0)
    expect(msUntilNext(pending, now)).toBe(500)
    expect(msUntilNext([], now)).toBeNull()
  })
})

describe('permission grants', () => {
  const manifest: ExtensionManifest = {
    manifest_version: 3,
    name: 'P',
    version: '1',
    permissions: ['storage', 'tabs'],
    host_permissions: ['https://a.com/*'],
    optional_permissions: ['bookmarks'],
    optional_host_permissions: ['*://*.b.com/*']
  }
  const mv2: ExtensionManifest = {
    manifest_version: 2,
    name: 'P',
    version: '1',
    permissions: ['storage', '<all_urls>', 'http://c.com/*'],
    optional_permissions: ['cookies', 'https://d.com/*']
  }

  it('splits manifest permissions into required and optional sets', () => {
    expect(manifestPermissionSets(manifest)).toEqual({
      required: { permissions: ['storage', 'tabs'], origins: ['https://a.com/*'] },
      optional: { permissions: ['bookmarks'], origins: ['*://*.b.com/*'] }
    })
    expect(manifestPermissionSets(mv2)).toEqual({
      required: { permissions: ['storage'], origins: ['<all_urls>', 'http://c.com/*'] },
      optional: { permissions: ['cookies'], origins: ['https://d.com/*'] }
    })
  })

  it('normalises, contains, removes and finds missing entries', () => {
    expect(normalizePermissionSet({ permissions: ['a', 'a'] })).toEqual({
      permissions: ['a'],
      origins: []
    })
    expect(normalizePermissionSet({ permissions: 'a' })).toBeNull()
    expect(normalizePermissionSet(null)).toBeNull()
    const granted = { permissions: ['storage'], origins: ['*://*.b.com/*'] }
    expect(
      permissionSetContains(granted, { permissions: ['storage'], origins: ['https://x.b.com/*'] })
    ).toBe(true)
    expect(permissionSetContains(granted, { permissions: ['tabs'], origins: [] })).toBe(false)
    expect(permissionSetContains(granted, { permissions: [], origins: ['https://c.com/*'] })).toBe(
      false
    )
    expect(
      missingPermissions(granted, {
        permissions: ['storage', 'tabs'],
        origins: ['https://c.com/*']
      })
    ).toEqual({ permissions: ['tabs'], origins: ['https://c.com/*'] })
    expect(
      removePermissionSet(granted, { permissions: ['storage'], origins: ['https://x.b.com/*'] })
    ).toEqual({
      permissions: [],
      origins: ['*://*.b.com/*']
    })
  })

  it('only lets manifest-declared permissions be requested', () => {
    const sets = manifestPermissionSets(manifest)
    expect(
      requestablePermissions(sets, { permissions: ['bookmarks'], origins: ['https://x.b.com/*'] })
    ).toEqual({
      ok: true
    })
    expect(requestablePermissions(sets, { permissions: ['history'], origins: [] }).ok).toBe(false)
    expect(requestablePermissions(sets, { permissions: [], origins: ['https://z.com/*'] }).ok).toBe(
      false
    )
    expect(requestablePermissions(sets, { permissions: [], origins: ['garbage'] }).ok).toBe(false)
  })
})
