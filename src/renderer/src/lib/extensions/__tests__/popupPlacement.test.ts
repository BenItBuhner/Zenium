import { describe, expect, it } from 'vitest'
import {
  POPOVER_WIDTH,
  POPUP_DEFAULT,
  POPUP_MAX,
  POPUP_MIN,
  POPUP_PADDING,
  POPUP_RADIUS,
  RADIUS_FLOOR,
  anchorBelow,
  placePopup
} from '../popupPlacement'

const viewport = { width: 1280, height: 800 }
/** A 28 button in the sidebar's 32 toolbar row (x 8–348), centred in it. */
const bar = { x: 8, y: 10, width: 340, height: 32 }
const button = (x: number, inBar = true): Parameters<typeof anchorBelow>[0] => ({
  x,
  y: 12,
  width: 28,
  height: 28,
  ...(inBar ? { bar } : {})
})

describe('anchorBelow (v2 §9.20)', () => {
  it('sits flush with the bottom edge of the bar, not the button', () => {
    const p = anchorBelow(button(40), { width: 320, height: 200 }, viewport)
    expect(p.y).toBe(bar.y + bar.height)
    expect(p.y).toBe(12 + 28 + 2)
  })

  it('hangs under the button itself when it sits in no bar', () => {
    const p = anchorBelow(button(40, false), { width: 320, height: 200 }, viewport)
    expect(p.y).toBe(12 + 28)
  })

  it('start-aligns with an anchor in the leading half of its bar', () => {
    const p = anchorBelow(button(40), { width: 320, height: 200 }, viewport)
    expect(p.x).toBe(40)
    expect(p.side).toBe('left')
  })

  it('end-aligns with an anchor in the trailing half of its bar', () => {
    const p = anchorBelow(button(300), { width: 100, height: 200 }, viewport)
    expect(p.x + p.width).toBe(300 + 28)
    expect(p.side).toBe('right')
  })

  it('flips to the other alignment when the preferred one would leave the window', () => {
    // Trailing half of a bar at the window's left edge: end-aligning a 400 panel would leave it.
    const p = anchorBelow(button(300), { width: POPOVER_WIDTH.form, height: 200 }, viewport)
    expect(p.x).toBe(300)
    expect(p.side).toBe('left')
    // Leading half, but 1180 + 320 leaves a 1280 window: the popover hangs from its end.
    const near = { ...button(1180, false) }
    const q = anchorBelow(near, { width: 320, height: 200 }, viewport)
    expect(q.x + q.width).toBe(1180 + 28)
    expect(q.side).toBe('right')
  })

  it('clamps 8px inside the window when neither alignment fits', () => {
    const p = anchorBelow(button(300), { width: 2000, height: 200 }, { width: 600, height: 800 })
    expect(p.x).toBe(8)
    const tall = anchorBelow(button(40), { width: 320, height: 900 }, viewport)
    expect(tall.y).toBe(8)
  })
})

describe('placePopup', () => {
  it('opens flush under the bar with the frame around the document', () => {
    const p = placePopup({ anchor: button(40), content: { width: 380, height: 420 }, viewport })
    expect(p.frame.y).toBe(bar.y + bar.height)
    expect(p.frame.x).toBe(40)
    expect(p.side).toBe('left')
    expect(p.frame.width).toBe(380 + 2 * POPUP_PADDING)
    expect(p.frame.height).toBe(420 + 2 * POPUP_PADDING)
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

  it('hangs from its right edge when the button is near the window edge', () => {
    const p = placePopup({
      anchor: button(1200, false),
      content: { width: 380, height: 300 },
      viewport
    })
    expect(p.side).toBe('right')
    expect(p.frame.x + p.frame.width).toBe(1200 + 28)
    expect(p.frame.x + p.frame.width).toBeLessThanOrEqual(viewport.width - 8)
  })

  it('never leaves the window', () => {
    const p = placePopup({
      anchor: button(2, false),
      content: { width: 380, height: 300 },
      viewport
    })
    expect(p.frame.x).toBe(8)
    const wide = placePopup({
      anchor: button(300),
      content: { width: 2000, height: 300 },
      viewport: { width: 600, height: 800 }
    })
    expect(wide.frame.x).toBe(8)
    expect(wide.frame.x + wide.frame.width).toBe(600 - 8)
  })

  it('applies Chrome popup limits and the window height', () => {
    const big = placePopup({ anchor: button(300), content: { width: 1200, height: 900 }, viewport })
    expect(big.inner.width).toBe(POPUP_MAX.width)
    expect(big.inner.height).toBe(POPUP_MAX.height)
    const tiny = placePopup({ anchor: button(300), content: { width: 1, height: 1 }, viewport })
    expect(tiny.inner.width).toBe(POPUP_MIN.width)
    expect(tiny.inner.height).toBe(POPUP_MIN.height)
    const short = placePopup({
      anchor: button(300),
      content: { width: 380, height: 590 },
      viewport: { width: 1280, height: 400 }
    })
    expect(short.frame.y + short.frame.height).toBeLessThanOrEqual(400 - 8)
  })

  it('opens at the default size until the document reports one', () => {
    const p = placePopup({ anchor: button(300), content: null, viewport })
    expect(p.inner.width).toBe(POPUP_DEFAULT.width)
    expect(p.inner.height).toBe(POPUP_DEFAULT.height)
  })
})
