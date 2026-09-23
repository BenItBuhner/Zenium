import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HOMEPAGE,
  homepageAddress,
  homepageDisplay,
  homepageHasPage,
  isHomepageMode,
  sanitizeHomepage
} from '../homepage'

/*
 * The homepage setting (SET-36 / NTP-30): what a typed address stands for, what a stored or
 * synced value reads as, and what the Settings row shows for it.
 */

describe('homepageAddress', () => {
  it('reads a bare host as its https page and keeps a full address as typed', () => {
    expect(homepageAddress('example.com')).toBe('https://example.com/')
    expect(homepageAddress('  news.ycombinator.com  ')).toBe('https://news.ycombinator.com/')
    expect(homepageAddress('http://intranet.local/start?x=1')).toBe(
      'http://intranet.local/start?x=1'
    )
    expect(homepageAddress('https://docs.example/a/b#c')).toBe('https://docs.example/a/b#c')
  })

  it('refuses what a Home action could not load as a page: nothing, an internal page, a script, a search', () => {
    expect(homepageAddress('')).toBeNull()
    expect(homepageAddress('   ')).toBeNull()
    expect(homepageAddress('zen://settings')).toBeNull()
    expect(homepageAddress('zenium://newtab')).toBeNull()
    expect(homepageAddress('about:blank')).toBeNull()
    expect(homepageAddress('javascript:alert(1)')).toBeNull()
    expect(homepageAddress('what is a homepage')).toBeNull()
  })
})

describe('sanitizeHomepage', () => {
  it('reads anything that is not the setting as the default (the new tab page), a fresh copy each time', () => {
    for (const raw of [undefined, null, 'newtab', 3, [], true]) {
      const read = sanitizeHomepage(raw)
      expect(read).toEqual(DEFAULT_HOMEPAGE)
      expect(read).not.toBe(DEFAULT_HOMEPAGE)
    }
    expect(sanitizeHomepage({})).toEqual({ mode: 'newtab', url: '' })
  })

  it('keeps a known mode and a web address, and reads an unknown mode as the default’s', () => {
    expect(sanitizeHomepage({ mode: 'off', url: '' })).toEqual({ mode: 'off', url: '' })
    expect(sanitizeHomepage({ mode: 'url', url: 'example.com' })).toEqual({
      mode: 'url',
      url: 'https://example.com/'
    })
    expect(sanitizeHomepage({ mode: 'blank', url: 'https://example.com/' })).toEqual({
      mode: 'newtab',
      url: 'https://example.com/'
    })
    expect(isHomepageMode('url')).toBe(true)
    expect(isHomepageMode('blank')).toBe(false)
    expect(isHomepageMode(1)).toBe(false)
  })

  it('drops an address that is not a web page’s – a peer cannot make Home open an internal page', () => {
    expect(sanitizeHomepage({ mode: 'url', url: 'zen://settings' })).toEqual({
      mode: 'url',
      url: ''
    })
    expect(sanitizeHomepage({ mode: 'url', url: 'javascript:alert(1)' })).toEqual({
      mode: 'url',
      url: ''
    })
    expect(sanitizeHomepage({ mode: 'url', url: 42 })).toEqual({ mode: 'url', url: '' })
  })
})

describe('what the row shows', () => {
  it('names a page only for a Specific page homepage with an address', () => {
    expect(homepageHasPage({ mode: 'url', url: 'https://example.com/' })).toBe(true)
    expect(homepageHasPage({ mode: 'url', url: '' })).toBe(false)
    expect(homepageHasPage({ mode: 'newtab', url: 'https://example.com/' })).toBe(false)
    expect(homepageHasPage({ mode: 'off', url: 'https://example.com/' })).toBe(false)
  })

  it('shows the page without its scheme or trailing slash, and nothing for the other modes', () => {
    expect(homepageDisplay({ mode: 'url', url: 'https://news.ycombinator.com/' })).toBe(
      'news.ycombinator.com'
    )
    expect(homepageDisplay({ mode: 'url', url: 'https://docs.example/a/b' })).toBe(
      'docs.example/a/b'
    )
    expect(homepageDisplay({ mode: 'url', url: '' })).toBe('')
    expect(homepageDisplay({ mode: 'newtab', url: 'https://example.com/' })).toBe('')
  })
})
