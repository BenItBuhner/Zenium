import { describe, expect, it } from 'vitest'
import {
  corsAllows,
  corsResponse,
  exposedHeaders,
  isConnectRefusal,
  isCrossOriginHttp,
  needsPreflight,
  opaqueResponse,
  originOf,
  preflightAllows,
  refererFor,
  replyHeaders,
  unsafeHeaderNames,
  violationNames
} from '../extensionCorsRelay'

const PAGE = 'https://www.roblox.com'
const CONFIG = 'https://www.rovalra.com/RoValra/Settings/config.json?_RoValraRequest='
const win = globalThis as unknown as Window & typeof globalThis

describe("extensionCorsRelay: the renderer's CORS judgement of a content script's cross-origin request, made in the world", () => {
  it('tells a cross-origin http(s) URL from the page’s own, a non-http one and an extension origin', () => {
    expect(isCrossOriginHttp(CONFIG, PAGE)).toBe(true)
    expect(isCrossOriginHttp('http://www.rovalra.com/x', PAGE)).toBe(true)
    expect(isCrossOriginHttp('https://www.roblox.com/games/1', PAGE)).toBe(false)
    expect(isCrossOriginHttp('https://apis.roblox.com/v1/x', PAGE)).toBe(true)
    expect(isCrossOriginHttp('data:text/plain,x', PAGE)).toBe(false)
    expect(isCrossOriginHttp('blob:https://www.roblox.com/uuid', PAGE)).toBe(false)
    expect(
      isCrossOriginHttp('https://abcdefghijklmnopabcdefghijklmnop.ext.zenium.invalid/x.json', PAGE)
    ).toBe(false)
    // An opaque origin's page: every http(s) URL is cross-origin to it.
    expect(isCrossOriginHttp(CONFIG, 'null')).toBe(true)
    expect(originOf(CONFIG)).toBe('https://www.rovalra.com')
    expect(originOf('https://host:8443/x')).toBe('https://host:8443')
    expect(originOf('ftp://host/x')).toBeNull()
  })

  it('matches a violation’s blockedURI to the request by URL (fragment apart) or by origin, as Chromium reports it', () => {
    expect(violationNames(CONFIG, CONFIG)).toBe(true)
    expect(violationNames('https://www.rovalra.com', CONFIG)).toBe(true)
    expect(violationNames('https://www.rovalra.com/', CONFIG)).toBe(true)
    expect(violationNames(CONFIG, CONFIG + '#frag')).toBe(true)
    expect(violationNames('https://other.test', CONFIG)).toBe(false)
    expect(violationNames('https://www.rovalra.com/other.json', CONFIG)).toBe(false)
    expect(violationNames('', CONFIG)).toBe(false)
  })

  it('takes a connect-src refusal from the event – the effective directive first, a report-only policy never', () => {
    expect(
      isConnectRefusal({ effectiveDirective: 'connect-src', violatedDirective: 'default-src' })
    ).toBe(true)
    expect(
      isConnectRefusal({ effectiveDirective: 'img-src', violatedDirective: 'default-src' })
    ).toBe(false)
    expect(isConnectRefusal({ violatedDirective: "connect-src 'self' https://*.roblox.com" })).toBe(
      true
    )
    expect(isConnectRefusal({ violatedDirective: 'script-src' })).toBe(false)
    expect(isConnectRefusal({ effectiveDirective: 'connect-src', disposition: 'report' })).toBe(
      false
    )
    expect(isConnectRefusal({ effectiveDirective: 'connect-src', disposition: 'enforce' })).toBe(
      true
    )
  })

  it('needs a preflight for a method or a header off the safelist, as Chrome sends one', () => {
    expect(needsPreflight('GET', [['accept', 'application/json']])).toBe(false)
    expect(needsPreflight('POST', [['content-type', 'application/x-www-form-urlencoded']])).toBe(
      false
    )
    expect(needsPreflight('POST', [['content-type', 'text/plain;charset=UTF-8']])).toBe(false)
    expect(needsPreflight('POST', [['content-type', 'application/json']])).toBe(true)
    expect(
      needsPreflight('GET', [
        ['x-rovalra-user-agent', 'RoValraExtension(RoValra/Chrome/Chromium/2.6.13/Production)']
      ])
    ).toBe(true)
    expect(needsPreflight('PUT', [])).toBe(true)
    expect(needsPreflight('DELETE', [])).toBe(true)
    expect(needsPreflight('GET', [['range', 'bytes=0-99']])).toBe(false)
    expect(needsPreflight('GET', [['range', 'bytes=0-99,200-300']])).toBe(true)
    expect(needsPreflight('GET', [['accept', 'x'.repeat(129)]])).toBe(true)
    expect(
      unsafeHeaderNames([
        ['Authorization', 'Bearer x'],
        ['Accept', '*/*'],
        ['X-Custom', '1']
      ])
    ).toEqual(['authorization', 'x-custom'])
  })

  it('allows an origin by Access-Control-Allow-Origin: * or the page’s, never * with credentials, which also need the credentials header', () => {
    expect(corsAllows({ 'access-control-allow-origin': '*' }, PAGE, false)).toBe(true)
    expect(corsAllows({ 'access-control-allow-origin': PAGE }, PAGE, false)).toBe(true)
    expect(corsAllows({ 'access-control-allow-origin': 'https://other.test' }, PAGE, false)).toBe(
      false
    )
    expect(corsAllows({}, PAGE, false)).toBe(false)
    expect(corsAllows({ 'access-control-allow-origin': '*' }, PAGE, true)).toBe(false)
    expect(corsAllows({ 'access-control-allow-origin': PAGE }, PAGE, true)).toBe(false)
    expect(
      corsAllows(
        { 'access-control-allow-origin': PAGE, 'access-control-allow-credentials': 'true' },
        PAGE,
        true
      )
    ).toBe(true)
    expect(
      replyHeaders({ headers: { 'Access-Control-Allow-Origin': '*', 'X-Server': 'yes', bad: 1 } })
    ).toEqual({
      'access-control-allow-origin': '*',
      'x-server': 'yes'
    })
    expect(replyHeaders({ headers: 'none' })).toEqual({})
  })

  it('checks a preflight answer: an ok status, the origin, the method, every unsafe header listed (* for an uncredentialed request, Authorization apart)', () => {
    const headers: Array<[string, string]> = [
      ['x-rovalra-user-agent', 'r'],
      ['content-type', 'application/json']
    ]
    const ok = {
      ok: true,
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': PAGE,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, x-rovalra-user-agent'
      }
    }
    expect(preflightAllows(ok, 'POST', headers, PAGE, false)).toBe(true)
    expect(preflightAllows({ ...ok, status: 403 }, 'POST', headers, PAGE, false)).toBe(false)
    expect(
      preflightAllows(
        { ...ok, headers: { ...ok.headers, 'Access-Control-Allow-Headers': 'content-type' } },
        'POST',
        headers,
        PAGE,
        false
      )
    ).toBe(false)
    expect(
      preflightAllows(
        { ...ok, headers: { ...ok.headers, 'Access-Control-Allow-Headers': '*' } },
        'POST',
        headers,
        PAGE,
        false
      )
    ).toBe(true)
    expect(
      preflightAllows(
        { ...ok, headers: { ...ok.headers, 'Access-Control-Allow-Headers': '*' } },
        'POST',
        [['authorization', 'x']],
        PAGE,
        false
      )
    ).toBe(false)
    // A method off the safelist must be listed; `*` lists it for an uncredentialed request only.
    expect(preflightAllows(ok, 'DELETE', [], PAGE, false)).toBe(false)
    expect(
      preflightAllows(
        { ...ok, headers: { ...ok.headers, 'Access-Control-Allow-Methods': '*' } },
        'DELETE',
        [],
        PAGE,
        false
      )
    ).toBe(true)
    expect(
      preflightAllows(
        {
          ...ok,
          headers: {
            ...ok.headers,
            'Access-Control-Allow-Methods': '*',
            'Access-Control-Allow-Credentials': 'true'
          }
        },
        'DELETE',
        [],
        PAGE,
        true
      )
    ).toBe(false)
    expect(
      preflightAllows(
        {
          ...ok,
          headers: {
            ...ok.headers,
            'Access-Control-Allow-Methods': 'DELETE',
            'Access-Control-Allow-Credentials': 'true'
          }
        },
        'DELETE',
        [],
        PAGE,
        true
      )
    ).toBe(true)
  })

  it('exposes the safelisted response headers and those Access-Control-Expose-Headers names, re-deriving Content-Type and Content-Length', () => {
    const reply = {
      mime: 'application/json',
      charset: 'utf-8',
      headers: {
        'Cache-Control': 'max-age=14400',
        'X-Server': 'yes',
        'X-Secret': 'no',
        'Set-Cookie': 'sid=1',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'X-Server'
      }
    }
    expect(exposedHeaders(reply, 17, false)).toEqual([
      ['cache-control', 'max-age=14400'],
      ['x-server', 'yes'],
      ['content-type', 'application/json; charset=utf-8'],
      ['content-length', '17']
    ])
    const all = exposedHeaders(
      { ...reply, headers: { ...reply.headers, 'Access-Control-Expose-Headers': '*' } },
      3,
      false
    )
    expect(all.map(([n]) => n)).toEqual(
      expect.arrayContaining(['x-secret', 'x-server', 'cache-control'])
    )
    expect(all.map(([n]) => n)).not.toContain('set-cookie')
    // `*` lists nothing for a credentialed request.
    const credentialed = exposedHeaders(
      { ...reply, headers: { ...reply.headers, 'Access-Control-Expose-Headers': '*' } },
      3,
      true
    )
    expect(credentialed.map(([n]) => n)).toEqual([
      'cache-control',
      'content-type',
      'content-length'
    ])
  })

  it('rebuilds the response as the renderer hands it over: status, exposed headers, bytes, type cors, url and redirected; none of the body for a HEAD or a 204', async () => {
    const bytes = new TextEncoder().encode('{"locks":{}}')
    const reply = {
      ok: true,
      status: 200,
      reason: 'OK',
      url: CONFIG,
      redirected: false,
      mime: 'application/json',
      charset: 'utf-8',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'max-age=14400',
        'X-Hidden': '1'
      }
    }
    const response = corsResponse(win, reply, bytes, 'GET', false)
    expect(response.status).toBe(200)
    expect(response.statusText).toBe('OK')
    expect(response.type).toBe('cors')
    expect(response.url).toBe(CONFIG)
    expect(response.redirected).toBe(false)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('max-age=14400')
    expect(response.headers.get('x-hidden')).toBeNull()
    expect(await response.json()).toEqual({ locks: {} })
    const head = corsResponse(win, reply, bytes, 'HEAD', false)
    expect(head.body).toBeNull()
    expect(head.headers.get('content-length')).toBe(String(bytes.byteLength))
    const noContent = corsResponse(
      win,
      { ...reply, status: 204, reason: 'No Content' },
      new Uint8Array(0),
      'GET',
      false
    )
    expect(noContent.status).toBe(204)
    expect(noContent.body).toBeNull()
    const moved = corsResponse(
      win,
      { ...reply, url: 'https://cdn.rovalra.com/config.json', redirected: true },
      bytes,
      'GET',
      false
    )
    expect(moved.redirected).toBe(true)
    expect(moved.url).toBe('https://cdn.rovalra.com/config.json')
  })

  it('an opaque response reads as no-cors gets it: status 0, type opaque, no headers, no body, an empty URL', async () => {
    const response = opaqueResponse(win)
    expect(response.type).toBe('opaque')
    expect(response.status).toBe(0)
    expect(response.ok).toBe(false)
    expect(response.url).toBe('')
    expect([...response.headers.keys()]).toEqual([])
    expect(response.body).toBeNull()
    expect(await response.text()).toBe('')
  })

  it('sends the Referer the page’s request would carry under its referrer policy', () => {
    const page = 'https://www.roblox.com/games/920587237#x'
    expect(refererFor(new Request(CONFIG), page, PAGE)).toBe('https://www.roblox.com/')
    expect(
      refererFor(new Request(CONFIG, { referrerPolicy: 'no-referrer' }), page, PAGE)
    ).toBeNull()
    expect(refererFor(new Request(CONFIG, { referrer: '' }), page, PAGE)).toBeNull()
    expect(refererFor(new Request(CONFIG, { referrerPolicy: 'unsafe-url' }), page, PAGE)).toBe(
      'https://www.roblox.com/games/920587237'
    )
    expect(refererFor(new Request(CONFIG, { referrerPolicy: 'origin' }), page, PAGE)).toBe(
      'https://www.roblox.com/'
    )
    expect(refererFor(new Request(CONFIG), 'about:blank', 'null')).toBeNull()
  })
})
