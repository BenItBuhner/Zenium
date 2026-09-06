import { dialog } from 'electron'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { SyncScope, SyncStatus } from '../../shared/types'
import { newId } from '../../shared/ids'
import { JsonStore } from '../store/JsonStore'
import type { Browser } from '../browser/browser'
import type { ZenWindow } from '../browser/window'
import { applyRemote } from './apply'
import { decryptJson, deriveKey, encryptJson, newSalt } from './crypto'
import {
  collectLocal,
  defaultScope,
  diffLocal,
  metaFromRemote,
  newestByRecord,
  winningRemote,
  type MetaMap,
  type SyncRecord
} from './records'
import { FolderTransport, type DeviceFile } from './transport'

interface Persisted {
  version: 1
  enabled: boolean
  folder: string | null
  /** Base64 scrypt key (derived once from the passphrase). */
  key: string | null
  salt: string | null
  deviceId: string
  deviceName: string
  scope: SyncScope
  meta: MetaMap
  lastSyncAt: number | null
  devices: Array<{ id: string; name: string; lastSeen: number }>
  /** First sync still needs the user's merge decision. */
  pendingMerge: boolean
}

interface Payload {
  v: 1
  records: SyncRecord[]
}

const PUSH_DEBOUNCE_MS = 4_000
const POLL_MS = 45_000

/**
 * Zen 1.22 "Sync your Spaces across devices" for the Chromium port. Mozilla accounts are not
 * available to a non-Firefox browser, so devices exchange end-to-end encrypted record sets
 * through a folder they all see (cloud drive / Syncthing). Merge is last-writer-wins per record,
 * like Firefox Sync.
 */
export class SyncEngine {
  private data: Persisted
  private readonly store: JsonStore<Persisted>
  private key: Buffer | null = null
  private transport: FolderTransport | null = null
  private pushTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private applying = false
  private syncing = false
  private lastError: string | null = null

  constructor(
    private readonly browser: Browser,
    userDataDir: string
  ) {
    this.store = new JsonStore<Persisted>(join(userDataDir, 'zen', 'sync.json'), 300)
    const saved = this.store.readSync()
    this.data = {
      version: 1,
      enabled: false,
      folder: null,
      key: null,
      salt: null,
      deviceId: newId('device'),
      deviceName: defaultDeviceName(),
      scope: defaultScope(),
      meta: {},
      lastSyncAt: null,
      devices: [],
      pendingMerge: false,
      ...(saved?.version === 1 ? saved : {})
    }
    this.data.scope = { ...defaultScope(), ...this.data.scope }
    if (this.data.key) this.key = Buffer.from(this.data.key, 'base64')
  }

  start(): void {
    this.browser.state.subscribe(() => this.onLocalChange())
    if (this.data.enabled && this.data.folder && this.key) this.connect(this.data.folder)
  }

  status(): SyncStatus {
    return {
      enabled: this.data.enabled,
      folder: this.data.folder,
      deviceId: this.data.deviceId,
      deviceName: this.data.deviceName,
      scope: this.data.scope,
      lastSyncAt: this.data.lastSyncAt,
      lastError: this.lastError,
      syncing: this.syncing,
      devices: this.data.devices,
      pendingMerge: this.data.pendingMerge
    }
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  async chooseFolder(win: ZenWindow): Promise<string | null> {
    const result = await dialog.showOpenDialog(win.win, {
      title: 'Choose a folder that is synced between your devices',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder'
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }

  /**
   * Enable sync. If other devices already wrote to the folder the passphrase must decrypt their
   * data, and the user is asked how to merge before anything is applied.
   */
  async setup(
    opts: { folder: string; passphrase: string; deviceName: string; scope: SyncScope },
    win: ZenWindow
  ): Promise<void> {
    if (!opts.passphrase || opts.passphrase.length < 8) {
      this.browser.toast('Choose a passphrase of at least 8 characters.', 'error', win)
      return
    }
    const transport = new FolderTransport(opts.folder)
    await transport.ensure()
    const existing = (await transport.list()).filter((f) => f.deviceId !== this.data.deviceId)
    const salt = existing[0]?.envelope.salt ?? newSalt()
    const key = deriveKey(opts.passphrase, salt)
    if (existing.length) {
      try {
        decryptJson(key, existing[0].envelope)
      } catch {
        this.browser.toast('That passphrase does not match the data in this folder.', 'error', win)
        return
      }
    }
    this.disconnect(false)
    this.key = key
    this.data = {
      ...this.data,
      enabled: true,
      folder: opts.folder,
      key: key.toString('base64'),
      salt,
      deviceName: opts.deviceName.trim() || defaultDeviceName(),
      scope: { ...defaultScope(), ...opts.scope },
      meta: {},
      pendingMerge: existing.length > 0
    }
    this.persist()
    this.connect(opts.folder)
    if (!this.data.pendingMerge) await this.syncNow()
    this.browser.state.commitVolatile()
  }

  /** Zen prompts how to combine local Spaces with the cloud copy the first time. */
  async confirmMerge(merge: boolean): Promise<void> {
    if (!this.data.pendingMerge) return
    this.data.pendingMerge = false
    if (!merge) {
      // Keep this device's data: make everything local "newer" and tombstone remote-only records.
      const remote = await this.readRemote()
      const local = collectLocal(this.sources(), this.data.scope)
      const now = Date.now()
      const meta: MetaMap = {}
      for (const [id, r] of remote) {
        if (!local.has(id)) meta[id] = { type: r.type, hash: '', modified: now, deleted: true }
      }
      this.data.meta = meta
    }
    this.persist()
    await this.syncNow()
  }

  setScope(patch: Partial<SyncScope>): void {
    this.data.scope = { ...this.data.scope, ...patch }
    this.persist()
    this.browser.state.commitVolatile()
    this.schedulePush()
  }

  setDeviceName(name: string): void {
    this.data.deviceName = name.trim() || defaultDeviceName()
    this.persist()
    this.browser.state.commitVolatile()
    this.schedulePush()
  }

  /** Turn sync off; optionally delete this device's file from the folder. */
  disconnect(wipeRemote: boolean): void {
    const transport = this.transport
    if (wipeRemote && transport) void transport.remove(this.data.deviceId).catch(() => undefined)
    this.transport?.unwatch()
    this.transport = null
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = null
    this.key = null
    this.data = {
      ...this.data,
      enabled: false,
      folder: null,
      key: null,
      meta: {},
      pendingMerge: false,
      devices: []
    }
    this.lastError = null
    this.persist()
    this.browser.state.commitVolatile()
  }

  // ---------------------------------------------------------------------------
  // Syncing
  // ---------------------------------------------------------------------------

  private connect(folder: string): void {
    this.transport = new FolderTransport(folder)
    this.transport.watch(() => void this.syncNow())
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = setInterval(() => void this.syncNow(), POLL_MS)
    setTimeout(() => void this.syncNow(), 1_500)
  }

  private onLocalChange(): void {
    if (!this.data.enabled || this.applying) return
    this.schedulePush()
  }

  private schedulePush(): void {
    if (!this.data.enabled || this.data.pendingMerge) return
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => void this.syncNow(), PUSH_DEBOUNCE_MS)
  }

  private sources(): Parameters<typeof collectLocal>[0] {
    const state = this.browser.state
    return {
      model: state.model,
      settings: state.settings,
      shortcutOverrides: state.shortcutOverrides,
      bookmarks: state.bookmarks,
      boosts: this.browser.boosts.all()
    }
  }

  private async readRemote(): Promise<Map<string, SyncRecord>> {
    if (!this.transport || !this.key) return new Map()
    const files = (await this.transport.list()).filter((f) => f.deviceId !== this.data.deviceId)
    const lists: SyncRecord[][] = []
    const devices = new Map(this.data.devices.map((d) => [d.id, d]))
    for (const file of files) {
      try {
        const payload = decryptJson<Payload>(this.key, file.envelope)
        if (payload?.v === 1 && Array.isArray(payload.records)) lists.push(payload.records)
        devices.set(file.deviceId, {
          id: file.deviceId,
          name: file.deviceName,
          lastSeen: file.updatedAt
        })
      } catch {
        this.lastError = `Could not decrypt data from "${file.deviceName}" (different passphrase?)`
      }
    }
    this.data.devices = [...devices.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 20)
    return newestByRecord(lists)
  }

  /** One full round: pull + merge remote changes, then publish our record set. */
  syncNow(): Promise<void> {
    if (this.running) return this.running
    this.running = this.run().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async run(): Promise<void> {
    if (!this.data.enabled || !this.transport || !this.key || this.data.pendingMerge) return
    if (this.pushTimer) {
      clearTimeout(this.pushTimer)
      this.pushTimer = null
    }
    this.syncing = true
    this.lastError = null
    this.browser.state.commitVolatile()
    try {
      const remote = await this.readRemote()
      const now = Date.now()
      // Local snapshot first, so records we changed since the last sync carry a fresh timestamp.
      let local = diffLocal(this.data.meta, collectLocal(this.sources(), this.data.scope), now)
      const winners = winningRemote(local.meta, remote)
      if (winners.length) {
        this.applying = true
        try {
          applyRemote(this.browser, winners)
        } finally {
          this.applying = false
        }
        // Re-snapshot after applying; remote winners keep their own timestamps.
        const merged: MetaMap = { ...local.meta, ...metaFromRemote(winners) }
        local = diffLocal(merged, collectLocal(this.sources(), this.data.scope), now)
        for (const w of winners) {
          const entry = local.meta[w.id]
          const fromRemote = metaFromRemote([w])[w.id]
          if (entry && fromRemote && entry.hash === fromRemote.hash) local.meta[w.id] = fromRemote
          else if (!entry && w.deleted) local.meta[w.id] = fromRemote
        }
      }
      this.data.meta = local.meta
      const file: DeviceFile = {
        deviceId: this.data.deviceId,
        deviceName: this.data.deviceName,
        updatedAt: now,
        envelope: encryptJson(this.key, this.data.salt ?? newSalt(), {
          v: 1,
          records: local.records
        } satisfies Payload)
      }
      await this.transport.write(file)
      this.data.lastSyncAt = now
      this.persist()
    } catch (error) {
      this.lastError = (error as Error).message || 'Sync failed'
    } finally {
      this.syncing = false
      this.browser.state.commitVolatile()
    }
  }

  private persist(): void {
    this.store.write(this.data)
  }

  flushSync(): void {
    this.store.flushSync()
  }
}

function defaultDeviceName(): string {
  const host = hostname().replace(/\.local$/, '')
  const os =
    process.platform === 'darwin' ? 'Mac' : process.platform === 'win32' ? 'Windows PC' : 'Linux'
  return host ? `${host} (${os})` : os
}
