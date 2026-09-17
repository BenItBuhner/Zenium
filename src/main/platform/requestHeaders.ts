/**
 * The store-origin client-hints rewrite as a function-shaped builtin request-header handler, and
 * the interim registration that runs it until the blocking engine's `webRequest` multiplexer
 * owns the hook.
 *
 * The constraint: Electron gives a session exactly one listener per `webRequest` event (a second
 * registration replaces the first), and any listener the host installs switches off native
 * extension `webRequest` / `declarativeNetRequest` handling for that session. So no feature may
 * call `ses.webRequest.onBeforeSendHeaders` itself.
 *
 * The shape: the rewrite transforms an existing `Sec-CH-UA` value (Chrome's brand goes next to
 * the Chromium entry, with that entry's version) rather than setting a constant, so it is not a
 * `modifyHeaders` rule for the engine's rule-set registry. It is a {@link RequestHeaderHandler}:
 * `{ id, urls, rewrite(headers, details) }` with a pure `rewrite`, which the multiplexer
 * registers as a builtin handler at session creation, right after the rule engine, in its
 * ordered `RequestHandler` list (`webRequest.ts` on `cursor/services-blocking-24d1`).
 *
 * The hand-off: that multiplexer attaches `onBeforeSendHeaders` to every session
 * unconditionally, so when it lands the adopter registers {@link webstoreClientHints} in the
 * multiplexer and deletes the `requestHeaderRules.attach` call in `index.ts` and this module's
 * {@link RequestHeaderRules.attach} in the same PR; whichever PR lands second removes the
 * duplicate. Until then {@link requestHeaderRules} installs the one listener per persistent
 * session, filtered to the handler's URL patterns, and {@link webstoreClientHints} is its only
 * registered handler.
 */
import type { Session } from 'electron'
import {
  WEBSTORE_URL_PATTERNS as STORE_URL_PATTERNS,
  withChromeClientHints
} from '../../core/extensions/webstorePrivate'

type BeforeSendHeadersDetails = Electron.OnBeforeSendHeadersListenerDetails

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

interface MatchPattern {
  /** `*` is http or https; the empty string (from `<all_urls>`) is any scheme. */
  scheme: string
  host: string
  subdomains: boolean
  path: RegExp
}

const PATTERN_RE = /^(\*|[a-z][a-z0-9+.-]*):\/\/(\*|(?:\*\.)?[^/*]+)(\/.*)$/i

/** `URLPattern::Parse` for the subset Electron's `WebRequestFilter.urls` accepts. */
export function parseMatchPattern(text: string): MatchPattern | null {
  if (text === '<all_urls>') return { scheme: '', host: '', subdomains: true, path: /^/ }
  const match = PATTERN_RE.exec(text)
  if (!match) return null
  const scheme = match[1].toLowerCase()
  let host = match[2].toLowerCase()
  let subdomains = false
  if (host === '*') {
    host = ''
    subdomains = true
  } else if (host.startsWith('*.')) {
    host = host.slice(2)
    subdomains = true
  }
  const path = new RegExp(`^${match[3].split('*').map(escapeRegExp).join('.*')}$`)
  return { scheme, host, subdomains, path }
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
  return pattern.path.test(`${parsed.pathname}${parsed.search}`)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The interim registration: one `onBeforeSendHeaders` listener per attached session, filtered to
 * the union of the handlers' patterns, running the matching handlers in registration order.
 * Generic inside so a test can drive it with any handler; the host registers one.
 */
export class RequestHeaderRules {
  private readonly handlers = new Map<
    string,
    { handler: RequestHeaderHandler; patterns: MatchPattern[] }
  >()
  private readonly sessions = new Set<Session>()

  /** Add or replace a handler; returns the function that removes it again. */
  register(handler: RequestHeaderHandler): () => void {
    const patterns = handler.urls.map((text) => {
      const pattern = parseMatchPattern(text)
      if (!pattern)
        throw new Error(`Request header handler ${handler.id}: invalid match pattern ${text}`)
      return pattern
    })
    this.handlers.set(handler.id, { handler, patterns })
    this.reinstall()
    return () => this.unregister(handler.id)
  }

  unregister(id: string): void {
    if (this.handlers.delete(id)) this.reinstall()
  }

  handlerIds(): string[] {
    return [...this.handlers.keys()]
  }

  /** The request headers after every handler whose patterns match `details.url`, in order. */
  apply(details: BeforeSendHeadersDetails): Record<string, string> {
    let headers = details.requestHeaders
    for (const { handler, patterns } of this.handlers.values()) {
      if (!patterns.some((pattern) => matchesPattern(pattern, details.url))) continue
      headers = handler.rewrite(headers, details)
    }
    return headers
  }

  /** Install the session's listener (once per session; re-filtered whenever the handlers change). */
  attach(ses: Session): void {
    if (this.sessions.has(ses)) return
    this.sessions.add(ses)
    this.install(ses)
  }

  /** Remove the listeners this module installed, freeing the slot for another owner. */
  detachAll(): void {
    for (const ses of this.sessions) ses.webRequest.onBeforeSendHeaders(null)
    this.sessions.clear()
  }

  private reinstall(): void {
    for (const ses of this.sessions) this.install(ses)
  }

  private install(ses: Session): void {
    const urls = [...new Set([...this.handlers.values()].flatMap(({ handler }) => handler.urls))]
    if (urls.length === 0) {
      ses.webRequest.onBeforeSendHeaders(null)
      return
    }
    ses.webRequest.onBeforeSendHeaders({ urls }, (details, callback) => {
      callback({ requestHeaders: this.apply(details) })
    })
  }
}

/** The host's interim registration; {@link webstoreClientHints} is its only handler. */
export const requestHeaderRules = new RequestHeaderRules()
requestHeaderRules.register(webstoreClientHints)
