import { describe, expect, it } from 'vitest'
import type { SearchEngine } from '../types'
import {
  DEFAULT_SEARCH_ENGINES,
  MAX_DISCOVERED_ENGINES,
  MAX_OPENSEARCH_BYTES,
  allSearchEngines,
  buildSearchUrl,
  customSearchEngine,
  discoveredSearchEngine,
  engineHost,
  parseOpenSearchDescription,
  rememberDiscoveredEngine,
  sanitizeSearchEngines,
  searchTemplateProblem,
  uniqueEngineKeyword
} from '../search'
import { isOpenSearchLink } from '../pageScript'

/*
 * OpenSearch discovery and the user's engine list (OMN-27): a page's description becomes an
 * engine of the profile, the Settings form adds one by template, both are stored in
 * `settings.searchEngines` and read back through the same sanitiser a synced peer's copy goes
 * through, and the shipped list is never stored or shadowed.
 */

const BASE = 'https://en.wikipedia.org/w/opensearch_desc.php'

const WIKIPEDIA = `<?xml version="1.0"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/" xmlns:moz="http://www.mozilla.org/2006/browser/search/">
  <ShortName>Wikipedia (en)</ShortName>
  <Description>Wikipedia (en)</Description>
  <Image height="16" width="16" type="image/x-icon">/static/favicon/wikipedia.ico</Image>
  <Image height="64" width="64" type="image/png">https://en.wikipedia.org/static/apple-touch/wikipedia.png</Image>
  <Url type="text/html" method="get" template="https://en.wikipedia.org/w/index.php?title=Special:Search&amp;search={searchTerms}"/>
  <Url type="application/x-suggestions+json" method="get" template="https://en.wikipedia.org/w/api.php?action=opensearch&amp;search={searchTerms}&amp;namespace=0"/>
  <moz:SearchForm>https://en.wikipedia.org/wiki/Special:Search</moz:SearchForm>
</OpenSearchDescription>`

describe('parseOpenSearchDescription', () => {
  it('reads the name, the html and suggestions templates and the 16 px image', () => {
    const d = parseOpenSearchDescription(WIKIPEDIA, BASE)!
    expect(d).not.toBeNull()
    expect(d.name).toBe('Wikipedia (en)')
    expect(d.searchUrl).toBe('https://en.wikipedia.org/w/index.php?title=Special:Search&search=%s')
    expect(d.suggestUrl).toBe(
      'https://en.wikipedia.org/w/api.php?action=opensearch&search=%s&namespace=0'
    )
    // The relative 16 × 16 image resolves against the description's address.
    expect(d.favicon).toBe('https://en.wikipedia.org/static/favicon/wikipedia.ico')
  })

  it('takes namespace prefixes, CDATA names, Param children and optional parameters', () => {
    const xml = `<os:OpenSearchDescription xmlns:os="http://a9.com/-/spec/opensearch/1.1/">
      <os:ShortName><![CDATA[Ducks & Co]]></os:ShortName>
      <os:Url type="text/html" template="/find?lang={language?}&amp;page={startPage?}">
        <os:Param name="q" value="{searchTerms}"/>
        <os:Param name="src" value="opensearch"/>
      </os:Url>
      <os:Image>data:image/png;base64,iVBORw0KGgo=</os:Image>
    </os:OpenSearchDescription>`
    const d = parseOpenSearchDescription(xml, 'https://ducks.example/search/desc.xml')!
    expect(d.name).toBe('Ducks & Co')
    expect(d.searchUrl).toBe('https://ducks.example/find?lang=&page=&q=%s&src=opensearch')
    expect(d.suggestUrl).toBeNull()
    expect(d.favicon).toBe('data:image/png;base64,iVBORw0KGgo=')
    // The engine searches with the terms in the Param the template took.
    expect(buildSearchUrl({ ...d, id: 'x', keyword: '@x', glyph: 'D' }, 'a b')).toBe(
      'https://ducks.example/find?lang=&page=&q=a%20b&src=opensearch'
    )
  })

  it("falls back to the link's title, then the host, when ShortName is missing", () => {
    const xml = `<OpenSearchDescription><Url type="text/html" template="https://s.example/?q={searchTerms}"/></OpenSearchDescription>`
    expect(parseOpenSearchDescription(xml, BASE, ' Site search ')!.name).toBe('Site search')
    expect(parseOpenSearchDescription(xml, BASE)!.name).toBe('s.example')
  })

  it('prefers the first html GET template and skips POST ones', () => {
    const xml = `<OpenSearchDescription>
      <ShortName>Posty</ShortName>
      <Url type="text/html" method="post" template="https://p.example/search"><Param name="q" value="{searchTerms}"/></Url>
      <Url type="text/html" method="GET" template="https://p.example/s?q={searchTerms}"/>
      <Url type="text/html" template="https://p.example/other?q={searchTerms}"/>
    </OpenSearchDescription>`
    expect(parseOpenSearchDescription(xml, BASE)!.searchUrl).toBe('https://p.example/s?q=%s')
  })

  it.each([
    ['not XML at all', 'Hello <b>world</b>'],
    [
      'an HTML page in place of the description',
      '<!doctype html><html><head><title>404</title></head></html>'
    ],
    ['a truncated document', WIKIPEDIA.slice(0, 200)],
    ['no template', '<OpenSearchDescription><ShortName>X</ShortName></OpenSearchDescription>'],
    [
      'a template without the search terms',
      '<OpenSearchDescription><Url type="text/html" template="https://x.example/search"/></OpenSearchDescription>'
    ],
    [
      'a required parameter that is not the terms',
      '<OpenSearchDescription><Url type="text/html" template="https://x.example/?q={searchTerms}&amp;k={apiKey}"/></OpenSearchDescription>'
    ],
    [
      'a non-http template',
      '<OpenSearchDescription><Url type="text/html" template="ftp://x.example/?q={searchTerms}"/></OpenSearchDescription>'
    ],
    [
      'a javascript template',
      '<OpenSearchDescription><Url type="text/html" template="javascript:alert({searchTerms})"/></OpenSearchDescription>'
    ],
    [
      'only a suggestions template',
      '<OpenSearchDescription><Url type="application/x-suggestions+json" template="https://x.example/s?q={searchTerms}"/></OpenSearchDescription>'
    ],
    ['an empty string', '']
  ])('is null for %s', (_label, xml) => {
    expect(parseOpenSearchDescription(xml, BASE)).toBeNull()
  })

  it('refuses oversized documents and drops non-http images', () => {
    const big = WIKIPEDIA + ' '.repeat(MAX_OPENSEARCH_BYTES)
    expect(parseOpenSearchDescription(big, BASE)).toBeNull()
    const xml = `<OpenSearchDescription><ShortName>X</ShortName>
      <Image>javascript:alert(1)</Image>
      <Url type="text/html" template="https://x.example/?q={searchTerms}"/></OpenSearchDescription>`
    expect(parseOpenSearchDescription(xml, BASE)!.favicon).toBeNull()
  })

  it('leaves a literal %25s alone: the placeholder is what {searchTerms} becomes', () => {
    const xml = `<OpenSearchDescription><Url type="text/html" template="https://x.example/?fmt=%25s&amp;q={searchTerms}"/></OpenSearchDescription>`
    const d = parseOpenSearchDescription(xml, BASE)!
    expect(d.searchUrl).toBe('https://x.example/?fmt=%25s&q=%s')
    expect(buildSearchUrl({ ...d, id: 'x', keyword: '@x', glyph: 'X' }, 'z')).toBe(
      'https://x.example/?fmt=%25s&q=z'
    )
  })
})

describe('isOpenSearchLink', () => {
  it('needs the search rel token and the OpenSearch type, whatever the case or parameters', () => {
    expect(isOpenSearchLink('search', 'application/opensearchdescription+xml')).toBe(true)
    expect(
      isOpenSearchLink('Search alternate', 'Application/OpenSearchDescription+XML; charset=utf-8')
    ).toBe(true)
    // A site's own search page, or a stylesheet, is not a description.
    expect(isOpenSearchLink('search', 'text/html')).toBe(false)
    expect(isOpenSearchLink('search', '')).toBe(false)
    expect(isOpenSearchLink('stylesheet', 'application/opensearchdescription+xml')).toBe(false)
    expect(isOpenSearchLink('searching', 'application/opensearchdescription+xml')).toBe(false)
  })
})

describe('searchTemplateProblem and custom engines', () => {
  it('accepts an http(s) template with %s and names what is wrong otherwise', () => {
    expect(searchTemplateProblem('https://example.com/search?q=%s')).toBeNull()
    expect(searchTemplateProblem('http://example.com/%s')).toBeNull()
    expect(searchTemplateProblem('')).toBe('Enter the search URL')
    expect(searchTemplateProblem('https://example.com/search')).toBe(
      'Put %s where the search terms go'
    )
    expect(searchTemplateProblem('example.com/?q=%s')).toMatch(/complete address/)
    expect(searchTemplateProblem('ftp://example.com/?q=%s')).toMatch(/https:\/\/ or http:\/\//)
  })

  it('gives a new engine a unique id and keyword, the letter glyph and no suggestions', () => {
    const mine = customSearchEngine('Marginalia', 'https://m.example/?q=%s', DEFAULT_SEARCH_ENGINES)
    expect(mine).toMatchObject({
      id: 'custom:marginalia',
      keyword: '@marginalia',
      glyph: 'M',
      source: 'custom',
      suggestUrl: null,
      favicon: null
    })
    const again = customSearchEngine('Marginalia', 'https://m2.example/?q=%s', [
      ...DEFAULT_SEARCH_ENGINES,
      mine
    ])
    expect(again.id).toBe('custom:marginalia-2')
    expect(again.keyword).toBe('@marginalia2')
    // A keyword a shipped engine answers to is never handed out (Wikipedia ships as @wikipedia).
    expect(uniqueEngineKeyword('Wikipedia', DEFAULT_SEARCH_ENGINES)).toBe('@wikipedia2')
    expect(uniqueEngineKeyword('DuckDuckGo', DEFAULT_SEARCH_ENGINES)).toBe('@duckduckgo2')
  })
})

function discovered(host: string, visitedAt: number, name = host): SearchEngine {
  return {
    id: `discovered:${host}`,
    name,
    searchUrl: `https://${host}/search?q=%s`,
    suggestUrl: null,
    keyword: `@${host.replace(/\W/g, '')}`,
    glyph: 'X',
    source: 'discovered',
    favicon: null,
    visitedAt
  }
}

describe('the stored engine list', () => {
  it('lists the shipped engines, then custom ones as added, then discovered ones newest first', () => {
    const custom = customSearchEngine('Mine', 'https://mine.example/?q=%s', DEFAULT_SEARCH_ENGINES)
    const list = allSearchEngines([
      discovered('old.example', 1),
      custom,
      discovered('new.example', 2)
    ])
    expect(list.map((e) => e.id)).toEqual([
      ...DEFAULT_SEARCH_ENGINES.map((e) => e.id),
      'custom:mine',
      'discovered:new.example',
      'discovered:old.example'
    ])
  })

  it('sanitises a synced or on-disk list: shipped ids, duplicates and broken entries go', () => {
    const shippedCopy = { ...DEFAULT_SEARCH_ENGINES[0], name: 'Not Google' }
    const raw: unknown[] = [
      shippedCopy,
      discovered('a.example', 5),
      discovered('a.example', 9),
      { id: 'custom:broken', name: 'Broken', searchUrl: 'https://b.example/no-terms' },
      { id: 'custom:no-name', name: '   ', searchUrl: 'https://b.example/?q=%s' },
      {
        id: 'custom:ok',
        name: 'OK',
        searchUrl: 'https://ok.example/?q=%s',
        favicon: 'javascript:x'
      },
      'garbage',
      null
    ]
    const out = sanitizeSearchEngines(raw)
    expect(out.map((e) => e.id)).toEqual(['custom:ok', 'discovered:a.example'])
    // Missing fields are filled in; a favicon that is not http(s) or a data image is dropped.
    expect(out[0]).toMatchObject({ keyword: '@ok', glyph: 'O', source: 'custom', favicon: null })
    expect(out[1].visitedAt).toBe(5)
    expect(sanitizeSearchEngines('nope')).toEqual([])
    expect(sanitizeSearchEngines(undefined)).toEqual([])
  })

  it('caps discovered engines to the newest and never drops the default', () => {
    const many = Array.from({ length: MAX_DISCOVERED_ENGINES + 3 }, (_, i) =>
      discovered(`site${i}.example`, i)
    )
    const capped = sanitizeSearchEngines(many)
    expect(capped).toHaveLength(MAX_DISCOVERED_ENGINES)
    expect(capped[0].id).toBe(`discovered:site${MAX_DISCOVERED_ENGINES + 2}.example`)
    expect(capped.some((e) => e.id === 'discovered:site0.example')).toBe(false)
    const kept = sanitizeSearchEngines(many, 'discovered:site0.example')
    expect(kept).toHaveLength(MAX_DISCOVERED_ENGINES)
    expect(kept.some((e) => e.id === 'discovered:site0.example')).toBe(true)
  })

  it('remembers a discovered engine by the site it searches and refreshes it on a later visit', () => {
    const xml = `<OpenSearchDescription><ShortName>Forum</ShortName>
      <Url type="text/html" template="https://forum.example/search?q={searchTerms}"/>
      <Image width="16" height="16">https://forum.example/favicon.ico</Image>
    </OpenSearchDescription>`
    const d = parseOpenSearchDescription(xml, 'https://forum.example/opensearch.xml')!
    const first = discoveredSearchEngine(d, 1000, DEFAULT_SEARCH_ENGINES)!
    expect(first).toMatchObject({
      id: 'discovered:forum.example',
      keyword: '@forum',
      glyph: 'F',
      source: 'discovered',
      favicon: 'https://forum.example/favicon.ico',
      visitedAt: 1000
    })
    const list = rememberDiscoveredEngine([], first)
    expect(list).toHaveLength(1)

    const later = discoveredSearchEngine({ ...d, name: 'Forum (renamed)' }, 2000, [
      ...DEFAULT_SEARCH_ENGINES,
      ...list
    ])!
    // The same entry: the keyword it already answers to stays, the visit and name refresh.
    expect(later.keyword).toBe('@forum')
    const refreshed = rememberDiscoveredEngine(list, later)
    expect(refreshed).toHaveLength(1)
    expect(refreshed[0]).toMatchObject({ name: 'Forum (renamed)', visitedAt: 2000 })
  })

  it('offers nothing for a site whose engine is shipped or was added by hand', () => {
    // Wikipedia ships: its own description (above) adds no second engine.
    const wiki = discoveredSearchEngine(parseOpenSearchDescription(WIKIPEDIA, BASE)!, 1, [])!
    expect(rememberDiscoveredEngine([], wiki)).toEqual([])
    const google = discovered('www.google.com', 5, 'Google Search')
    expect(engineHost(google)).toBe('google.com')
    expect(rememberDiscoveredEngine([], google)).toEqual([])
    const mine = customSearchEngine('Mine', 'https://mine.example/?q=%s', DEFAULT_SEARCH_ENGINES)
    expect(rememberDiscoveredEngine([mine], discovered('mine.example', 7))).toEqual([mine])
  })
})
