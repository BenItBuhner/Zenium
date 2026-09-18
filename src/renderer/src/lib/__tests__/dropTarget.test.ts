import { describe, expect, it } from 'vitest'
import {
  beginDrag,
  DROP_IDLE,
  dwellDeadline,
  elapseDrag,
  homeOf,
  hoverDrag,
  leaveDrag,
  releaseDrag,
  SLOT_DWELL_MS,
  SLOT_REST_SPEED,
  type DropHover,
  type DropTargetState
} from '../gestures/dropTarget'

/*
 * The drop-target machine of a card in the hand (`lib/gestures/dropTarget.ts`): what the grid
 * shows while the finger moves, where the card goes when it lets go, and – above all – that
 * every way the gesture ends leaves nothing behind: no ring on a group, no gap waiting to open.
 */

const SLOW = SLOT_REST_SPEED / 2
const FAST = SLOT_REST_SPEED * 5

const over = (target: string, slot: DropTargetState['slot'] = null): DropHover => ({ target, slot })
const between = (folderId: string | null, index: number): DropHover => ({
  target: null,
  slot: { folderId, index }
})
const nothing = (state: DropTargetState): DropHover => ({ target: null, slot: state.slot })

/** Hover, resting, and wait the dwell out. */
function settleAt(state: DropTargetState, hover: DropHover, now: number): DropTargetState {
  const pending = hoverDrag(state, hover, now, SLOW)
  return elapseDrag(pending, now + SLOT_DWELL_MS)
}

describe('drop-target machine', () => {
  it('drag in: over a group the target takes hold at once, and the drop joins it', () => {
    let s = beginDrag(null)
    s = hoverDrag(s, over('group:g'), 0, FAST)
    expect(s.target).toBe('group:g')
    const { state, outcome } = releaseDrag(s, 'drop')
    expect(outcome).toEqual({ kind: 'target', target: 'group:g' })
    expect(state).toEqual(DROP_IDLE)
  })

  it('drag out: a slot among the loose cards opens after the dwell and the drop lands there', () => {
    let s = beginDrag('g')
    expect(homeOf(s)).toBe('g')
    s = hoverDrag(s, between(null, 2), 100, SLOW)
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
    let s = beginDrag(null)
    s = hoverDrag(s, over('group:g'), 0, SLOW)
    expect(s.target).toBe('group:g')
    s = hoverDrag(s, nothing(s), 16, SLOW)
    expect(s.target).toBeNull()
    expect(s.pending).toBeNull()
    // Off the grid altogether says the same, and also forgets a slot on its way in.
    s = hoverDrag(s, between(null, 1), 32, SLOW)
    s = hoverDrag(s, over('card:x'), 48, SLOW)
    s = leaveDrag(s)
    expect(s.target).toBeNull()
    expect(s.pending).toBeNull()
    expect(s.phase).toBe('dragging')
  })

  it('cancel mid-hover: idle at once, nothing kept, and the card goes back', () => {
    let s = beginDrag(null)
    s = hoverDrag(s, over('group:g'), 0, SLOW)
    s = hoverDrag(s, between('g', 0), 10, SLOW)
    const { state, outcome } = releaseDrag(s, 'cancel')
    expect(outcome).toEqual({ kind: 'cancelled' })
    expect(state).toEqual(DROP_IDLE)
    // A cancelled machine ignores whatever arrives late.
    expect(hoverDrag(state, over('group:g'), 20, SLOW)).toEqual(DROP_IDLE)
    expect(elapseDrag(state, 1000)).toEqual(DROP_IDLE)
    expect(releaseDrag(state, 'drop').outcome).toEqual({ kind: 'unchanged' })
  })

  it('fling out: a release before the dwell commits the slot the finger is at', () => {
    let s = beginDrag('g')
    s = hoverDrag(s, between(null, 0), 0, FAST)
    expect(s.slot).toBeNull()
    expect(s.pending).toEqual({ slot: { folderId: null, index: 0 }, since: 0 })
    const { state, outcome } = releaseDrag(s, 'drop')
    expect(outcome).toEqual({ kind: 'slot', slot: { folderId: null, index: 0 } })
    expect(state).toEqual(DROP_IDLE)
  })

  it('drop on nothing: a gutter changes nothing, and so does a target the finger left', () => {
    let s = beginDrag(null)
    s = hoverDrag(s, nothing(s), 0, SLOW)
    expect(releaseDrag(s, 'drop').outcome).toEqual({ kind: 'unchanged' })
    s = hoverDrag(s, over('card:x'), 10, SLOW)
    s = hoverDrag(s, nothing(s), 20, SLOW)
    expect(releaseDrag(s, 'drop').outcome).toEqual({ kind: 'unchanged' })
    // An applied slot is where the card is shown: dropping in a gutter keeps it there.
    s = settleAt(beginDrag(null), between(null, 3), 0)
    s = hoverDrag(s, nothing(s), 500, SLOW)
    expect(releaseDrag(s, 'drop').outcome).toEqual({
      kind: 'slot',
      slot: { folderId: null, index: 3 }
    })
  })

  it('drop on the same group: a card is no target for the group it is shown in', () => {
    let s = beginDrag('g')
    s = hoverDrag(s, over('group:g'), 0, SLOW)
    expect(s.target).toBeNull()
    expect(releaseDrag(s, 'drop').outcome).toEqual({ kind: 'unchanged' })
    // Another group is a target as usual…
    s = hoverDrag(s, over('group:h'), 10, SLOW)
    expect(s.target).toBe('group:h')
    // …and once the stand-in has moved out, the old group is a target again (the card rejoins).
    s = settleAt(beginDrag('g'), between(null, 1), 0)
    s = hoverDrag(s, over('group:g'), 500, SLOW)
    expect(s.target).toBe('group:g')
    expect(releaseDrag(s, 'drop').outcome).toEqual({ kind: 'target', target: 'group:g' })
  })

  it('a slot opening inside a group the finger targets drops the ring on that group', () => {
    let s = beginDrag(null)
    s = hoverDrag(s, over('group:g'), 0, SLOW)
    s = hoverDrag(s, between('g', 1), 10, SLOW)
    s = hoverDrag(s, { target: 'group:g', slot: { folderId: 'g', index: 1 } }, 20, SLOW)
    s = elapseDrag(s, 20 + SLOT_DWELL_MS)
    expect(s.slot).toEqual({ folderId: 'g', index: 1 })
    expect(s.target).toBeNull()
  })

  it('rapid re-entry: leaving and coming back re-targets at once and restarts the dwell cleanly', () => {
    let s = beginDrag(null)
    s = hoverDrag(s, over('group:g'), 0, SLOW)
    s = hoverDrag(s, nothing(s), 8, SLOW)
    s = hoverDrag(s, over('group:g'), 16, SLOW)
    expect(s.target).toBe('group:g')
    // Slot A, then B before A's dwell, then A again: A waits its full dwell from the return.
    s = hoverDrag(s, between(null, 0), 100, SLOW)
    s = hoverDrag(s, between(null, 1), 150, SLOW)
    s = hoverDrag(s, between(null, 0), 160, SLOW)
    expect(s.pending).toEqual({ slot: { folderId: null, index: 0 }, since: 160 })
    s = elapseDrag(s, 100 + SLOT_DWELL_MS)
    expect(s.slot).toBeNull()
    s = elapseDrag(s, 160 + SLOT_DWELL_MS)
    expect(s.slot).toEqual({ folderId: null, index: 0 })
  })

  it('the dwell counts from the moment the finger slows down', () => {
    let s = beginDrag(null)
    s = hoverDrag(s, between(null, 2), 0, FAST)
    s = hoverDrag(s, between(null, 2), 100, FAST)
    expect(s.pending?.since).toBe(100)
    s = hoverDrag(s, between(null, 2), 120, SLOW)
    expect(s.pending?.since).toBe(100)
    expect(s.slot).toBeNull()
    s = hoverDrag(s, between(null, 2), 100 + SLOT_DWELL_MS, SLOW)
    expect(s.slot).toEqual({ folderId: null, index: 2 })
    // Back on the slot it is shown in: nothing is pending.
    expect(hoverDrag(s, between(null, 2), 400, SLOW).pending).toBeNull()
  })
})
