import { SPRING_SNAPPY, SpringAnimation, reducedMotion } from './spring'

export type SlideAxis = 'x' | 'y'

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
  /** Items still growing into their slot. */
  private readonly entering = new Map<string, SpringAnimation>()
  /** Items new to the list whose arrival is another motion's: placed on the next commit, no entry. */
  private readonly placed = new Set<string>()
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private committed = false
  private scroller: HTMLElement | null
  private readonly enterNew: boolean
  private readonly batch: number

  constructor(
    private readonly axis: SlideAxis,
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
      this.elements.set(id, el)
      return
    }
    this.elements.delete(id)
    this.springs.get(id)?.stop()
    this.springs.delete(id)
    this.entering.get(id)?.stop()
    this.entering.delete(id)
    this.offsets.delete(id)
    this.layout.delete(id)
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
    for (const spring of this.springs.values()) spring.stop()
    this.springs.clear()
    for (const spring of this.entering.values()) spring.stop()
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
    this.entering.get(id)?.stop()
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
    this.entering.set(id, spring)
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
