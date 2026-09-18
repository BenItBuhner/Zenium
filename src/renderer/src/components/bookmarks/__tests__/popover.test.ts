import { describe, expect, it } from 'vitest'
import { POPOVER_MARGIN, POPOVER_WIDTH, placePopover } from '../popover'

const viewport = { width: 1600, height: 1000 }
const bar = { x: 0, y: 40, width: 1600, height: 30 }

describe('placePopover (design-language-v2-draft §9.20)', () => {
  it('hangs flush from the bottom edge of the bar the anchor sits in, at a fixed width', () => {
    const box = placePopover(
      { x: 100, y: 42, width: 80, height: 26 },
      bar,
      POPOVER_WIDTH.list,
      viewport
    )
    expect(box.top).toBe(70)
    expect(box.width).toBe(320)
  })

  it('start-aligns with an anchor in the leading half of its bar', () => {
    const box = placePopover({ x: 100, y: 42, width: 80, height: 26 }, bar, 320, viewport)
    expect(box.left).toBe(100)
  })

  it('end-aligns with an anchor in the trailing half of its bar', () => {
    const box = placePopover({ x: 1200, y: 42, width: 80, height: 26 }, bar, 320, viewport)
    expect(box.left).toBe(1200 + 80 - 320)
  })

  it('stays 8px inside the window at either edge', () => {
    const left = placePopover({ x: 2, y: 42, width: 20, height: 26 }, bar, 320, viewport)
    expect(left.left).toBe(POPOVER_MARGIN)
    // A trailing anchor narrower than the popover would push it past the left edge of a narrow window.
    const narrow = { width: 300, height: 1000 }
    const squeezed = placePopover(
      { x: 260, y: 42, width: 28, height: 26 },
      { x: 0, y: 40, width: 300, height: 30 },
      320,
      narrow
    )
    expect(squeezed.left).toBe(narrow.width - 320 - POPOVER_MARGIN)
    // End-aligned with an anchor whose own end is 2px from the window's edge.
    const right = placePopover({ x: 1500, y: 42, width: 98, height: 26 }, bar, 320, viewport)
    expect(right.left).toBe(1600 - 320 - POPOVER_MARGIN)
  })

  it('offers at most 60% of the window height, less when the bar sits low', () => {
    const box = placePopover({ x: 100, y: 42, width: 80, height: 26 }, bar, 320, viewport)
    expect(box.maxHeight).toBe(600)
    const low = placePopover(
      { x: 100, y: 902, width: 80, height: 26 },
      { x: 0, y: 900, width: 1600, height: 30 },
      320,
      viewport
    )
    expect(low.maxHeight).toBe(1000 - 930 - POPOVER_MARGIN)
    const short = placePopover({ x: 100, y: 42, width: 80, height: 26 }, bar, 320, {
      width: 1600,
      height: 100
    })
    expect(short.maxHeight).toBe(100 - 70 - POPOVER_MARGIN)
  })

  it('treats a lone anchor as its own bar: the star bubble with no pill on screen', () => {
    const anchor = { x: 1564, y: 28, width: 28, height: 28 }
    const box = placePopover(anchor, anchor, POPOVER_WIDTH.list, viewport)
    expect(box.top).toBe(56)
    expect(box.left).toBe(1600 - 320 - POPOVER_MARGIN)
  })
})
