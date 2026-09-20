import type { SyncScope, SyncStatus } from '../../shared/types'
import { newId } from '../../shared/ids'
import { JsonStore } from '../store/JsonStore'
import type { Browser } from '../browser'
import type { ZenWindow } from '../window'
import type { SyncHost, SyncPlatformHost, SyncTransport } from '../platform'
import { fromBase64, toBase64 } from '../credentials/crypto'
import { applyRemote } from './apply'
import { decryptJson, deriveKey, encryptJson, newSalt } from './crypto'
import {
  collectLocal,
  defaultScope,
  diffLocal,
  frozenRecords,
  hashData,
  inScope,
  metaFromRemote,
  newestByRecord,
  winningRemote,
  type LocalSources,
  type MetaMap,
  type SyncRecord
} from './records'
import {
  deviceFileName,
  ensureReadme,
  isFolderLost,
  readDeviceFiles,
  serializeDeviceFile,
  type DeviceFile
} from './transport'

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
export const DEFAULT_POLL_MS = 45_000
const FIRST_SYNC_DELAY_MS = 1_500

export const FOLDER_LOST_MESSAGE =
  'The sync folder is no longer accessible. Choose it again to keep syncing.'
export const WRONG_PASSPHRASE_MESSAGE = 'That passphrase does not match the data in this folder.'
export const OTHER_PASSPHRASE_FOLDER_MESSAGE =
  'That folder holds sync data set up with a different passphrase. Turn sync off and set it up again to use it.'

type Timer = ReturnType<typeof setTimeout>

/**
 * Zen 1.22 "Sync your Spaces across devices" for the Chromium port. Mozilla accounts are not
 * available to a non-Firefox browser, so devices exchange end-to-end encrypted record sets
 * through a folder they all see (cloud drive / Syncthing). Merge is last-writer-wins per record,
 * like Firefox Sync.
 *
 * The engine is platform-neutral: the folder's bytes come and go through the host's
 * `SyncTransport` (node:fs on desktop, the Storage Access Framework on Android), the folder
 * picker and the device's default name are the host's too (`SyncPlatformHost`), and the crypto
 * runs on Web Crypto with scrypt-js (or the host's own scrypt). Device files written by the
 * Electron-only engine keep decrypting: same envelope, same key derivation, same record hashes
 * (`__tests__/compat.test.ts`).
 */
export class SyncEngine implements SyncHost {
  private data: Persisted
  private readonly store: JsonStore<Persisted>
  private key: Uint8Array | null = null
  private transport: SyncTransport | null = null
  private unwatch: (() => void) | null = null
  private pushTimer: Timer | null = null
  private pollTimer: Timer | null = null
  private firstSyncTimer: Timer | null = null
  private running: Promise<void> | null = null
  private applying = false
  private syncing = false
  private lastError: string | null = null
  private folderLost = false
  private folderName: string | null = null

  constructor(
    private readonly browser: Browser,
    private readonly host: SyncPlatformHost
  ) {
    this.store = new JsonStore<Persisted>(browser.platform.io, 'sync.json', 300)
    const saved = this.store.readSync()
    this.data = {
      version: 1,
      enabled: false,
      folder: null,
      key: null,
      salt: null,
      deviceId: newId('device'),
      deviceName: host.deviceNameDefault(),
      scope: defaultScope(),
      meta: {},
      lastSyncAt: null,
      devices: [],
      pendingMerge: false,
      ...(saved?.version === 1 ? saved : {})
    }
    // A scope key this build added (`passwords`) starts at its default on a device set up before.
    this.data.scope = { ...defaultScope(), ...this.data.scope }
    if (this.data.key) this.key = fromBase64(this.data.key)
  }

  start(): void {
    this.browser.state.subscribe(() => this.onLocalChange())
    if (this.data.enabled && this.data.folder && this.key) this.connect(this.data.folder)
  }

  status(): SyncStatus {
    return {
      enabled: this.data.enabled,
      folder: this.data.folder,
      folderName: this.data.folder === null ? null : (this.folderName ?? this.data.folder),
      folderLost: this.folderLost,
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

  chooseFolder(win: ZenWindow): Promise<string | null> {
    return this.host.chooseFolder(win)
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
    // Deriving the key takes a moment (seconds on a phone): the chrome shows the form busy.
    this.setBusy(true)
    try {
      const transport = this.host.createTransport(opts.folder)
      let existing: DeviceFile[]
      try {
        await ensureReadme(transport)
        existing = (await readDeviceFiles(transport)).filter(
          (f) => f.deviceId !== this.data.deviceId
        )
      } catch (error) {
        this.browser.toast(this.describe(error), 'error', win)
        return
      }
      const salt = existing[0]?.envelope.salt ?? newSalt()
      const key = await deriveKey(opts.passphrase, salt, this.host.scrypt)
      if (existing.length) {
        try {
          await decryptJson(key, existing[0].envelope)
        } catch {
          this.browser.toast(WRONG_PASSPHRASE_MESSAGE, 'error', win)
          return
        }
      }
      this.disconnect(false)
      this.key = key
      this.data = {
        ...this.data,
        enabled: true,
        folder: opts.folder,
        key: toBase64(key),
        salt,
        deviceName: opts.deviceName.trim() || this.host.deviceNameDefault(),
        scope: { ...defaultScope(), ...opts.scope },
        meta: {},
        pendingMerge: existing.length > 0
      }
      this.persist()
      this.connect(opts.folder)
    } finally {
      this.setBusy(false)
    }
    if (!this.data.pendingMerge) await this.syncNow()
    this.browser.state.commitVolatile()
  }

  /**
   * Zen prompts how to combine local Spaces with the cloud copy the first time. Passwords are
   * outside the question: Chrome's password sync always merges by entry, so "keep this device's
   * data" never deletes another device's logins, and types this device does not sync are left
   * to the devices that do.
   */
  async confirmMerge(merge: boolean): Promise<void> {
    if (!this.data.pendingMerge) return
    this.data.pendingMerge = false
    const remote = await this.readRemote()
    const sources = this.sources()
    const local = collectLocal(sources, this.data.scope)
    const meta: MetaMap = {}
    if (merge) {
      // Merge: records that exist on both sides (settings, shortcuts, ordering, shared ids)
      // adopt the cloud copy; everything only this device has is added to it.
      for (const [id, { type, data }] of local) {
        if (remote.has(id)) meta[id] = { type, hash: hashData(data), modified: -1, deleted: false }
      }
    } else {
      // Keep this device's data: stamp every local record as freshly edited (so it beats the
      // cloud copy) and tombstone records that only exist remotely.
      const now = Date.now()
      for (const [id, { type }] of local) meta[id] = { type, hash: '', modified: now, deleted: false }
      for (const [id, r] of remote) {
        if (local.has(id) || r.deleted) continue
        if (r.type === 'credential' || !inScope(r, this.data.scope)) continue
        meta[id] = { type: r.type, hash: '', modified: now, deleted: true }
      }
    }
    this.data.meta = meta
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
    this.data.deviceName = name.trim() || this.host.deviceNameDefault()
    this.persist()
    this.browser.state.commitVolatile()
    this.schedulePush()
  }

  /**
   * Point the device at a folder again: the one it had is gone (an unmounted drive, a revoked
   * Android tree), or the user moves the shared copy. The key and this device's record history
   * stay, so nothing is re-merged; a folder whose files the key does not open belongs to another
   * passphrase and is refused.
   */
  async setFolder(folder: string, win: ZenWindow): Promise<void> {
    if (!this.data.enabled || !this.key) {
      this.browser.toast('Set up sync first.', 'error', win)
      return
    }
    this.setBusy(true)
    try {
      const transport = this.host.createTransport(folder)
      let others: DeviceFile[]
      try {
        await ensureReadme(transport)
        others = (await readDeviceFiles(transport)).filter((f) => f.deviceId !== this.data.deviceId)
      } catch (error) {
        this.browser.toast(this.describe(error), 'error', win)
        return
      }
      if (others.length) {
        try {
          await decryptJson(this.key, others[0].envelope)
        } catch {
          this.browser.toast(OTHER_PASSPHRASE_FOLDER_MESSAGE, 'error', win)
          return
        }
      }
      this.stopTransport()
      this.data.folder = folder
      this.folderLost = false
      this.lastError = null
      this.persist()
      this.connect(folder)
    } finally {
      this.setBusy(false)
    }
    await this.syncNow()
  }

  /** Turn sync off; optionally delete this device's file from the folder. */
  disconnect(wipeRemote: boolean): void {
    const transport = this.transport
    if (wipeRemote && transport)
      void transport.remove(deviceFileName(this.data.deviceId)).catch(() => undefined)
    this.stopTransport()
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
    this.folderLost = false
    this.folderName = null
    this.persist()
    this.browser.state.commitVolatile()
  }

  // ---------------------------------------------------------------------------
  // Syncing
  // ---------------------------------------------------------------------------

  private connect(folder: string): void {
    this.stopTransport()
    const transport = this.host.createTransport(folder)
    this.transport = transport
    this.unwatch = transport.watch?.(() => void this.syncNow()) ?? null
    const pollMs = this.host.pollMs ?? DEFAULT_POLL_MS
    if (pollMs > 0) {
      this.pollTimer = setInterval(() => {
        if (this.host.foreground?.() === false) return
        void this.syncNow()
      }, pollMs)
    }
    this.firstSyncTimer = setTimeout(() => void this.syncNow(), FIRST_SYNC_DELAY_MS)
    this.folderName = null
    if (this.host.folderName) {
      void this.host
        .folderName(folder)
        .then((name) => {
          if (this.data.folder !== folder) return
          this.folderName = name || null
          this.browser.state.commitVolatile()
        })
        .catch(() => undefined)
    }
  }

  private stopTransport(): void {
    this.unwatch?.()
    this.unwatch = null
    this.transport = null
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = null
    if (this.firstSyncTimer) clearTimeout(this.firstSyncTimer)
    this.firstSyncTimer = null
  }

  /**
   * Stamp local edits the moment they are committed (not when the next sync happens to run), so
   * last-writer-wins reflects the real order of edits across devices.
   */
  private onLocalChange(): void {
    if (!this.data.enabled || this.applying || this.data.pendingMerge) return
    const sources = this.sources()
    const diff = diffLocal(
      this.data.meta,
      collectLocal(sources, this.data.scope),
      Date.now(),
      undefined,
      frozenRecords(sources, this.data.scope, this.data.meta)
    )
    if (diff.changed) {
      this.data.meta = diff.meta
      this.persist()
    }
    this.schedulePush()
  }

  private schedulePush(): void {
    if (!this.data.enabled || this.data.pendingMerge) return
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => void this.syncNow(), PUSH_DEBOUNCE_MS)
  }

  private sources(): LocalSources {
    const state = this.browser.state
    return {
      model: state.model,
      settings: state.settings,
      shortcutOverrides: state.shortcutOverrides,
      bookmarks: state.bookmarks,
      boosts: this.browser.boosts.all(),
      credentials: this.browser.passwords.syncSources()
    }
  }

  /** Every other device's newest records; a folder that cannot be read throws. */
  private async readRemote(): Promise<Map<string, SyncRecord>> {
    if (!this.transport || !this.key) return new Map()
    const files = (await readDeviceFiles(this.transport)).filter(
      (f) => f.deviceId !== this.data.deviceId
    )
    const lists: SyncRecord[][] = []
    const devices = new Map(this.data.devices.map((d) => [d.id, d]))
    for (const file of files) {
      try {
        const payload = await decryptJson<Payload>(this.key, file.envelope)
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
      const scope = this.data.scope
      const sources = this.sources()
      // Local snapshot first, so records we changed since the last sync carry a fresh timestamp.
      let local = diffLocal(
        this.data.meta,
        collectLocal(sources, scope),
        now,
        undefined,
        frozenRecords(sources, scope, this.data.meta)
      )
      // Types turned off are not received either (Chrome's toggles), and credential records
      // wait for the vault to be open: left out of the metadata, they win again next round.
      const vaultOpen = Boolean(sources.credentials)
      const winners = winningRemote(local.meta, remote).filter(
        (r) => inScope(r, scope) && (r.type !== 'credential' || vaultOpen)
      )
      if (winners.length) {
        this.applying = true
        try {
          applyRemote(this.browser, winners)
        } finally {
          this.applying = false
        }
        // Re-snapshot after applying; remote winners keep their own timestamps.
        const merged: MetaMap = { ...local.meta, ...metaFromRemote(winners) }
        const after = this.sources()
        local = diffLocal(
          merged,
          collectLocal(after, scope),
          now,
          undefined,
          frozenRecords(after, scope, merged)
        )
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
        envelope: await encryptJson(this.key, this.data.salt ?? newSalt(), {
          v: 1,
          records: local.records
        } satisfies Payload)
      }
      await this.transport.write(deviceFileName(this.data.deviceId), serializeDeviceFile(file))
      this.data.lastSyncAt = now
      this.folderLost = false
      this.persist()
    } catch (error) {
      if (isFolderLost(error)) {
        this.folderLost = true
        this.lastError = FOLDER_LOST_MESSAGE
      } else {
        this.lastError = (error as Error).message || 'Sync failed'
      }
    } finally {
      this.syncing = false
      this.browser.state.commitVolatile()
    }
  }

  private setBusy(busy: boolean): void {
    this.syncing = busy
    this.browser.state.commitVolatile()
  }

  private describe(error: unknown): string {
    if (isFolderLost(error)) return 'That folder cannot be opened. Choose another one.'
    const message = (error as Error)?.message
    return message ? `The folder could not be read: ${message}` : 'The folder could not be read.'
  }

  private persist(): void {
    this.store.write(this.data)
  }

  flushSync(): void {
    this.store.flushSync()
  }
}
