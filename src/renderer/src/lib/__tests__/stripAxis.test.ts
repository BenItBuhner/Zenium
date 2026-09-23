// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { measureRow } from '../hoverCard'
import { AUTOSCROLL_MAX_STEP, InsertionCaret, autoscrollStep } from '../insertionCaret'

/**
 * The seams the horizontal strip (v2 §9.37) turns in the sidebar's row machinery: a row's
 * measure carries the band as its list with the axis marked, the insertion caret stands
 * upright in the gap between two tabs and glides along x, and autoscroll reads the region's
 * left and right edges.
 */

function box(el: HTMLElement, x: number, y: number, width: number, height: number): void {
  el.getBoundingClientRect = () =>
    ({
      x,
      y,
      left: x,
      top: y,
      width,
      height,
      right: x + width,
      bottom: y + height,
      toJSON: () => ({})
    }) as DOMRect
}

describe('measureRow', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('reads a strip row against the band, the axis turned', () => {
    const band = document.createElement('div')
    band.setAttribute('data-tab-strip', '')
    const row = document.createElement('div')
    band.append(row)
    document.body.append(band)
    box(band, 0, 0, 1600, 38)
    box(row, 226, 6, 177, 32)
    expect(measureRow(row)).toEqual({
      anchor: { x: 226, y: 6, width: 177, height: 32 },
      sidebar: { x: 0, y: 0, width: 1600, height: 38 },
      axis: 'x'
    })
  })

  it('reads a sidebar row against its aside with no axis, and nothing for a row off the DOM', () => {
    const aside = document.createElement('aside')
    const row = document.createElement('div')
    aside.append(row)
    document.body.append(aside)
    box(aside, 0, 0, 240, 1000)
    box(row, 8, 120, 224, 36)
    expect(measureRow(row)).toEqual({
      anchor: { x: 8, y: 120, width: 224, height: 36 },
      sidebar: { x: 0, y: 0, width: 240, height: 1000 }
    })
    row.remove()
    expect(measureRow(row)).toBeNull()
  })

  it('a row in neither list measures nothing', () => {
    const row = document.createElement('div')
    document.body.append(row)
    expect(measureRow(row)).toBeNull()
  })
})

describe('InsertionCaret along the strip', () => {
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 1
  let now = 0

  function runFrames(count: number, dt = 16): void {
    for (let i = 0; i < count; i++) {
      now += dt
      const due = [...frames.values()]
      frames.clear()
      for (const cb of due) cb(now)
    }
  }

  function settle(max = 600): number {
    let n = 0
    while (frames.size > 0 && n < max) {
      runFrames(1)
      n++
    }
    return n
  }

  const translateX = (el: HTMLElement): number => {
    // The x term carries its unit; the untouched y term is a bare 0.
    const m = /^translate3d\((-?[\d.]+)px, 0, 0\)$/.exec(el.style.transform)
    expect(m, el.style.transform).not.toBeNull()
    return Number(m?.[1])
  }

  beforeEach(() => {
    frames.clear()
    nextFrame = 1
    now = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      const id = nextFrame++
      frames.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
      frames.delete(id)
    })
    vi.stubGlobal('performance', { now: () => now })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('stands upright in the gap: 2 wide, the row’s height less the 4 inset, centred on x', () => {
    const caret = new InsertionCaret()
    const el = document.createElement('div')
    caret.register(el)
    expect(el.style.opacity).toBe('0')
    caret.show({ axis: 'x', x: 405, y: 10, height: 24 })
    expect(el.style.width).toBe('2px')
    expect(el.style.height).toBe('24px')
    expect(el.style.top).toBe('10px')
    expect(el.style.left).toBe('0px')
    expect(el.style.opacity).toBe('1')
    // The 2 px line centred on the gap: its left edge 1 short of the centre.
    expect(translateX(el)).toBe(404)
    expect(frames.size).toBe(0)
  })

  it('glides to the next gap on the spring, never jumping', () => {
    const caret = new InsertionCaret()
    const el = document.createElement('div')
    caret.register(el)
    caret.show({ axis: 'x', x: 405, y: 10, height: 24 })
    caret.show({ axis: 'x', x: 586, y: 10, height: 24 })
    // A frame is asked for and the first frame moves it part of the way.
    expect(frames.size).toBe(1)
    runFrames(1)
    const after = translateX(el)
    expect(after).toBeGreaterThan(404)
    expect(after).toBeLessThan(585)
    settle()
    expect(translateX(el)).toBeCloseTo(585, 0)
  })

  it('turning the axis mid-drag redraws in place instead of gliding across', () => {
    const caret = new InsertionCaret()
    const el = document.createElement('div')
    caret.register(el)
    caret.show({ x: 8, y: 200, width: 224 })
    expect(el.style.height).toBe('2px')
    expect(el.style.transform).toBe('translate3d(0, 199px, 0)')
    caret.show({ axis: 'x', x: 405, y: 10, height: 24 })
    expect(frames.size).toBe(0)
    expect(el.style.transform).toBe('translate3d(404px, 0, 0)')
    caret.hide()
    expect(el.style.opacity).toBe('0')
  })
})

describe('autoscrollStep along x', () => {
  const region = { left: 100, right: 900, top: 6, bottom: 38 }

  it('is still in the middle of the region and off it', () => {
    expect(autoscrollStep(region, 500, 20, 'x')).toBe(0)
    // Outside the band's height: no scroll.
    expect(autoscrollStep(region, 110, 60, 'x')).toBe(0)
  })

  it('scrolls back the closer the pointer is to the left edge, on the fastest step at the edge', () => {
    expect(autoscrollStep(region, 100, 20, 'x')).toBe(-AUTOSCROLL_MAX_STEP)
    expect(autoscrollStep(region, 116, 20, 'x')).toBeCloseTo(-AUTOSCROLL_MAX_STEP / 2, 6)
    expect(autoscrollStep(region, 132, 20, 'x')).toBe(0)
  })

  it('scrolls on towards the right edge the same way', () => {
    expect(autoscrollStep(region, 900, 20, 'x')).toBe(AUTOSCROLL_MAX_STEP)
    expect(autoscrollStep(region, 884, 20, 'x')).toBeCloseTo(AUTOSCROLL_MAX_STEP / 2, 6)
  })

  it('reads the same numbers a column reads along y', () => {
    const column = { left: 0, right: 240, top: 100, bottom: 900 }
    for (const d of [0, 8, 16, 24, 31]) {
      expect(autoscrollStep(region, 100 + d, 20, 'x')).toBe(autoscrollStep(column, 20, 100 + d))
      expect(autoscrollStep(region, 900 - d, 20, 'x')).toBe(autoscrollStep(column, 20, 900 - d))
    }
  })
})
