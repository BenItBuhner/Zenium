import { describe, expect, it } from 'vitest'
import {
  POPUP_ANCHOR_INSET,
  POPUP_DEFAULT,
  POPUP_GAP,
  POPUP_MAX,
  POPUP_MIN,
  POPUP_PADDING,
  POPUP_RADIUS,
  placePopup
} from '../popupPlacement'

const viewport = { width: 1280, height: 800 }
const button = (x: number): { x: number; y: number; width: number; height: number } => ({
  x,
  y: 12,
  width: 28,
  height: 28
})

describe('placePopup', () => {
  it('hangs 8px below the button with its centre 20px into the frame', () => {
    const p = placePopup({ anchor: button(300), content: { width: 380, height: 420 }, viewport })
    expect(p.frame.y).toBe(12 + 28 + POPUP_GAP)
    expect(p.frame.x).toBe(300 + 14 - POPUP_ANCHOR_INSET)
    expect(p.side).toBe('left')
    expect(p.frame.width).toBe(380 + 2 * POPUP_PADDING)
    expect(p.frame.height).toBe(420 + 2 * POPUP_PADDING)
  })

  it('the view sits inside the frame at the padding, concentric with the corner', () => {
    const p = placePopup({ anchor: button(300), content: { width: 380, height: 420 }, viewport })
    expect(p.inner).toEqual({
      x: p.frame.x + POPUP_PADDING,
      y: p.frame.y + POPUP_PADDING,
      width: 380,
      height: 420
    })
    expect(p.radius).toBe(POPUP_RADIUS)
    expect(p.innerRadius).toBe(POPUP_RADIUS - POPUP_PADDING)
    expect(p.innerRadius).toBeGreaterThanOrEqual(10)
  })

  it('hangs from its right edge when the button is near the window edge', () => {
    const p = placePopup({ anchor: button(1200), content: { width: 380, height: 300 }, viewport })
    expect(p.side).toBe('right')
    expect(p.frame.x + p.frame.width).toBe(1200 + 14 + POPUP_ANCHOR_INSET)
    expect(p.frame.x + p.frame.width).toBeLessThanOrEqual(viewport.width - 8)
  })

  it('never leaves the window', () => {
    const p = placePopup({ anchor: button(2), content: { width: 380, height: 300 }, viewport })
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
