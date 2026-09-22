/**
 * The desktop's background worker: a `worker_threads` worker of Electron's main process (the
 * core runs there, and the main process has no Web Workers), serving the core's heavy tasks over
 * its parent port – a Safe Browsing feed's text to its prefix table, a filter list's text to its
 * network filters. electron-vite bundles it beside the main entry (`backgroundWork.ts` imports it
 * with `?nodeWorker`); one instance at a time, spawned on the first task and let go when idle.
 */
import { parentPort } from 'node:worker_threads'
import { CORE_BACKGROUND_TASKS } from '../../core/background/tasks'
import { serveBackgroundTasks } from '../../core/background/worker'

const port = parentPort
if (!port) throw new Error('the background worker has no parent port')

serveBackgroundTasks(
  {
    postMessage: (message, transfer) => port.postMessage(message, transfer),
    onMessage: (listener) => void port.on('message', listener)
  },
  CORE_BACKGROUND_TASKS
)
