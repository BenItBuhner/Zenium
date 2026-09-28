import { describe, expect, it } from 'vitest'
import {
  DEFAULT_READER_PREFERENCES,
  LEGACY_READER_SPACING,
  READER_FONT_SIZES,
  READER_LETTER_SPACINGS,
  READER_LINE_SPACINGS,
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
    ).toEqual({
      ...DEFAULT_READER_PREFERENCES,
      fontSize: 22,
      font: 'mono',
      theme: 'sepia',
      width: 'wide'
    })
    // The extras (EDGE-13): a stored set from before them comes back with them off.
    expect(
      sanitizeReaderPreferences({
        lineFocus: 3,
        lineSpacing: 'very-loose',
        letterSpacing: 'wide',
        syllables: true
      })
    ).toMatchObject({
      lineFocus: 3,
      lineSpacing: 'very-loose',
      letterSpacing: 'wide',
      syllables: true
    })
    expect(
      sanitizeReaderPreferences({
        lineFocus: 2,
        lineSpacing: 'huge',
        letterSpacing: 'wider',
        syllables: 'yes'
      })
    ).toMatchObject({
      lineFocus: 0,
      lineSpacing: 'standard',
      letterSpacing: 'standard',
      syllables: false
    })
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
    expect(
      readerPreferencesPatch({
        lineFocus: 5,
        lineSpacing: 'loose',
        letterSpacing: 'very-wide',
        syllables: false
      })
    ).toEqual({
      lineFocus: 5,
      lineSpacing: 'loose',
      letterSpacing: 'very-wide',
      syllables: false
    })
    expect(
      readerPreferencesPatch({
        lineFocus: 4,
        lineSpacing: 'wider',
        letterSpacing: 'loose',
        syllables: 1
      })
    ).toBeNull()
    expect(readerPreferencesPatch({ fontSize: 'big' })).toBeNull()
    expect(readerPreferencesPatch({ color: 'red' })).toBeNull()
    expect(readerPreferencesPatch(null)).toBeNull()
    expect(readerPreferencesPatch('sepia')).toBeNull()
  })

  /**
   * CT-35: Edge's one Text spacing step (`spacing`: normal / wide / wider) became Chrome's two
   * menus. A record or a patch from before the split reads forward as the pair its step stood
   * for – normal → Standard / Standard, wide → Loose / Wide, wider → Very loose / Very wide –
   * and the old key is never written again: no migration, the synced record read as it comes.
   */
  it('reads the old Text spacing step forward into the two rows, and never writes it', () => {
    expect(LEGACY_READER_SPACING).toEqual({
      normal: { lineSpacing: 'standard', letterSpacing: 'standard' },
      wide: { lineSpacing: 'loose', letterSpacing: 'wide' },
      wider: { lineSpacing: 'very-loose', letterSpacing: 'very-wide' }
    })
    expect(READER_LINE_SPACINGS).toEqual(['standard', 'loose', 'very-loose'])
    expect(READER_LETTER_SPACINGS).toEqual(['standard', 'wide', 'very-wide'])
    expect(DEFAULT_READER_PREFERENCES).toMatchObject({
      lineSpacing: 'standard',
      letterSpacing: 'standard'
    })
    expect(DEFAULT_READER_PREFERENCES).not.toHaveProperty('spacing')

    // A stored or synced record from before the split: its one step becomes the pair.
    const wider = sanitizeReaderPreferences({ fontSize: 20, spacing: 'wider' })
    expect(wider).toMatchObject({
      fontSize: 20,
      lineSpacing: 'very-loose',
      letterSpacing: 'very-wide'
    })
    expect(wider).not.toHaveProperty('spacing')
    expect(sanitizeReaderPreferences({ spacing: 'wide' })).toMatchObject({
      lineSpacing: 'loose',
      letterSpacing: 'wide'
    })
    expect(sanitizeReaderPreferences({ spacing: 'normal' })).toMatchObject({
      lineSpacing: 'standard',
      letterSpacing: 'standard'
    })
    // A record that carries the new keys keeps them, whatever old key rides along; an old
    // value that is none of the three words is the defaults.
    expect(
      sanitizeReaderPreferences({
        spacing: 'wider',
        lineSpacing: 'loose',
        letterSpacing: 'standard'
      })
    ).toMatchObject({ lineSpacing: 'loose', letterSpacing: 'standard' })
    expect(sanitizeReaderPreferences({ spacing: 'wider', lineSpacing: 'loose' })).toMatchObject({
      lineSpacing: 'loose',
      letterSpacing: 'very-wide'
    })
    expect(sanitizeReaderPreferences({ spacing: 'huge' })).toMatchObject({
      lineSpacing: 'standard',
      letterSpacing: 'standard'
    })

    // A patch in the old shape (an older caller) sets the pair; one that names either new key
    // is taken as sent, the old key ignored beside it.
    expect(readerPreferencesPatch({ spacing: 'wide' })).toEqual({
      lineSpacing: 'loose',
      letterSpacing: 'wide'
    })
    expect(readerPreferencesPatch({ spacing: 'wider', lineSpacing: 'standard' })).toEqual({
      lineSpacing: 'standard'
    })
    expect(readerPreferencesPatch({ spacing: 'widest' })).toBeNull()
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
