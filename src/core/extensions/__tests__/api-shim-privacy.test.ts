import { afterEach, describe, expect, it, vi } from 'vitest'
import { installExtensionApi, type InvokeResult, type ShimHost } from '../api/shim'
import { API_SPEC } from '../api/spec'
import { PRIVACY_SETTING_NAMES } from '../api/privacy'

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
    kind: 'frame',
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

function install(permissions: string[] = ['privacy']): { chrome: Any; host: FakeHost } {
  const g = globalThis as Any
  const manifest = { manifest_version: 2, name: 'Probe', version: '1.0', permissions }
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
  Object.defineProperty(g, 'chrome', { value: chrome, configurable: true, writable: true })
  Object.defineProperty(g, 'browser', { value: chrome, configurable: true, writable: true })
  const host = fakeHost()
  installExtensionApi(host, API_SPEC)
  return { chrome: g.chrome, host }
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('chrome.privacy in the shim', () => {
  const g = globalThis as Any

  afterEach(() => {
    delete g.chrome
    delete g.browser
    vi.restoreAllMocks()
  })

  it('exists only for extensions holding the privacy permission', () => {
    expect(install(['storage']).chrome.privacy).toBeUndefined()
    delete g.chrome
    delete g.browser
    const { chrome } = install()
    expect(chrome.privacy).toBeTypeOf('object')
    expect(g.browser.privacy).toBe(chrome.privacy)
    // The namespace has no members of its own besides the objects and the enum.
    expect(chrome.privacy.get).toBeUndefined()
    expect(chrome.privacy.IPHandlingPolicy.DISABLE_NON_PROXIED_UDP).toBe('disable_non_proxied_udp')
  })

  it('builds a ChromeSetting for every setting of the table, the way uBlock Origin probes them', () => {
    const { chrome } = install()
    for (const [object, names] of Object.entries(PRIVACY_SETTING_NAMES)) {
      expect(chrome.privacy[object]).toBeInstanceOf(Object)
      for (const name of names) {
        const setting = chrome.privacy[object][name]
        expect(typeof setting.get).toBe('function')
        expect(typeof setting.set).toBe('function')
        expect(typeof setting.clear).toBe('function')
        expect(typeof setting.onChange.addListener).toBe('function')
      }
    }
    // Privacy Badger feature-detects the Privacy Sandbox settings by property.
    expect(Object.prototype.hasOwnProperty.call(chrome.privacy.websites, 'topicsEnabled')).toBe(
      true
    )
    expect(chrome.privacy.network.webRTCIPHandlingPolicy).toBe(
      g.browser.privacy.network.webRTCIPHandlingPolicy
    )
  })

  it('routes get / set / clear to the host with the setting named first', async () => {
    const { chrome, host } = install()
    host.respond = (_ns, method) =>
      method === 'get'
        ? {
            ok: true,
            value: { value: 'default', levelOfControl: 'controllable_by_this_extension' }
          }
        : { ok: true, value: undefined }
    const policy = chrome.privacy.network.webRTCIPHandlingPolicy
    await expect(policy.get({})).resolves.toEqual({
      value: 'default',
      levelOfControl: 'controllable_by_this_extension'
    })
    await expect(policy.set({ value: 'disable_non_proxied_udp', scope: 'regular' })).resolves.toBe(
      undefined
    )
    const cleared = vi.fn()
    chrome.privacy.websites.hyperlinkAuditingEnabled.clear({ scope: 'regular' }, cleared)
    await flush()
    expect(cleared).toHaveBeenCalledWith()
    expect(host.calls).toEqual([
      { namespace: 'privacy', method: 'get', args: ['network', 'webRTCIPHandlingPolicy', {}] },
      {
        namespace: 'privacy',
        method: 'set',
        args: [
          'network',
          'webRTCIPHandlingPolicy',
          { value: 'disable_non_proxied_udp', scope: 'regular' }
        ]
      },
      {
        namespace: 'privacy',
        method: 'clear',
        args: ['websites', 'hyperlinkAuditingEnabled', { scope: 'regular' }]
      }
    ])
  })

  it('needs the details object, and reports host errors through the callback or the promise', async () => {
    const { chrome, host } = install()
    const setting = chrome.privacy.websites.referrersEnabled
    expect(() => setting.get()).toThrow(
      'Error in invocation of types.ChromeSetting.get(object details, optional function callback): No matching signature.'
    )
    expect(() => setting.set('nope')).toThrow(/types\.ChromeSetting\.set/)
    host.respond = () => ({
      ok: false,
      error: 'You do not have permission to access incognito preferences.'
    })
    await expect(setting.get({ incognito: true })).rejects.toThrow(
      'You do not have permission to access incognito preferences.'
    )
    const callback = vi.fn(() => {
      expect(chrome.runtime.lastError?.message).toBe(
        'You do not have permission to access incognito preferences.'
      )
    })
    setting.get({ incognito: true }, callback)
    await flush()
    expect(callback).toHaveBeenCalledTimes(1)
    expect(chrome.runtime.lastError).toBeUndefined()
  })

  it('delivers onChange under the setting name and registers the listener with the host', () => {
    const { chrome, host } = install()
    const changed = vi.fn()
    chrome.privacy.network.networkPredictionEnabled.onChange.addListener(changed)
    expect(host.notifications).toContainEqual({
      kind: 'listen',
      payload: { event: 'privacy.network.networkPredictionEnabled.onChange' }
    })
    const details = { value: false, levelOfControl: 'controlled_by_other_extensions' }
    host.deliver('privacy', 'network.networkPredictionEnabled.onChange', [details])
    expect(changed).toHaveBeenCalledWith(details)
    // Another setting's change is not this listener's business.
    host.deliver('privacy', 'websites.doNotTrackEnabled.onChange', [{ value: true }])
    expect(changed).toHaveBeenCalledTimes(1)
    chrome.privacy.network.networkPredictionEnabled.onChange.removeListener(changed)
    expect(host.notifications).toContainEqual({
      kind: 'unlisten',
      payload: { event: 'privacy.network.networkPredictionEnabled.onChange' }
    })
  })
})
