import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FONT_SETTINGS,
  FONT_SIZE_STEPS,
  MINIMUM_FONT_SIZE_STEPS,
  cdpFontFamilies,
  cdpFontFamilyChanges,
  chromiumFontPreferences,
  electronFontDefaults,
  isDefaultFontSettings,
  monospaceFontSize,
  sanitizeFontSettings
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
})
