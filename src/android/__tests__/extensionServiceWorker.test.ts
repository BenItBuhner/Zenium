import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import type { Any } from '../extensionIsolation'
import {
  decodePayload,
  encodePayload,
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
