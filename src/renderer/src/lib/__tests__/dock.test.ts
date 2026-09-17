import { describe, expect, it } from 'vitest'
import {
  bandAlong,
  contentShift,
  otherEdge,
  pillCentreAt,
  relocationTarget,
  towardsOther
} from '../gestures/dock'

const travel = 700

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
