import { getDomain } from '../../shared/url'

/**
 * Where a login belongs. Logins are keyed by origin (scheme, host, port) like Chrome's
 * `signon_realm`; matching for fill and grouping in the manager works on the registrable domain
 * (`accounts.example.com` and `www.example.com` share `example.com`).
 */

/** `https://Accounts.Example.com:443/login?x` → `https://accounts.example.com`; '' when unusable. */
export function normalizeOrigin(input: string): string {
  const text = input.trim()
  if (!text) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    if (!url.hostname) return ''
    return url.origin
  } catch {
    return ''
  }
}

/** A full page URL for the record when the input parses, else ''. */
export function normalizeUrl(input: string): string {
  const text = input.trim()
  if (!text) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}

/** Registrable domain of an origin or URL (`example.com`, `bbc.co.uk`), '' when unknown. */
export function domainOf(originOrUrl: string): string {
  return getDomain(originOrUrl)
}

/** Hostname without a leading `www.`, for display. */
export function siteLabel(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/^www\./, '')
  } catch {
    return origin
  }
}

/**
 * Whether a saved login for `credentialOrigin` may be offered on `pageOrigin`: the same
 * registrable domain, and never across the http / https boundary towards the insecure side.
 */
export function originMatches(credentialOrigin: string, pageOrigin: string): boolean {
  const a = normalizeOrigin(credentialOrigin)
  const b = normalizeOrigin(pageOrigin)
  if (!a || !b) return false
  if (a === b) return true
  const da = domainOf(a)
  const db = domainOf(b)
  if (!da || da !== db) return false
  // An https login must not be filled into an http page of the same site.
  if (a.startsWith('https:') && b.startsWith('http:')) return false
  return true
}

/** Normalise a domain typed by the user for the never-save list. */
export function normalizeDomain(input: string): string {
  const text = input.trim().toLowerCase()
  if (!text) return ''
  const origin = normalizeOrigin(text)
  return origin ? domainOf(origin) : ''
}
