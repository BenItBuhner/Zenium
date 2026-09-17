import { settleTarget } from '@renderer/lib/gestures/swipe'
import { SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'

/** Tilt of a card swiped a full width to one side, in degrees. */
const TILT_DEG = 6
/** Widths a card travels before it has faded out completely. */
const FADE_WIDTHS = 1.6
/** How far past the grid's edge a committed card flies before it counts as gone. */
const EXIT_MARGIN = 24

/**
 * A card being swiped sideways off the grid, Chrome-style: it follows the finger, tilting and
 * fading with the distance; let go, it either flies off and the tab closes, or springs back into
 * its slot. Both are one spring on the card's offset, so a finger can catch a card that is
 * springing back and carry on from where it is; a card that has committed is on its way out and
 * cannot be caught. The card draws itself – only `transform` and `opacity`, per frame.
 */
export class CardSwipe {
  private el: HTMLElement | null = null
  private width = 1
  private x = 0
  private closed = false
  /** The card is flying off; when the spring rests the tab closes. */
  committed = false
  private readonly spring = new SpringAnimation(
    SPRING_SNAPPY,
    (x) => this.draw(x),
    () => this.rested()
  )

  constructor(private readonly onClose: () => void) {}

  get running(): boolean {
    return this.spring.running
  }

  /** The finger has started dragging the card sideways (or caught it springing back). */
  begin(el: HTMLElement): void {
    this.spring.stop()
    this.el = el
    this.width = Math.max(1, el.offsetWidth)
    el.dataset.swiping = ''
    // Above its neighbours while it moves across them.
    if (el.parentElement) el.parentElement.style.zIndex = '1'
    this.draw(this.x)
  }

  /** Where a caught card is, so the finger continues from there rather than from zero. */
  catchUp(): number {
    this.spring.stop()
    return this.x
  }

  move(x: number): void {
    this.draw(x)
  }

  /**
   * The finger lifted, moving at `velocity` px/s. Chrome's rule, shared with the pill: a fling
   * commits in its own direction, a slow release commits past half a width, anything else returns.
   */
  release(velocity: number): void {
    const page = settleTarget({
      position: this.x / this.width,
      origin: 0,
      velocity,
      extent: this.width,
      min: -1,
      max: 1
    })
    if (page === 0) {
      this.spring.start(this.x, velocity, 0)
      return
    }
    this.committed = true
    this.spring.start(this.x, velocity, this.exitOffset(page))
  }

  /** The card is going away (unmounted): a committed close still happens. */
  dispose(): void {
    this.spring.stop()
    if (this.committed && !this.closed) {
      this.closed = true
      this.onClose()
    }
    this.el = null
  }

  /** Offset at which the card has left the grid's clip on side `direction`. */
  private exitOffset(direction: number): number {
    const el = this.el
    if (!el) return direction * this.width * 2
    const clip = el.closest<HTMLElement>('.zen-overview-grid')?.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    // The card is drawn translated by x; its slot is that much back.
    const left = r.left - this.x
    const right = r.right - this.x
    if (direction > 0) return (clip ? clip.right : window.innerWidth) - left + EXIT_MARGIN
    return -(right - (clip ? clip.left : 0)) - EXIT_MARGIN
  }

  private draw(x: number): void {
    this.x = x
    const el = this.el
    if (!el) return
    const f = x / this.width
    el.style.transform = `translateX(${x}px) rotate(${f * TILT_DEG}deg)`
    el.style.opacity = String(Math.max(0, 1 - Math.abs(f) / FADE_WIDTHS))
  }

  private rested(): void {
    if (this.committed) {
      if (!this.closed) {
        this.closed = true
        this.onClose()
      }
      return
    }
    const el = this.el
    if (!el) return
    el.style.transform = ''
    el.style.opacity = ''
    delete el.dataset.swiping
    if (el.parentElement) el.parentElement.style.zIndex = ''
  }
}
