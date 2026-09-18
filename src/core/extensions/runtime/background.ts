import type { RuntimeManifest } from './manifest'

/**
 * The lifecycle of an extension's background context on a host that runs MV3 service workers
 * and MV2 event pages as hidden pages: Chrome's policy, without Chrome. A worker (or an event
 * page) starts when something needs it, stays while it is busy and is torn down after a quiet
 * half minute; the events it registered listeners for wake it again, with the event held until
 * it is ready. Persistent MV2 background pages never idle out.
 *
 * Pure bookkeeping over an injected host (`start`/`stop` the page, timers): the runtime feeds
 * it what it sees on the bridge and asks it before delivering anything to a background.
 */
export type BackgroundKind = 'none' | 'persistent' | 'event' | 'worker'

export type BackgroundState = 'stopped' | 'starting' | 'running'

export interface BackgroundHost {
  /** Load the background page; the host keeps a page that is already running at the same URL. */
  start(id: string): void
  /** Destroy the background page; its endpoints report gone afterwards. */
  stop(id: string): void
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface BackgroundOptions {
  /** Quiet time before a worker or event page is torn down; Chrome's is 30 s. */
  idleMs?: number
  /** Ceiling for a start that never reports ready (a script that throws before `load`). */
  startTimeoutMs?: number
}

export interface BackgroundStats {
  starts: number
  idleStops: number
  /** Events and messages held for a background that was not running when they arrived. */
  queued: number
  /** Events dropped because the background was stopped and had no listener persisted for them. */
  dropped: number
}

export type DeliveryOutcome = 'sent' | 'queued' | 'dropped'

const DEFAULT_IDLE_MS = 30_000
const DEFAULT_START_TIMEOUT_MS = 60_000

/** Which policy a manifest's background declaration falls under. */
export function backgroundKindOf(manifest: RuntimeManifest): BackgroundKind {
  const background = manifest.background
  if (!background) return 'none'
  if (background.kind === 'service_worker') return 'worker'
  return background.persistent ? 'persistent' : 'event'
}

interface Entry {
  kind: BackgroundKind
  state: BackgroundState
  /** `chrome.<ns>.<event>` names the background registered listeners for, kept across stops. */
  listeners: Set<string>
  queue: Array<() => void>
  idleTimer: unknown
  startTimer: unknown
  /** The runtime asked for the stop (idle or detach): the gone that follows is expected. */
  stopping: boolean
  stats: BackgroundStats
}

export class BackgroundLifecycle {
  private readonly entries = new Map<string, Entry>()
  private readonly idleMs: number
  private readonly startTimeoutMs: number

  constructor(
    private readonly host: BackgroundHost,
    options: BackgroundOptions = {}
  ) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
  }

  /**
   * Register (or re-register, after a reconfigure) an extension's background. `listeners` are
   * the event names persisted from earlier runs: they decide which events wake a stopped
   * worker before it ever ran in this session.
   */
  configure(id: string, kind: BackgroundKind, listeners: Iterable<string> = []): void {
    const existing = this.entries.get(id)
    if (existing) {
      existing.kind = kind
      for (const name of listeners) existing.listeners.add(name)
      if (kind === 'none') this.remove(id)
      else if (kind === 'persistent') this.clearIdle(existing)
      else if (existing.state === 'running') this.armIdle(id, existing)
      return
    }
    if (kind === 'none') return
    this.entries.set(id, {
      kind,
      state: 'stopped',
      listeners: new Set(listeners),
      queue: [],
      idleTimer: null,
      startTimer: null,
      stopping: false,
      stats: { starts: 0, idleStops: 0, queued: 0, dropped: 0 }
    })
  }

  /** The extension is going away: stop its page and forget everything but nothing (detach). */
  remove(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.clearIdle(entry)
    this.clearStart(entry)
    entry.queue.length = 0
    if (entry.state !== 'stopped') {
      entry.stopping = true
      this.host.stop(id)
    }
    this.entries.delete(id)
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  state(id: string): BackgroundState {
    return this.entries.get(id)?.state ?? 'stopped'
  }

  kind(id: string): BackgroundKind {
    return this.entries.get(id)?.kind ?? 'none'
  }

  stats(id: string): BackgroundStats | null {
    const entry = this.entries.get(id)
    return entry ? { ...entry.stats } : null
  }

  /** Listener names to persist (`chrome.<ns>.<event>`), so the next session knows what wakes it. */
  persistedListeners(id: string): string[] {
    return [...(this.entries.get(id)?.listeners ?? [])].sort()
  }

  /** Idempotent: a page that is starting or running is left alone. */
  ensureStarted(id: string): void {
    const entry = this.entries.get(id)
    if (!entry || entry.state !== 'stopped') return
    entry.state = 'starting'
    entry.stopping = false
    entry.stats.starts += 1
    this.clearStart(entry)
    entry.startTimer = this.host.setTimeout(() => {
      // Never said ready: whatever waited for it is not going to be answered by this page.
      if (entry.state !== 'starting') return
      entry.startTimer = null
      this.flush(entry)
      entry.state = 'running'
      this.armIdle(id, entry)
    }, this.startTimeoutMs)
    this.host.start(id)
  }

  /** The background page finished loading (its scripts ran and registered their listeners). */
  onReady(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.clearStart(entry)
    entry.state = 'running'
    entry.stopping = false
    this.flush(entry)
    this.armIdle(id, entry)
  }

  /**
   * The background's endpoint vanished: our own stop, a renderer crash, or a reload. Anything
   * still queued restarts it (a crash while work waited), otherwise it rests until needed.
   */
  onGone(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.clearIdle(entry)
    this.clearStart(entry)
    entry.state = 'stopped'
    const expected = entry.stopping
    entry.stopping = false
    if (entry.queue.length > 0 || (!expected && entry.kind === 'persistent')) this.ensureStarted(id)
  }

  /** Something happened on the background's bridge: it is busy, the idle clock restarts. */
  activity(id: string): void {
    const entry = this.entries.get(id)
    if (!entry || entry.state !== 'running') return
    this.armIdle(id, entry)
  }

  /** The background added (`on`) or removed its last listener for `chrome.<ns>.<event>`. */
  listen(id: string, event: string, on: boolean): void {
    const entry = this.entries.get(id)
    if (!entry) return
    if (on) entry.listeners.add(event)
    else entry.listeners.delete(event)
  }

  /**
   * Deliver something to the background: `send` runs now when it is running, is held until it
   * is ready when it is starting, and wakes it first when it is stopped. `event` names the
   * `chrome.<ns>.<event>` being raised; a stopped background is only woken for events it
   * registered a listener for (in this or an earlier session). Messages and ports (`event ===
   * null`) always wake it, as in Chrome, where `runtime.sendMessage` starts the worker.
   */
  deliver(id: string, event: string | null, send: () => void): DeliveryOutcome {
    const entry = this.entries.get(id)
    if (!entry) return 'dropped'
    switch (entry.state) {
      case 'running':
        send()
        this.armIdle(id, entry)
        return 'sent'
      case 'starting':
        entry.queue.push(send)
        entry.stats.queued += 1
        return 'queued'
      case 'stopped':
        if (event !== null && !entry.listeners.has(event)) {
          entry.stats.dropped += 1
          return 'dropped'
        }
        entry.queue.push(send)
        entry.stats.queued += 1
        this.ensureStarted(id)
        return 'queued'
    }
  }

  /** Whether an event would reach the background: running, or stopped with a listener for it. */
  wouldDeliver(id: string, event: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    return entry.state !== 'stopped' || entry.listeners.has(event)
  }

  private flush(entry: Entry): void {
    const queued = entry.queue.splice(0)
    for (const send of queued) send()
  }

  private armIdle(id: string, entry: Entry): void {
    this.clearIdle(entry)
    if (entry.kind === 'persistent') return
    entry.idleTimer = this.host.setTimeout(() => {
      entry.idleTimer = null
      if (entry.state !== 'running') return
      entry.state = 'stopped'
      entry.stopping = true
      entry.stats.idleStops += 1
      this.host.stop(id)
    }, this.idleMs)
  }

  private clearIdle(entry: Entry): void {
    if (entry.idleTimer !== null) this.host.clearTimeout(entry.idleTimer)
    entry.idleTimer = null
  }

  private clearStart(entry: Entry): void {
    if (entry.startTimer !== null) this.host.clearTimeout(entry.startTimer)
    entry.startTimer = null
  }
}
