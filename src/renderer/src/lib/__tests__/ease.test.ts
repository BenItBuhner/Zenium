import { describe, expect, it } from 'vitest'
import { zenEase } from '../motion/ease'
import { ZEN_EASE } from '../motion/tokens'

/*
 * The one curve in script (motion spec §1): `zenEase` is `--zen-ease` – cubic-bezier(.2, .8, .2,
 * 1) – read from the token, for the drivers that write a motion per frame. Its values are the
 * curve's own (solved apart, by bisection on the x axis), and it is a curve of the right shape:
 * out of the gate fast, into its rest soft, never past its ends.
 */

/** The Bézier's one axis at parameter `u`, from (0, 0) through (a1, a2) to (1, 1). */
const axis = (u: number, a1: number, a2: number): number =>
  ((1 - 3 * a2 + 3 * a1) * u * u + (3 * a2 - 6 * a1) * u + 3 * a1) * u

/** The curve's y at x = t, by bisection: the slow reference the fast solver is held to. */
function reference(t: number): number {
  const [x1, y1, x2, y2] = ZEN_EASE.match(/[\d.]+/g)!.map(Number) as [
    number,
    number,
    number,
    number
  ]
  let lo = 0
  let hi = 1
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (axis(mid, x1, x2) < t) lo = mid
    else hi = mid
  }
  return axis((lo + hi) / 2, y1, y2)
}

describe('zenEase (§1: --zen-ease in script)', () => {
  it('is the token’s curve, point for point', () => {
    expect(ZEN_EASE).toBe('cubic-bezier(0.2, 0.8, 0.2, 1)')
    for (let i = 0; i <= 100; i++) {
      const t = i / 100
      expect(zenEase(t), `t = ${t}`).toBeCloseTo(reference(t), 6)
    }
    // The shape in numbers: past a third of the way by a tenth of the time, nearly there at half.
    expect(zenEase(0.1)).toBeCloseTo(0.3967, 4)
    expect(zenEase(0.25)).toBeCloseTo(0.7673, 4)
    expect(zenEase(0.5)).toBeCloseTo(0.9461, 4)
    expect(zenEase(0.75)).toBeCloseTo(0.9911, 4)
  })

  it('starts at 0, ends at 1, clamps beyond, and only ever rises', () => {
    expect(zenEase(0)).toBe(0)
    expect(zenEase(1)).toBe(1)
    expect(zenEase(-0.5)).toBe(0)
    expect(zenEase(1.5)).toBe(1)
    let last = 0
    for (let i = 1; i <= 1000; i++) {
      const y = zenEase(i / 1000)
      expect(y).toBeGreaterThanOrEqual(last)
      expect(y).toBeLessThanOrEqual(1)
      last = y
    }
  })
})
