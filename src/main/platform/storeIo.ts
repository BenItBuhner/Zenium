import {
  promises as fs,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { StoreIO, StoreWriteOptions } from '../../core/platform'

/**
 * JSON documents under `<userData>/zen/` (document names may carry one folder, e.g.
 * `blocking/index.json`). Writes go to a temp file that is renamed over the target, so a crash
 * mid-write can never corrupt the profile. With `backup`, the document that was there is renamed
 * to `<name>.bak` first – two renames, no copying – so the previous version survives a write that
 * the document itself does not (a crash between the two renames leaves only the backup, which
 * the core reads instead).
 */
export class FileStoreIO implements StoreIO {
  private tmpSeq = 0

  constructor(private readonly dir: string) {}

  private pathFor(name: string): string {
    return join(this.dir, name)
  }

  exists(name: string): boolean {
    return existsSync(this.pathFor(name))
  }

  async remove(name: string): Promise<void> {
    await fs.rm(this.pathFor(name), { force: true })
  }

  /** Two overlapping writes of the same document must not share a temp file (rename would fail). */
  private tmpFor(path: string): string {
    return `${path}.${process.pid}.${++this.tmpSeq}.tmp`
  }

  readSync(name: string): string | null {
    const path = this.pathFor(name)
    if (!existsSync(path)) return null
    return readFileSync(path, 'utf8')
  }

  async write(name: string, text: string, options?: StoreWriteOptions): Promise<void> {
    const path = this.pathFor(name)
    await fs.mkdir(dirname(path), { recursive: true })
    const tmp = this.tmpFor(path)
    await fs.writeFile(tmp, text, 'utf8')
    if (options?.backup) await fs.rename(path, `${path}.bak`).catch(() => undefined)
    await fs.rename(tmp, path)
  }

  writeSync(name: string, text: string, options?: StoreWriteOptions): void {
    const path = this.pathFor(name)
    mkdirSync(dirname(path), { recursive: true })
    const tmp = this.tmpFor(path)
    writeFileSync(tmp, text, 'utf8')
    if (options?.backup) {
      try {
        renameSync(path, `${path}.bak`)
      } catch {
        // Nothing there yet to keep.
      }
    }
    renameSync(tmp, path)
  }
}
