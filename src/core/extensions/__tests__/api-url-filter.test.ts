import { describe, expect, it } from 'vitest'
import {
  matchesAnyUrlFilter,
  matchesUrlFilter,
  normalizeEventFilters,
  normalizeUrlFilter
} from '../api/urlFilter'

const URL = 'https://www.example.com:8443/docs/page.html?q=1&lang=en#section-2'

describe('matchesUrlFilter', () => {
  it('matches everything with an empty filter and nothing for an unparsable URL', () => {
    expect(matchesUrlFilter(URL, {})).toBe(true)
    expect(matchesUrlFilter('not a url', {})).toBe(false)
  })

  it('compares hosts the way URLMatcherConditionFactory does (dots around the host)', () => {
    // `.example` inside `.www.example.com.` – and `example.` too.
    expect(matchesUrlFilter(URL, { hostContains: '.example' })).toBe(true)
    expect(matchesUrlFilter(URL, { hostContains: 'example.' })).toBe(true)
    // `.xample` is not a label boundary.
    expect(matchesUrlFilter(URL, { hostContains: '.xample' })).toBe(false)
    expect(matchesUrlFilter('https://foo.com/', { hostContains: '.foo' })).toBe(true)
    expect(matchesUrlFilter('https://barfoo.com/', { hostContains: '.foo' })).toBe(false)
    expect(matchesUrlFilter(URL, { hostEquals: 'www.example.com' })).toBe(true)
    expect(matchesUrlFilter(URL, { hostEquals: 'example.com' })).toBe(false)
    expect(matchesUrlFilter(URL, { hostSuffix: 'example.com' })).toBe(true)
    expect(matchesUrlFilter(URL, { hostSuffix: '.com' })).toBe(true)
    expect(matchesUrlFilter(URL, { hostPrefix: 'www.' })).toBe(true)
    expect(matchesUrlFilter(URL, { hostPrefix: 'example' })).toBe(false)
  })

  it('checks path and query separately, without the leading question mark', () => {
    expect(matchesUrlFilter(URL, { pathPrefix: '/docs/' })).toBe(true)
    expect(matchesUrlFilter(URL, { pathSuffix: '.html' })).toBe(true)
    expect(matchesUrlFilter(URL, { pathEquals: '/docs/page.html' })).toBe(true)
    expect(matchesUrlFilter(URL, { pathContains: 'page' })).toBe(true)
    expect(matchesUrlFilter(URL, { pathContains: 'q=1' })).toBe(false)
    expect(matchesUrlFilter(URL, { queryEquals: 'q=1&lang=en' })).toBe(true)
    expect(matchesUrlFilter(URL, { queryEquals: '?q=1&lang=en' })).toBe(true)
    expect(matchesUrlFilter(URL, { queryPrefix: 'q=' })).toBe(true)
    expect(matchesUrlFilter(URL, { querySuffix: 'lang=en' })).toBe(true)
    expect(matchesUrlFilter(URL, { queryContains: 'section' })).toBe(false)
  })

  it('never sees the fragment in the url* conditions', () => {
    expect(matchesUrlFilter(URL, { urlContains: 'section-2' })).toBe(false)
    expect(
      matchesUrlFilter(URL, {
        urlEquals: 'https://www.example.com:8443/docs/page.html?q=1&lang=en'
      })
    ).toBe(true)
    expect(matchesUrlFilter(URL, { urlPrefix: 'https://www.example.com:8443/docs' })).toBe(true)
    expect(matchesUrlFilter(URL, { urlSuffix: 'lang=en' })).toBe(true)
    expect(matchesUrlFilter(URL, { urlMatches: '^https://[^/]+/docs/.*\\.html' })).toBe(true)
    expect(matchesUrlFilter(URL, { urlMatches: '[' })).toBe(false)
  })

  it('matches originAndPathMatches against origin plus path only', () => {
    expect(
      matchesUrlFilter(URL, {
        originAndPathMatches: '^https://www\\.example\\.com:8443/docs/page\\.html$'
      })
    ).toBe(true)
    expect(matchesUrlFilter(URL, { originAndPathMatches: 'q=1' })).toBe(false)
  })

  it('checks schemes and explicit or default ports, with ranges', () => {
    expect(matchesUrlFilter(URL, { schemes: ['https'] })).toBe(true)
    expect(matchesUrlFilter(URL, { schemes: ['http', 'ftp'] })).toBe(false)
    expect(matchesUrlFilter(URL, { ports: [8443] })).toBe(true)
    expect(matchesUrlFilter(URL, { ports: [80, [8000, 8999]] })).toBe(true)
    expect(matchesUrlFilter(URL, { ports: [80, 443] })).toBe(false)
    expect(matchesUrlFilter('https://example.com/', { ports: [443] })).toBe(true)
    expect(matchesUrlFilter('http://example.com/', { ports: [80] })).toBe(true)
    expect(matchesUrlFilter('ftp://example.com/', { ports: [21] })).toBe(true)
    // A malformed range never matches.
    expect(matchesUrlFilter(URL, { ports: [[8000]] })).toBe(false)
  })

  it('requires every condition of one filter to hold', () => {
    expect(matchesUrlFilter(URL, { hostSuffix: 'example.com', pathPrefix: '/docs/' })).toBe(true)
    expect(matchesUrlFilter(URL, { hostSuffix: 'example.com', pathPrefix: '/blog/' })).toBe(false)
  })
})

describe('matchesAnyUrlFilter', () => {
  it('accepts with no filters, otherwise when any filter matches', () => {
    expect(matchesAnyUrlFilter(URL, [])).toBe(true)
    expect(matchesAnyUrlFilter(URL, [{ hostSuffix: 'other.org' }, { pathPrefix: '/docs' }])).toBe(
      true
    )
    expect(matchesAnyUrlFilter(URL, [{ hostSuffix: 'other.org' }, { schemes: ['http'] }])).toBe(
      false
    )
  })
})

describe('normalizeEventFilters', () => {
  it('treats no filters, no url list and an empty list as unfiltered', () => {
    expect(normalizeEventFilters(undefined)).toBeNull()
    expect(normalizeEventFilters(null)).toBeNull()
    expect(normalizeEventFilters({})).toBeNull()
    expect(normalizeEventFilters({ url: [] })).toBeNull()
  })

  it('keeps the known keys of each filter and validates the rest', () => {
    expect(
      normalizeEventFilters({
        url: [
          { hostSuffix: 'example.com', unknownKey: 1 },
          { schemes: ['https'], ports: [443, [8000, 8999]] }
        ]
      })
    ).toEqual([{ hostSuffix: 'example.com' }, { schemes: ['https'], ports: [443, [8000, 8999]] }])
  })

  it('throws Chrome-style errors for malformed arguments', () => {
    expect(() => normalizeEventFilters('nope')).toThrow(/Invalid filter object/)
    expect(() => normalizeEventFilters({ url: 'x' })).toThrow(/expected an array/)
    expect(() => normalizeEventFilters({ url: [{ hostSuffix: 3 }] })).toThrow(/Invalid url filter/)
    expect(() => normalizeEventFilters({ url: [{ schemes: 'https' }] })).toThrow(
      /Invalid url filter/
    )
    expect(() => normalizeEventFilters({ url: [{ ports: ['80'] }] })).toThrow(/Invalid url filter/)
    expect(() => normalizeEventFilters({ url: [{ ports: [[1, 2, 3]] }] })).toThrow(
      /Invalid url filter/
    )
    expect(() => normalizeEventFilters({ url: [null] })).toThrow(/Invalid url filter/)
  })

  it('normalizeUrlFilter returns null for anything that is not an object', () => {
    expect(normalizeUrlFilter(null)).toBeNull()
    expect(normalizeUrlFilter([])).toBeNull()
    expect(normalizeUrlFilter('x')).toBeNull()
    expect(normalizeUrlFilter({})).toEqual({})
  })
})
