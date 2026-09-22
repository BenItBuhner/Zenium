import { describe, expect, it } from 'vitest'
import {
  compareSitePatterns,
  matchSitePatterns,
  normalizeSitePattern,
  parseSitePattern,
  siteAddressOf,
  sitePatternCoversHost,
  sitePatternForHost,
  sitePatternMatches,
  urlInSitePatterns,
  type SitePattern
} from '../sitePatterns'

describe('parseSitePattern', () => {
  it("reads Chrome's grammar and writes the canonical text back", () => {
    expect(parseSitePattern('example.com')).toEqual({
      text: 'example.com',
      scheme: null,
      host: 'example.com',
      subdomains: false,
      port: null
    })
    expect(parseSitePattern('[*.]example.com')).toMatchObject({
      text: '[*.]example.com',
      subdomains: true
    })
    expect(parseSitePattern('https://[*.]example.com')).toMatchObject({
      text: 'https://[*.]example.com',
      scheme: 'https',
      subdomains: true
    })
    expect(parseSitePattern('http://example.com:8080')).toMatchObject({
      text: 'http://example.com:8080',
      scheme: 'http',
      port: 8080
    })
    expect(parseSitePattern('[*.]example.com:8080')).toMatchObject({
      text: '[*.]example.com:8080',
      subdomains: true,
      port: 8080
    })
    // Case, whitespace, a trailing dot and the any-scheme / any-port wildcards are forgiven.
    expect(normalizeSitePattern('  HTTPS://Example.COM.  ')).toBe('https://example.com')
    expect(normalizeSitePattern('*://example.com:*')).toBe('example.com')
    expect(normalizeSitePattern('[*.]Example.com:*')).toBe('[*.]example.com')
    // IDN travels as punycode, as URLs carry it.
    expect(normalizeSitePattern('xn--bcher-kva.example')).toBe('xn--bcher-kva.example')
  })

  it('takes IP literals as one machine each', () => {
    expect(normalizeSitePattern('192.168.0.1')).toBe('192.168.0.1')
    expect(normalizeSitePattern('192.168.0.1:8443')).toBe('192.168.0.1:8443')
    expect(normalizeSitePattern('[::1]')).toBe('[::1]')
    expect(normalizeSitePattern('::1')).toBe('[::1]')
    expect(normalizeSitePattern('https://[2001:db8::1]:8443')).toBe('https://[2001:db8::1]:8443')
    // Nothing is under an address: the wildcard is refused.
    expect(parseSitePattern('[*.]192.168.0.1')).toBeNull()
    expect(parseSitePattern('[*.][::1]')).toBeNull()
    // Not an address, not a name either.
    expect(parseSitePattern('999.1.1.1')).toBeNull()
  })

  it('refuses what is not a pattern', () => {
    for (const bad of [
      '',
      '   ',
      'https://',
      'ftp://example.com',
      'example.com/path',
      'https://example.com/',
      'user@example.com',
      'exam ple.com',
      '*.example.com',
      'ex*mple.com',
      '[*.]',
      '-bad.example',
      'bad-.example',
      'example.com:0',
      'example.com:65536',
      'example.com:12a',
      `${'a'.repeat(64)}.example`,
      `${'a.'.repeat(130)}com`
    ])
      expect(parseSitePattern(bad), bad).toBeNull()
  })
})

describe('sitePatternForHost', () => {
  it('gives a bare host the subdomain wildcard and leaves an IP literal exact', () => {
    expect(sitePatternForHost('Example.com')).toBe('[*.]example.com')
    expect(sitePatternForHost('www.example.com')).toBe('[*.]www.example.com')
    expect(sitePatternForHost('10.0.0.2')).toBe('10.0.0.2')
    expect(sitePatternForHost('[::1]')).toBe('[::1]')
    // A pattern with a scheme or port is not a host.
    expect(sitePatternForHost('https://example.com')).toBeNull()
    expect(sitePatternForHost('example.com:8080')).toBeNull()
    expect(sitePatternForHost('not a host')).toBeNull()
  })
})

describe('siteAddressOf', () => {
  it("takes the scheme, host and port of a URL, the scheme's default port without one", () => {
    expect(siteAddressOf('https://Example.com/a?b#c')).toEqual({
      scheme: 'https',
      host: 'example.com',
      port: 443
    })
    expect(siteAddressOf('http://example.com:8080/')).toEqual({
      scheme: 'http',
      host: 'example.com',
      port: 8080
    })
    // WebSocket URLs are looked up as the http scheme they ride on.
    expect(siteAddressOf('wss://live.example/socket')).toEqual({
      scheme: 'https',
      host: 'live.example',
      port: 443
    })
    expect(siteAddressOf('ws://live.example/socket')?.scheme).toBe('http')
    expect(siteAddressOf('https://[::1]:8443/')).toEqual({
      scheme: 'https',
      host: '[::1]',
      port: 8443
    })
    expect(siteAddressOf('about:blank')).toBeNull()
    expect(siteAddressOf('not a url')).toBeNull()
    expect(siteAddressOf({ scheme: 'https', host: 'a.example', port: null })).toEqual({
      scheme: 'https',
      host: 'a.example',
      port: null
    })
  })
})

describe('sitePatternMatches', () => {
  const p = (text: string): SitePattern => parseSitePattern(text)!

  it('covers the host alone without [*.] and its subdomains with it', () => {
    expect(sitePatternMatches(p('example.com'), 'https://example.com/')).toBe(true)
    expect(sitePatternMatches(p('example.com'), 'https://www.example.com/')).toBe(false)
    expect(sitePatternMatches(p('[*.]example.com'), 'https://example.com/')).toBe(true)
    expect(sitePatternMatches(p('[*.]example.com'), 'https://a.b.example.com/')).toBe(true)
    expect(sitePatternMatches(p('[*.]example.com'), 'https://notexample.com/')).toBe(false)
    expect(sitePatternMatches(p('[*.]example.com'), 'https://example.com.evil/')).toBe(false)
    expect(sitePatternCoversHost(p('[*.]example.com'), 'Sub.Example.com.')).toBe(true)
    expect(sitePatternCoversHost(p('example.com'), 'sub.example.com')).toBe(false)
  })

  it('narrows to a scheme or a port when the pattern names one', () => {
    expect(sitePatternMatches(p('https://example.com'), 'https://example.com/')).toBe(true)
    expect(sitePatternMatches(p('https://example.com'), 'http://example.com/')).toBe(false)
    expect(sitePatternMatches(p('https://example.com'), 'wss://example.com/')).toBe(true)
    expect(sitePatternMatches(p('example.com:8443'), 'https://example.com:8443/')).toBe(true)
    expect(sitePatternMatches(p('example.com:8443'), 'https://example.com/')).toBe(false)
    // A pattern without a port matches the default port and any other.
    expect(sitePatternMatches(p('example.com'), 'https://example.com:8443/')).toBe(true)
    expect(sitePatternMatches(p('example.com:443'), 'https://example.com/')).toBe(true)
    expect(sitePatternMatches(p('[::1]'), 'http://[::1]:3000/')).toBe(true)
    expect(sitePatternMatches(p('example.com'), 'about:blank')).toBe(false)
  })
})

describe('compareSitePatterns and matchSitePatterns', () => {
  it('orders from the most specific: exact host, longer host, named scheme, named port', () => {
    const order = [
      'https://www.example.com:8443',
      'https://www.example.com',
      'www.example.com:8443',
      'www.example.com',
      'example.com',
      'https://[*.]www.example.com',
      '[*.]www.example.com:8443',
      '[*.]www.example.com',
      '[*.]example.com'
    ]
    const shuffled = [...order].reverse()
    const sorted = shuffled
      .map((t) => parseSitePattern(t)!)
      .sort(compareSitePatterns)
      .map((p) => p.text)
    expect(sorted).toEqual(order)
    // Ties are total (by text) so a list has one order.
    const a = parseSitePattern('a.example')!
    const b = parseSitePattern('b.example')!
    expect(compareSitePatterns(a, b)).toBeLessThan(0)
    expect(compareSitePatterns(b, a)).toBeGreaterThan(0)
    expect(compareSitePatterns(a, a)).toBe(0)
  })

  it('picks the most specific covering pattern of a list and skips what does not parse', () => {
    const list = ['[*.]example.com', 'www.example.com', 'garbage/', 'https://[*.]example.com']
    expect(matchSitePatterns(list, 'https://www.example.com/')?.text).toBe('www.example.com')
    expect(matchSitePatterns(list, 'https://cdn.example.com/')?.text).toBe(
      'https://[*.]example.com'
    )
    expect(matchSitePatterns(list, 'http://cdn.example.com/')?.text).toBe('[*.]example.com')
    expect(matchSitePatterns(list, 'https://other.example/')).toBeNull()
    expect(matchSitePatterns(list, 'about:blank')).toBeNull()
    expect(urlInSitePatterns(list, 'https://example.com/')).toBe(true)
    expect(urlInSitePatterns([], 'https://example.com/')).toBe(false)
  })
})
