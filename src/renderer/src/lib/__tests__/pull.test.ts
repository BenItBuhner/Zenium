import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PULL_EXTENT,
  PULL_FLING_VELOCITY,
  PULL_REST,
  PULL_THRESHOLD,
  PullMachine,
  abortPull,
  dispatchPullEvent,
  heldPageOffset,
  holdPage,
  pageHeldByPull,
  pullOffset,
  pullProgress,
  pullTravelFor,
  releaseRefreshes,
  setPageHold,
  setPullHost,
  type PullState
} from '../pull'

describe('pull mapping', () => {
  it('follows the finger one to one at first and never reaches the extent', () => {
    expect(pullOffset(0)).toBe(0)
    expect(pullOffset(-40)).toBe(0)
    // The slope at the origin is 1: a small pull moves the page about as far.
    expect(pullOffset(1)).toBeGreaterThan(0.98)
    expect(pullOffset(1)).toBeLessThanOrEqual(1)
    expect(pullOffset(10_000)).toBeLessThan(PULL_EXTENT)
    expect(pullOffset(10_000)).toBeGreaterThan(PULL_EXTENT * 0.95)
  })

  it('resists more the further the finger goes', () => {
    const first = pullOffset(60)
    const second = pullOffset(120) - pullOffset(60)
    const third = pullOffset(180) - pullOffset(120)
    expect(first).toBeGreaterThan(second)
    expect(second).toBeGreaterThan(third)
    for (let t = 0; t < 600; t += 20) expect(pullOffset(t + 20)).toBeGreaterThan(pullOffset(t))
  })

  it('reaches the threshold after 120 px of finger, like Chrome', () => {
    expect(pullOffset(120)).toBeCloseTo(PULL_THRESHOLD, 6)
    expect(pullProgress(pullOffset(120))).toBeCloseTo(1, 6)
  })

  it('pullTravelFor inverts pullOffset', () => {
    for (const travel of [0, 5, 37, 120, 260, 900]) {
      expect(pullTravelFor(pullOffset(travel))).toBeCloseTo(travel, 6)
    }
    expect(pullTravelFor(-10)).toBe(0)
    // At (or past) the extent the inverse is finite, so a caught spring never explodes.
    expect(Number.isFinite(pullTravelFor(PULL_EXTENT))).toBe(true)
    expect(Number.isFinite(pullTravelFor(PULL_EXTENT * 2))).toBe(true)
  })

  it('progress is 0 at rest, 1 at the threshold, 0.4 at 40 percent', () => {
    expect(pullProgress(0)).toBe(0)
    expect(pullProgress(-3)).toBe(0)
    expect(pullProgress(PULL_THRESHOLD)).toBe(1)
    expect(pullProgress(PULL_THRESHOLD * 0.4)).toBeCloseTo(0.4, 9)
  })
})

describe('release decision', () => {
  it('refreshes at the threshold regardless of velocity', () => {
    expect(releaseRefreshes(PULL_THRESHOLD, 0)).toBe(true)
    expect(releaseRefreshes(PULL_THRESHOLD + 30, -2000)).toBe(true)
    expect(releaseRefreshes(PULL_THRESHOLD - 0.01, 0)).toBe(false)
  })

  it('a fling refreshes from half the threshold on, but not from a barely-out disc', () => {
    expect(releaseRefreshes(PULL_THRESHOLD * 0.5, PULL_FLING_VELOCITY)).toBe(true)
    expect(releaseRefreshes(PULL_THRESHOLD * 0.5, PULL_FLING_VELOCITY - 1)).toBe(false)
    expect(releaseRefreshes(PULL_THRESHOLD * 0.49, PULL_FLING_VELOCITY * 3)).toBe(false)
    // Flinging back up never refreshes.
    expect(releaseRefreshes(PULL_THRESHOLD * 0.9, -PULL_FLING_VELOCITY * 3)).toBe(false)
  })
})

interface Harness {
  machine: PullMachine
  painted: number[]
  phases: string[]
  refreshed: string[]
  states: PullState[]
  loading: boolean | null
}

describe('PullMachine', () => {
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
      refreshed: [],
      states: [],
      loading: false,
      machine: null as unknown as PullMachine
    }
    h.machine = new PullMachine({
      refresh: (tabId) => h.refreshed.push(tabId),
      paint: (_tabId, offset) => h.painted.push(offset),
      onChange: (state) => {
        h.phases.push(state.phase)
        h.states.push(state)
      },
      isLoading: () => h.loading
    })
    return h
  }

  /** A finger that pulls down `travel` px over `steps` samples, `dtMs` apart. */
  const pull = (h: Harness, travel: number, steps = 8, dtMs = 16): void => {
    h.machine.dispatch('t1', 'start')
    for (let i = 1; i <= steps; i++) {
      now += dtMs
      h.machine.dispatch('t1', 'move', { travel: (travel * i) / steps, time: now })
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
    vi.useRealTimers()
  })

  it('paints the resisted offset while the finger is down and arms at the threshold', () => {
    const h = harness()
    h.machine.dispatch('t1', 'start')
    expect(h.machine.state).toEqual({ tabId: 't1', phase: 'pulling', armed: false })
    expect(h.painted).toEqual([0])
    now += 16
    h.machine.dispatch('t1', 'move', { travel: 60, time: now })
    expect(h.machine.current).toBeCloseTo(pullOffset(60), 9)
    expect(h.machine.state.armed).toBe(false)
    now += 16
    h.machine.dispatch('t1', 'move', { travel: 130, time: now })
    expect(h.machine.state.armed).toBe(true)
    // Arming is a state change (the chrome ticks on it) – reported exactly once on the way out.
    expect(h.states.filter((s) => s.armed)).toHaveLength(1)
    // Easing back below the threshold disarms again.
    now += 16
    h.machine.dispatch('t1', 'move', { travel: 100, time: now })
    expect(h.machine.state.armed).toBe(false)
  })

  it('a release below the threshold retracts on the spring without refreshing', () => {
    const h = harness()
    pull(h, 80)
    expect(h.machine.state.armed).toBe(false)
    now += 16
    h.machine.dispatch('t1', 'release', { travel: 80, time: now })
    expect(h.machine.state.phase).toBe('settling')
    settle()
    expect(h.refreshed).toEqual([])
    expect(h.machine.state).toEqual({ tabId: null, phase: 'idle', armed: false })
    expect(h.machine.current).toBe(0)
    expect(h.painted[h.painted.length - 1]).toBe(0)
    // The retract is a monotonic return: the page never dips below the frame's edge.
    for (const x of h.painted) expect(x).toBeGreaterThanOrEqual(0)
  })

  it('a release past the threshold reloads, waits at the rest offset and finishes when the load ends', () => {
    const h = harness()
    pull(h, 160)
    expect(h.machine.state.armed).toBe(true)
    now += 16
    h.machine.dispatch('t1', 'release', { travel: 160, time: now })
    expect(h.refreshed).toEqual(['t1'])
    expect(h.machine.state.phase).toBe('refreshing')
    // The page settles to where the spinner sits while the load runs.
    settle()
    expect(h.machine.current).toBe(PULL_REST)
    expect(h.machine.state.phase).toBe('refreshing')
    // The tab starts loading, then stops: the spinner stays up the minimum, then springs away.
    h.loading = true
    h.machine.poll()
    expect(h.machine.state.phase).toBe('refreshing')
    now += 1000
    h.loading = false
    h.machine.poll()
    expect(h.machine.state.phase).toBe('finishing')
    settle()
    expect(h.machine.state).toEqual({ tabId: null, phase: 'idle', armed: false })
    expect(h.machine.current).toBe(0)
    expect(h.refreshed).toEqual(['t1']) // exactly one reload
  })

  it('a reload that ends in a blink keeps the spinner up for the minimum time', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = harness()
    pull(h, 160)
    now += 16
    h.machine.dispatch('t1', 'release', { travel: 160, time: now })
    h.loading = true
    h.machine.poll()
    now += 40
    h.loading = false
    h.machine.poll()
    // Too soon: still refreshing, with a timer set for the remainder.
    expect(h.machine.state.phase).toBe('refreshing')
    now += 500
    vi.advanceTimersByTime(500)
    expect(h.machine.state.phase).toBe('finishing')
  })

  it('a reload that never starts loading gives up after the grace period', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = harness()
    pull(h, 160)
    now += 16
    h.machine.dispatch('t1', 'release', { travel: 160, time: now })
    expect(h.machine.state.phase).toBe('refreshing')
    now += 1600
    vi.advanceTimersByTime(1600)
    expect(h.machine.state.phase).toBe('finishing')
  })

  it('a fast fling refreshes before the threshold, a slow one does not', () => {
    const fast = harness()
    // 16 px every 8 ms: a 2000 px/s tug covering 96 px of finger.
    fast.machine.dispatch('t1', 'start')
    for (let i = 1; i <= 6; i++) {
      now += 8
      fast.machine.dispatch('t1', 'move', { travel: i * 16, time: now })
    }
    // The page is past half the threshold (not the threshold itself) and the finger is fast.
    expect(fast.machine.current).toBeGreaterThan(PULL_THRESHOLD * 0.5)
    expect(fast.machine.current).toBeLessThan(PULL_THRESHOLD)
    fast.machine.dispatch('t1', 'release', { travel: 96, time: now })
    expect(fast.refreshed).toEqual(['t1'])

    const slow = harness()
    slow.machine.dispatch('t1', 'start')
    for (let i = 1; i <= 6; i++) {
      now += 80
      slow.machine.dispatch('t1', 'move', { travel: i * 16, time: now })
    }
    slow.machine.dispatch('t1', 'release', { travel: 96, time: now })
    expect(slow.refreshed).toEqual([])
    expect(slow.machine.state.phase).toBe('settling')
  })

  it('a finger that paused before lifting is not a fling', () => {
    const h = harness()
    h.machine.dispatch('t1', 'start')
    for (let i = 1; i <= 6; i++) {
      now += 8
      h.machine.dispatch('t1', 'move', { travel: i * 16, time: now })
    }
    now += 400 // held still
    h.machine.dispatch('t1', 'release', { travel: 96, time: now })
    expect(h.refreshed).toEqual([])
  })

  it('cancel (the finger reversed or the page scrolled) retracts without refreshing', () => {
    const h = harness()
    pull(h, 140)
    expect(h.machine.state.armed).toBe(true)
    now += 16
    h.machine.dispatch('t1', 'cancel', { travel: 140, time: now })
    expect(h.machine.state.phase).toBe('settling')
    expect(h.refreshed).toEqual([])
    const from = h.machine.current
    settle()
    expect(h.machine.state.phase).toBe('idle')
    // Even though the finger was moving down when the pull was cancelled, the page only goes home.
    for (const x of h.painted.slice(h.painted.indexOf(from)))
      expect(x).toBeLessThanOrEqual(from + 1e-6)
    expect(h.machine.current).toBe(0)
  })

  it('a finger landing on a retracting page catches it where it is and can pull it back out', () => {
    const h = harness()
    pull(h, 120)
    now += 16
    h.machine.dispatch('t1', 'release', { travel: 120, time: now })
    settle(3)
    const midway = h.machine.current
    expect(midway).toBeGreaterThan(0)
    expect(midway).toBeLessThan(PULL_THRESHOLD)
    h.machine.dispatch('t1', 'start')
    expect(frames).toEqual([]) // the spring stopped
    expect(h.machine.state.phase).toBe('pulling')
    expect(h.machine.current).toBe(midway)
    // No finger movement yet: the page stays exactly where it was caught.
    now += 16
    h.machine.dispatch('t1', 'move', { travel: 0, time: now })
    expect(h.machine.current).toBeCloseTo(midway, 6)
    // Pulling further continues from there…
    now += 16
    h.machine.dispatch('t1', 'move', { travel: 40, time: now })
    expect(h.machine.current).toBeGreaterThan(midway)
    // …and reversing brings it back up under the finger, all the way to the edge.
    now += 16
    h.machine.dispatch('t1', 'move', { travel: -pullTravelFor(midway) - 10, time: now })
    expect(h.machine.current).toBe(0)
  })

  it('a finger on a page another source held out carries on from where it sits', () => {
    const h = harness()
    // The band held the page 56 px down and lets go to this finger: nothing is painted at the
    // start (the page is already there), and travel counts from the held offset.
    h.machine.dispatch('t1', 'start', null, 56)
    expect(h.painted).toEqual([])
    expect(h.machine.state.phase).toBe('pulling')
    expect(h.machine.current).toBe(56)
    now += 16
    h.machine.dispatch('t1', 'move', { travel: 0, time: now })
    expect(h.machine.current).toBeCloseTo(56, 6)
    now += 16
    h.machine.dispatch('t1', 'move', { travel: 30, time: now })
    expect(h.machine.current).toBeGreaterThan(56)
    expect(h.machine.current).toBeLessThan(56 + 30)
    // Reversing eases the page home under the finger, all the way to the edge.
    now += 16
    h.machine.dispatch('t1', 'move', { travel: -pullTravelFor(56) - 5, time: now })
    expect(h.machine.current).toBe(0)
    // Letting go there leaves the page home and the machine idle.
    now += 16
    h.machine.dispatch('t1', 'release', { travel: -pullTravelFor(56) - 5, time: now })
    settle()
    expect(h.machine.state.phase).toBe('idle')
    expect(h.painted[h.painted.length - 1]).toBe(0)
  })

  it('a held page released at once springs home from the held offset', () => {
    const h = harness()
    h.machine.dispatch('t1', 'start', null, 56)
    now += 16
    h.machine.dispatch('t1', 'release', { travel: 0, time: now })
    expect(h.machine.state.phase).toBe('settling')
    settle(2)
    expect(h.painted[0]).toBeLessThan(56)
    expect(h.painted[0]).toBeGreaterThan(40)
    settle()
    expect(h.machine.state.phase).toBe('idle')
    expect(h.painted[h.painted.length - 1]).toBe(0)
  })

  it('a from offset is ignored while a spring of its own is in flight', () => {
    const h = harness()
    pull(h, 120)
    now += 16
    h.machine.dispatch('t1', 'release', { travel: 120, time: now })
    settle(3)
    const midway = h.machine.current
    h.machine.dispatch('t1', 'start', null, 56)
    expect(h.machine.current).toBe(midway)
  })

  it('a pull during the reload takes the spinner over; letting go below the threshold puts it away', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = harness()
    pull(h, 160)
    now += 16
    h.machine.dispatch('t1', 'release', { travel: 160, time: now })
    settle()
    expect(h.machine.current).toBe(PULL_REST)
    h.machine.dispatch('t1', 'start')
    expect(h.machine.state).toEqual({ tabId: 't1', phase: 'pulling', armed: false })
    now += 16
    h.machine.dispatch('t1', 'release', { travel: 0, time: now })
    settle()
    expect(h.machine.state.phase).toBe('idle')
    expect(h.refreshed).toEqual(['t1'])
    // The abandoned poll loop does not come back to life.
    now += 3000
    vi.advanceTimersByTime(3000)
    expect(h.machine.state.phase).toBe('idle')
  })

  it('events for another tab are ignored while a pull is in flight', () => {
    const h = harness()
    pull(h, 60)
    const before = h.machine.current
    now += 16
    h.machine.dispatch('t2', 'move', { travel: 200, time: now })
    h.machine.dispatch('t2', 'release', { travel: 200, time: now })
    expect(h.machine.current).toBe(before)
    expect(h.machine.state).toEqual({ tabId: 't1', phase: 'pulling', armed: false })
    // Moves and releases without a start do nothing either.
    const fresh = harness()
    fresh.machine.dispatch('t1', 'move', { travel: 200, time: now })
    fresh.machine.dispatch('t1', 'release', { travel: 200, time: now })
    expect(fresh.refreshed).toEqual([])
    expect(fresh.machine.state.phase).toBe('idle')
  })

  it('abort puts the page back at once', () => {
    const h = harness()
    pull(h, 160)
    now += 16
    h.machine.dispatch('t1', 'release', { travel: 160, time: now })
    expect(h.machine.state.phase).toBe('refreshing')
    h.machine.abort()
    expect(h.machine.state).toEqual({ tabId: null, phase: 'idle', armed: false })
    expect(h.machine.current).toBe(0)
    expect(h.painted[h.painted.length - 1]).toBe(0)
    expect(frames).toEqual([])
  })

  it('a tab that disappears mid-reload ends the spinner', () => {
    const h = harness()
    pull(h, 160)
    now += 16
    h.machine.dispatch('t1', 'release', { travel: 160, time: now })
    h.loading = null
    h.machine.poll()
    expect(h.machine.state.phase).toBe('finishing')
    settle()
    expect(h.machine.state.phase).toBe('idle')
  })

  describe('with reduced motion', () => {
    beforeEach(() => {
      vi.stubGlobal('window', {
        matchMedia: (query: string) => ({ matches: query.includes('reduce') })
      })
    })

    it('retracts without any animation frames', () => {
      const h = harness()
      pull(h, 80)
      now += 16
      h.machine.dispatch('t1', 'release', { travel: 80, time: now })
      expect(frames).toEqual([])
      expect(h.machine.state).toEqual({ tabId: null, phase: 'idle', armed: false })
      expect(h.machine.current).toBe(0)
      expect(h.refreshed).toEqual([])
    })

    it('jumps to the rest offset for the reload and straight home afterwards', () => {
      const h = harness()
      pull(h, 160)
      now += 16
      h.machine.dispatch('t1', 'release', { travel: 160, time: now })
      expect(frames).toEqual([])
      expect(h.refreshed).toEqual(['t1'])
      expect(h.machine.state.phase).toBe('refreshing')
      expect(h.machine.current).toBe(PULL_REST)
      h.loading = true
      h.machine.poll()
      now += 1000
      h.loading = false
      h.machine.poll()
      expect(frames).toEqual([])
      expect(h.machine.state).toEqual({ tabId: null, phase: 'idle', armed: false })
      expect(h.machine.current).toBe(0)
    })

    it('still follows the finger directly while pulling', () => {
      const h = harness()
      pull(h, 130)
      expect(h.machine.current).toBeCloseTo(pullOffset(130), 9)
      expect(h.machine.state.armed).toBe(true)
    })
  })
})

describe('the hold (the band as the second source of the offset)', () => {
  let frames: Array<(now: number) => void>
  let now: number
  let written: Array<[string, number]>
  let displaced: Array<[string, number]>

  const settle = (max = 600): void => {
    for (let i = 0; i < max && frames.length; i++) {
      now += 16
      const batch = frames
      frames = []
      for (const frame of batch) frame(now)
    }
  }

  beforeEach(() => {
    frames = []
    now = 1000
    written = []
    displaced = []
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.splice(id - 1, 1)
    })
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    setPullHost({ setOffset: (tabId, offset) => written.push([tabId, offset]) })
    setPageHold({ displaced: (tabId, offset) => displaced.push([tabId, offset]) })
  })
  afterEach(() => {
    holdPage('t1', 0)
    holdPage('t2', 0)
    abortPull()
    setPageHold(null)
    setPullHost(null)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('writes the held offset through the host channel and lets go with 0', () => {
    expect(holdPage('t1', 24)).toBe(true)
    expect(holdPage('t1', 56)).toBe(true)
    expect(heldPageOffset('t1')).toBe(56)
    expect(heldPageOffset('t2')).toBe(0)
    expect(pageHeldByPull()).toBe(false)
    expect(holdPage('t1', 0)).toBe(true)
    expect(heldPageOffset('t1')).toBe(0)
    expect(written).toEqual([
      ['t1', 24],
      ['t1', 56],
      ['t1', 0]
    ])
  })

  it('refuses to hold a second tab while the first is held', () => {
    holdPage('t1', 56)
    expect(holdPage('t2', 56)).toBe(false)
    expect(written).toEqual([['t1', 56]])
    holdPage('t1', 0)
    expect(holdPage('t2', 56)).toBe(true)
  })

  it('a pull that begins on the held page takes it over where it sits', () => {
    holdPage('t1', 56)
    dispatchPullEvent('t1', 'start')
    // The hold was displaced after the pull had the page; nothing moved.
    expect(displaced).toEqual([['t1', 56]])
    expect(heldPageOffset('t1')).toBe(0)
    expect(pageHeldByPull()).toBe(true)
    expect(written).toEqual([['t1', 56]])
    // Whatever the displaced hold still writes (a spring's last frames) is refused.
    expect(holdPage('t1', 40)).toBe(false)
    expect(holdPage('t1', 0)).toBe(false)
    expect(written).toEqual([['t1', 56]])
    // The finger carries on from 56.
    now += 16
    dispatchPullEvent('t1', 'move', { travel: 0, time: now })
    expect(written[written.length - 1]).toEqual(['t1', 56])
    now += 16
    dispatchPullEvent('t1', 'move', { travel: 10, time: now })
    const [, moved] = written[written.length - 1]
    expect(moved).toBeGreaterThan(56)
    now += 16
    dispatchPullEvent('t1', 'release', { travel: 10, time: now })
    settle()
    expect(pageHeldByPull()).toBe(false)
    expect(written[written.length - 1]).toEqual(['t1', 0])
    // With the page home and the pull idle, the band may hold it again.
    expect(holdPage('t1', 56)).toBe(true)
  })

  it('a pull on a page the hold does not have is an ordinary pull', () => {
    holdPage('t1', 56)
    dispatchPullEvent('t2', 'start')
    expect(displaced).toEqual([])
    // The other tab's pull begins at home…
    expect(written[written.length - 1]).toEqual(['t2', 0])
    // …and while it runs the hold may only let go of its own page, never move it.
    expect(holdPage('t1', 60)).toBe(false)
    expect(holdPage('t1', 0)).toBe(true)
    expect(written[written.length - 1]).toEqual(['t1', 0])
    now += 16
    dispatchPullEvent('t2', 'cancel', { travel: 0, time: now })
    settle()
  })

  it('a hold is refused while a pull has the page, until it comes home', () => {
    dispatchPullEvent('t1', 'start')
    now += 16
    dispatchPullEvent('t1', 'move', { travel: 20, time: now })
    expect(holdPage('t1', 56)).toBe(false)
    now += 16
    dispatchPullEvent('t1', 'release', { travel: 20, time: now })
    expect(holdPage('t1', 56)).toBe(false)
    settle()
    expect(pageHeldByPull()).toBe(false)
    expect(holdPage('t1', 56)).toBe(true)
  })
})
