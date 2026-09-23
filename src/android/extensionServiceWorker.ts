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
 * `[port]` transferred; the worker then calls `res.postMessage`), binary data as base64
 * (`{ __zenBytes }` for an `ArrayBuffer` or a view of one, `{ __zenBlob }` for a `Blob` or `File`,
 * rebuilt with their type and name: Tampermonkey's worker hands its offscreen document the
 * userscript's `Blob` over `client.postMessage` for a `URL.createObjectURL` the worker has not),
 * the rest is what JSON keeps (Stylus answers `{ id, res, err: [Error, {...}] }`). A `Blob` is
 * read asynchronously, so a payload carrying one goes out once read, and the relay keeps its
 * sends in the order of the calls, as a port delivers them.
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
const BYTES_KEY = '__zenBytes'
const BLOB_KEY = '__zenBlob'

const isMessagePort = (value: unknown): value is MessagePort =>
  typeof MessagePort === 'function' && value instanceof MessagePort

const isBlob = (value: unknown): value is Blob =>
  typeof Blob === 'function' && value instanceof Blob

/** The typed-array and DataView constructors a `{ __zenBytes }` view is rebuilt with, by name. */
const VIEWS: Record<string, (buffer: ArrayBuffer) => ArrayBufferView> = {
  Int8Array: (b) => new Int8Array(b),
  Uint8Array: (b) => new Uint8Array(b),
  Uint8ClampedArray: (b) => new Uint8ClampedArray(b),
  Int16Array: (b) => new Int16Array(b),
  Uint16Array: (b) => new Uint16Array(b),
  Int32Array: (b) => new Int32Array(b),
  Uint32Array: (b) => new Uint32Array(b),
  Float32Array: (b) => new Float32Array(b),
  Float64Array: (b) => new Float64Array(b),
  BigInt64Array: (b) => new BigInt64Array(b),
  BigUint64Array: (b) => new BigUint64Array(b),
  DataView: (b) => new DataView(b)
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)))
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** A `Blob`'s place in a payload: its slot is filled with the bytes once the blob is read. */
interface BlobSlot {
  blob: Blob
  slot: Record<string, unknown>
}

/**
 * Errors survive the JSON trip, a port of `transfer` travels as its place in the list, an
 * `ArrayBuffer` or a view of one as base64 with the view's name; a `Blob` is entered in `blobs`
 * with the slot its bytes fill once read (`readBlobs`), or is what JSON keeps (`{}`) when no list
 * is given. Anything else is what JSON keeps. A port outside the transfer list is the platform's
 * `DataCloneError`.
 */
export function encodePayload(
  value: unknown,
  transfer: readonly MessagePort[] = [],
  seen = new Set<object>(),
  blobs?: BlobSlot[]
): unknown {
  if (value instanceof Error) {
    const own: Record<string, unknown> = {}
    for (const key of Object.keys(value))
      own[key] = encodePayload((value as unknown as Any)[key], transfer, seen, blobs)
    return { [ERROR_KEY]: { name: value.name, message: value.message, stack: value.stack, own } }
  }
  if (value === null || typeof value !== 'object') return value
  if (isMessagePort(value)) {
    const at = transfer.indexOf(value)
    if (at < 0) throw new DOMException('A MessagePort could not be cloned.', 'DataCloneError')
    return { [PORT_KEY]: at }
  }
  if (value instanceof ArrayBuffer)
    return { [BYTES_KEY]: { b64: bytesToBase64(new Uint8Array(value)) } }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    const name = (Object.getPrototypeOf(view) as { constructor: { name: string } }).constructor.name
    return {
      [BYTES_KEY]: {
        b64: bytesToBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
        view: name in VIEWS ? name : 'Uint8Array'
      }
    }
  }
  if (isBlob(value)) {
    if (!blobs) return value
    const slot: Record<string, unknown> = { type: value.type }
    if (typeof File === 'function' && value instanceof File) {
      slot.name = value.name
      slot.lastModified = value.lastModified
    }
    blobs.push({ blob: value, slot })
    return { [BLOB_KEY]: slot }
  }
  if (seen.has(value)) throw new Error('postMessage: the value has a cycle and cannot be cloned')
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => encodePayload(item, transfer, seen, blobs))
    const proto = Object.getPrototypeOf(value) as object | null
    if (proto !== Object.prototype && proto !== null) return value
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value))
      out[key] = encodePayload((value as Record<string, unknown>)[key], transfer, seen, blobs)
    return out
  } finally {
    seen.delete(value)
  }
}

/** Reads every blob `encodePayload` entered and fills its slot with the base64 of its bytes. */
export async function readBlobs(blobs: readonly BlobSlot[]): Promise<void> {
  await Promise.all(
    blobs.map(async ({ blob, slot }) => {
      slot.b64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
    })
  )
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
  const bytes = record[BYTES_KEY]
  if (bytes && typeof bytes === 'object' && keys.length === 1) {
    const b = bytes as { b64?: string; view?: string }
    const buffer = base64ToBytes(typeof b.b64 === 'string' ? b.b64 : '').buffer
    if (typeof b.view !== 'string') return buffer
    return (VIEWS[b.view] ?? VIEWS.Uint8Array)(buffer)
  }
  const blob = record[BLOB_KEY]
  if (blob && typeof blob === 'object' && keys.length === 1) {
    const b = blob as { b64?: string; type?: string; name?: string; lastModified?: number }
    const part = base64ToBytes(typeof b.b64 === 'string' ? b.b64 : '')
    const type = typeof b.type === 'string' ? b.type : ''
    if (typeof b.name === 'string' && typeof File === 'function')
      return new File([part], b.name, { type, lastModified: b.lastModified })
    return new Blob([part], { type })
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
  /** Sends waiting on a blob read, in order; a send with nothing to read goes out at once. */
  private queue: Promise<void> = Promise.resolve()
  private waiting = 0

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

  /**
   * A `postMessage`: the payload with its transfer list goes out as `frame` wraps them. What
   * cannot be cloned throws here, as the platform's `postMessage` does; the ports are bound at
   * once (they are the far side's from this call on); a payload with a `Blob` in it goes out
   * once the blob is read, and every later send of this relay waits behind it, so the order of
   * the calls is the order on the wire.
   */
  post(
    message: unknown,
    transfer: unknown,
    frame: (encoded: { data: unknown; ports: string[] }) => ServiceWorkerMessage
  ): void {
    const ports = transferredPorts(transfer)
    const blobs: BlobSlot[] = []
    const data = encodePayload(message, ports, new Set(), blobs)
    const ids = this.outbound(ports)
    if (blobs.length === 0 && this.waiting === 0) {
      this.send(frame({ data, ports: ids }))
      return
    }
    this.waiting++
    const read = blobs.length > 0 ? readBlobs(blobs) : Promise.resolve()
    this.queue = this.queue.then(async () => {
      try {
        await read
        this.send(frame({ data, ports: ids }))
      } catch (error) {
        console.error(
          '[Zenium] service worker relay: a Blob of a postMessage could not be read',
          error
        )
      } finally {
        this.waiting--
      }
    })
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
      try {
        this.post(event.data, event.ports, (encoded) => ({ op: 'port', port: id, ...encoded }))
      } catch (error) {
        console.error('[Zenium] service worker port relay', error)
      }
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
  (relay: PortRelay, to: string) =>
  (message: unknown, transfer?: unknown): void => {
    relay.post(message, transfer, (encoded) => ({ op: 'post', to, ...encoded }))
  }

/** A `WindowClient` as the worker sees one of its pages. */
function windowClient(info: ClientInfo, relay: PortRelay): Any {
  const client: Any = {
    id: info.id,
    url: info.url,
    type: 'window',
    frameType: 'top-level',
    focused: info.focused,
    visibilityState: info.visible ? 'visible' : 'hidden',
    ancestorOrigins: [],
    lifecycleState: 'active',
    postMessage: clientPostMessage(relay, info.id),
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

/** What a script element's failure reaches the page as: the `ErrorEvent` of its parse or run. */
export interface ScriptErrorEvent {
  error?: unknown
  message?: string
  /** The failed script's URL, as the page's `ErrorEvent.filename` names it. */
  filename?: string
  preventDefault(): void
}

/** The page the script elements report to (`window`), or a test's stand-in for it. */
export interface ScriptErrorTarget {
  addEventListener(type: 'error', listener: (event: ScriptErrorEvent) => void): void
  removeEventListener(type: 'error', listener: (event: ScriptErrorEvent) => void): void
}

export interface ImportScriptsOptions {
  origin: string
  /** The worker script's URL; relative imports resolve against it, as in a worker. */
  base: string
  /** A synchronous GET of an extension-origin URL (`importScripts` is synchronous by contract). */
  fetchText: (url: string) => { status: number; text: string }
  /** The page standing in for the worker. */
  document: ScriptDocument
  /**
   * Where the page reports what a script element throws; with it, an imported file's parse or
   * run error is the caller's exception, as a worker's `importScripts` makes it. Without it the
   * error stays the page's uncaught one.
   */
  errors?: ScriptErrorTarget
}

/**
 * `importScripts` for the worker page: each file, fetched synchronously from the extension
 * origin, runs as a classic `<script>` element of the page. A script element shares the global
 * lexical environment with the worker script and the other imports, as the files of a worker
 * do, so a top-level `const`, `let` or `class` of an imported file is there for the next one
 * (Enhancer for YouTube's `config.js` is `const config = {...}`, read by its worker; an indirect
 * eval kept those declarations to itself and the worker threw `config is not defined`).
 *
 * What an imported file throws while it is parsed or run is `importScripts`' own exception, as
 * in a worker: the page reports a script element's failure as its uncaught error instead, so the
 * call listens for that report while the element runs, keeps it off the console and throws it,
 * and the files after it do not run. OrbitNote's wrapper imports an ES module among its files
 * inside a `try` and logs the SyntaxError Chrome throws it; here the error was the worker's
 * uncaught one and the wrapper's `catch` never saw it.
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
      let thrown: { error: unknown } | null = null
      const report = (event: ScriptErrorEvent): void => {
        if (thrown) return
        thrown = {
          error: event.error ?? new Error(event.message ?? `importScripts: ${url} failed`)
        }
        event.preventDefault()
      }
      options.errors?.addEventListener('error', report)
      try {
        parent.appendChild(script)
      } finally {
        options.errors?.removeEventListener('error', report)
        script.remove()
      }
      if (thrown) throw (thrown as { error: unknown }).error
    }
  }
}

/**
 * The Window members a global `let`, `const` or `class` cannot redeclare on the page: the
 * global's unforgeable properties (`HasRestrictedGlobalProperty`), an early SyntaxError for the
 * whole script. A worker's global has no `window`, `document` or `top`, and its `location` is
 * replaceable, so a worker script may declare any of them.
 */
const UNFORGEABLE_WINDOW_MEMBERS: ReadonlySet<string> = new Set([
  'window',
  'document',
  'location',
  'top'
])

/** `Identifier 'window' has already been declared`, as Blink words the early error (with or without its `Uncaught SyntaxError:` prefix). */
const REDECLARED_GLOBAL = /Identifier '([^']+)' has already been declared/

/**
 * `"use strict"` as a script's directive prologue: comments and whitespace, then the directive.
 * Inside a block the same text is an expression statement and the script would run sloppy.
 */
const STRICT_PROLOGUE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(['"])use strict\1\s*;?/

export interface WorkerScriptRescueOptions {
  /** The worker script's URL as the page loads it (the served spelling). */
  scriptUrl: string
  /** A synchronous GET of an extension-origin URL, as `importScripts` has. */
  fetchText: (url: string) => { status: number; text: string }
  document: ScriptDocument
  /** The page (`window`), whose `error` events name a failed script. */
  errors: ScriptErrorTarget
  warn?: (message: string) => void
}

/**
 * The worker script as a block of the page when its plain load is the early error a worker
 * never has.
 *
 * A worker has no `window`: bundler prologues and hand-written workers alike open with
 * `let window = self` (Video Downloader PLUS's `main.js`, compat rounds 9 to 11) so the code
 * after it can spell `window.…`. On the page that stands in for the worker, `window` is the
 * global's unforgeable property and a global `let` of that name is a SyntaxError for the whole
 * file: nothing of it ran, and the background was a dead worker with one console line. The
 * page reports a script element's failure as its `error` event, naming the identifier and the
 * file; when the identifier is one of [UNFORGEABLE_WINDOW_MEMBERS] and the file the worker's
 * own, the text is fetched and run once more inside a block, where that declaration is the
 * block's (and the script's later `window.…` reads its own binding, `self`), and every other
 * identifier resolves as it did: a `var` and a sloppy-mode function declaration still land on
 * the global as a worker's do. A strict prologue is hoisted ahead of the block so a strict
 * script stays strict; the block opens on the prologue's line so the file's line numbers hold
 * under its `sourceURL`. Top-level `let`, `const` and `class` become the block's alone, which
 * an `importScripts` file of the same worker would not see; the alternative was the file not
 * running at all. Once per file: the retried text's own errors are the page's, as any script's.
 */
export function installWorkerScriptRescue(options: WorkerScriptRescueOptions): () => void {
  let done = false
  const listener = (event: ScriptErrorEvent): void => {
    if (done) return
    const match = REDECLARED_GLOBAL.exec(String(event.message ?? ''))
    if (!match || !UNFORGEABLE_WINDOW_MEMBERS.has(match[1] ?? '')) return
    if (!event.filename || event.filename !== options.scriptUrl) return
    done = true
    const { status, text } = options.fetchText(options.scriptUrl)
    if (status !== 200) return
    const parent = options.document.head ?? options.document.documentElement
    if (!parent) return
    event.preventDefault()
    options.warn?.(
      `[Zenium] the service worker script declares '${match[1]}', which the page standing in for the worker already has; the script runs as a block of the page instead`
    )
    const strict = STRICT_PROLOGUE.test(text)
    const script = options.document.createElement('script')
    script.textContent = `${strict ? "'use strict';" : ''}{${text}\n}\n//# sourceURL=${options.scriptUrl}`
    try {
      parent.appendChild(script)
    } finally {
      script.remove()
    }
  }
  options.errors.addEventListener('error', listener)
  return () => options.errors.removeEventListener('error', listener)
}

/**
 * Members a `Window` has and a `ServiceWorkerGlobalScope` has not, as seen through the worker
 * page's `self` and `globalThis`: absent until the script itself defines them. The ones worker
 * scripts and their libraries test for or polyfill (`window`, `document`, `localStorage`, the
 * frame tree), and the page-only schedulers a hidden page never runs (`requestAnimationFrame`).
 * Constructors (`DOMParser`, `XMLHttpRequest`, `Image`) are left visible: they are writable, a
 * polyfill replaces them, and the real ones work on the page. `Worker` and `SharedWorker` are
 * not: a service worker's global has neither, and a script branches on them (JSONVue).
 */
export const WINDOW_ONLY_MEMBERS: ReadonlySet<PropertyKey> = new Set<PropertyKey>([
  'window',
  'document',
  'localStorage',
  'sessionStorage',
  'history',
  'frames',
  'parent',
  'top',
  'opener',
  'frameElement',
  'customElements',
  'screen',
  'visualViewport',
  'speechSynthesis',
  'external',
  'menubar',
  'toolbar',
  'locationbar',
  'personalbar',
  'scrollbars',
  'statusbar',
  'alert',
  'confirm',
  'prompt',
  'Worker',
  'SharedWorker',
  'print',
  'open',
  'find',
  'stop',
  'focus',
  'blur',
  'getComputedStyle',
  'getSelection',
  'matchMedia',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'moveBy',
  'moveTo',
  'resizeBy',
  'resizeTo',
  'scroll',
  'scrollBy',
  'scrollTo',
  'innerWidth',
  'innerHeight',
  'outerWidth',
  'outerHeight',
  'screenX',
  'screenY',
  'screenLeft',
  'screenTop',
  'scrollX',
  'scrollY',
  'pageXOffset',
  'pageYOffset',
  'devicePixelRatio'
])

/**
 * The keys of the global's operations: the function-valued data properties of the global and
 * of its prototype chain short of `Object.prototype` that are not constructors (Blink gives an
 * operation no `prototype`; `fetch`, `setTimeout` and `atob` sit on the Window itself, a
 * [Global] interface, `addEventListener` on `EventTarget.prototype`). Accessors are not read:
 * the snapshot must not run a getter. `Object.prototype`'s generics (`hasOwnProperty`,
 * `toString`) take any receiver and are left out, so through the proxy they see the proxy.
 */
export function platformOperations(global: object): ReadonlySet<PropertyKey> {
  const keys = new Set<PropertyKey>()
  for (
    let obj: object | null = global;
    obj && obj !== Object.prototype;
    obj = Object.getPrototypeOf(obj)
  ) {
    for (const key of Reflect.ownKeys(obj)) {
      const descriptor = Object.getOwnPropertyDescriptor(obj, key)
      const value: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined
      if (typeof value === 'function' && !Object.prototype.hasOwnProperty.call(value, 'prototype'))
        keys.add(key)
    }
  }
  return keys
}

/**
 * The worker page's `self` and `globalThis`, as a worker script built for a real worker reads
 * and writes them.
 *
 * A worker has no `window`, `document` or `localStorage`, so bundlers and the scripts polyfill
 * them onto the global: `self.window = self` opens Google Docs Offline's worker and both Avira
 * workers (Closure and browserify prologues), `self.localStorage = new LocalStorage()` Capital
 * One Shopping's, `globalThis.document = { visibilityState: 'hidden', … }` Online Security's
 * (Sentry's `GLOBAL_OBJ`); NordPass tells a background from a page by `!globalThis.document`.
 * On the page that stands in for the worker those are the global's unforgeable getters, a
 * strict-mode write to a getter-only property is a TypeError, and the scripts died on that
 * line, before a single listener was registered; the test read a page. `self` is [Replaceable]
 * and `globalThis` writable in Chrome's IDL, so both become this proxy, which answers as a
 * worker's global does:
 *
 * - `WINDOW_ONLY_MEMBERS` are absent (`undefined`, not `in`) until the script defines them,
 *   and what it defines is kept here and read back from here; the page's own `window`,
 *   `document` and schedulers are untouched.
 * - A write the global refuses (a getter-only property, `navigator` say) is kept here too,
 *   instead of the TypeError a Window throws and a worker never would for its own polyfill.
 * - Everything else goes to the global, with the global as receiver (its getters, `location`
 *   and `crypto` among them, want it), and a function that is not a constructor comes back
 *   bound to the global, so `self.addEventListener`, `self.fetch`, `self.setTimeout` run on
 *   the object Blink expects (a constructor constructs alike whatever the receiver, and its
 *   `prototype` must stay reachable, so it comes back as it is). The platform's operations
 *   are told from constructors once, when the proxy is made: a key that names one stays bound
 *   whatever function a script has put there since. Sentry's `browserApiErrors` wraps
 *   `EventTarget.prototype.addEventListener` in a plain function that forwards `this` to the
 *   native, then calls `GLOBAL_OBJ.addEventListener(…)`; the wrapper has a `prototype` as any
 *   plain function does, and unbound it would hand the native this proxy, an Illegal invocation
 *   that took MetaMask's and Malwarebytes' workers down.
 *
 * The proxy's target is an empty object, not the global: a proxy over the global itself would
 * be held to the global's own invariants, and refusing a write to a getter-only `window` is
 * one of them. Bare identifiers (`typeof document`, `window.x`) still resolve on the page's
 * global; only what a script reaches through `self` or `globalThis` is a worker's.
 */
export function workerSelf(global: object): object {
  const bound = new WeakMap<object, unknown>()
  const operations = platformOperations(global)
  // The target: empty but for what the script defines of a worker's missing members.
  const held: Record<PropertyKey, unknown> = {}
  const holds = (key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(held, key)
  const ownHere = (key: PropertyKey): boolean => holds(key) || WINDOW_ONLY_MEMBERS.has(key)
  const forCall = (key: PropertyKey, value: unknown): unknown => {
    if (typeof value !== 'function') return value
    if (!operations.has(key) && Object.prototype.hasOwnProperty.call(value, 'prototype'))
      return value
    const own = Object.getOwnPropertyDescriptor(global, key)
    if (own && !own.configurable && !own.writable) return value
    let fn = bound.get(value)
    if (!fn) {
      fn = (value as (...args: unknown[]) => unknown).bind(global)
      bound.set(value, fn)
    }
    return fn
  }
  /** A getter-only property of the global (a Window's readonly attribute): the write is kept here. */
  const refusedByGlobal = (key: PropertyKey): boolean => {
    let obj: object | null = global
    while (obj) {
      const descriptor = Object.getOwnPropertyDescriptor(obj, key)
      if (descriptor) return 'get' in descriptor && typeof descriptor.set !== 'function'
      obj = Object.getPrototypeOf(obj)
    }
    return false
  }
  const proxy: object = new Proxy(held, {
    get(target, key) {
      if (key === 'self' || key === 'globalThis') return proxy
      if (holds(key)) return Reflect.get(target, key, proxy)
      if (WINDOW_ONLY_MEMBERS.has(key)) return undefined
      return forCall(key, Reflect.get(global, key, global))
    },
    set(target, key, value) {
      if (ownHere(key) || refusedByGlobal(key)) return Reflect.set(target, key, value, target)
      return Reflect.set(global, key, value, global)
    },
    has(_target, key) {
      if (holds(key)) return true
      if (WINDOW_ONLY_MEMBERS.has(key)) return false
      return Reflect.has(global, key)
    },
    deleteProperty(target, key) {
      if (holds(key)) return Reflect.deleteProperty(target, key)
      if (WINDOW_ONLY_MEMBERS.has(key)) return true
      return Reflect.deleteProperty(global, key)
    },
    defineProperty(target, key, descriptor) {
      if (ownHere(key) || refusedByGlobal(key))
        return Reflect.defineProperty(target, key, descriptor)
      const ok = Reflect.defineProperty(global, key, descriptor)
      // The proxy may only report a property non-configurable when its target holds one too.
      if (ok && descriptor.configurable === false) Reflect.defineProperty(target, key, descriptor)
      return ok
    },
    getOwnPropertyDescriptor(target, key) {
      if (holds(key)) return Reflect.getOwnPropertyDescriptor(target, key)
      if (WINDOW_ONLY_MEMBERS.has(key)) return undefined
      const descriptor = Reflect.getOwnPropertyDescriptor(global, key)
      if (!descriptor) return undefined
      // The global's unforgeable properties are non-configurable; the target holds no such
      // property (unless a script defined one through the proxy, the branch above), and the
      // proxy may not report one it does not hold.
      return { ...descriptor, configurable: true }
    },
    ownKeys(target) {
      // The global's keys but a worker's missing members, and whatever the target holds that
      // the global does not (the invariant: every own key of the target is reported).
      const keys = Reflect.ownKeys(global).filter((key) => !WINDOW_ONLY_MEMBERS.has(key))
      const missing = Reflect.ownKeys(target).filter((key) => !keys.includes(key))
      return missing.length ? [...keys, ...missing] : keys
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(global)
    },
    preventExtensions() {
      return false
    }
  })
  return proxy
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
 * The interfaces a worker's global is an instance of, on the worker page: `WorkerGlobalScope`
 * and `ServiceWorkerGlobalScope` (Chrome's chain: `ServiceWorkerGlobalScope` → `WorkerGlobalScope`
 * → `EventTarget`), neither constructible (`Illegal constructor`, as the real ones). The page's
 * `self` is a proxy over a Window whose prototype chain holds neither, so each constructor
 * answers `instanceof` itself: true for the worker's global – the page's `self` / `globalThis`
 * (the proxy) or the page window – false for anything else. Google Dictionary's worker guards
 * its `importScripts('mustache.js')` with `typeof WorkerGlobalScope !== 'undefined' && self
 * instanceof WorkerGlobalScope`, a Closure library's test for a worker; without the interfaces
 * the guard read false, the template renderer never loaded and every lookup ended in
 * `ReferenceError: Mustache is not defined`. Distinct from `typeof window`, which stays the
 * page's (round 4, settled): only what a script reaches through `self` / `globalThis` is a worker's.
 *
 * With them the two interfaces a worker's `navigator` and `location` are instances of,
 * `WorkerNavigator` and `WorkerLocation` (Chrome's worker has no `Navigator` or `Location`;
 * the page's are what the worker page reaches, so each answers `instanceof` for that one
 * object). Read&Write's worker routes a message to its handlers only `typeof WorkerGlobalScope
 * !== 'undefined' && typeof importScripts === 'function' && navigator instanceof
 * WorkerNavigator` (a bundled worker test); once `WorkerGlobalScope` existed the third clause
 * threw `ReferenceError: WorkerNavigator is not defined` on every message and the toolbar's
 * chain (worker, offscreen document, speech frame) never completed.
 */
export function installWorkerScopeInterfaces(target: Any): void {
  const isWorkerGlobal = (value: unknown): boolean =>
    value === target ||
    value === Reflect.get(target, 'self') ||
    value === Reflect.get(target, 'globalThis')
  const scope = function WorkerGlobalScope(): never {
    throw new TypeError('Illegal constructor')
  }
  Object.setPrototypeOf(scope.prototype, EventTarget.prototype)
  Object.defineProperty(scope, Symbol.hasInstance, { value: isWorkerGlobal, configurable: true })
  const serviceScope = function ServiceWorkerGlobalScope(): never {
    throw new TypeError('Illegal constructor')
  }
  Object.setPrototypeOf(serviceScope.prototype, scope.prototype)
  Object.setPrototypeOf(serviceScope, scope)
  Object.defineProperty(serviceScope, Symbol.hasInstance, {
    value: isWorkerGlobal,
    configurable: true
  })
  const oneOf = (name: string, key: 'navigator' | 'location'): (() => never) => {
    const ctor = {
      [name]: function (): never {
        throw new TypeError('Illegal constructor')
      }
    }[name] as () => never
    Object.defineProperty(ctor, Symbol.hasInstance, {
      value: (value: unknown): boolean =>
        value !== undefined && value !== null && value === Reflect.get(target, key),
      configurable: true
    })
    return ctor
  }
  define(target, {
    WorkerGlobalScope: scope,
    ServiceWorkerGlobalScope: serviceScope,
    WorkerNavigator: oneOf('WorkerNavigator', 'navigator'),
    WorkerLocation: oneOf('WorkerLocation', 'location')
  })
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
      return infos.map((info) => windowClient(info, relay))
    },
    get: async (id: unknown) => {
      const infos = await listClients()
      const info = infos.find((entry) => entry.id === String(id))
      return info ? windowClient(info, relay) : undefined
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
    prompt: undefined,
    // Nor does a `ServiceWorkerGlobalScope` have `Worker` or `SharedWorker` (Chrome nests no
    // worker in a service worker). A script that reads `typeof Worker` as a bare identifier
    // sees the page's global, not `self`, so the page's constructors go too: JSONVue's
    // `WORKER_API_AVAILABLE` picks the branch that spawns `js/workers/formatter.js` and dies
    // on the error event, where Chrome runs its inline formatter.
    Worker: undefined,
    SharedWorker: undefined
  })
  installWorkerScopeInterfaces(target)

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
      relay.post(message, transfer, (encoded) => ({ op: 'post', ...encoded }))
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
