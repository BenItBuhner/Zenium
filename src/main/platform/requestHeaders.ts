/**
 * The store-origin request-header rewrites as function-shaped builtin request-header handlers,
 * and the Chromium match-pattern helpers the `webRequest` multiplexer filters requests with.
 *
 * The constraint: Electron gives a session exactly one listener per `webRequest` event (a second
 * registration replaces the first), and any listener the host installs switches off native
 * extension `webRequest` / `declarativeNetRequest` handling for that session. So no feature may
 * call `ses.webRequest.onBeforeSendHeaders` itself: the multiplexer (`webRequest.ts`) owns the
 * hook, and builtin transforms of the request headers register with it through
 * `WebRequestMultiplexer.registerHeaderRewrite`, which runs them right after the rule engine and
 * before any `chrome.webRequest`-style listener, so their edits count as the host's when
 * listeners conflict with them.
 *
 * The shape: the rewrites transform existing values (a brand goes next to the Chromium entry of
 * `Sec-CH-UA`, with that entry's version; Edge's token is appended to the request's own
 * `User-Agent`) rather than setting constants, so they are not `modifyHeaders` rules for the
 * engine's rule-set registry. Each is a {@link RequestHeaderHandler}:
 * `{ id, urls, rewrite(headers, details) }` with a pure `rewrite`. The platform registers
 * {@link webstoreClientHints} and {@link edgeStoreUserAgent} for persistent sessions in
 * `index.ts`.
 */
import {
  EDGE_ADD_ONS_URL_PATTERNS as EDGE_URL_PATTERNS,
  WEBSTORE_URL_PATTERNS as STORE_URL_PATTERNS,
  withChromeClientHints,
  withEdgeIdentity
} from '../../core/extensions/webstorePrivate'

/** A builtin participant in the `onBeforeSendHeaders` phase for the requests `urls` select. */
export interface RequestHeaderHandler {
  /** Stable id, unique among the host's builtin handlers. */
  id: string
  /** Chrome match patterns (`https://host/*`, `*://*.example.com/*`, `<all_urls>`). */
  urls: readonly string[]
  /** The request headers to send, as a new map; `headers` is left as it was. */
  rewrite(
    headers: Record<string, string>,
    details: Electron.OnBeforeSendHeadersListenerDetails
  ): Record<string, string>
}

/** The Chrome Web Store origins (the legacy host on its webstore path only). */
export const WEBSTORE_URL_PATTERNS: readonly string[] = STORE_URL_PATTERNS

/** The Edge Add-ons origin. */
export const EDGE_ADD_ONS_URL_PATTERNS: readonly string[] = EDGE_URL_PATTERNS

/**
 * Presents the browser to the store's servers as Chrome. The page request's client hints decide
 * whether the store renders its install button or "Switch to Chrome": Chrome's brand is added to
 * `Sec-CH-UA` and `Sec-CH-UA-Full-Version-List` (with the Chromium entry's version, and
 * `Sec-CH-UA` written in full when the request has none); every other header passes through.
 */
export const webstoreClientHints: RequestHeaderHandler = {
  id: 'webstore-client-hints',
  urls: WEBSTORE_URL_PATTERNS,
  rewrite(headers): Record<string, string> {
    return withChromeClientHints(headers, process.versions.chrome)
  }
}

/**
 * Presents the browser to the Edge Add-ons origin as Edge: `Edg/<major>.0.0.0` is appended to the
 * request's `User-Agent` and Edge's brand is added to the client hints, both only when missing.
 * The page's own gate is the brand list it reads from `navigator.userAgentData` (the frame
 * preload supplies that); the headers make the server see the same browser the page does.
 * Nothing outside this origin is touched.
 */
export const edgeStoreUserAgent: RequestHeaderHandler = {
  id: 'edge-store-user-agent',
  urls: EDGE_ADD_ONS_URL_PATTERNS,
  rewrite(headers): Record<string, string> {
    return withEdgeIdentity(headers, process.versions.chrome)
  }
}

export interface MatchPattern {
  /** `*` is http or https; the empty string (from `<all_urls>`) is any scheme. */
  scheme: string
  host: string
  subdomains: boolean
  /** `*` or absent matches any port; a number must equal the URL's (explicit or default) port. */
  port: string | null
  path: RegExp
}

const PATTERN_RE = /^(\*|[a-z][a-z0-9+.-]*):\/\/(\*|(?:\*\.)?[^/*]+(?::\*)?|)(\/.*)$/i

const DEFAULT_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443',
  'ws:': '80',
  'wss:': '443',
  'ftp:': '21'
}

/**
 * `URLPattern::Parse` for the subset Electron's `WebRequestFilter.urls` accepts: `*` as the
 * scheme is http or https, `*.` on the host takes the host and its subdomains, an optional
 * `:port` (a number or `*`), `*` in the path and query runs over anything. Null for a pattern
 * Chromium would reject.
 */
export function parseMatchPattern(text: string): MatchPattern | null {
  if (text === '<all_urls>')
    return { scheme: '', host: '', subdomains: true, port: null, path: /^/ }
  const match = PATTERN_RE.exec(text)
  if (!match) return null
  const scheme = match[1].toLowerCase()
  let host = match[2].toLowerCase()
  let port: string | null = null
  const colon = host.lastIndexOf(':')
  if (colon > 0 && !host.endsWith(']')) {
    port = host.slice(colon + 1)
    host = host.slice(0, colon)
    if (port !== '*' && !/^\d+$/.test(port)) return null
    if (port === '*') port = null
  }
  let subdomains = false
  if (host === '*') {
    host = ''
    subdomains = true
  } else if (host.startsWith('*.')) {
    host = host.slice(2)
    subdomains = true
    if (host === '') return null
  } else if (host === '') {
    // Only `file:` URLs have no host.
    if (scheme !== 'file') return null
    subdomains = true
  }
  const path = new RegExp(`^${match[3].split('*').map(escapeRegExp).join('.*')}$`)
  return { scheme, host, subdomains, port, path }
}

export function matchesPattern(pattern: MatchPattern, url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const scheme = parsed.protocol.slice(0, -1)
  if (pattern.scheme === '*' && scheme !== 'http' && scheme !== 'https') return false
  if (pattern.scheme !== '*' && pattern.scheme !== '' && scheme !== pattern.scheme) return false
  const host = parsed.hostname
  if (pattern.host !== '' || !pattern.subdomains) {
    const exact = host === pattern.host
    if (!exact && !(pattern.subdomains && host.endsWith(`.${pattern.host}`))) return false
  }
  if (
    pattern.port !== null &&
    (parsed.port || DEFAULT_PORTS[parsed.protocol] || '') !== pattern.port
  )
    return false
  return pattern.path.test(`${parsed.pathname}${parsed.search}`)
}

/**
 * Several match patterns compiled to one predicate, the way `chrome.webRequest`'s `urls` filter
 * reads them; a pattern Chromium would reject matches nothing.
 */
export function compileMatchPatterns(patterns: readonly string[]): (url: string) => boolean {
  const parsed: MatchPattern[] = []
  for (const text of patterns) {
    const pattern = parseMatchPattern(text)
    if (pattern) parsed.push(pattern)
  }
  return (url) => parsed.some((pattern) => matchesPattern(pattern, url))
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
