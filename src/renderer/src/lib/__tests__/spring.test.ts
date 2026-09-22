import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SPRING_GENTLE,
  SPRING_SNAPPY,
  SPRING_STEP_CLAMP_MS,
  SpringAnimation,
  isAtRest,
  reducedMotion,
  stepSpring,
  type SpringConfig,
  type SpringState
} from '../motion/spring'

/** Run the spring frame by frame until it rests (or `maxFrames` pass); returns the trace. */
function simulate(
  from: SpringState,
  target: number,
  config: SpringConfig,
  dt = 1 / 60,
  maxFrames = 600
): SpringState[] {
  const trace: SpringState[] = [from]
  let state = from
  for (let i = 0; i < maxFrames && !isAtRest(state, target); i++) {
    state = stepSpring(state, target, dt, config)
    trace.push(state)
  }
  return trace
}

describe('stepSpring', () => {
  it('settles exactly on the target from rest', () => {
    const trace = simulate({ x: 0, v: 0 }, 400, SPRING_SNAPPY)
    const last = trace[trace.length - 1]
    expect(last).toEqual({ x: 400, v: 0 })
    // Fast enough for a tab switch, but not instant.
    expect(trace.length).toBeGreaterThan(10)
    expect(trace.length).toBeLessThan(60)
  })

  it('is nonlinear: covers most of the distance early, then eases in', () => {
    const trace = simulate({ x: 0, v: 0 }, 400, SPRING_SNAPPY)
    const quarter = trace[Math.floor(trace.length / 4)].x
    const half = trace[Math.floor(trace.length / 2)].x
    expect(quarter).toBeGreaterThan(400 * 0.4)
    expect(half).toBeGreaterThan(400 * 0.85)
  })

  it('never overshoots noticeably with the snappy tuning', () => {
    const trace = simulate({ x: 0, v: 0 }, 400, SPRING_SNAPPY)
    expect(Math.max(...trace.map((s) => s.x))).toBeLessThan(402)
  })

  it('carries a fling: initial velocity moves it further before it turns back', () => {
    const noFling = simulate({ x: 100, v: 0 }, 0, SPRING_GENTLE)
    const fling = simulate({ x: 100, v: 900 }, 0, SPRING_GENTLE)
    expect(Math.max(...fling.map((s) => s.x))).toBeGreaterThan(100)
    expect(Math.max(...noFling.map((s) => s.x))).toBe(100)
    expect(fling[fling.length - 1]).toEqual({ x: 0, v: 0 })
  })

  it('is independent of the frame rate', () => {
    const at60 = simulate({ x: 0, v: 0 }, 300, SPRING_GENTLE, 1 / 60)
    const at30 = simulate({ x: 0, v: 0 }, 300, SPRING_GENTLE, 1 / 30)
    // Compare the position after the same wall-clock time (100 ms).
    const x60 = at60[6].x
    const x30 = at30[3].x
    expect(Math.abs(x60 - x30)).toBeLessThan(0.5)
  })

  it('handles under-, critically and over-damped tunings', () => {
    const under: SpringConfig = { ...SPRING_GENTLE, damping: 10 }
    const critical: SpringConfig = { ...SPRING_GENTLE, damping: 2 * Math.sqrt(300) }
    const over: SpringConfig = { ...SPRING_GENTLE, damping: 60 }
    for (const config of [under, critical, over]) {
      const trace = simulate({ x: 0, v: 0 }, 200, config, 1 / 60, 2000)
      expect(trace[trace.length - 1]).toEqual({ x: 200, v: 0 })
    }
    const wobble = simulate({ x: 0, v: 0 }, 200, under, 1 / 60, 2000)
    expect(Math.max(...wobble.map((s) => s.x))).toBeGreaterThan(210)
  })

  it('a stopped spring hands over a state a new drag can continue from', () => {
    const trace = simulate({ x: 0, v: 0 }, 400, SPRING_SNAPPY)
    const caught = trace[5]
    expect(caught.x).toBeGreaterThan(0)
    expect(caught.x).toBeLessThan(400)
    // Reverse from the caught state towards the origin: still ends at rest, on the new target.
    const back = simulate(caught, 0, SPRING_SNAPPY)
    expect(back[back.length - 1]).toEqual({ x: 0, v: 0 })
  })

  it('rests by px thresholds: a spring over a 0…1 progress would snap the last 40%', () => {
    // Why the FLIP tracker and the exit of a closed card run their springs over a distance in
    // px and divide back: on a unit scale the rest thresholds are met almost at once.
    const unit = simulate({ x: 1, v: 0 }, 0, SPRING_SNAPPY)
    expect(unit.length).toBeLessThan(10)
    expect(unit[unit.length - 2].x).toBeGreaterThan(0.3)
    const px = simulate({ x: 190, v: 0 }, 0, SPRING_SNAPPY)
    expect(px.length).toBeGreaterThan(15)
    expect(px[px.length - 2].x).toBeLessThan(1)
  })
})

describe('SpringAnimation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** The animation frame, held for the test to run by hand. */
  const frames = (): { queue: FrameRequestCallback[] } => {
    const queue: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => queue.push(cb))
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    vi.stubGlobal('performance', { now: () => 0 })
    return { queue }
  }

  it('runs on the animation frame towards a destination it can be asked for', () => {
    const { queue } = frames()
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
    expect(reducedMotion()).toBe(false)
    const onFrame = vi.fn()
    const onRest = vi.fn()
    const spring = new SpringAnimation(SPRING_SNAPPY, onFrame, onRest)
    spring.start(0, 0, 300)
    expect(spring.running).toBe(true)
    expect(spring.destination).toBe(300)
    expect(queue).toHaveLength(1)
    expect(onFrame).not.toHaveBeenCalled()
    spring.retarget(120)
    expect(spring.destination).toBe(120)
    // Retargeting mid-flight asks for no second frame: the one in flight carries on.
    expect(queue).toHaveLength(1)
  })

  it('under reduced motion jumps to its destination and rests in the same call, asking for no frame (v2 §11.3)', () => {
    const { queue } = frames()
    vi.stubGlobal('window', {
      matchMedia: (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)' })
    })
    expect(reducedMotion()).toBe(true)
    const onFrame = vi.fn()
    const onRest = vi.fn()
    const spring = new SpringAnimation(SPRING_GENTLE, onFrame, onRest)
    // A release with the velocity of the hand behind it: the ghost is in its slot at once.
    spring.start(40, 900, 300)
    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(onFrame).toHaveBeenCalledWith(300, 0)
    expect(onRest).toHaveBeenCalledTimes(1)
    expect(onRest).toHaveBeenCalledWith(300)
    expect(spring.running).toBe(false)
    expect(spring.current).toEqual({ x: 300, v: 0 })
    expect(queue).toHaveLength(0)
    // A drag tracks 1:1: every new destination is where the motion is, at once.
    spring.retarget(120)
    expect(onFrame).toHaveBeenLastCalledWith(120, 0)
    expect(spring.current).toEqual({ x: 120, v: 0 })
    expect(queue).toHaveLength(0)
  })

  it('advances a late frame by the step clamp, not by the time it took', () => {
    const { queue } = frames()
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
    const spring = new SpringAnimation(
      SPRING_SNAPPY,
      () => undefined,
      () => undefined
    )
    spring.start(0, 0, 300)
    // A frame 200 ms after the start (a stalled tab, the emulator's software GPU): the spring
    // moves as it would in one frame of the clamp's length – so a motion of N ms of its own
    // time takes N × (frame / clamp) ms of the wall's, the stretch the harness reads off.
    queue.shift()!(200)
    expect(spring.current).toEqual(
      stepSpring({ x: 0, v: 0 }, 300, SPRING_STEP_CLAMP_MS / 1000, SPRING_SNAPPY)
    )
    expect(spring.current).not.toEqual(stepSpring({ x: 0, v: 0 }, 300, 0.2, SPRING_SNAPPY))
  })
})

/*
 * The harness reconstructs a spring's own time from the frames the probe saw it write, each
 * interval clamped as `SpringAnimation.tick` clamps its step (`MotionPerfDemo.kt`'s
 * `foldNumbers`): its copy of the clamp must be this one, or the stretch it reports drifts from
 * the product's without a word.
 */
describe('the harness twin (MotionPerfDemo.kt)', () => {
  it('holds the same step clamp', () => {
    const kotlin = readFileSync(
      resolve(
        __dirname,
        '../../../../../android/app/src/androidTest/kotlin/app/zen/chromium/MotionPerfDemo.kt'
      ),
      'utf8'
    )
    const twin = /SPRING_STEP_CLAMP_MS\s*=\s*([\d.]+)/.exec(kotlin)
    expect(twin, 'MotionPerfDemo.kt names SPRING_STEP_CLAMP_MS').not.toBeNull()
    expect(Number(twin![1])).toBe(SPRING_STEP_CLAMP_MS)
  })
})
