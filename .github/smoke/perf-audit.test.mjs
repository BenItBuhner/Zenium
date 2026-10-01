import { describe, expect, it } from 'vitest'
import {
  frameStats,
  longTaskStats,
  pairLatencies,
  percentile,
  summarize,
  summarizeCpuProfile
} from './perf-audit-stats.mjs'

describe('perf-audit: a CPU profile boiled down', () => {
  // (root) → render (index.js) → [commit (react-dom.js), render again (recursion)] ; (idle)
  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '' }, children: [2, 5] },
      {
        id: 2,
        callFrame: { functionName: 'render', url: 'file:///a/index.js', lineNumber: 9 },
        children: [3, 4]
      },
      {
        id: 3,
        callFrame: { functionName: 'commit', url: 'file:///a/react-dom.js', lineNumber: 0 }
      },
      { id: 4, callFrame: { functionName: 'render', url: 'file:///a/index.js', lineNumber: 9 } },
      { id: 5, callFrame: { functionName: '(idle)', url: '' } }
    ],
    samples: [3, 3, 4, 2, 5],
    timeDeltas: [1000, 1000, 2000, 1000, 5000]
  }

  it('charges self time to the sampled function and inclusive time once per stack', () => {
    const s = summarizeCpuProfile(profile)
    expect(s.totalMs).toBe(10)
    expect(s.self).toEqual([
      { name: '(idle)', ms: 5 },
      { name: 'render index.js:10', ms: 3 },
      { name: 'commit react-dom.js:1', ms: 2 }
    ])
    const inclusive = Object.fromEntries(s.inclusive.map((r) => [r.name, r.ms]))
    expect(inclusive['(root)']).toBe(10)
    expect(inclusive['render index.js:10']).toBe(5)
    expect(inclusive['commit react-dom.js:1']).toBe(2)
  })

  it('sums the time by file', () => {
    const s = summarizeCpuProfile(profile)
    expect(s.byFile).toEqual([
      { name: '(idle)', ms: 5 },
      { name: 'index.js', ms: 3 },
      { name: 'react-dom.js', ms: 2 }
    ])
  })

  it('keeps the top N only', () => {
    expect(summarizeCpuProfile(profile, { top: 1 }).self).toHaveLength(1)
  })
})

describe('perf-audit: percentiles', () => {
  it('interpolates between the nearest ranks', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3)
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5)
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95)).toBeCloseTo(95.5)
    expect(percentile([7], 95)).toBe(7)
  })

  it('reads the extremes at 0 and 100 and ignores what is not a number', () => {
    expect(percentile([5, 1, 3], 0)).toBe(1)
    expect(percentile([5, 1, 3], 100)).toBe(5)
    expect(percentile([5, null, NaN, 1, undefined, 3], 100)).toBe(5)
    expect(percentile([], 50)).toBeNull()
  })
})

describe('perf-audit: the summary', () => {
  it('gives count, p50, p95, max, min and mean', () => {
    const s = summarize([16.7, 16.6, 33.4, 16.8, 50.1])
    expect(s.count).toBe(5)
    expect(s.p50).toBe(16.8)
    expect(s.max).toBe(50.1)
    expect(s.min).toBe(16.6)
    expect(s.mean).toBeCloseTo(26.72)
    expect(s.p95).toBeCloseTo(46.76)
  })

  it('is all nulls on an empty sample, so a table prints a dash rather than NaN', () => {
    expect(summarize([])).toEqual({
      count: 0,
      p50: null,
      p95: null,
      max: null,
      mean: null,
      min: null
    })
    expect(summarize([null, undefined]).count).toBe(0)
  })
})

describe('perf-audit: pairing triggers with the events that answer them', () => {
  it('takes the first event at or after each trigger, before the next trigger', () => {
    expect(pairLatencies([100, 200, 300], [130, 150, 260, 310])).toEqual([30, 60, 10])
  })

  it('is null for a trigger nothing answered in its span', () => {
    expect(pairLatencies([100, 200], [250])).toEqual([null, 50])
    expect(pairLatencies([100], [])).toEqual([null])
  })

  it('lets an event stamped a hair early pair within the tolerance', () => {
    expect(pairLatencies([100], [98], { tolerance: 5 })).toEqual([-2])
    expect(pairLatencies([100], [98])).toEqual([null])
  })
})

describe('perf-audit: frame and long-task statistics over a window', () => {
  const frames = [
    { at: 1000, dt: 16.7 },
    { at: 1017, dt: 16.6 },
    { at: 1050, dt: 33.4 },
    { at: 1105, dt: 55 },
    { at: 2000, dt: 16.7 }
  ]

  it('counts dropped frames against one and a half budgets, and the 32 / 50 ms marks', () => {
    const s = frameStats(frames, 1000 / 60, 1000, 1500)
    expect(s.count).toBe(4)
    expect(s.dropped).toBe(2)
    expect(s.over32).toBe(2)
    expect(s.over50).toBe(1)
    expect(s.max).toBe(55)
  })

  it('restricts itself to the window', () => {
    expect(frameStats(frames, 1000 / 60, 1900, 2100).count).toBe(1)
    expect(frameStats(frames, 1000 / 60).count).toBe(5)
  })

  it('sums the long tasks in the window', () => {
    const tasks = [
      { at: 1000, duration: 60 },
      { at: 1200, duration: 120 },
      { at: 5000, duration: 500 }
    ]
    expect(longTaskStats(tasks, 900, 2000)).toEqual({ count: 2, totalMs: 180, max: 120 })
    expect(longTaskStats([], 0, 1)).toEqual({ count: 0, totalMs: 0, max: 0 })
  })
})
