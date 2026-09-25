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
 * Every asynchronous entry pays that wait for nothing but the handover: its answer, when it has
 * one, comes back asynchronously anyway (`__zenHost.resolve`, once the work is done), and the
 * synchronous hop that handed the string over was 4–68 ms of the chrome's frame on the emulator
 * with 1 ms of it on the CPU (#455's finding, on the thirty-tab overview fold; 52 hops and
 * 182 ms of the JS thread across the tab swipe and the overview, #469's runs). So the host offers
 * an ASYNCHRONOUS CHANNEL: a `MessagePort` (the WebView's `WebMessageChannel`) it hands the page
 * at boot ({@link openBridgePort}); `postMessage` on it is a pipe write that never blocks the JS
 * thread, and the reply still comes through `__zenHost`.
 *
 * THE RULE (services perf pass 4; the storage class took the port in #458, the thumbnail read in
 * #469): once the page holds the port, THE PORT IS THE BRIDGE – every `call`, `send`, `post` and
 * `batch` goes through `port.postMessage`, one FIFO, and none through the hops; `callSync` alone
 * stays a hop, because it is synchronous by nature (the answer is wanted on this thread, now).
 * The host reads the port on one thread and dispatches each string BY ITS SHAPE into the route
 * the hop would have taken (`JsBridge.route`: a JSON array is a batch, an envelope with an id a
 * call, one without a post), so the port carries the same strings the hops did and the host runs
 * them the same way. There is no per-method set any more (#458's `PORTED`): the set was the
 * storage class and the thumbnail read while only they were ported; with everything but the
 * synchronous reads on the port, the only rule left is the entry's, and `callSync` is the one
 * exception, stated where it lives. Before the port arrives every kind hops as it always did; a
 * host that answers `false` (or knows no such call) keeps the hops for good.
 *
 * THE ORDER: the page's order is the port's order is the host's receipt order – one pipe, read
 * on one thread, each string posted to the main thread (or the storage thread, for a storage
 * call) as it is read, so the main thread's dispatch order is the page's order too, a batch one
 * task as before. The switch cannot reorder: a hop before the port handed its string to the host
 * before this thread went on, so a string after it, through the port, is queued behind it. A
 * port that throws is dropped for good, for every kind, and the string that failed and every
 * later one take the hops; but a `postMessage` into a port whose other end is gone does not
 * throw – the HTML spec drops it – so the hazard is LOSS, not reorder, and its bound is the
 * host's: the host closes its end only with the document (replaced, rebuilt, destroyed), so the
 * strings that can be lost are a dying document's, sent between the host's close and the
 * document's end, and the host tolerates a view it never heard of (`TabHost`: a silent no-op).
 *
 * THE PRICE (pass 4's finding): the WebView delivers a port message as a task on its UI thread –
 * the host's main thread – before it reaches the host's reading thread, so a string off the port
 * is queued on the main thread twice (its delivery, then its dispatch) where a hop's was once;
 * what the JS thread no longer waits for inside the hop, the host's main thread queues once more,
 * in its own proportion (up to a frame of it when that thread is busy). Measured, not designed
 * around: the host's `BridgeLatency` reads it per kind beside these marks.
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
 * The entries the port carries once the page holds it: every asynchronous one. `sync` is the one
 * that does not – `callSync` wants its answer on this thread before the next statement, which no
 * pipe can give – and it is named here so the exception is a value the tests read, not a clause.
 */
export type PortedKind = 'call' | 'post' | 'batch'
export const PORTED_KINDS: readonly PortedKind[] = ['call', 'post', 'batch']

/** The method the page asks the host for its channel with (`Host.dispatch`); the token comes back as the port's message. */
export const PORT_REQUEST = 'bridge.port'

/**
 * Whether the bridge marks its hops in the performance timeline (`bridge:<entry>:<method>` as a
 * hop leaves and the same name with `:ret` as the host's entry point returns, the entry being
 * `call`, `post`, `sync` or `batch` for a hop – a batch named by its commands' methods joined
 * with `+` – and `port:call`, `port:post` or `port:batch` for a string through the port, named
 * by the entry it would have hopped through – in the `blink.user_timing` category of the
 * WebView's trace): the motion profile's probe (`MotionPerfDemo`) turns it on for a scene, so the
 * trace tells every string's task by the channel, the entry and the method that paid it, and the
 * pair of marks tells the JS thread's wait in the hop (or the pipe write) itself, whatever else
 * the task around it did; off, a hop costs no mark. Read on every hop so a probe installed after
 * boot is heard.
 */
const traced = (): boolean =>
  (globalThis as { __zenBridgeTrace?: unknown }).__zenBridgeTrace === true

const noMark = (): void => {}

/**
 * Mark a hop as it leaves (`bridge:<entry>:<method>`) and hand back the mark of its return
 * (`…:ret`); nothing when untraced – not even the name is built then, so a hop in production pays
 * one flag read and no string. A batch's name is its commands' methods joined, so it is passed as
 * a thunk and joined only under the flag.
 */
const markHop = (entry: string, method: string | (() => string)): (() => void) => {
  if (!traced()) return noMark
  const name = `bridge:${entry}:${typeof method === 'function' ? method() : method}`
  performance.mark(name)
  return () => {
    performance.mark(`${name}:ret`)
  }
}

export class Bridge {
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  /** The `batched` commands of the current task, not yet flushed. */
  private queue: NativeCommand[] = []
  /** The host's asynchronous channel, once handed over ({@link adoptPort}): the bridge itself for every kind of {@link PORTED_KINDS}. */
  private port: BridgePort | null = null

  constructor(private readonly native: NativeBridge) {}

  /** Whether the asynchronous entries go through the host's channel (for the boot log and the tests). */
  get ported(): boolean {
    return this.port !== null
  }

  /**
   * Take the host's channel: from here every `call`, `post` and `batch` goes through the port,
   * none through the hops; `callSync` alone keeps hopping. The switch keeps the order: a hop
   * before it handed its string to the host before this thread went on (the hop is synchronous:
   * the host's receiving thread had posted its task, or handed it to the storage thread, by the
   * time the entry point returned), so a string after it, through the port, is queued behind
   * it. A second port is not taken (closed).
   */
  adoptPort(port: BridgePort): void {
    if (this.port !== null) {
      port.close()
      return
    }
    this.port = port
  }

  /**
   * One string to the host through the port, if the page holds one: true when it went (marked
   * `bridge:port:<kind>:<method>` and `:ret` around the pipe write when traced); false when
   * there is no port – or the port threw, in which case it is dropped FOR GOOD, for every kind,
   * and this string and every later one take the hops. A port whose other end is gone does not
   * throw on `postMessage` (the message is dropped, per the HTML spec), so a throw is not the
   * expected way a port dies; it is the one way this thread can see, and it is answered once.
   */
  private viaPort(kind: PortedKind, method: string | (() => string), json: string): boolean {
    const port = this.port
    if (port === null) return false
    const returned = markHop(`port:${kind}`, method)
    try {
      port.postMessage(json)
      returned()
      return true
    } catch (error) {
      this.port = null
      console.warn('[zen] the bridge port failed; every kind takes the hop from here', error)
      return false
    }
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

  /** One `call` string to the host: through the port once there is one, else the `call` hop. */
  private hop(method: string, json: string): void {
    if (this.viaPort('call', method, json)) return
    const returned = markHop('call', method)
    this.native.call(json)
    returned()
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
   * (the bar hide profile, #270). A host without `post` gets a `send`. Through the port once the
   * page holds one (the same string, without the envelope's id: the host tells a post from a
   * call by that), else the `post` hop.
   */
  post(method: string, args: unknown = {}): void {
    if (typeof this.native.post !== 'function') {
      this.send(method, args)
      return
    }
    this.flush()
    const json = JSON.stringify({ method, args } satisfies NativeCommand)
    if (this.viaPort('post', method, json)) return
    const returned = markHop('post', method)
    try {
      this.native.post(json)
      returned()
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
   * Send the `batched` commands waiting, if any, as one string: through the port once the page
   * holds one (a JSON array, which is how the host tells a batch from an envelope; one main-thread
   * task for the array as the hop's was), else the `batch` hop. The bridge's own: a batch leaves
   * at the task's microtask or ahead of the task's next string of any other kind, never by hand.
   */
  private flush(): void {
    if (this.queue.length === 0 || typeof this.native.batch !== 'function') return
    const commands = this.queue
    this.queue = []
    const methods = (): string => commands.map((c) => c.method).join('+')
    const json = JSON.stringify(commands)
    if (this.viaPort('batch', methods, json)) return
    const returned = markHop('batch', methods)
    try {
      this.native.batch(json)
      returned()
    } catch (error) {
      console.warn(
        `[zen] native batch of ${commands.map((c) => c.method).join(', ')} failed`,
        error
      )
    }
  }

  /**
   * Synchronous, and the one entry the port never carries: the answer is wanted on this thread
   * before the next statement, so it hops as it always did – after the batch waiting, if any,
   * has left this thread (through the port or the hop), as before. What changed with the port is
   * the one difference between the channels: a string ahead of this one through the port has
   * LEFT the page but may not have been received by the host, let alone executed, when this one
   * runs on the host's bridge thread (the pipe's delivery crosses the WebView's UI thread and the
   * port's handler thread; the JNI hop does not), where a hop's string had been posted to the
   * main thread already. No sync call of the chrome's reads a state that a string ahead of it
   * writes – `boot` runs before any port; the storage reads answer the file, which only a write
   * EXECUTING on the storage thread changes and neither channel ever waited for; the sync writes
   * run on the bridge thread themselves; the navigation reads answer a mirror the view's own
   * pushes write, never a call's receipt (the audit of every site is in services perf pass 4's
   * body) – so no fence (`seq` / `after`) is added here, and none is wanted.
   */
  callSync<T>(method: string, args: unknown = {}): T {
    this.flush()
    const returned = markHop('sync', method)
    const raw = this.native.callSync(JSON.stringify({ id: 0, method, args } satisfies NativeCall))
    returned()
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
 * channel answers `false` (an older host rejects the method): the bridge keeps the hops for
 * every kind, for good, and the listener goes. The listener goes once the port is taken too;
 * until then every string takes its hop, as it always did.
 */
export function openBridgePort(bridge: Bridge, target: PortTarget, token = portToken()): void {
  const stop = (): void => target.removeEventListener('message', onMessage)
  const onMessage = (event: MessageEvent): void => {
    if (event.data !== token) return
    const port = event.ports?.[0]
    if (!port) return
    stop()
    bridge.adoptPort(port)
    console.debug('[zen] bridge: the port is the bridge from here (every call, post and batch); callSync hops')
  }
  target.addEventListener('message', onMessage)
  bridge.call<boolean>(PORT_REQUEST, { token }).then(
    (offered) => {
      if (offered === true) return
      stop()
      console.debug('[zen] bridge: no port from this host; every kind keeps the hop')
    },
    (error: unknown) => {
      stop()
      console.debug('[zen] bridge: no port from this host; every kind keeps the hop', error)
    }
  )
}
