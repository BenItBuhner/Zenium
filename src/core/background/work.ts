/**
 * Background work: the one place the services hand their heavy parsing and hashing to, and the
 * one place a host (or its demo harness) can hold that work back.
 *
 * The queue runs one {@link BackgroundTask} at a time, in order, inside the host's worker when it
 * has one (`Platform.performance.createBackgroundWorker`: a module Web Worker in the Android
 * chrome, a `worker_threads` worker in Electron's main process) and on the main thread otherwise
 * (`runInline`: the chunked path, in the node tests and on a host without workers). Both services
 * share the queue, so the Safe Browsing feeds and the filter lists never parse at the same time:
 * one worker's memory, one core, and the main thread only ever moves an `ArrayBuffer` or a string
 * in and out. A worker that fails is given up on for the session and its job runs inline once.
 *
 * The hold. `Platform.performance.holdBackgroundWork()` is the host's word that the startup
 * sweeps should wait – the demo harness sets it for its scenes (Android: the intent extra the
 * boot payload carries; Electron: `--hold-background-work`) – and {@link BackgroundWork.armStartup}
 * consults it: a held sweep re-arms every {@link HOLD_RECHECK_MS} instead of running, and runs
 * once the hold is gone, at once when {@link BackgroundWork.release} is called (the
 * `performance.releaseBackgroundWork` command) or at the next check when the host's flag drops.
 * Never held in production: no host sets the flag on its own.
 */
import type { BackgroundReply, BackgroundRequest, BackgroundTask } from './tasks'

/** A worker the host spawned, as the queue drives it. */
export interface BackgroundWorkerHandle {
  postMessage(message: BackgroundRequest, transfer: ArrayBuffer[]): void
  onMessage(listener: (message: unknown) => void): void
  /** The worker itself failed (its script did not load, it crashed): the queue gives it up. */
  onError(listener: (message: string) => void): void
  terminate(): void
}

export interface BackgroundWorkOptions {
  /** Spawn the host's worker; null (or a throw) leaves every task to the main thread. */
  worker?: (() => BackgroundWorkerHandle | null) | null
  /** The host's hold on the startup sweeps (see the module comment); absent: never held. */
  hold?: (() => boolean) | null
}

/** How long a held startup sweep waits before it looks at the hold again. */
export const HOLD_RECHECK_MS = 5_000
/** An idle worker is let go after this; the next task spawns one again. */
export const WORKER_IDLE_MS = 30_000

export class BackgroundWork {
  private worker: BackgroundWorkerHandle | null = null
  /** The worker cannot be had this session (spawn failed or it crashed): every task runs inline. */
  private workerGone = false
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve(output: unknown): void; reject(error: Error): void; fallback(): void }
  >()
  private queue: Promise<void> = Promise.resolve()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private released = false
  private stopped = false
  private readonly armed = new Set<() => void>()
  /** Tasks run so far, by where they ran (diagnostics and the tests). */
  readonly runs = { worker: 0, inline: 0 }

  constructor(private readonly options: BackgroundWorkOptions = {}) {}

  /** Whether the host asks the startup sweeps to wait right now (see the module comment). */
  held(): boolean {
    if (this.released || this.stopped) return false
    try {
      return this.options.hold?.() === true
    } catch {
      return false
    }
  }

  /** End the hold for good (the `performance.releaseBackgroundWork` command): held sweeps run now. */
  release(): void {
    if (this.released) return
    this.released = true
    for (const wake of [...this.armed]) wake()
  }

  /**
   * Run `fn` once, `delayMs` from now – or, if the work is held when the time comes, at the next
   * {@link HOLD_RECHECK_MS} check that finds it free (at once on {@link release}). Returns the
   * function that cancels it.
   */
  armStartup(delayMs: number, fn: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null
    // The release wakes the arm only once its delay has passed: a hold lifted early leaves the
    // sweep to its own time.
    let due = false
    const wake = (): void => {
      if (!due || timer === null) return
      clearTimeout(timer)
      fire()
    }
    const fire = (): void => {
      timer = null
      this.armed.delete(wake)
      fn()
    }
    const check = (): void => {
      timer = null
      if (this.stopped) return
      if (this.held()) {
        timer = setTimeout(check, HOLD_RECHECK_MS)
        return
      }
      fire()
    }
    this.armed.add(wake)
    timer = setTimeout(() => {
      due = true
      check()
    }, delayMs)
    return () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      this.armed.delete(wake)
    }
  }

  /**
   * Run `task` on `input` after the tasks already queued; resolves with its output. `transfer`
   * names the input's buffers to move into the worker. A task that throws rejects, wherever it ran.
   */
  run<I, O>(task: BackgroundTask<I, O>, input: I, transfer: ArrayBuffer[] = []): Promise<O> {
    return new Promise<O>((resolve, reject) => {
      const start = (): Promise<void> => this.execute(task, input, transfer).then(resolve, reject)
      this.queue = this.queue.then(start, start)
    })
  }

  /** Let the worker go and cancel every armed sweep (shutdown). */
  stop(): void {
    this.stopped = true
    this.armed.clear()
    this.dropWorker()
  }

  private async execute<I, O>(
    task: BackgroundTask<I, O>,
    input: I,
    transfer: ArrayBuffer[]
  ): Promise<O> {
    if (this.stopped) throw new Error('background work stopped')
    const worker = this.ensureWorker()
    if (!worker) return this.inline(task, input)
    this.clearIdle()
    try {
      return await this.post(worker, task, input, transfer)
    } finally {
      this.scheduleIdle()
    }
  }

  private async inline<I, O>(task: BackgroundTask<I, O>, input: I): Promise<O> {
    this.runs.inline++
    return task.runInline ? task.runInline(input) : task.run(input)
  }

  private post<I, O>(
    worker: BackgroundWorkerHandle,
    task: BackgroundTask<I, O>,
    input: I,
    transfer: ArrayBuffer[]
  ): Promise<O> {
    return new Promise<O>((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, {
        resolve: (output) => resolve(output as O),
        reject,
        // The worker went away under this job: the main thread does it, once.
        fallback: () => void this.inline(task, input).then(resolve, reject)
      })
      try {
        worker.postMessage({ id, name: task.name, input }, transfer)
      } catch (error) {
        this.pending.delete(id)
        this.failWorker(error instanceof Error ? error.message : String(error))
        void this.inline(task, input).then(resolve, reject)
      }
    })
  }

  private ensureWorker(): BackgroundWorkerHandle | null {
    if (this.worker) return this.worker
    if (this.workerGone || !this.options.worker) return null
    let worker: BackgroundWorkerHandle | null
    try {
      worker = this.options.worker()
    } catch (error) {
      this.failWorker(error instanceof Error ? error.message : String(error))
      return null
    }
    if (!worker) {
      this.workerGone = true
      return null
    }
    worker.onMessage((message) => this.onReply(worker, message))
    worker.onError((message) => {
      if (this.worker === worker) this.failWorker(message)
    })
    this.worker = worker
    return worker
  }

  private onReply(worker: BackgroundWorkerHandle, message: unknown): void {
    if (this.worker !== worker) return
    const reply = message as Partial<BackgroundReply> | null
    if (!reply || typeof reply.id !== 'number') return
    const waiter = this.pending.get(reply.id)
    if (!waiter) return
    this.pending.delete(reply.id)
    this.runs.worker++
    if (reply.ok === true) {
      waiter.resolve(reply.output)
      return
    }
    const error = (reply as { error?: unknown }).error
    waiter.reject(new Error(typeof error === 'string' ? error : 'the task failed'))
  }

  /** The worker is lost: what waited on it runs inline, and nothing is posted to one again. */
  private failWorker(message: string): void {
    console.warn(`[zenium] background worker unavailable, working on the main thread: ${message}`)
    this.workerGone = true
    this.dropWorker()
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const waiter of waiting) waiter.fallback()
  }

  private dropWorker(): void {
    this.clearIdle()
    const worker = this.worker
    this.worker = null
    if (!worker) return
    try {
      worker.terminate()
    } catch {
      // Already gone.
    }
  }

  private scheduleIdle(): void {
    this.clearIdle()
    if (!this.worker) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      // Let it go only between tasks; a task in flight keeps it.
      if (this.pending.size === 0) this.dropWorker()
    }, WORKER_IDLE_MS)
  }

  private clearIdle(): void {
    if (this.idleTimer === null) return
    clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}
