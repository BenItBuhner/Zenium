/**
 * The page script's observer of the page's own `fetch` / XHR responses, for the extension
 * runtime's `chrome.webRequest` emulation (`blocking-rule-interface.md` 7.10; round 15). The
 * Kotlin engine's intercept sees every request's REQUEST stage but no response (WebView shows
 * the embedder none); its relay serves and observes media-element requests alone (7.2). A page
 * script's `fetch` / XHR – what an MSE player, an XHR-fed `<video>`, a JSON API feeds on – has
 * its response in the page, and this observer reports it AS THE PAGE SEES IT: the status, the
 * headers the page may read (a cross-origin cors response exposes the safelisted ones and what
 * `Access-Control-Expose-Headers` names; an opaque `no-cors` response nothing, and it is not
 * reported), and – for a `fetch` – the end of the body as the page reads it.
 *
 * Installed by the page script only while the host says a response-stage `webRequest` listener
 * exists ([RequestObserver.setOn]; the `extObserve` message), so a page under no sniffer keeps
 * its own `fetch` and `XMLHttpRequest` untouched; the hooks stand from the first word on and
 * pass through while the word is off (a page may have wrapped them by then: putting the natives
 * back under its wrapper, and hooking again over it later, would observe one response twice).
 *
 * The runtime asks `relayServed` first (the shared selection) and drops what the relay served,
 * pairs the rest with the intercept's `onBeforeRequest` by tab, URL and order, and emits
 * `onHeadersReceived`, `onResponseStarted` and `onCompleted` under that id.
 */
export interface RequestObservation {
  type: 'ext-observation'
  /** The observer's own number for the request, per document: its `headers` and `complete` reports pair by it. */
  seq: string
  /** The request's absolute URL, without a fragment – the form the intercept saw. */
  url: string
  /** Upper case. */
  method: string
  /** The page's `Range` request header as it set it, or null. */
  range: string | null
  /** The request's URL is of another origin than the document's. */
  crossOrigin: boolean
  status: number
  statusText: string
  /** The response headers as the page sees them, in the page's order. */
  headers: Array<{ name: string; value: string }>
  at: 'headers' | 'complete'
  /** `fetch`: the response's URL when it differs from the request's (the engine followed a redirect). */
  finalUrl?: string
}

export interface RequestObserverTransport {
  send(observation: RequestObservation): void
}

export interface RequestObserver {
  setOn(on: boolean): void
}

interface RequestFacts {
  url: string
  method: string
  range: string | null
  crossOrigin: boolean
}

type BodyReader = 'arrayBuffer' | 'blob' | 'formData' | 'json' | 'text'
const BODY_READERS: readonly BodyReader[] = ['arrayBuffer', 'blob', 'formData', 'json', 'text']

/** `RequestObservation` as it reaches the runtime (a `pageMessage` view event); anything else is dropped. */
export function scriptObservation(raw: unknown): RequestObservation | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o.type !== 'ext-observation') return null
  if (typeof o.seq !== 'string' || o.seq === '') return null
  if (typeof o.url !== 'string' || !/^https?:\/\//i.test(o.url)) return null
  if (typeof o.method !== 'string' || o.method === '') return null
  if (o.range !== null && typeof o.range !== 'string') return null
  if (typeof o.crossOrigin !== 'boolean') return null
  if (
    typeof o.status !== 'number' ||
    !Number.isInteger(o.status) ||
    o.status < 100 ||
    o.status > 999
  )
    return null
  if (typeof o.statusText !== 'string') return null
  if (
    !Array.isArray(o.headers) ||
    !o.headers.every(
      (h: unknown) =>
        typeof h === 'object' &&
        h !== null &&
        typeof (h as { name?: unknown }).name === 'string' &&
        typeof (h as { value?: unknown }).value === 'string'
    )
  )
    return null
  if (o.at !== 'headers' && o.at !== 'complete') return null
  if (o.finalUrl !== undefined && typeof o.finalUrl !== 'string') return null
  const observation: RequestObservation = {
    type: 'ext-observation',
    seq: o.seq,
    url: o.url,
    method: o.method,
    range: o.range as string | null,
    crossOrigin: o.crossOrigin,
    status: o.status,
    statusText: o.statusText,
    headers: (o.headers as Array<{ name: string; value: string }>).map(({ name, value }) => ({
      name,
      value
    })),
    at: o.at
  }
  if (typeof o.finalUrl === 'string' && o.finalUrl !== o.url) observation.finalUrl = o.finalUrl
  return observation
}

/** The `Range` header of a request's headers, in any of the forms `fetch` takes them. */
function rangeOf(headers: HeadersInit | Headers | undefined | null): string | null {
  if (!headers) return null
  try {
    if (typeof (headers as Headers).get === 'function') {
      return (headers as Headers).get('range')
    }
    if (Array.isArray(headers)) {
      for (const pair of headers) {
        if (Array.isArray(pair) && String(pair[0]).toLowerCase() === 'range') return String(pair[1])
      }
      return null
    }
    for (const name of Object.keys(headers as Record<string, string>)) {
      if (name.toLowerCase() === 'range') return String((headers as Record<string, string>)[name])
    }
  } catch {
    /* a Proxy or a sealed object: no range read */
  }
  return null
}

/** The absolute URL without its fragment, as the network layer – and the intercept – sees it. */
function requestUrl(input: string, base: string): string | null {
  try {
    const url = new URL(input, base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'null'
  }
}

/**
 * Install the observer over the window's `fetch` and `XMLHttpRequest`. The hooks are laid on the
 * first `setOn(true)` and stand from then on, passing through while off.
 */
export function installRequestObserver(
  w: Window & typeof globalThis,
  transport: RequestObserverTransport
): RequestObserver {
  let on = false
  let hooked = false
  const docToken = Math.random().toString(36).slice(2, 8)
  let counter = 0
  const nextSeq = (): string => {
    counter += 1
    return `${docToken}-${counter}`
  }
  const documentOrigin = (): string => {
    try {
      return w.location.origin
    } catch {
      return 'null'
    }
  }
  const baseUrl = (): string => {
    try {
      return w.document.baseURI
    } catch {
      return w.location.href
    }
  }
  const report = (observation: RequestObservation): void => {
    try {
      transport.send(observation)
    } catch {
      /* the bridge is gone with the document */
    }
  }
  const factsOf = (url: string, method: string, range: string | null): RequestFacts => ({
    url,
    method: method.toUpperCase(),
    range,
    crossOrigin: originOf(url) !== documentOrigin()
  })

  // --- fetch --------------------------------------------------------------------------------

  const fetchFacts = (input: RequestInfo | URL, init?: RequestInit): RequestFacts | null => {
    let rawUrl: string
    let method = 'GET'
    let range: string | null = null
    if (typeof input === 'string') rawUrl = input
    else if (input instanceof URL) rawUrl = input.href
    else if (input && typeof (input as Request).url === 'string') {
      const request = input as Request
      rawUrl = request.url
      method = request.method || 'GET'
      range = rangeOf(request.headers)
    } else rawUrl = String(input)
    if (init) {
      if (typeof init.method === 'string' && init.method) method = init.method
      const initRange = rangeOf(init.headers)
      if (initRange !== null || init.headers) range = initRange
    }
    const url = requestUrl(rawUrl, baseUrl())
    if (url === null) return null
    return factsOf(url, method, range)
  }

  const headersOf = (headers: Headers): Array<{ name: string; value: string }> => {
    const out: Array<{ name: string; value: string }> = []
    try {
      headers.forEach((value, name) => {
        out.push({ name, value })
      })
    } catch {
      /* a sealed Headers: none read */
    }
    return out
  }

  /** The end of the body as the page reads it: the consumers, or a reader taken over `body`. */
  const watchBodyEnd = (response: Response, done: () => void): void => {
    let ended = false
    const once = (): void => {
      if (ended) return
      ended = true
      done()
    }
    if (response.body === null) {
      once()
      return
    }
    for (const name of BODY_READERS) {
      const native = response[name]
      if (typeof native !== 'function') continue
      Object.defineProperty(response, name, {
        configurable: true,
        writable: true,
        value: function (this: Response): Promise<unknown> {
          const promise = (native as () => Promise<unknown>).call(this)
          promise.then(once, () => {
            /* a failed read: no end to report */
          })
          return promise
        }
      })
    }
    const bodyGetter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(response) as object,
      'body'
    )?.get
    if (typeof bodyGetter !== 'function') return
    let wrapped: ReadableStream<Uint8Array> | null = null
    Object.defineProperty(response, 'body', {
      configurable: true,
      get(this: Response): ReadableStream<Uint8Array> | null {
        const stream = (bodyGetter as () => ReadableStream<Uint8Array> | null).call(this)
        if (!stream || wrapped === stream) return stream
        wrapped = stream
        const nativeGetReader = stream.getReader
        if (typeof nativeGetReader === 'function') {
          Object.defineProperty(stream, 'getReader', {
            configurable: true,
            writable: true,
            value: function (this: ReadableStream<Uint8Array>, ...args: unknown[]): unknown {
              const reader = (nativeGetReader as (...a: unknown[]) => unknown).apply(
                this,
                args
              ) as {
                read?: (...a: unknown[]) => Promise<{ done: boolean }>
              }
              const nativeRead = reader.read
              if (typeof nativeRead === 'function') {
                Object.defineProperty(reader, 'read', {
                  configurable: true,
                  writable: true,
                  value: function (
                    this: unknown,
                    ...readArgs: unknown[]
                  ): Promise<{ done: boolean }> {
                    const promise = nativeRead.apply(this, readArgs)
                    promise.then(
                      (result) => {
                        if (result && result.done) once()
                      },
                      () => {
                        /* a failed read */
                      }
                    )
                    return promise
                  }
                })
              }
              return reader
            }
          })
        }
        return stream
      }
    })
  }

  const observeFetchResponse = (seq: string, facts: RequestFacts, response: Response): void => {
    // An opaque response (a `no-cors` cross-origin fetch): the page sees no status and no headers, and neither does the observer.
    if (!response || response.status === 0) return
    const headers = headersOf(response.headers)
    const base = {
      type: 'ext-observation' as const,
      seq,
      url: facts.url,
      method: facts.method,
      range: facts.range,
      crossOrigin: facts.crossOrigin,
      status: response.status,
      statusText: response.statusText,
      headers
    }
    const finalUrl =
      response.redirected && response.url && response.url !== facts.url ? response.url : undefined
    const headersReport: RequestObservation = { ...base, at: 'headers' }
    if (finalUrl) headersReport.finalUrl = finalUrl
    report(headersReport)
    watchBodyEnd(response, () => {
      if (!on) return
      const complete: RequestObservation = { ...base, at: 'complete' }
      if (finalUrl) complete.finalUrl = finalUrl
      report(complete)
    })
  }

  // --- XMLHttpRequest ----------------------------------------------------------------------

  interface XhrState {
    facts: RequestFacts | null
    method: string
    url: string | null
    range: string | null
    seq: string | null
    reported: boolean
    /** The observer's listeners are on the object: one pair for its lifetime, however often it is reopened. */
    listening: boolean
  }
  const xhrStates = new WeakMap<XMLHttpRequest, XhrState>()
  const xhrState = (xhr: XMLHttpRequest): XhrState => {
    let state = xhrStates.get(xhr)
    if (!state) {
      state = {
        facts: null,
        method: 'GET',
        url: null,
        range: null,
        seq: null,
        reported: false,
        listening: false
      }
      xhrStates.set(xhr, state)
    }
    return state
  }
  const xhrHeaders = (xhr: XMLHttpRequest): Array<{ name: string; value: string }> => {
    const out: Array<{ name: string; value: string }> = []
    let all = ''
    try {
      all = xhr.getAllResponseHeaders() || ''
    } catch {
      return out
    }
    for (const line of all.split(/\r?\n/)) {
      const colon = line.indexOf(':')
      if (colon <= 0) continue
      out.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() })
    }
    return out
  }
  const observeXhr = (xhr: XMLHttpRequest, state: XhrState, at: 'headers' | 'complete'): void => {
    if (!on || !state.facts || !state.seq) return
    let status = 0
    let statusText = ''
    try {
      status = xhr.status
      statusText = xhr.statusText
    } catch {
      return
    }
    if (status === 0) return
    if (at === 'headers') {
      if (state.reported) return
      state.reported = true
    } else if (!state.reported) return
    let finalUrl: string | undefined
    try {
      const responseUrl = xhr.responseURL
      if (responseUrl && responseUrl !== state.facts.url) finalUrl = responseUrl
    } catch {
      /* no responseURL on this engine */
    }
    const observation: RequestObservation = {
      type: 'ext-observation',
      seq: state.seq,
      url: state.facts.url,
      method: state.facts.method,
      range: state.facts.range,
      crossOrigin: state.facts.crossOrigin,
      status,
      statusText,
      headers: xhrHeaders(xhr),
      at
    }
    if (finalUrl) observation.finalUrl = finalUrl
    report(observation)
  }

  type XhrOpen = XMLHttpRequest['open']
  type XhrSend = XMLHttpRequest['send']
  type XhrSetHeader = XMLHttpRequest['setRequestHeader']

  const hook = (): void => {
    if (hooked) return
    hooked = true
    // fetch
    const fetchOwner = w as unknown as { fetch?: typeof fetch }
    if (typeof fetchOwner.fetch === 'function') {
      const native = fetchOwner.fetch
      const wrapped = function (
        this: unknown,
        ...args: [RequestInfo | URL, RequestInit?]
      ): Promise<Response> {
        const promise = Reflect.apply(
          native,
          this === undefined || this === null ? w : this,
          args
        ) as Promise<Response>
        if (!on) return promise
        let facts: RequestFacts | null = null
        try {
          facts = fetchFacts(args[0], args[1])
        } catch {
          facts = null
        }
        if (!facts) return promise
        const seq = nextSeq()
        return promise.then((response) => {
          if (on) {
            try {
              observeFetchResponse(seq, facts, response)
            } catch {
              /* a response the page sealed: unobserved */
            }
          }
          return response
        })
      } as typeof fetch
      fetchOwner.fetch = wrapped
    }
    // XMLHttpRequest
    const proto = (w as unknown as { XMLHttpRequest?: { prototype: XMLHttpRequest } })
      .XMLHttpRequest?.prototype
    if (!proto) return
    const open: XhrOpen = proto.open
    const send: XhrSend = proto.send
    const setHeader: XhrSetHeader = proto.setRequestHeader
    proto.open = function (this: XMLHttpRequest, ...args: unknown[]): void {
      if (on) {
        const state = xhrState(this)
        state.method = typeof args[0] === 'string' && args[0] ? args[0] : 'GET'
        state.url = args[1] === undefined || args[1] === null ? null : String(args[1])
        state.range = null
        state.facts = null
        state.seq = null
        state.reported = false
      }
      return Reflect.apply(open, this, args) as void
    } as XhrOpen
    proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string): void {
      if (on && typeof name === 'string' && name.toLowerCase() === 'range')
        xhrState(this).range = String(value)
      return Reflect.apply(setHeader, this, [name, value]) as void
    } as XhrSetHeader
    proto.send = function (this: XMLHttpRequest, ...args: unknown[]): void {
      if (on) {
        const state = xhrStates.get(this)
        if (state && state.url !== null) {
          const url = requestUrl(state.url, baseUrl())
          if (url !== null) {
            state.facts = factsOf(url, state.method, state.range)
            state.seq = nextSeq()
            if (!state.listening) {
              state.listening = true
              this.addEventListener('readystatechange', () => {
                if (this.readyState === 2) observeXhr(this, state, 'headers')
              })
              this.addEventListener('loadend', () => observeXhr(this, state, 'complete'))
            }
          }
        }
      }
      return Reflect.apply(send, this, args) as void
    } as XhrSend
  }

  return {
    setOn(wanted: boolean): void {
      on = wanted
      if (wanted) hook()
    }
  }
}
