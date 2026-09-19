import { afterEach, describe, expect, it, vi } from 'vitest'
import { installExtensionApi, type InvokeResult, type ShimHost } from '../api/shim'
import { API_SPEC } from '../api/spec'
import { USER_SCRIPTS_UNAVAILABLE_ERROR } from '../api/userScripts'
import {
  NO_RECEIVER_ERROR,
  PORT_CLOSED_ERROR,
  USER_SCRIPTS_SHIM
} from '../../../shared/userScripts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke at the patched globals
type Any = any

const ID = 'abcdefghijklmnopabcdefghijklmnop'

interface FakeHost extends ShimHost {
  calls: Array<{ namespace: string; method: string; args: unknown[] }>
  notifications: Array<{ kind: string; payload: unknown }>
  respond: (
    namespace: string,
    method: string,
    args: unknown[]
  ) => InvokeResult | Promise<InvokeResult>
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

interface Installed {
  chrome: Any
  host: FakeHost
  /** The engine's `tabs.sendMessage`, a mock the tests script per call. */
  nativeSendMessage: ReturnType<typeof vi.fn>
}

function install(
  permissions: string[] = ['userScripts'],
  toggles?: Record<string, boolean>
): Installed {
  const g = globalThis as Any
  const manifest = { manifest_version: 3, name: 'Probe', version: '1.0', permissions }
  const nativeEvent = (): Any => ({
    addListener: vi.fn(),
    removeListener: vi.fn(),
    hasListener: vi.fn(() => false)
  })
  const nativeSendMessage = vi.fn()
  const chrome: Any = {
    runtime: {
      id: ID,
      getManifest: () => manifest,
      getURL: (path: string) => `chrome-extension://${ID}/${path}`,
      sendMessage: vi.fn(),
      onMessage: nativeEvent()
    },
    tabs: { sendMessage: nativeSendMessage, query: vi.fn() },
    storage: { local: {}, session: {}, onChanged: nativeEvent() }
  }
  Object.defineProperty(g, 'chrome', { value: chrome, configurable: true, writable: true })
  Object.defineProperty(g, 'browser', { value: chrome, configurable: true, writable: true })
  const host = fakeHost()
  installExtensionApi(host, API_SPEC, toggles ? { toggles } : undefined)
  return { chrome: g.chrome, host, nativeSendMessage }
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

/** The engine's callback-style `tabs.sendMessage`: answer, or fail through `runtime.lastError`. */
function engineAnswers(
  installed: Installed,
  outcome: { response?: unknown; error?: string }
): void {
  installed.nativeSendMessage.mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as (response?: unknown) => void
    if (outcome.error !== undefined) {
      installed.chrome.runtime.lastError = { message: outcome.error }
      try {
        callback()
      } finally {
        delete installed.chrome.runtime.lastError
      }
      return
    }
    callback(outcome.response)
  })
}

describe('chrome.userScripts in the shim', () => {
  const g = globalThis as Any

  afterEach(() => {
    delete g.chrome
    delete g.browser
    vi.restoreAllMocks()
  })

  describe('the namespace and its toggle', () => {
    it('exists only for extensions declaring the userScripts permission', () => {
      expect(install([]).chrome.userScripts).toBeUndefined()
      const { chrome } = install(['userScripts'])
      expect(typeof chrome.userScripts.register).toBe('function')
      expect(chrome.userScripts.ExecutionWorld).toEqual({
        MAIN: 'MAIN',
        USER_SCRIPT: 'USER_SCRIPT'
      })
      expect(typeof chrome.runtime.onUserScriptMessage.addListener).toBe('function')
      expect(typeof chrome.runtime.onUserScriptConnect.addListener).toBe('function')
    })

    it('keeps the events off extensions without the permission', () => {
      const { chrome } = install(['tabs'])
      expect(chrome.runtime.onUserScriptMessage).toBeUndefined()
      expect(chrome.runtime.onUserScriptConnect).toBeUndefined()
    })

    it("throws Chrome's error on access while the toggle is off", () => {
      const { chrome } = install(['userScripts'], { userScripts: false })
      expect(() => chrome.userScripts).toThrow(USER_SCRIPTS_UNAVAILABLE_ERROR)
      // Feature detection the way Tampermonkey does it.
      let available = true
      try {
        void chrome.userScripts
      } catch {
        available = false
      }
      expect(available).toBe(false)
    })

    it('installs the namespace when the host turns the toggle on, and removes it when off', async () => {
      const { chrome, host } = install(['userScripts'], { userScripts: false })
      host.deliver('__zen', USER_SCRIPTS_SHIM.togglesEvent, [{ userScripts: true }])
      expect(typeof chrome.userScripts.getScripts).toBe('function')
      host.respond = () => ({ ok: true, value: [] })
      await expect(chrome.userScripts.getScripts()).resolves.toEqual([])
      expect(host.calls).toEqual([
        { namespace: 'userScripts', method: 'getScripts', args: [undefined] }
      ])
      host.deliver('__zen', USER_SCRIPTS_SHIM.togglesEvent, [{ userScripts: false }])
      expect(() => chrome.userScripts).toThrow(USER_SCRIPTS_UNAVAILABLE_ERROR)
      host.deliver('__zen', USER_SCRIPTS_SHIM.togglesEvent, [{ userScripts: true }])
      expect(typeof chrome.userScripts.register).toBe('function')
    })

    it('routes the methods with their arguments', async () => {
      const { chrome, host } = install()
      host.respond = (_ns, method) => ({
        ok: true,
        value: method === 'getScripts' ? [{ id: 'a' }] : undefined
      })
      await chrome.userScripts.register([{ id: 'a', matches: ['<all_urls>'], js: [{ code: '1' }] }])
      await chrome.userScripts.configureWorld({ messaging: true })
      await chrome.userScripts.resetWorldConfiguration()
      await expect(chrome.userScripts.getScripts({ ids: ['a'] })).resolves.toEqual([{ id: 'a' }])
      expect(host.calls.map((c) => [c.method, c.args])).toEqual([
        ['register', [[{ id: 'a', matches: ['<all_urls>'], js: [{ code: '1' }] }]]],
        ['configureWorld', [{ messaging: true }]],
        ['resetWorldConfiguration', [undefined]],
        ['getScripts', [{ ids: ['a'] }]]
      ])
    })

    it("surfaces the host's error as the rejection", async () => {
      const { chrome, host } = install()
      host.respond = () => ({ ok: false, error: "Duplicate script ID 'a'" })
      await expect(chrome.userScripts.register([{ id: 'a' }])).rejects.toThrow(
        "Duplicate script ID 'a'"
      )
    })
  })

  describe('runtime.onUserScriptMessage', () => {
    it('hands the message and sender to the listener; sendResponse answers under the token', () => {
      const { chrome, host } = install()
      const seen: unknown[] = []
      chrome.runtime.onUserScriptMessage.addListener(
        (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => {
          seen.push(message, sender)
          sendResponse({ pong: message })
        }
      )
      expect(host.notifications).toContainEqual({
        kind: 'listen',
        payload: { event: 'runtime.onUserScriptMessage' }
      })
      const sender = { id: ID, tab: { id: 4 }, frameId: 0 }
      host.deliver('runtime', 'onUserScriptMessage', ['ping', sender, 7])
      expect(seen).toEqual(['ping', sender])
      expect(host.notifications.at(-1)).toEqual({
        kind: USER_SCRIPTS_SHIM.answer,
        payload: { token: 7, responded: true, result: { pong: 'ping' } }
      })
    })

    it('closes the channel without a response when no listener keeps it open', () => {
      const { chrome, host } = install()
      chrome.runtime.onUserScriptMessage.addListener(() => undefined)
      host.deliver('runtime', 'onUserScriptMessage', ['m', {}, 8])
      expect(host.notifications.at(-1)).toEqual({
        kind: USER_SCRIPTS_SHIM.answer,
        payload: { token: 8, responded: false }
      })
    })

    it('keeps the channel open for a listener returning true, and answers with a promise', async () => {
      const { chrome, host } = install()
      let later: ((r: unknown) => void) | null = null
      chrome.runtime.onUserScriptMessage.addListener(
        (_m: unknown, _s: unknown, sendResponse: (r: unknown) => void) => {
          later = sendResponse
          return true
        }
      )
      host.deliver('runtime', 'onUserScriptMessage', ['m', {}, 9])
      expect(host.notifications.some((n) => n.kind === USER_SCRIPTS_SHIM.answer)).toBe(false)
      const respond = later as unknown as (r: unknown) => void
      respond('late')
      respond('twice')
      expect(host.notifications.filter((n) => n.kind === USER_SCRIPTS_SHIM.answer)).toEqual([
        { kind: USER_SCRIPTS_SHIM.answer, payload: { token: 9, responded: true, result: 'late' } }
      ])
      const { chrome: c2, host: h2 } = install()
      c2.runtime.onUserScriptMessage.addListener(async (m: unknown) => `async:${String(m)}`)
      h2.deliver('runtime', 'onUserScriptMessage', ['x', {}, 10])
      await flush()
      expect(h2.notifications.at(-1)).toEqual({
        kind: USER_SCRIPTS_SHIM.answer,
        payload: { token: 10, responded: true, result: 'async:x' }
      })
    })
  })

  describe('runtime.onUserScriptConnect', () => {
    it('builds the Port, accepts it once a listener took it, and relays traffic both ways', () => {
      const { chrome, host } = install()
      let port: Any = null
      chrome.runtime.onUserScriptConnect.addListener((p: Any) => {
        port = p
      })
      const sender = { id: ID, tab: { id: 2 } }
      host.deliver('runtime', 'onUserScriptConnect', [{ portId: 'p1', name: 'tm', sender }])
      expect(port.name).toBe('tm')
      expect(port.sender).toBe(sender)
      expect(host.notifications.at(-1)).toEqual({
        kind: USER_SCRIPTS_SHIM.port,
        payload: { kind: 'accept', portId: 'p1' }
      })
      port.postMessage({ up: 1 })
      expect(host.notifications.at(-1)).toEqual({
        kind: USER_SCRIPTS_SHIM.port,
        payload: { kind: 'message', portId: 'p1', message: { up: 1 } }
      })
      const got: unknown[] = []
      port.onMessage.addListener((m: unknown, p: unknown) => got.push(m, p === port))
      host.deliver('__zen', USER_SCRIPTS_SHIM.portEvent, [
        { kind: 'message', portId: 'p1', message: 'down' }
      ])
      expect(got).toEqual(['down', true])
      expect(() => port.postMessage(undefined)).toThrow(TypeError)
    })

    it("a disconnect from the world fires onDisconnect with the error in runtime.lastError; the extension's own disconnect tells the host once", () => {
      const { chrome, host } = install()
      const ports: Any[] = []
      chrome.runtime.onUserScriptConnect.addListener((p: Any) => ports.push(p))
      host.deliver('runtime', 'onUserScriptConnect', [{ portId: 'a', name: '', sender: {} }])
      host.deliver('runtime', 'onUserScriptConnect', [{ portId: 'b', name: '', sender: {} }])
      let lastError: unknown = 'unset'
      ports[0].onDisconnect.addListener(() => {
        lastError = chrome.runtime.lastError
      })
      host.deliver('__zen', USER_SCRIPTS_SHIM.portEvent, [
        { kind: 'disconnect', portId: 'a', error: 'gone' }
      ])
      expect(lastError).toEqual({ message: 'gone' })
      expect(() => ports[0].postMessage(1)).toThrow('Attempting to use a disconnected port object')
      const before = host.notifications.length
      ports[1].disconnect()
      ports[1].disconnect()
      expect(host.notifications.slice(before)).toEqual([
        { kind: USER_SCRIPTS_SHIM.port, payload: { kind: 'disconnect', portId: 'b' } }
      ])
      // Traffic for a port that is gone is dropped.
      host.deliver('__zen', USER_SCRIPTS_SHIM.portEvent, [
        { kind: 'message', portId: 'b', message: 1 }
      ])
      expect(host.notifications).toHaveLength(before + 1)
    })

    it('does not accept a port nobody listens for until a listener registers', () => {
      const { chrome, host } = install()
      host.deliver('runtime', 'onUserScriptConnect', [{ portId: 'p', name: 'late', sender: {} }])
      expect(host.notifications.some((n) => n.kind === USER_SCRIPTS_SHIM.port)).toBe(false)
      let port: Any = null
      chrome.runtime.onUserScriptConnect.addListener((p: Any) => {
        port = p
      })
      expect(port?.name).toBe('late')
      expect(host.notifications.at(-1)).toEqual({
        kind: USER_SCRIPTS_SHIM.port,
        payload: { kind: 'accept', portId: 'p' }
      })
    })
  })

  describe('tabs.sendMessage with user-script worlds', () => {
    it('leaves the engine call alone for extensions without the permission', () => {
      const installed = install(['tabs'])
      expect(installed.chrome.tabs.sendMessage).toBe(installed.nativeSendMessage)
    })

    it("resolves with the engine's response and still asks the host", async () => {
      const installed = install()
      engineAnswers(installed, { response: { from: 'content-script' } })
      installed.host.respond = () => ({ ok: true, value: { handled: false, responded: false } })
      await expect(installed.chrome.tabs.sendMessage(3, 'hi')).resolves.toEqual({
        from: 'content-script'
      })
      expect(installed.host.calls).toEqual([
        { namespace: 'userScripts', method: 'sendMessage', args: [3, 'hi', null] }
      ])
      expect(installed.nativeSendMessage).toHaveBeenCalledWith(3, 'hi', expect.any(Function))
    })

    it("resolves with a world's response when the content scripts had none", async () => {
      const installed = install()
      engineAnswers(installed, { error: NO_RECEIVER_ERROR })
      installed.host.respond = () => ({
        ok: true,
        value: { handled: true, responded: true, result: 'from-world' }
      })
      await expect(installed.chrome.tabs.sendMessage(3, 'hi', { frameId: 0 })).resolves.toBe(
        'from-world'
      )
      expect(installed.nativeSendMessage).toHaveBeenCalledWith(
        3,
        'hi',
        { frameId: 0 },
        expect.any(Function)
      )
    })

    it('rejects with no receiver when nobody listened, with the closed port when someone did', async () => {
      const installed = install()
      engineAnswers(installed, { error: NO_RECEIVER_ERROR })
      installed.host.respond = () => ({ ok: true, value: { handled: false, responded: false } })
      await expect(installed.chrome.tabs.sendMessage(3, 'hi')).rejects.toThrow(NO_RECEIVER_ERROR)
      installed.host.respond = () => ({ ok: true, value: { handled: true, responded: false } })
      await expect(installed.chrome.tabs.sendMessage(3, 'hi')).rejects.toThrow(PORT_CLOSED_ERROR)
      engineAnswers(installed, { error: PORT_CLOSED_ERROR })
      installed.host.respond = () => ({ ok: true, value: { handled: false, responded: false } })
      await expect(installed.chrome.tabs.sendMessage(3, 'hi')).rejects.toThrow(PORT_CLOSED_ERROR)
    })

    it("rejects with the engine's other errors, and reports through the callback with runtime.lastError", async () => {
      const installed = install()
      engineAnswers(installed, { error: 'No tab with id: 3.' })
      installed.host.respond = () => ({ ok: true, value: { handled: false, responded: false } })
      await expect(installed.chrome.tabs.sendMessage(3, 'hi')).rejects.toThrow('No tab with id: 3.')
      let seen: unknown = 'unset'
      installed.chrome.tabs.sendMessage(3, 'hi', () => {
        seen = installed.chrome.runtime.lastError?.message
      })
      await flush()
      expect(seen).toBe('No tab with id: 3.')
    })

    it('treats a failed host call as no worlds', async () => {
      const installed = install()
      engineAnswers(installed, { response: 'ok' })
      installed.host.respond = () => ({
        ok: false,
        error: 'userScripts.sendMessage is not available in Zenium.'
      })
      await expect(installed.chrome.tabs.sendMessage(1, 'x')).resolves.toBe('ok')
    })

    it('checks the signature', () => {
      const installed = install()
      expect(() => installed.chrome.tabs.sendMessage('3', 'hi')).toThrow(TypeError)
      expect(() => installed.chrome.tabs.sendMessage(3)).toThrow(TypeError)
    })
  })
})
