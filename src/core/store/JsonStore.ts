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
 */
export class JsonStore<T> {
  private pending: T | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()
  private readonly debounceMs: number
  private readonly writeOptions: StoreWriteOptions | undefined
  /** Whether the last `readSync` had to fall back to the backup. */
  readFromBackup = false

  constructor(
    private readonly io: StoreIO,
    private readonly name: string,
    options: number | JsonStoreOptions = {}
  ) {
    const opts = typeof options === 'number' ? { debounceMs: options } : options
    this.debounceMs = opts.debounceMs ?? 400
    this.writeOptions = opts.backup ? { backup: true } : undefined
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
    this.writing = this.writing
      .then(() => this.io.write(this.name, JSON.stringify(data), this.writeOptions))
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
      this.io.writeSync(this.name, JSON.stringify(data), this.writeOptions)
    } catch (error) {
      console.error(`[zen] failed writing ${this.name}:`, error)
    }
  }
}
