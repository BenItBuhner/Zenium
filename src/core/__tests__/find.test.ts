import { describe, expect, it } from 'vitest'
import { FindMemory, SELECTION_QUERY_MAX, selectionQuery } from '../find'

describe('find memory', () => {
  it('starts empty and remembers the last query per tab', () => {
    const m = new FindMemory()
    expect(m.queryFor('a')).toBe('')
    m.remember('a', 'tea')
    m.remember('b', 'coffee')
    expect(m.queryFor('a')).toBe('tea')
    expect(m.queryFor('b')).toBe('coffee')
  })

  it('gives a tab that never searched the profile-wide last query, as Chrome does', () => {
    const m = new FindMemory()
    m.remember('a', 'tea')
    expect(m.queryFor('new')).toBe('tea')
    m.remember('b', 'coffee')
    expect(m.queryFor('new')).toBe('coffee')
    // A tab's own query wins over a later search elsewhere.
    expect(m.queryFor('a')).toBe('tea')
  })

  it('ignores the bar emptying and keeps the profile query when a tab closes', () => {
    const m = new FindMemory()
    m.remember('a', 'tea')
    m.remember('a', '')
    expect(m.queryFor('a')).toBe('tea')
    m.forget('a')
    expect(m.queryFor('a')).toBe('tea')
    expect(m.queryFor('b')).toBe('tea')
  })
})

describe('selection as a find query', () => {
  it('takes a short single-line selection, trimmed and with whitespace collapsed', () => {
    expect(selectionQuery('  find   me ')).toBe('find me')
    expect(selectionQuery('word')).toBe('word')
  })

  it('refuses passages, empty selections and anything that is not text', () => {
    expect(selectionQuery('two\nlines')).toBe('')
    expect(selectionQuery('  \n ')).toBe('')
    expect(selectionQuery('')).toBe('')
    expect(selectionQuery(undefined)).toBe('')
    expect(selectionQuery(42)).toBe('')
    expect(selectionQuery('x'.repeat(SELECTION_QUERY_MAX))).toHaveLength(SELECTION_QUERY_MAX)
    expect(selectionQuery('x'.repeat(SELECTION_QUERY_MAX + 1))).toBe('')
  })
})
