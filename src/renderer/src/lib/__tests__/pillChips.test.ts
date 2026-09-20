import { describe, expect, it } from 'vitest'
import {
  PILL_CHIP_PITCH,
  PILL_HOST_FLOOR,
  foldPillChips,
  foldedChipsSpoken,
  pillChipCost,
  pillFoldOrder,
  type PillChipSpec
} from '../pillChips'

/*
 * The phone pill's chip fold (v2 §9.29, OMN-02): the host keeps at least 120 px; chips beyond
 * that fold into the site-information sheet, informational ones first, state-reporting ones
 * last; the site-information glyph never folds. The geometry is #237's: the pill is 252 wide on
 * the 412 phone, 224 inside its padding; the leading glyph's 44 box costs 26 (18 of flow and the
 * gap), every other 44 box on the 28 pitch costs 28, the blocked chip with its "12" badge about
 * 68. Everything is in px and stays so at every font scale.
 */

const ROOM_412 = 252 - 2 * 14
const anchor: PillChipSpec = { id: 'site-info', width: pillChipCost(18) }
const lock: PillChipSpec = { id: 'lock', width: PILL_CHIP_PITCH }
const translate: PillChipSpec = { id: 'translate', width: PILL_CHIP_PITCH }
const media: PillChipSpec = { id: 'media', width: PILL_CHIP_PITCH }
const savePrompt: PillChipSpec = { id: 'save-prompt', width: PILL_CHIP_PITCH }
const blocked: PillChipSpec = { id: 'blocked', width: pillChipCost(60) }
const blockedPlain: PillChipSpec = { id: 'blocked', width: pillChipCost(36) }

describe('the geometry', () => {
  it('puts a 44 box on the 28 pitch and the floor at 120 px', () => {
    expect(PILL_CHIP_PITCH).toBe(28)
    expect(PILL_HOST_FLOOR).toBe(120)
    expect(pillChipCost(20)).toBe(28)
  })

  it('leaves the host 198 px on the 412 phone with the glyph alone (#237)', () => {
    expect(foldPillChips([anchor], ROOM_412).host).toBe(198)
  })
})

describe('the fold order', () => {
  it('folds informational chips first, then state-reporting ones, in the rule’s order', () => {
    const order = pillFoldOrder([anchor, blocked, lock, translate, savePrompt, media])
    expect(order.map((c) => c.id)).toEqual(['lock', 'translate', 'blocked', 'save-prompt', 'media'])
  })

  it('never lists the anchor', () => {
    expect(pillFoldOrder([anchor]).map((c) => c.id)).toEqual([])
    expect(pillFoldOrder([lock, anchor, media]).map((c) => c.id)).toEqual(['lock', 'media'])
  })

  it('ranks a chip it does not know after the known ones of its tier, in the order given', () => {
    const boost: PillChipSpec = { id: 'boost', tier: 'informational', width: 28 }
    const extension: PillChipSpec = { id: 'extension', width: 28 }
    const order = pillFoldOrder([extension, boost, media, lock])
    expect(order.map((c) => c.id)).toEqual(['lock', 'boost', 'media', 'extension'])
  })

  it('is stable: the same chips in another order fold in the same order', () => {
    const a = pillFoldOrder([anchor, blocked, lock, translate, media]).map((c) => c.id)
    const b = pillFoldOrder([media, translate, lock, blocked, anchor]).map((c) => c.id)
    expect(a).toEqual(b)
  })
})

describe('foldPillChips', () => {
  it('keeps every chip while the host has its floor', () => {
    const fold = foldPillChips([anchor, lock], ROOM_412)
    expect(fold).toEqual({ shown: ['site-info', 'lock'], folded: [], host: 170 })
  })

  it('keeps three chips on the 412 phone without a badge: glyph, shield, lock', () => {
    const fold = foldPillChips([anchor, blockedPlain, lock], ROOM_412)
    expect(fold.folded).toEqual([])
    expect(fold.host).toBe(126)
  })

  it('sheds the lock, then the translate offer, with four chips up (the "e…" case)', () => {
    // Every chip in: 224 − 26 − 68 − 28 − 28 = 74, well under the floor.
    const fold = foldPillChips([anchor, blocked, lock, translate], ROOM_412)
    expect(fold.folded).toEqual(['lock', 'translate'])
    expect(fold.shown).toEqual(['site-info', 'blocked'])
    expect(fold.host).toBe(130)
    expect(fold.host).toBeGreaterThanOrEqual(PILL_HOST_FLOOR)
  })

  it('sheds the blocked count before the media chip once media plays (state tier, in order)', () => {
    const fold = foldPillChips([anchor, blocked, lock, translate, media], ROOM_412)
    expect(fold.folded).toEqual(['lock', 'translate', 'blocked'])
    expect(fold.shown).toEqual(['site-info', 'media'])
    expect(fold.host).toBe(170)
  })

  it('stops folding as soon as the host has the floor', () => {
    // 224 − 26 − 68 − 28 = 102: one informational chip back gives 130.
    const fold = foldPillChips([anchor, blocked, lock], ROOM_412)
    expect(fold.folded).toEqual(['lock'])
    expect(fold.host).toBe(130)
  })

  it('keeps the shown chips in the order they were given', () => {
    const fold = foldPillChips([anchor, blocked, lock, translate, media], ROOM_412 + 56)
    // 280 − 178 = 102 → the lock goes (130): the rest keep their places.
    expect(fold.shown).toEqual(['site-info', 'blocked', 'translate', 'media'])
    expect(fold.folded).toEqual(['lock'])
  })

  it('folds nothing on a wide pill (a tablet, a phone in landscape)', () => {
    const fold = foldPillChips([anchor, blocked, lock, translate, savePrompt, media], 700)
    expect(fold.folded).toEqual([])
    expect(fold.shown).toHaveLength(6)
  })

  it('never folds the site-information glyph, whatever the room', () => {
    expect(foldPillChips([anchor], 100)).toEqual({ shown: ['site-info'], folded: [], host: 74 })
    const fold = foldPillChips([anchor, blocked, lock, translate, media], 150)
    expect(fold.shown).toEqual(['site-info'])
    expect(fold.folded).toEqual(['lock', 'translate', 'blocked', 'media'])
    expect(fold.host).toBe(124)
  })

  it('leaves the host under the floor only once nothing more can fold', () => {
    const fold = foldPillChips([anchor, blocked], 140)
    expect(fold.folded).toEqual(['blocked'])
    expect(fold.host).toBe(114)
  })

  it('folds nothing on a pill that has not been laid out (room 0)', () => {
    const fold = foldPillChips([anchor, blocked, lock, translate, media], 0)
    expect(fold.folded).toEqual([])
    expect(fold.shown).toHaveLength(5)
  })

  it('takes another floor', () => {
    const fold = foldPillChips([anchor, blocked, lock, translate], ROOM_412, 60)
    expect(fold).toEqual({
      shown: ['site-info', 'blocked', 'lock', 'translate'],
      folded: [],
      host: 74
    })
  })

  it('is deterministic', () => {
    const chips = [anchor, blocked, lock, translate, media]
    expect(foldPillChips(chips, ROOM_412)).toEqual(foldPillChips(chips, ROOM_412))
    expect(foldPillChips([...chips], ROOM_412)).toEqual(foldPillChips(chips, ROOM_412))
  })

  describe('at the system font scale 1.3', () => {
    // The controls hold in px (the lead's #237 verdict): the chips' boxes and the floor are what
    // they were at 1.0; only the text inside them grew. The fold is the same fold.
    it('folds the same chips for the same px geometry', () => {
      const at10 = foldPillChips([anchor, blocked, lock, translate], ROOM_412)
      const at13 = foldPillChips([anchor, blocked, lock, translate], ROOM_412)
      expect(at13).toEqual(at10)
      expect(at13.host).toBeGreaterThanOrEqual(PILL_HOST_FLOOR)
    })

    it('holds the floor when the badge’s figures grew the blocked chip', () => {
      // The count is text and grows with the zoom: measured 68 at 1.0, say 76 at 1.3. The host
      // still keeps its 120: 224 − 26 − 76 = 122.
      const grown: PillChipSpec = { id: 'blocked', width: pillChipCost(68) }
      const fold = foldPillChips([anchor, grown, lock, translate], ROOM_412)
      expect(fold.shown).toEqual(['site-info', 'blocked'])
      expect(fold.host).toBe(122)
      expect(fold.host).toBeGreaterThanOrEqual(PILL_HOST_FLOOR)
    })

    it('sheds the badge chip too once its figures alone would take the floor', () => {
      // 224 − 26 − 84 = 114 < 120 and no informational chip left: the count folds, media stays.
      const wide: PillChipSpec = { id: 'blocked', width: pillChipCost(76) }
      const fold = foldPillChips([anchor, wide, media], ROOM_412)
      expect(fold.folded).toEqual(['blocked'])
      expect(fold.shown).toEqual(['site-info', 'media'])
      expect(fold.host).toBe(170)
    })
  })
})

describe('foldedChipsSpoken', () => {
  it('speaks the folded chips’ states in order, and nothing when nothing folded', () => {
    expect(foldedChipsSpoken(['12 requests blocked', 'Now playing'])).toBe(
      '12 requests blocked, Now playing'
    )
    expect(foldedChipsSpoken([])).toBe('')
    expect(foldedChipsSpoken(['', 'Translation offered'])).toBe('Translation offered')
  })
})
