/**
 * The page-edge band's motion (motion spec §2, §3.1–3.2): the page travels down by the band's
 * height on `SPRING_GENTLE` and the band's content fades in over the last 120 ms of the travel;
 * leaving, the content fades first and the page travels back up on the spring. A swipe up on the
 * band takes the page with the finger 1:1; a release past half the height (or a fling) dismisses,
 * else the band springs back. A new height re-targets the one spring (never a second motion), and
 * under reduced motion the page jumps while the content fades 120 ms.
 *
 * The driver owns the numbers and nothing else: it tells its `BandSeam` where the page is each
 * frame and how present the content is, and the host writes those where it must – the desktop
 * translates the content view's bounds by the offset and lays the page out once at rest, Android
 * moves its WebView by the pull channel, the React band writes its content's opacity. Every frame
 * comes from the chrome's one animation clock (§6).
 */
import { SWIPE_THRESHOLDS } from '../gestures/swipe'
import { cancelFrame, requestFrame } from './clock'
import {
  isAtRest,
  reducedMotion,
  SPRING_GENTLE,
  SpringAnimation,
  stepSpring,
  type SpringState
} from './spring'
import { MOTION_STATE_MS } from './tokens'

/** The band's heights (§3.1): one line, and a title with a detail line. */
export const BAND_HEIGHT_ONE_LINE = 56
export const BAND_HEIGHT_TWO_LINE = 76
export type BandHeight = typeof BAND_HEIGHT_ONE_LINE | typeof BAND_HEIGHT_TWO_LINE

/** The content's fade at either end of the travel, and the whole of it under reduced motion. */
export const BAND_FADE_MS = MOTION_STATE_MS

/** Where the band's motion is. */
export type BandPhase =
  | 'closed'
  /** The page travels down from the frame's edge; the content fades in at the end. */
  | 'opening'
  /** At rest at its height. */
  | 'open'
  /** Open, and travelling to a new height for a new tenant (the content is the tenant's own). */
  | 'resizing'
  /** A finger has it: the page follows 1:1. */
  | 'dragging'
  /** Let go short of half: springing back to its height. */
  | 'returning'
  /** The content fades, the page travels up. */
  | 'closing'

/**
 * What the host does with the band's numbers. `translate` arrives per frame (and per pointer
 * move under a finger) with the page's offset from the frame's top edge: 0 with the band shut,
 * the band's height with it open. `rest` arrives when a motion ends, at the height it ended at:
 * the band's height once open, 0 once shut – where the desktop lays the page out once (§3.1) and
 * the band's content is let go. `paint` arrives with the content's opacity whenever it changes.
 */
export interface BandSeam {
  translate(offset: number): void
  rest(height: number): void
  paint(opacity: number): void
}

const FRAME_S = 1 / 60
/** Frames the remaining-time estimate runs ahead at most: a spring not resting by then is slow enough to show. */
const ESTIMATE_LIMIT = 64

/**
 * How long (ms) a spring at `state` takes to rest on `target`, read by running it ahead a frame
 * at a time – the content's fade-in is timed to the last 120 ms of a travel whose length only
 * the spring knows.
 */
export function remainingMs(state: SpringState, target: number, config = SPRING_GENTLE): number {
  let s = state
  let frames = 0
  while (frames < ESTIMATE_LIMIT && !isAtRest(s, target)) {
    s = stepSpring(s, target, FRAME_S, config)
    frames++
  }
  return frames * FRAME_S * 1000
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

export class BandMotion {
  private phase_: BandPhase = 'closed'
  private height_ = 0
  private offset_ = 0
  private opacity_ = 0
  /** When the leave began and how present the content was then: it fades from there over 120 ms. */
  private closingSince = 0
  private closingFrom = 1
  private readonly spring: SpringAnimation
  private fadeFrame: number | null = null

  constructor(private readonly seam: BandSeam) {
    this.spring = new SpringAnimation(
      SPRING_GENTLE,
      (x) => this.frame(x),
      (x) => this.rested(x)
    )
  }

  get phase(): BandPhase {
    return this.phase_
  }

  /** The height the band stands (or is heading) at; 0 shut. */
  get height(): number {
    return this.height_
  }

  /** The page's present offset from the frame's edge. */
  get offset(): number {
    return this.offset_
  }

  /** The content's present opacity. */
  get opacity(): number {
    return this.opacity_
  }

  /**
   * Open at `height`, or – open already – travel to `height`. Opening from shut (or from a
   * leave not yet done) is the §2 entrance: the page travels down, the content fades in at the
   * end; a new height during the entrance re-targets it and the fade-in keeps its rule. A new
   * height on an open band is a re-target of the one spring at full opacity: the tenant's
   * content cross-fades on its own (§3.2). Under a finger the new height is where the release
   * returns to.
   */
  open(height: number): void {
    this.height_ = height
    if (this.phase_ === 'dragging') return
    const entering =
      this.phase_ === 'closed' || this.phase_ === 'closing' || this.phase_ === 'opening'
    if (entering) {
      this.endFade()
      this.phase_ = 'opening'
      if (reducedMotion()) {
        // §3.2: the page jumps to the open height and the band fades in 120 ms.
        this.spring.start(this.offset_, 0, height)
        this.fade(1)
        return
      }
      if (this.spring.running) this.spring.retarget(height)
      else this.spring.start(this.offset_, this.spring.current.v, height)
      return
    }
    if (this.offset_ === height && !this.spring.running) {
      this.paint(1)
      return
    }
    this.phase_ = 'resizing'
    this.paint(1)
    this.spring.retarget(height)
  }

  /** Leave: the content fades over the first 120 ms while the page travels up (§2). */
  close(): void {
    if (this.phase_ === 'closed' || this.phase_ === 'closing') return
    this.endFade()
    if (this.phase_ === 'dragging') this.spring.stop()
    this.leave(this.spring.running ? this.spring.current.v : 0)
  }

  /** A finger has the band: the motion stops where it is and the page follows the finger. */
  dragStart(): void {
    if (this.phase_ === 'closed' || this.phase_ === 'closing') return
    this.endFade()
    this.spring.stop()
    this.phase_ = 'dragging'
  }

  /** The finger moved `dy` px (negative up) from where it took hold: the page follows 1:1. */
  drag(dy: number): void {
    if (this.phase_ !== 'dragging') return
    const x = Math.min(this.height_, Math.max(0, this.height_ + dy))
    this.offset_ = x
    this.seam.translate(x)
    this.paint(this.height_ > 0 ? x / this.height_ : 0)
  }

  /**
   * The finger lifted, moving at `velocity` px/s (negative up): past half the height or flung
   * up the band leaves with that velocity; else it springs back to its height.
   */
  release(velocity: number): void {
    if (this.phase_ !== 'dragging') return
    const flung = velocity <= -SWIPE_THRESHOLDS.flingVelocity
    if (flung || this.offset_ < this.height_ / 2) {
      if (reducedMotion()) {
        // A release's outcome is at once (as a card's): gone.
        this.phase_ = 'closing'
        this.spring.start(this.offset_, 0, 0)
        return
      }
      this.leave(velocity)
      return
    }
    this.phase_ = 'returning'
    this.spring.start(this.offset_, velocity, this.height_)
  }

  /** Stop every motion and frame; the seam hears nothing more. */
  dispose(): void {
    this.endFade()
    this.spring.stop()
  }

  private leave(velocity: number): void {
    this.phase_ = 'closing'
    this.closingFrom = this.opacity_
    if (reducedMotion()) {
      // §3.2: leaving fades out, then jumps.
      this.fade(0, () => this.spring.start(this.offset_, 0, 0))
      return
    }
    this.closingSince = performance.now()
    this.spring.start(this.offset_, velocity, 0)
  }

  private paint(opacity: number): void {
    const o = clamp01(opacity)
    if (o === this.opacity_) return
    this.opacity_ = o
    this.seam.paint(o)
  }

  private frame(x: number): void {
    switch (this.phase_) {
      case 'opening': {
        // The content fades in over the last 120 ms of the travel (§3.1); a re-target that
        // lengthens the travel never takes back what has shown.
        if (!reducedMotion()) {
          const left = remainingMs(this.spring.current, this.height_)
          this.paint(Math.max(this.opacity_, 1 - left / BAND_FADE_MS))
        }
        break
      }
      case 'closing': {
        if (!reducedMotion()) {
          const t = clamp01((performance.now() - this.closingSince) / BAND_FADE_MS)
          this.paint(this.closingFrom * (1 - t))
        }
        if (x <= 0) {
          // Past the edge nothing more can show: rest here rather than run the hair of
          // overshoot and back beneath it (as the fold does).
          this.offset_ = 0
          this.seam.translate(0)
          this.spring.settle()
          return
        }
        break
      }
      case 'returning':
        this.paint(this.height_ > 0 ? x / this.height_ : 1)
        break
      default:
        break
    }
    this.offset_ = Math.max(0, x)
    this.seam.translate(this.offset_)
  }

  private rested(x: number): void {
    if (this.phase_ === 'closing') {
      this.paint(0)
      this.phase_ = 'closed'
      this.height_ = 0
      if (this.offset_ !== 0) {
        this.offset_ = 0
        this.seam.translate(0)
      }
      this.seam.rest(0)
      return
    }
    if (this.phase_ === 'dragging') return
    this.offset_ = x
    if (this.phase_ !== 'opening' || !reducedMotion()) this.paint(1)
    this.phase_ = 'open'
    this.seam.rest(this.height_)
  }

  /** The reduced-motion fade, on the clock: 120 ms from the present opacity to `to`. */
  private fade(to: 0 | 1, done?: () => void): void {
    this.endFade()
    const from = this.opacity_
    const startedAt = performance.now()
    const step = (now: number): void => {
      const t = clamp01((now - startedAt) / BAND_FADE_MS)
      this.paint(from + (to - from) * t)
      if (t < 1) {
        this.fadeFrame = requestFrame(step)
        return
      }
      this.fadeFrame = null
      done?.()
    }
    this.fadeFrame = requestFrame(step)
  }

  private endFade(): void {
    if (this.fadeFrame !== null) cancelFrame(this.fadeFrame)
    this.fadeFrame = null
  }
}
