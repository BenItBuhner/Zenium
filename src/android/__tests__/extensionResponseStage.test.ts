import { describe, expect, it } from 'vitest'
import type { ExtRequestEvent, ExtResponseEvent } from '../extensionRuntime'
import type { RequestObservation } from '../requestObserver'
import {
  backgroundUp,
  call,
  events,
  harness,
  manifest,
  record,
  type Harness
} from './runtimeHarness'

/**
 * The response stage on the phone (`blocking-rule-interface.md` §7; round 15's twin of
 * services' pass 2): what the runtime emits from the relay's `ext.response` reports and from
 * the page script's observations, under which ids, and what each listener sees of the headers.
 */

type Details = Record<string, unknown> & {
  requestId: string
  url: string
  statusCode?: number
  statusLine?: string
  responseHeaders?: Array<{ name: string; value: string }>
  redirectUrl?: string
  fromCache?: boolean
  error?: string
  initiator?: string
  type?: string
  tabId?: number
}

const CLIP = 'https://cdn.example/clip.mp4'

function requestEvent(over: Partial<ExtRequestEvent> = {}): ExtRequestEvent {
  return {
    tabId: 't1',
    requestId: '7',
    url: CLIP,
    type: 'media',
    method: 'GET',
    initiator: 'https://news.example',
    mainFrame: false,
    document: 2,
    action: 'allow',
    matchedSet: null,
    matchedRule: null,
    micros: 3,
    cpuMicros: null,
    ...over
  }
}

function responseEvent(
  at: 'headers' | 'complete' | 'error',
  over: Partial<ExtResponseEvent> = {}
): ExtResponseEvent {
  return {
    tabId: 't1',
    requestId: '7',
    url: CLIP,
    type: 'media',
    method: 'GET',
    statusCode: 206,
    statusLine: 'HTTP/1.1 206 Partial Content',
    responseHeaders: [
      { name: 'Content-Type', value: 'video/mp4' },
      { name: 'Content-Range', value: 'bytes 0-1023/4096' },
      { name: 'Set-Cookie', value: 'seen=1' }
    ],
    at,
    relayed: true,
    ...over
  }
}

function observation(over: Partial<RequestObservation> = {}): RequestObservation {
  return {
    type: 'ext-observation',
    seq: 'doc-1',
    url: 'https://news.example/api/segment-1.m4s',
    method: 'GET',
    range: null,
    crossOrigin: false,
    status: 200,
    statusText: 'OK',
    headers: [
      { name: 'content-type', value: 'video/iso.segment' },
      { name: 'content-length', value: '4096' }
    ],
    at: 'headers',
    ...over
  }
}

function heard(h: Harness, ep: string, event: string): Details[] {
  return events(h, ep, `webRequest.${event}`).map((m) => (m.args as Details[])[0])
}

/** A background with one listener per response-stage event, each asking for `responseHeaders`. */
async function sniffer(
  h: Harness,
  ep: string,
  spec: string[] = ['responseHeaders'],
  filter: Record<string, unknown> = { urls: ['<all_urls>'] }
): Promise<void> {
  backgroundUp(h, ep)
  const eventsListened = [
    'onBeforeRequest',
    'onHeadersReceived',
    'onResponseStarted',
    'onBeforeRedirect',
    'onCompleted',
    'onErrorOccurred'
  ]
  let id = 1
  for (const event of eventsListened) {
    const own =
      event === 'onBeforeRequest' || event === 'onErrorOccurred'
        ? spec.filter((s) => s === 'extraHeaders')
        : spec
    await call(h, ep, 'webRequest', 'addListener', [event, filter, own, id])
    id += 1
  }
}

describe('the response stage of a relayed media request (ext.response → webRequest events)', () => {
  it("emits onHeadersReceived then onResponseStarted at 'headers' for a non-3xx, with the status, the headers and fromCache false, under the onBeforeRequest's id (§7.5)", async () => {
    const h = harness()
    await h.runtime.attach(record(h, {}, manifest({ permissions: ['webRequest'] })))
    await sniffer(h, 'bg1')
    h.runtime.onRequest(requestEvent())
    expect(h.runtime.onResponse(responseEvent('headers'))).not.toBeNull()
    const before = heard(h, 'bg1', 'onBeforeRequest')
    const received = heard(h, 'bg1', 'onHeadersReceived')
    const started = heard(h, 'bg1', 'onResponseStarted')
    expect(before).toHaveLength(1)
    expect(received).toHaveLength(1)
    expect(started).toHaveLength(1)
    expect(received[0].requestId).toBe(before[0].requestId)
    expect(started[0].requestId).toBe(before[0].requestId)
    expect(received[0]).toMatchObject({
      url: CLIP,
      method: 'GET',
      type: 'media',
      frameId: 0,
      parentFrameId: -1,
      statusCode: 206,
      statusLine: 'HTTP/1.1 206 Partial Content',
      initiator: 'https://news.example'
    })
    expect(received[0].tabId).toBe(before[0].tabId)
    // onHeadersReceived carries no cache word; onResponseStarted says the origin answered (false).
    expect(received[0].fromCache).toBeUndefined()
    expect(started[0].fromCache).toBe(false)
    expect(started[0].statusCode).toBe(206)
    expect(started[0].responseHeaders).toEqual([
      { name: 'Content-Type', value: 'video/mp4' },
      { name: 'Content-Range', value: 'bytes 0-1023/4096' }
    ])
    // No ip on the phone; no redirect, no error yet.
    expect(started[0].ip).toBeUndefined()
    expect(heard(h, 'bg1', 'onBeforeRedirect')).toHaveLength(0)
    expect(heard(h, 'bg1', 'onCompleted')).toHaveLength(0)
    expect(heard(h, 'bg1', 'onErrorOccurred')).toHaveLength(0)
  })

  it("emits onCompleted at 'complete' with the status and headers repeated (Chrome's onCompleted carries them) and fromCache false", async () => {
    const h = harness()
    await h.runtime.attach(record(h, {}, manifest({ permissions: ['webRequest'] })))
    await sniffer(h, 'bg1')
    h.runtime.onRequest(requestEvent())
    h.runtime.onResponse(responseEvent('headers'))
    h.runtime.onResponse(responseEvent('complete'))
    const completed = heard(h, 'bg1', 'onCompleted')
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({
      requestId: '7',
      url: CLIP,
      statusCode: 206,
      statusLine: 'HTTP/1.1 206 Partial Content',
      fromCache: false
    })
    expect(completed[0].responseHeaders).toHaveLength(2)
    expect(heard(h, 'bg1', 'onErrorOccurred')).toHaveLength(0)
  })

  it("emits onErrorOccurred at 'error' with the net::ERR_* name and no status (the element sought, WebView closed the stream)", async () => {
    const h = harness()
    await h.runtime.attach(record(h, {}, manifest({ permissions: ['webRequest'] })))
    await sniffer(h, 'bg1')
    h.runtime.onRequest(requestEvent())
    h.runtime.onResponse(responseEvent('headers'))
    h.runtime.onResponse(responseEvent('error', { error: 'net::ERR_ABORTED' }))
    const failed = heard(h, 'bg1', 'onErrorOccurred')
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({
      requestId: '7',
      url: CLIP,
      error: 'net::ERR_ABORTED',
      fromCache: false
    })
    expect(failed[0].statusCode).toBeUndefined()
    expect(failed[0].responseHeaders).toBeUndefined()
    expect(heard(h, 'bg1', 'onCompleted')).toHaveLength(0)
    // The relay's own failure before any headers: the error alone, under the request's id.
    h.runtime.onRequest(requestEvent({ requestId: '8', url: 'https://cdn.example/other.mp4' }))
    h.runtime.onResponse(
      responseEvent('error', {
        requestId: '8',
        url: 'https://cdn.example/other.mp4',
        statusCode: 0,
        statusLine: '',
        responseHeaders: [],
        error: 'net::ERR_CONNECTION_FAILED'
      })
    )
    expect(heard(h, 'bg1', 'onErrorOccurred').at(-1)).toMatchObject({
      requestId: '8',
      error: 'net::ERR_CONNECTION_FAILED'
    })
    expect(heard(h, 'bg1', 'onHeadersReceived')).toHaveLength(1)
  })

  it("emits onHeadersReceived then onBeforeRedirect at a 3xx 'headers' with redirectUrl resolved against the request URL, and the target's request continues under the same id (§7.3: WebView follows the hop itself)", async () => {
    const h = harness()
    await h.runtime.attach(record(h, {}, manifest({ permissions: ['webRequest'] })))
    await sniffer(h, 'bg1')
    h.runtime.onRequest(
      requestEvent({ requestId: '7', url: 'https://cdn.example/redirect?to=/clip.mp4' })
    )
    h.runtime.onResponse(
      responseEvent('headers', {
        requestId: '7',
        url: 'https://cdn.example/redirect?to=/clip.mp4',
        statusCode: 302,
        statusLine: 'HTTP/1.1 302 Found',
        responseHeaders: [
          { name: 'Location', value: '/clip.mp4' },
          { name: 'Content-Length', value: '0' }
        ]
      })
    )
    const received = heard(h, 'bg1', 'onHeadersReceived')
    const redirected = heard(h, 'bg1', 'onBeforeRedirect')
    expect(received).toHaveLength(1)
    expect(received[0].statusCode).toBe(302)
    expect(redirected).toHaveLength(1)
    expect(redirected[0]).toMatchObject({
      requestId: '7',
      url: 'https://cdn.example/redirect?to=/clip.mp4',
      statusCode: 302,
      statusLine: 'HTTP/1.1 302 Found',
      redirectUrl: CLIP,
      fromCache: false
    })
    expect(redirected[0].responseHeaders).toEqual([
      { name: 'Location', value: '/clip.mp4' },
      { name: 'Content-Length', value: '0' }
    ])
    // The hop has no onResponseStarted and no end of its own.
    expect(heard(h, 'bg1', 'onResponseStarted')).toHaveLength(0)
    expect(heard(h, 'bg1', 'onCompleted')).toHaveLength(0)
    // The target comes through the intercept as a NEW request under a NEW ext.request id (9):
    // its onBeforeRequest and its whole response stage run under the chain's id, 7.
    h.runtime.onRequest(requestEvent({ requestId: '9', url: CLIP }))
    const before = heard(h, 'bg1', 'onBeforeRequest')
    expect(before).toHaveLength(2)
    expect(before[1]).toMatchObject({ requestId: '7', url: CLIP })
    h.runtime.onResponse(responseEvent('headers', { requestId: '9' }))
    h.runtime.onResponse(responseEvent('complete', { requestId: '9' }))
    expect(heard(h, 'bg1', 'onHeadersReceived')[1]).toMatchObject({
      requestId: '7',
      url: CLIP,
      statusCode: 206
    })
    expect(heard(h, 'bg1', 'onResponseStarted')[0]).toMatchObject({ requestId: '7', url: CLIP })
    expect(heard(h, 'bg1', 'onCompleted')[0]).toMatchObject({
      requestId: '7',
      url: CLIP,
      statusCode: 206
    })
    // A later, unrelated request of the same URL is its own: the mark was consumed by the target.
    h.runtime.onRequest(requestEvent({ requestId: '12', url: CLIP }))
    expect(heard(h, 'bg1', 'onBeforeRequest')[2]).toMatchObject({ requestId: '12', url: CLIP })
    // A hop in another tab does not pair with this tab's target.
    h.runtime.onRequest(
      requestEvent({ requestId: '13', url: 'https://cdn.example/redirect?to=/b.mp4', tabId: 't1' })
    )
    h.runtime.onResponse(
      responseEvent('headers', {
        requestId: '13',
        url: 'https://cdn.example/redirect?to=/b.mp4',
        statusCode: 301,
        statusLine: 'HTTP/1.1 301 Moved Permanently',
        responseHeaders: [{ name: 'location', value: 'https://cdn.example/b.mp4' }]
      })
    )
    expect(heard(h, 'bg1', 'onBeforeRedirect')[1]).toMatchObject({
      requestId: '13',
      redirectUrl: 'https://cdn.example/b.mp4'
    })
    h.tabs.t2 = { ...h.tabs.t1, id: 't2' }
    h.runtime.onRequest(
      requestEvent({ requestId: '14', url: 'https://cdn.example/b.mp4', tabId: 't2' })
    )
    expect(heard(h, 'bg1', 'onBeforeRequest').at(-1)).toMatchObject({ requestId: '14' })
  })

  it("a 3xx without a Location (a 304) is one the relay closed too: onHeadersReceived, onResponseStarted and onCompleted at once, as the relay's observation of it ended", async () => {
    const h = harness()
    await h.runtime.attach(record(h, {}, manifest({ permissions: ['webRequest'] })))
    await sniffer(h, 'bg1')
    h.runtime.onRequest(requestEvent())
    h.runtime.onResponse(
      responseEvent('headers', {
        statusCode: 304,
        statusLine: 'HTTP/1.1 304 Not Modified',
        responseHeaders: [{ name: 'ETag', value: '"abc"' }]
      })
    )
    expect(heard(h, 'bg1', 'onHeadersReceived')).toHaveLength(1)
    expect(heard(h, 'bg1', 'onBeforeRedirect')).toHaveLength(0)
    expect(heard(h, 'bg1', 'onResponseStarted')[0]).toMatchObject({
      requestId: '7',
      statusCode: 304,
      fromCache: false
    })
    expect(heard(h, 'bg1', 'onCompleted')[0]).toMatchObject({ requestId: '7', statusCode: 304 })
  })

  it('cuts the headers per listener: none without responseHeaders in the spec, set-cookie only with extraHeaders besides (Chrome since 72), the same event to each', async () => {
    const h = harness()
    await h.runtime.attach(record(h, {}, manifest({ permissions: ['webRequest'] })))
    backgroundUp(h, 'bg1')
    // Three listeners of onResponseStarted: bare, with responseHeaders, with responseHeaders and extraHeaders.
    await call(h, 'bg1', 'webRequest', 'addListener', [
      'onResponseStarted',
      { urls: ['<all_urls>'] },
      [],
      1
    ])
    await call(h, 'bg1', 'webRequest', 'addListener', [
      'onResponseStarted',
      { urls: ['<all_urls>'] },
      ['responseHeaders'],
      2
    ])
    await call(h, 'bg1', 'webRequest', 'addListener', [
      'onResponseStarted',
      { urls: ['<all_urls>'] },
      ['responseHeaders', 'extraHeaders'],
      3
    ])
    h.runtime.onRequest(requestEvent())
    h.runtime.onResponse(responseEvent('headers'))
    const deliveries = events(h, 'bg1', 'webRequest.onResponseStarted')
    expect(deliveries).toHaveLength(3)
    const byListener = new Map<number, Details>()
    for (const d of deliveries) {
      const matched = (d.delivery as { matched: number[] }).matched
      expect(matched).toHaveLength(1)
      byListener.set(matched[0], (d.args as Details[])[0])
    }
    expect(byListener.get(1)?.responseHeaders).toBeUndefined()
    expect(byListener.get(1)).toMatchObject({
      statusCode: 206,
      statusLine: 'HTTP/1.1 206 Partial Content'
    })
    expect(byListener.get(2)?.responseHeaders).toEqual([
      { name: 'Content-Type', value: 'video/mp4' },
      { name: 'Content-Range', value: 'bytes 0-1023/4096' }
    ])
    expect(byListener.get(3)?.responseHeaders).toEqual([
      { name: 'Content-Type', value: 'video/mp4' },
      { name: 'Content-Range', value: 'bytes 0-1023/4096' },
      { name: 'Set-Cookie', value: 'seen=1' }
    ])
    // The listener's own filter still applies: a types filter that excludes media hears nothing.
    await call(h, 'bg1', 'webRequest', 'addListener', [
      'onCompleted',
      { urls: ['<all_urls>'], types: ['image'] },
      ['responseHeaders'],
      4
    ])
    h.runtime.onResponse(responseEvent('complete'))
    expect(events(h, 'bg1', 'webRequest.onCompleted')).toHaveLength(0)
  })

  it('a malformed report or one after the switch went off emits nothing, and a response of a tab the extension cannot see (private) is not delivered', async () => {
    const h = harness()
    await h.runtime.attach(record(h, {}, manifest({ permissions: ['webRequest'] })))
    await sniffer(h, 'bg1')
    h.runtime.onRequest(requestEvent())
    expect(
      h.runtime.onResponse({ ...responseEvent('headers'), relayed: false } as never)
    ).toBeNull()
    expect(heard(h, 'bg1', 'onHeadersReceived')).toHaveLength(0)
    for (let id = 2; id <= 5; id++)
      await call(h, 'bg1', 'webRequest', 'removeListener', [
        ['onHeadersReceived', 'onResponseStarted', 'onBeforeRedirect', 'onCompleted'][id - 2],
        id
      ])
    expect(h.kt.calledWith('ext.observeResponses').at(-1)).toEqual({ on: false })
    expect(h.runtime.onResponse(responseEvent('headers'))).toBeNull()
    expect(heard(h, 'bg1', 'onHeadersReceived')).toHaveLength(0)
  })
})

describe("the page script's observer of a fetch / XHR (ext-observation → webRequest events)", () => {
  async function fetchSniffer(h: Harness): Promise<void> {
    await h.runtime.attach(record(h, {}, manifest({ permissions: ['webRequest'] })))
    await sniffer(h, 'bg1')
    expect(h.kt.calledWith('ext.observeResponses').at(-1)).toEqual({ on: true })
  }

  it("pairs a fetch's 'headers' report with the intercept's onBeforeRequest of the same tab, URL and method and emits onHeadersReceived and onResponseStarted under that id; 'complete' finds the pair by the observer's sequence and emits onCompleted", async () => {
    const h = harness()
    await fetchSniffer(h)
    const url = 'https://news.example/api/segment-1.m4s'
    h.runtime.onRequest(requestEvent({ requestId: '21', url, type: 'xmlhttprequest' }))
    h.runtime.onViewEvent('t1', 'pageMessage', observation({ url }) as never)
    const received = heard(h, 'bg1', 'onHeadersReceived')
    const started = heard(h, 'bg1', 'onResponseStarted')
    expect(received).toHaveLength(1)
    expect(started).toHaveLength(1)
    expect(received[0]).toMatchObject({
      requestId: '21',
      url,
      method: 'GET',
      type: 'xmlhttprequest',
      initiator: 'https://news.example',
      statusCode: 200,
      statusLine: 'HTTP/1.1 200 OK'
    })
    expect(received[0].responseHeaders).toEqual([
      { name: 'content-type', value: 'video/iso.segment' },
      { name: 'content-length', value: '4096' }
    ])
    expect(started[0]).toMatchObject({ requestId: '21', fromCache: false })
    expect(heard(h, 'bg1', 'onCompleted')).toHaveLength(0)
    h.runtime.onViewEvent('t1', 'pageMessage', observation({ url, at: 'complete' }) as never)
    const completed = heard(h, 'bg1', 'onCompleted')
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ requestId: '21', url, statusCode: 200, fromCache: false })
    // The pair is done: a second 'complete' of the same sequence pairs afresh (the runtime's own id).
    h.runtime.onViewEvent('t1', 'pageMessage', observation({ url, at: 'complete' }) as never)
    expect(heard(h, 'bg1', 'onCompleted')[1].requestId).not.toBe('21')
  })

  it('pairs by URL and order: two requests of one URL in flight pair with the observations in the order the observations come (the stated limit), and a report without a request stage gets an id of the runtime’s own', async () => {
    const h = harness()
    await fetchSniffer(h)
    const url = 'https://news.example/api/poll.json'
    h.runtime.onRequest(requestEvent({ requestId: '31', url, type: 'xmlhttprequest' }))
    h.runtime.onRequest(requestEvent({ requestId: '32', url, type: 'xmlhttprequest' }))
    h.runtime.onViewEvent('t1', 'pageMessage', observation({ url, seq: 'doc-1' }) as never)
    h.runtime.onViewEvent('t1', 'pageMessage', observation({ url, seq: 'doc-2' }) as never)
    const received = heard(h, 'bg1', 'onHeadersReceived')
    expect(received.map((d) => d.requestId)).toEqual(['31', '32'])
    // A third observation with no unclaimed request of its URL: the runtime mints an id far from Kotlin's.
    h.runtime.onViewEvent('t1', 'pageMessage', observation({ url, seq: 'doc-3' }) as never)
    const minted = heard(h, 'bg1', 'onHeadersReceived')[2].requestId
    expect(Number(minted)).toBeGreaterThan(2_000_000_000)
    expect(heard(h, 'bg1', 'onHeadersReceived')[2].type).toBe('xmlhttprequest')
    // A POST observation does not claim a GET's request stage.
    h.runtime.onRequest(requestEvent({ requestId: '33', url, type: 'xmlhttprequest' }))
    h.runtime.onViewEvent(
      't1',
      'pageMessage',
      observation({ url, seq: 'doc-4', method: 'POST' }) as never
    )
    expect(heard(h, 'bg1', 'onHeadersReceived')[3].requestId).not.toBe('33')
    h.runtime.onViewEvent('t1', 'pageMessage', observation({ url, seq: 'doc-5' }) as never)
    expect(heard(h, 'bg1', 'onHeadersReceived')[4].requestId).toBe('33')
  })

  it('drops what the relay served (asked first, the shared selection: a same-origin ranged GET) so no response is reported twice, and everything while the switch is off', async () => {
    const h = harness()
    await fetchSniffer(h)
    const url = 'https://news.example/clip.mp4'
    h.runtime.onRequest(requestEvent({ requestId: '41', url }))
    // The relay served this one (Range, no Origin): its ext.response is the report; the observation is dropped.
    h.runtime.onViewEvent('t1', 'pageMessage', observation({ url, range: 'bytes=0-' }) as never)
    expect(heard(h, 'bg1', 'onHeadersReceived')).toHaveLength(0)
    h.runtime.onResponse(responseEvent('headers', { requestId: '41', url }))
    expect(heard(h, 'bg1', 'onHeadersReceived')).toHaveLength(1)
    expect(heard(h, 'bg1', 'onHeadersReceived')[0].requestId).toBe('41')
    // A cross-origin ranged fetch carried Origin: not relayed, the observer's to report.
    h.runtime.onRequest(requestEvent({ requestId: '42', url: 'https://cdn.example/x.mp4' }))
    h.runtime.onViewEvent(
      't1',
      'pageMessage',
      observation({
        url: 'https://cdn.example/x.mp4',
        range: 'bytes=0-',
        crossOrigin: true,
        seq: 'doc-2',
        status: 206,
        statusText: 'Partial Content'
      }) as never
    )
    expect(heard(h, 'bg1', 'onHeadersReceived')[1]).toMatchObject({
      requestId: '42',
      statusCode: 206,
      statusLine: 'HTTP/1.1 206 Partial Content'
    })
    // Malformed: not an observation (no seq, a status the page cannot have seen, a data: URL).
    h.runtime.onViewEvent('t1', 'pageMessage', { ...observation(), seq: '' } as never)
    h.runtime.onViewEvent('t1', 'pageMessage', { ...observation(), status: 0 } as never)
    h.runtime.onViewEvent('t1', 'pageMessage', {
      ...observation(),
      url: 'data:text/plain,x'
    } as never)
    h.runtime.onViewEvent('t1', 'pageMessage', { type: 'media', playing: true } as never)
    expect(heard(h, 'bg1', 'onHeadersReceived')).toHaveLength(2)
    // The switch off: the observation is nobody's.
    for (let id = 2; id <= 5; id++)
      await call(h, 'bg1', 'webRequest', 'removeListener', [
        ['onHeadersReceived', 'onResponseStarted', 'onBeforeRedirect', 'onCompleted'][id - 2],
        id
      ])
    h.runtime.onViewEvent('t1', 'pageMessage', observation({ seq: 'doc-9' }) as never)
    expect(heard(h, 'bg1', 'onHeadersReceived')).toHaveLength(2)
  })

  it("a redirected fetch is reported under the first request's id with the final URL (the page does not see the hop); a new document drops the old one's pending pairs", async () => {
    const h = harness()
    await fetchSniffer(h)
    const first = 'https://news.example/redirect?to=/clip.json'
    const final = 'https://news.example/clip.json'
    h.runtime.onRequest(requestEvent({ requestId: '51', url: first, type: 'xmlhttprequest' }))
    h.runtime.onRequest(requestEvent({ requestId: '52', url: final, type: 'xmlhttprequest' }))
    h.runtime.onViewEvent(
      't1',
      'pageMessage',
      observation({ url: first, finalUrl: final }) as never
    )
    expect(heard(h, 'bg1', 'onHeadersReceived')[0]).toMatchObject({ requestId: '51', url: final })
    expect(heard(h, 'bg1', 'onResponseStarted')[0]).toMatchObject({ requestId: '51', url: final })
    // The document changes: the pending pair is the old document's; the new document's 'complete' of the same sequence pairs afresh.
    h.runtime.onViewEvent('t1', 'navigated', {
      url: 'https://news.example/next',
      inPage: false
    } as never)
    h.runtime.onViewEvent(
      't1',
      'pageMessage',
      observation({ url: first, finalUrl: final, at: 'complete' }) as never
    )
    expect(heard(h, 'bg1', 'onCompleted')[0].requestId).not.toBe('51')
  })
})
