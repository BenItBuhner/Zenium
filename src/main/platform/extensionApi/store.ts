import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StoreIO } from '../../../core/platform'
import { JsonStore } from '../../../core/store/JsonStore'
import type { Alarm } from '../../../core/extensions/api/alarms'
import type { PermissionSet } from '../../../core/extensions/api/permissions'
import type { ScopedValues } from '../../../core/extensions/api/privacy'
import type { StorageItems } from '../../../core/extensions/api/storage'
import { FileStoreIO } from '../storeIo'

interface PersistedApi {
  version: 1
  /** Version seen at the last load, per extension (drives `runtime.onInstalled`'s reason). */
  installed: Record<string, { version: string }>
  alarms: Record<string, Alarm[]>
  grants: Record<string, PermissionSet>
  uninstallUrls: Record<string, string>
  /** Events an extension's worker listened to, so it can be woken for them after a restart. */
  workerEvents: Record<string, string[]>
  /** `chrome.privacy` values per extension, by `category.setting`, then scope. */
  privacy?: Record<string, Record<string, ScopedValues>>
}

function emptyPersisted(): PersistedApi {
  return {
    version: 1,
    installed: {},
    alarms: {},
    grants: {},
    uninstallUrls: {},
    workerEvents: {},
    privacy: {}
  }
}

/**
 * Everything the browser layer remembers about extensions across restarts: one document for the
 * small per-extension records, one document per extension for `storage.sync` (shared by every
 * container partition the extension is loaded into), and read-only `storage.managed` policy
 * files dropped into `<userData>/extensions/managed/<id>.json`.
 */
export class ApiStore {
  private readonly main: JsonStore<PersistedApi>
  private readonly data: PersistedApi
  private readonly syncIo: StoreIO
  private readonly syncStores = new Map<
    string,
    { store: JsonStore<StorageItems>; items: StorageItems }
  >()
  private readonly managedDir: string

  constructor(io: StoreIO, userDataDir: string) {
    this.main = new JsonStore<PersistedApi>(io, 'extension-api.json', 300)
    const loaded = this.main.readSync()
    this.data =
      loaded && loaded.version === 1 ? { ...emptyPersisted(), ...loaded } : emptyPersisted()
    this.syncIo = new FileStoreIO(join(userDataDir, 'zen', 'extension-sync'))
    this.managedDir = join(userDataDir, 'extensions', 'managed')
  }

  // --- small records -----------------------------------------------------------

  installedVersion(extensionId: string): string | undefined {
    return this.data.installed[extensionId]?.version
  }

  setInstalledVersion(extensionId: string, version: string): void {
    this.data.installed[extensionId] = { version }
    this.save()
  }

  alarms(extensionId: string): Alarm[] {
    return this.data.alarms[extensionId] ?? []
  }

  setAlarms(extensionId: string, alarms: Alarm[]): void {
    if (alarms.length === 0) delete this.data.alarms[extensionId]
    else this.data.alarms[extensionId] = alarms
    this.save()
  }

  grants(extensionId: string): PermissionSet | undefined {
    return this.data.grants[extensionId]
  }

  setGrants(extensionId: string, grants: PermissionSet): void {
    this.data.grants[extensionId] = grants
    this.save()
  }

  uninstallUrl(extensionId: string): string | undefined {
    return this.data.uninstallUrls[extensionId]
  }

  setUninstallUrl(extensionId: string, url: string): void {
    if (url) this.data.uninstallUrls[extensionId] = url
    else delete this.data.uninstallUrls[extensionId]
    this.save()
  }

  workerEvents(extensionId: string): string[] {
    return this.data.workerEvents[extensionId] ?? []
  }

  setWorkerEvents(extensionId: string, events: string[]): void {
    if (events.length === 0) delete this.data.workerEvents[extensionId]
    else this.data.workerEvents[extensionId] = events
    this.save()
  }

  privacyValues(extensionId: string): Record<string, ScopedValues> {
    return this.data.privacy?.[extensionId] ?? {}
  }

  setPrivacyValues(extensionId: string, values: Record<string, ScopedValues>): void {
    const privacy = this.data.privacy ?? (this.data.privacy = {})
    if (Object.keys(values).length === 0) delete privacy[extensionId]
    else privacy[extensionId] = values
    this.save()
  }

  /** The extension is gone for good: drop everything about it. */
  forget(extensionId: string): void {
    delete this.data.installed[extensionId]
    delete this.data.alarms[extensionId]
    delete this.data.grants[extensionId]
    delete this.data.uninstallUrls[extensionId]
    delete this.data.workerEvents[extensionId]
    delete this.data.privacy?.[extensionId]
    this.save()
    this.syncStores.get(extensionId)?.store.write({})
  }

  private save(): void {
    this.main.write(this.data)
  }

  // --- storage.sync ------------------------------------------------------------

  syncItems(extensionId: string): StorageItems {
    return this.syncEntry(extensionId).items
  }

  setSyncItems(extensionId: string, items: StorageItems): void {
    const entry = this.syncEntry(extensionId)
    entry.items = items
    entry.store.write(items)
  }

  private syncEntry(extensionId: string): { store: JsonStore<StorageItems>; items: StorageItems } {
    let entry = this.syncStores.get(extensionId)
    if (!entry) {
      const store = new JsonStore<StorageItems>(this.syncIo, `${extensionId}.json`, 300)
      const items = store.readSync()
      entry = { store, items: items && typeof items === 'object' ? items : {} }
      this.syncStores.set(extensionId, entry)
    }
    return entry
  }

  // --- storage.managed ---------------------------------------------------------

  managedItems(extensionId: string): StorageItems {
    const file = join(this.managedDir, `${extensionId}.json`)
    if (!existsSync(file)) return {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as StorageItems)
        : {}
    } catch {
      return {}
    }
  }

  get managedDirectory(): string {
    return this.managedDir
  }

  flushSync(): void {
    this.main.flushSync()
    for (const entry of this.syncStores.values()) entry.store.flushSync()
  }
}
