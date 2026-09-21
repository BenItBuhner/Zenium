import { afterEach, describe, expect, it, vi } from 'vitest'
import { installExtensionApi, type ShimHost } from '../api/shim'
import { API_SPEC } from '../api/spec'
import { NATIVE_HOST_NOT_FOUND } from '../api/engine'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke at the patched globals
type Any = any

const ID = 'abcdefghijklmnopabcdefghijklmnop'
/** What Electron's messaging delegate answers every native host with; extensions do not know it. */
const ELECTRON_POLICY_REFUSAL =
  'Access to the native messaging host was disabled by the system administrator.'

function fakeHost(kind: 'frame' | 'worker'): ShimHost {
  return {
    kind,
    invoke: () => Promise.resolve({ ok: true, value: undefined }),
    notify: () => undefined,
    onEvent: () => undefined
  }
}

/** The engine's bindings as Electron exposes them to an extension holding `nativeMessaging`. */
function engineNativeMessaging(): { connectNative: Any; sendNativeMessage: Any } {
  return {
    connectNative: vi.fn(() => ({ name: '', onDisconnect: { addListener: vi.fn() } })),
    sendNativeMessage: vi.fn((_app: string, _msg: unknown, cb?: (r: unknown) => void) => {
      if (cb) setTimeout(() => cb(undefined), 0)
      return Promise.reject(new Error(ELECTRON_POLICY_REFUSAL))
    })
  }
}

function install(
  kind: 'frame' | 'worker',
  permissions: string[],
  aliased = true
): { chrome: Any; browser: Any; engine: ReturnType<typeof engineNativeMessaging> } {
  const g = globalThis as Any
  const manifest = { manifest_version: 3, name: 'Probe', version: '1.0', permissions }
  const nativeEvent = (): Any => ({
    addListener: vi.fn(),
    removeListener: vi.fn(),
    hasListener: vi.fn(() => false)
  })
  const engine = engineNativeMessaging()
  const chrome: Any = {
    runtime: {
      id: ID,
      getManifest: () => manifest,
      getURL: (path: string) => `chrome-extension://${ID}/${path}`,
      sendMessage: vi.fn(),
      onMessage: nativeEvent(),
      ...(permissions.includes('nativeMessaging') ? engine : {})
    },
    storage: { local: {}, session: {}, onChanged: nativeEvent() }
  }
  const browser: Any = aliased
    ? chrome
    : { runtime: { ...chrome.runtime }, storage: chrome.storage }
  Object.defineProperty(g, 'chrome', { value: chrome, configurable: true, writable: true })
  Object.defineProperty(g, 'browser', { value: browser, configurable: true, writable: true })
  installExtensionApi(fakeHost(kind), API_SPEC)
  return { chrome: g.chrome, browser: g.browser, engine }
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('native messaging in the shim', () => {
  const g = globalThis as Any

  afterEach(() => {
    delete g.chrome
    delete g.browser
    vi.restoreAllMocks()
  })

  it("connectNative answers a Port at once and Chrome's not-found disconnect a moment later, lastError set while the listeners run", async () => {
    const { chrome, engine } = install('worker', ['nativeMessaging'])
    const port = chrome.runtime.connectNative('signer.digital.chrome.host')
    expect(port.name).toBe('signer.digital.chrome.host')
    expect(port.sender).toBe(undefined)
    // The engine's binding, whose disconnect reason is Electron's policy refusal, is out of the way.
    expect(engine.connectNative).not.toHaveBeenCalled()
    let seen: string | undefined
    const onDisconnect = vi.fn(() => {
      seen = chrome.runtime.lastError?.message
    })
    port.onDisconnect.addListener(onDisconnect)
    // Before the disconnect, a message posted is accepted like Chrome's (the host never starts).
    expect(() => port.postMessage({ cmd: 'SDGetVersion' })).not.toThrow()
    expect(onDisconnect).not.toHaveBeenCalled()
    await flush()
    expect(onDisconnect).toHaveBeenCalledTimes(1)
    expect(onDisconnect).toHaveBeenCalledWith(port)
    expect(seen).toBe(NATIVE_HOST_NOT_FOUND)
    // Signer.Digital's test of the reason, verbatim: `message.indexOf("native messaging host not found") > 0`.
    expect(seen?.indexOf('native messaging host not found')).toBeGreaterThan(0)
    expect(chrome.runtime.lastError).toBe(undefined)
    // Chrome's disconnected-port error afterwards; a second disconnect is a no-op.
    expect(() => port.postMessage({ again: true })).toThrow(
      'Attempting to use a disconnected port object'
    )
    expect(() => port.disconnect()).not.toThrow()
    await flush()
    expect(onDisconnect).toHaveBeenCalledTimes(1)
  })

  it("a port the extension disconnects itself first never hears the host's disconnect", async () => {
    const { chrome } = install('frame', ['nativeMessaging'])
    const port = chrome.runtime.connectNative('com.example.host')
    const onDisconnect = vi.fn()
    port.onDisconnect.addListener(onDisconnect)
    port.disconnect()
    await flush()
    expect(onDisconnect).not.toHaveBeenCalled()
    expect(() => port.postMessage(undefined)).toThrow(
      'Attempting to use a disconnected port object'
    )
  })

  it("connectNative and sendNativeMessage validate their arguments with Chrome's signatures", async () => {
    const { chrome } = install('worker', ['nativeMessaging'])
    expect(() => chrome.runtime.connectNative()).toThrow(
      'Error in invocation of runtime.connectNative(string application): No matching signature.'
    )
    expect(() => chrome.runtime.connectNative(4)).toThrow(/No matching signature/)
    expect(() => chrome.runtime.sendNativeMessage('com.example.host')).toThrow(
      /No matching signature/
    )
    const port = chrome.runtime.connectNative('com.example.host')
    expect(() => port.postMessage()).toThrow(
      'Error in invocation of runtime.Port.postMessage(any message): No matching signature.'
    )
    await flush()
  })

  it("sendNativeMessage: the callback with lastError, or a rejection, with Chrome's text; browser.* alike", async () => {
    const { chrome, browser } = install('frame', ['nativeMessaging'], false)
    let seen: string | undefined
    let answer: unknown = 'unset'
    const callback = vi.fn((response: unknown) => {
      answer = response
      seen = chrome.runtime.lastError?.message
    })
    expect(chrome.runtime.sendNativeMessage('com.example.host', { text: 'ping' }, callback)).toBe(
      undefined
    )
    await flush()
    expect(callback).toHaveBeenCalledTimes(1)
    expect(answer).toBe(undefined)
    expect(seen).toBe(NATIVE_HOST_NOT_FOUND)
    await expect(browser.runtime.sendNativeMessage('com.example.host', {})).rejects.toThrow(
      NATIVE_HOST_NOT_FOUND
    )
    expect(browser.runtime.connectNative).toBe(chrome.runtime.connectNative)
  })

  it('is absent without the nativeMessaging permission, as in Chrome', () => {
    const { chrome } = install('worker', ['storage'])
    expect(chrome.runtime.connectNative).toBe(undefined)
    expect(chrome.runtime.sendNativeMessage).toBe(undefined)
  })
})
