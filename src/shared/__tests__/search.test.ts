import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RELEVANCE,
  DEFAULT_SEARCH_ENGINES,
  buildSearchUrl,
  completeWwwCom,
  engineKeywords,
  matchEngineKeyword,
  matchKeyword,
  matchKeywordWord,
  parseSuggestPayload,
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

  it('queries Google as client=chrome, the keyless payload with types and relevance', () => {
    expect(google.suggestUrl).toContain('client=chrome')
  })

  it('reads the typed Google payload: types, descriptions, relevance, verbatim', () => {
    const payload = parseSuggestPayload([
      'gith',
      ['github', 'https://github.com/', '= 4'],
      ['', 'GitHub', ''],
      [],
      {
        'google:suggesttype': ['QUERY', 'NAVIGATION', 'CALCULATOR'],
        'google:suggestrelevance': [1252, 800, 1250],
        'google:verbatimrelevance': 851
      }
    ])
    expect(payload.verbatimRelevance).toBe(851)
    expect(payload.suggestions).toEqual([
      { text: 'github', type: 'query', description: '', relevance: 1252 },
      { text: 'https://github.com/', type: 'navigation', description: 'GitHub', relevance: 800 },
      { text: '= 4', type: 'calculator', description: '', relevance: 1250 }
    ])
  })

  it('reads plain OpenSearch payloads as query rows with descending default relevance', () => {
    const payload = parseSuggestPayload(['cat', ['cats', 'cat food', 7, 'cat videos']])
    expect(payload.verbatimRelevance).toBeNull()
    expect(payload.suggestions.map((s) => [s.text, s.type, s.relevance])).toEqual([
      ['cats', 'query', DEFAULT_RELEVANCE],
      ['cat food', 'query', DEFAULT_RELEVANCE - 1],
      ['cat videos', 'query', DEFAULT_RELEVANCE - 2]
    ])
    expect(parseSuggestPayload({ suggestions: [{ value: 'eco' }] }).suggestions[0]).toMatchObject({
      text: 'eco',
      type: 'query'
    })
    expect(parseSuggestPayload('garbage').suggestions).toEqual([])
  })

  it('matches keywords for engines and the built-in scopes, as typed', () => {
    expect(matchKeyword('@bookmarks foo bar', DEFAULT_SEARCH_ENGINES)).toEqual({
      kind: 'scope',
      scope: 'bookmarks',
      keyword: '@bookmarks',
      query: 'foo bar'
    })
    expect(matchKeyword('@History x', DEFAULT_SEARCH_ENGINES)).toMatchObject({ scope: 'history' })
    expect(matchKeyword('@tabs ', DEFAULT_SEARCH_ENGINES)).toMatchObject({
      scope: 'tabs',
      query: ''
    })
    expect(matchKeyword('@duckduckgo cats', DEFAULT_SEARCH_ENGINES)).toMatchObject({
      kind: 'engine',
      keyword: '@duckduckgo',
      query: 'cats'
    })
    expect(matchKeyword('@wikipedia cats', DEFAULT_SEARCH_ENGINES)).toMatchObject({
      kind: 'engine',
      engine: expect.objectContaining({ id: 'wikipedia' })
    })
    expect(matchKeyword('@nope cats', DEFAULT_SEARCH_ENGINES)).toBeNull()
    expect(matchKeyword('ddg cats', DEFAULT_SEARCH_ENGINES)).toBeNull()
    expect(matchKeywordWord('@ddg', DEFAULT_SEARCH_ENGINES)).toMatchObject({ kind: 'engine' })
    expect(matchKeywordWord('@dd', DEFAULT_SEARCH_ENGINES)).toBeNull()
    expect(engineKeywords(google)).toEqual(['@google'])
    expect(engineKeywords(DEFAULT_SEARCH_ENGINES.find((e) => e.id === 'duckduckgo')!)).toEqual([
      '@ddg',
      '@duckduckgo'
    ])
  })

  it('completes a bare word to www.<word>.com for Ctrl+Enter and leaves the rest alone', () => {
    expect(completeWwwCom('example')).toBe('www.example.com')
    expect(completeWwwCom(' zenium ')).toBe('www.zenium.com')
    expect(completeWwwCom('example/docs?x=1')).toBe('www.example.com/docs?x=1')
    expect(completeWwwCom('example.org')).toBe('example.org')
    expect(completeWwwCom('localhost:3000')).toBe('localhost:3000')
    expect(completeWwwCom('two words')).toBe('two words')
    expect(completeWwwCom('https://x')).toBe('https://x')
    expect(completeWwwCom('')).toBe('')
  })
})

describe('command bar', () => {
  it('finds commands by label and keyword', () => {
    expect(searchCommands('compact').map((c) => c.action)).toContain('compact.toggle')
    expect(searchCommands('split grid').map((c) => c.action)).toContain('split.grid')
    expect(searchCommands('')).toEqual([])
  })
})
