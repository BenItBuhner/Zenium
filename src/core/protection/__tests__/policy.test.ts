import { describe, expect, it } from 'vitest'
import type { RequestContext } from '../../blocking/rules'
import type { PrivacyFlags } from '../../../shared/privacy'
import { blocksThirdPartyCookies, plaintextAllowed, signalHeaders } from '../policy'

const flags = (overrides: Partial<PrivacyFlags> = {}): PrivacyFlags => ({
  safeBrowsing: true,
  httpsOnly: 'ask',
  httpsOnlyAllowed: [],
  thirdPartyCookies: 'block-private',
  thirdPartyCookieExceptions: [],
  gpc: false,
  dnt: false,
  secureDnsMode: 'automatic',
  secureDnsServers: [],
  safeBrowsingBypassed: [],
  ...overrides
})

const ctx = (url: string, extra: Partial<RequestContext> = {}): RequestContext => ({
  url,
  type: 'image',
  method: 'GET',
  documentUrl: 'https://news.example/story',
  ...extra
})

describe('blocksThirdPartyCookies', () => {
  it('follows the mode and the partition', () => {
    const third = ctx('https://tracker.example/p.gif')
    expect(blocksThirdPartyCookies(flags({ thirdPartyCookies: 'allow' }), third)).toBe(false)
    expect(blocksThirdPartyCookies(flags({ thirdPartyCookies: 'block' }), third)).toBe(true)
    expect(blocksThirdPartyCookies(flags(), third)).toBe(false)
    expect(blocksThirdPartyCookies(flags(), { ...third, isPrivate: true })).toBe(true)
  })

  it('only concerns third-party requests with a known document', () => {
    const f = flags({ thirdPartyCookies: 'block' })
    expect(blocksThirdPartyCookies(f, ctx('https://cdn.news.example/a.js'))).toBe(false)
    expect(blocksThirdPartyCookies(f, ctx('https://news.example/', { type: 'main_frame' }))).toBe(
      false
    )
    expect(blocksThirdPartyCookies(f, ctx('https://x.example/', { documentUrl: undefined }))).toBe(
      false
    )
    expect(
      blocksThirdPartyCookies(
        f,
        ctx('https://x.example/', { documentUrl: undefined, initiator: 'https://news.example/' })
      )
    ).toBe(true)
    // A frame navigation to another site is third party to the top document.
    expect(blocksThirdPartyCookies(f, ctx('https://embed.example/f', { type: 'sub_frame' }))).toBe(
      true
    )
    // The host's own answer wins over the derivation.
    expect(
      blocksThirdPartyCookies(f, ctx('https://cdn.news.example/a.js', { isThirdParty: true }))
    ).toBe(true)
  })

  it('spares the exception sites whether they are the embedded party or the page', () => {
    const f = flags({
      thirdPartyCookies: 'block',
      thirdPartyCookieExceptions: ['sso.example', 'news.example']
    })
    expect(blocksThirdPartyCookies(f, ctx('https://login.sso.example/x'))).toBe(false)
    expect(blocksThirdPartyCookies(f, ctx('https://tracker.example/p.gif'))).toBe(false)
    expect(
      blocksThirdPartyCookies(
        f,
        ctx('https://tracker.example/p.gif', { documentUrl: 'https://shop.example/' })
      )
    ).toBe(true)
  })
})

describe('plaintextAllowed', () => {
  it('is true when the mode is off or the host is on (or under) an allowed site', () => {
    expect(plaintextAllowed(flags({ httpsOnly: 'off' }), 'http://any.example/')).toBe(true)
    const f = flags({ httpsOnlyAllowed: ['intranet.example'] })
    expect(plaintextAllowed(f, 'http://intranet.example/')).toBe(true)
    expect(plaintextAllowed(f, 'http://wiki.intranet.example/')).toBe(true)
    expect(plaintextAllowed(f, 'http://other.example/')).toBe(false)
    expect(plaintextAllowed(f, 'not a url')).toBe(false)
  })

  it('is true for non-unique hosts, which the mode never upgrades', () => {
    const f = flags()
    for (const url of [
      'http://localhost/',
      'http://dev.localhost:5173/',
      'http://127.0.0.1:8080/',
      'http://[::1]/',
      'http://10.0.0.5/',
      'http://192.168.0.10/status',
      'http://[fe80::1%25eth0]/',
      'http://router/',
      'http://printer.local/'
    ])
      expect(plaintextAllowed(f, url), url).toBe(true)
    expect(plaintextAllowed(f, 'http://example.com/')).toBe(false)
    expect(plaintextAllowed(f, 'http://8.8.8.8/')).toBe(false)
  })
})

describe('signalHeaders', () => {
  it('adds the headers of the enabled signals by their wire names', () => {
    expect(signalHeaders(flags())).toEqual({})
    expect(signalHeaders(flags({ gpc: true }))).toEqual({ 'Sec-GPC': '1' })
    expect(signalHeaders(flags({ dnt: true }))).toEqual({ DNT: '1' })
    expect(signalHeaders(flags({ gpc: true, dnt: true }))).toEqual({ 'Sec-GPC': '1', DNT: '1' })
  })
})
