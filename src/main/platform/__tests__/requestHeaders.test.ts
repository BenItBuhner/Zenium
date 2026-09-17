import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Session } from 'electron'
import {
  EDGE_ADD_ONS_URL_PATTERNS as CORE_EDGE_PATTERNS,
  WEBSTORE_URL_PATTERNS as CORE_PATTERNS
} from '../../../core/extensions/webstorePrivate'
import {
  EDGE_ADD_ONS_URL_PATTERNS,
  RequestHeaderRules,
  WEBSTORE_URL_PATTERNS,
  edgeStoreUserAgent,
  matchesPattern,
  parseMatchPattern,
  requestHeaderRules,
  webstoreClientHints,
  type RequestHeaderHandler
} from '../requestHeaders'

type Details = Electron.OnBeforeSendHeadersListenerDetails
type Listener = (
  details: Details,
  callback: (response: Electron.BeforeSendResponse) => void
) => void

class FakeSession {
  installs: Array<{ urls: string[] | null; listener: Listener | null }> = []
  webRequest = {
    onBeforeSendHeaders: (filterOrListener: unknown, listener?: unknown): void => {
      if (listener === undefined)
        this.installs.push({ urls: null, listener: filterOrListener as Listener | null })
      else
        this.installs.push({
          urls: (filterOrListener as { urls: string[] }).urls,
          listener: listener as Listener | null
        })
    }
  }
  get current(): { urls: string[] | null; listener: Listener | null } {
    return this.installs[this.installs.length - 1]
  }
  /** Run the installed listener the way Electron would and return the headers it answered with. */
  request(url: string, requestHeaders: Record<string, string>): Record<string, string> {
    const listener = this.current.listener
    if (!listener) throw new Error('no listener installed')
    let answer: Record<string, string> | undefined
    listener(details(url, requestHeaders), (response) => {
      answer = response.requestHeaders as Record<string, string>
    })
    return answer ?? requestHeaders
  }
  asSession(): Session {
    return this as unknown as Session
  }
}

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
const brand: RequestHeaderHandler['rewrite'] = (headers) => ({
  ...headers,
  'sec-ch-ua': `${headers['sec-ch-ua'] ?? ''}, "Google Chrome";v="152"`
})

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

  it('leaves requests to other origins untouched through its url patterns', () => {
    const rules = new RequestHeaderRules()
    rules.register(webstoreClientHints)
    const headers = { 'sec-ch-ua': '"Chromium";v="152", "Not_A Brand";v="24"' }
    for (const url of [
      'https://example.com/',
      'https://google.com/',
      'https://chrome.google.com/',
      'https://chromewebstore.google.com.evil.example/',
      'http://chromewebstore.google.com/'
    ]) {
      expect(rules.apply(details(url, headers)), url).toBe(headers)
    }
    for (const url of [
      'https://chromewebstore.google.com/detail/json-formatter/bcjindcccaagfpapjjmafapmmgkkhgoa',
      'https://chrome.google.com/webstore/detail/abc?hl=en'
    ]) {
      expect(rules.apply(details(url, headers)), url).toEqual({
        'sec-ch-ua': '"Chromium";v="152", "Google Chrome";v="152", "Not_A Brand";v="24"'
      })
    }
    expect(headers).toEqual({ 'sec-ch-ua': '"Chromium";v="152", "Not_A Brand";v="24"' })
  })

  it('is registered with the Edge handler, and nothing else, in the host registration', () => {
    expect(requestHeaderRules.handlerIds()).toEqual([
      'webstore-client-hints',
      'edge-store-user-agent'
    ])
  })
})

describe('edgeStoreUserAgent', () => {
  const versions = process.versions
  beforeAll(() => {
    Object.defineProperty(process, 'versions', {
      value: { ...versions, chrome: '152.0.7359.98' },
      configurable: true
    })
  })
  afterAll(() => {
    Object.defineProperty(process, 'versions', { value: versions, configurable: true })
  })

  const UA =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
  const EDGE_PAGE =
    'https://microsoftedge.microsoft.com/addons/detail/ublock-origin/odfafepnkmbhccpbejgmiehpchacaeak'
  const electronRequest = {
    'User-Agent': UA,
    'Sec-CH-UA': '"Chromium";v="152", "Not_A Brand";v="24"',
    'Sec-CH-UA-Full-Version-List': '"Chromium";v="152.0.7359.98", "Not_A Brand";v="24.0.0.0"',
    'Sec-CH-UA-Mobile': '?0',
    Accept: 'text/html',
    Cookie: 'session=abc'
  }

  it('is the Edge-origin handler, keyed on the Edge Add-ons URL pattern', () => {
    expect(edgeStoreUserAgent.id).toBe('edge-store-user-agent')
    expect(edgeStoreUserAgent.urls).toBe(EDGE_ADD_ONS_URL_PATTERNS)
    expect(EDGE_ADD_ONS_URL_PATTERNS).toEqual(CORE_EDGE_PATTERNS)
    expect(EDGE_ADD_ONS_URL_PATTERNS).toEqual(['https://microsoftedge.microsoft.com/*'])
  })

  it('appends the Edg token to the User-Agent and adds the Microsoft Edge brand', () => {
    const input = { ...electronRequest }
    const result = edgeStoreUserAgent.rewrite(input, details(EDGE_PAGE, input))
    expect(result).toEqual({
      ...electronRequest,
      'User-Agent': `${UA} Edg/152.0.0.0`,
      'Sec-CH-UA': '"Chromium";v="152", "Microsoft Edge";v="152", "Not_A Brand";v="24"',
      'Sec-CH-UA-Full-Version-List':
        '"Chromium";v="152.0.7359.98", "Microsoft Edge";v="152.0.7359.98", "Not_A Brand";v="24.0.0.0"'
    })
    expect(result['Sec-CH-UA']).not.toContain('Google Chrome')
  })

  it('is pure and idempotent', () => {
    const input = { ...electronRequest }
    const once = edgeStoreUserAgent.rewrite(input, details(EDGE_PAGE, input))
    expect(input).toEqual(electronRequest)
    expect(once).not.toBe(input)
    const twice = edgeStoreUserAgent.rewrite(once, details(EDGE_PAGE, once))
    expect(twice).toEqual(once)
    expect((twice['User-Agent'].match(/Edg\//g) ?? []).length).toBe(1)
  })

  it('adds Edg only on the Edge origin; every other request, the Chrome Web Store included, is untouched', () => {
    const rules = new RequestHeaderRules()
    rules.register(webstoreClientHints)
    rules.register(edgeStoreUserAgent)
    const headers = { 'User-Agent': UA, 'sec-ch-ua': '"Chromium";v="152", "Not_A Brand";v="24"' }
    for (const url of [
      'https://example.com/',
      'https://www.microsoft.com/en-us/edge',
      'https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect',
      'https://microsoftedge.microsoft.com.evil.example/addons/',
      'http://microsoftedge.microsoft.com/addons/'
    ]) {
      expect(rules.apply(details(url, headers)), url).toBe(headers)
    }
    for (const url of [
      'https://chromewebstore.google.com/detail/json-formatter/bcjindcccaagfpapjjmafapmmgkkhgoa',
      'https://chrome.google.com/webstore/detail/abc?hl=en'
    ]) {
      const result = rules.apply(details(url, headers))
      expect(result['User-Agent'], url).toBe(UA)
      expect(result['sec-ch-ua'], url).toBe(
        '"Chromium";v="152", "Google Chrome";v="152", "Not_A Brand";v="24"'
      )
    }
    for (const url of [EDGE_PAGE, 'https://microsoftedge.microsoft.com/addons/search/dark']) {
      expect(rules.apply(details(url, headers)), url).toEqual({
        'User-Agent': `${UA} Edg/152.0.0.0`,
        'sec-ch-ua': '"Chromium";v="152", "Microsoft Edge";v="152", "Not_A Brand";v="24"'
      })
    }
    expect(headers['User-Agent']).toBe(UA)
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
    expect(matchesPattern(parseMatchPattern('https://*/*')!, 'https://example.org/x')).toBe(true)
    expect(matchesPattern(parseMatchPattern('https://*/*')!, 'http://example.org/x')).toBe(false)
    expect(parseMatchPattern('https://chromewebstore.google.com')).toBeNull()
    expect(parseMatchPattern('https://*store.google.com/*')).toBeNull()
    expect(parseMatchPattern('chromewebstore.google.com/*')).toBeNull()
  })
})

describe('RequestHeaderRules', () => {
  it('installs one filtered listener per session that runs the matching handlers', () => {
    const rules = new RequestHeaderRules()
    const ses = new FakeSession()
    rules.register({ id: 'store', urls: [STORE], rewrite: brand })
    rules.attach(ses.asSession())
    rules.attach(ses.asSession())
    expect(ses.installs).toHaveLength(1)
    expect(ses.current.urls).toEqual([STORE])
    expect(
      ses.request('https://chromewebstore.google.com/detail/a', {
        'sec-ch-ua': '"Chromium";v="152"'
      })
    ).toEqual({ 'sec-ch-ua': '"Chromium";v="152", "Google Chrome";v="152"' })
    expect(ses.request('https://example.com/', { accept: '*/*' })).toEqual({ accept: '*/*' })
  })

  it('chains handlers in registration order and passes each the previous edits', () => {
    const rules = new RequestHeaderRules()
    rules.register({
      id: 'first',
      urls: ['https://*/*'],
      rewrite: (headers) => ({ ...headers, 'x-first': 'yes' })
    })
    rules.register({
      id: 'second',
      urls: [STORE],
      rewrite: (headers, d) => ({
        ...headers,
        'x-second': `after ${headers['x-first']} for ${new URL(d.url).hostname}`
      })
    })
    expect(rules.apply(details('https://chromewebstore.google.com/', {}))).toEqual({
      'x-first': 'yes',
      'x-second': 'after yes for chromewebstore.google.com'
    })
    expect(rules.apply(details('https://example.com/', {}))).toEqual({ 'x-first': 'yes' })
    expect(rules.apply(details('http://example.com/', { a: 'b' }))).toEqual({ a: 'b' })
  })

  it('re-filters attached sessions as handlers come and go and frees the slot when none remain', () => {
    const rules = new RequestHeaderRules()
    const ses = new FakeSession()
    rules.attach(ses.asSession())
    expect(ses.installs).toHaveLength(1)
    expect(ses.current.listener).toBeNull()

    const remove = rules.register({ id: 'store', urls: [STORE], rewrite: brand })
    expect(ses.current.urls).toEqual([STORE])
    rules.register({
      id: 'other',
      urls: ['https://example.com/*', STORE],
      rewrite: (headers) => headers
    })
    expect(ses.current.urls).toEqual([STORE, 'https://example.com/*'])
    expect(rules.handlerIds()).toEqual(['store', 'other'])

    remove()
    expect(rules.handlerIds()).toEqual(['other'])
    expect(ses.current.urls).toEqual(['https://example.com/*', STORE])
    rules.unregister('other')
    rules.unregister('missing')
    expect(ses.current.urls).toBeNull()
    expect(ses.current.listener).toBeNull()
  })

  it('replaces a handler registered under the same id and rejects invalid patterns', () => {
    const rules = new RequestHeaderRules()
    rules.register({ id: 'store', urls: [STORE], rewrite: () => ({ v: '1' }) })
    rules.register({ id: 'store', urls: [STORE], rewrite: () => ({ v: '2' }) })
    expect(rules.handlerIds()).toEqual(['store'])
    expect(rules.apply(details('https://chromewebstore.google.com/', {}))).toEqual({ v: '2' })
    expect(() =>
      rules.register({
        id: 'bad',
        urls: ['chromewebstore.google.com'],
        rewrite: (headers) => headers
      })
    ).toThrow(/invalid match pattern/)
    expect(rules.handlerIds()).toEqual(['store'])
  })

  it('detachAll removes the listeners it installed', () => {
    const rules = new RequestHeaderRules()
    const a = new FakeSession()
    const b = new FakeSession()
    rules.register({ id: 'store', urls: [STORE], rewrite: brand })
    rules.attach(a.asSession())
    rules.attach(b.asSession())
    rules.detachAll()
    expect(a.current.listener).toBeNull()
    expect(b.current.listener).toBeNull()
    rules.attach(a.asSession())
    expect(a.current.urls).toEqual([STORE])
  })
})
