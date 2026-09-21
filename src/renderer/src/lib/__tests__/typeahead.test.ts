import { describe, expect, it } from 'vitest'
import { TYPEAHEAD_RESET_MS, typeaheadExtend, typeaheadKey, typeaheadMatch } from '../typeahead'

/*
 * The listbox type-ahead of the menulist popup (v2 draft §9.13, §9.22): Chromium's `TypeAhead`
 * rules – a one-second search buffer, a repeated letter cycling, a longer prefix staying put.
 */

const LANGUAGES = ['Danish', 'Dutch', 'English', 'Estonian', 'French', ' German', 'Spanish']

describe('typeaheadKey', () => {
  it('is one printable character with no Control, Alt or Command', () => {
    const key = (
      k: string,
      mods: Partial<Record<'ctrlKey' | 'altKey' | 'metaKey', boolean>> = {}
    ): string | null =>
      typeaheadKey({ key: k, ctrlKey: false, altKey: false, metaKey: false, ...mods })
    expect(key('d')).toBe('d')
    expect(key('É')).toBe('É')
    expect(key('ArrowDown')).toBeNull()
    expect(key(' ')).toBeNull()
    expect(key('d', { ctrlKey: true })).toBeNull()
    expect(key('d', { altKey: true })).toBeNull()
    expect(key('d', { metaKey: true })).toBeNull()
  })
})

describe('typeaheadExtend', () => {
  it('extends the search within a second of the last key and begins again after', () => {
    const first = typeaheadExtend(null, 'd', 1000)
    expect(first).toEqual({ text: 'd', at: 1000 })
    expect(typeaheadExtend(first, 'u', 1000 + TYPEAHEAD_RESET_MS)).toEqual({
      text: 'du',
      at: 1000 + TYPEAHEAD_RESET_MS
    })
    expect(typeaheadExtend(first, 'u', 1000 + TYPEAHEAD_RESET_MS + 1)).toEqual({
      text: 'u',
      at: 1000 + TYPEAHEAD_RESET_MS + 1
    })
  })
})

describe('typeaheadMatch', () => {
  it('one letter goes to the first option starting with it after the cursor, round to the first', () => {
    expect(typeaheadMatch(LANGUAGES, 'd', -1)).toBe(0)
    expect(typeaheadMatch(LANGUAGES, 'd', 0)).toBe(1)
    expect(typeaheadMatch(LANGUAGES, 'e', 1)).toBe(2)
    // From the last option the search wraps.
    expect(typeaheadMatch(LANGUAGES, 'd', 6)).toBe(0)
  })

  it('the same letter again cycles through the options starting with it', () => {
    expect(typeaheadMatch(LANGUAGES, 'dd', 0)).toBe(1)
    expect(typeaheadMatch(LANGUAGES, 'ddd', 1)).toBe(0)
  })

  it('a longer prefix starts at the cursor, so typing on stays on a match that still holds', () => {
    // "e" landed on English; "es" leaves it for Estonian, "en" would have stayed.
    expect(typeaheadMatch(LANGUAGES, 'es', 2)).toBe(3)
    expect(typeaheadMatch(LANGUAGES, 'en', 2)).toBe(2)
    expect(typeaheadMatch(LANGUAGES, 'du', 0)).toBe(1)
  })

  it('ignores case and a label’s leading spaces, skips options the keys skip, and finds nothing for a miss', () => {
    expect(typeaheadMatch(LANGUAGES, 'G', -1)).toBe(5)
    expect(typeaheadMatch(LANGUAGES, 'sp', -1)).toBe(6)
    expect(typeaheadMatch(['Danish', null, 'Dutch'], 'd', 0)).toBe(2)
    expect(typeaheadMatch(LANGUAGES, 'x', -1)).toBeNull()
    expect(typeaheadMatch(LANGUAGES, '', 2)).toBeNull()
    expect(typeaheadMatch([], 'd', -1)).toBeNull()
  })
})
