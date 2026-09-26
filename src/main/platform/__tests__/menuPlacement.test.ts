import { describe, expect, it } from 'vitest'
import { popupPoint } from '../menuPlacement'

/*
 * Where a native menu opens (`platform/menuPlacement.ts`; shortcuts-menus-167, §9.23): a menu
 * that belongs to an element hangs from the element's bottom-left corner, the core's point
 * stands otherwise, and no anchor at all leaves the pointer to Electron. The numbers are DIP
 * relative to the window's content, the chrome document's CSS pixels at zoom 1.
 */

const content = { width: 1600, height: 1000 }

describe('a menu anchored to an element hangs from its bottom-left corner', () => {
  it('takes the element’s left edge and its bottom, not the pointer', () => {
    expect(
      popupPoint({ x: 400, y: 300, rect: { x: 12, y: 40, width: 200, height: 28 } }, content)
    ).toEqual({ x: 12, y: 68 })
  })

  it('rounds a fractional box to whole DIP', () => {
    expect(popupPoint({ rect: { x: 700.4, y: 4.25, width: 19.6, height: 16.6 } }, content)).toEqual(
      { x: 700, y: 21 }
    )
  })

  it('a keyboard menu opened over a text field still hangs from the field, not the caret', () => {
    expect(popupPoint({ x: 500, y: 20, rect: { x: 300, y: 8, width: 600, height: 32 } })).toEqual({
      x: 300,
      y: 40
    })
  })
})

describe('the core’s point stands when it names no element', () => {
  it('passes an anchor point through, rounded', () => {
    expect(popupPoint({ x: 300.6, y: 44.2 }, content)).toEqual({ x: 301, y: 44 })
  })

  it('needs both coordinates – half a point is no point', () => {
    expect(popupPoint({ x: 300 }, content)).toBeUndefined()
    expect(popupPoint({ y: 44 }, content)).toBeUndefined()
  })

  it('no anchor: undefined, and Electron opens at the pointer', () => {
    expect(popupPoint({}, content)).toBeUndefined()
    expect(popupPoint({})).toBeUndefined()
  })
})

describe('an element clipped out of the window anchors at the nearest edge', () => {
  it('a row scrolled above the top hangs from the top edge', () => {
    expect(popupPoint({ rect: { x: 12, y: -60, width: 200, height: 28 } }, content)).toEqual({
      x: 12,
      y: 0
    })
  })

  it('a row below the bottom hangs from the bottom edge', () => {
    expect(popupPoint({ rect: { x: 12, y: 1200, width: 200, height: 28 } }, content)).toEqual({
      x: 12,
      y: 1000
    })
  })

  it('a control off to the right or left stays inside the window', () => {
    expect(popupPoint({ rect: { x: 1700, y: 40, width: 20, height: 20 } }, content)).toEqual({
      x: 1600,
      y: 60
    })
    expect(popupPoint({ x: -30, y: -5 }, content)).toEqual({ x: 0, y: 0 })
  })

  it('without a content size nothing is clamped', () => {
    expect(popupPoint({ rect: { x: -20, y: -60, width: 10, height: 10 } })).toEqual({
      x: -20,
      y: -50
    })
  })
})
