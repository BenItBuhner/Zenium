import { SPRING_SNAPPY, SpringAnimation } from './motion/spring'

/** Where the caret lies: its left edge and vertical centre in the window, and its length. */
export interface CaretPlacement {
  x: number
  y: number
  width: number
}

/**
 * The insertion caret of a drag (design-language-v2-draft §9.4): a 2 px accent line, radius 1,
 * drawn by a `.zen-tab-caret` element a layer registers. It appears in the gap the pointer names
 * and glides to the next gap on the snappy spring – it never jumps – and hides when the pointer
 * leaves the lists. One instance per drag layer: the tab drag's and the chrome drop's.
 */
export class InsertionCaret {
  private el: HTMLElement | null = null
  private shown = false
  private y = 0
  private readonly spring = new SpringAnimation(
    SPRING_SNAPPY,
    (y) => this.draw(y),
    (y) => this.draw(y)
  )

  /** The layer mounted (or unmounted) the caret element; a new element starts hidden. */
  register(el: HTMLElement | null): void {
    this.el = el
    this.shown = false
    if (el) el.style.opacity = '0'
  }

  show(c: CaretPlacement): void {
    const el = this.el
    if (!el) return
    el.style.left = `${c.x}px`
    el.style.width = `${c.width}px`
    if (!this.shown) {
      this.shown = true
      this.spring.stop()
      this.draw(c.y)
      el.style.opacity = '1'
      return
    }
    if (Math.abs(c.y - this.y) < 0.5) return
    const state = this.spring.running ? this.spring.stop() : { x: this.y, v: 0 }
    this.spring.start(state.x, state.v, c.y)
  }

  hide(): void {
    this.spring.stop()
    this.shown = false
    if (this.el) this.el.style.opacity = '0'
  }

  private draw(y: number): void {
    this.y = y
    if (this.el) this.el.style.transform = `translate3d(0, ${y - 1}px, 0)`
  }
}

/** Autoscroll band at a list's near edges, and the fastest scroll per frame (§9.4: 32 px). */
export const AUTOSCROLL_EDGE = 32
export const AUTOSCROLL_MAX_STEP = 14

/**
 * How far a list scrolls this frame for a pointer at `x`, `y` over its box: nothing away from
 * the top and bottom edges, up to `AUTOSCROLL_MAX_STEP` px the closer the pointer is to one
 * (negative upwards). The pointer must be within the box's width.
 */
export function autoscrollStep(
  box: { left: number; right: number; top: number; bottom: number },
  x: number,
  y: number
): number {
  if (x < box.left || x > box.right) return 0
  let step = 0
  if (y < box.top + AUTOSCROLL_EDGE) step = -((box.top + AUTOSCROLL_EDGE - y) / AUTOSCROLL_EDGE)
  else if (y > box.bottom - AUTOSCROLL_EDGE)
    step = (y - (box.bottom - AUTOSCROLL_EDGE)) / AUTOSCROLL_EDGE
  if (step === 0) return 0
  return Math.max(-1, Math.min(1, step)) * AUTOSCROLL_MAX_STEP
}
