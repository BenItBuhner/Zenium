import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ARMED_GROWTH,
  BUBBLE_FADE_IN,
  BUBBLE_SIZE,
  bubbleHostFrame,
  bubbleOffset,
  bubbleVisuals,
  HistoryNavMachine,
  NAV_BAND_EXTENT,
  NAV_DRAG_DISTANCE,
  NAV_STEP_CLAMP,
  NAV_THRESHOLD,
  navMotion,
  releaseNavigates,
  type HistoryNavEdge,
  type HistoryNavFrame,
  type HistoryNavState
} from '../historyNav'
import { rubberBand } from '../gestures/swipe'

describe('history navigation mapping (Chrome SideSlideLayout; v2 §11.3 input rule)', () => {
  it("pins Chrome's figures: 32 dp drag distance, three of them to navigate, a third per sample", () => {
    expect(NAV_DRAG_DISTANCE).toBe(32)
    expect(NAV_THRESHOLD).toBe(96)
    expect(NAV_BAND_EXTENT).toBe(32)
    expect(NAV_STEP_CLAMP).toBeCloseTo(32 / 3, 9)
    expect(ARMED_GROWTH).toBe(0.15)
  })

  it('rides the finger one to one up to the threshold, then rubber-bands the excess', () => {
    expect(bubbleOffset(0)).toBe(0)
    expect(bubbleOffset(-20)).toBe(0)
    expect(bubbleOffset(16)).toBe(16)
    expect(bubbleOffset(NAV_DRAG_DISTANCE)).toBe(NAV_DRAG_DISTANCE)
    expect(bubbleOffset(64)).toBe(64)
    expect(bubbleOffset(NAV_THRESHOLD)).toBe(NAV_THRESHOLD)
    // Past it: the app's shared band over one drag distance, never a drag distance further in.
    expect(bubbleOffset(NAV_THRESHOLD + 24)).toBeCloseTo(
      NAV_THRESHOLD + rubberBand(24, NAV_BAND_EXTENT),
      9
    )
    expect(bubbleOffset(NAV_THRESHOLD + 24)).toBeLessThan(NAV_THRESHOLD + 24)
    expect(bubbleOffset(NAV_THRESHOLD * 30)).toBeLessThan(NAV_THRESHOLD + NAV_BAND_EXTENT)
    for (let m = 0; m < NAV_THRESHOLD * 2; m += 4)
      expect(bubbleOffset(m + 4)).toBeGreaterThan(bubbleOffset(m))
  })

  it('takes the motion in steps of at most a third of the drag distance, either way', () => {
    expect(navMotion(0, 5, 0)).toBe(5)
    expect(navMotion(0, 50, 0)).toBeCloseTo(NAV_STEP_CLAMP, 9)
    expect(navMotion(40, 10, 60)).toBeCloseTo(40 - NAV_STEP_CLAMP, 9)
    expect(navMotion(40, 55, 60)).toBe(35)
    // Ten samples of a fast swipe are the least that arm (nine reach the threshold exactly, not
    // past it): Chrome's guard against an accidental navigation.
    let motion = 0
    let last = 0
    let samples = 0
    while (!releaseNavigates(motion)) {
      motion = navMotion(motion, last + 100, last)
      last += 100
      samples++
    }
    expect(samples).toBe(10)
  })

  it("navigates only past the threshold: Chrome's willNavigate()", () => {
    expect(releaseNavigates(NAV_THRESHOLD)).toBe(false)
    expect(releaseNavigates(NAV_THRESHOLD + 0.01)).toBe(true)
    expect(releaseNavigates(0)).toBe(false)
  })
})

describe("the disc's visuals (the DOM disc's and a host's, one mapping)", () => {
  it("pins Chrome's 44 disc and the 16 px fade-in", () => {
    expect(BUBBLE_SIZE).toBe(44)
    expect(BUBBLE_FADE_IN).toBe(16)
  })

  it('shifts the disc by its offset from a whole disc out, fading up over the first 16 px', () => {
    expect(bubbleVisuals({ offset: 0, hide: 0, grow: 0 })).toEqual({ x: -44, scale: 1, opacity: 0 })
    expect(bubbleVisuals({ offset: 8, hide: 0, grow: 0 })).toEqual({
      x: -36,
      scale: 1,
      opacity: 0.5
    })
    expect(bubbleVisuals({ offset: 96, hide: 0, grow: 0 })).toEqual({ x: 52, scale: 1, opacity: 1 })
  })

  it('grows by the armed growth and is taken to nothing by the hide', () => {
    expect(bubbleVisuals({ offset: 96, hide: 0, grow: 1 }).scale).toBeCloseTo(1 + ARMED_GROWTH, 9)
    const half = bubbleVisuals({ offset: 96, hide: 0.5, grow: 1 })
    expect(half.scale).toBeCloseTo((1 + ARMED_GROWTH) / 2, 9)
    expect(half.opacity).toBe(0.5)
    expect(bubbleVisuals({ offset: 96, hide: 1, grow: 1 })).toEqual({ x: 52, scale: 0, opacity: 0 })
  })

  it("lays a host's disc against the page's side: a whole disc out at rest, its leading edge `offset` in", () => {
    // The page frame: 360 wide from x 6 (the phone's gutter), 100 to 700 tall.
    const clip = { left: 6, top: 100, right: 366, bottom: 700 }
    const anchorLeft = { x: 6, centerY: 400, clip }
    const state = (edge: HistoryNavEdge, armed = false): HistoryNavState => ({
      tabId: 't1',
      edge,
      phase: 'dragging',
      armed
    })
    const rest = bubbleHostFrame({ offset: 0, hide: 0, grow: 0 }, state('left'), anchorLeft, false)
    expect(rest).toEqual({
      edge: 'left',
      left: 6 - 44,
      top: 378,
      size: 44,
      scale: 1,
      opacity: 0,
      armed: false,
      reduced: false,
      clip
    })
    const armed = bubbleHostFrame(
      { offset: 96, hide: 0, grow: 1 },
      state('left', true),
      anchorLeft,
      true
    )
    // The leading (right) edge stands 96 in from the frame's side: left + size = 6 + 96.
    expect(armed.left + armed.size).toBe(6 + 96)
    // The clip is the frame's box, the same every frame of the drag.
    expect(armed.clip).toBe(clip)
    expect(armed.scale).toBeCloseTo(1 + ARMED_GROWTH, 9)
    expect(armed.opacity).toBe(1)
    expect(armed.armed).toBe(true)
    expect(armed.reduced).toBe(true)

    const anchorRight = { x: 366, centerY: 400, clip }
    const rightRest = bubbleHostFrame(
      { offset: 0, hide: 0, grow: 0 },
      state('right'),
      anchorRight,
      false
    )
    // At rest the disc's left side is on the page's right side: the whole disc out.
    expect(rightRest.left).toBe(366)
    const rightIn = bubbleHostFrame(
      { offset: 96, hide: 0, grow: 0 },
      state('right'),
      anchorRight,
      false
    )
    // The leading (left) edge stands 96 in from the right side.
    expect(rightIn.left).toBe(366 - 96)
    expect(rightIn.edge).toBe('right')
  })
})

interface Harness {
  machine: HistoryNavMachine
  frames: HistoryNavFrame[]
  states: HistoryNavState[]
  navigated: Array<[string, HistoryNavEdge]>
  reduced: boolean
}

describe('HistoryNavMachine', () => {
  let queued: Array<(now: number) => void>
  let now: number

  /** Run queued animation frames until the spring rests (or `max` frames pass). */
  const settle = (max = 600): void => {
    for (let i = 0; i < max && queued.length; i++) {
      now += 16
      const batch = queued
      queued = []
      for (const frame of batch) frame(now)
    }
  }

  const harness = (): Harness => {
    const h: Harness = {
      frames: [],
      states: [],
      navigated: [],
      reduced: false,
      machine: null as unknown as HistoryNavMachine
    }
    h.machine = new HistoryNavMachine({
      navigate: (tabId, edge) => h.navigated.push([tabId, edge]),
      paint: (_tabId, frame) => h.frames.push({ ...frame }),
      onChange: (state) => h.states.push(state),
      reduced: () => h.reduced
    })
    return h
  }

  /** A finger that drags `travel` px into the page over `steps` samples, 16 ms apart. */
  const drag = (h: Harness, travel: number, steps = 12, edge: HistoryNavEdge = 'left'): void => {
    h.machine.dispatch('t1', 'start', { edge })
    for (let i = 1; i <= steps; i++) {
      now += 16
      h.machine.dispatch('t1', 'move', { travel: (travel * i) / steps, time: now })
    }
  }

  beforeEach(() => {
    queued = []
    now = 1000
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      queued.push(cb)
      return queued.length
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      queued.splice(id - 1, 1)
    })
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('paints the bubble under the finger while it is down and arms past the threshold', () => {
    const h = harness()
    h.machine.dispatch('t1', 'start', { edge: 'left' })
    expect(h.machine.state).toEqual({ tabId: 't1', edge: 'left', phase: 'dragging', armed: false })
    expect(h.frames).toEqual([{ offset: 0, hide: 0, grow: 0 }])
    now += 16
    h.machine.dispatch('t1', 'move', { travel: 10, time: now })
    expect(h.machine.current.offset).toBe(10)
    expect(h.machine.state.armed).toBe(false)
    // Nothing is on a spring while the finger rides short of the threshold.
    expect(queued).toHaveLength(0)
    drag(h, 120, 12)
    // 120 px over 12 samples of 10 px: every step under the clamp, the motion is the travel.
    expect(h.machine.current.offset).toBeCloseTo(bubbleOffset(120), 9)
    expect(h.machine.state.armed).toBe(true)
    // Arming is a state change (the chrome ticks on it) – reported exactly once on the way out.
    expect(h.states.filter((s) => s.armed)).toHaveLength(1)
    // Easing back below the threshold disarms again – in the clamp's steps, so three samples.
    for (const travel of [110, 100, 90]) {
      now += 16
      h.machine.dispatch('t1', 'move', { travel, time: now })
    }
    expect(h.machine.current.offset).toBeCloseTo(bubbleOffset(90), 9)
    expect(h.machine.state.armed).toBe(false)
  })

  it('arming grows the disc on the spring and disarming shrinks it back; the ride stays input', () => {
    const h = harness()
    drag(h, 100, 10)
    expect(h.machine.state.armed).toBe(true)
    expect(h.machine.current.grow).toBe(0)
    expect(queued).toHaveLength(1)
    // The finger holds still: the growth runs to 1 on its own frames, monotonically.
    settle()
    const growing = h.frames.filter((f) => f.grow > 0)
    expect(growing.length).toBeGreaterThan(3)
    for (let i = 1; i < growing.length; i++)
      expect(growing[i].grow).toBeGreaterThanOrEqual(growing[i - 1].grow - 1e-9)
    expect(h.machine.current.grow).toBeCloseTo(1, 2)
    // The offset never moved with the growth: the ride is the finger's alone.
    for (const f of growing) expect(f.offset).toBeCloseTo(bubbleOffset(100), 9)
    // Back under the threshold: the disc shrinks again, from where the growth was.
    for (const travel of [90, 80]) {
      now += 16
      h.machine.dispatch('t1', 'move', { travel, time: now })
    }
    expect(h.machine.state.armed).toBe(false)
    settle()
    expect(h.machine.current.grow).toBeCloseTo(0, 2)
    expect(h.machine.state.phase).toBe('dragging')
  })

  it('a fast swipe needs several samples before it arms', () => {
    const h = harness()
    h.machine.dispatch('t1', 'start', { edge: 'left' })
    now += 16
    h.machine.dispatch('t1', 'move', { travel: 200, time: now })
    expect(h.machine.current.offset).toBeCloseTo(NAV_STEP_CLAMP, 9)
    expect(h.machine.state.armed).toBe(false)
  })

  it('a release short of the threshold springs the bubble home without navigating', () => {
    const h = harness()
    drag(h, 60)
    expect(h.machine.state.armed).toBe(false)
    h.machine.dispatch('t1', 'release', { time: now })
    expect(h.machine.state.phase).toBe('settling')
    settle()
    expect(h.navigated).toEqual([])
    expect(h.machine.state).toEqual({ tabId: null, edge: 'left', phase: 'idle', armed: false })
    expect(h.frames[h.frames.length - 1]).toEqual({ offset: 0, hide: 0, grow: 0 })
    // The return never overshoots out past the side, and never hides the disc on the way.
    for (const f of h.frames) {
      expect(f.offset).toBeGreaterThanOrEqual(0)
      expect(f.hide).toBe(0)
    }
  })

  it('a release past the threshold goes back and shrinks the bubble away where it stands', () => {
    const h = harness()
    drag(h, 120)
    expect(h.machine.state.armed).toBe(true)
    settle()
    expect(h.machine.current.grow).toBeCloseTo(1, 2)
    h.machine.dispatch('t1', 'release', { time: now })
    expect(h.navigated).toEqual([['t1', 'left']])
    expect(h.machine.state.phase).toBe('navigating')
    const standing = h.machine.current.offset
    settle()
    expect(h.machine.state.phase).toBe('idle')
    // The disc stayed where the finger left it, grown, while `hide` ran to 1.
    const hiding = h.frames.filter((f) => f.hide > 0 && f.hide < 1)
    expect(hiding.length).toBeGreaterThan(2)
    for (const f of hiding) {
      expect(f.offset).toBeCloseTo(standing, 9)
      expect(f.grow).toBeCloseTo(1, 2)
    }
    for (let i = 1; i < hiding.length; i++)
      expect(hiding[i].hide).toBeGreaterThanOrEqual(hiding[i - 1].hide)
  })

  it('a cancel while armed runs the growth back with the return', () => {
    const h = harness()
    drag(h, 120)
    settle()
    expect(h.machine.current.grow).toBeCloseTo(1, 2)
    h.machine.dispatch('t1', 'cancel', { time: now })
    expect(h.machine.state.armed).toBe(false)
    settle()
    expect(h.navigated).toEqual([])
    expect(h.machine.state.phase).toBe('idle')
    expect(h.frames[h.frames.length - 1]).toEqual({ offset: 0, hide: 0, grow: 0 })
  })

  it('a drag from the right edge goes forward', () => {
    const h = harness()
    drag(h, 120, 12, 'right')
    expect(h.machine.state.edge).toBe('right')
    h.machine.dispatch('t1', 'release', { time: now })
    expect(h.navigated).toEqual([['t1', 'right']])
  })

  it('a cancel retracts like a short release', () => {
    const h = harness()
    drag(h, 120)
    h.machine.dispatch('t1', 'cancel', { time: now })
    expect(h.machine.state.phase).toBe('settling')
    settle()
    expect(h.navigated).toEqual([])
    expect(h.machine.state.phase).toBe('idle')
  })

  it('ignores events for another tab or out of phase', () => {
    const h = harness()
    drag(h, 60)
    h.machine.dispatch('t2', 'move', { travel: 200, time: now })
    h.machine.dispatch('t2', 'release', { time: now })
    expect(h.machine.state).toEqual({ tabId: 't1', edge: 'left', phase: 'dragging', armed: false })
    h.machine.dispatch('t1', 'release', { time: now })
    // Late moves after the release change nothing.
    h.machine.dispatch('t1', 'move', { travel: 300, time: now })
    expect(h.machine.state.phase).toBe('settling')
    expect(h.navigated).toEqual([])
  })

  it('abort takes the bubble down at once', () => {
    const h = harness()
    drag(h, 120)
    expect(queued).toHaveLength(1)
    h.machine.abort()
    expect(h.machine.state).toEqual({ tabId: null, edge: 'left', phase: 'idle', armed: false })
    expect(h.frames[h.frames.length - 1]).toEqual({ offset: 0, hide: 0, grow: 0 })
    expect(queued).toHaveLength(0)
  })

  it('under reduced motion the drag still tracks, the growth jumps and the bubble leaves on a 120 ms fade', () => {
    const h = harness()
    h.reduced = true
    drag(h, 120)
    const standing = bubbleOffset(120)
    expect(h.machine.current.offset).toBeCloseTo(standing, 9)
    // The growth is a spring, so it jumps: no frame was asked for.
    expect(h.machine.current.grow).toBe(1)
    expect(queued).toHaveLength(0)
    h.machine.dispatch('t1', 'release', { time: now })
    expect(h.navigated).toEqual([['t1', 'left']])
    // One frame with the disc where it stands and `hide` at 1: the CSS fade does the rest.
    expect(h.frames[h.frames.length - 1]).toEqual({ offset: standing, hide: 1, grow: 1 })
    expect(h.machine.state.phase).toBe('navigating')
    expect(queued).toHaveLength(0)
    vi.advanceTimersByTime(119)
    expect(h.machine.state.phase).toBe('navigating')
    vi.advanceTimersByTime(1)
    expect(h.machine.state.phase).toBe('idle')

    const short = harness()
    short.reduced = true
    drag(short, 30)
    short.machine.dispatch('t1', 'release', { time: now })
    expect(short.frames[short.frames.length - 1]).toEqual({ offset: 30, hide: 1, grow: 0 })
    vi.advanceTimersByTime(120)
    expect(short.machine.state.phase).toBe('idle')
    expect(short.navigated).toEqual([])
  })
})
