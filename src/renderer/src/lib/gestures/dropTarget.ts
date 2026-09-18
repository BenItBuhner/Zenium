/**
 * The drop-target state of a card in the hand, as a pure state machine. The grid resolves what
 * the finger is over (see `hoverAt` in `TabOverview`) and feeds it in with the pointer's terminal
 * events; the machine says what the grid shows – the merge target the card would go into, the
 * slot its stand-in sits in – and, on release, where the card goes. Every release returns to
 * idle in the same step that decides the outcome, so no hover can outlive the gesture: there is
 * no state in which a target ring or an open gap waits for an event that never comes.
 *
 * Two rules the geometry does not know about live here:
 *  - a card is never a target for itself: the group its stand-in is shown in (its home) is no
 *    merge target, dropping there changes nothing;
 *  - a slot takes hold only once the finger has rested with it for a moment (`SLOT_DWELL_MS` at
 *    under `SLOT_REST_SPEED` px/s): the edge of a card is on the way to its middle, and the gap
 *    must not open, moving that card away, under a finger heading for a merge. Merge targets
 *    take hold at once. A release commits the slot the finger is at, dwelled or not – the card
 *    lands where it was let go, which is what a fling out of a group asks for.
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

export const DROP_IDLE: DropTargetState = {
  phase: 'idle',
  origin: null,
  target: null,
  slot: null,
  pending: null
}

export function sameSlot(a: DropSlot | null, b: DropSlot | null): boolean {
  if (!a || !b) return a === b
  return a.folderId === b.folderId && a.index === b.index
}

/** The card came off the grid; `origin` is the group it was in (null for a loose card). */
export function beginDrag(origin: string | null): DropTargetState {
  return { ...DROP_IDLE, phase: 'dragging', origin }
}

/** The group the card's stand-in is shown in right now. */
export function homeOf(state: DropTargetState): string | null {
  return state.slot ? state.slot.folderId : state.origin
}

/**
 * The finger is over `hover`, at `now` (ms) and moving at `speed` px/s. The target applies at
 * once (never the card's own home); the slot goes pending until the finger has rested with it.
 */
export function hoverDrag(
  state: DropTargetState,
  hover: DropHover,
  now: number,
  speed: number
): DropTargetState {
  if (state.phase !== 'dragging') return state
  const home = homeOf(state)
  const target = hover.target === `group:${home}` ? null : hover.target
  const next: DropTargetState = state.target === target ? state : { ...state, target }
  if (sameSlot(hover.slot, state.slot)) return next.pending ? { ...next, pending: null } : next
  const resting = speed < SLOT_REST_SPEED
  if (next.pending && sameSlot(next.pending.slot, hover.slot) && resting)
    return elapseDrag(next, now)
  // A new slot, or the finger still on its way: the dwell starts over from here.
  return { ...next, pending: { slot: hover.slot, since: now } }
}

/** When the pending slot takes hold if the finger keeps resting, or null when nothing is pending. */
export function dwellDeadline(state: DropTargetState): number | null {
  return state.pending ? state.pending.since + SLOT_DWELL_MS : null
}

/** Time passed to `now`: a slot that has waited out its dwell takes hold. */
export function elapseDrag(state: DropTargetState, now: number): DropTargetState {
  const deadline = dwellDeadline(state)
  if (state.phase !== 'dragging' || deadline === null || now < deadline) return state
  const slot = state.pending?.slot ?? null
  // The home moved with the stand-in: a group the card just left is a target again.
  const target =
    state.target === `group:${slot ? slot.folderId : state.origin}` ? null : state.target
  return { ...state, slot, target, pending: null }
}

/** The finger left the grid (or nothing under it can be resolved): nothing is targeted or pending. */
export function leaveDrag(state: DropTargetState): DropTargetState {
  if (state.phase !== 'dragging') return state
  if (state.target === null && state.pending === null) return state
  return { ...state, target: null, pending: null }
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
