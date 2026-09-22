/**
 * The worker side of the background work: one request in, one reply out, over whatever port the
 * host's worker has (`self` in a Web Worker, `parentPort` in a Node worker thread – each host's
 * entry adapts its own and hands it here with the tasks it serves). No state between requests.
 */
import type { BackgroundReply, BackgroundRequest, BackgroundTask } from './tasks'

/** The messaging surface of a worker global, as the two hosts' entries present it. */
export interface WorkerPort {
  postMessage(message: BackgroundReply, transfer: ArrayBuffer[]): void
  onMessage(listener: (message: unknown) => void): void
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

/** Answer `port`'s requests with `tasks`; an unknown task or a throwing one is a failed reply. */
export function serveBackgroundTasks(
  port: WorkerPort,
  tasks: ReadonlyArray<BackgroundTask<unknown, unknown>>
): void {
  const byName = new Map(tasks.map((task) => [task.name, task]))
  port.onMessage((message) => {
    const request = message as Partial<BackgroundRequest> | null
    if (!request || typeof request.id !== 'number' || typeof request.name !== 'string') return
    const task = byName.get(request.name)
    if (!task) {
      port.postMessage({ id: request.id, ok: false, error: `unknown task ${request.name}` }, [])
      return
    }
    try {
      const output = task.run(request.input)
      port.postMessage({ id: request.id, ok: true, output }, task.transferables?.(output) ?? [])
    } catch (error) {
      port.postMessage({ id: request.id, ok: false, error: describe(error) }, [])
    }
  })
}
