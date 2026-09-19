/**
 * Damped-spring motion for gesture-driven UI. The maths (`stepSpring`) is shared with the new
 * tab page; this module adds the frame loop the chrome's surfaces run it on.
 */
import { isAtRest, stepSpring, type SpringConfig, type SpringState } from '@shared/spring'

export { SPRING_GENTLE, SPRING_SNAPPY, isAtRest, stepSpring } from '@shared/spring'
export type { SpringConfig, SpringState } from '@shared/spring'

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

  private cancelFrame(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
  }

  private readonly tick = (now: number): void => {
    this.frame = null
    // A stalled tab must not turn into one huge step.
    const dt = Math.min(0.064, Math.max(0.001, (now - this.last) / 1000))
    this.last = now
    this.state = stepSpring(this.state, this.target, dt, this.config)
    this.onFrame(this.state.x, this.state.v)
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
