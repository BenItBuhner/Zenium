// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Rect } from '@shared/types'
import {
  IDENTITY,
  isIdentity,
  layoutRectThrough,
  layoutRectUnder,
  onLayoutGrid,
  parseAxisTransform,
  parseOrigin
} from '../layoutRect'
import { RECEDE_SCALE, recedeScale } from '../motion/recede'

/*
 * The layout box under the recede (v2 §11.1; PERF-4's audit). The content frame at `scale(.97)`
 * about its centre paints a viewport 3 percent short and 1.5 percent in from either edge; the
 * page view is laid out from the frame's LAYOUT box, which nothing scales. `layoutRectThrough`
 * runs the painted box back through the frame's transform; `layoutRectUnder` reads that
 * transform off the frame's computed style.
 */

/** A phone's content frame with the bar at the bottom edge: 8 px gutters, under a 24 px inset. */
const frame: Rect = { x: 8, y: 80, width: 396, height: 715 }
const centre = { x: frame.width / 2, y: frame.height / 2 }

/** `rect` as the frame's scale about its centre paints it, the frame's layout box being `frame`. */
function paint(rect: Rect, s: number, origin = centre, translate = { x: 0, y: 0 }): Rect {
  const ox = frame.x + origin.x
  const oy = frame.y + origin.y
  return {
    x: ox + (rect.x - ox) * s + translate.x,
    y: oy + (rect.y - oy) * s + translate.y,
    width: rect.width * s,
    height: rect.height * s
  }
}

function close(actual: Rect, expected: Rect): void {
  expect(actual.x).toBeCloseTo(expected.x, 6)
  expect(actual.y).toBeCloseTo(expected.y, 6)
  expect(actual.width).toBeCloseTo(expected.width, 6)
  expect(actual.height).toBeCloseTo(expected.height, 6)
}

describe('layoutRectThrough: the painted box run back through the frame’s transform', () => {
  it('at rest the painted box is the layout box', () => {
    close(layoutRectThrough(frame, frame, IDENTITY, centre), frame)
  })

  it('the recede’s .97 about the centre: the frame’s own box comes back whole', () => {
    const s = recedeScale(1)
    const painted = paint(frame, s)
    // The painted read PERF-4 saw: 3 percent short – 21.45 px of a 715 px frame.
    expect(frame.height - painted.height).toBeCloseTo(RECEDE_SCALE * frame.height, 6)
    const t = { scaleX: s, scaleY: s, translateX: 0, translateY: 0 }
    close(layoutRectThrough(painted, painted, t, centre), frame)
  })

  it('a viewport inside the frame (under a 3 px load bar, above nothing) comes back to its own layout box, at every recede', () => {
    const viewport: Rect = {
      x: frame.x,
      y: frame.y + 3,
      width: frame.width,
      height: frame.height - 3
    }
    for (const p of [0.1, 0.35, 0.5, 0.97, 1]) {
      const s = recedeScale(p)
      const t = { scaleX: s, scaleY: s, translateX: 0, translateY: 0 }
      close(layoutRectThrough(paint(viewport, s), paint(frame, s), t, centre), viewport)
    }
  })

  it('an origin other than the centre, and a translation, are undone too', () => {
    const origin = { x: 0, y: frame.height }
    const translate = { x: 12, y: -7 }
    const s = 0.9
    const t = { scaleX: s, scaleY: s, translateX: translate.x, translateY: translate.y }
    const viewport: Rect = {
      x: frame.x,
      y: frame.y + 40,
      width: frame.width,
      height: frame.height - 40
    }
    close(
      layoutRectThrough(
        paint(viewport, s, origin, translate),
        paint(frame, s, origin, translate),
        t,
        origin
      ),
      viewport
    )
  })

  it('an unequal scale is run back per axis', () => {
    const t = { scaleX: 0.5, scaleY: 0.8, translateX: 0, translateY: 0 }
    const painted: Rect = {
      x: frame.x + centre.x * 0.5,
      y: frame.y + centre.y * 0.2,
      width: frame.width * 0.5,
      height: frame.height * 0.8
    }
    close(layoutRectThrough(painted, painted, t, centre), frame)
  })

  it('a scale that cannot be run back (0, negative, not a number) answers the painted box as it is', () => {
    const painted = paint(frame, 0.97)
    for (const s of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const t = { scaleX: s, scaleY: s, translateX: 0, translateY: 0 }
      expect(layoutRectThrough(painted, painted, t, centre)).toEqual(painted)
    }
  })

  it('answers on the layout grid (1/64 px), exactly the box a measure at rest reports', () => {
    // A transformed rect reaches getBoundingClientRect through the compositor's floats: each
    // painted value carries float32's rounding (about 1e-4 px at 800 px), and the division adds
    // float64's dust even without it. The layout box the run-back answers is what `sameRect`
    // compares to the re-measure at the recede's rest, and what the host truncates to device
    // pixels: it has to be the rest's value to the bit, not a hair under it.
    const s = recedeScale(1)
    const t = { scaleX: s, scaleY: s, translateX: 0, translateY: 0 }
    const tall: Rect = { x: 8, y: 80, width: 396, height: 824 }
    const viewport: Rect = { x: tall.x, y: tall.y + 3, width: tall.width, height: tall.height - 3 }
    const about = { x: tall.width / 2, y: tall.height / 2 }
    const painted = (r: Rect): Rect => {
      const ox = tall.x + about.x
      const oy = tall.y + about.y
      return { x: ox + (r.x - ox) * s, y: oy + (r.y - oy) * s, width: r.width * s, height: r.height * s }
    }
    const float32 = (r: Rect): Rect => ({
      x: Math.fround(r.x),
      y: Math.fround(r.y),
      width: Math.fround(r.width),
      height: Math.fround(r.height)
    })
    // Float64 inputs: the arithmetic alone is off the grid (7.999999999999993 for 8).
    expect(layoutRectThrough(painted(tall), painted(tall), t, about)).toEqual(tall)
    // Float32 inputs, as the compositor reports them: 823.99999… for 824 before the grid.
    const rough = layoutRectThrough(float32(painted(viewport)), float32(painted(tall)), t, about)
    expect(rough).toEqual(viewport)
    // What the host would have laid out from the ungridded answer, one device pixel short.
    const density = 2.625
    expect(Math.trunc(onLayoutGrid(823.99997) * density)).toBe(Math.trunc(824 * density))
    expect(Math.trunc(823.99997 * density)).toBe(Math.trunc(824 * density) - 1)
    // The grid itself: 1/64 px steps, halves rounded away from zero as Math.round has them.
    expect(onLayoutGrid(0.0078125)).toBe(0.015625)
    expect(onLayoutGrid(357.5)).toBe(357.5)
    expect(onLayoutGrid(357.50001)).toBe(357.5)
  })
})

describe('parseAxisTransform: the computed transform as a scale and a translation', () => {
  it('none, or nothing, is the identity', () => {
    expect(parseAxisTransform('none')).toEqual(IDENTITY)
    expect(parseAxisTransform('')).toEqual(IDENTITY)
    expect(parseAxisTransform(undefined)).toEqual(IDENTITY)
    expect(isIdentity(IDENTITY)).toBe(true)
  })

  it('reads the recede’s matrix as Chromium computes scale(calc(…))', () => {
    expect(parseAxisTransform('matrix(0.97, 0, 0, 0.97, 0, 0)')).toEqual({
      scaleX: 0.97,
      scaleY: 0.97,
      translateX: 0,
      translateY: 0
    })
    expect(isIdentity(parseAxisTransform('matrix(1, 0, 0, 1, 0, 0)')!)).toBe(true)
  })

  it('reads a translation, and a matrix3d without rotation', () => {
    expect(parseAxisTransform('matrix(0.5, 0, 0, 0.8, 12, -7.5)')).toEqual({
      scaleX: 0.5,
      scaleY: 0.8,
      translateX: 12,
      translateY: -7.5
    })
    expect(
      parseAxisTransform('matrix3d(0.97, 0, 0, 0, 0, 0.97, 0, 0, 0, 0, 1, 0, 3, 4, 0, 1)')
    ).toEqual({
      scaleX: 0.97,
      scaleY: 0.97,
      translateX: 3,
      translateY: 4
    })
  })

  it('a rotation or a skew is not run back: null', () => {
    // rotate(45deg)
    expect(parseAxisTransform('matrix(0.7071, 0.7071, -0.7071, 0.7071, 0, 0)')).toBeNull()
    expect(parseAxisTransform('matrix(1, 0.2, 0, 1, 0, 0)')).toBeNull()
    expect(
      parseAxisTransform('matrix3d(1, 0.1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)')
    ).toBeNull()
    expect(parseAxisTransform('perspective(100px)')).toBeNull()
    expect(parseAxisTransform('matrix(1, 0, 0)')).toBeNull()
  })

  it('reads the origin as computed, with or without a z', () => {
    expect(parseOrigin('198px 357.5px')).toEqual({ x: 198, y: 357.5 })
    expect(parseOrigin('198px 357.5px 0px')).toEqual({ x: 198, y: 357.5 })
    expect(parseOrigin('')).toEqual({ x: 0, y: 0 })
  })
})

describe('layoutRectUnder: the frame’s computed transform, off the DOM', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** A frame and a viewport in it, painted as `getBoundingClientRect` reports them. */
  function mount(
    painted: { frame: Rect; viewport: Rect },
    style: { transform: string; transformOrigin: string }
  ): { frameEl: HTMLElement; viewportEl: HTMLElement } {
    const frameEl = document.createElement('div')
    const viewportEl = document.createElement('div')
    frameEl.appendChild(viewportEl)
    document.body.appendChild(frameEl)
    const rect = (r: Rect): DOMRect =>
      ({
        left: r.x,
        top: r.y,
        width: r.width,
        height: r.height,
        right: r.x + r.width,
        bottom: r.y + r.height,
        x: r.x,
        y: r.y
      }) as DOMRect
    vi.spyOn(frameEl, 'getBoundingClientRect').mockImplementation(() => rect(painted.frame))
    vi.spyOn(viewportEl, 'getBoundingClientRect').mockImplementation(() => rect(painted.viewport))
    const computed = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) =>
      el === frameEl ? ({ ...style } as unknown as CSSStyleDeclaration) : computed(el)
    )
    return { frameEl, viewportEl }
  }

  it('under the recede the viewport’s layout box is answered, not its painted one', () => {
    const s = recedeScale(1)
    const viewport: Rect = {
      x: frame.x,
      y: frame.y + 3,
      width: frame.width,
      height: frame.height - 3
    }
    const { frameEl, viewportEl } = mount(
      { frame: paint(frame, s), viewport: paint(viewport, s) },
      {
        transform: `matrix(${s}, 0, 0, ${s}, 0, 0)`,
        transformOrigin: `${centre.x}px ${centre.y}px`
      }
    )
    close(layoutRectUnder(viewportEl, frameEl), viewport)
    // Without the frame to read, the painted box is all there is.
    close(layoutRectUnder(viewportEl, null), paint(viewport, s))
  })

  it('at rest (transform none) the painted box is the layout box, with no second read of the frame', () => {
    const { frameEl, viewportEl } = mount(
      { frame, viewport: frame },
      { transform: 'none', transformOrigin: `${centre.x}px ${centre.y}px` }
    )
    close(layoutRectUnder(viewportEl, frameEl), frame)
    expect(frameEl.getBoundingClientRect).not.toHaveBeenCalled()
  })

  it('a transform the frame never carries (a rotation) leaves the box as painted', () => {
    const painted = paint(frame, 0.97)
    const { frameEl, viewportEl } = mount(
      { frame: painted, viewport: painted },
      { transform: 'matrix(0.7071, 0.7071, -0.7071, 0.7071, 0, 0)', transformOrigin: '0px 0px' }
    )
    close(layoutRectUnder(viewportEl, frameEl), painted)
  })
})
