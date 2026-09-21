/**
 * The JS half of the Kotlin ⇄ JS bridge.
 *
 * Kotlin exposes `window.__zenNative` (a `@JavascriptInterface` object) with three entry points:
 *   call(json)      – asynchronous; Kotlin answers through `__zenHost.resolve/reject`.
 *   post(json)      – asynchronous and one way; Kotlin answers nothing (the per-frame commands).
 *   callSync(json)  – synchronous; only for boot data and last-chance persistence.
 * Kotlin talks back through `window.__zenHost` (installed by `installHostGlobal`).
 */
export interface NativeBridge {
  call(json: string): void
  callSync(json: string): string
  /** One way: no `resolve` comes back. Hosts before the bar hide profile (#270) lack it. */
  post?(json: string): void
}

export interface NativeCall {
  id: number
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

  constructor(private readonly native: NativeBridge) {}

  call<T = void>(method: string, args: unknown = {}): Promise<T> {
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
    try {
      this.native.post(JSON.stringify({ method, args }))
    } catch (error) {
      console.warn(`[zen] native ${method} failed`, error)
    }
  }

  callSync<T>(method: string, args: unknown = {}): T {
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
