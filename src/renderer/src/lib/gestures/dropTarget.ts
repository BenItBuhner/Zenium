/**
 * The drop-target state of a card in the hand, as a pure state machine. The grid resolves what
 * the finger is over (see `hoverAt` in `TabOverview`) and feeds it in with the pointer's terminal
 * events; the machine says what the grid shows – the merge target the card would go into, the
 * slot its stand-in sits in – and, on release, where the card goes. Every release returns to
 * idle in the same step that decides the outcome, so no hover can outlive the gesture: there is
 * no state in which a target ring or an open gap waits for an event that never comes.
 *
 * Three rules the geometry does not know about live here:
 *  - a card is never a target for itself: the group its stand-in is shown in (its home) is no
 *    merge target, dropping there changes nothing;
 *  - a slot takes hold only once the finger has rested with it for a moment (`SLOT_DWELL_MS` at
 *    under `SLOT_REST_SPEED` px/s): the edge of a card is on the way to its middle, and the gap
 *    must not open, moving that card away, under a finger heading for a merge. Merge targets
 *    take hold at once. A release commits the slot the finger is at, dwelled or not – the card
 *    lands where it was let go, which is what a fling out of a group asks for;
 *  - the target belongs to the finger, not to the layout (v2 §11.4): what the grid reads under
 *    the finger counts only once the finger has moved past the touch slop (`DRAG_SLOP`) from
 *    where it last settled (`anchor`). When the grid reflows under a still finger – a group
 *    loses a row, a card departs, a group collapses – the cells glide to the new layout but the
 *    stand-in stays in the slot the finger chose and the ring on the card it chose, and the
 *    drag re-targets on the finger's next movement; a release on a still finger lands in the
 *    held slot. The finger has settled where a hover finds it at rest, where a slot took hold
 *    under it, or where it stood through a pause as long as the dwell; a finger on its way has
 *    settled nowhere, and re-targets on every event as usual. The grid scrolling under the
 *    finger at its own asking (`scrollDrag`) is the finger moving over the grid.
 */

/** A position between cards: in a group's members (`folderId`) or the loose tabs (`null`). */
export interface DropSlot {
  folderId: string | null
  index: number
}

/**
 * Something a card can be dropped *on*: `card:<tabId>` (the two become a group, or the card joins
 * that card's group) or `group:<folderId>` (the card joins the group).
 */
export type DropTargetKey = string

/** What the finger is over, as the grid works it out from its layout. */
export interface DropHover {
  target: DropTargetKey | null
  /** The slot under the finger; null means "no change" (a gutter, the card's own stand-in). */
  slot: DropSlot | null
}

export interface Point {
  x: number
  y: number
}

/** The finger as a hover finds it: where, when (ms) and how fast (px/s). */
export interface DragPointer extends Point {
  now: number
  speed: number
}

export interface DropTargetState {
  phase: 'idle' | 'dragging'
  /** Group the card came from (its home until a slot moves the stand-in elsewhere). */
  origin: string | null
  /** Target the card would merge into if dropped now; drawn as the ring on that card or group. */
  target: DropTargetKey | null
  /** Slot the stand-in is shown in; null while the card is still in its own place. */
  slot: DropSlot | null
  /** A slot the finger has arrived at but not yet rested in. */
  pending: { slot: DropSlot | null; since: number } | null
  /** Where the finger last settled: its target and slot are its choice until it moves from here. */
  anchor: Point | null
  /** Where the finger last was, and when. */
  pointer: (Point & { at: number }) | null
}

/** Where a released card goes. */
export type DropOutcome =
  | { kind: 'target'; target: DropTargetKey }
  | { kind: 'slot'; slot: DropSlot }
  | { kind: 'unchanged' }
  | { kind: 'cancelled' }

/** How long the finger rests with a new slot before the gap opens there… */
export const SLOT_DWELL_MS = 150
/** …and how slow (px/s) it has to be moving to count as resting. */
export const SLOT_REST_SPEED = 120
/**
 * The touch slop (px): a finger within this of where it settled has not moved, and what the grid
 * reads under it does not count (v2 §11.4). The same distance turns a hold into a drag.
 */
export const DRAG_SLOP = 8

export const DROP_IDLE: DropTargetState = {
  phase: 'idle',
  origin: null,
  target: null,
  slot: null,
  pending: null,
  anchor: null,
  pointer: null
}

export function sameSlot(a: DropSlot | null, b: DropSlot | null): boolean {
  if (!a || !b) return a === b
  return a.folderId === b.folderId && a.index === b.index
}

function within(a: Point, b: Point, distance: number): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= distance
}

/**
 * The card came off the grid at `at`; `origin` is the group it was in (null for a loose card).
 * The finger has settled where it picked the card up.
 */
export function beginDrag(origin: string | null, at: Point): DropTargetState {
  const point = { x: at.x, y: at.y }
  return { ...DROP_IDLE, phase: 'dragging', origin, anchor: point, pointer: { ...point, at: 0 } }
}

/** The group the card's stand-in is shown in right now. */
export function homeOf(state: DropTargetState): string | null {
  return state.slot ? state.slot.folderId : state.origin
}

/** Whether the finger at `at` has moved past the slop from where it last settled. */
export function fingerMoved(state: DropTargetState, at: Point): boolean {
  return state.anchor === null || !within(at, state.anchor, DRAG_SLOP)
}

/**
 * The finger is at `pointer`, over `hover`. Within the slop of where it settled the finger has
 * not moved and the hover does not count – only a pending slot's dwell can run out. Past it,
 * the target applies at once (never the card's own home) and the slot goes pending until the
 * finger has rested with it; a finger found at rest has settled where it is.
 */
export function hoverDrag(
  state: DropTargetState,
  hover: DropHover,
  pointer: DragPointer
): DropTargetState {
  if (state.phase !== 'dragging') return state
  const at = { x: pointer.x, y: pointer.y }
  const resting = pointer.speed < SLOT_REST_SPEED
  let anchor = state.anchor
  // The finger stood still through a pause (no event for as long as the dwell) and is at rest
  // now: it settled where it stood, whatever speed its last event still had.
  if (resting && state.pointer && pointer.now - state.pointer.at >= SLOT_DWELL_MS)
    anchor = { x: state.pointer.x, y: state.pointer.y }
  const placed: DropTargetState = { ...state, anchor, pointer: { ...at, at: pointer.now } }
  if (!fingerMoved(placed, at)) return elapseDrag(placed, pointer.now)
  // Moved: a finger found at rest has settled here; one on its way has settled nowhere, and
  // every reading under it counts until it does – wherever it passes, its own start included.
  const settled = { ...placed, anchor: resting ? at : null }
  const home = homeOf(settled)
  const target = hover.target === `group:${home}` ? null : hover.target
  const next: DropTargetState = settled.target === target ? settled : { ...settled, target }
  if (sameSlot(hover.slot, state.slot)) return next.pending ? { ...next, pending: null } : next
  if (next.pending && sameSlot(next.pending.slot, hover.slot) && resting)
    return elapseDrag(next, pointer.now)
  // A new slot, or the finger still on its way: the dwell starts over from here.
  return { ...next, pending: { slot: hover.slot, since: pointer.now } }
}

/**
 * The grid scrolled by (`dx`, `dy`) under the finger at the finger's own asking (it rests at an
 * edge): over the grid, the finger has moved by as much – the next hover counts.
 */
export function scrollDrag(state: DropTargetState, dx: number, dy: number): DropTargetState {
  if (state.phase !== 'dragging' || (dx === 0 && dy === 0)) return state
  return {
    ...state,
    anchor: state.anchor ? { x: state.anchor.x - dx, y: state.anchor.y - dy } : null,
    pointer: state.pointer
      ? { x: state.pointer.x - dx, y: state.pointer.y - dy, at: state.pointer.at }
      : null
  }
}

/** When the pending slot takes hold if the finger keeps resting, or null when nothing is pending. */
export function dwellDeadline(state: DropTargetState): number | null {
  return state.pending ? state.pending.since + SLOT_DWELL_MS : null
}

/**
 * Time passed to `now`: a slot that has waited out its dwell takes hold – the finger's choice,
 * settled where the finger is.
 */
export function elapseDrag(state: DropTargetState, now: number): DropTargetState {
  const deadline = dwellDeadline(state)
  if (state.phase !== 'dragging' || deadline === null || now < deadline) return state
  const slot = state.pending?.slot ?? null
  // The home moved with the stand-in: a group the card just left is a target again.
  const target =
    state.target === `group:${slot ? slot.folderId : state.origin}` ? null : state.target
  const anchor = state.pointer ? { x: state.pointer.x, y: state.pointer.y } : state.anchor
  return { ...state, slot, target, pending: null, anchor }
}

/**
 * The finger left the grid (or nothing under it can be resolved): nothing is targeted or pending.
 * With `at`, the finger has settled out there, on nothing.
 */
export function leaveDrag(state: DropTargetState, at?: DragPointer): DropTargetState {
  if (state.phase !== 'dragging') return state
  const placed: DropTargetState = at
    ? { ...state, anchor: { x: at.x, y: at.y }, pointer: { x: at.x, y: at.y, at: at.now } }
    : state
  if (placed.target === null && placed.pending === null) return placed
  return { ...placed, target: null, pending: null }
}

/**
 * The finger lifted (`drop`) or the gesture was cut short (`cancel`). The outcome is decided and
 * the machine is idle in one step. A drop takes the target first, then the slot the finger is at
 * – pending or applied – and is `unchanged` when neither says anything.
 */
export function releaseDrag(
  state: DropTargetState,
  how: 'drop' | 'cancel'
): { state: DropTargetState; outcome: DropOutcome } {
  if (state.phase !== 'dragging') return { state: DROP_IDLE, outcome: { kind: 'unchanged' } }
  if (how === 'cancel') return { state: DROP_IDLE, outcome: { kind: 'cancelled' } }
  if (state.target) return { state: DROP_IDLE, outcome: { kind: 'target', target: state.target } }
  const slot = state.pending ? state.pending.slot : state.slot
  if (slot) return { state: DROP_IDLE, outcome: { kind: 'slot', slot } }
  return { state: DROP_IDLE, outcome: { kind: 'unchanged' } }
}
