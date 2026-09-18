// Node's SHA-256 is the reference the core's own implementation is checked against.
// eslint-disable-next-line no-restricted-imports
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  GSB_DEFAULT_CACHE_MS,
  GSB_MAX_PREFIXES,
  GSB_SEARCH_ENDPOINT,
  buildSearchRequest,
  canonicalExpressions,
  canonicalUrl,
  hostSuffixes,
  parseSearchResponse,
  pathPrefixes,
  threatOfGsbType
} from '../gsb'

function fullHashBase64(expression: string): string {
  return createHash('sha256').update(expression).digest('base64')
}

describe('canonicalisation', () => {
  it('lowercases the host, drops fragments and credentials, refuses other schemes', () => {
    const url = canonicalUrl('  HTTP://user:pw@Evil.Example.COM./a/b?x=1#frag ')
    expect(url?.href).toBe('http://evil.example.com/a/b?x=1')
    expect(canonicalUrl('ftp://evil.example/')).toBeNull()
    expect(canonicalUrl('not a url')).toBeNull()
    expect(canonicalUrl('zen://error')).toBeNull()
  })

  it('lists host suffixes down to the last two labels, five at most', () => {
    expect(hostSuffixes('a.b.c.d.e.f.example.com')).toEqual([
      'a.b.c.d.e.f.example.com',
      'd.e.f.example.com',
      'e.f.example.com',
      'f.example.com',
      'example.com'
    ])
    expect(hostSuffixes('www.example.com')).toEqual(['www.example.com', 'example.com'])
    expect(hostSuffixes('example.com')).toEqual(['example.com'])
    expect(hostSuffixes('192.0.2.1')).toEqual(['192.0.2.1'])
  })

  it('lists path prefixes: with query, without, then parent directories', () => {
    const url = new URL('https://example.com/a/b/c.html?q=1')
    expect(pathPrefixes(url)).toEqual(['/a/b/c.html?q=1', '/a/b/c.html', '/', '/a/', '/a/b/'])
    expect(pathPrefixes(new URL('https://example.com/'))).toEqual(['/'])
    expect(pathPrefixes(new URL('https://example.com/a/'))).toEqual(['/a/', '/'])
  })

  it('crosses host suffixes and path prefixes into at most thirty expressions', () => {
    const expressions = canonicalExpressions('http://a.b.example.com/1/2.html?x=y')
    expect(expressions).toContain('a.b.example.com/1/2.html?x=y')
    expect(expressions).toContain('example.com/')
    expect(expressions).toContain('b.example.com/1/')
    expect(expressions.length).toBeLessThanOrEqual(GSB_MAX_PREFIXES)
    expect(canonicalExpressions('http://h:8080/p')).toEqual(['h:8080/p', 'h:8080/'])
    expect(canonicalExpressions('http://example.com:8080/p')).toContain('example.com:8080/p')
    expect(canonicalExpressions('zen://error')).toEqual([])
  })
})

describe('buildSearchRequest', () => {
  it('sends the key and one 4-byte prefix per distinct expression', () => {
    const request = buildSearchRequest('KEY', 'https://www.example.com/path')
    expect(request).not.toBeNull()
    const url = new URL(request!.url)
    expect(`${url.origin}${url.pathname}`).toBe(GSB_SEARCH_ENDPOINT)
    expect(url.searchParams.get('key')).toBe('KEY')
    const prefixes = url.searchParams.getAll('hashPrefixes')
    expect(prefixes.length).toBe(request!.fullHashes.size)
    for (const prefix of prefixes) expect(Buffer.from(prefix, 'base64').length).toBe(4)
    const expected = createHash('sha256').update('www.example.com/path').digest('hex')
    expect(request!.fullHashes.get(expected)).toBe('www.example.com/path')
    expect(buildSearchRequest('', 'https://www.example.com/')).toBeNull()
    expect(buildSearchRequest('KEY', 'zen://error')).toBeNull()
  })
})

describe('parseSearchResponse', () => {
  const request = buildSearchRequest('KEY', 'https://www.example.com/login')!

  it('matches full hashes against the request, picks the gravest threat and the cache time', () => {
    const result = parseSearchResponse(
      {
        fullHashes: [
          {
            fullHash: fullHashBase64('example.com/'),
            fullHashDetails: [{ threatType: 'UNWANTED_SOFTWARE' }, { threatType: 'MALWARE' }]
          }
        ],
        cacheDuration: '600s'
      },
      request
    )
    expect(result).toEqual({ threat: 'malware', expression: 'example.com/', cacheMs: 600_000 })
  })

  it('ignores hashes the request did not ask about (a prefix collision) and empty answers', () => {
    const stranger = parseSearchResponse(
      {
        fullHashes: [
          {
            fullHash: fullHashBase64('other.example/'),
            fullHashDetails: [{ threatType: 'MALWARE' }]
          }
        ]
      },
      request
    )
    expect(stranger).toEqual({ threat: null, expression: null, cacheMs: GSB_DEFAULT_CACHE_MS })
    expect(parseSearchResponse({}, request).threat).toBeNull()
    expect(parseSearchResponse(null, request).cacheMs).toBe(GSB_DEFAULT_CACHE_MS)
    expect(parseSearchResponse({ cacheDuration: 'soon' }, request).cacheMs).toBe(
      GSB_DEFAULT_CACHE_MS
    )
    expect(parseSearchResponse({ cacheDuration: '0.5s' }, request).cacheMs).toBe(500)
  })

  it('reports a hash without details as an unknown threat and maps the API types', () => {
    const result = parseSearchResponse(
      { fullHashes: [{ fullHash: fullHashBase64('www.example.com/login') }] },
      request
    )
    expect(result.threat).toBe('unknown')
    expect(result.expression).toBe('www.example.com/login')
    expect(threatOfGsbType('SOCIAL_ENGINEERING')).toBe('phishing')
    expect(threatOfGsbType('POTENTIALLY_HARMFUL_APPLICATION')).toBe('unwanted')
    expect(threatOfGsbType('WHATEVER')).toBe('unknown')
  })
})
