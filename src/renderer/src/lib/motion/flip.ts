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
  /** Offset the element is drawn at, relative to its layout position, when progress = 1. */
  dx: number
  dy: number
}

interface ScrollOffset {
  scrollLeft: number
  scrollTop: number
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
  private lastScroll: ScrollOffset | null = null
  private progress = 0
  private readonly spring = new SpringAnimation(
    SPRING_SNAPPY,
    (t) => {
      this.progress = t
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
  commit(elements: Map<string, HTMLElement>, scroll: ScrollOffset | null, animate: boolean): void {
    this.elements = new Map(elements)
    this.lastScroll = scroll
    const t = this.progress
    const next = new Map<string, Tracked>()
    let moved = false
    for (const [id, el] of elements) {
      const prev = this.tracked.get(id)
      el.style.transform = ''
      const r = el.getBoundingClientRect()
      const x = r.left + (scroll?.scrollLeft ?? 0)
      const y = r.top + (scroll?.scrollTop ?? 0)
      let dx = 0
      let dy = 0
      if (prev && animate) {
        // Where the element was drawn a moment ago, against where it is laid out now.
        dx = prev.x + prev.dx * t - x
        dy = prev.y + prev.dy * t - y
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
          dx = 0
          dy = 0
        } else moved = true
      }
      next.set(id, { x, y, dx, dy })
    }
    this.tracked = next
    if (moved) {
      this.progress = 1
      this.draw()
      this.spring.start(1, 0, 0)
    }
  }

  /**
   * Take the current positions as the baseline without animating anything (the elements moved by
   * a layout animation that already showed the motion).
   */
  rebaseline(): void {
    this.commit(this.elements, this.lastScroll, false)
  }

  /** Where `id` will come to rest, in window coordinates (its in-flight translation removed). */
  layoutRect(id: string): DOMRect | null {
    const el = this.elements.get(id)
    if (!el) return null
    const r = el.getBoundingClientRect()
    const item = this.tracked.get(id)
    if (!item) return r
    const t = this.progress
    return new DOMRect(r.left - item.dx * t, r.top - item.dy * t, r.width, r.height)
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
