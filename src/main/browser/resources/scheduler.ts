export interface SchedulerHost {
  /** Create the page and start loading it. Returns false when the tab no longer exists. */
  load(tabId: string): boolean
  tabExists(tabId: string): boolean
  liveCount(): number
  maxConcurrent(): number
  /** Hard cap on live pages (0 = unlimited). */
  maxLive(): number
  /** Discard a hidden page to make room under the cap. Returns false when nothing can go. */
  makeRoom(): boolean
  onDeferred(tabId: string): void
  onChange(): void
}

/** A load that never reports completion still frees its slot after this long. */
const IN_FLIGHT_TIMEOUT_MS = 30_000

/**
 * Background page loads go through here so a session restore or a burst of "open in new tab"
 * never starts dozens of renderers at once: at most `maxConcurrent` loads run at a time and the
 * live-page cap is honoured before a new renderer is spawned. Visible tabs bypass the queue but
 * still occupy a slot.
 */
export class LoadScheduler {
  private readonly queue: string[] = []
  private readonly inFlight = new Map<string, number>()

  constructor(private readonly host: SchedulerHost) {}

  /** Ask for a background load. Returns true when it started right away. */
  request(tabId: string): boolean {
    if (this.inFlight.has(tabId)) return true
    this.expireStale()
    if (this.canStart()) return this.start(tabId)
    if (!this.queue.includes(tabId)) {
      this.queue.push(tabId)
      this.host.onDeferred(tabId)
      this.host.onChange()
    }
    return false
  }

  /** A visible (user-requested) load started outside the queue. */
  track(tabId: string): void {
    this.dequeue(tabId)
    this.inFlight.set(tabId, Date.now())
  }

  /** The load finished, failed, or the page went away – free the slot and start the next one. */
  finished(tabId: string): void {
    const wasQueued = this.dequeue(tabId)
    const wasInFlight = this.inFlight.delete(tabId)
    if (wasQueued || wasInFlight) this.pump()
  }

  /** Start queued loads while there are free slots. */
  pump(): void {
    this.expireStale()
    let changed = false
    while (this.queue.length && this.canStart()) {
      const id = this.queue.shift()!
      changed = true
      if (!this.host.tabExists(id)) continue
      this.start(id)
    }
    if (changed) this.host.onChange()
  }

  get queued(): number {
    return this.queue.length
  }

  isQueued(tabId: string): boolean {
    return this.queue.includes(tabId)
  }

  get loading(): number {
    return this.inFlight.size
  }

  private canStart(): boolean {
    if (this.inFlight.size >= Math.max(1, this.host.maxConcurrent())) return false
    const max = this.host.maxLive()
    if (max > 0 && this.host.liveCount() >= max && !this.host.makeRoom()) return false
    return true
  }

  private start(tabId: string): boolean {
    this.inFlight.set(tabId, Date.now())
    const ok = this.host.load(tabId)
    if (!ok) this.inFlight.delete(tabId)
    return ok
  }

  private dequeue(tabId: string): boolean {
    const idx = this.queue.indexOf(tabId)
    if (idx === -1) return false
    this.queue.splice(idx, 1)
    return true
  }

  private expireStale(): void {
    const now = Date.now()
    for (const [id, startedAt] of this.inFlight) {
      if (now - startedAt > IN_FLIGHT_TIMEOUT_MS) this.inFlight.delete(id)
    }
  }
}
