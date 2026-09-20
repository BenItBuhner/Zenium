import type { EncryptedEnvelope } from './crypto'
import { isEnvelope } from './crypto'

/**
 * The folder every device writes its file into ("bring your own storage": the folder lives in a
 * cloud drive or a Syncthing share). Each device owns exactly one file, so the drive never has
 * to merge concurrent edits; reading is every other device's file.
 */
export const SYNC_DIR_NAME = 'zenium-sync'
/** The folder's name while the browser was called Zen (up to v0.2.0); the desktop takes it over. */
export const LEGACY_SYNC_DIR_NAME = 'zen-sync'
export const FILE_EXT = '.zensync'
export const README_NAME = 'README.txt'

export const README = `Zenium sync data.

Each file in this folder belongs to one of your devices and is end-to-end encrypted with your
sync passphrase (AES-256-GCM). The folder can live in any synced location – Dropbox, iCloud
Drive, Google Drive, OneDrive, Nextcloud, Syncthing… Nothing here is readable without the
passphrase, and deleting the folder only removes the shared copy, never your local data.
`

/** What one device publishes: its identity in the clear, its records under the shared key. */
export interface DeviceFile {
  deviceId: string
  deviceName: string
  updatedAt: number
  envelope: EncryptedEnvelope
}

/**
 * The bytes of a sync folder as a host sees them: text documents by name inside the
 * `zenium-sync` directory of the folder the user chose. Desktop backs it with node:fs and a
 * watcher, Android with the Storage Access Framework and a poll (`watch` then only reports the
 * app's return to the foreground). Names never contain path separators.
 *
 * A folder the host can no longer reach (an unmounted drive, a revoked Android tree permission)
 * is reported by throwing `SyncFolderLostError`, which the engine turns into a status the chrome
 * can act on rather than a silent stop.
 */
export interface SyncTransport {
  /** Names of the documents in the sync directory (the README included); [] before the first write. */
  list(): Promise<string[]>
  /** A document's text, or null when it does not exist. */
  read(name: string): Promise<string | null>
  /** Create or replace a document atomically: a reader never sees a half-written file. */
  write(name: string, text: string): Promise<void>
  /** Delete a document; a missing one is not an error. */
  remove(name: string): Promise<void>
  /** Delete the whole sync directory (the user disconnects and wipes the shared copy). */
  removeAll(): Promise<void>
  /** Fire `onChange` when another device's file may have landed; returns the unsubscribe. */
  watch?(onChange: () => void): () => void
}

/** The chosen folder is gone or no longer accessible; the user has to choose it again. */
export class SyncFolderLostError extends Error {
  readonly kind = 'folder-lost' as const

  constructor(message = 'The sync folder is no longer accessible') {
    super(message)
    this.name = 'SyncFolderLostError'
  }
}

export function isFolderLost(error: unknown): boolean {
  return (
    error instanceof SyncFolderLostError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { kind?: unknown }).kind === 'folder-lost')
  )
}

/** `<deviceId>.zensync`, the id reduced to characters every file system accepts. */
export function deviceFileName(deviceId: string): string {
  return `${deviceId.replace(/[^a-zA-Z0-9_-]/g, '_')}${FILE_EXT}`
}

export function isDeviceFileName(name: string): boolean {
  return name.endsWith(FILE_EXT)
}

/** Parse a device file's text; null for a partially synced or corrupt file (its owner rewrites it). */
export function parseDeviceFile(text: string): DeviceFile | null {
  let raw: Partial<DeviceFile>
  try {
    raw = JSON.parse(text) as Partial<DeviceFile>
  } catch {
    return null
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    typeof raw.deviceId !== 'string' ||
    typeof raw.updatedAt !== 'number' ||
    !isEnvelope(raw.envelope)
  )
    return null
  return {
    deviceId: raw.deviceId,
    deviceName: typeof raw.deviceName === 'string' ? raw.deviceName : raw.deviceId,
    updatedAt: raw.updatedAt,
    envelope: raw.envelope
  }
}

/** The text a device file is written as (the exact bytes the Electron-only engine wrote). */
export function serializeDeviceFile(file: DeviceFile): string {
  return JSON.stringify(file)
}

/** Every readable device file in the folder. */
export async function readDeviceFiles(transport: SyncTransport): Promise<DeviceFile[]> {
  const files: DeviceFile[] = []
  for (const name of await transport.list()) {
    if (!isDeviceFileName(name)) continue
    const text = await transport.read(name)
    if (text === null) continue
    const file = parseDeviceFile(text)
    if (file) files.push(file)
  }
  return files
}

/** Write the README once, so whoever opens the folder in a file manager knows what it holds. */
export async function ensureReadme(transport: SyncTransport): Promise<void> {
  const names = await transport.list()
  if (names.includes(README_NAME)) return
  await transport.write(README_NAME, README).catch(() => undefined)
}

/**
 * A transport over a map: the tests' shared "folder" (two engines on one instance see each
 * other's files), and a stand-in while a host has none.
 */
export class MemoryTransport implements SyncTransport {
  private readonly listeners = new Set<() => void>()
  /** When set, every operation fails with it (a folder that went away). */
  lost = false

  constructor(readonly files = new Map<string, string>()) {}

  private check(): void {
    if (this.lost) throw new SyncFolderLostError()
  }

  async list(): Promise<string[]> {
    this.check()
    return [...this.files.keys()]
  }

  async read(name: string): Promise<string | null> {
    this.check()
    return this.files.get(name) ?? null
  }

  async write(name: string, text: string): Promise<void> {
    this.check()
    this.files.set(name, text)
    for (const listener of this.listeners) listener()
  }

  async remove(name: string): Promise<void> {
    this.check()
    this.files.delete(name)
  }

  async removeAll(): Promise<void> {
    this.check()
    this.files.clear()
  }

  watch(onChange: () => void): () => void {
    this.listeners.add(onChange)
    return () => this.listeners.delete(onChange)
  }
}
