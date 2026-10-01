import { describe, expect, it } from 'vitest'
import {
  CREDENTIALS_HEADER,
  MAX_BODY_BYTES,
  NET_ERROR_HEADER,
  PROXY_HEADER,
  SKIP,
  base64,
  installCorsProxy,
  proxiesUrl
} from '../extensionCorsProxy'

const ORIGIN = 'https://abcdefghijklmnopabcdefghijklmnop.ext.zenium.invalid'
const PAGE = `${ORIGIN}/popup.html`

interface Sent {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
}

/** A page window with the real fetch primitives and a recording `fetch`; `answer` is what the WebView (the host) answers. */
function fakeWindow(answer: (sent: Sent) => Response = () => new Response('ok', { status: 200 })): {
  win: Window & typeof globalThis
  sent: Sent[]
  posted: Array<{ ticket: string; body: string }>
} {
  const sent: Sent[] = []
  const posted: Array<{ ticket: string; body: string }> = []
  const win = {
    location: { href: PAGE },
    Request,
    Headers,
    Response,
    URL,
    URLSearchParams,
    Blob,
    FormData,
    ArrayBuffer,
    Promise,
    TypeError,
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const headers: Record<string, string> = {}
      request.headers.forEach((value, key) => {
        headers[key] = value
      })
      const record = {
        url: request.url,
        method: request.method,
        headers,
        body: request.body ? await request.text() : null
      }
      sent.push(record)
      return answer(record)
    }
  } as unknown as Window & typeof globalThis
  let seq = 0
  installCorsProxy(win, {
    origin: ORIGIN,
    hostPermissions: ['*://*.example.com/*', 'https://api.test/v1/*'],
    postBody: (ticket, body) => posted.push({ ticket, body }),
    nextTicket: () => `ep:${++seq}`
  })
  return { win, sent, posted }
}

describe('the page side of the CORS proxy', () => {
  it('decides by scheme, origin and host permissions', () => {
    const options = { origin: ORIGIN, hostPermissions: ['*://*.example.com/*'] }
    expect(proxiesUrl('https://www.example.com/a', options)).toBe(true)
    expect(proxiesUrl('http://example.com/', options)).toBe(true)
    expect(proxiesUrl('https://example.org/', options)).toBe(false)
    expect(proxiesUrl(`${ORIGIN}/file.js`, options)).toBe(false)
    expect(proxiesUrl('data:text/plain,x', options)).toBe(false)
    expect(proxiesUrl('wss://example.com/socket', options)).toBe(false)
  })

  it('leaves GETs alone apart from the credentials mark, and untouched requests off the permissions', async () => {
    const { win, sent, posted } = fakeWindow()
    await win.fetch('https://www.example.com/image.png')
    await win.fetch('https://www.example.com/me', { credentials: 'include' })
    await win.fetch('https://other.test/', { method: 'POST', body: 'x' })
    expect(sent[0].headers[PROXY_HEADER.toLowerCase()]).toBeUndefined()
    expect(sent[0].headers[CREDENTIALS_HEADER.toLowerCase()]).toBeUndefined()
    expect(sent[1].headers[CREDENTIALS_HEADER.toLowerCase()]).toBe('include')
    expect(sent[2].body).toBe('x')
    expect(sent[2].headers[PROXY_HEADER.toLowerCase()]).toBeUndefined()
    expect(posted).toEqual([])
  })

  it('hands a POST body over under a ticket and sends the request without it, URL and headers intact', async () => {
    const { win, sent, posted } = fakeWindow()
    const response = await win.fetch('https://api.test/v1/items?x=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ a: 1 })
    })
    expect(response.status).toBe(200)
    expect(posted).toEqual([{ ticket: 'ep:1', body: btoa('{"a":1}') }])
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('https://api.test/v1/items?x=1')
    expect(sent[0].method).toBe('POST')
    expect(sent[0].body).toBeNull()
    expect(sent[0].headers['content-type']).toBe('application/json')
    expect(sent[0].headers.authorization).toBe('Bearer t')
    expect(sent[0].headers[PROXY_HEADER.toLowerCase()]).toBe('ep:1')
  })

  it('takes a Request object with a body without consuming it twice, and keeps FormData boundaries', async () => {
    const { win, sent, posted } = fakeWindow()
    const form = new FormData()
    form.append('k', 'v')
    await win.fetch(new Request('https://www.example.com/upload', { method: 'PUT', body: form }))
    expect(posted).toHaveLength(1)
    const decoded = atob(posted[0].body)
    expect(decoded).toContain('name="k"')
    expect(decoded).toContain('v')
    const boundary = sent[0].headers['content-type'].match(/boundary=(.+)$/)?.[1]
    expect(boundary).toBeTruthy()
    expect(decoded).toContain(boundary as string)
  })

  it('a body too large for the bridge stays with the request, marked for the WebView to send', async () => {
    const { win, sent, posted } = fakeWindow()
    await win.fetch('https://www.example.com/big', {
      method: 'POST',
      body: new Uint8Array(MAX_BODY_BYTES + 1)
    })
    expect(posted).toEqual([])
    expect(sent[0].headers[PROXY_HEADER.toLowerCase()]).toBe(SKIP)
    expect(sent[0].body?.length).toBe(MAX_BODY_BYTES + 1)
  })

  it('encodes bytes as standard base64 in chunks', () => {
    const bytes = new Uint8Array(70_000)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff
    expect(base64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
  })

  describe("R25-11: the host's refusal of an extension-origin request is Chrome's network error", () => {
    const refused = (code: string): Response =>
      new Response(null, { status: 404, headers: { [NET_ERROR_HEADER]: code } })
    const VIVALDI_READER =
      'chrome-extension://mpognobbkildjkofajifpdfhcoklimli/components/reader/reader.html'

    it("Black Menu's HEAD of Vivaldi's reader extension, not installed, rejects as in Chrome – and its probe reads null", async () => {
      const { win, sent } = fakeWindow(() => refused('ERR_BLOCKED_BY_CLIENT'))
      await expect(win.fetch(VIVALDI_READER, { method: 'HEAD' })).rejects.toThrow(
        new TypeError('Failed to fetch')
      )
      expect(sent).toEqual([
        expect.objectContaining({
          url: 'https://mpognobbkildjkofajifpdfhcoklimli.ext.zenium.invalid/components/reader/reader.html',
          method: 'HEAD'
        })
      ])
      const vivaldi = await win.fetch(VIVALDI_READER, { method: 'HEAD' }).then(
        () => true,
        () => null
      )
      expect(vivaldi).toBeNull()
    })

    it("the extension's own missing file (ERR_FILE_NOT_FOUND) and another's file that is not web-accessible reject too", async () => {
      const { win } = fakeWindow((request) =>
        refused(request.url.startsWith(ORIGIN) ? 'ERR_FILE_NOT_FOUND' : 'ERR_BLOCKED_BY_CLIENT')
      )
      await expect(win.fetch(`${ORIGIN}/missing.json`)).rejects.toThrow(TypeError)
      await expect(
        win.fetch('https://bcdefghijklmnopabcdefghijklmnopa.ext.zenium.invalid/private/data.json')
      ).rejects.toThrow(TypeError)
    })

    it('an extension-origin answer without the header stands, a 404 included; a web answer with the header is the web answer', async () => {
      const { win } = fakeWindow((request) =>
        request.url.startsWith('https://')
          ? request.url.includes('.ext.zenium.invalid/')
            ? new Response(null, { status: 404 })
            : new Response('web', {
                status: 200,
                headers: { [NET_ERROR_HEADER]: 'ERR_BLOCKED_BY_CLIENT' }
              })
          : new Response('ok')
      )
      const own = await win.fetch(`${ORIGIN}/gone.json`)
      expect(own.status).toBe(404)
      // Off the permissions and off any extension origin: the WebView's answer, whatever its headers say.
      const web = await win.fetch('https://example.org/x')
      expect(web.status).toBe(200)
      expect(await web.text()).toBe('web')
    })
  })
})

describe('XMLHttpRequest through the proxy', () => {
  class FakeXhr {
    static opened: Array<{ method: string; url: string }> = []
    static sent: Array<{ body: unknown; headers: Record<string, string> }> = []
    withCredentials = false
    headers: Record<string, string> = {}
    open(method: string, url: string): void {
      FakeXhr.opened.push({ method, url })
    }
    setRequestHeader(name: string, value: string): void {
      this.headers[name] = value
    }
    send(body?: unknown): void {
      FakeXhr.sent.push({ body, headers: { ...this.headers } })
    }
  }

  function xhrWindow(): {
    win: Window & typeof globalThis
    posted: Array<{ ticket: string; body: string }>
  } {
    FakeXhr.opened = []
    FakeXhr.sent = []
    const posted: Array<{ ticket: string; body: string }> = []
    const win = {
      location: { href: PAGE },
      Request,
      Headers,
      Response,
      URL,
      URLSearchParams,
      Blob,
      FormData,
      ArrayBuffer,
      Promise,
      XMLHttpRequest: FakeXhr
    } as unknown as Window & typeof globalThis
    let seq = 0
    installCorsProxy(win, {
      origin: ORIGIN,
      hostPermissions: ['https://api.test/*'],
      postBody: (ticket, body) => posted.push({ ticket, body }),
      nextTicket: () => `ep:${++seq}`
    })
    return { win, posted }
  }

  it('ticketes a string body, sets the Content-Type XHR would have, marks withCredentials', () => {
    const { win, posted } = xhrWindow()
    const xhr = new win.XMLHttpRequest()
    xhr.withCredentials = true
    xhr.open('post', '/v2/things'.replace('/v2', 'https://api.test/v2'))
    xhr.send('hello')
    expect(posted).toEqual([{ ticket: 'ep:1', body: btoa('hello') }])
    expect(FakeXhr.sent).toHaveLength(1)
    expect(FakeXhr.sent[0].body).toBeNull()
    expect(FakeXhr.sent[0].headers).toEqual({
      [CREDENTIALS_HEADER]: 'include',
      'Content-Type': 'text/plain;charset=UTF-8',
      [PROXY_HEADER]: 'ep:1'
    })
  })

  it('keeps the Content-Type the page set and resolves relative URLs against the page', () => {
    const { win, posted } = xhrWindow()
    const xhr = new win.XMLHttpRequest()
    xhr.open('POST', 'https://api.test/v1/json')
    xhr.setRequestHeader('Content-Type', 'application/json')
    xhr.send(new URLSearchParams({ a: '1' }))
    expect(posted[0].body).toBe(btoa('a=1'))
    expect(FakeXhr.sent[0].headers['Content-Type']).toBe('application/json')
    const other = new win.XMLHttpRequest()
    other.open('POST', '/relative.html')
    other.send('x')
    // Relative to the extension page: the extension origin, not proxied.
    expect(FakeXhr.sent[1].body).toBe('x')
    expect(FakeXhr.sent[1].headers[PROXY_HEADER]).toBeUndefined()
  })

  it('serialises a Blob asynchronously and sends afterwards; a GET never waits', async () => {
    const { win, posted } = xhrWindow()
    const xhr = new win.XMLHttpRequest()
    xhr.open('PUT', 'https://api.test/v1/blob')
    xhr.send(new Blob(['bytes'], { type: 'application/octet-stream' }))
    expect(FakeXhr.sent).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(posted[0].body).toBe(btoa('bytes'))
    expect(FakeXhr.sent[0].headers['Content-Type']).toBe('application/octet-stream')
    const get = new win.XMLHttpRequest()
    get.open('GET', 'https://api.test/v1/list')
    get.send()
    expect(FakeXhr.sent[1].headers[PROXY_HEADER]).toBeUndefined()
  })

  it('a synchronous XHR with a Blob is left to the WebView, marked skip', () => {
    const { win } = xhrWindow()
    const xhr = new win.XMLHttpRequest()
    xhr.open('POST', 'https://api.test/v1/sync', false)
    const blob = new Blob(['b'])
    xhr.send(blob)
    expect(FakeXhr.sent[0].body).toBe(blob)
    expect(FakeXhr.sent[0].headers[PROXY_HEADER]).toBe(SKIP)
  })
})

/*
 * R26-3, the XHR half of R25-11: the host's marked 404 of an extension-origin request reads as
 * Chrome's network error on an `XMLHttpRequest` – `readyState` 4, `status` 0, `error` and
 * `loadend`, never `load` – whichever way the handlers were registered.
 */
describe("R26-3: the host's refusal of an extension-origin XMLHttpRequest is Chrome's network error course", () => {
  type Handler = ((this: XMLHttpRequest, event: Event) => unknown) | null

  /** A native-like XHR the test drives: states, status, headers, the native's events and the `on*` handlers' registration order. */
  class DrivenXhr extends EventTarget {
    static instances: DrivenXhr[] = []
    static readonly DONE = 4
    withCredentials = false
    responseType: XMLHttpRequestResponseType = ''
    url = ''
    private state = 0
    private code = 0
    private answered: Record<string, string> = {}
    private body = ''
    private readonly handlers = new Map<string, { fn: Handler; listener: EventListener }>()
    constructor() {
      super()
      DrivenXhr.instances.push(this)
    }
    private handler(type: string, fn: Handler): void {
      let entry = this.handlers.get(type)
      if (!entry) {
        const made = {
          fn,
          listener: (event: Event) => made.fn?.call(this as unknown as XMLHttpRequest, event)
        }
        entry = made
        this.handlers.set(type, entry)
        // The attribute's listener is registered when it is first set, as the native's is.
        this.addEventListener(type, entry.listener)
      }
      entry.fn = fn
    }
    set onload(fn: Handler) {
      this.handler('load', fn)
    }
    set onerror(fn: Handler) {
      this.handler('error', fn)
    }
    set onloadend(fn: Handler) {
      this.handler('loadend', fn)
    }
    set onreadystatechange(fn: Handler) {
      this.handler('readystatechange', fn)
    }
    get readyState(): number {
      return this.state
    }
    get status(): number {
      return this.code
    }
    get statusText(): string {
      return this.code === 404 ? 'Not Found' : this.code === 200 ? 'OK' : ''
    }
    get responseURL(): string {
      return this.state >= 2 ? this.url : ''
    }
    get response(): unknown {
      return this.body
    }
    get responseText(): string {
      return this.body
    }
    get responseXML(): Document | null {
      return null
    }
    open(_method: string, url: string): void {
      this.url = String(url)
      this.state = 1
      this.code = 0
      this.answered = {}
      this.body = ''
      this.dispatchEvent(new Event('readystatechange'))
    }
    requestHeaders: Record<string, string> = {}
    setRequestHeader(name: string, value: string): void {
      this.requestHeaders[name] = value
    }
    send(): void {
      this.dispatchEvent(new Event('loadstart'))
    }
    getResponseHeader(name: string): string | null {
      return this.state >= 2 ? (this.answered[name.toLowerCase()] ?? null) : null
    }
    getAllResponseHeaders(): string {
      return Object.entries(this.answered)
        .map(([n, v]) => `${n}: ${v}\r\n`)
        .join('')
    }
    /** The answer arriving: the native's course, HEADERS_RECEIVED through DONE with its events. */
    answer(status: number, headers: Record<string, string>, body: string): void {
      this.code = status
      this.answered = Object.fromEntries(
        Object.entries(headers).map(([n, v]) => [n.toLowerCase(), v])
      )
      this.state = 2
      this.dispatchEvent(new Event('readystatechange'))
      this.state = 3
      this.body = body
      this.dispatchEvent(new Event('readystatechange'))
      this.dispatchEvent(new Event('progress'))
      this.state = 4
      this.dispatchEvent(new Event('readystatechange'))
      this.dispatchEvent(new Event('load'))
      this.dispatchEvent(new Event('loadend'))
    }
  }

  function drivenWindow(): Window & typeof globalThis {
    DrivenXhr.instances = []
    const win = {
      location: { href: PAGE },
      Request,
      Headers,
      Response,
      URL,
      URLSearchParams,
      Blob,
      FormData,
      ArrayBuffer,
      Promise,
      Event,
      XMLHttpRequest: DrivenXhr
    } as unknown as Window & typeof globalThis
    installCorsProxy(win, {
      origin: ORIGIN,
      hostPermissions: ['https://api.test/*'],
      postBody: () => undefined,
      nextTicket: () => 'ep:1'
    })
    return win
  }

  /** Every event and handler the request fires, with the state and status read at that moment. */
  function record(xhr: XMLHttpRequest, seen: string[]): void {
    xhr.onreadystatechange = () => seen.push(`rsc@${xhr.readyState}:${xhr.status}`)
    xhr.onload = () => seen.push(`load@${xhr.readyState}:${xhr.status}`)
    xhr.onerror = () => seen.push(`error@${xhr.readyState}:${xhr.status}`)
    xhr.onloadend = () => seen.push(`loadend@${xhr.readyState}`)
    xhr.addEventListener('progress', () => seen.push(`progress@${xhr.readyState}`))
  }

  it("Black Menu's HEAD of Vivaldi's reader extension by XHR: handlers set before open see 4 and 0, `error` then `loadend`, never `load` or the 404", () => {
    const win = drivenWindow()
    const xhr = new win.XMLHttpRequest()
    expect(xhr).toBeInstanceOf(DrivenXhr)
    expect(xhr).toBeInstanceOf(win.XMLHttpRequest)
    expect(win.XMLHttpRequest.name).toBe('XMLHttpRequest')
    expect(win.XMLHttpRequest.DONE).toBe(4)
    const seen: string[] = []
    record(xhr, seen)
    xhr.open(
      'HEAD',
      'chrome-extension://mpognobbkildjkofajifpdfhcoklimli/components/reader/reader.html'
    )
    xhr.send()
    const driven = DrivenXhr.instances[0]
    expect(driven.url).toBe(
      'https://mpognobbkildjkofajifpdfhcoklimli.ext.zenium.invalid/components/reader/reader.html'
    )
    driven.answer(
      404,
      { [NET_ERROR_HEADER]: 'ERR_BLOCKED_BY_CLIENT', 'Content-Type': 'text/plain' },
      'Not found'
    )
    expect(seen).toEqual(['rsc@1:0', 'rsc@4:0', 'error@4:0', 'loadend@4'])
    expect(xhr.readyState).toBe(4)
    expect(xhr.status).toBe(0)
    expect(xhr.statusText).toBe('')
    expect(xhr.responseURL).toBe('')
    expect(xhr.response).toBe('')
    expect(xhr.responseText).toBe('')
    expect(xhr.responseXML).toBeNull()
    expect(xhr.getResponseHeader('Content-Type')).toBeNull()
    expect(xhr.getAllResponseHeaders()).toBe('')
    xhr.responseType = 'json'
    expect(xhr.response).toBeNull()
  })

  it("an extension-origin 404 without the mark, and a web answer with it, run the native's course as they are", () => {
    const win = drivenWindow()
    const own = new win.XMLHttpRequest()
    const ownSeen: string[] = []
    record(own, ownSeen)
    own.open('GET', `${ORIGIN}/missing.json`)
    own.send()
    DrivenXhr.instances[0].answer(404, { 'Content-Type': 'text/plain' }, 'not found')
    expect(ownSeen).toEqual([
      'rsc@1:0',
      'rsc@2:404',
      'rsc@3:404',
      'progress@3',
      'rsc@4:404',
      'load@4:404',
      'loadend@4'
    ])
    expect(own.status).toBe(404)
    expect(own.statusText).toBe('Not Found')
    expect(own.responseText).toBe('not found')
    expect(own.getResponseHeader('content-type')).toBe('text/plain')

    const web = new win.XMLHttpRequest()
    const webSeen: string[] = []
    record(web, webSeen)
    web.open('GET', 'https://api.test/v1/x')
    web.send()
    DrivenXhr.instances[1].answer(404, { [NET_ERROR_HEADER]: 'ERR_FILE_NOT_FOUND' }, 'web')
    expect(webSeen.at(-2)).toBe('load@4:404')
    expect(web.status).toBe(404)
    expect(web.getResponseHeader(NET_ERROR_HEADER)).toBe('ERR_FILE_NOT_FOUND')
  })

  it('a second open() on a refused request starts over on the native', () => {
    const win = drivenWindow()
    const xhr = new win.XMLHttpRequest()
    xhr.open('GET', `${ORIGIN}/a.json`)
    xhr.send()
    DrivenXhr.instances[0].answer(404, { [NET_ERROR_HEADER]: 'ERR_FILE_NOT_FOUND' }, '')
    expect(xhr.status).toBe(0)
    const seen: string[] = []
    record(xhr, seen)
    xhr.open('GET', `${ORIGIN}/b.json`)
    xhr.send()
    DrivenXhr.instances[0].answer(200, { 'Content-Type': 'application/json' }, '{}')
    expect(seen.at(-2)).toBe('load@4:200')
    expect(xhr.status).toBe(200)
    expect(xhr.responseText).toBe('{}')
  })
})
