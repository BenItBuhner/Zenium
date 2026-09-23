/**
 * Damped-spring motion for gesture-driven UI. The maths (`stepSpring`) is shared with the new
 * tab page; this module adds the frame loop the chrome's surfaces run it on.
 */
import { isAtRest, stepSpring, type SpringConfig, type SpringState } from '@shared/spring'

export { SPRING_GENTLE, SPRING_SNAPPY, isAtRest, stepSpring } from '@shared/spring'
export type { SpringConfig, SpringState } from '@shared/spring'

/**
 * The longest step one frame may advance a spring by (ms): a stalled tab must not turn into one
 * huge step. Under a frame rate this slow (a frame every 64 ms is 15 a second) the motion runs
 * in the spring's own time no longer, but in the frames': the harness reconstructs the spring's
 * own time from its frames with this same figure (`MotionPerfDemo.kt`'s `SPRING_STEP_CLAMP_MS`,
 * pinned equal to this one by `spring.test.ts`), and the emulator's cadence is read against it.
 */
export const SPRING_STEP_CLAMP_MS = 64

/**
 * Runs a spring on the animation frame. `stop()` hands the live `{ x, v }` back so a new drag can
 * start from exactly where the motion was – the basis of interruptible transitions.
 */
export class SpringAnimation {
  private frame: number | null = null
  private state: SpringState = { x: 0, v: 0 }
  private target = 0
  private last = 0

  constructor(
    private config: SpringConfig,
    private readonly onFrame: (x: number, v: number) => void,
    private readonly onRest: (x: number) => void
  ) {}

  get running(): boolean {
    return this.frame !== null
  }

  get current(): SpringState {
    return this.state
  }

  /** Where the motion is heading (or last came to rest). */
  get destination(): number {
    return this.target
  }

  /** Start (or restart) from `from` moving at `velocity` px/s towards `to`. */
  start(from: number, velocity: number, to: number, config?: SpringConfig): void {
    if (config) this.config = config
    this.state = { x: from, v: velocity }
    this.target = to
    if (reducedMotion()) {
      this.cancelFrame()
      this.state = { x: to, v: 0 }
      this.onFrame(to, 0)
      this.onRest(to)
      return
    }
    this.last = performance.now()
    if (this.frame === null) this.frame = requestAnimationFrame(this.tick)
  }

  /** Change the destination without disturbing the current motion. */
  retarget(to: number): void {
    this.target = to
    if (this.frame === null) this.start(this.state.x, this.state.v, to)
  }

  /** Freeze the motion (a finger caught it) and report where it was. */
  stop(): SpringState {
    this.cancelFrame()
    return this.state
  }

  /**
   * End the motion where it is: the loop stops and `onRest` runs with the current position, as
   * it would at the rest thresholds. For a caller that knows nothing more of the spring's way to
   * rest can show – a height clamped at a floor once the spring has passed it runs on beneath
   * the floor, the §7 hair of overshoot and back, drawing nothing (the fold's tail: PERF-5,
   * #349). Fine to call from `onFrame`: the frame in flight then asks for no next one. A spring
   * not running has nothing to end and the call does nothing – so a `settle()` from `onFrame`
   * under reduced motion, where `start()` jumps to the destination and rests on its own, rests
   * once. `x` stays where the motion was ended, a hair short of the destination, and the
   * destination stands: a `retarget()` later sets off from there.
   */
  settle(): void {
    if (this.frame === null) return
    this.cancelFrame()
    this.state = { x: this.state.x, v: 0 }
    this.onRest(this.state.x)
  }

  private cancelFrame(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
  }

  private readonly tick = (now: number): void => {
    // A stalled tab must not turn into one huge step.
    const dt = Math.min(SPRING_STEP_CLAMP_MS / 1000, Math.max(0.001, (now - this.last) / 1000))
    this.last = now
    this.state = stepSpring(this.state, this.target, dt, this.config)
    // The frame stays on the books through `onFrame`, so a `stop` or a `settle` made there ends
    // the motion: the frame in flight then asks for no next one. Off the books after it whatever
    // `onFrame` did – a throw must not leave a stale frame that reads as motion (`running`) and
    // keeps `start` from asking for one.
    const frame = this.frame
    let after = frame
    try {
      this.onFrame(this.state.x, this.state.v)
      after = this.frame
    } finally {
      if (this.frame === frame) this.frame = null
    }
    // Stopped or settled there, or started again on a frame of its own: this one is done.
    if (after !== frame) return
    if (isAtRest(this.state, this.target)) {
      this.onRest(this.state.x)
      return
    }
    this.frame = requestAnimationFrame(this.tick)
  }
}

export function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}
