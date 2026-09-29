import { SPRING_SNAPPY, SpringAnimation } from './motion/spring'

/**
 * Where the caret lies. Between rows of a column (`axis` absent): its left edge and vertical
 * centre in the window, and its length. Between tabs of the strip along the caption band
 * (§9.37, `axis: 'x'`): the line turned – its horizontal centre and top edge, and its height.
 */
export type CaretPlacement =
  | { axis?: undefined; x: number; y: number; width: number }
  | { axis: 'x'; x: number; y: number; height: number }

/**
 * The insertion caret of a drag (design-language-v2-draft §9.4): a 2 px accent line, radius 1,
 * drawn by a `.zen-tab-caret` element a layer registers. It appears in the gap the pointer names
 * and glides to the next gap on the snappy spring – it never jumps – and hides when the pointer
 * leaves the lists. One instance per drag layer: the tab drag's and the chrome drop's. Along the
 * strip the same caret stands upright in the gap between two tabs and glides along it.
 */
export class InsertionCaret {
  private el: HTMLElement | null = null
  private shown = false
  /** The caret's position along the list's axis: the centre the spring drives. */
  private at = 0
  private axis: 'x' | 'y' = 'y'
  private readonly spring = new SpringAnimation(
    SPRING_SNAPPY,
    (v) => this.draw(v),
    (v) => this.draw(v)
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
    const axis: 'x' | 'y' = c.axis === 'x' ? 'x' : 'y'
    // The line's fixed extent: across the gap it stands in, along the rows it separates.
    if (c.axis === 'x') {
      el.style.left = '0px'
      el.style.top = `${c.y}px`
      el.style.width = '2px'
      el.style.height = `${c.height}px`
    } else {
      el.style.left = `${c.x}px`
      el.style.top = '0px'
      el.style.width = `${c.width}px`
      el.style.height = '2px'
    }
    const to = c.axis === 'x' ? c.x : c.y
    if (!this.shown || axis !== this.axis) {
      this.axis = axis
      this.shown = true
      this.spring.stop()
      this.draw(to)
      el.style.opacity = '1'
      return
    }
    if (Math.abs(to - this.at) < 0.5) return
    const state = this.spring.running ? this.spring.stop() : { x: this.at, v: 0 }
    this.spring.start(state.x, state.v, to)
  }

  hide(): void {
    this.spring.stop()
    this.shown = false
    if (this.el) this.el.style.opacity = '0'
  }

  private draw(at: number): void {
    this.at = at
    if (!this.el) return
    this.el.style.transform =
      this.axis === 'x' ? `translate3d(${at - 1}px, 0, 0)` : `translate3d(0, ${at - 1}px, 0)`
  }
}

/** Autoscroll band at a list's near edges, and the fastest scroll per frame (§9.4: 32 px). */
export const AUTOSCROLL_EDGE = 32
export const AUTOSCROLL_MAX_STEP = 14

/**
 * How far a list scrolls this frame for a pointer at `x`, `y` over its box: nothing away from
 * the top and bottom edges, up to `AUTOSCROLL_MAX_STEP` px the closer the pointer is to one
 * (negative upwards). The pointer must be within the box's width. A list laid along x
 * (`axis: 'x'`, the strip) reads its left and right edges the same way, the pointer within its
 * height.
 */
export function autoscrollStep(
  box: { left: number; right: number; top: number; bottom: number },
  x: number,
  y: number,
  axis: 'x' | 'y' = 'y'
): number {
  if (axis === 'x') {
    return autoscrollStep(
      { left: box.top, right: box.bottom, top: box.left, bottom: box.right },
      y,
      x
    )
  }
  if (x < box.left || x > box.right) return 0
  let step = 0
  if (y < box.top + AUTOSCROLL_EDGE) step = -((box.top + AUTOSCROLL_EDGE - y) / AUTOSCROLL_EDGE)
  else if (y > box.bottom - AUTOSCROLL_EDGE)
    step = (y - (box.bottom - AUTOSCROLL_EDGE)) / AUTOSCROLL_EDGE
  if (step === 0) return 0
  return Math.max(-1, Math.min(1, step)) * AUTOSCROLL_MAX_STEP
}

/**
 * The frame `AUTOSCROLL_MAX_STEP` is counted in – 60 Hz – and the most frames one tick may
 * stand for. A finger's drag (TABLET-03) scales each tick's step by its frame's real length
 * against this one, so the band scrolls at the same speed (840 px/s at the edge) on a 60, 90 or
 * 120 Hz tablet where the per-frame step alone would run 1.5 or 2 × as fast; a tick after a
 * stall (a hidden window, a long frame) counts for two frames at most, never a jump. The mouse's
 * tick keeps the per-frame step.
 */
export const AUTOSCROLL_FRAME_MS = 1000 / 60
export const AUTOSCROLL_MAX_FRAMES = 2

/** How many 60 Hz frames' worth of step an autoscroll tick `elapsedMs` after the last one adds. */
export function autoscrollFrames(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0
  return Math.min(AUTOSCROLL_MAX_FRAMES, elapsedMs / AUTOSCROLL_FRAME_MS)
}
