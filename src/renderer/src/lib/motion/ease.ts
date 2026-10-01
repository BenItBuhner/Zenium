/**
 * The one curve, read in script (motion spec §1): `--zen-ease`, `cubic-bezier(0.2, 0.8, 0.2, 1)`,
 * evaluated for a motion a driver writes per frame – the lift of a thing whose follow is a
 * per-frame `transform` (the address bar's pill, `lib/gestures/dock.ts`), where a stylesheet
 * transition on that transform would smear the follow. `zenEase(t)` is the curve's progress at
 * the time fraction `t`, the value a `transition` on `--zen-ease` would be at the same instant.
 * The control points are the token's own, parsed from `ZEN_EASE`, so the curve has one owner.
 */
import { ZEN_EASE } from './tokens'

const match = /^cubic-bezier\(([^)]*)\)$/.exec(ZEN_EASE)
const points = match ? match[1]!.split(',').map((n) => Number(n.trim())) : []
if (points.length !== 4 || points.some((n) => !Number.isFinite(n)))
  throw new Error(`ZEN_EASE is not a cubic-bezier: ${ZEN_EASE}`)
const [X1, Y1, X2, Y2] = points as [number, number, number, number]

/** One axis of the cubic Bézier from (0, 0) through (a1, a2) to (1, 1), at parameter `u`. */
const axis = (u: number, a1: number, a2: number): number =>
  ((1 - 3 * a2 + 3 * a1) * u * u + (3 * a2 - 6 * a1) * u + 3 * a1) * u
const slope = (u: number, a1: number, a2: number): number =>
  3 * (1 - 3 * a2 + 3 * a1) * u * u + 2 * (3 * a2 - 6 * a1) * u + 3 * a1

/**
 * The curve's progress (0…1) at the time fraction `t` (0…1; clamped). The parameter whose x is
 * `t` is found by Newton's method from `t` itself – the curve's x is monotonic in the parameter
 * for the control points a `transition` accepts (0 ≤ x ≤ 1) – with a bisection behind it for a
 * flat stretch.
 */
export function zenEase(t: number): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  let u = t
  for (let i = 0; i < 8; i++) {
    const x = axis(u, X1, X2) - t
    if (Math.abs(x) < 1e-7) return axis(u, Y1, Y2)
    const d = slope(u, X1, X2)
    if (d < 1e-6) break
    u -= x / d
  }
  let lo = 0
  let hi = 1
  u = t
  for (let i = 0; i < 32 && hi - lo > 1e-7; i++) {
    u = (lo + hi) / 2
    if (axis(u, X1, X2) < t) lo = u
    else hi = u
  }
  return axis(u, Y1, Y2)
}
