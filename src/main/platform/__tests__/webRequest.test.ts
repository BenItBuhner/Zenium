import { describe, expect, it } from 'vitest'
import type { Session } from 'electron'
import {
  HANDLER_ORDER,
  WebRequestMultiplexer,
  applyRequestHeaderOps,
  applyResponseHeaderOps,
  composeBeforeRequest,
  contextFor,
  mergeRedirect,
  mergeRequestHeaders,
  mergeResponseHeaders,
  type Answer,
  type BeforeRequestDetails,
  type BeforeSendHeadersDetails,
  type HeadersReceivedDetails,
  type RequestHandler,
  type WebRequestDetails
} from '../webRequest'
import {
  edgeStoreUserAgent,
  webstoreClientHints,
  type RequestHeaderHandler
} from '../requestHeaders'
import { withChromeClientHints, withEdgeIdentity } from '../../../core/extensions/webstorePrivate'
import { PRIVATE_CONTAINER_ID } from '../../../shared/types'

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
type ObserveListener = (details: Record<string, unknown> & { id: number }) => void

/** A `Session` that records the listeners installed on its `webRequest`. */
class FakeSession {
  listeners: {
    onBeforeRequest: BeforeRequestListener[]
    onBeforeSendHeaders: BeforeSendHeadersListener[]
    onSendHeaders: ObserveListener[]
    onHeadersReceived: HeadersReceivedListener[]
    onResponseStarted: ObserveListener[]
    onBeforeRedirect: ObserveListener[]
    onCompleted: ObserveListener[]
    onErrorOccurred: ObserveListener[]
  } = {
    onBeforeRequest: [],
    onBeforeSendHeaders: [],
    onSendHeaders: [],
    onHeadersReceived: [],
    onResponseStarted: [],
    onBeforeRedirect: [],
    onCompleted: [],
    onErrorOccurred: []
  }

  webRequest = {
    onBeforeRequest: (l: BeforeRequestListener) => this.listeners.onBeforeRequest.push(l),
    onBeforeSendHeaders: (l: BeforeSendHeadersListener) =>
      this.listeners.onBeforeSendHeaders.push(l),
    onSendHeaders: (l: ObserveListener) => this.listeners.onSendHeaders.push(l),
    onHeadersReceived: (l: HeadersReceivedListener) => this.listeners.onHeadersReceived.push(l),
    onResponseStarted: (l: ObserveListener) => this.listeners.onResponseStarted.push(l),
    onBeforeRedirect: (l: ObserveListener) => this.listeners.onBeforeRedirect.push(l),
    onCompleted: (l: ObserveListener) => this.listeners.onCompleted.push(l),
    onErrorOccurred: (l: ObserveListener) => this.listeners.onErrorOccurred.push(l)
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

  /** The same, for pipelines with an asynchronous blocking listener. */
  beforeRequestAsync(details: Partial<BeforeRequestDetails>): Promise<Electron.CallbackResponse> {
    return new Promise((resolve) =>
      this.listeners.onBeforeRequest[0](fakeDetails(details) as BeforeRequestDetails, resolve)
    )
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

  observe(event: keyof FakeSession['listeners'], details: Record<string, unknown>): void {
    const listener = this.listeners[event][0] as ObserveListener
    listener(
      fakeDetails(details as Partial<{ id: number }>) as Record<string, unknown> & { id: number }
    )
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

describe('WebRequestMultiplexer listeners', () => {
  type Log = string[]
  function setup(): { mux: WebRequestMultiplexer; ses: FakeSession; log: Log } {
    const mux = new WebRequestMultiplexer(views)
    const ses = new FakeSession()
    mux.attach(ses.asSession(), 'default')
    return { mux, ses, log: [] }
  }

  it('orders listeners by priority, registrant id and registration order', () => {
    const { mux, ses, log } = setup()
    const add = (registrant: string, priority: number | undefined, tag = ''): void => {
      mux.addListener(
        'onBeforeRequest',
        () => {
          log.push(`${registrant}${tag}`)
        },
        { registrant, priority }
      )
    }
    add('b', 1)
    add('a', 1)
    add('c', 5)
    add('b', 1, '2')
    add('z', undefined)
    add('y', undefined)
    expect(mux.listenerOrder('onBeforeRequest')).toEqual([
      ['c', false],
      ['a', false],
      ['b', false],
      ['b', false],
      ['y', false],
      ['z', false]
    ])
    ses.beforeRequest({ url: 'https://site.example/a.js' })
    expect(log).toEqual(['c', 'a', 'b', 'b2', 'y', 'z'])
    mux.removeListenersOf('b')
    expect(mux.listenerOrder('onBeforeRequest').map(([r]) => r)).toEqual(['c', 'a', 'y', 'z'])
    expect(() =>
      mux.addListener('onCompleted', () => undefined, { registrant: 'x', blocking: true })
    ).toThrow(/no blocking variant/)
  })

  it('gives listeners Chromium-shaped details and applies the filters', () => {
    const { mux, ses } = setup()
    const seen: WebRequestDetails[] = []
    mux.addListener(
      'onBeforeRequest',
      (details) => {
        seen.push(details)
      },
      { registrant: 'ext', filter: { types: ['script', 'image'], partition: 'default' } }
    )
    const skipped: string[] = []
    mux.addListener(
      'onBeforeRequest',
      (details) => {
        skipped.push(details.url)
      },
      { registrant: 'ext', filter: { tabId: 'tab-nope', url: () => true } }
    )
    const frame = {
      url: 'https://frame.example/',
      frameTreeNodeId: 7,
      parent: { frameTreeNodeId: 3, parent: null }
    }
    ses.beforeRequest({
      id: 77,
      url: 'https://cdn.example/a.js',
      referrer: 'https://frame.example/page',
      timestamp: 1234.5,
      webContents: fakeWebContents('https://top.example/'),
      frame: frame as unknown as Electron.WebFrameMain
    })
    ses.beforeRequest({ url: 'https://cdn.example/a.css', resourceType: 'stylesheet' })
    expect(skipped).toEqual([])
    expect(seen).toEqual([
      {
        event: 'onBeforeRequest',
        requestId: '77',
        url: 'https://cdn.example/a.js',
        method: 'GET',
        resourceType: 'script',
        frameId: 7,
        parentFrameId: 0,
        tabId: 'tab-20',
        partition: 'default',
        initiator: 'https://frame.example',
        documentUrl: 'https://top.example/',
        timestamp: 1234.5
      }
    ])
    // A main-frame navigation without a frame object is frame 0 without a parent.
    const nav: WebRequestDetails[] = []
    mux.addListener(
      'onBeforeRequest',
      (d) => {
        nav.push(d)
      },
      { registrant: 'nav', filter: { types: ['main_frame'] } }
    )
    ses.beforeRequest({ url: 'https://top.example/', resourceType: 'mainFrame' })
    expect(nav[0]).toMatchObject({
      frameId: 0,
      parentFrameId: -1,
      tabId: null,
      initiator: null,
      documentUrl: null
    })
  })

  it('lets the engine decide first and composes onBeforeRequest answers like Chromium', async () => {
    const { mux, ses, log } = setup()
    mux.register({
      id: 'engine',
      order: 100,
      onBeforeRequest: (request) =>
        request.ctx.url.includes('/engine-blocks') ? { cancel: true } : undefined
    })
    const answer = (
      registrant: string,
      priority: number,
      respond: (d: WebRequestDetails) => ReturnType<Parameters<typeof mux.addListener>[1]>
    ): void => {
      mux.addListener(
        'onBeforeRequest',
        (d) => {
          log.push(registrant)
          return respond(d)
        },
        { registrant, priority, blocking: true }
      )
    }
    answer('low', 1, (d) =>
      d.url.includes('/redirect') ? { redirectUrl: 'https://low.example/' } : undefined
    )
    answer('high', 9, (d) =>
      d.url.includes('/redirect') ? { redirectUrl: 'https://high.example/' } : undefined
    )
    answer('canceller', 5, (d) => (d.url.includes('/cancel') ? { cancel: true } : undefined))
    answer('neutered', 0, (d) =>
      d.url.includes('/data') ? { redirectUrl: 'data:text/plain,' } : undefined
    )
    answer('slow', 3, (d) =>
      d.url.includes('/async')
        ? Promise.resolve({ redirectUrl: 'https://slow.example/' })
        : undefined
    )

    const errors: WebRequestDetails[] = []
    mux.addListener(
      'onErrorOccurred',
      (d) => {
        errors.push(d)
      },
      { registrant: 'watcher' }
    )

    // The engine's cancel is final and the listeners never see the request, but they hear that
    // it was blocked, as Chromium tells them.
    expect(ses.beforeRequest({ id: 41, url: 'https://site.example/engine-blocks' })).toEqual({
      cancel: true
    })
    expect(log).toEqual([])
    expect(mux.inFlight).toBe(0)
    expect(errors).toMatchObject([
      {
        event: 'onErrorOccurred',
        requestId: '41',
        url: 'https://site.example/engine-blocks',
        error: 'net::ERR_BLOCKED_BY_CLIENT',
        fromCache: false
      }
    ])
    // Electron's own error event for the cancelled request finds nothing left to report.
    ses.observe('onErrorOccurred', {
      id: 41,
      url: 'https://site.example/engine-blocks',
      error: 'net::ERR_BLOCKED_BY_CLIENT'
    })
    expect(errors).toHaveLength(1)

    // Every listener runs; the highest-priority registrant's redirect wins, the loser is a conflict.
    expect(ses.beforeRequest({ url: 'https://site.example/redirect' })).toEqual({
      redirectURL: 'https://high.example/'
    })
    expect(log).toEqual(['high', 'canceller', 'slow', 'low', 'neutered'])
    expect(mux.conflicts).toEqual([
      { event: 'onBeforeRequest', registrant: 'low', url: 'https://site.example/redirect' }
    ])

    // Any cancel wins over redirects, and a listener's cancel is reported like the engine's.
    expect(ses.beforeRequest({ id: 42, url: 'https://site.example/redirect/cancel' })).toEqual({
      cancel: true
    })
    expect(errors.map((d) => [d.requestId, d.error])).toEqual([
      ['41', 'net::ERR_BLOCKED_BY_CLIENT'],
      ['42', 'net::ERR_BLOCKED_BY_CLIENT']
    ])
    // A data: redirect is a cancel in disguise and beats a higher-priority plain redirect.
    expect(ses.beforeRequest({ url: 'https://site.example/redirect/data' })).toEqual({
      redirectURL: 'data:text/plain,'
    })
    // No answer at all is a plain pass-through.
    expect(ses.beforeRequest({ url: 'https://site.example/plain.js' })).toEqual({})
    // A promise from a blocking listener defers the callback until it settles.
    expect(await ses.beforeRequestAsync({ url: 'https://site.example/async' })).toEqual({
      redirectURL: 'https://slow.example/'
    })
  })

  it('merges request-header answers in precedence order and drops conflicting deltas', () => {
    const { mux, ses } = setup()
    mux.register({
      id: 'engine',
      order: 100,
      onBeforeSendHeaders: (_request, headers) => {
        delete headers['X-Tracking']
        headers['X-Engine'] = 'on'
        return undefined
      }
    })
    const seen: Array<Record<string, string> | undefined> = []
    mux.addListener(
      'onBeforeSendHeaders',
      (d) => {
        seen.push(d.requestHeaders)
        return {
          requestHeaders: { ...d.requestHeaders, 'X-High': 'h', 'User-Agent': 'High/1' }
        }
      },
      { registrant: 'high', priority: 9, blocking: true }
    )
    mux.addListener(
      'onBeforeSendHeaders',
      (d) => {
        // Same value as "high" for User-Agent (no conflict), plus its own header.
        const headers = { ...d.requestHeaders, 'user-agent': 'High/1', 'X-Mid': 'm' }
        return { requestHeaders: headers }
      },
      { registrant: 'mid', priority: 5, blocking: true }
    )
    mux.addListener(
      'onBeforeSendHeaders',
      (d) => {
        // Conflicts: a different User-Agent and re-adding what the engine removed.
        const headers = { ...d.requestHeaders, 'User-Agent': 'Low/1', 'X-Tracking': 'back' }
        return { requestHeaders: headers }
      },
      { registrant: 'low', priority: 1, blocking: true }
    )
    mux.addListener(
      'onBeforeSendHeaders',
      (d) => {
        // Removing a header nobody else touched, and one the engine set (conflict).
        const headers = { ...d.requestHeaders }
        delete headers['Accept']
        delete headers['X-Engine']
        return { requestHeaders: headers }
      },
      { registrant: 'remover', priority: 0, blocking: true }
    )
    mux.addListener(
      'onBeforeSendHeaders',
      (d) => {
        const headers = { ...d.requestHeaders }
        delete headers['Accept-Language']
        return { requestHeaders: headers }
      },
      { registrant: 'trimmer', priority: 0, blocking: true }
    )
    const out = ses.beforeSendHeaders({
      url: 'https://site.example/a.js',
      requestHeaders: {
        Accept: '*/*',
        'Accept-Language': 'en',
        'User-Agent': 'Zenium/1',
        'X-Tracking': 'yes'
      }
    })
    // Listeners see the headers after the engine's edits.
    expect(seen[0]).toEqual({
      Accept: '*/*',
      'Accept-Language': 'en',
      'User-Agent': 'Zenium/1',
      'X-Engine': 'on'
    })
    expect(out).toEqual({
      requestHeaders: {
        Accept: '*/*',
        'user-agent': 'High/1',
        'X-Engine': 'on',
        'X-High': 'h',
        'X-Mid': 'm'
      }
    })
    expect(mux.conflicts.map((c) => c.registrant)).toEqual(['low', 'remover'])
    // Wait: "trimmer" removed Accept-Language and nobody set it, so it is gone.
    expect(out.requestHeaders).not.toHaveProperty('Accept-Language')
  })

  it('merges response-header lines, turns a headers-received redirect into a 302 and cancels', () => {
    const { mux, ses } = setup()
    mux.register({
      id: 'engine',
      order: 100,
      onHeadersReceived: (_request, headers) => {
        headers['content-security-policy'] = ['default-src https:']
        return undefined
      }
    })
    mux.addListener(
      'onHeadersReceived',
      (d) => {
        const headers = { ...d.responseHeaders }
        delete headers['set-cookie']
        return { responseHeaders: { ...headers, 'x-high': 'h' } }
      },
      { registrant: 'high', priority: 9, blocking: true }
    )
    mux.addListener(
      'onHeadersReceived',
      (d) => {
        // Re-adding a deleted cookie line and dropping the engine's CSP: both conflicts.
        const headers = { ...d.responseHeaders, 'Set-Cookie': ['a=1'] }
        delete headers['content-security-policy']
        return { responseHeaders: headers }
      },
      { registrant: 'low', priority: 1, blocking: true }
    )
    mux.addListener(
      'onHeadersReceived',
      (d) => {
        // Only one of two cookie lines was deleted upstream; adding a fresh one is fine.
        return { responseHeaders: { ...d.responseHeaders, 'Set-Cookie': 'fresh=1' } }
      },
      { registrant: 'cookie', priority: 0, blocking: true }
    )
    const out = ses.headersReceived({
      url: 'https://site.example/',
      responseHeaders: { 'set-cookie': ['a=1', 'b=2'], 'content-type': ['text/html'] }
    })
    expect(out).toEqual({
      responseHeaders: {
        'content-type': ['text/html'],
        'content-security-policy': ['default-src https:'],
        'x-high': ['h'],
        'Set-Cookie': ['fresh=1']
      }
    })
    expect(mux.conflicts.map((c) => c.registrant)).toEqual(['low'])

    mux.addListener(
      'onHeadersReceived',
      (d) => (d.url.endsWith('/go') ? { redirectUrl: 'https://elsewhere.example/' } : undefined),
      { registrant: 'redirector', priority: 2, blocking: true }
    )
    expect(
      ses.headersReceived({
        url: 'https://site.example/go',
        responseHeaders: { 'content-type': ['text/html'], location: ['https://old.example/'] }
      })
    ).toEqual({
      statusLine: 'HTTP/1.1 302 Found',
      responseHeaders: {
        'content-type': ['text/html'],
        'content-security-policy': ['default-src https:'],
        'x-high': ['h'],
        'Set-Cookie': ['fresh=1'],
        Location: ['https://elsewhere.example/']
      }
    })
    mux.addListener(
      'onHeadersReceived',
      (d) => (d.url.endsWith('/stop') ? { cancel: true } : undefined),
      { registrant: 'stopper', priority: 0, blocking: true }
    )
    expect(ses.headersReceived({ url: 'https://site.example/stop' })).toEqual({ cancel: true })
    // The two requests that went through stay tracked until they complete; the cancelled one is gone.
    expect(mux.inFlight).toBe(2)
  })

  it('dispatches the observe-only events with their fields and installs them lazily', () => {
    const { mux, ses, log } = setup()
    expect(ses.listeners.onSendHeaders.length).toBe(0)
    expect(ses.listeners.onResponseStarted.length).toBe(0)
    expect(ses.listeners.onBeforeRedirect.length).toBe(0)
    const events: WebRequestDetails[] = []
    for (const event of [
      'onSendHeaders',
      'onResponseStarted',
      'onBeforeRedirect',
      'onCompleted',
      'onErrorOccurred'
    ] as const) {
      mux.addListener(
        event,
        (d) => {
          events.push(d)
          log.push(event)
          return { cancel: true } // ignored: not a blocking listener
        },
        { registrant: 'observer' }
      )
    }
    expect(ses.listeners.onSendHeaders.length).toBe(1)
    expect(ses.listeners.onResponseStarted.length).toBe(1)
    expect(ses.listeners.onBeforeRedirect.length).toBe(1)
    // A session attached later gets the observers too.
    const later = new FakeSession()
    mux.attach(later.asSession(), 'private')
    expect(later.listeners.onBeforeRedirect.length).toBe(1)

    const id = 500
    ses.beforeRequest({ id, url: 'https://site.example/x' })
    ses.observe('onSendHeaders', { id, url: 'https://site.example/x', requestHeaders: { A: '1' } })
    ses.observe('onResponseStarted', {
      id,
      url: 'https://site.example/x',
      responseHeaders: { 'x-a': '1' },
      statusLine: 'HTTP/1.1 200 OK',
      statusCode: 200,
      fromCache: false
    })
    ses.observe('onBeforeRedirect', {
      id,
      url: 'https://site.example/x',
      redirectURL: 'https://site.example/y',
      statusCode: 301,
      statusLine: 'HTTP/1.1 301 Moved Permanently',
      fromCache: false,
      ip: '10.0.0.1',
      responseHeaders: {}
    })
    ses.observe('onCompleted', {
      id,
      url: 'https://site.example/y',
      statusCode: 200,
      statusLine: 'HTTP/1.1 200 OK',
      fromCache: true,
      responseHeaders: { 'x-b': ['2'] }
    })
    expect(mux.inFlight).toBe(0)
    ses.beforeRequest({ id: 501, url: 'https://site.example/z' })
    ses.observe('onErrorOccurred', {
      id: 501,
      url: 'https://site.example/z',
      error: 'net::ERR_FAILED',
      fromCache: false
    })
    expect(mux.inFlight).toBe(0)
    expect(log).toEqual([
      'onSendHeaders',
      'onResponseStarted',
      'onBeforeRedirect',
      'onCompleted',
      'onErrorOccurred'
    ])
    expect(events[0]).toMatchObject({ event: 'onSendHeaders', requestHeaders: { A: '1' } })
    expect(events[1]).toMatchObject({
      event: 'onResponseStarted',
      responseHeaders: { 'x-a': ['1'] },
      statusCode: 200,
      fromCache: false
    })
    expect(events[2]).toMatchObject({
      event: 'onBeforeRedirect',
      redirectUrl: 'https://site.example/y',
      statusCode: 301,
      ip: '10.0.0.1'
    })
    expect(events[3]).toMatchObject({
      event: 'onCompleted',
      responseHeaders: { 'x-b': ['2'] },
      fromCache: true
    })
    expect(events[4]).toMatchObject({ event: 'onErrorOccurred', error: 'net::ERR_FAILED' })
    // A completion event for a request never seen in onBeforeRequest is simply forgotten.
    ses.observe('onCompleted', { id: 999, url: 'https://site.example/unknown' })
    expect(log.length).toBe(5)
  })

  it('survives throwing and rejecting listeners', async () => {
    const { mux, ses } = setup()
    mux.addListener(
      'onBeforeRequest',
      () => {
        throw new Error('boom')
      },
      { registrant: 'thrower', priority: 9, blocking: true }
    )
    mux.addListener('onBeforeRequest', () => Promise.reject(new Error('later')), {
      registrant: 'rejecter',
      priority: 8,
      blocking: true
    })
    mux.addListener('onBeforeRequest', () => ({ cancel: true }), {
      registrant: 'decider',
      priority: 1,
      blocking: true
    })
    expect(await ses.beforeRequestAsync({ url: 'https://site.example/a' })).toEqual({
      cancel: true
    })
  })
})

describe('builtin header rewrites', () => {
  const CHROMIUM = '136.0.7103.48'
  /** The handler `index.ts` registers (`requestHeaders.ts`), with a fixed Chromium version. */
  const storeHints: RequestHeaderHandler = {
    ...webstoreClientHints,
    rewrite: (headers) => withChromeClientHints(headers, CHROMIUM)
  }
  const brands = '"Chromium";v="136", "Not_A Brand";v="24"'

  it('runs inside the one onBeforeSendHeaders hook of a persistent session, after the engine', () => {
    const mux = new WebRequestMultiplexer(views)
    const ses = new FakeSession()
    mux.attach(ses.asSession(), 'default')
    const seen: string[] = []
    mux.register({
      id: 'blocking',
      order: HANDLER_ORDER.ruleEngine,
      onBeforeSendHeaders: (_r, headers) => {
        seen.push(headers['Sec-CH-UA'])
        headers['X-Engine'] = 'first'
        return undefined
      }
    })
    const remove = mux.registerHeaderRewrite(storeHints, { persistentOnly: true })
    // Still exactly one session listener per event: the rewrite is a handler, not a listener.
    expect(ses.listeners.onBeforeSendHeaders.length).toBe(1)
    expect(mux.handlerIds()).toEqual(['blocking', 'rewrite:webstore-client-hints'])

    const out = ses.beforeSendHeaders({
      url: 'https://chromewebstore.google.com/detail/abc',
      resourceType: 'mainFrame',
      requestHeaders: { 'Sec-CH-UA': brands, Accept: 'text/html' }
    })
    expect(out.requestHeaders).toEqual({
      'Sec-CH-UA': `"Chromium";v="136", "Google Chrome";v="136", "Not_A Brand";v="24"`,
      Accept: 'text/html',
      'X-Engine': 'first'
    })
    // The engine saw the headers before the rewrite touched them.
    expect(seen).toEqual([brands])

    // A store page's own requests to other hosts are left alone.
    expect(
      ses.beforeSendHeaders({
        url: 'https://fonts.gstatic.com/x.woff2',
        requestHeaders: { 'Sec-CH-UA': brands }
      }).requestHeaders
    ).toEqual({ 'Sec-CH-UA': brands, 'X-Engine': 'first' })

    remove()
    expect(mux.handlerIds()).toEqual(['blocking'])
    expect(
      ses.beforeSendHeaders({
        url: 'https://chromewebstore.google.com/',
        requestHeaders: { 'Sec-CH-UA': brands }
      }).requestHeaders
    ).toEqual({ 'Sec-CH-UA': brands, 'X-Engine': 'first' })
  })

  it('runs the two store handlers side by side, each on its own origin only', () => {
    /** The second handler `index.ts` registers, with the same fixed Chromium version. */
    const edgeIdentity: RequestHeaderHandler = {
      ...edgeStoreUserAgent,
      rewrite: (headers) => withEdgeIdentity(headers, CHROMIUM)
    }
    const ua =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.48 Safari/537.36'
    const mux = new WebRequestMultiplexer(views)
    const ses = new FakeSession()
    mux.attach(ses.asSession(), 'default')
    mux.registerHeaderRewrite(storeHints, { persistentOnly: true })
    mux.registerHeaderRewrite(edgeIdentity, { persistentOnly: true })
    expect(ses.listeners.onBeforeSendHeaders.length).toBe(1)
    expect(mux.handlerIds()).toEqual([
      'rewrite:webstore-client-hints',
      'rewrite:edge-store-user-agent'
    ])

    const edge = ses.beforeSendHeaders({
      url: 'https://microsoftedge.microsoft.com/addons/detail/dark-reader/ifoakfbpdcdoeenechcleahebpibofpc',
      resourceType: 'mainFrame',
      requestHeaders: { 'User-Agent': ua, 'Sec-CH-UA': brands, Accept: 'text/html' }
    })
    expect(edge.requestHeaders).toEqual({
      'User-Agent': `${ua} Edg/136.0.0.0`,
      'Sec-CH-UA': `"Chromium";v="136", "Microsoft Edge";v="136", "Not_A Brand";v="24"`,
      Accept: 'text/html'
    })

    const chrome = ses.beforeSendHeaders({
      url: 'https://chromewebstore.google.com/detail/abc',
      resourceType: 'mainFrame',
      requestHeaders: { 'User-Agent': ua, 'Sec-CH-UA': brands, Accept: 'text/html' }
    })
    expect(chrome.requestHeaders).toEqual({
      'User-Agent': ua,
      'Sec-CH-UA': `"Chromium";v="136", "Google Chrome";v="136", "Not_A Brand";v="24"`,
      Accept: 'text/html'
    })

    const other = ses.beforeSendHeaders({
      url: 'https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=updatecheck',
      requestHeaders: { 'User-Agent': ua, 'Sec-CH-UA': brands }
    })
    expect(other.requestHeaders).toEqual({ 'User-Agent': ua, 'Sec-CH-UA': brands })
  })

  it('skips the private partition when the rewrite is for persistent sessions only', () => {
    const mux = new WebRequestMultiplexer(views)
    const ses = new FakeSession()
    mux.attach(ses.asSession(), PRIVATE_CONTAINER_ID)
    mux.registerHeaderRewrite(storeHints, { persistentOnly: true })
    expect(
      ses.beforeSendHeaders({
        url: 'https://chromewebstore.google.com/',
        requestHeaders: { 'Sec-CH-UA': brands }
      }).requestHeaders
    ).toEqual({ 'Sec-CH-UA': brands })
    mux.registerHeaderRewrite({
      id: 'everywhere',
      urls: ['<all_urls>'],
      rewrite: (headers) => ({ ...headers, DNT: '1' })
    })
    expect(
      ses.beforeSendHeaders({ url: 'https://site.example/', requestHeaders: { Accept: '*/*' } })
        .requestHeaders
    ).toEqual({ Accept: '*/*', DNT: '1' })
  })

  it("counts the rewrite's edits as the host's when listeners conflict, and lets them drop headers", () => {
    const mux = new WebRequestMultiplexer(views)
    const ses = new FakeSession()
    mux.attach(ses.asSession(), 'default')
    mux.registerHeaderRewrite({
      id: 'strip',
      urls: ['*://*.example/*'],
      rewrite: (headers) => {
        const rest = { ...headers }
        delete rest.Cookie
        return { ...rest, 'X-Host': 'rewrite' }
      }
    })
    mux.addListener(
      'onBeforeSendHeaders',
      (d) => ({ requestHeaders: { ...d.requestHeaders, 'X-Host': 'extension', 'X-Ext': '1' } }),
      { registrant: 'ext', blocking: true }
    )
    mux.addListener(
      'onBeforeSendHeaders',
      (d) => ({ requestHeaders: { ...d.requestHeaders, 'X-Other': '2' } }),
      { registrant: 'other', blocking: true }
    )
    const out = ses.beforeSendHeaders({
      url: 'https://www.site.example/',
      requestHeaders: { Cookie: 'a=1', Accept: '*/*' }
    })
    // `ext` fought the host over X-Host, so its whole delta is dropped (as Chromium drops an
    // extension's conflicting response); `other` did not and its edit stands.
    expect(out.requestHeaders).toEqual({ Accept: '*/*', 'X-Host': 'rewrite', 'X-Other': '2' })
    expect(mux.conflicts.map((c) => c.registrant)).toEqual(['ext'])
  })
})

describe('composition rules', () => {
  const answer = (registrant: string, response: Answer['response']): Answer => ({
    registrant,
    response
  })

  it('picks redirects like MergeRedirectUrlOfResponses', () => {
    const conflicts: string[] = []
    const note = (r: string): void => {
      conflicts.push(r)
    }
    expect(mergeRedirect('https://a/', [], note)).toBeNull()
    expect(
      mergeRedirect('https://a/', [answer('x', { redirectUrl: 'https://a/' })], note)
    ).toBeNull()
    expect(
      mergeRedirect(
        'https://a/',
        [
          answer('first', { redirectUrl: 'https://one/' }),
          answer('second', { redirectUrl: 'https://two/' }),
          answer('third', { redirectUrl: 'https://one/' })
        ],
        note
      )
    ).toBe('https://one/')
    expect(conflicts).toEqual(['second'])
    expect(
      mergeRedirect('https://a/', [
        answer('first', { redirectUrl: 'https://one/' }),
        answer('second', { redirectUrl: 'about:blank' })
      ])
    ).toBe('about:blank')
    expect(
      composeBeforeRequest('https://a/', [
        answer('x', { cancel: true }),
        answer('y', { redirectUrl: 'https://b/' })
      ])
    ).toEqual({
      cancel: true,
      redirectUrl: null
    })
    expect(
      composeBeforeRequest('https://a/', [
        answer('x', {}),
        answer('y', { redirectUrl: 'https://b/' })
      ])
    ).toEqual({
      cancel: false,
      redirectUrl: 'https://b/'
    })
  })

  it('merges request headers like MergeOnBeforeSendHeadersResponses', () => {
    const base = { Accept: '*/*', Cookie: 'a=1', 'X-Old': 'old' }
    const conflicts: string[] = []
    const merged = mergeRequestHeaders(
      base,
      [
        { registrant: 'a', headers: { Accept: '*/*', Cookie: 'a=1', 'X-New': 'a' } }, // removes X-Old, adds X-New
        { registrant: 'b', headers: { accept: 'text/html', Cookie: 'a=1', 'X-Old': 'b' } }, // sets X-Old: conflict (removed)
        {
          registrant: 'c',
          headers: { Accept: '*/*', Cookie: 'a=1', 'X-Old': 'old', 'x-new': 'a' }
        }, // same value: fine
        { registrant: 'd', headers: { Accept: '*/*', 'X-Old': 'old', 'X-New': 'd' } }, // different value: conflict
        { registrant: 'e', headers: { Accept: '*/*', 'X-Old': 'old', 'X-New': 'a' } }, // removes Cookie: fine
        { registrant: 'f', headers: { Accept: '*/*', Cookie: 'a=1', 'X-Old': 'old' } } // the base again: no delta
      ],
      (r) => {
        conflicts.push(r)
      }
    )
    expect(merged).toEqual({ Accept: '*/*', 'X-New': 'a' })
    expect(conflicts).toEqual(['b', 'd'])
    expect(mergeRequestHeaders(base, [])).toEqual(base)
    // Removing a header a higher-precedence answer set is a conflict too.
    const removals: string[] = []
    expect(
      mergeRequestHeaders(
        { 'X-A': '0' },
        [
          { registrant: 'setter', headers: { 'X-A': '1' } },
          { registrant: 'remover', headers: {} }
        ],
        (r) => {
          removals.push(r)
        }
      )
    ).toEqual({ 'X-A': '1' })
    expect(removals).toEqual(['remover'])
    // The handlers' edits (original → base) win over every answer.
    const host: string[] = []
    expect(
      mergeRequestHeaders(
        { 'X-Engine': 'on' },
        [
          { registrant: 'restorer', headers: { 'X-Engine': 'on', 'X-Tracking': 'back' } },
          { registrant: 'changer', headers: { 'X-Engine': 'off' } }
        ],
        (r) => {
          host.push(r)
        },
        { 'X-Tracking': 'yes' }
      )
    ).toEqual({ 'X-Engine': 'on' })
    expect(host).toEqual(['restorer', 'changer'])
  })

  it('merges response header lines like MergeOnHeadersReceivedResponses', () => {
    const base = { 'set-cookie': ['a=1', 'b=2'], 'x-frame-options': ['DENY'] }
    const conflicts: string[] = []
    const merged = mergeResponseHeaders(
      base,
      [
        // Deletes a=1.
        { registrant: 'a', headers: { 'set-cookie': ['b=2'], 'x-frame-options': ['DENY'] } },
        // The base again (names compare case-insensitively): no delta.
        { registrant: 'b', headers: { 'Set-Cookie': ['a=1', 'b=2'], 'x-frame-options': ['DENY'] } },
        // Deletes DENY, adds X-Added.
        { registrant: 'c', headers: { 'set-cookie': ['a=1', 'b=2'], 'X-Added': ['1'] } },
        // Adds a second line: fine.
        {
          registrant: 'd',
          headers: { 'set-cookie': ['a=1', 'b=2'], 'x-frame-options': ['DENY', 'SAMEORIGIN'] }
        },
        // No line differs from the base: no delta.
        {
          registrant: 'e',
          headers: { 'set-cookie': ['a=1', 'b=2'], 'x-frame-options': ['DENY'], 'x-added': [] }
        }
      ],
      (r) => {
        conflicts.push(r)
      }
    )
    expect(merged).toEqual({
      'set-cookie': ['b=2'],
      'X-Added': ['1'],
      'x-frame-options': ['SAMEORIGIN']
    })
    expect(conflicts).toEqual([])
    // The handlers' edits (original → base) are protected: re-adding a line they deleted or
    // deleting a line they added is a conflict, and the whole answer is dropped.
    const host: string[] = []
    expect(
      mergeResponseHeaders(
        { 'x-a': ['1'], 'x-csp': ['default-src https:'] },
        [
          {
            registrant: 'restorer',
            headers: {
              'x-a': ['1'],
              'x-csp': ['default-src https:'],
              'x-removed': ['gone'],
              'x-mine': ['m']
            }
          },
          { registrant: 'dropper', headers: { 'x-a': ['1'] } },
          {
            registrant: 'fine',
            headers: { 'x-a': ['1'], 'x-csp': ['default-src https:'], 'x-fine': ['f'] }
          }
        ],
        (r) => {
          host.push(r)
        },
        { 'x-a': ['1'], 'x-removed': ['gone'] }
      )
    ).toEqual({ 'x-a': ['1'], 'x-csp': ['default-src https:'], 'x-fine': ['f'] })
    expect(host).toEqual(['restorer', 'dropper'])
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
