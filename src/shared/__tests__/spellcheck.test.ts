import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SPELLCHECK,
  SPELLCHECK_LANGUAGES_MAX,
  dictionaryFor,
  isSpellcheckLanguageCode,
  orderSpellcheckLanguages,
  resolveSpellcheckLanguages,
  sanitizeSpellcheck,
  spellcheckLanguageName,
  withSpellcheckLanguage,
  type SpellcheckLanguage
} from '../spellcheck'

const AVAILABLE = ['en-US', 'en-GB', 'de', 'fr', 'pt-BR', 'pt-PT', 'es', 'nl']

describe('spell check settings', () => {
  it('sanitises stored settings of any shape', () => {
    expect(sanitizeSpellcheck(undefined)).toEqual(DEFAULT_SPELLCHECK)
    expect(sanitizeSpellcheck({ enabled: 'yes', languages: 'en' })).toEqual(DEFAULT_SPELLCHECK)
    expect(
      sanitizeSpellcheck({ enabled: false, languages: ['en-US', 'de', 'en-US', 42, 'x', 'pt-BR'] })
    ).toEqual({ enabled: false, languages: ['en-US', 'de', 'pt-BR'] })
    // Never more than Chrome's handful.
    const many = ['en-US', 'de', 'fr', 'es', 'nl', 'pt-BR', 'it']
    expect(sanitizeSpellcheck({ languages: many }).languages).toHaveLength(SPELLCHECK_LANGUAGES_MAX)
  })

  it('recognises dictionary codes the way Chromium spells them', () => {
    expect(isSpellcheckLanguageCode('en-US')).toBe(true)
    expect(isSpellcheckLanguageCode('de')).toBe(true)
    expect(isSpellcheckLanguageCode('sr-Latn')).toBe(true)
    expect(isSpellcheckLanguageCode('english')).toBe(false)
    expect(isSpellcheckLanguageCode('')).toBe(false)
    expect(isSpellcheckLanguageCode(null)).toBe(false)
  })

  it('finds the dictionary of a UI locale: exact, then the language with the host’s first region', () => {
    expect(dictionaryFor('en-US', AVAILABLE)).toBe('en-US')
    expect(dictionaryFor('en_GB', AVAILABLE)).toBe('en-GB')
    expect(dictionaryFor('en', AVAILABLE)).toBe('en-US')
    expect(dictionaryFor('de-AT', AVAILABLE)).toBe('de')
    expect(dictionaryFor('pt', AVAILABLE)).toBe('pt-BR')
    expect(dictionaryFor('ja', AVAILABLE)).toBeNull()
    expect(dictionaryFor('', AVAILABLE)).toBeNull()
  })

  it('resolves the chosen languages the host has, or the UI language’s dictionary when none was chosen', () => {
    expect(
      resolveSpellcheckLanguages({ enabled: true, languages: ['de', 'en-US'] }, AVAILABLE, ['fr'])
    ).toEqual(['de', 'en-US'])
    // A chosen language the host lacks is skipped; a region the host lacks falls to the language.
    expect(
      resolveSpellcheckLanguages({ enabled: true, languages: ['ja', 'de-CH'] }, AVAILABLE, ['fr'])
    ).toEqual(['de'])
    // A fresh profile: the first UI locale with a dictionary.
    expect(
      resolveSpellcheckLanguages(DEFAULT_SPELLCHECK, AVAILABLE, ['ja', 'pt-BR', 'en'])
    ).toEqual(['pt-BR'])
    // Nothing chosen and no UI locale has one: nothing to check in.
    expect(resolveSpellcheckLanguages(DEFAULT_SPELLCHECK, AVAILABLE, ['ja'])).toEqual([])
    expect(resolveSpellcheckLanguages(DEFAULT_SPELLCHECK, [], ['en'])).toEqual([])
  })

  it('toggles one language: added at the end, removed, never past the limit', () => {
    const chosen = { enabled: true, languages: ['en-US'] }
    expect(withSpellcheckLanguage(chosen, ['en-US'], 'de', true)).toEqual({
      enabled: true,
      languages: ['en-US', 'de']
    })
    expect(
      withSpellcheckLanguage({ enabled: true, languages: ['en-US', 'de'] }, [], 'en-us', false)
    ).toEqual({ enabled: true, languages: ['de'] })
    const full = { enabled: true, languages: ['en-US', 'de', 'fr', 'es', 'nl'] }
    expect(withSpellcheckLanguage(full, full.languages, 'pt-BR', true)).toBe(full)
  })

  it('turns a language off in a profile that never chose any without emptying the list back to the default', () => {
    // The UI-locale default is en-US; a German dictionary was added through the menu.
    const added = withSpellcheckLanguage(DEFAULT_SPELLCHECK, ['en-US'], 'de', true)
    expect(added.languages).toEqual(['en-US', 'de'])
    expect(withSpellcheckLanguage(DEFAULT_SPELLCHECK, ['en-US', 'de'], 'en-US', false)).toEqual({
      enabled: true,
      languages: ['de']
    })
  })

  it('turning the last language off turns the checker off and keeps the language for the switch', () => {
    expect(
      withSpellcheckLanguage({ enabled: true, languages: ['de'] }, ['de'], 'de', false)
    ).toEqual({ enabled: false, languages: ['de'] })
    // The UI-locale default, never stored, is stored once it is the language switched off.
    expect(withSpellcheckLanguage(DEFAULT_SPELLCHECK, ['en-US'], 'en-US', false)).toEqual({
      enabled: false,
      languages: ['en-US']
    })
    // Nothing checked in at all: nothing to switch off.
    expect(withSpellcheckLanguage(DEFAULT_SPELLCHECK, [], 'en-US', false)).toBe(DEFAULT_SPELLCHECK)
  })

  it('names dictionaries as Chrome’s list does, with a table behind Intl', () => {
    expect(spellcheckLanguageName('en-US')).toBe('English (United States)')
    expect(spellcheckLanguageName('de')).toBe('German')
    expect(spellcheckLanguageName('pt-BR')).toBe('Portuguese (Brazil)')
    // An unknown code comes back as itself rather than nothing.
    expect(spellcheckLanguageName('zz-ZZ')).toBe('zz-ZZ')
  })

  it('lists the checked languages first in their order, the rest by name', () => {
    const language = (code: string, enabled: boolean): SpellcheckLanguage => ({
      code,
      name: spellcheckLanguageName(code),
      enabled,
      status: 'unknown'
    })
    const ordered = orderSpellcheckLanguages([
      language('nl', false),
      language('de', true),
      language('fr', false),
      language('en-US', true),
      language('es', false)
    ])
    expect(ordered.map((l) => l.code)).toEqual(['de', 'en-US', 'nl', 'fr', 'es'])
  })
})
