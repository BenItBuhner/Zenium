import type { Any } from './extensionIsolation'

/**
 * The service-worker platform of an MV3 extension, emulated over the runtime bridge.
 *
 * The worker runs as a hidden page (`runtime/background.ts` decides when), so what the worker
 * and its clients use to reach each other through the browser is missing on both sides and is
 * built here: in extension pages `navigator.serviceWorker` (`ready`, `controller`, the worker's
 * `postMessage`, incoming `message` events), in the worker page `self.clients`, `self.registration`
 * and the `message` events a client's `postMessage` raises, plus the `install` and `activate`
 * events, once per version of the script. Extensions like Stylus drive their whole popup ↔ worker
 * traffic this way (a `MessageChannel` port handed to the worker with the first `postMessage`).
 *
 * A `MessagePort` cannot cross WebViews. A port handed over for transfer stays on its side under
 * a fresh id and what arrives on it is relayed through the runtime as `{ t: 'sw', op: 'port' }`;
 * the far side gets a new channel per id, one end for the script, the other bound to the relay.
 * The runtime knows which client each id belongs to and wakes the worker for a client's
 * `postMessage` as Chrome does (`extensionRuntime.ts`, `onServiceWorkerMessage`).
 *
 * The payloads travel as JSON: an `Error` is carried as `{ __zenErr }` and rebuilt, a transferred
 * port named inside the data as `{ __zenPort: n }` (its place in the transfer list) and resolved
 * to the port that arrives at that place, as structured clone hands the receiver the very object
 * of `event.ports` (Stylus's page answers a worker's `getWorkerPort` with `{ id, res: port }` and
 * `[port]` transferred; the worker then calls `res.postMessage`), the rest is what JSON keeps
 * (Stylus answers `{ id, res, err: [Error, {...}] }`).
 */

/** What both sides send the runtime; `t: 'sw'`, `token` and `ep` are stamped by the caller. */
export interface ServiceWorkerMessage {
  op: 'post' | 'port' | 'close' | 'clients' | 'message'
  [key: string]: unknown
}

export interface ServiceWorkerEndpoint {
  receive(message: Record<string, unknown>): void
}

/** A client page as the runtime lists it for `clients.matchAll`. */
export interface ClientInfo {
  id: string
  url: string
  context: string
  focused: boolean
  visible: boolean
}

type Send = (message: ServiceWorkerMessage) => void

const ERROR_KEY = '__zenErr'
const PORT_KEY = '__zenPort'

const isMessagePort = (value: unknown): value is MessagePort =>
  typeof MessagePort === 'function' && value instanceof MessagePort

/**
 * Errors survive the JSON trip, a port of `transfer` travels as its place in the list; anything
 * else is what JSON keeps. A port outside the transfer list is the platform's `DataCloneError`.
 */
export function encodePayload(
  value: unknown,
  transfer: readonly MessagePort[] = [],
  seen = new Set<object>()
): unknown {
  if (value instanceof Error) {
    const own: Record<string, unknown> = {}
    for (const key of Object.keys(value))
      own[key] = encodePayload((value as unknown as Any)[key], transfer, seen)
    return { [ERROR_KEY]: { name: value.name, message: value.message, stack: value.stack, own } }
  }
  if (value === null || typeof value !== 'object') return value
  if (isMessagePort(value)) {
    const at = transfer.indexOf(value)
    if (at < 0) throw new DOMException('A MessagePort could not be cloned.', 'DataCloneError')
    return { [PORT_KEY]: at }
  }
  if (seen.has(value)) throw new Error('postMessage: the value has a cycle and cannot be cloned')
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => encodePayload(item, transfer, seen))
    const proto = Object.getPrototypeOf(value) as object | null
    if (proto !== Object.prototype && proto !== null) return value
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value))
      out[key] = encodePayload((value as Record<string, unknown>)[key], transfer, seen)
    return out
  } finally {
    seen.delete(value)
  }
}

/** The payload as the far side sent it, `ports` being the ports that arrived with it, in order. */
export function decodePayload(value: unknown, ports: readonly MessagePort[] = []): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => decodePayload(item, ports))
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  const encoded = record[ERROR_KEY]
  if (encoded && typeof encoded === 'object' && keys.length === 1) {
    const e = encoded as { name?: string; message?: string; stack?: string; own?: unknown }
    const error = new Error(e.message ?? '')
    if (e.name) error.name = e.name
    if (e.stack) error.stack = e.stack
    const own = decodePayload(e.own, ports)
    if (own && typeof own === 'object') Object.assign(error, own)
    return error
  }
  if (typeof record[PORT_KEY] === 'number' && keys.length === 1) {
    return ports[record[PORT_KEY]] ?? null
  }
  const out: Record<string, unknown> = {}
  for (const key of keys) out[key] = decodePayload(record[key], ports)
  return out
}

/** The `MessagePort`s of a `postMessage` transfer list (an array or `{ transfer }`). */
function transferredPorts(transfer: unknown): MessagePort[] {
  const list = Array.isArray(transfer)
    ? transfer
    : transfer && typeof transfer === 'object' && Array.isArray((transfer as Any).transfer)
      ? ((transfer as Any).transfer as unknown[])
      : []
  return list.filter((item): item is MessagePort => item instanceof MessagePort)
}

/**
 * The ports of one side of the relay: those a script handed over for transfer (kept here, their
 * traffic goes out under an id) and those that arrived (a local channel per id, one end for the
 * script).
 */
class PortRelay {
  private readonly bound = new Map<string, MessagePort>()
  private seq = 0

  constructor(
    private readonly send: Send,
    private readonly prefix: string
  ) {}

  /** The ids under which `ports` (a transfer list, already filtered) go out; each is bound here. */
  outbound(ports: readonly MessagePort[]): string[] {
    return ports.map((port) => {
      const id = `${this.prefix}${++this.seq}`
      this.bind(id, port)
      return id
    })
  }

  /** A `postMessage` payload with its transfer list, as the wire carries them. */
  encode(message: unknown, transfer: unknown): { data: unknown; ports: string[] } {
    const ports = transferredPorts(transfer)
    const data = encodePayload(message, ports)
    return { data, ports: this.outbound(ports) }
  }

  inbound(ids: unknown): MessagePort[] {
    if (!Array.isArray(ids)) return []
    return ids.map((raw) => {
      const id = String(raw)
      const channel = new MessageChannel()
      this.bind(id, channel.port2)
      return channel.port1
    })
  }

  /** `port` and `close` messages for a bound port; false for anything else. */
  receive(message: Record<string, unknown>): boolean {
    if (message.op !== 'port' && message.op !== 'close') return false
    const id = String(message.port)
    const port = this.bound.get(id)
    if (!port) return true
    if (message.op === 'close') {
      this.bound.delete(id)
      port.close()
      return true
    }
    try {
      const ports = this.inbound(message.ports)
      port.postMessage(decodePayload(message.data, ports), ports)
    } catch (error) {
      console.error('[Zenium] service worker port relay', error)
    }
    return true
  }

  private bind(id: string, port: MessagePort): void {
    this.bound.set(id, port)
    port.onmessage = (event: MessageEvent): void => {
      let encoded: { data: unknown; ports: string[] }
      try {
        encoded = this.encode(event.data, event.ports)
      } catch (error) {
        console.error('[Zenium] service worker port relay', error)
        return
      }
      this.send({ op: 'port', port: id, ...encoded })
    }
    port.onmessageerror = (): void => {
      console.warn('[Zenium] service worker port relay: a message could not be deserialised')
    }
  }
}

/** `onfoo` handler properties over an EventTarget, as the platform's IDL attributes behave. */
function handlerProperties(target: EventTarget, names: string[]): void {
  for (const name of names) {
    const type = name.slice(2)
    let current: EventListener | null = null
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (value: unknown) => {
        if (current) target.removeEventListener(type, current)
        current = typeof value === 'function' ? (value as EventListener) : null
        if (current) target.addEventListener(type, current)
      }
    })
  }
}

function define(target: object, properties: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(properties))
    Object.defineProperty(target, name, {
      value,
      configurable: true,
      enumerable: true,
      writable: true
    })
}

function messageEvent(data: unknown, ports: MessagePort[], origin: string, source: unknown): Event {
  const event = new MessageEvent('message', { data, ports, origin })
  Object.defineProperty(event, 'source', { value: source, configurable: true })
  return event
}

const clientPostMessage =
  (send: Send, relay: PortRelay, to: string) =>
  (message: unknown, transfer?: unknown): void => {
    send({ op: 'post', to, ...relay.encode(message, transfer) })
  }

/** A `WindowClient` as the worker sees one of its pages. */
function windowClient(info: ClientInfo, send: Send, relay: PortRelay): Any {
  const client: Any = {
    id: info.id,
    url: info.url,
    type: 'window',
    frameType: 'top-level',
    focused: info.focused,
    visibilityState: info.visible ? 'visible' : 'hidden',
    ancestorOrigins: [],
    lifecycleState: 'active',
    postMessage: clientPostMessage(send, relay, info.id),
    focus: () => Promise.resolve(client),
    navigate: () => Promise.reject(new TypeError('navigate is not supported on Zenium for Android'))
  }
  return client
}

/** The element and document `importScriptsFor` needs: what a `Document` gives, and a test can fake. */
export interface ScriptElement {
  textContent: string | null
  remove(): void
}

/** `appendChild` asks no more of its node than the text it runs (a `Node` is one such). */
export interface ScriptParent {
  appendChild(node: { textContent: string | null }): unknown
}

export interface ScriptDocument {
  createElement(tag: 'script'): ScriptElement
  head: ScriptParent | null
  documentElement: ScriptParent | null
}

export interface ImportScriptsOptions {
  origin: string
  /** The worker script's URL; relative imports resolve against it, as in a worker. */
  base: string
  /** A synchronous GET of an extension-origin URL (`importScripts` is synchronous by contract). */
  fetchText: (url: string) => { status: number; text: string }
  /** The page standing in for the worker. */
  document: ScriptDocument
}

/**
 * `importScripts` for the worker page: each file, fetched synchronously from the extension
 * origin, runs as a classic `<script>` element of the page. A script element shares the global
 * lexical environment with the worker script and the other imports, as the files of a worker
 * do, so a top-level `const`, `let` or `class` of an imported file is there for the next one
 * (Enhancer for YouTube's `config.js` is `const config = {...}`, read by its worker; an indirect
 * eval kept those declarations to itself and the worker threw `config is not defined`). What an
 * imported file throws is reported as the page's uncaught error rather than thrown here.
 */
export function importScriptsFor(options: ImportScriptsOptions): (...urls: string[]) => void {
  return (...urls: string[]): void => {
    for (const url of urls) {
      const absolute = new URL(url, options.base).href
      if (!absolute.startsWith(options.origin + '/'))
        throw new Error(`importScripts: ${url} is not on the extension origin`)
      const { status, text } = options.fetchText(absolute)
      if (status !== 200) throw new Error(`importScripts: ${url} failed (${status})`)
      const parent = options.document.head ?? options.document.documentElement
      if (!parent) throw new Error(`importScripts: ${url} has no document to run in`)
      const script = options.document.createElement('script')
      script.textContent = `${text}\n//# sourceURL=${absolute}`
      parent.appendChild(script)
      script.remove()
    }
  }
}

interface WorkerOptions {
  origin: string
  /** The worker script's URL: `self.location`, `serviceWorker.scriptURL`, the lifecycle marker. */
  scriptUrl: string
  version: string
  send: Send
  /** `chrome.tabs.create`, for `clients.openWindow`. */
  openTab: (url: string) => void
  /** Unique across the pages of the extension: port ids come from it. */
  prefix: string
}

/**
 * The worker page's side: `self.clients`, `self.registration`, `self.serviceWorker`,
 * `skipWaiting`, and the `message` events clients raise (`self.onmessage` in a classic script's
 * global scope). Returns the receiver for `{ t: 'sw' }` messages and the lifecycle runner.
 */
export function installServiceWorkerGlobals(
  target: Any,
  options: WorkerOptions
): ServiceWorkerEndpoint & { lifecycle(): Promise<void> } {
  const { send, origin } = options
  const relay = new PortRelay(send, options.prefix)
  const pendingClients = new Map<number, (clients: ClientInfo[]) => void>()
  let seq = 0

  const listClients = (): Promise<ClientInfo[]> =>
    new Promise((resolve) => {
      const id = ++seq
      pendingClients.set(id, resolve)
      send({ op: 'clients', id })
    })

  const worker = new EventTarget()
  define(worker, {
    scriptURL: options.scriptUrl,
    state: 'activated',
    postMessage: (): void => {
      /* a worker posting to itself: Chrome delivers nothing either */
    }
  })
  handlerProperties(worker, ['onstatechange', 'onerror'])

  const registration = new EventTarget()
  define(registration, {
    scope: origin + '/',
    active: worker,
    installing: null,
    waiting: null,
    updateViaCache: 'imports',
    navigationPreload: {
      enable: () => Promise.resolve(),
      disable: () => Promise.resolve(),
      setHeaderValue: () => Promise.resolve(),
      getState: () => Promise.resolve({ enabled: false, headerValue: 'true' })
    },
    update: () => Promise.resolve(registration),
    unregister: () => Promise.resolve(false),
    getNotifications: () => Promise.resolve([]),
    showNotification: () => Promise.resolve()
  })
  handlerProperties(registration, ['onupdatefound'])

  const clients: Any = {
    matchAll: async (query?: { type?: string; includeUncontrolled?: boolean }) => {
      const type = query?.type ?? 'window'
      if (type !== 'window' && type !== 'all') return []
      const infos = await listClients()
      return infos.map((info) => windowClient(info, send, relay))
    },
    get: async (id: unknown) => {
      const infos = await listClients()
      const info = infos.find((entry) => entry.id === String(id))
      return info ? windowClient(info, send, relay) : undefined
    },
    claim: () => Promise.resolve(),
    openWindow: (url: unknown) => {
      options.openTab(new URL(String(url), options.scriptUrl).href)
      return Promise.resolve(null)
    }
  }

  define(target, {
    clients,
    registration,
    serviceWorker: worker,
    skipWaiting: () => Promise.resolve(),
    // A worker has no dialogs. On the page that stands in for one, a native `confirm()` would
    // stall the WebView's shared renderer – and with it every tab and the chrome – until a
    // finger pressed it away (Tampermonkey's internal-error confirm did, in the sweep).
    alert: undefined,
    confirm: undefined,
    prompt: undefined
  })

  const receive = (message: Record<string, unknown>): void => {
    switch (message.op) {
      case 'message': {
        const from = String(message.from ?? '')
        const source = windowClient(
          {
            id: from,
            url: String(message.url ?? ''),
            context: String(message.context ?? 'page'),
            focused: message.focused === true,
            visible: message.visible !== false
          },
          send,
          relay
        )
        const ports = relay.inbound(message.ports)
        ;(target as unknown as EventTarget).dispatchEvent(
          messageEvent(decodePayload(message.data, ports), ports, origin, source)
        )
        return
      }
      case 'clients': {
        const resolve = pendingClients.get(Number(message.id))
        if (!resolve) return
        pendingClients.delete(Number(message.id))
        resolve(Array.isArray(message.clients) ? (message.clients as ClientInfo[]) : [])
        return
      }
      default:
        relay.receive(message)
    }
  }

  /**
   * `install` then `activate`, the first time this version of the script runs (Chrome fires
   * them when the script changes; the version is the proxy). `waitUntil` holds the next step,
   * bounded so a promise that never settles does not hold the extension's `onInstalled`.
   */
  const lifecycle = async (): Promise<void> => {
    const key = `__zenSw:${options.scriptUrl}`
    let seen: string | null = null
    try {
      seen = localStorage.getItem(key)
    } catch {
      return
    }
    if (seen === options.version) return
    for (const type of ['install', 'activate'] as const) {
      const waited: Promise<unknown>[] = []
      const event = new Event(type)
      define(event, {
        waitUntil: (promise: unknown) => {
          waited.push(Promise.resolve(promise).catch(() => undefined))
        },
        ...(type === 'install' ? { addRoutes: () => Promise.resolve() } : {})
      })
      try {
        ;(target as unknown as EventTarget).dispatchEvent(event)
      } catch (error) {
        console.error(`[Zenium] service worker ${type} listener threw`, error)
      }
      if (waited.length > 0)
        await Promise.race([
          Promise.all(waited),
          new Promise((resolve) => setTimeout(resolve, 5000))
        ])
    }
    try {
      localStorage.setItem(key, options.version)
    } catch {
      /* the marker is a nicety */
    }
  }

  return { receive, lifecycle }
}

interface ClientOptions {
  origin: string
  scriptUrl: string
  send: Send
  prefix: string
}

/**
 * An extension page's side: `navigator.serviceWorker` with a registration whose active worker
 * is the emulated one. `controller` stays null: no fetch goes through the worker here, and
 * extensions that check it (Stylus) then take their message-based path.
 */
export function installServiceWorkerClient(
  target: Any,
  options: ClientOptions
): ServiceWorkerEndpoint {
  const { send, origin } = options
  const relay = new PortRelay(send, options.prefix)

  const worker = new EventTarget()
  define(worker, {
    scriptURL: options.scriptUrl,
    state: 'activated',
    postMessage: (message: unknown, transfer?: unknown): void => {
      send({ op: 'post', ...relay.encode(message, transfer) })
    }
  })
  handlerProperties(worker, ['onstatechange', 'onerror'])

  const registration = new EventTarget()
  define(registration, {
    scope: origin + '/',
    active: worker,
    installing: null,
    waiting: null,
    updateViaCache: 'imports',
    navigationPreload: {
      enable: () => Promise.resolve(),
      disable: () => Promise.resolve(),
      setHeaderValue: () => Promise.resolve(),
      getState: () => Promise.resolve({ enabled: false, headerValue: 'true' })
    },
    update: () => Promise.resolve(registration),
    unregister: () => Promise.resolve(false),
    getNotifications: () => Promise.resolve([]),
    showNotification: () => Promise.resolve()
  })
  handlerProperties(registration, ['onupdatefound'])

  const container = new EventTarget()
  define(container, {
    controller: null,
    ready: Promise.resolve(registration),
    register: () => Promise.resolve(registration),
    getRegistration: () => Promise.resolve(registration),
    getRegistrations: () => Promise.resolve([registration]),
    startMessages: (): void => undefined
  })
  handlerProperties(container, ['onmessage', 'onmessageerror', 'oncontrollerchange'])

  const navigator = target.navigator as object | undefined
  if (navigator && typeof navigator === 'object') {
    try {
      Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true })
    } catch {
      /* a frozen navigator: the page keeps the real container */
    }
  }

  const receive = (message: Record<string, unknown>): void => {
    if (message.op === 'message') {
      const ports = relay.inbound(message.ports)
      container.dispatchEvent(
        messageEvent(decodePayload(message.data, ports), ports, origin, worker)
      )
      return
    }
    relay.receive(message)
  }

  return { receive }
}
