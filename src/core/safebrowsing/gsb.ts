import type { SafeBrowsingThreat } from '../../shared/privacy'
import { bytesToBase64 } from './prefixes'
import { sha256, toHex } from './sha256'

/**
 * Google Safe Browsing v5 `hashes:search`, used only when the user entered a key of their own
 * (Settings → Privacy and security). The API is free for non-commercial use with a default
 * quota of 10,000 requests a day per Google Cloud project; Zenium sends one request per
 * main-frame navigation the open feeds did not already stop, and honours the response's cache
 * duration. Nothing here does network I/O: the service hands the request to the host and this
 * module builds it and reads the answer.
 */

export const GSB_SEARCH_ENDPOINT = 'https://safebrowsing.googleapis.com/v5/hashes:search'

/** The API takes at most this many prefixes per request. */
export const GSB_MAX_PREFIXES = 30

/** Default cache time for a negative answer when the response does not say. */
export const GSB_DEFAULT_CACHE_MS = 5 * 60 * 1000

const MAX_HOST_SUFFIXES = 5
const MAX_PATH_PREFIXES = 6
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/

/**
 * The URL's canonical form, as the API defines it: lowercase scheme and host, no fragment, no
 * default port, `.` and `..` resolved, no leading or trailing whitespace. Null for URLs that are
 * not http(s) or do not parse.
 */
export function canonicalUrl(raw: string): URL | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  url.hash = ''
  url.username = ''
  url.password = ''
  url.hostname = url.hostname.toLowerCase().replace(/\.+$/, '')
  return url.hostname ? url : null
}

/** Host suffixes: the host itself, then the last five components down to two of them. */
export function hostSuffixes(hostname: string): string[] {
  const host = hostname.toLowerCase()
  if (IPV4_RE.test(host) || host.startsWith('[')) return [host]
  const labels = host.split('.')
  const out = [host]
  const start = Math.max(1, labels.length - MAX_HOST_SUFFIXES)
  for (let i = start; i < labels.length - 1; i++) {
    const suffix = labels.slice(i).join('.')
    if (suffix !== host) out.push(suffix)
  }
  return out
}

/** Path prefixes: the path with query, without query, then each parent directory up to four. */
export function pathPrefixes(url: URL): string[] {
  const path = url.pathname || '/'
  const out: string[] = []
  if (url.search) out.push(path + url.search)
  out.push(path)
  const parts = path.split('/').slice(0, -1)
  // `/a/b/c` → `/`, `/a/`, `/a/b/`
  for (let depth = 0; depth < parts.length && out.length < MAX_PATH_PREFIXES; depth++) {
    const prefix = parts.slice(0, depth + 1).join('/') + '/'
    if (prefix !== path && !out.includes(prefix)) out.push(prefix)
  }
  return out.slice(0, MAX_PATH_PREFIXES)
}

/** Every host suffix × path prefix expression of `url`, the way the API hashes URLs. */
export function canonicalExpressions(raw: string): string[] {
  const url = canonicalUrl(raw)
  if (!url) return []
  const hosts = hostSuffixes(url.hostname)
  const paths = pathPrefixes(url)
  const out: string[] = []
  for (const host of hosts)
    for (const path of paths) {
      const port = url.port ? `:${url.port}` : ''
      out.push(`${host}${port}${path}`)
    }
  return out.slice(0, GSB_MAX_PREFIXES)
}

export interface GsbSearchRequest {
  /** The GET URL, key and prefixes included. */
  url: string
  /** Full SHA-256 (hex) of every expression, for matching the response. */
  fullHashes: Map<string, string>
}

/** The request for `pageUrl`, or null when the URL has no expressions. */
export function buildSearchRequest(apiKey: string, pageUrl: string): GsbSearchRequest | null {
  const expressions = canonicalExpressions(pageUrl)
  if (!expressions.length || !apiKey) return null
  const fullHashes = new Map<string, string>()
  const params = new URLSearchParams()
  params.set('key', apiKey)
  const seenPrefixes = new Set<string>()
  for (const expression of expressions) {
    const digest = sha256(expression)
    fullHashes.set(toHex(digest), expression)
    const prefix = bytesToBase64(digest.subarray(0, 4))
    if (seenPrefixes.has(prefix)) continue
    seenPrefixes.add(prefix)
    params.append('hashPrefixes', prefix)
  }
  return { url: `${GSB_SEARCH_ENDPOINT}?${params.toString()}`, fullHashes }
}

/** The API's threat types as Zenium reports them. */
export function threatOfGsbType(type: string): SafeBrowsingThreat {
  switch (type) {
    case 'MALWARE':
      return 'malware'
    case 'SOCIAL_ENGINEERING':
      return 'phishing'
    case 'UNWANTED_SOFTWARE':
    case 'POTENTIALLY_HARMFUL_APPLICATION':
      return 'unwanted'
    default:
      return 'unknown'
  }
}

export interface GsbSearchResult {
  /** The threat the URL is listed under, or null when no full hash matched. */
  threat: SafeBrowsingThreat | null
  /** The expression that matched. */
  expression: string | null
  /** How long the answer may be cached. */
  cacheMs: number
}

interface FullHashDetail {
  threatType?: string
}

interface FullHash {
  fullHash?: string
  fullHashDetails?: FullHashDetail[]
}

interface SearchResponse {
  fullHashes?: FullHash[]
  cacheDuration?: string
}

function durationMs(text: string | undefined): number {
  if (!text) return GSB_DEFAULT_CACHE_MS
  const match = /^(\d+(?:\.\d+)?)s$/.exec(text.trim())
  if (!match) return GSB_DEFAULT_CACHE_MS
  const ms = Math.round(Number(match[1]) * 1000)
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 24 * 60 * 60 * 1000) : GSB_DEFAULT_CACHE_MS
}

function base64ToHex(text: string): string | null {
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    let hex = ''
    for (let i = 0; i < binary.length; i++)
      hex += binary.charCodeAt(i).toString(16).padStart(2, '0')
    return hex
  } catch {
    return null
  }
}

/**
 * Read a `hashes:search` response for the request it answers: the full hashes are compared to
 * the request's own, so a prefix collision with another site is never a hit.
 */
export function parseSearchResponse(json: unknown, request: GsbSearchRequest): GsbSearchResult {
  const response = (json && typeof json === 'object' ? json : {}) as SearchResponse
  const cacheMs = durationMs(response.cacheDuration)
  const hashes = Array.isArray(response.fullHashes) ? response.fullHashes : []
  const rank: Record<SafeBrowsingThreat, number> = {
    malware: 3,
    phishing: 2,
    unwanted: 1,
    unknown: 0
  }
  let best: { threat: SafeBrowsingThreat; expression: string } | null = null
  for (const item of hashes) {
    if (!item || typeof item.fullHash !== 'string') continue
    const hex = base64ToHex(item.fullHash)
    const expression = hex ? request.fullHashes.get(hex) : undefined
    if (!expression) continue
    const details = Array.isArray(item.fullHashDetails) ? item.fullHashDetails : []
    for (const detail of details) {
      const threat = threatOfGsbType(detail?.threatType ?? '')
      if (!best || rank[threat] > rank[best.threat]) best = { threat, expression }
    }
    if (!details.length && !best) best = { threat: 'unknown', expression }
  }
  return best
    ? { threat: best.threat, expression: best.expression, cacheMs }
    : { threat: null, expression: null, cacheMs }
}
