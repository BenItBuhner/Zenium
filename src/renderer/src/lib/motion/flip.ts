import { reducedMotion, SPRING_SNAPPY, SpringAnimation } from './spring'

/** Length of the opacity fade that stands in for a glide under reduced motion (v2 §11.3). */
export const REDUCED_FADE_MS = 120
/** `--zen-ease`, for the Web Animations API (which cannot read a custom property). */
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

/**
 * A layout animation in flight – a group card running its height on a spring – by the owner's
 * cell key. While it runs, the cells below the owner would be moved by layout on every frame;
 * the FLIP tracker holds them where they are instead and glides them once the height has
 * settled (v2 §11.4: "the cards below wait for the group's height to settle and then glide"),
 * so it needs to know, per frame, how far the owner is from the height it is heading for. The
 * record outlives the animation until the tracker has released the hold, so a second change
 * that lands meanwhile keeps the same destination.
 */
interface LayoutAnimation {
  /** The owner's height now. */
  height: number
  /** The height the owner is heading for – the one the settled layout will have. */
  destination: number
  /**
   * Whether the owner is in the grid's flow: a group shrinking to nothing is taken out of it
   * (positioned where it was), so the layout is settled from the start and nothing moves by it.
   */
  inFlow: boolean
  running: boolean
}

const animations = new Map<string, LayoutAnimation>()
const frameListeners = new Set<() => void>()
const settledListeners = new Set<() => void>()

export const layoutAnimations = {
  any(): boolean {
    for (const a of animations.values()) if (a.running) return true
    return false
  },
  /** `owner` is animating its height from `height` to `destination`. */
  start(owner: string, height: number, destination: number, inFlow = true): void {
    const a = animations.get(owner)
    if (a) Object.assign(a, { height, destination, inFlow, running: true })
    else animations.set(owner, { height, destination, inFlow, running: true })
  },
  /** The owner's animation is heading somewhere else now. */
  retarget(owner: string, destination: number): void {
    const a = animations.get(owner)
    if (a) a.destination = destination
  },
  /** The owner's height this frame. */
  frame(owner: string, height: number): void {
    const a = animations.get(owner)
    if (!a) return
    a.height = height
    for (const listener of frameListeners) listener()
  },
  /** Whether `owner` has an animation running or not yet released. */
  has(owner: string): boolean {
    return animations.has(owner)
  },
  /**
   * How far `owner` is from its destination, in px of the layout below it (positive: the cells
   * below are laid out lower than they will settle). Nothing for an owner out of the flow.
   * `beside` is the tallest cell sharing its grid row, whose height the row cannot go under.
   */
  shortfall(owner: string, beside: number): number {
    const a = animations.get(owner)
    if (!a || !a.inFlow) return 0
    return Math.max(a.height, beside) - Math.max(a.destination, beside)
  },
  /** The owner's animation is over; the hold stands until the tracker releases it. */
  end(owner: string): void {
    const a = animations.get(owner)
    if (!a || !a.running) return
    a.running = false
    // No tracker to release the hold: nothing waits for this record. Only an unmounted grid
    // gets here – a mounted one listens for its whole life (`useFlip` takes `listen()` in an
    // effect that re-runs on every mount) – so a hold that never releases points at a tracker
    // that stopped listening, not at this branch.
    if (settledListeners.size === 0) animations.delete(owner)
    else if (!layoutAnimations.any()) for (const listener of settledListeners) listener()
  },
  /** The tracker took the settled layout as its baseline: the finished animations are forgotten. */
  release(): void {
    for (const [owner, a] of animations) if (!a.running) animations.delete(owner)
  },
  onFrame(listener: () => void): () => void {
    frameListeners.add(listener)
    return () => frameListeners.delete(listener)
  },
  onSettled(listener: () => void): () => void {
    settledListeners.add(listener)
    return () => settledListeners.delete(listener)
  }
}

/**
 * The attribute that makes an element a cell of a FLIP grid (written `data-cell={key}` in JSX);
 * its value is the cell's key. The grid is the registry: every element carrying it under the
 * grid's root is measured and glides, whatever component drew it – a page card, the New Tab
 * card, a group – so no card kind can fall out of the choreography by forgetting to register.
 */
export const CELL_ATTR = 'data-cell'

/** The cells under `root`, by key, in document order. */
export function collectCells(root: ParentNode | null): Map<string, HTMLElement> {
  const cells = new Map<string, HTMLElement>()
  if (!root) return cells
  for (const el of root.querySelectorAll<HTMLElement>(`[${CELL_ATTR}]`)) {
    const key = el.getAttribute(CELL_ATTR)
    if (key) cells.set(key, el)
  }
  return cells
}

interface Tracked {
  /**
   * Where the cell will rest, in the scroll content's coordinates (no transform, no scrolling):
   * its layout position once every running layout animation has reached its destination.
   */
  x: number
  y: number
  width: number
  height: number
  /** Offset the element is drawn at, relative to where it rests, when progress = 1. */
  dx: number
  dy: number
  /** The nearest cell this one is drawn inside: its transform carries this one along. */
  parent: string | null
  /** Owners of layout animations whose height moves this cell by layout, frame by frame. */
  below: string[]
  /**
   * The cell waits: it is below a group changing height and stays drawn where it was, at its
   * full offset, until the tracker releases the hold and it glides (v2 §11.4).
   */
  held: boolean
}

/**
 * Elements glide to their new slots instead of jumping when a grid re-lays itself out (a group
 * is made, a card joins one, a tab is closed). Classic FLIP: after every commit each tracked
 * element is measured, the difference to where it was drawn becomes a translation, and one
 * shared spring takes all of them back to zero – a re-layout mid-flight simply starts again from
 * where the elements are, so nothing ever snaps.
 *
 * A group animating its height is the one re-layout that is sequenced (v2 §11.4): the cells
 * below it are held where they were, frame by frame, while the group card runs its height and
 * the browser lays the rows below out for it; the card leaving (or entering) the group glides
 * meanwhile, straight to the slot it will have once the height has settled; and once it has
 * (and any glide in flight has ended) the hold is released into one glide of everything below.
 * Under reduced motion a glide is a 120 ms fade in at the new slot (v2 §11.3).
 */
export class FlipTracker {
  private tracked = new Map<string, Tracked>()
  private elements = new Map<string, HTMLElement>()
  private scroller: HTMLElement | null = null
  private progress = 0
  /** False while the grid is scaling in: the set is observed, nothing is measured. */
  private measuring = false
  private releasePending = false
  /**
   * Per owner of a layout animation, the tallest cell beside it in its grid row (0 when it has
   * the row to itself): the row is as tall as the taller of the two, and it is the row's height
   * that moves the cells below, not the owner's.
   */
  private rowMates = new Map<string, number>()
  private readonly releaseListeners = new Set<() => void>()
  private readonly frameListeners = new Set<() => void>()
  /**
   * What `listen()` gave `layoutAnimations`, kept as the same two functions for the tracker's
   * lifetime so that listening twice adds nothing and `unlisten()` removes exactly them.
   */
  private readonly onLayoutFrame = (): void => this.draw()
  private readonly onLayoutSettled = (): void => this.release()
  private unsubscribe: Array<() => void> = []
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
        if (item.held) continue
        item.dx = 0
        item.dy = 0
      }
      this.draw()
      if (this.releasePending) this.release()
    }
  )

  /**
   * Hear of the groups' height animations: redraw on each of their frames, release the hold
   * when they have settled. Returns the way to stop listening. Taken from an effect, not the
   * constructor, and for as long as the grid is mounted: React's StrictMode (every dev build)
   * mounts, cleans up and mounts again, so whatever a cleanup drops must be taken again by the
   * effect that follows – a tracker that subscribed once, when it was made, would end deaf, its
   * holds never released and a forming group's chrome never switched on. Listening twice adds
   * nothing.
   */
  listen(): () => void {
    if (this.unsubscribe.length === 0)
      this.unsubscribe = [
        layoutAnimations.onFrame(this.onLayoutFrame),
        layoutAnimations.onSettled(this.onLayoutSettled)
      ]
    return () => this.unlisten()
  }

  /** Whether the tracker is hearing of layout animations. */
  get listening(): boolean {
    return this.unsubscribe.length > 0
  }

  /** Whether a glide is in flight. */
  get gliding(): boolean {
    return this.spring.running
  }

  /**
   * Called after every commit with the elements currently on screen. With `animate` false the
   * positions are only recorded (the grid is being scaled in).
   */
  commit(elements: Map<string, HTMLElement>, scroller: HTMLElement | null, animate: boolean): void {
    this.elements = new Map(elements)
    this.scroller = scroller
    this.measuring = true
    const t = this.progress
    const scrollLeft = scroller?.scrollLeft ?? 0
    const scrollTop = scroller?.scrollTop ?? 0
    // Layout positions: every transform out of the way first (a parent's moves its children),
    // then one measurement each – never a write between two reads.
    for (const el of elements.values()) el.style.transform = ''
    const rects = new Map<string, DOMRect>()
    for (const [id, el] of elements) rects.set(id, el.getBoundingClientRect())
    const parents = new Map<string, string | null>()
    for (const [id, el] of elements) {
      const key = el.parentElement?.closest<HTMLElement>(`[${CELL_ATTR}]`)?.getAttribute(CELL_ATTR)
      parents.set(id, key && elements.has(key) ? key : null)
    }
    const owners = [...elements.keys()].filter((id) => layoutAnimations.has(id))
    this.rowMates = new Map()
    for (const owner of owners) {
      const box = rects.get(owner)!
      let tallest = 0
      for (const [id, r] of rects) {
        if (id === owner || parents.get(id) !== parents.get(owner)) continue
        if (Math.abs(r.top - box.top) < 0.5) tallest = Math.max(tallest, r.height)
      }
      this.rowMates.set(owner, tallest)
    }
    const next = new Map<string, Tracked>()
    const moved: HTMLElement[] = []
    let travel = 0
    for (const [id, el] of elements) {
      const prev = this.tracked.get(id)
      const r = rects.get(id)!
      const pt = prev?.held ? 1 : t
      // Where the element is drawn right now, in the content's coordinates.
      const drawnTop = prev ? prev.y + prev.dy * pt : r.top + scrollTop
      const below: string[] = []
      let held = false
      for (const owner of owners) {
        if (owner === id || elements.get(owner)!.contains(el)) continue
        const box = rects.get(owner)!
        // Laid out under the owner: its height moves this cell, frame by frame.
        if (r.top >= box.bottom - 0.5) below.push(owner)
        // Drawn under the owner: this cell waits for it (a card just out of the group is drawn
        // inside it still, and glides).
        if (drawnTop >= box.bottom + scrollTop - 0.5) held = true
      }
      const x = r.left + scrollLeft
      const y = r.top + scrollTop - this.shiftOf(below)
      let dx = 0
      let dy = 0
      if (prev && animate) {
        // Where the element was drawn a moment ago, against where it will rest now.
        dx = prev.x + prev.dx * pt - x
        dy = prev.y + prev.dy * pt - y
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
          dx = 0
          dy = 0
        } else if (held) {
          // Frozen where it was; the glide comes with the release.
        } else if (reducedMotion()) {
          // No travel: the cell is at its new slot, and fades in there (v2 §11.3).
          moved.push(el)
          dx = 0
          dy = 0
        } else travel = Math.max(travel, Math.abs(dx), Math.abs(dy))
      }
      next.set(id, {
        x,
        y,
        width: r.width,
        height: r.height,
        dx,
        dy,
        parent: parents.get(id) ?? null,
        below,
        held: held && (dx !== 0 || dy !== 0 || below.length > 0)
      })
    }
    this.tracked = next
    if (travel > 0) {
      this.travel = travel
      this.progress = 1
      this.spring.start(travel, 0, 0)
    }
    this.draw()
    for (const el of moved) fadeIn(el)
  }

  /**
   * The cells on screen, not measured: before the grid has settled (it is scaling in, and a
   * measurement per card per frame would slow the very frames the spring is paced by) the set is
   * kept current so `element()` answers, and the first settled commit takes the baseline.
   */
  observe(elements: Map<string, HTMLElement>): void {
    this.elements = new Map(elements)
    this.measuring = false
  }

  /** The element of cell `id` as of the last commit or observation. */
  element(id: string): HTMLElement | null {
    return this.elements.get(id) ?? null
  }

  /**
   * Where `id` will come to rest, in window coordinates: its slot in the settled layout as of
   * the last commit, at the scroller's current offset, with any glide in flight and any hold
   * left out. Read from what the last commit measured, so a drag can ask every frame without
   * forcing a layout.
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

  /** Where `id` is drawn right now, in window coordinates: its rest plus its glide, or its hold. */
  drawnRect(id: string): DOMRect | null {
    const item = this.tracked.get(id)
    if (!item) return null
    const t = item.held ? 1 : this.progress
    return new DOMRect(
      item.x + item.dx * t - (this.scroller?.scrollLeft ?? 0),
      item.y + item.dy * t - (this.scroller?.scrollTop ?? 0),
      item.width,
      item.height
    )
  }

  /** Runs after every frame the tracker draws (a glide's, or a held layout animation's). */
  onFrame(listener: () => void): () => void {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  /**
   * Runs when a hold is released: a group's height has settled, any glide in flight has ended,
   * and the cells below have set off for their new slots – the end of the sequence a card
   * leaving or entering a group runs, where the group's chrome switches (v2 §11.4).
   */
  onRelease(listener: () => void): () => void {
    this.releaseListeners.add(listener)
    return () => this.releaseListeners.delete(listener)
  }

  /**
   * The layout animations are over: the settled layout is the new baseline, and whatever the
   * hold kept in place glides there – once the glide in flight, if any, has ended.
   */
  release(): void {
    if (layoutAnimations.any()) return
    if (this.spring.running) {
      this.releasePending = true
      return
    }
    this.releasePending = false
    layoutAnimations.release()
    // Nothing is held while the grid scales in; the first settled commit takes the baseline.
    if (this.measuring) {
      // Fresh from the DOM: a release inside a child's layout effect runs before the grid's own
      // commit has handed over this commit's elements.
      const cells = this.scroller ? collectCells(this.scroller) : this.elements
      this.commit(cells, this.scroller, true)
    }
    for (const listener of this.releaseListeners) listener()
  }

  /** Stop animating and drop every transform (the grid is going away). */
  stop(): void {
    this.spring.stop()
    this.progress = 0
    this.releasePending = false
    for (const el of this.elements.values()) el.style.transform = ''
  }

  /**
   * `stop()`, stop listening for layout animations and forget the finished ones this tracker
   * would have released. Safe to call more than once, and `listen()` starts the tracker again
   * (StrictMode's cleanup is followed by a mount).
   */
  dispose(): void {
    this.stop()
    this.unlisten()
    layoutAnimations.release()
  }

  private unlisten(): void {
    for (const off of this.unsubscribe) off()
    this.unsubscribe = []
  }

  private draw(): void {
    const t = this.progress
    for (const [id, item] of this.tracked) {
      const el = this.elements.get(id)
      if (!el) continue
      // The cell's own transform is what its parent cell's does not already do to it.
      const parent = item.parent ? this.tracked.get(item.parent) : undefined
      const x = this.offsetX(item, t) - (parent ? this.offsetX(parent, t) : 0)
      const y = this.offsetY(item, t) - (parent ? this.offsetY(parent, t) : 0)
      el.style.transform =
        Math.abs(x) >= 0.01 || Math.abs(y) >= 0.01 ? `translate(${x}px, ${y}px)` : ''
    }
    for (const listener of this.frameListeners) listener()
  }

  private offsetX(item: Tracked, t: number): number {
    return item.dx * (item.held ? 1 : t)
  }

  /**
   * How far from its layout position the cell is drawn: its glide (or its hold), less how far
   * the layout below a group still has to go.
   */
  private offsetY(item: Tracked, t: number): number {
    return item.dy * (item.held ? 1 : t) - this.shiftOf(item.below)
  }

  /**
   * How far the layout animations of `owners` still have to move the cells below them, in px
   * (positive: they are laid out lower than they will settle).
   */
  private shiftOf(owners: string[]): number {
    let shift = 0
    for (const owner of owners)
      shift += layoutAnimations.shortfall(owner, this.rowMates.get(owner) ?? 0)
    return shift
  }
}

/** The 120 ms fade that stands in for a glide under reduced motion. */
function fadeIn(el: HTMLElement): void {
  el.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: REDUCED_FADE_MS, easing: EASE })
}
