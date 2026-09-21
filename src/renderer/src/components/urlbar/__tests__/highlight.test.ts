import { describe, expect, it } from 'vitest'
import { matchRanges } from '../highlight'

/*
 * The bold match of the dropdown's rows (omnibox-21, Chrome's anatomy): a search row emphasises
 * its completion, every other row the typed words where they start a word; answers, the
 * clipboard row and zero-suggest carry none.
 */

describe('matchRanges: a search row emphasises what the engine adds', () => {
  it('sets the completion after the typed prefix', () => {
    expect(matchRanges('search', 'weather', 'wea')).toEqual([[3, 7]])
    expect(matchRanges('search', 'Weather Tomorrow', 'wea')).toEqual([[3, 16]])
  })

  it('leaves the typed text plain wherever it sits and emphasises the rest', () => {
    expect(matchRanges('search', 'cat food', 'food')).toEqual([[0, 4]])
    expect(matchRanges('search', 'hotdogs', 'dog')).toEqual([
      [0, 3],
      [6, 7]
    ])
  })

  it('emphasises the whole suggestion when the typed text is not in it, and nothing on the verbatim row', () => {
    expect(matchRanges('search', 'barack obama', 'president')).toEqual([[0, 12]])
    expect(matchRanges('search', 'cats', 'cats')).toEqual([])
    expect(matchRanges('search', 'Cats', 'cats ')).toEqual([])
  })

  it('treats an entity row as a search row and never emphasises the engine line', () => {
    expect(matchRanges('entity', 'Barack Obama', 'obama')).toEqual([[0, 7]])
    expect(matchRanges('search', 'Search with Google', 'wea', 'description')).toEqual([])
    expect(matchRanges('entity', '44th U.S. President', 'obama', 'description')).toEqual([])
  })
})

describe('matchRanges: a URL row emphasises the typed words at word starts', () => {
  it('sets the typed prefix of a host and a word start of a title', () => {
    expect(matchRanges('url', 'github.com', 'git')).toEqual([[0, 3]])
    expect(matchRanges('history', "GitHub: Let's build from here", 'let')).toEqual([[8, 11]])
    expect(matchRanges('bookmark', 'github.com/zenium', 'zen', 'description')).toEqual([[11, 14]])
  })

  it('does not hit inside a word, and matches every word start', () => {
    expect(matchRanges('url', 'github.com', 'hub')).toEqual([])
    expect(matchRanges('tab', 'New tab – new page', 'new')).toEqual([
      [0, 3],
      [10, 13]
    ])
  })

  it('looks for each typed word, merging touching hits, case-insensitively', () => {
    expect(matchRanges('history', 'Zenium desktop parity', 'zenium desk')).toEqual([
      [0, 6],
      [7, 11]
    ])
    expect(matchRanges('history', 'Zenium desktop', 'zenium des ZENIUM')).toEqual([
      [0, 6],
      [7, 10]
    ])
  })

  it('ignores a scheme, www. and a keyword’s @ typed ahead of the term', () => {
    expect(matchRanges('url', 'github.com', 'https://github')).toEqual([[0, 6]])
    expect(matchRanges('url', 'github.com', 'www.git')).toEqual([[0, 3]])
    expect(matchRanges('engine', 'ddg', '@dd')).toEqual([[0, 2]])
    expect(matchRanges('command', 'Compact mode', 'comp')).toEqual([[0, 4]])
  })
})

describe('matchRanges: rows that carry no emphasis', () => {
  it('leaves answers and the clipboard row plain', () => {
    expect(matchRanges('answer', '= 4', '2+2')).toEqual([])
    expect(matchRanges('answer', '2+2', '2+2', 'description')).toEqual([])
    expect(matchRanges('clipboard', 'Link you copied', 'link')).toEqual([])
  })

  it('emphasises nothing when nothing is typed (zero-suggest) or the text is empty', () => {
    expect(matchRanges('search', 'weather', '')).toEqual([])
    expect(matchRanges('history', 'Zenium', '   ')).toEqual([])
    expect(matchRanges('url', '', 'git')).toEqual([])
  })
})
