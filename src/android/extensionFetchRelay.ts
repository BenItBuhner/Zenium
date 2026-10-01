import { extensionOrigin } from '@core/extensions/runtime/plan'
import { toServedUrl } from '@core/extensions/runtime/extensionUrls'
import { matchesAnyPatternOrigin } from '@core/extensions/api/matchPattern'
import { MAX_BODY_BYTES, base64 } from './extensionCorsProxy'
import {
  corsAllows,
  corsResponse,
  isConnectRefusal,
  isCrossOriginHttp,
  needsPreflight,
  opaqueResponse,
  originOf,
  preflightAllows,
  refererFor,
  replyHeaders,
  unsafeHeaderNames,
  violationNames,
  type ProxyReply,
  type ProxyRequest,
  type ViolationLike
} from './extensionCorsRelay'

/**
 * A content script's `fetch`, answered by the host where the page's policy stands in Chrome's way.
 *
 * TWO CLASSES OF URL leave the page's network stack for the bridge, which no page policy governs.
 *
 * ITS OWN EXTENSION'S FILE (`fetch(chrome.runtime.getURL('locales/en.json'))`, RoPro on
 * roblox.com; RoValra's locale index): in Chrome the request is the isolated world's, which
 * carries the extension's origin, so the page's Content-Security-Policy (`connect-src`) never
 * sees it and the file answers as a same-origin response (`type: "basic"`, whatever `mode`
 * asked – a request to one's own origin is never a CORS one). A WebView's isolated world carries
 * no origin of its own (the document's policy applies to it: `Refused to connect because it
 * violates the document's Content Security Policy` from the world's fetch on WebView 156), and
 * under the `with` fallback (no worlds, Chromium < 146) the request is the page's outright. So a
 * request for an attached extension's own file – the served spelling
 * `https://<id>.ext.zenium.invalid/…` or Chrome's `chrome-extension://<id>/…`, which an
 * extension writes out by hand and only the served origin loads – goes to the host FIRST: the
 * host reads the web-accessible file and answers its bytes and type (`Extensions.extensionFetch`,
 * `ExtensionFileAnswer`), rebuilt here as a `Response` with the file's URL and type. When the
 * host cannot (not web-accessible, missing, past the bridge's size), the request goes the page's
 * way after all, and the page's answer – the served origin's 404, or the policy's refusal – is
 * the extension's, as it was before the relay.
 *
 * A CROSS-ORIGIN URL THE PAGE'S POLICY REFUSED (RoValra's content script on roblox.com reading
 * `https://www.rovalra.com/RoValra/Settings/config.json`, which roblox.com's `connect-src` does
 * not name): in Chrome the request leaves as the PAGE's own CORS request – the isolated world
 * runs under the extension's policy, so the page's has no say over it, but no host permission is
 * consulted (Chrome 85): the request carries the page's `Origin` and the renderer judges the
 * server's answer by the CORS rules for that origin. Here the page's network stack is tried
 * FIRST, so a permissive page's request goes out exactly as before (the WebView's cache, the
 * engine's rules and its observers all seeing it); when the document reports the policy's
 * refusal (a `securitypolicyviolation` for `connect-src` naming the URL), the host performs the
 * request framed as the page's (`Extensions.extensionProxyFetch`, `CorsProxy.Framing.contentScript`)
 * and answers status, headers, body and final URL, and the renderer's judgement is made here
 * (`extensionCorsRelay.ts`): the preflight for a request that is not simple, the
 * `Access-Control-Allow-Origin` check, the exposed headers, an opaque `Response` for `no-cors`, a
 * `TypeError` where Chrome's fetch rejects. An origin the policy has refused once is asked of the
 * host first thereafter. The host's refusal (not attached, a body or an answer past the bridge's
 * size, a network failure) leaves the page's own course standing – its rejection, or its own
 * attempt where the host was asked first – so nothing is lost to the detour. What stays the page's: a same-origin request (never a CORS one), a URL off http(s) or
 * on an extension origin, `mode: "same-origin"` (fetch rejects it itself), and a request the
 * page did not refuse. The `XMLHttpRequest` of the same URLs rides on this `fetch`
 * (`extensionXhrRelay.ts`).
 */

/** What the bootstrap lends the relay: the attached extensions, the bridge and the realm's globals. */
export interface FetchRelayHost {
  /** Ids of the extensions attached to this scope's copy at call time. */
  attachedIds(): string[]
  /** The host permissions of an attached extension, to pick the one a cross-origin request is made for. */
  hostPermissions?(extId: string): readonly string[]
  /** Ask the host for `url`'s bytes (the extension's own file); it answers through `done(id, reply)`. */
  request(id: string, extId: string, url: string): void
  /** Ask the host to perform a cross-origin request as the page's; it answers through `done(id, reply)`. */
  proxy?(id: string, extId: string, request: ProxyRequest): void
  /** Chars a bridge message may carry; a request body past it stays the page's. */
  maxMessageChars?: number
  error(...args: unknown[]): void
  warn?(...args: unknown[]): void
}

/** The host's answer: the file's bytes (standard base64) and type, or the reason it could not. */
export interface FetchRelayReply {
  ok?: unknown
  body?: unknown
  mime?: unknown
  error?: unknown
}

export interface FetchRelay {
  /** The `fetch` the scope's `window` answers. */
  fetch: typeof globalThis.fetch
  /** Whether `url` (as written, either spelling) is an attached extension's own file. */
  owns(url: string): boolean
  /** Whether `url` is a cross-origin URL the page's policy has refused, so the host is asked first. */
  refused(url: string): boolean
  /** The host's answer to `request` or `proxy`. */
  done(id: string, reply: FetchRelayReply | ProxyReply): void
  /** The document reported a policy violation; a `connect-src` refusal is remembered. */
  onViolation(event: ViolationLike): void
  /** Requests still waiting for the host (tests, diagnostics). */
  pending(): number
}

interface Waiting {
  url: string
  method: string
  resolve(response: Response): void
  reject(reason: unknown): void
  /** The page's own fetch of the same request, when the host cannot answer. */
  page(): Promise<Response>
  /** Stops listening for an abort once the request is settled. */
  settle(): void
}

/** A cross-origin request waiting for the host's raw answer. */
interface WaitingProxy {
  url: string
  resolve(reply: ProxyReply): void
  reject(reason: unknown): void
  settle(): void
}

interface Refusal {
  blocked: string
  at: number
}

/** How long a refusal is matched to a rejection after it was reported. */
const REFUSAL_WINDOW_MS = 5_000
/** How long a rejected request waits for the document's violation report before it stands. */
const VIOLATION_WAIT_MS = 80
/** Thrown inside the host's leg where the host cannot answer: the page's own course stands. */
const HOST_CANNOT = Symbol('the host cannot answer the request')

export function createFetchRelay(
  win: Window & typeof globalThis,
  host: FetchRelayHost
): FetchRelay {
  const native: typeof globalThis.fetch | undefined = win.fetch
  const waiting = new Map<string, Waiting>()
  const waitingProxy = new Map<string, WaitingProxy>()
  const refusals: Refusal[] = []
  const refusedOrigins = new Set<string>()
  let seq = 0

  const extensionFor = (served: string): string | null => {
    for (const id of host.attachedIds()) if (served.startsWith(extensionOrigin(id) + '/')) return id
    return null
  }

  /** The extension a cross-origin request is made for: the one whose permissions cover it, else the first attached. */
  const extensionForCrossOrigin = (url: string): string | null => {
    const ids = host.attachedIds()
    if (ids.length === 0) return null
    if (host.hostPermissions) {
      for (const id of ids) {
        if (matchesAnyPatternOrigin(url, host.hostPermissions(id))) return id
      }
    }
    return ids[0]
  }

  const pageOrigin = (): string => {
    try {
      return String(win.location.origin)
    } catch {
      return 'null'
    }
  }

  const failed = (): TypeError => new win.TypeError('Failed to fetch')

  const nowMs = (): number => Date.now()

  const wasRefused = (url: string): boolean => {
    const since = nowMs() - REFUSAL_WINDOW_MS
    return refusals.some((r) => r.at >= since && violationNames(r.blocked, url))
  }

  const delay = (ms: number): Promise<void> => new Promise((resolve) => win.setTimeout(resolve, ms))

  /** Whether the document reports the policy's refusal of `url`: now, or within a short wait (the event is a later task). */
  const refusalReported = async (url: string): Promise<boolean> => {
    if (wasRefused(url)) return true
    await delay(0)
    if (wasRefused(url)) return true
    await delay(VIOLATION_WAIT_MS)
    return wasRefused(url)
  }

  /** Ask the host to perform `request`; the raw answer, or a rejection on abort / the host's silence. */
  const askProxy = (
    extId: string,
    request: ProxyRequest,
    signal: AbortSignal | null
  ): Promise<ProxyReply> =>
    new Promise<ProxyReply>((resolve, reject) => {
      if (!host.proxy) {
        reject(failed())
        return
      }
      const id = `p${(seq += 1)}`
      const onAbort = (): void => {
        const entry = waitingProxy.get(id)
        if (!entry) return
        waitingProxy.delete(id)
        entry.settle()
        reject(abortReason(win, signal as AbortSignal))
      }
      waitingProxy.set(id, {
        url: request.url,
        resolve,
        reject,
        settle: () => signal?.removeEventListener('abort', onAbort)
      })
      signal?.addEventListener('abort', onAbort)
      host.proxy(id, extId, request)
    })

  /**
   * The request through the host, judged as Chrome's renderer judges the page's CORS request.
   * Throws `HOST_CANNOT` where the host cannot answer (the caller lets the page's own course
   * stand) and fetch's `TypeError` where the CORS rules refuse the answer.
   */
  const throughHost = async (request: Request, extId: string): Promise<Response> => {
    const origin = pageOrigin()
    const method = request.method.toUpperCase()
    const credentials = request.credentials === 'include'
    const headers: Array<[string, string]> = []
    request.headers.forEach((value, name) => headers.push([name, value]))
    let body: string | null = null
    if (method !== 'GET' && method !== 'HEAD' && request.body != null) {
      const bytes = new Uint8Array(await request.arrayBuffer())
      if (bytes.byteLength > MAX_BODY_BYTES) throw HOST_CANNOT
      body = base64(bytes)
      const limit = host.maxMessageChars
      if (typeof limit === 'number' && limit > 0 && body.length > limit - 4096) throw HOST_CANNOT
    }
    const referer = refererFor(request, String(win.location.href), origin)
    const signal = request.signal ?? null
    if (request.mode === 'cors' && needsPreflight(method, headers)) {
      const asked: Array<[string, string]> = [
        ['Accept', '*/*'],
        ['Access-Control-Request-Method', method]
      ]
      const names = unsafeHeaderNames(headers)
      if (names.length) asked.push(['Access-Control-Request-Headers', names.join(',')])
      const preflight = await askProxy(
        extId,
        {
          method: 'OPTIONS',
          url: request.url,
          headers: asked,
          body: null,
          credentials: false,
          origin,
          referer
        },
        signal
      )
      if (preflight.ok !== true) throw HOST_CANNOT
      if (!preflightAllows(preflight, method, headers, origin, credentials)) throw failed()
    }
    const reply = await askProxy(
      extId,
      { method, url: request.url, headers, body, credentials, origin, referer },
      signal
    )
    if (reply.ok !== true || typeof reply.body !== 'string') {
      host.error(
        `[Zenium] ${request.url} could not be answered through the host for the content script: ${String(reply.error ?? 'the host refused')}; the page's own answer stands`
      )
      throw HOST_CANNOT
    }
    if (request.mode === 'no-cors') return opaqueResponse(win)
    if (!corsAllows(replyHeaders(reply), origin, credentials)) throw failed()
    return corsResponse(win, reply, decodeBase64(win, reply.body), method, credentials)
  }

  /** A cross-origin request: the page's stack first, the host on the policy's refusal. */
  const crossOrigin = async (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    served: string,
    extId: string
  ): Promise<Response> => {
    const native_ = native as typeof globalThis.fetch
    // fetch's own normalisation (a Request from a Request takes its body over), so the page's
    // attempt and the host's leg read one request; `same-origin` mode is fetch's own rejection.
    const request = new win.Request(input, init)
    if (request.mode !== 'cors' && request.mode !== 'no-cors') return native_.call(win, request)
    const url = request.url || served
    const forPage = request.clone()
    if (refusedOrigins.has(originOf(url) ?? '')) {
      // Refused before in this document: the host first, so the page does not refuse it a
      // second time; where the host cannot, the page's own course answers after all.
      try {
        return await throughHost(request, extId)
      } catch (e) {
        if (e !== HOST_CANNOT) throw e
        return native_.call(win, forPage)
      }
    }
    try {
      return await native_.call(win, forPage)
    } catch (pageError) {
      if (request.signal?.aborted) throw pageError
      if (!(await refusalReported(url))) throw pageError
      refusedOrigins.add(originOf(url) ?? '')
      host.warn?.(
        `[Zenium] ${url}: the page's policy refused the content script's request; the host sends it as the page's own CORS request, as Chrome does`
      )
      try {
        return await throughHost(request, extId)
      } catch (e) {
        if (e !== HOST_CANNOT) throw e
        throw pageError
      }
    }
  }

  const relayed: typeof globalThis.fetch = function fetch(input, init) {
    if (typeof native !== 'function') return Promise.reject(new win.TypeError('Failed to fetch'))
    const asked = urlOf(win, input)
    const served = toServedUrl(asked)
    const extId = extensionFor(served)
    if (extId === null) {
      if (host.proxy && isCrossOriginHttp(served, pageOrigin())) {
        const forExt = extensionForCrossOrigin(served)
        if (forExt !== null) return crossOrigin(input, init, served, forExt)
      }
      return native.call(win, input, init)
    }
    // Chrome's spelling of the extension's own file loads from the served origin, the page's
    // way included (the CORS proxy does the same for an extension page's own fetch).
    const pageInput = served === asked ? input : respelled(win, input, served)
    const request = isRequest(win, input) ? input : null
    const signal = init?.signal ?? request?.signal ?? null
    if (signal?.aborted) return Promise.reject(abortReason(win, signal))
    const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase()
    return new Promise<Response>((resolve, reject) => {
      const id = `f${(seq += 1)}`
      const onAbort = (): void => {
        const entry = waiting.get(id)
        if (!entry) return
        waiting.delete(id)
        entry.settle()
        reject(abortReason(win, signal as AbortSignal))
      }
      waiting.set(id, {
        url: served,
        method,
        resolve,
        reject,
        page: () => native.call(win, pageInput, init),
        settle: () => signal?.removeEventListener('abort', onAbort)
      })
      signal?.addEventListener('abort', onAbort)
      host.request(id, extId, served)
    })
  }

  return {
    fetch: relayed,
    owns: (url) => extensionFor(toServedUrl(url)) !== null,
    refused: (url) => refusedOrigins.has(originOf(url) ?? ''),
    onViolation(event) {
      if (!isConnectRefusal(event)) return
      const blocked = String(event.blockedURI ?? '')
      if (!blocked) return
      refusals.push({ blocked, at: nowMs() })
      if (refusals.length > 64) refusals.splice(0, refusals.length - 64)
      const origin = originOf(blocked)
      if (origin !== null) refusedOrigins.add(origin)
    },
    done(id, reply) {
      const proxied = waitingProxy.get(id)
      if (proxied) {
        waitingProxy.delete(id)
        proxied.settle()
        proxied.resolve(reply as ProxyReply)
        return
      }
      const entry = waiting.get(id)
      if (!entry) return
      waiting.delete(id)
      entry.settle()
      if (reply.ok !== true || typeof reply.body !== 'string') {
        host.error(
          `[Zenium] ${entry.url} could not be read for the content script: ${String(reply.error ?? 'the host refused')}; the page's fetch answers it`
        )
        entry.page().then(entry.resolve, entry.reject)
        return
      }
      let response: Response
      try {
        const bytes = decodeBase64(win, reply.body)
        const headers: Record<string, string> = { 'Content-Length': String(bytes.byteLength) }
        if (typeof reply.mime === 'string' && reply.mime) headers['Content-Type'] = reply.mime
        // A HEAD answers the headers alone, as the origin would.
        response = new win.Response(
          entry.method === 'HEAD' ? null : (bytes.buffer as ArrayBuffer),
          {
            status: 200,
            statusText: 'OK',
            headers
          }
        )
        // Chrome's `Response.url` is the file's and its `type` "basic" – a same-origin answer;
        // a constructed Response reads '' and "default" otherwise.
        for (const [name, value] of [
          ['url', entry.url],
          ['type', 'basic']
        ]) {
          try {
            Object.defineProperty(response, name, { value, configurable: true })
          } catch {
            /* a frozen Response of the page's: the body and headers still stand */
          }
        }
      } catch (e) {
        host.error(`[Zenium] ${entry.url} arrived unreadable over the bridge`, e)
        entry.page().then(entry.resolve, entry.reject)
        return
      }
      entry.resolve(response)
    },
    pending: () => waiting.size + waitingProxy.size
  }
}

function isRequest(win: Window & typeof globalThis, input: RequestInfo | URL): input is Request {
  return (
    typeof input === 'object' &&
    input !== null &&
    ((typeof win.Request === 'function' && input instanceof win.Request) ||
      (typeof Request === 'function' && input instanceof Request))
  )
}

/** `input` with its URL in the served spelling: a string or URL as the string, a Request rebuilt on it. */
function respelled(
  win: Window & typeof globalThis,
  input: RequestInfo | URL,
  served: string
): RequestInfo | URL {
  if (!isRequest(win, input)) return served
  try {
    return new win.Request(served, input)
  } catch {
    return served
  }
}

/** What an aborted fetch rejects with: the signal's reason, or an AbortError as fetch's own. */
function abortReason(win: Window & typeof globalThis, signal: AbortSignal): unknown {
  const reason = (signal as { reason?: unknown }).reason
  if (reason !== undefined) return reason
  if (typeof win.DOMException === 'function')
    return new win.DOMException('The user aborted a request.', 'AbortError')
  const error = new win.Error('The user aborted a request.')
  error.name = 'AbortError'
  return error
}

function urlOf(win: Window & typeof globalThis, input: RequestInfo | URL): string {
  try {
    if (typeof input === 'string') return new win.URL(input, win.location.href).href
    if (input instanceof win.URL || input instanceof URL) return input.href
    return String((input as Request).url)
  } catch {
    return ''
  }
}

function decodeBase64(win: Window & typeof globalThis, text: string): Uint8Array {
  const binary = win.atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
