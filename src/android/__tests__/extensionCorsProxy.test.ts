import { describe, expect, it } from 'vitest'
import {
  CREDENTIALS_HEADER,
  MAX_BODY_BYTES,
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

/** A page window with the real fetch primitives and a recording `fetch`. */
function fakeWindow(): {
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
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const headers: Record<string, string> = {}
      request.headers.forEach((value, key) => {
        headers[key] = value
      })
      sent.push({
        url: request.url,
        method: request.method,
        headers,
        body: request.body ? await request.text() : null
      })
      return new Response('ok', { status: 200 })
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
