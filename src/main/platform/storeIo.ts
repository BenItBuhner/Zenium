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
  constructor(private readonly dir: string) {}

  private pathFor(name: string): string {
    return join(this.dir, name)
  }

  readSync(name: string): string | null {
    const path = this.pathFor(name)
    if (!existsSync(path)) return null
    return readFileSync(path, 'utf8')
  }

  async write(name: string, text: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    const path = this.pathFor(name)
    const tmp = `${path}.tmp`
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, path)
  }

  writeSync(name: string, text: string): void {
    mkdirSync(this.dir, { recursive: true })
    const path = this.pathFor(name)
    const tmp = `${path}.tmp`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, path)
  }
}
