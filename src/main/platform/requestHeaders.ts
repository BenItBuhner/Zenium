/**
 * Request-header rules of the desktop host, behind the one `onBeforeSendHeaders` listener a
 * session can have.
 *
 * The constraint: Electron gives a session exactly one listener per `webRequest` event (a second
 * registration replaces the first), and any listener the host installs switches off native
 * extension `webRequest` / `declarativeNetRequest` handling for that session. So no feature may
 * call `ses.webRequest.onBeforeSendHeaders` itself. It registers a {@link RequestHeaderRule} here,
 * and this module installs the single listener per attached session, filtered to the union of the
 * rules' URL patterns, and runs the matching rules in registration order.
 *
 * The hand-off: the shared-services blocking engine (`blocking.ts` and its `webRequest.ts`
 * multiplexer on `cursor/services-blocking-24d1`) is becoming the sole owner of the `webRequest`
 * hook, with `modifyHeaders` rules. When it lands, {@link RequestHeaderRules.attach} must no longer
 * be called; instead the multiplexer either runs {@link RequestHeaderRules.apply} from its own
 * `onBeforeSendHeaders` handler (one `RequestHandler`, keeping this registry as the API), or
 * expresses the store rule as a `modifyHeaders` rule and deletes this file. The only client today
 * is the store-origin client-hints rule in `webstoreBridge.ts`.
 */
import type { Session } from 'electron'

type BeforeSendHeadersDetails = Electron.OnBeforeSendHeadersListenerDetails

export interface RequestHeaderRule {
  /** Stable id; registering the same id again replaces the earlier rule. */
  id: string
  /** Chrome match patterns (`https://host/*`, `*://*.example.com/*`, `<all_urls>`). */
  urls: readonly string[]
  /**
   * Returns the request headers to send. `details.requestHeaders` already carries the edits of
   * the rules registered before this one.
   */
  headers: (details: BeforeSendHeadersDetails) => Record<string, string>
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

/** The rule registry and, until the multiplexer takes over, the installer of the listeners. */
export class RequestHeaderRules {
  private readonly rules = new Map<string, { rule: RequestHeaderRule; patterns: MatchPattern[] }>()
  private readonly sessions = new Set<Session>()

  /** Add or replace a rule; returns the function that removes it again. */
  register(rule: RequestHeaderRule): () => void {
    const patterns = rule.urls.map((text) => {
      const pattern = parseMatchPattern(text)
      if (!pattern) throw new Error(`Request header rule ${rule.id}: invalid match pattern ${text}`)
      return pattern
    })
    this.rules.set(rule.id, { rule, patterns })
    this.reinstall()
    return () => this.unregister(rule.id)
  }

  unregister(id: string): void {
    if (this.rules.delete(id)) this.reinstall()
  }

  ruleIds(): string[] {
    return [...this.rules.keys()]
  }

  /** The request headers after every rule whose patterns match `details.url`, in registration order. */
  apply(details: BeforeSendHeadersDetails): Record<string, string> {
    let headers = details.requestHeaders
    for (const { rule, patterns } of this.rules.values()) {
      if (!patterns.some((pattern) => matchesPattern(pattern, details.url))) continue
      headers = rule.headers({ ...details, requestHeaders: headers })
    }
    return headers
  }

  /** Install the session's listener (once per session; re-filtered whenever the rules change). */
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
    const urls = [...new Set([...this.rules.values()].flatMap(({ rule }) => rule.urls))]
    if (urls.length === 0) {
      ses.webRequest.onBeforeSendHeaders(null)
      return
    }
    ses.webRequest.onBeforeSendHeaders({ urls }, (details, callback) => {
      callback({ requestHeaders: this.apply(details) })
    })
  }
}

/** The host's registry; features register here, the platform attaches sessions. */
export const requestHeaderRules = new RequestHeaderRules()

export function registerRequestHeaderRule(rule: RequestHeaderRule): () => void {
  return requestHeaderRules.register(rule)
}

export function unregisterRequestHeaderRule(id: string): void {
  requestHeaderRules.unregister(id)
}
