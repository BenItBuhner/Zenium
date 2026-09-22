/**
 * The Android chrome's background worker: a module Web Worker beside the chrome document, from
 * the same assets (`AndroidPlatform.performance.createBackgroundWorker` spawns it), serving the
 * core's heavy tasks – a Safe Browsing feed's text to its prefix table, a filter list's text to
 * its network filters – so the chrome's main thread only ever moves a string in and a buffer out.
 * The Kotlin host has no part in it, and the preview host runs it the same way.
 */
import { CORE_BACKGROUND_TASKS } from '../core/background/tasks'
import { serveBackgroundTasks } from '../core/background/worker'

const scope = self as unknown as {
  postMessage(message: unknown, transfer: ArrayBuffer[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
}

serveBackgroundTasks(
  {
    postMessage: (message, transfer) => scope.postMessage(message, transfer),
    onMessage: (listener) => scope.addEventListener('message', (event) => listener(event.data))
  },
  CORE_BACKGROUND_TASKS
)
