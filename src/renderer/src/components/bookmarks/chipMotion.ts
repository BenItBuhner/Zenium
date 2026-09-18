import { SPRING_SNAPPY, SpringAnimation, reducedMotion } from '@renderer/lib/motion/spring'

/**
 * Motion of the bookmarks bar's chips, all of it a horizontal translation on a spring per chip.
 *
 * Two jobs share the one offset so they never fight: while a chip is being dragged its
 * neighbours *slide* to open the gap where it would land, and after any commit (that drop, a
 * new bookmark, a removal, "Sort by name") chips whose layout moved keep their on-screen place
 * and spring home – FLIP. A drop is the two meeting: the new layout is where the slid chips
 * already are, so their springs have nothing left to do.
 */
export class ChipMotion {
  private readonly elements = new Map<string, HTMLElement>()
  private readonly springs = new Map<string, SpringAnimation>()
  /** Translation each chip is drawn with right now. */
  private readonly offsets = new Map<string, number>()
  /** Layout left edge of each chip at the last commit, in window coordinates. */
  private readonly layout = new Map<string, number>()

  attach(id: string, el: HTMLElement | null): void {
    if (el) {
      this.elements.set(id, el)
      return
    }
    this.elements.delete(id)
    this.springs.get(id)?.stop()
    this.springs.delete(id)
    this.offsets.delete(id)
    this.layout.delete(id)
  }

  /** Slide chips to the given offsets; chips not named glide back to their slots. */
  slide(targets: ReadonlyMap<string, number>): void {
    for (const id of this.elements.keys()) {
      const to = targets.get(id) ?? 0
      const spring = this.spring(id)
      const from = this.offsets.get(id) ?? 0
      if (spring.running) spring.retarget(to)
      else if (from !== to) spring.start(from, 0, to)
    }
  }

  /**
   * Called after every commit: chips that were laid out elsewhere spring from there to here.
   * The chip whose ghost is still travelling (`still`) is placed, not animated.
   */
  flip(still: string | null = null): void {
    for (const [id, el] of this.elements) {
      const offset = this.offsets.get(id) ?? 0
      const left = el.getBoundingClientRect().left - offset
      const was = this.layout.get(id)
      this.layout.set(id, left)
      if (was === undefined) continue
      // Where the chip was drawn a moment ago, against where it is laid out now.
      const delta = was + offset - left
      const spring = this.spring(id)
      if (id === still || Math.abs(delta) < 0.5 || reducedMotion()) {
        spring.stop()
        this.draw(id, 0)
        continue
      }
      const velocity = spring.running ? spring.stop().v : 0
      this.draw(id, delta)
      spring.start(delta, velocity, 0)
    }
  }

  /** Where the chip rests once its motion is over (its in-flight translation removed). */
  restingRect(id: string): DOMRect | null {
    const el = this.elements.get(id)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return new DOMRect(r.left - (this.offsets.get(id) ?? 0), r.top, r.width, r.height)
  }

  /** Where the chip is drawn right now. */
  visualRect(id: string): DOMRect | null {
    return this.elements.get(id)?.getBoundingClientRect() ?? null
  }

  dispose(): void {
    for (const spring of this.springs.values()) spring.stop()
    this.springs.clear()
  }

  private spring(id: string): SpringAnimation {
    let spring = this.springs.get(id)
    if (!spring) {
      spring = new SpringAnimation(
        SPRING_SNAPPY,
        (x) => this.draw(id, x),
        (x) => this.draw(id, x)
      )
      this.springs.set(id, spring)
    }
    return spring
  }

  private draw(id: string, x: number): void {
    this.offsets.set(id, x)
    const el = this.elements.get(id)
    if (el) el.style.transform = x === 0 ? '' : `translateX(${x}px)`
  }
}
