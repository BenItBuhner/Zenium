import { describe, expect, it } from 'vitest'
import {
  PILL_CHIP_FOLDS,
  foldPillChips,
  liveArrival,
  pillChipFold,
  type PillChipFoldSpec
} from '../pillChips'

/*
 * The phone pill's chips at rest (OMN-02; v2 §9.29 as amended on Bennett's ruling): the
 * site-information glyph stays, every informational chip is the sheet's, a transient state chip
 * takes the glyph's slot while live and two states never stack – a rule per chip, the same at
 * every width and font scale.
 */

const chip = (id: string, fold = pillChipFold(id)): PillChipFoldSpec => ({ id, fold })
const ids = (chips: readonly PillChipFoldSpec[]): string[] => chips.map((c) => c.id)

describe('pillChipFold: what each chip is to the pill at rest', () => {
  it('keeps the lock as the glyph, sends the shield and the translate offer to the sheet', () => {
    expect(pillChipFold('lock')).toBe('glyph')
    expect(pillChipFold('blocked')).toBe('sheet')
    expect(pillChipFold('translate')).toBe('sheet')
  })

  it('the glyph’s other states are the one glyph too (ERR-09): the open lock, the triangle, the shield', () => {
    expect(pillChipFold('not-secure')).toBe('glyph')
    expect(pillChipFold('certificate-error')).toBe('glyph')
    expect(pillChipFold('dangerous')).toBe('glyph')
  })

  it('knows the transient state chips: the media chip and a save-prompt key', () => {
    expect(pillChipFold('media')).toBe('live')
    expect(pillChipFold('save-prompt')).toBe('live')
  })

  it('treats a chip it does not know as informational: the sheet’s (the reader chip, an extension action)', () => {
    expect(pillChipFold('reader')).toBe('sheet')
    expect(pillChipFold('extension-action')).toBe('sheet')
    expect(Object.keys(PILL_CHIP_FOLDS).sort()).toEqual(
      [
        'blocked',
        'certificate-error',
        'dangerous',
        'lock',
        'media',
        'not-secure',
        'save-prompt',
        'translate'
      ].sort()
    )
  })
})

describe('foldPillChips: the rule, not a width', () => {
  it('leaves the pill the lock alone on an ordinary secure page with a count and an offer', () => {
    const fold = foldPillChips([chip('lock'), chip('blocked'), chip('translate')])
    expect(ids(fold.shown)).toEqual(['lock'])
    expect(ids(fold.folded)).toEqual(['blocked', 'translate'])
    expect(fold.yielded).toEqual([])
  })

  it('folds the shield on an http page too, where there is no lock to keep', () => {
    const fold = foldPillChips([chip('blocked')])
    expect(fold.shown).toEqual([])
    expect(ids(fold.folded)).toEqual(['blocked'])
  })

  it('is empty in and empty out, and keeps the objects it was given', () => {
    expect(foldPillChips([])).toEqual({ shown: [], folded: [], yielded: [] })
    const lock = { id: 'lock', fold: 'glyph' as const, extra: 1 }
    expect(foldPillChips([lock]).shown[0]).toBe(lock)
  })

  it('folds the same way whatever the pill’s width or the font scale: neither is an input', () => {
    const chips = [chip('lock'), chip('blocked'), chip('translate'), chip('media')]
    expect(foldPillChips(chips)).toEqual(foldPillChips([...chips]))
    expect(foldPillChips.length).toBe(1)
  })

  it('honours a fold given on the chip over the table’s', () => {
    const fold = foldPillChips([chip('lock'), chip('media', 'sheet')])
    expect(ids(fold.shown)).toEqual(['lock'])
    expect(ids(fold.folded)).toEqual(['media'])
  })
})

describe('foldPillChips: a live state takes the glyph slot (§9.29)', () => {
  const page = [chip('lock'), chip('blocked'), chip('translate')]

  it('one live: the media chip shows in the lock’s place, the lock gives way, the sheet’s rows are unchanged', () => {
    const fold = foldPillChips([...page, chip('media')])
    expect(ids(fold.shown)).toEqual(['media'])
    expect(ids(fold.yielded)).toEqual(['lock'])
    expect(ids(fold.folded)).toEqual(['blocked', 'translate'])
  })

  it('two live never stack: the newer shows, the older waits in the sheet as a row, in the pill’s order', () => {
    const fold = foldPillChips(
      [...page, chip('media'), chip('save-prompt')],
      liveArrival(['media'], ['media', 'save-prompt'])
    )
    expect(ids(fold.shown)).toEqual(['save-prompt'])
    expect(ids(fold.folded)).toEqual(['blocked', 'translate', 'media'])
    expect(ids(fold.yielded)).toEqual(['lock'])
  })

  it('order of arrival decides, not the order the chips come in', () => {
    const chips = [...page, chip('media'), chip('save-prompt')]
    // The key was up first, then the media started: the media chip is the newer.
    const mediaNewer = liveArrival(liveArrival([], ['save-prompt']), ['save-prompt', 'media'])
    expect(mediaNewer).toEqual(['save-prompt', 'media'])
    expect(ids(foldPillChips(chips, mediaNewer).shown)).toEqual(['media'])
    expect(ids(foldPillChips(chips, mediaNewer).folded)).toEqual([
      'blocked',
      'translate',
      'save-prompt'
    ])
    // The media was up first: the key is the newer.
    const keyNewer = liveArrival(liveArrival([], ['media']), ['media', 'save-prompt'])
    expect(ids(foldPillChips(chips, keyNewer).shown)).toEqual(['save-prompt'])
    // Without a record the order given stands in for it: the last live chip is the newest.
    expect(ids(foldPillChips(chips).shown)).toEqual(['save-prompt'])
  })

  it('a state the record does not know yet is newer than any it does', () => {
    const chips = [...page, chip('media'), chip('save-prompt')]
    expect(ids(foldPillChips(chips, ['save-prompt']).shown)).toEqual(['media'])
    expect(ids(foldPillChips(chips, ['media']).shown)).toEqual(['save-prompt'])
  })

  it('state ends: the older state comes back to the pill, and when the last ends the lock returns', () => {
    let arrival = liveArrival([], ['media'])
    arrival = liveArrival(arrival, ['media', 'save-prompt'])
    expect(
      ids(foldPillChips([...page, chip('media'), chip('save-prompt')], arrival).shown)
    ).toEqual(['save-prompt'])
    // The key is answered: the media chip, which waited in the sheet, is the pill's again.
    arrival = liveArrival(arrival, ['media'])
    expect(arrival).toEqual(['media'])
    const one = foldPillChips([...page, chip('media')], arrival)
    expect(ids(one.shown)).toEqual(['media'])
    expect(ids(one.folded)).toEqual(['blocked', 'translate'])
    // The media stops: the lock returns and nothing is yielded.
    arrival = liveArrival(arrival, [])
    expect(arrival).toEqual([])
    const none = foldPillChips(page, arrival)
    expect(ids(none.shown)).toEqual(['lock'])
    expect(none.yielded).toEqual([])
  })

  it('a live state on a page without a lock (http) stands alone, nothing yielded', () => {
    const fold = foldPillChips([chip('blocked'), chip('media')])
    expect(ids(fold.shown)).toEqual(['media'])
    expect(fold.yielded).toEqual([])
    expect(ids(fold.folded)).toEqual(['blocked'])
  })
})

describe('liveArrival: the states’ order of arrival', () => {
  it('appends a new state at the end and keeps the order of those still live', () => {
    expect(liveArrival([], ['media'])).toEqual(['media'])
    expect(liveArrival(['media'], ['save-prompt', 'media'])).toEqual(['media', 'save-prompt'])
  })

  it('drops a state that ended and keeps the rest in place', () => {
    expect(liveArrival(['media', 'save-prompt'], ['save-prompt'])).toEqual(['save-prompt'])
    expect(liveArrival(['media', 'save-prompt'], [])).toEqual([])
  })

  it('a state that ends and comes back is the newest again', () => {
    const a = liveArrival(['media', 'save-prompt'], ['save-prompt'])
    expect(liveArrival(a, ['media', 'save-prompt'])).toEqual(['save-prompt', 'media'])
  })

  it('is pure: the same inputs give the same order, and the inputs are left alone', () => {
    const previous = ['media']
    const live = ['save-prompt', 'media']
    expect(liveArrival(previous, live)).toEqual(liveArrival(previous, live))
    expect(previous).toEqual(['media'])
    expect(live).toEqual(['save-prompt', 'media'])
  })
})
