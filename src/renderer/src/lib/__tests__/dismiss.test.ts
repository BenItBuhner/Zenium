import { describe, expect, it } from 'vitest'
import {
  DISMISS_SLOP,
  allowedAlong,
  dismissPresence,
  dismissSign,
  dragAxis,
  dragOffset,
  type DismissDirections
} from '../gestures/dismiss'
import { SWIPE_THRESHOLDS } from '../gestures/swipe'

/** A toast: down, or off to either side. */
const TOAST: DismissDirections = { x: [-1, 1], y: [1] }
/** A banner: up, or off to either side. */
const BANNER: DismissDirections = { x: [-1, 1], y: [-1] }

const {
  flingVelocity: FLING,
  commitFraction: COMMIT,
  projectionSeconds: PROJECTION
} = SWIPE_THRESHOLDS

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

  it('lets go where the tab and row swipes do: the shared thresholds, not a set of its own', () => {
    // v2 §9.33: one set for every dismissible card in the app.
    expect(SWIPE_THRESHOLDS).toEqual({
      flingVelocity: 450,
      commitFraction: 0.45,
      projectionSeconds: 0.12
    })
    // The default is that set; the same call with it spelled out decides the same.
    for (const velocity of [0, 200, 449, 450, -450, 900]) {
      for (const offset of [0, 10, 22, 24, 30, 60]) {
        expect(dismissSign(offset, velocity, extent, 'y', TOAST)).toBe(
          dismissSign(offset, velocity, extent, 'y', TOAST, SWIPE_THRESHOLDS)
        )
      }
    }
    // A stricter set given explicitly is honoured: the shared one is a default, not a constant.
    const strict = { flingVelocity: 2000, commitFraction: 0.9, projectionSeconds: 0 }
    expect(dismissSign(30, 600, extent, 'y', TOAST)).toBe(1)
    expect(dismissSign(30, 600, extent, 'y', TOAST, strict)).toBe(0)
  })

  it('a fling in a permitted direction commits from anywhere', () => {
    expect(dismissSign(2, FLING, extent, 'y', TOAST)).toBe(1)
    expect(dismissSign(-2, -FLING, extent, 'x', TOAST)).toBe(-1)
    expect(dismissSign(-2, -FLING, extent, 'y', BANNER)).toBe(-1)
    // A hair under the fling speed is a slow release, judged by where it is projected to be:
    // from 40 px on the closed side, 449 px/s projects 14 px out, short of the line; 450 goes.
    expect(dismissSign(-40, FLING - 1, extent, 'y', TOAST)).toBe(0)
    expect(dismissSign(-40, FLING, extent, 'y', TOAST)).toBe(1)
  })

  it('a fling the wrong way goes back to the slot', () => {
    expect(dismissSign(-10, -FLING * 2, extent, 'y', TOAST)).toBe(0)
    expect(dismissSign(10, FLING * 2, extent, 'y', BANNER)).toBe(0)
  })

  it('a slow release commits past .45 of the card and returns before it', () => {
    const commit = COMMIT * extent
    expect(commit).toBeCloseTo(23.4)
    expect(dismissSign(commit + 1, 0, extent, 'y', TOAST)).toBe(1)
    expect(dismissSign(commit - 1, 0, extent, 'y', TOAST)).toBe(0)
    expect(dismissSign(-(commit + 1), 0, extent, 'x', BANNER)).toBe(-1)
    // Barely moved and drifting: back it goes.
    expect(dismissSign(1, 100, extent, 'y', TOAST)).toBe(0)
  })

  it('projects a slow release .12 s ahead', () => {
    const commit = COMMIT * extent
    // 15 px short of the line, drifting at 200 px/s: the projection (24 px) carries it over…
    expect(200 * PROJECTION).toBeCloseTo(24)
    expect(dismissSign(commit - 15, 200, extent, 'y', TOAST)).toBe(1)
    // …drifting at 100 px/s (12 px) it does not, and drifting back it never does.
    expect(dismissSign(commit - 15, 100, extent, 'y', TOAST)).toBe(0)
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
