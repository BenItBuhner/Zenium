import {
  promises as fs,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { StoreIO } from '../../core/platform'

/**
 * JSON documents under `<userData>/zen/`. Writes go to a temp file that is renamed over the
 * target, so a crash mid-write can never corrupt the profile.
 */
export class FileStoreIO implements StoreIO {
  private tmpSeq = 0

  constructor(private readonly dir: string) {}

  private pathFor(name: string): string {
    return join(this.dir, name)
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

  async write(name: string, text: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    const path = this.pathFor(name)
    const tmp = this.tmpFor(path)
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, path)
  }

  writeSync(name: string, text: string): void {
    mkdirSync(this.dir, { recursive: true })
    const path = this.pathFor(name)
    const tmp = this.tmpFor(path)
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, path)
  }
}
