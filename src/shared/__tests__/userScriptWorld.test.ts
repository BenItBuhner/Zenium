// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DISCONNECTED_PORT_ERROR,
  WORLD_EVALUATOR,
  WORLD_NO_RECEIVER_ERROR,
  installUserScriptWorldApi,
  type PreloadToWorld,
  type WorldApiConfig,
  type WorldEvalResult,
  type WorldToPreload
} from '../userScriptWorld'

const EXT = 'abcdefghijklmnopabcdefghijklmnop'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the world's untyped `chrome`
type Any = any

interface World {
  root: Any
  chrome: Any
  posted: WorldToPreload[]
  send(payload: PreloadToWorld): void
}

function install(overrides: Partial<WorldApiConfig> = {}): World {
  const config: WorldApiConfig = {
    extensionId: EXT,
    incognito: false,
    messaging: true,
    inbound: 'in-' + Math.random().toString(36).slice(2),
    outbound: 'out-' + Math.random().toString(36).slice(2),
    ...overrides
  }
  const posted: WorldToPreload[] = []
  document.addEventListener(config.outbound, (event) => {
    posted.push(JSON.parse(String((event as CustomEvent).detail)) as WorldToPreload)
  })
  const root: Any = { document }
  installUserScriptWorldApi(config, root)
  return {
    root,
    chrome: root.chrome,
    posted,
    send: (payload) =>
      document.dispatchEvent(new CustomEvent(config.inbound, { detail: JSON.stringify(payload) }))
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('installUserScriptWorldApi', () => {
  let errors: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    errors.mockRestore()
  })

  it('installs chrome and browser (the same object) with the identity members', () => {
    const { root, chrome } = install({ incognito: true })
    expect(root.browser).toBe(chrome)
    expect(chrome.runtime.id).toBe(EXT)
    expect(chrome.runtime.getURL('/a/b.js')).toBe(`chrome-extension://${EXT}/a/b.js`)
    expect(chrome.extension.getURL('x')).toBe(`chrome-extension://${EXT}/x`)
    expect(chrome.extension.inIncognitoContext).toBe(true)
    expect(chrome.runtime.lastError).toBeUndefined()
    expect(typeof chrome.runtime.onMessage.addListener).toBe('function')
    expect(typeof chrome.runtime.onConnect.addListener).toBe('function')
  })

  it('has no sendMessage or connect while messaging is off, as in Chrome', () => {
    const { chrome } = install({ messaging: false })
    expect(chrome.runtime.sendMessage).toBeUndefined()
    expect(chrome.runtime.connect).toBeUndefined()
    expect(typeof chrome.runtime.onMessage.addListener).toBe('function')
  })

  it('is self-contained: its source evaluates in a fresh scope', () => {
    const source = `return (${installUserScriptWorldApi.toString()})(config, root)`
    const root: Any = { document }
    const run = new Function('config', 'root', source) as (c: WorldApiConfig, r: object) => void
    run({ extensionId: EXT, incognito: false, messaging: true, inbound: 'i', outbound: 'o' }, root)
    expect(root.chrome.runtime.id).toBe(EXT)
    expect(typeof root[WORLD_EVALUATOR]).toBe('function')
    expect(root.chrome.runtime.connect({ name: 'p' }).name).toBe('p')
  })

  describe('runtime.sendMessage', () => {
    it('posts the message and resolves with the response under its id', async () => {
      const { chrome, posted, send } = install()
      const promise = chrome.runtime.sendMessage({ hello: 1 }) as Promise<unknown>
      expect(posted).toEqual([{ kind: 'message', id: 1, message: { hello: 1 } }])
      send({ kind: 'response', id: 1, result: { ok: true } })
      await expect(promise).resolves.toEqual({ ok: true })
    })

    it('rejects with the error the preload reports', async () => {
      const { chrome, send } = install()
      const promise = chrome.runtime.sendMessage('x') as Promise<unknown>
      send({ kind: 'response', id: 1, error: 'nope' })
      await expect(promise).rejects.toThrow('nope')
    })

    it('takes the (extensionId, message, options, callback) forms', async () => {
      const { chrome, posted, send } = install()
      const callback = vi.fn()
      expect(chrome.runtime.sendMessage(EXT, 'm', {}, callback)).toBeUndefined()
      expect(posted[0]).toEqual({ kind: 'message', id: 1, message: 'm' })
      send({ kind: 'response', id: 1, result: 42 })
      await flush()
      expect(callback).toHaveBeenCalledWith(42)
      expect(chrome.runtime.sendMessage(null, 'n')).toBeInstanceOf(Promise)
      expect(posted[1]).toEqual({ kind: 'message', id: 2, message: 'n' })
    })

    it('reports a failure through runtime.lastError to a callback, unchecked ones to the console', async () => {
      const { chrome, send } = install()
      let seen: unknown = 'unset'
      chrome.runtime.sendMessage('m', () => {
        seen = chrome.runtime.lastError
      })
      send({ kind: 'response', id: 1, error: 'gone' })
      await flush()
      expect(seen).toEqual({ message: 'gone' })
      expect(chrome.runtime.lastError).toBeUndefined()
      expect(errors).not.toHaveBeenCalled()
      chrome.runtime.sendMessage('m', () => undefined)
      send({ kind: 'response', id: 2, error: 'gone again' })
      await flush()
      expect(errors).toHaveBeenCalledWith('Unchecked runtime.lastError: gone again')
    })

    it('another extension has no receiver; a missing message is a signature error', async () => {
      const { chrome, posted } = install()
      await expect(chrome.runtime.sendMessage('a'.repeat(32), 'm')).rejects.toThrow(
        WORLD_NO_RECEIVER_ERROR
      )
      expect(posted).toEqual([])
      expect(() => chrome.runtime.sendMessage()).toThrow(TypeError)
    })
  })

  describe('runtime.connect', () => {
    it('opens a port, relays traffic both ways and disconnects', () => {
      const { chrome, posted, send } = install()
      const port = chrome.runtime.connect({ name: 'chan' })
      expect(port.name).toBe('chan')
      const connect = posted[0]
      expect(connect.kind).toBe('connect')
      const portId = (connect as { portId: string }).portId
      expect(connect).toEqual({ kind: 'connect', portId, name: 'chan' })

      const received: unknown[] = []
      port.onMessage.addListener((message: unknown, p: unknown) => {
        received.push([message, p === port])
      })
      port.postMessage({ n: 1 })
      expect(posted[1]).toEqual({ kind: 'port-message', portId, message: { n: 1 } })
      expect(() => port.postMessage(undefined)).toThrow(TypeError)
      send({ kind: 'port-message', portId, message: 'back' })
      expect(received).toEqual([['back', true]])

      const disconnected = vi.fn()
      port.onDisconnect.addListener(disconnected)
      port.disconnect()
      expect(posted[2]).toEqual({ kind: 'port-disconnect', portId })
      expect(() => port.postMessage('x')).toThrow(DISCONNECTED_PORT_ERROR)
      // The world's own disconnect fires no onDisconnect (Chrome fires it at the other end).
      expect(disconnected).not.toHaveBeenCalled()
      port.disconnect()
      expect(posted).toHaveLength(3)
    })

    it('a disconnect from the other end fires onDisconnect, with lastError when it carries one', () => {
      const { chrome, posted, send } = install()
      const port = chrome.runtime.connect()
      expect(port.name).toBe('')
      const portId = (posted[0] as { portId: string }).portId
      let seen: unknown = 'unset'
      port.onDisconnect.addListener(() => {
        seen = chrome.runtime.lastError
      })
      send({ kind: 'port-disconnect', portId, error: 'Receiving end does not exist.' })
      expect(seen).toEqual({ message: 'Receiving end does not exist.' })
      expect(chrome.runtime.lastError).toBeUndefined()
      expect(() => port.postMessage('x')).toThrow(DISCONNECTED_PORT_ERROR)
    })

    it('connecting to another extension disconnects on its own with no receiver', async () => {
      const { chrome, posted } = install()
      const port = chrome.runtime.connect('b'.repeat(32), { name: 'x' })
      const seen: unknown[] = []
      port.onDisconnect.addListener(() => seen.push(chrome.runtime.lastError))
      await flush()
      expect(seen).toEqual([{ message: WORLD_NO_RECEIVER_ERROR }])
      expect(posted).toEqual([])
    })
  })

  describe('runtime.onMessage deliveries', () => {
    it('answers unhandled when nobody listens', () => {
      const { posted, send } = install({ messaging: false })
      send({ kind: 'deliver', token: 7, message: 'm', sender: { id: EXT } })
      expect(posted).toEqual([{ kind: 'response', token: 7, handled: false, responded: false }])
    })

    it('a synchronous sendResponse answers with the result; later calls are ignored', () => {
      const { chrome, posted, send } = install()
      const sender = { id: EXT, url: `chrome-extension://${EXT}/bg.js` }
      chrome.runtime.onMessage.addListener(
        (message: unknown, from: unknown, sendResponse: (r?: unknown) => void) => {
          expect(from).toEqual(sender)
          sendResponse({ echo: message })
          sendResponse('again')
        }
      )
      send({ kind: 'deliver', token: 1, message: 'hi', sender })
      expect(posted).toEqual([
        { kind: 'response', token: 1, handled: true, responded: true, result: { echo: 'hi' } }
      ])
    })

    it('a listener returning true keeps the channel open for an asynchronous response', async () => {
      const { chrome, posted, send } = install()
      chrome.runtime.onMessage.addListener(
        (_m: unknown, _s: unknown, sendResponse: (r?: unknown) => void) => {
          setTimeout(() => sendResponse('late'), 0)
          return true
        }
      )
      send({ kind: 'deliver', token: 2, message: 'hi', sender: null })
      expect(posted).toEqual([])
      await flush()
      expect(posted).toEqual([
        { kind: 'response', token: 2, handled: true, responded: true, result: 'late' }
      ])
    })

    it('a listener returning a promise answers with its value', async () => {
      const { chrome, posted, send } = install()
      chrome.runtime.onMessage.addListener(async () => 'promised')
      send({ kind: 'deliver', token: 3, message: 'hi', sender: null })
      await flush()
      expect(posted).toEqual([
        { kind: 'response', token: 3, handled: true, responded: true, result: 'promised' }
      ])
    })

    it('listeners that neither respond nor return true close the channel without a response', () => {
      vi.useFakeTimers()
      try {
        const { chrome, posted, send } = install()
        chrome.runtime.onMessage.addListener(() => undefined)
        chrome.runtime.onMessage.addListener(() => {
          throw new Error('listener bug')
        })
        send({ kind: 'deliver', token: 4, message: 'hi', sender: null })
        expect(posted).toEqual([{ kind: 'response', token: 4, handled: true, responded: false }])
        // A listener's exception surfaces on its own turn (the world's console), not to the sender.
        expect(() => vi.runAllTimers()).toThrow('listener bug')
      } finally {
        vi.useRealTimers()
      }
    })

    it('removeListener and hasListener work on the event', () => {
      const { chrome } = install()
      const fn = (): void => undefined
      chrome.runtime.onMessage.addListener(fn)
      expect(chrome.runtime.onMessage.hasListener(fn)).toBe(true)
      expect(chrome.runtime.onMessage.hasListeners()).toBe(true)
      chrome.runtime.onMessage.removeListener(fn)
      expect(chrome.runtime.onMessage.hasListeners()).toBe(false)
    })
  })

  describe('the evaluator for userScripts.execute', () => {
    it('returns the last expression, or the error', () => {
      const { root } = install()
      const evaluate = root[WORLD_EVALUATOR] as (code: string) => WorldEvalResult
      expect(evaluate('1 + 2')).toEqual({ value: 3 })
      expect(evaluate('null.x')).toEqual({
        error: "TypeError: Cannot read properties of null (reading 'x')"
      })
      expect(evaluate('throw "plain"')).toEqual({ error: 'plain' })
    })

    it('ignores malformed inbound events', () => {
      const { posted, send } = install()
      document.dispatchEvent(new CustomEvent('nothing'))
      send({ kind: 'response', id: 99 })
      send({ kind: 'port-message', portId: 'missing', message: 1 })
      send({ kind: 'port-disconnect', portId: 'missing' })
      expect(posted).toEqual([])
    })
  })
})
