import { SPRING_SNAPPY, SpringAnimation, reducedMotion } from './spring'

export type SlideAxis = 'x' | 'y'

/** What a detached item had (see `SlideMotion.attach`), and the way to let it go. */
interface Detached {
  el: HTMLElement | undefined
  spring: SpringAnimation | undefined
  entering: { spring: SpringAnimation; settle: () => void } | undefined
  offset: number | undefined
  layout: number | undefined
  drop: () => void
}

export interface SlideOptions {
  /** The list scrolls along its axis: positions are recorded in its content coordinates. */
  scroller?: HTMLElement | null
  /** Items new to the list grow into their slot (a clip opening on the spring). */
  enter?: boolean
  /**
   * More items than this new to the list in one commit is a batch (a session restore, a space
   * filling in) and is placed without motion. Unset: every change animates.
   */
  batch?: number
}

/**
 * Motion of the items of one list, all of it a translation along one axis on a spring per item.
 *
 * Two jobs share the one offset so they never fight: while an item is being dragged its
 * neighbours *slide* to open the gap where it would land, and after any commit (that drop, a
 * new item, a removal, a sort) items whose layout moved keep their on-screen place and spring
 * home – FLIP. A drop is the two meeting: the new layout is where the slid items already are,
 * so their springs have nothing left to do. With `enter`, an item that is new to the list grows
 * into its slot as the neighbours make room for it (a clip that opens on the same spring).
 */
export class SlideMotion {
  private readonly elements = new Map<string, HTMLElement>()
  private readonly springs = new Map<string, SpringAnimation>()
  /** Translation each item is drawn with right now. */
  private readonly offsets = new Map<string, number>()
  /** Layout start edge of each item at the last commit, in the scroller's content coordinates. */
  private readonly layout = new Map<string, number>()
  /** Items still growing into their slot: the spring, and the way to leave the item drawn whole. */
  private readonly entering = new Map<string, { spring: SpringAnimation; settle: () => void }>()
  /**
   * What an item that just detached had – its element, its motion, its slot – kept until the
   * next commit: React's StrictMode (a dev build) detaches a new item's ref and attaches the
   * same element again at once, and its entry must go on across that as if nothing happened;
   * an item whose element does not come back is let go at that commit's `flip`, or at once when
   * a different element takes its id (a row re-parented under a group's header).
   */
  private readonly detached = new Map<string, Detached>()
  /** Items new to the list whose arrival is another motion's: placed on the next commit, no entry. */
  private readonly placed = new Set<string>()
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private committed = false
  private scroller: HTMLElement | null
  private readonly enterNew: boolean
  private readonly batch: number

  constructor(
    /** The axis the items are laid along and slide on: `y` for a column of rows, `x` for the strip. */
    readonly axis: SlideAxis,
    options: SlideOptions = {}
  ) {
    this.scroller = options.scroller ?? null
    this.enterNew = options.enter ?? false
    this.batch = options.batch ?? Number.POSITIVE_INFINITY
  }

  setScroller(el: HTMLElement | null): void {
    this.scroller = el
  }

  attach(id: string, el: HTMLElement | null): void {
    if (el) {
      const held = this.detached.get(id)
      this.detached.delete(id)
      if (held && held.el === el) {
        // The same element, back at once (StrictMode): its motion and its slot go on.
        this.elements.set(id, el)
        if (held.spring) this.springs.set(id, held.spring)
        if (held.entering) this.entering.set(id, held.entering)
        if (held.offset !== undefined) this.offsets.set(id, held.offset)
        if (held.layout !== undefined) this.layout.set(id, held.layout)
        return
      }
      held?.drop()
      this.elements.set(id, el)
      return
    }
    const gone = this.elements.get(id)
    this.elements.delete(id)
    const spring = this.springs.get(id)
    const entering = this.entering.get(id)
    this.detached.get(id)?.drop()
    this.detached.set(id, {
      el: gone,
      spring,
      entering,
      offset: this.offsets.get(id),
      layout: this.layout.get(id),
      drop: () => {
        spring?.stop()
        // An item let go mid-entry is drawn whole, so no row that stays is left clipped.
        entering?.settle()
      }
    })
    this.springs.delete(id)
    this.entering.delete(id)
    this.offsets.delete(id)
    this.layout.delete(id)
  }

  /** Let go of the detached items whose elements did not come back. */
  private dropDetached(): void {
    for (const held of this.detached.values()) held.drop()
    this.detached.clear()
  }

  has(id: string): boolean {
    return this.elements.has(id)
  }

  /** Slide items to the given offsets; items not named glide back to their slots. */
  slide(targets: ReadonlyMap<string, number>): void {
    this.clearSettle()
    for (const id of this.elements.keys()) {
      const to = targets.get(id) ?? 0
      const spring = this.spring(id)
      const from = this.offsets.get(id) ?? 0
      if (spring.running) spring.retarget(to)
      else if (from !== to) spring.start(from, 0, to)
    }
  }

  /**
   * A drag ended without a commit that would put the slid items right again (a cancel from
   * another window, a tear-off that failed): they glide home unless a commit lands first.
   */
  releaseSoon(ms = 240): void {
    this.clearSettle()
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      this.slide(new Map())
    }, ms)
  }

  /**
   * Items about to be new to the list whose arrival another motion draws – a group's rows as
   * the group unfolds around them on its own height spring (`FolderRow`) – are placed on the
   * next commit rather than grown into their slot; a later arrival of theirs enters as usual.
   */
  placeNext(ids: Iterable<string>): void {
    for (const id of ids) this.placed.add(id)
  }

  /**
   * Called after every commit: items that were laid out elsewhere spring from there to here,
   * items new to the list grow into their slot. The item whose ghost is still travelling
   * (`still`) is placed, not animated. With `animate` false the positions are only recorded
   * (the list is off screen).
   */
  flip(still: string | null = null, animate = true): void {
    this.clearSettle()
    this.dropDetached()
    const scroll = this.scrollOffset()
    const measured = new Map<string, { start: number; size: number }>()
    let fresh = 0
    for (const [id, el] of this.elements) {
      const offset = this.offsets.get(id) ?? 0
      const r = el.getBoundingClientRect()
      const start = (this.axis === 'x' ? r.left : r.top) - offset + scroll
      const size = this.axis === 'x' ? r.width : r.height
      measured.set(id, { start, size })
      if (!this.layout.has(id)) fresh++
    }
    const motion = animate && !reducedMotion() && fresh <= this.batch
    for (const [id, el] of this.elements) {
      const { start, size } = measured.get(id) ?? { start: 0, size: 0 }
      const offset = this.offsets.get(id) ?? 0
      const was = this.layout.get(id)
      this.layout.set(id, start)
      const spring = this.spring(id)
      if (was === undefined) {
        spring.stop()
        this.draw(id, 0)
        if (
          motion &&
          this.enterNew &&
          this.committed &&
          id !== still &&
          !this.placed.has(id) &&
          size > 0
        )
          this.enter(id, el, size)
        continue
      }
      // Where the item was drawn a moment ago, against where it is laid out now.
      const delta = was + offset - start
      if (!motion || id === still || Math.abs(delta) < 0.5) {
        spring.stop()
        this.draw(id, 0)
        continue
      }
      const velocity = spring.running ? spring.stop().v : 0
      this.draw(id, delta)
      spring.start(delta, velocity, 0)
    }
    for (const id of [...this.layout.keys()]) if (!this.elements.has(id)) this.layout.delete(id)
    this.placed.clear()
    this.committed = true
  }

  /**
   * Re-record where the items are laid out right now, without motion: the baseline the next
   * `flip` measures against. For a motion that moves the layout under the items between commits
   * (a group's fold, `useGroupFold`: the rows below the block follow its extent on the spring,
   * no commit between the fold's and its rest) – called on each of its frames, so the commit
   * after it finds the rows where they are, rather than springing them from where the layout
   * stood at the last commit (the rows below a group jumping the group's height as it folds
   * again). Items the list has not placed yet are left to `flip`, which enters them.
   */
  record(): void {
    const scroll = this.scrollOffset()
    for (const [id, el] of this.elements) {
      if (!this.layout.has(id)) continue
      const offset = this.offsets.get(id) ?? 0
      const r = el.getBoundingClientRect()
      this.layout.set(id, (this.axis === 'x' ? r.left : r.top) - offset + scroll)
    }
  }

  /** Where the item rests once its motion is over (its in-flight translation removed). */
  restingRect(id: string): DOMRect | null {
    const el = this.elements.get(id)
    if (!el) return null
    const r = el.getBoundingClientRect()
    const offset = this.offsets.get(id) ?? 0
    return this.axis === 'x'
      ? new DOMRect(r.left - offset, r.top, r.width, r.height)
      : new DOMRect(r.left, r.top - offset, r.width, r.height)
  }

  /** Where the item is drawn right now. */
  visualRect(id: string): DOMRect | null {
    return this.elements.get(id)?.getBoundingClientRect() ?? null
  }

  /** The translation the item is drawn with right now. */
  offsetOf(id: string): number {
    return this.offsets.get(id) ?? 0
  }

  dispose(): void {
    this.clearSettle()
    this.dropDetached()
    for (const spring of this.springs.values()) spring.stop()
    this.springs.clear()
    for (const entry of this.entering.values()) entry.settle()
    this.entering.clear()
  }

  private scrollOffset(): number {
    const el = this.scroller
    if (!el) return 0
    return this.axis === 'x' ? el.scrollLeft : el.scrollTop
  }

  private clearSettle(): void {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer)
    this.settleTimer = null
  }

  /** A new item grows into its slot: a clip that opens from its start edge as the gap opens. */
  private enter(id: string, el: HTMLElement, size: number): void {
    this.entering.get(id)?.settle()
    const paint = (hidden: number): void => {
      const px = Math.max(0, Math.min(size, hidden))
      el.style.clipPath =
        px === 0 ? '' : this.axis === 'x' ? `inset(0 ${px}px 0 0)` : `inset(0 0 ${px}px 0)`
      el.style.opacity = px === 0 ? '' : String(1 - px / size)
    }
    const spring = new SpringAnimation(SPRING_SNAPPY, paint, () => {
      paint(0)
      this.entering.delete(id)
    })
    this.entering.set(id, {
      spring,
      settle: () => {
        spring.stop()
        paint(0)
      }
    })
    paint(size)
    spring.start(size, 0, 0)
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
    if (!el) return
    el.style.transform =
      x === 0 ? '' : this.axis === 'x' ? `translateX(${x}px)` : `translateY(${x}px)`
  }
}
