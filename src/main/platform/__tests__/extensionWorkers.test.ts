import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ServiceWorkerMain, Session } from 'electron'
import { ContextRegistry } from '../extensionApi/contexts'
import {
  acquireOnIncomingIpc,
  WiredWorkers,
  workerVersionOfIpcEvent
} from '../extensionApi/workers'

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const SCOPE = `chrome-extension://${EXT}/`
const CALL = 'zen-ext:call'

/** `IpcMainServiceWorker`: one handler per channel, as Electron's `IpcMainImpl` enforces. */
class FakeIpc {
  readonly handlers = new Map<string, unknown>()
  readonly listeners = new Map<string, unknown[]>()

  handle(channel: string, handler: unknown): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Attempted to register a second handler for '${channel}'`)
    }
    this.handlers.set(channel, handler)
  }

  on(channel: string, listener: unknown): void {
    this.listeners.set(channel, [...(this.listeners.get(channel) ?? []), listener])
  }
}

/** A `ServiceWorkerMain` wrapper: its own `ipc`, destroyable while the worker keeps running. */
class FakeWorker {
  destroyed = false
  readonly ipc = new FakeIpc()
  readonly sent: Array<{ channel: string; args: unknown[] }> = []
  tasks = 0

  constructor(
    readonly versionId: number,
    readonly scope: string
  ) {}

  get scriptURL(): string {
    return `${this.scope}background.js`
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.destroyed) throw new Error('ServiceWorkerMain is destroyed')
    this.sent.push({ channel, args })
  }

  startTask(): { end(): void } {
    if (this.destroyed) throw new TypeError('ServiceWorkerMain is destroyed')
    this.tasks += 1
    return { end: () => (this.tasks -= 1) }
  }
}

/**
 * Electron's version map behind `session.serviceWorkers`: one wrapper per live version, created
 * on demand by `getWorkerFromVersionID`, dropped when the wrapper is destroyed although the
 * worker itself may keep running (the version stays live).
 */
class FakeServiceWorkers {
  readonly live = new Map<number, string>()
  readonly running = new Set<number>()
  readonly wrappers = new Map<number, FakeWorker>()
  readonly created: FakeWorker[] = []
  readonly startWorkerForScope = vi.fn(async (scope: string): Promise<FakeWorker> => {
    const versionId = [...this.live].find(([, s]) => s === scope)?.[0]
    const worker = versionId === undefined ? undefined : this.getWorkerFromVersionID(versionId)
    if (!worker) throw new Error('Failed to start service worker.')
    return worker
  })

  getWorkerFromVersionID(versionId: number): FakeWorker | undefined {
    const existing = this.wrappers.get(versionId)
    if (existing) return existing
    const scope = this.live.get(versionId)
    if (!scope) return undefined
    const worker = new FakeWorker(versionId, scope)
    this.wrappers.set(versionId, worker)
    this.created.push(worker)
    return worker
  }

  /** What Electron's IPC dispatch uses: the map's wrapper, never a new one. */
  _getWorkerFromVersionIDIfExists(versionId: number): FakeWorker | undefined {
    return this.wrappers.get(versionId)
  }

  getAllRunning(): Record<number, { scope: string; scriptUrl: string; renderProcessId: number }> {
    const out: Record<number, { scope: string; scriptUrl: string; renderProcessId: number }> = {}
    for (const versionId of this.running) {
      const scope = this.live.get(versionId) ?? ''
      out[versionId] = { scope, scriptUrl: `${scope}background.js`, renderProcessId: 7 }
    }
    return out
  }

  getInfoFromVersionID(versionId: number): { scope: string } {
    const scope = this.running.has(versionId) ? this.live.get(versionId) : undefined
    if (!scope) throw new Error('Could not find service worker with that version_id')
    return { scope }
  }

  /** `ServiceWorkerMain::Destroy()`: the wrapper is marked and leaves the map; nothing else changes. */
  destroyWrapper(versionId: number): void {
    const worker = this.wrappers.get(versionId)
    if (!worker) return
    worker.destroyed = true
    this.wrappers.delete(versionId)
  }

  /** The version is gone for good (redundant and stopped, or released after stopping). */
  dropVersion(versionId: number): void {
    this.destroyWrapper(versionId)
    this.live.delete(versionId)
    this.running.delete(versionId)
  }
}

/**
 * A session: the emitter Electron dispatches worker IPC on. Its dispatch listener is attached at
 * construction (`Session.prototype._init`) and looks the wrapper up without creating one
 * (`lib/browser/ipc-dispatch.ts`): no wrapper, no handler.
 */
class FakeSession extends EventEmitter {
  readonly replies: string[] = []

  constructor(
    readonly serviceWorkers: FakeServiceWorkers,
    readonly storagePath: string
  ) {
    super()
    this.on('-ipc-invoke', (event: unknown, channel: string) => {
      const versionId = workerVersionOfIpcEvent(event)
      const ipc =
        versionId === undefined
          ? undefined
          : this.serviceWorkers._getWorkerFromVersionIDIfExists(versionId)?.ipc
      this.replies.push(
        ipc?.handlers.has(channel) ? `${channel}: ok` : `No handler registered for '${channel}'`
      )
    })
  }

  /** `ipcRenderer.invoke(channel)` from the worker of `versionId`: Electron's reply. */
  invokeFromWorker(versionId: number, channel: string): string {
    this.emit('-ipc-invoke', { type: 'service-worker', versionId, session: this }, channel, [])
    return this.replies[this.replies.length - 1] ?? ''
  }
}

function fakeSession(engine: FakeServiceWorkers, storagePath = '/profile/default'): Session {
  return new FakeSession(engine, storagePath) as unknown as Session
}

function asMain(worker: FakeWorker): ServiceWorkerMain {
  return worker as unknown as ServiceWorkerMain
}

function setup(): {
  engine: FakeServiceWorkers
  session: Session
  wired: WiredWorkers
  install: ReturnType<typeof vi.fn>
} {
  const engine = new FakeServiceWorkers()
  const session = fakeSession(engine)
  const install = vi.fn((worker: ServiceWorkerMain) => {
    worker.ipc.handle(CALL, () => undefined)
  })
  const wired = new WiredWorkers(install)
  return { engine, session, wired, install }
}

function registryFor(
  session: Session,
  wired: WiredWorkers
): { registry: ContextRegistry; acquired: ReturnType<typeof vi.fn> } {
  const acquired = vi.fn((versionId: number, ses: Session) => wired.acquire(versionId, ses))
  const registry = new ContextRegistry({
    sessionsFor: () => [session],
    persistWorkerEvents: () => undefined,
    placeFrame: () => ({}),
    acquireWorker: acquired
  })
  return { registry, acquired }
}

function eventsSentTo(worker: FakeWorker): Array<[string, string]> {
  return worker.sent
    .filter((s) => s.channel === 'zen-ext:event')
    .map((s) => [String(s.args[0]), String(s.args[1])])
}

describe('WiredWorkers', () => {
  it('installs the handlers once per wrapper and keeps the wrapper for its version', () => {
    const { engine, session, wired, install } = setup()
    engine.live.set(11, SCOPE)
    const first = engine.getWorkerFromVersionID(11)!
    expect(wired.wire(asMain(first), session)).toBe(true)
    expect(wired.wire(asMain(first), session)).toBe(true)
    expect(install).toHaveBeenCalledTimes(1)
    expect(wired.acquire(11, session)).toBe(first)
    expect(wired.current(11, session)).toBe(first)
    expect(engine.created).toHaveLength(1)
  })

  it('wires the fresh wrapper the engine hands out after destroying the old one while the worker runs', () => {
    const { engine, session, wired, install } = setup()
    engine.live.set(11, SCOPE)
    engine.running.add(11)
    const first = engine.getWorkerFromVersionID(11)!
    wired.wire(asMain(first), session)
    engine.destroyWrapper(11)
    expect(first.isDestroyed()).toBe(true)
    expect(engine.running.has(11)).toBe(true)
    expect(wired.current(11, session)).toBeUndefined()
    const second = wired.acquire(11, session)
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    expect(install).toHaveBeenCalledTimes(2)
    expect((second as unknown as FakeWorker).ipc.handlers.has(CALL)).toBe(true)
    expect(wired.acquire(11, session)).toBe(second)
    expect(install).toHaveBeenCalledTimes(2)
  })

  it('does not wire destroyed wrappers, site workers, or a version that is gone', () => {
    const { engine, session, wired, install } = setup()
    engine.live.set(21, 'https://site.example/')
    const site = engine.getWorkerFromVersionID(21)!
    expect(wired.wire(asMain(site), session)).toBe(false)
    engine.live.set(22, SCOPE)
    const gone = engine.getWorkerFromVersionID(22)!
    engine.dropVersion(22)
    expect(wired.wire(asMain(gone), session)).toBe(false)
    expect(wired.acquire(22, session)).toBeUndefined()
    expect(wired.wire(undefined, session)).toBe(false)
    expect(install).not.toHaveBeenCalled()
  })

  it('does not install twice on a wrapper that outlives its worker stopping and starting again', () => {
    const { engine, session, wired, install } = setup()
    engine.live.set(11, SCOPE)
    const worker = engine.getWorkerFromVersionID(11)!
    wired.wire(asMain(worker), session)
    wired.release(11, session)
    expect(wired.current(11, session)).toBeUndefined()
    expect(wired.wire(asMain(worker), session)).toBe(true)
    expect(wired.acquire(11, session)).toBe(worker)
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('keys wrappers by session, since version ids repeat across partitions', () => {
    const { engine, session, wired } = setup()
    const other = new FakeServiceWorkers()
    const otherSession = fakeSession(other, '/profile/work')
    engine.live.set(11, SCOPE)
    other.live.set(11, SCOPE)
    const a = wired.acquire(11, session)
    const b = wired.acquire(11, otherSession)
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a).not.toBe(b)
    expect(wired.current(11, session)).toBe(a)
    expect(wired.current(11, otherSession)).toBe(b)
  })
})

describe('acquireOnIncomingIpc', () => {
  it('recreates and wires the wrapper before Electron dispatches a call from the worker', () => {
    const { engine, session, wired, install } = setup()
    const ses = session as unknown as FakeSession
    engine.live.set(11, SCOPE)
    engine.running.add(11)
    const first = wired.acquire(11, session)
    expect(ses.invokeFromWorker(11, CALL)).toBe(`${CALL}: ok`)

    engine.destroyWrapper(11)
    // Electron alone: the map holds no wrapper, the call fails before any handler could run.
    expect(ses.invokeFromWorker(11, CALL)).toBe(`No handler registered for '${CALL}'`)

    const acquire = vi.fn((versionId: number) => {
      if (!wired.current(versionId, session)) wired.acquire(versionId, session)
    })
    acquireOnIncomingIpc(session, acquire)
    expect(ses.invokeFromWorker(11, CALL)).toBe(`${CALL}: ok`)
    expect(acquire).toHaveBeenCalledWith(11)
    expect(engine.created).toHaveLength(2)
    expect(engine.created[1]).not.toBe(first)
    expect(install).toHaveBeenCalledTimes(2)
    expect(wired.current(11, session)).toBe(engine.created[1])
    // The same for `send` and `sendSync`; a frame's message is not a worker's.
    ses.emit('-ipc-message', { type: 'service-worker', versionId: 11 }, 'zen-ext:notify', [])
    ses.emit('-ipc-message-sync', { type: 'service-worker', versionId: 11 }, 'zen-ext:x', [])
    expect(acquire).toHaveBeenCalledTimes(3)
    ses.emit('-ipc-invoke', { type: 'frame', frameId: 1, processId: 2 }, CALL, [])
    expect(acquire).toHaveBeenCalledTimes(3)
    // A wrapper that is present is left alone.
    expect(ses.invokeFromWorker(11, CALL)).toBe(`${CALL}: ok`)
    expect(engine.created).toHaveLength(2)
  })

  it('lets a call from a version that is gone fail as before', () => {
    const { engine, session, wired } = setup()
    const ses = session as unknown as FakeSession
    acquireOnIncomingIpc(session, (versionId) => wired.acquire(versionId, session))
    expect(ses.invokeFromWorker(99, CALL)).toBe(`No handler registered for '${CALL}'`)
    expect(engine.created).toHaveLength(0)
  })

  it('never keeps Electron from dispatching, whatever acquiring throws', () => {
    const { engine, session, wired } = setup()
    const ses = session as unknown as FakeSession
    engine.live.set(11, SCOPE)
    wired.acquire(11, session)
    acquireOnIncomingIpc(session, () => {
      throw new Error('wiring failed')
    })
    expect(() => ses.invokeFromWorker(11, CALL)).not.toThrow()
    expect(ses.replies).toEqual([`${CALL}: ok`])
  })
})

describe('workerVersionOfIpcEvent', () => {
  it('reads the version id of a worker event only', () => {
    expect(workerVersionOfIpcEvent({ type: 'service-worker', versionId: 4 })).toBe(4)
    expect(workerVersionOfIpcEvent({ type: 'frame', versionId: 4 })).toBeUndefined()
    expect(workerVersionOfIpcEvent({ type: 'service-worker', versionId: '4' })).toBeUndefined()
    expect(workerVersionOfIpcEvent({ type: 'service-worker', versionId: 4.5 })).toBeUndefined()
    expect(workerVersionOfIpcEvent({ type: 'service-worker' })).toBeUndefined()
    expect(workerVersionOfIpcEvent(null)).toBeUndefined()
    expect(workerVersionOfIpcEvent('service-worker')).toBeUndefined()
  })
})

describe('ContextRegistry with a destroyed and recreated worker wrapper', () => {
  it('delivers through the recreated wrapper and swaps it into the context', () => {
    const { engine, session, wired, install } = setup()
    const { registry } = registryFor(session, wired)
    engine.live.set(11, SCOPE)
    const first = engine.getWorkerFromVersionID(11)!
    wired.wire(asMain(first), session)
    registry.workerStatus(11, session, 'starting')
    const context = registry.helloWorker(EXT, asMain(first), session)
    registry.listen(context, { event: 'tabs.onUpdated' }, true)
    engine.running.add(11)
    registry.workerStatus(11, session, 'running')

    engine.destroyWrapper(11)
    expect(registry.dispatch(EXT, 'tabs', 'onUpdated', [1, { status: 'complete' }])).toBe(1)

    expect(engine.created).toHaveLength(2)
    const second = engine.created[1]!
    expect(install).toHaveBeenCalledTimes(2)
    expect(second.ipc.handlers.has(CALL)).toBe(true)
    expect(eventsSentTo(first)).toEqual([])
    expect(eventsSentTo(second)).toEqual([['tabs', 'onUpdated']])
    expect(context.worker).toBe(asMain(second))
    expect(registry.workersOf(EXT)).toEqual([context])
    expect(registry.isLive(context)).toBe(true)
    expect(engine.startWorkerForScope).not.toHaveBeenCalled()
  })

  it('sends a delivery queued while the worker was starting once, through the new wrapper', () => {
    const { engine, session, wired, install } = setup()
    const { registry } = registryFor(session, wired)
    engine.live.set(11, SCOPE)
    const first = engine.getWorkerFromVersionID(11)!
    wired.wire(asMain(first), session)
    registry.workerStatus(11, session, 'starting')
    registry.helloWorker(EXT, asMain(first), session)
    // Queued in the outbox: `send` is dropped while the worker is still starting.
    expect(registry.dispatch(EXT, 'alarms', 'onAlarm', [{ name: 'tick' }], { wake: true })).toBe(1)
    expect(eventsSentTo(first)).toEqual([])

    engine.destroyWrapper(11)
    engine.running.add(11)
    registry.workerStatus(11, session, 'running')

    const second = engine.created[1]!
    expect(install).toHaveBeenCalledTimes(2)
    expect(second.ipc.handlers.has(CALL)).toBe(true)
    expect(eventsSentTo(second)).toEqual([['alarms', 'onAlarm']])
    const total = engine.created.reduce((n, w) => n + eventsSentTo(w).length, 0)
    expect(total).toBe(1)
  })

  it('drops the context and queues a wake once the version itself is gone', () => {
    const { engine, session, wired } = setup()
    const { registry } = registryFor(session, wired)
    engine.live.set(11, SCOPE)
    const worker = engine.getWorkerFromVersionID(11)!
    wired.wire(asMain(worker), session)
    const context = registry.helloWorker(EXT, asMain(worker), session)
    engine.running.add(11)
    registry.workerStatus(11, session, 'running')

    engine.dropVersion(11)
    expect(registry.isLive(context)).toBe(false)
    expect(registry.workersOf(EXT)).toEqual([])
    // Nothing alive to receive it: the alarm waits for the next hello and a start is requested.
    expect(registry.dispatch(EXT, 'alarms', 'onAlarm', [{ name: 'tick' }], { wake: true })).toBe(1)
    expect(eventsSentTo(worker)).toEqual([])
    expect(engine.startWorkerForScope).toHaveBeenCalledWith(SCOPE)
  })

  it('wires the wrapper a wake resolves with and hands the queue to the hello that follows', async () => {
    const { engine, session, wired, install } = setup()
    const { registry, acquired } = registryFor(session, wired)
    engine.live.set(11, SCOPE)
    expect(registry.dispatch(EXT, 'runtime', 'onStartup', [], { wake: true })).toBe(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(engine.startWorkerForScope).toHaveBeenCalledWith(SCOPE)
    expect(acquired).toHaveBeenCalledWith(11, session)
    const worker = engine.created[0]!
    expect(install).toHaveBeenCalledTimes(1)
    expect(worker.ipc.handlers.has(CALL)).toBe(true)

    registry.workerStatus(11, session, 'starting')
    registry.helloWorker(EXT, asMain(worker), session)
    engine.running.add(11)
    registry.workerStatus(11, session, 'running')
    expect(eventsSentTo(worker)).toEqual([['runtime', 'onStartup']])
  })

  it('workerAcquired switches a registered context to the fresh wrapper', () => {
    const { engine, session, wired } = setup()
    const { registry } = registryFor(session, wired)
    engine.live.set(11, SCOPE)
    const first = engine.getWorkerFromVersionID(11)!
    wired.wire(asMain(first), session)
    const context = registry.helloWorker(EXT, asMain(first), session)
    engine.running.add(11)
    registry.workerStatus(11, session, 'running')

    engine.destroyWrapper(11)
    const second = wired.acquire(11, session)!
    registry.workerAcquired(second, session)
    expect(context.worker).toBe(second)
    expect(registry.workerFor(second, session)).toBe(context)
    // A stranger's wrapper (another version) changes nothing.
    engine.live.set(12, SCOPE)
    registry.workerAcquired(asMain(engine.getWorkerFromVersionID(12)!), session)
    expect(context.worker).toBe(second)
  })
})
