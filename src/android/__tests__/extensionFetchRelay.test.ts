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

describe('createFetchRelay: an extension-origin fetch the page policy refused, answered by the host', () => {
  it('leaves a fetch the page allows alone, whatever the URL', async () => {
    const native = vi.fn(() => Promise.resolve(new Response('ok', { status: 200 })))
    const { relay, requests } = harness(native as never)
    const response = await relay.fetch(LOCALE)
    expect(await response.text()).toBe('ok')
    expect(native).toHaveBeenCalledTimes(1)
    expect(requests).toHaveLength(0)
    expect(relay.pending()).toBe(0)
  })

  it("asks the host for an attached extension's file the page refused and answers its bytes and type", async () => {
    const { relay, requests, win } = harness()
    const promise = relay.fetch(LOCALE)
    await Promise.resolve()
    await Promise.resolve()
    expect(requests).toEqual([{ id: 'f1', extId: ROPRO, url: LOCALE }])
    expect(relay.pending()).toBe(1)
    relay.done('f1', { ok: true, body: base64('{"hello":"world"}'), mime: 'application/json' })
    const response = await promise
    expect(response).toBeInstanceOf(win.Response)
    expect(response.status).toBe(200)
    expect(response.ok).toBe(true)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.url).toBe(LOCALE)
    expect(await response.json()).toEqual({ hello: 'world' })
    expect(relay.pending()).toBe(0)
  })

  it('resolves a relative path and a Request against the page, and reads a URL object', async () => {
    const { relay, requests } = harness()
    void relay.fetch(new URL(LOCALE)).catch(() => undefined)
    void relay.fetch(new Request(LOCALE)).catch(() => undefined)
    void relay.fetch('/games/1').catch(() => undefined)
    await Promise.resolve()
    await Promise.resolve()
    expect(requests.map((r) => r.url)).toEqual([LOCALE, LOCALE])
  })

  it("hands the page's refusal on when the host cannot answer, and says why on the console", async () => {
    const { relay, errors } = harness()
    const promise = relay.fetch(`${extensionOrigin(ROPRO)}/js/secret.js`)
    await Promise.resolve()
    await Promise.resolve()
    relay.done('f1', { ok: false, error: 'js/secret.js is not a web-accessible resource' })
    await expect(promise).rejects.toThrow('Failed to fetch')
    expect(String(errors[0]?.[0])).toContain('is not a web-accessible resource')
    expect(relay.pending()).toBe(0)
  })

  it('keeps the refusal of a URL on no attached extension, and of an unattached extension', async () => {
    const { relay, requests } = harness()
    await expect(relay.fetch('https://api.example.com/x')).rejects.toThrow('Failed to fetch')
    await expect(relay.fetch(`${extensionOrigin(OTHER)}/locales/en.json`)).rejects.toThrow(
      'Failed to fetch'
    )
    expect(requests).toHaveLength(0)
  })

  it('keeps a failure that is not the policy (an abort) as it is', async () => {
    const aborting = (): Promise<Response> => {
      const error = new Error('The user aborted a request.')
      error.name = 'AbortError'
      return Promise.reject(error)
    }
    const { relay, requests } = harness(aborting)
    await expect(relay.fetch(LOCALE)).rejects.toMatchObject({ name: 'AbortError' })
    expect(requests).toHaveLength(0)
  })

  it('ignores an answer it did not ask for, and an unreadable body rejects with the refusal', async () => {
    const { relay, errors } = harness()
    relay.done('f9', { ok: true, body: base64('x') })
    const promise = relay.fetch(LOCALE)
    await Promise.resolve()
    await Promise.resolve()
    relay.done('f1', { ok: true, body: 42 })
    await expect(promise).rejects.toThrow('Failed to fetch')
    expect(errors).toHaveLength(1)
  })
})
