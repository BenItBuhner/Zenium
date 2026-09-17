import { describe, expect, it } from 'vitest'
import type { TranslatePreferences } from '../../../shared/translate'
import {
  defaultPreferences,
  defaultTarget,
  languageRule,
  languagesFromLocales,
  offerFor,
  sanitizePreferences,
  siteOf,
  withLanguageRule,
  withPreferred,
  withSiteRule
} from '../languages'

const BASE: TranslatePreferences = {
  preferred: ['en'],
  alwaysTranslate: [],
  neverTranslate: [],
  neverTranslateSites: [],
  autoOffer: true
}

describe('defaultPreferences', () => {
  it('seeds the preferred list from the UI locales, deduplicated and normalised', () => {
    expect(languagesFromLocales(['de-AT', 'de-DE', 'en-GB', 'zh-TW'])).toEqual([
      'de',
      'en',
      'zh-Hant'
    ])
    expect(defaultPreferences(['fr-CA', 'fr']).preferred).toEqual(['fr'])
    expect(defaultPreferences([]).preferred).toEqual(['en'])
    expect(defaultPreferences(['nonsense']).preferred).toEqual(['en'])
    expect(defaultPreferences(['es']).autoOffer).toBe(true)
  })
})

describe('sanitizePreferences', () => {
  it('normalises lists, keeps the lists exclusive and fills gaps from the fallback', () => {
    const prefs = sanitizePreferences(
      {
        preferred: ['pt-BR', 'PT', 'en', 7],
        alwaysTranslate: ['es', 'de', 'en'],
        neverTranslate: ['de', 'fr'],
        neverTranslateSites: [' Example.com ', 'example.com', ''],
        autoOffer: 'yes'
      },
      { ...BASE, autoOffer: false }
    )
    expect(prefs).toEqual({
      preferred: ['pt', 'en'],
      alwaysTranslate: ['es'],
      neverTranslate: ['de', 'fr'],
      neverTranslateSites: ['example.com'],
      autoOffer: false
    })
  })

  it('tolerates garbage documents', () => {
    expect(sanitizePreferences(null, BASE)).toEqual(BASE)
    expect(sanitizePreferences('nope', BASE)).toEqual(BASE)
    expect(sanitizePreferences({ preferred: 'en' }, BASE).preferred).toEqual(['en'])
  })
})

describe('defaultTarget', () => {
  it('picks the first preferred language that differs from the source, else English', () => {
    const prefs = { ...BASE, preferred: ['de', 'en'] }
    expect(defaultTarget(prefs, 'es')).toBe('de')
    expect(defaultTarget(prefs, 'de')).toBe('en')
    expect(defaultTarget({ ...BASE, preferred: ['en'] }, 'en')).toBe('en')
    expect(defaultTarget({ ...BASE, preferred: ['de'] }, 'de')).toBe('en')
    expect(defaultTarget(prefs, null)).toBe('de')
  })
})

describe('offerFor', () => {
  it('applies the rules in order', () => {
    const prefs: TranslatePreferences = {
      preferred: ['en'],
      alwaysTranslate: ['es'],
      neverTranslate: ['de'],
      neverTranslateSites: ['example.com'],
      autoOffer: true
    }
    expect(offerFor(prefs, null, 'x.com')).toBe('none')
    expect(offerFor(prefs, 'en', 'x.com')).toBe('none')
    expect(offerFor(prefs, 'es', 'example.com')).toBe('none')
    expect(offerFor(prefs, 'de', 'x.com')).toBe('none')
    expect(offerFor(prefs, 'es', 'x.com')).toBe('translate')
    expect(offerFor(prefs, 'fr', 'x.com')).toBe('offer')
    expect(offerFor({ ...prefs, autoOffer: false }, 'fr', 'x.com')).toBe('none')
    expect(offerFor({ ...prefs, autoOffer: false }, 'es', 'x.com')).toBe('translate')
    expect(offerFor(prefs, 'fr', '')).toBe('offer')
  })
})

describe('rules', () => {
  it('moves a language between the always and never lists', () => {
    let prefs = withLanguageRule(BASE, 'es', 'always')
    expect(prefs.alwaysTranslate).toEqual(['es'])
    expect(languageRule(prefs, 'es')).toBe('always')
    prefs = withLanguageRule(prefs, 'es', 'never')
    expect(prefs.alwaysTranslate).toEqual([])
    expect(prefs.neverTranslate).toEqual(['es'])
    expect(languageRule(prefs, 'es')).toBe('never')
    prefs = withLanguageRule(prefs, 'es', 'ask')
    expect(prefs.neverTranslate).toEqual([])
    expect(languageRule(prefs, 'es')).toBe('ask')
  })

  it('adds and removes never-translate sites', () => {
    let prefs = withSiteRule(BASE, 'example.com', true)
    expect(prefs.neverTranslateSites).toEqual(['example.com'])
    prefs = withSiteRule(prefs, 'example.com', true)
    expect(prefs.neverTranslateSites).toEqual(['example.com'])
    prefs = withSiteRule(prefs, 'example.com', false)
    expect(prefs.neverTranslateSites).toEqual([])
    expect(withSiteRule(BASE, '', true).neverTranslateSites).toEqual([])
  })

  it('reorders the preferred list and drops always-translate entries the user now reads', () => {
    const prefs = withPreferred({ ...BASE, alwaysTranslate: ['es'] }, ['es-419', 'en'])
    expect(prefs.preferred).toEqual(['es', 'en'])
    expect(prefs.alwaysTranslate).toEqual([])
    expect(withPreferred(BASE, ['??'])).toBe(BASE)
  })
})

describe('siteOf', () => {
  it('keys web pages by their domain and nothing else', () => {
    expect(siteOf('https://www.example.com/path')).toBe(siteOf('https://example.com/'))
    expect(siteOf('http://news.example.co.uk/a')).toBe(siteOf('https://example.co.uk/'))
    expect(siteOf('file:///tmp/page.html')).toBe('')
    expect(siteOf('zen://reader/1')).toBe('')
  })
})
