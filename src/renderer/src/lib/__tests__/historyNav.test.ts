import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BUBBLE_FADE_IN,
  BUBBLE_MIN_SCALE,
  BUBBLE_SIZE,
  bubbleHostFrame,
  bubbleOffset,
  bubbleVisuals,
  HIDE_SHRINK,
  HistoryNavMachine,
  NAV_BAND_EXTENT,
  NAV_DRAG_DISTANCE,
  NAV_STEP_CLAMP,
  NAV_THRESHOLD,
  navGrowth,
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

  it("heads the growth for the drag's approach to the threshold: 0 as it begins, 1 at and past it", () => {
    expect(navGrowth(0)).toBe(0)
    expect(navGrowth(-20)).toBe(0)
    expect(navGrowth(NAV_THRESHOLD / 2)).toBe(0.5)
    expect(navGrowth(NAV_THRESHOLD)).toBe(1)
    expect(navGrowth(NAV_THRESHOLD + 30)).toBe(1)
    for (let m = 0; m < NAV_THRESHOLD; m += 4)
      expect(navGrowth(m + 4)).toBeGreaterThan(navGrowth(m))
  })
})

describe("the disc's visuals (the DOM disc's and a host's, one mapping)", () => {
  it("pins v2 §11.9's 44 disc, its .6 → 1 growth, the exit's tenth of shrink and the 16 px fade-in", () => {
    expect(BUBBLE_SIZE).toBe(44)
    expect(BUBBLE_MIN_SCALE).toBe(0.6)
    expect(HIDE_SHRINK).toBe(0.1)
    expect(BUBBLE_FADE_IN).toBe(16)
  })

  it('shifts the disc by its offset from a whole disc out, fading up over the first 16 px', () => {
    expect(bubbleVisuals({ offset: 0, hide: 0, grow: 0 })).toEqual({
      x: -44,
      scale: BUBBLE_MIN_SCALE,
      opacity: 0
    })
    expect(bubbleVisuals({ offset: 8, hide: 0, grow: 0 })).toEqual({
      x: -36,
      scale: BUBBLE_MIN_SCALE,
      opacity: 0.5
    })
    expect(bubbleVisuals({ offset: 96, hide: 0, grow: 0 })).toEqual({
      x: 52,
      scale: BUBBLE_MIN_SCALE,
      opacity: 1
    })
  })

  it('grows from .6 to full with the growth, and leaves on the exit fade: opacity out with a tenth of shrink', () => {
    expect(bubbleVisuals({ offset: 48, hide: 0, grow: 0.5 }).scale).toBeCloseTo(0.8, 9)
    expect(bubbleVisuals({ offset: 96, hide: 0, grow: 1 }).scale).toBe(1)
    const half = bubbleVisuals({ offset: 96, hide: 0.5, grow: 1 })
    expect(half.scale).toBeCloseTo(1 - HIDE_SHRINK / 2, 9)
    expect(half.opacity).toBe(0.5)
    const gone = bubbleVisuals({ offset: 96, hide: 1, grow: 1 })
    expect(gone.x).toBe(52)
    expect(gone.scale).toBeCloseTo(1 - HIDE_SHRINK, 9)
    expect(gone.opacity).toBe(0)
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
      scale: BUBBLE_MIN_SCALE,
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
    // Full at the threshold (v2 §11.9).
    expect(armed.scale).toBe(1)
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
    // The offset is the finger's alone (input); the growth is the one spring, and it is on its
    // way from the first sample.
    expect(queued).toHaveLength(1)
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

  it("the growth follows the finger's approach to the threshold on its spring; the ride stays input", () => {
    const h = harness()
    // Half way: the growth heads for .5 and runs there on its own frames, monotonically.
    drag(h, NAV_THRESHOLD / 2, 6)
    expect(h.machine.state.armed).toBe(false)
    expect(queued).toHaveLength(1)
    settle()
    const growing = h.frames.filter((f) => f.grow > 0)
    expect(growing.length).toBeGreaterThan(3)
    for (let i = 1; i < growing.length; i++)
      expect(growing[i].grow).toBeGreaterThanOrEqual(growing[i - 1].grow - 1e-9)
    expect(h.machine.current.grow).toBeCloseTo(0.5, 2)
    // The offset never moved with the growth: the ride is the finger's alone.
    for (const f of growing) expect(f.offset).toBeCloseTo(NAV_THRESHOLD / 2, 9)
    // On to the threshold in steps under the clamp, the spring retargeted mid-flight each time:
    // full at the threshold, no jump on the way.
    const painted = h.frames.length
    for (const travel of [58, 68, 78, 88, 100]) {
      now += 16
      h.machine.dispatch('t1', 'move', { travel, time: now })
      settle(2)
    }
    expect(h.machine.state.armed).toBe(true)
    settle()
    expect(h.machine.current.grow).toBeCloseTo(1, 2)
    const onward = h.frames.slice(painted)
    for (let i = 1; i < onward.length; i++)
      expect(onward[i].grow).toBeGreaterThanOrEqual(onward[i - 1].grow - 1e-9)
    // Easing back out shrinks it again, to where the finger's approach stands.
    for (const travel of [90, 80]) {
      now += 16
      h.machine.dispatch('t1', 'move', { travel, time: now })
    }
    expect(h.machine.state.armed).toBe(false)
    settle()
    // Under the threshold the offset is the motion itself (the clamp trimmed the 12 px step).
    const motion = h.machine.current.offset
    expect(motion).toBeLessThan(80)
    expect(motion).toBeGreaterThan(70)
    expect(h.machine.current.grow).toBeCloseTo(navGrowth(motion), 2)
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

  it('a release past the threshold goes back and the bubble leaves on the exit fade where it stands', () => {
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
    // The disc stayed where the finger left it, full, while `hide` ran to 1.
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

  it('under reduced motion the drag still tracks, the disc is full from the start and leaves on a 120 ms fade', () => {
    const h = harness()
    h.reduced = true
    h.machine.dispatch('t1', 'start', { edge: 'left' })
    // Drawn at its full size the moment the drag arms (v2 §11.9): the growth is movement, and
    // movement goes – no spring, no frame asked for.
    expect(h.frames).toEqual([{ offset: 0, hide: 0, grow: 1 }])
    drag(h, 120)
    const standing = bubbleOffset(120)
    expect(h.machine.current.offset).toBeCloseTo(standing, 9)
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
    // Cut on release, still full: nothing shrinks back under reduced motion.
    expect(short.frames[short.frames.length - 1]).toEqual({ offset: 30, hide: 1, grow: 1 })
    vi.advanceTimersByTime(120)
    expect(short.machine.state.phase).toBe('idle')
    expect(short.navigated).toEqual([])
  })
})
