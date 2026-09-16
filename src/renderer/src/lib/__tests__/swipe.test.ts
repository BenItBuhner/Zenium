import { describe, expect, it } from 'vitest'
import { dragPosition, rubberBand, settleTarget } from '../gestures/swipe'

const extent = 400
const track = { extent, min: 0, max: 4, origin: 1 }

describe('settleTarget', () => {
  it('a slow release commits once the finger crossed the commit fraction', () => {
    expect(settleTarget({ ...track, position: 1.3, velocity: 0 })).toBe(1)
    expect(settleTarget({ ...track, position: 1.6, velocity: 0 })).toBe(2)
    expect(settleTarget({ ...track, position: 0.7, velocity: 0 })).toBe(1)
  })

  it('is symmetric: the same distance commits towards the previous tab', () => {
    expect(settleTarget({ ...track, position: 0.5, velocity: 0 })).toBe(0)
    expect(settleTarget({ ...track, position: 0.6, velocity: 0 })).toBe(1)
    expect(settleTarget({ ...track, position: 1.5, velocity: 0 })).toBe(2)
  })

  it('projects a slow velocity into the decision', () => {
    // 1.4 pages + 200 px/s * 0.12 s / 400 px = 1.46 → commits
    expect(settleTarget({ ...track, position: 1.4, velocity: 200 })).toBe(2)
    // Moving back cancels an otherwise committed drag.
    expect(settleTarget({ ...track, position: 1.5, velocity: -300 })).toBe(1)
  })

  it('a fling commits regardless of distance – in its own direction', () => {
    expect(settleTarget({ ...track, position: 1.1, velocity: 900 })).toBe(2)
    expect(settleTarget({ ...track, position: 0.9, velocity: -900 })).toBe(0)
  })

  it('flinging back over the page you dragged towards cancels (mid-gesture reversal)', () => {
    // Dragged 80% of the way to tab 2, then flicked back: land on tab 1 again.
    expect(settleTarget({ ...track, position: 1.8, velocity: -700 })).toBe(1)
    // Dragged 20% towards tab 0, flicked forward: back to tab 1.
    expect(settleTarget({ ...track, position: 0.8, velocity: 700 })).toBe(1)
  })

  it('a fling from rest on a page moves exactly one page', () => {
    expect(settleTarget({ ...track, position: 1, velocity: 1200 })).toBe(2)
    expect(settleTarget({ ...track, position: 1, velocity: -1200 })).toBe(0)
  })

  it('a drag caught mid-flight is measured from the page it was leaving', () => {
    // Caught at 1.6 while settling towards 2 (origin 2), dragged back to 1.4, released slowly.
    expect(settleTarget({ ...track, origin: 2, position: 1.4, velocity: 0 })).toBe(1)
    expect(settleTarget({ ...track, origin: 2, position: 1.7, velocity: 0 })).toBe(2)
    // Carried on past the next page: land on the page nearest to where the finger let go.
    expect(settleTarget({ ...track, origin: 3, position: 1.2, velocity: 0 })).toBe(1)
  })

  it('never leaves the track', () => {
    expect(settleTarget({ ...track, origin: 4, position: 4, velocity: 2000 })).toBe(4)
    expect(settleTarget({ ...track, origin: 0, position: 0, velocity: -2000 })).toBe(0)
    // Rubber-banded past the end and released: snaps back to the last page.
    expect(settleTarget({ ...track, origin: 4, position: 4.3, velocity: 100 })).toBe(4)
    expect(settleTarget({ ...track, origin: 0, position: -0.2, velocity: 0 })).toBe(0)
  })

  it('the overview track (closed = 0, open = 1) follows the same rules', () => {
    const sheet = { extent: 320, min: 0, max: 1 }
    expect(settleTarget({ ...sheet, origin: 0, position: 0.3, velocity: 0 })).toBe(0)
    expect(settleTarget({ ...sheet, origin: 0, position: 0.3, velocity: 800 })).toBe(1)
    expect(settleTarget({ ...sheet, origin: 0, position: 0.7, velocity: 0 })).toBe(1)
    expect(settleTarget({ ...sheet, origin: 1, position: 0.7, velocity: -800 })).toBe(0)
    // Pushing the open overview down by less than half brings it back.
    expect(settleTarget({ ...sheet, origin: 1, position: 0.6, velocity: 0 })).toBe(1)
    expect(settleTarget({ ...sheet, origin: 1, position: 0.5, velocity: 0 })).toBe(0)
  })
})

describe('rubberBand', () => {
  it('follows the finger less and less and never exceeds the extent', () => {
    const a = rubberBand(50, extent)
    const b = rubberBand(200, extent)
    const c = rubberBand(5000, extent)
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThan(50)
    expect(b - a).toBeLessThan(150)
    expect(c).toBeLessThan(extent)
    expect(rubberBand(-200, extent)).toBeCloseTo(-b)
    expect(rubberBand(0, extent)).toBe(0)
  })
})

describe('dragPosition', () => {
  it('moves one page per extent of finger travel', () => {
    expect(dragPosition(1, 400, extent, 0, 4)).toBe(2)
    expect(dragPosition(1, -200, extent, 0, 4)).toBe(0.5)
  })

  it('resists beyond the first and last page', () => {
    const past = dragPosition(4, 300, extent, 0, 4)
    expect(past).toBeGreaterThan(4)
    expect(past).toBeLessThan(4.75)
    const before = dragPosition(0, -300, extent, 0, 4)
    expect(before).toBeLessThan(0)
    expect(before).toBeGreaterThan(-0.75)
  })

  it('a drag that started mid-flight continues from where the finger caught the track', () => {
    expect(dragPosition(1.6, -40, extent, 0, 4)).toBeCloseTo(1.5)
  })
})
