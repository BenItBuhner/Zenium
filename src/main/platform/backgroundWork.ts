/**
 * The desktop's `PerformanceHost`: the `worker_threads` worker the core's background queue
 * (`core/background/work.ts`) runs its heavy parsing in, and the demo drivers' hold on the
 * startup sweeps (`--hold-background-work` on the command line; never set in a normal launch).
 * The worker's entry is `backgroundWorker.ts`; `ElectronPlatform` imports it with electron-vite's
 * `?nodeWorker` suffix (a chunk of the main build, and the function that spawns it) and hands the
 * spawn here, so this module stays plain node for the tests.
 */
import type { Worker } from 'node:worker_threads'
import type { BackgroundWorkerHandle } from '../../core/background/work'
import type { PerformanceHost } from '../../core/platform'

/** The command-line flag that holds the startup sweeps (the desktop demo drivers pass it). */
export const HOLD_BACKGROUND_WORK_FLAG = '--hold-background-work'

/** Whether `argv` (the process's) carries {@link HOLD_BACKGROUND_WORK_FLAG}. */
export function holdBackgroundWorkRequested(argv: readonly string[]): boolean {
  return argv.includes(HOLD_BACKGROUND_WORK_FLAG)
}

/** What the adapter needs of a `worker_threads` worker (the tests hand in a stand-in). */
export type NodeWorkerLike = Pick<Worker, 'postMessage' | 'on' | 'terminate'>

/** A `worker_threads` worker as the core's queue drives one. */
export function nodeWorkerHandle(worker: NodeWorkerLike): BackgroundWorkerHandle {
  return {
    postMessage: (message, transfer) => worker.postMessage(message, transfer),
    onMessage: (listener) => void worker.on('message', listener),
    onError: (listener) => {
      worker.on('error', (error) => listener(error.message || String(error)))
      // A worker that dies of its own accord (an exit the queue did not ask for) is lost too.
      worker.on('exit', (code) => {
        if (code !== 0) listener(`the worker exited with code ${code}`)
      })
    },
    terminate: () => void worker.terminate()
  }
}

export interface ElectronPerformanceOptions {
  /** `--hold-background-work` was on the command line. */
  holdBackgroundWork: boolean
  /** Spawn the background worker (`backgroundWorker?nodeWorker`); absent: the main thread does the work. */
  spawnWorker?: () => NodeWorkerLike
}

export function electronPerformanceHost(options: ElectronPerformanceOptions): PerformanceHost {
  const { spawnWorker } = options
  return {
    createBackgroundWorker: spawnWorker ? () => nodeWorkerHandle(spawnWorker()) : () => null,
    holdBackgroundWork: () => options.holdBackgroundWork
  }
}
