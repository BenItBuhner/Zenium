/**
 * The certificates behind the pages' https connections, for the site-information card
 * (`ElectronTabView.certificate`).
 *
 * Electron offers no read of the certificate a page was served over: the DevTools protocol's
 * `Security.visibleSecurityStateChanged` is emitted by `//chrome` code Electron does not ship,
 * `Security.enable` answers with nothing and the card waited on it for nothing, and
 * `Network.getCertificate` reads Blink's record of the resources loaded while the Network
 * domain was enabled – empty for a session opened after the load. What Electron does offer is
 * the verification itself: `session.setCertificateVerifyProc` sees every TLS handshake of the
 * session with the server's certificate, the chain as verified and the verifier's verdict. The
 * verdict is left to Chromium (`-3`); the certificate is kept here by the host it was verified
 * for, and the card reads the page's host up.
 *
 * The network service asks the proc only when its own cache (256 verifications, 30 minutes)
 * misses, so the record must outlast that cache: the store keeps more hosts than it does, least
 * recently read first out. A connection reused for another host the certificate covers (HTTP/2
 * coalescing, an apex redirecting to its `www`) is verified for the first host only, so a host
 * with no record of its own reads the record of a certificate whose names cover it.
 */
import { X509Certificate } from 'node:crypto'
import type { Certificate } from 'electron'
import type { SiteCertificate } from '../../shared/siteInfo'

/** Hosts kept per session: above the network service's 256 cached verifications. */
export const SITE_CERTIFICATE_RECORDS = 1024

/** `setCertificateVerifyProc`'s answer for "Chromium's own verdict stands". */
export const VERDICT_CHROMIUMS = -3

/** The parts of a `setCertificateVerifyProc` request read here. */
export interface CertificateVerification {
  hostname: string
  /** The certificate the server sent. */
  certificate: Certificate
  /** The chain as the verifier built it, leaf first; the server's when it built none. */
  validatedCertificate?: Certificate | null
  /** `net::OK` (0), or the negative `net::ERR_*` code the verification failed with. */
  errorCode: number
}

/** A session as the store follows it: whatever answers `setCertificateVerifyProc`. */
export interface VerifyingSession {
  setCertificateVerifyProc(
    proc: (request: CertificateVerification, callback: (verdict: number) => void) => void
  ): void
}

/** One host's verified certificate, as the card lists it, with the names it is good for. */
export interface CertificateRecord {
  certificate: SiteCertificate
  /** The certificate's subject alternative names (DNS and IP), lower-case. */
  names: string[]
}

/**
 * The `SiteCertificate` a verified certificate reads as, by the phone's rule (`TabWebView.kt`,
 * `certificateInfo`): issued to the subject's common name, or its organisation when it has no
 * common name; issued by the issuer's organisation ("Let's Encrypt", "Google Trust Services"),
 * or its common name when it names no organisation. The dates come in seconds; the TLS version
 * is not the verification's to tell.
 */
export function siteCertificateOf(cert: Certificate): SiteCertificate {
  return {
    subject: cert.subject?.commonName || cert.subjectName || cert.subject?.organizations?.[0] || '',
    issuer: cert.issuer?.organizations?.[0] || cert.issuer?.commonName || cert.issuerName || '',
    validFrom: seconds(cert.validStart),
    validTo: seconds(cert.validExpiry),
    protocol: null
  }
}

function seconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : null
}

/**
 * The names a PEM-encoded certificate is good for: its subject alternative names of the DNS and
 * IP kinds, lower-case (`crypto.X509Certificate` lists them as `DNS:a.example, IP Address:…`).
 * A certificate the parser refuses, or one naming nothing, is good for `fallback` alone.
 */
export function certificateNames(pem: string, fallback: string): string[] {
  let names: string[] = []
  try {
    const parsed = new X509Certificate(pem)
    names = (parsed.subjectAltName ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .flatMap((entry) => {
        const dns = /^DNS:(.+)$/i.exec(entry)
        if (dns) return [hostKey(dns[1]!)]
        const ip = /^IP Address:(.+)$/i.exec(entry)
        return ip ? [hostKey(ip[1]!)] : []
      })
      .filter((name) => name.length > 0)
  } catch {
    // Not a certificate the parser reads: the host it was verified for is all it is good for.
  }
  const key = hostKey(fallback)
  if (key && !names.includes(key)) names.push(key)
  return names
}

/**
 * A URL's host as the verifier names it: lower-case, with no trailing dot and no brackets
 * around an IPv6 literal.
 */
export function hostKey(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[(.*)\]$/, '$1')
}

/**
 * Whether a certificate name covers `host`: the name itself, or a wildcard in its leftmost
 * label standing for exactly one label of the host (`*.example.com` covers `www.example.com`,
 * not `example.com` nor `a.b.example.com`), as RFC 6125 has it.
 */
export function nameCovers(name: string, host: string): boolean {
  if (name === host) return true
  if (!name.startsWith('*.')) return false
  const rest = name.slice(2)
  if (!rest || rest.includes('*')) return false
  const dot = host.indexOf('.')
  return dot > 0 && host.slice(dot + 1) === rest
}

/**
 * One session's verified certificates by host, least recently read first out. A verification
 * that failed takes the host's record with it: what the card would list for the page is the
 * certificate it refused, which the failure itself reports.
 */
export class SiteCertificateRecords {
  private readonly byHost = new Map<string, CertificateRecord>()

  constructor(private readonly capacity: number = SITE_CERTIFICATE_RECORDS) {}

  get size(): number {
    return this.byHost.size
  }

  record(verification: CertificateVerification): void {
    const host = hostKey(verification.hostname)
    if (!host) return
    if (verification.errorCode !== 0) {
      this.byHost.delete(host)
      return
    }
    const cert = verification.validatedCertificate ?? verification.certificate
    if (!cert) return
    const record: CertificateRecord = {
      certificate: siteCertificateOf(cert),
      names: certificateNames(cert.data ?? '', host)
    }
    this.byHost.delete(host)
    this.byHost.set(host, record)
    while (this.byHost.size > this.capacity) {
      const oldest = this.byHost.keys().next().value
      if (oldest === undefined) break
      this.byHost.delete(oldest)
    }
  }

  /**
   * The certificate behind `hostname`: the host's own record, or the most recent one whose
   * certificate covers the host (a connection reused for it). Null for a host no verification
   * of the session's has named or covered.
   */
  lookup(hostname: string): SiteCertificate | null {
    const host = hostKey(hostname)
    if (!host) return null
    const own = this.byHost.get(host)
    if (own) {
      // Read: freshest again.
      this.byHost.delete(host)
      this.byHost.set(host, own)
      return own.certificate
    }
    let covering: CertificateRecord | null = null
    for (const record of this.byHost.values()) {
      if (record.names.some((name) => nameCovers(name, host))) covering = record
    }
    return covering ? covering.certificate : null
  }
}

/**
 * The sessions' verified certificates, one store per session (a container's proxy may well
 * hand a page a certificate another container's connection never saw). `watch` follows a
 * session's handshakes; `lookup` reads a page's by its URL.
 */
export class SiteCertificates {
  private readonly bySession = new WeakMap<VerifyingSession, SiteCertificateRecords>()

  constructor(private readonly capacity: number = SITE_CERTIFICATE_RECORDS) {}

  /** Follow the session's verifications, leaving every verdict to Chromium. */
  watch(ses: VerifyingSession): void {
    if (this.bySession.has(ses)) return
    const records = new SiteCertificateRecords(this.capacity)
    this.bySession.set(ses, records)
    ses.setCertificateVerifyProc((request, callback) => {
      try {
        records.record(request)
      } catch {
        // A request the store cannot read is no record; the handshake is not the store's to hold.
      }
      callback(VERDICT_CHROMIUMS)
    })
  }

  /** The certificate behind an https `url` for a page of `ses`; null for any other URL, or none on record. */
  lookup(ses: VerifyingSession, url: string): SiteCertificate | null {
    const records = this.bySession.get(ses)
    if (!records) return null
    let host: string
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:') return null
      host = parsed.hostname
    } catch {
      return null
    }
    return records.lookup(host)
  }
}
