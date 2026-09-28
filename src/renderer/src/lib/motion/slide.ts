import { fadeOpacity } from './fade'
import { SPRING_SNAPPY, SpringAnimation, reducedMotion } from './spring'

export type SlideAxis = 'x' | 'y'

/** An item's entry in flight, and the way to leave the item drawn whole. */
interface Entry {
  settle: () => void
}

/** An item's departure in flight (its element drawn out of the list), and the way to end it now. */
interface Departure {
  el: HTMLElement
  end: () => void
}

/** An item's box across the axis at the last commit, for the departure that draws it in place. */
interface Box {
  /** Its extent along the axis. */
  size: number
  /** Its start across the axis, against the scroller's box. */
  cross: number
  /** Its extent across the axis. */
  crossSize: number
}

/** What a departure is drawn against: the list's boxes as measured in the commit it leaves in. */
interface Frame {
  host: HTMLElement
  hostBox: DOMRect
  scrollerBox: DOMRect
  scroll: number
}

/** What a detached item had (see `SlideMotion.attach`), and the way to let it go. */
interface Detached {
  el: HTMLElement | undefined
  spring: SpringAnimation | undefined
  entering: Entry | undefined
  offset: number | undefined
  layout: number | undefined
  box: Box | undefined
  /** The element was the drag's lifted row (drawn by its ghost): no departure of its own. */
  lifted: boolean
  drop: () => void
}

export interface SlideOptions {
  /** The list scrolls along its axis: positions are recorded in its content coordinates. */
  scroller?: HTMLElement | null
  /** Items new to the list grow into their slot (a clip opening on the spring). */
  enter?: boolean
  /**
   * Items that leave the list shrink out of their slot – the entry run backwards, the element
   * kept drawn where it stood, in the scroller's parent, while the neighbours glide into the gap
   * on the same frame (v2 §11.4). The parent must be positioned: the departing element is placed
   * in its box, so a scroller that shrinks with its last row does not clip the row away. The
   * scroller's own extent runs from what it was to what it is on the same spring (its minimum
   * along the axis, whole pixels), so what stands after it along the axis – the panel's foot,
   * the New Tab row – follows the gap closing rather than jumping at the commit, and the rows
   * gliding up from below its new edge are not cut by it.
   */
  leave?: boolean
  /**
   * More items than this new to the list in one commit is a batch (a session restore, a space
   * filling in) and is placed without motion; as many leaving in one commit (a space cleared)
   * go without one. Unset: every change animates.
   */
  batch?: number
}

/** The class a departing element wears while it is drawn out of the list (`main.css`). */
export const LEAVING_CLASS = 'zen-slide-leaving'

/**
 * The attributes a departing element gives up: it is a picture of the row, no longer the row –
 * nothing finds it by its id or its test id, no reader or key reaches it, no drag's list counts
 * it among its children.
 */
const IDENTITY_ATTRIBUTES = [
  'data-tab-id',
  'data-strip-item',
  'data-strip-parent',
  'data-testid',
  'role',
  'tabindex',
  'id',
  'aria-describedby'
]

/**
 * Motion of the items of one list, all of it a translation along one axis on a spring per item.
 *
 * Two jobs share the one offset so they never fight: while an item is being dragged its
 * neighbours *slide* to open the gap where it would land, and after any commit (that drop, a
 * new item, a removal, a sort) items whose layout moved keep their on-screen place and spring
 * home – FLIP. A drop is the two meeting: the new layout is where the slid items already are,
 * so their springs have nothing left to do. With `enter`, an item that is new to the list grows
 * into its slot as the neighbours make room for it (a clip that opens on the same spring); with
 * `leave`, an item gone from the list shrinks out of it the same way, its element kept drawn
 * where it stood while the neighbours close the gap – the two ends of one motion. Under reduced
 * motion either is a 120 ms opacity fade in place (v2 §11.3), and nothing travels.
 */
export class SlideMotion {
  private readonly elements = new Map<string, HTMLElement>()
  private readonly springs = new Map<string, SpringAnimation>()
  /** Translation each item is drawn with right now. */
  private readonly offsets = new Map<string, number>()
  /** Layout start edge of each item at the last commit, in the scroller's content coordinates. */
  private readonly layout = new Map<string, number>()
  /** Each item's box across the axis at the last commit (what a departure draws it with). */
  private readonly boxes = new Map<string, Box>()
  /** Items still growing into their slot, and the way to leave each drawn whole. */
  private readonly entering = new Map<string, Entry>()
  /** Items shrinking out of the list, and the way to end each now. */
  private readonly leaving = new Map<string, Departure>()
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
  /** Items leaving the list whose departure is another motion's: let go at the next commit, no shrink. */
  private readonly dropping = new Set<string>()
  /** The scroller's extent along the axis at the last commit (with `leave`). */
  private extent: number | undefined
  /** The run of the scroller's extent from the last commit's to this one's, while items leave. */
  private hold: SpringAnimation | null = null
  /** The extent the hold last wrote (where a run on its heels picks up from). */
  private heldExtent: number | undefined
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private committed = false
  private scroller: HTMLElement | null
  private readonly enterNew: boolean
  private readonly leaveGone: boolean
  private readonly batch: number

  constructor(
    /** The axis the items are laid along and slide on: `y` for a column of rows, `x` for the strip. */
    readonly axis: SlideAxis,
    options: SlideOptions = {}
  ) {
    this.scroller = options.scroller ?? null
    this.enterNew = options.enter ?? false
    this.leaveGone = options.leave ?? false
    this.batch = options.batch ?? Number.POSITIVE_INFINITY
  }

  setScroller(el: HTMLElement | null): void {
    if (el !== this.scroller) {
      this.releaseHold()
      this.extent = undefined
    }
    this.scroller = el
  }

  attach(id: string, el: HTMLElement | null): void {
    if (el) {
      // The item is back (a closed tab undone) while its picture still shrinks: the picture goes
      // at once, and the item enters as any new one.
      this.leaving.get(id)?.end()
      const held = this.detached.get(id)
      this.detached.delete(id)
      if (held && held.el === el) {
        // The same element, back at once (StrictMode): its motion and its slot go on.
        this.elements.set(id, el)
        if (held.spring) this.springs.set(id, held.spring)
        if (held.entering) this.entering.set(id, held.entering)
        if (held.offset !== undefined) this.offsets.set(id, held.offset)
        if (held.layout !== undefined) this.layout.set(id, held.layout)
        if (held.box) this.boxes.set(id, held.box)
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
      box: this.boxes.get(id),
      lifted: gone?.hasAttribute?.('data-lifted') ?? false,
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
    this.boxes.delete(id)
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
   * Items about to leave the list whose departure another motion draws – a group's rows as the
   * group folds shut over them on its own height spring (`useGroupFold`: kept drawn under the
   * clip until it rests, gone in the commit after) – are let go at the next commit rather than
   * shrunk out of their slot; a later departure of theirs leaves as usual.
   */
  dropNext(ids: Iterable<string>): void {
    for (const id of ids) this.dropping.add(id)
  }

  /**
   * Called after every commit: items that were laid out elsewhere spring from there to here,
   * items new to the list grow into their slot, items gone from it shrink out of theirs. The
   * item whose ghost is still travelling (`still`) is placed, not animated. With `animate` false
   * the positions are only recorded (the list is off screen).
   */
  flip(still: string | null = null, animate = true): void {
    this.clearSettle()
    // A hold still running (a close on the heels of a close) lets the scroller go before it is
    // measured: this commit's run picks up from the extent it had reached.
    const heldNow = this.releaseHold()
    // The items gone for good since the last commit (their element never came back), before
    // they are let go: each is drawn out of the list from where it stood.
    const gone = [...this.detached].filter(
      ([id, held]) =>
        held.el !== undefined &&
        held.box !== undefined &&
        held.layout !== undefined &&
        !held.lifted &&
        id !== still &&
        !this.dropping.has(id)
    )
    this.dropDetached()
    const reduced = reducedMotion()
    const leaving =
      this.leaveGone && animate && this.committed && gone.length > 0 && gone.length <= this.batch
    // Every read before any write: the layout is flushed once for the commit.
    const scroll = this.scrollOffset()
    const scroller = this.scroller
    const host = scroller?.parentElement ?? null
    // The boxes across the axis are read against the scroller's, for a departure to draw them in
    // place; a list without departures needs no measure of it.
    const scrollerBox = this.leaveGone ? scroller?.getBoundingClientRect() : undefined
    const hostBox = leaving ? host?.getBoundingClientRect() : undefined
    const crossOrigin = scrollerBox ? (this.axis === 'x' ? scrollerBox.top : scrollerBox.left) : 0
    const measured = new Map<string, { start: number; box: Box }>()
    let fresh = 0
    for (const [id, el] of this.elements) {
      const offset = this.offsets.get(id) ?? 0
      const r = el.getBoundingClientRect()
      const start = (this.axis === 'x' ? r.left : r.top) - offset + scroll
      const box: Box =
        this.axis === 'x'
          ? { size: r.width, cross: r.top - crossOrigin, crossSize: r.height }
          : { size: r.height, cross: r.left - crossOrigin, crossSize: r.width }
      measured.set(id, { start, box })
      if (!this.layout.has(id)) fresh++
    }
    const motion = animate && !reduced && fresh <= this.batch
    // Under reduced motion a new item fades in where it stands (v2 §11.3): no travel, no growth.
    const fadeNew = animate && reduced && fresh <= this.batch
    let departed = 0
    if (leaving && host && hostBox && scrollerBox) {
      const frame: Frame = { host, hostBox, scrollerBox, scroll }
      for (const [id, held] of gone) if (this.leave(id, held, reduced, frame)) departed++
    }
    if (scrollerBox) {
      const size = this.axis === 'x' ? scrollerBox.width : scrollerBox.height
      // The scroller shrank with the departing items: its extent runs from where it stood – or
      // where a hold had brought it – to here on their spring, and what follows it in the layout
      // follows the gap. Under reduced motion the cut, as the neighbours' (§11.3).
      const from = heldNow ?? this.extent
      if (departed > 0 && !reduced && from !== undefined && from > size + 0.5)
        this.holdExtent(from - size, size)
      this.extent = size
    }
    for (const [id, el] of this.elements) {
      const { start, box } = measured.get(id) ?? {
        start: 0,
        box: { size: 0, cross: 0, crossSize: 0 }
      }
      const offset = this.offsets.get(id) ?? 0
      const was = this.layout.get(id)
      this.layout.set(id, start)
      this.boxes.set(id, box)
      const spring = this.spring(id)
      if (was === undefined) {
        spring.stop()
        this.draw(id, 0)
        const arrives =
          this.enterNew && this.committed && id !== still && !this.placed.has(id) && box.size > 0
        if (arrives && motion) this.enter(id, el, box.size)
        else if (arrives && fadeNew) this.fadeIn(id, el)
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
    for (const id of [...this.boxes.keys()]) if (!this.elements.has(id)) this.boxes.delete(id)
    this.placed.clear()
    this.dropping.clear()
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

  /** Whether an item's departure is still being drawn. */
  isLeaving(id: string): boolean {
    return this.leaving.has(id)
  }

  dispose(): void {
    this.clearSettle()
    this.dropDetached()
    for (const spring of this.springs.values()) spring.stop()
    this.springs.clear()
    for (const entry of this.entering.values()) entry.settle()
    this.entering.clear()
    for (const departure of [...this.leaving.values()]) departure.end()
    this.leaving.clear()
    this.releaseHold()
  }

  private scrollOffset(): number {
    const el = this.scroller
    if (!el) return 0
    return this.axis === 'x' ? el.scrollLeft : el.scrollTop
  }

  /** The scroller's minimum along the axis: what the hold writes. */
  private get minimum(): 'minWidth' | 'minHeight' {
    return this.axis === 'x' ? 'minWidth' : 'minHeight'
  }

  /**
   * Run the scroller's extent from `base + extra` to `base` on the departures' spring, written as
   * its minimum along the axis in whole pixels – a floor under its layout, never a cap: a list
   * that still overflows keeps the extent its column allows and the floor does nothing, and the
   * rows gliding into the gap by the same value are never past the edge. At rest the floor is
   * gone and the layout stands where it would.
   */
  private holdExtent(extra: number, base: number): void {
    const el = this.scroller
    if (!el) return
    const write = (x: number): void => {
      const px = Math.ceil(Math.max(0, x))
      this.heldExtent = base + px
      el.style[this.minimum] = px === 0 ? '' : `${base + px}px`
    }
    const spring = new SpringAnimation(SPRING_SNAPPY, write, () => {
      el.style[this.minimum] = ''
      this.heldExtent = undefined
      this.hold = null
    })
    this.hold = spring
    write(extra)
    spring.start(extra, 0, 0)
  }

  /** End a hold in flight, the scroller let go; the extent it had reached, for a run after it. */
  private releaseHold(): number | undefined {
    const spring = this.hold
    if (!spring) return undefined
    spring.stop()
    this.hold = null
    const el = this.scroller
    if (el) el.style[this.minimum] = ''
    const held = this.heldExtent
    this.heldExtent = undefined
    return held
  }

  private clearSettle(): void {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer)
    this.settleTimer = null
  }

  /**
   * The frame of an item's growth or shrink: `hidden` px of its extent clipped off its end edge,
   * its opacity the part that shows. Written every frame by the spring, so the item's own
   * transitions (the row's 120 ms opacity ease) are held off while it runs – one value on one
   * spring (v2 §11.1), nothing trailing it – and `will-change` names the two properties for the
   * run alone. At `hidden` 0 every inline mark comes off and the item is drawn as it is.
   */
  private clip(el: HTMLElement, size: number): (hidden: number) => void {
    return (hidden) => {
      const px = Math.max(0, Math.min(size, hidden))
      if (px === 0) {
        el.style.clipPath = ''
        el.style.opacity = ''
        el.style.transition = ''
        el.style.willChange = ''
        return
      }
      el.style.transition = 'none'
      el.style.willChange = 'clip-path, opacity'
      el.style.clipPath = this.axis === 'x' ? `inset(0 ${px}px 0 0)` : `inset(0 0 ${px}px 0)`
      el.style.opacity = String(1 - px / size)
    }
  }

  /** A new item grows into its slot: a clip that opens from its start edge as the gap opens. */
  private enter(id: string, el: HTMLElement, size: number): void {
    this.entering.get(id)?.settle()
    const paint = this.clip(el, size)
    const spring = new SpringAnimation(SPRING_SNAPPY, paint, () => {
      paint(0)
      this.entering.delete(id)
    })
    this.entering.set(id, {
      settle: () => {
        spring.stop()
        paint(0)
      }
    })
    paint(size)
    spring.start(size, 0, 0)
  }

  /** A new item under reduced motion: the 120 ms fade in where it stands (v2 §11.3). */
  private fadeIn(id: string, el: HTMLElement): void {
    this.entering.get(id)?.settle()
    const whole = (): void => {
      el.style.opacity = ''
      this.entering.delete(id)
    }
    el.style.opacity = '0'
    const cancel = fadeOpacity(el, 1, whole)
    this.entering.set(id, {
      settle: () => {
        cancel()
        whole()
      }
    })
  }

  /**
   * An item gone from the list shrinks out of its slot: its element – React's no longer – is put
   * back in the scroller's parent, in the box it stood in (the layout the last commit recorded,
   * plus the translation it was drawn with), stripped of what made it the row, and clipped shut
   * from its end edge on the spring as the neighbours glide into the gap – the entry backwards,
   * the two on one spring so the picture's end edge and the next row's start edge move as one.
   * Under reduced motion the picture fades where it stands. At rest the element is removed.
   * Whether the departure was drawn.
   */
  private leave(id: string, held: Detached, reduced: boolean, frame: Frame): boolean {
    const { host, hostBox, scrollerBox, scroll } = frame
    const el = held.el
    const box = held.box
    if (!el || !box || held.layout === undefined || box.size <= 0) return false
    this.leaving.get(id)?.end()
    // Where the item was drawn, in the window: its layout at the last commit (recorded in the
    // window's coordinates plus the scroll) and the translation it wore, less the scroll now.
    const drawn = held.layout + (held.offset ?? 0) - scroll
    const along = drawn - (this.axis === 'x' ? hostBox.left : hostBox.top)
    const cross =
      box.cross +
      (this.axis === 'x' ? scrollerBox.top - hostBox.top : scrollerBox.left - hostBox.left)
    for (const name of IDENTITY_ATTRIBUTES) el.removeAttribute(name)
    el.setAttribute('aria-hidden', 'true')
    el.setAttribute('inert', '')
    el.classList.add(LEAVING_CLASS)
    // Its geometry inline, where no utility of the row's (an indent's margin) outranks it.
    el.style.position = 'absolute'
    el.style.margin = '0'
    el.style.transform = ''
    if (this.axis === 'x') {
      el.style.left = `${along}px`
      el.style.top = `${cross}px`
      el.style.width = `${box.size}px`
      el.style.height = `${box.crossSize}px`
    } else {
      el.style.top = `${along}px`
      el.style.left = `${cross}px`
      el.style.height = `${box.size}px`
      el.style.width = `${box.crossSize}px`
    }
    host.appendChild(el)
    let stop = (): void => {}
    const end = (): void => {
      stop()
      el.remove()
      this.leaving.delete(id)
    }
    this.leaving.set(id, { el, end })
    if (reduced) {
      stop = fadeOpacity(el, 0, end)
    } else {
      const paint = this.clip(el, box.size)
      // The spring runs the part that still shows from the whole to nothing, the neighbours'
      // glide running the same way on the same frame.
      const spring = new SpringAnimation(SPRING_SNAPPY, (shown) => paint(box.size - shown), end)
      stop = () => spring.stop()
      spring.start(box.size, 0, 0)
    }
    return true
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
