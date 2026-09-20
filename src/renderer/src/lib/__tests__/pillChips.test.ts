import { describe, expect, it } from 'vitest'
import {
  PILL_CHIP_FOLDS,
  foldPillChips,
  foldedChipsSpoken,
  pillChipFold,
  type PillChipFoldSpec
} from '../pillChips'

/*
 * The phone pill's chips at rest (OMN-02; Bennett's rule over v2 §9.29 on the phone): the
 * site-information glyph stays, every informational chip is the sheet's, a transient state chip
 * is in the pill while live – a rule per chip, the same at every width and font scale.
 */

const chip = (id: string, fold = pillChipFold(id)): PillChipFoldSpec => ({ id, fold })

describe('pillChipFold: what each chip is to the pill at rest', () => {
  it('keeps the lock as the glyph, sends the shield and the translate offer to the sheet', () => {
    expect(pillChipFold('lock')).toBe('glyph')
    expect(pillChipFold('blocked')).toBe('sheet')
    expect(pillChipFold('translate')).toBe('sheet')
  })

  it('shows the transient state chips while live (the interim rule, pending the lead)', () => {
    expect(pillChipFold('media')).toBe('live')
    expect(pillChipFold('save-prompt')).toBe('live')
  })

  it('treats a chip it does not know as informational: the sheet’s', () => {
    expect(pillChipFold('boost')).toBe('sheet')
    expect(pillChipFold('extensions')).toBe('sheet')
    expect(Object.keys(PILL_CHIP_FOLDS).sort()).toEqual(
      ['blocked', 'lock', 'media', 'save-prompt', 'translate'].sort()
    )
  })
})

describe('foldPillChips: the rule, not a width', () => {
  it('leaves the pill the lock alone on an ordinary secure page with a count and an offer', () => {
    const fold = foldPillChips([chip('lock'), chip('blocked'), chip('translate')])
    expect(fold.shown.map((c) => c.id)).toEqual(['lock'])
    expect(fold.folded.map((c) => c.id)).toEqual(['blocked', 'translate'])
  })

  it('keeps a live media chip beside the lock, in the order given', () => {
    const fold = foldPillChips([chip('lock'), chip('blocked'), chip('translate'), chip('media')])
    expect(fold.shown.map((c) => c.id)).toEqual(['lock', 'media'])
    expect(fold.folded.map((c) => c.id)).toEqual(['blocked', 'translate'])
  })

  it('folds the shield on an http page too, where there is no lock to keep', () => {
    const fold = foldPillChips([chip('blocked')])
    expect(fold.shown).toEqual([])
    expect(fold.folded.map((c) => c.id)).toEqual(['blocked'])
  })

  it('is empty in and empty out, and keeps the objects it was given', () => {
    expect(foldPillChips([])).toEqual({ shown: [], folded: [] })
    const lock = { id: 'lock', fold: 'glyph' as const, extra: 1 }
    expect(foldPillChips([lock]).shown[0]).toBe(lock)
  })

  it('folds the same way whatever the pill’s width or the font scale: neither is an input', () => {
    const chips = [chip('lock'), chip('blocked'), chip('translate'), chip('media')]
    const a = foldPillChips(chips)
    const b = foldPillChips([...chips])
    expect(a).toEqual(b)
    expect(foldPillChips.length).toBe(1)
  })

  it('honours a fold given on the chip over the table’s (the lead’s ruling on a transient chip)', () => {
    const fold = foldPillChips([chip('lock'), chip('media', 'sheet')])
    expect(fold.shown.map((c) => c.id)).toEqual(['lock'])
    expect(fold.folded.map((c) => c.id)).toEqual(['media'])
  })
})

describe('foldedChipsSpoken: what TalkBack hears at the address', () => {
  it('reads the folded states in the pill’s order', () => {
    expect(foldedChipsSpoken(['5 requests blocked', 'Translation offered'])).toBe(
      '5 requests blocked, Translation offered'
    )
  })

  it('skips a chip with nothing to report, and is empty on a quiet page', () => {
    expect(foldedChipsSpoken(['', 'Translation offered'])).toBe('Translation offered')
    expect(foldedChipsSpoken([''])).toBe('')
    expect(foldedChipsSpoken([])).toBe('')
  })
})
