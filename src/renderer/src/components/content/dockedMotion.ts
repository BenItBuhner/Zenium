import { SPRING_SNAPPY, SpringAnimation, reducedMotion } from '@renderer/lib/motion/spring'

/** v2 §11.3: with motion reduced, a docked panel's appearance and departure are a fade this long. */
const REDUCED_FADE_MS = 120

/**
 * A docked panel's own entrance and exit (v2 §9.32's slot under the live page: the zoom sheet,
 * the read-aloud player): `translateY` on `SPRING_SNAPPY` from and to its height (v1 §7,
 * `transform` only), or – with motion reduced – an opacity fade written per frame, since the
 * reduced-motion stylesheet cuts every CSS transition to nothing (§11.3). `data-moving` is on
 * the element only while something moves (§9.33's `will-change` rule).
 */
export class DockedPanelMotion {
  private readonly spring: SpringAnimation
  private frame: number | null = null
  private onRest: (() => void) | null = null

  constructor(private readonly el: HTMLElement) {
    this.spring = new SpringAnimation(
      SPRING_SNAPPY,
      (y) => {
        el.style.transform = `translateY(${y}px)`
      },
      (y) => {
        el.style.transform = y === 0 ? '' : `translateY(${y}px)`
        delete el.dataset.moving
        const done = this.onRest
        this.onRest = null
        done?.()
      }
    )
  }

  enter(): void {
    if (reducedMotion()) {
      this.fade(0, 1, null)
      return
    }
    this.el.dataset.moving = ''
    this.spring.start(this.el.offsetHeight, 0, 0)
  }

  /** Slide (or fade) out, then `done` – which unmounts the panel. A second call is ignored. */
  leave(done: () => void): void {
    if (this.onRest) return
    this.onRest = done
    if (reducedMotion()) {
      this.fade(Number.parseFloat(this.el.style.opacity) || 1, 0, done)
      return
    }
    // From wherever the entrance has got to, carrying its velocity: every motion is interruptible.
    const { x, v } = this.spring.current
    this.el.dataset.moving = ''
    this.spring.start(x, v, this.el.offsetHeight)
  }

  dispose(): void {
    this.spring.stop()
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.onRest = null
  }

  private fade(from: number, to: number, done: (() => void) | null): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    const el = this.el
    const startedAt = performance.now()
    el.dataset.moving = ''
    el.style.opacity = from.toFixed(3)
    const step = (now: number): void => {
      const t = Math.min(1, (now - startedAt) / REDUCED_FADE_MS)
      el.style.opacity = (from + (to - from) * t).toFixed(3)
      if (t < 1) {
        this.frame = requestAnimationFrame(step)
        return
      }
      this.frame = null
      if (to === 1) el.style.opacity = ''
      delete el.dataset.moving
      this.onRest = null
      done?.()
    }
    this.frame = requestAnimationFrame(step)
  }
}
