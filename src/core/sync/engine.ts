import type { SyncDeviceTabs, SyncScope, SyncStatus } from '../../shared/types'
import { newId } from '../../shared/ids'
import { JsonStore } from '../store/JsonStore'
import type { Browser } from '../browser'
import type { HistoryVisitsEvent } from '../history'
import { RETENTION_MS } from '../history'
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
import {
  historyPageName,
  inboxName,
  openTabsName,
  ownsName,
  parseHistoryPageName,
  parseInboxName,
  parseOpenTabsName,
  readDocument,
  serializeDocument,
  type SyncDocument,
  type SyncDocumentKind
} from './documents'
import {
  HISTORY_PAGES_PER_ROUND,
  advanceCursor,
  appendOpen,
  applyEntries,
  entriesFromEvent,
  entriesFromVisits,
  expiredPages,
  initialHistoryState,
  pagesToRead,
  planWrites,
  readHistoryPage,
  readHistoryState,
  refreshTitles,
  rememberDeletion,
  seedFloor,
  takeWrites,
  type HistorySyncState,
  type StreamCursor
} from './history'
import { collectOpenTabs, openTabsHash, readOpenTabs, sortDeviceTabs } from './openTabs'
import {
  SENDS_REMEMBERED,
  SEND_TTL_MS,
  isSendableUrl,
  readSendTab,
  sendTabArrivedText,
  type SendTabDocument
} from './sendTab'

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
  /** The history stream: this device's pages and its place in the others' (`history.ts`). */
  history: HistorySyncState
  /** Fingerprint of the open-tabs document in the folder; null while there is none. */
  openTabsHash: string | null
  /** Ids of the sent tabs this device opened, newest last (`SENDS_REMEMBERED` at most). */
  consumedSends: string[]
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
export const SEND_TAB_UNKNOWN_DEVICE_MESSAGE = 'That device is no longer in your sync folder.'
export const SEND_TAB_NOT_A_PAGE_MESSAGE = 'Only web pages can be sent to your devices.'

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
 *
 * Beside its record set (the `.zensync` device file) a device owns documents (`.zenpage`,
 * `documents.ts`): the pages of its history stream (`history.ts`, ID-13 / HB-48), its open tabs
 * for the others' "Tabs from other devices" (`openTabs.ts`, ID-28), and an inbox of tabs the
 * others sent it (`sendTab.ts`, ID-27). One round pulls and merges the records, publishes the
 * device file, then moves the three: history written and read up to each stream's cursor, the
 * tab list rewritten when it changed and the others' read, the inbox opened and consumed.
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
  /** A remote stream is being applied to the history model: its events are not ours to publish. */
  private applyingHistory = false
  private syncing = false
  private lastError: string | null = null
  private folderLost = false
  private folderName: string | null = null
  /** The other devices' open tabs as last read, by their (reduced) id. */
  private readonly remoteTabs = new Map<string, SyncDeviceTabs>()
  private remoteTabsVersion = 0

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
      history: initialHistoryState(),
      openTabsHash: null,
      consumedSends: [],
      ...(saved?.version === 1 ? saved : {})
    }
    // A scope key this build added (`passwords`, `history`) starts at its default on a device set
    // up before; the history state of an older `sync.json` is completed the same way.
    this.data.scope = { ...defaultScope(), ...this.data.scope }
    this.data.history = readHistoryState(this.data.history)
    if (!Array.isArray(this.data.consumedSends)) this.data.consumedSends = []
    if (this.data.key) this.key = fromBase64(this.data.key)
  }

  start(): void {
    this.browser.state.subscribe(() => this.onLocalChange())
    this.browser.history.onVisits((event) => this.onVisits(event))
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
      pendingMerge: this.data.pendingMerge,
      remoteTabsVersion: this.remoteTabsVersion
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
        pendingMerge: existing.length > 0,
        openTabsHash: null
      }
      // The stream starts over in this folder; the sequence number never goes back, so a device
      // that read the old stream (the same folder joined again) does not sit past the new pages.
      this.data.history = { ...initialHistoryState(), seq: this.data.history.seq }
      if (this.data.scope.history) this.startSeed(Date.now())
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
   *
   * History is a stream per device, never one shared copy, so the question reads differently
   * there: "merge" takes the other devices' visits in from the start of their streams, "keep
   * this device's data" skips what they have published so far and follows them from here on –
   * nothing of theirs is deleted either way (Chrome merges history and never asks). This
   * device's own history is published in both cases.
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
      for (const [id, { type }] of local)
        meta[id] = { type, hash: '', modified: now, deleted: false }
      for (const [id, r] of remote) {
        if (local.has(id) || r.deleted) continue
        if (r.type === 'credential' || !inScope(r, this.data.scope)) continue
        meta[id] = { type: r.type, hash: '', modified: now, deleted: true }
      }
      if (this.data.scope.history) await this.skipRemoteHistory().catch(() => undefined)
    }
    this.data.meta = meta
    this.persist()
    await this.syncNow()
  }

  setScope(patch: Partial<SyncScope>): void {
    const before = this.data.scope
    this.data.scope = { ...this.data.scope, ...patch }
    // History turned on: what this device visited since it last published goes out (the backlog
    // again, from where it left off). Off: nothing is taken back from the folder.
    if (this.data.scope.history && !before.history && this.data.enabled) this.startSeed(Date.now())
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
      // The new folder has none of this device's pages: the whole open buffer is written again,
      // and the sealed pages it had elsewhere are not there to expire.
      this.data.history.written = 0
      this.data.history.pages = []
      this.data.openTabsHash = null
      this.persist()
      this.connect(folder)
    } finally {
      this.setBusy(false)
    }
    await this.syncNow()
  }

  /** Turn sync off; optionally delete this device's file and documents from the folder. */
  disconnect(wipeRemote: boolean): void {
    const transport = this.transport
    if (wipeRemote && transport) void this.removeOwnDocuments(transport).catch(() => undefined)
    this.stopTransport()
    this.key = null
    this.data = {
      ...this.data,
      enabled: false,
      folder: null,
      key: null,
      meta: {},
      pendingMerge: false,
      devices: [],
      history: { ...initialHistoryState(), seq: this.data.history.seq },
      openTabsHash: null
    }
    this.lastError = null
    this.folderLost = false
    this.folderName = null
    if (this.remoteTabs.size) {
      this.remoteTabs.clear()
      this.remoteTabsVersion += 1
    }
    this.persist()
    this.browser.state.commitVolatile()
  }

  // ---------------------------------------------------------------------------
  // Tabs from other devices, Send to your devices
  // ---------------------------------------------------------------------------

  tabsFromDevices(): SyncDeviceTabs[] {
    if (!this.data.enabled || !this.data.scope.openTabs) return []
    return sortDeviceTabs([...this.remoteTabs.values()], Date.now())
  }

  /**
   * Chrome's "Send to your devices": the page lands in the target's inbox in the folder and opens
   * there as a tab once the device syncs. The sender only confirms it was handed over – whether
   * the target is on is the folder's business.
   */
  async sendTab(
    opts: { deviceId: string; url: string; title?: string; tabId?: string },
    win: ZenWindow
  ): Promise<void> {
    if (!this.data.enabled || !this.transport || !this.key) {
      this.browser.toast('Set up sync first.', 'error', win)
      return
    }
    const target = this.data.devices.find((d) => d.id === opts.deviceId)
    if (!target) {
      this.browser.toast(SEND_TAB_UNKNOWN_DEVICE_MESSAGE, 'error', win)
      return
    }
    const tab = opts.tabId ? this.browser.tabs.tab(opts.tabId) : undefined
    const url = opts.url || tab?.url || ''
    if (!isSendableUrl(url)) {
      this.browser.toast(SEND_TAB_NOT_A_PAGE_MESSAGE, 'error', win)
      return
    }
    const now = Date.now()
    const doc: SendTabDocument = {
      v: 1,
      id: newId('send'),
      url,
      title: (opts.title ?? tab?.customTitle ?? tab?.title ?? '').slice(0, 500),
      at: now,
      from: { id: this.data.deviceId, name: this.data.deviceName }
    }
    try {
      await this.writeDocument(this.transport, inboxName(target.id, doc.id), 'send-tab', doc, now)
      this.browser.toast(`Sent to ${target.name}`, 'info', win)
    } catch (error) {
      this.browser.toast(
        isFolderLost(error)
          ? FOLDER_LOST_MESSAGE
          : `Could not send the tab: ${this.describe(error)}`,
        'error',
        win
      )
    }
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
   * last-writer-wins reflects the real order of edits across devices. A push is scheduled only
   * when something to publish changed: a record, or the open-tabs list.
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
    if (diff.changed || this.openTabsChanged()) this.schedulePush()
  }

  /** The history model changed by the user's hand (not by a stream): the stream records it. */
  private onVisits(event: HistoryVisitsEvent): void {
    if (!this.data.enabled || this.applyingHistory || !this.data.scope.history) return
    const now = Date.now()
    const entries = entriesFromEvent(event, now)
    if (entries.length === 0) return
    // This device's own deletions are remembered too: a stream read later must not undo them.
    for (const e of entries) rememberDeletion(this.data.history.deletions, e, now)
    appendOpen(this.data.history, entries)
    this.persist()
    if (!this.data.pendingMerge) this.schedulePush()
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
      credentials: this.browser.passwords.syncSources(),
      siteData: this.browser.siteData.policy()
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
      // The documents: the folder listed once for the three.
      const names = await this.transport.list()
      await this.syncHistory(this.transport, this.key, names, now)
      await this.syncOpenTabs(this.transport, this.key, names, now)
      await this.syncInbox(this.transport, this.key, names, now)
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

  // ---------------------------------------------------------------------------
  // The history stream (ID-13 / HB-48)
  // ---------------------------------------------------------------------------

  /** Begin (or resume) publishing the backlog: the retention window past what went out before. */
  private startSeed(now: number): void {
    const state = this.data.history
    const since = Math.max(now - RETENTION_MS, state.publishedUntil + 1)
    state.seed = { since: seedFloor(this.browser.history, since, now), until: now, cursor: null }
  }

  /**
   * "Keep this device's data" at the merge question: the other devices' streams are followed
   * from their current end, nothing published so far is taken in.
   */
  private async skipRemoteHistory(): Promise<void> {
    if (!this.transport || !this.key) return
    const names = await this.transport.list()
    const streams = this.streamsIn(names)
    for (const [dev, seqs] of streams) {
      const last = Math.max(...seqs)
      const doc = await readDocument(this.transport, historyPageName(dev, last))
      if (!doc) continue
      try {
        const page = readHistoryPage(await decryptJson(this.key, doc.envelope))
        if (page) {
          const cursor: StreamCursor = advanceCursor(page)
          if (!page.sealed) cursor.updatedAt = doc.updatedAt
          this.data.history.cursors[dev] = cursor
        }
      } catch {
        // Unreadable: the stream is read from its start like any other.
      }
    }
  }

  /** The other devices' history pages in the folder: (reduced) device id → sequence numbers. */
  private streamsIn(names: string[]): Map<string, number[]> {
    const streams = new Map<string, number[]>()
    for (const name of names) {
      const parsed = parseHistoryPageName(name)
      if (!parsed || ownsName(this.data.deviceId, parsed.deviceId)) continue
      const seqs = streams.get(parsed.deviceId) ?? []
      seqs.push(parsed.seq)
      streams.set(parsed.deviceId, seqs)
    }
    return streams
  }

  /**
   * This device's stream out, the others' in. Out: the backlog under way (a few pages a round),
   * the buffer written as pages, pages past retention removed. In: every other stream from its
   * cursor on, each page applied once through the model's batch import and delete paths, the
   * events that raises kept out of this device's stream (`applyingHistory`).
   */
  private async syncHistory(
    transport: SyncTransport,
    key: Uint8Array,
    names: string[],
    now: number
  ): Promise<void> {
    const state = this.data.history
    if (!this.data.scope.history) return
    // 1. The backlog: some pages of the model's export per round, the rest next round.
    let seeded = 0
    while (state.seed && seeded < HISTORY_PAGES_PER_ROUND) {
      const page = this.browser.history.exportVisits({
        since: state.seed.since,
        until: state.seed.until,
        cursor: state.seed.cursor
      })
      appendOpen(state, entriesFromVisits(page.visits))
      if (page.next === null) state.seed = null
      else state.seed.cursor = page.next
      seeded += 1
    }
    // 2. The buffer as pages (the visits not yet out with the titles their pages have by now);
    //    the state moves only once every write went through.
    refreshTitles(state, (url) => this.browser.history.titleFor(url))
    const plannedOpen = state.open.length
    const { writes, after } = planWrites(state)
    for (const w of writes) {
      await this.writeDocument(
        transport,
        historyPageName(this.data.deviceId, w.seq),
        'history',
        w.page,
        now
      )
    }
    if (writes.length) takeWrites(state, after, plannedOpen)
    // 3. Pages whose newest event is past the retention window, or beyond the count cap.
    for (const seq of expiredPages(state, now)) {
      await transport.remove(historyPageName(this.data.deviceId, seq))
      state.pages = state.pages.filter((p) => p.seq !== seq)
    }
    // 4. The other streams, from where this device left each (a round reads so many pages of
    //    one stream; the rest follow in the next).
    let more = false
    for (const [dev, seqs] of this.streamsIn(names)) {
      let cursor = state.cursors[dev]
      const wanted = pagesToRead(seqs, cursor)
      if (wanted.length && Math.max(...seqs) > wanted[wanted.length - 1]) more = true
      for (const seq of wanted) {
        const doc = await readDocument(transport, historyPageName(dev, seq))
        if (!doc || doc.kind !== 'history') continue
        if (cursor && cursor.seq === seq && cursor.updatedAt === doc.updatedAt) continue
        let page
        try {
          page = readHistoryPage(await decryptJson(key, doc.envelope))
        } catch {
          this.lastError = `Could not decrypt history from "${doc.deviceName}" (different passphrase?)`
          break
        }
        if (!page) continue
        const from = cursor && cursor.seq === seq ? Math.min(cursor.index, page.entries.length) : 0
        this.applyingHistory = true
        try {
          applyEntries(this.browser.history, page.entries, from, state.deletions, now)
        } finally {
          this.applyingHistory = false
        }
        // An open page is read again only once its document changed; a sealed one is past.
        cursor = advanceCursor(page)
        if (!page.sealed) cursor.updatedAt = doc.updatedAt
        state.cursors[dev] = cursor
      }
    }
    if (state.seed || more) this.schedulePush()
  }

  // ---------------------------------------------------------------------------
  // Open tabs (ID-28)
  // ---------------------------------------------------------------------------

  /** Whether the list in the folder no longer matches this device's tabs. */
  private openTabsChanged(): boolean {
    if (!this.data.scope.openTabs) return this.data.openTabsHash !== null
    return (
      openTabsHash(collectOpenTabs(Object.values(this.browser.state.model.tabs))) !==
      this.data.openTabsHash
    )
  }

  /**
   * This device's list rewritten when it changed (removed with the type off), the others' read
   * when their document did – the toggle works both ways: off, nothing is shown either.
   */
  private async syncOpenTabs(
    transport: SyncTransport,
    key: Uint8Array,
    names: string[],
    now: number
  ): Promise<void> {
    const own = openTabsName(this.data.deviceId)
    if (!this.data.scope.openTabs) {
      if (this.data.openTabsHash !== null) {
        await transport.remove(own)
        this.data.openTabsHash = null
      }
      if (this.remoteTabs.size) {
        this.remoteTabs.clear()
        this.remoteTabsVersion += 1
      }
      return
    }
    const doc = collectOpenTabs(Object.values(this.browser.state.model.tabs))
    const hash = openTabsHash(doc)
    if (hash !== this.data.openTabsHash) {
      await this.writeDocument(transport, own, 'open-tabs', doc, now)
      this.data.openTabsHash = hash
    }
    let changed = false
    const seen = new Set<string>()
    for (const name of names) {
      const dev = parseOpenTabsName(name)
      if (!dev || ownsName(this.data.deviceId, dev)) continue
      seen.add(dev)
      const prev = this.remoteTabs.get(dev)
      const document = await readDocument(transport, name)
      if (!document || document.kind !== 'open-tabs') continue
      if (prev && prev.updatedAt === document.updatedAt) continue
      try {
        const tabs = readOpenTabs(await decryptJson(key, document.envelope))
        if (!tabs) continue
        this.remoteTabs.set(dev, {
          deviceId: document.deviceId,
          deviceName: document.deviceName,
          updatedAt: document.updatedAt,
          tabs: tabs.tabs
        })
        changed = true
      } catch {
        this.lastError = `Could not decrypt data from "${document.deviceName}" (different passphrase?)`
      }
    }
    for (const dev of [...this.remoteTabs.keys()]) {
      if (seen.has(dev)) continue
      this.remoteTabs.delete(dev)
      changed = true
    }
    if (changed) this.remoteTabsVersion += 1
  }

  // ---------------------------------------------------------------------------
  // Send to your devices (ID-27)
  // ---------------------------------------------------------------------------

  /**
   * The tabs the others sent this device: each opens once and its file goes; a send this
   * device already opened (the file came back with a cloud drive's hiccup) only goes. A send
   * left to anyone for `SEND_TTL_MS` is dropped by whoever sees it.
   */
  private async syncInbox(
    transport: SyncTransport,
    key: Uint8Array,
    names: string[],
    now: number
  ): Promise<void> {
    for (const name of names) {
      const parsed = parseInboxName(name)
      if (!parsed) continue
      const mine = ownsName(this.data.deviceId, parsed.targetId)
      if (mine && this.data.consumedSends.includes(parsed.sendId)) {
        await transport.remove(name)
        continue
      }
      const doc = await readDocument(transport, name)
      if (!doc) continue
      if (!mine) {
        if (now - doc.updatedAt > SEND_TTL_MS) await transport.remove(name)
        continue
      }
      let sent: SendTabDocument | null = null
      try {
        sent = readSendTab(await decryptJson(key, doc.envelope))
      } catch {
        this.lastError = `Could not decrypt a tab sent from "${doc.deviceName}" (different passphrase?)`
      }
      // Consumed first, whatever opening it does: a tab is never opened twice.
      this.data.consumedSends.push(parsed.sendId)
      if (this.data.consumedSends.length > SENDS_REMEMBERED)
        this.data.consumedSends.splice(0, this.data.consumedSends.length - SENDS_REMEMBERED)
      await transport.remove(name)
      if (sent && now - sent.at <= SEND_TTL_MS) this.openSentTab(sent)
    }
  }

  /**
   * A sent tab arrives: on a host with its own notification shade for the browser (Android) it
   * is posted there, under the app's "Sharing" channel, and opens on the tap (the tap of a
   * notification this core never showed opens its `url` – the existing path); elsewhere it
   * opens as a tab right away, with a toast naming the sender, as Chrome's desktop does.
   */
  private openSentTab(sent: SendTabDocument): void {
    const host = this.browser.platform.webNotifications
    if (host) {
      void host
        .show({
          id: `send/${sent.id}`,
          origin: new URL(sent.url).origin,
          tabId: '',
          url: sent.url,
          title: sendTabArrivedText(sent),
          body: sent.title || sent.url,
          icon: '',
          tag: '',
          silent: false,
          requireInteraction: false,
          renotify: false,
          timestamp: sent.at || Date.now(),
          channel: 'sharing'
        })
        .then((shown) => {
          if (!shown) this.openSentTabNow(sent)
        })
        .catch(() => this.openSentTabNow(sent))
      return
    }
    this.openSentTabNow(sent)
  }

  private openSentTabNow(sent: SendTabDocument): void {
    const win = this.browser.focusedWindow()
    this.browser.tabs.createTab({ url: sent.url, active: true }, win)
    this.browser.toast(sendTabArrivedText(sent), 'info', win)
  }

  // ---------------------------------------------------------------------------
  // Documents
  // ---------------------------------------------------------------------------

  private async writeDocument(
    transport: SyncTransport,
    name: string,
    kind: SyncDocumentKind,
    payload: unknown,
    now: number
  ): Promise<void> {
    if (!this.key) return
    const doc: SyncDocument = {
      kind,
      deviceId: this.data.deviceId,
      deviceName: this.data.deviceName,
      updatedAt: now,
      envelope: await encryptJson(this.key, this.data.salt ?? newSalt(), payload)
    }
    await transport.write(name, serializeDocument(doc))
  }

  /** Everything this device wrote: its record file, its pages, its tab list, its unread inbox. */
  private async removeOwnDocuments(transport: SyncTransport): Promise<void> {
    const id = this.data.deviceId
    await transport.remove(deviceFileName(id))
    for (const name of await transport.list()) {
      const page = parseHistoryPageName(name)
      const tabs = parseOpenTabsName(name)
      const inbox = parseInboxName(name)
      if (
        (page && ownsName(id, page.deviceId)) ||
        (tabs && ownsName(id, tabs)) ||
        (inbox && ownsName(id, inbox.targetId))
      )
        await transport.remove(name)
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
