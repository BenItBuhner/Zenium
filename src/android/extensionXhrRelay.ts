/**
 * A content script's `XMLHttpRequest` of its own extension's file, answered by the host.
 *
 * The older bundles read their extension's files with an XHR
 * (`xhr.open('GET', chrome.runtime.getURL('data/rules.json')); xhr.send()`), which the page's
 * `connect-src` refuses on a WebView the same way it refuses the world's `fetch`
 * (`extensionFetchRelay.ts`: Chrome's isolated world carries the extension's origin, a
 * WebView's the document's policy). So the content scripts' `XMLHttpRequest` is this subclass
 * of the realm's: an asynchronous request `open`ed on an attached extension's own URL (either
 * spelling) never reaches the network stack – `send` asks the relay's `fetch`, which the host
 * answers over the bridge, and the answer is played back as the XHR's states and events
 * (`readystatechange` through HEADERS_RECEIVED, LOADING and DONE; `loadstart`, `progress`,
 * `load`, `loadend`; `error` when the page's answer, the fallback, failed; `abort` and `timeout`
 * for the extension's own calls), with `status` 200, `responseURL` the file's, the
 * `Content-Type` and `Content-Length` headers, and `response` in the `responseType` asked. Any
 * other request – another URL, or a synchronous one, which cannot wait for the bridge – is the
 * native XHR's, exactly as before: the overrides hand it to the native prototype's own members.
 *
 * The same ride serves a CROSS-ORIGIN request to an origin the page's policy has refused in
 * this document (`extensionFetchRelay.ts`'s second class; the relay's `fetch` then asks the host
 * first and judges the answer as Chrome's renderer would): the request's headers, body and
 * `withCredentials` go along, and the answer's status, exposed headers and final URL are played
 * back. The policy's refusal is learnt from the document's own report, so the FIRST request to
 * such an origin – by an XHR, where nothing of the native's course can be replayed – fails as
 * before and teaches the relay; the next is relayed. A `fetch`'s refusal teaches it too.
 */

export interface XhrRelayHost {
  /** Whether `url` (resolved, either spelling) is an attached extension's own file. */
  owns(url: string): boolean
  /** Whether `url` is a cross-origin URL the page's policy has refused, which the relay's `fetch` asks the host for. */
  refused?(url: string): boolean
  /** The relay's `fetch`: the host's answer for an own file or a refused cross-origin URL, the page's otherwise. */
  fetch(url: string, init: RequestInit): Promise<Response>
}

interface Relayed {
  method: string
  url: string
  /** Whether the request is the extension's own file (a header on it goes nowhere) or a cross-origin one. */
  own: boolean
  /** The request headers set so far (a cross-origin request's go along). */
  requestHeaders: Array<[string, string]>
  readyState: number
  status: number
  statusText: string
  responseURL: string
  headers: Array<[string, string]>
  bytes: Uint8Array | null
  sent: boolean
  /** Set by `abort()` and by the timeout: the answer, arriving late, is dropped. */
  aborted: boolean
  timer: number | null
  overrideMime: string | null
}

const UNSENT = 0
const OPENED = 1
const HEADERS_RECEIVED = 2
const LOADING = 3
const DONE = 4

type Win = Window & typeof globalThis
type Any = Record<string, unknown>

/**
 * The `XMLHttpRequest` the content scripts' scope answers: the realm's subclassed, an
 * asynchronous request for an attached extension's own file relayed; null when the realm has
 * no `XMLHttpRequest` to subclass.
 */
export function createXhrRelay(win: Win, host: XhrRelayHost): typeof XMLHttpRequest | null {
  const Native = win.XMLHttpRequest
  if (typeof Native !== 'function') return null
  const nativeProto = Native.prototype as unknown as Any
  const relayed = new WeakMap<XMLHttpRequest, Relayed>()

  const resolved = (url: unknown): string => {
    try {
      return new win.URL(String(url), win.location.href).href
    } catch {
      return ''
    }
  }

  const progressEvent = (type: string, loaded: number, total: number): Event => {
    try {
      return new win.ProgressEvent(type, { lengthComputable: total > 0, loaded, total })
    } catch {
      return new win.Event(type)
    }
  }

  const invalidState = (message: string): unknown => {
    if (typeof win.DOMException === 'function')
      return new win.DOMException(message, 'InvalidStateError')
    const error = new win.Error(message)
    error.name = 'InvalidStateError'
    return error
  }

  const mimeOf = (state: Relayed): string => {
    const override = state.overrideMime
    if (override) return override.split(';')[0].trim()
    const header = state.headers.find(([n]) => n === 'content-type')
    return header ? header[1].split(';')[0].trim() : ''
  }

  const textOf = (state: Relayed): string =>
    new win.TextDecoder('utf-8').decode(state.bytes ?? new Uint8Array(0))

  const parsed = (state: Relayed): Document | null => {
    try {
      const kind: DOMParserSupportedType = /xml/i.test(mimeOf(state))
        ? 'application/xml'
        : 'text/html'
      return new win.DOMParser().parseFromString(textOf(state), kind)
    } catch {
      return null
    }
  }

  const clearTimer = (state: Relayed): void => {
    if (state.timer !== null) win.clearTimeout(state.timer)
    state.timer = null
  }

  const finish = (xhr: XMLHttpRequest, state: Relayed, loaded: number): void => {
    clearTimer(state)
    state.readyState = DONE
    xhr.dispatchEvent(new win.Event('readystatechange'))
    xhr.dispatchEvent(progressEvent('load', loaded, loaded))
    xhr.dispatchEvent(progressEvent('loadend', loaded, loaded))
  }

  const fail = (xhr: XMLHttpRequest, state: Relayed, type: 'error' | 'timeout'): void => {
    clearTimer(state)
    state.aborted = type === 'timeout'
    state.status = 0
    state.statusText = ''
    state.bytes = null
    state.readyState = DONE
    xhr.dispatchEvent(new win.Event('readystatechange'))
    xhr.dispatchEvent(progressEvent(type, 0, 0))
    xhr.dispatchEvent(progressEvent('loadend', 0, 0))
  }

  /** The native member of the same name, for a request that is not relayed. */
  const nativeMethod = (name: string): ((this: XMLHttpRequest, ...args: unknown[]) => unknown) =>
    nativeProto[name] as (this: XMLHttpRequest, ...args: unknown[]) => unknown
  const nativeGetter = (name: string): ((this: XMLHttpRequest) => unknown) => {
    // The accessor may sit above `XMLHttpRequest.prototype` (a realm that subclasses its own).
    for (let p: object | null = nativeProto; p !== null; p = Object.getPrototypeOf(p)) {
      const getter = Object.getOwnPropertyDescriptor(p, name)?.get
      if (getter) return getter as (this: XMLHttpRequest) => unknown
    }
    return () => undefined
  }

  class RelayedXMLHttpRequest extends Native {}
  const proto = RelayedXMLHttpRequest.prototype as unknown as Any

  const methods: Record<string, (this: XMLHttpRequest, ...args: unknown[]) => unknown> = {
    open(method, url, async, username, password) {
      const previous = relayed.get(this)
      if (previous) {
        // A second `open` drops the relayed request as the native drops an in-flight one.
        clearTimer(previous)
        relayed.delete(this)
      }
      const href = resolved(url)
      const own = href !== '' && host.owns(href)
      if (async !== false && href !== '' && (own || host.refused?.(href) === true)) {
        relayed.set(this, {
          method: String(method).toUpperCase(),
          url: href,
          own,
          requestHeaders: [],
          readyState: OPENED,
          status: 0,
          statusText: '',
          responseURL: '',
          headers: [],
          bytes: null,
          sent: false,
          aborted: false,
          timer: null,
          overrideMime: null
        })
        this.dispatchEvent(new win.Event('readystatechange'))
        return undefined
      }
      // The native call as it was made: a two-argument open stays one (`async` defaults true).
      if (async === undefined) return nativeMethod('open').call(this, method, url)
      return nativeMethod('open').call(this, method, url, async, username, password)
    },
    setRequestHeader(name, value) {
      const state = relayed.get(this)
      if (!state) return nativeMethod('setRequestHeader').call(this, name, value)
      if (state.readyState !== OPENED || state.sent) {
        throw invalidState(
          "Failed to execute 'setRequestHeader' on 'XMLHttpRequest': The object's state must be OPENED."
        )
      }
      // A header on a request for one's own file goes nowhere, as it goes nowhere in Chrome; a
      // cross-origin request's go along (the forbidden names fetch's Headers refuse are left to it).
      if (!state.own) state.requestHeaders.push([String(name), String(value)])
      return undefined
    },
    overrideMimeType(mime) {
      const state = relayed.get(this)
      if (!state) return nativeMethod('overrideMimeType').call(this, mime)
      state.overrideMime = String(mime)
      return undefined
    },
    send(body) {
      const state = relayed.get(this)
      if (!state) return nativeMethod('send').call(this, body)
      if (state.readyState !== OPENED || state.sent) {
        throw invalidState(
          "Failed to execute 'send' on 'XMLHttpRequest': The object's state must be OPENED."
        )
      }
      state.sent = true
      const timeout = this.timeout
      if (typeof timeout === 'number' && timeout > 0) {
        state.timer = win.setTimeout(() => {
          if (relayed.get(this) === state && !state.aborted && state.readyState !== DONE)
            fail(this, state, 'timeout')
        }, timeout)
      }
      this.dispatchEvent(progressEvent('loadstart', 0, 0))
      const live = (): boolean => relayed.get(this) === state && !state.aborted
      const init: RequestInit = { method: state.method }
      if (!state.own) {
        // A cross-origin request as the native would send it: its headers, its body (a Document
        // serialised, as XHR sends one), the cookies when `withCredentials` asks for them.
        init.headers = state.requestHeaders
        init.credentials = this.withCredentials ? 'include' : 'same-origin'
        if (
          body !== null &&
          body !== undefined &&
          state.method !== 'GET' &&
          state.method !== 'HEAD'
        ) {
          init.body = isDocument(win, body) ? serialised(win, body) : (body as BodyInit)
        }
      }
      host
        .fetch(state.url, init)
        .then(async (response) => {
          const bytes = new Uint8Array(await response.arrayBuffer())
          if (!live()) return
          state.status = response.status
          state.statusText = response.statusText
          state.responseURL = response.url || state.url
          const headers: Array<[string, string]> = []
          response.headers.forEach((value, name) => headers.push([name.toLowerCase(), value]))
          state.headers = headers
          state.readyState = HEADERS_RECEIVED
          this.dispatchEvent(new win.Event('readystatechange'))
          if (!live()) return
          state.readyState = LOADING
          state.bytes = bytes
          this.dispatchEvent(new win.Event('readystatechange'))
          this.dispatchEvent(progressEvent('progress', bytes.byteLength, bytes.byteLength))
          if (!live()) return
          finish(this, state, bytes.byteLength)
        })
        .catch(() => {
          if (live()) fail(this, state, 'error')
        })
      return undefined
    },
    abort() {
      const state = relayed.get(this)
      if (!state) return nativeMethod('abort').call(this)
      clearTimer(state)
      if (state.sent && state.readyState !== DONE) {
        state.aborted = true
        state.status = 0
        state.statusText = ''
        state.bytes = null
        state.readyState = DONE
        this.dispatchEvent(new win.Event('readystatechange'))
        this.dispatchEvent(progressEvent('abort', 0, 0))
        this.dispatchEvent(progressEvent('loadend', 0, 0))
      }
      state.readyState = UNSENT
      state.sent = false
      return undefined
    },
    getResponseHeader(name) {
      const state = relayed.get(this)
      if (!state) return nativeMethod('getResponseHeader').call(this, name)
      if (state.readyState < HEADERS_RECEIVED) return null
      const wanted = String(name).toLowerCase()
      const values = state.headers.filter(([n]) => n === wanted).map(([, v]) => v)
      return values.length ? values.join(', ') : null
    },
    getAllResponseHeaders() {
      const state = relayed.get(this)
      if (!state) return nativeMethod('getAllResponseHeaders').call(this)
      if (state.readyState < HEADERS_RECEIVED) return ''
      return state.headers.map(([n, v]) => `${n}: ${v}\r\n`).join('')
    }
  }

  const getters: Record<string, (this: XMLHttpRequest) => unknown> = {
    readyState() {
      const state = relayed.get(this)
      return state ? state.readyState : nativeGetter('readyState').call(this)
    },
    status() {
      const state = relayed.get(this)
      return state ? state.status : nativeGetter('status').call(this)
    },
    statusText() {
      const state = relayed.get(this)
      return state ? state.statusText : nativeGetter('statusText').call(this)
    },
    responseURL() {
      const state = relayed.get(this)
      return state ? state.responseURL : nativeGetter('responseURL').call(this)
    },
    responseText() {
      const state = relayed.get(this)
      if (!state) return nativeGetter('responseText').call(this)
      const type = this.responseType
      if (type !== '' && type !== 'text') {
        throw invalidState(
          `Failed to read the 'responseText' property from 'XMLHttpRequest': The value is only accessible if the object's 'responseType' is '' or 'text' (was '${type}').`
        )
      }
      return state.bytes ? textOf(state) : ''
    },
    response() {
      const state = relayed.get(this)
      if (!state) return nativeGetter('response').call(this)
      const type = this.responseType
      if (type === '' || type === 'text') return state.bytes ? textOf(state) : ''
      if (state.readyState !== DONE || !state.bytes) return null
      const bytes = state.bytes
      switch (type) {
        case 'arraybuffer':
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        case 'blob':
          return new win.Blob([bytes as BlobPart], { type: mimeOf(state) })
        case 'json':
          try {
            return JSON.parse(textOf(state))
          } catch {
            return null
          }
        case 'document':
          return parsed(state)
        default:
          return null
      }
    },
    responseXML() {
      const state = relayed.get(this)
      if (!state) return nativeGetter('responseXML').call(this)
      const type = this.responseType
      if (type !== '' && type !== 'document') {
        throw invalidState(
          `Failed to read the 'responseXML' property from 'XMLHttpRequest': The value is only accessible if the object's 'responseType' is '' or 'document' (was '${type}').`
        )
      }
      if (state.readyState !== DONE || !state.bytes) return null
      // With no `responseType` a document is parsed for an XML answer alone, as the native's is.
      if (type === '' && !/xml/i.test(mimeOf(state))) return null
      return parsed(state)
    }
  }

  function isDocument(win: Win, body: unknown): body is Document {
    return typeof win.Document === 'function' && body instanceof win.Document
  }

  /** A Document body as XHR serialises it: the markup, as text. */
  function serialised(win: Win, body: Document): string {
    try {
      return new win.XMLSerializer().serializeToString(body)
    } catch {
      return ''
    }
  }

  for (const [name, method] of Object.entries(methods)) {
    Object.defineProperty(proto, name, {
      value: method,
      writable: true,
      configurable: true,
      enumerable: false
    })
  }
  for (const [name, get] of Object.entries(getters)) {
    Object.defineProperty(proto, name, { get, configurable: true, enumerable: true })
  }

  return RelayedXMLHttpRequest as unknown as typeof XMLHttpRequest
}
