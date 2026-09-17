import { describe, expect, it, vi } from 'vitest'
import type {
  EngineAssets,
  EngineRequest,
  EngineResponse,
  EngineTransport
} from '../../../shared/translateEngine'
import { WorkerEngine } from '../engine'

const ASSETS: EngineAssets = { bergamotWasm: 'b', fastTextWasm: 'f', lid: 'l' }

/** A transport whose worker is scripted from the test. */
class FakeTransport implements EngineTransport {
  posted: EngineRequest[] = []
  terminated = 0
  private listeners: ((message: EngineResponse) => void)[] = []
  private errorListeners: ((message: string) => void)[] = []
  /** Answers every request at once unless a request op is listed in `hold`. */
  hold = new Set<EngineRequest['op']>()
  translate: (texts: string[]) => (string | null)[] = (texts) => texts.map((t) => `[${t}]`)

  post(message: EngineRequest): void {
    this.posted.push(message)
    if (!this.hold.has(message.op)) queueMicrotask(() => this.answer(message))
  }

  answer(message: EngineRequest): void {
    let result: unknown = null
    if (message.op === 'init') result = { bergamotVersion: 'v0.4.9-test' }
    if (message.op === 'translate') result = this.translate(message.texts)
    if (message.op === 'detect')
      result = { language: 'es', confidence: 0.98, second: { language: 'pt', confidence: 0.01 } }
    this.emit({ id: message.id, ok: true, result: result as never })
  }

  fail(message: EngineRequest, error: string): void {
    this.emit({ id: message.id, ok: false, error })
  }

  emit(message: EngineResponse): void {
    for (const listener of this.listeners) listener(message)
  }

  crash(message: string): void {
    for (const listener of this.errorListeners) listener(message)
  }

  onMessage(listener: (message: EngineResponse) => void): void {
    this.listeners.push(listener)
  }

  onError(listener: (message: string) => void): void {
    this.errorListeners.push(listener)
  }

  terminate(): void {
    this.terminated++
  }
}

const FILES = { model: 'm', lex: 'l', vocabs: ['v'] }

describe('WorkerEngine', () => {
  it('initialises with the assets and reports the runtime version', async () => {
    const transport = new FakeTransport()
    const engine = new WorkerEngine(transport, ASSETS)
    await engine.whenReady()
    expect(transport.posted[0]).toMatchObject({ op: 'init', assets: ASSETS })
    expect(engine.version).toBe('v0.4.9-test')
  })

  it('loads a pair once and translates through it', async () => {
    const transport = new FakeTransport()
    const engine = new WorkerEngine(transport, ASSETS)
    const pair = { from: 'es', to: 'en' }
    await engine.loadPair(pair, FILES)
    await engine.loadPair(pair, FILES)
    expect(transport.posted.filter((m) => m.op === 'load')).toHaveLength(1)
    expect(engine.loaded()).toEqual([pair])
    const out = await engine.translate(['hola', 'adiós'], { route: [pair], html: false })
    expect(out).toEqual(['[hola]', '[adiós]'])
    expect(transport.posted.at(-1)).toMatchObject({
      op: 'translate',
      route: [pair],
      texts: ['hola', 'adiós'],
      html: false
    })
    expect(await engine.translate([], { route: [pair], html: true })).toEqual([])
    const detection = await engine.detect('hola a todos')
    expect(detection.language).toBe('es')
    await engine.unload(pair)
    await engine.unload(pair)
    expect(transport.posted.filter((m) => m.op === 'unload')).toHaveLength(1)
    expect(engine.loaded()).toEqual([])
  })

  it('rejects the caller when the worker reports an error', async () => {
    const transport = new FakeTransport()
    transport.hold.add('translate')
    const engine = new WorkerEngine(transport, ASSETS)
    await engine.whenReady()
    const pending = engine.translate(['x'], { route: [{ from: 'es', to: 'en' }], html: false })
    await Promise.resolve()
    const request = transport.posted.find((m) => m.op === 'translate')!
    transport.fail(request, 'model es-en is not loaded')
    await expect(pending).rejects.toThrow('model es-en is not loaded')
    expect(engine.disposed).toBe(false)
  })

  it('fails every pending call and disposes itself when the worker dies', async () => {
    const transport = new FakeTransport()
    transport.hold.add('translate')
    transport.hold.add('detect')
    const engine = new WorkerEngine(transport, ASSETS)
    await engine.whenReady()
    const a = engine.translate(['x'], { route: [{ from: 'es', to: 'en' }], html: false })
    const b = engine.detect('y')
    await Promise.resolve()
    transport.crash('the translation engine worker failed')
    await expect(a).rejects.toThrow('worker failed')
    await expect(b).rejects.toThrow('worker failed')
    expect(engine.disposed).toBe(true)
    expect(transport.terminated).toBe(1)
    await expect(engine.detect('z')).rejects.toThrow('stopped')
  })

  it('fails to start when the worker cannot initialise', async () => {
    const transport = new FakeTransport()
    transport.hold.add('init')
    const engine = new WorkerEngine(transport, ASSETS)
    await Promise.resolve()
    transport.fail(transport.posted[0], 'no WebAssembly')
    await expect(engine.whenReady()).rejects.toThrow('no WebAssembly')
    await expect(engine.detect('x')).rejects.toThrow('no WebAssembly')
  })

  it('times out a request the worker never answers', async () => {
    vi.useFakeTimers()
    try {
      const transport = new FakeTransport()
      transport.hold.add('detect')
      const engine = new WorkerEngine(transport, ASSETS)
      await engine.whenReady()
      const pending = engine.detect('x')
      await Promise.resolve()
      vi.advanceTimersByTime(30_001)
      await expect(pending).rejects.toThrow('did not answer (detect)')
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose terminates the transport and rejects what was in flight', async () => {
    const transport = new FakeTransport()
    transport.hold.add('translate')
    const engine = new WorkerEngine(transport, ASSETS)
    await engine.whenReady()
    const pending = engine.translate(['x'], { route: [{ from: 'es', to: 'en' }], html: true })
    await Promise.resolve()
    engine.dispose()
    engine.dispose()
    await expect(pending).rejects.toThrow('stopped')
    expect(transport.terminated).toBe(1)
  })
})
