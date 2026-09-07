import { describe, expect, it } from 'vitest'
import {
  BLANK_URL,
  displayUrl,
  errorPageUrl,
  getDomain,
  inputToUrl,
  isNavigableUrl,
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
    expect(inputToUrl('about:newtab')).toBe(BLANK_URL)
    expect(inputToUrl('about:preferences')).toBe('zen://settings')
    expect(inputToUrl('search terms')).toBeNull()
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
