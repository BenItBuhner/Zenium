import { describe, expect, it } from 'vitest'
import type { CertificateDetails } from '../types'
import {
  BLANK_URL,
  BOOKMARKS_URL,
  HISTORY_URL,
  NEW_TAB_URL,
  SETTINGS_URL,
  addressParts,
  certificateDetailsFrom,
  displayHost,
  displayUrl,
  errorPageCertificate,
  errorPageUrl,
  fullUrl,
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
    expect(inputToUrl('about:bookmarks')).toBe(BOOKMARKS_URL)
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

  it('resolves the zenium:// name users see and Chrome’s chrome:// pages to zen://', () => {
    expect(inputToUrl('zenium://newtab')).toBe(NEW_TAB_URL)
    expect(inputToUrl('zenium://settings')).toBe(SETTINGS_URL)
    expect(inputToUrl('zenium://settings/privacy')).toBe(SETTINGS_URL)
    expect(inputToUrl('ZENIUM://Newtab/')).toBe(NEW_TAB_URL)
    expect(inputToUrl('zenium://reader/?id=1')).toBe('zen://reader/?id=1')
    expect(inputToUrl('chrome://settings')).toBe(SETTINGS_URL)
    expect(inputToUrl('chrome://settings/')).toBe(SETTINGS_URL)
    expect(inputToUrl('chrome://newtab')).toBe(NEW_TAB_URL)
    expect(inputToUrl('chrome://history')).toBe(HISTORY_URL)
    // A chrome:// page Zenium has no page for stays as typed (Chromium answers it).
    expect(inputToUrl('chrome://gpu')).toBe('chrome://gpu')
  })

  it('shows an empty address and the New Tab title for the new tab page', () => {
    expect(displayUrl(NEW_TAB_URL)).toBe('')
    expect(displayUrl(`${NEW_TAB_URL}/`)).toBe('')
    // Chrome: the omnibox is empty on the new tab page even with "Always show full URLs".
    expect(fullUrl(NEW_TAB_URL)).toBe('')
    expect(fullUrl(`${NEW_TAB_URL}/`)).toBe('')
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

describe('fullUrl / addressParts', () => {
  it('keeps the scheme and www for "Always show full URLs" and for copying', () => {
    expect(fullUrl('https://www.example.com/a?b#c')).toBe('https://www.example.com/a?b#c')
    expect(fullUrl(BLANK_URL)).toBe('')
    expect(fullUrl('')).toBe('')
    expect(fullUrl(errorPageUrl(-105, 'ERR_NAME_NOT_RESOLVED', 'https://nope.invalid/'))).toBe(
      'https://nope.invalid/'
    )
    expect(
      fullUrl('zen://reader/?id=article_1&url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FZen')
    ).toBe('https://en.wikipedia.org/wiki/Zen')
    expect(fullUrl('zen://settings')).toBe('zen://settings')
  })

  it('splits the site from the dimmed path, query and fragment', () => {
    expect(addressParts('example.com/some/path')).toEqual({
      site: 'example.com',
      rest: '/some/path'
    })
    expect(addressParts('example.com?q=1')).toEqual({ site: 'example.com', rest: '?q=1' })
    expect(addressParts('example.com')).toEqual({ site: 'example.com', rest: '' })
    expect(addressParts('localhost:3000/app#x')).toEqual({
      site: 'localhost:3000',
      rest: '/app#x'
    })
    expect(addressParts('https://www.example.com/a')).toEqual({
      site: 'https://www.example.com',
      rest: '/a'
    })
    expect(addressParts('zen://settings')).toEqual({ site: 'zen://settings', rest: '' })
    expect(addressParts('file:///tmp/a.html')).toEqual({ site: 'file://', rest: '/tmp/a.html' })
    expect(addressParts('')).toEqual({ site: '', rest: '' })
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

describe('errorPageUrl: the refused certificate', () => {
  const certificate: CertificateDetails = {
    subjectName: '*.badssl.com',
    issuerName: 'DigiCert SHA2 Secure Server CA',
    validStart: 1_427_846_400_000,
    validExpiry: 1_428_883_200_000,
    fingerprint: 'sha256/6vrsUckLNSQnSOaQlHcoKdzhUR9ctSYNeHx0kSVR9gs='
  }

  it('rides in the page URL and comes back whole', () => {
    const page = errorPageUrl(
      -201,
      'ERR_CERT_DATE_INVALID',
      'https://expired.badssl.com/',
      certificate
    )
    const params = new URL(page).searchParams
    expect(params.get('code')).toBe('-201')
    expect(params.get('url')).toBe('https://expired.badssl.com/')
    expect(errorPageCertificate(params)).toEqual(certificate)
    // The plain error page (and an interstitial the host could not describe) carries none.
    expect(
      errorPageCertificate(new URL(errorPageUrl(-201, 'x', 'https://a.example/')).searchParams)
    ).toBeNull()
    expect(
      errorPageCertificate(
        new URL(errorPageUrl(-201, 'x', 'https://a.example/', null)).searchParams
      )
    ).toBeNull()
  })

  it('reads a partial or mangled description as unknown fields, and no object at all as none', () => {
    expect(certificateDetailsFrom({ subjectName: 'a.example', validExpiry: 5 })).toEqual({
      subjectName: 'a.example',
      issuerName: '',
      validStart: 0,
      validExpiry: 5,
      fingerprint: ''
    })
    expect(
      certificateDetailsFrom({ subjectName: 7, validStart: 'soon', fingerprint: null })
    ).toEqual({
      subjectName: '',
      issuerName: '',
      validStart: 0,
      validExpiry: 0,
      fingerprint: ''
    })
    expect(certificateDetailsFrom(null)).toBeNull()
    expect(certificateDetailsFrom('sha256/abc')).toBeNull()
    const params = new URLSearchParams({ certificate: '{not json' })
    expect(errorPageCertificate(params)).toBeNull()
  })
})

describe('isEmptyTabUrl (where the bookmarks bar shows in its new-tab-only mode)', () => {
  it('recognises the empty tab, the new tab page and no tab at all', () => {
    expect(isEmptyTabUrl(BLANK_URL)).toBe(true)
    // What the loaded blank page reports itself as.
    expect(isEmptyTabUrl(`${BLANK_URL}/`)).toBe(true)
    expect(isEmptyTabUrl('zen://newtab')).toBe(true)
    expect(isEmptyTabUrl('zen://newtab/')).toBe(true)
    expect(isEmptyTabUrl(null)).toBe(true)
    expect(isEmptyTabUrl(undefined)).toBe(true)
    expect(isEmptyTabUrl('')).toBe(true)
    expect(isEmptyTabUrl('https://example.com/')).toBe(false)
    expect(isEmptyTabUrl(BOOKMARKS_URL)).toBe(false)
    // The new tab page itself is only `zen://newtab`.
    expect(isNewTabUrl(BLANK_URL)).toBe(false)
  })
})
