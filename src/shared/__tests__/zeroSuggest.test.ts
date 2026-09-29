import { describe, expect, it } from 'vitest'
import type { SearchEngine } from '../types'
import { searchEnginesInOrder, searchVisitUrls, searchesInHistory } from '../zeroSuggest'

const engine = (id: string, searchUrl: string, extra: Partial<SearchEngine> = {}): SearchEngine =>
  ({ id, name: id, searchUrl, suggestUrl: null, keyword: id, glyph: 'S', ...extra }) as SearchEngine

const google = engine('google', 'https://www.google.com/search?q=%s')
const ddg = engine('ddg', 'https://duckduckgo.com/?q=%s')
const inactive = engine('old', 'https://old.example/find?query=%s', { active: false })
// A second engine at Google's host and path: which template reads a page is the order's business.
const googleImages = engine('images', 'https://www.google.com/search?tbm=isch&q=%s')

describe('zero-suggest: the searches the history holds (OMN-04)', () => {
  it('reads the results pages of the engines back to their terms, most recent first, one per terms', () => {
    const entries = [
      { url: 'https://www.google.com/search?q=cats&sourceid=chrome', lastVisit: 500 },
      { url: 'https://duckduckgo.com/?q=two+words&t=h_', lastVisit: 400 },
      { url: 'https://news.example/story', lastVisit: 300 },
      { url: 'https://www.google.com/search?q=Cats', lastVisit: 200 },
      { url: 'https://duckduckgo.com/?q=cats', lastVisit: 100 },
      { url: 'https://www.google.com/search?q=', lastVisit: 50 },
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
