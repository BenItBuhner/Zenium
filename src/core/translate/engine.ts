import type {
  DetectionResult,
  EngineAssets,
  EngineOp,
  EngineRequest,
  EngineResponse,
  EngineResults,
  EngineTransport,
  LanguagePair,
  ModelFiles
} from '../../shared/translateEngine'
import { pairKey } from './registry'

export interface TranslateOptions {
  /** The models to run, in order: one pair, or two when pivoting through English. */
  route: LanguagePair[]
  /** The texts are HTML fragments whose markup must survive. */
  html: boolean
}

/**
 * What the translation core needs from a runtime. `WorkerEngine` drives Bergamot over the worker
 * protocol; anything with the same shape (a native runtime, a test double) can replace it.
 */
export interface TranslationEngine {
  /** Make a model available for `translate` (a no-op when it is already loaded). */
  loadPair(pair: LanguagePair, files: ModelFiles): Promise<void>
  translate(texts: string[], options: TranslateOptions): Promise<(string | null)[]>
  /** Identify the language of `text`. */
  detect(text: string): Promise<DetectionResult>
  unload(pair: LanguagePair): Promise<void>
  /** Pairs currently loaded, in load order. */
  loaded(): LanguagePair[]
  /** Stop the runtime; every pending call rejects. */
  dispose(): void
  readonly disposed: boolean
}

/** Time limits per operation; a stuck worker must not hang a tab forever. */
const TIMEOUTS_MS: Record<EngineOp, number> = {
  init: 60_000,
  load: 180_000,
  unload: 30_000,
  translate: 180_000,
  detect: 30_000
}

interface Pending {
  op: EngineOp
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** The Bergamot engine behind an `EngineTransport` (a Web Worker in the chrome). */
export class WorkerEngine implements TranslationEngine {
  private readonly pending = new Map<number, Pending>()
  private readonly pairs = new Map<string, LanguagePair>()
  private readonly ready: Promise<EngineResults['init']>
  private seq = 0
  disposed = false
  /** `BERGAMOT_VERSION_FULL` of the runtime, once initialised. */
  version = ''

  constructor(
    private readonly transport: EngineTransport,
    assets: EngineAssets
  ) {
    transport.onMessage((message) => this.receive(message))
    // A worker error (or the window relaying it going away) leaves nothing to talk to.
    transport.onError((message) => {
      this.fail(new Error(message))
      this.dispose()
    })
    this.ready = this.request('init', { assets }).then((result) => {
      this.version = result.bergamotVersion
      return result
    })
    this.ready.catch(() => undefined)
  }

  /** Resolves once the worker took the runtime assets (rejects when it could not start). */
  whenReady(): Promise<void> {
    return this.ready.then(() => undefined)
  }

  async loadPair(pair: LanguagePair, files: ModelFiles): Promise<void> {
    await this.ready
    if (this.pairs.has(pairKey(pair))) return
    await this.request('load', { pair, files })
    this.pairs.set(pairKey(pair), pair)
  }

  async translate(texts: string[], options: TranslateOptions): Promise<(string | null)[]> {
    if (texts.length === 0) return []
    await this.ready
    return this.request('translate', { route: options.route, texts, html: options.html })
  }

  async detect(text: string): Promise<DetectionResult> {
    await this.ready
    return this.request('detect', { text })
  }

  async unload(pair: LanguagePair): Promise<void> {
    if (!this.pairs.delete(pairKey(pair))) return
    await this.request('unload', { pair })
  }

  loaded(): LanguagePair[] {
    return [...this.pairs.values()]
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.fail(new Error('the translation engine was stopped'))
    this.transport.terminate()
  }

  private request<K extends EngineOp>(
    op: K,
    fields: Omit<Extract<EngineRequest, { op: K }>, 'id' | 'op'>
  ): Promise<EngineResults[K]> {
    if (this.disposed) return Promise.reject(new Error('the translation engine was stopped'))
    const id = ++this.seq
    return new Promise<EngineResults[K]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`the translation engine did not answer (${op})`))
      }, TIMEOUTS_MS[op])
      this.pending.set(id, {
        op,
        resolve: resolve as (result: unknown) => void,
        reject,
        timer
      })
      const message = { id, op, ...fields } as unknown as EngineRequest
      try {
        this.transport.post(message)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private receive(message: EngineResponse): void {
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new Error(message.error))
  }

  private fail(error: Error): void {
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const pending of waiting) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }
}
