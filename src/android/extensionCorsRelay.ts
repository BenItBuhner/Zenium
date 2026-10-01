import { EXTENSION_ORIGIN_SUFFIX } from '@core/extensions/runtime/plan'

/**
 * The CORS judgement of a content script's cross-origin request the host performed on its
 * behalf, made in the world as Chrome's renderer makes it (`extensionFetchRelay.ts` drives it).
 *
 * In Chrome a content script's cross-origin `fetch` leaves as the PAGE's own CORS request: the
 * isolated world runs under the extension's Content-Security-Policy, so the page's `connect-src`
 * has no say over it, but no host permission is consulted either (Chrome 85) – the request
 * carries the page's `Origin`, and the renderer judges the server's answer by the CORS rules for
 * that origin: `Access-Control-Allow-Origin` `*` or the page's origin (never `*` for a
 * credentialed request, which also needs `Access-Control-Allow-Credentials: true`), a preflight
 * for a request that is not simple, the headers exposed to the script (the safelisted ones and
 * `Access-Control-Expose-Headers`), an opaque `Response` for `no-cors`. A WebView's world runs
 * under the document's policy, which refuses such a request before it leaves (`Refused to
 * connect to … because it violates the document's Content Security Policy`); the host can send
 * it framed as the page's (`CorsProxy.Framing.contentScript`) and answer status, headers, body
 * and final URL, and these functions make the renderer's judgement of that answer here.
 */

/** What the world asks the host to perform (`extProxyFetch`). */
export interface ProxyRequest {
  method: string
  url: string
  headers: Array<[string, string]>
  /** The body in standard base64, or null for a bodyless request. */
  body: string | null
  /** `credentials: "include"`: the jar's cookies go along and the answer's are stored. */
  credentials: boolean
  /** The page's origin – the `Origin` the target sees. */
  origin: string
  /** The `Referer` the target sees, or null for none. */
  referer: string | null
}

/** The host's answer (`extProxyDone`): the response as the server sent it, or the reason it could not. */
export interface ProxyReply {
  ok?: unknown
  status?: unknown
  reason?: unknown
  url?: unknown
  redirected?: unknown
  mime?: unknown
  charset?: unknown
  headers?: unknown
  /** The body in standard base64. */
  body?: unknown
  error?: unknown
}

/** A `securitypolicyviolation` event's fields the relay reads. */
export interface ViolationLike {
  effectiveDirective?: unknown
  violatedDirective?: unknown
  blockedURI?: unknown
  disposition?: unknown
}

export const CORS_SAFELISTED_METHODS = new Set(['GET', 'HEAD', 'POST'])
const SAFELISTED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-language',
  'content-type',
  'range'
])
const SIMPLE_CONTENT_TYPES = [
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain'
]
const SAFELISTED_RESPONSE_HEADERS = new Set([
  'cache-control',
  'content-language',
  'content-length',
  'content-type',
  'expires',
  'last-modified',
  'pragma'
])
/** Bytes a safelisted request header's value may have before it needs a preflight. */
const SAFELISTED_VALUE_LIMIT = 128

/** The origin of an http(s) URL (`https://host[:port]`), or null for any other. */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.origin
  } catch {
    return null
  }
}

/**
 * Whether `url` is one the host may answer for a content script: an http(s) URL off the page's
 * origin, and not an extension's (another extension's file is the page's way, as before; the
 * scope's own files have their own relay).
 */
export function isCrossOriginHttp(url: string, pageOrigin: string): boolean {
  const origin = originOf(url)
  if (origin === null || origin === pageOrigin) return false
  try {
    return !new URL(url).hostname.endsWith(EXTENSION_ORIGIN_SUFFIX)
  } catch {
    return false
  }
}

/** A URL without its fragment, the way a violation names the blocked one. */
function withoutFragment(url: string): string {
  const hash = url.indexOf('#')
  return hash < 0 ? url : url.slice(0, hash)
}

/**
 * Whether a violation's `blockedURI` names `url`: the URL itself (fragment apart), or its origin
 * – Chromium reports a cross-origin blocked URL by its origin alone in places, and a policy's
 * `connect-src` refusal names the request's URL in others.
 */
export function violationNames(blockedURI: string, url: string): boolean {
  if (!blockedURI) return false
  const blocked = withoutFragment(blockedURI)
  const asked = withoutFragment(url)
  if (blocked === asked) return true
  const origin = originOf(url)
  return origin !== null && (blocked === origin || blocked === origin + '/')
}

/**
 * Whether the event is the document's policy refusing a connection (`connect-src`, or a
 * `default-src` standing in for it) rather than a report-only policy's notice.
 */
export function isConnectRefusal(event: ViolationLike): boolean {
  if (event.disposition === 'report') return false
  const effective = String(event.effectiveDirective ?? '')
  if (effective) return effective === 'connect-src'
  return String(event.violatedDirective ?? '').startsWith('connect-src')
}

/** The Fetch standard's CORS-safelisted request header test, name and value. */
function isSafelistedRequestHeader(name: string, value: string): boolean {
  const lower = name.toLowerCase()
  if (!SAFELISTED_REQUEST_HEADERS.has(lower)) return false
  if (new TextEncoder().encode(value).byteLength > SAFELISTED_VALUE_LIMIT) return false
  if (lower === 'content-type') {
    const essence = value.split(';')[0].trim().toLowerCase()
    return SIMPLE_CONTENT_TYPES.includes(essence)
  }
  if (lower === 'range') return /^bytes=\d*-\d*$/.test(value)
  // Accept, Accept-Language, Content-Language: no CORS-unsafe request-header byte.
  return !hasUnsafeByte(value)
}

/** The Fetch standard's CORS-unsafe request-header byte: a control byte (HT apart), a delimiter, DEL. */
function hasUnsafeByte(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true
    if ('"():<>?@[\\]{}'.includes(value[i])) return true
  }
  return false
}

/** The request headers a preflight has to clear: those not CORS-safelisted. */
export function unsafeHeaderNames(headers: Array<[string, string]>): string[] {
  return headers
    .filter(([name, value]) => !isSafelistedRequestHeader(name, value))
    .map(([name]) => name.toLowerCase())
    .sort()
}

/** Whether Chrome sends a preflight for the request: a method or a header off the safelist. */
export function needsPreflight(method: string, headers: Array<[string, string]>): boolean {
  return !CORS_SAFELISTED_METHODS.has(method.toUpperCase()) || unsafeHeaderNames(headers).length > 0
}

/** The header map of a reply, names lower-cased. */
export function replyHeaders(reply: ProxyReply): Record<string, string> {
  const out: Record<string, string> = {}
  const raw = reply.headers
  if (typeof raw !== 'object' || raw === null) return out
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[name.toLowerCase()] = value
  }
  return out
}

/**
 * The CORS check of a response for a request from `pageOrigin`: `Access-Control-Allow-Origin`
 * `*` or the origin itself; with credentials the origin exactly and
 * `Access-Control-Allow-Credentials: true`.
 */
export function corsAllows(
  headers: Record<string, string>,
  pageOrigin: string,
  credentials: boolean
): boolean {
  const allowed = headers['access-control-allow-origin']
  if (allowed === undefined) return false
  const value = allowed.trim()
  if (value === '*') return !credentials
  if (value !== pageOrigin) return false
  return !credentials || headers['access-control-allow-credentials']?.trim() === 'true'
}

/**
 * The CORS-preflight check: an ok status, the origin allowed, the method and every unsafe
 * header listed (`*` lists all of them for an uncredentialed request, `Authorization` apart).
 */
export function preflightAllows(
  reply: ProxyReply,
  method: string,
  headers: Array<[string, string]>,
  pageOrigin: string,
  credentials: boolean
): boolean {
  const status = typeof reply.status === 'number' ? reply.status : 0
  if (status < 200 || status > 299) return false
  const answer = replyHeaders(reply)
  if (!corsAllows(answer, pageOrigin, credentials)) return false
  const list = (name: string): string[] =>
    (answer[name] ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  const methods = list('access-control-allow-methods')
  const upper = method.toUpperCase()
  const methodOk =
    CORS_SAFELISTED_METHODS.has(upper) ||
    methods.some((m) => m.toUpperCase() === upper) ||
    (methods.includes('*') && !credentials)
  if (!methodOk) return false
  const allowedHeaders = list('access-control-allow-headers').map((h) => h.toLowerCase())
  const wildcard = allowedHeaders.includes('*') && !credentials
  return unsafeHeaderNames(headers).every(
    (name) => allowedHeaders.includes(name) || (wildcard && name !== 'authorization')
  )
}

/**
 * The response headers the script may read: the CORS-safelisted ones and those
 * `Access-Control-Expose-Headers` names (`*` all of them for an uncredentialed request,
 * `Set-Cookie` never). `Content-Type` comes back from the reply's type and charset, and
 * `Content-Length` from the bytes, since the host re-derives the framing.
 */
export function exposedHeaders(
  reply: ProxyReply,
  byteLength: number,
  credentials: boolean
): Array<[string, string]> {
  const headers = replyHeaders(reply)
  const exposed = (headers['access-control-expose-headers'] ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
  const all = exposed.includes('*') && !credentials
  const out: Array<[string, string]> = []
  for (const [name, value] of Object.entries(headers)) {
    if (name === 'set-cookie' || name === 'set-cookie2') continue
    if (SAFELISTED_RESPONSE_HEADERS.has(name) || all || exposed.includes(name))
      out.push([name, value])
  }
  if (typeof reply.mime === 'string' && reply.mime) {
    const charset =
      typeof reply.charset === 'string' && reply.charset ? `; charset=${reply.charset}` : ''
    out.push(['content-type', reply.mime + charset])
  }
  out.push(['content-length', String(byteLength)])
  return out
}

/** Statuses a Response may not carry a body with. */
export function nullBodyStatus(status: number): boolean {
  return status === 101 || status === 103 || status === 204 || status === 205 || status === 304
}

/**
 * An opaque `Response`, as `no-cors` gets: status 0, no headers, no body, `type: "opaque"`, an
 * empty URL – the script learns nothing of the answer but that the request went out.
 */
export function opaqueResponse(win: Window & typeof globalThis): Response {
  const response = new win.Response(null, { status: 200 })
  for (const [name, value] of [
    ['type', 'opaque'],
    ['status', 0],
    ['statusText', ''],
    ['ok', false],
    ['url', ''],
    ['redirected', false],
    ['headers', new win.Headers()],
    ['body', null]
  ] as Array<[string, unknown]>) {
    try {
      Object.defineProperty(response, name, { value, configurable: true })
    } catch {
      /* a frozen Response of the page's: the empty body stands */
    }
  }
  return response
}

/**
 * The `Response` of a CORS request answered through the host, as the renderer would hand it to
 * the script: the status and reason, the exposed headers, the bytes (none for a HEAD or a
 * null-body status), `type: "cors"`, `url` where the response came from, `redirected`.
 */
export function corsResponse(
  win: Window & typeof globalThis,
  reply: ProxyReply,
  bytes: Uint8Array,
  method: string,
  credentials: boolean
): Response {
  const status =
    typeof reply.status === 'number' && reply.status >= 200 && reply.status <= 599
      ? reply.status
      : 200
  const headers = exposedHeaders(reply, bytes.byteLength, credentials)
  const body =
    method.toUpperCase() === 'HEAD' || nullBodyStatus(status) ? null : (bytes.buffer as ArrayBuffer)
  const response = new win.Response(body, {
    status,
    statusText: typeof reply.reason === 'string' ? reply.reason : '',
    headers
  })
  for (const [name, value] of [
    ['type', 'cors'],
    ['url', typeof reply.url === 'string' ? reply.url : ''],
    ['redirected', reply.redirected === true]
  ] as Array<[string, unknown]>) {
    try {
      Object.defineProperty(response, name, { value, configurable: true })
    } catch {
      /* a frozen Response of the page's: the body and headers still stand */
    }
  }
  return response
}

/**
 * The `Referer` Chrome would send with a request from the page under the request's referrer
 * policy: none for `no-referrer`, the page's URL for the policies that send it whole across
 * origins, the page's origin otherwise (the default, `strict-origin-when-cross-origin`).
 */
export function refererFor(request: Request, pageUrl: string, pageOrigin: string): string | null {
  if (request.referrer === '' || request.referrerPolicy === 'no-referrer') return null
  if (pageOrigin === 'null') return null
  const whole =
    request.referrerPolicy === 'unsafe-url' ||
    request.referrerPolicy === 'no-referrer-when-downgrade'
  if (whole) {
    try {
      const url = new URL(pageUrl)
      url.hash = ''
      url.username = ''
      url.password = ''
      return url.href
    } catch {
      return pageOrigin + '/'
    }
  }
  return pageOrigin + '/'
}
