import { beforeEach, describe, expect, it } from 'vitest'
import {
  beginDrag,
  DRAG_SLOP,
  DROP_IDLE,
  dwellDeadline,
  elapseDrag,
  fingerMoved,
  homeOf,
  hoverDrag,
  leaveDrag,
  releaseDrag,
  scrollDrag,
  SLOT_DWELL_MS,
  SLOT_REST_SPEED,
  type DropHover,
  type DropTargetState,
  type Point
} from '../gestures/dropTarget'

/*
 * The drop-target machine of a card in the hand (`lib/gestures/dropTarget.ts`): what the grid
 * shows while the finger moves, where the card goes when it lets go, that the slot belongs to
 * the finger and not to the layout (v2 §11.4), and – above all – that every way the gesture
 * ends leaves nothing behind: no ring on a group, no gap waiting to open.
 */

const SLOW = SLOT_REST_SPEED / 2
const FAST = SLOT_REST_SPEED * 5
const START: Point = { x: 0, y: 0 }

const over = (target: string, slot: DropTargetState['slot'] = null): DropHover => ({ target, slot })
const between = (folderId: string | null, index: number): DropHover => ({
  target: null,
  slot: { folderId, index }
})
const nothing = (state: DropTargetState): DropHover => ({ target: null, slot: state.slot })

/** Somewhere the finger has not been: each call is a fresh place well past the slop. */
let travelled = 0
const away = (): Point => ({ x: (travelled += 100), y: 0 })
beforeEach(() => {
  travelled = 0
})

/** The finger, moving, reads `hover` at `now`, at `speed` px/s – somewhere new unless `at` says. */
function hover(
  state: DropTargetState,
  h: DropHover,
  now: number,
  speed: number,
  at: Point = away()
): DropTargetState {
  return hoverDrag(state, h, { ...at, now, speed })
}

/** Hover, resting, and wait the dwell out. */
function settleAt(
  state: DropTargetState,
  h: DropHover,
  now: number,
  at: Point = away()
): DropTargetState {
  const pending = hover(state, h, now, SLOW, at)
  return elapseDrag(pending, now + SLOT_DWELL_MS)
}

describe('drop-target machine', () => {
  it('drag in: over a group the target takes hold at once, and the drop joins it', () => {
    let s = beginDrag(null, START)
    s = hover(s, over('group:g'), 0, FAST)
    expect(s.target).toBe('group:g')
    const { state, outcome } = releaseDrag(s, 'drop')
    expect(outcome).toEqual({ kind: 'target', target: 'group:g' })
    expect(state).toEqual(DROP_IDLE)
  })

  it('drag out: a slot among the loose cards opens after the dwell and the drop lands there', () => {
    let s = beginDrag('g', START)
    expect(homeOf(s)).toBe('g')
    s = hover(s, between(null, 2), 100, SLOW)
    expect(s.slot).toBeNull()
    expect(dwellDeadline(s)).toBe(100 + SLOT_DWELL_MS)
    s = elapseDrag(s, 100 + SLOT_DWELL_MS - 1)
    expect(s.slot).toBeNull()
    s = elapseDrag(s, 100 + SLOT_DWELL_MS)
    expect(s.slot).toEqual({ folderId: null, index: 2 })
    expect(s.pending).toBeNull()
    expect(homeOf(s)).toBeNull()
    const { state, outcome } = releaseDrag(s, 'drop')
    expect(outcome).toEqual({ kind: 'slot', slot: { folderId: null, index: 2 } })
    expect(state.phase).toBe('idle')
  })

  it('hover then leave: the ring goes out the moment the finger is off the group', () => {
    let s = beginDrag(null, START)
    s = hover(s, over('group:g'), 0, SLOW)
    expect(s.target).toBe('group:g')
    s = hover(s, nothing(s), 16, SLOW)
    expect(s.target).toBeNull()
    expect(s.pending).toBeNull()
    // Off the grid altogether says the same, and also forgets a slot on its way in.
    s = hover(s, between(null, 1), 32, SLOW)
    s = hover(s, over('card:x'), 48, SLOW)
    s = leaveDrag(s, { ...away(), now: 64, speed: SLOW })
    expect(s.target).toBeNull()
    expect(s.pending).toBeNull()
    expect(s.phase).toBe('dragging')
  })

  it('cancel mid-hover: idle at once, nothing kept, and the card goes back', () => {
    let s = beginDrag(null, START)
    s = hover(s, over('group:g'), 0, SLOW)
    s = hover(s, between('g', 0), 10, SLOW)
    const { state, outcome } = releaseDrag(s, 'cancel')
    expect(outcome).toEqual({ kind: 'cancelled' })
    expect(state).toEqual(DROP_IDLE)
    // A cancelled machine ignores whatever arrives late.
    expect(hover(state, over('group:g'), 20, SLOW)).toEqual(DROP_IDLE)
    expect(elapseDrag(state, 1000)).toEqual(DROP_IDLE)
    expect(releaseDrag(state, 'drop').outcome).toEqual({ kind: 'unchanged' })
  })

  it('fling out: a release before the dwell commits the slot the finger is at', () => {
    let s = beginDrag('g', START)
    s = hover(s, between(null, 0), 0, FAST)
    expect(s.slot).toBeNull()
    expect(s.pending).toEqual({ slot: { folderId: null, index: 0 }, since: 0 })
    const { state, outcome } = releaseDrag(s, 'drop')
    expect(outcome).toEqual({ kind: 'slot', slot: { folderId: null, index: 0 } })
    expect(state).toEqual(DROP_IDLE)
  })

  it('drop on nothing: a gutter changes nothing, and so does a target the finger left', () => {
    let s = beginDrag(null, START)
    s = hover(s, nothing(s), 0, SLOW)
    expect(releaseDrag(s, 'drop').outcome).toEqual({ kind: 'unchanged' })
    s = hover(s, over('card:x'), 10, SLOW)
    s = hover(s, nothing(s), 20, SLOW)
    expect(releaseDrag(s, 'drop').outcome).toEqual({ kind: 'unchanged' })
    // An applied slot is where the card is shown: dropping in a gutter keeps it there.
    s = settleAt(beginDrag(null, START), between(null, 3), 0)
    s = hover(s, nothing(s), 500, SLOW)
    expect(releaseDrag(s, 'drop').outcome).toEqual({
      kind: 'slot',
      slot: { folderId: null, index: 3 }
    })
  })

  it('drop on the same group: a card is no target for the group it is shown in', () => {
    let s = beginDrag('g', START)
    s = hover(s, over('group:g'), 0, SLOW)
    expect(s.target).toBeNull()
    expect(releaseDrag(s, 'drop').outcome).toEqual({ kind: 'unchanged' })
    // Another group is a target as usual…
    s = hover(s, over('group:h'), 10, SLOW)
    expect(s.target).toBe('group:h')
    // …and once the stand-in has moved out, the old group is a target again (the card rejoins).
    s = settleAt(beginDrag('g', START), between(null, 1), 0)
    s = hover(s, over('group:g'), 500, SLOW)
    expect(s.target).toBe('group:g')
    expect(releaseDrag(s, 'drop').outcome).toEqual({ kind: 'target', target: 'group:g' })
  })

  it('a slot opening inside a group the finger targets drops the ring on that group', () => {
    let s = beginDrag(null, START)
    s = hover(s, over('group:g'), 0, SLOW)
    s = hover(s, between('g', 1), 10, SLOW)
    s = hover(s, { target: 'group:g', slot: { folderId: 'g', index: 1 } }, 20, SLOW)
    s = elapseDrag(s, 20 + SLOT_DWELL_MS)
    expect(s.slot).toEqual({ folderId: 'g', index: 1 })
    expect(s.target).toBeNull()
  })

  it('rapid re-entry: leaving and coming back re-targets at once and restarts the dwell cleanly', () => {
    let s = beginDrag(null, START)
    s = hover(s, over('group:g'), 0, SLOW)
    s = hover(s, nothing(s), 8, SLOW)
    s = hover(s, over('group:g'), 16, SLOW)
    expect(s.target).toBe('group:g')
    // Slot A, then B before A's dwell, then A again: A waits its full dwell from the return.
    s = hover(s, between(null, 0), 100, SLOW)
    s = hover(s, between(null, 1), 150, SLOW)
    s = hover(s, between(null, 0), 160, SLOW)
    expect(s.pending).toEqual({ slot: { folderId: null, index: 0 }, since: 160 })
    s = elapseDrag(s, 100 + SLOT_DWELL_MS)
    expect(s.slot).toBeNull()
    s = elapseDrag(s, 160 + SLOT_DWELL_MS)
    expect(s.slot).toEqual({ folderId: null, index: 0 })
  })

  it('the dwell counts from the moment the finger slows down', () => {
    let s = beginDrag(null, START)
    s = hover(s, between(null, 2), 0, FAST)
    s = hover(s, between(null, 2), 100, FAST)
    expect(s.pending?.since).toBe(100)
    s = hover(s, between(null, 2), 120, SLOW)
    expect(s.pending?.since).toBe(100)
    expect(s.slot).toBeNull()
    s = hover(s, between(null, 2), 100 + SLOT_DWELL_MS, SLOW)
    expect(s.slot).toEqual({ folderId: null, index: 2 })
    // Back on the slot it is shown in: nothing is pending.
    expect(hover(s, between(null, 2), 400, SLOW).pending).toBeNull()
  })
})

describe('the slot belongs to the finger, not to the layout (v2 §11.4)', () => {
  const REST: Point = { x: 120, y: 300 }
  /** A card resting out of its group in the slot after the first loose card. */
  const rested = (): DropTargetState => settleAt(beginDrag('g', START), between(null, 1), 100, REST)

  it('a reflow under a still finger changes neither the slot nor the target', () => {
    let s = rested()
    expect(s.slot).toEqual({ folderId: null, index: 1 })
    expect(s.anchor).toEqual(REST)
    // The group lost a row and the grid moved up: the same point now reads as the end slot, or
    // as a card to merge into. Neither counts.
    s = hover(s, between(null, 2), 300, SLOW, REST)
    expect(s.slot).toEqual({ folderId: null, index: 1 })
    expect(s.pending).toBeNull()
    s = hover(s, over('card:x'), 316, SLOW, REST)
    expect(s.target).toBeNull()
    expect(s.slot).toEqual({ folderId: null, index: 1 })
    // Under the slop is not a movement either.
    const under = { x: REST.x + 5, y: REST.y + 5 }
    expect(fingerMoved(s, under)).toBe(false)
    s = hover(s, over('card:x'), 332, SLOW, under)
    expect(s.target).toBeNull()
    expect(s.slot).toEqual({ folderId: null, index: 1 })
    expect(s.pending).toBeNull()
    // Past it the finger has moved, and what is under it counts again.
    const past = { x: REST.x + DRAG_SLOP + 2, y: REST.y }
    expect(fingerMoved(s, past)).toBe(true)
    s = hover(s, over('card:x'), 348, SLOW, past)
    expect(s.target).toBe('card:x')
    expect(s.anchor).toEqual(past)
  })

  it('a release on a still finger lands in the held slot even if the layout changed beneath it', () => {
    let s = rested()
    s = hover(s, between(null, 2), 300, SLOW, REST)
    const { state, outcome } = releaseDrag(s, 'drop')
    expect(outcome).toEqual({ kind: 'slot', slot: { folderId: null, index: 1 } })
    expect(state).toEqual(DROP_IDLE)
  })

  it('a ring holds on the card the finger chose when that card glides away from under it', () => {
    let s = beginDrag(null, START)
    s = hover(s, over('card:x'), 0, SLOW, REST)
    expect(s.target).toBe('card:x')
    // A neighbour closed; the card moved on and the point reads as a gutter, then as a slot.
    s = hover(s, nothing(s), 200, SLOW, REST)
    expect(s.target).toBe('card:x')
    s = hover(s, between(null, 4), 216, SLOW, { x: REST.x - 3, y: REST.y + 2 })
    expect(s.target).toBe('card:x')
    expect(s.pending).toBeNull()
    expect(releaseDrag(s, 'drop').outcome).toEqual({ kind: 'target', target: 'card:x' })
  })

  it('a finger that is moving when the reflow lands re-targets on its next event', () => {
    let s = rested()
    s = hover(s, between(null, 2), 300, FAST, { x: REST.x + 40, y: REST.y })
    expect(s.pending).toEqual({ slot: { folderId: null, index: 2 }, since: 300 })
    expect(releaseDrag(s, 'drop').outcome).toEqual({
      kind: 'slot',
      slot: { folderId: null, index: 2 }
    })
  })

  it('a finger on its way back to where it settled is moving: the reading there counts', () => {
    // Out fast over the end of the grid and straight back to where the card was picked up: the
    // slot read on the way out must not survive the return, or a release at home would move
    // the card to the end.
    let s = beginDrag(null, START)
    s = hover(s, between(null, 2), 0, FAST, { x: 60, y: 90 })
    expect(s.pending).toEqual({ slot: { folderId: null, index: 2 }, since: 0 })
    s = hover(s, nothing(s), 16, FAST, START)
    expect(s.pending).toBeNull()
    s = hover(s, nothing(s), 32, SLOW, START)
    expect(s.anchor).toEqual(START)
    expect(releaseDrag(s, 'drop').outcome).toEqual({ kind: 'unchanged' })
  })

  it('the finger settles where its slot takes hold, whatever speed its last event had', () => {
    // One long stride straight to the slot, then stillness: no event slower than the rest speed.
    let s = beginDrag('g', START)
    s = hover(s, between(null, 2), 0, FAST, REST)
    // On its way, the finger has settled nowhere yet.
    expect(s.anchor).toBeNull()
    s = elapseDrag(s, SLOT_DWELL_MS)
    expect(s.slot).toEqual({ folderId: null, index: 2 })
    expect(s.anchor).toEqual(REST)
    // The grid reflowed; a tremor of the finger reads a new slot at the same place.
    s = hover(s, between(null, 5), 400, SLOW, { x: REST.x + 3, y: REST.y })
    expect(s.slot).toEqual({ folderId: null, index: 2 })
    expect(s.pending).toBeNull()
  })

  it('the finger settles where it stood through a pause', () => {
    let s = beginDrag(null, START)
    s = hover(s, over('card:x'), 0, FAST, REST)
    expect(s.anchor).toBeNull()
    // Nothing for a while, then a tremor: the finger was still at its last place all along.
    s = hover(s, nothing(s), SLOT_DWELL_MS + 50, SLOW, { x: REST.x + 4, y: REST.y })
    expect(s.target).toBe('card:x')
    expect(s.anchor).toEqual(REST)
    // A pause shorter than the dwell settles nothing: that is a finger between two events.
    let m = beginDrag(null, START)
    m = hover(m, over('card:x'), 0, FAST, REST)
    m = hover(m, nothing(m), 50, SLOW, { x: REST.x + 4, y: REST.y })
    expect(m.target).toBeNull()
  })

  it('the grid scrolling under the finger is the finger moving over the grid', () => {
    let s = rested()
    // Two ticks of autoscroll: the slots have moved 28 px up under a still finger.
    s = scrollDrag(scrollDrag(s, 0, 14), 0, 14)
    expect(s.anchor).toEqual({ x: REST.x, y: REST.y - 28 })
    expect(fingerMoved(s, REST)).toBe(true)
    s = hover(s, between(null, 3), 400, SLOW, REST)
    expect(s.pending).toEqual({ slot: { folderId: null, index: 3 }, since: 400 })
    expect(s.anchor).toEqual(REST)
    // A scroll that did not happen moves nothing.
    expect(scrollDrag(s, 0, 0)).toBe(s)
  })

  it('leaving the grid settles the finger out there, on nothing', () => {
    let s = rested()
    const off = { x: -40, y: 300 }
    s = leaveDrag(s, { ...off, now: 300, speed: SLOW })
    expect(s.anchor).toEqual(off)
    expect(s.slot).toEqual({ folderId: null, index: 1 })
    // Back on the grid within the slop of where it left: still nothing new.
    s = hover(s, over('card:x'), 316, SLOW, { x: off.x + 6, y: off.y })
    expect(s.target).toBeNull()
  })
})
