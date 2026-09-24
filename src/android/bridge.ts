/**
 * The JS half of the Kotlin ⇄ JS bridge.
 *
 * Kotlin exposes `window.__zenNative` (a `@JavascriptInterface` object) with four entry points:
 *   call(json)      – asynchronous; Kotlin answers through `__zenHost.resolve/reject`.
 *   post(json)      – asynchronous and one way; Kotlin answers nothing (the per-frame commands).
 *   batch(json)     – one way like `post`, for a list of commands in one hop (a layout's view ops).
 *   callSync(json)  – synchronous; only for boot data and last-chance persistence.
 * Kotlin talks back through `window.__zenHost` (installed by `installHostGlobal`).
 *
 * Every entry point is a synchronous `@JavascriptInterface` call: the JS thread waits while the
 * WebView carries the string to its Java bridge thread and back, and on a busy device that wait
 * is the thread's scheduling, not the string's size (the tab swipe profile, #312: a layout
 * report's four to six hops cost a fling 43 ms of its 74 ms of script). So a hop is the unit to
 * save, and `batched` saves them: the one-way commands of one task go out as one `batch`.
 *
 * The one call whose wait is the hop itself and nothing else is the storage write: its answer
 * comes back asynchronously anyway (`__zenHost.resolve`, once the document has landed), and the
 * synchronous hop it paid to hand the string over was 4–68 ms of the chrome's frame on the
 * emulator with 1 ms of it on the CPU (#455's finding, on the thirty-tab overview fold). So the
 * host offers an ASYNCHRONOUS CHANNEL for such calls: a `MessagePort` (the WebView's
 * `WebMessageChannel`) it hands the page at boot ({@link openBridgePort}); `postMessage` on it is
 * a pipe write that never blocks the JS thread, and the reply still comes through `__zenHost`.
 * One rule keeps the order: a CLASS of calls – the calls that must keep their order among
 * themselves – goes through the port whole or not at all; once the page holds the port, EVERY
 * call of {@link PORTED} (the storage class, #458; the thumbnail read, a class of one) goes
 * through it and none through `call`; a host without the channel answers `false` and the page
 * keeps `call` for them, as before.
 */
export interface NativeBridge {
  call(json: string): void
  callSync(json: string): string
  /** One way: no `resolve` comes back. Hosts before the bar hide profile (#270) lack it. */
  post?(json: string): void
  /**
   * One way, a JSON array of `{ method, args }` dispatched in order on the host's main thread,
   * in one task. Hosts before the view batch (#312's H3b) lack it.
   */
  batch?(json: string): void
}

export interface NativeCall {
  id: number
  method: string
  args: unknown
}

/** One command of a `batch`: what `post` sends, without the envelope's id. */
export interface NativeCommand {
  method: string
  args: unknown
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** The page's end of the host's asynchronous channel: what a `MessagePort` has that the bridge uses. */
export interface BridgePort {
  postMessage(message: string): void
  close(): void
}

/**
 * The storage class: the core's stores writing and removing their documents through
 * `AndroidStoreIO` (`storeIo.ts`) – the `STORAGE_CALLS` the host parses and dispatches on its
 * storage thread (`JsBridge.kt`), every one an awaited `call` whose answer arrives through
 * `__zenHost` after the write has landed. Ordered among themselves (a later write of a document
 * supersedes the one before it; a document in pieces lands piece by piece), so one FIFO into the
 * host's one storage thread: the class goes through the port whole or not at all – two channels
 * reorder against each other, one FIFO does not (services perf pass 2, #458).
 */
export const STORAGE_CLASS: readonly string[] = [
  'storage.write',
  'storage.remove',
  'storage.writeBegin',
  'storage.writeChunk',
  'storage.writeEnd',
  'storage.writeAbort'
]

/**
 * The thumbnail read, a class of one (services perf pass 3): `thumbnail.load`, a card's picture
 * asked for as the overview shows it – an awaited `call` the host answers off its io pool with
 * the file's bytes (`Host.kt` `"thumbnail.load" -> io.execute`). Its wait was the hop and nothing
 * else: in #458's runs the fold of a thirty-tab group left the JavaBridge thread two tasks, both
 * `thumbnail.load`, 2.4–4.0 ms of the JS thread's frame for the pair with 0.1–0.4 ms of Java in
 * them. It is ordered against NOTHING, which is why it is its own class and not the storage
 * class's seventh member: not against the storage calls (another subject – the pictures' files,
 * not the stores' documents – and another host thread, `io`, never the storage thread, so the
 * two were never ordered against each other through the hop either); not against its siblings
 * (each read is its own file, and the pool runs them side by side); not against the thumbnail
 * commands that keep the hop (`thumbnail.drop` / `sweep` / `configure`: a drop runs on the
 * pictures' disk thread and a load on `io`, so a load racing a drop reads the picture or reads
 * nothing, as before – `loadPicture` answers null for a picture of another page). A class of one
 * has no order to keep, so the switch to the port and the fallback from it can never reorder it;
 * the host routes it as it routes any call off the port that is not a storage call – parsed on
 * the port's thread, dispatched on the main thread – into the same `io.execute` as today.
 */
export const THUMBNAIL_CLASS: readonly string[] = ['thumbnail.load']

/**
 * The calls that take the asynchronous channel once the host has handed one over: the classes
 * above, each whole. The port is one FIFO into the host's receiving thread, so two classes on it
 * keep their order against each other as well – but no class here needs that.
 */
export const PORTED: ReadonlySet<string> = new Set([...STORAGE_CLASS, ...THUMBNAIL_CLASS])

/** The method the page asks the host for its channel with (`Host.dispatch`); the token comes back as the port's message. */
export const PORT_REQUEST = 'bridge.port'

/**
 * Whether the bridge marks its hops in the performance timeline (`bridge:<entry>:<method>`, the
 * entry being `call`, `port`, `post`, `sync` or `batch` – a batch named by its commands' methods
 * joined with `+` – in the `blink.user_timing` category of the WebView's trace): the motion
 * profile's probe (`MotionPerfDemo`) turns it on for a scene, so the trace tells every hop's task
 * by the entry point and the method that paid it; off, a hop costs no mark. Read on every hop so
 * a probe installed after boot is heard.
 */
const traced = (): boolean =>
  (globalThis as { __zenBridgeTrace?: unknown }).__zenBridgeTrace === true

export class Bridge {
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  /** The `batched` commands of the current task, not yet flushed. */
  private queue: NativeCommand[] = []
  /** The host's asynchronous channel for the {@link PORTED} calls, once handed over ({@link adoptPort}). */
  private port: BridgePort | null = null

  constructor(private readonly native: NativeBridge) {}

  /** Whether the {@link PORTED} calls go through the host's channel (for the boot log and the tests). */
  get ported(): boolean {
    return this.port !== null
  }

  /**
   * Take the host's channel: from here every {@link PORTED} call goes through the port, none
   * through `call`. The switch keeps the order: a `call` before it handed its string to the
   * host's storage thread before this thread went on (the hop is synchronous), so a call after
   * it, through the port, is queued there behind it. A second port is not taken (closed).
   */
  adoptPort(port: BridgePort): void {
    if (this.port !== null) {
      port.close()
      return
    }
    this.port = port
  }

  call<T = void>(method: string, args: unknown = {}): Promise<T> {
    this.flush()
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      try {
        this.hop(method, JSON.stringify({ id, method, args } satisfies NativeCall))
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** One `call` string to the host: through the port for a {@link PORTED} method once there is one, else the `call` hop. */
  private hop(method: string, json: string): void {
    const port = this.port
    if (port !== null && PORTED.has(method)) {
      if (traced()) performance.mark(`bridge:port:${method}`)
      try {
        port.postMessage(json)
        return
      } catch (error) {
        // A port that will not take a string (closed under the page: the host closed its
        // channel) is dropped for good, and this call and every later one take the hop.
        this.port = null
        console.warn('[zen] the bridge port failed; back to call', error)
      }
    }
    if (traced()) performance.mark(`bridge:call:${method}`)
    this.native.call(json)
  }

  /** Fire-and-forget variant for the many tiny view updates (bounds, visibility, …). */
  send(method: string, args: unknown = {}): void {
    void this.call(method, args).catch((error) => {
      console.warn(`[zen] native ${method} failed`, error)
    })
  }

  /**
   * One way, for a command sent every frame whose answer nobody reads (the bar hide's frame,
   * `chrome.setBarHide`): the host dispatches it and sends nothing back. `send` is a `call`
   * under the hood, and each of its answers is an `evaluateJavascript` of `__zenHost.resolve`
   * on the chrome's main thread – a task of its own per frame, next to the frame's real work
   * (the bar hide profile, #270). A host without `post` gets a `send`.
   */
  post(method: string, args: unknown = {}): void {
    if (typeof this.native.post !== 'function') {
      this.send(method, args)
      return
    }
    this.flush()
    if (traced()) performance.mark(`bridge:post:${method}`)
    try {
      this.native.post(JSON.stringify({ method, args } satisfies NativeCommand))
    } catch (error) {
      console.warn(`[zen] native ${method} failed`, error)
    }
  }

  /**
   * One way like `post`, and coalesced: the commands `batched` in one task leave together in ONE
   * hop (`batch`), at the end of the task (a microtask) or before the task's next hop of any other
   * kind – so the host sees every command in the order it was given, a `call` after a batched
   * command never overtaking it. For the commands sent several at a time whose answers nobody
   * reads: a layout report's view ops (`view.setBounds`, `view.setRadius`, `view.setVisible`, …
   * for each view it places), four to six hops per report and none of them worth the wait
   * (#312's H3b). A host without `batch` gets a `send` each, as before it.
   */
  batched(method: string, args: unknown = {}): void {
    if (typeof this.native.batch !== 'function') {
      this.send(method, args)
      return
    }
    this.queue.push({ method, args })
    if (this.queue.length === 1) queueMicrotask(() => this.flush())
  }

  /**
   * Send the `batched` commands waiting, if any, as one hop. The bridge's own: a batch leaves at
   * the task's microtask or ahead of the task's next hop, never by hand.
   */
  private flush(): void {
    if (this.queue.length === 0 || typeof this.native.batch !== 'function') return
    const commands = this.queue
    this.queue = []
    if (traced()) performance.mark(`bridge:batch:${commands.map((c) => c.method).join('+')}`)
    try {
      this.native.batch(JSON.stringify(commands))
    } catch (error) {
      console.warn(
        `[zen] native batch of ${commands.map((c) => c.method).join(', ')} failed`,
        error
      )
    }
  }

  callSync<T>(method: string, args: unknown = {}): T {
    this.flush()
    if (traced()) performance.mark(`bridge:sync:${method}`)
    const raw = this.native.callSync(JSON.stringify({ id: 0, method, args } satisfies NativeCall))
    return (raw === '' ? undefined : JSON.parse(raw)) as T
  }

  resolve(id: number, resultJson: string | null | undefined): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    try {
      p.resolve(
        resultJson === null || resultJson === undefined || resultJson === ''
          ? undefined
          : JSON.parse(resultJson)
      )
    } catch (error) {
      p.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  reject(id: number, message: string): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    p.reject(new Error(message))
  }
}

export function getNativeBridge(): NativeBridge | null {
  const w = window as unknown as { __zenNative?: NativeBridge }
  return w.__zenNative && typeof w.__zenNative.call === 'function' ? w.__zenNative : null
}

/** Where the host's port arrives ({@link openBridgePort}): the window, or a stand-in in the tests. */
export interface PortTarget {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

/** An unguessable token for one port request (`crypto.randomUUID` wants a secure context; the dev server is not one). */
function portToken(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

/**
 * Ask the host for its asynchronous channel ({@link PORT_REQUEST}: one `call`, at boot) and take
 * the port it posts to the document – a `message` event on the window whose data is the
 * request's token and whose one port is the channel's page end (`ChromeWebView.openBridgePort`).
 * The token is random and the event must carry it, so nothing else that can post to the window
 * (a frame of the chrome's document) hands the bridge a port of its own. A host without the
 * channel answers `false` (an older host rejects the method): the bridge keeps `call` for the
 * {@link PORTED} calls, as before, and the listener goes. The listener goes once the port is
 * taken too; until then every call takes the hop, as it always did.
 */
export function openBridgePort(bridge: Bridge, target: PortTarget, token = portToken()): void {
  const stop = (): void => target.removeEventListener('message', onMessage)
  const onMessage = (event: MessageEvent): void => {
    if (event.data !== token) return
    const port = event.ports?.[0]
    if (!port) return
    stop()
    bridge.adoptPort(port)
    console.debug('[zen] bridge: the storage calls and the thumbnail reads take the host’s port')
  }
  target.addEventListener('message', onMessage)
  bridge.call<boolean>(PORT_REQUEST, { token }).then(
    (offered) => {
      if (offered === true) return
      stop()
      console.debug('[zen] bridge: no port from this host; the ported calls take the hop')
    },
    (error: unknown) => {
      stop()
      console.debug('[zen] bridge: no port from this host; the ported calls take the hop', error)
    }
  )
}
