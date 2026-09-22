/**
 * The desktop's background worker: a `worker_threads` worker of Electron's main process (the
 * core runs there, and the main process has no Web Workers), serving the core's heavy tasks over
 * its parent port – a Safe Browsing feed's text to its prefix table, a filter list's text to its
 * network filters – and the desktop's own: the lists compiled into Ghostery's engine, as bytes
 * (`blockingCompile.ts`). electron-vite bundles it beside the main entry (`ElectronPlatform`
 * imports it with `?nodeWorker`); one instance at a time, spawned on the first task and let go
 * when idle. Nothing from `electron` is imported here or below: a worker thread has none of it.
 */
import { parentPort } from 'node:worker_threads'
import { CORE_BACKGROUND_TASKS } from '../../core/background/tasks'
import type { BackgroundTask } from '../../core/background/tasks'
import { serveBackgroundTasks } from '../../core/background/worker'
import { GHOSTERY_COMPILE_TASK } from './blockingCompile'

const port = parentPort
if (!port) throw new Error('the background worker has no parent port')

serveBackgroundTasks(
  {
    postMessage: (message, transfer) => port.postMessage(message, transfer),
    onMessage: (listener) => void port.on('message', listener)
  },
  [...CORE_BACKGROUND_TASKS, GHOSTERY_COMPILE_TASK as BackgroundTask<unknown, unknown>]
)
