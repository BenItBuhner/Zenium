import { describe, expect, it } from 'vitest'
import type { Session } from 'electron'
import { RequestHeaderRules, matchesPattern, parseMatchPattern } from '../requestHeaders'

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
const brand = (details: Details): Record<string, string> => ({
  ...details.requestHeaders,
  'sec-ch-ua': `${details.requestHeaders['sec-ch-ua'] ?? ''}, "Google Chrome";v="152"`
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
  it('installs one filtered listener per session that runs the matching rules', () => {
    const rules = new RequestHeaderRules()
    const ses = new FakeSession()
    rules.register({ id: 'store', urls: [STORE], headers: brand })
    rules.attach(ses.asSession())
    rules.attach(ses.asSession())
    expect(ses.installs).toHaveLength(1)
    expect(ses.current.urls).toEqual([STORE])
    expect(
      ses.request('https://chromewebstore.google.com/detail/a', {
        'sec-ch-ua': '"Chromium";v="152"'
      })
    ).toEqual({
      'sec-ch-ua': '"Chromium";v="152", "Google Chrome";v="152"'
    })
    expect(ses.request('https://example.com/', { accept: '*/*' })).toEqual({ accept: '*/*' })
  })

  it('chains rules in registration order and passes each the previous edits', () => {
    const rules = new RequestHeaderRules()
    rules.register({
      id: 'first',
      urls: ['https://*/*'],
      headers: (d) => ({ ...d.requestHeaders, 'x-first': 'yes' })
    })
    rules.register({
      id: 'second',
      urls: [STORE],
      headers: (d) => ({ ...d.requestHeaders, 'x-second': `after ${d.requestHeaders['x-first']}` })
    })
    expect(rules.apply(details('https://chromewebstore.google.com/', {}))).toEqual({
      'x-first': 'yes',
      'x-second': 'after yes'
    })
    expect(rules.apply(details('https://example.com/', {}))).toEqual({ 'x-first': 'yes' })
    expect(rules.apply(details('http://example.com/', { a: 'b' }))).toEqual({ a: 'b' })
  })

  it('re-filters attached sessions as rules come and go and frees the slot when none remain', () => {
    const rules = new RequestHeaderRules()
    const ses = new FakeSession()
    rules.attach(ses.asSession())
    expect(ses.installs).toHaveLength(1)
    expect(ses.current.listener).toBeNull()

    const remove = rules.register({ id: 'store', urls: [STORE], headers: brand })
    expect(ses.current.urls).toEqual([STORE])
    rules.register({
      id: 'other',
      urls: ['https://example.com/*', STORE],
      headers: (d) => d.requestHeaders
    })
    expect(ses.current.urls).toEqual([STORE, 'https://example.com/*'])
    expect(rules.ruleIds()).toEqual(['store', 'other'])

    remove()
    expect(rules.ruleIds()).toEqual(['other'])
    expect(ses.current.urls).toEqual(['https://example.com/*', STORE])
    rules.unregister('other')
    rules.unregister('missing')
    expect(ses.current.urls).toBeNull()
    expect(ses.current.listener).toBeNull()
  })

  it('replaces a rule registered under the same id and rejects invalid patterns', () => {
    const rules = new RequestHeaderRules()
    rules.register({ id: 'store', urls: [STORE], headers: () => ({ v: '1' }) })
    rules.register({ id: 'store', urls: [STORE], headers: () => ({ v: '2' }) })
    expect(rules.ruleIds()).toEqual(['store'])
    expect(rules.apply(details('https://chromewebstore.google.com/', {}))).toEqual({ v: '2' })
    expect(() =>
      rules.register({
        id: 'bad',
        urls: ['chromewebstore.google.com'],
        headers: (d) => d.requestHeaders
      })
    ).toThrow(/invalid match pattern/)
    expect(rules.ruleIds()).toEqual(['store'])
  })

  it('detachAll removes the listeners it installed', () => {
    const rules = new RequestHeaderRules()
    const a = new FakeSession()
    const b = new FakeSession()
    rules.register({ id: 'store', urls: [STORE], headers: brand })
    rules.attach(a.asSession())
    rules.attach(b.asSession())
    rules.detachAll()
    expect(a.current.listener).toBeNull()
    expect(b.current.listener).toBeNull()
    rules.attach(a.asSession())
    expect(a.current.urls).toEqual([STORE])
  })
})
