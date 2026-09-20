import type { SyncPlatformHost, SyncTransport } from '../core/platform'
import { SyncFolderLostError } from '../core/sync/transport'
import type { Bridge } from './bridge'

/** Kotlin's rejection for a tree whose permission is gone (`SyncFolder.kt`, `LOST_PREFIX`). */
export const FOLDER_LOST_PREFIX = 'folder-lost:'
/** How often the phone re-reads the folder while the app is in front (no watcher on a tree URI). */
export const ANDROID_POLL_MS = 30_000

/**
 * The sync folder on Android: a document tree the user picked through the Storage Access
 * Framework (`ACTION_OPEN_DOCUMENT_TREE`), kept as a persisted URI permission; `SyncFolder.kt`
 * lists, reads, writes and deletes the documents of its `zenium-sync` child. A tree whose
 * permission was revoked (or that was deleted) rejects every call with `folder-lost:` and the
 * transport raises `SyncFolderLostError`, which the engine turns into `SyncStatus.folderLost`.
 */
export class AndroidSyncTransport implements SyncTransport {
  constructor(
    private readonly bridge: Bridge,
    readonly folder: string,
    private readonly foreground: ForegroundSignal
  ) {}

  private async call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    try {
      return await this.bridge.call<T>(method, { folder: this.folder, ...args })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith(FOLDER_LOST_PREFIX))
        throw new SyncFolderLostError(message.slice(FOLDER_LOST_PREFIX.length).trim() || undefined)
      throw error
    }
  }

  async list(): Promise<string[]> {
    const names = await this.call<unknown>('sync.list')
    return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : []
  }

  async read(name: string): Promise<string | null> {
    const text = await this.call<unknown>('sync.read', { name })
    return typeof text === 'string' ? text : null
  }

  write(name: string, text: string): Promise<void> {
    return this.call<void>('sync.write', { name, text })
  }

  remove(name: string): Promise<void> {
    return this.call<void>('sync.remove', { name })
  }

  removeAll(): Promise<void> {
    return this.call<void>('sync.removeAll')
  }

  /** No file watcher on a document tree: the app's return to the foreground is the trigger. */
  watch(onChange: () => void): () => void {
    return this.foreground.subscribe(onChange)
  }
}

/** The activity's resumes, fanned out to whoever wants a look at the folder then. */
export class ForegroundSignal {
  private readonly listeners = new Set<() => void>()
  focused = true

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The activity resumed (`focus` host event with `focused: true`) or paused. */
  setFocused(focused: boolean): void {
    const resumed = focused && !this.focused
    this.focused = focused
    if (resumed) for (const listener of [...this.listeners]) listener()
  }
}

/**
 * The Android pieces of sync: the system folder picker behind `sync.chooseFolder`, the device
 * model as the default device name (Chrome names a phone by its model), the SAF transport, and
 * a foreground-only poll every 30 seconds instead of a watcher (no background service).
 */
export class AndroidSyncHost implements SyncPlatformHost {
  readonly pollMs = ANDROID_POLL_MS
  readonly signal = new ForegroundSignal()

  constructor(
    private readonly bridge: Bridge,
    private readonly deviceModel: string
  ) {}

  async chooseFolder(): Promise<string | null> {
    const uri = await this.bridge.call<unknown>('sync.chooseFolder')
    return typeof uri === 'string' && uri ? uri : null
  }

  async folderName(folder: string): Promise<string> {
    const name = await this.bridge.call<unknown>('sync.folderName', { folder })
    return typeof name === 'string' ? name : ''
  }

  deviceNameDefault(): string {
    return this.deviceModel.trim() || 'Android phone'
  }

  createTransport(folder: string): SyncTransport {
    return new AndroidSyncTransport(this.bridge, folder, this.signal)
  }

  foreground(): boolean {
    return this.signal.focused
  }
}
