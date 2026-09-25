import { describe, expect, it } from 'vitest'
import { framelessPopupBounds } from '../extensions'

/** The sweep window (1400x900 Xvfb) less the chrome: what `getContentBounds()` reads. */
const CONTENT = { width: 1400, height: 860 }
/** A toolbar button at the right end of the toolbar, the anchor `ApiHost.openPopup` places. */
const ANCHOR = { x: CONTENT.width - 56, y: 8, width: 40, height: 32 }

describe('framelessPopupBounds: the popup follows its document', () => {
  it('starts at the initial size under the anchor, right edge on the anchor’s', () => {
    const b = framelessPopupBounds(ANCHOR, { width: 380, height: 200 }, CONTENT)
    expect(b).toEqual({ x: ANCHOR.x + ANCHOR.width - 380, y: 8 + 32 + 6, width: 380, height: 200 })
  })

  it('follows the width the document reports, as it follows the height (Emoji Keyboard: 490x515)', () => {
    const b = framelessPopupBounds(ANCHOR, { width: 490, height: 515 }, CONTENT)
    expect(b.width).toBe(490)
    expect(b.height).toBe(515)
    // The right edge stays on the anchor's: the popup grew to the left.
    expect(b.x + b.width).toBe(ANCHOR.x + ANCHOR.width)
  })

  it('shifts left as the document widens, so it stays on screen', () => {
    const narrow = framelessPopupBounds(ANCHOR, { width: 380, height: 300 }, CONTENT)
    const wide = framelessPopupBounds(ANCHOR, { width: 700, height: 300 }, CONTENT)
    expect(wide.x).toBe(narrow.x - (700 - 380))
    expect(wide.x + wide.width).toBeLessThanOrEqual(CONTENT.width - 8)
  })

  it('clamps to Chrome’s limits: at most 800x600, at least 25x25', () => {
    const big = framelessPopupBounds(ANCHOR, { width: 1200, height: 900 }, CONTENT)
    expect(big.width).toBe(800)
    expect(big.height).toBe(600)
    const tiny = framelessPopupBounds(ANCHOR, { width: 1, height: 0 }, CONTENT)
    expect(tiny.width).toBe(25)
    expect(tiny.height).toBe(25)
  })

  it('never exceeds the window’s content width, with the margin on both sides', () => {
    const small = { width: 500, height: 600 }
    const b = framelessPopupBounds(
      { x: 444, y: 8, width: 40, height: 32 },
      { width: 800, height: 300 },
      small
    )
    expect(b.width).toBe(500 - 16)
    expect(b.x).toBe(8)
  })

  it('never runs past the left margin for an anchor near the left edge', () => {
    const b = framelessPopupBounds(
      { x: 10, y: 8, width: 40, height: 32 },
      { width: 490, height: 300 },
      CONTENT
    )
    expect(b.x).toBe(8)
  })

  it('never runs past the right margin for an anchor hanging over the right edge', () => {
    const b = framelessPopupBounds(
      { x: CONTENT.width - 20, y: 8, width: 40, height: 32 },
      { width: 380, height: 300 },
      CONTENT
    )
    expect(b.x + b.width).toBe(CONTENT.width - 8)
  })

  it('cuts the height at the content area’s bottom, as before', () => {
    const b = framelessPopupBounds(
      ANCHOR,
      { width: 380, height: 600 },
      { width: 1400, height: 400 }
    )
    expect(b.y).toBe(46)
    expect(b.height).toBe(400 - 46 - 8)
  })

  it('rounds every edge to whole pixels', () => {
    const b = framelessPopupBounds(
      { x: 100.4, y: 8.6, width: 40.2, height: 32.3 },
      { width: 489.5, height: 514.5 },
      CONTENT
    )
    for (const v of Object.values(b)) expect(Number.isInteger(v)).toBe(true)
  })
})
