import { describe, expect, it } from 'vitest'
import type { Certificate } from 'electron'
import {
  certificateNames,
  hostKey,
  nameCovers,
  SITE_CERTIFICATE_RECORDS,
  SiteCertificateRecords,
  SiteCertificates,
  siteCertificateOf,
  VERDICT_CHROMIUMS,
  type CertificateVerification,
  type VerifyingSession
} from '../siteCertificates'

/**
 * A self-signed EC certificate for `a.example` (`O=Zenium Tests`), good for `a.example`,
 * `*.b.example` and `127.0.0.1` – made with
 * `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 7300
 *  -subj '/O=Zenium Tests/CN=a.example' -addext 'subjectAltName=DNS:a.example,DNS:*.b.example,IP:127.0.0.1'`.
 */
const FIXTURE_PEM = `-----BEGIN CERTIFICATE-----
MIIB1DCCAXqgAwIBAgIUVIMnWuGcG9Y55QFqVOBhks2tj8gwCgYIKoZIzj0EAwIw
KzEVMBMGA1UECgwMWmVuaXVtIFRlc3RzMRIwEAYDVQQDDAlhLmV4YW1wbGUwHhcN
MjYwOTI0MjMzMjU1WhcNNDYwOTE5MjMzMjU1WjArMRUwEwYDVQQKDAxaZW5pdW0g
VGVzdHMxEjAQBgNVBAMMCWEuZXhhbXBsZTBZMBMGByqGSM49AgEGCCqGSM49AwEH
A0IABBW8aUpNWOBJjAAJfgHYRGcPm6uLbLVO2TCumDaOFtNux9UAMN6GRvvm9IAq
kVH7oEPmBFDYiPU2xjAlNv5RcrijfDB6MB0GA1UdDgQWBBQ0CpjY9CSf28RjFl7d
Icr5bIAfOzAfBgNVHSMEGDAWgBQ0CpjY9CSf28RjFl7dIcr5bIAfOzAPBgNVHRMB
Af8EBTADAQH/MCcGA1UdEQQgMB6CCWEuZXhhbXBsZYILKi5iLmV4YW1wbGWHBH8A
AAEwCgYIKoZIzj0EAwIDSAAwRQIhANZ0A+tPQGClRFetJJvDdJU2YAwpDZdLqdHj
FBZNpC0fAiBTrLRB8pn2zCZdAPzmhcMrcJQJWGHYJ4fRDbDkZd4ZbQ==
-----END CERTIFICATE-----
`

/** An Electron `Certificate` as the verify proc hands it over, with what the tests vary. */
function certificate(
  over: Partial<Certificate> & {
    subjectCN?: string
    subjectO?: string[]
    issuerCN?: string
    issuerO?: string[]
  } = {}
): Certificate {
  const principal = (commonName: string, organizations: string[]): Certificate['subject'] => ({
    commonName,
    organizations,
    organizationUnits: [],
    country: 'US',
    locality: '',
    state: ''
  })
  const subjectCN = over.subjectCN ?? 'www.example.com'
  const issuerCN = over.issuerCN ?? 'R11'
  return {
    data: over.data ?? '',
    fingerprint: over.fingerprint ?? 'sha256/abc',
    serialNumber: '01',
    subjectName: subjectCN,
    issuerName: issuerCN,
    subject: principal(subjectCN, over.subjectO ?? []),
    issuer: principal(issuerCN, over.issuerO ?? ["Let's Encrypt"]),
    validStart: over.validStart ?? 1_700_000_000,
    validExpiry: over.validExpiry ?? 1_707_000_000,
    issuerCert: undefined as unknown as Certificate
  }
}

function verified(hostname: string, cert: Certificate, errorCode = 0): CertificateVerification {
  return { hostname, certificate: cert, validatedCertificate: cert, errorCode }
}

describe('siteCertificateOf', () => {
  it('reads the card’s certificate by the phone’s rule: issued to the subject’s common name, by the issuer’s organisation, dates in milliseconds, no TLS version', () => {
    expect(siteCertificateOf(certificate())).toEqual({
      subject: 'www.example.com',
      issuer: "Let's Encrypt",
      validFrom: 1_700_000_000_000,
      validTo: 1_707_000_000_000,
      protocol: null
    })
  })

  it('falls back to the subject’s organisation and the issuer’s common name where the names are missing', () => {
    const cert = certificate({ subjectCN: '', subjectO: ['Example Corp'], issuerO: [] })
    expect(siteCertificateOf(cert)).toMatchObject({ subject: 'Example Corp', issuer: 'R11' })
    const bare = certificate({ subjectCN: '', issuerCN: '', issuerO: [] })
    expect(siteCertificateOf(bare)).toMatchObject({ subject: '', issuer: '' })
  })

  it('leaves a date the verification does not carry null', () => {
    const cert = certificate({ validStart: 0, validExpiry: Number.NaN })
    expect(siteCertificateOf(cert)).toMatchObject({ validFrom: null, validTo: null })
  })
})

describe('certificateNames and hostKey', () => {
  it('lists the certificate’s subject alternative names, DNS and IP, lower-case', () => {
    expect(certificateNames(FIXTURE_PEM, 'A.example')).toEqual([
      'a.example',
      '*.b.example',
      '127.0.0.1'
    ])
  })

  it('adds the host the certificate was verified for when the names leave it out', () => {
    expect(certificateNames(FIXTURE_PEM, 'c.example')).toEqual([
      'a.example',
      '*.b.example',
      '127.0.0.1',
      'c.example'
    ])
  })

  it('makes a certificate the parser refuses good for that host alone', () => {
    expect(certificateNames('not a certificate', 'Host.Example.')).toEqual(['host.example'])
    expect(certificateNames('', 'host.example')).toEqual(['host.example'])
  })

  it('names a host the way the verifier does: lower-case, no trailing dot, no brackets', () => {
    expect(hostKey('WWW.Example.COM.')).toBe('www.example.com')
    expect(hostKey('[::1]')).toBe('::1')
    expect(hostKey('  ')).toBe('')
  })
})

describe('nameCovers', () => {
  it('covers the name itself and one label under a wildcard, as RFC 6125 has it', () => {
    expect(nameCovers('www.example.com', 'www.example.com')).toBe(true)
    expect(nameCovers('*.example.com', 'www.example.com')).toBe(true)
    expect(nameCovers('*.example.com', 'example.com')).toBe(false)
    expect(nameCovers('*.example.com', 'a.b.example.com')).toBe(false)
    expect(nameCovers('www.example.com', 'example.com')).toBe(false)
    expect(nameCovers('w*.example.com', 'www.example.com')).toBe(false)
    expect(nameCovers('*.', 'a.')).toBe(false)
  })
})

describe('SiteCertificateRecords', () => {
  it('keeps a host’s verified certificate and reads it back by the host, however it is spelled', () => {
    const records = new SiteCertificateRecords()
    records.record(verified('www.example.com', certificate()))
    expect(records.lookup('WWW.Example.com.')).toMatchObject({ issuer: "Let's Encrypt" })
    expect(records.lookup('other.example')).toBeNull()
    expect(records.lookup('')).toBeNull()
  })

  it('reads the chain as verified over the certificate the server sent', () => {
    const records = new SiteCertificateRecords()
    records.record({
      hostname: 'www.example.com',
      certificate: certificate({ issuerO: ['Sent'] }),
      validatedCertificate: certificate({ issuerO: ['Verified'] }),
      errorCode: 0
    })
    expect(records.lookup('www.example.com')).toMatchObject({ issuer: 'Verified' })
    records.record({
      hostname: 'bare.example',
      certificate: certificate({ issuerO: ['Sent'] }),
      validatedCertificate: null,
      errorCode: 0
    })
    expect(records.lookup('bare.example')).toMatchObject({ issuer: 'Sent' })
  })

  it('drops the host’s record on a verification that failed: the refused certificate is the failure’s to report', () => {
    const records = new SiteCertificateRecords()
    records.record(verified('www.example.com', certificate()))
    records.record(verified('www.example.com', certificate({ issuerO: ['Rogue'] }), -202))
    expect(records.lookup('www.example.com')).toBeNull()
    expect(records.size).toBe(0)
  })

  it('answers for a host with no record of its own from a certificate whose names cover it (a connection reused)', () => {
    const records = new SiteCertificateRecords()
    records.record(verified('a.example', certificate({ data: FIXTURE_PEM, issuerO: ['Fixture'] })))
    expect(records.lookup('www.b.example')).toMatchObject({ issuer: 'Fixture' })
    expect(records.lookup('127.0.0.1')).toMatchObject({ issuer: 'Fixture' })
    expect(records.lookup('b.example')).toBeNull()
    expect(records.lookup('x.y.b.example')).toBeNull()
    // The host's own record, once there is one, comes first.
    records.record(verified('www.b.example', certificate({ issuerO: ['Own'] })))
    expect(records.lookup('www.b.example')).toMatchObject({ issuer: 'Own' })
  })

  it('lets the least recently read host go past its capacity, a read keeping a host fresh', () => {
    const records = new SiteCertificateRecords(2)
    records.record(verified('a.example', certificate({ issuerO: ['A'] })))
    records.record(verified('b.example', certificate({ issuerO: ['B'] })))
    // `a` read: `b` is now the one longest unread.
    expect(records.lookup('a.example')).toMatchObject({ issuer: 'A' })
    records.record(verified('c.example', certificate({ issuerO: ['C'] })))
    expect(records.size).toBe(2)
    expect(records.lookup('b.example')).toBeNull()
    expect(records.lookup('a.example')).toMatchObject({ issuer: 'A' })
    expect(records.lookup('c.example')).toMatchObject({ issuer: 'C' })
    expect(SITE_CERTIFICATE_RECORDS).toBeGreaterThan(256)
  })
})

/** A session as `watch` follows it: the proc installed, and every verdict it gave. */
class FakeSession implements VerifyingSession {
  proc: ((request: CertificateVerification, callback: (verdict: number) => void) => void) | null =
    null
  installs = 0
  readonly verdicts: number[] = []
  setCertificateVerifyProc(
    proc: (request: CertificateVerification, callback: (verdict: number) => void) => void
  ): void {
    this.proc = proc
    this.installs++
  }
  /** A handshake: what the network service asks the proc, and its verdict recorded. */
  verify(request: CertificateVerification): void {
    this.proc?.(request, (verdict) => this.verdicts.push(verdict))
  }
}

describe('SiteCertificates', () => {
  it('follows a session once, leaves every verdict to Chromium, and reads a page’s certificate by its https URL', () => {
    const store = new SiteCertificates()
    const ses = new FakeSession()
    store.watch(ses)
    store.watch(ses)
    expect(ses.installs).toBe(1)
    ses.verify(verified('www.example.com', certificate()))
    expect(ses.verdicts).toEqual([VERDICT_CHROMIUMS])
    expect(store.lookup(ses, 'https://www.example.com/path?q#f')).toMatchObject({
      subject: 'www.example.com',
      issuer: "Let's Encrypt"
    })
    expect(store.lookup(ses, 'http://www.example.com/')).toBeNull()
    expect(store.lookup(ses, 'https://other.example/')).toBeNull()
    expect(store.lookup(ses, 'not a url')).toBeNull()
    expect(store.lookup(new FakeSession(), 'https://www.example.com/')).toBeNull()
  })

  it('keeps the sessions’ records apart: a container’s handshake is its own', () => {
    const store = new SiteCertificates()
    const a = new FakeSession()
    const b = new FakeSession()
    store.watch(a)
    store.watch(b)
    a.verify(verified('www.example.com', certificate({ issuerO: ['Container A'] })))
    b.verify(verified('www.example.com', certificate({ issuerO: ['Proxy of B'] })))
    expect(store.lookup(a, 'https://www.example.com/')).toMatchObject({ issuer: 'Container A' })
    expect(store.lookup(b, 'https://www.example.com/')).toMatchObject({ issuer: 'Proxy of B' })
  })

  it('answers the handshake even for a request it cannot read', () => {
    const store = new SiteCertificates()
    const ses = new FakeSession()
    store.watch(ses)
    ses.verify({
      hostname: undefined as unknown as string,
      certificate: certificate(),
      errorCode: 0
    })
    expect(ses.verdicts).toEqual([VERDICT_CHROMIUMS])
  })
})
