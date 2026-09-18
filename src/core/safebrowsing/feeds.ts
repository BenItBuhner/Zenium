import type { SafeBrowsingThreat } from '../../shared/privacy'

/**
 * The open feeds Safe Browsing is built on. All of them are hostname lists (the feeds' own
 * "hosts file" or domain forms), refreshed with `If-None-Match` / `If-Modified-Since` on the
 * cadence below and hashed into prefix tables (`prefixes.ts`). No key, no account, no quota.
 */
export interface SafeBrowsingFeed {
  /** Stable id; also the file name under `safebrowsing/` in the profile. */
  id: string
  name: string
  url: string
  homepage: string
  licence: string
  /** What a hit on this feed is reported as. */
  threat: SafeBrowsingThreat
  /** `hosts`: `0.0.0.0 host` lines; `domains`: one host per line; `abp`: `||host^` filters. */
  format: 'hosts' | 'domains' | 'abp'
  /** Refresh once the copy is older than this. */
  maxAgeMs: number
  /** Part of the snapshot the build ships (`resources/safebrowsing`), so first run is protected. */
  bundled: boolean
}

const HOUR = 60 * 60 * 1000

export const SAFE_BROWSING_FEEDS: SafeBrowsingFeed[] = [
  {
    id: 'urlhaus',
    name: 'URLhaus (abuse.ch)',
    url: 'https://urlhaus.abuse.ch/downloads/hostfile/',
    homepage: 'https://urlhaus.abuse.ch/',
    licence: 'CC0',
    threat: 'malware',
    format: 'hosts',
    maxAgeMs: 6 * HOUR,
    bundled: true
  },
  {
    id: 'urlhaus-filter',
    name: 'malware-filter: online malicious hosts',
    url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-hosts-online.txt',
    homepage: 'https://gitlab.com/malware-filter/urlhaus-filter',
    licence: 'CC0',
    threat: 'malware',
    format: 'hosts',
    maxAgeMs: 6 * HOUR,
    bundled: true
  },
  {
    id: 'phishing-filter',
    name: 'malware-filter: phishing hosts',
    url: 'https://malware-filter.gitlab.io/malware-filter/phishing-filter-hosts.txt',
    homepage: 'https://gitlab.com/malware-filter/phishing-filter',
    licence: 'CC0',
    threat: 'phishing',
    format: 'hosts',
    maxAgeMs: 6 * HOUR,
    bundled: true
  },
  {
    id: 'phishing-database',
    name: 'Phishing.Database (active domains)',
    url: 'https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-domains-ACTIVE.txt',
    homepage: 'https://github.com/Phishing-Database/Phishing.Database',
    licence: 'MIT',
    threat: 'phishing',
    format: 'domains',
    maxAgeMs: 24 * HOUR,
    // Eleven megabytes: downloaded after first run rather than shipped in every build.
    bundled: false
  }
]

export function safeBrowsingFeed(id: string): SafeBrowsingFeed | undefined {
  return SAFE_BROWSING_FEEDS.find((f) => f.id === id)
}

/** The pseudo-feed a hit on {@link SAFE_BROWSING_TEST_HOSTS} is reported under. */
export const SAFE_BROWSING_TEST_FEED = 'test'

/**
 * Hosts Safe Browsing always stops, so the warning page can be tried out
 * (`http://malware.zenium.test/`, as Chrome has testsafebrowsing.appspot.com): `.test` is
 * reserved for exactly this (RFC 6761) and never resolves on the Internet. Mirrored by
 * `SafeBrowsingTables.TEST_HOSTS` in `privacy/SafeBrowsing.kt`.
 */
export const SAFE_BROWSING_TEST_HOSTS: Readonly<Record<string, SafeBrowsingThreat>> = {
  'malware.zenium.test': 'malware',
  'phishing.zenium.test': 'phishing'
}

const HOST_RE = /^(?=.{1,253}$)(?!-)[a-z0-9_-]{1,63}(?<!-)(\.(?!-)[a-z0-9_-]{1,63}(?<!-))+$/
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/

/** Hosts a feed must never make Zenium block, whatever a line says. */
const NEVER = new Set([
  'localhost',
  'localhost.localdomain',
  'local',
  'broadcasthost',
  'ip6-localhost',
  'ip6-loopback',
  '0.0.0.0',
  '127.0.0.1'
])

/** A feed line's hostname, normalised, or null for comments, blanks and junk. */
export function parseFeedLine(line: string, format: SafeBrowsingFeed['format']): string | null {
  let text = line.trim()
  if (!text || text.startsWith('#') || text.startsWith('!') || text.startsWith('[')) return null
  const comment = text.indexOf('#')
  if (comment !== -1) text = text.slice(0, comment).trim()
  if (!text) return null
  if (format === 'hosts') {
    const parts = text.split(/\s+/)
    if (parts.length < 2) return null
    // `0.0.0.0 host` / `127.0.0.1 host`; anything else on the line is ignored.
    if (!IPV4_RE.test(parts[0]) && parts[0] !== '::1' && parts[0] !== '::') return null
    text = parts[1]
  } else if (format === 'abp') {
    const match = /^\|\|([^\s/^$*|]+)\^?(?:\$[^\s]*)?$/.exec(text)
    if (!match) return null
    text = match[1]
  } else if (/\s/.test(text)) {
    return null
  }
  const host = text.toLowerCase().replace(/\.$/, '')
  if (!host || NEVER.has(host)) return null
  if (IPV4_RE.test(host)) return host
  if (!HOST_RE.test(host)) return null
  return host
}

/** Every distinct hostname of a feed's text, in order of first appearance. */
export function parseFeed(text: string, format: SafeBrowsingFeed['format']): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  let start = 0
  while (start < text.length) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = text.length
    const host = parseFeedLine(text.slice(start, end), format)
    if (host && !seen.has(host)) {
      seen.add(host)
      out.push(host)
    }
    start = end + 1
  }
  return out
}
