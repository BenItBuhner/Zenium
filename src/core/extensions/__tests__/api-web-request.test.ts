import { describe, expect, it } from 'vitest'
import {
  BLOCKING_EVENT_NAMES,
  EXTRA_INFO_SPECS,
  WEB_REQUEST_EVENT_NAMES,
  canAccessRequest,
  chromeRequestDetails,
  compileRequestFilter,
  isWebRequestUrl,
  normalizeBlockingResponse,
  normalizeRequestListener,
  requestBodyFrom,
  requestFilterMatches,
  requestHeadersFrom,
  responseHeadersFrom,
  toHttpHeaders,
  type HostRequestDetails,
  type RequestProbe
} from '../api/webRequest'

const SELF = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

describe('the event table', () => {
  it('lists the nine Chrome events with their extraInfoSpec enums', () => {
    expect(WEB_REQUEST_EVENT_NAMES).toHaveLength(9)
    for (const event of WEB_REQUEST_EVENT_NAMES) expect(EXTRA_INFO_SPECS[event]).toBeDefined()
    expect(EXTRA_INFO_SPECS.onBeforeRequest).toEqual(['blocking', 'requestBody', 'extraHeaders'])
    expect(EXTRA_INFO_SPECS.onErrorOccurred).toEqual(['extraHeaders'])
    expect([...BLOCKING_EVENT_NAMES].sort()).toEqual([
      'onAuthRequired',
      'onBeforeRequest',
      'onBeforeSendHeaders',
      'onHeadersReceived'
    ])
    // Only the blocking events accept `blocking` in their spec.
    for (const event of WEB_REQUEST_EVENT_NAMES) {
      expect(EXTRA_INFO_SPECS[event].includes('blocking')).toBe(BLOCKING_EVENT_NAMES.has(event))
    }
  })
})

describe('isWebRequestUrl', () => {
  it('accepts the schemes a host permission can name and nothing else', () => {
    for (const url of [
      'https://a.example/',
      'http://a.example/x',
      'ws://a.example/socket',
      'wss://a.example/socket',
      'file:///home/me/page.html',
      'ftp://files.example/',
      'HTTPS://upper.example/'
    ]) {
      expect(isWebRequestUrl(url)).toBe(true)
    }
    for (const url of [
      `chrome-extension://${SELF}/popup.html`,
      'data:text/plain,hi',
      'blob:https://a.example/uuid',
      'chrome://settings/',
      'about:blank',
      'javascript:void 0',
      'not a url',
      ''
    ]) {
      expect(isWebRequestUrl(url)).toBe(false)
    }
  })
})

describe('canAccessRequest', () => {
  const allow =
    (...prefixes: string[]): ((url: string) => boolean) =>
    (url) =>
      prefixes.some((p) => url.startsWith(p))

  it('needs host access to the URL first', () => {
    const request = { url: 'https://cdn.example/a.js', type: 'script' as const, initiator: null }
    expect(canAccessRequest(allow('https://cdn.example/'), request, SELF)).toBe(true)
    expect(canAccessRequest(allow('https://other.example/'), request, SELF)).toBe(false)
    // Schemes the API never reports fail even with `<all_urls>`-style access.
    expect(
      canAccessRequest(
        () => true,
        { url: `chrome-extension://${OTHER}/r.js`, type: 'script', initiator: null },
        SELF
      )
    ).toBe(false)
  })

  it('lets navigations through on the URL alone', () => {
    const only = allow('https://site.example/')
    expect(
      canAccessRequest(
        only,
        { url: 'https://site.example/', type: 'main_frame', initiator: 'https://referrer.example' },
        SELF
      )
    ).toBe(true)
    expect(
      canAccessRequest(
        only,
        { url: 'https://site.example/f', type: 'sub_frame', initiator: 'https://top.example' },
        SELF
      )
    ).toBe(true)
  })

  it('needs access to the initiator of a sub-resource, unless it is unknown or opaque', () => {
    const only = allow('https://cdn.example/')
    const sub = (initiator: string | null): Parameters<typeof canAccessRequest>[1] => ({
      url: 'https://cdn.example/a.js',
      type: 'script',
      initiator
    })
    expect(canAccessRequest(only, sub('https://page.example'), SELF)).toBe(false)
    expect(
      canAccessRequest(
        allow('https://cdn.example/', 'https://page.example/'),
        sub('https://page.example'),
        SELF
      )
    ).toBe(true)
    expect(canAccessRequest(only, sub(null), SELF)).toBe(true)
    expect(canAccessRequest(only, sub('null'), SELF)).toBe(true)
    // Initiators outside the web (a chrome: page) do not gate the request.
    expect(canAccessRequest(only, sub('chrome://newtab'), SELF)).toBe(true)
  })

  it("passes the extension's own pages as initiator and never another extension's", () => {
    const only = allow('https://cdn.example/')
    const from = (initiator: string): Parameters<typeof canAccessRequest>[1] => ({
      url: 'https://cdn.example/a.js',
      type: 'xmlhttprequest',
      initiator
    })
    expect(canAccessRequest(only, from(`chrome-extension://${SELF}`), SELF)).toBe(true)
    expect(canAccessRequest(() => true, from(`chrome-extension://${OTHER}`), SELF)).toBe(false)
  })
})

describe('normalizeRequestListener', () => {
  it('accepts a minimal filter, compiles the spec flags and drops duplicates', () => {
    expect(
      normalizeRequestListener('onBeforeRequest', { urls: ['<all_urls>'] }, undefined)
    ).toEqual({
      filter: { urls: ['<all_urls>'] },
      extraInfoSpec: [],
      blocking: false
    })
    expect(
      normalizeRequestListener(
        'onBeforeRequest',
        { urls: [], types: ['script'], tabId: 4, windowId: 2 },
        ['blocking', 'requestBody', 'blocking']
      )
    ).toEqual({
      filter: { urls: [], types: ['script'], tabId: 4, windowId: 2 },
      extraInfoSpec: ['blocking', 'requestBody'],
      blocking: true
    })
    expect(
      normalizeRequestListener('onAuthRequired', { urls: ['https://*/*'] }, ['asyncBlocking'])
        .blocking
    ).toBe(true)
    // `null` optional fields are left out, as the binding treats them.
    expect(
      normalizeRequestListener(
        'onCompleted',
        { urls: ['*://*.example/*'], types: null, tabId: null, windowId: null },
        null
      ).filter
    ).toEqual({ urls: ['*://*.example/*'] })
  })

  it("throws the binding's TypeErrors for a malformed filter", () => {
    const signature =
      'webRequest.onBeforeRequest.addListener(function callback, webRequest.RequestFilter filter, optional array extraInfoSpec)'
    expect(() => normalizeRequestListener('onBeforeRequest', undefined, undefined)).toThrow(
      new TypeError(`Error in invocation of ${signature}: No matching signature.`)
    )
    expect(() => normalizeRequestListener('onBeforeRequest', {}, undefined)).toThrow(
      /Error at property 'urls': Invalid type: expected array\./
    )
    expect(() => normalizeRequestListener('onBeforeRequest', { urls: [1] }, undefined)).toThrow(
      /Error at property 'urls': Invalid type: expected string\./
    )
    expect(() =>
      normalizeRequestListener(
        'onBeforeRequest',
        { urls: ['<all_urls>'], types: 'script' },
        undefined
      )
    ).toThrow(/Error at property 'types': Invalid type: expected array\./)
    expect(() =>
      normalizeRequestListener(
        'onBeforeRequest',
        { urls: ['<all_urls>'], types: ['bogus'] },
        undefined
      )
    ).toThrow(/Error at property 'types': Value must be one of main_frame, sub_frame/)
    expect(() =>
      normalizeRequestListener('onBeforeRequest', { urls: ['<all_urls>'], tabId: 1.5 }, undefined)
    ).toThrow(/Error at property 'tabId': Invalid type: expected integer\./)
    expect(() =>
      normalizeRequestListener(
        'onBeforeRequest',
        { urls: ['<all_urls>'], windowId: 'w' },
        undefined
      )
    ).toThrow(/Error at property 'windowId': Invalid type: expected integer\./)
  })

  it("throws Chrome's pattern error for an invalid match pattern", () => {
    expect(() =>
      normalizeRequestListener('onBeforeRequest', { urls: ['https://example.com'] }, undefined)
    ).toThrow("'https://example.com' is not a valid URL pattern.")
    expect(() =>
      normalizeRequestListener('onBeforeRequest', { urls: ['*://*.example/*', 'nope'] }, undefined)
    ).toThrow("'nope' is not a valid URL pattern.")
  })

  it("checks extraInfoSpec against the event's own enum", () => {
    expect(() => normalizeRequestListener('onBeforeRequest', { urls: [] }, 'blocking')).toThrow(
      /Error at parameter 'extraInfoSpec': Invalid type: expected array\./
    )
    expect(() =>
      normalizeRequestListener('onBeforeRequest', { urls: [] }, ['requestHeaders'])
    ).toThrow(
      /Error at parameter 'extraInfoSpec': Error at index 0: Value must be one of blocking, requestBody, extraHeaders\./
    )
    expect(() =>
      normalizeRequestListener('onCompleted', { urls: [] }, ['responseHeaders', 'blocking'])
    ).toThrow(/Error at index 1: Value must be one of responseHeaders, extraHeaders\./)
    expect(() => normalizeRequestListener('onErrorOccurred', { urls: [] }, [42])).toThrow(
      /Error at index 0/
    )
  })
})

describe('request filters', () => {
  const probe = (
    url: string,
    type: RequestProbe['type'] = 'script',
    tabId = 7,
    windowId = 1
  ): RequestProbe => ({ url, type, tabId, windowId })

  it('matches every URL with an empty list and by pattern otherwise', () => {
    const all = compileRequestFilter({ urls: [] })
    expect(requestFilterMatches(all, probe('https://anything.example/x'))).toBe(true)
    const some = compileRequestFilter({ urls: ['*://*.example/*', 'https://one.test/path*'] })
    expect(requestFilterMatches(some, probe('https://cdn.example/a.js'))).toBe(true)
    expect(requestFilterMatches(some, probe('http://example/'))).toBe(true)
    expect(requestFilterMatches(some, probe('https://one.test/pathway'))).toBe(true)
    expect(requestFilterMatches(some, probe('https://one.test/other'))).toBe(false)
    expect(requestFilterMatches(some, probe('https://two.test/'))).toBe(false)
  })

  it('narrows by resource type, tab and window', () => {
    const typed = compileRequestFilter({ urls: [], types: ['image', 'font'] })
    expect(requestFilterMatches(typed, probe('https://a/', 'font'))).toBe(true)
    expect(requestFilterMatches(typed, probe('https://a/', 'script'))).toBe(false)
    const placed = compileRequestFilter({ urls: [], tabId: 7, windowId: 1 })
    expect(requestFilterMatches(placed, probe('https://a/'))).toBe(true)
    expect(requestFilterMatches(placed, probe('https://a/', 'script', 8))).toBe(false)
    expect(requestFilterMatches(placed, probe('https://a/', 'script', 7, 2))).toBe(false)
    // An empty `types` list is no restriction (Chrome treats it as absent).
    expect(
      requestFilterMatches(compileRequestFilter({ urls: [], types: [] }), probe('https://a/'))
    ).toBe(true)
  })
})

describe('HttpHeaders conversions', () => {
  it('turns a header map into Chrome items, one per line', () => {
    expect(toHttpHeaders({ Accept: '*/*', 'set-cookie': ['a=1', 'b=2'] })).toEqual([
      { name: 'Accept', value: '*/*' },
      { name: 'set-cookie', value: 'a=1' },
      { name: 'set-cookie', value: 'b=2' }
    ])
  })

  it('reads request headers back, last value winning case-insensitively', () => {
    expect(
      requestHeadersFrom([
        { name: 'Accept', value: '*/*' },
        { name: 'X-A', value: '1' },
        { name: 'x-a', value: '2' },
        { name: 'X-Bin', binaryValue: [72, 105] }
      ])
    ).toEqual({ Accept: '*/*', 'x-a': '2', 'X-Bin': 'Hi' })
    expect(requestHeadersFrom(undefined)).toBeNull()
    expect(requestHeadersFrom('Accept: */*')).toBeNull()
    expect(requestHeadersFrom([{ value: 'no name' }])).toBeNull()
    expect(requestHeadersFrom([{ name: 'X', value: 1 }])).toBeNull()
    expect(requestHeadersFrom([{ name: 'X', binaryValue: [300] }])).toBeNull()
    expect(requestHeadersFrom([])).toEqual({})
  })

  it('reads response headers back as lines grouped by name', () => {
    expect(
      responseHeadersFrom([
        { name: 'Set-Cookie', value: 'a=1' },
        { name: 'set-cookie', value: 'b=2' },
        { name: 'Content-Type', value: 'text/html' }
      ])
    ).toEqual({ 'Set-Cookie': ['a=1', 'b=2'], 'Content-Type': ['text/html'] })
    expect(responseHeadersFrom(null)).toBeNull()
    expect(responseHeadersFrom([{ name: 'X' }])).toBeNull()
  })
})

describe('requestBodyFrom', () => {
  it('reports nothing without a body', () => {
    expect(requestBodyFrom(undefined)).toBeNull()
    expect(requestBodyFrom([])).toBeNull()
  })

  it('parses a form-encoded body into formData', () => {
    expect(requestBodyFrom([{ bytes: utf8('a=1&b=two+words&a=3&c=') }])).toEqual({
      formData: { a: ['1', '3'], b: ['two words'], c: [''] }
    })
    expect(requestBodyFrom([{ bytes: utf8('q=caf%C3%A9') }])).toEqual({
      formData: { q: ['café'] }
    })
  })

  it('hands anything else over as raw chunks, copying the bytes', () => {
    const json = utf8('{"a":1}')
    const body = requestBodyFrom([{ bytes: json }])
    expect(body?.formData).toBeUndefined()
    expect(body?.raw).toHaveLength(1)
    const bytes = body?.raw?.[0].bytes
    expect(bytes).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(bytes as ArrayBuffer)).toEqual(json)
    expect(bytes).not.toBe(json.buffer)
    // Spaces and control characters are never form data.
    expect(requestBodyFrom([{ bytes: utf8('a=1 &b=2') }])?.formData).toBeUndefined()
    expect(requestBodyFrom([{ bytes: new Uint8Array([0, 1, 2]) }])?.raw).toHaveLength(1)
  })

  it('names files and blobs, and several chunks are always raw', () => {
    expect(
      requestBodyFrom([{ bytes: utf8('a=1') }, { file: '/tmp/upload.bin' }, { blobUUID: 'u-1' }])
    ).toEqual({
      raw: [{ bytes: expect.any(ArrayBuffer) }, { file: '/tmp/upload.bin' }, { file: 'blob:u-1' }]
    })
    expect(requestBodyFrom([{}])).toEqual({ error: 'Unknown body type' })
  })
})

describe('chromeRequestDetails', () => {
  const base: HostRequestDetails = {
    requestId: '41',
    url: 'https://cdn.example/a.js',
    method: 'GET',
    resourceType: 'script',
    frameId: 3,
    parentFrameId: 0,
    initiator: 'https://page.example',
    documentUrl: 'https://page.example/',
    timestamp: 1234.5,
    requestHeaders: { Accept: '*/*' },
    responseHeaders: { 'content-type': ['text/javascript'] },
    statusLine: 'HTTP/1.1 200 OK',
    statusCode: 200,
    fromCache: true,
    ip: '10.0.0.1',
    redirectUrl: 'https://cdn.example/b.js',
    error: 'net::ERR_ABORTED'
  }

  it('carries the common fields and only what the event and spec ask for', () => {
    expect(chromeRequestDetails('onBeforeRequest', base, 5, [])).toEqual({
      requestId: '41',
      url: 'https://cdn.example/a.js',
      method: 'GET',
      frameId: 3,
      parentFrameId: 0,
      tabId: 5,
      type: 'script',
      timeStamp: 1234.5,
      initiator: 'https://page.example',
      documentLifecycle: 'active',
      frameType: 'sub_frame'
    })
    const top = chromeRequestDetails(
      'onBeforeRequest',
      { ...base, frameId: 0, parentFrameId: -1, initiator: null },
      -1,
      []
    )
    expect(top.frameType).toBe('outermost_frame')
    expect(top.tabId).toBe(-1)
    expect(top).not.toHaveProperty('initiator')
  })

  it('adds headers only where the spec asks and the phase has them', () => {
    expect(
      chromeRequestDetails('onBeforeSendHeaders', base, 5, ['requestHeaders']).requestHeaders
    ).toEqual([{ name: 'Accept', value: '*/*' }])
    expect(chromeRequestDetails('onBeforeSendHeaders', base, 5, [])).not.toHaveProperty(
      'requestHeaders'
    )
    // The spec cannot name requestHeaders for onBeforeRequest, and the phase has none anyway.
    expect(chromeRequestDetails('onBeforeRequest', base, 5, ['requestHeaders'])).not.toHaveProperty(
      'requestHeaders'
    )
    expect(
      chromeRequestDetails('onHeadersReceived', base, 5, ['responseHeaders']).responseHeaders
    ).toEqual([{ name: 'content-type', value: 'text/javascript' }])
    expect(chromeRequestDetails('onSendHeaders', base, 5, ['responseHeaders'])).not.toHaveProperty(
      'responseHeaders'
    )
    expect(
      chromeRequestDetails('onCompleted', { ...base, responseHeaders: undefined }, 5, [
        'responseHeaders'
      ]).responseHeaders
    ).toEqual([])
  })

  it('adds the status, cache, address, redirect and error fields per phase', () => {
    const received = chromeRequestDetails('onHeadersReceived', base, 5, [])
    expect(received).toMatchObject({ statusLine: 'HTTP/1.1 200 OK', statusCode: 200 })
    expect(received).not.toHaveProperty('fromCache')
    const before = chromeRequestDetails('onBeforeRequest', base, 5, [])
    expect(before).not.toHaveProperty('statusCode')
    expect(before).not.toHaveProperty('redirectUrl')
    expect(before).not.toHaveProperty('error')
    const completed = chromeRequestDetails('onCompleted', base, 5, [])
    expect(completed).toMatchObject({ fromCache: true, ip: '10.0.0.1', statusCode: 200 })
    expect(completed).not.toHaveProperty('redirectUrl')
    expect(
      chromeRequestDetails(
        'onResponseStarted',
        { ...base, fromCache: undefined, ip: undefined },
        5,
        []
      )
    ).toMatchObject({ fromCache: false })
    expect(chromeRequestDetails('onBeforeRedirect', base, 5, []).redirectUrl).toBe(
      'https://cdn.example/b.js'
    )
    expect(chromeRequestDetails('onErrorOccurred', base, 5, [])).toMatchObject({
      error: 'net::ERR_ABORTED',
      fromCache: true
    })
    expect(
      chromeRequestDetails('onErrorOccurred', { ...base, error: undefined }, 5, []).error
    ).toBe('net::ERR_FAILED')
  })

  it('adds the request body to onBeforeRequest when asked', () => {
    const withBody = { ...base, method: 'POST', uploadData: [{ bytes: utf8('a=1') }] }
    expect(
      chromeRequestDetails('onBeforeRequest', withBody, 5, ['requestBody']).requestBody
    ).toEqual({ formData: { a: ['1'] } })
    expect(chromeRequestDetails('onBeforeRequest', withBody, 5, ['blocking'])).not.toHaveProperty(
      'requestBody'
    )
    expect(chromeRequestDetails('onBeforeRequest', base, 5, ['requestBody'])).not.toHaveProperty(
      'requestBody'
    )
  })
})

describe('normalizeBlockingResponse', () => {
  it('ignores anything that is not an object, and an object that changes nothing', () => {
    expect(normalizeBlockingResponse('onBeforeRequest', undefined)).toBeUndefined()
    expect(normalizeBlockingResponse('onBeforeRequest', null)).toBeUndefined()
    expect(normalizeBlockingResponse('onBeforeRequest', true)).toBeUndefined()
    expect(normalizeBlockingResponse('onBeforeRequest', {})).toBeUndefined()
    expect(normalizeBlockingResponse('onBeforeRequest', { cancel: false })).toBeUndefined()
    expect(normalizeBlockingResponse('onBeforeRequest', { cancel: 'yes' })).toBeUndefined()
  })

  it('takes cancel everywhere and redirectUrl where the event allows it', () => {
    expect(normalizeBlockingResponse('onBeforeSendHeaders', { cancel: true })).toEqual({
      cancel: true
    })
    expect(
      normalizeBlockingResponse('onBeforeRequest', { redirectUrl: 'https://safe.example/' })
    ).toEqual({ redirectUrl: 'https://safe.example/' })
    expect(
      normalizeBlockingResponse('onHeadersReceived', { redirectUrl: 'https://safe.example/' })
    ).toEqual({ redirectUrl: 'https://safe.example/' })
    expect(
      normalizeBlockingResponse('onBeforeSendHeaders', { redirectUrl: 'https://safe.example/' })
    ).toBeUndefined()
    expect(normalizeBlockingResponse('onBeforeRequest', { redirectUrl: '' })).toBeUndefined()
  })

  it('takes header edits in their own phases and drops malformed lists', () => {
    expect(
      normalizeBlockingResponse('onBeforeSendHeaders', {
        requestHeaders: [{ name: 'User-Agent', value: 'X/1' }]
      })
    ).toEqual({ requestHeaders: { 'User-Agent': 'X/1' } })
    expect(
      normalizeBlockingResponse('onHeadersReceived', {
        requestHeaders: [{ name: 'User-Agent', value: 'X/1' }]
      })
    ).toBeUndefined()
    expect(
      normalizeBlockingResponse('onHeadersReceived', {
        responseHeaders: [{ name: 'Set-Cookie', value: 'a=1' }],
        cancel: true
      })
    ).toEqual({ responseHeaders: { 'Set-Cookie': ['a=1'] }, cancel: true })
    expect(
      normalizeBlockingResponse('onBeforeSendHeaders', {
        responseHeaders: [{ name: 'Set-Cookie', value: 'a=1' }]
      })
    ).toBeUndefined()
    expect(
      normalizeBlockingResponse('onBeforeSendHeaders', { requestHeaders: [{ value: 'x' }] })
    ).toBeUndefined()
  })
})
