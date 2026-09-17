import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BLOCKING_SETTINGS,
  DEFAULT_FILTER_LISTS,
  customListId,
  enabledListsFor,
  levelIncludes,
  listDefaultFor,
  normalizeSiteException,
  sanitizeBlockingSettings
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
    expect(enabledListsFor({ ...s, enabled: false }).size).toBe(0)
    expect(enabledListsFor({ ...s, level: 'off' }).size).toBe(0)
  })
})

describe('normalizeSiteException', () => {
  it('reduces hosts and URLs to a lowercase domain without www', () => {
    expect(normalizeSiteException('https://WWW.Example.com/path')).toBe('example.com')
    expect(normalizeSiteException('  news.example.co.uk. ')).toBe('news.example.co.uk')
    expect(normalizeSiteException('example.com/x')).toBe('example.com')
    expect(normalizeSiteException('localhost')).toBe('localhost')
    expect(normalizeSiteException('10.0.0.1')).toBe('10.0.0.1')
    expect(normalizeSiteException('')).toBeNull()
    expect(normalizeSiteException('not a host')).toBeNull()
    expect(normalizeSiteException('http://')).toBeNull()
    expect(normalizeSiteException('word')).toBeNull()
  })
})

describe('sanitizeBlockingSettings', () => {
  it('fills defaults and drops malformed values', () => {
    expect(sanitizeBlockingSettings(undefined)).toEqual(DEFAULT_BLOCKING_SETTINGS)
    const s = sanitizeBlockingSettings({
      enabled: 'yes' as unknown as boolean,
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
      siteExceptions: [
        'https://WWW.One.example/',
        'one.example',
        'bad host',
        7 as unknown as string
      ],
      autoUpdate: false
    })
    expect(s).toEqual({
      enabled: true,
      level: 'balanced',
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
      siteExceptions: ['one.example'],
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
