import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import type { Any } from '../extensionIsolation'
import {
  decodePayload,
  encodePayload,
  readBlobs,
  importScriptsFor,
  installServiceWorkerClient,
  installServiceWorkerGlobals,
  installWorkerScriptRescue,
  platformOperations,
  workerSelf,
  type ScriptDocument,
  type ScriptElement,
  type ScriptErrorEvent,
  type ScriptErrorTarget,
  type ServiceWorkerEndpoint,
  type ServiceWorkerMessage
} from '../extensionServiceWorker'

const ORIGIN = 'https://abcdefghijklmnopabcdefghijklmnop.ext.zenium.invalid'
const SCRIPT = `${ORIGIN}/sw.js`

/** Wait for MessagePort deliveries (a macrotask each hop). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (ready()) return
    await settle()
  }
  throw new Error('the relay did not get there')
}

/**
 * A client page and the worker page joined the way the runtime joins them: a client's `post`
 * becomes the worker's `message` (from that client), the worker's `post` names its client, port
 * traffic crosses as is, `clients` lists the one page.
 */
function pair(): {
  page: Any
  worker: EventTarget & Any
  client: ServiceWorkerEndpoint
  sw: ServiceWorkerEndpoint & { lifecycle(): Promise<void> }
  opened: string[]
  wire: string[]
} {
  const wire: string[] = []
  const opened: string[] = []
  const ends: {
    client?: ServiceWorkerEndpoint
    sw?: ServiceWorkerEndpoint & { lifecycle(): Promise<void> }
  } = {}
  const page: Any = { navigator: {} }
  const worker = new EventTarget() as EventTarget & Any
  // The bridge carries JSON text: nothing but what JSON keeps survives the hop.
  const json = (message: ServiceWorkerMessage): ServiceWorkerMessage =>
    JSON.parse(JSON.stringify(message)) as ServiceWorkerMessage
  const clientSend = (sent: ServiceWorkerMessage): void => {
    const message = json(sent)
    wire.push(`client ${message.op}`)
    if (message.op === 'post')
      ends.sw?.receive({
        t: 'sw',
        op: 'message',
        from: 'pop1',
        url: `${ORIGIN}/popup.html`,
        context: 'popup',
        data: message.data,
        ports: message.ports
      })
    else ends.sw?.receive({ t: 'sw', ...message })
  }
  const workerSend = (sent: ServiceWorkerMessage): void => {
    const message = json(sent)
    wire.push(`worker ${message.op}`)
    if (message.op === 'post') {
      expect(message.to).toBe('pop1')
      ends.client?.receive({ t: 'sw', op: 'message', data: message.data, ports: message.ports })
    } else if (message.op === 'clients') {
      ends.sw?.receive({
        t: 'sw',
        op: 'clients',
        id: message.id,
        clients: [
          {
            id: 'pop1',
            url: `${ORIGIN}/popup.html`,
            context: 'popup',
            focused: true,
            visible: true
          }
        ]
      })
    } else ends.client?.receive({ t: 'sw', ...message })
  }
  const client = installServiceWorkerClient(page, {
    origin: ORIGIN,
    scriptUrl: SCRIPT,
    send: clientSend,
    prefix: 'pop1:'
  })
  const sw = installServiceWorkerGlobals(worker, {
    origin: ORIGIN,
    scriptUrl: SCRIPT,
    version: '1.0.0',
    send: workerSend,
    openTab: (url) => {
      opened.push(url)
    },
    prefix: 'bg1:'
  })
  ends.client = client
  ends.sw = sw
  return { page, worker, client, sw, opened, wire }
}

describe('service-worker payloads', () => {
  it('carries Errors with their name, message, stack and own fields, and what JSON keeps', () => {
    const error = Object.assign(new TypeError('boom'), { code: 7 })
    const encoded = encodePayload({ id: 3, err: [error, { code: 7 }], list: [1, 'a', null] })
    const decoded = decodePayload(JSON.parse(JSON.stringify(encoded))) as {
      id: number
      err: [Error & { code: number }, { code: number }]
      list: unknown[]
    }
    expect(decoded.id).toBe(3)
    expect(decoded.err[0]).toBeInstanceOf(Error)
    expect(decoded.err[0].name).toBe('TypeError')
    expect(decoded.err[0].message).toBe('boom')
    expect(decoded.err[0].code).toBe(7)
    expect(decoded.err[0].stack).toBe(error.stack)
    expect(decoded.err[1]).toEqual({ code: 7 })
    expect(decoded.list).toEqual([1, 'a', null])
  })

  it('refuses a cycle instead of looping', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(() => encodePayload(a)).toThrow(/cycle/)
    // The same object twice is not a cycle.
    const shared = { x: 1 }
    expect(encodePayload([shared, shared])).toEqual([{ x: 1 }, { x: 1 }])
  })

  it('carries an ArrayBuffer, a typed array and a DataView as their bytes, rebuilt as the same kind', () => {
    const buffer = new Uint8Array([1, 2, 3, 250]).buffer
    const view = new Uint16Array([7, 65535])
    const sub = new Uint8Array(new Uint8Array([9, 8, 7, 6]).buffer, 1, 2)
    const encoded = encodePayload({ buffer, view, sub, dv: new DataView(buffer) })
    const decoded = decodePayload(JSON.parse(JSON.stringify(encoded))) as {
      buffer: ArrayBuffer
      view: Uint16Array
      sub: Uint8Array
      dv: DataView
    }
    expect(decoded.buffer).toBeInstanceOf(ArrayBuffer)
    expect(Array.from(new Uint8Array(decoded.buffer))).toEqual([1, 2, 3, 250])
    expect(decoded.view).toBeInstanceOf(Uint16Array)
    expect(Array.from(decoded.view)).toEqual([7, 65535])
    // A view over part of a buffer travels as the bytes it covers.
    expect(Array.from(decoded.sub)).toEqual([8, 7])
    expect(decoded.dv).toBeInstanceOf(DataView)
    expect(decoded.dv.getUint8(3)).toBe(250)
  })

  it('carries a Blob and a File with their type and name once read, or as JSON does without a list', async () => {
    const blob = new Blob(['// ==UserScript==\n'], { type: 'text/javascript' })
    const file = new File([new Uint8Array([0, 255])], 'a.bin', {
      type: 'application/octet-stream',
      lastModified: 5
    })
    const blobs: Array<{ blob: Blob; slot: Record<string, unknown> }> = []
    const encoded = encodePayload({ action: 'objectURL', blob, file }, [], new Set(), blobs)
    expect(blobs.map((b) => b.blob)).toEqual([blob, file])
    await readBlobs(blobs)
    const decoded = decodePayload(JSON.parse(JSON.stringify(encoded))) as { blob: Blob; file: File }
    expect(decoded.blob).toBeInstanceOf(Blob)
    expect(decoded.blob.type).toBe('text/javascript')
    expect(await decoded.blob.text()).toBe('// ==UserScript==\n')
    expect(decoded.file).toBeInstanceOf(File)
    expect([decoded.file.name, decoded.file.type, decoded.file.lastModified]).toEqual([
      'a.bin',
      'application/octet-stream',
      5
    ])
    expect(Array.from(new Uint8Array(await decoded.file.arrayBuffer()))).toEqual([0, 255])
    // Without a list to enter it in, a Blob is what JSON keeps of it.
    expect(JSON.parse(JSON.stringify(encodePayload({ blob })))).toEqual({ blob: {} })
  })
})

describe('navigator.serviceWorker in a page and the worker globals, joined by the relay', () => {
  it('a port handed to the worker with postMessage carries requests and replies both ways', async () => {
    const { page, worker } = pair()
    const container = (page.navigator as Any).serviceWorker as Any
    expect(container.controller).toBeNull()
    const registration = (await (container.ready as Promise<Any>)) as Any
    const active = registration.active as Any
    expect(active.state).toBe('activated')
    expect(active.scriptURL).toBe(SCRIPT)
    expect(registration.scope).toBe(`${ORIGIN}/`)
    // The worker: Stylus's shape, `self.onmessage` takes the port and answers on it.
    const seen: unknown[] = []
    worker.addEventListener('message', (event) => {
      const e = event as MessageEvent
      seen.push(e.data)
      const source = e.source as unknown as Any
      expect(source.id).toBe('pop1')
      expect(source.type).toBe('window')
      const port = e.ports[0]
      port.onmessage = (m: MessageEvent): void => {
        const { id, args } = m.data as { id: number; args: number[] }
        if (args[0] < 0) port.postMessage({ id, err: [new RangeError('negative')] })
        else port.postMessage({ id, res: args[0] * 2 })
      }
    })
    const channel = new MessageChannel()
    ;(active.postMessage as (m: unknown, t: unknown[]) => void)({ lock: '/sw.js' }, [channel.port2])
    const replies: Record<string, unknown>[] = []
    channel.port1.onmessage = (m: MessageEvent): void => {
      replies.push(m.data as Record<string, unknown>)
    }
    channel.port1.postMessage({ id: 1, args: [21] })
    channel.port1.postMessage({ id: 2, args: [-1] })
    await until(() => replies.length === 2)
    expect(seen).toEqual([{ lock: '/sw.js' }])
    expect(replies[0]).toEqual({ id: 1, res: 42 })
    const err = (replies[1].err as unknown[])[0] as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('RangeError')
    expect(err.message).toBe('negative')
    channel.port1.close()
  })

  it('the worker reaches its pages through clients.matchAll and can hand them ports', async () => {
    const { page, worker, opened } = pair()
    const clients = worker.clients as Any
    const list = (await (clients.matchAll as () => Promise<Any[]>)()) as Any[]
    expect(list.map((c) => [c.id, c.url, c.type, c.focused, c.visibilityState])).toEqual([
      ['pop1', `${ORIGIN}/popup.html`, 'window', true, 'visible']
    ])
    expect(await (clients.matchAll as (q: unknown) => Promise<Any[]>)({ type: 'worker' })).toEqual(
      []
    )
    const got: Array<{ data: unknown; ports: number; source: unknown }> = []
    const container = (page.navigator as Any).serviceWorker as Any
    container.onmessage = (event: MessageEvent): void => {
      got.push({ data: event.data, ports: event.ports.length, source: event.source })
      event.ports[0].postMessage('pong')
    }
    const channel = new MessageChannel()
    const pongs: unknown[] = []
    channel.port1.onmessage = (m: MessageEvent): void => {
      pongs.push(m.data)
    }
    ;(list[0].postMessage as (m: unknown, t: unknown[]) => void)({ ping: true }, [channel.port2])
    await until(() => pongs.length === 1)
    expect(got).toHaveLength(1)
    expect(got[0].data).toEqual({ ping: true })
    expect(got[0].ports).toBe(1)
    // The event's source is the page's view of the worker.
    const registration = (await (container.ready as Promise<Any>)) as Any
    expect(got[0].source).toBe(registration.active)
    expect(pongs).toEqual(['pong'])
    await (clients.openWindow as (u: string) => Promise<unknown>)('/manage.html')
    expect(opened).toEqual([`${ORIGIN}/manage.html`])
    channel.port1.close()
  })

  it('a Blob the worker hands a page arrives as a Blob, after a read, in the order of the sends', async () => {
    // Tampermonkey's worker: `client.postMessage({ action: 'objectURL', blob }, [port2])` to its
    // offscreen document, which answers `{ result: { url } }` on the port; a `Blob` cannot be
    // JSON and the worker has no `URL.createObjectURL` of its own.
    const { page, worker, wire } = pair()
    const clients = worker.clients as Any
    const [client] = (await (clients.matchAll as () => Promise<Any[]>)()) as Any[]
    const container = (page.navigator as Any).serviceWorker as Any
    const got: unknown[] = []
    container.onmessage = (event: MessageEvent): void => {
      const data = event.data as { action: string; blob?: Blob }
      got.push(data)
      if (data.blob) {
        void data.blob.text().then((text) => {
          event.ports[0].postMessage({ result: { url: `blob:${text.length}` } })
        })
      }
    }
    const channel = new MessageChannel()
    const answers: unknown[] = []
    channel.port1.onmessage = (m: MessageEvent): void => {
      answers.push(m.data)
    }
    const post = client.postMessage as (m: unknown, t?: unknown[]) => void
    post({ action: 'objectURL', blob: new Blob(['abc'], { type: 'text/plain' }) }, [channel.port2])
    // Sent after the blob's message and without a blob of its own: it must still arrive second.
    post({ action: 'config' })
    expect(wire.filter((w) => w === 'worker post')).toHaveLength(0)
    await until(() => answers.length === 1)
    expect((got[0] as { action: string }).action).toBe('objectURL')
    expect((got[0] as { blob: Blob }).blob).toBeInstanceOf(Blob)
    expect((got[0] as { blob: Blob }).blob.type).toBe('text/plain')
    expect(got[1]).toEqual({ action: 'config' })
    expect(answers).toEqual([{ result: { url: 'blob:3' } }])
    // With nothing to read and nothing waiting, a send goes out at once.
    const before = wire.length
    post({ action: 'ping' })
    expect(wire.length).toBe(before + 1)
    channel.port1.close()
  })

  it("a port named inside the data arrives as the very port of the event's transfer list", async () => {
    // Stylus: the worker asks a page for a worker port over a channel port; the page answers
    // `{ id, res: port2 }` with `[port2]` transferred and the worker calls `res.postMessage`.
    const { page, worker } = pair()
    const container = (page.navigator as Any).serviceWorker as Any
    container.onmessage = (event: MessageEvent): void => {
      const [reply] = event.ports
      reply.onmessage = (m: MessageEvent): void => {
        const { id } = m.data as { id: number }
        const chan = new MessageChannel()
        chan.port1.onmessage = (w: MessageEvent): void => {
          chan.port1.postMessage({ id: (w.data as { id: number }).id, res: 'built' })
        }
        reply.postMessage({ id, res: chan.port2 }, [chan.port2])
      }
    }
    const clients = worker.clients as Any
    const [client] = (await (clients.matchAll as () => Promise<Any[]>)()) as Any[]
    const channel = new MessageChannel()
    const answers: unknown[] = []
    channel.port1.onmessage = (m: MessageEvent): void => {
      answers.push(m.data)
    }
    ;(client.postMessage as (m: unknown, t: unknown[]) => void)(null, [channel.port2])
    channel.port1.postMessage({ id: 1, args: ['getWorkerPort', '/js/worker.js'] })
    await until(() => answers.length === 1)
    const { res } = answers[0] as { id: number; res: MessagePort }
    expect(res).toBeInstanceOf(MessagePort)
    // What the worker got in `res` is what it can talk on.
    const built: unknown[] = []
    res.onmessage = (m: MessageEvent): void => {
      built.push(m.data)
    }
    res.postMessage({ id: 7, args: ['build'] })
    await until(() => built.length === 1)
    expect(built).toEqual([{ id: 7, res: 'built' }])
    // A port that is not in the transfer list cannot be cloned, as on the platform.
    expect(() => encodePayload({ p: new MessageChannel().port1 })).toThrow(/cloned/)
    expect(decodePayload({ __zenPort: 3 }, [])).toBeNull()
    res.close()
    channel.port1.close()
  })

  it('a close from the far side closes the local end and later traffic for the id is dropped', async () => {
    const { page, worker, client, wire } = pair()
    worker.addEventListener('message', (event) => {
      const e = event as MessageEvent
      e.ports[0].onmessage = (): void => undefined
    })
    const container = (page.navigator as Any).serviceWorker as Any
    const registration = (await (container.ready as Promise<Any>)) as Any
    const channel = new MessageChannel()
    ;(registration.active as Any & { postMessage: (m: unknown, t: unknown[]) => void }).postMessage(
      null,
      [channel.port2]
    )
    expect(wire).toEqual(['client post'])
    client.receive({ t: 'sw', op: 'close', port: 'pop1:1' })
    channel.port1.postMessage('into the void')
    await settle()
    await settle()
    // Nothing crossed for the closed port.
    expect(wire).toEqual(['client post'])
    // Unknown ids are ignored, not errors.
    client.receive({ t: 'sw', op: 'port', port: 'nope', data: 1 })
    channel.port1.close()
  })
})

describe('the worker lifecycle events', () => {
  const store = new Map<string, string>()
  afterEach(() => {
    store.clear()
    delete (globalThis as Any).localStorage
  })

  it('fires install (with waitUntil and addRoutes) then activate once per version', async () => {
    ;(globalThis as Any).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value)
      }
    }
    const { worker, sw } = pair()
    const log: string[] = []
    worker.addEventListener('install', (event) => {
      const e = event as Event & { waitUntil: (p: Promise<unknown>) => void; addRoutes: unknown }
      expect(typeof e.addRoutes).toBe('function')
      e.waitUntil(
        new Promise((resolve) =>
          setTimeout(() => {
            log.push('installed')
            resolve(undefined)
          }, 5)
        )
      )
      log.push('install')
    })
    worker.addEventListener('activate', () => log.push('activate'))
    await sw.lifecycle()
    expect(log).toEqual(['install', 'installed', 'activate'])
    expect(store.get(`__zenSw:${SCRIPT}`)).toBe('1.0.0')
    // The same version again (the worker idled out and came back): nothing fires.
    await sw.lifecycle()
    expect(log).toEqual(['install', 'installed', 'activate'])
  })

  it('does nothing without storage for the marker', async () => {
    const { worker, sw } = pair()
    let fired = 0
    worker.addEventListener('install', () => fired++)
    await sw.lifecycle()
    expect(fired).toBe(0)
  })

  it('takes the page dialogs off the worker global: a worker has none, and a native one stalls the renderer', () => {
    const { worker } = pair()
    expect('alert' in worker && worker.alert).toBeUndefined()
    expect(worker.confirm).toBeUndefined()
    expect(worker.prompt).toBeUndefined()
  })

  it("takes Worker and SharedWorker off the worker global too, as bare identifiers and through self (JSONVue's WORKER_API_AVAILABLE)", () => {
    // The page's global as the WebView has it: both constructors on it, writable and configurable.
    const page = new EventTarget() as EventTarget & Any
    for (const name of ['Worker', 'SharedWorker']) {
      Object.defineProperty(page, name, {
        value: class {
          constructor() {
            throw new Error(`the page's ${name} ran`)
          }
        },
        writable: true,
        configurable: true
      })
    }
    installServiceWorkerGlobals(page, {
      origin: ORIGIN,
      scriptUrl: SCRIPT,
      version: '1.0.0',
      send: () => undefined,
      openTab: () => undefined,
      prefix: 'w:'
    })
    expect(page.Worker).toBeUndefined()
    expect(page.SharedWorker).toBeUndefined()
    // Through `self`: absent, as in Chrome's ServiceWorkerGlobalScope.
    const self = workerSelf(page)
    expect('Worker' in self).toBe(false)
    expect((self as Any).SharedWorker).toBeUndefined()
    // The guard as JSONVue's background.js spells it, a bare identifier of the script's global:
    // false, so the inline formatter runs and no `new Worker('js/workers/formatter.js')` dies
    // on its error event.
    const context = vm.createContext(page)
    expect(vm.runInContext('typeof Worker != "undefined"', context)).toBe(false)
    expect(vm.runInContext('typeof SharedWorker', context)).toBe('undefined')
  })

  it("the global is a WorkerGlobalScope and a ServiceWorkerGlobalScope, through self too, and neither constructs (Google Dictionary's importScripts guard)", () => {
    const { worker } = pair()
    const scope = worker.WorkerGlobalScope as (new () => never) & { prototype: object }
    const serviceScope = worker.ServiceWorkerGlobalScope as (new () => never) & {
      prototype: object
    }
    expect(worker instanceof scope).toBe(true)
    expect(worker instanceof serviceScope).toBe(true)
    // What the script reaches as `self` is the worker page's proxy over the global.
    const self = workerSelf(worker)
    Object.defineProperty(worker, 'self', { value: self, configurable: true, writable: true })
    Object.defineProperty(worker, 'globalThis', { value: self, configurable: true, writable: true })
    expect(self instanceof scope).toBe(true)
    expect(self instanceof serviceScope).toBe(true)
    expect((self as Any).WorkerGlobalScope).toBe(scope)
    expect({} instanceof scope).toBe(false)
    expect(new EventTarget() instanceof serviceScope).toBe(false)
    expect(() => new scope()).toThrow(TypeError)
    expect(() => new serviceScope()).toThrow(TypeError)
    expect(Object.getPrototypeOf(serviceScope.prototype)).toBe(scope.prototype)
    expect(Object.getPrototypeOf(scope.prototype)).toBe(EventTarget.prototype)
    // The guard as the Closure library spells it, run as the worker's script would.
    const guard = new Function(
      'self',
      'WorkerGlobalScope',
      "return typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope"
    ) as (self: unknown, scope: unknown) => boolean
    expect(guard(self, scope)).toBe(true)
  })

  it("through self and globalThis the global's constructor and tag are ServiceWorkerGlobalScope, the prototype and the page stay the global's (uVPN's store-sync role)", () => {
    const { worker } = pair()
    const serviceScope = worker.ServiceWorkerGlobalScope as new () => never
    const self = workerSelf(worker)
    Object.defineProperty(worker, 'self', { value: self, configurable: true, writable: true })
    Object.defineProperty(worker, 'globalThis', { value: self, configurable: true, writable: true })
    expect((self as Any).constructor).toBe(serviceScope)
    expect((self as Any).constructor.name).toBe('ServiceWorkerGlobalScope')
    expect(Object.prototype.toString.call(self)).toBe('[object ServiceWorkerGlobalScope]')
    // The global itself keeps its own constructor and prototype: the interfaces answer
    // `instanceof`, and nothing of the page's chain moves.
    expect(worker.constructor).toBe(EventTarget)
    expect(Object.getPrototypeOf(self)).toBe(Object.getPrototypeOf(worker))
    // A proxy over a global the interfaces were never installed on answers with the global's own.
    const bare = workerSelf({ navigator: {} }) as Any
    expect(bare.constructor).toBe(Object)
    expect(Object.prototype.toString.call(bare)).toBe('[object Object]')
    // vuex-extension-sync's role selection as uVPN's serviceWorker.js spells it, run with the
    // page's `globalThis` redefined to the proxy (as the bootstrap does) and `chrome.action` set:
    // the background takes the master role and answers its popup's connect.
    const role = new Function(
      'globalThis',
      'h',
      'return "ServiceWorkerGlobalScope"===globalThis.constructor.name||"Window"===globalThis.constructor.name&&globalThis.location.href.includes("-extension")&&globalThis.location.href.includes("background")?"bg":h.action||globalThis.location.protocol.includes("-extension")?globalThis.location.href.includes("popup")?"popup":globalThis.location.href.includes("options")?"options":"page":"cs"'
    ) as (globalThis: unknown, h: unknown) => string
    const location = { href: `${ORIGIN}/_generated_background_page.html`, protocol: 'https:' }
    Object.defineProperty(worker, 'location', { value: location, configurable: true })
    expect(role(self, { action: {} })).toBe('bg')
    // Through a Window's constructor on an origin without "-extension" the same expression read
    // "page": the worker joined its own popup as a client, and nothing answered the connect.
    expect(role({ constructor: { name: 'Window' }, location }, { action: {} })).toBe('page')
  })

  it("the page's navigator is a WorkerNavigator and its location a WorkerLocation, nothing else is, and neither constructs (Read&Write's message router)", () => {
    const { worker } = pair()
    const navigator = { userAgent: 'test' }
    const location = { href: 'https://x.ext.zenium.invalid/sw.js' }
    Object.defineProperty(worker, 'navigator', { value: navigator, configurable: true })
    Object.defineProperty(worker, 'location', { value: location, configurable: true })
    const workerNavigator = worker.WorkerNavigator as new () => never
    const workerLocation = worker.WorkerLocation as new () => never
    expect(navigator instanceof workerNavigator).toBe(true)
    expect(location instanceof workerLocation).toBe(true)
    expect(location instanceof workerNavigator).toBe(false)
    expect(navigator instanceof workerLocation).toBe(false)
    expect({} instanceof workerNavigator).toBe(false)
    expect((undefined as unknown) instanceof workerNavigator).toBe(false)
    expect(() => new workerNavigator()).toThrow(TypeError)
    expect(() => new workerLocation()).toThrow(TypeError)
    expect(workerNavigator.name).toBe('WorkerNavigator')
    // Read&Write's router clause, run as the worker's script would with the page's navigator.
    const router = new Function(
      'navigator',
      'WorkerGlobalScope',
      'importScripts',
      'WorkerNavigator',
      "return typeof WorkerGlobalScope !== 'undefined' && typeof importScripts === 'function' && navigator instanceof WorkerNavigator"
    ) as (...args: unknown[]) => boolean
    expect(router(navigator, worker.WorkerGlobalScope, () => undefined, workerNavigator)).toBe(true)
  })
})

describe('importScripts on the worker page', () => {
  /**
   * A document whose script elements run in one V8 context, as a page's classic scripts share
   * one global lexical environment: what `const config = …` in one import means for the next.
   */
  function documentInContext(): {
    document: ScriptDocument
    /** The page the elements report to: a failing script is an `error` event, uncaught unless prevented. */
    errors: ScriptErrorTarget
    uncaught: unknown[]
    context: vm.Context
    ran: string[]
    removed: number
    /** The page's `error` event for a script that failed outside `appendChild` (a `<script src>` of the document). */
    dispatch(event: ScriptErrorEvent): void
  } {
    const context = vm.createContext({ log: [] as string[] })
    const ran: string[] = []
    const listeners = new Set<(event: ScriptErrorEvent) => void>()
    const uncaught: unknown[] = []
    let removed = 0
    const document: ScriptDocument = {
      head: {
        appendChild: (node: ScriptElement) => {
          ran.push(node.textContent ?? '')
          try {
            vm.runInContext(node.textContent ?? '', context)
          } catch (error) {
            // Blink reports a script element's parse or run error to the window, never to the
            // inserter; the console shows it unless a listener prevents the event's default.
            let prevented = false
            const event: ScriptErrorEvent = {
              error,
              message: String((error as Error).message),
              preventDefault: () => {
                prevented = true
              }
            }
            for (const listener of listeners) listener(event)
            if (!prevented) uncaught.push(error)
          }
        }
      },
      documentElement: null,
      createElement: () => ({
        textContent: null,
        remove: () => {
          removed++
        }
      })
    }
    return {
      document,
      errors: {
        addEventListener: (_type, listener) => listeners.add(listener),
        removeEventListener: (_type, listener) => listeners.delete(listener)
      },
      uncaught,
      context,
      ran,
      get removed() {
        return removed
      },
      dispatch: (event: ScriptErrorEvent) => {
        for (const listener of listeners) listener(event)
      }
    }
  }

  it('runs each file as a classic script of the page, so a top-level const reaches the next file and the worker', () => {
    const files: Record<string, string> = {
      [`${ORIGIN}/js/config.js`]: 'const config = { speed: 2 }; let seen = 0;',
      [`${ORIGIN}/js/util.js`]: 'seen = config.speed; log.push("util " + seen)'
    }
    const fetched: string[] = []
    const d = documentInContext()
    const importScripts = importScriptsFor({
      origin: ORIGIN,
      base: `${ORIGIN}/js/service-worker.js`,
      fetchText: (url) => {
        fetched.push(url)
        const text = files[url]
        return text === undefined ? { status: 404, text: '' } : { status: 200, text }
      },
      document: d.document
    })
    importScripts('config.js', '/js/util.js')
    expect(fetched).toEqual([`${ORIGIN}/js/config.js`, `${ORIGIN}/js/util.js`])
    // The worker script itself, after the imports, sees the const as a worker would.
    expect(vm.runInContext('config.speed + seen', d.context)).toBe(4)
    expect(d.context.log).toEqual(['util 2'])
    expect(d.ran.map((text) => text.split('\n').at(-1))).toEqual([
      `//# sourceURL=${ORIGIN}/js/config.js`,
      `//# sourceURL=${ORIGIN}/js/util.js`
    ])
    expect(d.removed).toBe(2)
  })

  it('refuses another origin and reports a file the extension does not have', () => {
    const d = documentInContext()
    const importScripts = importScriptsFor({
      origin: ORIGIN,
      base: `${ORIGIN}/sw.js`,
      fetchText: () => ({ status: 404, text: '' }),
      document: d.document
    })
    expect(() => importScripts('https://evil.example/x.js')).toThrow(/not on the extension origin/)
    expect(() => importScripts('missing.js')).toThrow(/missing\.js failed \(404\)/)
    expect(d.ran).toEqual([])
  })

  it("throws what an imported file throws to the caller and stops at it, as a worker's importScripts does (OrbitNote's module among its imports)", () => {
    // OrbitNote's `worker_wrapper.js`: `try { importScripts("storageHelper.js", ..., "index.js") }
    // catch (e) { console.log(e) }`, `index.js` an ES module. Chrome throws its SyntaxError to
    // the wrapper's catch; the page reported it as the worker's uncaught error instead.
    const files: Record<string, string> = {
      [`${ORIGIN}/background/storageHelper.js`]: 'log.push("storage")',
      [`${ORIGIN}/background/index.js`]: 'import { a } from "./a.js"; log.push("index")',
      [`${ORIGIN}/background/after.js`]: 'log.push("after")',
      [`${ORIGIN}/background/throws.js`]: 'throw new TypeError("no vault")'
    }
    const d = documentInContext()
    const importScripts = importScriptsFor({
      origin: ORIGIN,
      base: `${ORIGIN}/background/worker_wrapper.js`,
      fetchText: (url) => {
        const text = files[url]
        return text === undefined ? { status: 404, text: '' } : { status: 200, text }
      },
      document: d.document,
      errors: d.errors
    })
    let caught: unknown = null
    try {
      importScripts('storageHelper.js', 'index.js', 'after.js')
    } catch (error) {
      caught = error
    }
    // The context's own SyntaxError (another realm's constructor), the error object itself.
    expect((caught as Error).name).toBe('SyntaxError')
    expect(String((caught as Error).message)).toMatch(/import/)
    // The files before it ran, the one after it did not; nothing reached the console as uncaught.
    expect(d.context.log).toEqual(['storage'])
    expect(d.uncaught).toEqual([])
    expect(d.removed).toBe(2)
    // A run-time throw of an imported file is the caller's too, the error object itself.
    let thrown: unknown = null
    try {
      importScripts('throws.js')
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error).name).toBe('TypeError')
    expect((thrown as Error).message).toBe('no vault')
    expect(d.uncaught).toEqual([])
    // Without a page to listen to, the error stays where the page puts it (the older contract).
    const bare = documentInContext()
    const bareImport = importScriptsFor({
      origin: ORIGIN,
      base: `${ORIGIN}/background/worker_wrapper.js`,
      fetchText: (url) => ({ status: 200, text: files[url] ?? '' }),
      document: bare.document
    })
    expect(() => bareImport('index.js')).not.toThrow()
    expect(bare.uncaught).toHaveLength(1)
  })

  it("a worker script whose `let window = self` is the page's early error runs again as a block, where the declaration is legal (Video Downloader PLUS)", () => {
    const scriptUrl = `${ORIGIN}/main.js`
    // The page's global is a Window: `window` is its unforgeable property, as `self` is its alias.
    const text = [
      '"use strict";',
      'let window = self;',
      'var started = window === self;',
      'function handler() { return "ran" }',
      'const hidden = 1;',
      'log.push("main " + started + " " + (function () { return this === undefined })())'
    ].join('\n')
    const d = documentInContext()
    const self = {}
    d.context.self = self
    const fetched: string[] = []
    const warnings: string[] = []
    installWorkerScriptRescue({
      scriptUrl,
      fetchText: (url) => {
        fetched.push(url)
        return { status: 200, text }
      },
      document: d.document,
      errors: d.errors,
      warn: (message) => warnings.push(message)
    })
    // The `<script src>`'s failure as the page reports it: nothing of the file ran.
    let prevented = false
    const event: ScriptErrorEvent = {
      message: "Uncaught SyntaxError: Identifier 'window' has already been declared",
      filename: scriptUrl,
      preventDefault: () => {
        prevented = true
      }
    }
    d.dispatch(event)
    expect(fetched).toEqual([scriptUrl])
    expect(prevented).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/declares 'window'/)
    // The block: `let window` is the block's, the script's `window` reads it, and the code ran
    // strict (the hoisted prologue) with its `var` on the global as a worker's would be.
    expect(d.ran).toHaveLength(1)
    expect(d.ran[0]).toMatch(/^'use strict';\{"use strict";\nlet window = self;/)
    expect(d.ran[0]).toMatch(
      new RegExp(`//# sourceURL=${scriptUrl.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`)
    )
    expect(d.context.log).toEqual(['main true true'])
    expect(d.context.started).toBe(true)
    expect(d.context.window).toBeUndefined()
    expect(d.uncaught).toEqual([])
    expect(d.removed).toBe(1)

    // Once per file, and only for the worker's own file and a Window member a worker lacks.
    d.dispatch(event)
    expect(fetched).toHaveLength(1)
    const other = documentInContext()
    const otherFetched: string[] = []
    installWorkerScriptRescue({
      scriptUrl,
      fetchText: (url) => {
        otherFetched.push(url)
        return { status: 200, text }
      },
      document: other.document,
      errors: other.errors
    })
    other.dispatch({
      message: "Uncaught SyntaxError: Identifier 'window' has already been declared",
      filename: `${ORIGIN}/lib.js`,
      preventDefault: () => undefined
    })
    other.dispatch({
      message: "Uncaught SyntaxError: Identifier 'config' has already been declared",
      filename: scriptUrl,
      preventDefault: () => undefined
    })
    other.dispatch({
      message: 'Uncaught TypeError: window is not a function',
      filename: scriptUrl,
      preventDefault: () => undefined
    })
    expect(otherFetched).toEqual([])
    expect(other.ran).toEqual([])
    // A sloppy script stays sloppy: no prologue is invented for it.
    const sloppy = documentInContext()
    sloppy.context.self = {}
    installWorkerScriptRescue({
      scriptUrl,
      fetchText: () => ({ status: 200, text: 'let document = self; log.push(typeof document)' }),
      document: sloppy.document,
      errors: sloppy.errors
    })
    sloppy.dispatch({
      message: "Identifier 'document' has already been declared",
      filename: scriptUrl,
      preventDefault: () => undefined
    })
    expect(sloppy.ran[0]).toMatch(/^\{let document = self;/)
    expect(sloppy.context.log).toEqual(['object'])
  })
})

describe("the worker page's self and globalThis answer as a worker's global", () => {
  /** A Window-shaped global: unforgeable getters, platform operations that check their receiver. */
  function blinkLikeGlobal(): Any {
    // EventTarget.prototype's operation sits on the chain, as in Blink; the Window's own on it.
    const eventTarget: Any = {}
    const global: Any = Object.create(eventTarget)
    // Blink's operations are not constructors (no `prototype`), as a shorthand method is not.
    const platform = (name: string): unknown =>
      ({
        [name](this: unknown, ...args: unknown[]): string {
          if (this !== global) throw new TypeError('Illegal invocation')
          return `${name}(${args.join(',')})`
        }
      })[name]
    const unforgeable = (name: string, value: () => unknown): void => {
      Object.defineProperty(global, name, { get: value, configurable: false, enumerable: true })
    }
    unforgeable('window', () => global)
    unforgeable('document', () => ({ nodeType: 9, visibilityState: 'visible' }))
    unforgeable('localStorage', () => ({ getItem: () => 'page' }))
    unforgeable('navigator', () => ({ userAgent: 'page' }))
    Object.defineProperty(global, 'location', {
      get() {
        if (this !== global) throw new TypeError('Illegal invocation')
        return { href: SCRIPT }
      },
      configurable: false
    })
    eventTarget.addEventListener = platform('addEventListener')
    global.setTimeout = platform('setTimeout')
    global.fetch = platform('fetch')
    global.requestAnimationFrame = platform('requestAnimationFrame')
    global.URL = class FakeURL {
      href: string
      constructor(href: string) {
        this.href = href
      }
    }
    global.chrome = { runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' } }
    global.Infinity = Infinity
    Object.defineProperty(global, 'Infinity', { writable: false, configurable: false })
    return global
  }

  function run(global: Any, code: string): unknown {
    const self = workerSelf(global)
    const context = vm.createContext({ self, window: global, TypeError, Object, Reflect })
    return vm.runInContext(code, context)
  }

  it('a strict-mode self.window = self is kept and read back, and the page stays intact', () => {
    const global = blinkLikeGlobal()
    // What the page would do: a getter-only property refuses the write.
    expect(() => {
      'use strict'
      global.window = global
    }).toThrow(TypeError)
    const result = run(
      global,
      `'use strict';
       const before = [self.window, 'window' in self];
       self.window = self;
       self.Prefs = { a: 1 };
       [before, self.window === self, self.self === self, self.globalThis === self, typeof window.Prefs, 'window' in self]`
    )
    expect(result).toEqual([[undefined, false], true, true, true, 'object', true])
    // The page's own `window` is untouched; the script's global reached the page.
    expect(global.window).toBe(global)
    expect(global.Prefs).toEqual({ a: 1 })
  })

  it("a worker's missing members are absent until the script polyfills them, and the polyfills take", () => {
    const global = blinkLikeGlobal()
    const result = run(
      global,
      `'use strict';
       // Capital One Shopping's worker: a localStorage over chrome.storage.
       const absent = [self.localStorage, self.document, self.requestAnimationFrame, 'document' in self, 'localStorage' in self];
       self.localStorage = { getItem: (k) => 'shim:' + k };
       // Online Security's worker: Sentry's GLOBAL_OBJ is globalThis, and its document shim goes there.
       self.globalThis.document = { visibilityState: 'hidden', addEventListener: () => {} };
       // NordPass's worker tells a background from a page by the document it has not.
       const nordpass = (() => { const g = self.globalThis; return !g.document || g.window === g; })();
       [absent, self.localStorage.getItem('k'), self.document.visibilityState, 'document' in self, nordpass, Object.keys(self).includes('document'), Object.keys(self).includes('localStorage')]`
    )
    expect(result).toEqual([
      [undefined, undefined, undefined, false, false],
      'shim:k',
      'hidden',
      true,
      false,
      true,
      true
    ])
    // The page keeps its own document and storage.
    expect((global.document as { visibilityState: string }).visibilityState).toBe('visible')
    expect((global.localStorage as { getItem(k: string): string }).getItem('k')).toBe('page')
  })

  it('a write the global refuses is kept, a delete of a missing member is a no-op, and the page is not touched', () => {
    const global = blinkLikeGlobal()
    const result = run(
      global,
      `'use strict';
       const nav = self.navigator.userAgent;
       self.navigator = { userAgent: 'shim' };
       const deleted = delete self.document;
       const descriptor = Object.getOwnPropertyDescriptor(self, 'document');
       [nav, self.navigator.userAgent, deleted, descriptor, Reflect.has(self, 'navigator')]`
    )
    expect(result).toEqual(['page', 'shim', true, undefined, true])
    expect((global.navigator as { userAgent: string }).userAgent).toBe('page')
  })

  it('platform methods run on the global, getters see it, constructors and identity hold', () => {
    const global = blinkLikeGlobal()
    const result = run(
      global,
      `'use strict';
       const listen = self.addEventListener('message', 'fn');
       const timer = self.setTimeout('cb', 5);
       const same = self.fetch === self.fetch && self.addEventListener !== undefined;
       const url = new self.URL('https://a.example/').href;
       const proto = self.URL.prototype !== undefined;
       [listen, timer, same, url, proto, self.location.href, self.chrome.runtime.id, self.Infinity]`
    )
    expect(result).toEqual([
      'addEventListener(message,fn)',
      'setTimeout(cb,5)',
      true,
      'https://a.example/',
      true,
      SCRIPT,
      'abcdefghijklmnopabcdefghijklmnop',
      Infinity
    ])
  })

  it("a script's wrapper of a platform operation runs on the global too, wherever it was installed", () => {
    const global = blinkLikeGlobal()
    const result = run(
      global,
      `'use strict';
       // Sentry's browserApiErrors: EventTarget.prototype.addEventListener becomes a plain
       // function (it has a prototype, as any does) that forwards this to the native, and its
       // INP tracking then calls GLOBAL_OBJ.addEventListener(...).
       const proto = Object.getPrototypeOf(self);
       const nativeListen = proto.addEventListener;
       proto.addEventListener = function (type, fn) { return 'wrapped:' + nativeListen.apply(this, [type, fn]); };
       const listened = self.addEventListener('click', 'fn');
       // Sentry's fill(WINDOW, 'setTimeout', ...): the Window's own operation, replaced through
       // the proxy; the replacement forwards this to the native it took from the page.
       const nativeTimer = window.setTimeout;
       self.setTimeout = function (cb, ms) { return 'wrapped:' + nativeTimer.apply(this, [cb, ms]); };
       const timed = self.setTimeout('cb', 7);
       // The replacement landed on the page's global, where the bare identifier finds it.
       const bare = window.setTimeout('bare', 1);
       // A constructor the script defines on the global is not an operation: raw, constructible.
       self.Thing = function Thing(v) { this.v = v; };
       const built = new self.Thing(4).v;
       [listened, timed, bare, self.setTimeout === self.setTimeout, built, self.Thing === window.Thing]`
    )
    expect(result).toEqual([
      'wrapped:addEventListener(click,fn)',
      'wrapped:setTimeout(cb,7)',
      'wrapped:setTimeout(bare,1)',
      true,
      4,
      true
    ])
  })

  it('the operations snapshot names the platform functions, not constructors, accessors or Object.prototype', () => {
    const global = blinkLikeGlobal()
    const operations = platformOperations(global)
    expect(operations.has('addEventListener')).toBe(true)
    expect(operations.has('setTimeout')).toBe(true)
    expect(operations.has('fetch')).toBe(true)
    expect(operations.has('URL')).toBe(false)
    expect(operations.has('document')).toBe(false)
    expect(operations.has('location')).toBe(false)
    expect(operations.has('hasOwnProperty')).toBe(false)
    expect(operations.has('toString')).toBe(false)
    // The snapshot runs no getter: location's throws for any receiver but the global, and a
    // getter with a side effect would count.
    let read = 0
    Object.defineProperty(global, 'counted', {
      get: () => {
        read++
        return () => 'x'
      },
      configurable: true
    })
    expect(platformOperations(global).has('counted')).toBe(false)
    expect(read).toBe(0)
  })

  it('Object.assign, defineProperty, keys, prototype and delete go to the global; the guarded polyfills run as in a worker', () => {
    const global = blinkLikeGlobal()
    const result = run(
      global,
      `'use strict';
       Object.assign(self, { Prefs: { a: 1 }, info: 'x' });
       Object.defineProperty(self, 'frozen', { value: 3, configurable: false, writable: false, enumerable: true });
       // Read&Write's and MetaMask's guarded polyfills: the bare identifier is the page's, the
       // reflective test is the worker's, and the polyfill takes.
       if (typeof window === 'undefined') self.window = self;
       if (!Reflect.has(self, 'window')) self.window = self;
       const keys = Object.keys(self).filter((k) => ['Prefs', 'info', 'frozen', 'chrome', 'window'].includes(k)).sort();
       const own = Object.getOwnPropertyDescriptor(self, 'frozen');
       delete self.info;
       [keys, own.configurable, own.value, self.window === self, 'info' in self, Object.getPrototypeOf(self) === Object.getPrototypeOf(window)]`
    )
    expect(result).toEqual([
      ['Prefs', 'chrome', 'frozen', 'info', 'window'],
      false,
      3,
      true,
      false,
      true
    ])
    expect(global.Prefs).toEqual({ a: 1 })
    expect(global.frozen).toBe(3)
    expect(global.info).toBeUndefined()
    expect(global.window).toBe(global)
  })
})
