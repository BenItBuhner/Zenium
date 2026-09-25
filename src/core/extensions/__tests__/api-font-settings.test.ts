import { describe, expect, it } from 'vitest'
import { DEFAULT_FONT_SETTINGS } from '../../../shared/fonts'
import {
  COMMON_SCRIPT,
  CONSTANTS,
  FONT_PREFS,
  SCRIPT_CODES,
  controllableSlot,
  defaultFixedFontSizeResult,
  defaultFontSizeResult,
  familyList,
  fontResult,
  hasFontValues,
  layerFonts,
  minimumFontSizeResult,
  normalizeFontDetails,
  normalizeFontValues,
  normalizeSetFontDetails,
  normalizeSizeDetails,
  sameLayered,
  withFontValue,
  type FontValues
} from '../api/fontSettings'
import { API_SPEC } from '../api/spec'

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

/** Installed most recently first: NEW outranks OLD. */
const rank = (id: string): number | undefined => (id === NEW ? 0 : id === OLD ? 1 : undefined)

describe('fontSettings details (Chrome\u2019s shapes)', () => {
  it('reads getFont / clearFont details with the common script as the default', () => {
    expect(normalizeFontDetails({ genericFamily: 'standard' })).toEqual({
      script: COMMON_SCRIPT,
      genericFamily: 'standard'
    })
    expect(normalizeFontDetails({ genericFamily: 'fixed', script: 'Arab' })).toEqual({
      script: 'Arab',
      genericFamily: 'fixed'
    })
    expect(() => normalizeFontDetails({})).toThrow("Missing required property 'genericFamily'.")
    expect(() => normalizeFontDetails({ genericFamily: 'monospace' })).toThrow(
      "Invalid value for 'genericFamily': expected one of standard, sansserif, serif, fixed, cursive, fantasy, math."
    )
    expect(() => normalizeFontDetails({ genericFamily: 'serif', script: 'Latin' })).toThrow(
      "Invalid value for 'script'"
    )
    expect(() => normalizeFontDetails('standard')).toThrow('Invalid details.')
  })

  it('requires a string fontId on setFont and trims it', () => {
    expect(normalizeSetFontDetails({ genericFamily: 'serif', fontId: ' Georgia ' })).toEqual({
      script: COMMON_SCRIPT,
      genericFamily: 'serif',
      fontId: 'Georgia'
    })
    expect(() => normalizeSetFontDetails({ genericFamily: 'serif' })).toThrow(
      "Missing required property 'fontId'."
    )
    expect(() => normalizeSetFontDetails({ genericFamily: 'serif', fontId: 3 })).toThrow(
      "Invalid value for 'fontId': expected a string."
    )
  })

  it('takes integer pixel sizes and brings them into the setting\u2019s range', () => {
    expect(normalizeSizeDetails({ pixelSize: 20 }, 'size')).toBe(20)
    expect(normalizeSizeDetails({ pixelSize: 3 }, 'size')).toBe(9)
    expect(normalizeSizeDetails({ pixelSize: 300 }, 'size')).toBe(72)
    expect(normalizeSizeDetails({ pixelSize: 0 }, 'minimumSize')).toBe(0)
    expect(normalizeSizeDetails({ pixelSize: 4 }, 'minimumSize')).toBe(6)
    expect(normalizeSizeDetails({ pixelSize: 40 }, 'minimumSize')).toBe(24)
    expect(() => normalizeSizeDetails({}, 'size')).toThrow("Missing required property 'pixelSize'.")
    expect(() => normalizeSizeDetails({ pixelSize: 12.5 }, 'size')).toThrow(
      "Invalid value for 'pixelSize': expected an integer."
    )
  })

  it('has Chrome\u2019s enums: 152 script codes with Zyyy, seven generic families, four levels', () => {
    expect(SCRIPT_CODES).toHaveLength(152)
    expect(SCRIPT_CODES.at(-1)).toBe('Zyyy')
    expect(new Set(SCRIPT_CODES).size).toBe(152)
    expect(CONSTANTS.ScriptCode.ARAB).toBe('Arab')
    expect(CONSTANTS.ScriptCode.ZYYY).toBe('Zyyy')
    expect(Object.keys(CONSTANTS.GenericFamily)).toEqual([
      'STANDARD',
      'SANSSERIF',
      'SERIF',
      'FIXED',
      'CURSIVE',
      'FANTASY',
      'MATH'
    ])
    expect(CONSTANTS.LevelOfControl.CONTROLLED_BY_THIS_EXTENSION).toBe(
      'controlled_by_this_extension'
    )
  })

  it('is in the desktop table as a permission-gated namespace with the events and constants', () => {
    const ns = API_SPEC.fontSettings
    expect(ns.permissions).toEqual(['fontSettings'])
    expect(Object.keys(ns.methods).sort()).toEqual(
      [
        'clearDefaultFixedFontSize',
        'clearDefaultFontSize',
        'clearFont',
        'clearMinimumFontSize',
        'getDefaultFixedFontSize',
        'getDefaultFontSize',
        'getFont',
        'getFontList',
        'getMinimumFontSize',
        'setDefaultFixedFontSize',
        'setDefaultFontSize',
        'setFont',
        'setMinimumFontSize'
      ].sort()
    )
    expect(Object.keys(ns.events)).toEqual([
      'onFontChanged',
      'onDefaultFontSizeChanged',
      'onDefaultFixedFontSizeChanged',
      'onMinimumFontSizeChanged'
    ])
    expect(ns.constants).toBe(CONSTANTS)
  })
})

describe('fontSettings values', () => {
  it('controls the common script of the four slotted families only', () => {
    expect(controllableSlot({ script: 'Zyyy', genericFamily: 'standard' })).toBe('standard')
    expect(controllableSlot({ script: 'Zyyy', genericFamily: 'sansserif' })).toBe('sansSerif')
    expect(controllableSlot({ script: 'Zyyy', genericFamily: 'serif' })).toBe('serif')
    expect(controllableSlot({ script: 'Zyyy', genericFamily: 'fixed' })).toBe('fixed')
    expect(controllableSlot({ script: 'Zyyy', genericFamily: 'cursive' })).toBeNull()
    expect(controllableSlot({ script: 'Latn', genericFamily: 'standard' })).toBeNull()
  })

  it('sets, replaces and clears one extension\u2019s values, reporting whether anything moved', () => {
    const values: FontValues = {}
    expect(withFontValue(values, 'standard', 'Georgia')).toBe(true)
    expect(withFontValue(values, 'standard', 'Georgia')).toBe(false)
    expect(withFontValue(values, 'size', 20)).toBe(true)
    expect(values).toEqual({ families: { standard: 'Georgia' }, size: 20 })
    // Chrome's `setFont` with an empty name is a clear.
    expect(withFontValue(values, 'standard', '')).toBe(true)
    expect(withFontValue(values, 'standard', undefined)).toBe(false)
    expect(values).toEqual({ size: 20 })
    expect(hasFontValues(values)).toBe(true)
    expect(withFontValue(values, 'size', undefined)).toBe(true)
    expect(hasFontValues(values)).toBe(false)
  })

  it('brings a stored record into shape', () => {
    expect(
      normalizeFontValues({
        families: { standard: ' Georgia ', fixed: '', cursive: 'Comic', serif: 7 },
        size: 500,
        minimumSize: 2.5,
        extra: true
      })
    ).toEqual({ families: { standard: 'Georgia' }, size: 72 })
    expect(normalizeFontValues(null)).toEqual({})
    expect(normalizeFontValues({ minimumSize: 3 })).toEqual({ minimumSize: 6 })
  })

  it('lays the first-ranked extension\u2019s value over the user\u2019s, preference by preference', () => {
    const user = { ...DEFAULT_FONT_SETTINGS, serif: 'Georgia', size: 18 }
    const layers = new Map<string, FontValues>([
      [OLD, { families: { standard: 'Arimo', serif: 'Tinos' }, size: 20, minimumSize: 12 }],
      [NEW, { families: { standard: 'Cantarell' }, size: 24 }],
      ['not-loaded', { families: { fixed: 'Cousine' } }]
    ])
    const layered = layerFonts(user, layers, rank)
    expect(layered.fonts).toEqual({
      standard: 'Cantarell',
      serif: 'Tinos',
      sansSerif: null,
      fixed: null,
      size: 24,
      minimumSize: 12
    })
    expect(layered.controllers).toEqual({
      standard: NEW,
      serif: OLD,
      sansSerif: null,
      fixed: null,
      size: NEW,
      minimumSize: OLD
    })
    expect(FONT_PREFS).toEqual(['standard', 'serif', 'sansSerif', 'fixed', 'size', 'minimumSize'])
    // Nothing set: the user's setting stands, nobody controls anything.
    const plain = layerFonts(user, new Map(), rank)
    expect(plain.fonts).toEqual(user)
    expect(Object.values(plain.controllers).every((c) => c === null)).toBe(true)
    expect(sameLayered(plain, layerFonts(user, new Map(), rank))).toBe(true)
    expect(sameLayered(plain, layered)).toBe(false)
  })
})

describe('fontSettings answers', () => {
  const user = { ...DEFAULT_FONT_SETTINGS, serif: 'Georgia' }
  const layered = layerFonts(
    user,
    new Map<string, FontValues>([[NEW, { families: { standard: 'Cantarell' }, size: 20 }]]),
    rank
  )

  it('answers getFont with the family the pages have and the caller\u2019s say over it', () => {
    expect(
      fontResult({ script: 'Zyyy', genericFamily: 'standard' }, layered, NEW, 'linux')
    ).toEqual({
      fontId: 'Cantarell',
      levelOfControl: 'controlled_by_this_extension'
    })
    expect(
      fontResult({ script: 'Zyyy', genericFamily: 'standard' }, layered, OLD, 'linux')
    ).toEqual({
      fontId: 'Cantarell',
      levelOfControl: 'controlled_by_other_extensions'
    })
    expect(fontResult({ script: 'Zyyy', genericFamily: 'serif' }, layered, OLD, 'linux')).toEqual({
      fontId: 'Georgia',
      levelOfControl: 'controllable_by_this_extension'
    })
    // A slot the user left to the platform reads as the engine's default for it.
    expect(fontResult({ script: 'Zyyy', genericFamily: 'fixed' }, layered, OLD, 'darwin')).toEqual({
      fontId: 'Menlo',
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(
      fontResult({ script: 'Zyyy', genericFamily: 'sansserif' }, layered, OLD, 'win32')
    ).toEqual({ fontId: 'Arial', levelOfControl: 'controllable_by_this_extension' })
  })

  it('answers not_controllable, with the empty name, for per-script and slotless families', () => {
    expect(
      fontResult({ script: 'Arab', genericFamily: 'standard' }, layered, NEW, 'linux')
    ).toEqual({ fontId: '', levelOfControl: 'not_controllable' })
    expect(fontResult({ script: 'Zyyy', genericFamily: 'cursive' }, layered, NEW, 'linux')).toEqual(
      {
        fontId: '',
        levelOfControl: 'not_controllable'
      }
    )
  })

  it('answers the sizes: the size and the minimum controllable, the fixed size derived', () => {
    expect(defaultFontSizeResult(layered, NEW)).toEqual({
      pixelSize: 20,
      levelOfControl: 'controlled_by_this_extension'
    })
    expect(defaultFontSizeResult(layered, OLD)).toEqual({
      pixelSize: 20,
      levelOfControl: 'controlled_by_other_extensions'
    })
    expect(defaultFixedFontSizeResult(layered)).toEqual({
      pixelSize: 16,
      levelOfControl: 'not_controllable'
    })
    expect(minimumFontSizeResult(layered, OLD)).toEqual({
      pixelSize: 0,
      levelOfControl: 'controllable_by_this_extension'
    })
  })

  it('lists the installed families once each, sorted by name', () => {
    expect(familyList(['Tinos', ' Arimo', 'cantarell', 'Arimo', '', 'DejaVu Sans'])).toEqual([
      { fontId: 'Arimo', displayName: 'Arimo' },
      { fontId: 'cantarell', displayName: 'cantarell' },
      { fontId: 'DejaVu Sans', displayName: 'DejaVu Sans' },
      { fontId: 'Tinos', displayName: 'Tinos' }
    ])
  })
})
