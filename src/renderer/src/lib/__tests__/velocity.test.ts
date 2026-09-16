import { describe, expect, it } from 'vitest'
import { VelocityTracker } from '../motion/velocity'

describe('VelocityTracker', () => {
  it('measures a steady drag in px/s', () => {
    const tracker = new VelocityTracker()
    for (let i = 0; i <= 10; i++) tracker.add(i * 16, i * 8, -i * 4) // 500 px/s right, 250 px/s up
    const { vx, vy } = tracker.velocity()
    expect(vx).toBeCloseTo(500, 0)
    expect(vy).toBeCloseTo(-250, 0)
  })

  it('needs at least two recent samples', () => {
    const tracker = new VelocityTracker()
    expect(tracker.velocity()).toEqual({ vx: 0, vy: 0 })
    tracker.add(0, 10, 10)
    expect(tracker.velocity()).toEqual({ vx: 0, vy: 0 })
  })

  it('a finger that stopped moving reads as still, whatever happened before', () => {
    const tracker = new VelocityTracker(100)
    for (let i = 0; i <= 10; i++) tracker.add(i * 16, i * 20, 0)
    // Hold for 300 ms, then lift.
    tracker.add(460, 200, 0)
    expect(tracker.velocity(460).vx).toBe(0)
  })

  it('only the recent window counts, so a reversal shows the new direction', () => {
    const tracker = new VelocityTracker(100)
    for (let i = 0; i <= 10; i++) tracker.add(i * 16, i * 30, 0) // rightwards
    for (let i = 1; i <= 8; i++) tracker.add(160 + i * 16, 300 - i * 30, 0) // back left
    expect(tracker.velocity().vx).toBeLessThan(-1000)
  })

  it('falls back to the last stretch when a busy main thread coalesced the recent moves', () => {
    const tracker = new VelocityTracker(100)
    tracker.add(0, 0, 0)
    tracker.add(20, 20, 0)
    // The thread stalled: one coalesced sample arrives 250 ms later, 100 px further on.
    tracker.add(270, 120, 0)
    const { vx } = tracker.velocity(275)
    expect(vx).toBeCloseTo(400, 0)
  })

  it('smooths out one jittery sample', () => {
    const tracker = new VelocityTracker()
    for (let i = 0; i <= 8; i++) tracker.add(i * 16, i * 5, 0)
    tracker.add(9 * 16, 9 * 5 + 40, 0) // a single bad point
    tracker.add(10 * 16, 10 * 5, 0)
    const { vx } = tracker.velocity()
    expect(vx).toBeGreaterThan(200)
    expect(vx).toBeLessThan(600)
  })

  it('collapses duplicate timestamps instead of dividing by zero', () => {
    const tracker = new VelocityTracker()
    tracker.add(0, 0, 0)
    tracker.add(0, 5, 0)
    tracker.add(16, 10, 0)
    expect(Number.isFinite(tracker.velocity().vx)).toBe(true)
  })
})
