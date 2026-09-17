import { describe, expect, it } from 'vitest'
import {
  cookieBytes,
  cookieHosts,
  describeSite,
  formatBytes,
  inferHttpOnly,
  otherSites,
  permissionLabel,
  type SiteCookie
} from '../siteInfo'

const cookie = (name: string, extra: Partial<SiteCookie> = {}): SiteCookie => ({
  name,
  domain: '.example.com',
  path: '/',
  secure: null,
  httpOnly: null,
  session: null,
  size: name.length + 1,
  ...extra
})

describe('describeSite', () => {
  it('describes a secure web page', () => {
    const d = describeSite('https://www.google.com/search?q=zenium#top')
    expect(d).toEqual({
      scheme: 'https',
      host: 'www.google.com',
      site: 'google.com',
      origin: 'https://www.google.com',
      path: '/search?q=zenium',
      state: 'secure',
      web: true
    })
  })

  it('marks plain http as insecure and loopback as local', () => {
    expect(describeSite('http://example.com/').state).toBe('insecure')
    expect(describeSite('http://localhost:3000/app').state).toBe('local')
    expect(describeSite('http://127.0.0.1/').state).toBe('local')
    expect(describeSite('http://localhost:3000/app').host).toBe('localhost')
  })

  it('knows the browser’s own pages and files are not sites', () => {
    for (const url of ['', 'zen://blank', 'zen://settings', 'about:blank']) {
      const d = describeSite(url)
      expect(d.web).toBe(false)
      expect(d.state).toBe('internal')
      expect(d.host).toBe('')
    }
    expect(describeSite('file:///home/me/page.html').state).toBe('local')
    expect(describeSite('file:///home/me/page.html').web).toBe(false)
    expect(describeSite('not a url').state).toBe('unknown')
    expect(describeSite('data:text/html,hi').state).toBe('unknown')
  })

  it('describes the page an error or reader page stands in for', () => {
    const error = describeSite(
      'zen://error?code=-105&description=x&url=https%3A%2F%2Fexample.com%2Fa'
    )
    expect(error.host).toBe('example.com')
    expect(error.scheme).toBe('zen')
    expect(error.state).toBe('secure')
    expect(error.web).toBe(true)
    const reader = describeSite('zen://reader?id=1&url=http%3A%2F%2Fnews.example.org%2Fstory')
    expect(reader.site).toBe('example.org')
    expect(reader.state).toBe('insecure')
    expect(describeSite('zen://error?code=-105').web).toBe(false)
  })

  it('keeps second-level country suffixes whole', () => {
    expect(describeSite('https://news.bbc.co.uk/').site).toBe('bbc.co.uk')
    expect(describeSite('https://shop.amazon.com.au/x').site).toBe('amazon.com.au')
  })
})

describe('cookieHosts', () => {
  it('walks from the host up to the registrable domain', () => {
    expect(cookieHosts('www.google.com')).toEqual(['www.google.com', 'google.com'])
    expect(cookieHosts('a.b.mail.google.com')).toEqual([
      'a.b.mail.google.com',
      'b.mail.google.com',
      'mail.google.com',
      'google.com'
    ])
    expect(cookieHosts('google.com')).toEqual(['google.com'])
    expect(cookieHosts('www.bbc.co.uk')).toEqual(['www.bbc.co.uk', 'bbc.co.uk'])
    expect(cookieHosts('localhost')).toEqual(['localhost'])
    expect(cookieHosts('')).toEqual([])
  })
})

describe('otherSites', () => {
  it('lists the sites embedded content came from, most used first, without the page’s own', () => {
    const hosts = [
      { host: 'www.google.com', count: 40 },
      { host: 'fonts.gstatic.com', count: 3 },
      { host: 'stats.g.doubleclick.net', count: 4 },
      { host: 'ad.doubleclick.net', count: 2 },
      { host: 'apis.google.com', count: 9 },
      { host: 'i.ytimg.com', count: 1 }
    ]
    expect(otherSites(hosts, 'google.com')).toEqual(['doubleclick.net', 'gstatic.com', 'ytimg.com'])
    expect(otherSites([], 'google.com')).toEqual([])
  })
})

describe('inferHttpOnly', () => {
  it('marks cookies the document cannot see as HttpOnly, leaving known flags alone', () => {
    const cookies = [cookie('NID'), cookie('AEC'), cookie('known', { httpOnly: false })]
    const out = inferHttpOnly(cookies, ['AEC', 'known'])
    expect(out.map((c) => c.httpOnly)).toEqual([true, false, false])
  })

  it('changes nothing when the page could not be asked', () => {
    const cookies = [cookie('NID')]
    expect(inferHttpOnly(cookies, null)).toBe(cookies)
  })
})

describe('formatting', () => {
  it('formats byte counts compactly', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1_258_291)).toBe('1.2 MB')
    expect(formatBytes(45.7 * 1024 * 1024)).toBe('45.7 MB')
    expect(formatBytes(3 * 1024 ** 3)).toBe('3 GB')
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })

  it('sums cookie sizes and labels permissions', () => {
    expect(cookieBytes([cookie('ab', { size: 10 }), cookie('c', { size: 5 })])).toBe(15)
    expect(permissionLabel('geolocation')).toBe('Location')
    expect(permissionLabel('camera')).toBe('Camera')
    expect(permissionLabel('something-new')).toBe('something-new')
  })
})
