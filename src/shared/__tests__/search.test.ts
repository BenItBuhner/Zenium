import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RELEVANCE,
  DEFAULT_SEARCH_ENGINES,
  buildSearchUrl,
  completeWwwCom,
  engineFieldFavicon,
  engineKeywords,
  matchEngineKeyword,
  matchKeyword,
  matchKeywordWord,
  parseSuggestPayload,
  parseSuggestResponse
} from '../search'
import { searchCommands } from '../commands'
import type { FormFactor, HostCapabilities } from '../types'

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

  it('marks a field with the engine’s favicon only when the engine is not the vendor’s default (NTP-09)', () => {
    // The vendor's default is not marked: the slot keeps the letter tile or the magnifier.
    expect(engineFieldFavicon(google)).toBeNull()
    // Every shipped engine carries its site's icon in the registry; the others show it.
    for (const engine of DEFAULT_SEARCH_ENGINES) {
      expect(engine.favicon).toMatch(/^https:\/\/.+\/favicon\.ico$/)
      if (engine !== google) expect(engineFieldFavicon(engine)).toBe(engine.favicon)
    }
    // A user's engine whose site offered no icon shows none: the slot falls back.
    expect(engineFieldFavicon({ id: 'custom-1', favicon: null })).toBeNull()
    expect(engineFieldFavicon({ id: 'custom-2' })).toBeNull()
    expect(engineFieldFavicon({ id: 'custom-3', favicon: 'https://s.example/i.png' })).toBe(
      'https://s.example/i.png'
    )
  })
})

describe('command bar', () => {
  it('finds commands by label and keyword', () => {
    expect(searchCommands('compact').map((c) => c.action)).toContain('compact.toggle')
    expect(searchCommands('split grid').map((c) => c.action)).toContain('split.grid')
    expect(searchCommands('')).toEqual([])
  })

  it('offers each layout the commands that act on its chrome', () => {
    const caps = new Proxy({} as HostCapabilities, { get: () => true })
    const actions = (formFactor: FormFactor, query: string): string[] =>
      searchCommands(query, { capabilities: caps, formFactor }).map((c) => c.action)
    // Compact mode is the desktop's hover-revealed sidebar: not the tablet's (its rail is the
    // toolbar's toggle) nor the phone's (no sidebar).
    expect(actions('desktop', 'compact')).toContain('compact.toggle')
    expect(actions('tablet', 'compact')).not.toContain('compact.toggle')
    expect(actions('tablet', 'floating sidebar')).not.toContain('compact.toggleSidebar')
    expect(actions('phone', 'compact')).not.toContain('compact.toggle')
    // The sidebar layouts share the sidebar width toggle and Split View.
    expect(actions('tablet', 'sidebar width')).toContain('sidebar.toggle')
    expect(actions('tablet', 'split grid')).toContain('split.grid')
    expect(actions('phone', 'split grid')).not.toContain('split.grid')
  })
})
