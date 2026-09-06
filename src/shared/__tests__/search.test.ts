import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SEARCH_ENGINES,
  buildSearchUrl,
  matchEngineKeyword,
  parseSuggestResponse
} from '../search'
import { searchCommands } from '../commands'

const google = DEFAULT_SEARCH_ENGINES.find((e) => e.id === 'google')!

describe('search engines', () => {
  it('ships Google, DuckDuckGo and Ecosia (the onboarding choices)', () => {
    const ids = DEFAULT_SEARCH_ENGINES.map((e) => e.id)
    expect(ids).toEqual(expect.arrayContaining(['google', 'duckduckgo', 'ecosia']))
  })

  it('encodes queries into the search template', () => {
    expect(buildSearchUrl(google, 'zen browser & co')).toBe(
      'https://www.google.com/search?q=zen%20browser%20%26%20co'
    )
  })

  it('parses OpenSearch array and Ecosia object responses', () => {
    expect(parseSuggestResponse(['zen', ['zen browser', 'zen garden']])).toEqual([
      'zen browser',
      'zen garden'
    ])
    expect(parseSuggestResponse({ suggestions: ['a', { value: 'b' }] })).toEqual(['a', 'b'])
    expect(parseSuggestResponse('garbage')).toEqual([])
  })

  it('detects engine keywords like "@ddg query"', () => {
    const hit = matchEngineKeyword('@ddg privacy browser', DEFAULT_SEARCH_ENGINES)
    expect(hit?.engine.id).toBe('duckduckgo')
    expect(hit?.query).toBe('privacy browser')
    expect(matchEngineKeyword('@ddg', DEFAULT_SEARCH_ENGINES)).toBeNull()
  })
})

describe('command bar', () => {
  it('finds commands by label and keyword', () => {
    expect(searchCommands('compact').map((c) => c.action)).toContain('compact.toggle')
    expect(searchCommands('split grid').map((c) => c.action)).toContain('split.grid')
    expect(searchCommands('')).toEqual([])
  })
})
