import type { Rect } from '@shared/types'

/**
 * The layout box of an element under a transformed ancestor.
 *
 * `getBoundingClientRect()` is the box as painted. Under a phone sheet the content frame stands
 * receded – `scale(1 − 0.03 · p)` about its centre (main.css on `--zen-recede`, v2 §11.1) – and a
 * viewport measured through it reads 3 percent short and 1.5 percent in from either edge: 20 to
 * 24 CSS px of height on a phone. The page view the host lays out from that measure is not in
 * the frame's picture: the recede moves the chrome's cover of the page, and the page itself takes
 * the frame's layout box – which nothing scales – the moment the sheet has gone. A measure taken
 * while a sheet is up (a setting written from its picker, the keyboard rising under its field)
 * must therefore be the layout box: the painted box run back through the frame's computed
 * transform (PERF-4's audit: `page 783 vs 805` on every bar-hide run).
 *
 * Only what the chassis writes is undone – a scale, with any translation, about the frame's
 * transform-origin. A rotation or a skew is not the frame's vocabulary; a transform that carries
 * one leaves the box as painted, as does a degenerate scale.
 */

/** An axis-aligned transform: a scale about the transform-origin, then a translation. */
export interface AxisTransform {
  scaleX: number
  scaleY: number
  translateX: number
  translateY: number
}

export const IDENTITY: AxisTransform = { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }

/** Below this a matrix entry is 0: the computed value of `scale()` carries no rotation, but floats. */
const EPSILON = 1e-6

/**
 * Blink lays out on `LayoutUnit`s of 1/64 px, and a layout box measured at rest sits on that
 * grid; the run-back's arithmetic does not (a transformed rect comes through the compositor's
 * floats, and the division adds its own dust: 1e-5 to 1e-4 px off the true layout box). The
 * reporter compares rects exactly (`useLayoutReporter`'s `sameRect`) and the host truncates the
 * device-pixel height (`TabHost.place`'s `toInt()`), so an answer a hair under the rest's would
 * cost one more `layout.report` at the rest and a page view one device pixel short until it:
 * the run-back answers on the grid instead.
 */
const LAYOUT_UNITS_PER_PX = 64

/** `v` at the nearest layout unit. */
export function onLayoutGrid(v: number): number {
  return Math.round(v * LAYOUT_UNITS_PER_PX) / LAYOUT_UNITS_PER_PX
}

function numbers(list: string): number[] {
  return list.split(',').map((s) => Number.parseFloat(s))
}

/**
 * The computed `transform` value as an axis-aligned transform: `none` (or nothing) is the
 * identity; `matrix(a, b, c, d, e, f)` and `matrix3d(…)` with no rotation or skew give their
 * scale and translation. Null for a transform that rotates or skews, or that cannot be read.
 */
export function parseAxisTransform(value: string | null | undefined): AxisTransform | null {
  const v = (value ?? '').trim()
  if (v === '' || v === 'none') return IDENTITY
  const m2 = /^matrix\((.*)\)$/.exec(v)
  if (m2) {
    const [a, b, c, d, e, f] = numbers(m2[1])
    if ([a, b, c, d, e, f].some((n) => n === undefined || !Number.isFinite(n))) return null
    if (Math.abs(b) > EPSILON || Math.abs(c) > EPSILON) return null
    return { scaleX: a, scaleY: d, translateX: e, translateY: f }
  }
  const m3 = /^matrix3d\((.*)\)$/.exec(v)
  if (m3) {
    const n = numbers(m3[1])
    if (n.length !== 16 || n.some((x) => !Number.isFinite(x))) return null
    // Column-major as CSS lists it: the first four values are the first column (m11 m21 m31
    // m41), the last four the fourth (the translation). So n[0] and n[5] are the scales
    // (matrix()'s a and d), n[1] and n[4] the 2D skew terms (its b and c), n[12] and n[13] the
    // translation (its e and f). Only the 2D skew terms are checked: a rotation about x or y
    // (n[2], n[6], n[8], n[9]) or a perspective (n[3], n[7], n[11]) is not the frame's vocabulary.
    if (Math.abs(n[1]) > EPSILON || Math.abs(n[4]) > EPSILON) return null
    return { scaleX: n[0], scaleY: n[5], translateX: n[12], translateY: n[13] }
  }
  return null
}

/** The computed `transform-origin` (`<x>px <y>px [<z>px]`) as a point in the element's own box. */
export function parseOrigin(value: string | null | undefined): { x: number; y: number } {
  const parts = (value ?? '').trim().split(/\s+/)
  const x = Number.parseFloat(parts[0] ?? '')
  const y = Number.parseFloat(parts[1] ?? '')
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 }
}

export function isIdentity(t: AxisTransform): boolean {
  return (
    Math.abs(t.scaleX - 1) < EPSILON &&
    Math.abs(t.scaleY - 1) < EPSILON &&
    Math.abs(t.translateX) < EPSILON &&
    Math.abs(t.translateY) < EPSILON
  )
}

/**
 * The layout box of an element painted at `painted` inside a frame painted at `frame`, the frame
 * standing under `transform` about `origin` (a point in the frame's own layout box, as
 * `transform-origin` computes). The frame's layout top-left is its painted one less what the
 * scale about the origin and the translation moved it by; inside the frame every offset and
 * length is the painted one divided by the scale. The answer is put on the layout grid
 * (`onLayoutGrid`), as a box measured at rest would be. A scale that is not positive and finite
 * cannot be run back: the painted box is answered as it is.
 */
export function layoutRectThrough(
  painted: Rect,
  frame: Rect,
  transform: AxisTransform,
  origin: { x: number; y: number }
): Rect {
  const { scaleX: sx, scaleY: sy, translateX: tx, translateY: ty } = transform
  if (!(sx > 0 && sy > 0) || !Number.isFinite(sx) || !Number.isFinite(sy)) return painted
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return painted
  const left = frame.x - (1 - sx) * origin.x - tx
  const top = frame.y - (1 - sy) * origin.y - ty
  return {
    x: onLayoutGrid(left + (painted.x - frame.x) / sx),
    y: onLayoutGrid(top + (painted.y - frame.y) / sy),
    width: onLayoutGrid(painted.width / sx),
    height: onLayoutGrid(painted.height / sy)
  }
}

function clientRect(el: Element): Rect {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

/**
 * `el`'s layout box in window coordinates: its painted box, run back through the computed
 * transform of `frame` – the transformed ancestor it sits under (the content frame) – when that
 * frame carries one. With no frame, or the frame at rest, the painted box is the layout box.
 */
export function layoutRectUnder(el: Element, frame: Element | null | undefined): Rect {
  const painted = clientRect(el)
  if (!frame || typeof getComputedStyle !== 'function') return painted
  const style = getComputedStyle(frame)
  const transform = parseAxisTransform(style.transform)
  if (transform === null || isIdentity(transform)) return painted
  return layoutRectThrough(
    painted,
    clientRect(frame),
    transform,
    parseOrigin(style.transformOrigin)
  )
}
