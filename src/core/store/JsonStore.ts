import type { StoreIO } from '../platform'

/**
 * Tiny debounced JSON document store. The host's `StoreIO` decides how documents are made durable
 * (Electron writes a temp file and renames it over the target; Android hands the text to Kotlin).
 */
export class JsonStore<T> {
  private pending: T | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly io: StoreIO,
    private readonly name: string,
    private readonly debounceMs = 400
  ) {}

  /** Synchronous read used once at startup. Returns `null` when the document is missing or corrupt. */
  readSync(): T | null {
    try {
      const raw = this.io.readSync(this.name)
      if (raw === null || raw === '') return null
      return JSON.parse(raw) as T
    } catch (error) {
      console.warn(`[zen] could not read ${this.name}:`, error)
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
    this.writing = this.writing
      .then(() => this.io.write(this.name, JSON.stringify(data)))
      .catch((error) => {
        console.error(`[zen] failed writing ${this.name}:`, error)
      })
    await this.writing
  }

  /** Synchronous flush for shutdown paths where async work may not complete. */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pending === null) return
    const data = this.pending
    this.pending = null
    try {
      this.io.writeSync(this.name, JSON.stringify(data))
    } catch (error) {
      console.error(`[zen] failed writing ${this.name}:`, error)
    }
  }
}
