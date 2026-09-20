import { describe, expect, it } from 'vitest'
import {
  DEFAULT_READER_PREFERENCES,
  READER_FONT_SIZES,
  readerPreferencesPatch,
  sanitizeReaderPreferences,
  stepReaderFontSize
} from '../reader'

describe('reader text preferences', () => {
  it('sanitises stored preferences of any shape to a complete, valid set', () => {
    expect(sanitizeReaderPreferences(undefined)).toEqual(DEFAULT_READER_PREFERENCES)
    expect(sanitizeReaderPreferences('serif')).toEqual(DEFAULT_READER_PREFERENCES)
    expect(
      sanitizeReaderPreferences({ fontSize: 22, font: 'mono', theme: 'sepia', width: 'wide' })
    ).toEqual({ fontSize: 22, font: 'mono', theme: 'sepia', width: 'wide' })
    // A size off the ladder, a font that is not one of the three, a theme spelled wrong: each
    // falls back to its default alone.
    expect(
      sanitizeReaderPreferences({ fontSize: 19, font: 'comic', theme: 'Dark', width: 'narrow' })
    ).toEqual({ ...DEFAULT_READER_PREFERENCES, width: 'narrow' })
    expect(sanitizeReaderPreferences({ fontSize: '18' }).fontSize).toBe(18)
  })

  it('takes only the valid keys of a patch, and nothing from an unusable one', () => {
    expect(readerPreferencesPatch({ fontSize: 24 })).toEqual({ fontSize: 24 })
    expect(readerPreferencesPatch({ font: 'sans', theme: 'light', width: 'narrow' })).toEqual({
      font: 'sans',
      theme: 'light',
      width: 'narrow'
    })
    // Malformed values are left out rather than defaulted: a patch must not reset a preference
    // the sender did not mean to change.
    expect(readerPreferencesPatch({ fontSize: 13, font: 'sans' })).toEqual({ font: 'sans' })
    expect(readerPreferencesPatch({ fontSize: 'big' })).toBeNull()
    expect(readerPreferencesPatch({ color: 'red' })).toBeNull()
    expect(readerPreferencesPatch(null)).toBeNull()
    expect(readerPreferencesPatch('sepia')).toBeNull()
  })

  it('steps the size along the ladder with sticky ends', () => {
    expect(stepReaderFontSize(18, 1)).toBe(20)
    expect(stepReaderFontSize(18, -1)).toBe(17)
    expect(stepReaderFontSize(14, -1)).toBe(14)
    expect(stepReaderFontSize(28, 1)).toBe(28)
    // A size between two rungs (an older profile) snaps up, then steps from there.
    expect(stepReaderFontSize(19, 1)).toBe(22)
    expect(stepReaderFontSize(19, -1)).toBe(18)
    // Past the top of the ladder: the top rung, and down from it.
    expect(stepReaderFontSize(40, -1)).toBe(24)
    expect(stepReaderFontSize(40, 1)).toBe(28)
    // A zero step stays put.
    expect(stepReaderFontSize(16, 0)).toBe(16)
    expect(READER_FONT_SIZES).toContain(DEFAULT_READER_PREFERENCES.fontSize)
  })
})
