import { promises as fs, existsSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { SyncTransport } from '../../core/platform'
import { LEGACY_SYNC_DIR_NAME, SYNC_DIR_NAME, SyncFolderLostError } from '../../core/sync/transport'
import { moveLegacyDirectory } from '../platform/legacyPaths'

export { SYNC_DIR_NAME, LEGACY_SYNC_DIR_NAME }

/**
 * The desktop's sync folder: `<root>/zenium-sync` on the local file system, kept in sync by
 * whatever cloud drive or Syncthing share `root` lives in. Writes go through a temp file and a
 * rename so a peer's drive client never uploads half a file; a watcher on the directory reports
 * other devices' files as they land.
 */
export class FolderTransport implements SyncTransport {
  private watcher: FSWatcher | null = null
  private watchTimer: ReturnType<typeof setTimeout> | null = null

  constructor(readonly root: string) {
    // A folder that still holds a zen-sync directory from before the rename keeps its data: the
    // directory is renamed in place (cloud drives sync that like any other rename).
    try {
      moveLegacyDirectory(join(root, LEGACY_SYNC_DIR_NAME), this.dir, (message) =>
        console.warn('[zen] sync:', message)
      )
    } catch (error) {
      console.warn('[zen] sync: could not take over the zen-sync folder:', error)
    }
  }

  get dir(): string {
    return join(this.root, SYNC_DIR_NAME)
  }

  private path(name: string): string {
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..')
      throw new Error(`invalid sync document name: ${name}`)
    return join(this.dir, name)
  }

  /** The chosen folder itself is gone (an unmounted drive, a deleted directory). */
  private checkRoot(): void {
    if (!existsSync(this.root)) throw new SyncFolderLostError()
  }

  async list(): Promise<string[]> {
    this.checkRoot()
    try {
      return await fs.readdir(this.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async read(name: string): Promise<string | null> {
    this.checkRoot()
    try {
      return await fs.readFile(this.path(name), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async write(name: string, text: string): Promise<void> {
    this.checkRoot()
    await fs.mkdir(this.dir, { recursive: true })
    const target = this.path(name)
    const tmp = `${target}.tmp-${process.pid}`
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, target)
  }

  async remove(name: string): Promise<void> {
    this.checkRoot()
    await fs.rm(this.path(name), { force: true })
  }

  async removeAll(): Promise<void> {
    this.checkRoot()
    await fs.rm(this.dir, { recursive: true, force: true })
  }

  /** Fire `onChange` (debounced) whenever another device's file lands in the folder. */
  watch(onChange: () => void): () => void {
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
    return () => this.unwatch()
  }

  unwatch(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.watchTimer) clearTimeout(this.watchTimer)
    this.watchTimer = null
  }
}
