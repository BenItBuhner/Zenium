import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RELEVANCE,
  DEFAULT_SEARCH_ENGINES,
  buildSearchUrl,
  completeWwwCom,
  customSearchEngine,
  editedSearchEngine,
  engineFieldFavicon,
  engineKeywordProblem,
  engineKeywords,
  isActiveSearchEngine,
  matchEngineKeyword,
  matchEngineWord,
  matchKeyword,
  matchKeywordWord,
  normalizeEngineKeyword,
  parseSuggestPayload,
  parseSuggestResponse,
  sanitizeSearchEngines,
  searchTermsFromUrl,
  withDefaultSearchEngineActive,
  withSearchEngineActive
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

  it('marks a field with the engine’s favicon whichever engine it is, the vendor’s default included (v2 §6, NTP-09)', () => {
    // The vendor's default leads the field too: §6 gives the engine's favicon, not the choice's.
    expect(engineFieldFavicon(google)).toBe('https://www.google.com/favicon.ico')
    // Every shipped engine carries its site's icon in the registry, and every one shows it.
    for (const engine of DEFAULT_SEARCH_ENGINES) {
      expect(engine.favicon).toMatch(/^https:\/\/.+\/favicon\.ico$/)
      expect(engineFieldFavicon(engine)).toBe(engine.favicon)
    }
    // A user's engine whose site offered no icon shows none: the slot falls back.
    expect(engineFieldFavicon({ favicon: null })).toBeNull()
    expect(engineFieldFavicon({})).toBeNull()
    expect(engineFieldFavicon({ favicon: 'https://s.example/i.png' })).toBe(
      'https://s.example/i.png'
    )
  })

  it("reads the terms out of an engine's results page, its own additions and `+` aside; another engine's page or path is not one", () => {
    expect(searchTermsFromUrl(google, buildSearchUrl(google, 'two words'))).toBe('two words')
    expect(
      searchTermsFromUrl(
        google,
        'https://www.google.com/search?q=two+words&sourceid=chrome&ie=UTF-8'
      )
    ).toBe('two words')
    // `www.` aside, the host must be the engine's; the path too.
    expect(searchTermsFromUrl(google, 'https://google.com/search?q=cats')).toBe('cats')
    expect(searchTermsFromUrl(google, 'https://www.google.com/maps?q=cats')).toBeNull()
    expect(searchTermsFromUrl(google, 'https://duckduckgo.com/?q=cats')).toBeNull()
    expect(searchTermsFromUrl(google, 'https://www.google.com/search?tbm=isch')).toBeNull()
    expect(searchTermsFromUrl(google, 'https://www.google.com/search?q=')).toBeNull()
    expect(searchTermsFromUrl(google, 'not a url')).toBeNull()
    const ddg = DEFAULT_SEARCH_ENGINES.find((e) => e.id === 'duckduckgo')!
    expect(searchTermsFromUrl(ddg, 'https://duckduckgo.com/?q=cats&t=h_&ia=web')).toBe('cats')
    // A template with the terms in its path is not read.
    expect(
      searchTermsFromUrl(
        { searchUrl: 'https://example.com/find/%s' },
        'https://example.com/find/cats'
      )
    ).toBeNull()
  })
})

describe('search engines: the shortcut and the active flag (omnibox-09, settings-43)', () => {
  const own = customSearchEngine(
    'Marginalia',
    'https://marginalia.example/?q=%s',
    DEFAULT_SEARCH_ENGINES
  )
  const all = [...DEFAULT_SEARCH_ENGINES, own]

  it('normalises a typed shortcut to one lower-case @word, or none', () => {
    expect(normalizeEngineKeyword('wiki')).toBe('@wiki')
    expect(normalizeEngineKeyword(' @Wiki ')).toBe('@wiki')
    expect(normalizeEngineKeyword('')).toBeNull()
    expect(normalizeEngineKeyword('   ')).toBeNull()
    expect(normalizeEngineKeyword('two words')).toBeNull()
    expect(normalizeEngineKeyword('@')).toBeNull()
    expect(normalizeEngineKeyword('x'.repeat(65))).toBeNull()
    expect(normalizeEngineKeyword('x'.repeat(64))).toBe(`@${'x'.repeat(64)}`)
  })

  it('names why a shortcut cannot be an engine’s: spaces, length, Zenium’s scopes, another engine’s word', () => {
    // Empty is no problem: the derived shortcut stands in.
    expect(engineKeywordProblem('', own.id, all)).toBeNull()
    expect(engineKeywordProblem('mg', own.id, all)).toBeNull()
    // The engine's own current shortcut is fine for itself.
    expect(engineKeywordProblem(own.keyword, own.id, all)).toBeNull()
    expect(engineKeywordProblem('two words', own.id, all)).toBe(
      'A shortcut is one word, with no spaces'
    )
    expect(engineKeywordProblem('x'.repeat(65), own.id, all)).toBe('The shortcut is too long')
    expect(engineKeywordProblem('@tabs', own.id, all)).toBe(
      '@tabs is one of Zenium’s own shortcuts'
    )
    expect(engineKeywordProblem('bookmarks', own.id, all)).toBe(
      '@bookmarks is one of Zenium’s own shortcuts'
    )
    // Another engine's keyword, id and name are all its words.
    expect(engineKeywordProblem('ddg', own.id, all)).toBe('DuckDuckGo already answers to @ddg')
    expect(engineKeywordProblem('@DuckDuckGo', own.id, all)).toBe(
      'DuckDuckGo already answers to @duckduckgo'
    )
  })

  it('a bare @ is a word missing, not a word too long: its own line, spaces around it or not', () => {
    // `normalizeEngineKeyword('@')` is null as a 65-character word's is; the reason differs.
    expect(engineKeywordProblem('@', own.id, all)).toBe('Type a word after the @')
    expect(engineKeywordProblem(' @ ', own.id, all)).toBe('Type a word after the @')
    expect(engineKeywordProblem('@w', own.id, all)).toBeNull()
    // The long word keeps its line.
    expect(engineKeywordProblem(`@${'x'.repeat(65)}`, own.id, all)).toBe('The shortcut is too long')
  })

  it('an engine being added has no id: given one no engine has, every engine’s word is another’s', () => {
    // `sanitizeSearchEngine` keeps no engine with an empty id, so '' names none of them.
    expect(engineKeywordProblem('ddg', '', all)).toBe('DuckDuckGo already answers to @ddg')
    expect(engineKeywordProblem(own.keyword, '', all)).toBe(
      `${own.name} already answers to ${own.keyword}`
    )
    expect(engineKeywordProblem('fresh', '', all)).toBeNull()
  })

  it('edits name, shortcut and template; an empty shortcut derives from the new name, unique', () => {
    const edited = editedSearchEngine(
      own,
      {
        name: '  Marginalia Search  ',
        searchUrl: ' https://search.marginalia.nu/search?query=%s ',
        keyword: 'MS'
      },
      all
    )
    expect(edited).toMatchObject({
      id: own.id,
      name: 'Marginalia Search',
      searchUrl: 'https://search.marginalia.nu/search?query=%s',
      keyword: '@ms',
      glyph: 'M',
      source: 'custom'
    })
    // An empty shortcut derives one from the name; `@google` is the shipped engine's, so `2`.
    const derived = editedSearchEngine(
      own,
      { name: 'Google', searchUrl: own.searchUrl, keyword: '' },
      all
    )
    expect(derived.keyword).toBe('@google2')
    // The engine's own current shortcut never counts against itself.
    const same = editedSearchEngine(
      own,
      { name: 'Marginalia', searchUrl: own.searchUrl, keyword: '' },
      all
    )
    expect(same.keyword).toBe('@marginalia')
  })

  it('an edited discovered engine becomes the user’s own, its visit stamp gone', () => {
    const discovered = {
      ...own,
      id: 'discovered:marginalia.example',
      source: 'discovered' as const,
      visitedAt: 1234
    }
    const edited = editedSearchEngine(
      discovered,
      { name: 'Marginalia', searchUrl: discovered.searchUrl, keyword: 'mg' },
      [...DEFAULT_SEARCH_ENGINES, discovered]
    )
    expect(edited.source).toBe('custom')
    expect(edited.visitedAt).toBeUndefined()
    expect(edited.id).toBe('discovered:marginalia.example')
  })

  it('deactivates and activates by the flag alone: absent is active, `false` is not', () => {
    expect(isActiveSearchEngine(own)).toBe(true)
    expect(isActiveSearchEngine({ active: true })).toBe(true)
    expect(isActiveSearchEngine({ active: false })).toBe(false)
    const off = withSearchEngineActive([own], own.id, false)
    expect(off[0].active).toBe(false)
    const on = withSearchEngineActive(off, own.id, true)
    expect('active' in on[0]).toBe(false)
    // Another id leaves the list as it was.
    expect(withSearchEngineActive([own], 'nope', false)).toEqual([own])
  })

  it('a deactivated engine answers to no keyword, host or name until activated', () => {
    const inactive = { ...own, active: false }
    const engines = [...DEFAULT_SEARCH_ENGINES, inactive]
    expect(matchKeywordWord('@marginalia', engines)).toBeNull()
    expect(matchKeyword('@marginalia cats', engines)).toBeNull()
    expect(matchEngineKeyword('@marginalia cats', engines)).toBeNull()
    expect(matchEngineWord('marginalia.example', engines)).toBeNull()
    expect(matchEngineWord('marginalia', engines, true)).toBeNull()
    // The shipped engines beside it still answer.
    expect(matchKeywordWord('@ddg', engines)).toMatchObject({ kind: 'engine' })
    // Activated, it answers again.
    const active = withSearchEngineActive([inactive], own.id, true)
    expect(matchKeywordWord('@marginalia', [...DEFAULT_SEARCH_ENGINES, ...active])).toMatchObject({
      kind: 'engine',
      keyword: '@marginalia'
    })
  })

  it('an engine made the default while deactivated comes back active, the flag deleted; the other engines keep theirs; nothing to do leaves the same list (A7)', () => {
    const other = { ...own, id: 'custom:other', name: 'Other', keyword: '@other', active: false }
    const list = [{ ...own, active: false }, other]
    const made = withDefaultSearchEngineActive(list, own.id)
    expect(made).not.toBe(list)
    expect('active' in made[0]).toBe(false)
    expect(isActiveSearchEngine(made[0])).toBe(true)
    expect(made[1]).toEqual(other)
    // Its shortcut answers again.
    expect(matchKeywordWord('@marginalia', [...DEFAULT_SEARCH_ENGINES, ...made])).toMatchObject({
      kind: 'engine',
      keyword: '@marginalia'
    })
    // The default active already, or a shipped engine (not one of the user's): the same list.
    expect(withDefaultSearchEngineActive(made, own.id)).toBe(made)
    expect(withDefaultSearchEngineActive(list, 'google')).toBe(list)
  })

  it('the sanitiser keeps `active: false` and drops any other value of the flag', () => {
    const stored = JSON.parse(
      JSON.stringify([
        { ...own, active: false },
        { ...own, id: 'custom:2', keyword: '@two', active: true },
        { ...own, id: 'custom:3', keyword: '@three', active: 'yes' }
      ])
    )
    const read = sanitizeSearchEngines(stored)
    expect(read.map((e) => e.active)).toEqual([false, undefined, undefined])
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
