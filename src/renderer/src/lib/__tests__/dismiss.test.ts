import { describe, expect, it } from 'vitest'
import {
  DISMISS_COMMIT_FRACTION,
  DISMISS_FLING_VELOCITY,
  DISMISS_SLOP,
  allowedAlong,
  dismissPresence,
  dismissSign,
  dragAxis,
  dragOffset,
  type DismissDirections
} from '../gestures/dismiss'

/** A toast: down, or off to either side. */
const TOAST: DismissDirections = { x: [-1, 1], y: [1] }
/** A banner: up, or off to either side. */
const BANNER: DismissDirections = { x: [-1, 1], y: [-1] }

describe('drag axis', () => {
  it('is undecided inside the slop circle and follows the dominant direction outside it', () => {
    expect(dragAxis(3, 4)).toBeNull()
    expect(dragAxis(DISMISS_SLOP - 1, 0)).toBeNull()
    expect(dragAxis(DISMISS_SLOP, 0)).toBe('x')
    expect(dragAxis(0, -DISMISS_SLOP)).toBe('y')
    expect(dragAxis(10, -12)).toBe('y')
    expect(dragAxis(-12, 10)).toBe('x')
  })
})

describe('directions', () => {
  it('lets a toast go down and sideways, a banner up and sideways', () => {
    expect(allowedAlong(20, 'y', TOAST)).toBe(true)
    expect(allowedAlong(-20, 'y', TOAST)).toBe(false)
    expect(allowedAlong(-20, 'y', BANNER)).toBe(true)
    expect(allowedAlong(20, 'y', BANNER)).toBe(false)
    expect(allowedAlong(-20, 'x', TOAST)).toBe(true)
    expect(allowedAlong(20, 'x', BANNER)).toBe(true)
    expect(allowedAlong(0, 'x', TOAST)).toBe(false)
  })

  it('follows the finger where the card may go and rubber-bands where it may not', () => {
    expect(dragOffset(80, 'y', TOAST)).toBe(80)
    expect(dragOffset(-80, 'x', TOAST)).toBe(-80)
    const held = dragOffset(-80, 'y', TOAST)
    expect(held).toBeLessThan(0)
    expect(Math.abs(held)).toBeLessThan(40)
    // Diminishing returns: each further 80 px gives less than the last.
    const a = Math.abs(dragOffset(-80, 'y', TOAST))
    const b = Math.abs(dragOffset(-160, 'y', TOAST)) - a
    const c = Math.abs(dragOffset(-240, 'y', TOAST)) - a - b
    expect(b).toBeLessThan(a)
    expect(c).toBeLessThan(b)
  })
})

describe('release', () => {
  const extent = 52

  it('a fling in a permitted direction commits from anywhere', () => {
    expect(dismissSign(2, DISMISS_FLING_VELOCITY, extent, 'y', TOAST)).toBe(1)
    expect(dismissSign(-2, -DISMISS_FLING_VELOCITY, extent, 'x', TOAST)).toBe(-1)
    expect(dismissSign(-2, -DISMISS_FLING_VELOCITY, extent, 'y', BANNER)).toBe(-1)
  })

  it('a fling the wrong way goes back to the slot', () => {
    expect(dismissSign(-10, -DISMISS_FLING_VELOCITY * 2, extent, 'y', TOAST)).toBe(0)
    expect(dismissSign(10, DISMISS_FLING_VELOCITY * 2, extent, 'y', BANNER)).toBe(0)
  })

  it('a slow release commits past the fraction of the card and returns before it', () => {
    const commit = DISMISS_COMMIT_FRACTION * extent
    expect(dismissSign(commit + 1, 0, extent, 'y', TOAST)).toBe(1)
    expect(dismissSign(commit - 1, 0, extent, 'y', TOAST)).toBe(0)
    expect(dismissSign(-(commit + 1), 0, extent, 'x', BANNER)).toBe(-1)
    // Barely moved and drifting: back it goes.
    expect(dismissSign(1, 100, extent, 'y', TOAST)).toBe(0)
  })

  it('projects a slow release a little ahead', () => {
    const commit = DISMISS_COMMIT_FRACTION * extent
    // 15 px short of the line, drifting at 200 px/s: the projection (20 px) carries it over.
    expect(dismissSign(commit - 15, 200, extent, 'y', TOAST)).toBe(1)
    expect(dismissSign(commit - 15, -200, extent, 'y', TOAST)).toBe(0)
  })
})

describe('presence', () => {
  it('is full in the slot and gone a reach away', () => {
    expect(dismissPresence(0, 60)).toBe(1)
    expect(dismissPresence(30, 60)).toBe(0.5)
    expect(dismissPresence(-30, 60)).toBe(0.5)
    expect(dismissPresence(90, 60)).toBe(0)
    expect(dismissPresence(10, 0)).toBe(1)
  })
})
