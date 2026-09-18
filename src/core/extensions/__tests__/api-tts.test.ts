import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ERROR_INVALID_LANG,
  ERROR_INVALID_OPTIONS,
  ERROR_INVALID_PITCH,
  ERROR_INVALID_RATE,
  ERROR_INVALID_VOLUME,
  ERROR_NO_PERMISSION,
  ERROR_UTTERANCE_TOO_LONG,
  MAX_UTTERANCE_LENGTH,
  TtsQueue,
  engineEventFromWebSpeech,
  normalizeSpeakOptions,
  normalizeUtterance,
  pickWebSpeechVoice,
  voiceFromWebSpeech,
  type EngineDriver,
  type EngineEvent,
  type EngineSpeakOptions,
  type TtsEvent,
  type TtsVoice,
  type Utterance
} from '../api/tts'
import { API_SPEC } from '../api/spec'
import { installExtensionApi, type InvokeResult, type ShimHost } from '../api/shim'
import { TtsApi, type SpeechEngine } from '../../../main/platform/extensionApi/tts'
import type {
  ApiContext,
  ApiHost,
  LoadedExtension
} from '../../../main/platform/extensionApi/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke at the patched globals
type Any = any

describe('chrome.tts options', () => {
  it("validates in Chrome's words", () => {
    expect(normalizeSpeakOptions(undefined)).toEqual({ enqueue: false })
    expect(
      normalizeSpeakOptions({
        enqueue: true,
        voiceName: 'Alice',
        lang: 'en-US',
        rate: 1.5,
        pitch: 0.5,
        volume: 0.8,
        gender: 'female',
        extensionId: 'abc',
        desiredEventTypes: ['start', 'end'],
        requiredEventTypes: ['end']
      })
    ).toEqual({
      enqueue: true,
      voiceName: 'Alice',
      lang: 'en-US',
      rate: 1.5,
      pitch: 0.5,
      volume: 0.8,
      desiredEventTypes: ['start', 'end'],
      requiredEventTypes: ['end']
    })
    expect(() => normalizeSpeakOptions({ rate: 0.05 })).toThrow(ERROR_INVALID_RATE)
    expect(() => normalizeSpeakOptions({ rate: 11 })).toThrow(ERROR_INVALID_RATE)
    expect(() => normalizeSpeakOptions({ pitch: 2.5 })).toThrow(ERROR_INVALID_PITCH)
    expect(() => normalizeSpeakOptions({ volume: -0.1 })).toThrow(ERROR_INVALID_VOLUME)
    expect(() => normalizeSpeakOptions({ lang: 'not a lang' })).toThrow(ERROR_INVALID_LANG)
    expect(() => normalizeSpeakOptions({ desiredEventTypes: ['nope'] })).toThrow(
      ERROR_INVALID_OPTIONS
    )
    expect(() => normalizeSpeakOptions('x')).toThrow(ERROR_INVALID_OPTIONS)
    expect(normalizeUtterance('hello')).toBe('hello')
    expect(() => normalizeUtterance('x'.repeat(MAX_UTTERANCE_LENGTH + 1))).toThrow(
      ERROR_UTTERANCE_TOO_LONG
    )
    expect(() => normalizeUtterance(5)).toThrow(ERROR_INVALID_OPTIONS)
  })

  it('maps speechSynthesis voices and events', () => {
    expect(voiceFromWebSpeech({ name: 'Alice', lang: 'en-GB', localService: true })).toMatchObject({
      voiceName: 'Alice',
      lang: 'en-GB',
      remote: false
    })
    const voices = [
      { name: 'Alice', lang: 'en-GB' },
      { name: 'Bob', lang: 'en-US' },
      { name: 'Claire', lang: 'fr-FR' }
    ]
    expect(pickWebSpeechVoice(voices, { voiceName: 'Bob' })?.name).toBe('Bob')
    expect(pickWebSpeechVoice(voices, { voiceName: 'Nobody', lang: 'fr' })?.name).toBe('Claire')
    expect(pickWebSpeechVoice(voices, { lang: 'en_US' })?.name).toBe('Bob')
    expect(pickWebSpeechVoice(voices, { lang: 'en' })?.name).toBe('Alice')
    expect(pickWebSpeechVoice(voices, { lang: 'de' })).toBeNull()
    expect(engineEventFromWebSpeech('boundary', { charIndex: 4, charLength: 5 })).toEqual({
      type: 'word',
      charIndex: 4,
      length: 5
    })
    expect(engineEventFromWebSpeech('boundary', { charIndex: 0, name: 'sentence' })).toEqual({
      type: 'sentence',
      charIndex: 0
    })
    expect(engineEventFromWebSpeech('error', { charIndex: 0, error: 'not-allowed' })).toEqual({
      type: 'error',
      charIndex: 0,
      errorMessage: 'not-allowed'
    })
    expect(engineEventFromWebSpeech('end', {})).toEqual({ type: 'end' })
    expect(engineEventFromWebSpeech('bogus', {})).toBeNull()
  })
})

class FakeDriver implements EngineDriver {
  calls: string[] = []
  speaking: number | null = null
  speak(id: number, text: string, options: EngineSpeakOptions): void {
    this.speaking = id
    this.calls.push(`speak:${id}:${text}:${JSON.stringify(options)}`)
  }
  cancel(): void {
    this.speaking = null
    this.calls.push('cancel')
  }
  pause(): void {
    this.calls.push('pause')
  }
  resume(): void {
    this.calls.push('resume')
  }
}

function utterance(id: number, text: string, over: Partial<Utterance> = {}): Utterance {
  return { id, text, options: { enqueue: false }, owner: 'ext', token: `t${id}`, ...over }
}

describe('TtsQueue', () => {
  function setup(): { queue: TtsQueue; driver: FakeDriver; events: Array<[number, TtsEvent]> } {
    const driver = new FakeDriver()
    const events: Array<[number, TtsEvent]> = []
    const queue = new TtsQueue(driver, (u, event) => events.push([u.id, event]))
    return { queue, driver, events }
  }

  it('interrupts the current utterance and cancels the queue unless asked to enqueue', () => {
    const { queue, driver, events } = setup()
    queue.speak(utterance(1, 'one'))
    expect(driver.speaking).toBe(1)
    queue.engineEvent(1, { type: 'start', charIndex: 0 })
    queue.speak(utterance(2, 'two', { options: { enqueue: true } }))
    queue.speak(utterance(3, 'three', { options: { enqueue: true } }))
    expect(driver.speaking).toBe(1)
    expect(queue.isSpeaking()).toBe(true)
    queue.speak(utterance(4, 'four'))
    expect(driver.calls.filter((c) => c === 'cancel')).toHaveLength(1)
    expect(driver.speaking).toBe(4)
    expect(events.map(([id, e]) => `${id}:${e.type}:${e.isFinalEvent}`)).toEqual([
      '1:start:false',
      '1:interrupted:true',
      '2:cancelled:true',
      '3:cancelled:true'
    ])
    // The engine's late word about the interrupted utterance is stale.
    queue.engineEvent(1, { type: 'error', errorMessage: 'interrupted' })
    expect(events).toHaveLength(4)
  })

  it('moves on after a final engine event and fills in charIndex', () => {
    const { queue, driver, events } = setup()
    queue.speak(utterance(1, 'first'))
    queue.speak(utterance(2, 'second', { options: { enqueue: true } }))
    queue.engineEvent(1, { type: 'word', charIndex: 0, length: 5 })
    queue.engineEvent(1, { type: 'end' })
    expect(driver.speaking).toBe(2)
    expect(events).toEqual([
      [1, { type: 'word', charIndex: 0, length: 5, isFinalEvent: false }],
      [1, { type: 'end', charIndex: 5, isFinalEvent: true }]
    ])
    queue.engineEvent(2, { type: 'error', charIndex: 0, errorMessage: 'synthesis-failed' })
    expect(queue.isSpeaking()).toBe(false)
    expect(events[2]).toEqual([
      2,
      { type: 'error', charIndex: 0, errorMessage: 'synthesis-failed', isFinalEvent: true }
    ])
  })

  it('holds new utterances while paused; stop lifts the pause and empties everything', () => {
    const { queue, driver, events } = setup()
    queue.pause()
    expect(driver.calls).toEqual([])
    queue.speak(utterance(1, 'waiting'))
    expect(driver.speaking).toBeNull()
    queue.resume()
    expect(driver.speaking).toBe(1)
    queue.pause()
    expect(driver.calls.at(-1)).toBe('pause')
    queue.speak(utterance(2, 'also waiting'))
    queue.stop()
    expect(queue.isPaused()).toBe(false)
    expect(events.map(([id, e]) => `${id}:${e.type}`)).toEqual(['1:interrupted', '2:cancelled'])
    queue.speak(utterance(3, 'now'))
    expect(driver.speaking).toBe(3)
  })

  it('filters by desiredEventTypes and drops an owner without a word', () => {
    const { queue, driver, events } = setup()
    queue.speak(utterance(1, 'a', { options: { enqueue: false, desiredEventTypes: ['end'] } }))
    queue.engineEvent(1, { type: 'start', charIndex: 0 })
    queue.engineEvent(1, { type: 'end' })
    expect(events.map(([, e]) => e.type)).toEqual(['end'])
    queue.speak(utterance(2, 'b', { owner: 'gone' }))
    queue.speak(utterance(3, 'c', { owner: 'gone', options: { enqueue: true } }))
    queue.speak(utterance(4, 'd', { owner: 'stays', options: { enqueue: true } }))
    queue.removeOwner('gone')
    expect(driver.speaking).toBe(4)
    expect(events).toHaveLength(1)
  })
})

class FakeEngine extends FakeDriver implements SpeechEngine {
  list: TtsVoice[] = []
  eventListener: ((id: number, event: EngineEvent) => void) | null = null
  voicesListener: (() => void) | null = null
  voices(): Promise<TtsVoice[]> {
    return Promise.resolve(this.list)
  }
  onEvent(listener: (id: number, event: EngineEvent) => void): void {
    this.eventListener = listener
  }
  onVoicesChanged(listener: () => void): void {
    this.voicesListener = listener
  }
}

interface Dispatched {
  extensionId: string
  event: string
  args: unknown[]
}

function harness(grants: Record<string, string[]>): {
  api: TtsApi
  engine: FakeEngine
  out: Dispatched[]
  ctx: (id: string) => ApiContext
} {
  const engine = new FakeEngine()
  const out: Dispatched[] = []
  const loaded = new Map<string, LoadedExtension>()
  for (const id of Object.keys(grants)) {
    loaded.set(id, { id, sessions: [] } as unknown as LoadedExtension)
  }
  const host = {
    allLoaded: () => [...loaded.values()],
    grants: (id: string) => ({ permissions: grants[id] ?? [], origins: [] }),
    dispatch(extensionId: string, namespace: string, event: string, args: unknown[]): void {
      out.push({ extensionId, event: `${namespace}.${event}`, args })
    },
    broadcast(
      namespace: string,
      event: string,
      argsFor: (ext: LoadedExtension) => unknown[] | null
    ): void {
      for (const ext of loaded.values()) {
        const args = argsFor(ext)
        if (args) out.push({ extensionId: ext.id, event: `${namespace}.${event}`, args })
      }
    }
  }
  const api = new TtsApi(host as unknown as ApiHost, engine)
  const ctx = (id: string): ApiContext =>
    ({ extensionId: id, extension: loaded.get(id) }) as unknown as ApiContext
  return { api, engine, out, ctx }
}

describe('TtsApi', () => {
  it('requires the tts permission', async () => {
    const h = harness({ ext: ['tabs'] })
    expect(() => h.api.handlers.speak(h.ctx('ext'), 'hi', {}, 't')).toThrow(ERROR_NO_PERMISSION)
    expect(() => h.api.handlers.isSpeaking(h.ctx('ext'))).toThrow(ERROR_NO_PERMISSION)
    await expect(async () => h.api.handlers.getVoices(h.ctx('ext'))).rejects.toThrow(
      ERROR_NO_PERMISSION
    )
  })

  it('speaks through the engine and sends the events back to the caller by token', () => {
    const h = harness({ a: ['tts'], b: ['tts'] })
    h.api.handlers.speak(h.ctx('a'), 'hello there', { rate: 2, lang: 'en-US' }, 'tok-1')
    expect(h.engine.calls).toEqual(['speak:1:hello there:{"lang":"en-US","rate":2}'])
    expect(h.api.handlers.isSpeaking(h.ctx('b'))).toBe(true)
    h.engine.eventListener?.(1, { type: 'start', charIndex: 0 })
    h.engine.eventListener?.(1, { type: 'end' })
    expect(h.out).toEqual([
      {
        extensionId: 'a',
        event: 'tts.onEvent',
        args: ['tok-1', { type: 'start', charIndex: 0, isFinalEvent: false }]
      },
      {
        extensionId: 'a',
        event: 'tts.onEvent',
        args: ['tok-1', { type: 'end', charIndex: 11, isFinalEvent: true }]
      }
    ])
    expect(h.api.handlers.isSpeaking(h.ctx('a'))).toBe(false)
    // Without an onEvent handler nothing is sent back.
    h.api.handlers.speak(h.ctx('b'), 'quiet', undefined, null)
    h.engine.eventListener?.(2, { type: 'end' })
    expect(h.out).toHaveLength(2)
  })

  it("rejects Chrome's invalid options, stops globally and drops an unloaded extension's speech", () => {
    const h = harness({ a: ['tts'], b: ['tts'] })
    expect(() => h.api.handlers.speak(h.ctx('a'), 'x', { rate: 50 }, 't')).toThrow(
      ERROR_INVALID_RATE
    )
    expect(() => h.api.handlers.speak(h.ctx('a'), 'x'.repeat(40_000), {}, 't')).toThrow(
      ERROR_UTTERANCE_TOO_LONG
    )
    h.api.handlers.speak(h.ctx('a'), 'one', {}, 'ta')
    h.api.handlers.speak(h.ctx('b'), 'two', { enqueue: true }, 'tb')
    h.api.handlers.stop(h.ctx('b'))
    expect(h.out.map((d) => `${d.extensionId}:${(d.args[1] as TtsEvent).type}`)).toEqual([
      'a:interrupted',
      'b:cancelled'
    ])
    h.api.handlers.speak(h.ctx('a'), 'three', {}, 'tc')
    h.api.handlers.speak(h.ctx('b'), 'four', { enqueue: true }, 'td')
    h.api.unload('a')
    expect(h.engine.speaking).toBe(4)
    h.api.handlers.pause(h.ctx('b'))
    h.api.handlers.resume(h.ctx('b'))
    expect(h.engine.calls.slice(-2)).toEqual(['pause', 'resume'])
  })

  it('lists voices and tells permission holders when they change', async () => {
    const h = harness({ a: ['tts'], b: [] })
    h.engine.list = [
      { voiceName: 'Alice', lang: 'en-GB', remote: false, eventTypes: ['start', 'end'] }
    ]
    await expect(h.api.handlers.getVoices(h.ctx('a'))).resolves.toEqual(h.engine.list)
    h.engine.voicesListener?.()
    expect(h.out).toEqual([{ extensionId: 'a', event: 'tts.onVoicesChanged', args: [] }])
  })
})

describe('the shim relays speak options.onEvent', () => {
  const g = globalThis as Any
  const calls: Array<{ namespace: string; method: string; args: unknown[] }> = []
  const notifications: Array<{ kind: string; payload: unknown }> = []
  let respond: () => InvokeResult = () => ({ ok: true, value: undefined })
  let push: (namespace: string, event: string, args: unknown[]) => void = () => undefined

  beforeEach(() => {
    calls.length = 0
    notifications.length = 0
    const manifest = { manifest_version: 3, name: 'Probe', version: '1.0' }
    const chrome: Any = {
      runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        getManifest: () => manifest,
        getURL: (path: string) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}`
      }
    }
    Object.defineProperty(g, 'chrome', { value: chrome, configurable: true, writable: true })
    const host: ShimHost = {
      kind: 'worker',
      invoke(namespace, method, args) {
        calls.push({ namespace, method, args })
        return Promise.resolve(respond())
      },
      notify: (kind, payload) => {
        notifications.push({ kind, payload })
      },
      onEvent: (listener) => {
        push = (namespace, event, args) => listener(namespace, event, args)
      }
    }
    installExtensionApi(host, API_SPEC)
  })

  afterEach(() => {
    delete g.chrome
    delete g.browser
  })

  it('keeps the handler here, sends a token, and calls the handler until the final event', async () => {
    respond = () => ({ ok: true, value: undefined })
    const seen: unknown[] = []
    await g.chrome.tts.speak('hello', { rate: 1.2, onEvent: (e: unknown) => seen.push(e) })
    expect(calls).toHaveLength(1)
    const [utterance, options, token] = calls[0].args as [string, unknown, string]
    expect(utterance).toBe('hello')
    expect(options).toEqual({ rate: 1.2 })
    expect(typeof token).toBe('string')
    expect(
      notifications.some((n) => n.kind === 'listen' && (n.payload as Any).event === 'tts.onEvent')
    ).toBe(true)
    push('tts', 'onEvent', [token, { type: 'start', charIndex: 0, isFinalEvent: false }])
    push('tts', 'onEvent', [token, { type: 'end', charIndex: 5, isFinalEvent: true }])
    push('tts', 'onEvent', [token, { type: 'end', charIndex: 5, isFinalEvent: true }])
    expect(seen.map((e) => (e as TtsEvent).type)).toEqual(['start', 'end'])
    // No handler, no token.
    await g.chrome.tts.speak('plain')
    expect(calls[1].args).toEqual(['plain', undefined, null])
    expect(typeof g.chrome.tts.getVoices).toBe('function')
    expect(g.chrome.tts.EventType.INTERRUPTED).toBe('interrupted')
    expect(g.chrome.tts.onEvent).toBeUndefined()
  })

  it('forgets the handler when the host refuses the utterance', async () => {
    respond = () => ({ ok: false, error: ERROR_INVALID_RATE })
    const seen: unknown[] = []
    await expect(
      g.chrome.tts.speak('hello', { rate: 99, onEvent: (e: unknown) => seen.push(e) })
    ).rejects.toThrow(ERROR_INVALID_RATE)
    const token = (calls[0].args as [string, unknown, string])[2]
    push('tts', 'onEvent', [token, { type: 'start', charIndex: 0, isFinalEvent: false }])
    expect(seen).toEqual([])
  })
})
