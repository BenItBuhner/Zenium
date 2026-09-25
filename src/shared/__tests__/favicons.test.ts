import { describe, expect, it } from 'vitest'
import {
  ANDROID_FAVICON_PATH,
  faviconHashOf,
  faviconSrc,
  faviconUrl,
  hostFaviconUrl,
  isFaviconUrl,
  openHosts,
  siteHost
} from '../favicons'

/*
 * The favicon cache's address forms and the one rule that decides what a favicon `<img>` shows
 * (HB-47): a cached icon is drawn from the core's copy on every host, an uncached one is asked
 * of the network only for a slot that is no page's or whose page's site is open in a tab – a
 * history row or a bookmark for a closed page makes no request.
 */

const HASH = '0123456789abcdef0123456789abcdef'
const CACHED = 'https://cached.example/favicon.ico'
const LIVE = 'https://live.example/favicon.ico'

describe('the cached icon address', () => {
  it('is zen://favicon/<hash> and names a 128-bit hex hash only', () => {
    expect(faviconUrl(HASH)).toBe(`zen://favicon/${HASH}`)
    expect(faviconHashOf(`zen://favicon/${HASH}`)).toBe(HASH)
    expect(faviconHashOf(`zen://favicon/${HASH}?x=1`)).toBe(HASH)
    expect(faviconHashOf('zen://favicon/short')).toBeNull()
    expect(faviconHashOf(`zen://favicon/${HASH.toUpperCase()}`)).toBeNull()
    expect(faviconHashOf('zen://settings')).toBeNull()
    expect(faviconHashOf(CACHED)).toBeNull()
    expect(faviconHashOf(null)).toBeNull()
    expect(isFaviconUrl(`zen://favicon/${HASH}`)).toBe(true)
    expect(isFaviconUrl(CACHED)).toBe(false)
  })

  it("is served as itself on Electron and under the app origin's /zen-favicon/ on Android", () => {
    const url = faviconUrl(HASH)
    expect(hostFaviconUrl(url, 'linux')).toBe(url)
    expect(hostFaviconUrl(url, 'darwin')).toBe(url)
    expect(hostFaviconUrl(url, null)).toBe(url)
    expect(hostFaviconUrl(url, 'android')).toBe(
      `https://appassets.androidplatform.net${ANDROID_FAVICON_PATH}${HASH}`
    )
    // Any other address is left alone.
    expect(hostFaviconUrl(CACHED, 'android')).toBe(CACHED)
  })
})

describe('faviconSrc', () => {
  const index = new Map([[CACHED, HASH]])

  it('shows nothing for no icon, and an inline icon as itself', () => {
    expect(faviconSrc(null, { index, platform: 'linux' })).toBeNull()
    expect(faviconSrc('', { index, platform: 'linux' })).toBeNull()
    expect(faviconSrc('data:image/png;base64,iVBORw0KGgo=', { index, platform: 'linux' })).toBe(
      'data:image/png;base64,iVBORw0KGgo='
    )
  })

  it("draws a cached icon from the core's copy, on every host, whatever the slot", () => {
    const zen = `zen://favicon/${HASH}`
    expect(faviconSrc(CACHED, { index, platform: 'linux' })).toBe(zen)
    expect(
      faviconSrc(CACHED, { index, platform: 'linux', pageUrl: 'https://cached.example/' })
    ).toBe(zen)
    expect(
      faviconSrc(CACHED, {
        index,
        platform: 'linux',
        pageUrl: 'https://cached.example/',
        openHosts: new Set()
      })
    ).toBe(zen)
    expect(faviconSrc(CACHED, { index, platform: 'android' })).toBe(
      `https://appassets.androidplatform.net/zen-favicon/${HASH}`
    )
    // A record that already holds the content address (Android's rewritten data: icons).
    expect(faviconSrc(zen, { index: new Map(), platform: 'android' })).toBe(
      `https://appassets.androidplatform.net/zen-favicon/${HASH}`
    )
  })

  it("keeps the live address for a slot that is no page's (a tab's own row, an engine's mark)", () => {
    expect(faviconSrc(LIVE, { index, platform: 'linux' })).toBe(LIVE)
  })

  it("draws an uncached icon live only while the row's page has its site open in a tab", () => {
    const page = 'https://www.live.example/article'
    // The site is open: the live address, as before.
    expect(
      faviconSrc(LIVE, {
        index,
        platform: 'linux',
        pageUrl: page,
        openHosts: openHosts([{ url: 'https://live.example/home' }])
      })
    ).toBe(LIVE)
    // The site is not open: nothing – the row's glyph, never a request.
    expect(
      faviconSrc(LIVE, {
        index,
        platform: 'linux',
        pageUrl: page,
        openHosts: openHosts([{ url: 'https://other.example/' }])
      })
    ).toBeNull()
    expect(faviconSrc(LIVE, { index, platform: 'linux', pageUrl: page })).toBeNull()
    expect(faviconSrc(LIVE, { index, platform: 'linux', pageUrl: null })).toBeNull()
  })

  it("leaves an icon on a scheme that is no site's (an extension's own) as it was", () => {
    const own = 'chrome-extension://abcdefghijklmnop/icon.png'
    expect(faviconSrc(own, { index, platform: 'linux', pageUrl: 'https://x.example/' })).toBe(own)
  })
})

describe('the open sites', () => {
  it('are the tabs\u2019 hosts, lowercased and without www.', () => {
    expect(siteHost('https://WWW.Example.COM/a')).toBe('example.com')
    expect(siteHost('zen://settings')).toBe('')
    expect(siteHost('')).toBe('')
    expect(siteHost(null)).toBe('')
    const hosts = openHosts([
      { url: 'https://www.example.com/a' },
      { url: 'https://news.example.org/' },
      { url: 'zen://newtab' },
      { url: '' }
    ])
    expect([...hosts].sort()).toEqual(['example.com', 'news.example.org'])
  })
})
