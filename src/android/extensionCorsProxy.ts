import { matchesAnyPatternOrigin } from '@core/extensions/api/matchPattern'
import { isExtensionPageUrl, toServedUrl } from '@core/extensions/runtime/extensionUrls'

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
 * untouched: those are the WebView's, CORS and all, as they are Chrome's – except that an
 * extension-origin answer the host refused, where Chrome has no answer but a network error,
 * rejects as Chrome's does (`NET_ERROR_HEADER`): the `fetch` with Chrome's `TypeError`, the
 * `XMLHttpRequest` with Chrome's course for a network error (`readyState` 4, `status` 0, the
 * `error` and `loadend` events, never `load`).
 */

export const PROXY_HEADER = 'X-Zenium-Proxy'
export const CREDENTIALS_HEADER = 'X-Zenium-Credentials'
export const SKIP = 'skip'
/**
 * The header on an extension-origin answer Chrome would not answer at all (`NetErrorAnswer.kt`,
 * set by `Extensions.intercept`): a request for a file of an extension that is not installed, for another
 * extension's file that is not web-accessible, in a private tab the extension may not see
 * (`ERR_BLOCKED_BY_CLIENT`), or for a file the extension has not (`ERR_FILE_NOT_FOUND`). Chrome
 * fails these as network errors, so an extension's `fetch` of them rejects – `TypeError: Failed
 * to fetch` – and an extension reads the rejection as the file's absence: Black Menu for Google
 * tells Vivaldi by a `HEAD` of Vivaldi's reader extension (`chrome-extension://mpognobbk…/…`),
 * `then(() => true, () => null)`, and turns its toolbar tap into the side panel on `true`. The
 * WebView can only answer such a request with a response from the host (the served origin is
 * the host's alone), so the host answers a 404 with this header, and `fetch` here rejects it as
 * Chrome does. A response of the page's `no-cors` mode is opaque and keeps its headers; such a
 * request still resolves.
 */
export const NET_ERROR_HEADER = 'X-Zenium-Net-Error'
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
  /** The host refused the extension-origin request: the XHR reads as Chrome's network error. */
  netError: boolean
  /** The network error's own events are being dispatched: the watcher lets them through. */
  replaying: boolean
}

const HEADERS_RECEIVED = 2
const DONE = 4
/** The native XHR's events after the host's refusal, swallowed so Chrome's course alone is seen. */
const SWALLOWED_EVENTS = [
  'readystatechange',
  'progress',
  'load',
  'loadend',
  'error',
  'abort',
  'timeout'
]

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
    if (!proxiesUrl(served, options)) {
      const response = await native.call(win, input, init)
      return isExtensionPageUrl(served) ? asChromeAnswers(win, response) : response
    }
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

/**
 * Whether an answer is the host's refusal of an extension-origin request (`NET_ERROR_HEADER`) –
 * the network error Chrome fails the request with. An opaque response has no headers to read:
 * it stands.
 */
export function refusedByHost(response: Response): boolean {
  try {
    return Boolean(response.headers.get(NET_ERROR_HEADER))
  } catch {
    return false
  }
}

/**
 * An extension-origin answer as Chrome gives it: the host's refusal (`NET_ERROR_HEADER`) is the
 * network error Chrome fails the request with, so the fetch rejects with Chrome's `TypeError`;
 * any other answer stands.
 */
function asChromeAnswers(win: Window & typeof globalThis, response: Response): Response {
  if (refusedByHost(response)) throw new win.TypeError('Failed to fetch')
  return response
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
      contentType: null,
      netError: false,
      replaying: false
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

  installNetErrorCourse(win, states)
}

/**
 * The host's refusal of an extension-origin request on an `XMLHttpRequest`, as Chrome's network
 * error (R26-3, the XHR half of R25-11): where `fetch` rejects, Chrome's XHR goes `readyState` 4
 * with `status` 0 and fires `error` and `loadend` – never `load`, never a 2 or 3 – and the host's
 * marked 404 (`NET_ERROR_HEADER`) must read the same, or an extension's `onload`/`onerror` pair
 * reads a missing file as present. The page's `XMLHttpRequest` becomes a subclass of the
 * realm's, the same to `instanceof`, the statics and the prototype chain, whose constructor
 * registers the FIRST listeners on each request (an `onload` or `onreadystatechange` set before
 * `open` is a listener registered before `open`; nothing registered later can run ahead of the
 * constructor's): at the native's HEADERS_RECEIVED with the header on an extension-origin
 * answer the request is marked, that event is stopped before any other listener sees it, Chrome's
 * three events are dispatched, and every later event of the native's (the body's 3 and 4,
 * `progress`, `load`, `loadend`) is swallowed; the subclass's accessors read the mark – 4, 0,
 * an empty response, no headers – and the native's own values otherwise. A web answer with the
 * header, and an extension-origin answer without it (a generated page's 404), stand as they are.
 */
function installNetErrorCourse(
  win: Window & typeof globalThis,
  states: WeakMap<XMLHttpRequest, XhrState>
): void {
  const Native = win.XMLHttpRequest
  const proto = Native.prototype as unknown as Record<string, unknown>
  const nativeGetter = (name: string): ((this: XMLHttpRequest) => unknown) => {
    for (let p: object | null = proto; p !== null; p = Object.getPrototypeOf(p)) {
      const getter = Object.getOwnPropertyDescriptor(p, name)?.get
      if (getter) return getter as (this: XMLHttpRequest) => unknown
    }
    return () => undefined
  }
  const nativeMethod = (name: string): ((this: XMLHttpRequest, ...args: unknown[]) => unknown) =>
    proto[name] as (this: XMLHttpRequest, ...args: unknown[]) => unknown
  const readyStateOf = nativeGetter('readyState')
  const getResponseHeader = nativeMethod('getResponseHeader')

  const progressEvent = (type: string): Event => {
    try {
      return new win.ProgressEvent(type, { lengthComputable: false, loaded: 0, total: 0 })
    } catch {
      return new win.Event(type)
    }
  }

  const watch = (xhr: XMLHttpRequest): void => {
    if (typeof xhr.addEventListener !== 'function') return
    xhr.addEventListener('readystatechange', (event) => {
      const state = states.get(xhr)
      if (!state) return
      if (state.netError) {
        if (!state.replaying) event.stopImmediatePropagation()
        return
      }
      if (readyStateOf.call(xhr) !== HEADERS_RECEIVED || !isExtensionPageUrl(state.url)) return
      let refused: unknown = null
      try {
        refused = getResponseHeader.call(xhr, NET_ERROR_HEADER)
      } catch {
        refused = null
      }
      if (!refused) return
      state.netError = true
      event.stopImmediatePropagation()
      state.replaying = true
      try {
        xhr.dispatchEvent(new win.Event('readystatechange'))
        xhr.dispatchEvent(progressEvent('error'))
        xhr.dispatchEvent(progressEvent('loadend'))
      } finally {
        state.replaying = false
      }
    })
    for (const type of SWALLOWED_EVENTS) {
      if (type === 'readystatechange') continue
      xhr.addEventListener(type, (event) => {
        const state = states.get(xhr)
        if (state?.netError && !state.replaying) event.stopImmediatePropagation()
      })
    }
  }

  // The class keeps the native's name: `XMLHttpRequest.name` reads as before.
  const Patched = class XMLHttpRequest extends Native {
    constructor() {
      super()
      watch(this)
    }
  }
  const patched = Patched.prototype as unknown as Record<string, unknown>
  const failed = (xhr: XMLHttpRequest): boolean => states.get(xhr)?.netError === true
  const textual = (xhr: XMLHttpRequest): boolean => {
    const type = xhr.responseType
    return type === '' || type === 'text'
  }
  const getters: Record<string, (this: XMLHttpRequest) => unknown> = {
    readyState() {
      return failed(this) ? DONE : nativeGetter('readyState').call(this)
    },
    status() {
      return failed(this) ? 0 : nativeGetter('status').call(this)
    },
    statusText() {
      return failed(this) ? '' : nativeGetter('statusText').call(this)
    },
    responseURL() {
      return failed(this) ? '' : nativeGetter('responseURL').call(this)
    },
    response() {
      if (!failed(this)) return nativeGetter('response').call(this)
      return textual(this) ? '' : null
    },
    responseText() {
      // A non-text `responseType` throws the native's InvalidStateError, as it would.
      if (!failed(this) || !textual(this)) return nativeGetter('responseText').call(this)
      return ''
    },
    responseXML() {
      return failed(this) ? null : nativeGetter('responseXML').call(this)
    }
  }
  for (const [name, get] of Object.entries(getters)) {
    Object.defineProperty(patched, name, { get, configurable: true, enumerable: true })
  }
  const methods: Record<string, (this: XMLHttpRequest, ...args: unknown[]) => unknown> = {
    getResponseHeader(name) {
      return failed(this) ? null : nativeMethod('getResponseHeader').call(this, name)
    },
    getAllResponseHeaders() {
      return failed(this) ? '' : nativeMethod('getAllResponseHeaders').call(this)
    }
  }
  for (const [name, method] of Object.entries(methods)) {
    Object.defineProperty(patched, name, {
      value: method,
      writable: true,
      configurable: true,
      enumerable: false
    })
  }
  win.XMLHttpRequest = Patched as unknown as typeof XMLHttpRequest
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
