import { describe, expect, it } from 'vitest'
import {
  COMMON_SCRIPT,
  DEFAULT_FONT_SIZE_PREF,
  FONT_SIZE_METHODS,
  FONT_SIZE_PREFS,
  GENERIC_FAMILIES,
  INVALID_FONT_ID_ERROR,
  MINIMUM_FONT_SIZE_PREF,
  SCRIPT_CODES,
  controllerOf,
  effectivePref,
  fontChangedDetails,
  fontListOf,
  fontPrefKey,
  fontResult,
  fontSizeResult,
  isValidFontId,
  levelOfControlFor,
  normalizeFontDetails,
  normalizeFontPrefValues,
  normalizePixelSize,
  normalizeSetFontDetails,
  normalizeUnusedDetails,
  parseFontPrefKey,
  sameEffective,
  type FontRank
} from '../api/fontSettings'

const rankOf =
  (order: string[]): FontRank =>
  (id) => {
    const i = order.indexOf(id)
    return i === -1 ? undefined : i
  }

describe('fontSettings enums and pref keys', () => {
  it("names Chrome's seven generic families and 152 script codes, Zyyy the common one", () => {
    expect([...GENERIC_FAMILIES]).toEqual([
      'standard',
      'sansserif',
      'serif',
      'fixed',
      'cursive',
      'fantasy',
      'math'
    ])
    expect(SCRIPT_CODES).toHaveLength(152)
    expect(new Set(SCRIPT_CODES).size).toBe(152)
    expect(COMMON_SCRIPT).toBe('Zyyy')
    expect(SCRIPT_CODES).toContain('Jpan')
    expect(SCRIPT_CODES).toContain('Cyrl')
  })

  it("builds and parses Chrome's pref paths", () => {
    expect(fontPrefKey('standard', 'Zyyy')).toBe('webkit.webprefs.fonts.standard.Zyyy')
    expect(parseFontPrefKey('webkit.webprefs.fonts.fixed.Jpan')).toEqual({
      genericFamily: 'fixed',
      script: 'Jpan'
    })
    expect(parseFontPrefKey('webkit.webprefs.fonts.bogus.Jpan')).toBeUndefined()
    expect(parseFontPrefKey('webkit.webprefs.fonts.fixed.Zzzz')).toBeUndefined()
    expect(parseFontPrefKey(DEFAULT_FONT_SIZE_PREF)).toBeUndefined()
    expect(FONT_SIZE_PREFS).toEqual([
      'webkit.webprefs.default_font_size',
      'webkit.webprefs.default_fixed_font_size',
      'webkit.webprefs.minimum_font_size'
    ])
    expect(FONT_SIZE_METHODS[MINIMUM_FONT_SIZE_PREF]).toEqual({
      get: 'getMinimumFontSize',
      set: 'setMinimumFontSize',
      clear: 'clearMinimumFontSize',
      event: 'onMinimumFontSizeChanged'
    })
  })
})

describe('fontSettings argument shapes', () => {
  it('takes genericFamily with an optional script that defaults to Zyyy', () => {
    expect(normalizeFontDetails({ genericFamily: 'serif' })).toEqual({
      genericFamily: 'serif',
      script: 'Zyyy'
    })
    expect(normalizeFontDetails({ genericFamily: 'fixed', script: 'Hang' })).toEqual({
      genericFamily: 'fixed',
      script: 'Hang'
    })
    expect(() => normalizeFontDetails(undefined)).toThrow("Missing required argument 'details'.")
    expect(() => normalizeFontDetails({})).toThrow("Missing required property 'genericFamily'.")
    expect(() => normalizeFontDetails({ genericFamily: 'monospace' })).toThrow(
      /Invalid value for 'genericFamily'/
    )
    expect(() => normalizeFontDetails({ genericFamily: 'serif', script: 'Latin' })).toThrow(
      /Invalid value for 'script'/
    )
  })

  it("checks fontId as Chrome's IsValidFontName does", () => {
    expect(isValidFontId('')).toBe(true)
    expect(isValidFontId('Noto Sans CJK JP')).toBe(true)
    expect(isValidFontId('Source-Code_Pro.v2+')).toBe(true)
    expect(isValidFontId('游ゴシック')).toBe(true)
    expect(isValidFontId('Arial;')).toBe(false)
    expect(isValidFontId('"Arial"')).toBe(false)
    expect(isValidFontId('Arial\n')).toBe(false)
    expect(isValidFontId('a'.repeat(256))).toBe(true)
    expect(isValidFontId('a'.repeat(257))).toBe(false)
    expect(isValidFontId('游'.repeat(86))).toBe(false)
    expect(normalizeSetFontDetails({ genericFamily: 'standard', fontId: 'Verdana' })).toEqual({
      genericFamily: 'standard',
      script: 'Zyyy',
      fontId: 'Verdana'
    })
    expect(normalizeSetFontDetails({ genericFamily: 'standard', fontId: '' }).fontId).toBe('')
    expect(() => normalizeSetFontDetails({ genericFamily: 'standard' })).toThrow(
      "Missing required property 'fontId'."
    )
    expect(() => normalizeSetFontDetails({ genericFamily: 'standard', fontId: 12 })).toThrow(
      "Invalid value for 'fontId': expected string."
    )
    expect(() => normalizeSetFontDetails({ genericFamily: 'standard', fontId: 'A,B' })).toThrow(
      INVALID_FONT_ID_ERROR
    )
  })

  it("takes pixelSize as Chrome's schema does: a required integer, any sign", () => {
    expect(normalizePixelSize({ pixelSize: 18 })).toBe(18)
    expect(normalizePixelSize({ pixelSize: 0 })).toBe(0)
    expect(() => normalizePixelSize({})).toThrow("Missing required property 'pixelSize'.")
    expect(() => normalizePixelSize({ pixelSize: 16.5 })).toThrow(
      "Invalid value for 'pixelSize': expected integer."
    )
    expect(() => normalizePixelSize({ pixelSize: '16' })).toThrow(/expected integer/)
    expect(() => normalizePixelSize(undefined)).toThrow("Missing required argument 'details'.")
  })

  it('lets the unused details of the getters and clears be absent or an object', () => {
    expect(() => normalizeUnusedDetails(undefined)).not.toThrow()
    expect(() => normalizeUnusedDetails({})).not.toThrow()
    expect(() => normalizeUnusedDetails([])).toThrow('Invalid details.')
    expect(() => normalizeUnusedDetails('x')).toThrow('Invalid details.')
  })
})

describe('fontSettings precedence and levelOfControl', () => {
  const rank = rankOf(['newest', 'middle', 'oldest'])

  it('lets the most recently installed enabled extension control a pref', () => {
    const values = new Map<string, string | number>([
      ['oldest', 'Georgia'],
      ['middle', 'Verdana']
    ])
    expect(controllerOf(values, rank)).toEqual({ extensionId: 'middle', value: 'Verdana' })
    values.set('newest', 'Arial')
    expect(controllerOf(values, rank)).toEqual({ extensionId: 'newest', value: 'Arial' })
    expect(controllerOf(values, rankOf(['oldest']))).toEqual({
      extensionId: 'oldest',
      value: 'Georgia'
    })
    expect(controllerOf(new Map(), rank)).toBeUndefined()
  })

  it("answers Chrome's four levels: controlled, controllable when newer than the controller, else other", () => {
    expect(levelOfControlFor(null, 'middle', rank)).toBe('controllable_by_this_extension')
    expect(levelOfControlFor('middle', 'middle', rank)).toBe('controlled_by_this_extension')
    expect(levelOfControlFor('middle', 'newest', rank)).toBe('controllable_by_this_extension')
    expect(levelOfControlFor('middle', 'oldest', rank)).toBe('controlled_by_other_extensions')
    expect(levelOfControlFor('middle', 'unknown', rank)).toBe('controlled_by_other_extensions')
  })

  it('falls back to the browser value and reports it with the level per caller', () => {
    const none = effectivePref<string>(new Map(), 'Times New Roman', rank)
    expect(none).toEqual({ value: 'Times New Roman', controller: null })
    expect(fontResult(none, 'oldest', rank)).toEqual({
      fontId: 'Times New Roman',
      levelOfControl: 'controllable_by_this_extension'
    })
    const set = effectivePref<string>(new Map([['oldest', 'Georgia']]), 'Times New Roman', rank)
    expect(set).toEqual({ value: 'Georgia', controller: 'oldest' })
    expect(fontResult(set, 'oldest', rank).levelOfControl).toBe('controlled_by_this_extension')
    expect(fontResult(set, 'newest', rank).levelOfControl).toBe('controllable_by_this_extension')
    expect(sameEffective(set, { value: 'Georgia', controller: 'oldest' })).toBe(true)
    expect(sameEffective(set, { value: 'Georgia', controller: null })).toBe(false)
    const size = effectivePref<number>(new Map([['middle', 20]]), 16, rank)
    expect(fontSizeResult(size, 'oldest', rank)).toEqual({
      pixelSize: 20,
      levelOfControl: 'controlled_by_other_extensions'
    })
  })

  it('builds onFontChanged details with the script always named', () => {
    const effective = effectivePref<string>(new Map([['newest', 'Arial']]), 'Times', rank)
    expect(
      fontChangedDetails({ genericFamily: 'standard', script: 'Zyyy' }, effective, 'middle', rank)
    ).toEqual({
      fontId: 'Arial',
      levelOfControl: 'controlled_by_other_extensions',
      script: 'Zyyy',
      genericFamily: 'standard'
    })
  })
})

describe('fontSettings font list and persistence', () => {
  it('lists distinct trimmed families in code point order, hidden ones left out', () => {
    expect(fontListOf(['Verdana', ' Arial ', 'arial', '.SF NS', '', 'Arial', 'Ébène'])).toEqual([
      { fontId: 'Arial', displayName: 'Arial' },
      { fontId: 'Verdana', displayName: 'Verdana' },
      { fontId: 'arial', displayName: 'arial' },
      { fontId: 'Ébène', displayName: 'Ébène' }
    ])
  })

  it('reads persisted values back, dropping keys and values that do not fit', () => {
    expect(
      normalizeFontPrefValues({
        'webkit.webprefs.fonts.standard.Zyyy': 'Verdana',
        'webkit.webprefs.fonts.serif.Jpan': 'Bad;Name',
        'webkit.webprefs.fonts.serif.Zzzz': 'Georgia',
        'webkit.webprefs.default_font_size': 18,
        'webkit.webprefs.minimum_font_size': 12.5,
        other: 'x'
      })
    ).toEqual({
      'webkit.webprefs.fonts.standard.Zyyy': 'Verdana',
      'webkit.webprefs.default_font_size': 18
    })
    expect(normalizeFontPrefValues(null)).toEqual({})
    expect(normalizeFontPrefValues([1])).toEqual({})
  })
})
