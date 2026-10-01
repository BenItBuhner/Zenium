import { describe, expect, it } from 'vitest'
import type { ExtRequestEvent, ExtResponseEvent } from '../extensionRuntime'
import {
  backgroundUp,
  call,
  events,
  harness,
  ID,
  ID2,
  manifest,
  record,
  type Harness
} from './runtimeHarness'

/**
 * The `webRequest` report of an extension page's own subresource loads (compat round 27,
 * R27-2): what Kotlin's `Extensions.interceptPageRequest` emits for a load an extension view
 * made – a tab-less `ext.request` whose `initiator` is the extension's served origin, and the
 * response stage `PageRequestReport` relays or reads off the host's own answer – and what the
 * runtime makes of it: `tabId -1`, the initiator on every event, the owner alone addressed
 * (Chrome's `WebRequestPermissions::CanExtensionAccessURL`: host access to one's own origin,
 * never to another extension's).
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

const ORIGIN = `https://${ID}.ext.zenium.invalid`
const ORIGIN2 = `https://${ID2}.ext.zenium.invalid`
const PATH2 = `/data/user/0/app.zen.chromium/files/zen/extensions/${ID2}/1.0.0`
const PHOTO = 'https://photos.example/photo-1.jpg'

/** The shape `PageRequestReport.request` posts: no tab, the page's origin, an allow of document 0. */
function pageLoad(over: Partial<ExtRequestEvent> = {}): ExtRequestEvent {
  return {
    tabId: null,
    requestId: '41',
    url: PHOTO,
    type: 'image',
    method: 'GET',
    initiator: ORIGIN,
    mainFrame: false,
    document: 0,
    redirectedFrom: null,
    action: 'allow',
    matchedSet: null,
    matchedRule: null,
    micros: 0,
    cpuMicros: null,
    ...over
  }
}

/** The shape `PageRequestReport.response` posts, relayed, no tab. */
function pageResponse(
  at: 'headers' | 'complete' | 'error',
  over: Partial<ExtResponseEvent> = {}
): ExtResponseEvent {
  return {
    tabId: null,
    requestId: '41',
    url: PHOTO,
    type: 'image',
    method: 'GET',
    statusCode: 200,
    statusLine: 'HTTP/1.1 200 OK',
    responseHeaders: [
      { name: 'Content-Type', value: 'image/jpeg' },
      { name: 'Content-Length', value: '48213' },
      { name: 'Set-Cookie', value: 'seen=1' }
    ],
    at,
    relayed: true,
    ...over
  }
}

function heard(h: Harness, ep: string, event: string): Details[] {
  return events(h, ep, `webRequest.${event}`).map((m) => (m.args as Details[])[0])
}

function names(h: Harness, ep: string): string[] {
  return h.kt
    .to(ep)
    .filter((m) => m.t === 'event' && m.ns === 'webRequest')
    .map((m) => String(m.name))
}

const STAGES = [
  'onBeforeRequest',
  'onHeadersReceived',
  'onResponseStarted',
  'onBeforeRedirect',
  'onCompleted',
  'onErrorOccurred'
]

/** A background up with one listener per event, `responseHeaders` asked for where Chrome allows it. */
async function sniffer(
  h: Harness,
  ep: string,
  filter: Record<string, unknown> = { urls: ['<all_urls>'] }
): Promise<void> {
  let id = 1
  for (const event of STAGES) {
    const own =
      event === 'onBeforeRequest' || event === 'onErrorOccurred' ? [] : ['responseHeaders']
    await call(h, ep, 'webRequest', 'addListener', [event, filter, own, id])
    id += 1
  }
}

/** Image Downloader's shape: `webRequest` and the photo host, a background that sniffs everything. */
async function imageDownloader(h: Harness): Promise<void> {
  await h.runtime.attach(
    record(
      h,
      {},
      manifest({
        permissions: ['webRequest', 'storage'],
        host_permissions: ['<all_urls>']
      })
    )
  )
  backgroundUp(h, 'bg1')
  await sniffer(h, 'bg1')
}

/** A second extension, another id and origin, its own sniffing background. */
async function bystander(h: Harness): Promise<void> {
  await h.runtime.attach(
    record(
      h,
      { id: ID2, path: PATH2 },
      manifest({ permissions: ['webRequest'], host_permissions: ['<all_urls>'] })
    )
  )
  h.runtime.onMessage({
    ep: 'bg2',
    tabId: null,
    top: true,
    origin: ORIGIN2,
    message: { t: 'hello', ext: ID2, ctx: 'background', url: `${ORIGIN2}/bg.html`, world: false }
  })
  h.runtime.onMessage({ ep: 'bg2', tabId: null, top: true, origin: '', message: { t: 'ready' } })
  await sniffer(h, 'bg2')
}

describe("an extension page's own subresource load (a tab-less ext.request from the extension view's intercept)", () => {
  it('is onBeforeRequest with tabId -1, the extension origin as initiator, the type by destination and the outermost-frame words; the intercept was asked to observe', async () => {
    const h = harness()
    await imageDownloader(h)
    expect(h.kt.calledWith('ext.observeRequests').at(-1)).toEqual({ on: true })
    expect(h.kt.calledWith('ext.observeResponses').at(-1)).toEqual({ on: true })
    h.runtime.onRequest(pageLoad())
    const before = heard(h, 'bg1', 'onBeforeRequest')
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({
      requestId: '41',
      url: PHOTO,
      method: 'GET',
      type: 'image',
      tabId: -1,
      frameId: 0,
      parentFrameId: -1,
      frameType: 'outermost_frame',
      documentLifecycle: 'active',
      initiator: ORIGIN
    })
    expect(before[0].timeStamp).toBe(h.clock.now)
    // The page's own served files are reported too (Chrome reports a chrome-extension://
    // subresource of the page to its extension), under the same origin as initiator and URL.
    h.runtime.onRequest(pageLoad({ requestId: '42', url: `${ORIGIN}/icons/download.svg` }))
    expect(heard(h, 'bg1', 'onBeforeRequest')[1]).toMatchObject({
      requestId: '42',
      url: `${ORIGIN}/icons/download.svg`,
      initiator: ORIGIN,
      tabId: -1
    })
    expect(names(h, 'bg1')).toEqual(['onBeforeRequest', 'onBeforeRequest'])
  })

  it("is the owner's alone: another extension's sniffer hears nothing of it, hears a page's request as before, and hears its own pages' loads that the first does not", async () => {
    const h = harness()
    await imageDownloader(h)
    await bystander(h)
    h.runtime.onRequest(pageLoad())
    expect(heard(h, 'bg1', 'onBeforeRequest')).toHaveLength(1)
    expect(heard(h, 'bg2', 'onBeforeRequest')).toHaveLength(0)
    // A tab's own request, a web initiator: both hear it, as before.
    h.runtime.onRequest(
      pageLoad({ requestId: '43', tabId: 't1', initiator: 'https://news.example', document: 2 })
    )
    expect(heard(h, 'bg1', 'onBeforeRequest')).toHaveLength(2)
    expect(heard(h, 'bg2', 'onBeforeRequest')).toHaveLength(1)
    expect(heard(h, 'bg2', 'onBeforeRequest')[0]).toMatchObject({
      requestId: '43',
      initiator: 'https://news.example'
    })
    expect(heard(h, 'bg2', 'onBeforeRequest')[0].tabId).not.toBe(-1)
    // The second extension's own page loads something: its own, not the first's.
    h.runtime.onRequest(pageLoad({ requestId: '44', initiator: ORIGIN2 }))
    expect(heard(h, 'bg1', 'onBeforeRequest')).toHaveLength(2)
    expect(heard(h, 'bg2', 'onBeforeRequest')).toHaveLength(2)
    expect(heard(h, 'bg2', 'onBeforeRequest')[1]).toMatchObject({
      requestId: '44',
      initiator: ORIGIN2,
      tabId: -1
    })
    // The response stage follows the same rule: the first's load's answer is the first's alone.
    h.runtime.onResponse(pageResponse('headers'))
    h.runtime.onResponse(pageResponse('complete'))
    expect(heard(h, 'bg1', 'onCompleted')).toHaveLength(1)
    expect(heard(h, 'bg2', 'onHeadersReceived')).toHaveLength(0)
    expect(heard(h, 'bg2', 'onCompleted')).toHaveLength(0)
  })

  it("the response stage the relay reports: onHeadersReceived and onResponseStarted at 'headers', onCompleted at 'complete' with the status, the headers and fromCache false, under the request's id, tabId -1 and the initiator remembered; set-cookie cut without extraHeaders", async () => {
    const h = harness()
    await imageDownloader(h)
    h.runtime.onRequest(pageLoad())
    h.runtime.onResponse(pageResponse('headers'))
    const received = heard(h, 'bg1', 'onHeadersReceived')
    const started = heard(h, 'bg1', 'onResponseStarted')
    expect(received).toHaveLength(1)
    expect(started).toHaveLength(1)
    expect(received[0]).toMatchObject({
      requestId: '41',
      url: PHOTO,
      method: 'GET',
      type: 'image',
      tabId: -1,
      frameId: 0,
      parentFrameId: -1,
      initiator: ORIGIN,
      statusCode: 200,
      statusLine: 'HTTP/1.1 200 OK'
    })
    expect(received[0].fromCache).toBeUndefined()
    expect(started[0]).toMatchObject({ requestId: '41', tabId: -1, fromCache: false })
    expect(heard(h, 'bg1', 'onCompleted')).toHaveLength(0)
    h.runtime.onResponse(pageResponse('complete'))
    const completed = heard(h, 'bg1', 'onCompleted')
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({
      requestId: '41',
      url: PHOTO,
      type: 'image',
      tabId: -1,
      initiator: ORIGIN,
      statusCode: 200,
      statusLine: 'HTTP/1.1 200 OK',
      fromCache: false
    })
    expect(completed[0].responseHeaders).toEqual([
      { name: 'Content-Type', value: 'image/jpeg' },
      { name: 'Content-Length', value: '48213' }
    ])
    expect(completed[0].ip).toBeUndefined()
    expect(names(h, 'bg1')).toEqual([
      'onBeforeRequest',
      'onHeadersReceived',
      'onResponseStarted',
      'onCompleted'
    ])
    // The host's own answer of a served file comes as the same two reports (`answered`): the
    // Content-Type the host composed, no Content-Length.
    h.runtime.onRequest(
      pageLoad({ requestId: '42', url: `${ORIGIN}/popup.css`, type: 'stylesheet' })
    )
    const own: Partial<ExtResponseEvent> = {
      requestId: '42',
      url: `${ORIGIN}/popup.css`,
      type: 'stylesheet',
      responseHeaders: [
        { name: 'Content-Type', value: 'text/css; charset=utf-8' },
        { name: 'Cache-Control', value: 'no-store' }
      ]
    }
    h.runtime.onResponse(pageResponse('headers', own))
    h.runtime.onResponse(pageResponse('complete', own))
    expect(heard(h, 'bg1', 'onCompleted')[1]).toMatchObject({
      requestId: '42',
      url: `${ORIGIN}/popup.css`,
      type: 'stylesheet',
      initiator: ORIGIN,
      statusCode: 200
    })
    expect(heard(h, 'bg1', 'onCompleted')[1].responseHeaders).toEqual([
      { name: 'Content-Type', value: 'text/css; charset=utf-8' },
      { name: 'Cache-Control', value: 'no-store' }
    ])
  })

  it("a 3xx the relay reports: onHeadersReceived then onBeforeRedirect with redirectUrl resolved against the URL, and the target's own tab-less ext.request under a new id continues under the chain's id to its onCompleted", async () => {
    const h = harness()
    await imageDownloader(h)
    const hop = 'https://photos.example/r/photo-1'
    h.runtime.onRequest(pageLoad({ requestId: '41', url: hop }))
    h.runtime.onResponse(
      pageResponse('headers', {
        requestId: '41',
        url: hop,
        statusCode: 302,
        statusLine: 'HTTP/1.1 302 Found',
        responseHeaders: [
          { name: 'Location', value: '/cdn/photo-1.jpg?s=large' },
          { name: 'Content-Length', value: '0' }
        ]
      })
    )
    const target = 'https://photos.example/cdn/photo-1.jpg?s=large'
    const redirected = heard(h, 'bg1', 'onBeforeRedirect')
    expect(heard(h, 'bg1', 'onHeadersReceived')[0]).toMatchObject({
      requestId: '41',
      statusCode: 302,
      tabId: -1
    })
    expect(redirected).toHaveLength(1)
    expect(redirected[0]).toMatchObject({
      requestId: '41',
      url: hop,
      tabId: -1,
      initiator: ORIGIN,
      statusCode: 302,
      statusLine: 'HTTP/1.1 302 Found',
      redirectUrl: target,
      fromCache: false
    })
    expect(heard(h, 'bg1', 'onResponseStarted')).toHaveLength(0)
    // The relay followed the hop and posted the target as a new ext.request (a new id): its
    // request stage and its whole response stage run under the chain's id, 41.
    h.runtime.onRequest(pageLoad({ requestId: '101', url: target }))
    expect(heard(h, 'bg1', 'onBeforeRequest')).toHaveLength(2)
    expect(heard(h, 'bg1', 'onBeforeRequest')[1]).toMatchObject({
      requestId: '41',
      url: target,
      tabId: -1,
      initiator: ORIGIN
    })
    h.runtime.onResponse(pageResponse('headers', { requestId: '101', url: target }))
    h.runtime.onResponse(pageResponse('complete', { requestId: '101', url: target }))
    expect(heard(h, 'bg1', 'onHeadersReceived')[1]).toMatchObject({
      requestId: '41',
      url: target,
      statusCode: 200
    })
    expect(heard(h, 'bg1', 'onCompleted')[0]).toMatchObject({
      requestId: '41',
      url: target,
      statusCode: 200,
      tabId: -1,
      initiator: ORIGIN
    })
    expect(names(h, 'bg1')).toEqual([
      'onBeforeRequest',
      'onHeadersReceived',
      'onBeforeRedirect',
      'onBeforeRequest',
      'onHeadersReceived',
      'onResponseStarted',
      'onCompleted'
    ])
    // A later load of the target by the page is its own request again.
    h.runtime.onRequest(pageLoad({ requestId: '102', url: target }))
    expect(heard(h, 'bg1', 'onBeforeRequest')[2]).toMatchObject({ requestId: '102', url: target })
  })

  it('a failure the relay reports – no connection, a status it refused, too many hops – is onErrorOccurred with the net::ERR_* name and no status; a 304 is headers, started and completed at once', async () => {
    const h = harness()
    await imageDownloader(h)
    h.runtime.onRequest(pageLoad())
    h.runtime.onResponse(
      pageResponse('error', {
        statusCode: 0,
        statusLine: '',
        responseHeaders: [],
        error: 'net::ERR_CONNECTION_FAILED'
      })
    )
    const failed = heard(h, 'bg1', 'onErrorOccurred')
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({
      requestId: '41',
      url: PHOTO,
      tabId: -1,
      initiator: ORIGIN,
      error: 'net::ERR_CONNECTION_FAILED',
      fromCache: false
    })
    expect(failed[0].statusCode).toBeUndefined()
    expect(failed[0].responseHeaders).toBeUndefined()
    expect(heard(h, 'bg1', 'onHeadersReceived')).toHaveLength(0)
    // The stream closed early after the headers: the headers stood, then the error.
    h.runtime.onRequest(pageLoad({ requestId: '42' }))
    h.runtime.onResponse(pageResponse('headers', { requestId: '42' }))
    h.runtime.onResponse(pageResponse('error', { requestId: '42', error: 'net::ERR_ABORTED' }))
    expect(heard(h, 'bg1', 'onHeadersReceived')).toHaveLength(1)
    expect(heard(h, 'bg1', 'onErrorOccurred')[1]).toMatchObject({
      requestId: '42',
      error: 'net::ERR_ABORTED'
    })
    expect(heard(h, 'bg1', 'onCompleted')).toHaveLength(0)
    // The relay's hop ceiling: the chain ends in the error under the chain's id.
    h.runtime.onRequest(pageLoad({ requestId: '43', url: 'https://photos.example/loop' }))
    h.runtime.onResponse(
      pageResponse('error', {
        requestId: '43',
        url: 'https://photos.example/loop',
        statusCode: 0,
        statusLine: '',
        responseHeaders: [],
        error: 'net::ERR_TOO_MANY_REDIRECTS'
      })
    )
    expect(heard(h, 'bg1', 'onErrorOccurred')[2]).toMatchObject({
      requestId: '43',
      error: 'net::ERR_TOO_MANY_REDIRECTS'
    })
    // A 304: the relay returned the request to WebView; as relayed it ended with the headers.
    h.runtime.onRequest(pageLoad({ requestId: '44' }))
    h.runtime.onResponse(
      pageResponse('headers', {
        requestId: '44',
        statusCode: 304,
        statusLine: 'HTTP/1.1 304 Not Modified',
        responseHeaders: [{ name: 'ETag', value: '"abc"' }]
      })
    )
    expect(heard(h, 'bg1', 'onResponseStarted').at(-1)).toMatchObject({
      requestId: '44',
      statusCode: 304,
      tabId: -1
    })
    expect(heard(h, 'bg1', 'onCompleted').at(-1)).toMatchObject({
      requestId: '44',
      statusCode: 304
    })
  })

  it("the listener's own filter decides what it hears: a types filter, a urls filter on the photo host or on the extension's own origin; nothing of the response stage once its listeners are gone, nothing at all without listeners", async () => {
    const h = harness()
    await h.runtime.attach(
      record(h, {}, manifest({ permissions: ['webRequest'], host_permissions: ['<all_urls>'] }))
    )
    backgroundUp(h, 'bg1')
    await call(h, 'bg1', 'webRequest', 'addListener', [
      'onBeforeRequest',
      { urls: ['<all_urls>'], types: ['image'] },
      [],
      1
    ])
    await call(h, 'bg1', 'webRequest', 'addListener', [
      'onCompleted',
      { urls: ['*://photos.example/*'] },
      ['responseHeaders'],
      2
    ])
    await call(h, 'bg1', 'webRequest', 'addListener', [
      'onCompleted',
      { urls: [`${ORIGIN}/*`] },
      [],
      3
    ])
    h.runtime.onRequest(pageLoad())
    h.runtime.onRequest(pageLoad({ requestId: '42', url: `${ORIGIN}/popup.js`, type: 'script' }))
    const before = events(h, 'bg1', 'webRequest.onBeforeRequest')
    expect(before).toHaveLength(1)
    expect((before[0].args as Details[])[0]).toMatchObject({ requestId: '41', type: 'image' })
    h.runtime.onResponse(pageResponse('headers'))
    h.runtime.onResponse(pageResponse('complete'))
    const own: Partial<ExtResponseEvent> = {
      requestId: '42',
      url: `${ORIGIN}/popup.js`,
      type: 'script',
      responseHeaders: [{ name: 'Content-Type', value: 'text/javascript; charset=utf-8' }]
    }
    h.runtime.onResponse(pageResponse('headers', own))
    h.runtime.onResponse(pageResponse('complete', own))
    const completed = events(h, 'bg1', 'webRequest.onCompleted')
    expect(completed).toHaveLength(2)
    expect(completed[0].delivery).toEqual({ unfiltered: false, matched: [2] })
    expect((completed[0].args as Details[])[0]).toMatchObject({ requestId: '41', url: PHOTO })
    expect((completed[0].args as Details[])[0].responseHeaders).toHaveLength(2)
    expect(completed[1].delivery).toEqual({ unfiltered: false, matched: [3] })
    expect((completed[1].args as Details[])[0]).toMatchObject({
      requestId: '42',
      url: `${ORIGIN}/popup.js`
    })
    expect((completed[1].args as Details[])[0].responseHeaders).toBeUndefined()
    // The response-stage listeners gone: the switch goes off and a report is nobody's.
    await call(h, 'bg1', 'webRequest', 'removeListener', ['onCompleted', 2])
    await call(h, 'bg1', 'webRequest', 'removeListener', ['onCompleted', 3])
    expect(h.kt.calledWith('ext.observeResponses').at(-1)).toEqual({ on: false })
    expect(h.kt.calledWith('ext.observeRequests').at(-1)).toEqual({ on: true })
    h.runtime.onRequest(pageLoad({ requestId: '43' }))
    expect(h.runtime.onResponse(pageResponse('headers', { requestId: '43' }))).toBeNull()
    expect(events(h, 'bg1', 'webRequest.onBeforeRequest')).toHaveLength(2)
    expect(events(h, 'bg1', 'webRequest.onCompleted')).toHaveLength(2)
    // The last listener gone: the intercept is told to stop observing.
    await call(h, 'bg1', 'webRequest', 'removeListener', ['onBeforeRequest', 1])
    expect(h.kt.calledWith('ext.observeRequests').at(-1)).toEqual({ on: false })
  })
})
