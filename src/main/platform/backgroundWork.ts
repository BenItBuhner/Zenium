/**
 * The desktop's `PerformanceHost`: the `worker_threads` worker the core's background queue
 * (`core/background/work.ts`) runs its heavy parsing in, and the demo harness's hold on the
 * startup sweeps (`--hold-background-work` on the command line; never set in a normal launch).
 * The worker's entry is `backgroundWorker.ts`; electron-vite's `?nodeWorker` import bundles it as
 * a chunk of the main build and hands back the function that spawns it.
 */
import type { Worker } from 'node:worker_threads'
import type { BackgroundWorkerHandle } from '../../core/background/work'
import type { PerformanceHost } from '../../core/platform'
import createBackgroundWorker from './backgroundWorker?nodeWorker'

/** The command-line flag that holds the startup sweeps (the desktop demo drivers pass it). */
export const HOLD_BACKGROUND_WORK_FLAG = '--hold-background-work'

/** Whether `argv` (the process's) carries {@link HOLD_BACKGROUND_WORK_FLAG}. */
export function holdBackgroundWorkRequested(argv: readonly string[]): boolean {
  return argv.includes(HOLD_BACKGROUND_WORK_FLAG)
}

/** A `worker_threads` worker as the core's queue drives one. */
export function nodeWorkerHandle(worker: Worker): BackgroundWorkerHandle {
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

export function electronPerformanceHost(options: { holdBackgroundWork: boolean }): PerformanceHost {
  return {
    createBackgroundWorker: () => nodeWorkerHandle(createBackgroundWorker({})),
    holdBackgroundWork: () => options.holdBackgroundWork
  }
}
