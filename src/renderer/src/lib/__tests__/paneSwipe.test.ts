import { describe, expect, it } from 'vitest'
import {
  PANE_SWIPE_COMMIT_FRACTION,
  PANE_SWIPE_EDGE_GUTTER,
  PANE_SWIPE_FLING_VELOCITY,
  PANE_SWIPE_SLOP,
  PaneSwipeSession,
  paneSwipeDirection,
  paneSwipeMayStart,
  paneSwipeNeighbour,
  paneSwipeProgress,
  paneSwipeSettles
} from '../gestures/paneSwipe'

/**
 * The switcher's pane swipe (GN-19), the pure part. Chrome's numbers are the Hub's
 * (`HubPaneSwipeGestureHandler.java`: a third of the width, the 32 dp gutters, the platform's
 * 8 dp slop and 50 dp/s minimum fling), read into `paneSwipe.ts`'s header.
 */
const PANES = ['tabs', 'groups', 'private'] as const
type Pane = (typeof PANES)[number]
const WIDTH = 360

describe('the figures', () => {
  it('are Chrome’s: a third of the width, 32 dp gutters, 8 dp slop, 50 dp/s fling', () => {
    expect(PANE_SWIPE_COMMIT_FRACTION).toBeCloseTo(1 / 3)
    expect(PANE_SWIPE_EDGE_GUTTER).toBe(32)
    expect(PANE_SWIPE_SLOP).toBe(8)
    expect(PANE_SWIPE_FLING_VELOCITY).toBe(50)
  })
})

describe('paneSwipeMayStart', () => {
  it('refuses the edge gutters, where a touch is the system’s back gesture', () => {
    expect(paneSwipeMayStart(10, WIDTH)).toBe(false)
    expect(paneSwipeMayStart(32, WIDTH)).toBe(false)
    expect(paneSwipeMayStart(33, WIDTH)).toBe(true)
    expect(paneSwipeMayStart(WIDTH - 33, WIDTH)).toBe(true)
    expect(paneSwipeMayStart(WIDTH - 32, WIDTH)).toBe(false)
    expect(paneSwipeMayStart(WIDTH - 5, WIDTH)).toBe(false)
  })

  it('refuses a pane with no width yet', () => {
    expect(paneSwipeMayStart(100, 0)).toBe(false)
  })
})

describe('paneSwipeDirection', () => {
  it('is undecided under the slop either way', () => {
    expect(paneSwipeDirection(0, 0)).toBeNull()
    expect(paneSwipeDirection(8, 0)).toBeNull()
    expect(paneSwipeDirection(-8, 3)).toBeNull()
    expect(paneSwipeDirection(2, -8)).toBeNull()
  })

  it('locks horizontal once past the slop with the horizontal winning', () => {
    expect(paneSwipeDirection(-9, 0)).toBe('left')
    expect(paneSwipeDirection(9, 0)).toBe('right')
    expect(paneSwipeDirection(-20, 19)).toBe('left')
    expect(paneSwipeDirection(20, -19)).toBe('right')
  })

  it('hands a vertical-first move to the scroller, a diagonal tie included', () => {
    expect(paneSwipeDirection(0, 9)).toBe('vertical')
    expect(paneSwipeDirection(5, -12)).toBe('vertical')
    expect(paneSwipeDirection(12, 12)).toBe('vertical')
  })
})

describe('paneSwipeNeighbour', () => {
  it('reads the switcher’s order: a swipe left reaches the next pane, a swipe right the one before', () => {
    expect(paneSwipeNeighbour(PANES, 'tabs', 'left')).toBe('groups')
    expect(paneSwipeNeighbour(PANES, 'groups', 'left')).toBe('private')
    expect(paneSwipeNeighbour(PANES, 'groups', 'right')).toBe('tabs')
    expect(paneSwipeNeighbour(PANES, 'private', 'right')).toBe('groups')
  })

  it('has nothing past either end, and nothing for a pane not in the order', () => {
    expect(paneSwipeNeighbour(PANES, 'tabs', 'right')).toBeNull()
    expect(paneSwipeNeighbour(PANES, 'private', 'left')).toBeNull()
    expect(paneSwipeNeighbour(['tabs', 'groups'] as readonly Pane[], 'groups', 'left')).toBeNull()
    expect(paneSwipeNeighbour(['tabs', 'groups'] as readonly Pane[], 'private', 'left')).toBeNull()
  })
})

describe('paneSwipeProgress', () => {
  it('is the displacement over the width, clamped to the locked direction', () => {
    expect(paneSwipeProgress(-90, WIDTH, 'left')).toBeCloseTo(0.25)
    expect(paneSwipeProgress(90, WIDTH, 'right')).toBeCloseTo(0.25)
    expect(paneSwipeProgress(-WIDTH * 2, WIDTH, 'left')).toBe(1)
    expect(paneSwipeProgress(WIDTH * 2, WIDTH, 'right')).toBe(1)
  })

  it('reads a finger back past its origin as 0, never as a swipe the other way', () => {
    expect(paneSwipeProgress(40, WIDTH, 'left')).toBe(0)
    expect(paneSwipeProgress(-40, WIDTH, 'right')).toBe(0)
  })

  it('is 0 without a width', () => {
    expect(paneSwipeProgress(-100, 0, 'left')).toBe(0)
  })
})

describe('paneSwipeSettles', () => {
  const still = { vx: 0, vy: 0, width: WIDTH }

  it('a slow release switches once past a third of the width, not before', () => {
    expect(paneSwipeSettles({ ...still, dx: -119, direction: 'left' })).toBe(false)
    expect(paneSwipeSettles({ ...still, dx: -121, direction: 'left' })).toBe(true)
    expect(paneSwipeSettles({ ...still, dx: 121, direction: 'right' })).toBe(true)
  })

  it('a fling onward switches at any distance', () => {
    expect(paneSwipeSettles({ ...still, dx: -20, vx: -60, direction: 'left' })).toBe(true)
    expect(paneSwipeSettles({ ...still, dx: 20, vx: 60, direction: 'right' })).toBe(true)
  })

  it('a fling back cancels even past the third', () => {
    expect(paneSwipeSettles({ ...still, dx: -200, vx: 80, direction: 'left' })).toBe(false)
    expect(paneSwipeSettles({ ...still, dx: 200, vx: -80, direction: 'right' })).toBe(false)
  })

  it('a fling is horizontal: a faster vertical speed makes it no fling, and the distance decides', () => {
    expect(paneSwipeSettles({ ...still, dx: -20, vx: -60, vy: 90, direction: 'left' })).toBe(false)
    expect(paneSwipeSettles({ ...still, dx: -200, vx: 80, vy: 120, direction: 'left' })).toBe(true)
  })

  it('a speed at the minimum is no fling yet', () => {
    expect(paneSwipeSettles({ ...still, dx: -20, vx: -50, direction: 'left' })).toBe(false)
    expect(paneSwipeSettles({ ...still, dx: -20, vx: -51, direction: 'left' })).toBe(true)
  })
})

describe('PaneSwipeSession', () => {
  const session = (current: Pane = 'tabs'): PaneSwipeSession<Pane> =>
    new PaneSwipeSession<Pane>(PANES, current, WIDTH, 180, 300, 0)

  it('is pending under the slop, then claims the first horizontal move with a neighbour, direction locked', () => {
    const s = session()
    expect(s.move(175, 302, 16)).toEqual({ kind: 'pending' })
    expect(s.dragging).toBe(false)
    expect(s.move(160, 303, 32)).toEqual({
      kind: 'claimed',
      direction: 'left',
      neighbour: 'groups',
      progress: 20 / WIDTH
    })
    expect(s.dragging).toBe(true)
    expect(s.target).toEqual({ direction: 'left', neighbour: 'groups' })
    expect(s.move(90, 310, 48)).toEqual({ kind: 'dragging', progress: 90 / WIDTH })
    // Back past the origin: the drag reads 0, the lock holds.
    expect(s.move(200, 310, 64)).toEqual({ kind: 'dragging', progress: 0 })
    expect(s.target).toEqual({ direction: 'left', neighbour: 'groups' })
    expect(s.progress).toBe(0)
    s.move(108, 310, 80)
    expect(s.progress).toBeCloseTo(0.2)
  })

  it('declines a vertical-first move for good', () => {
    const s = session()
    expect(s.move(182, 320, 16)).toEqual({ kind: 'declined', reason: 'vertical' })
    expect(s.move(100, 320, 32)).toEqual({ kind: 'declined', reason: 'vertical' })
    expect(s.dragging).toBe(false)
    expect(s.release(48)).toBeNull()
  })

  it('declines a swipe with nothing that way for good', () => {
    const s = session('tabs')
    expect(s.move(200, 300, 16)).toEqual({ kind: 'declined', reason: 'no-neighbour' })
    expect(s.move(100, 300, 32)).toEqual({ kind: 'declined', reason: 'no-neighbour' })
    expect(s.release(48)).toBeNull()
    const last = session('private')
    expect(last.move(160, 300, 16)).toEqual({ kind: 'declined', reason: 'no-neighbour' })
  })

  it('a release short of the third with the finger at rest returns to the pane', () => {
    const s = session()
    s.move(160, 300, 16)
    s.move(120, 300, 100)
    s.move(120, 300, 300)
    expect(s.release(500)).toEqual({
      commit: false,
      neighbour: 'groups',
      direction: 'left',
      progress: 60 / WIDTH,
      velocity: 0
    })
  })

  it('a release past the third switches', () => {
    const s = session('groups')
    s.move(200, 300, 16)
    s.move(320, 300, 200)
    s.move(320, 300, 400)
    expect(s.release(600)).toEqual({
      commit: true,
      neighbour: 'tabs',
      direction: 'right',
      progress: 140 / WIDTH,
      velocity: 0
    })
  })

  it('a fling onward switches from a short distance; a fling back cancels from a long one', () => {
    const flung = session()
    flung.move(160, 300, 16)
    flung.move(140, 300, 32)
    flung.move(120, 300, 48)
    const onward = flung.release(48)
    expect(onward?.commit).toBe(true)
    // 20 px per 16 ms towards the neighbour: the settle carries on from about 3.5 widths a second.
    expect(onward?.velocity).toBeGreaterThan(3)
    // Half the width to the left, then the last 100 ms moving back right: still past the third,
    // but the fling reads backwards, so it cancels.
    const back = session()
    back.move(160, 300, 16)
    back.move(100, 300, 48)
    back.move(0, 300, 96)
    back.move(10, 300, 120)
    back.move(20, 300, 150)
    back.move(30, 300, 180)
    back.move(40, 300, 210)
    const backwards = back.release(210)
    expect(backwards).toMatchObject({ commit: false, progress: 140 / WIDTH })
    expect(backwards?.velocity).toBeLessThan(0)
  })

  it('a release before any move is nothing', () => {
    expect(session().release(16)).toBeNull()
  })
})
