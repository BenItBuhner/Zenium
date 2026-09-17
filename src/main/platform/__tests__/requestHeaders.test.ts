import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WEBSTORE_URL_PATTERNS as CORE_PATTERNS } from '../../../core/extensions/webstorePrivate'
import {
  WEBSTORE_URL_PATTERNS,
  compileMatchPatterns,
  matchesPattern,
  parseMatchPattern,
  webstoreClientHints
} from '../requestHeaders'

type Details = Electron.OnBeforeSendHeadersListenerDetails

function details(url: string, requestHeaders: Record<string, string>): Details {
  return {
    id: 1,
    url,
    method: 'GET',
    webContentsId: 1,
    frame: undefined,
    resourceType: 'mainFrame',
    referrer: '',
    timestamp: 0,
    uploadData: [],
    requestHeaders
  } as unknown as Details
}

const STORE = 'https://chromewebstore.google.com/*'

describe('webstoreClientHints', () => {
  const versions = process.versions
  beforeAll(() => {
    // Electron's main process reports the Chromium build here; Node alone does not.
    Object.defineProperty(process, 'versions', {
      value: { ...versions, chrome: '152.0.7359.98' },
      configurable: true
    })
  })
  afterAll(() => {
    Object.defineProperty(process, 'versions', { value: versions, configurable: true })
  })

  const electronHints = {
    'Sec-CH-UA': '"Chromium";v="152", "Not_A Brand";v="24"',
    'Sec-CH-UA-Full-Version-List': '"Chromium";v="152.0.7359.98", "Not_A Brand";v="24.0.0.0"',
    'Sec-CH-UA-Mobile': '?0',
    Accept: 'text/html',
    Cookie: 'session=abc'
  }

  it('is the store-origin handler, keyed on the store URL patterns', () => {
    expect(webstoreClientHints.id).toBe('webstore-client-hints')
    expect(webstoreClientHints.urls).toBe(WEBSTORE_URL_PATTERNS)
    expect(WEBSTORE_URL_PATTERNS).toEqual(CORE_PATTERNS)
    expect(WEBSTORE_URL_PATTERNS).toEqual([
      'https://chromewebstore.google.com/*',
      'https://chrome.google.com/webstore/*'
    ])
  })

  it('adds the Google Chrome brand to Sec-CH-UA and Sec-CH-UA-Full-Version-List', () => {
    const input = { ...electronHints }
    const result = webstoreClientHints.rewrite(
      input,
      details('https://chromewebstore.google.com/', input)
    )
    expect(result).toEqual({
      ...electronHints,
      'Sec-CH-UA': '"Chromium";v="152", "Google Chrome";v="152", "Not_A Brand";v="24"',
      'Sec-CH-UA-Full-Version-List':
        '"Chromium";v="152.0.7359.98", "Google Chrome";v="152.0.7359.98", "Not_A Brand";v="24.0.0.0"'
    })
  })

  it('is pure: returns a new map, leaves the input alone, and is idempotent', () => {
    const input = { ...electronHints }
    const once = webstoreClientHints.rewrite(
      input,
      details('https://chromewebstore.google.com/', input)
    )
    expect(input).toEqual(electronHints)
    expect(once).not.toBe(input)
    const twice = webstoreClientHints.rewrite(
      once,
      details('https://chromewebstore.google.com/', once)
    )
    expect(twice).toEqual(once)
  })

  it('passes unrelated headers through untouched and writes Sec-CH-UA in full when absent', () => {
    const input = { Accept: '*/*', 'Accept-Language': 'en-US', Authorization: 'Bearer x' }
    const result = webstoreClientHints.rewrite(
      input,
      details('https://chromewebstore.google.com/', input)
    )
    expect(result).toEqual({
      ...input,
      'sec-ch-ua': '"Chromium";v="152", "Google Chrome";v="152", "Not_A Brand";v="24"'
    })
    for (const [name, value] of Object.entries(input)) expect(result[name]).toBe(value)
  })

  it('selects the store origins only through its url patterns', () => {
    const store = compileMatchPatterns(webstoreClientHints.urls)
    for (const url of [
      'https://example.com/',
      'https://google.com/',
      'https://chrome.google.com/',
      'https://chromewebstore.google.com.evil.example/',
      'http://chromewebstore.google.com/'
    ]) {
      expect(store(url), url).toBe(false)
    }
    for (const url of [
      'https://chromewebstore.google.com/detail/json-formatter/bcjindcccaagfpapjjmafapmmgkkhgoa',
      'https://chrome.google.com/webstore/detail/abc?hl=en'
    ]) {
      expect(store(url), url).toBe(true)
    }
  })
})

describe('match patterns', () => {
  it('matches scheme, host and path with the query included', () => {
    const p = parseMatchPattern(STORE)!
    expect(matchesPattern(p, 'https://chromewebstore.google.com/')).toBe(true)
    expect(matchesPattern(p, 'https://chromewebstore.google.com/detail/x/abc?hl=en')).toBe(true)
    expect(matchesPattern(p, 'http://chromewebstore.google.com/')).toBe(false)
    expect(matchesPattern(p, 'https://chromewebstore.google.com.evil.example/')).toBe(false)
    expect(matchesPattern(p, 'https://www.chromewebstore.google.com/')).toBe(false)
    expect(matchesPattern(p, 'not a url')).toBe(false)
  })

  it('handles wildcard schemes and subdomains', () => {
    const p = parseMatchPattern('*://*.google.com/webstore/*')!
    expect(matchesPattern(p, 'https://chrome.google.com/webstore/detail/abc')).toBe(true)
    expect(matchesPattern(p, 'http://google.com/webstore/')).toBe(true)
    expect(matchesPattern(p, 'https://chrome.google.com/store/')).toBe(false)
    expect(matchesPattern(p, 'ftp://chrome.google.com/webstore/')).toBe(false)
    expect(matchesPattern(p, 'https://notgoogle.com/webstore/')).toBe(false)
  })

  it('accepts <all_urls> and any-host patterns, rejects malformed ones', () => {
    expect(matchesPattern(parseMatchPattern('<all_urls>')!, 'file:///tmp/a.crx')).toBe(true)
    expect(matchesPattern(parseMatchPattern('file:///*')!, 'file:///tmp/a.crx')).toBe(true)
    expect(matchesPattern(parseMatchPattern('https://*/*')!, 'https://example.org/x')).toBe(true)
    expect(matchesPattern(parseMatchPattern('https://*/*')!, 'http://example.org/x')).toBe(false)
    expect(parseMatchPattern('https://chromewebstore.google.com')).toBeNull()
    expect(parseMatchPattern('https://*store.google.com/*')).toBeNull()
    expect(parseMatchPattern('chromewebstore.google.com/*')).toBeNull()
    expect(parseMatchPattern('https://example:x/*')).toBeNull()
    expect(parseMatchPattern('https:///*')).toBeNull()
  })

  it('reads a port as Chromium does: explicit or the scheme default, `*` or absent for any', () => {
    const scoped = parseMatchPattern('http://localhost:8080/*')!
    expect(matchesPattern(scoped, 'http://localhost:8080/x')).toBe(true)
    expect(matchesPattern(scoped, 'http://localhost/x')).toBe(false)
    expect(matchesPattern(scoped, 'http://localhost:80/x')).toBe(false)
    const defaults = parseMatchPattern('https://site.example:443/*')!
    expect(matchesPattern(defaults, 'https://site.example/')).toBe(true)
    expect(matchesPattern(defaults, 'https://site.example:8443/')).toBe(false)
    const any = parseMatchPattern('https://site.example:*/*')!
    expect(matchesPattern(any, 'https://site.example:8443/')).toBe(true)
    expect(matchesPattern(any, 'https://site.example/')).toBe(true)
  })

  it('compiles several patterns to one predicate that ignores the ones Chromium rejects', () => {
    const scoped = compileMatchPatterns(['*://*.example/path*', 'http://localhost:8080/*'])
    expect(scoped('https://a.b.example/path/deep?q=1')).toBe(true)
    expect(scoped('http://example/path')).toBe(true)
    expect(scoped('https://example/other')).toBe(false)
    expect(scoped('ftp://example/path')).toBe(false)
    expect(scoped('http://localhost:8080/x')).toBe(true)
    expect(scoped('not a url')).toBe(false)
    for (const bad of ['https://*foo.example/*', 'https://example', '*.example/*'])
      expect(compileMatchPatterns([bad])('https://example/')).toBe(false)
    expect(compileMatchPatterns(['https://example', '<all_urls>'])('https://example/')).toBe(true)
  })
})
