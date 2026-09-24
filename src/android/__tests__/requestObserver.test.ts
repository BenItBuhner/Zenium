import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  installRequestObserver,
  scriptObservation,
  type RequestObservation
} from '../requestObserver'

/**
 * The page script's fetch / XHR observer (`requestObserver.ts`, blocking-rule-interface.md 7.10)
 * over a fake window: Node's own `Response`, `Headers` and `ReadableStream` stand for the page's,
 * a small `XMLHttpRequest` stands for the engine's. What is pinned: the hooks are laid on the
 * first word alone and pass through while the word is off; the facts as the intercept saw them
 * (absolute URL without a fragment, upper-case method, the `Range` the page set, the origin
 * test); a `headers` report at the response and a `complete` report when – and only when – the
 * page reads the body to its end, once; an opaque response unreported; a redirected fetch under
 * the request's URL with `finalUrl`; `scriptObservation` as the runtime's gate.
 */

const PAGE = 'https://page.example/watch/index.html'
const PAGE_ORIGIN = 'https://page.example'

type Route = () => Response

class FakeXhr {
  static routes = new Map<
    string,
    { status: number; statusText: string; headers: string; responseURL?: string }
  >()
  static opened: Array<[string, string]> = []
  static sent = 0

  readyState = 0
  status = 0
  statusText = ''
  responseURL = ''
  private url = ''
  private allHeaders = ''
  private readonly listeners = new Map<string, Array<() => void>>()

  open(method: string, url: string): void {
    this.url = url
    this.readyState = 1
    FakeXhr.opened.push([method, url])
  }

  setRequestHeader(): void {
    /* the fake sends nothing */
  }

  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  getAllResponseHeaders(): string {
    return this.allHeaders
  }

  send(): void {
    FakeXhr.sent += 1
    const route = FakeXhr.routes.get(this.url)
    if (!route) {
      this.status = 0
      this.readyState = 4
      this.fire('readystatechange')
      this.fire('loadend')
      return
    }
    this.status = route.status
    this.statusText = route.statusText
    this.allHeaders = route.headers
    // A browser's `responseURL` carries no fragment.
    const resolved = new URL(this.url, PAGE)
    resolved.hash = ''
    this.responseURL = route.responseURL ?? resolved.href
    this.readyState = 2
    this.fire('readystatechange')
    this.readyState = 4
    this.fire('readystatechange')
    this.fire('loadend')
  }

  private fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn()
  }
}

interface Harness {
  w: Window & typeof globalThis
  sent: RequestObservation[]
  routes: Map<string, Route>
  nativeFetch: Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>
  observer: ReturnType<typeof installRequestObserver>
}

function harness(): Harness {
  const routes = new Map<string, Route>()
  const nativeFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    // The network layer's view of the URL: absolute, without a fragment.
    const key = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      PAGE
    )
    key.hash = ''
    const route = routes.get(key.href)
    if (!route) throw new TypeError(`Failed to fetch ${key}`)
    return route()
  })
  const w = {
    location: { origin: PAGE_ORIGIN, href: PAGE },
    document: { baseURI: PAGE },
    fetch: nativeFetch,
    XMLHttpRequest: FakeXhr
  } as unknown as Window & typeof globalThis
  const sent: RequestObservation[] = []
  const observer = installRequestObserver(w, {
    send: (observation) => {
      sent.push(observation)
    }
  })
  return { w, sent, routes, nativeFetch, observer }
}

function okResponse(
  body: string | null,
  headers: Record<string, string> = {},
  status = 200
): Route {
  return () => new Response(body, { status, statusText: status === 200 ? 'OK' : '', headers })
}

async function drain(response: Response): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) return
  for (;;) {
    const { done } = await reader.read()
    if (done) return
  }
}

beforeEach(() => {
  FakeXhr.routes.clear()
  FakeXhr.opened = []
  FakeXhr.sent = 0
})

describe('scriptObservation: the runtime gate on a page message', () => {
  const well: RequestObservation = {
    type: 'ext-observation',
    seq: 'a1b2c3-1',
    url: 'https://cdn.example/segment-1.m4s',
    method: 'GET',
    range: 'bytes=0-',
    crossOrigin: true,
    status: 206,
    statusText: 'Partial Content',
    headers: [{ name: 'content-type', value: 'video/mp4' }],
    at: 'headers'
  }

  it('copies a well-formed observation and nothing else', () => {
    const copy = scriptObservation({
      ...well,
      extra: 1,
      headers: [{ name: 'content-type', value: 'video/mp4', x: 2 }]
    })
    expect(copy).toEqual(well)
    expect(copy).not.toBe(well)
    expect(scriptObservation({ ...well, range: null, at: 'complete' })).toMatchObject({
      range: null,
      at: 'complete'
    })
  })

  it('keeps finalUrl only when it differs from the URL', () => {
    expect(scriptObservation({ ...well, finalUrl: well.url })).not.toHaveProperty('finalUrl')
    expect(scriptObservation({ ...well, finalUrl: 'https://cdn.example/final.m4s' })).toMatchObject(
      {
        finalUrl: 'https://cdn.example/final.m4s'
      }
    )
    expect(scriptObservation({ ...well, finalUrl: 5 })).toBeNull()
  })

  it('drops anything malformed', () => {
    expect(scriptObservation(null)).toBeNull()
    expect(scriptObservation('ext-observation')).toBeNull()
    expect(scriptObservation({ ...well, type: 'capture-state' })).toBeNull()
    expect(scriptObservation({ ...well, seq: '' })).toBeNull()
    expect(scriptObservation({ ...well, url: 'blob:https://page.example/x' })).toBeNull()
    expect(scriptObservation({ ...well, url: 'ftp://cdn.example/x' })).toBeNull()
    expect(scriptObservation({ ...well, method: '' })).toBeNull()
    expect(scriptObservation({ ...well, range: 7 })).toBeNull()
    expect(scriptObservation({ ...well, crossOrigin: 'yes' })).toBeNull()
    expect(scriptObservation({ ...well, status: 0 })).toBeNull()
    expect(scriptObservation({ ...well, status: 200.5 })).toBeNull()
    expect(scriptObservation({ ...well, status: 1000 })).toBeNull()
    expect(scriptObservation({ ...well, statusText: null })).toBeNull()
    expect(scriptObservation({ ...well, headers: 'content-type: video/mp4' })).toBeNull()
    expect(scriptObservation({ ...well, headers: [{ name: 'x' }] })).toBeNull()
    expect(scriptObservation({ ...well, headers: [null] })).toBeNull()
    expect(scriptObservation({ ...well, at: 'redirect' })).toBeNull()
  })
})

describe('the hooks: laid on the first word, standing after it, passing through while off', () => {
  it('touches nothing before the first word', () => {
    const { w, nativeFetch } = harness()
    expect(w.fetch).toBe(nativeFetch)
    expect(FakeXhr.prototype.open.toString()).toContain('FakeXhr.opened.push')
  })

  it('wraps fetch and XHR on the word, keeps the wrappers when the word goes off and reports nothing then', async () => {
    const { w, sent, routes, nativeFetch, observer } = harness()
    const nativeOpen = FakeXhr.prototype.open
    observer.setOn(true)
    expect(w.fetch).not.toBe(nativeFetch)
    expect(FakeXhr.prototype.open).not.toBe(nativeOpen)
    const wrappedFetch = w.fetch
    observer.setOn(false)
    expect(w.fetch).toBe(wrappedFetch)

    routes.set(
      'https://page.example/watch/list.json',
      okResponse('[]', { 'content-type': 'application/json' })
    )
    const response = await w.fetch('list.json', { headers: { Range: 'bytes=0-' } })
    expect(nativeFetch).toHaveBeenCalledWith('list.json', { headers: { Range: 'bytes=0-' } })
    expect(await response.json()).toEqual([])
    FakeXhr.routes.set('/api', { status: 200, statusText: 'OK', headers: 'X-A: 1\r\n' })
    const xhr = new w.XMLHttpRequest()
    xhr.open('GET', '/api')
    xhr.send()
    expect(FakeXhr.opened).toEqual([['GET', '/api']])
    expect(FakeXhr.sent).toBe(1)
    expect(sent).toEqual([])
    // Restore the prototype for the suites that follow: the observer never unhooks by design.
    FakeXhr.prototype.open = nativeOpen
  })
})

describe('fetch: the facts as the intercept saw them', () => {
  it('resolves a relative URL against the document, strips the fragment, upper-cases the method and reads the Range', async () => {
    const { w, sent, routes, observer } = harness()
    observer.setOn(true)
    routes.set(
      'https://page.example/watch/clip.mp4',
      okResponse('mp4', { 'content-type': 'video/mp4' }, 206)
    )
    await w.fetch('clip.mp4#t=5', { method: 'get', headers: [['range', 'bytes=0-1023']] })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'ext-observation',
      url: 'https://page.example/watch/clip.mp4',
      method: 'GET',
      range: 'bytes=0-1023',
      crossOrigin: false,
      status: 206,
      at: 'headers',
      headers: [{ name: 'content-type', value: 'video/mp4' }]
    })
    expect(sent[0]).not.toHaveProperty('finalUrl')
  })

  it('takes the facts of a URL object and of a Request, the init overriding the Request as fetch does', async () => {
    const { w, sent, routes, observer } = harness()
    observer.setOn(true)
    routes.set('https://cdn.example/seg-1.m4s', okResponse('a'))
    routes.set('https://cdn.example/seg-2.m4s', okResponse('b'))
    routes.set('https://cdn.example/seg-3.m4s', okResponse('c'))
    await w.fetch(new URL('https://cdn.example/seg-1.m4s'))
    await w.fetch(
      new Request('https://cdn.example/seg-2.m4s', {
        method: 'post',
        headers: { Range: 'bytes=0-99' }
      })
    )
    await w.fetch(
      new Request('https://cdn.example/seg-3.m4s', { headers: { Range: 'bytes=0-' } }),
      {
        method: 'HEAD',
        headers: {}
      }
    )
    expect(sent.map((o) => [o.url, o.method, o.range, o.crossOrigin])).toEqual([
      ['https://cdn.example/seg-1.m4s', 'GET', null, true],
      ['https://cdn.example/seg-2.m4s', 'POST', 'bytes=0-99', true],
      ['https://cdn.example/seg-3.m4s', 'HEAD', null, true]
    ])
  })

  it('observes no data: or blob: URL, and lets a rejected fetch reject as it did', async () => {
    const { w, sent, nativeFetch, observer } = harness()
    observer.setOn(true)
    nativeFetch.mockResolvedValueOnce(new Response('hi'))
    await w.fetch('data:text/plain,hi')
    nativeFetch.mockResolvedValueOnce(new Response('blob'))
    await w.fetch('blob:https://page.example/1234')
    await expect(w.fetch('https://cdn.example/missing')).rejects.toThrow('Failed to fetch')
    expect(sent).toEqual([])
    expect(nativeFetch).toHaveBeenCalledTimes(3)
  })
})

describe('fetch: the two reports of a response', () => {
  it('reports headers at the response and complete once when the page reads the body, under one seq', async () => {
    const { w, sent, routes, observer } = harness()
    observer.setOn(true)
    routes.set(
      'https://cdn.example/seg.m4s',
      okResponse('segment', { 'content-type': 'video/iso.segment' })
    )
    const response = await w.fetch('https://cdn.example/seg.m4s')
    expect(sent.map((o) => o.at)).toEqual(['headers'])
    expect(await response.text()).toBe('segment')
    expect(sent.map((o) => o.at)).toEqual(['headers', 'complete'])
    expect(sent[1]).toMatchObject({
      seq: sent[0].seq,
      url: 'https://cdn.example/seg.m4s',
      status: 200,
      statusText: 'OK',
      headers: [{ name: 'content-type', value: 'video/iso.segment' }]
    })
  })

  it('hears the end of a body read through a reader, once', async () => {
    const { w, sent, routes, observer } = harness()
    observer.setOn(true)
    routes.set('https://cdn.example/seg.m4s', okResponse('x'.repeat(4096)))
    const response = await w.fetch('https://cdn.example/seg.m4s')
    await drain(response)
    expect(sent.map((o) => o.at)).toEqual(['headers', 'complete'])
  })

  it('reports a bodiless response complete at once and an unread body never', async () => {
    const { w, sent, routes, observer } = harness()
    observer.setOn(true)
    routes.set('https://cdn.example/probe', okResponse(null, {}, 204))
    routes.set('https://cdn.example/unread', okResponse('never read'))
    await w.fetch('https://cdn.example/probe')
    expect(sent.map((o) => [o.at, o.status])).toEqual([
      ['headers', 204],
      ['complete', 204]
    ])
    await w.fetch('https://cdn.example/unread')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(sent.map((o) => [o.at, o.status])).toEqual([
      ['headers', 204],
      ['complete', 204],
      ['headers', 200]
    ])
  })

  it('gives every request its own seq, and no complete once the word went off in between', async () => {
    const { w, sent, routes, observer } = harness()
    observer.setOn(true)
    routes.set('https://cdn.example/a', okResponse('a'))
    routes.set('https://cdn.example/b', okResponse('b'))
    const a = await w.fetch('https://cdn.example/a')
    const b = await w.fetch('https://cdn.example/b')
    expect(sent).toHaveLength(2)
    expect(sent[0].seq).not.toBe(sent[1].seq)
    await a.text()
    observer.setOn(false)
    await b.text()
    expect(sent.map((o) => [o.at, o.url])).toEqual([
      ['headers', 'https://cdn.example/a'],
      ['headers', 'https://cdn.example/b'],
      ['complete', 'https://cdn.example/a']
    ])
  })

  it('reports nothing of an opaque response', async () => {
    const { w, sent, routes, observer } = harness()
    observer.setOn(true)
    routes.set('https://cdn.example/opaque.mp4', () => Response.error())
    const response = await w.fetch('https://cdn.example/opaque.mp4', { mode: 'no-cors' })
    expect(response.status).toBe(0)
    expect(sent).toEqual([])
  })

  it('reports a redirected fetch under the request URL with the final one beside it', async () => {
    class Redirected extends Response {
      override get redirected(): boolean {
        return true
      }
      override get url(): string {
        return 'https://cdn.example/final/clip.mp4'
      }
    }
    const { w, sent, routes, observer } = harness()
    observer.setOn(true)
    routes.set(
      'https://cdn.example/clip.mp4',
      () => new Redirected('mp4', { status: 200, statusText: 'OK' })
    )
    const response = await w.fetch('https://cdn.example/clip.mp4')
    await response.arrayBuffer()
    expect(sent.map((o) => [o.at, o.url, o.finalUrl])).toEqual([
      ['headers', 'https://cdn.example/clip.mp4', 'https://cdn.example/final/clip.mp4'],
      ['complete', 'https://cdn.example/clip.mp4', 'https://cdn.example/final/clip.mp4']
    ])
  })

  it('survives a transport that throws: the page keeps its response', async () => {
    const routes = new Map<string, Route>()
    routes.set('https://cdn.example/a', okResponse('a'))
    const w = {
      location: { origin: PAGE_ORIGIN, href: PAGE },
      document: { baseURI: PAGE },
      fetch: async (): Promise<Response> => routes.get('https://cdn.example/a')!(),
      XMLHttpRequest: FakeXhr
    } as unknown as Window & typeof globalThis
    const observer = installRequestObserver(w, {
      send: () => {
        throw new Error('bridge gone')
      }
    })
    observer.setOn(true)
    const response = await w.fetch('https://cdn.example/a')
    expect(await response.text()).toBe('a')
  })
})

describe('XMLHttpRequest: the two reports', () => {
  it('reports headers at readyState 2 and complete at loadend, the Range and the method as set', () => {
    const { w, sent, observer } = harness()
    const nativeOpen = FakeXhr.prototype.open
    observer.setOn(true)
    FakeXhr.routes.set('../api/list?page=2#top', {
      status: 200,
      statusText: 'OK',
      headers: 'Content-Type: application/json\r\nX-Total: 3\r\n'
    })
    const xhr = new w.XMLHttpRequest()
    xhr.open('get', '../api/list?page=2#top')
    xhr.setRequestHeader('Range', 'bytes=0-')
    xhr.send()
    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatchObject({
      type: 'ext-observation',
      url: 'https://page.example/api/list?page=2',
      method: 'GET',
      range: 'bytes=0-',
      crossOrigin: false,
      status: 200,
      statusText: 'OK',
      headers: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'X-Total', value: '3' }
      ],
      at: 'headers'
    })
    expect(sent[1]).toMatchObject({ at: 'complete', seq: sent[0].seq })
    expect(sent[0]).not.toHaveProperty('finalUrl')
    FakeXhr.prototype.open = nativeOpen
  })

  it('reports nothing of a failed request, a redirect with its final URL, and a reused object under a new seq', () => {
    const { w, sent, observer } = harness()
    const nativeOpen = FakeXhr.prototype.open
    observer.setOn(true)
    const xhr = new w.XMLHttpRequest()
    xhr.open('GET', 'https://cdn.example/down')
    xhr.send()
    expect(sent).toEqual([])
    FakeXhr.routes.set('https://cdn.example/moved.mp4', {
      status: 206,
      statusText: 'Partial Content',
      headers: 'Content-Range: bytes 0-1/2\r\n',
      responseURL: 'https://cdn.example/here.mp4'
    })
    xhr.open('GET', 'https://cdn.example/moved.mp4')
    xhr.setRequestHeader('range', 'bytes=0-1')
    xhr.send()
    expect(sent.map((o) => [o.at, o.url, o.finalUrl, o.range, o.crossOrigin])).toEqual([
      [
        'headers',
        'https://cdn.example/moved.mp4',
        'https://cdn.example/here.mp4',
        'bytes=0-1',
        true
      ],
      [
        'complete',
        'https://cdn.example/moved.mp4',
        'https://cdn.example/here.mp4',
        'bytes=0-1',
        true
      ]
    ])
    FakeXhr.routes.set('https://cdn.example/next.mp4', {
      status: 200,
      statusText: 'OK',
      headers: ''
    })
    xhr.open('GET', 'https://cdn.example/next.mp4')
    xhr.send()
    expect(sent).toHaveLength(4)
    expect(sent[2]).toMatchObject({ url: 'https://cdn.example/next.mp4', range: null, headers: [] })
    expect(sent[2].seq).not.toBe(sent[0].seq)
    FakeXhr.prototype.open = nativeOpen
  })
})
