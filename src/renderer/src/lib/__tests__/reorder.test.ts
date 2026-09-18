import { describe, expect, it } from 'vitest'
import { gapCentre, slideOffsets, slotAt, slotKey, type Span } from '../reorder'

/** Four rows of 36 with a 2 px gap, the third one (index 2) lifted: the others' resting spans. */
const ROW = 36
const GAP = 2
const SHIFT = ROW + GAP
const others: Span[] = [0, 1, 3].map((i) => ({ start: i * SHIFT, end: i * SHIFT + ROW }))
const own: Span = { start: 2 * SHIFT, end: 2 * SHIFT + ROW }
const LIFTED_AT = 2
const ids = ['a', 'b', 'd']

describe('slotAt', () => {
  const mids = others.map((s) => (s.start + s.end) / 2)

  it('is the number of items whose midpoint the pointer has passed', () => {
    expect(slotAt(-10, mids)).toBe(0)
    expect(slotAt(mids[0] + 1, mids)).toBe(1)
    expect(slotAt(mids[2] + 1, mids)).toBe(3)
  })

  it('leaves an item on the pointer side it is on until its midpoint is crossed', () => {
    expect(slotAt(mids[1] - 1, mids)).toBe(1)
    expect(slotAt(mids[1], mids)).toBe(1)
    expect(slotAt(mids[1] + 0.5, mids)).toBe(2)
  })

  it('is 0 for an empty list', () => {
    expect(slotAt(100, [])).toBe(0)
  })
})

describe('slideOffsets', () => {
  it('moves nothing while the pointer is over the hole', () => {
    expect(slideOffsets(LIFTED_AT, LIFTED_AT, 3, SHIFT)).toEqual([0, 0, 0])
  })

  it('slides the items between the hole and a slot below it up by one row', () => {
    expect(slideOffsets(LIFTED_AT, 3, 3, SHIFT)).toEqual([0, 0, -SHIFT])
  })

  it('slides the items between a slot above and the hole down by one row', () => {
    expect(slideOffsets(LIFTED_AT, 0, 3, SHIFT)).toEqual([SHIFT, SHIFT, 0])
    expect(slideOffsets(LIFTED_AT, 1, 3, SHIFT)).toEqual([0, SHIFT, 0])
  })

  it('handles the hole at either end', () => {
    expect(slideOffsets(0, 2, 3, SHIFT)).toEqual([-SHIFT, -SHIFT, 0])
    expect(slideOffsets(3, 1, 3, SHIFT)).toEqual([0, SHIFT, SHIFT])
  })
})

describe('gapCentre', () => {
  it('is the lifted row itself over the hole', () => {
    expect(gapCentre(LIFTED_AT, LIFTED_AT, others, own)).toBe(own.start + ROW / 2)
  })

  it('opens where the row that slid up used to end, past the hole', () => {
    // Dropping after d (which slid up into the hole): the gap is d's old slot.
    expect(gapCentre(LIFTED_AT, 3, others, own)).toBe(others[2].end - ROW / 2)
    expect(gapCentre(LIFTED_AT, 3, others, own)).toBe(3 * SHIFT + ROW / 2)
  })

  it('opens where the row that slid down used to start, before the hole', () => {
    expect(gapCentre(LIFTED_AT, 0, others, own)).toBe(others[0].start + ROW / 2)
    expect(gapCentre(LIFTED_AT, 1, others, own)).toBe(1 * SHIFT + ROW / 2)
  })
})

describe('slotKey', () => {
  it('names the neighbour the row lands beside', () => {
    expect(slotKey(ids, LIFTED_AT, 3)).toEqual({ key: 'tab:d:after', stay: false })
    expect(slotKey(ids, LIFTED_AT, 0)).toEqual({ key: 'tab:a:before', stay: false })
    expect(slotKey(ids, LIFTED_AT, 1)).toEqual({ key: 'tab:b:before', stay: false })
  })

  it('is a stay over the hole, with the key that would keep the row put', () => {
    expect(slotKey(ids, LIFTED_AT, LIFTED_AT)).toEqual({ key: 'tab:b:after', stay: true })
    expect(slotKey(ids, 0, 0)).toEqual({ key: 'tab:a:before', stay: true })
    expect(slotKey([], 0, 0)).toEqual({ key: null, stay: true })
  })
})
