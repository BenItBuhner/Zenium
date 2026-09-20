import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installExtensionApi,
  type EventDelivery,
  type InvokeResult,
  type ShimHost
} from '../api/shim'
import { API_SPEC } from '../api/spec'
import { SYSTEM_DISPLAY_CROS_ONLY_METHODS } from '../api/systemDisplay'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke at the patched globals
type Any = any

const ID = 'abcdefghijklmnopabcdefghijklmnop'

interface FakeHost extends ShimHost {
  calls: Array<{ namespace: string; method: string; args: unknown[] }>
  respond: (namespace: string, method: string, args: unknown[]) => InvokeResult
  deliver: (namespace: string, event: string, args: unknown[]) => void
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
    },
    deliver: (namespace, event, args) => onEvent?.(namespace, event, args, undefined)
  }
  return host
}

const nativeEvent = (): Any => ({
  addListener: vi.fn(),
  removeListener: vi.fn(),
  hasListener: vi.fn(() => false)
})

/** The engine's own `chrome.system.display`: every function rejects, the event never fires. */
function engineSystemDisplay(): Any {
  const inert: Any = { onDisplayChanged: nativeEvent() }
  for (const name of ['getInfo', 'getDisplayLayout', ...SYSTEM_DISPLAY_CROS_ONLY_METHODS]) {
    inert[name] = vi.fn(() => Promise.reject(new Error('System display API is not available.')))
  }
  return inert
}

function install(
  permissions: string[],
  engine: { system?: Any } = {}
): { chrome: Any; host: FakeHost; engine: Any } {
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
    storage: { local: {}, session: {}, onChanged: nativeEvent() },
    ...engine
  }
  Object.defineProperty(g, 'chrome', { value: chrome, configurable: true, writable: true })
  Object.defineProperty(g, 'browser', { value: chrome, configurable: true, writable: true })
  const host = fakeHost()
  installExtensionApi(host, API_SPEC)
  return { chrome: g.chrome, host, engine: engine.system }
}

describe('chrome.system.display in the shim', () => {
  const g = globalThis as Any

  afterEach(() => {
    delete g.chrome
    delete g.browser
    vi.restoreAllMocks()
  })

  it('replaces the engine\u2019s inert functions in place and routes getInfo to the host as system.display', async () => {
    const engine = { system: { display: engineSystemDisplay() } }
    const nativeGetInfo = engine.system.display.getInfo
    const { chrome, host } = install(['system.display'], engine)
    expect(chrome.system).toBe(engine.system)
    expect(chrome.system.display).toBe(engine.system.display)
    expect(chrome.system.display.getInfo).not.toBe(nativeGetInfo)
    const infos = [{ id: '1', isPrimary: true }]
    host.respond = () => ({ ok: true, value: infos })
    await expect(chrome.system.display.getInfo()).resolves.toEqual(infos)
    await expect(chrome.system.display.getInfo({ singleUnified: true })).resolves.toEqual(infos)
    expect(host.calls.map((c) => [c.namespace, c.method, c.args])).toEqual([
      ['system.display', 'getInfo', [undefined]],
      ['system.display', 'getInfo', [{ singleUnified: true }]]
    ])
    expect(chrome.system.display.MirrorMode).toEqual({
      OFF: 'off',
      NORMAL: 'normal',
      MIXED: 'mixed'
    })
  })

  it('answers a callback with the host\u2019s result and its error through runtime.lastError', async () => {
    const { chrome, host } = install(['system.display'], {
      system: { display: engineSystemDisplay() }
    })
    host.respond = (_ns, method) =>
      method === 'getInfo'
        ? { ok: true, value: [] }
        : { ok: false, error: 'Function available only on ChromeOS.' }
    const got = await new Promise((resolve) => chrome.system.display.getInfo(resolve))
    expect(got).toEqual([])
    const seen = await new Promise((resolve) =>
      chrome.system.display.setMirrorMode({ mode: 'off' }, () =>
        resolve(chrome.runtime.lastError?.message)
      )
    )
    expect(seen).toBe('Function available only on ChromeOS.')
  })

  it('makes chrome.system.display for a declaring extension the engine gave none, and none otherwise', () => {
    expect(install(['system.display']).chrome.system?.display?.getInfo).toBeTypeOf('function')
    const { chrome } = install(['tabs'])
    expect(chrome.system).toBeUndefined()
  })

  it('delivers onDisplayChanged from the host', () => {
    const { chrome, host } = install(['system.display'], {
      system: { display: engineSystemDisplay() }
    })
    const listener = vi.fn()
    chrome.system.display.onDisplayChanged.addListener(listener)
    host.deliver('system.display', 'onDisplayChanged', [])
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
