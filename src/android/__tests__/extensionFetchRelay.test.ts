import { describe, expect, it, vi } from 'vitest'
import { extensionOrigin } from '@core/extensions/runtime/plan'
import { createFetchRelay, type FetchRelayHost } from '../extensionFetchRelay'

const ROPRO = 'adbacgifemdbhdkfppmeilbgppmhaobf'
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const LOCALE = `${extensionOrigin(ROPRO)}/locales/en.json`

/** The little of a page's window the relay reads, with a `fetch` the test scripts. */
function pageWindow(
  native: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): Window & typeof globalThis {
  return {
    fetch: native,
    URL,
    Request,
    Response,
    TypeError,
    Error,
    DOMException,
    atob: (text: string) => Buffer.from(text, 'base64').toString('binary'),
    location: { href: 'https://www.roblox.com/games/920587237' }
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
