import { describe, expect, it } from 'vitest'
import type { Session } from 'electron'
import {
  WebRequestMultiplexer,
  applyRequestHeaderOps,
  applyResponseHeaderOps,
  contextFor,
  type BeforeRequestDetails,
  type BeforeSendHeadersDetails,
  type HeadersReceivedDetails,
  type RequestHandler
} from '../webRequest'

type BeforeRequestListener = (
  details: BeforeRequestDetails,
  callback: (r: Electron.CallbackResponse) => void
) => void
type BeforeSendHeadersListener = (
  details: BeforeSendHeadersDetails,
  callback: (r: Electron.BeforeSendResponse) => void
) => void
type HeadersReceivedListener = (
  details: HeadersReceivedDetails,
  callback: (r: Electron.HeadersReceivedResponse) => void
) => void
type CompletedListener = (details: { id: number }) => void

/** A `Session` that records the listeners installed on its `webRequest`. */
class FakeSession {
  listeners: {
    onBeforeRequest: BeforeRequestListener[]
    onBeforeSendHeaders: BeforeSendHeadersListener[]
    onHeadersReceived: HeadersReceivedListener[]
    onCompleted: CompletedListener[]
    onErrorOccurred: CompletedListener[]
  } = {
    onBeforeRequest: [],
    onBeforeSendHeaders: [],
    onHeadersReceived: [],
    onCompleted: [],
    onErrorOccurred: []
  }

  webRequest = {
    onBeforeRequest: (l: BeforeRequestListener) => this.listeners.onBeforeRequest.push(l),
    onBeforeSendHeaders: (l: BeforeSendHeadersListener) =>
      this.listeners.onBeforeSendHeaders.push(l),
    onHeadersReceived: (l: HeadersReceivedListener) => this.listeners.onHeadersReceived.push(l),
    onCompleted: (l: CompletedListener) => this.listeners.onCompleted.push(l),
    onErrorOccurred: (l: CompletedListener) => this.listeners.onErrorOccurred.push(l)
  }

  asSession(): Session {
    return this as unknown as Session
  }

  beforeRequest(details: Partial<BeforeRequestDetails>): Electron.CallbackResponse {
    let out: Electron.CallbackResponse = {}
    this.listeners.onBeforeRequest[0](fakeDetails(details) as BeforeRequestDetails, (r) => {
      out = r
    })
    return out
  }

  beforeSendHeaders(details: Partial<BeforeSendHeadersDetails>): Electron.BeforeSendResponse {
    let out: Electron.BeforeSendResponse = {}
    this.listeners.onBeforeSendHeaders[0](fakeDetails(details) as BeforeSendHeadersDetails, (r) => {
      out = r
    })
    return out
  }

  headersReceived(details: Partial<HeadersReceivedDetails>): Electron.HeadersReceivedResponse {
    let out: Electron.HeadersReceivedResponse = {}
    this.listeners.onHeadersReceived[0](fakeDetails(details) as HeadersReceivedDetails, (r) => {
      out = r
    })
    return out
  }
}

let nextId = 1
function fakeDetails<T extends { id: number }>(details: Partial<T>): Partial<T> {
  return {
    id: nextId++,
    url: 'https://site.example/',
    method: 'GET',
    resourceType: 'script',
    referrer: '',
    timestamp: 0,
    ...details
  } as Partial<T>
}

function fakeWebContents(url: string, destroyed = false): Electron.WebContents {
  return { isDestroyed: () => destroyed, getURL: () => url } as unknown as Electron.WebContents
}

const views = {
  tabIdForWebContents: (wc: Electron.WebContents) =>
    wc.getURL() ? `tab-${wc.getURL().length}` : undefined
}

describe('WebRequestMultiplexer', () => {
  it('installs exactly one listener per event per session', () => {
    const mux = new WebRequestMultiplexer(views)
    const ses = new FakeSession()
    mux.attach(ses.asSession(), 'default')
    mux.attach(ses.asSession(), 'default')
    expect(ses.listeners.onBeforeRequest.length).toBe(1)
    expect(ses.listeners.onBeforeSendHeaders.length).toBe(1)
    expect(ses.listeners.onHeadersReceived.length).toBe(1)
    expect(ses.listeners.onCompleted.length).toBe(1)
    expect(ses.listeners.onErrorOccurred.length).toBe(1)
    const other = new FakeSession()
    mux.attach(other.asSession(), 'private')
    expect(other.listeners.onBeforeRequest.length).toBe(1)
  })

  it('runs handlers in order and stops onBeforeRequest at the first definitive answer', () => {
    const mux = new WebRequestMultiplexer(views)
    const calls: string[] = []
    const handler = (
      id: string,
      order: number,
      answer?: () => ReturnType<NonNullable<RequestHandler['onBeforeRequest']>>
    ): RequestHandler => ({
      id,
      order,
      onBeforeRequest: () => {
        calls.push(id)
        return answer?.()
      }
    })
    mux.register(handler('late', 300))
    mux.register(handler('early', 10))
    const unregister = mux.register(handler('blocker', 100, () => ({ cancel: true })))
    expect(mux.handlerIds()).toEqual(['early', 'blocker', 'late'])

    const ses = new FakeSession()
    mux.attach(ses.asSession(), 'default')
    expect(ses.beforeRequest({ url: 'https://ads.example/x' })).toEqual({ cancel: true })
    expect(calls).toEqual(['early', 'blocker'])
    expect(mux.inFlight).toBe(0)

    calls.length = 0
    unregister()
    expect(mux.handlerIds()).toEqual(['early', 'late'])
    expect(ses.beforeRequest({ url: 'https://ads.example/x' })).toEqual({})
    expect(calls).toEqual(['early', 'late'])
    expect(mux.inFlight).toBe(1)

    calls.length = 0
    mux.register(handler('redirector', 50, () => ({ redirectURL: 'https://safe.example/' })))
    expect(ses.beforeRequest({ url: 'https://ads.example/y' })).toEqual({
      redirectURL: 'https://safe.example/'
    })
    expect(calls).toEqual(['early', 'redirector'])
  })

  it('keeps one request record across the three phases and forgets it at the end', () => {
    const mux = new WebRequestMultiplexer(views)
    const seen: string[] = []
    mux.register({
      id: 'stateful',
      order: 1,
      onBeforeRequest: (request) => {
        request.state.set('mark', request.ctx.url)
        return undefined
      },
      onBeforeSendHeaders: (request, headers) => {
        seen.push(`send:${String(request.state.get('mark'))}`)
        headers['X-Zenium'] = '1'
        return undefined
      },
      onHeadersReceived: (request, headers) => {
        seen.push(`recv:${String(request.state.get('mark'))}`)
        headers['x-seen'] = ['yes']
        return undefined
      }
    })
    const ses = new FakeSession()
    mux.attach(ses.asSession(), 'default')
    const id = 4242
    ses.beforeRequest({ id, url: 'https://site.example/a.js' })
    expect(
      ses.beforeSendHeaders({
        id,
        url: 'https://site.example/a.js',
        requestHeaders: { Accept: '*/*' }
      })
    ).toEqual({
      requestHeaders: { Accept: '*/*', 'X-Zenium': '1' }
    })
    expect(
      ses.headersReceived({
        id,
        url: 'https://site.example/a.js',
        responseHeaders: { 'content-type': ['text/javascript'] }
      })
    ).toEqual({
      responseHeaders: { 'content-type': ['text/javascript'], 'x-seen': ['yes'] }
    })
    expect(seen).toEqual(['send:https://site.example/a.js', 'recv:https://site.example/a.js'])
    expect(mux.inFlight).toBe(1)
    ses.listeners.onCompleted[0]({ id })
    expect(mux.inFlight).toBe(0)
    // A header phase without a preceding onBeforeRequest still gets a record.
    ses.beforeSendHeaders({ id: 9, url: 'https://site.example/b.js', requestHeaders: {} })
    expect(mux.inFlight).toBe(1)
    ses.listeners.onErrorOccurred[0]({ id: 9 })
    expect(mux.inFlight).toBe(0)
  })

  it('lets header handlers cancel and set the status line, and survives a throwing handler', () => {
    const mux = new WebRequestMultiplexer(views)
    mux.register({
      id: 'broken',
      order: 1,
      onBeforeRequest: () => {
        throw new Error('boom')
      },
      onBeforeSendHeaders: () => {
        throw new Error('boom')
      },
      onHeadersReceived: () => {
        throw new Error('boom')
      }
    })
    mux.register({
      id: 'cancel-headers',
      order: 2,
      onBeforeSendHeaders: (request) =>
        request.ctx.url.endsWith('/cancel') ? { cancel: true } : undefined,
      onHeadersReceived: (request) =>
        request.ctx.url.endsWith('/status') ? { statusLine: 'HTTP/1.1 204 No Content' } : undefined
    })
    const ses = new FakeSession()
    mux.attach(ses.asSession(), 'default')
    expect(ses.beforeRequest({ url: 'https://site.example/ok' })).toEqual({})
    expect(
      ses.beforeSendHeaders({ url: 'https://site.example/cancel', requestHeaders: {} })
    ).toEqual({ cancel: true })
    expect(
      ses.beforeSendHeaders({ url: 'https://site.example/ok', requestHeaders: { A: 'b' } })
    ).toEqual({ requestHeaders: { A: 'b' } })
    expect(
      ses.headersReceived({ url: 'https://site.example/status', responseHeaders: {} })
    ).toEqual({
      responseHeaders: {},
      statusLine: 'HTTP/1.1 204 No Content'
    })
    expect(ses.headersReceived({ url: 'https://site.example/ok' })).toEqual({ responseHeaders: {} })
  })
})

describe('contextFor', () => {
  it('derives type, initiator, document, tab and partition from the details', () => {
    const wc = fakeWebContents('https://top.example/page')
    const ctx = contextFor(
      fakeDetails<BeforeRequestDetails>({
        url: 'https://cdn.example/a.js',
        resourceType: 'script',
        method: 'GET',
        referrer: 'https://top.example/page',
        webContents: wc
      }) as BeforeRequestDetails,
      'container-work',
      'tab-1'
    )
    expect(ctx).toEqual({
      url: 'https://cdn.example/a.js',
      type: 'script',
      method: 'GET',
      partition: 'container-work',
      isPrivate: false,
      initiator: 'https://top.example/page',
      documentUrl: 'https://top.example/page',
      tabId: 'tab-1'
    })
  })

  it('falls back to the frame URL, then the top document, and keeps main frames document-free', () => {
    const wc = fakeWebContents('https://top.example/page')
    const frame = { url: 'https://frame.example/inner' } as Electron.WebFrameMain
    const sub = contextFor(
      fakeDetails<BeforeRequestDetails>({
        url: 'https://x.example/p.gif',
        resourceType: 'image',
        referrer: '',
        frame,
        webContents: wc
      }) as BeforeRequestDetails,
      'private',
      undefined
    )
    expect(sub.initiator).toBe('https://frame.example/inner')
    expect(sub.documentUrl).toBe('https://top.example/page')
    expect(sub.isPrivate).toBe(true)
    expect(sub.tabId).toBeUndefined()

    const noFrame = contextFor(
      fakeDetails<BeforeRequestDetails>({
        url: 'https://x.example/p.gif',
        resourceType: 'xhr',
        referrer: '',
        webContents: wc
      }) as BeforeRequestDetails,
      'default',
      undefined
    )
    expect(noFrame.type).toBe('xmlhttprequest')
    expect(noFrame.initiator).toBe('https://top.example/page')

    const main = contextFor(
      fakeDetails<BeforeRequestDetails>({
        url: 'https://next.example/',
        resourceType: 'mainFrame',
        referrer: '',
        webContents: wc
      }) as BeforeRequestDetails,
      'default',
      'tab-2'
    )
    expect(main.type).toBe('main_frame')
    expect(main.initiator).toBeUndefined()
    expect(main.documentUrl).toBeUndefined()

    const gone = contextFor(
      fakeDetails<BeforeRequestDetails>({
        url: 'https://x.example/',
        resourceType: 'other',
        referrer: '',
        webContents: fakeWebContents('https://a/', true)
      }) as BeforeRequestDetails,
      'default',
      undefined
    )
    expect(gone.documentUrl).toBeUndefined()
  })
})

describe('header operations', () => {
  it('applies set, append and remove case-insensitively to request headers', () => {
    const headers: Record<string, string> = {
      'user-agent': 'UA',
      Cookie: 'a=1',
      'Accept-Language': 'en'
    }
    applyRequestHeaderOps(headers, [
      { header: 'Sec-GPC', operation: 'set', value: '1' },
      { header: 'COOKIE', operation: 'remove' },
      { header: 'accept-language', operation: 'append', value: 'de' },
      { header: 'DNT', operation: 'append', value: '1' },
      { header: 'User-Agent', operation: 'set', value: 'Zenium' },
      { header: 'X-Nothing', operation: 'set' }
    ])
    expect(headers).toEqual({
      'Sec-GPC': '1',
      'Accept-Language': 'en, de',
      DNT: '1',
      'User-Agent': 'Zenium'
    })
  })

  it('applies set, append and remove to multi-valued response headers', () => {
    const headers: Record<string, string[]> = {
      'set-cookie': ['a=1', 'b=2'],
      'X-Frame-Options': ['DENY'],
      Server: ['x']
    }
    applyResponseHeaderOps(headers, [
      { header: 'Set-Cookie', operation: 'remove' },
      { header: 'x-frame-options', operation: 'set', value: 'SAMEORIGIN' },
      { header: 'Content-Security-Policy', operation: 'append', value: "script-src 'none'" },
      { header: 'Content-Security-Policy', operation: 'append', value: 'frame-src https:' },
      { header: 'Server', operation: 'append' }
    ])
    expect(headers).toEqual({
      'x-frame-options': ['SAMEORIGIN'],
      Server: ['x'],
      'Content-Security-Policy': ["script-src 'none'", 'frame-src https:']
    })
  })
})
