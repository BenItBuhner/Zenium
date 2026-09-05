import {
  promises as fs,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync
} from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Tiny debounced, atomic JSON file store. Writes go to a temp file that is renamed over the
 * target, so a crash mid-write can never corrupt the profile.
 */
export class JsonStore<T> {
  private pending: T | null = null
  private timer: NodeJS.Timeout | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly debounceMs = 400
  ) {}

  static path(dir: string, name: string): string {
    return join(dir, name)
  }

  /** Synchronous read used once at startup. Returns `null` when the file is missing or corrupt. */
  readSync(): T | null {
    try {
      if (!existsSync(this.filePath)) return null
      const raw = readFileSync(this.filePath, 'utf8')
      return JSON.parse(raw) as T
    } catch (error) {
      console.warn(`[zen] could not read ${this.filePath}:`, error)
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
      .then(() => this.writeAtomic(data))
      .catch((error) => {
        console.error(`[zen] failed writing ${this.filePath}:`, error)
      })
    await this.writing
  }

  /** Synchronous flush for `before-quit` where async work may not complete. */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pending === null) return
    const data = this.pending
    this.pending = null
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, JSON.stringify(data), 'utf8')
      renameSync(tmp, this.filePath)
    } catch (error) {
      console.error(`[zen] failed writing ${this.filePath}:`, error)
    }
  }

  private async writeAtomic(data: T): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data), 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}
