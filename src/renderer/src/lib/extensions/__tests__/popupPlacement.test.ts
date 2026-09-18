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

  it('clamps 8 inside the window rather than flipping its alignment', () => {
    // Trailing half of a bar at the window's left edge: end-aligning 382 would leave the window.
    const p = placePopup({ anchor: button(300), content: { width: 380, height: 300 }, viewport })
    expect(p.frame.x).toBe(POPOVER_MARGIN)
    const near = placePopup({
      anchor: button(1200, false),
      content: { width: 380, height: 300 },
      viewport
    })
    expect(near.frame.x + near.frame.width).toBe(viewport.width - POPOVER_MARGIN)
    const wide = placePopup({
      anchor: button(300),
      content: { width: 2000, height: 300 },
      viewport: { width: 600, height: 800 }
    })
    expect(wide.frame.x).toBe(POPOVER_MARGIN)
    expect(wide.frame.x + wide.frame.width).toBe(600 - POPOVER_MARGIN)
  })

  it("keeps the manifest's size: Chrome's limits and the window, not §9.20's widths or 60%", () => {
    const big = placePopup({ anchor: button(300), content: { width: 1200, height: 900 }, viewport })
    expect(big.inner.width).toBe(POPUP_MAX.width)
    expect(big.inner.height).toBe(POPUP_MAX.height)
    expect(big.inner.height).toBeGreaterThan(viewport.height * 0.6)
    const tiny = placePopup({ anchor: button(300), content: { width: 1, height: 1 }, viewport })
    expect(tiny.inner.width).toBe(POPUP_MIN.width)
    expect(tiny.inner.height).toBe(POPUP_MIN.height)
    const short = placePopup({
      anchor: button(300),
      content: { width: 380, height: 590 },
      viewport: { width: 1280, height: 400 }
    })
    expect(short.frame.y + short.frame.height).toBeLessThanOrEqual(400 - POPOVER_MARGIN)
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
