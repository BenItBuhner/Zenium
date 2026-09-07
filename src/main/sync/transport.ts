import { promises as fs, existsSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { EncryptedEnvelope } from './crypto'
import { isEnvelope } from './crypto'

export const SYNC_DIR_NAME = 'zen-sync'
const FILE_EXT = '.zensync'

export interface DeviceFile {
  deviceId: string
  deviceName: string
  updatedAt: number
  envelope: EncryptedEnvelope
}

const README = `Zen (Chromium) sync data.

Each file in this folder belongs to one of your devices and is end-to-end encrypted with your
sync passphrase (AES-256-GCM). The folder can live in any synced location – Dropbox, iCloud
Drive, Google Drive, OneDrive, Nextcloud, Syncthing… Nothing here is readable without the
passphrase, and deleting the folder only removes the shared copy, never your local data.
`

/**
 * "Bring your own storage" transport: every device writes exactly one file, so cloud-drive sync
 * never has to merge concurrent edits. Reading = every other device's file.
 */
export class FolderTransport {
  private watcher: FSWatcher | null = null
  private watchTimer: NodeJS.Timeout | null = null

  constructor(readonly root: string) {}

  get dir(): string {
    return join(this.root, SYNC_DIR_NAME)
  }

  async ensure(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    const readme = join(this.dir, 'README.txt')
    if (!existsSync(readme)) await fs.writeFile(readme, README, 'utf8').catch(() => undefined)
  }

  async list(): Promise<DeviceFile[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.dir)
    } catch {
      return []
    }
    const files: DeviceFile[] = []
    for (const name of names) {
      if (!name.endsWith(FILE_EXT)) continue
      try {
        const raw = JSON.parse(
          await fs.readFile(join(this.dir, name), 'utf8')
        ) as Partial<DeviceFile>
        if (
          raw &&
          typeof raw.deviceId === 'string' &&
          typeof raw.updatedAt === 'number' &&
          isEnvelope(raw.envelope)
        ) {
          files.push({
            deviceId: raw.deviceId,
            deviceName: typeof raw.deviceName === 'string' ? raw.deviceName : raw.deviceId,
            updatedAt: raw.updatedAt,
            envelope: raw.envelope
          })
        }
      } catch {
        // Partially synced or corrupt file – skip it, the owning device will rewrite it.
      }
    }
    return files
  }

  async write(file: DeviceFile): Promise<void> {
    await this.ensure()
    const target = join(this.dir, `${safeName(file.deviceId)}${FILE_EXT}`)
    const tmp = `${target}.tmp-${process.pid}`
    await fs.writeFile(tmp, JSON.stringify(file), 'utf8')
    await fs.rename(tmp, target)
  }

  async remove(deviceId: string): Promise<void> {
    await fs.rm(join(this.dir, `${safeName(deviceId)}${FILE_EXT}`), { force: true })
  }

  async removeAll(): Promise<void> {
    await fs.rm(this.dir, { recursive: true, force: true })
  }

  /** Fire `onChange` (debounced) whenever another device's file lands in the folder. */
  watch(onChange: () => void): void {
    this.unwatch()
    try {
      this.watcher = watch(this.dir, { persistent: false }, () => {
        if (this.watchTimer) clearTimeout(this.watchTimer)
        this.watchTimer = setTimeout(onChange, 1500)
      })
      this.watcher.on('error', () => this.unwatch())
    } catch {
      this.watcher = null
    }
  }

  unwatch(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.watchTimer) clearTimeout(this.watchTimer)
    this.watchTimer = null
  }
}

function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}
