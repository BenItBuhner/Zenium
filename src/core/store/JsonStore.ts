import type { StoreIO, StoreWriteOptions } from '../platform'

export interface JsonStoreOptions {
  debounceMs?: number
  /**
   * Keep the previous version as `<name>.bak` on every write and read it when the document is
   * missing or corrupt (the profile's core documents).
   */
  backup?: boolean
}

/**
 * Tiny debounced JSON document store. The host's `StoreIO` decides how documents are made durable
 * (Electron writes a temp file and renames it over the target; Android hands the text to Kotlin).
 *
 * Writes land in the order they were asked for, whichever way they go: the asynchronous ones run
 * one after the other, and the synchronous write of a shutdown supersedes every asynchronous one
 * still waiting its turn and is repeated after one that had already started – which would
 * otherwise land after it and put its older document back (a graceful quit whose last debounced
 * write fired just before it left `cleanExit: false` in the profile).
 */
export class JsonStore<T> {
  private pending: T | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** The asynchronous writes in order; each starts once the one before it has landed. */
  private writing: Promise<void> = Promise.resolve()
  /** Asynchronous writes are numbered as they are queued; a synchronous write supersedes them. */
  private queued = 0
  private superseded = 0
  /** Asynchronous writes that have started (their document is being written by the host). */
  private inFlight = 0
  private readonly debounceMs: number
  private readonly writeOptions: StoreWriteOptions | undefined
  /** Whether the last `readSync` had to fall back to the backup. */
  readFromBackup = false

  /** Every store's asynchronous writes that have not landed yet. */
  private static readonly active = new Set<Promise<void>>()

  constructor(
    private readonly io: StoreIO,
    private readonly name: string,
    options: number | JsonStoreOptions = {}
  ) {
    const opts = typeof options === 'number' ? { debounceMs: options } : options
    this.debounceMs = opts.debounceMs ?? 400
    this.writeOptions = opts.backup ? { backup: true } : undefined
  }

  /** Whether any store still has a write in flight (`idle` resolves once none has). */
  static get busy(): boolean {
    return JsonStore.active.size > 0
  }

  /**
   * Resolves once every store's writes have landed – the asynchronous ones in flight and the
   * repeat of a synchronous write that followed one of them. Shutdown paths wait for this before
   * the process goes away, so that the final write is complete and the last one.
   */
  static async idle(): Promise<void> {
    while (JsonStore.active.size > 0) await Promise.allSettled([...JsonStore.active])
  }

  /**
   * Synchronous read used once at startup. Returns `null` when the document is missing or corrupt
   * – after trying the backup, for stores that keep one.
   */
  readSync(): T | null {
    this.readFromBackup = false
    const primary = this.parse(this.name)
    if (primary !== null || !this.writeOptions?.backup) return primary
    const backup = this.parse(`${this.name}.bak`)
    if (backup !== null) {
      console.warn(`[zen] ${this.name} unreadable, using its backup`)
      this.readFromBackup = true
    }
    return backup
  }

  private parse(name: string): T | null {
    try {
      const raw = this.io.readSync(name)
      if (raw === null || raw === '') return null
      return JSON.parse(raw) as T
    } catch (error) {
      console.warn(`[zen] could not read ${name}:`, error)
      return null
    }
  }

  /** Schedule a write; consecutive calls within the debounce window collapse into one. */
  write(data: T): void {
    this.pending = data
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), this.debounceMs)
  }

  /** Write immediately (used on quit). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const data = this.pending
    if (data === null) return
    this.pending = null
    const seq = ++this.queued
    this.writing = this.track(
      this.writing
        .then(async () => {
          // A synchronous write landed a newer document while this one waited its turn.
          if (seq <= this.superseded) return
          this.inFlight++
          try {
            await this.io.write(this.name, JSON.stringify(data), this.writeOptions)
          } finally {
            this.inFlight--
          }
        })
        .catch((error) => {
          console.error(`[zen] failed writing ${this.name}:`, error)
        })
    )
    await this.writing
  }

  /**
   * Synchronous flush for shutdown paths where async work may not complete. The document written
   * here is the last one to land: asynchronous writes still queued are dropped, and one that has
   * already started is followed by a repeat of this write (`idle` covers the repeat).
   */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pending === null) return
    const text = JSON.stringify(this.pending)
    this.pending = null
    this.superseded = this.queued
    this.writeNow(text)
    if (this.inFlight > 0) {
      this.writing = this.track(this.writing.then(() => this.writeNow(text)))
    }
  }

  private writeNow(text: string): void {
    try {
      this.io.writeSync(this.name, text, this.writeOptions)
    } catch (error) {
      console.error(`[zen] failed writing ${this.name}:`, error)
    }
  }

  private track(write: Promise<void>): Promise<void> {
    const tracked: Promise<void> = write.finally(() => {
      JsonStore.active.delete(tracked)
    })
    JsonStore.active.add(tracked)
    return tracked
  }
}
