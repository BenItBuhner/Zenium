import { describe, expect, it } from 'vitest'
import type { SiteCookie } from '../../shared/siteInfo'
import type { CertificateError } from '../../shared/types'
import { EMPTY_PROBE, composeSiteInfo, parseProbe, type ComposeInput } from '../siteInfo'

const cookie = (name: string, domain = '.google.com'): SiteCookie => ({
  name,
  domain,
  path: '',
  secure: true,
  httpOnly: null,
  session: null,
  size: name.length + 4
})

const base: ComposeInput = {
  tabId: 'tab_1',
  url: 'https://www.google.com/',
  containerId: 'default',
  cookies: [cookie('AEC'), cookie('NID'), cookie('host_only', 'www.google.com')],
  thirdParty: [{ site: 'doubleclick.net', count: 2 }],
  storage: { usageBytes: 4096, quotaBytes: 1_000_000, origins: ['https://www.google.com'] },
  certificate: {
    subject: '*.google.com',
    issuer: 'Google Trust Services',
    validFrom: 1,
    validTo: 2,
    protocol: null
  },
  probe: {
    ...EMPTY_PROBE,
    documentCookies: ['AEC', 'host_only'],
    hosts: [{ host: 'www.google.com', count: 12 }],
    httpResources: 0,
    localStorageItems: 3,
    estimate: { usage: 9999, quota: 5 }
  },
  permissions: [{ permission: 'geolocation', decision: 'allow' }]
}

describe('composeSiteInfo', () => {
  it('assembles the readings for a secure page', () => {
    const info = composeSiteInfo(base)
    expect(info.host).toBe('www.google.com')
    expect(info.site).toBe('google.com')
    expect(info.origin).toBe('https://www.google.com')
    expect(info.security.state).toBe('secure')
    expect(info.security.certificate?.issuer).toBe('Google Trust Services')
    expect(info.security.mixedContent).toBe(false)
    // HttpOnly comes from what the document could not see.
    expect(info.cookies.items.map((c) => [c.name, c.httpOnly])).toEqual([
      ['AEC', false],
      ['NID', true],
      ['host_only', false]
    ])
    expect(info.cookies.thirdParty).toEqual([{ site: 'doubleclick.net', count: 2 }])
    // The host's storage reading wins over the page's estimate.
    expect(info.storage.usageBytes).toBe(4096)
    expect(info.storage.quotaBytes).toBe(1_000_000)
    expect(info.storage.origins).toEqual(['https://www.google.com'])
    expect(info.storage.localStorageItems).toBe(3)
    expect(info.permissions).toEqual([{ permission: 'geolocation', decision: 'allow' }])
  })

  it('falls back to the page’s own storage estimate', () => {
    const info = composeSiteInfo({ ...base, storage: null })
    expect(info.storage.usageBytes).toBe(9999)
    expect(info.storage.quotaBytes).toBe(5)
    expect(info.storage.origins).toEqual([])
  })

  it('reports mixed content only for https pages the probe could run in', () => {
    const mixed = composeSiteInfo({ ...base, probe: { ...base.probe, httpResources: 2 } })
    expect(mixed.security.mixedContent).toBe(true)
    const unknown = composeSiteInfo({ ...base, probe: EMPTY_PROBE })
    expect(unknown.security.mixedContent).toBe(null)
    const plain = composeSiteInfo({ ...base, url: 'http://example.com/' })
    expect(plain.security.state).toBe('insecure')
    expect(plain.security.mixedContent).toBe(null)
    // A certificate is only meaningful on a secure page.
    expect(plain.security.certificate).toBe(null)
  })

  it('leaves everything unknown for the browser’s own pages', () => {
    const info = composeSiteInfo({
      ...base,
      url: 'zen://settings',
      cookies: null,
      thirdParty: [],
      storage: null,
      certificate: null,
      probe: EMPTY_PROBE,
      permissions: []
    })
    expect(info.security.state).toBe('internal')
    expect(info.host).toBe('')
    expect(info.cookies.items).toEqual([])
    expect(info.storage.usageBytes).toBe(null)
    expect(info.storage.localStorageItems).toBe(null)
  })

  it('reports an https connection over a refused certificate as not secure, with the reason and the certificate', () => {
    const certificateError: CertificateError = {
      code: -201,
      url: 'https://www.google.com/',
      certificate: {
        subjectName: '*.google.com',
        issuerName: 'Someone Else',
        validStart: 1,
        validExpiry: 2,
        fingerprint: 'sha256/x'
      },
      bypassed: false
    }
    // The interstitial is showing: the engine's certificate reading would be of the error page.
    const warned = composeSiteInfo({ ...base, certificate: null, certificateError })
    expect(warned.security.state).toBe('insecure')
    expect(warned.security.certificateError).toEqual(certificateError)
    expect(warned.security.certificate).toMatchObject({
      subject: '*.google.com',
      issuer: 'Someone Else'
    })
    // Mixed content is beside the point when the connection itself is not trusted.
    expect(warned.security.mixedContent).toBe(null)
    // Proceeded past: the page loaded over the broken certificate, still not secure.
    const bypassed = composeSiteInfo({
      ...base,
      certificateError: { ...certificateError, bypassed: true }
    })
    expect(bypassed.security.state).toBe('insecure')
    expect(bypassed.security.certificateError?.bypassed).toBe(true)
    expect(bypassed.security.certificate?.issuer).toBe('Someone Else')
    // Without one, nothing changes; an http page cannot carry a certificate error.
    expect(composeSiteInfo(base).security.certificateError).toBeUndefined()
    const plain = composeSiteInfo({ ...base, url: 'http://example.com/', certificateError })
    expect(plain.security.state).toBe('insecure')
    expect(plain.security.certificateError).toBeUndefined()
  })
})

describe('parseProbe', () => {
  it('defaults every missing or malformed reading', () => {
    expect(parseProbe(null)).toEqual(EMPTY_PROBE)
    expect(parseProbe('garbage')).toEqual(EMPTY_PROBE)
    expect(parseProbe({})).toEqual(EMPTY_PROBE)
  })

  it('shapes what the page answered', () => {
    const probe = parseProbe({
      documentCookies: ['a', 2],
      hosts: [{ host: 'CDN.Example.com', count: 3.7 }, { host: '', count: 1 }, 'junk'],
      httpResources: 1.2,
      localStorageItems: 4,
      sessionStorageItems: -1,
      serviceWorkers: '2',
      estimate: { usage: 100.4, quota: 'x' }
    })
    expect(probe).toEqual({
      documentCookies: ['a', '2'],
      hosts: [{ host: 'cdn.example.com', count: 4 }],
      httpResources: 1,
      localStorageItems: 4,
      sessionStorageItems: 0,
      serviceWorkers: null,
      estimate: { usage: 100, quota: 0 }
    })
  })
})
