import type { ServiceWorkerMain, Session } from 'electron'

/**
 * The `ServiceWorkerMain` wrappers that carry the router's IPC handlers, one per live extension
 * worker version.
 *
 * Electron routes a worker's `ipcRenderer.invoke` to the `ipc` of whatever wrapper its version
 * map holds at that moment, and a wrapper's `ipc` is its own: handlers installed on one wrapper
 * are not on the next. The map drops a wrapper when Electron destroys it and hands out a fresh,
 * handler-less one the next time anybody asks for the version, without a
 * `running-status-changed` when the worker itself kept running. So the handlers are installed on
 * acquisition: every wrapper the router obtains, from wherever, is wired exactly once, and a
 * wrapper found destroyed is replaced by asking the engine again.
 */
export class WiredWorkers {
  /** The wired wrapper of every version, by worker key. */
  private readonly byKey = new Map<string, ServiceWorkerMain>()
  /** Wrappers that received the handlers (a wrapper survives its worker stopping and restarting). */
  private readonly installed = new WeakSet<ServiceWorkerMain>()

  constructor(private readonly install: (worker: ServiceWorkerMain, session: Session) => void) {}

  /**
   * Install the handlers on `worker` unless it has them; false when there is nothing to wire (no
   * wrapper, a destroyed one, or a site's worker rather than an extension's).
   */
  wire(worker: ServiceWorkerMain | null | undefined, session: Session): boolean {
    if (!worker || worker.isDestroyed()) return false
    if (!worker.scope.startsWith('chrome-extension://')) return false
    if (!this.installed.has(worker)) {
      this.installed.add(worker)
      this.install(worker, session)
    }
    this.byKey.set(workerKey(worker.versionId, session), worker)
    return true
  }

  /**
   * The wired wrapper of a version: the one held while it lives, else the engine's current one
   * (created on demand for a live version), wired. Undefined when the version is gone.
   */
  acquire(versionId: number, session: Session): ServiceWorkerMain | undefined {
    const held = this.current(versionId, session)
    if (held) return held
    let fresh: ServiceWorkerMain | undefined
    try {
      fresh = session.serviceWorkers.getWorkerFromVersionID(versionId)
    } catch {
      fresh = undefined
    }
    return fresh && this.wire(fresh, session) ? fresh : undefined
  }

  /** The wired wrapper of a version if one is held and alive; never asks the engine. */
  current(versionId: number, session: Session): ServiceWorkerMain | undefined {
    const key = workerKey(versionId, session)
    const held = this.byKey.get(key)
    if (held && !held.isDestroyed()) return held
    if (held) this.byKey.delete(key)
    return undefined
  }

  /** The version stopped: its key is free (a later run of it re-acquires the wrapper, wired once). */
  release(versionId: number, session: Session): void {
    this.byKey.delete(workerKey(versionId, session))
  }
}

/**
 * The session events Electron dispatches a worker's `invoke`, `send` and `sendSync` from
 * (`lib/browser/ipc-dispatch.ts`; internal names, stable since the worker IPC exists).
 */
const WORKER_IPC_EVENTS = ['-ipc-invoke', '-ipc-message', '-ipc-message-sync'] as const

/**
 * Call `acquire` with the version id behind each incoming worker message before Electron's own
 * dispatch runs. That dispatch only looks the wrapper up (`_getWorkerFromVersionIDIfExists`):
 * when the map holds none it answers an `invoke` with 'No handler registered' and drops a `send`,
 * so the wrapper has to exist, wired, by the time it looks. Electron attaches its dispatch
 * listener when the session is created; one prepended here runs first. Should the internal
 * names ever change, this path goes quiet and the others (status, console, wake) remain.
 */
export function acquireOnIncomingIpc(session: Session, acquire: (versionId: number) => void): void {
  const listener = (event: unknown): void => {
    const versionId = workerVersionOfIpcEvent(event)
    if (versionId === undefined) return
    try {
      acquire(versionId)
    } catch {
      /* Electron's dispatch follows this listener; a failure here must not keep it from running. */
    }
  }
  for (const name of WORKER_IPC_EVENTS) session.prependListener(name, listener)
}

/** The version id of the worker an Electron IPC dispatch event came from; undefined for a frame's. */
export function workerVersionOfIpcEvent(event: unknown): number | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const { type, versionId } = event as { type?: unknown; versionId?: unknown }
  if (type !== 'service-worker' || typeof versionId !== 'number') return undefined
  return Number.isInteger(versionId) ? versionId : undefined
}

/** Version ids are allocated per storage partition, so a worker is keyed by session as well. */
export function workerKey(versionId: number, session: Session): string {
  return `${sessionKey(session)}#${versionId}`
}

export function sessionKey(session: Session): string {
  return session.storagePath || 'memory'
}
