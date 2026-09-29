import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SearchEngine } from '../types'
import { searchTermsFromUrl } from '../search'
import { searchEnginesInOrder, searchVisitUrls, searchesInHistory } from '../zeroSuggest'

const engine = (id: string, searchUrl: string, extra: Partial<SearchEngine> = {}): SearchEngine =>
  ({ id, name: id, searchUrl, suggestUrl: null, keyword: id, glyph: 'S', ...extra }) as SearchEngine

const google = engine('google', 'https://www.google.com/search?q=%s')
const ddg = engine('ddg', 'https://duckduckgo.com/?q=%s')
const inactive = engine('old', 'https://old.example/find?query=%s', { active: false })
// A second engine at Google's host and path: which template reads a page is the order's business.
const googleImages = engine('images', 'https://www.google.com/search?tbm=isch&q=%s')

describe('zero-suggest: the searches the history holds (OMN-04)', () => {
  it("reads the results pages of the engines back to their terms, most recent first, one per terms; a page on an engine's host that is not its results page is no search", () => {
    const entries = [
      { url: 'https://www.google.com/search?q=cats&sourceid=chrome', lastVisit: 500 },
      { url: 'https://www.google.com/maps?q=cat+cafe', lastVisit: 450 },
      { url: 'https://duckduckgo.com/?q=two+words&t=h_', lastVisit: 400 },
      { url: 'https://duckduckgo.com/settings?q=dogs', lastVisit: 350 },
      { url: 'https://news.example/story', lastVisit: 300 },
      { url: 'https://www.google.com/search?q=Cats', lastVisit: 200 },
      { url: 'https://duckduckgo.com/?q=cats', lastVisit: 100 },
      { url: 'https://www.google.com/search?q=', lastVisit: 50 },
      { url: 'https://www.google.com/search?tbm=isch', lastVisit: 40 },
      { url: 'zen://newtab', lastVisit: 25 }
    ]
    const found = searchesInHistory(entries, [google, ddg])
    expect(found.map((s) => [s.terms, s.engine.id, s.url, s.lastVisit])).toEqual([
      ['cats', 'google', 'https://www.google.com/search?q=cats&sourceid=chrome', 500],
      ['two words', 'ddg', 'https://duckduckgo.com/?q=two+words&t=h_', 400]
    ])
  })

  it('keeps the most recent visit of the same terms whatever order the entries come in', () => {
    const entries = [
      { url: 'https://duckduckgo.com/?q=cats', lastVisit: 100 },
      { url: 'https://www.google.com/search?q=cats', lastVisit: 900 },
      { url: 'https://www.google.com/search?q=dogs', lastVisit: 500 }
    ]
    expect(searchesInHistory(entries, [google, ddg]).map((s) => [s.terms, s.engine.id])).toEqual([
      ['cats', 'google'],
      ['dogs', 'google']
    ])
  })

  it('the default engine reads a page first; the other active engines follow; an inactive engine reads nothing', () => {
    expect(searchEnginesInOrder([inactive, googleImages, google, ddg], google)).toEqual([
      google,
      googleImages,
      ddg
    ])
    const entries = [
      { url: 'https://www.google.com/search?tbm=isch&q=kittens', lastVisit: 300 },
      { url: 'https://old.example/find?query=forgotten', lastVisit: 200 }
    ]
    // Google's template fits the images page too (same host, same path, the same `q`): the
    // default engine claims it. The inactive engine's page is a plain page.
    expect(
      searchesInHistory(
        entries,
        searchEnginesInOrder([inactive, googleImages, google], google)
      ).map((s) => [s.terms, s.engine.id])
    ).toEqual([['kittens', 'google']])
    expect(
      searchesInHistory(entries, searchEnginesInOrder([inactive, googleImages], googleImages)).map(
        (s) => [s.terms, s.engine.id]
      )
    ).toEqual([['kittens', 'images']])
  })

  it('names every results page that is the same search, case aside, for the forget path', () => {
    const entries = [
      { url: 'https://www.google.com/search?q=cats&sourceid=chrome' },
      { url: 'https://www.google.com/search?q=CATS' },
      { url: 'https://duckduckgo.com/?q=cats' },
      { url: 'https://www.google.com/search?q=cats+and+dogs' },
      { url: 'https://cats.example/' }
    ]
    expect(searchVisitUrls(entries, [google, ddg], ' Cats ')).toEqual([
      'https://www.google.com/search?q=cats&sourceid=chrome',
      'https://www.google.com/search?q=CATS',
      'https://duckduckgo.com/?q=cats'
    ])
    expect(searchVisitUrls(entries, [google, ddg], '   ')).toEqual([])
  })
})

/*
 * The scan's cost (#725's second fold, F3): the engines' templates are parsed once per call, not
 * once per page, and a page plainly on no engine's host is not parsed at all – while what a
 * page is read as stays `searchTermsFromUrl`'s answer, engine by engine in order, address for
 * address, whatever the address looks like.
 */
describe('zero-suggest: the scan reads each template once and parses only the pages it must', () => {
  const RealURL = globalThis.URL
  let parsed: string[] = []
  class CountingURL extends RealURL {
    constructor(input: string | URL, base?: string | URL) {
      super(input, base)
      parsed.push(String(input))
    }
  }
  const counting = (): void => {
    parsed = []
    vi.stubGlobal('URL', CountingURL)
  }
  afterEach(() => vi.unstubAllGlobals())

  /** What the scan answered before the fold: each engine's template read against each page. */
  const reference = (
    entries: readonly { url: string; lastVisit: number }[],
    engines: readonly SearchEngine[]
  ): Array<[string, string, string, number]> => {
    const byTerms = new Map<string, [string, string, string, number]>()
    for (const entry of entries) {
      if (!/^https?:/i.test(entry.url)) continue
      let found: [string, string] | null = null
      for (const e of engines) {
        const terms = searchTermsFromUrl(e, entry.url)
        if (terms !== null) {
          found = [terms, e.id]
          break
        }
      }
      if (!found) continue
      const key = found[0].toLowerCase()
      const seen = byTerms.get(key)
      if (seen && seen[3] >= entry.lastVisit) continue
      byTerms.set(key, [found[0], found[1], entry.url, entry.lastVisit])
    }
    return [...byTerms.values()].sort((a, b) => b[3] - a[3])
  }

  // Addresses the cheap host check must hand to the parser rather than judge itself, beside
  // plain ones it can judge: case and `www.`, a userinfo, the default port, a percent-encoded
  // host (the parser decodes it to Google's), an IDN, a bracketed IPv6 host, a numeric host the
  // parser would normalise, a backslash that ends the authority early, a trailing dot, a
  // whitespace-led address (no address at all), a results page of the images template.
  const corpus = [
    'https://WWW.Google.com/search?q=upper',
    'https://user:pw@www.google.com/search?q=userinfo',
    'https://www.google.com:443/search?q=port',
    'https://%77ww.google.com/search?q=percent',
    'https://xn--80ak6aa92e.com/search?q=idn-punycode',
    'https://пример.рф/search?q=idn',
    'https://[::1]/search?q=ipv6',
    'https://0x7f.1/search?q=numeric',
    'https://127.0.0.1/search?q=ipv4',
    'https://evil.example\\@www.google.com/search?q=backslash',
    'https://www.google.com./search?q=trailing-dot',
    ' https://www.google.com/search?q=space',
    'https://www.google.com/search?tbm=isch&q=kittens',
    'https://www.google.com/maps?q=place',
    'https://duckduckgo.com/?q=ducks&t=h_',
    'https://duckduckgo.com/?t=h_&q=',
    'https://news.example/story?q=not-a-search',
    'https://search.example/find?query=custom',
    'zen://newtab',
    'file:///tmp/search?q=file',
    'not a url'
  ].map((url, i) => ({ url, lastVisit: 1000 - i }))
  const custom = engine('custom', 'https://search.example/find?query=%s')
  const engines = searchEnginesInOrder([inactive, googleImages, google, ddg, custom], google)

  it('answers what `searchTermsFromUrl` answers, address for address, engine by engine', () => {
    const found = searchesInHistory(corpus, engines).map(
      (s) => [s.terms, s.engine.id, s.url, s.lastVisit] as [string, string, string, number]
    )
    expect(found).toEqual(reference(corpus, engines))
    // What the corpus holds, spelt out: the parser's reading of every odd address.
    expect(found.map(([terms, id]) => `${id}:${terms}`)).toEqual([
      'google:upper',
      'google:userinfo',
      'google:port',
      'google:percent',
      'google:kittens',
      'ddg:ducks',
      'custom:custom'
    ])
    for (const terms of ['upper', 'percent', 'kittens', 'custom']) {
      expect(searchVisitUrls(corpus, engines, terms)).toEqual(
        corpus
          .map((e) => e.url)
          .filter((url) => engines.some((e) => searchTermsFromUrl(e, url)?.toLowerCase() === terms))
      )
    }
  })

  it('parses each template once per call and no page that is plainly on no engine’s host', () => {
    const plain = Array.from({ length: 200 }, (_, i) => ({
      url: `https://site${i}.example/page?q=${i}`,
      lastVisit: 5000 - i
    }))
    const pages = [
      'https://www.google.com/search?q=cats',
      'https://duckduckgo.com/?q=dogs',
      'https://www.google.com/maps?q=place',
      'https://%77ww.google.com/search?q=percent',
      'https://пример.рф/search?q=idn'
    ].map((url, i) => ({ url, lastVisit: 100 - i }))
    counting()
    const found = searchesInHistory([...plain, ...pages], engines)
    expect(found.map((s) => s.terms)).toEqual(['cats', 'dogs', 'percent'])
    // Four templates (the inactive engine is not read) plus the five pages the parser had to
    // read: the three on the engines' hosts, the two whose hosts only the parser can tell.
    expect(parsed).toHaveLength(engines.length + pages.length)
    expect(parsed.filter((url) => url.startsWith('https://site'))).toEqual([])
    counting()
    expect(searchVisitUrls([...plain, ...pages], engines, 'cats')).toEqual([
      'https://www.google.com/search?q=cats'
    ])
    expect(parsed).toHaveLength(engines.length + pages.length)
  })
})
