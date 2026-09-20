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
  type ScriptDocument,
  type ScriptElement,
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
})

describe('importScripts on the worker page', () => {
  /**
   * A document whose script elements run in one V8 context, as a page's classic scripts share
   * one global lexical environment: what `const config = …` in one import means for the next.
   */
  function documentInContext(): {
    document: ScriptDocument
    context: vm.Context
    ran: string[]
    removed: number
  } {
    const context = vm.createContext({ log: [] as string[] })
    const ran: string[] = []
    let removed = 0
    const document: ScriptDocument = {
      head: {
        appendChild: (node: ScriptElement) => {
          ran.push(node.textContent ?? '')
          vm.runInContext(node.textContent ?? '', context)
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
      context,
      ran,
      get removed() {
        return removed
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
})
