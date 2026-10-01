import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BLOCKING_SETTINGS,
  DEFAULT_FILTER_LISTS,
  customListId,
  effectiveLevel,
  enabledListsFor,
  levelIncludes,
  listDefaultFor,
  normalizeSiteException,
  sanitizeBlockingSettings,
  siteOriginOf
} from '../blocking'

describe('tracking levels', () => {
  it('turns lists on by tier: basic ⊂ balanced ⊂ strict, off enables nothing', () => {
    const ids = (level: 'off' | 'basic' | 'balanced' | 'strict'): string[] =>
      [...enabledListsFor({ ...DEFAULT_BLOCKING_SETTINGS, level })].sort()
    expect(ids('off')).toEqual([])
    expect(ids('basic')).toEqual(['ubo-badware', 'urlhaus'])
    expect(ids('balanced')).toEqual([
      'easylist',
      'easyprivacy',
      'peter-lowe',
      'ubo-badware',
      'ubo-filters',
      'urlhaus'
    ])
    expect(ids('strict')).toEqual(DEFAULT_FILTER_LISTS.map((l) => l.id).sort())
    expect(levelIncludes('basic', 'balanced')).toBe(false)
    expect(levelIncludes('strict', 'basic')).toBe(true)
    expect(listDefaultFor('balanced', 'ubo-privacy')).toBe(false)
    expect(listDefaultFor('strict', 'ubo-privacy')).toBe(true)
    expect(listDefaultFor('off', 'urlhaus')).toBe(false)
    expect(listDefaultFor('strict', 'nope')).toBe(false)
  })

  it('applies per-list overrides, custom lists and the master switch', () => {
    const s = {
      ...DEFAULT_BLOCKING_SETTINGS,
      lists: { easylist: false, 'ubo-privacy': true },
      customLists: [
        { id: 'custom-a', url: 'https://a/x.txt', name: 'A', enabled: true },
        { id: 'custom-b', url: 'https://b/x.txt', name: 'B', enabled: false }
      ]
    }
    expect([...enabledListsFor(s)].sort()).toEqual([
      'custom-a',
      'easyprivacy',
      'peter-lowe',
      'ubo-badware',
      'ubo-filters',
      'ubo-privacy',
      'urlhaus'
    ])
    expect(enabledListsFor(s, false).size).toBe(0)
    expect(enabledListsFor({ ...s, level: 'off' }).size).toBe(0)
  })
})

describe('"Always use Strict in private windows" (services pass 16, PS-49)', () => {
  const strictIds = DEFAULT_FILTER_LISTS.map((l) => l.id).sort()
  const ids = (s: typeof DEFAULT_BLOCKING_SETTINGS, isPrivate: boolean, enabled = true): string[] =>
    [...enabledListsFor(s, enabled, isPrivate)].sort()
  const on = { ...DEFAULT_BLOCKING_SETTINGS, levelPrivate: 'strict' as const }

  it('effectiveLevel: a private window reads strict while the switch is on, every other window the level', () => {
    expect(effectiveLevel(on, true)).toBe('strict')
    expect(effectiveLevel(on, false)).toBe('balanced')
    expect(effectiveLevel({ ...on, level: 'basic' }, true)).toBe('strict')
    expect(effectiveLevel({ ...on, level: 'basic' }, false)).toBe('basic')
    // Off is a level too: the switch lifts a private window above it and leaves the others off.
    expect(effectiveLevel({ ...on, level: 'off' }, true)).toBe('strict')
    expect(effectiveLevel({ ...on, level: 'off' }, false)).toBe('off')
    // Switch off: the general level everywhere.
    expect(effectiveLevel(DEFAULT_BLOCKING_SETTINGS, true)).toBe('balanced')
    expect(effectiveLevel({ ...DEFAULT_BLOCKING_SETTINGS, level: 'off' }, true)).toBe('off')
    // Already Strict: the switch changes nothing either way.
    expect(effectiveLevel({ ...on, level: 'strict' }, true)).toBe('strict')
    expect(effectiveLevel({ ...DEFAULT_BLOCKING_SETTINGS, level: 'strict' }, true)).toBe('strict')
  })

  it('enabledListsFor: the strict set for a private window while on, the general set otherwise', () => {
    // On at Balanced: private windows get every list, the others the balanced tier as before.
    expect(ids(on, true)).toEqual(strictIds)
    expect(ids(on, false)).toEqual(ids(DEFAULT_BLOCKING_SETTINGS, false))
    expect(ids(on, true)).not.toEqual(ids(on, false))
    // Off: the general level everywhere.
    expect(ids(DEFAULT_BLOCKING_SETTINGS, true)).toEqual(ids(DEFAULT_BLOCKING_SETTINGS, false))
    // General level Strict: identical sets whether the switch is on or off.
    const strict = { ...DEFAULT_BLOCKING_SETTINGS, level: 'strict' as const }
    expect(ids({ ...strict, levelPrivate: 'strict' }, true)).toEqual(strictIds)
    expect(ids(strict, true)).toEqual(strictIds)
    expect(ids(strict, false)).toEqual(strictIds)
    // Level Off with the switch on: the strict set in private windows, nothing elsewhere.
    expect(ids({ ...on, level: 'off' }, true)).toEqual(strictIds)
    expect(ids({ ...on, level: 'off' }, false)).toEqual([])
    // The master switch off enables nothing anywhere.
    expect(ids(on, true, false)).toEqual([])
    // A per-list override and a custom list hold in private windows as they do elsewhere.
    const overridden = {
      ...on,
      lists: { 'ubo-privacy': false },
      customLists: [{ id: 'custom-a', url: 'https://a/x.txt', name: 'A', enabled: true }]
    }
    expect(ids(overridden, true)).toEqual(
      ['custom-a', ...strictIds.filter((id) => id !== 'ubo-privacy')].sort()
    )
    expect(ids(overridden, false)).toEqual(
      [
        ...enabledListsFor({ ...DEFAULT_BLOCKING_SETTINGS, lists: { 'ubo-privacy': false } }),
        'custom-a'
      ].sort()
    )
  })

  it('sanitises levelPrivate to strict or default and defaults it to default', () => {
    expect(sanitizeBlockingSettings(undefined).levelPrivate).toBe('default')
    expect(sanitizeBlockingSettings({}).levelPrivate).toBe('default')
    expect(sanitizeBlockingSettings({ levelPrivate: 'strict' }).levelPrivate).toBe('strict')
    expect(sanitizeBlockingSettings({ levelPrivate: 'default' }).levelPrivate).toBe('default')
    expect(
      sanitizeBlockingSettings({ levelPrivate: 'inherit' as unknown as 'default' }).levelPrivate
    ).toBe('default')
    expect(sanitizeBlockingSettings({ levelPrivate: 1 as unknown as 'strict' }).levelPrivate).toBe(
      'default'
    )
    // A settings record from a build before the switch reads as the switch off.
    const before = {
      level: 'balanced',
      lists: {},
      customLists: [],
      userFilters: '',
      autoUpdate: true
    }
    expect(sanitizeBlockingSettings(before as Partial<typeof DEFAULT_BLOCKING_SETTINGS>)).toEqual(
      DEFAULT_BLOCKING_SETTINGS
    )
  })
})

describe('normalizeSiteException', () => {
  it('reduces hosts and URLs to the origin the permission store keys on', () => {
    expect(normalizeSiteException('https://WWW.Example.com/path')).toBe('https://www.example.com')
    expect(normalizeSiteException('  news.example.co.uk. ')).toBe('https://news.example.co.uk')
    expect(normalizeSiteException('example.com/x')).toBe('https://example.com')
    expect(normalizeSiteException('http://example.com:8080/x')).toBe('http://example.com:8080')
    expect(normalizeSiteException('localhost:3000')).toBe('https://localhost:3000')
    expect(normalizeSiteException('10.0.0.1')).toBe('https://10.0.0.1')
    expect(normalizeSiteException('')).toBeNull()
    expect(normalizeSiteException('not a host')).toBeNull()
    expect(normalizeSiteException('http://')).toBeNull()
    expect(normalizeSiteException('word')).toBeNull()
    expect(normalizeSiteException('zen://blank')).toBeNull()
    expect(normalizeSiteException('file:///etc/hosts')).toBeNull()
  })

  it('names the origin of a web page and nothing for internal pages', () => {
    expect(siteOriginOf('https://www.example.com/a?b#c')).toBe('https://www.example.com')
    expect(siteOriginOf('http://localhost:8080/')).toBe('http://localhost:8080')
    expect(siteOriginOf('zen://blocked')).toBeNull()
    expect(siteOriginOf('about:blank')).toBeNull()
    expect(siteOriginOf('nonsense')).toBeNull()
  })
})

describe('sanitizeBlockingSettings', () => {
  it('fills defaults and drops malformed values', () => {
    expect(sanitizeBlockingSettings(undefined)).toEqual(DEFAULT_BLOCKING_SETTINGS)
    const s = sanitizeBlockingSettings({
      level: 'paranoid' as unknown as 'strict',
      lists: { easylist: false, bogus: 'x' as unknown as boolean },
      customLists: [
        { id: '', url: ' https://a.example/list.txt ', name: '', enabled: true },
        { id: 'dup', url: 'https://a.example/list.txt', name: 'dup', enabled: true },
        { id: 'ftp', url: 'ftp://a.example/list.txt', name: 'ftp', enabled: true },
        null as unknown as { id: string; url: string; name: string; enabled: boolean },
        { id: 'keep', url: 'https://b.example/l.txt', name: 'B', enabled: false }
      ],
      userFilters: 42 as unknown as string,
      autoUpdate: false
    })
    expect(s).toEqual({
      level: 'balanced',
      levelPrivate: 'default',
      lists: { easylist: false },
      customLists: [
        {
          id: customListId('https://a.example/list.txt'),
          url: 'https://a.example/list.txt',
          name: 'https://a.example/list.txt',
          enabled: true
        },
        { id: 'keep', url: 'https://b.example/l.txt', name: 'B', enabled: false }
      ],
      userFilters: '',
      autoUpdate: false
    })
    expect(sanitizeBlockingSettings({ userFilters: 'x'.repeat(300_000) }).userFilters.length).toBe(
      200_000
    )
  })

  it('derives stable custom list ids', () => {
    expect(customListId('https://a.example/list.txt')).toMatch(/^custom-[0-9a-f]{8}$/)
    expect(customListId('https://a.example/list.txt')).toBe(
      customListId('https://a.example/list.txt')
    )
    expect(customListId('https://a.example/list.txt')).not.toBe(
      customListId('https://a.example/list2.txt')
    )
  })
})
