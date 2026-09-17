import { describe, expect, it } from 'vitest'
import { findCounter } from '../utils'

describe('findCounter', () => {
  it('shows nothing while the field is empty, whatever the last result was', () => {
    expect(findCounter('', null, false)).toBe('')
    expect(findCounter('', { activeMatchOrdinal: 2, matches: 5 }, false)).toBe('')
    expect(findCounter('', { activeMatchOrdinal: 2, matches: 5 }, true)).toBe('')
  })

  it('reads n of m on desktop and names the miss', () => {
    expect(findCounter('tea', { activeMatchOrdinal: 2, matches: 5 }, false)).toBe('2 of 5')
    expect(findCounter('tea', { activeMatchOrdinal: 0, matches: 0 }, false)).toBe(
      'Phrase not found'
    )
    expect(findCounter('tea', null, false)).toBe('Phrase not found')
  })

  it('is a compact n/m on the phone, 0/0 for a miss or before the first result', () => {
    expect(findCounter('tea', { activeMatchOrdinal: 2, matches: 5 }, true)).toBe('2/5')
    expect(findCounter('tea', { activeMatchOrdinal: 0, matches: 0 }, true)).toBe('0/0')
    expect(findCounter('tea', null, true)).toBe('0/0')
  })
})
