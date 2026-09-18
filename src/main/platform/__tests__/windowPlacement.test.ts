import { describe, expect, it } from 'vitest'
import { centredIn, displayMatching, placeWindow, type DisplayArea } from '../windowPlacement'

const primary: DisplayArea = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1050 } }
const right: DisplayArea = { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 720 } }
const base = { minWidth: 500, minHeight: 300, defaultSize: { width: 1200, height: 800 } }

describe('placeWindow', () => {
  it('centres the default size on the primary display for a window without saved bounds', () => {
    expect(placeWindow({ ...base, saved: null, displayId: null }, [primary, right])).toEqual({
      x: 360,
      y: 125,
      width: 1200,
      height: 800
    })
  })

  it('shrinks the default size into a small primary display', () => {
    const small: DisplayArea = { id: 3, workArea: { x: 0, y: 0, width: 1024, height: 600 } }
    const rect = placeWindow({ ...base, saved: null, displayId: null }, [small])
    expect(rect).toEqual({ x: 20, y: 20, width: 984, height: 560 })
  })

  it('brings a window back exactly where it was on the display it was saved on', () => {
    const saved = { x: 2000, y: 40, width: 1000, height: 600 }
    expect(placeWindow({ ...base, saved, displayId: 2 }, [primary, right])).toEqual(saved)
  })

  it('nudges a window back inside its display when it hangs over the edge', () => {
    const saved = { x: 2800, y: 500, width: 1000, height: 600 }
    expect(placeWindow({ ...base, saved, displayId: 2 }, [primary, right])).toEqual({
      x: 2200,
      y: 120,
      width: 1000,
      height: 600
    })
  })

  it('fits a window that is larger than its display into the work area', () => {
    const saved = { x: 1920, y: 0, width: 1600, height: 1000 }
    expect(placeWindow({ ...base, saved, displayId: 2 }, [primary, right])).toEqual({
      x: 1920,
      y: 0,
      width: 1280,
      height: 720
    })
  })

  it('finds the display the bounds lie on when the saved display id is gone', () => {
    const saved = { x: 2100, y: 100, width: 800, height: 500 }
    expect(placeWindow({ ...base, saved, displayId: 7 }, [primary, right])).toEqual(saved)
  })

  it('centres a window on the primary display when its screen was unplugged', () => {
    const saved = { x: 4000, y: 100, width: 800, height: 500 }
    expect(placeWindow({ ...base, saved, displayId: 9 }, [primary, right])).toEqual({
      x: 560,
      y: 275,
      width: 800,
      height: 500
    })
  })

  it('keeps a window no smaller than its minimum size', () => {
    const saved = { x: 10, y: 10, width: 100, height: 50 }
    expect(placeWindow({ ...base, saved, displayId: 1 }, [primary])).toEqual({
      x: 10,
      y: 10,
      width: 500,
      height: 300
    })
  })

  it('falls back to the default size at the origin when no display is known', () => {
    expect(placeWindow({ ...base, saved: null, displayId: null }, [])).toEqual({
      x: 0,
      y: 0,
      width: 1200,
      height: 800
    })
  })
})

describe('displayMatching and centredIn', () => {
  it('picks the display that holds most of the rectangle', () => {
    expect(displayMatching({ x: 1800, y: 0, width: 400, height: 300 }, [primary, right])).toBe(
      right
    )
    expect(displayMatching({ x: 1700, y: 0, width: 400, height: 300 }, [primary, right])).toBe(
      primary
    )
    expect(displayMatching({ x: 5000, y: 0, width: 400, height: 300 }, [primary, right])).toBeNull()
  })

  it('centres a size inside an area and never exceeds it', () => {
    expect(centredIn(right.workArea, { width: 2000, height: 100 }, 100, 100)).toEqual({
      x: 1920,
      y: 310,
      width: 1280,
      height: 100
    })
  })
})
