import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FONT_SETTINGS,
  FONT_SIZE_STEPS,
  MINIMUM_FONT_SIZE_STEPS,
  browserLocaleScript,
  cdpEffectiveFamilies,
  cdpEffectiveFamilyChanges,
  cdpFontFamilies,
  cdpFontFamilyChanges,
  chromiumEffectiveFontPreferences,
  chromiumFontPreferences,
  effectiveFonts,
  effectiveFontsAsMade,
  effectiveSizesMove,
  electronFontDefaults,
  electronGenericFontDefaults,
  electronScriptFontDefaults,
  firstAvailableFamily,
  FONT_RESTYLE_SCRIPT,
  fontSizesMove,
  isDefaultFontSettings,
  monospaceFontSize,
  sanitizeFontSettings,
  type PageFontSettings
} from '../fonts'

describe('sanitizeFontSettings', () => {
  it('reads a stored or synced document field by field, the rest from the defaults', () => {
    expect(sanitizeFontSettings(undefined)).toEqual(DEFAULT_FONT_SETTINGS)
    expect(sanitizeFontSettings('serif')).toEqual(DEFAULT_FONT_SETTINGS)
    expect(
      sanitizeFontSettings({ standard: 'Georgia', fixed: 'Fira Code', size: 20, minimumSize: 12 })
    ).toEqual({
      standard: 'Georgia',
      serif: null,
      sansSerif: null,
      fixed: 'Fira Code',
      size: 20,
      minimumSize: 12
    })
  })

  it('holds the sizes to Chrome’s ranges and rounds them', () => {
    expect(sanitizeFontSettings({ size: 200 }).size).toBe(72)
    expect(sanitizeFontSettings({ size: 2 }).size).toBe(9)
    expect(sanitizeFontSettings({ size: 15.6 }).size).toBe(16)
    expect(sanitizeFontSettings({ size: 'big' }).size).toBe(16)
    expect(sanitizeFontSettings({ size: Number.NaN }).size).toBe(16)
    expect(sanitizeFontSettings({ minimumSize: 40 }).minimumSize).toBe(24)
    expect(sanitizeFontSettings({ minimumSize: -3 }).minimumSize).toBe(0)
  })

  it('rounds a 1–5 px floor, which Chrome’s slider never offers, up to its first stop', () => {
    expect(sanitizeFontSettings({ minimumSize: 1 }).minimumSize).toBe(6)
    expect(sanitizeFontSettings({ minimumSize: 5 }).minimumSize).toBe(6)
    expect(sanitizeFontSettings({ minimumSize: 6 }).minimumSize).toBe(6)
    expect(sanitizeFontSettings({ minimumSize: 0 }).minimumSize).toBe(0)
    expect(MINIMUM_FONT_SIZE_STEPS.slice(0, 2)).toEqual([0, 6])
    expect(FONT_SIZE_STEPS).toContain(16)
  })

  it('keeps a family a page could take in font-family: printable, unquoted, bounded', () => {
    expect(sanitizeFontSettings({ standard: '  "Noto Serif";  x  ' }).standard).toBe('Noto Serif x')
    expect(sanitizeFontSettings({ serif: '' }).serif).toBeNull()
    expect(sanitizeFontSettings({ serif: '   ' }).serif).toBeNull()
    expect(sanitizeFontSettings({ serif: 12 }).serif).toBeNull()
    expect(sanitizeFontSettings({ sansSerif: 'a'.repeat(300) }).sansSerif).toHaveLength(120)
    expect(sanitizeFontSettings({ fixed: '<script>' }).fixed).toBe('script')
  })
})

describe('the engine’s terms', () => {
  it('keeps Chrome’s fixed-width size a step under the running text', () => {
    expect(monospaceFontSize(16)).toBe(13)
    expect(monospaceFontSize(9)).toBe(7)
    expect(monospaceFontSize(24)).toBe(20)
    expect(monospaceFontSize(72)).toBe(59)
    expect(monospaceFontSize(0)).toBe(1)
  })

  it('names for the web preferences only the families the user chose', () => {
    expect(chromiumFontPreferences(DEFAULT_FONT_SETTINGS)).toEqual({
      defaultFontFamily: {},
      defaultFontSize: 16,
      defaultMonospaceFontSize: 13,
      minimumFontSize: 0
    })
    expect(
      chromiumFontPreferences({
        standard: 'Georgia',
        serif: null,
        sansSerif: 'Inter',
        fixed: 'Fira Code',
        size: 20,
        minimumSize: 12
      })
    ).toEqual({
      defaultFontFamily: { standard: 'Georgia', sansSerif: 'Inter', monospace: 'Fira Code' },
      defaultFontSize: 20,
      defaultMonospaceFontSize: 16,
      minimumFontSize: 12
    })
  })

  it('knows the families Electron gives a page on each OS (Chrome’s, not Blink’s Courier New)', () => {
    expect(electronFontDefaults('linux')).toEqual({
      standard: 'Times New Roman',
      serif: 'Times New Roman',
      sansSerif: 'Arial',
      fixed: 'Monospace'
    })
    expect(electronFontDefaults('win32').fixed).toBe('Consolas')
    expect(electronFontDefaults('darwin')).toEqual({
      standard: 'Times',
      serif: 'Times',
      sansSerif: 'Helvetica',
      fixed: 'Menlo'
    })
    // An OS not accounted for reads as Linux (fontconfig names).
    expect(electronFontDefaults('freebsd')).toEqual(electronFontDefaults('linux'))
  })

  it('names every family a page has, the unchosen ones as the engine’s own', () => {
    const defaults = electronFontDefaults('linux')
    expect(cdpFontFamilies(DEFAULT_FONT_SETTINGS, defaults)).toEqual(defaults)
    expect(cdpFontFamilies({ ...DEFAULT_FONT_SETTINGS, serif: 'Georgia' }, defaults)).toEqual({
      ...defaults,
      serif: 'Georgia'
    })
  })

  it('sends the protocol only the slots that move, never one the user left alone', () => {
    const defaults = electronFontDefaults('linux')
    const born = cdpFontFamilies(DEFAULT_FONT_SETTINGS, defaults)
    // Nothing chosen: nothing to send.
    expect(cdpFontFamilyChanges(born, born)).toBeNull()
    // A choice names its slot alone.
    const chosen = cdpFontFamilies({ ...DEFAULT_FONT_SETTINGS, fixed: 'Fira Code' }, defaults)
    expect(cdpFontFamilyChanges(born, chosen)).toEqual({ fixed: 'Fira Code' })
    // Letting it go takes the slot back by naming the engine's own; the others stay unnamed.
    expect(cdpFontFamilyChanges(chosen, born)).toEqual({ fixed: 'Monospace' })
    // Two slots moving, one of them back.
    const two = cdpFontFamilies(
      { ...DEFAULT_FONT_SETTINGS, standard: 'Georgia', sansSerif: 'Inter' },
      defaults
    )
    expect(cdpFontFamilyChanges(chosen, two)).toEqual({
      standard: 'Georgia',
      sansSerif: 'Inter',
      fixed: 'Monospace'
    })
  })

  it('knows a profile that follows the platform entirely', () => {
    expect(isDefaultFontSettings(DEFAULT_FONT_SETTINGS)).toBe(true)
    expect(isDefaultFontSettings({ ...DEFAULT_FONT_SETTINGS, size: 17 })).toBe(false)
    expect(isDefaultFontSettings({ ...DEFAULT_FONT_SETTINGS, fixed: 'monospace' })).toBe(false)
  })

  it('tells a size move (Blink restyles by itself) from a family move (the document must be asked)', () => {
    const has = { ...DEFAULT_FONT_SETTINGS, standard: 'Georgia' }
    expect(fontSizesMove(has, { ...has, standard: 'Palatino' })).toBe(false)
    expect(fontSizesMove(has, { ...has, fixed: 'Fira Code' })).toBe(false)
    expect(fontSizesMove(has, { ...has, size: 17 })).toBe(true)
    expect(fontSizesMove(has, { ...has, minimumSize: 12 })).toBe(true)
    expect(fontSizesMove(has, has)).toBe(false)
    // The script an open document gets after a family move: a fresh, unused custom property,
    // registered (which marks every element for a style recalc), nothing that renders or fails loud.
    expect(FONT_RESTYLE_SCRIPT).toMatch(
      /^\(\(\) => \{ try \{ CSS\.registerProperty\(\{ name: '--zenium-fonts-'/
    )
    expect(FONT_RESTYLE_SCRIPT).toContain("syntax: '*', inherits: false")
    expect(FONT_RESTYLE_SCRIPT).toContain('catch {}')
    // Valid script, and one that a document without the API leaves silent.
    expect(() => new Function(FONT_RESTYLE_SCRIPT)).not.toThrow()
  })
})

describe('the extensions’ layer (chrome.fontSettings)', () => {
  const USER: PageFontSettings = {
    standard: 'Georgia',
    serif: null,
    sansSerif: 'Inter',
    fixed: null,
    size: 20,
    minimumSize: 12
  }

  it('lays the extensions’ families and sizes over the setting, the user’s untouched where it names none', () => {
    expect(effectiveFonts(USER, null)).toEqual({
      settings: USER,
      fixedSize: 16,
      extras: {},
      scripts: {}
    })
    const fonts = effectiveFonts(USER, {
      // '' is Chrome's "fall back": the slot goes to the engine's own, over the user's choice.
      families: { standard: 'Verdana', sansSerif: '', cursive: 'Zapfino', fantasy: '' },
      scripts: { Jpan: { sansSerif: 'Noto Sans JP' } },
      sizes: { standard: 24, minimum: 10 }
    })
    expect(fonts.settings).toEqual({
      standard: 'Verdana',
      serif: null,
      sansSerif: null,
      fixed: null,
      size: 24,
      minimumSize: 10
    })
    // Chrome's default_fixed_font_size is its own pref: the layer's default size leaves it.
    expect(fonts.fixedSize).toBe(16)
    expect(fonts.extras).toEqual({ cursive: 'Zapfino' })
    expect(fonts.scripts).toEqual({ Jpan: { sansSerif: 'Noto Sans JP' } })
    expect(
      effectiveFonts(USER, { families: {}, scripts: {}, sizes: { fixed: 11 } }).fixedSize
    ).toBe(11)
    expect(effectiveFontsAsMade(fonts)).toEqual({ ...fonts, scripts: {} })
  })

  it('makes the web preferences with the layer’s fixed size and the three extra families', () => {
    const fonts = effectiveFonts(USER, {
      families: { cursive: 'Zapfino', fantasy: 'Papyrus', math: 'STIX Two Math' },
      scripts: {},
      sizes: { fixed: 11 }
    })
    expect(chromiumEffectiveFontPreferences(fonts)).toEqual({
      defaultFontFamily: {
        standard: 'Georgia',
        sansSerif: 'Inter',
        cursive: 'Zapfino',
        fantasy: 'Papyrus',
        math: 'STIX Two Math'
      },
      defaultFontSize: 20,
      defaultMonospaceFontSize: 11,
      minimumFontSize: 12
    })
    expect(chromiumEffectiveFontPreferences(effectiveFonts(USER, null))).toEqual(
      chromiumFontPreferences(USER)
    )
  })

  it('knows the engine’s own families for all seven slots: Electron’s cursive, Blink’s fantasy and math', () => {
    expect(electronGenericFontDefaults('darwin')).toEqual({
      ...electronFontDefaults('darwin'),
      cursive: 'Apple Chancery',
      fantasy: 'Impact',
      math: 'Latin Modern Math'
    })
    expect(electronGenericFontDefaults('linux')).toMatchObject({
      cursive: 'Comic Sans MS',
      fantasy: 'Impact'
    })
  })

  it('knows Electron’s per-script defaults on macOS and Windows, none on Linux, minus the locale’s own script', () => {
    expect(electronScriptFontDefaults('linux', 'ja')).toEqual({})
    expect(electronScriptFontDefaults('darwin', 'en-US').Jpan).toEqual({
      standard: ['Hiragino Kaku Gothic ProN'],
      fixed: ['Osaka', 'BIZ UDGothic', 'Menlo'],
      serif: ['Hiragino Mincho ProN'],
      sansSerif: ['Hiragino Kaku Gothic ProN']
    })
    expect(Object.keys(electronScriptFontDefaults('darwin', 'ja'))).toEqual([
      'Hang',
      'Hans',
      'Hant'
    ])
    expect(Object.keys(electronScriptFontDefaults('win32', 'zh-CN'))).not.toContain('Hans')
    expect(Object.keys(electronScriptFontDefaults('win32', 'zh-TW'))).toContain('Hans')
    expect(electronScriptFontDefaults('win32', 'ru').Cyrl).toBeUndefined()
    expect(electronScriptFontDefaults('win32', 'en-US').Cyrl?.sansSerif).toEqual(['Arial'])
    expect(browserLocaleScript('zh-CN')).toBe('Hans')
    expect(browserLocaleScript('zh_TW')).toBe('Hant')
    expect(browserLocaleScript('ko-KR')).toBe('Hang')
    expect(browserLocaleScript('ja')).toBe('Jpan')
    expect(browserLocaleScript('el')).toBe('Grek')
    expect(browserLocaleScript('fa-IR')).toBe('Arab')
    expect(browserLocaleScript('en-US')).toBeNull()
  })

  it('resolves a list default as Chrome does: the first installed family, else the first', () => {
    const list = ['Noto Sans JP', 'Meiryo', 'Yu Gothic']
    expect(firstAvailableFamily(list, null)).toBe('Noto Sans JP')
    expect(firstAvailableFamily(list, new Set(['Yu Gothic', 'Meiryo']))).toBe('Meiryo')
    expect(firstAvailableFamily(list, new Set(['Arial']))).toBe('Noto Sans JP')
    expect(firstAvailableFamily([], new Set(['Arial']))).toBe('')
  })

  it('names every family a page has under the layer, common and per script', () => {
    const defaults = electronGenericFontDefaults('linux')
    const fonts = effectiveFonts(USER, {
      families: { math: 'STIX Two Math' },
      scripts: { Jpan: { sansSerif: 'Noto Sans JP' } },
      sizes: {}
    })
    expect(cdpEffectiveFamilies(fonts, defaults)).toEqual({
      common: {
        ...cdpFontFamilies(USER, electronFontDefaults('linux')),
        cursive: 'Comic Sans MS',
        fantasy: 'Impact',
        math: 'STIX Two Math'
      },
      scripts: { Jpan: { sansSerif: 'Noto Sans JP' } }
    })
  })

  it('sends the protocol the slots that move, a let-go script slot as the empty family, nothing when nothing moved', () => {
    const defaults = electronGenericFontDefaults('linux')
    const has = cdpEffectiveFamilies(effectiveFonts(USER, null), defaults)
    const wanted = cdpEffectiveFamilies(
      effectiveFonts(USER, {
        families: { standard: 'Verdana', math: 'STIX Two Math' },
        scripts: { Jpan: { sansSerif: 'Noto Sans JP' }, Cyrl: { standard: 'PT Serif' } },
        sizes: {}
      }),
      defaults
    )
    expect(cdpEffectiveFamilyChanges(has, has)).toBeNull()
    expect(cdpEffectiveFamilyChanges(has, wanted)).toEqual({
      fontFamilies: { standard: 'Verdana', math: 'STIX Two Math' },
      forScripts: [
        { script: 'Cyrl', fontFamilies: { standard: 'PT Serif' } },
        { script: 'Jpan', fontFamilies: { sansSerif: 'Noto Sans JP' } }
      ]
    })
    // Back: the common slots by the engine's or the user's name, the scripts' slots erased.
    expect(cdpEffectiveFamilyChanges(wanted, has)).toEqual({
      fontFamilies: { standard: 'Georgia', math: 'Latin Modern Math' },
      forScripts: [
        { script: 'Cyrl', fontFamilies: { standard: '' } },
        { script: 'Jpan', fontFamilies: { sansSerif: '' } }
      ]
    })
    // A script slot changing alone: no common-slot key beyond the empty object.
    const other = { ...wanted, scripts: { ...wanted.scripts, Jpan: { sansSerif: 'Meiryo' } } }
    expect(cdpEffectiveFamilyChanges(wanted, other)).toEqual({
      fontFamilies: {},
      forScripts: [{ script: 'Jpan', fontFamilies: { sansSerif: 'Meiryo' } }]
    })
    // The user path's shape stands: the four slots only, no forScripts key.
    expect(
      cdpEffectiveFamilyChanges(
        has,
        cdpEffectiveFamilies(effectiveFonts({ ...USER, fixed: 'Fira Code' }, null), defaults)
      )
    ).toEqual({ fontFamilies: { fixed: 'Fira Code' } })
  })

  it('tells a size move under the layer, the fixed-width size counted', () => {
    const base = effectiveFonts(USER, null)
    expect(effectiveSizesMove(base, effectiveFonts(USER, null))).toBe(false)
    expect(
      effectiveSizesMove(
        base,
        effectiveFonts(USER, { families: {}, scripts: {}, sizes: { fixed: 11 } })
      )
    ).toBe(true)
    expect(
      effectiveSizesMove(
        base,
        effectiveFonts(USER, { families: {}, scripts: {}, sizes: { standard: 24 } })
      )
    ).toBe(true)
    expect(
      effectiveSizesMove(
        base,
        effectiveFonts(USER, { families: {}, scripts: {}, sizes: { minimum: 0 } })
      )
    ).toBe(true)
    expect(
      effectiveSizesMove(
        base,
        effectiveFonts(USER, { families: { standard: 'Verdana' }, scripts: {}, sizes: {} })
      )
    ).toBe(false)
  })
})
