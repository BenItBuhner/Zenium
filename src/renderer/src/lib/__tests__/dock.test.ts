import { describe, expect, it } from 'vitest'
import {
  bandAlong,
  contentShift,
  liftAt,
  liftAtRest,
  liftTowards,
  otherEdge,
  pillCentreAt,
  relocationTarget,
  towardsOther,
  type LiftMotion
} from '../gestures/dock'
import { zenEase } from '../motion/ease'
import { MOTION_STATE_MS } from '../motion/tokens'

const travel = 700

describe('the lift (motion spec §1: a 120 ms rise on --zen-ease, the same back; never a spring)', () => {
  const flat: LiftMotion = { from: 0, to: 0, startedAt: 0, x: 0 }

  it('rises from flat to lifted over MOTION_STATE_MS on the curve, and rests exactly at 1', () => {
    const lift = liftTowards(flat, 1, 1000)
    expect(lift).toEqual({ from: 0, to: 1, startedAt: 1000, x: 0 })
    expect(liftAt(lift, 1000, false).x).toBe(0)
    expect(liftAt(lift, 1000 + MOTION_STATE_MS / 4, false).x).toBeCloseTo(zenEase(0.25), 9)
    expect(liftAt(lift, 1000 + MOTION_STATE_MS / 2, false).x).toBeCloseTo(zenEase(0.5), 9)
    expect(liftAt(lift, 1000 + MOTION_STATE_MS, false).x).toBe(1)
    expect(liftAt(lift, 1000 + MOTION_STATE_MS * 3, false).x).toBe(1)
    expect(liftAtRest(liftAt(lift, 1000 + MOTION_STATE_MS - 1, false))).toBe(false)
    expect(liftAtRest(liftAt(lift, 1000 + MOTION_STATE_MS, false))).toBe(true)
    // A frame before the start (the frame clock's stamp behind the pick-up's) is the start.
    expect(liftAt(lift, 990, false).x).toBe(0)
  })

  it('never overshoots: every frame of the rise is within 0…1 and later than the last', () => {
    const lift = liftTowards(flat, 1, 0)
    let last = 0
    for (let now = 0; now <= MOTION_STATE_MS; now += 4) {
      const { x } = liftAt(lift, now, false)
      expect(x).toBeGreaterThanOrEqual(last)
      expect(x).toBeLessThanOrEqual(1)
      last = x
    }
    expect(last).toBe(1)
  })

  it('sets down from wherever the rise is, the same 120 ms back, and rests exactly at 0', () => {
    const rising = liftAt(liftTowards(flat, 1, 0), 40, false)
    const setDown = liftTowards(rising, 0, 40)
    expect(setDown).toEqual({ from: rising.x, to: 0, startedAt: 40, x: rising.x })
    expect(liftAt(setDown, 40, false).x).toBe(rising.x)
    expect(liftAt(setDown, 40 + MOTION_STATE_MS / 2, false).x).toBeCloseTo(
      rising.x * (1 - zenEase(0.5)),
      9
    )
    expect(liftAt(setDown, 40 + MOTION_STATE_MS, false).x).toBe(0)
    expect(liftAtRest(liftAt(setDown, 40 + MOTION_STATE_MS, false))).toBe(true)
  })

  it('cuts under reduced motion: lifted at once, flat at once', () => {
    const lift = liftTowards(flat, 1, 0)
    expect(liftAt(lift, 0, true)).toEqual({ ...lift, x: 1 })
    expect(liftAtRest(liftAt(lift, 0, true))).toBe(true)
    const down = liftTowards(liftAt(lift, 0, true), 0, 0)
    expect(liftAt(down, 0, true).x).toBe(0)
  })
})

describe('relocationTarget', () => {
  it('a slow release docks on the nearer edge', () => {
    expect(relocationTarget(0.2, 0, travel)).toBe(0)
    expect(relocationTarget(0.49, 0, travel)).toBe(0)
    expect(relocationTarget(0.51, 0, travel)).toBe(1)
    expect(relocationTarget(0.9, 0, travel)).toBe(1)
  })

  it('a fling commits in its own direction regardless of distance', () => {
    expect(relocationTarget(0.1, 900, travel)).toBe(1)
    expect(relocationTarget(0.9, -900, travel)).toBe(0)
  })

  it('a slow velocity is projected into the decision', () => {
    // 0.47 + 300 px/s * 0.12 s / 700 px = 0.52 → carries on to the other edge
    expect(relocationTarget(0.47, 300, travel)).toBe(1)
    // Drifting back from past the middle returns the pill home.
    expect(relocationTarget(0.53, -300, travel)).toBe(0)
  })

  it('never leaves the track', () => {
    expect(relocationTarget(-0.1, -2000, travel)).toBe(0)
    expect(relocationTarget(1.1, 2000, travel)).toBe(1)
  })
})

describe('bandAlong', () => {
  it('follows the finger between the slots', () => {
    expect(bandAlong(0, travel)).toBe(0)
    expect(bandAlong(350, travel)).toBe(350)
    expect(bandAlong(travel, travel)).toBe(travel)
  })

  it('rubber-bands past either slot, never further than the overshoot', () => {
    const below = bandAlong(-200, travel)
    expect(below).toBeLessThan(0)
    expect(below).toBeGreaterThan(-56)
    const beyond = bandAlong(travel + 400, travel)
    expect(beyond).toBeGreaterThan(travel)
    expect(beyond).toBeLessThan(travel + 56)
  })
})

describe('geometry', () => {
  it('slides the content by the bar band minus the gutter it gets instead', () => {
    expect(contentShift('bottom', 0, 56, 8)).toBe(0)
    expect(contentShift('bottom', 0.5, 56, 8)).toBe(24)
    expect(contentShift('bottom', 1, 56, 8)).toBe(48)
    expect(contentShift('top', 1, 56, 8)).toBe(-48)
    // Rubber-banded progress does not move the frame past its docked positions.
    expect(contentShift('bottom', 1.2, 56, 8)).toBe(48)
    expect(contentShift('bottom', -0.2, 56, 8)).toBe(0)
  })

  it('places the pill centre half a bar band inside either edge', () => {
    const insets = { top: 24, bottom: 48 }
    expect(pillCentreAt('top', insets, 891, 56)).toBe(52)
    expect(pillCentreAt('bottom', insets, 891, 56)).toBe(891 - 48 - 28)
  })

  it('knows its directions', () => {
    expect(otherEdge('bottom')).toBe('top')
    expect(otherEdge('top')).toBe('bottom')
    expect(towardsOther('bottom')).toBe(-1)
    expect(towardsOther('top')).toBe(1)
  })
})
