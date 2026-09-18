import { describe, expect, it } from 'vitest'
import { CREEP_CEILING, CREEP_TAU_MS, creep, progressTarget } from '../motion/progress'

describe('load progress creep', () => {
  it('starts from nothing and only ever grows', () => {
    expect(creep(0)).toBe(0)
    expect(creep(-100)).toBe(0)
    expect(creep(Number.NaN)).toBe(0)
    let last = 0
    for (let t = 100; t <= 60_000; t += 100) {
      const c = creep(t)
      expect(c).toBeGreaterThan(last)
      last = c
    }
  })

  it('never reaches the ceiling – only the page finishing fills the last stretch', () => {
    expect(creep(60_000)).toBeLessThan(CREEP_CEILING)
    expect(creep(60_000)).toBeGreaterThan(CREEP_CEILING - 1e-5)
    // One time constant in: 1 - 1/e of the ceiling.
    expect(creep(CREEP_TAU_MS)).toBeCloseTo(CREEP_CEILING * (1 - Math.exp(-1)), 6)
  })
})

describe('progressTarget', () => {
  it('is the end once the load is over, whatever was reported', () => {
    expect(progressTarget(0.2, false, 500)).toBe(1)
    expect(progressTarget(0, false, 0)).toBe(1)
  })

  it('follows the reported progress while it leads the creep', () => {
    expect(progressTarget(0.5, true, 0)).toBe(0.5)
    expect(progressTarget(0.5, true, 100)).toBe(0.5)
  })

  it('creeps ahead of a report that stands still', () => {
    const t = 10_000
    expect(progressTarget(0.1, true, t)).toBe(creep(t))
    expect(progressTarget(0.1, true, t)).toBeGreaterThan(0.1)
  })

  it('clamps what the host reports to 0…1 and ignores nonsense', () => {
    expect(progressTarget(1.7, true, 0)).toBe(1)
    expect(progressTarget(-0.4, true, 0)).toBe(0)
    expect(progressTarget(Number.NaN, true, 0)).toBe(0)
  })
})
