import type { ServiceWorkerMain, Session, WebContents, WebFrameMain } from 'electron'
import type { EventDelivery, ExtensionView } from '../../../core/extensions/api/shim'
import { matchesAnyUrlFilter, type UrlFilter } from '../../../core/extensions/api/urlFilter'

export type FrameKind = ExtensionView['type']

/**
 * Listeners registered with `addListener(fn, { url: [...] })` (webNavigation): the shim numbers
 * them per context and the host matches the event URL here, before fan-out.
 */
export type ListenerFilters = Map<string, Map<number, UrlFilter[]>>

export interface FrameContext {
  key: string
  extensionId: string
  frame: WebFrameMain
  webContents: WebContents
  session: Session
  url: string
  kind: FrameKind
  manifestVersion: 2 | 3
  isBackgroundPage: boolean
  /** Events with at least one unfiltered listener. */
  listeners: Set<string>
  /** Filtered listeners by event name and filter id. */
  filters: ListenerFilters
  /** Chrome tab id of the page hosting this frame (extension pages opened as tabs). */
  tabId?: number
  windowId?: number
}

export interface WorkerContext {
  key: string
  extensionId: string
  versionId: number
  worker: ServiceWorkerMain
  session: Session
  listeners: Set<string>
  filters: ListenerFilters
  startedAt: number
  /**
   * `ServiceWorkerMain.send` is silently dropped while the worker's running status is still
   * `starting`, which is when its hello (and so the flush of everything queued for it) arrives.
   * Deliveries wait in `outbox` until the engine reports the worker running.
   */
  running: boolean
  outbox: Array<{ namespace: string; event: string; args: unknown[]; delivery?: EventDelivery }>
}

export type WorkerRunningStatus = 'starting' | 'running' | 'stopping' | 'stopped'

export interface DispatchOptions {
  /** Deliver even without a registration and wake a stopped worker (lifecycle events, alarms). */
  wake?: boolean
  /** Only contexts in sessions passing this filter (`storage.local` belongs to one partition). */
  session?: (session: Session) => boolean
  /**
   * The URL the event is about: listeners registered with URL filters only receive it when one
   * of their filters matches (`webNavigation`). Without it every listener receives the event.
   */
  url?: string
}

/** A `listen` / `unlisten` notification from the shim. */
export interface ListenPayload {
  event: string
  /** Set for a filtered listener; absent for the unfiltered kind. */
  filterId?: number
  filters?: UrlFilter[]
}

export interface HelloPayload {
  kind: 'frame' | 'worker'
  url: string
  manifestVersion: 2 | 3
  isBackgroundPage: boolean
  browserAliased: boolean
}

interface PendingEvent {
  namespace: string
  event: string
  args: unknown[]
  url?: string
  at: number
}

/** Events for a background context that is not alive yet wait this long for it. */
const PENDING_TTL_MS = 30_000
/** How long a freshly started worker is kept alive for its top-level script to register listeners. */
const STARTUP_KEEPALIVE_MS = 10_000
/** How long a worker is kept alive after an event so the listeners it triggered can finish. */
const EVENT_KEEPALIVE_MS = 5_000

/** Hold a worker's idle timer for `ms` (Chrome does the same around event dispatch). */
export function keepAlive(worker: ServiceWorkerMain, ms: number): void {
  let task: { end(): void } | null = null
  try {
    task = worker.startTask()
  } catch {
    return
  }
  setTimeout(() => {
    try {
      task?.end()
    } catch {
      /* worker already gone */
    }
  }, ms)
}

/**
 * Every live context of every extension – documents by frame, MV3 workers by version id – with
 * the events each one listens to, so the host can fan an event out to exactly the contexts that
 * want it and wake a stopped worker for the ones it registered before it went idle.
 */
export class ContextRegistry {
  private readonly frames = new Map<string, FrameContext>()
  private readonly workers = new Map<string, WorkerContext>()
  /** Events each extension's worker listened to at some point (survives the worker stopping). */
  private readonly workerEvents = new Map<string, Set<string>>()
  private readonly pendingBackground = new Map<string, PendingEvent[]>()
  /** Worker keys the engine reports running (`ServiceWorkerMain` has no status accessor). */
  private readonly runningWorkers = new Set<string>()
  private readonly watchedContents = new WeakSet<WebContents>()

  constructor(
    private readonly hooks: {
      /** Sessions that hold `extensionId`, primary first. */
      sessionsFor(extensionId: string): Session[]
      /** Persist the remembered worker events of an extension. */
      persistWorkerEvents(extensionId: string, events: string[]): void
      /** Locate the tab / window a document belongs to, for `extension.getViews`. */
      placeFrame(frame: FrameContext): { tabId?: number; windowId?: number }
    }
  ) {}

  restoreWorkerEvents(extensionId: string, events: string[]): void {
    this.workerEvents.set(extensionId, new Set(events.map(normalizeEventName)))
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  helloFrame(
    extensionId: string,
    frame: WebFrameMain,
    webContents: WebContents,
    payload: HelloPayload,
    kind: FrameKind
  ): FrameContext {
    const key = frameKey(frame)
    const context: FrameContext = {
      key,
      extensionId,
      frame,
      webContents,
      session: webContents.session,
      url: payload.url,
      kind: payload.isBackgroundPage ? 'background' : kind,
      manifestVersion: payload.manifestVersion,
      isBackgroundPage: payload.isBackgroundPage,
      // A hello means a new document: whatever the previous one listened to is gone with it.
      listeners: new Set(),
      filters: new Map()
    }
    Object.assign(context, this.hooks.placeFrame(context))
    this.frames.set(key, context)
    this.watch(webContents)
    if (context.isBackgroundPage) this.flushPendingBackground(extensionId)
    this.pushViews(extensionId)
    return context
  }

  helloWorker(extensionId: string, worker: ServiceWorkerMain, session: Session): WorkerContext {
    const key = workerKey(worker, session)
    const context: WorkerContext = {
      key,
      extensionId,
      versionId: worker.versionId,
      worker,
      session,
      listeners: new Set(),
      filters: new Map(),
      startedAt: Date.now(),
      running: this.runningWorkers.has(key),
      outbox: []
    }
    this.workers.set(key, context)
    // The script that follows the preload registers its listeners within this window; the
    // events queued for the worker while it was stopped must not outlive them.
    keepAlive(worker, STARTUP_KEEPALIVE_MS)
    this.flushPendingBackground(extensionId)
    return context
  }

  /** The engine's `running-status-changed` for a worker (any worker; non-extension ones are inert). */
  workerStatus(versionId: number, session: Session, status: WorkerRunningStatus): void {
    const key = `${sessionKey(session)}#${versionId}`
    if (status === 'running') {
      this.runningWorkers.add(key)
      const context = this.workers.get(key)
      if (context) this.workerRunning(context)
      return
    }
    if (status === 'stopping' || status === 'stopped') {
      this.runningWorkers.delete(key)
      this.workers.delete(key)
    }
  }

  private workerRunning(context: WorkerContext): void {
    context.running = true
    const queued = context.outbox.splice(0)
    for (const item of queued) {
      this.sendToWorker(context, item.namespace, item.event, item.args, item.delivery)
    }
  }

  private sendToWorker(
    context: WorkerContext,
    namespace: string,
    event: string,
    args: unknown[],
    delivery?: EventDelivery
  ): void {
    if (!context.running) {
      if (context.outbox.length < 100) context.outbox.push({ namespace, event, args, delivery })
      return
    }
    try {
      context.worker.send('zen-ext:event', namespace, event, args, delivery)
      // Chrome extends the worker's lifetime while the listeners the event triggered run.
      keepAlive(context.worker, EVENT_KEEPALIVE_MS)
    } catch {
      /* worker went away */
    }
  }

  frameFor(frame: WebFrameMain): FrameContext | undefined {
    const context = this.frames.get(frameKey(frame))
    if (!context) return undefined
    if (this.stale(context)) {
      this.frames.delete(context.key)
      return undefined
    }
    return context
  }

  /** Gone, or navigated to a page that is not this extension's any more (no hello follows). */
  private stale(context: FrameContext): boolean {
    if (context.frame.isDestroyed() || context.webContents.isDestroyed()) return true
    const url = context.frame.url
    if (url === '' || url.startsWith(`chrome-extension://${context.extensionId}/`)) return false
    // `about:blank` / `srcdoc` sub-frames carry the extension's origin without its URL.
    return context.frame.origin !== `chrome-extension://${context.extensionId}`
  }

  workerFor(worker: ServiceWorkerMain, session: Session): WorkerContext | undefined {
    return this.workers.get(workerKey(worker, session))
  }

  listen(context: FrameContext | WorkerContext, payload: ListenPayload, on: boolean): void {
    const name = normalizeEventName(payload.event)
    if (payload.filterId !== undefined) {
      const byId = context.filters.get(name) ?? new Map<number, UrlFilter[]>()
      if (on) byId.set(payload.filterId, payload.filters ?? [])
      else byId.delete(payload.filterId)
      if (byId.size === 0) context.filters.delete(name)
      else context.filters.set(name, byId)
    } else if (on) context.listeners.add(name)
    else context.listeners.delete(name)
    if ('worker' in context && on) {
      const remembered = this.workerEvents.get(context.extensionId) ?? new Set<string>()
      if (!remembered.has(name)) {
        remembered.add(name)
        this.workerEvents.set(context.extensionId, remembered)
        this.hooks.persistWorkerEvents(context.extensionId, [...remembered])
      }
    }
  }

  /** Forget everything about an extension (unloaded or removed). */
  forget(extensionId: string, opts: { keepWorkerEvents: boolean }): void {
    for (const [key, context] of this.frames)
      if (context.extensionId === extensionId) this.frames.delete(key)
    for (const [key, context] of this.workers)
      if (context.extensionId === extensionId) this.workers.delete(key)
    this.pendingBackground.delete(extensionId)
    if (!opts.keepWorkerEvents) {
      this.workerEvents.delete(extensionId)
      this.hooks.persistWorkerEvents(extensionId, [])
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  framesOf(extensionId: string): FrameContext[] {
    const out: FrameContext[] = []
    for (const [key, context] of this.frames) {
      if (context.extensionId !== extensionId) continue
      if (this.stale(context)) {
        this.frames.delete(key)
        continue
      }
      out.push(context)
    }
    return out
  }

  workersOf(extensionId: string): WorkerContext[] {
    const out: WorkerContext[] = []
    for (const [key, context] of this.workers) {
      if (context.extensionId !== extensionId) continue
      if (context.worker.isDestroyed()) {
        this.workers.delete(key)
        continue
      }
      out.push(context)
    }
    return out
  }

  /** The `extension.getViews` list of an extension. */
  views(extensionId: string): ExtensionView[] {
    return this.framesOf(extensionId)
      .filter((f) => f.frame.parent === null)
      .map((f) => ({ url: f.url, type: f.kind, tabId: f.tabId, windowId: f.windowId }))
  }

  /** Whether a live context or the remembered worker registrations want `namespace.event`. */
  hasListener(extensionId: string, namespace: string, event: string): boolean {
    const name = normalizeEventName(`${namespace}.${event}`)
    if (this.workerEvents.get(extensionId)?.has(name)) return true
    const wants = (c: FrameContext | WorkerContext): boolean =>
      c.listeners.has(name) || c.filters.has(name)
    if (this.framesOf(extensionId).some(wants)) return true
    return this.workersOf(extensionId).some(wants)
  }

  /**
   * What a context should receive of `name` for an event about `url`: `undefined` for every
   * listener (no URL, or the context registered nothing yet), else which listeners match. Null
   * when nothing in the context wants it.
   */
  private deliveryFor(
    context: FrameContext | WorkerContext,
    name: string,
    url: string | undefined
  ): EventDelivery | null | undefined {
    const filters = context.filters.get(name)
    if (url === undefined || !filters) return context.listeners.has(name) ? undefined : null
    const matched: number[] = []
    for (const [id, list] of filters) if (matchesAnyUrlFilter(url, list)) matched.push(id)
    const unfiltered = context.listeners.has(name)
    if (!unfiltered && matched.length === 0) return null
    return { unfiltered, matched }
  }

  // ---------------------------------------------------------------------------
  // Delivery
  // ---------------------------------------------------------------------------

  /**
   * Send `namespace.event` to every context of the extension that listens. A stopped worker is
   * woken when it registered the event before; `wake` forces that even without a registration
   * (lifecycle events an extension only listens to once its script runs).
   */
  dispatch(
    extensionId: string,
    namespace: string,
    event: string,
    args: unknown[],
    options: DispatchOptions = {}
  ): void {
    const name = normalizeEventName(`${namespace}.${event}`)
    const remembered = this.workerEvents.get(extensionId)?.has(name) ?? false
    let background = false
    for (const frame of this.framesOf(extensionId)) {
      if (options.session && !options.session(frame.session)) continue
      if (frame.isBackgroundPage) background = true
      let delivery = this.deliveryFor(frame, name, options.url)
      if (delivery === null) {
        if (!(options.wake && frame.isBackgroundPage)) continue
        delivery = undefined
      }
      try {
        frame.frame.send('zen-ext:event', namespace, event, args, delivery)
      } catch {
        /* frame went away */
      }
    }
    for (const worker of this.workersOf(extensionId)) {
      if (options.session && !options.session(worker.session)) continue
      background = true
      // A worker whose top-level script is still running has not registered anything yet; when
      // it listened to this event in an earlier life the shim queues the delivery for it.
      const fresh = Date.now() - worker.startedAt < STARTUP_KEEPALIVE_MS && remembered
      let delivery = this.deliveryFor(worker, name, options.url)
      if (delivery === null) {
        if (!options.wake && !fresh) continue
        delivery = undefined
      }
      this.sendToWorker(worker, namespace, event, args, delivery)
    }
    if (background) return
    // No background context is alive. A worker that registered the event before it stopped, or a
    // lifecycle event that must reach whichever background context comes up, waits in the queue
    // that `helloWorker` / the background page's `helloFrame` flush, and the worker is started.
    if (!remembered && !options.wake) return
    const primary = this.hooks.sessionsFor(extensionId)[0]
    if (options.session && primary && !options.session(primary)) return
    const queue = this.pendingBackground.get(extensionId) ?? []
    if (queue.length < 100) {
      const pending: PendingEvent = { namespace, event, args, at: Date.now() }
      if (options.url !== undefined) pending.url = options.url
      queue.push(pending)
    }
    this.pendingBackground.set(extensionId, queue)
    void this.wake(extensionId)
  }

  private waking = new Set<string>()

  /** Start the extension's MV3 worker in its primary session (a no-op when it is running). */
  async wake(extensionId: string): Promise<void> {
    if (this.waking.has(extensionId)) return
    const primary = this.hooks.sessionsFor(extensionId)[0]
    if (!primary) return
    this.waking.add(extensionId)
    try {
      await primary.serviceWorkers.startWorkerForScope(`chrome-extension://${extensionId}/`)
    } catch {
      /* MV2 extension, or the registration is not ready yet – the hello flushes the queue */
    } finally {
      this.waking.delete(extensionId)
    }
  }

  private flushPendingBackground(extensionId: string): void {
    const queue = this.pendingBackground.get(extensionId)
    if (!queue) return
    this.pendingBackground.delete(extensionId)
    const now = Date.now()
    for (const item of queue) {
      if (now - item.at > PENDING_TTL_MS) continue
      const options: DispatchOptions = { wake: true }
      if (item.url !== undefined) options.url = item.url
      this.dispatch(extensionId, item.namespace, item.event, item.args, options)
    }
  }

  /** Tell every document of an extension what `extension.getViews` should return. */
  pushViews(extensionId: string): void {
    const views = this.views(extensionId)
    for (const frame of this.framesOf(extensionId)) {
      const own = views.map((v) => ({ ...v, self: v.url === frame.url }))
      try {
        frame.frame.send('zen-ext:event', '__zen', 'views', [own])
      } catch {
        /* frame went away */
      }
    }
  }

  private watch(webContents: WebContents): void {
    if (this.watchedContents.has(webContents)) return
    this.watchedContents.add(webContents)
    webContents.once('destroyed', () => {
      const gone = new Set<string>()
      for (const [key, context] of this.frames) {
        if (context.webContents === webContents) {
          this.frames.delete(key)
          gone.add(context.extensionId)
        }
      }
      for (const extensionId of gone) this.pushViews(extensionId)
    })
  }
}

/** `browserAction.*` registrations are the MV2 spelling of `action.*`. */
export function normalizeEventName(name: string): string {
  return name.startsWith('browserAction.') ? `action.${name.slice('browserAction.'.length)}` : name
}

function frameKey(frame: WebFrameMain): string {
  return `${frame.processId}:${frame.routingId}`
}

/** Version ids are allocated per storage partition, so a worker is keyed by session as well. */
function workerKey(worker: ServiceWorkerMain, session: Session): string {
  return `${sessionKey(session)}#${worker.versionId}`
}

function sessionKey(session: Session): string {
  return session.storagePath || 'memory'
}
