import { describe, expect, it } from 'vitest'
import { phoneSearchChoiceListHeight } from '../searchChoice'

/*
 * The phone list's box under §9.39's scroller rule (OMN-26): the desktop's numbers – tiles 52
 * on a 56 pitch, the ring room 4 – and the phone's own count, from what its column leaves.
 */
const desktop = { row: 52, gap: 4, ring: 4, count: 8 }

describe('the phone choice list’s box (§9.39)', () => {
  it('shows five whole and the sixth cut at 26 where the desktop panel would: 310', () => {
    // A column that has 5 whole and most of a sixth: the cap lands the fold at half a tile.
    expect(phoneSearchChoiceListHeight({ ...desktop, available: 340 })).toBe(310)
    expect(phoneSearchChoiceListHeight({ ...desktop, available: 310 })).toBe(310)
  })

  it('takes no cap where every tile fits whole – nothing scrolls on a frame tall enough', () => {
    // 8 × 56 − 4 + 2 × 4 = 452.
    expect(phoneSearchChoiceListHeight({ ...desktop, available: 452 })).toBeNull()
    expect(phoneSearchChoiceListHeight({ ...desktop, available: 900 })).toBeNull()
  })

  it('cuts the last tile rather than showing a clean edge just short of all of them', () => {
    // 451 holds 7 whole and all but 1 px of the eighth: the fold is at 7 + half, not a clean 8.
    expect(phoneSearchChoiceListHeight({ ...desktop, available: 451 })).toBe(8 + 7 * 56 - 4 + 26)
  })

  it('shows as many whole as the column has room for, the next cut at half', () => {
    // 6 whole + 26: 8 + 6 × 56 − 4 + 26 = 366; the column has 380.
    expect(phoneSearchChoiceListHeight({ ...desktop, available: 380 })).toBe(366)
    // Just under 366 → five and the cut.
    expect(phoneSearchChoiceListHeight({ ...desktop, available: 365 })).toBe(310)
  })

  it('never fewer than two whole tiles: a short column scrolls the column instead', () => {
    expect(phoneSearchChoiceListHeight({ ...desktop, available: 100 })).toBe(8 + 2 * 56 - 4 + 26)
  })

  it('follows the tile the grid laid out: a wrapped line makes every tile 72, the cut 36', () => {
    const tall = { row: 72, gap: 4, ring: 4, count: 8 }
    // 8 × 76 − 4 + 8 = 612 fits whole in 620; 600 does not → 7 whole + 36.
    expect(phoneSearchChoiceListHeight({ ...tall, available: 620 })).toBeNull()
    expect(phoneSearchChoiceListHeight({ ...tall, available: 600 })).toBe(8 + 7 * 76 - 4 + 36)
  })

  it('measures nothing before layout: an unmeasured tile or an empty list caps nothing', () => {
    expect(phoneSearchChoiceListHeight({ ...desktop, row: 0, available: 300 })).toBeNull()
    expect(phoneSearchChoiceListHeight({ ...desktop, count: 0, available: 300 })).toBeNull()
  })
})
