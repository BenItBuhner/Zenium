import { dragPosition, settleTarget } from '../gestures/swipe'
import { SPRING_GENTLE, SPRING_SNAPPY, SpringAnimation } from './spring'

export type SheetPhase = 'closed' | 'settling' | 'open' | 'dragging'

export interface SheetState {
  phase: SheetPhase
  /**
   * Where the sheet is on its track: 0 = resting open, 1 = fully out of view. Rubber-banded a
   * little past 0 while a finger overshoots upwards.
   */
  progress: number
}

export const SHEET_CLOSED: SheetState = { phase: 'closed', progress: 1 }

/**
 * How far along its track the system back gesture pulls the sheet at full progress: it peeks
 * down to show it is about to go, then commits with the spring (or springs back when cancelled).
 */
export const BACK_PEEK = 0.3

export interface SheetMotionOptions {
  /** Distance (px) between resting open and fully dismissed – the sheet's height. */
  travel: () => number
  onChange: (state: SheetState) => void
  /** The dismissal finished: the sheet may be unmounted. */
  onClosed: () => void
}

/**
 * The motion of a dismissible sheet, on one `progress` track with the stage's rules: presented
 * with a spring, dragged by a finger (which can catch the spring in flight), flung or dropped back
 * on release, and driven by the system back gesture through `backProgress` / `backCommit` /
 * `backCancel` so a predictive back peeks it away before it goes.
 */
export class SheetMotion {
  private state: SheetState = SHEET_CLOSED
  private dragStart = 0
  private readonly spring: SpringAnimation

  constructor(private readonly options: SheetMotionOptions) {
    this.spring = new SpringAnimation(
      SPRING_GENTLE,
      (x) => {
        if (this.state.phase !== 'settling') return
        this.set({ phase: 'settling', progress: x / this.travel() })
      },
      (x) => this.settled(x / this.travel())
    )
  }

  get current(): SheetState {
    return this.state
  }

  get isOpen(): boolean {
    return this.state.phase !== 'closed'
  }

  /** Bring the sheet in (from wherever it is – closed, or half dismissed). */
  present(): void {
    const from = this.state.phase === 'closed' ? 1 : this.hold()
    this.set({ phase: 'settling', progress: from })
    this.spring.start(from * this.travel(), 0, 0, SPRING_GENTLE)
  }

  /** Send the sheet away with the spring, carrying `velocity` (px/s, positive = away). */
  dismiss(velocity = 0): void {
    if (this.state.phase === 'closed') return
    const from = this.hold()
    const travel = this.travel()
    this.set({ phase: 'settling', progress: from })
    this.spring.start(from * travel, velocity, travel, SPRING_SNAPPY)
  }

  /** A finger took hold of the sheet (catching a spring in flight). False when closed. */
  beginDrag(): boolean {
    if (this.state.phase === 'closed') return false
    const progress = this.hold()
    this.dragStart = progress
    this.set({ phase: 'dragging', progress })
    return true
  }

  /** The finger moved `deltaPx` along the track (positive = towards dismissal). */
  drag(deltaPx: number): void {
    if (this.state.phase !== 'dragging') return
    const progress = dragPosition(this.dragStart, deltaPx, this.travel(), 0, 1)
    if (progress !== this.state.progress) this.set({ phase: 'dragging', progress })
  }

  /** The finger lifted, moving at `velocity` px/s along the track. */
  release(velocity: number): void {
    if (this.state.phase !== 'dragging') return
    const target = settleTarget({
      position: this.state.progress,
      origin: 0,
      velocity,
      extent: this.travel(),
      min: 0,
      max: 1
    })
    if (target >= 1) {
      this.dismiss(velocity)
      return
    }
    const from = this.state.progress
    this.set({ phase: 'settling', progress: from })
    this.spring.start(from * this.travel(), velocity, 0, SPRING_GENTLE)
  }

  /** System back gesture in flight: `p` is its 0…1 progress. */
  backProgress(p: number): void {
    if (this.state.phase === 'closed') return
    if (this.state.phase === 'settling') this.spring.stop()
    const clamped = Math.min(1, Math.max(0, p))
    this.set({ phase: 'dragging', progress: clamped * BACK_PEEK })
  }

  /** The back gesture completed: finish the dismissal from where the peek left the sheet. */
  backCommit(): void {
    if (this.state.phase === 'closed') return
    this.dismiss()
  }

  /** The back gesture was abandoned: the sheet springs back to rest. */
  backCancel(): void {
    if (this.state.phase === 'closed') return
    this.present()
  }

  /** Take the sheet down at once, without animation (the layout changed, another surface opened). */
  close(): void {
    this.spring.stop()
    if (this.state.phase === 'closed') return
    this.set(SHEET_CLOSED)
    this.options.onClosed()
  }

  /** Freeze whatever motion is running and report where the sheet is. */
  private hold(): number {
    if (this.state.phase === 'settling') return this.spring.stop().x / this.travel()
    return this.state.progress
  }

  private settled(progress: number): void {
    if (this.state.phase !== 'settling') return
    if (progress >= 0.999) {
      this.set(SHEET_CLOSED)
      this.options.onClosed()
    } else {
      this.set({ phase: 'open', progress: 0 })
    }
  }

  private travel(): number {
    return Math.max(1, this.options.travel())
  }

  private set(state: SheetState): void {
    this.state = state
    this.options.onChange(state)
  }
}
