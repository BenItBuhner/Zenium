import type { WorkerRunningStatus } from './contexts'

/** An MV3 worker's renderer, as its preload reported it: the OS pid and whose worker it is. */
export interface WorkerProcess {
  osPid: number
  extensionId: string
}

/** After a worker's script ran, how long the host waits for a word from its preload before warning. */
export const WORKER_PRELOAD_GRACE_MS = 5_000

export interface WorkerHandshakeOptions {
  /**
   * A worker of `extensionId` ran its script and its preload never spoke: the service-worker
   * preload did not run. Called once per process – the cause is the process's, not a worker's.
   */
  onPreloadMissing: (extensionId: string) => void
  graceMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * What every MV3 worker's preload (`preload/extension.ts`) tells the host as the worker starts,
 * and what the host makes of a worker that starts without it.
 *
 * The preload's first act is a synchronous request for its shim options (the `toggles` channel);
 * the worker's script runs only after the answer. So by the time the engine reports the worker
 * `running` – its script evaluated – a preload that ran has spoken, and one that has not by then
 * never will: Electron evaluates `service-worker` preloads in its sandboxed renderer client only,
 * and a renderer launched with `--no-sandbox` and without `--enable-sandbox` is not one (see
 * `platform/sandbox.ts`). The check gives the word a grace period past `running`, then warns once
 * per process, naming the cause; the extensions' workers run on the engine's own `chrome.*` then.
 *
 * The same first message carries the worker renderer's OS pid, which nothing else joins to the
 * worker (`ServiceWorkerInfo.renderProcessId` is a render-process-host id, `app.getAppMetrics()`
 * an OS pid): the task manager names the process by it while the worker runs.
 */
export class WorkerHandshakes {
  /** The extension of every worker this run knows, by worker key (`workerKey`). */
  private readonly owners = new Map<string, string>()
  /** Worker keys whose preload has spoken in the current run of the worker. */
  private readonly heard = new Set<string>()
  /** The pending preload check of a running worker, by key. */
  private readonly pending = new Map<string, unknown>()
  /** The renderer of every worker whose preload sent its pid, by key. */
  private readonly renderers = new Map<string, WorkerProcess>()
  private warned = false
  private readonly graceMs: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly options: WorkerHandshakeOptions) {
    this.graceMs = options.graceMs ?? WORKER_PRELOAD_GRACE_MS
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
  }

  /** The engine's `running-status-changed` for an extension's worker. */
  status(key: string, extensionId: string, status: WorkerRunningStatus): void {
    if (status === 'stopping' || status === 'stopped') {
      this.release(key)
      return
    }
    this.owners.set(key, extensionId)
    if (status !== 'running') return
    if (this.heard.has(key) || this.warned || this.pending.has(key)) return
    const handle = this.setTimer(() => {
      this.pending.delete(key)
      if (this.heard.has(key) || this.warned) return
      this.warned = true
      this.options.onPreloadMissing(extensionId)
    }, this.graceMs)
    this.pending.set(key, handle)
  }

  /**
   * The preload's first message – the shim options request – with what it sent along: its
   * process's pid, when the preload could read one. The worker counts as heard either way.
   */
  hello(key: string, extensionId: string, payload: unknown): void {
    this.owners.set(key, extensionId)
    this.speak(key)
    const pid = pidOf(payload)
    if (pid !== null) this.renderers.set(key, { osPid: pid, extensionId })
  }

  /** Any other message from the worker's preload: it ran, whatever its first message said. */
  heardFrom(key: string): void {
    this.speak(key)
  }

  /** The worker is gone: its run is over, its renderer no longer its. */
  release(key: string): void {
    const handle = this.pending.get(key)
    if (handle !== undefined) {
      this.pending.delete(key)
      this.clearTimer(handle)
    }
    this.owners.delete(key)
    this.heard.delete(key)
    this.renderers.delete(key)
  }

  /** Every worker of `extensionId` is over: an unload, an uninstall. */
  forget(extensionId: string): void {
    for (const [key, owner] of [...this.owners]) {
      if (owner === extensionId) this.release(key)
    }
  }

  /** The renderers of the running workers whose preloads reported a pid. */
  processes(): WorkerProcess[] {
    return [...this.renderers.values()]
  }

  private speak(key: string): void {
    this.heard.add(key)
    const handle = this.pending.get(key)
    if (handle === undefined) return
    this.pending.delete(key)
    this.clearTimer(handle)
  }
}

/** The pid a preload sent in its first message: a positive integer under `pid`, or nothing. */
function pidOf(payload: unknown): number | null {
  if (payload === null || typeof payload !== 'object') return null
  const { pid } = payload as { pid?: unknown }
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null
}
