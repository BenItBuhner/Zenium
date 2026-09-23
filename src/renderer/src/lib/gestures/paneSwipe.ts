import { VelocityTracker } from '../motion/velocity'

/**
 * The switcher's pane swipe (GN-19): a horizontal drag over the tab overview's pane moves to the
 * neighbouring header segment, the segment's indicator following the finger. Chrome's rule is the
 * Hub's `HubPaneSwipeGestureHandler.java` (`chrome/browser/hub/internal/android/java/src/org/
 * chromium/chrome/browser/hub/swipe/`), read 2026-09-23:
 *
 *  - a touch that lands in the edge gutters or on an interactive element is never a swipe
 *    (`checkCanInterceptSwipe`, lines 260-268; `hub_edge_swipe_gutter_width` 32 dp,
 *    `hub/internal/android/res/values/dimens.xml` line 9);
 *  - the drag claims the touch once `|dx| > touchSlop && |dx| > |dy|` (lines 139, 194; the slop is
 *    `ViewConfiguration.getScaledTouchSlop()`, 8 dp in AOSP's `ViewConfiguration.java` line 191),
 *    and its direction is locked there: the displacement is clamped to that side (lines 213-217)
 *    and progress is `|dx| / containerWidth` (line 217);
 *  - on release it switches when `(|dx| > width / 3 && !oppositeFling) || flingInDirection`
 *    (`SWIPE_SWITCH_DISTANCE_FRACTION` line 57; lines 230-241), a fling being
 *    `|vx| > minimumFlingVelocity && |vx| > |vy|` (`getScaledMinimumFlingVelocity()`, 50 dp/s in
 *    `ViewConfiguration.java` line 240);
 *  - the neighbour is the next pane in the switcher's order for a swipe left, the previous for a
 *    swipe right (`HubCoordinator.onSwipeDragProgress`, `currentActiveIndex + (isSwipeLeft ? 1 : -1)`,
 *    line 375), and the switcher's indicator scrolls to `currentActiveIndex ± progress` (lines 383-386).
 *
 * A CSS px is a dp on Android, so the numbers carry over as they are. This module is the pure
 * part – no DOM – so it can be tested as such; `usePaneSwipe` owns the pointer events and the
 * writes.
 */

/** The part of the pane's width a release must have crossed to switch, short of a fling. */
export const PANE_SWIPE_COMMIT_FRACTION = 1 / 3
/** The gutter on either side of the pane where a touch is the system's (gesture navigation), never a swipe. */
export const PANE_SWIPE_EDGE_GUTTER = 32
/** How far a finger moves before it is a drag rather than a tap. */
export const PANE_SWIPE_SLOP = 8
/** The least horizontal speed, in px/s, that counts as a fling at release. */
export const PANE_SWIPE_FLING_VELOCITY = 50

/** Which way the finger moves. */
export type PaneSwipeDirection = 'left' | 'right'

/** Whether a touch at `x` across a pane `width` wide may start a swipe: not in either edge gutter. */
export function paneSwipeMayStart(
  x: number,
  width: number,
  gutter = PANE_SWIPE_EDGE_GUTTER
): boolean {
  return width > 0 && x > gutter && x < width - gutter
}

/**
 * What a move of `(dx, dy)` from the touch's origin decides: the swipe's direction once the
 * finger is past the slop with the horizontal winning, `'vertical'` once it is past the slop the
 * other way (the touch is the scroller's), `null` while it is still under the slop.
 */
export function paneSwipeDirection(
  dx: number,
  dy: number,
  slop = PANE_SWIPE_SLOP
): PaneSwipeDirection | 'vertical' | null {
  if (Math.abs(dx) > slop && Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'left' : 'right'
  if (Math.abs(dy) > slop) return 'vertical'
  return null
}

/**
 * The pane a swipe reaches: the one after `current` in the switcher's order for a swipe left,
 * the one before for a swipe right; `null` at the order's end (nothing to swipe to).
 */
export function paneSwipeNeighbour<T>(
  panes: readonly T[],
  current: T,
  direction: PaneSwipeDirection
): T | null {
  const index = panes.indexOf(current)
  if (index < 0) return null
  const next = panes[index + (direction === 'left' ? 1 : -1)]
  return next === undefined ? null : next
}

/**
 * The drag's progress towards the neighbour, 0 to 1: the displacement clamped to the locked
 * direction (a finger that crosses back past its origin reads as 0, never as a swipe the other
 * way) over the pane's width.
 */
export function paneSwipeProgress(
  dx: number,
  width: number,
  direction: PaneSwipeDirection
): number {
  if (width <= 0) return 0
  const clamped =
    direction === 'left' ? Math.min(0, Math.max(-width, dx)) : Math.max(0, Math.min(width, dx))
  return Math.abs(clamped) / width
}

export interface PaneSwipeRelease {
  dx: number
  vx: number
  vy: number
  width: number
  direction: PaneSwipeDirection
}

/**
 * Whether a release switches panes: past a third of the width unless the finger was flung back
 * the other way, or flung onward at any distance.
 */
export function paneSwipeSettles(
  input: PaneSwipeRelease,
  fraction = PANE_SWIPE_COMMIT_FRACTION,
  flingVelocity = PANE_SWIPE_FLING_VELOCITY
): boolean {
  const { dx, vx, vy, width, direction } = input
  const fling = Math.abs(vx) > flingVelocity && Math.abs(vx) > Math.abs(vy)
  const onward = fling && (direction === 'left' ? vx < 0 : vx > 0)
  const opposite = fling && !onward
  const farEnough = Math.abs(dx) > width * fraction
  return (farEnough && !opposite) || onward
}

/** What one pointer move means to a session. */
export type PaneSwipeStep<T> =
  | { kind: 'pending' }
  | { kind: 'declined'; reason: 'vertical' | 'no-neighbour' }
  | { kind: 'claimed'; direction: PaneSwipeDirection; neighbour: T; progress: number }
  | { kind: 'dragging'; progress: number }

/**
 * What a release means: the pane to settle on, how far the drag had got, and how fast it was
 * going there – `velocity` in progress per second, positive towards the neighbour – so the
 * settle can carry on from the finger's motion.
 */
export interface PaneSwipeOutcome<T> {
  commit: boolean
  neighbour: T
  direction: PaneSwipeDirection
  progress: number
  velocity: number
}

/**
 * One touch's life as a pane swipe, from the down to the release, in Chrome's terms: pending
 * until the slop decides the axis; declined for good if the axis is vertical or there is no pane
 * that way; claimed on the first horizontal move with a neighbour, the direction locked; then
 * dragging, progress clamped to that direction; and at release the settle rule.
 */
export class PaneSwipeSession<T> {
  private readonly tracker = new VelocityTracker()
  private state:
    | { phase: 'pending' }
    | { phase: 'declined'; reason: 'vertical' | 'no-neighbour' }
    | { phase: 'dragging'; direction: PaneSwipeDirection; neighbour: T; dx: number } = {
    phase: 'pending'
  }

  constructor(
    private readonly panes: readonly T[],
    private readonly current: T,
    private readonly width: number,
    private readonly x0: number,
    private readonly y0: number,
    t0: number
  ) {
    this.tracker.add(t0, x0, y0)
  }

  /** Whether the touch is a swipe in progress. */
  get dragging(): boolean {
    return this.state.phase === 'dragging'
  }

  /** The locked direction and neighbour, once claimed. */
  get target(): { direction: PaneSwipeDirection; neighbour: T } | null {
    return this.state.phase === 'dragging'
      ? { direction: this.state.direction, neighbour: this.state.neighbour }
      : null
  }

  /** How far the drag has got, 0 to 1; 0 for a touch that is no drag. */
  get progress(): number {
    return this.state.phase === 'dragging'
      ? paneSwipeProgress(this.state.dx, this.width, this.state.direction)
      : 0
  }

  move(x: number, y: number, t: number): PaneSwipeStep<T> {
    this.tracker.add(t, x, y)
    const dx = x - this.x0
    if (this.state.phase === 'declined') return { kind: 'declined', reason: this.state.reason }
    if (this.state.phase === 'dragging') {
      this.state.dx = dx
      return { kind: 'dragging', progress: paneSwipeProgress(dx, this.width, this.state.direction) }
    }
    const decided = paneSwipeDirection(dx, y - this.y0)
    if (decided === null) return { kind: 'pending' }
    if (decided === 'vertical') {
      this.state = { phase: 'declined', reason: 'vertical' }
      return { kind: 'declined', reason: 'vertical' }
    }
    const neighbour = paneSwipeNeighbour(this.panes, this.current, decided)
    if (neighbour === null) {
      this.state = { phase: 'declined', reason: 'no-neighbour' }
      return { kind: 'declined', reason: 'no-neighbour' }
    }
    this.state = { phase: 'dragging', direction: decided, neighbour, dx }
    return {
      kind: 'claimed',
      direction: decided,
      neighbour,
      progress: paneSwipeProgress(dx, this.width, decided)
    }
  }

  /** The finger lifts: the outcome for a drag, `null` for a touch that never became one. */
  release(t: number): PaneSwipeOutcome<T> | null {
    if (this.state.phase !== 'dragging') return null
    const { direction, neighbour, dx } = this.state
    const { vx, vy } = this.tracker.velocity(t)
    const commit = paneSwipeSettles({ dx, vx, vy, width: this.width, direction })
    const towards = direction === 'left' ? -vx : vx
    return {
      commit,
      neighbour,
      direction,
      progress: paneSwipeProgress(dx, this.width, direction),
      velocity: this.width > 0 && towards !== 0 ? towards / this.width : 0
    }
  }
}
