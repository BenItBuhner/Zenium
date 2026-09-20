import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installExtensionApi,
  type EventDelivery,
  type InvokeResult,
  type ShimHost
} from '../api/shim'
import { API_SPEC } from '../api/spec'
import { BLOCKING_PERMISSION_ERROR } from '../api/webRequest'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke at the patched globals
type Any = any

const ID = 'abcdefghijklmnopabcdefghijklmnop'

interface FakeHost extends ShimHost {
  calls: Array<{ namespace: string; method: string; args: unknown[] }>
  notifications: Array<{ kind: string; payload: unknown }>
  respond: (namespace: string, method: string, args: unknown[]) => InvokeResult
  deliver(event: string, args: unknown[], delivery: EventDelivery): void
}

function fakeHost(): FakeHost {
  let listener:
    ((namespace: string, event: string, args: unknown[], delivery?: EventDelivery) => void) | null =
    null
  const host: FakeHost = {
    kind: 'worker',
    calls: [],
    notifications: [],
    respond: () => ({ ok: true, value: undefined }),
    invoke(namespace, method, args) {
      host.calls.push({ namespace, method, args })
      return Promise.resolve(host.respond(namespace, method, args))
    },
    notify(kind, payload) {
      host.notifications.push({ kind, payload })
    },
    onEvent(fn) {
      listener = fn
    },
    deliver(event, args, delivery) {
      listener?.('webRequest', event, args, delivery)
    }
  }
  return host
}

interface Setup {
  manifestVersion?: 2 | 3
  permissions?: string[]
  /** Pretend the engine exposed its own (never firing) `chrome.webRequest` object. */
  nativeWebRequest?: boolean
}

function install(setup: Setup = {}): { chrome: Any; host: FakeHost } {
  const g = globalThis as Any
  const manifest = {
    manifest_version: setup.manifestVersion ?? 3,
    name: 'Probe',
    version: '1.0',
    permissions: setup.permissions ?? ['webRequest']
  }
  const nativeEvent = (): Any => ({
    addListener: vi.fn(),
    removeListener: vi.fn(),
    hasListener: vi.fn(() => false)
  })
  const chrome: Any = {
    runtime: {
      id: ID,
      getManifest: () => manifest,
      getURL: (path: string) => `chrome-extension://${ID}/${path}`,
      sendMessage: vi.fn(),
      onMessage: nativeEvent()
    },
    storage: { local: {}, session: {}, onChanged: nativeEvent() }
  }
  if (setup.nativeWebRequest) {
    chrome.webRequest = {
      onBeforeRequest: nativeEvent(),
      onCompleted: nativeEvent(),
      handlerBehaviorChanged: vi.fn()
    }
  }
  Object.defineProperty(g, 'chrome', { value: chrome, configurable: true, writable: true })
  Object.defineProperty(g, 'browser', { value: chrome, configurable: true, writable: true })
  const host = fakeHost()
  installExtensionApi(host, API_SPEC)
  return { chrome: g.chrome, host }
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

/** The blocking answers the shim sent (the install-time `hello` and the rest set aside). */
function answers(host: FakeHost): unknown[] {
  return host.notifications.filter((n) => n.kind === 'webRequest-answer').map((n) => n.payload)
}

describe('chrome.webRequest in the shim', () => {
  const g = globalThis as Any

  afterEach(() => {
    delete g.chrome
    delete g.browser
    vi.restoreAllMocks()
  })

  it('exists for extensions holding the permission, or when the engine exposed one', () => {
    expect(install({ permissions: ['storage'] }).chrome.webRequest).toBeUndefined()
    delete g.chrome
    delete g.browser
    const { chrome } = install({ permissions: ['webRequestBlocking'], manifestVersion: 2 })
    expect(typeof chrome.webRequest.onBeforeRequest.addListener).toBe('function')
    expect(chrome.webRequest.MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES).toBe(20)
    expect(chrome.webRequest.ResourceType.MAIN_FRAME).toBe('main_frame')
    expect(chrome.webRequest.OnBeforeRequestOptions.REQUEST_BODY).toBe('requestBody')
    delete g.chrome
    delete g.browser
    const native = install({ permissions: ['storage'], nativeWebRequest: true })
    // The engine's event object, which never fires under the session hook, is replaced.
    expect(vi.isMockFunction(native.chrome.webRequest.onBeforeRequest.addListener)).toBe(false)
    native.chrome.webRequest.onBeforeRequest.addListener(() => undefined, { urls: [] })
    expect(native.host.calls.map((c) => `${c.namespace}.${c.method}`)).toEqual([
      'webRequest.addListener'
    ])
  })

  it('validates addListener the way the binding does, before asking the host', () => {
    const { chrome, host } = install()
    const event = chrome.webRequest.onBeforeRequest
    const fn = (): undefined => undefined
    expect(() => event.addListener('nope', { urls: [] })).toThrow(TypeError)
    expect(() => event.addListener(fn)).toThrow(/No matching signature\./)
    expect(() => event.addListener(fn, {})).toThrow(
      /Error at property 'urls': Invalid type: expected array\./
    )
    expect(() => event.addListener(fn, { urls: [3] })).toThrow(
      /Error at property 'urls': Invalid type: expected string\./
    )
    expect(() => event.addListener(fn, { urls: ['example.com'] })).toThrow(
      "'example.com' is not a valid URL pattern."
    )
    expect(() => event.addListener(fn, { urls: [] }, 'blocking')).toThrow(
      /Error at parameter 'extraInfoSpec': Invalid type: expected array\./
    )
    expect(() => event.addListener(fn, { urls: [] }, ['responseHeaders'])).toThrow(
      /Error at index 0: Value must be one of blocking, requestBody, extraHeaders\./
    )
    // An MV3 extension may not block.
    expect(() => event.addListener(fn, { urls: [] }, ['blocking'])).toThrow(
      BLOCKING_PERMISSION_ERROR
    )
    expect(() =>
      chrome.webRequest.onAuthRequired.addListener(fn, { urls: [] }, ['asyncBlocking'])
    ).toThrow(BLOCKING_PERMISSION_ERROR)
    expect(host.calls).toEqual([])
    expect(event.hasListener(fn)).toBe(false)
  })

  it('lets webRequestAuthProvider holders block onAuthRequired and nothing else', () => {
    const { chrome, host } = install({ permissions: ['webRequest', 'webRequestAuthProvider'] })
    const fn = (): undefined => undefined
    chrome.webRequest.onAuthRequired.addListener(fn, { urls: [] }, ['asyncBlocking'])
    expect(() =>
      chrome.webRequest.onBeforeRequest.addListener(fn, { urls: [] }, ['blocking'])
    ).toThrow(BLOCKING_PERMISSION_ERROR)
    expect(host.calls.map((c) => c.args)).toEqual([
      ['onAuthRequired', { urls: [] }, ['asyncBlocking'], 1]
    ])
  })

  it('registers each listener once with the host under its own id and removes it again', async () => {
    const { chrome, host } = install()
    const a = (): undefined => undefined
    const b = (): undefined => undefined
    chrome.webRequest.onBeforeRequest.addListener(a, { urls: ['<all_urls>'], types: ['script'] }, [
      'requestBody',
      'requestBody'
    ])
    chrome.webRequest.onBeforeRequest.addListener(a, { urls: [] })
    chrome.webRequest.onCompleted.addListener(b, { urls: ['*://*.example/*'], tabId: 4 })
    expect(host.calls).toEqual([
      {
        namespace: 'webRequest',
        method: 'addListener',
        args: ['onBeforeRequest', { urls: ['<all_urls>'], types: ['script'] }, ['requestBody'], 1]
      },
      {
        namespace: 'webRequest',
        method: 'addListener',
        args: ['onCompleted', { urls: ['*://*.example/*'], tabId: 4 }, [], 2]
      }
    ])
    expect(chrome.webRequest.onBeforeRequest.hasListener(a)).toBe(true)
    expect(chrome.webRequest.onBeforeRequest.hasListeners()).toBe(true)
    expect(chrome.webRequest.onCompleted.hasListener(a)).toBe(false)
    chrome.webRequest.onBeforeRequest.removeListener(a)
    chrome.webRequest.onBeforeRequest.removeListener(a)
    expect(chrome.webRequest.onBeforeRequest.hasListeners()).toBe(false)
    expect(host.calls.slice(2)).toEqual([
      { namespace: 'webRequest', method: 'removeListener', args: ['onBeforeRequest', 1] }
    ])
    // The rule members every chrome.Event has are there for callers that probe them.
    expect(typeof chrome.webRequest.onCompleted.getRules).toBe('function')
    await flush()
  })

  it('drops a listener the host refused', async () => {
    const { chrome, host } = install()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    host.respond = () => ({ ok: false, error: "The 'webRequest' permission is required." })
    const fn = (): undefined => undefined
    chrome.webRequest.onBeforeRequest.addListener(fn, { urls: [] })
    expect(chrome.webRequest.onBeforeRequest.hasListener(fn)).toBe(true)
    await flush()
    expect(chrome.webRequest.onBeforeRequest.hasListener(fn)).toBe(false)
    expect(error).toHaveBeenCalledWith(
      "webRequest.onBeforeRequest.addListener: The 'webRequest' permission is required."
    )
  })

  it('delivers to the listener the host addressed and to no other', () => {
    const { chrome, host } = install()
    const seen: unknown[][] = []
    const a = (...args: unknown[]): undefined => {
      seen.push(['a', ...args])
      return undefined
    }
    const b = (...args: unknown[]): undefined => {
      seen.push(['b', ...args])
      return undefined
    }
    chrome.webRequest.onBeforeRequest.addListener(a, { urls: [] })
    chrome.webRequest.onBeforeRequest.addListener(b, { urls: ['https://*/*'] })
    const details = { requestId: '1', url: 'https://a.example/' }
    host.deliver('onBeforeRequest', [details, null], { unfiltered: false, matched: [2] })
    host.deliver('onBeforeRequest', [details, null], { unfiltered: false, matched: [1] })
    host.deliver('onCompleted', [details, null], { unfiltered: false, matched: [1] })
    host.deliver('onBeforeRequest', [details, null], { unfiltered: false, matched: [9] })
    expect(seen).toEqual([
      ['b', details],
      ['a', details]
    ])
    // A non-blocking delivery never answers.
    expect(answers(host)).toEqual([])
  })

  it("sends a blocking listener's return value back under the token", () => {
    const { chrome, host } = install({ manifestVersion: 2, permissions: ['webRequestBlocking'] })
    const binary = new Uint8Array([72, 105]).buffer
    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details: Any) => ({
        cancel: false,
        requestHeaders: [
          ...details.requestHeaders,
          { name: 'X-Bin', binaryValue: binary },
          { name: 'X-View', binaryValue: new Uint8Array(binary, 1, 1) },
          { name: 'X-List', binaryValue: [1, 2] },
          'not a header'
        ],
        unknownField: 1
      }),
      { urls: [] },
      ['blocking', 'requestHeaders']
    )
    chrome.webRequest.onBeforeRequest.addListener(
      (details: Any) => (details.url.endsWith('/block') ? { cancel: true } : undefined),
      { urls: [] },
      ['blocking']
    )
    const send = {
      requestId: '1',
      url: 'https://a.example/',
      requestHeaders: [{ name: 'A', value: '1' }]
    }
    host.deliver('onBeforeSendHeaders', [send, 41], { unfiltered: false, matched: [1] })
    host.deliver('onBeforeRequest', [{ requestId: '2', url: 'https://a.example/block' }, 42], {
      unfiltered: false,
      matched: [2]
    })
    host.deliver('onBeforeRequest', [{ requestId: '3', url: 'https://a.example/pass' }, 43], {
      unfiltered: false,
      matched: [2]
    })
    expect(answers(host)).toEqual([
      {
        token: 41,
        response: {
          requestHeaders: [
            { name: 'A', value: '1' },
            { name: 'X-Bin', binaryValue: [72, 105] },
            { name: 'X-View', binaryValue: [105] },
            { name: 'X-List', binaryValue: [1, 2] },
            'not a header'
          ]
        }
      },
      { token: 42, response: { cancel: true } },
      { token: 43, response: undefined }
    ])
  })

  it("carries an onAuthRequired listener's credentials back, and nothing malformed", () => {
    const { chrome, host } = install({ permissions: ['webRequest', 'webRequestAuthProvider'] })
    chrome.webRequest.onAuthRequired.addListener(
      (details: Any) =>
        details.isProxy
          ? { authCredentials: { username: 'vpn-user', password: 'vpn-pass' }, extra: 1 }
          : { authCredentials: { username: 'only' } },
      { urls: [] },
      ['blocking']
    )
    const challenge = { requestId: '1', url: 'https://page.example/', statusCode: 407 }
    host.deliver('onAuthRequired', [{ ...challenge, isProxy: true }, 51], {
      unfiltered: false,
      matched: [1]
    })
    host.deliver('onAuthRequired', [{ ...challenge, isProxy: false }, 52], {
      unfiltered: false,
      matched: [1]
    })
    expect(answers(host)).toEqual([
      { token: 51, response: { authCredentials: { username: 'vpn-user', password: 'vpn-pass' } } },
      { token: 52, response: {} }
    ])
  })

  it('answers with nothing for a delivery no listener claims', () => {
    const { chrome, host } = install({ manifestVersion: 2, permissions: ['webRequestBlocking'] })
    chrome.webRequest.onBeforeRequest.addListener(() => ({ cancel: true }), { urls: [] }, [
      'blocking'
    ])
    host.deliver('onBeforeRequest', [{ requestId: '1' }, 7], { unfiltered: false, matched: [5] })
    expect(answers(host)).toEqual([{ token: 7, response: undefined }])
  })

  it('waits for a promise or the asyncBlocking callback, and rethrows a listener error later', async () => {
    vi.useFakeTimers()
    try {
      const { chrome, host } = install({ manifestVersion: 2, permissions: ['webRequestBlocking'] })
      chrome.webRequest.onBeforeRequest.addListener(
        () => Promise.resolve({ redirectUrl: 'https://safe.example/' }),
        { urls: [] },
        ['blocking']
      )
      chrome.webRequest.onAuthRequired.addListener(
        (_details: unknown, callback: (r: unknown) => void) => {
          callback({ cancel: true })
        },
        { urls: [] },
        ['asyncBlocking']
      )
      chrome.webRequest.onHeadersReceived.addListener(
        () => {
          throw new Error('listener broke')
        },
        { urls: [] },
        ['blocking']
      )
      chrome.webRequest.onBeforeSendHeaders.addListener(
        () => Promise.reject(new Error('later')),
        {
          urls: []
        },
        ['blocking']
      )
      host.deliver('onBeforeRequest', [{ requestId: '1' }, 1], { unfiltered: false, matched: [1] })
      host.deliver('onAuthRequired', [{ requestId: '2' }, 2], { unfiltered: false, matched: [2] })
      host.deliver('onHeadersReceived', [{ requestId: '3' }, 3], {
        unfiltered: false,
        matched: [3]
      })
      host.deliver('onBeforeSendHeaders', [{ requestId: '4' }, 4], {
        unfiltered: false,
        matched: [4]
      })
      // The callback and the throw answer at once; the promises after they settle.
      expect(answers(host)).toEqual([
        { token: 2, response: { cancel: true } },
        { token: 3, response: undefined }
      ])
      await Promise.resolve()
      await Promise.resolve()
      expect(answers(host).slice(2)).toEqual([
        { token: 1, response: { redirectUrl: 'https://safe.example/' } },
        { token: 4, response: undefined }
      ])
      // The listener's exception and the rejection surface in the context, off the delivery path.
      expect(() => vi.advanceTimersToNextTimer()).toThrow('listener broke')
      expect(() => vi.advanceTimersToNextTimer()).toThrow('later')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})
