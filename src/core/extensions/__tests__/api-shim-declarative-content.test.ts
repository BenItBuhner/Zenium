import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installExtensionApi,
  type EventDelivery,
  type InvokeResult,
  type ShimHost
} from '../api/shim'
import { API_SPEC } from '../api/spec'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke at the patched globals
type Any = any

const ID = 'abcdefghijklmnopabcdefghijklmnop'

interface FakeHost extends ShimHost {
  calls: Array<{ namespace: string; method: string; args: unknown[] }>
  respond: (namespace: string, method: string, args: unknown[]) => InvokeResult
}

function fakeHost(): FakeHost {
  let onEvent:
    ((namespace: string, event: string, args: unknown[], delivery?: EventDelivery) => void) | null =
    null
  const host: FakeHost = {
    kind: 'worker',
    calls: [],
    respond: () => ({ ok: true, value: undefined }),
    invoke(namespace, method, args) {
      host.calls.push({ namespace, method, args })
      return Promise.resolve(host.respond(namespace, method, args))
    },
    notify: vi.fn(),
    onEvent: (listener) => {
      onEvent = listener
    }
  }
  void onEvent
  return host
}

const nativeEvent = (): Any => ({
  addListener: vi.fn(),
  removeListener: vi.fn(),
  hasListener: vi.fn(() => false)
})

function install(permissions: string[]): { chrome: Any; host: FakeHost } {
  const g = globalThis as Any
  const manifest = { manifest_version: 3, name: 'Probe', version: '1.0', permissions }
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
  Object.defineProperty(g, 'chrome', { value: chrome, configurable: true, writable: true })
  Object.defineProperty(g, 'browser', { value: chrome, configurable: true, writable: true })
  const host = fakeHost()
  installExtensionApi(host, API_SPEC)
  return { chrome: g.chrome, host }
}

afterEach(() => {
  const g = globalThis as Any
  Reflect.deleteProperty(g, 'chrome')
  Reflect.deleteProperty(g, 'browser')
})

describe('chrome.declarativeContent in the shim (Android compat round 24)', () => {
  it('exists for an extension holding the permission alone, with the constructors, the one event and the instanceType enums', () => {
    const { chrome } = install(['declarativeContent'])
    expect(typeof chrome.declarativeContent).toBe('object')
    expect(typeof chrome.declarativeContent.PageStateMatcher).toBe('function')
    expect(typeof chrome.declarativeContent.ShowAction).toBe('function')
    expect(typeof chrome.declarativeContent.ShowPageAction).toBe('function')
    expect(typeof chrome.declarativeContent.SetIcon).toBe('function')
    expect(typeof chrome.declarativeContent.RequestContentScript).toBe('function')
    expect(typeof chrome.declarativeContent.onPageChanged.addRules).toBe('function')
    expect(typeof chrome.declarativeContent.onPageChanged.addListener).toBe('function')
    expect(chrome.declarativeContent.PageStateMatcherInstanceType).toEqual({
      DECLARATIVE_CONTENT_PAGE_STATE_MATCHER: 'declarativeContent.PageStateMatcher'
    })
    expect(chrome.declarativeContent.ShowActionInstanceType).toEqual({
      DECLARATIVE_CONTENT_SHOW_ACTION: 'declarativeContent.ShowAction'
    })
    const without = install(['storage'])
    expect(without.chrome.declarativeContent).toBeUndefined()
  })

  it("the constructors copy the details' own properties onto the instance under Chrome's instanceType word, refusing what the schema does not name – what a rule carries to the host", () => {
    const { chrome } = install(['declarativeContent'])
    const matcher = new chrome.declarativeContent.PageStateMatcher({
      pageUrl: { hostSuffix: 'instagram.com' }
    })
    expect(matcher).toEqual({
      pageUrl: { hostSuffix: 'instagram.com' },
      instanceType: 'declarativeContent.PageStateMatcher'
    })
    expect(matcher).toBeInstanceOf(chrome.declarativeContent.PageStateMatcher)
    expect(JSON.parse(JSON.stringify(matcher))).toEqual({
      pageUrl: { hostSuffix: 'instagram.com' },
      instanceType: 'declarativeContent.PageStateMatcher'
    })
    expect({ ...new chrome.declarativeContent.ShowAction() }).toEqual({
      instanceType: 'declarativeContent.ShowAction'
    })
    // Chrome's renderer maps the deprecated constructor to the ShowAction word (its action
    // factory knows no other).
    expect({ ...new chrome.declarativeContent.ShowPageAction() }).toEqual({
      instanceType: 'declarativeContent.ShowAction'
    })
    const imageData = { 19: { data: [0, 0, 0, 0], width: 1, height: 1 } }
    expect({ ...new chrome.declarativeContent.SetIcon({ imageData }) }).toEqual({
      imageData,
      instanceType: 'declarativeContent.SetIcon'
    })
    // The word cannot be talked over by the details.
    expect(
      new chrome.declarativeContent.PageStateMatcher({
        instanceType: 'declarativeContent.ShowAction'
      }).instanceType
    ).toBe('declarativeContent.PageStateMatcher')
    // The binding's TypeErrors: a property the type's schema does not name, a second argument,
    // a non-object first one.
    expect(() => new chrome.declarativeContent.PageStateMatcher({ hostSuffix: 'x' })).toThrow(
      new TypeError("Invalid invocation: Unexpected property: 'hostSuffix'.")
    )
    expect(() => new chrome.declarativeContent.SetIcon({ path: 'on.png' })).toThrow(
      new TypeError("Invalid invocation: Unexpected property: 'path'.")
    )
    expect(() => new chrome.declarativeContent.ShowAction({}, {})).toThrow(
      new TypeError('Invalid invocation.')
    )
    expect(() => new chrome.declarativeContent.PageStateMatcher('x')).toThrow(
      new TypeError('Invalid invocation.')
    )
    // Called without `new`, as Chrome allows: the same object, plain.
    expect(chrome.declarativeContent.ShowAction()).toEqual({
      instanceType: 'declarativeContent.ShowAction'
    })
  })

  it("onPageChanged's rule members route to the host with the event's name first – Story Saver's removeRules(undefined, cb) then addRules(rules) – and answer by callback or promise, a failure as runtime.lastError", async () => {
    const { chrome, host } = install(['declarativeContent'])
    const added = [{ id: '_0_', priority: 100, conditions: [], actions: [] }]
    host.respond = (_ns, method) =>
      method === 'addRules'
        ? { ok: true, value: added }
        : method === 'getRules'
          ? { ok: true, value: [] }
          : { ok: true, value: undefined }
    const removed = await new Promise<unknown[]>((resolve) => {
      chrome.declarativeContent.onPageChanged.removeRules(undefined, (...args: unknown[]) =>
        resolve(args)
      )
    })
    expect(removed).toEqual([])
    expect(host.calls).toEqual([
      { namespace: 'declarativeContent', method: 'removeRules', args: ['onPageChanged', undefined] }
    ])
    const rule = {
      conditions: [
        new chrome.declarativeContent.PageStateMatcher({ pageUrl: { hostSuffix: 'instagram.com' } })
      ],
      actions: [new chrome.declarativeContent.ShowAction()]
    }
    const result = await chrome.declarativeContent.onPageChanged.addRules([rule])
    expect(result).toEqual(added)
    expect(host.calls[1]).toEqual({
      namespace: 'declarativeContent',
      method: 'addRules',
      args: [
        'onPageChanged',
        [
          {
            conditions: [
              {
                pageUrl: { hostSuffix: 'instagram.com' },
                instanceType: 'declarativeContent.PageStateMatcher'
              }
            ],
            actions: [{ instanceType: 'declarativeContent.ShowAction' }]
          }
        ]
      ]
    })
    await chrome.declarativeContent.onPageChanged.getRules(['_0_'])
    expect(host.calls[2]).toEqual({
      namespace: 'declarativeContent',
      method: 'getRules',
      args: ['onPageChanged', ['_0_']]
    })
    // A refusal of the host's is the callback's runtime.lastError, or a rejection.
    host.respond = () => ({ ok: false, error: 'Id _0_ was used multiple times.' })
    const lastError = await new Promise<unknown>((resolve) => {
      chrome.declarativeContent.onPageChanged.addRules([rule], () =>
        resolve(chrome.runtime.lastError?.message)
      )
    })
    expect(lastError).toBe('Id _0_ was used multiple times.')
    await expect(chrome.declarativeContent.onPageChanged.addRules([rule])).rejects.toThrow(
      'Id _0_ was used multiple times.'
    )
    // Every other event's rule members stay inert (Chrome defines them on each chrome.Event).
    expect(chrome.tabs.onUpdated.addRules([rule])).toBeUndefined()
    expect(host.calls).toHaveLength(5)
  })
})
