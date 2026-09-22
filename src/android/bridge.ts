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

export class Bridge {
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  /** The `batched` commands of the current task, not yet flushed. */
  private queue: NativeCommand[] = []

  constructor(private readonly native: NativeBridge) {}

  call<T = void>(method: string, args: unknown = {}): Promise<T> {
    this.flush()
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      try {
        this.native.call(JSON.stringify({ id, method, args } satisfies NativeCall))
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
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
