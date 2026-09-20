import { afterEach, describe, expect, it, vi } from 'vitest'
import { installExtensionApi, type InvokeResult, type ShimHost } from '../api/shim'
import { API_SPEC } from '../api/spec'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke at the patched globals
type Any = any

const ID = 'abcdefghijklmnopabcdefghijklmnop'

interface FakeHost extends ShimHost {
  calls: Array<{ namespace: string; method: string; args: unknown[] }>
  notifications: Array<{ kind: string; payload: unknown }>
  respond: (namespace: string, method: string, args: unknown[]) => InvokeResult
  deliver(namespace: string, event: string, args: unknown[]): void
}

function fakeHost(): FakeHost {
  let listener: ((namespace: string, event: string, args: unknown[]) => void) | null = null
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
    deliver(namespace, event, args) {
      listener?.(namespace, event, args)
    }
  }
  return host
}

/** Electron's inert `chrome.proxy`: the binding exists, its calls reject. */
function inertProxy(): Any {
  const denied = (): Promise<never> => Promise.reject(new Error('Access to extension API denied.'))
  return {
    settings: {
      get: denied,
      set: denied,
      clear: denied,
      onChange: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn() }
    },
    onProxyError: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn() }
  }
}

interface Inert {
  namespace: Any
  /** The engine's `proxy.settings` as it was before the shim ran. */
  settings: Any
}

function install(permissions: string[] = ['proxy']): { chrome: Any; host: FakeHost; inert: Inert } {
  const g = globalThis as Any
  const manifest = { manifest_version: 3, name: 'Probe', version: '1.0', permissions }
  const nativeEvent = (): Any => ({
    addListener: vi.fn(),
    removeListener: vi.fn(),
    hasListener: vi.fn(() => false)
  })
  const namespace = inertProxy()
  const inert: Inert = { namespace, settings: namespace.settings }
  const chrome: Any = {
    runtime: {
      id: ID,
      getManifest: () => manifest,
      getURL: (path: string) => `chrome-extension://${ID}/${path}`,
      sendMessage: vi.fn(),
      onMessage: nativeEvent()
    },
    storage: { local: {}, session: {}, onChanged: nativeEvent() },
    proxy: namespace
  }
  Object.defineProperty(g, 'chrome', { value: chrome, configurable: true, writable: true })
  Object.defineProperty(g, 'browser', { value: chrome, configurable: true, writable: true })
  const host = fakeHost()
  installExtensionApi(host, API_SPEC)
  return { chrome: g.chrome, host, inert }
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('chrome.proxy in the shim', () => {
  const g = globalThis as Any

  afterEach(() => {
    delete g.chrome
    delete g.browser
    vi.restoreAllMocks()
  })

  it('replaces the engine\u2019s inert proxy.settings for extensions holding the permission, and leaves the rest alone', async () => {
    const { chrome, inert } = install()
    // The engine's namespace object stays (Electron's), its inert setting is replaced on it.
    expect(chrome.proxy).toBe(inert.namespace)
    expect(chrome.proxy.settings).not.toBe(inert.settings)
    expect(typeof chrome.proxy.settings.get).toBe('function')
    expect(typeof chrome.proxy.settings.set).toBe('function')
    expect(typeof chrome.proxy.settings.clear).toBe('function')
    expect(typeof chrome.proxy.settings.onChange.addListener).toBe('function')
    expect(g.browser.proxy.settings).toBe(chrome.proxy.settings)
    expect(chrome.proxy.Mode.PAC_SCRIPT).toBe('pac_script')
    expect(chrome.proxy.Scheme.SOCKS5).toBe('socks5')
    delete g.chrome
    delete g.browser
    // The engine made the namespace for an extension without the permission too (Chrome would
    // not): patched regardless, so the host answers with the permission error, not the engine.
    const without = install(['storage'])
    expect(without.chrome.proxy.settings).not.toBe(without.inert.settings)
    without.host.respond = () => ({
      ok: false,
      error: 'You do not have permission to access the preference \u2018proxy\u2019.'
    })
    await expect(without.chrome.proxy.settings.get({})).rejects.toThrow(
      'You do not have permission to access the preference'
    )
    expect(without.host.calls).toEqual([
      { namespace: 'proxy', method: 'get', args: ['settings', {}] }
    ])
  })

  it('routes get / set / clear to the host with the setting named first, the way Browsec and VeePN call them', async () => {
    const { chrome, host } = install()
    const config = {
      mode: 'fixed_servers',
      rules: { singleProxy: { scheme: 'https', host: 'p.example', port: 443 }, bypassList: [] }
    }
    host.respond = (_ns, method) =>
      method === 'get'
        ? { ok: true, value: { value: config, levelOfControl: 'controlled_by_this_extension' } }
        : { ok: true, value: undefined }
    await expect(
      chrome.proxy.settings.set({
        value: { mode: 'pac_script', pacScript: { data: 'x' } },
        scope: 'regular'
      })
    ).resolves.toBe(undefined)
    await expect(chrome.proxy.settings.get({})).resolves.toEqual({
      value: config,
      levelOfControl: 'controlled_by_this_extension'
    })
    const cleared = vi.fn()
    chrome.proxy.settings.clear({ scope: 'regular' }, cleared)
    await flush()
    expect(cleared).toHaveBeenCalledWith()
    expect(host.calls).toEqual([
      {
        namespace: 'proxy',
        method: 'set',
        args: [
          'settings',
          { value: { mode: 'pac_script', pacScript: { data: 'x' } }, scope: 'regular' }
        ]
      },
      { namespace: 'proxy', method: 'get', args: ['settings', {}] },
      { namespace: 'proxy', method: 'clear', args: ['settings', { scope: 'regular' }] }
    ])
  })

  it('reports host errors through the promise or runtime.lastError', async () => {
    const { chrome, host } = install()
    host.respond = () => ({
      ok: false,
      error: "Proxy mode 'fixed_servers' requires a 'rules' field."
    })
    await expect(chrome.proxy.settings.set({ value: { mode: 'fixed_servers' } })).rejects.toThrow(
      "Proxy mode 'fixed_servers' requires a 'rules' field."
    )
    const callback = vi.fn(() => {
      expect(chrome.runtime.lastError?.message).toBe(
        "Proxy mode 'fixed_servers' requires a 'rules' field."
      )
    })
    chrome.proxy.settings.set({ value: { mode: 'fixed_servers' } }, callback)
    await flush()
    expect(callback).toHaveBeenCalledTimes(1)
    expect(() => chrome.proxy.settings.get()).toThrow(
      'Error in invocation of types.ChromeSetting.get(object details, optional function callback): No matching signature.'
    )
  })

  it('delivers settings.onChange and onProxyError from the host', () => {
    const { chrome, host } = install()
    const changed = vi.fn()
    const failed = vi.fn()
    chrome.proxy.settings.onChange.addListener(changed)
    chrome.proxy.onProxyError.addListener(failed)
    expect(host.notifications).toContainEqual({
      kind: 'listen',
      payload: { event: 'proxy.settings.onChange' }
    })
    expect(host.notifications).toContainEqual({
      kind: 'listen',
      payload: { event: 'proxy.onProxyError' }
    })
    const details = { value: { mode: 'system' }, levelOfControl: 'controllable_by_this_extension' }
    host.deliver('proxy', 'settings.onChange', [details])
    expect(changed).toHaveBeenCalledWith(details)
    const error = { fatal: true, error: 'net::ERR_PROXY_CONFIGURATION_INVALID', details: 'x' }
    host.deliver('proxy', 'onProxyError', [error])
    expect(failed).toHaveBeenCalledWith(error)
    expect(changed).toHaveBeenCalledTimes(1)
  })
})
