import { describe, expect, it } from 'vitest'
import { foldedCardHeight, mosaicOf, parseAspect } from '../groupMosaic'

describe('mosaicOf (cleanup spec §2: the folded group card)', () => {
  it('shows every member up to four', () => {
    expect(mosaicOf([])).toEqual({ tiles: [], more: 0 })
    expect(mosaicOf(['a'])).toEqual({ tiles: ['a'], more: 0 })
    expect(mosaicOf(['a', 'b', 'c', 'd'])).toEqual({ tiles: ['a', 'b', 'c', 'd'], more: 0 })
  })

  it('past four shows the first three and names the rest in the fourth tile', () => {
    expect(mosaicOf(['a', 'b', 'c', 'd', 'e'])).toEqual({ tiles: ['a', 'b', 'c'], more: 2 })
    expect(mosaicOf(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toEqual({
      tiles: ['a', 'b', 'c'],
      more: 4
    })
  })

  it('does not hand back the caller’s array', () => {
    const members = ['a', 'b']
    expect(mosaicOf(members).tiles).not.toBe(members)
  })
})

describe('parseAspect', () => {
  it('reads a ratio, a bare number, and nothing else', () => {
    expect(parseAspect('3 / 4')).toBeCloseTo(0.75)
    expect(parseAspect('1280/800')).toBeCloseTo(1.6)
    expect(parseAspect('1.5')).toBe(1.5)
    expect(parseAspect('')).toBeNull()
    expect(parseAspect(null)).toBeNull()
    expect(parseAspect(undefined)).toBeNull()
    expect(parseAspect('auto')).toBeNull()
    expect(parseAspect('0 / 4')).toBeNull()
    expect(parseAspect('3 / 0')).toBeNull()
    expect(parseAspect('1 / 2 / 3')).toBeNull()
  })
})

describe('foldedCardHeight', () => {
  it('is the cell’s height at the card aspect, never under the header', () => {
    expect(foldedCardHeight(150, '3 / 4', 44)).toBe(200)
    expect(foldedCardHeight(320, '1280 / 800', 44)).toBe(200)
    expect(foldedCardHeight(30, '3 / 4', 44)).toBe(44)
  })

  it('answers the header before layout or without an aspect', () => {
    expect(foldedCardHeight(0, '3 / 4', 44)).toBe(44)
    expect(foldedCardHeight(150, '', 44)).toBe(44)
    expect(foldedCardHeight(150, undefined, 44)).toBe(44)
  })
})
