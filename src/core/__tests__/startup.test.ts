import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/defaults'
import {
  DEFAULT_STARTUP,
  MAX_STARTUP_PAGES,
  effectiveStartup,
  migrateStartupSettings,
  resolveStartupOverride,
  sanitizeStartupPages,
  sanitizeStartupSettings,
  startupControls,
  startupPageUrl,
  type StartupOverride
} from '../startup'

const override = (overrides: Partial<StartupOverride> = {}): StartupOverride => ({
  extensionId: 'a'.repeat(32),
  name: 'Startup Pages',
  pages: ['https://ext.example/'],
  installedAt: 1_000,
  ...overrides
})

describe('startupPageUrl – what a typed startup page stands for', () => {
  it('a bare host is a web address; a full address keeps its path and query', () => {
    expect(startupPageUrl('example.com')).toBe('https://example.com/')
    expect(startupPageUrl('  example.com/a?b=1#c  ')).toBe('https://example.com/a?b=1#c')
    expect(startupPageUrl('http://example.com:8080/x')).toBe('http://example.com:8080/x')
    expect(startupPageUrl('HTTPS://Example.COM/Path')).toBe('https://example.com/Path')
  })

  it('anything that is not a web page is refused', () => {
    expect(startupPageUrl('')).toBeNull()
    expect(startupPageUrl('   ')).toBeNull()
    expect(startupPageUrl('what is a startup page')).toBeNull()
    expect(startupPageUrl('zenium://settings')).toBeNull()
    expect(startupPageUrl('about:blank')).toBeNull()
    expect(startupPageUrl('ftp://files.example.com/')).toBeNull()
    expect(startupPageUrl('javascript:alert(1)')).toBeNull()
    expect(startupPageUrl('file:///etc/passwd')).toBeNull()
  })
})

describe('sanitizeStartupPages – a list from disk, a peer, a patch or a manifest', () => {
  it('keeps web addresses alone, each once, in their order', () => {
    expect(
      sanitizeStartupPages([
        'https://a.example/',
        'b.example',
        7,
        null,
        'https://a.example',
        'zenium://history',
        'not a url at all',
        'https://b.example/'
      ])
    ).toEqual(['https://a.example/', 'https://b.example/'])
  })

  it('reads anything but an array as no pages', () => {
    expect(sanitizeStartupPages(undefined)).toEqual([])
    expect(sanitizeStartupPages(null)).toEqual([])
    expect(sanitizeStartupPages('https://a.example/')).toEqual([])
    expect(sanitizeStartupPages({ 0: 'https://a.example/' })).toEqual([])
  })

  it(`caps the list at ${MAX_STARTUP_PAGES}`, () => {
    const many = Array.from({ length: MAX_STARTUP_PAGES + 5 }, (_, i) => `https://p${i}.example/`)
    const kept = sanitizeStartupPages(many)
    expect(kept).toHaveLength(MAX_STARTUP_PAGES)
    expect(kept[0]).toBe('https://p0.example/')
    expect(kept[MAX_STARTUP_PAGES - 1]).toBe(`https://p${MAX_STARTUP_PAGES - 1}.example/`)
  })
})

describe('sanitizeStartupSettings – the setting as read from disk or a peer', () => {
  it('passes a well-formed setting through, its pages sanitised', () => {
    expect(
      sanitizeStartupSettings({ mode: 'pages', pages: ['a.example', 'https://a.example/', 3] })
    ).toEqual({ mode: 'pages', pages: ['https://a.example/'] })
    expect(sanitizeStartupSettings({ mode: 'newTab', pages: [] })).toEqual({
      mode: 'newTab',
      pages: []
    })
  })

  it('a mode this build does not know, or no object at all, reads as the default', () => {
    expect(sanitizeStartupSettings({ mode: 'lastTab', pages: ['https://a.example/'] })).toEqual({
      mode: DEFAULT_STARTUP.mode,
      pages: ['https://a.example/']
    })
    expect(sanitizeStartupSettings(null)).toEqual(DEFAULT_STARTUP)
    expect(sanitizeStartupSettings('continue')).toEqual(DEFAULT_STARTUP)
    expect(sanitizeStartupSettings({})).toEqual(DEFAULT_STARTUP)
  })

  it('never hands back the default object itself', () => {
    const a = sanitizeStartupSettings(null)
    a.pages.push('https://a.example/')
    expect(DEFAULT_STARTUP.pages).toEqual([])
    expect(sanitizeStartupSettings(undefined).pages).toEqual([])
  })
})

describe('migrateStartupSettings – the 0.4.x "Restore previous session" switch folded in', () => {
  it('a profile with its own startup keeps it, whatever the old switch said', () => {
    expect(
      migrateStartupSettings({
        startup: { mode: 'pages', pages: ['https://a.example/'] },
        restoreSession: false
      })
    ).toEqual({ mode: 'pages', pages: ['https://a.example/'] })
    expect(migrateStartupSettings({ startup: { mode: 'newTab' }, restoreSession: true })).toEqual({
      mode: 'newTab',
      pages: []
    })
  })

  it('the switch on was "Continue where you left off", off "Open the New Tab page"', () => {
    expect(migrateStartupSettings({ restoreSession: true })).toEqual({
      mode: 'continue',
      pages: []
    })
    expect(migrateStartupSettings({ restoreSession: false })).toEqual({
      mode: 'newTab',
      pages: []
    })
  })

  it('a profile with neither, or junk for either, gets the default', () => {
    expect(migrateStartupSettings({})).toEqual(DEFAULT_STARTUP)
    expect(migrateStartupSettings({ restoreSession: 'yes' })).toEqual(DEFAULT_STARTUP)
    expect(migrateStartupSettings({ startup: 'pages', restoreSession: 1 })).toEqual(DEFAULT_STARTUP)
    expect(migrateStartupSettings({ startup: null, restoreSession: false })).toEqual({
      mode: 'newTab',
      pages: []
    })
  })

  it('matches the shipped default: a fresh profile continues where it left off', () => {
    expect(DEFAULT_SETTINGS.startup).toEqual(DEFAULT_STARTUP)
    expect(migrateStartupSettings({})).toEqual(DEFAULT_SETTINGS.startup)
  })
})

describe('resolveStartupOverride – which enabled extension holds the setting', () => {
  it('none without a candidate with a page', () => {
    expect(resolveStartupOverride([])).toBeNull()
    expect(resolveStartupOverride([override({ pages: [] })])).toBeNull()
  })

  it('the newest-installed of several wins, as its prefs layer sits on top', () => {
    const older = override({ extensionId: 'b'.repeat(32), name: 'Older', installedAt: 1_000 })
    const newer = override({ extensionId: 'c'.repeat(32), name: 'Newer', installedAt: 2_000 })
    expect(resolveStartupOverride([older, newer])).toBe(newer)
    expect(resolveStartupOverride([newer, older])).toBe(newer)
  })

  it('an extension with no page counts for nothing, however new', () => {
    const older = override({ name: 'Older', installedAt: 1_000 })
    const newerEmpty = override({ name: 'Newer', installedAt: 2_000, pages: [] })
    expect(resolveStartupOverride([older, newerEmpty])).toBe(older)
  })
})

describe('effectiveStartup – what the boot does', () => {
  const settings = (
    mode: 'newTab' | 'continue' | 'pages',
    pages: string[] = []
  ): { startup: { mode: 'newTab' | 'continue' | 'pages'; pages: string[] } } => ({
    startup: { mode, pages }
  })

  it('each of the user\u2019s three choices, with no extension holding the setting', () => {
    expect(effectiveStartup(settings('newTab'), null)).toEqual({
      mode: 'newTab',
      pages: [],
      control: null
    })
    expect(effectiveStartup(settings('continue'), null)).toEqual({
      mode: 'continue',
      pages: [],
      control: null
    })
    expect(
      effectiveStartup(settings('pages', ['https://a.example/', 'https://b.example/']), null)
    ).toEqual({
      mode: 'pages',
      pages: ['https://a.example/', 'https://b.example/'],
      control: null
    })
  })

  it('a pages list is kept under the other modes but only read under "pages"', () => {
    expect(effectiveStartup(settings('continue', ['https://a.example/']), undefined)).toEqual({
      mode: 'continue',
      pages: [],
      control: null
    })
    expect(effectiveStartup(settings('newTab', ['https://a.example/']), null).pages).toEqual([])
  })

  it('"pages" with no page left after sanitising is the New Tab page, as Chrome falls back', () => {
    expect(effectiveStartup(settings('pages'), null)).toEqual({
      mode: 'newTab',
      pages: [],
      control: null
    })
    expect(effectiveStartup(settings('pages', ['zenium://settings', 'nope']), null).mode).toBe(
      'newTab'
    )
  })

  it('the pages come back sanitised, so a stale profile cannot open a non-web address', () => {
    expect(
      effectiveStartup(
        settings('pages', ['a.example', 'https://a.example/', 'javascript:alert(1)']),
        null
      ).pages
    ).toEqual(['https://a.example/'])
  })

  it('an enabled extension\u2019s pages replace the user\u2019s choice, whatever it was', () => {
    for (const own of [
      settings('newTab'),
      settings('continue'),
      settings('pages', ['https://mine.example/'])
    ]) {
      const effective = effectiveStartup(own, override())
      expect(effective.mode).toBe('pages')
      expect(effective.pages).toEqual(['https://ext.example/'])
      expect(effective.control).toEqual({
        extensionId: 'a'.repeat(32),
        name: 'Startup Pages',
        value: ['https://ext.example/'],
        pages: ['https://ext.example/']
      })
    }
  })

  it('the extension\u2019s list is sanitised too; one with no valid page leaves the user in charge', () => {
    expect(
      effectiveStartup(settings('newTab'), override({ pages: ['ext.example', 'zenium://x'] })).pages
    ).toEqual(['https://ext.example/'])
    expect(
      effectiveStartup(settings('continue'), override({ pages: ['zenium://x', 'not a url'] }))
    ).toEqual({ mode: 'continue', pages: [], control: null })
  })

  it('the user\u2019s own value stands again once the override is gone', () => {
    const own = settings('pages', ['https://mine.example/'])
    expect(effectiveStartup(own, override()).pages).toEqual(['https://ext.example/'])
    expect(effectiveStartup(own, null)).toEqual({
      mode: 'pages',
      pages: ['https://mine.example/'],
      control: null
    })
    expect(own.startup.pages).toEqual(['https://mine.example/'])
  })
})

describe('startupControls – the Settings rows\u2019 controlled state', () => {
  it('nothing when no extension holds the setting', () => {
    expect(startupControls(effectiveStartup({ startup: DEFAULT_STARTUP }, null))).toEqual({})
  })

  it('the mode row reads "pages", the pages rows the extension\u2019s list, both under its name', () => {
    const controls = startupControls(
      effectiveStartup(
        { startup: DEFAULT_STARTUP },
        override({ pages: ['https://ext.example/', 'https://two.example/'] })
      )
    )
    expect(controls).toEqual({
      'startup.mode': { extensionId: 'a'.repeat(32), name: 'Startup Pages', value: 'pages' },
      'startup.pages': {
        extensionId: 'a'.repeat(32),
        name: 'Startup Pages',
        value: ['https://ext.example/', 'https://two.example/']
      }
    })
  })

  it('hands out its own copy of the list', () => {
    const effective = effectiveStartup({ startup: DEFAULT_STARTUP }, override())
    const controls = startupControls(effective) as Record<string, { value: string[] }>
    controls['startup.pages'].value.push('https://x.example/')
    expect(effective.pages).toEqual(['https://ext.example/'])
  })
})
