import { describe, expect, it } from 'vitest'
import { findCounter } from '../utils'

describe('findCounter', () => {
  it('shows nothing while the field is empty, whatever the last result was', () => {
    expect(findCounter('', null)).toBe('')
    expect(findCounter('', { activeMatchOrdinal: 2, matches: 5 })).toBe('')
  })

  it('reads n/m like Chrome, 0/0 for a miss or before the first result', () => {
    expect(findCounter('tea', { activeMatchOrdinal: 2, matches: 5 })).toBe('2/5')
    expect(findCounter('tea', { activeMatchOrdinal: 3, matches: 17 })).toBe('3/17')
    expect(findCounter('tea', { activeMatchOrdinal: 0, matches: 0 })).toBe('0/0')
    expect(findCounter('tea', null)).toBe('0/0')
  })
})
