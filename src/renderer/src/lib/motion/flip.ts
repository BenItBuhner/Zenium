import { SPRING_SNAPPY, SpringAnimation } from './spring'

/**
 * Layout animations in flight (a group card changing height), by owner. While any is running
 * the elements below it move by layout every frame, which is not a re-layout the FLIP tracker
 * should chase – and once it ends, the positions the tracker last recorded are stale, so it is
 * told to take them again.
 */
const settledListeners = new Set<() => void>()

export const layoutAnimations = {
  active: new Set<string>(),
  any(): boolean {
    return layoutAnimations.active.size > 0
  },
  start(owner: string): void {
    layoutAnimations.active.add(owner)
  },
  /** The owner's animation is over: trackers re-measure once nothing else is moving. */
  end(owner: string): void {
    layoutAnimations.active.delete(owner)
    if (layoutAnimations.active.size === 0) for (const listener of settledListeners) listener()
  },
  onSettled(listener: () => void): () => void {
    settledListeners.add(listener)
    return () => settledListeners.delete(listener)
  }
}

interface Tracked {
  /** Layout position in the scroll content's coordinates (no transform, no scrolling). */
  x: number
  y: number
  width: number
  height: number
  /** Offset the element is drawn at, relative to its layout position, when progress = 1. */
  dx: number
  dy: number
}

/**
 * Elements glide to their new slots instead of jumping when a grid re-lays itself out (a group
 * is made, a card joins one, a tab is closed). Classic FLIP: after every commit each tracked
 * element is measured, the difference to where it was drawn becomes a translation, and one
 * shared spring takes all of them back to zero – a re-layout mid-flight simply starts again from
 * where the elements are, so nothing ever snaps.
 */
export class FlipTracker {
  private tracked = new Map<string, Tracked>()
  private elements = new Map<string, HTMLElement>()
  private scroller: HTMLElement | null = null
  private progress = 0
  /**
   * The spring runs over the longest displacement in px, and the shared progress is its position
   * divided by that – so it comes to rest by the px thresholds of its config, not before.
   */
  private travel = 1
  private readonly spring = new SpringAnimation(
    SPRING_SNAPPY,
    (x) => {
      this.progress = x / this.travel
      this.draw()
    },
    () => {
      this.progress = 0
      for (const item of this.tracked.values()) {
        item.dx = 0
        item.dy = 0
      }
      this.draw()
    }
  )

  /**
   * Called after every commit with the elements currently on screen. With `animate` false the
   * positions are only recorded (the grid is being scaled in, or moving by layout already).
   */
  commit(elements: Map<string, HTMLElement>, scroller: HTMLElement | null, animate: boolean): void {
    this.elements = new Map(elements)
    this.scroller = scroller
    const t = this.progress
    const next = new Map<string, Tracked>()
    let travel = 0
    for (const [id, el] of elements) {
      const prev = this.tracked.get(id)
      el.style.transform = ''
      const r = el.getBoundingClientRect()
      const x = r.left + (scroller?.scrollLeft ?? 0)
      const y = r.top + (scroller?.scrollTop ?? 0)
      let dx = 0
      let dy = 0
      if (prev && animate) {
        // Where the element was drawn a moment ago, against where it is laid out now.
        dx = prev.x + prev.dx * t - x
        dy = prev.y + prev.dy * t - y
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
          dx = 0
          dy = 0
        } else travel = Math.max(travel, Math.abs(dx), Math.abs(dy))
      }
      next.set(id, { x, y, width: r.width, height: r.height, dx, dy })
    }
    this.tracked = next
    if (travel > 0) {
      this.travel = travel
      this.progress = 1
      this.draw()
      this.spring.start(travel, 0, 0)
    }
  }

  /**
   * Take the current positions as the baseline without animating anything (the elements moved by
   * a layout animation that already showed the motion).
   */
  rebaseline(): void {
    this.commit(this.elements, this.scroller, false)
  }

  /**
   * Where `id` will come to rest, in window coordinates: its slot as of the last commit, at the
   * scroller's current offset, with any glide in flight left out. Read from what the last commit
   * measured, so a drag can ask every frame without forcing a layout.
   */
  layoutRect(id: string): DOMRect | null {
    const item = this.tracked.get(id)
    if (!item) return null
    return new DOMRect(
      item.x - (this.scroller?.scrollLeft ?? 0),
      item.y - (this.scroller?.scrollTop ?? 0),
      item.width,
      item.height
    )
  }

  stop(): void {
    this.spring.stop()
    this.progress = 0
    for (const el of this.elements.values()) el.style.transform = ''
  }

  private draw(): void {
    const t = this.progress
    for (const [id, item] of this.tracked) {
      const el = this.elements.get(id)
      if (!el) continue
      el.style.transform =
        (item.dx || item.dy) && t ? `translate(${item.dx * t}px, ${item.dy * t}px)` : ''
    }
  }
}
