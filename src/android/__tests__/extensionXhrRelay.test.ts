// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { extensionOrigin } from '@core/extensions/runtime/plan'
import { createXhrRelay, type XhrRelayHost } from '../extensionXhrRelay'

/*
 * A content script's `XMLHttpRequest` of its own extension's file (compat round 25, R25-2):
 * the request never reaches the page's network stack – the relay's `fetch`, which the host
 * answers over the bridge, is played back as the XHR's states and events. Any other request,
 * and a synchronous one, is the realm's native XHR's.
 */

const EXT = 'adbacgifemdbhdkfppmeilbgppmhaobf'
const RULES = `${extensionOrigin(EXT)}/data/rules.json`
const win = window as Window & typeof globalThis

interface Harness {
  Xhr: typeof XMLHttpRequest
  fetches: Array<{ url: string; init: RequestInit }>
  answer: { current: () => Promise<Response> }
}

function harness(): Harness {
  const fetches: Array<{ url: string; init: RequestInit }> = []
  const answer = {
    current: (): Promise<Response> =>
      Promise.resolve(
        Object.defineProperty(
          new win.Response('{"rules":[1,2,3]}', {
            status: 200,
            statusText: 'OK',
            headers: { 'Content-Type': 'application/json', 'Content-Length': '17' }
          }),
          'url',
          { value: RULES }
        )
      )
  }
  const host: XhrRelayHost = {
    owns: (url) => url.startsWith(extensionOrigin(EXT) + '/'),
    fetch: (url, init) => {
      fetches.push({ url, init })
      return answer.current()
    }
  }
  const Xhr = createXhrRelay(win, host)
  if (!Xhr) throw new Error('the realm has an XMLHttpRequest')
  return { Xhr, fetches, answer }
}

/** The events an XHR fires, in order, with the states they were fired at. */
function record(xhr: XMLHttpRequest): string[] {
  const seen: string[] = []
  for (const type of [
    'readystatechange',
    'loadstart',
    'progress',
    'load',
    'loadend',
    'error',
    'abort',
    'timeout'
  ]) {
    xhr.addEventListener(type, () => seen.push(`${type}@${xhr.readyState}`))
  }
  return seen
}

const settled = (xhr: XMLHttpRequest): Promise<void> =>
  new Promise((resolve) => xhr.addEventListener('loadend', () => resolve(), { once: true }))

describe("createXhrRelay: a content script's XMLHttpRequest of its extension's own file", () => {
  it('is a subclass of the realm’s XMLHttpRequest, the same to instanceof, with the native statics', () => {
    const { Xhr } = harness()
    const xhr = new Xhr()
    expect(xhr).toBeInstanceOf(win.XMLHttpRequest)
    expect(xhr).toBeInstanceOf(Xhr)
    expect(Object.getPrototypeOf(Xhr.prototype)).toBe(win.XMLHttpRequest.prototype)
    expect(xhr.readyState).toBe(0)
    expect(Xhr.DONE).toBe(4)
  })

  it("plays the host's answer back as the states, events and fields Chrome's same-origin answer has", async () => {
    const { Xhr, fetches } = harness()
    const xhr = new Xhr()
    const seen = record(xhr)
    const onload = vi.fn()
    xhr.onload = onload
    xhr.open('GET', RULES)
    expect(xhr.readyState).toBe(1)
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest')
    xhr.send()
    expect(fetches).toEqual([{ url: RULES, init: { method: 'GET' } }])
    await settled(xhr)
    expect(xhr.readyState).toBe(4)
    expect(xhr.status).toBe(200)
    expect(xhr.statusText).toBe('OK')
    expect(xhr.responseURL).toBe(RULES)
    expect(xhr.responseText).toBe('{"rules":[1,2,3]}')
    expect(xhr.response).toBe('{"rules":[1,2,3]}')
    expect(xhr.getResponseHeader('Content-Type')).toBe('application/json')
    expect(xhr.getResponseHeader('content-length')).toBe('17')
    expect(xhr.getResponseHeader('x-none')).toBeNull()
    expect(xhr.getAllResponseHeaders()).toBe(
      'content-type: application/json\r\ncontent-length: 17\r\n'
    )
    expect(xhr.responseXML).toBeNull()
    expect(onload).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([
      'readystatechange@1',
      'loadstart@1',
      'readystatechange@2',
      'readystatechange@3',
      'progress@3',
      'readystatechange@4',
      'load@4',
      'loadend@4'
    ])
  })

  it("answers in the responseType asked: json, arraybuffer, blob, document; responseText refuses when it is not text", async () => {
    const { Xhr, answer } = harness()
    const asJson = new Xhr()
    asJson.open('GET', RULES)
    asJson.responseType = 'json'
    asJson.send()
    await settled(asJson)
    expect(asJson.response).toEqual({ rules: [1, 2, 3] })
    expect(() => asJson.responseText).toThrow(/responseType/)

    const asBuffer = new Xhr()
    asBuffer.open('GET', `${extensionOrigin(EXT)}/data/rules.json?v=2`)
    asBuffer.responseType = 'arraybuffer'
    asBuffer.send()
    await settled(asBuffer)
    const buffer = asBuffer.response as ArrayBuffer
    expect(buffer).toBeInstanceOf(ArrayBuffer)
    expect(new TextDecoder().decode(buffer)).toBe('{"rules":[1,2,3]}')

    const asBlob = new Xhr()
    asBlob.open('GET', RULES)
    asBlob.responseType = 'blob'
    asBlob.send()
    await settled(asBlob)
    const blob = asBlob.response as Blob
    expect(blob).toBeInstanceOf(win.Blob)
    expect(blob.type).toBe('application/json')
    expect(blob.size).toBe(17)

    answer.current = () =>
      Promise.resolve(
        new win.Response('<root><a>1</a></root>', {
          status: 200,
          headers: { 'Content-Type': 'application/xml' }
        })
      )
    const asXml = new Xhr()
    asXml.open('GET', `${extensionOrigin(EXT)}/data/tree.xml`)
    asXml.send()
    await settled(asXml)
    expect(asXml.responseXML?.documentElement?.tagName).toBe('root')
    expect(asXml.response).toBe('<root><a>1</a></root>')

    const asDocument = new Xhr()
    asDocument.open('GET', `${extensionOrigin(EXT)}/data/tree.xml`)
    asDocument.responseType = 'document'
    asDocument.send()
    await settled(asDocument)
    expect((asDocument.response as Document).documentElement?.tagName).toBe('root')
    expect(asDocument.responseXML?.documentElement?.tagName).toBe('root')
    expect(() => asDocument.responseText).toThrow(/responseType/)
  })

  it("plays the page's failure back as an error: readyState DONE, status 0, `error` then `loadend`", async () => {
    const { Xhr, answer } = harness()
    answer.current = () => Promise.reject(new TypeError('Failed to fetch'))
    const xhr = new Xhr()
    const seen = record(xhr)
    const onerror = vi.fn()
    xhr.onerror = onerror
    xhr.open('GET', RULES)
    xhr.send()
    await settled(xhr)
    expect(xhr.readyState).toBe(4)
    expect(xhr.status).toBe(0)
    expect(xhr.responseText).toBe('')
    expect(onerror).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([
      'readystatechange@1',
      'loadstart@1',
      'readystatechange@4',
      'error@4',
      'loadend@4'
    ])
  })

  it("the page's own 404 answer (the fallback for a file that is not web-accessible) comes through as a 404", async () => {
    const { Xhr, answer } = harness()
    answer.current = () =>
      Promise.resolve(new win.Response('not found', { status: 404, statusText: 'Not Found' }))
    const xhr = new Xhr()
    xhr.open('GET', `${extensionOrigin(EXT)}/js/secret.js`)
    xhr.send()
    await settled(xhr)
    expect(xhr.status).toBe(404)
    expect(xhr.statusText).toBe('Not Found')
    expect(xhr.responseText).toBe('not found')
  })

  it('abort() drops the request: DONE, `abort`, `loadend`, then UNSENT, and a late answer is ignored', async () => {
    const { Xhr, answer } = harness()
    let release: (r: Response) => void = () => undefined
    answer.current = () => new Promise<Response>((resolve) => (release = resolve))
    const xhr = new Xhr()
    const seen = record(xhr)
    xhr.open('GET', RULES)
    xhr.send()
    xhr.abort()
    expect(xhr.readyState).toBe(0)
    expect(xhr.status).toBe(0)
    expect(seen).toEqual(['readystatechange@1', 'loadstart@1', 'readystatechange@4', 'abort@4', 'loadend@4'])
    release(new win.Response('late'))
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(xhr.readyState).toBe(0)
    expect(seen).toHaveLength(5)
  })

  it('a timeout the extension set fires `timeout` when the answer is late, and is cleared by an answer in time', async () => {
    vi.useFakeTimers()
    try {
      const { Xhr, answer } = harness()
      answer.current = () => new Promise<Response>(() => undefined)
      const xhr = new Xhr()
      const seen = record(xhr)
      const ontimeout = vi.fn()
      xhr.ontimeout = ontimeout
      xhr.open('GET', RULES)
      xhr.timeout = 50
      xhr.send()
      vi.advanceTimersByTime(49)
      expect(ontimeout).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(ontimeout).toHaveBeenCalledTimes(1)
      expect(xhr.readyState).toBe(4)
      expect(xhr.status).toBe(0)
      expect(seen.slice(-3)).toEqual(['readystatechange@4', 'timeout@4', 'loadend@4'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses send() and setRequestHeader() out of the OPENED state, as the native does', async () => {
    const { Xhr } = harness()
    const xhr = new Xhr()
    expect(() => xhr.send()).toThrow()
    xhr.open('GET', RULES)
    xhr.send()
    expect(() => xhr.send()).toThrow(/OPENED/)
    expect(() => xhr.setRequestHeader('A', 'b')).toThrow(/OPENED/)
    await settled(xhr)
  })

  it("leaves another URL, an unattached extension's, and a synchronous request to the native XMLHttpRequest", () => {
    const { Xhr, fetches } = harness()
    const nativeOpen = vi.spyOn(win.XMLHttpRequest.prototype, 'open')
    const nativeSend = vi.spyOn(win.XMLHttpRequest.prototype, 'send').mockImplementation(() => undefined)
    try {
      const other = new Xhr()
      other.open('GET', 'https://api.example.com/x')
      other.send()
      expect(nativeOpen).toHaveBeenCalledWith('GET', 'https://api.example.com/x')
      expect(nativeSend).toHaveBeenCalledTimes(1)

      const unattached = new Xhr()
      unattached.open('GET', `${extensionOrigin('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')}/x.json`)
      expect(nativeOpen).toHaveBeenCalledTimes(2)

      const sync = new Xhr()
      sync.open('GET', RULES, false)
      expect(nativeOpen).toHaveBeenLastCalledWith('GET', RULES, false, undefined, undefined)
      expect(fetches).toHaveLength(0)
    } finally {
      nativeOpen.mockRestore()
      nativeSend.mockRestore()
    }
  })

  it("resolves a relative URL against the page and maps Chrome's spelling of the extension's own file before asking", () => {
    const owns = vi.fn((url: string) => url.startsWith(extensionOrigin(EXT) + '/'))
    const Xhr = createXhrRelay(win, { owns, fetch: () => new Promise(() => undefined) })
    if (!Xhr) throw new Error('the realm has an XMLHttpRequest')
    const xhr = new Xhr()
    xhr.open('GET', `chrome-extension://${EXT}/data/rules.json`)
    expect(owns).toHaveBeenCalledWith(`chrome-extension://${EXT}/data/rules.json`)
    const relative = new Xhr()
    const nativeOpen = vi.spyOn(win.XMLHttpRequest.prototype, 'open')
    try {
      relative.open('GET', '/games/1')
      expect(owns).toHaveBeenLastCalledWith(new URL('/games/1', win.location.href).href)
      expect(nativeOpen).toHaveBeenCalledTimes(1)
    } finally {
      nativeOpen.mockRestore()
    }
  })

  it('a second open() on a relayed request drops it and starts over', async () => {
    const { Xhr, fetches } = harness()
    const xhr = new Xhr()
    xhr.open('GET', RULES)
    xhr.open('GET', `${extensionOrigin(EXT)}/data/other.json`)
    xhr.send()
    expect(fetches.map((f) => f.url)).toEqual([`${extensionOrigin(EXT)}/data/other.json`])
    await settled(xhr)
    expect(xhr.status).toBe(200)
  })
})
