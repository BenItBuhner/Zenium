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
  extraPref,
  extraValueOf,
  familyKey,
  layerHolds,
  pageFontLayer,
  parseFamilyKey,
  sameLayered,
  scriptDefault,
  withExtraValue,
  withFixedSize,
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

  it('answers per-script and slotless families with the engine\u2019s own, controllable, until an extension names them', () => {
    // Linux installs no per-script family: Chrome's empty name, "the Default font".
    expect(
      fontResult({ script: 'Arab', genericFamily: 'standard' }, layered, NEW, 'linux')
    ).toEqual({ fontId: '', levelOfControl: 'controllable_by_this_extension' })
    // Electron's per-script tables on macOS and Windows, the browser locale's own script left out.
    expect(fontResult({ script: 'Jpan', genericFamily: 'serif' }, layered, NEW, 'darwin')).toEqual({
      fontId: 'Hiragino Mincho ProN',
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(
      fontResult({ script: 'Jpan', genericFamily: 'standard' }, layered, NEW, 'win32', {
        locale: 'en-US',
        installed: new Set(['Meiryo', 'Yu Gothic'])
      })
    ).toEqual({ fontId: 'Meiryo', levelOfControl: 'controllable_by_this_extension' })
    expect(
      fontResult({ script: 'Jpan', genericFamily: 'standard' }, layered, NEW, 'win32', {
        locale: 'ja',
        installed: null
      })
    ).toEqual({ fontId: '', levelOfControl: 'controllable_by_this_extension' })
    // The slotless three are the engine's own (Electron's cursive; Blink's fantasy and math).
    expect(fontResult({ script: 'Zyyy', genericFamily: 'cursive' }, layered, NEW, 'linux')).toEqual(
      { fontId: 'Comic Sans MS', levelOfControl: 'controllable_by_this_extension' }
    )
    expect(fontResult({ script: 'Zyyy', genericFamily: 'math' }, layered, OLD, 'darwin')).toEqual({
      fontId: 'Latin Modern Math',
      levelOfControl: 'controllable_by_this_extension'
    })
    const held = layerFonts(
      user,
      new Map<string, FontValues>([
        [
          NEW,
          { extras: { cursive: 'Zapfino' }, scripts: { Arab: { standard: 'Noto Naskh Arabic' } } }
        ]
      ]),
      rank
    )
    expect(fontResult({ script: 'Zyyy', genericFamily: 'cursive' }, held, NEW, 'linux')).toEqual({
      fontId: 'Zapfino',
      levelOfControl: 'controlled_by_this_extension'
    })
    expect(fontResult({ script: 'Arab', genericFamily: 'standard' }, held, OLD, 'linux')).toEqual({
      fontId: 'Noto Naskh Arabic',
      levelOfControl: 'controlled_by_other_extensions'
    })
    expect(fontResult({ script: 'Arab', genericFamily: 'serif' }, held, OLD, 'linux')).toEqual({
      fontId: '',
      levelOfControl: 'controllable_by_this_extension'
    })
  })

  it('answers the sizes: the size and the minimum, and the fixed-width size – the size\u2019s companion until an extension sets it', () => {
    expect(defaultFontSizeResult(layered, NEW)).toEqual({
      pixelSize: 20,
      levelOfControl: 'controlled_by_this_extension'
    })
    expect(defaultFontSizeResult(layered, OLD)).toEqual({
      pixelSize: 20,
      levelOfControl: 'controlled_by_other_extensions'
    })
    expect(defaultFixedFontSizeResult(layered, OLD)).toEqual({
      pixelSize: 16,
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(minimumFontSizeResult(layered, OLD)).toEqual({
      pixelSize: 0,
      levelOfControl: 'controllable_by_this_extension'
    })
    const fixed = layerFonts(
      user,
      new Map<string, FontValues>([[OLD, { size: 20, fixedSize: 18 }]]),
      rank
    )
    expect(defaultFixedFontSizeResult(fixed, OLD)).toEqual({
      pixelSize: 18,
      levelOfControl: 'controlled_by_this_extension'
    })
    expect(defaultFixedFontSizeResult(fixed, NEW)).toEqual({
      pixelSize: 18,
      levelOfControl: 'controlled_by_other_extensions'
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

describe('fontSettings beside the setting (per-script and slotless families, the fixed-width size)', () => {
  it('names the preference behind details the setting has no slot for', () => {
    expect(extraPref({ script: 'Zyyy', genericFamily: 'cursive' })).toEqual({
      kind: 'extra',
      family: 'cursive'
    })
    expect(extraPref({ script: 'Jpan', genericFamily: 'sansserif' })).toEqual({
      kind: 'script',
      script: 'Jpan',
      slot: 'sansSerif'
    })
    expect(extraPref({ script: 'Arab', genericFamily: 'fantasy' })).toEqual({
      kind: 'script',
      script: 'Arab',
      slot: 'fantasy'
    })
    expect(familyKey('sansSerif', 'Jpan')).toBe('sansSerif.Jpan')
    expect(parseFamilyKey('sansSerif.Jpan')).toEqual({ slot: 'sansSerif', script: 'Jpan' })
    expect(parseFamilyKey('fixedSize')).toBeNull()
    expect(parseFamilyKey('bogus.Jpan')).toBeNull()
  })

  it('sets, replaces and clears them in one extension\u2019s values, reporting whether anything moved', () => {
    const values: FontValues = {}
    const cursive = extraPref({ script: 'Zyyy', genericFamily: 'cursive' })
    const jpan = extraPref({ script: 'Jpan', genericFamily: 'standard' })
    expect(withExtraValue(values, cursive, 'Zapfino')).toBe(true)
    expect(withExtraValue(values, cursive, 'Zapfino')).toBe(false)
    expect(withExtraValue(values, jpan, 'Noto Sans JP')).toBe(true)
    expect(withFixedSize(values, 14)).toBe(true)
    expect(withFixedSize(values, 14)).toBe(false)
    expect(values).toEqual({
      extras: { cursive: 'Zapfino' },
      scripts: { Jpan: { standard: 'Noto Sans JP' } },
      fixedSize: 14
    })
    expect(extraValueOf(values, jpan)).toBe('Noto Sans JP')
    expect(
      extraValueOf(values, extraPref({ script: 'Jpan', genericFamily: 'serif' }))
    ).toBeUndefined()
    expect(hasFontValues(values)).toBe(true)
    // Chrome's `setFont` with an empty name is a clear; an emptied script or record goes away.
    expect(withExtraValue(values, cursive, '')).toBe(true)
    expect(withExtraValue(values, jpan, undefined)).toBe(true)
    expect(withExtraValue(values, jpan, undefined)).toBe(false)
    expect(values).toEqual({ fixedSize: 14 })
    expect(withFixedSize(values, undefined)).toBe(true)
    expect(values).toEqual({})
    expect(hasFontValues(values)).toBe(false)
  })

  it('brings a stored record with them into shape', () => {
    expect(
      normalizeFontValues({
        extras: { cursive: ' Zapfino ', fantasy: '', math: 3, standard: 'no' },
        scripts: {
          Jpan: { standard: 'Noto Sans JP', bogus: 'x', serif: '' },
          Zyyy: { standard: 'not a script slot' },
          Klingon: { standard: 'Noto Sans' },
          Arab: { fixed: 7 }
        },
        fixedSize: 200
      })
    ).toEqual({
      extras: { cursive: 'Zapfino' },
      scripts: { Jpan: { standard: 'Noto Sans JP' } },
      fixedSize: 72
    })
  })

  it('lays them by the same precedence, per entry, and tells the setting\u2019s part from them', () => {
    const user = { ...DEFAULT_FONT_SETTINGS }
    const layered = layerFonts(
      user,
      new Map<string, FontValues>([
        [
          OLD,
          {
            extras: { cursive: 'Comic Neue', fantasy: 'Papyrus' },
            scripts: { Jpan: { standard: 'Noto Sans JP', serif: 'Noto Serif JP' } },
            fixedSize: 14
          }
        ],
        [NEW, { extras: { cursive: 'Zapfino' }, scripts: { Jpan: { standard: 'Meiryo' } } }],
        ['not-loaded', { fixedSize: 30, scripts: { Arab: { standard: 'x' } } }]
      ]),
      rank
    )
    expect(layered.fonts).toEqual(user)
    expect(layerHolds(layered)).toBe(false)
    expect(layered.layer).toEqual({
      families: { cursive: 'Zapfino', fantasy: 'Papyrus' },
      scripts: { Jpan: { standard: 'Meiryo', serif: 'Noto Serif JP' } },
      fixedSize: 14,
      controllers: {
        'cursive.Zyyy': NEW,
        'fantasy.Zyyy': OLD,
        'standard.Jpan': NEW,
        'serif.Jpan': OLD,
        fixedSize: OLD
      }
    })
    const plain = layerFonts(user, new Map(), rank)
    expect(plain.layer).toEqual({ families: {}, scripts: {}, fixedSize: null, controllers: {} })
    expect(sameLayered(plain, layered)).toBe(false)
    expect(sameLayered(layered, layerFonts(user, new Map(), rank))).toBe(false)
    expect(
      layerHolds(layerFonts(user, new Map([[OLD, { families: { serif: 'Lora' } }]]), rank))
    ).toBe(true)
  })

  it('builds the pages\u2019 layer: what is held, and the engine\u2019s own family for a script slot let go', () => {
    const user = { ...DEFAULT_FONT_SETTINGS }
    const layered = layerFonts(
      user,
      new Map<string, FontValues>([
        [
          NEW,
          {
            extras: { math: 'STIX Two Math' },
            scripts: { Arab: { serif: 'Amiri' } },
            fixedSize: 15
          }
        ]
      ]),
      rank
    )
    const linux = { platform: 'linux', locale: 'en-US', installed: null }
    expect(pageFontLayer(layered, new Set(), linux)).toEqual({
      families: { math: 'STIX Two Math' },
      scripts: { Arab: { serif: 'Amiri' } },
      sizes: { fixed: 15 }
    })
    // Let go on Linux: the engine has no family for the slot, and the hook erases it by itself.
    expect(pageFontLayer(layered, new Set(['standard.Jpan', 'fixedSize']), linux)).toEqual({
      families: { math: 'STIX Two Math' },
      scripts: { Arab: { serif: 'Amiri' } },
      sizes: { fixed: 15 }
    })
    // Let go on macOS: Electron's own Japanese face is named again; a slot still held is not touched.
    const mac = {
      platform: 'darwin',
      locale: 'en-US',
      installed: new Set(['Hiragino Kaku Gothic ProN'])
    }
    expect(pageFontLayer(layered, new Set(['standard.Jpan', 'serif.Arab']), mac).scripts).toEqual({
      Arab: { serif: 'Amiri' },
      Jpan: { standard: 'Hiragino Kaku Gothic ProN' }
    })
    expect(scriptDefault(mac, 'Jpan', 'fixed')).toBe('Osaka')
    expect(scriptDefault({ ...mac, installed: new Set(['Menlo']) }, 'Jpan', 'fixed')).toBe('Menlo')
    expect(scriptDefault(mac, 'Arab', 'fixed')).toBe('')
    expect(scriptDefault({ ...mac, platform: 'win32' }, 'Arab', 'fixed')).toBe('Courier New')
    expect(scriptDefault({ ...mac, platform: 'win32', locale: 'ar-EG' }, 'Arab', 'fixed')).toBe('')
    // Nothing held: an empty layer.
    expect(pageFontLayer(layerFonts(user, new Map(), rank), new Set(), linux)).toEqual({
      families: {},
      scripts: {},
      sizes: {}
    })
  })
})
