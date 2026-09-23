import { describe, expect, it } from 'vitest'
import {
  STRIP_BAND,
  STRIP_BUTTON,
  STRIP_FRAME_TOP,
  STRIP_GAP,
  STRIP_HOLD_MS,
  STRIP_INSET,
  STRIP_LEADING_INSET,
  STRIP_MAC_INSET,
  STRIP_PINNED,
  STRIP_RAIL_WIDTH,
  STRIP_ROW,
  STRIP_SLOT,
  STRIP_SLOT_THRESHOLD,
  STRIP_TAB_MAX,
  STRIP_TAB_MIN,
  STRIP_TEAR_PAST,
  STRIP_TOOLBAR_HEIGHT,
  STRIP_TOOLBAR_TOP,
  hasStateGlyph,
  heldTabWidth,
  stripSlot,
  stripTabRoom,
  stripTabWidth
} from '../tabStripLayout'

/** A row with none of the state marks; a test turns one on. */
const quiet = {
  discarded: false,
  frozen: false,
  cpuThrottle: 1,
  audible: false,
  muted: false,
  alert: null
} as const

describe('the horizontal strip’s numbers (v2 §9.37)', () => {
  it('lays the 32 row in the 38 caption band under a 6 inset, the toolbar row and the frame beneath', () => {
    expect(STRIP_INSET + STRIP_ROW).toBe(STRIP_BAND)
    expect(STRIP_BAND).toBe(38)
    // The toolbar row at y 42–74 (the band plus the 4 gutter), the frame 8 under it.
    expect(STRIP_TOOLBAR_TOP).toBe(42)
    expect(STRIP_TOOLBAR_TOP + STRIP_TOOLBAR_HEIGHT + 8).toBe(STRIP_FRAME_TOP)
    expect(STRIP_RAIL_WIDTH).toBe(56)
  })

  it('draws a tab between 120 and 240, 4 apart, with the sidebar row’s 24 slot and a 32 pinned square', () => {
    expect([STRIP_TAB_MIN, STRIP_TAB_MAX, STRIP_GAP]).toEqual([120, 240, 4])
    expect(STRIP_SLOT).toBe(24)
    expect(STRIP_SLOT_THRESHOLD).toBe(160)
    expect(STRIP_PINNED).toBe(STRIP_ROW)
    // The + and the All tabs button are §9.3's 28 box; the strip starts at the window's 8
    // gutter on Linux and Windows and past the traffic lights on macOS.
    expect(STRIP_BUTTON).toBe(28)
    expect(STRIP_LEADING_INSET).toBe(8)
    expect(STRIP_MAC_INSET).toBe(84)
    expect(STRIP_TEAR_PAST).toBe(16)
    expect(STRIP_HOLD_MS).toBe(120)
  })
})

describe('stripTabWidth', () => {
  it('gives every regular tab 240 while the room allows', () => {
    expect(stripTabWidth(1000, 4)).toEqual({ width: 240, overflow: false })
    expect(stripTabWidth(960, 4)).toEqual({ width: 240, overflow: false })
  })

  it('shrinks the tabs evenly as they come, whole pixels each', () => {
    expect(stripTabWidth(900, 4)).toEqual({ width: 225, overflow: false })
    expect(stripTabWidth(1063, 6)).toEqual({ width: 177, overflow: false })
  })

  it('holds the 120 floor and reports the overflow once the floor no longer fits', () => {
    expect(stripTabWidth(720, 6)).toEqual({ width: 120, overflow: false })
    expect(stripTabWidth(700, 6)).toEqual({ width: 120, overflow: true })
    expect(stripTabWidth(300, 10)).toEqual({ width: 120, overflow: true })
  })

  it('with no regular tab the width is the rest width and nothing overflows', () => {
    expect(stripTabWidth(500, 0)).toEqual({ width: 240, overflow: false })
    expect(stripTabWidth(-20, 0)).toEqual({ width: 240, overflow: false })
  })

  it('treats a negative room as none', () => {
    expect(stripTabWidth(-100, 2)).toEqual({ width: 120, overflow: true })
  })
})

describe('stripTabRoom', () => {
  it('takes the chips and the gap between every item out of the region', () => {
    // Six tabs and one chip 93 wide: seven items, six gaps.
    expect(stripTabRoom(1180, 93, 1, 6)).toBe(1180 - 93 - 6 * STRIP_GAP)
  })

  it('a lone tab has no gap to pay for, and the room never goes negative', () => {
    expect(stripTabRoom(500, 0, 0, 1)).toBe(500)
    expect(stripTabRoom(100, 400, 2, 3)).toBe(0)
  })
})

describe('stripSlot', () => {
  it('keeps the 24 slot at 160 and above whatever the tab shows', () => {
    expect(stripSlot(160, false, false)).toBe('reserved')
    expect(stripSlot(240, false, true)).toBe('reserved')
  })

  it('the active tab keeps its slot (and its ×) at any width', () => {
    expect(stripSlot(120, true, false)).toBe('reserved')
    expect(stripSlot(120, true, true)).toBe('reserved')
  })

  it('under 160 an inactive tab gives the slot to its title, unless a state glyph needs it', () => {
    expect(stripSlot(159, false, false)).toBe('title')
    expect(stripSlot(120, false, false)).toBe('title')
    expect(stripSlot(159, false, true)).toBe('glyph')
  })
})

describe('hasStateGlyph', () => {
  it('is false for a quiet row', () => {
    expect(hasStateGlyph(quiet)).toBe(false)
  })

  it('is true for a sleeping, frozen or throttled row, an alert, sound or a mute', () => {
    expect(hasStateGlyph({ ...quiet, discarded: true })).toBe(true)
    expect(hasStateGlyph({ ...quiet, frozen: true })).toBe(true)
    expect(hasStateGlyph({ ...quiet, cpuThrottle: 2 })).toBe(true)
    expect(hasStateGlyph({ ...quiet, alert: 'recording' })).toBe(true)
    expect(hasStateGlyph({ ...quiet, audible: true })).toBe(true)
    expect(hasStateGlyph({ ...quiet, muted: true })).toBe(true)
  })
})

describe('heldTabWidth', () => {
  it('holds the width of the moment of the close while the pointer stays in the band', () => {
    expect(heldTabWidth(120, true, 137)).toBe(120)
  })

  it('lets the natural width through once the pointer has left, or when nothing is held', () => {
    expect(heldTabWidth(120, false, 137)).toBe(137)
    expect(heldTabWidth(null, true, 137)).toBe(137)
  })
})
