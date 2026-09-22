/**
 * Chrome's content-settings pattern grammar, the subset the cookie and site-data lists use
 * (`chrome://settings/content/siteData`, `ContentSettingsPattern`):
 *
 *     [scheme://][*.]host[:port]
 *
 * - `[*.]example.com` covers `example.com` and every subdomain; `example.com` alone covers that
 *   host only. Chrome's "Add site" dialog prepends `[*.]` to a bare host, and so does
 *   {@link sitePatternForHost}: that is what a row added from the site-information sheet gets.
 * - `scheme://` (http, https, ws or wss; `*://` says nothing) and `:port` narrow a pattern to
 *   one scheme or one port; without them a pattern covers every scheme and port. A port cannot
 *   go with a subdomain wildcard in Chrome either.
 * - Hosts are lowercase DNS names (IDN in punycode, as URLs carry them), dotted-decimal IPv4 or
 *   bracketed IPv6 literals; an IP literal takes no `[*.]`. Paths are not part of the grammar.
 *
 * When several patterns of one policy cover a URL the most specific one decides, as Chrome's
 * `ContentSettingsPattern::Compare` orders them: an exact host beats a subdomain wildcard, a
 * longer host beats a shorter one, then a named scheme beats any scheme and a named port beats
 * any port. The Kotlin twin is `privacy/SitePatterns.kt`; pure, no platform code.
 */

import { parseIpv4, parseIpv6 } from './nonUniqueHost'

export interface SitePattern {
  /** The canonical text (`https://[*.]example.com:8443`), what the lists store. */
  text: string
  /** `http`, `https`, `ws` or `wss`; null for any scheme. */
  scheme: string | null
  /** Lowercase host; an IPv6 literal keeps its brackets. */
  host: string
  /** `[*.]`: the host's subdomains are covered too. */
  subdomains: boolean
  /** A fixed port, or null for any. */
  port: number | null
}

const SCHEMES: readonly string[] = ['http', 'https', 'ws', 'wss']
const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443, ws: 80, wss: 443 }
const HOST_LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/
const MAX_HOST_LENGTH = 253
const WILDCARD = '[*.]'

/** Parse `input` as a pattern; null when it is not one. Whitespace and case are forgiven. */
export function parseSitePattern(input: string): SitePattern | null {
  let text = input.trim().toLowerCase()
  if (!text || /[\s/\\?#@]/.test(text)) return null
  let scheme: string | null = null
  const schemeEnd = text.indexOf('://')
  if (schemeEnd !== -1) {
    const given = text.slice(0, schemeEnd)
    text = text.slice(schemeEnd + 3)
    if (given !== '*') {
      if (!SCHEMES.includes(given)) return null
      scheme = given
    }
  }
  let subdomains = false
  if (text.startsWith(WILDCARD)) {
    subdomains = true
    text = text.slice(WILDCARD.length)
  }
  if (!text || text.includes('*')) return null
  let port: number | null = null
  const portMatch = /^(.*?)(?::(\*|\d{1,5}))?$/.exec(text)
  if (!portMatch) return null
  let hostText = portMatch[1]
  if (portMatch[2] !== undefined && portMatch[2] !== '*') {
    port = Number(portMatch[2])
    if (port < 1 || port > 65535) return null
    // A port narrows one host; Chrome refuses the combination with a domain wildcard.
    if (subdomains) return null
  }
  if (hostText.endsWith('.') && hostText.length > 1) hostText = hostText.slice(0, -1)
  const host = canonicalHost(hostText)
  if (!host) return null
  // An IP literal names one machine: nothing is under it.
  if (subdomains && (host.startsWith('[') || parseIpv4(host))) return null
  return { text: patternText(scheme, host, subdomains, port), scheme, host, subdomains, port }
}

/** The canonical text of `input`, or null when it is not a pattern. */
export function normalizeSitePattern(input: string): string | null {
  return parseSitePattern(input)?.text ?? null
}

/** The pattern a bare host gets when added from a page: `[*.]host` (an IP literal stays exact). */
export function sitePatternForHost(host: string): string | null {
  const bare = parseSitePattern(host)
  if (!bare || bare.scheme || bare.port) return null
  if (bare.host.startsWith('[') || parseIpv4(bare.host)) return bare.text
  return `${WILDCARD}${bare.host}`
}

/** The parts of a URL a pattern is matched against. */
export interface SiteAddress {
  scheme: string
  host: string
  port: number | null
}

/** `url` (a URL string, or parts already taken from one) as a {@link SiteAddress}; null for a URL without a host. */
export function siteAddressOf(url: string | SiteAddress): SiteAddress | null {
  if (typeof url !== 'string') return url
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const scheme = parsed.protocol.replace(/:$/, '')
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return null
  const port = parsed.port ? Number(parsed.port) : (DEFAULT_PORTS[scheme] ?? null)
  return { scheme, host, port }
}

/** Whether `pattern` covers the URL. */
export function sitePatternMatches(pattern: SitePattern, url: string | SiteAddress): boolean {
  const address = siteAddressOf(url)
  if (!address) return false
  if (pattern.scheme !== null && pattern.scheme !== address.scheme) return false
  if (pattern.port !== null && pattern.port !== address.port) return false
  return hostCovered(pattern, address.host)
}

/** Whether `pattern` covers `host` alone, whatever the scheme or port. */
export function sitePatternCoversHost(pattern: SitePattern, host: string): boolean {
  return hostCovered(pattern, host.toLowerCase().replace(/\.$/, ''))
}

function hostCovered(pattern: SitePattern, host: string): boolean {
  if (host === pattern.host) return true
  if (!pattern.subdomains) return false
  return (
    host.length > pattern.host.length &&
    host.endsWith(pattern.host) &&
    host[host.length - pattern.host.length - 1] === '.'
  )
}

/**
 * Chrome's order of patterns from the most specific to the least: an exact host before a
 * subdomain wildcard, a longer host before a shorter one, a named scheme before any, a named
 * port before any; ties by text so the order is total. Negative when `a` is the more specific.
 */
export function compareSitePatterns(a: SitePattern, b: SitePattern): number {
  if (a.subdomains !== b.subdomains) return a.subdomains ? 1 : -1
  if (a.host.length !== b.host.length) return b.host.length - a.host.length
  if ((a.scheme === null) !== (b.scheme === null)) return a.scheme === null ? 1 : -1
  if ((a.port === null) !== (b.port === null)) return a.port === null ? 1 : -1
  return a.text < b.text ? -1 : a.text > b.text ? 1 : 0
}

/** The most specific of `patterns` (texts; unparsable ones are skipped) covering the URL, or null. */
export function matchSitePatterns(
  patterns: readonly string[],
  url: string | SiteAddress
): SitePattern | null {
  const address = siteAddressOf(url)
  if (!address) return null
  let best: SitePattern | null = null
  for (const text of patterns) {
    const pattern = parseSitePattern(text)
    if (!pattern || !sitePatternMatches(pattern, address)) continue
    if (!best || compareSitePatterns(pattern, best) < 0) best = pattern
  }
  return best
}

/** Whether any of `patterns` covers the URL. */
export function urlInSitePatterns(patterns: readonly string[], url: string | SiteAddress): boolean {
  return matchSitePatterns(patterns, url) !== null
}

function patternText(
  scheme: string | null,
  host: string,
  subdomains: boolean,
  port: number | null
): string {
  return `${scheme ? `${scheme}://` : ''}${subdomains ? WILDCARD : ''}${host}${port ? `:${port}` : ''}`
}

/** A lowercase DNS name, dotted-decimal IPv4 or bracketed IPv6 literal; null for anything else. */
function canonicalHost(text: string): string | null {
  if (!text) return null
  if (text.startsWith('[') && text.endsWith(']'))
    return parseIpv6(text.slice(1, -1)) ? text : null
  if (parseIpv6(text)) return `[${text}]`
  if (/^\d+(\.\d+){3}$/.test(text)) return parseIpv4(text) ? text : null
  if (text.length > MAX_HOST_LENGTH) return null
  const labels = text.split('.')
  if (!labels.every((label) => HOST_LABEL.test(label))) return null
  return text
}
