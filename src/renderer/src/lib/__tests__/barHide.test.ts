import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BAR_HIDE_FLING_GAP_MS,
  BAR_HIDE_FLING_VELOCITY,
  BAR_HIDE_SETTLE_VELOCITY,
  barMayHide,
  BarHideMachine,
  snapTarget,
  stepOffset,
  type BarHideGate,
  type BarHidePhase
} from '../barHide'

/*
 * The offset machine behind the phone bar that hides on scroll (Chrome / Edge parity, design
 * language v2 draft §11): the host streams the page's scroll and the machine turns it into how
 * far the bar is off its edge, one to one and clamped while a finger or a fling drives it, and
 * snapped fully in or out on a spring when the scroll ends. The gate is what keeps the bar put.
 */

const TRAVEL = 48

describe('stepOffset: deltas to offset', () => {
  it('follows the scroll one to one and clamps at both ends of the travel', () => {
    expect(stepOffset(0, 10, TRAVEL)).toBe(10)
    expect(stepOffset(10, 30, TRAVEL)).toBe(40)
    expect(stepOffset(40, 30, TRAVEL)).toBe(TRAVEL)
    expect(stepOffset(TRAVEL, 500, TRAVEL)).toBe(TRAVEL)
    expect(stepOffset(TRAVEL, -20, TRAVEL)).toBe(28)
    expect(stepOffset(28, -100, TRAVEL)).toBe(0)
    expect(stepOffset(0, -5, TRAVEL)).toBe(0)
  })

  it('ignores a delta that is not a number', () => {
    expect(stepOffset(12, Number.NaN, TRAVEL)).toBe(12)
    expect(stepOffset(12, Number.POSITIVE_INFINITY, TRAVEL)).toBe(12)
  })
})

describe('snapTarget: the release decision', () => {
  it('snaps to the nearer end when the release is slow', () => {
    expect(snapTarget(TRAVEL * 0.49, 0, TRAVEL)).toBe(0)
    expect(snapTarget(TRAVEL * 0.5, 0, TRAVEL)).toBe(TRAVEL)
    expect(snapTarget(TRAVEL * 0.9, 0, TRAVEL)).toBe(TRAVEL)
    expect(snapTarget(3, 0, TRAVEL)).toBe(0)
  })

  it('a fling snaps in its direction wherever the bar is', () => {
    expect(snapTarget(2, BAR_HIDE_FLING_VELOCITY, TRAVEL)).toBe(TRAVEL)
    expect(snapTarget(TRAVEL - 2, -BAR_HIDE_FLING_VELOCITY, TRAVEL)).toBe(0)
    // Slower than a fling: the position decides.
    expect(snapTarget(2, BAR_HIDE_FLING_VELOCITY - 1, TRAVEL)).toBe(0)
    expect(snapTarget(TRAVEL - 2, -(BAR_HIDE_FLING_VELOCITY - 1), TRAVEL)).toBe(TRAVEL)
  })
})

describe('barMayHide: the gate', () => {
  const open: BarHideGate = {
    enabled: true,
    internalPage: false,
    editing: false,
    covered: false,
    panelDocked: false,
    keyboardUp: false,
    pulling: false,
    carrying: false,
    touchExploring: false
  }

  it('is open only with the setting on and nothing in the way', () => {
    expect(barMayHide(open)).toBe(true)
  })

  it.each([
    ['the setting off', { enabled: false }],
    ['the new tab page or an internal page', { internalPage: true }],
    ['the omnibox editing', { editing: true }],
    ['a sheet or other chrome over the page', { covered: true }],
    ['find or the zoom panel docked', { panelDocked: true }],
    ['the keyboard up', { keyboardUp: true }],
    ['a pull-to-refresh in flight', { pulling: true }],
    ['the pill being carried', { carrying: true }],
    ['an accessibility service exploring by touch', { touchExploring: true }]
  ] as Array<[string, Partial<BarHideGate>]>)('closes with %s', (_name, change) => {
    expect(barMayHide({ ...open, ...change })).toBe(false)
  })
})

interface Harness {
  machine: BarHideMachine
  painted: number[]
  phases: BarHidePhase[]
  timers: Array<{ fn: () => void; at: number }>
}

describe('BarHideMachine', () => {
  let frames: Array<(now: number) => void>
  let now: number

  /** Run queued animation frames until the spring rests (or `max` frames pass). */
  const settle = (max = 600): void => {
    for (let i = 0; i < max && frames.length; i++) {
      now += 16
      const batch = frames
      frames = []
      for (const frame of batch) frame(now)
    }
  }

  const harness = (): Harness => {
    const h: Harness = {
      painted: [],
      phases: [],
      timers: [],
      machine: null as unknown as BarHideMachine
    }
    h.machine = new BarHideMachine(
      {
        paint: (offset) => h.painted.push(offset),
        onChange: (phase) => h.phases.push(phase),
        later: (fn, ms) => {
          const timer = { fn, at: now + ms }
          h.timers.push(timer)
          return () => {
            const i = h.timers.indexOf(timer)
            if (i >= 0) h.timers.splice(i, 1)
          }
        }
      },
      TRAVEL
    )
    return h
  }

  /** Let `ms` pass with no scroll: the fling gap timers that fall due run. */
  const wait = (h: Harness, ms: number): void => {
    now += ms
    for (const timer of h.timers.filter((t) => t.at <= now)) {
      h.timers.splice(h.timers.indexOf(timer), 1)
      timer.fn()
    }
  }

  /** A finger that scrolls the page by `total` px over `steps` reports, `dtMs` apart. */
  const drag = (h: Harness, total: number, steps = 6, dtMs = 16): void => {
    h.machine.dispatch('start')
    for (let i = 0; i < steps; i++) {
      now += dtMs
      h.machine.dispatch('move', { delta: total / steps, time: now })
    }
  }

  beforeEach(() => {
    frames = []
    now = 1000
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.splice(id - 1, 1)
    })
    vi.spyOn(performance, 'now').mockImplementation(() => now)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('moves one to one with the scroll under a finger, clamped to its travel, and back the same way', () => {
    const h = harness()
    h.machine.dispatch('start')
    expect(h.machine.state).toBe('dragging')
    now += 16
    h.machine.dispatch('move', { delta: 10, time: now })
    expect(h.machine.current).toBe(10)
    now += 16
    h.machine.dispatch('move', { delta: 20, time: now })
    expect(h.machine.current).toBe(30)
    // Past the travel the bar stays at its end; the page scrolls on.
    now += 16
    h.machine.dispatch('move', { delta: 200, time: now })
    expect(h.machine.current).toBe(TRAVEL)
    // Any scroll back up brings it back one to one.
    now += 16
    h.machine.dispatch('move', { delta: -12, time: now })
    expect(h.machine.current).toBe(TRAVEL - 12)
    expect(h.painted).toEqual([10, 30, TRAVEL, TRAVEL - 12])
    expect(h.machine.hidden).toBe(false)
  })

  it('a slow release past half way snaps hidden on the spring; before half way it snaps shown', () => {
    const h = harness()
    drag(h, 30, 6, 100)
    now += 16
    h.machine.dispatch('end', { time: now })
    expect(h.machine.state).toBe('settling')
    settle()
    expect(h.machine.state).toBe('rest')
    expect(h.machine.current).toBe(TRAVEL)
    expect(h.machine.hidden).toBe(true)
    // The spring only ever moves further out: no dip back towards the finger's last position.
    const fromRelease = h.painted.slice(6)
    for (let i = 1; i < fromRelease.length; i++) {
      expect(fromRelease[i]).toBeGreaterThanOrEqual(fromRelease[i - 1] - 0.001)
    }

    const back = harness()
    drag(back, 20, 6, 100)
    now += 16
    back.machine.dispatch('end', { time: now })
    settle()
    expect(back.machine.current).toBe(0)
    expect(back.machine.hidden).toBe(false)
    expect(back.phases).toEqual(['dragging', 'settling', 'rest'])
  })

  it('a fast release keeps riding the fling and settles where the last of it was heading', () => {
    const h = harness()
    // 90 px in 96 ms: well past the settle velocity, so the page will fling on.
    drag(h, 20, 6, 16)
    now += 16
    h.machine.dispatch('end', { time: now })
    expect(h.machine.state).toBe('flinging')
    expect(h.machine.current).toBe(20)
    // The fling's scroll keeps moving the bar one to one.
    now += 16
    h.machine.dispatch('move', { delta: 15, time: now })
    expect(h.machine.current).toBe(35)
    expect(h.machine.state).toBe('flinging')
    // The scroll stops: after the gap the bar settles (past half way and moving out: hidden).
    wait(h, BAR_HIDE_FLING_GAP_MS)
    expect(h.machine.state).toBe('settling')
    settle()
    expect(h.machine.current).toBe(TRAVEL)
    expect(h.machine.hidden).toBe(true)
  })

  it('a scroll with no finger down (an in-page fling) rides the bar along and settles after the gap', () => {
    const h = harness()
    now += 16
    h.machine.dispatch('move', { delta: 3, time: now })
    expect(h.machine.state).toBe('flinging')
    now += 16
    h.machine.dispatch('move', { delta: 3, time: now })
    expect(h.machine.current).toBe(6)
    wait(h, BAR_HIDE_FLING_GAP_MS)
    settle()
    // The tail of a fling is slow (under the fling velocity) and under half way: back to shown.
    expect(h.machine.current).toBe(0)
    expect(h.machine.state).toBe('rest')
  })

  it('a finger landing mid-spring takes over from where the bar is', () => {
    const h = harness()
    drag(h, 30, 6, 100)
    now += 16
    h.machine.dispatch('end', { time: now })
    settle(3)
    expect(h.machine.state).toBe('settling')
    const caught = h.machine.current
    expect(caught).toBeGreaterThan(30)
    expect(caught).toBeLessThan(TRAVEL)
    h.machine.dispatch('start')
    expect(h.machine.state).toBe('dragging')
    expect(h.machine.current).toBe(caught)
    // No spring frame moves it any more.
    settle()
    expect(h.machine.current).toBe(caught)
    now += 16
    h.machine.dispatch('move', { delta: -5, time: now })
    expect(h.machine.current).toBeCloseTo(caught - 5, 9)
  })

  it('closing the gate brings a hidden bar back on the spring and ignores the scroll until it opens', () => {
    const h = harness()
    drag(h, 60, 6, 100)
    now += 16
    h.machine.dispatch('end', { time: now })
    settle()
    expect(h.machine.hidden).toBe(true)
    h.machine.setAllowed(false)
    expect(h.machine.state).toBe('settling')
    settle()
    expect(h.machine.current).toBe(0)
    expect(h.machine.state).toBe('rest')
    // Scroll reports change nothing while the gate is closed.
    h.machine.dispatch('start')
    now += 16
    h.machine.dispatch('move', { delta: 40, time: now })
    expect(h.machine.current).toBe(0)
    expect(h.machine.state).toBe('rest')
    h.machine.setAllowed(true)
    h.machine.dispatch('start')
    now += 16
    h.machine.dispatch('move', { delta: 40, time: now })
    expect(h.machine.current).toBe(40)
  })

  it('show puts the bar back on the spring; reset puts it back at once', () => {
    const h = harness()
    drag(h, 60, 6, 100)
    now += 16
    h.machine.dispatch('end', { time: now })
    settle()
    expect(h.machine.hidden).toBe(true)
    h.machine.dispatch('show')
    expect(h.machine.state).toBe('settling')
    settle()
    expect(h.machine.current).toBe(0)

    drag(h, 60, 6, 100)
    h.machine.reset()
    expect(h.machine.current).toBe(0)
    expect(h.machine.state).toBe('rest')
    expect(h.painted[h.painted.length - 1]).toBe(0)
  })

  it('under reduced motion the finger still moves the bar one to one and the snap jumps, no frames between', () => {
    // The lib tests run without a DOM: the spring's `reducedMotion()` asks `window.matchMedia`.
    vi.stubGlobal('window', {
      matchMedia: (query: string) => ({ matches: query.includes('reduce') })
    })
    const h = harness()
    drag(h, 30, 6, 100)
    expect(h.machine.current).toBe(30)
    now += 16
    h.machine.dispatch('end', { time: now })
    // The spring rests on the release itself: hidden, one paint, nothing queued for a frame.
    expect(h.machine.state).toBe('rest')
    expect(h.machine.current).toBe(TRAVEL)
    expect(h.machine.hidden).toBe(true)
    expect(h.painted.slice(6)).toEqual([TRAVEL])
    expect(frames).toHaveLength(0)
    h.machine.dispatch('show')
    expect(h.machine.state).toBe('rest')
    expect(h.machine.current).toBe(0)
    expect(frames).toHaveLength(0)
  })

  it('the settle velocity tells a lift after a pause from a release into a fling', () => {
    expect(BAR_HIDE_SETTLE_VELOCITY).toBeLessThan(BAR_HIDE_FLING_VELOCITY)
    const h = harness()
    drag(h, 20, 6, 16)
    // The finger holds still, then lifts: no fling, the bar settles at once.
    now += 200
    h.machine.dispatch('end', { time: now })
    expect(h.machine.state).toBe('settling')
  })

  it('a change of travel keeps the bar at the same fraction of the way out', () => {
    const h = harness()
    drag(h, 24, 6, 100)
    expect(h.machine.current).toBe(24)
    h.machine.travel = 96
    expect(h.machine.travel).toBe(96)
    expect(h.machine.current).toBe(48)
    h.machine.travel = 0
    expect(h.machine.travel).toBe(96)
  })
})
