import { describe, expect, it } from 'vitest'
import {
  BLANK_URL,
  NEW_TAB_URL,
  SETTINGS_URL,
  displayHost,
  displayUrl,
  errorPageUrl,
  getDomain,
  inputToUrl,
  isEmptyTabUrl,
  isNavigableUrl,
  isNewTabUrl,
  isProbablyUrl,
  isSameSite,
  titleForUrl
} from '../url'

describe('isProbablyUrl / inputToUrl', () => {
  it('recognises hosts, IPs, localhost and schemes', () => {
    expect(isProbablyUrl('example.com')).toBe(true)
    expect(isProbablyUrl('sub.example.co.uk/path?q=1')).toBe(true)
    expect(isProbablyUrl('localhost:3000')).toBe(true)
    expect(isProbablyUrl('192.168.1.1')).toBe(true)
    expect(isProbablyUrl('https://zen-browser.app')).toBe(true)
    expect(isProbablyUrl('about:blank')).toBe(true)
  })

  it('treats plain words, sentences and numbers as searches', () => {
    expect(isProbablyUrl('zen browser')).toBe(false)
    expect(isProbablyUrl('how to split tabs')).toBe(false)
    expect(isProbablyUrl('1.5')).toBe(false)
    expect(isProbablyUrl('hello')).toBe(false)
    expect(isProbablyUrl('javascript:alert(1)')).toBe(false)
  })

  it('upgrades bare hosts to https, keeps local servers on http and maps about: pages', () => {
    expect(inputToUrl('example.com')).toBe('https://example.com')
    expect(inputToUrl('http://example.com')).toBe('http://example.com')
    expect(inputToUrl('localhost:3000/app')).toBe('http://localhost:3000/app')
    expect(inputToUrl('192.168.1.1')).toBe('http://192.168.1.1')
    expect(inputToUrl('devbox:8080')).toBe('http://devbox:8080')
    expect(inputToUrl('about:blank')).toBe(BLANK_URL)
    expect(inputToUrl('about:newtab')).toBe(NEW_TAB_URL)
    expect(inputToUrl('about:home')).toBe(NEW_TAB_URL)
    expect(inputToUrl('about:preferences')).toBe(SETTINGS_URL)
    expect(inputToUrl('about:Settings')).toBe(SETTINGS_URL)
    expect(inputToUrl('search terms')).toBeNull()
  })
})

describe('new tab and settings pages', () => {
  it('recognises the new tab page with and without Chromium’s trailing slash', () => {
    expect(isNewTabUrl(NEW_TAB_URL)).toBe(true)
    expect(isNewTabUrl(`${NEW_TAB_URL}/`)).toBe(true)
    expect(isNewTabUrl('zen://newtabs')).toBe(false)
    expect(isNewTabUrl('https://example.com/zen://newtab')).toBe(false)
  })

  it('treats blank and new tab pages as empty tabs', () => {
    expect(isEmptyTabUrl('')).toBe(true)
    expect(isEmptyTabUrl(BLANK_URL)).toBe(true)
    expect(isEmptyTabUrl(NEW_TAB_URL)).toBe(true)
    expect(isEmptyTabUrl('https://example.com/')).toBe(false)
    expect(isEmptyTabUrl(SETTINGS_URL)).toBe(false)
  })

  it('maps the about: aliases of Settings to zen://settings (a chrome surface, see zenPages)', () => {
    expect(inputToUrl('about:preferences')).toBe(SETTINGS_URL)
    expect(inputToUrl('about:settings')).toBe(SETTINGS_URL)
    expect(inputToUrl('ABOUT:Preferences')).toBe(SETTINGS_URL)
  })

  it('shows an empty address and the New Tab title for the new tab page', () => {
    expect(displayUrl(NEW_TAB_URL)).toBe('')
    expect(displayUrl(`${NEW_TAB_URL}/`)).toBe('')
    expect(titleForUrl(NEW_TAB_URL)).toBe('New Tab')
  })
})

describe('displayUrl', () => {
  it('trims scheme, www and the trailing slash like Firefox', () => {
    expect(displayUrl('https://www.example.com/')).toBe('example.com')
    expect(displayUrl('https://example.com/path/')).toBe('example.com/path/')
    expect(displayUrl('http://example.com')).toBe('example.com')
    expect(displayUrl(BLANK_URL)).toBe('')
  })

  it('shows the original URL for error and reader pages', () => {
    expect(displayUrl(errorPageUrl(-105, 'ERR_NAME_NOT_RESOLVED', 'https://nope.invalid/'))).toBe(
      'nope.invalid'
    )
    expect(
      displayUrl('zen://reader/?id=article_1&url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FZen')
    ).toBe('en.wikipedia.org/wiki/Zen')
  })
})

describe('displayHost', () => {
  it('shows the site alone, never the path or query', () => {
    expect(displayHost('https://www.google.com/search?q=android+parity&oq=and')).toBe('google.com')
    expect(displayHost('https://en.wikipedia.org/wiki/Zen_(browser)#History')).toBe(
      'en.wikipedia.org'
    )
    expect(displayHost('http://example.com')).toBe('example.com')
    expect(displayHost('https://user:pw@example.com/private')).toBe('example.com')
  })

  it('keeps a non-default port and drops the default one', () => {
    expect(displayHost('http://localhost:5173/app/index.html')).toBe('localhost:5173')
    expect(displayHost('https://example.com:443/')).toBe('example.com')
  })

  it('shows the site an error or reader page stands in for', () => {
    expect(
      displayHost(errorPageUrl(-105, 'ERR_NAME_NOT_RESOLVED', 'https://nope.invalid/deep/path'))
    ).toBe('nope.invalid')
    expect(
      displayHost('zen://reader/?id=article_1&url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FZen')
    ).toBe('en.wikipedia.org')
  })

  it('falls back to the display form where there is no site', () => {
    expect(displayHost(BLANK_URL)).toBe('')
    expect(displayHost('')).toBe('')
    expect(displayHost('zen://settings')).toBe('zen://settings')
    expect(displayHost('file:///home/me/notes.html')).toBe('file:///home/me/notes.html')
  })
})

describe('domains', () => {
  it('computes an approximate registrable domain', () => {
    expect(getDomain('https://www.iana.org/domains')).toBe('iana.org')
    expect(getDomain('https://news.bbc.co.uk/')).toBe('bbc.co.uk')
    expect(getDomain('http://localhost:8080/')).toBe('localhost')
    expect(getDomain('http://127.0.0.1/')).toBe('127.0.0.1')
  })

  it('compares sites for the pinned-tab third-party rule', () => {
    expect(isSameSite('https://example.com/a', 'https://www.example.com/b')).toBe(true)
    expect(isSameSite('https://example.com/', 'https://iana.org/')).toBe(false)
  })
})

describe('misc', () => {
  it('produces titles and validates navigable schemes', () => {
    expect(titleForUrl(BLANK_URL)).toBe('New Tab')
    expect(titleForUrl('https://www.example.com/x')).toBe('example.com')
    expect(isNavigableUrl('https://a.b')).toBe(true)
    expect(isNavigableUrl('javascript:void 0')).toBe(false)
    expect(isNavigableUrl('')).toBe(false)
  })
})
