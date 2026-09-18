import { describe, expect, it } from 'vitest'
import {
  certificateErrorDetail,
  cookieBytes,
  cookieHosts,
  describeSite,
  formatBytes,
  inferHttpOnly,
  isCertificateError,
  otherSites,
  permissionLabel,
  refusedCertificate,
  securityIndicator,
  type SiteCookie
} from '../siteInfo'
import type { CertificateError } from '../types'
import { errorPageUrl, httpsOnlyPageUrl, safeBrowsingPageUrl } from '../url'

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
    // Local files share one permissions site (Chrome's "file:///"); other siteless pages have none.
    expect(describeSite('file:///home/me/page.html').origin).toBe('file://')
    expect(describeSite('zen://settings').origin).toBe('')
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

describe('securityIndicator', () => {
  it('labels http "Not secure" and keeps https, loopback, file and Zenium pages label-free', () => {
    expect(securityIndicator('http://example.com/', null)).toMatchObject({
      state: 'insecure',
      label: 'Not secure'
    })
    expect(securityIndicator('http://10.0.0.7:8787/plain.html', null).label).toBe('Not secure')
    expect(securityIndicator('https://example.com/', null)).toMatchObject({
      state: 'secure',
      label: null
    })
    expect(securityIndicator('http://127.0.0.1:8787/', null)).toMatchObject({
      state: 'local',
      label: null
    })
    expect(securityIndicator('http://localhost:3000/', null).state).toBe('local')
    expect(securityIndicator('file:///tmp/a.html', null)).toMatchObject({
      state: 'local',
      title: 'Local file'
    })
    expect(securityIndicator('zen://settings', null).state).toBe('internal')
    expect(securityIndicator('zen://blank', null).state).toBe('empty')
    expect(securityIndicator('', null).state).toBe('empty')
    expect(securityIndicator('data:text/html,hi', null).state).toBe('unknown')
  })

  it('reports a refused certificate as "Not secure" and other failures as a Zenium page', () => {
    const bad = errorPageUrl(-202, 'ERR_CERT_AUTHORITY_INVALID', 'https://bad.example/')
    expect(securityIndicator(bad, -202)).toMatchObject({
      state: 'certificate-error',
      label: 'Not secure'
    })
    const dns = errorPageUrl(-105, 'ERR_NAME_NOT_RESOLVED', 'https://nowhere.example/')
    expect(securityIndicator(dns, -105)).toMatchObject({ state: 'internal', label: null })
    // An http page that failed for a certificate-range code cannot be a certificate error.
    const http = errorPageUrl(-202, 'x', 'http://plain.example/')
    expect(securityIndicator(http, -202).state).toBe('internal')
    expect(isCertificateError(-200)).toBe(true)
    expect(isCertificateError(-299)).toBe(true)
    expect(isCertificateError(-105)).toBe(false)
    expect(isCertificateError(null)).toBe(false)
  })

  it('reads the interstitials the way Chrome does: "Dangerous" and "Not secure"', () => {
    const blocked = safeBrowsingPageUrl('https://evil.example/login', 'phishing')
    expect(securityIndicator(blocked, -20)).toMatchObject({
      state: 'dangerous',
      label: 'Dangerous'
    })
    const question = httpsOnlyPageUrl('http://old.example/', -107)
    expect(securityIndicator(question, -107)).toMatchObject({
      state: 'insecure',
      label: 'Not secure'
    })
  })

  it('describes a Reader View page by the page it stands in for', () => {
    expect(securityIndicator('zen://reader?url=http%3A%2F%2Fexample.com%2F', null).label).toBe(
      'Not secure'
    )
    expect(securityIndicator('zen://reader?url=https%3A%2F%2Fexample.com%2F', null).state).toBe(
      'secure'
    )
  })

  it('reads the certificate interstitial at the https address itself, and the page proceeded to, as "Not secure"', () => {
    const error: CertificateError = {
      code: -201,
      url: 'https://expired.example/',
      certificate: null,
      bypassed: false
    }
    // The desktop writes the interstitial into the failed entry: the tab's URL is the site's.
    expect(securityIndicator('https://expired.example/', -201, error)).toMatchObject({
      state: 'certificate-error',
      label: 'Not secure'
    })
    // Proceeded past: the page loads over the broken certificate and stays "Not secure".
    expect(
      securityIndicator('https://expired.example/', null, { ...error, bypassed: true })
    ).toMatchObject({
      state: 'certificate-error',
      label: 'Not secure'
    })
    // Without an error the https page is secure as ever; an http page cannot hold one.
    expect(securityIndicator('https://expired.example/', null, null).state).toBe('secure')
    expect(securityIndicator('http://plain.example/', null, error).state).toBe('insecure')
  })
})

describe('certificate errors in site information', () => {
  const error: CertificateError = {
    code: -202,
    url: 'https://self-signed.example/',
    certificate: {
      subjectName: 'self-signed.example',
      issuerName: 'self-signed.example',
      validStart: 1_700_000_000_000,
      validExpiry: 1_800_000_000_000,
      fingerprint: 'sha256/abc'
    },
    bypassed: false
  }

  it('explains the refusal, and the choice to proceed once made', () => {
    expect(certificateErrorDetail(error)).toContain('could not be verified')
    expect(certificateErrorDetail(error)).toContain('Zenium')
    expect(certificateErrorDetail({ ...error, bypassed: true })).toContain(
      'proceed past a certificate warning'
    )
  })

  it('lists the refused certificate as the card does, and nothing when the host could not describe it', () => {
    expect(refusedCertificate(error)).toEqual({
      subject: 'self-signed.example',
      issuer: 'self-signed.example',
      validFrom: 1_700_000_000_000,
      validTo: 1_800_000_000_000,
      protocol: null
    })
    // Unknown dates (0) read as unknown, not as 1970.
    expect(
      refusedCertificate({
        ...error,
        certificate: { ...error.certificate!, validStart: 0, validExpiry: 0 }
      })
    ).toMatchObject({ validFrom: null, validTo: null })
    expect(refusedCertificate({ ...error, certificate: null })).toBeNull()
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
    expect(permissionLabel('popups')).toBe('Pop-up windows')
    expect(permissionLabel('openExternal:tel')).toBe('Open tel: links')
    expect(permissionLabel('storage-access:https://embedder.example')).toBe(
      'Cookies while embedded (embedder.example)'
    )
    expect(permissionLabel('fileSystem')).toBe('Write to files you picked')
    expect(permissionLabel('fileSystem:read')).toBe('View folders you picked')
  })
})
