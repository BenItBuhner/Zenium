import { describe, expect, it } from 'vitest'
import { parkedInCorner, viewInBox } from './views.mjs'

const content = { width: 1280, height: 820 }
const box = { x: 240, y: 48, width: 1032, height: 764 }

describe('parkedInCorner', () => {
  it('reads a box moved so one corner pixel of it is inside the window, in any of its corners', () => {
    // `ElectronTabView.parkedBox`: bottom-right, bottom-left, top-right, top-left.
    expect(parkedInCorner({ ...box, x: 1279, y: 819 }, content)).toBe(true)
    expect(parkedInCorner({ ...box, x: -(box.width - 1), y: 819 }, content)).toBe(true)
    expect(parkedInCorner({ ...box, x: 1279, y: -(box.height - 1) }, content)).toBe(true)
    expect(parkedInCorner({ ...box, x: -(box.width - 1), y: -(box.height - 1) }, content)).toBe(
      true
    )
  })
  it('refuses a box in place, one only partly out, and one wholly out of the window', () => {
    expect(parkedInCorner(box, content)).toBe(false)
    expect(parkedInCorner({ ...box, x: 1000 }, content)).toBe(false)
    expect(parkedInCorner({ ...box, x: 1280, y: 820 }, content)).toBe(false)
    expect(parkedInCorner({ ...box, x: 1278, y: 819 }, content)).toBe(false)
  })
  it('is false with no box or no window to measure against', () => {
    expect(parkedInCorner(null, content)).toBe(false)
    expect(parkedInCorner(box, null)).toBe(false)
  })
})

describe('viewInBox', () => {
  it('is true for a shown view in its box only', () => {
    expect(viewInBox({ visible: true, bounds: box }, content)).toBe(true)
  })
  it('is false for a hidden view and for a parked one alike: the page is behind its picture', () => {
    expect(viewInBox({ visible: false, bounds: box }, content)).toBe(false)
    expect(viewInBox({ visible: true, bounds: { ...box, x: 1279, y: 819 } }, content)).toBe(false)
  })
  it('is null with no view', () => {
    expect(viewInBox(undefined, content)).toBeNull()
  })
})
