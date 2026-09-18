import { describe, expect, it } from 'vitest'
import { swipeOutcome, swipeRestTarget, swipeReveal } from '../gestures/swipeDelete'

const width = 380

describe('swipeOutcome', () => {
  it('a slow release past about half the row deletes, short of it springs home', () => {
    expect(swipeOutcome(0.2 * width, 0, width)).toBe('reset')
    expect(swipeOutcome(0.5 * width, 0, width)).toBe('delete')
    expect(swipeOutcome(-0.5 * width, 0, width)).toBe('delete')
  })

  it('a fling deletes from a short distance, in either direction', () => {
    expect(swipeOutcome(20, 900, width)).toBe('delete')
    expect(swipeOutcome(-20, -900, width)).toBe('delete')
  })

  it('flinging back over a long drag cancels it', () => {
    expect(swipeOutcome(0.6 * width, -900, width)).toBe('reset')
  })

  it('a row without a width never deletes', () => {
    expect(swipeOutcome(200, 2000, 0)).toBe('reset')
  })
})

describe('swipeRestTarget', () => {
  it('goes home on reset and off the moving edge on delete', () => {
    expect(swipeRestTarget('reset', 150, 800, width)).toBe(0)
    expect(swipeRestTarget('delete', 150, 800, width)).toBe(width)
    expect(swipeRestTarget('delete', -150, -800, width)).toBe(-width)
  })

  it('takes the fling direction when the row has not moved yet', () => {
    expect(swipeRestTarget('delete', 0, -900, width)).toBe(-width)
    expect(swipeRestTarget('delete', 0, 0, width)).toBe(width)
  })
})

describe('swipeReveal', () => {
  it('is full exactly where a slow release starts to delete', () => {
    expect(swipeReveal(0, width)).toBe(0)
    expect(swipeReveal(0.225 * width, width)).toBeCloseTo(0.5)
    expect(swipeReveal(0.45 * width, width)).toBeCloseTo(1)
    expect(swipeReveal(width, width)).toBe(1)
    expect(swipeReveal(-0.45 * width, width)).toBeCloseTo(1)
  })
})
