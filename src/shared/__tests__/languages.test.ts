import { describe, expect, it } from 'vitest'
import {
  FALLBACK_LANGUAGES,
  LANGUAGES_MAX,
  acceptLanguageHeader,
  acceptLanguageList,
  baseLanguage,
  defaultLanguages,
  expandLanguages,
  languagesKey,
  normalizeLanguageTag,
  sanitizeLanguages
} from '../languages'

describe('normalizeLanguageTag', () => {
  it('puts a tag in canonical casing', () => {
    expect(normalizeLanguageTag('en-us')).toBe('en-US')
    expect(normalizeLanguageTag('EN')).toBe('en')
    expect(normalizeLanguageTag('zh-hant-tw')).toBe('zh-Hant-TW')
    expect(normalizeLanguageTag('es-419')).toBe('es-419')
    expect(normalizeLanguageTag('sr-latn')).toBe('sr-Latn')
  })

  it('reduces POSIX spellings to the tag and refuses what is no language', () => {
    expect(normalizeLanguageTag('en_US.UTF-8')).toBe('en-US')
    expect(normalizeLanguageTag('de_DE@euro')).toBe('de-DE')
    expect(normalizeLanguageTag(' fr ')).toBe('fr')
    expect(normalizeLanguageTag('C')).toBeNull()
    expect(normalizeLanguageTag('POSIX')).toBeNull()
    expect(normalizeLanguageTag('')).toBeNull()
    expect(normalizeLanguageTag('english')).toBeNull()
    expect(normalizeLanguageTag('en-')).toBeNull()
    expect(normalizeLanguageTag('e')).toBeNull()
  })

  it('names the base language of a tag', () => {
    expect(baseLanguage('en-US')).toBe('en')
    expect(baseLanguage('zh-Hant-TW')).toBe('zh')
    expect(baseLanguage('de')).toBe('de')
  })
})

describe('sanitizeLanguages', () => {
  it('canonicalises, deduplicates case-insensitively and bounds the list', () => {
    expect(sanitizeLanguages(['en-us', 'EN-US', 'en', 'de_DE', 'C', 7, ''])).toEqual([
      'en-US',
      'en',
      'de-DE'
    ])
    const many = Array.from({ length: 60 }, (_, i) => `x${String(i).padStart(2, '0')}`.slice(0, 3))
    expect(sanitizeLanguages(many).length).toBeLessThanOrEqual(LANGUAGES_MAX)
  })

  it('leaves the fallback standing when nothing valid is left', () => {
    expect(sanitizeLanguages([], ['fr'])).toEqual(['fr'])
    expect(sanitizeLanguages(['C', 'POSIX'], ['fr'])).toEqual(['fr'])
    expect(sanitizeLanguages('en', ['fr'])).toEqual(['fr'])
    expect(sanitizeLanguages(null)).toEqual([])
  })
})

describe('Chrome’s expansion and header', () => {
  it('puts each family’s base language after its last region variant, nothing twice', () => {
    expect(expandLanguages(['en-US', 'en-GB', 'de'])).toEqual(['en-US', 'en-GB', 'en', 'de'])
    expect(expandLanguages(['en-US', 'de-DE', 'en-GB'])).toEqual([
      'en-US',
      'en',
      'de-DE',
      'de',
      'en-GB'
    ])
    expect(expandLanguages(['en', 'en-US'])).toEqual(['en', 'en-US'])
    expect(expandLanguages(['zh-Hant-TW'])).toEqual(['zh-Hant-TW', 'zh'])
    expect(expandLanguages([])).toEqual([])
  })

  it('makes the list Electron’s session takes, never empty', () => {
    expect(acceptLanguageList(['de-DE', 'en'])).toBe('de-DE,de,en')
    expect(acceptLanguageList(['en-US', 'en'])).toBe('en-US,en')
    expect(acceptLanguageList([])).toBe(FALLBACK_LANGUAGES.join(','))
    expect(acceptLanguageList(['C'])).toBe('en-US,en')
  })

  it('weights the header in descending tenths down to q=0.1, as Chromium sends it', () => {
    expect(acceptLanguageHeader(['en-US', 'en'])).toBe('en-US,en;q=0.9')
    expect(acceptLanguageHeader(['de-DE', 'en-GB', 'fr'])).toBe(
      'de-DE,de;q=0.9,en-GB;q=0.8,en;q=0.7,fr;q=0.6'
    )
    const twelve = ['aa', 'ab', 'ae', 'af', 'ak', 'am', 'an', 'ar', 'as', 'av', 'ay', 'az']
    const header = acceptLanguageHeader(twelve)
    expect(header.split(',').slice(7, 12)).toEqual([
      'ar;q=0.3',
      'as;q=0.2',
      'av;q=0.1',
      'ay;q=0.1',
      'az;q=0.1'
    ])
  })
})

describe('defaultLanguages', () => {
  it('starts a fresh profile from the OS languages, the UI locale first, expanded like Chrome’s', () => {
    expect(defaultLanguages(['en-US', 'en-US', 'de-DE'])).toEqual(['en-US', 'en', 'de-DE', 'de'])
    expect(defaultLanguages(['en_US.UTF-8'])).toEqual(['en-US', 'en'])
    expect(defaultLanguages(['C', ''])).toEqual(['en-US', 'en'])
    expect(defaultLanguages([])).toEqual(['en-US', 'en'])
  })

  it('has one key per list for change detection', () => {
    expect(languagesKey(['en-US', 'en'])).toBe('en-US,en')
    expect(languagesKey([])).toBe('')
  })
})
