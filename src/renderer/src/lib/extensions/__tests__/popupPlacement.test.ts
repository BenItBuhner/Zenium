import { describe, expect, it } from 'vitest'
import type { Anchor } from '@renderer/lib/anchor'
import { POPOVER_MARGIN } from '@renderer/lib/portals'
import {
  POPUP_DEFAULT,
  POPUP_MAX,
  POPUP_MIN,
  POPUP_PADDING,
  POPUP_RADIUS,
  RADIUS_FLOOR,
  placePopup
} from '../popupPlacement'

const viewport = { width: 1280, height: 800 }
/** A 28 button in the sidebar's 32 toolbar row (x 8–348), centred in it. */
const bar = { x: 8, y: 10, width: 340, height: 32 }
const button = (x: number, inBar = true): Anchor => ({
  x,
  y: 12,
  width: 28,
  height: 28,
  ...(inBar ? { bar } : {})
})

describe('placePopup', () => {
  it('opens flush under the bar with the frame around the document (§9.20 via placePopover)', () => {
    const p = placePopup({ anchor: button(40), content: { width: 380, height: 420 }, viewport })
    expect(p.frame.y).toBe(bar.y + bar.height)
    expect(p.frame.x).toBe(40)
    expect(p.frame.width).toBe(380 + 2 * POPUP_PADDING)
    expect(p.frame.height).toBe(420 + 2 * POPUP_PADDING)
  })

  it('hangs under the button itself when it sits in no bar', () => {
    const p = placePopup({
      anchor: button(40, false),
      content: { width: 380, height: 420 },
      viewport
    })
    expect(p.frame.y).toBe(12 + 28)
  })

  it('the view sits inside the frame at the padding, concentric with the corner', () => {
    const p = placePopup({ anchor: button(40), content: { width: 380, height: 420 }, viewport })
    expect(p.inner).toEqual({
      x: p.frame.x + POPUP_PADDING,
      y: p.frame.y + POPUP_PADDING,
      width: 380,
      height: 420
    })
    expect(p.radius).toBe(POPUP_RADIUS)
    expect(p.innerRadius).toBe(POPUP_RADIUS - POPUP_PADDING)
    expect(p.innerRadius).toBeGreaterThanOrEqual(RADIUS_FLOOR)
  })

  it('end-aligns with a button in the trailing half of its bar', () => {
    const p = placePopup({ anchor: button(300), content: { width: 100, height: 300 }, viewport })
    expect(p.frame.x + p.frame.width).toBe(300 + 28)
  })

  it('flips its alignment when the aligned box would cross the margin (§9.20: flip first)', () => {
    // Trailing half of a bar at the window's left edge: end-aligning 382 would leave the window,
    // so the frame start-aligns on the same button instead.
    const p = placePopup({ anchor: button(300), content: { width: 380, height: 300 }, viewport })
    expect(p.frame.x).toBe(300)
    expect(p.side).toBe('below')
    // A lone button by the right edge: start-aligned it would leave, so it end-aligns.
    const near = placePopup({
      anchor: button(1200, false),
      content: { width: 380, height: 300 },
      viewport
    })
    expect(near.frame.x + near.frame.width).toBe(1200 + 28)
  })

  it('slides the least distance inside the margins when neither alignment fits, then shrinks', () => {
    // Neither alignment of a 700 frame fits a 720 window from a button at 300: the frame slides
    // to the margin and still overlaps its button.
    const slid = placePopup({
      anchor: button(300),
      content: { width: 700, height: 300 },
      viewport: { width: 720, height: 800 }
    })
    expect(slid.frame.x).toBe(POPOVER_MARGIN)
    expect(slid.frame.width).toBe(700 + 2 * POPUP_PADDING)
    expect(slid.frame.x).toBeLessThan(300 + 28)
    expect(slid.frame.x + slid.frame.width).toBeGreaterThan(300)
    // Wider than the window minus 16: shrunk to that and centred, the view inside it narrower
    // than the manifest asked.
    const wide = placePopup({
      anchor: button(300),
      content: { width: 800, height: 300 },
      viewport: { width: 600, height: 800 }
    })
    expect(wide.frame.x).toBe(POPOVER_MARGIN)
    expect(wide.frame.x + wide.frame.width).toBe(600 - POPOVER_MARGIN)
    expect(wide.inner.width).toBe(600 - 2 * POPOVER_MARGIN - 2 * POPUP_PADDING)
  })

  it('flips above the bar when the room there is greater, ending flush on its top edge', () => {
    // A bar low in a short window: 300 of document does not fit the 60 below it.
    const lowBar = { x: 8, y: 700, width: 340, height: 32 }
    const p = placePopup({
      anchor: { x: 40, y: 702, width: 28, height: 28, bar: lowBar },
      content: { width: 380, height: 300 },
      viewport
    })
    expect(p.side).toBe('above')
    expect(p.frame.y + p.frame.height).toBe(lowBar.y)
    expect(p.frame.height).toBe(300 + 2 * POPUP_PADDING)
    expect(p.frame.y).toBeGreaterThanOrEqual(POPOVER_MARGIN)
    expect(p.inner.y).toBe(p.frame.y + POPUP_PADDING)
  })

  it("keeps the manifest's size: Chrome's limits and the window, not §9.20's widths or 60%", () => {
    const big = placePopup({ anchor: button(300), content: { width: 1200, height: 900 }, viewport })
    expect(big.inner.width).toBe(POPUP_MAX.width)
    expect(big.inner.height).toBe(POPUP_MAX.height)
    expect(big.inner.height).toBeGreaterThan(viewport.height * 0.6)
    const tiny = placePopup({ anchor: button(300), content: { width: 1, height: 1 }, viewport })
    expect(tiny.inner.width).toBe(POPUP_MIN.width)
    expect(tiny.inner.height).toBe(POPUP_MIN.height)
    // As tall as asked below a bar at the top, not shrunk to a 60% of the window.
    const tall = placePopup({ anchor: button(300), content: { width: 380, height: 590 }, viewport })
    expect(tall.inner.height).toBe(590)
    expect(tall.side).toBe('below')
    // A window too short for it: the frame shrinks to the room, never past the margin.
    const short = placePopup({
      anchor: button(300),
      content: { width: 380, height: 590 },
      viewport: { width: 1280, height: 400 }
    })
    expect(short.frame.y + short.frame.height).toBe(400 - POPOVER_MARGIN)
    expect(short.frame.y).toBe(bar.y + bar.height)
    expect(short.inner.height).toBe(short.frame.height - 2 * POPUP_PADDING)
  })

  it('rounds to whole pixels for the view bounds main sets', () => {
    const p = placePopup({
      anchor: { x: 40.4, y: 12.6, width: 28, height: 28, bar: { ...bar, y: 10.2 } },
      content: { width: 380.6, height: 420.2 },
      viewport
    })
    for (const n of [p.frame.x, p.frame.y, p.frame.width, p.frame.height, p.inner.width]) {
      expect(Number.isInteger(n)).toBe(true)
    }
  })

  it('opens at the default size until the document reports one', () => {
    const p = placePopup({ anchor: button(300), content: null, viewport })
    expect(p.inner.width).toBe(POPUP_DEFAULT.width)
    expect(p.inner.height).toBe(POPUP_DEFAULT.height)
  })
})
