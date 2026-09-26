import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HOMEPAGE,
  defaultHomepageOf,
  extensionHomepage,
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

describe('an extension’s homepage over the user’s (chrome_settings_overrides.homepage)', () => {
  const control = {
    extensionId: 'a'.repeat(32),
    name: 'Bing Homepage',
    value: 'https://www.bing.com/'
  }

  it('is the page a Home control opens while the Home button is on, as a Specific page homepage; the user’s own otherwise', () => {
    const newtab = { mode: 'newtab' as const, url: '' }
    expect(extensionHomepage(newtab, control)).toBe('https://www.bing.com/')
    expect(defaultHomepageOf(newtab, control)).toEqual({
      mode: 'url',
      url: 'https://www.bing.com/'
    })
    const own = { mode: 'url' as const, url: 'https://news.example/' }
    expect(defaultHomepageOf(own, control)).toEqual({ mode: 'url', url: 'https://www.bing.com/' })
    // No extension: the user's own, the same object, so a caller can tell nothing changed.
    expect(defaultHomepageOf(own, undefined)).toBe(own)
    expect(defaultHomepageOf(own, null)).toBe(own)
    expect(extensionHomepage(own, undefined)).toBeNull()
  })

  it('leaves Off alone – Chrome’s "Show home button" is the user’s, no extension draws a Home button – and ignores a value that is not a web page', () => {
    const off = { mode: 'off' as const, url: '' }
    expect(extensionHomepage(off, control)).toBeNull()
    expect(defaultHomepageOf(off, control)).toBe(off)
    const newtab = { mode: 'newtab' as const, url: '' }
    expect(defaultHomepageOf(newtab, { ...control, value: 'zen://settings' })).toBe(newtab)
    expect(defaultHomepageOf(newtab, { ...control, value: 20 })).toBe(newtab)
    const valueless: { extensionId: string; name: string; value?: unknown } = { ...control }
    delete valueless.value
    expect(defaultHomepageOf(newtab, valueless)).toBe(newtab)
  })
})
