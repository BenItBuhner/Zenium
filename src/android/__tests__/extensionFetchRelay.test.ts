import { describe, expect, it, vi } from 'vitest'
import { extensionOrigin } from '@core/extensions/runtime/plan'
import { createFetchRelay, type FetchRelayHost } from '../extensionFetchRelay'
import type { ProxyRequest } from '../extensionCorsRelay'

const ROPRO = 'adbacgifemdbhdkfppmeilbgppmhaobf'
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const ROVALRA = 'njcickgebhnpgmoodjdgohkclfplejli'
const LOCALE = `${extensionOrigin(ROPRO)}/locales/en.json`
/** RoValra's content script on roblox.com reads its settings off its own site: the measure. */
const CONFIG = 'https://www.rovalra.com/RoValra/Settings/config.json?_RoValraRequest='
const PAGE_ORIGIN = 'https://www.roblox.com'

/** The little of a page's window the relay reads, with a `fetch` the test scripts. */
function pageWindow(
  native: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): Window & typeof globalThis {
  return {
    fetch: native,
    URL,
    Request,
    Response,
    Headers,
    TypeError,
    Error,
    DOMException,
    setTimeout,
    atob: (text: string) => Buffer.from(text, 'base64').toString('binary'),
    location: { href: 'https://www.roblox.com/games/920587237', origin: PAGE_ORIGIN }
  } as unknown as Window & typeof globalThis
}

/** A page whose `connect-src` refuses the extension's origin: the fetch rejects as Chrome's does. */
const refusing = (input: RequestInfo | URL): Promise<Response> => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
  if (url.startsWith('https://www.roblox.com/') || url.startsWith('/'))
    return Promise.resolve(new Response('page'))
  return Promise.reject(new TypeError('Failed to fetch'))
}

interface Harness {
  relay: ReturnType<typeof createFetchRelay>
  requests: Array<{ id: string; extId: string; url: string }>
  errors: unknown[][]
  win: Window & typeof globalThis
}

function harness(native = refusing, attached: string[] = [ROPRO]): Harness {
  const requests: Array<{ id: string; extId: string; url: string }> = []
  const errors: unknown[][] = []
  const host: FetchRelayHost = {
    attachedIds: () => attached,
    request: (id, extId, url) => requests.push({ id, extId, url }),
    error: (...args) => errors.push(args)
  }
  const win = pageWindow(native)
  const relay = createFetchRelay(win, host)
  return { relay, requests, errors, win }
}

const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

describe("createFetchRelay: a content script's fetch of its extension's own file, answered by the host first", () => {
  it("asks the host for an attached extension's file before the page's policy sees it, and answers its bytes and type as a same-origin response", async () => {
    const native = vi.fn(() => Promise.resolve(new Response('page', { status: 200 })))
    const { relay, requests, win } = harness(native as never)
    const promise = relay.fetch(LOCALE)
    // The request is the host's at once: no page attempt, permissive page or not.
    expect(requests).toEqual([{ id: 'f1', extId: ROPRO, url: LOCALE }])
    expect(native).not.toHaveBeenCalled()
    expect(relay.pending()).toBe(1)
    relay.done('f1', { ok: true, body: base64('{"hello":"world"}'), mime: 'application/json' })
    const response = await promise
    expect(response).toBeInstanceOf(win.Response)
    expect(response.status).toBe(200)
    expect(response.statusText).toBe('OK')
    expect(response.ok).toBe(true)
    expect(response.type).toBe('basic')
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('content-length')).toBe('17')
    expect(response.url).toBe(LOCALE)
    expect(await response.json()).toEqual({ hello: 'world' })
    expect(relay.pending()).toBe(0)
    expect(native).not.toHaveBeenCalled()
  })

  it("maps Chrome's spelling of the extension's own file to the served origin before asking, and keeps the URL asked on the Response", async () => {
    const { relay, requests } = harness()
    const promise = relay.fetch(`chrome-extension://${ROPRO}/locales/en.json`)
    expect(requests).toEqual([{ id: 'f1', extId: ROPRO, url: LOCALE }])
    relay.done('f1', { ok: true, body: base64('{}'), mime: 'application/json' })
    const response = await promise
    expect(response.url).toBe(LOCALE)
    expect(await response.text()).toBe('{}')
  })

  it('answers a HEAD with the headers alone, and takes the method off a Request', async () => {
    const { relay } = harness()
    const promise = relay.fetch(new Request(LOCALE, { method: 'HEAD' }))
    relay.done('f1', { ok: true, body: base64('{"hello":"world"}'), mime: 'application/json' })
    const response = await promise
    expect(response.headers.get('content-length')).toBe('17')
    expect(response.body).toBeNull()
    expect(await response.text()).toBe('')
  })

  it('is indifferent to the mode asked: a request to its own origin is never a CORS one in Chrome either', async () => {
    const { relay } = harness()
    const promise = relay.fetch(LOCALE, { mode: 'no-cors', credentials: 'omit', cache: 'no-store' })
    relay.done('f1', { ok: true, body: base64('x'), mime: 'text/plain' })
    const response = await promise
    expect(response.type).toBe('basic')
    expect(response.status).toBe(200)
  })

  it('resolves a relative path and a Request against the page, and reads a URL object', async () => {
    const { relay, requests } = harness()
    void relay.fetch(new URL(LOCALE)).catch(() => undefined)
    void relay.fetch(new Request(LOCALE)).catch(() => undefined)
    void relay.fetch('/games/1').catch(() => undefined)
    expect(requests.map((r) => r.url)).toEqual([LOCALE, LOCALE])
  })

  it("hands the request to the page's fetch when the host cannot answer, and says why on the console: the policy's refusal is then the extension's", async () => {
    const { relay, errors } = harness()
    const promise = relay.fetch(`${extensionOrigin(ROPRO)}/js/secret.js`)
    relay.done('f1', { ok: false, error: 'js/secret.js is not a web-accessible resource' })
    await expect(promise).rejects.toThrow('Failed to fetch')
    expect(String(errors[0]?.[0])).toContain('is not a web-accessible resource')
    expect(String(errors[0]?.[0])).toContain("the page's fetch answers it")
    expect(relay.pending()).toBe(0)
  })

  it("a permissive page's own answer stands when the host cannot – the served origin's 404 for a file that is not web-accessible", async () => {
    const native = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        new Response('not found', {
          status: 404,
          headers: { 'X-Asked': typeof input === 'string' ? input : (input as Request).url }
        })
      )
    )
    const { relay } = harness(native as never)
    const promise = relay.fetch(`chrome-extension://${ROPRO}/js/secret.js`)
    relay.done('f1', { ok: false, error: 'js/secret.js is not a web-accessible resource' })
    const response = await promise
    expect(response.status).toBe(404)
    // The page's attempt is made on the served spelling, the only one the WebView loads.
    expect(response.headers.get('x-asked')).toBe(`${extensionOrigin(ROPRO)}/js/secret.js`)
    expect(native).toHaveBeenCalledTimes(1)
  })

  it('leaves a URL on no attached extension, and an unattached extension, to the page as they are', async () => {
    const native = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')))
    const { relay, requests } = harness(native as never)
    await expect(relay.fetch('https://api.example.com/x')).rejects.toThrow('Failed to fetch')
    await expect(relay.fetch(`${extensionOrigin(OTHER)}/locales/en.json`)).rejects.toThrow(
      'Failed to fetch'
    )
    expect(requests).toHaveLength(0)
    expect(native).toHaveBeenCalledTimes(2)
    expect(relay.owns(LOCALE)).toBe(true)
    expect(relay.owns(`chrome-extension://${ROPRO}/x`)).toBe(true)
    expect(relay.owns(`${extensionOrigin(OTHER)}/x`)).toBe(false)
    expect(relay.owns('https://api.example.com/x')).toBe(false)
  })

  it('rejects an aborted request with the AbortError fetch gives, before and while the host is asked', async () => {
    const { relay, requests } = harness()
    const already = new AbortController()
    already.abort()
    await expect(relay.fetch(LOCALE, { signal: already.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(requests).toHaveLength(0)
    const controller = new AbortController()
    const promise = relay.fetch(LOCALE, { signal: controller.signal })
    expect(relay.pending()).toBe(1)
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(relay.pending()).toBe(0)
    // The host's late answer is dropped.
    relay.done('f1', { ok: true, body: base64('x') })
  })

  it('ignores an answer it did not ask for, and an unreadable body goes the page way', async () => {
    const { relay, errors } = harness()
    relay.done('f9', { ok: true, body: base64('x') })
    const promise = relay.fetch(LOCALE)
    relay.done('f1', { ok: true, body: 42 })
    await expect(promise).rejects.toThrow('Failed to fetch')
    expect(errors).toHaveLength(1)
  })
})

/*
 * The second class (compat round 26, R26-2): a cross-origin URL the page's policy refused. In
 * Chrome the content script's request leaves as the page's own CORS request – the isolated
 * world runs under the extension's policy, no host permission consulted – so here the page's
 * stack is tried first and, on the document's `connect-src` refusal, the host performs the
 * request framed as the page's and the renderer's CORS judgement is made in the world.
 */

interface CorsHarness extends Harness {
  proxies: Array<{ id: string; extId: string; request: ProxyRequest }>
  warnings: unknown[][]
  native: ReturnType<typeof vi.fn>
}

function corsHarness(
  native: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = refusing,
  attached: string[] = [ROVALRA],
  permissions: Record<string, string[]> = { [ROVALRA]: ['*://*.roblox.com/*'] }
): CorsHarness {
  const requests: Array<{ id: string; extId: string; url: string }> = []
  const proxies: Array<{ id: string; extId: string; request: ProxyRequest }> = []
  const errors: unknown[][] = []
  const warnings: unknown[][] = []
  const spy = vi.fn(native)
  const host: FetchRelayHost = {
    attachedIds: () => attached,
    hostPermissions: (extId) => permissions[extId] ?? [],
    request: (id, extId, url) => requests.push({ id, extId, url }),
    proxy: (id, extId, request) => proxies.push({ id, extId, request }),
    maxMessageChars: 2_000_000,
    error: (...args) => errors.push(args),
    warn: (...args) => warnings.push(args)
  }
  const win = pageWindow(spy as never)
  const relay = createFetchRelay(win, host)
  return { relay, requests, proxies, errors, warnings, win, native: spy }
}

/** Waits for the relay's asynchronous course to reach `check` (the host is asked after the page's rejection). */
async function until(check: () => boolean, ms = 1_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('the relay did not get there in time')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

const refusal = (blockedURI: string): { effectiveDirective: string; blockedURI: string } => ({
  effectiveDirective: 'connect-src',
  blockedURI
})

const answer = (
  body: string,
  headers: Record<string, string> = { 'Access-Control-Allow-Origin': '*' },
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  ok: true,
  status: 200,
  reason: 'OK',
  url: CONFIG,
  redirected: false,
  mime: 'application/json',
  charset: '',
  headers,
  body: base64(body),
  ...extra
})

describe("createFetchRelay: a content script's cross-origin fetch the page's policy refused, sent by the host as the page's own CORS request", () => {
  it("a permissive page's request goes out the page's way, the host never asked", async () => {
    const native = vi.fn(() =>
      Promise.resolve(
        new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } })
      )
    )
    const { relay, proxies, native: spy } = corsHarness(native as never)
    const response = await relay.fetch(CONFIG, {
      credentials: 'omit',
      headers: { Accept: 'application/json' }
    })
    expect(await response.json()).toEqual({ ok: true })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(proxies).toHaveLength(0)
    expect(relay.refused(CONFIG)).toBe(false)
  })

  it("RoValra's config.json: the page's refusal reported, the host asked for the request framed as the page's, the answer judged by CORS and rebuilt as a `cors` Response", async () => {
    const { relay, proxies, warnings, native, win } = corsHarness()
    const promise = relay.fetch(CONFIG, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      cache: 'default'
    })
    relay.onViolation(refusal(CONFIG))
    await until(() => proxies.length === 1)
    // The page's own attempt was made first, as before the relay.
    expect(native).toHaveBeenCalledTimes(1)
    expect(proxies[0]).toEqual({
      id: 'p1',
      extId: ROVALRA,
      request: {
        method: 'GET',
        url: CONFIG,
        headers: [['accept', 'application/json']],
        body: null,
        credentials: false,
        origin: PAGE_ORIGIN,
        referer: 'https://www.roblox.com/'
      }
    })
    expect(relay.pending()).toBe(1)
    relay.done(
      'p1',
      answer('{"version":"2.6.13"}', {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'max-age=600',
        'X-Served-By': 'cloudflare'
      })
    )
    const response = await promise
    expect(response).toBeInstanceOf(win.Response)
    expect(response.status).toBe(200)
    expect(response.statusText).toBe('OK')
    expect(response.ok).toBe(true)
    expect(response.type).toBe('cors')
    expect(response.url).toBe(CONFIG)
    expect(response.redirected).toBe(false)
    expect(await response.json()).toEqual({ version: '2.6.13' })
    // The exposed headers alone: the safelisted ones and the type and length re-derived; the
    // server's others, and the CORS headers themselves, are not the script's to read in Chrome.
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('content-length')).toBe('20')
    expect(response.headers.get('cache-control')).toBe('max-age=600')
    expect(response.headers.get('x-served-by')).toBeNull()
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(relay.pending()).toBe(0)
    expect(String(warnings[0]?.[0])).toContain(
      "the page's policy refused the content script's request; the host sends it as the page's own CORS request"
    )
    // The origin is remembered: the next request to it is the host's first, the page not asked again.
    expect(relay.refused(CONFIG)).toBe(true)
    expect(relay.refused('https://www.rovalra.com/other.json')).toBe(true)
    expect(relay.refused('https://apis.rovalra.com/v1/x')).toBe(false)
    const second = relay.fetch('https://www.rovalra.com/other.json')
    await until(() => proxies.length === 2)
    expect(native).toHaveBeenCalledTimes(1)
    expect(proxies[1].id).toBe('p2')
    expect(proxies[1].request.url).toBe('https://www.rovalra.com/other.json')
    relay.done('p2', answer('[]', undefined, { url: 'https://www.rovalra.com/other.json' }))
    expect(await (await second).json()).toEqual([])
  })

  it("the refusal's report is a later task than the rejection: a violation arriving after it is still matched, within the wait", async () => {
    const { relay, proxies } = corsHarness()
    const promise = relay.fetch(CONFIG)
    setTimeout(() => relay.onViolation(refusal('https://www.rovalra.com')), 20)
    await until(() => proxies.length === 1)
    relay.done('p1', answer('{}'))
    expect((await promise).status).toBe(200)
  })

  it("a rejection the document reports no violation for stands as the page's, after the wait, the host not asked", async () => {
    const pageError = new TypeError('Failed to fetch')
    const { relay, proxies, native } = corsHarness(() => Promise.reject(pageError))
    await expect(relay.fetch(CONFIG)).rejects.toBe(pageError)
    expect(native).toHaveBeenCalledTimes(1)
    expect(proxies).toHaveLength(0)
    expect(relay.refused(CONFIG)).toBe(false)
  })

  it("the renderer's CORS check: no Access-Control-Allow-Origin, or `*` for a credentialed request, is fetch's TypeError; the exact origin with credentials allowed passes, the cookies asked of the host", async () => {
    const { relay, proxies } = corsHarness()
    relay.onViolation(refusal('https://www.rovalra.com'))

    const bare = relay.fetch(CONFIG)
    await until(() => proxies.length === 1)
    relay.done('p1', answer('{}', {}))
    await expect(bare).rejects.toThrow('Failed to fetch')

    const starred = relay.fetch(CONFIG, { credentials: 'include' })
    await until(() => proxies.length === 2)
    expect(proxies[1].request.credentials).toBe(true)
    relay.done('p2', answer('{}', { 'Access-Control-Allow-Origin': '*' }))
    await expect(starred).rejects.toThrow('Failed to fetch')

    const exact = relay.fetch(CONFIG, { credentials: 'include' })
    await until(() => proxies.length === 3)
    relay.done(
      'p3',
      answer('{}', {
        'Access-Control-Allow-Origin': PAGE_ORIGIN,
        'Access-Control-Allow-Credentials': 'true'
      })
    )
    expect((await exact).status).toBe(200)

    const otherOrigin = relay.fetch(CONFIG)
    await until(() => proxies.length === 4)
    relay.done('p4', answer('{}', { 'Access-Control-Allow-Origin': 'https://evil.test' }))
    await expect(otherOrigin).rejects.toThrow('Failed to fetch')
    expect(relay.pending()).toBe(0)
  })

  it('a `no-cors` request answers an opaque Response: status 0, no headers, no body, the request having gone out', async () => {
    const { relay, proxies } = corsHarness()
    relay.onViolation(refusal('https://www.rovalra.com'))
    const promise = relay.fetch(CONFIG, { mode: 'no-cors' })
    await until(() => proxies.length === 1)
    relay.done('p1', answer('{"secret":1}', {}))
    const response = await promise
    expect(response.type).toBe('opaque')
    expect(response.status).toBe(0)
    expect(response.ok).toBe(false)
    expect(response.url).toBe('')
    expect([...response.headers.keys()]).toEqual([])
    expect(await response.text()).toBe('')
  })

  it("a request that is not simple – RoValra's `x-rovalra-user-agent` on its API – is preflighted through the host, the request following only on the preflight's leave", async () => {
    const { relay, proxies } = corsHarness()
    const api = 'https://apis.rovalra.com/v1/servers'
    relay.onViolation(refusal(api))
    const promise = relay.fetch(api, { headers: { 'x-rovalra-user-agent': 'RoValra/2.6.13' } })
    await until(() => proxies.length === 1)
    expect(proxies[0].request).toEqual({
      method: 'OPTIONS',
      url: api,
      headers: [
        ['Accept', '*/*'],
        ['Access-Control-Request-Method', 'GET'],
        ['Access-Control-Request-Headers', 'x-rovalra-user-agent']
      ],
      body: null,
      credentials: false,
      origin: PAGE_ORIGIN,
      referer: 'https://www.roblox.com/'
    })
    relay.done('p1', {
      ok: true,
      status: 204,
      reason: 'No Content',
      url: api,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'x-rovalra-user-agent'
      },
      body: ''
    })
    await until(() => proxies.length === 2)
    expect(proxies[1].request.method).toBe('GET')
    expect(proxies[1].request.headers).toEqual([['x-rovalra-user-agent', 'RoValra/2.6.13']])
    relay.done('p2', answer('[1]', undefined, { url: api }))
    const response = await promise
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([1])

    // The preflight refusing the header: fetch's TypeError, the request never made.
    const refused = relay.fetch(api, { headers: { 'x-rovalra-user-agent': 'RoValra/2.6.13' } })
    await until(() => proxies.length === 3)
    relay.done('p3', {
      ok: true,
      status: 204,
      url: api,
      headers: { 'access-control-allow-origin': '*' },
      body: ''
    })
    await expect(refused).rejects.toThrow('Failed to fetch')
    expect(proxies).toHaveLength(3)
  })

  it("a bodied POST goes along in base64 with its content type, a simple one without a preflight; the answer's status and reason are the server's", async () => {
    const { relay, proxies } = corsHarness()
    const api = 'https://apis.rovalra.com/v1/report'
    relay.onViolation(refusal(api))
    const promise = relay.fetch(api, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=1&b=2'
    })
    await until(() => proxies.length === 1)
    expect(proxies[0].request.method).toBe('POST')
    expect(proxies[0].request.body).toBe(base64('a=1&b=2'))
    expect(proxies[0].request.headers).toEqual([
      ['content-type', 'application/x-www-form-urlencoded']
    ])
    relay.done('p1', {
      ok: true,
      status: 201,
      reason: 'Created',
      url: api,
      mime: 'text/plain',
      headers: { 'access-control-allow-origin': '*' },
      body: base64('made')
    })
    const response = await promise
    expect(response.status).toBe(201)
    expect(response.statusText).toBe('Created')
    expect(await response.text()).toBe('made')
  })

  it("the host's refusal leaves the page's own rejection standing, and says why on the console", async () => {
    const pageError = new TypeError('Failed to fetch')
    const { relay, proxies, errors } = corsHarness(() => Promise.reject(pageError))
    const promise = relay.fetch(CONFIG)
    relay.onViolation(refusal(CONFIG))
    await until(() => proxies.length === 1)
    relay.done('p1', { ok: false, error: 'the extension is not attached' })
    await expect(promise).rejects.toBe(pageError)
    expect(String(errors[0]?.[0])).toContain(
      'could not be answered through the host for the content script'
    )
    expect(String(errors[0]?.[0])).toContain('the extension is not attached')
    expect(String(errors[0]?.[0])).toContain("the page's own answer stands")
    expect(relay.pending()).toBe(0)
  })

  it("the host's refusal of a request it was asked first hands it to the page's fetch after all", async () => {
    const native = vi.fn(() =>
      Promise.resolve(
        new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } })
      )
    )
    const { relay, proxies } = corsHarness(native as never)
    relay.onViolation(refusal('https://www.rovalra.com'))
    const promise = relay.fetch(CONFIG)
    await until(() => proxies.length === 1)
    expect(native).not.toHaveBeenCalled()
    relay.done('p1', { ok: false, error: "the answer is past the bridge's size" })
    expect(await (await promise).json()).toEqual({ ok: true })
    expect(native).toHaveBeenCalledTimes(1)
  })

  it('stays the page\'s: a same-origin URL, another extension\'s origin, a URL off http(s), `mode: "same-origin"`', async () => {
    const { relay, proxies, native } = corsHarness()
    relay.onViolation(refusal('https://www.rovalra.com'))
    expect(await (await relay.fetch('https://www.roblox.com/api/x')).text()).toBe('page')
    await expect(relay.fetch(`${extensionOrigin(OTHER)}/x.json`)).rejects.toThrow('Failed to fetch')
    await expect(relay.fetch('data:text/plain,hi')).rejects.toThrow('Failed to fetch')
    await expect(relay.fetch(CONFIG, { mode: 'same-origin' })).rejects.toThrow('Failed to fetch')
    expect(native).toHaveBeenCalledTimes(4)
    expect(proxies).toHaveLength(0)
  })

  it('the request is made for the attached extension whose host permissions cover the URL, else the first attached', async () => {
    const { relay, proxies } = corsHarness(refusing, [ROPRO, ROVALRA], {
      [ROPRO]: ['*://*.roblox.com/*'],
      [ROVALRA]: ['https://www.rovalra.com/*']
    })
    relay.onViolation(refusal('https://www.rovalra.com'))
    relay.onViolation(refusal('https://api.example.com'))
    void relay.fetch(CONFIG).catch(() => undefined)
    void relay.fetch('https://api.example.com/x').catch(() => undefined)
    await until(() => proxies.length === 2)
    expect(proxies.map((p) => p.extId)).toEqual([ROVALRA, ROPRO])
  })

  it("an abort while the host is asked rejects with fetch's AbortError, the late answer dropped", async () => {
    const { relay, proxies } = corsHarness()
    relay.onViolation(refusal('https://www.rovalra.com'))
    const controller = new AbortController()
    const promise = relay.fetch(CONFIG, { signal: controller.signal })
    await until(() => proxies.length === 1)
    expect(relay.pending()).toBe(1)
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(relay.pending()).toBe(0)
    relay.done('p1', answer('{}'))
  })

  it("a body past the bridge's room stays the page's: its own course, no ask", async () => {
    const pageError = new TypeError('Failed to fetch')
    const { relay, proxies, native } = corsHarness(() => Promise.reject(pageError))
    relay.onViolation(refusal('https://www.rovalra.com'))
    const promise = relay.fetch(CONFIG, { method: 'POST', body: 'x'.repeat(1_600_000) })
    await expect(promise).rejects.toBe(pageError)
    expect(proxies).toHaveLength(0)
    expect(native).toHaveBeenCalledTimes(1)
  })
})
