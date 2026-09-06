/**
 * The JS half of the Kotlin ⇄ JS bridge.
 *
 * Kotlin exposes `window.__zenNative` (a `@JavascriptInterface` object) with two entry points:
 *   call(json)      – asynchronous; Kotlin answers through `__zenHost.resolve/reject`.
 *   callSync(json)  – synchronous; only for boot data and last-chance persistence.
 * Kotlin talks back through `window.__zenHost` (installed by `installHostGlobal`).
 */
export interface NativeBridge {
  call(json: string): void
  callSync(json: string): string
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
