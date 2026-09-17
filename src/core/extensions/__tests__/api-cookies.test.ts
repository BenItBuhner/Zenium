import { describe, expect, it } from 'vitest'
import {
  ERROR_INVALID_URL,
  containerForStoreId,
  cookieDomainMatches,
  cookieMatchesFilter,
  cookieUrl,
  formatCookieError,
  isCookieUrl,
  normalizeGetAllDetails,
  normalizeGetDetails,
  normalizeRemoveDetails,
  normalizeSetDetails,
  sortCookies,
  storeIdForContainer,
  toChangeCause,
  toChromeCookie,
  type ChromeCookie
} from '../api/cookies'
import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID } from '../../../shared/types'

const chromeCookie = (overrides: Partial<ChromeCookie> = {}): ChromeCookie => ({
  name: 'sid',
  value: '1',
  domain: '.example.com',
  hostOnly: false,
  path: '/',
  secure: true,
  httpOnly: false,
  sameSite: 'lax',
  session: true,
  storeId: '0',
  ...overrides
})

describe('isCookieUrl', () => {
  it('accepts http(s), ws(s) and file URLs only', () => {
    expect(isCookieUrl('https://example.com/')).toBe(true)
    expect(isCookieUrl('http://example.com/')).toBe(true)
    expect(isCookieUrl('wss://example.com/')).toBe(true)
    expect(isCookieUrl('file:///tmp/a.html')).toBe(true)
    expect(isCookieUrl('chrome-extension://abc/')).toBe(false)
    expect(isCookieUrl('data:text/html,hi')).toBe(false)
    expect(isCookieUrl('not a url')).toBe(false)
  })
})

describe('normalize*Details', () => {
  it('get / remove need url and name; storeId is optional', () => {
    expect(normalizeGetDetails({ url: 'https://example.com/', name: 'sid' })).toEqual({
      url: 'https://example.com/',
      name: 'sid',
      storeId: null
    })
    expect(
      normalizeRemoveDetails({ url: 'https://example.com/', name: 'sid', storeId: '1' })
    ).toEqual({ url: 'https://example.com/', name: 'sid', storeId: '1' })
    expect(() => normalizeGetDetails({ name: 'sid' })).toThrow(/Missing required property 'url'/)
    expect(() => normalizeGetDetails({ url: 'https://example.com/' })).toThrow(
      /Missing required property 'name'/
    )
    expect(() => normalizeGetDetails({ url: 'ftp://x/', name: 'a' })).toThrow(
      formatCookieError(ERROR_INVALID_URL, 'ftp://x/')
    )
    expect(() => normalizeGetDetails({ url: 'https://x/', name: 'a', storeId: 3 })).toThrow(
      /Invalid value for 'storeId'/
    )
    expect(() => normalizeGetDetails(null)).toThrow(/Invalid details/)
  })

  it('getAll takes every field optionally and tolerates no argument', () => {
    expect(normalizeGetAllDetails(undefined)).toEqual({ storeId: null })
    expect(
      normalizeGetAllDetails({
        url: 'https://example.com/a',
        name: 'n',
        domain: 'example.com',
        path: '/a',
        secure: true,
        session: false,
        storeId: '0'
      })
    ).toEqual({
      storeId: '0',
      url: 'https://example.com/a',
      name: 'n',
      domain: 'example.com',
      path: '/a',
      secure: true,
      session: false
    })
    expect(() => normalizeGetAllDetails({ secure: 'yes' })).toThrow(/Invalid value for 'secure'/)
    expect(() => normalizeGetAllDetails({ url: 'javascript:1' })).toThrow(/Invalid url/)
  })

  it('set defaults name and value to empty strings and validates sameSite and expirationDate', () => {
    expect(normalizeSetDetails({ url: 'https://example.com/' })).toEqual({
      url: 'https://example.com/',
      name: '',
      value: '',
      storeId: null
    })
    expect(
      normalizeSetDetails({
        url: 'https://example.com/',
        name: 'a',
        value: 'b',
        domain: '.example.com',
        path: '/x',
        secure: true,
        httpOnly: true,
        sameSite: 'strict',
        expirationDate: 1_900_000_000
      })
    ).toMatchObject({ sameSite: 'strict', expirationDate: 1_900_000_000, httpOnly: true })
    expect(() => normalizeSetDetails({ url: 'https://x/', sameSite: 'none' })).toThrow(
      /Invalid value for 'sameSite'/
    )
    expect(() => normalizeSetDetails({ url: 'https://x/', expirationDate: 'soon' })).toThrow(
      /Invalid value for 'expirationDate'/
    )
    expect(() => normalizeSetDetails({ url: 'https://x/', expirationDate: Infinity })).toThrow(
      /Invalid value for 'expirationDate'/
    )
  })
})

describe('toChromeCookie', () => {
  it('fills Chrome defaults from a sparse engine cookie', () => {
    expect(toChromeCookie({ name: 'a', value: 'b' }, '0')).toEqual({
      name: 'a',
      value: 'b',
      domain: '',
      hostOnly: true,
      path: '/',
      secure: false,
      httpOnly: false,
      sameSite: 'unspecified',
      session: true,
      storeId: '0'
    })
  })

  it('derives hostOnly from the leading dot and session from the expiry', () => {
    const persistent = toChromeCookie(
      { name: 'a', value: 'b', domain: '.example.com', expirationDate: 1234, sameSite: 'strict' },
      '1'
    )
    expect(persistent).toMatchObject({
      hostOnly: false,
      session: false,
      expirationDate: 1234,
      sameSite: 'strict',
      storeId: '1'
    })
    const hostOnly = toChromeCookie({ name: 'a', value: 'b', domain: 'example.com' }, '0')
    expect(hostOnly.hostOnly).toBe(true)
    expect(hostOnly).not.toHaveProperty('expirationDate')
    // An explicit session flag wins over the expiry heuristic; unknown sameSite is unspecified.
    expect(
      toChromeCookie(
        { name: 'a', value: 'b', session: true, expirationDate: 5, sameSite: 'weird' },
        '0'
      )
    ).toMatchObject({ session: true, sameSite: 'unspecified' })
  })
})

describe('filters and ordering', () => {
  it('cookieDomainMatches compares domains and sub-domains regardless of leading dots', () => {
    expect(cookieDomainMatches('.example.com', 'example.com')).toBe(true)
    expect(cookieDomainMatches('example.com', '.example.com')).toBe(true)
    expect(cookieDomainMatches('www.example.com', 'example.com')).toBe(true)
    expect(cookieDomainMatches('EXAMPLE.com', 'example.COM')).toBe(true)
    expect(cookieDomainMatches('example.com', 'www.example.com')).toBe(false)
    expect(cookieDomainMatches('notexample.com', 'example.com')).toBe(false)
  })

  it('cookieMatchesFilter applies name, domain, path, secure and session', () => {
    const cookie = chromeCookie({ path: '/app', secure: true, session: false })
    expect(cookieMatchesFilter(cookie, { storeId: null })).toBe(true)
    expect(cookieMatchesFilter(cookie, { storeId: null, name: 'sid' })).toBe(true)
    expect(cookieMatchesFilter(cookie, { storeId: null, name: 'other' })).toBe(false)
    expect(cookieMatchesFilter(cookie, { storeId: null, domain: 'example.com' })).toBe(true)
    expect(cookieMatchesFilter(cookie, { storeId: null, path: '/' })).toBe(false)
    expect(cookieMatchesFilter(cookie, { storeId: null, path: '/app' })).toBe(true)
    expect(cookieMatchesFilter(cookie, { storeId: null, secure: false })).toBe(false)
    expect(cookieMatchesFilter(cookie, { storeId: null, session: true })).toBe(false)
  })

  it('sortCookies puts longer paths first and keeps creation order otherwise', () => {
    const sorted = sortCookies([
      chromeCookie({ name: 'a', path: '/' }),
      chromeCookie({ name: 'b', path: '/deep/er' }),
      chromeCookie({ name: 'c', path: '/deep' }),
      chromeCookie({ name: 'd', path: '/' })
    ])
    expect(sorted.map((c) => c.name)).toEqual(['b', 'c', 'a', 'd'])
  })
})

describe('change causes, URLs and store ids', () => {
  it('maps the engine causes onto Chrome names, explicit for anything else', () => {
    expect(toChangeCause('explicit')).toBe('explicit')
    expect(toChangeCause('overwrite')).toBe('overwrite')
    expect(toChangeCause('expired')).toBe('expired')
    expect(toChangeCause('evicted')).toBe('evicted')
    expect(toChangeCause('expired-overwrite')).toBe('expired_overwrite')
    expect(toChangeCause('expired_overwrite')).toBe('expired_overwrite')
    expect(toChangeCause('unknown')).toBe('explicit')
  })

  it('cookieUrl follows GetURLFromCanonicalCookie', () => {
    expect(cookieUrl({ domain: '.example.com', secure: true, path: '/a' })).toBe(
      'https://example.com/a'
    )
    expect(cookieUrl({ domain: 'example.com', secure: false, path: '' })).toBe(
      'http://example.com/'
    )
  })

  it('maps the default and private containers to Chrome store ids 0 and 1', () => {
    expect(storeIdForContainer(DEFAULT_CONTAINER_ID)).toBe('0')
    expect(storeIdForContainer(PRIVATE_CONTAINER_ID)).toBe('1')
    expect(storeIdForContainer('work')).toBe('work')
    expect(containerForStoreId('0')).toBe(DEFAULT_CONTAINER_ID)
    expect(containerForStoreId('1')).toBe(PRIVATE_CONTAINER_ID)
    expect(containerForStoreId('work')).toBe('work')
  })
})
