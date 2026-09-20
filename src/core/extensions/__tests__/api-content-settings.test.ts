import { describe, expect, it } from 'vitest'
import {
  CONTENT_SETTING_TYPES,
  EMBEDDED_PATTERN_ERROR,
  INVALID_SETTING_ERROR,
  SPECIFIC_PATH_ERROR,
  contentSettingType,
  contentSettingTypeFor,
  decisionOfSetting,
  matchingRule,
  normalizeClearDetails,
  normalizeGetDetails,
  normalizeSetDetails,
  normalizeStoredRules,
  parseContentSettingsPattern,
  patternMatchesUrl,
  patternSpecificity,
  persistedRules,
  settingOfDecision,
  sortRules,
  type ContentSettingRule,
  type ContentSettingsPattern
} from '../api/contentSettings'
import { CONTENT_SETTINGS } from '../../../shared/contentSettings'

const pattern = (raw: string): ContentSettingsPattern => {
  const parsed = parseContentSettingsPattern(raw)
  if (typeof parsed === 'string') throw new Error(`${raw}: ${parsed}`)
  return parsed
}

const rule = (
  primaryPattern: string,
  setting: string,
  extra: Partial<ContentSettingRule> = {}
): ContentSettingRule => ({
  primaryPattern,
  secondaryPattern: '<all_urls>',
  setting,
  scope: 'regular',
  ...extra
})

describe('contentSettings: the types', () => {
  it('names Chrome\u2019s types and the catalogue rows they stand for', () => {
    const names = CONTENT_SETTING_TYPES.map((type) => type.name)
    expect(names).toEqual([
      'cookies',
      'images',
      'javascript',
      'location',
      'plugins',
      'popups',
      'notifications',
      'fullscreen',
      'mouselock',
      'microphone',
      'camera',
      'unsandboxedPlugins',
      'automaticDownloads',
      'clipboard',
      'autoVerify'
    ])
    const rows = new Set(CONTENT_SETTINGS.map((row) => row.id))
    for (const type of CONTENT_SETTING_TYPES) {
      if (type.permission !== null) expect(rows.has(type.permission), type.name).toBe(true)
    }
    expect(contentSettingType('location')?.permission).toBe('geolocation')
    expect(contentSettingTypeFor('geolocation')?.name).toBe('location')
    expect(contentSettingTypeFor('pointerLock')?.name).toBe('mouselock')
    expect(contentSettingType('flash')).toBeUndefined()
  })

  it('the retired types answer a fixed value', () => {
    expect(contentSettingType('plugins')?.fixed).toBe('block')
    expect(contentSettingType('unsandboxedPlugins')?.fixed).toBe('block')
    expect(contentSettingType('fullscreen')?.fixed).toBe('allow')
    expect(contentSettingType('mouselock')?.fixed).toBe('allow')
    expect(contentSettingType('notifications')?.fixed).toBeUndefined()
  })
})

describe('contentSettings: patterns', () => {
  it('takes Chrome\u2019s content-settings patterns and refuses the rest', () => {
    expect(pattern('<all_urls>').matchesAllUrls).toBe(true)
    expect(pattern('https://example.com/*')).toMatchObject({
      schemes: ['https'],
      host: 'example.com',
      port: null,
      source: 'https://example.com/*'
    })
    expect(pattern('*://*.example.com:8080/*')).toMatchObject({
      schemes: ['http', 'https'],
      host: '*.example.com',
      port: '8080'
    })
    expect(pattern('HTTPS://Example.COM/*').source).toBe('https://example.com/*')
    expect(pattern('file:///*').schemes).toEqual(['file'])
    expect(pattern('file:///home/me/a.pdf').path).toBe('/home/me/a.pdf')
    expect(parseContentSettingsPattern('https://example.com/path/*')).toBe(SPECIFIC_PATH_ERROR)
    expect(parseContentSettingsPattern('https://example.com')).toMatch(/invalid/)
    expect(parseContentSettingsPattern('ftp://example.com/*')).toMatch(/invalid/)
    expect(parseContentSettingsPattern('chrome-extension://abc/*')).toMatch(/invalid/)
    expect(parseContentSettingsPattern('example.com')).toMatch(/invalid/)
    expect(parseContentSettingsPattern(42)).toMatch(/invalid/)
  })

  it('matches URLs by scheme, host (with the domain wildcard), port and file path', () => {
    const site = pattern('https://example.com/*')
    expect(patternMatchesUrl(site, 'https://example.com/a/b?c')).toBe(true)
    expect(patternMatchesUrl(site, 'https://example.com:443/')).toBe(true)
    expect(patternMatchesUrl(site, 'http://example.com/')).toBe(false)
    expect(patternMatchesUrl(site, 'https://www.example.com/')).toBe(false)
    const domain = pattern('*://*.example.com/*')
    expect(patternMatchesUrl(domain, 'http://example.com/')).toBe(true)
    expect(patternMatchesUrl(domain, 'https://a.b.example.com/')).toBe(true)
    expect(patternMatchesUrl(domain, 'https://example.org/')).toBe(false)
    expect(patternMatchesUrl(domain, 'ftp://example.com/')).toBe(false)
    const port = pattern('http://example.com:8080/*')
    expect(patternMatchesUrl(port, 'http://example.com:8080/x')).toBe(true)
    expect(patternMatchesUrl(port, 'http://example.com/x')).toBe(false)
    expect(patternMatchesUrl(pattern('http://example.com:80/*'), 'http://example.com/')).toBe(true)
    expect(patternMatchesUrl(pattern('<all_urls>'), 'ftp://x.example/')).toBe(true)
    expect(patternMatchesUrl(pattern('<all_urls>'), 'not a url')).toBe(false)
    expect(patternMatchesUrl(pattern('file:///*'), 'file:///home/me/a.pdf')).toBe(true)
    expect(patternMatchesUrl(pattern('file:///home/me/a.pdf'), 'file:///home/me/a.pdf')).toBe(true)
    expect(patternMatchesUrl(pattern('file:///home/me/a.pdf'), 'file:///home/me/b.pdf')).toBe(false)
  })

  it('ranks the more specific pattern higher, as Chrome orders rules', () => {
    const order = [
      '<all_urls>',
      '*://*/*',
      'https://*/*',
      '*://*.example.com/*',
      '*://*.a.example.com/*',
      '*://example.com/*',
      'https://example.com/*',
      'https://example.com:443/*'
    ].map((raw) => patternSpecificity(pattern(raw)))
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1])
  })
})

describe('contentSettings: details', () => {
  const notifications = contentSettingType('notifications')!
  const cookies = contentSettingType('cookies')!

  it('get: a primary URL is required and must be a URL; the secondary defaults to it', () => {
    expect(normalizeGetDetails({ primaryUrl: 'https://a.example/x' })).toEqual({
      primaryUrl: 'https://a.example/x',
      secondaryUrl: 'https://a.example/x',
      incognito: false
    })
    expect(
      normalizeGetDetails({
        primaryUrl: 'https://a.example/',
        secondaryUrl: 'https://top.example/',
        incognito: true,
        resourceIdentifier: { id: 'x' }
      })
    ).toEqual({
      primaryUrl: 'https://a.example/',
      secondaryUrl: 'https://top.example/',
      incognito: true
    })
    expect(normalizeGetDetails({})).toBe('The URL "undefined" is invalid.')
    expect(normalizeGetDetails({ primaryUrl: 'nope' })).toBe('The URL "nope" is invalid.')
    expect(normalizeGetDetails({ primaryUrl: 'https://a.example/', secondaryUrl: 7 })).toBe(
      'The URL "7" is invalid.'
    )
  })

  it('set: the patterns, the value the type accepts, the scope', () => {
    expect(
      normalizeSetDetails(notifications, {
        primaryPattern: 'https://a.example/*',
        setting: 'block'
      })
    ).toMatchObject({
      primary: { source: 'https://a.example/*' },
      secondary: { source: '<all_urls>' },
      setting: 'block',
      scope: 'regular'
    })
    expect(
      normalizeSetDetails(notifications, {
        primaryPattern: 'https://a.example/*',
        setting: 'ask',
        scope: 'incognito_session_only'
      })
    ).toMatchObject({ scope: 'incognito_session_only' })
    expect(
      normalizeSetDetails(notifications, {
        primaryPattern: 'https://a.example/*',
        setting: 'session_only'
      })
    ).toBe("'session_only' is not supported for this setting.")
    expect(
      normalizeSetDetails(cookies, {
        primaryPattern: 'https://a.example/*',
        setting: 'session_only'
      })
    ).toMatchObject({ setting: 'session_only' })
    expect(normalizeSetDetails(notifications, { primaryPattern: 'https://a.example/*' })).toBe(
      INVALID_SETTING_ERROR
    )
    expect(
      normalizeSetDetails(notifications, { primaryPattern: 'a.example', setting: 'block' })
    ).toMatch(/invalid/)
    expect(
      normalizeSetDetails(notifications, {
        primaryPattern: 'https://a.example/*',
        secondaryPattern: 'https://top.example/*',
        setting: 'block'
      })
    ).toBe(EMBEDDED_PATTERN_ERROR)
    expect(
      normalizeSetDetails(cookies, {
        primaryPattern: 'https://a.example/*',
        secondaryPattern: 'https://top.example/*',
        setting: 'block'
      })
    ).toMatchObject({ secondary: { source: 'https://top.example/*' } })
    expect(
      normalizeSetDetails(notifications, {
        primaryPattern: 'https://a.example/*',
        setting: 'block',
        scope: 'regular_only'
      })
    ).toMatch(/scope/)
  })

  it('clear: the scope, regular by default', () => {
    expect(normalizeClearDetails(undefined)).toEqual({ scope: 'regular' })
    expect(normalizeClearDetails({ scope: 'incognito_session_only' })).toEqual({
      scope: 'incognito_session_only'
    })
    expect(normalizeClearDetails({ scope: 'x' })).toMatch(/scope/)
  })
})

describe('contentSettings: rules', () => {
  it('orders one extension\u2019s rules by specificity and finds the first covering a URL pair', () => {
    const rules = [
      rule('<all_urls>', 'block'),
      rule('*://*.example.com/*', 'allow'),
      rule('https://a.example.com/*', 'ask'),
      rule('https://b.example.com/*', 'ask', { scope: 'incognito_session_only' })
    ]
    const sorted = sortRules(rules)
    expect(sorted.map((r) => r.primaryPattern)).toEqual([
      'https://a.example.com/*',
      'https://b.example.com/*',
      '*://*.example.com/*',
      '<all_urls>'
    ])
    const at = (
      url: string,
      scopes: Array<'regular' | 'incognito_session_only'> = ['regular']
    ): string | null => matchingRule(sorted, url, url, scopes)?.setting ?? null
    expect(at('https://a.example.com/')).toBe('ask')
    expect(at('https://c.example.com/')).toBe('allow')
    expect(at('https://other.example/')).toBe('block')
    expect(at('https://b.example.com/')).toBe('allow')
    expect(at('https://b.example.com/', ['incognito_session_only', 'regular'])).toBe('ask')
    expect(at('zen://newtab/')).toBe('block')
    expect(matchingRule([], 'https://a.example/', 'https://a.example/', ['regular'])).toBeNull()
  })

  it('a cookies rule with an embedded pattern needs both URLs to match', () => {
    const rules = sortRules([
      rule('https://tracker.example/*', 'block', { secondaryPattern: 'https://news.example/*' })
    ])
    expect(
      matchingRule(rules, 'https://tracker.example/x', 'https://news.example/', ['regular'])
    ).not.toBeNull()
    expect(
      matchingRule(rules, 'https://tracker.example/x', 'https://shop.example/', ['regular'])
    ).toBeNull()
  })

  it('translates between Chrome\u2019s values and the permission store\u2019s decisions', () => {
    expect(settingOfDecision('deny')).toBe('block')
    expect(settingOfDecision('allow')).toBe('allow')
    expect(settingOfDecision('ask')).toBe('ask')
    expect(decisionOfSetting('block')).toBe('deny')
    expect(decisionOfSetting('session_only')).toBe('allow')
    expect(decisionOfSetting('ask')).toBe('ask')
    expect(decisionOfSetting('what')).toBeNull()
  })

  it('persists the regular-scope rules only and reads back what is a rule', () => {
    const rules = [
      rule('<all_urls>', 'block'),
      rule('https://b.example.com/*', 'ask', { scope: 'incognito_session_only' })
    ]
    expect(persistedRules(rules)).toEqual([rules[0]])
    expect(
      normalizeStoredRules([
        rules[0],
        { primaryPattern: 'x' },
        null,
        { ...rules[0], scope: 'weird' }
      ])
    ).toEqual([rules[0]])
    expect(normalizeStoredRules('no')).toEqual([])
  })
})
