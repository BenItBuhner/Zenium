import { matchesAnyPatternOrigin } from '@core/extensions/api/matchPattern'
import { toServedUrl } from '@core/extensions/runtime/extensionUrls'

/**
 * The page side of the CORS proxy (`CorsProxy.kt`). Chrome lets an extension page fetch any host
 * its `host_permissions` cover without CORS; here such a request is answered by Kotlin from
 * `shouldInterceptRequest`, which sees the method, URL and headers of a request but never its
 * body. So `fetch` and `XMLHttpRequest` on extension pages hand the body of a bodied request to
 * Kotlin over the bridge first, under a ticket the request then names in a header, and send the
 * request itself without one. Two more things Kotlin cannot see travel as headers: whether the
 * fetch is credentialed (`credentials: "include"`, `withCredentials`), so cookies go along, and
 * whether the page could not hand the body over at all (`skip`), so Kotlin leaves that request
 * to the WebView. Requests to the extension's own origin and to hosts outside its permissions are
 * untouched: those are the WebView's, CORS and all, as they are Chrome's.
 */

export const PROXY_HEADER = 'X-Zenium-Proxy'
export const CREDENTIALS_HEADER = 'X-Zenium-Credentials'
export const SKIP = 'skip'
/** Bodies past this go unticketed (the request is left to the WebView): base64 over the bridge has a price. */
export const MAX_BODY_BYTES = 16 * 1024 * 1024

export interface CorsProxyOptions {
  /** The extension's emulated origin (`https://<id>.ext.zenium.invalid`). */
  origin: string
  hostPermissions: readonly string[]
  /** A body for Kotlin, ahead of the request that names the ticket. */
  postBody(ticket: string, base64: string): void
  nextTicket(): string
}

type FetchFn = typeof globalThis.fetch

interface XhrState {
  method: string
  url: string
  async: boolean
  contentType: string | null
}

/** Whether a URL is one the proxy answers: http(s), off the extension origin, inside the permissions. */
export function proxiesUrl(
  url: string,
  options: Pick<CorsProxyOptions, 'origin' | 'hostPermissions'>
): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  if (url.startsWith(options.origin + '/')) return false
  // By security origin, as Chrome's CORS allowlist reads a host permission: its path is not
  // consulted (`https://mail.google.com/` reaches `/mail/u/0/feed/atom`).
  return matchesAnyPatternOrigin(url, options.hostPermissions)
}

/** Install the patched `fetch` and `XMLHttpRequest` on an extension page's window. */
export function installCorsProxy(win: Window & typeof globalThis, options: CorsProxyOptions): void {
  installFetch(win, options)
  installXhr(win, options)
}

function installFetch(win: Window & typeof globalThis, options: CorsProxyOptions): void {
  const native: FetchFn = win.fetch
  if (typeof native !== 'function') return
  const patched: FetchFn = async function fetch(input, init) {
    // The extension's own file under Chrome's spelling (`chrome-extension://<id>/x.json`, the
    // way an extension page's URL is presented to it) loads from the served origin.
    const asked = urlOf(win, input)
    const served = toServedUrl(asked)
    if (served !== asked)
      input =
        typeof input === 'string' || input instanceof URL ? served : new win.Request(served, input)
    // Decide on the URL alone first: building a Request from a Request takes its body over.
    if (!proxiesUrl(served, options)) return native.call(win, input, init)
    const request = new win.Request(input, init)
    const headers = new win.Headers(request.headers)
    if (request.credentials === 'include') headers.set(CREDENTIALS_HEADER, 'include')
    // The same request without its body: Kotlin puts the ticketed one back. `Response.url` is
    // the real URL, so nothing downstream notices the detour. A body too large for the bridge
    // stays with the request, which is then the WebView's to send.
    let body: ArrayBuffer | null = null
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.body != null) {
      const bytes = await request.arrayBuffer()
      if (bytes.byteLength > MAX_BODY_BYTES) {
        body = bytes
        headers.set(PROXY_HEADER, SKIP)
      } else if (bytes.byteLength > 0) {
        headers.set(PROXY_HEADER, ticketFor(bytes, options))
      }
    }
    return native.call(
      win,
      new win.Request(request.url, {
        method: request.method,
        headers,
        body,
        mode: request.mode,
        credentials: request.credentials,
        cache: request.cache,
        redirect: request.redirect,
        referrer: request.referrer,
        referrerPolicy: request.referrerPolicy,
        integrity: request.integrity,
        keepalive: request.keepalive,
        signal: request.signal
      })
    )
  }
  win.fetch = patched
}

function urlOf(win: Window & typeof globalThis, input: RequestInfo | URL): string {
  try {
    if (typeof input === 'string') return new win.URL(input, win.location.href).href
    if (input instanceof win.URL || input instanceof URL) return input.href
    return input.url
  } catch {
    return ''
  }
}

function installXhr(win: Window & typeof globalThis, options: CorsProxyOptions): void {
  const proto = win.XMLHttpRequest?.prototype
  if (!proto) return
  const nativeOpen = proto.open
  const nativeSend = proto.send
  const nativeSetRequestHeader = proto.setRequestHeader
  const states = new WeakMap<XMLHttpRequest, XhrState>()

  proto.open = function open(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    let absolute = ''
    try {
      absolute = new win.URL(String(url), win.location.href).href
    } catch {
      absolute = ''
    }
    const served = toServedUrl(absolute)
    if (served !== absolute) {
      absolute = served
      url = served
    }
    states.set(this, {
      method: String(method).toUpperCase(),
      url: absolute,
      async: rest.length === 0 || rest[0] !== false,
      contentType: null
    })
    return (nativeOpen as (...args: unknown[]) => void).call(this, method, url, ...rest)
  } as typeof proto.open

  proto.setRequestHeader = function setRequestHeader(
    this: XMLHttpRequest,
    name: string,
    value: string
  ) {
    const state = states.get(this)
    if (state && name.toLowerCase() === 'content-type') state.contentType = value
    return nativeSetRequestHeader.call(this, name, value)
  }

  proto.send = function send(
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null
  ) {
    const state = states.get(this)
    if (!state || !proxiesUrl(state.url, options)) return nativeSend.call(this, body)
    if (this.withCredentials) nativeSetRequestHeader.call(this, CREDENTIALS_HEADER, 'include')
    if (body === null || body === undefined || state.method === 'GET' || state.method === 'HEAD') {
      return nativeSend.call(this, body)
    }
    const encoded = encodeBody(win, body)
    if (encoded === null) {
      // A body the page cannot serialise (a Document): the WebView sends it, CORS and all.
      nativeSetRequestHeader.call(this, PROXY_HEADER, SKIP)
      return nativeSend.call(this, body)
    }
    const ticketed = ({ bytes, contentType }: EncodedBody): void => {
      if (bytes.byteLength > MAX_BODY_BYTES) {
        nativeSetRequestHeader.call(this, PROXY_HEADER, SKIP)
        nativeSend.call(this, body)
        return
      }
      // XHR sets the Content-Type from the body it is given; with the body gone, it is set here.
      if (state.contentType === null && contentType) {
        nativeSetRequestHeader.call(this, 'Content-Type', contentType)
      }
      nativeSetRequestHeader.call(this, PROXY_HEADER, ticketFor(bytes, options))
      nativeSend.call(this, null)
    }
    if (isPromise(encoded)) {
      if (!state.async) {
        // A synchronous XHR cannot wait for a Blob or FormData to serialise.
        nativeSetRequestHeader.call(this, PROXY_HEADER, SKIP)
        return nativeSend.call(this, body)
      }
      void encoded.then(ticketed, () => {
        nativeSetRequestHeader.call(this, PROXY_HEADER, SKIP)
        nativeSend.call(this, body)
      })
      return
    }
    ticketed(encoded)
  }
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>).then === 'function'
}

interface EncodedBody {
  bytes: ArrayBuffer
  /** The Content-Type XHR would have derived from the body, or null when it derives none. */
  contentType: string | null
}

/** Serialise an XHR body; a promise for the asynchronous kinds (Blob, FormData), null for a Document. */
function encodeBody(
  win: Window & typeof globalThis,
  body: Document | XMLHttpRequestBodyInit
): EncodedBody | Promise<EncodedBody> | null {
  if (typeof body === 'string') {
    return {
      bytes: new TextEncoder().encode(body).buffer as ArrayBuffer,
      contentType: 'text/plain;charset=UTF-8'
    }
  }
  if (body instanceof win.ArrayBuffer || body instanceof ArrayBuffer) {
    return { bytes: body.slice(0), contentType: null }
  }
  if (ArrayBuffer.isView(body)) {
    return {
      bytes: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      contentType: null
    }
  }
  if (body instanceof win.URLSearchParams || body instanceof URLSearchParams) {
    return {
      bytes: new TextEncoder().encode(body.toString()).buffer as ArrayBuffer,
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8'
    }
  }
  if (typeof win.Blob === 'function' && body instanceof win.Blob) {
    return body.arrayBuffer().then((bytes) => ({ bytes, contentType: body.type || null }))
  }
  if (typeof win.FormData === 'function' && body instanceof win.FormData) {
    // Response serialises multipart form data with its boundary, the way XHR would.
    const response = new win.Response(body)
    const contentType = response.headers.get('content-type')
    return response.arrayBuffer().then((bytes) => ({ bytes, contentType }))
  }
  return null
}

function ticketFor(bytes: ArrayBuffer, options: CorsProxyOptions): string {
  const ticket = options.nextTicket()
  options.postBody(ticket, base64(new Uint8Array(bytes)))
  return ticket
}

/** Standard base64 of a byte array, in chunks that keep `String.fromCharCode` under its argument limit. */
export function base64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(binary)
}
