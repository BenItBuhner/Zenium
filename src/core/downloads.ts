import {
  DEFAULT_CONTAINER_ID,
  PRIVATE_CONTAINER_ID,
  type DownloadChangeKind,
  type DownloadDanger,
  type DownloadItem,
  type DownloadSettings,
  type DownloadState,
  type DownloadsProgress,
  type Platform as PlatformOs
} from '../shared/types'
import { fileExtension, finalName as stripPartial } from '../shared/downloads'
import { newId } from '../shared/ids'
import { JsonStore } from './store/JsonStore'
import type { DownloadHost, StoreIO } from './platform'
import type { ZenWindow } from './window'
import {
  SAFE,
  VERDICT_TIMEOUT_MS,
  classifyDownload,
  dangerVerdicts,
  makeDanger,
  mayAutoOpen,
  worstDanger,
  type DangerVerdictProvider,
  type DangerVerdictRegistry
} from './downloads/danger'

interface PersistedV1 {
  version: 1
  items: Array<Record<string, unknown>>
}

interface PersistedV2 {
  version: 2
  items: DownloadItem[]
}

type Persisted = PersistedV1 | PersistedV2

const MAX_ITEMS = 100
const SCHEMA_VERSION = 2
/** Progress events per item are throttled to this (4 Hz); state changes go out at once. */
const PROGRESS_INTERVAL_MS = 250
const PERSIST_INTERVAL_MS = 2000

/** Everything a host knows when a transfer starts. */
export interface DownloadInit {
  url: string
  /** Name the server suggested (`Content-Disposition`, the `download` attribute or the URL). */
  filename: string
  /** Name the file will end up under when the host already made it unique; defaults to `filename`. */
  finalName?: string
  totalBytes: number
  mimeType: string
  savePath?: string
  referrer?: string
  /** Tab whose page started it ("familiar site" check); null for retries and resumes. */
  sourceTabId?: string | null
  /** Chromium's user-gesture flag when the host has it; null when unknown (Android's WebView). */
  userGesture?: boolean | null
  canResume?: boolean
  etag?: string
  lastModified?: string
  /** Partition the transfer runs in; `PRIVATE_CONTAINER_ID` makes the item private. */
  containerId?: string
  private?: boolean
  /** Continuation of an existing record (resume after a restart, retry) instead of a new download. */
  resumes?: string
}

/** A filter over the list: private items only, regular items only, or (undefined) everything. */
export interface DownloadFilter {
  private?: boolean
}

export interface DownloadServiceDeps {
  os: PlatformOs
  settings: () => DownloadSettings
  /** The referrer's site was visited before today (Chromium's file-type warning exemption). */
  referrerFamiliar: (referrer: string) => boolean
  /** A dangerous or suspicious download finished and waits for Keep / Discard. */
  onDanger?: (item: DownloadItem) => void
  /** Providers asked for a verdict on every new download; the shared registry by default. */
  verdicts?: DangerVerdictRegistry
  now?: () => number
}

export type DownloadChange = DownloadChangeKind

/**
 * Chromium's rate estimate: bytes over a sliding window of one-second buckets, so the speed
 * shown settles quickly after a pause and follows throttling without jumping around.
 */
export class RateEstimator {
  private readonly buckets: number[]
  private bucketStart: number
  private since: number
  private index = 0
  private lastBytes: number | null = null

  constructor(
    now: number,
    private readonly bucketMs = 1000,
    bucketCount = 10
  ) {
    this.buckets = new Array<number>(bucketCount).fill(0)
    this.bucketStart = now
    this.since = now
  }

  /** Record the cumulative byte count at `now`. */
  update(receivedBytes: number, now: number): void {
    this.advance(now)
    if (this.lastBytes !== null && receivedBytes >= this.lastBytes)
      this.buckets[this.index] += receivedBytes - this.lastBytes
    this.lastBytes = receivedBytes
  }

  /** Forget history (after a pause or resume the old rate is meaningless). */
  reset(receivedBytes: number, now: number): void {
    this.buckets.fill(0)
    this.index = 0
    this.bucketStart = now
    this.since = now
    this.lastBytes = receivedBytes
  }

  /** Bytes per second over the window (or over the time since the reset while it is shorter). */
  bytesPerSecond(now: number): number {
    this.advance(now)
    const total = this.buckets.reduce((a, b) => a + b, 0)
    const windowMs = this.buckets.length * this.bucketMs
    const elapsed = Math.min(windowMs, Math.max(this.bucketMs, now - this.since))
    return Math.round((total * 1000) / elapsed)
  }

  private advance(now: number): void {
    const steps = Math.floor((now - this.bucketStart) / this.bucketMs)
    if (steps <= 0) return
    if (steps >= this.buckets.length) {
      this.buckets.fill(0)
    } else {
      for (let i = 0; i < steps; i++) {
        this.index = (this.index + 1) % this.buckets.length
        this.buckets[this.index] = 0
      }
    }
    this.bucketStart += steps * this.bucketMs
  }
}

interface Transfer {
  rate: RateEstimator
  /** Provider verdicts still outstanding; the file stays quarantined until they settle. */
  verdicts: Promise<void> | null
  /** The worst URL verdict a provider returned, kept apart from the file-type verdict. */
  urlVerdict: DownloadDanger | null
  abort: AbortController
  /** Completion is waiting for the verdicts. */
  completing: boolean
  lastBroadcast: number
}

type ProgressPatch = Partial<
  Pick<
    DownloadItem,
    | 'receivedBytes'
    | 'totalBytes'
    | 'savePath'
    | 'finalName'
    | 'canResume'
    | 'etag'
    | 'lastModified'
    | 'mimeType'
    | 'error'
  >
>

/**
 * The downloads list: records, their persistence and the rules around them. The host owns the
 * actual transfers and reports through `begin` / `progress` / `finish`, then acts on `pause` /
 * `resume` / `cancel` / `retry` / `release` / `deletePartial`. Every change goes out through
 * `onChange` (the `download.changed` event) and the list rides on the state snapshot.
 *
 * Files arrive under `PARTIAL_SUFFIX`. When a transfer completes the service waits for every
 * danger verdict, then either has the host release the file to its final name (safe) or keeps
 * it quarantined until the user chooses Keep or Discard (flagged).
 *
 * Private downloads (a private window, the Android private profile) stay in memory: they are
 * never written to `downloads.json`, only private windows see them, and `endPrivateSession`
 * cancels and forgets them when the last private window closes.
 */
export class DownloadService {
  items: DownloadItem[] = []
  private readonly store: JsonStore<Persisted>
  private lastPersist = 0
  private readonly transfers = new Map<string, Transfer>()
  private readonly registry: DangerVerdictRegistry
  private readonly now: () => number

  constructor(
    io: StoreIO,
    private readonly host: DownloadHost,
    private readonly onChange: (item: DownloadItem, kind: DownloadChangeKind) => void,
    private readonly deps: DownloadServiceDeps
  ) {
    this.now = deps.now ?? (() => Date.now())
    this.registry = deps.verdicts ?? dangerVerdicts
    this.store = new JsonStore<Persisted>(io, 'downloads.json', 1000)
    this.items = migrate(this.store.readSync(), this.now())
  }

  /** Safe Browsing and friends register here (or on the registry directly). */
  addVerdictProvider(provider: DangerVerdictProvider): () => void {
    return this.registry.register(provider)
  }

  item(id: string): DownloadItem | undefined {
    return this.items.find((i) => i.id === id)
  }

  get inFlight(): DownloadItem[] {
    return this.items.filter((i) => isInFlight(i.state))
  }

  /** The list a window may show: private windows see everything, the rest no private item. */
  visibleTo(privateWindow: boolean): DownloadItem[] {
    return privateWindow ? this.items : this.items.filter((i) => !i.private)
  }

  /** In-flight downloads (paused ones included), optionally private or regular ones only. */
  activeCount(filter: DownloadFilter = {}): number {
    return this.inFlight.filter((i) => matches(i, filter)).length
  }

  /**
   * Bytes received and expected over the in-flight downloads, for the toolbar indicator and the
   * OS progress bar. `indeterminate` when a running transfer has no size; paused transfers of
   * known size still count towards the ratio, like Chrome's.
   */
  aggregateProgress(filter: DownloadFilter = {}): DownloadsProgress {
    const active = this.inFlight.filter((i) => matches(i, filter))
    let received = 0
    let total = 0
    let indeterminate = false
    for (const i of active) {
      received += i.receivedBytes
      if (i.totalBytes > 0) total += i.totalBytes
      else if (i.state === 'progressing') indeterminate = true
    }
    return { received, total, indeterminate, active: active.length }
  }

  // ---------------------------------------------------------------------------
  // Host reports
  // ---------------------------------------------------------------------------

  /** A transfer started; returns the record the host should keep updating. */
  begin(init: DownloadInit): DownloadItem {
    const now = this.now()
    const existing = init.resumes ? this.item(init.resumes) : undefined
    const record = existing ? this.continueRecord(existing, init) : this.newRecord(init, now)
    const transfer: Transfer = {
      rate: new RateEstimator(now),
      verdicts: null,
      urlVerdict: null,
      abort: new AbortController(),
      completing: false,
      lastBroadcast: now
    }
    transfer.rate.reset(record.receivedBytes, now)
    this.transfers.set(record.id, transfer)
    if (!existing && this.registry.size > 0) transfer.verdicts = this.askProviders(record, transfer)
    this.persist()
    this.onChange(record, 'started')
    return record
  }

  private newRecord(init: DownloadInit, now: number): DownloadItem {
    const referrer = init.referrer ?? ''
    const filename = stripPartial(init.filename) || 'download'
    const containerId =
      init.containerId ?? (init.private ? PRIVATE_CONTAINER_ID : DEFAULT_CONTAINER_ID)
    const record: DownloadItem = {
      id: newId('dl'),
      url: init.url,
      referrer,
      filename,
      finalName: stripPartial(init.finalName ?? '') || filename,
      savePath: init.savePath ?? '',
      totalBytes: init.totalBytes,
      receivedBytes: 0,
      state: 'progressing',
      startedAt: now,
      mimeType: init.mimeType,
      canResume: init.canResume ?? false,
      danger: SAFE,
      dangerAccepted: false,
      openWhenDone: false,
      bytesPerSecond: 0,
      etaMs: null,
      private: Boolean(init.private) || containerId === PRIVATE_CONTAINER_ID,
      containerId,
      etag: init.etag ?? '',
      lastModified: init.lastModified ?? ''
    }
    record.danger = this.classify(record, init.userGesture ?? null)
    this.items.unshift(record)
    if (this.items.length > MAX_ITEMS) this.trim()
    return record
  }

  /** A resume after a restart or a retry picks the old record up where it was. */
  private continueRecord(record: DownloadItem, init: DownloadInit): DownloadItem {
    record.state = 'progressing'
    delete record.error
    delete record.endedAt
    delete record.completedAt
    if (init.savePath) record.savePath = init.savePath
    if (init.totalBytes > 0) record.totalBytes = init.totalBytes
    if (init.mimeType) record.mimeType = init.mimeType
    if (init.canResume !== undefined) record.canResume = init.canResume
    if (init.etag !== undefined) record.etag = init.etag
    if (init.lastModified !== undefined) record.lastModified = init.lastModified
    if (init.finalName) record.finalName = stripPartial(init.finalName)
    const filename = init.filename ? stripPartial(init.filename) : ''
    if (filename && filename !== record.filename) {
      // The server suggested another name this time: the type may have changed with it.
      record.filename = filename
      if (!init.finalName) record.finalName = filename
      record.danger = this.classify(record, init.userGesture ?? null)
      record.dangerAccepted = false
    }
    return record
  }

  /**
   * The host settled on the on-disk name. When the response headers changed the type after
   * `begin` (Android learns `Content-Disposition` only once the request is answered), the file
   * is classified again under the name it will actually carry.
   */
  private rename(record: DownloadItem, finalName: string | undefined): void {
    if (!finalName) return
    const name = stripPartial(finalName)
    if (!name || name === record.finalName) return
    const typeChanged = fileExtension(name) !== fileExtension(record.finalName)
    record.finalName = name
    if (!typeChanged || record.dangerAccepted) return
    const urlVerdict = this.transfers.get(record.id)?.urlVerdict ?? SAFE
    record.danger = worstDanger(this.classify(record, null), urlVerdict)
  }

  private classify(record: DownloadItem, userGesture: boolean | null): DownloadDanger {
    return classifyDownload({
      url: record.url,
      referrer: record.referrer,
      filename: record.finalName || record.filename,
      mimeType: record.mimeType,
      os: this.deps.os,
      referrerFamiliar:
        userGesture !== false &&
        Boolean(record.referrer) &&
        this.deps.referrerFamiliar(record.referrer)
    })
  }

  /** Progress update; broadcasts are throttled per item unless the state changed. */
  progress(
    id: string,
    patch: ProgressPatch & {
      state: Extract<DownloadState, 'progressing' | 'paused' | 'interrupted'>
    }
  ): void {
    const record = this.item(id)
    // Finished records never come back to life; a resumable interruption does (interrupted → progressing).
    if (!record || record.state === 'completed' || record.state === 'cancelled') return
    const transfer = this.transfers.get(id)
    const now = this.now()
    const stateChanged = record.state !== patch.state
    const { state, finalName, ...fields } = patch
    assignFields(record, fields)
    this.rename(record, finalName)
    record.state = state
    if (state === 'progressing') delete record.error
    else if (state === 'interrupted' && !record.error) record.error = 'interrupted'
    if (transfer) {
      if (stateChanged) transfer.rate.reset(record.receivedBytes, now)
      else transfer.rate.update(record.receivedBytes, now)
      record.bytesPerSecond = state === 'progressing' ? transfer.rate.bytesPerSecond(now) : 0
    }
    record.etaMs = estimateEta(record)
    if (stateChanged || now - this.lastPersist > PERSIST_INTERVAL_MS) this.persist()
    if (stateChanged || !transfer || now - transfer.lastBroadcast >= PROGRESS_INTERVAL_MS) {
      if (transfer) transfer.lastBroadcast = now
      this.onChange(record, 'progress')
    }
  }

  /** The transfer ended: completed (bytes are in the partial file), cancelled or interrupted. */
  finish(
    id: string,
    state: Extract<DownloadState, 'completed' | 'cancelled' | 'interrupted'>,
    patch: ProgressPatch = {}
  ): void {
    const record = this.item(id)
    if (!record || record.state === 'completed' || record.state === 'cancelled') return
    const transfer = this.transfers.get(id)
    const { finalName, ...fields } = patch
    assignFields(record, fields)
    this.rename(record, finalName)
    record.bytesPerSecond = 0
    record.etaMs = null
    if (state === 'completed') {
      if (record.totalBytes <= 0) record.totalBytes = record.receivedBytes
      void this.complete(record, transfer)
      return
    }
    this.transfers.delete(id)
    transfer?.abort.abort()
    record.state = state
    record.endedAt = this.now()
    if (state === 'cancelled') {
      delete record.error
      const partial = record.savePath
      record.savePath = ''
      if (partial) void this.host.deletePartial({ ...record, savePath: partial })
    } else if (!record.error) {
      record.error = 'interrupted'
    }
    this.persist()
    this.onChange(record, 'done')
  }

  /** Register a file we produced ourselves (e.g. a screenshot) so it shows in the panel. */
  addCompleted(
    savePath: string,
    mimeType: string,
    options: { containerId?: string; private?: boolean } = {}
  ): DownloadItem {
    const now = this.now()
    const name = basename(savePath)
    const containerId =
      options.containerId ?? (options.private ? PRIVATE_CONTAINER_ID : DEFAULT_CONTAINER_ID)
    const record: DownloadItem = {
      id: newId('dl'),
      url: savePath.startsWith('content:') ? savePath : `file://${savePath}`,
      referrer: '',
      filename: name,
      finalName: name,
      savePath,
      totalBytes: 0,
      receivedBytes: 0,
      state: 'completed',
      startedAt: now,
      completedAt: now,
      endedAt: now,
      mimeType,
      canResume: false,
      danger: SAFE,
      dangerAccepted: false,
      openWhenDone: false,
      bytesPerSecond: 0,
      etaMs: null,
      private: Boolean(options.private) || containerId === PRIVATE_CONTAINER_ID,
      containerId,
      etag: '',
      lastModified: ''
    }
    this.items.unshift(record)
    if (this.items.length > MAX_ITEMS) this.trim()
    this.persist()
    this.onChange(record, 'done')
    return record
  }

  // ---------------------------------------------------------------------------
  // User actions
  // ---------------------------------------------------------------------------

  pause(id: string): void {
    const item = this.item(id)
    if (item?.state === 'progressing') this.host.pause(id)
  }

  resume(id: string): void {
    const item = this.item(id)
    if (!item) return
    if (item.state === 'paused' || (item.state === 'interrupted' && item.canResume))
      this.host.resume(item)
    else if (item.state === 'interrupted' || item.state === 'cancelled') this.retry(id)
  }

  cancel(id: string): void {
    const item = this.item(id)
    if (item && isInFlight(item.state)) this.host.cancel(id)
  }

  /**
   * Start over: a new request for the same URL and referrer that reports back into this record
   * (the host passes `resumes: item.id` to `begin`), so the row keeps its place and identity.
   */
  retry(id: string): void {
    const item = this.item(id)
    if (!item || !canRetry(item)) return
    if (item.savePath) void this.host.deletePartial(item)
    item.savePath = ''
    item.receivedBytes = 0
    item.canResume = false
    item.dangerAccepted = false
    this.host.retry(item)
  }

  /** "Keep": release a flagged file from quarantine. */
  async acceptDanger(id: string): Promise<void> {
    const item = this.item(id)
    if (!item || !isQuarantined(item)) return
    const released = await this.host.release(item, this.releaseOptions())
    if (this.item(id) !== item) return
    if (released) {
      item.savePath = released.savePath
      item.finalName = released.finalName || item.finalName
    }
    item.dangerAccepted = true
    this.persist()
    this.onChange(item, 'done')
    await this.afterRelease(item)
  }

  /** "Discard" a flagged file, or delete what is left of a failed download; the row goes too. */
  async discard(id: string): Promise<void> {
    const item = this.item(id)
    if (!item) return
    if (isInFlight(item.state)) {
      this.host.cancel(id)
      return
    }
    if (item.savePath && (isQuarantined(item) || item.state === 'interrupted'))
      await this.host.deletePartial(item)
    this.drop(item)
  }

  setOpenWhenDone(id: string, on: boolean): void {
    const item = this.item(id)
    if (!item) return
    item.openWhenDone = on
    this.persist()
    this.onChange(item, 'progress')
  }

  showInFolder(id: string): void {
    const item = this.item(id)
    if (item?.savePath) this.host.showInFolder(item)
  }

  async open(id: string): Promise<void> {
    const item = this.item(id)
    if (item?.savePath && item.state === 'completed' && !isQuarantined(item))
      await this.host.open(item)
  }

  /** Take the row out of the list. A running transfer is cancelled; a finished file stays. */
  remove(id: string): void {
    const item = this.item(id)
    if (!item) return
    if (isInFlight(item.state)) this.host.cancel(id)
    else if (item.savePath && (isQuarantined(item) || item.state === 'interrupted'))
      void this.host.deletePartial(item)
    this.drop(item)
  }

  /** "Clear all": every finished row leaves the list; quarantined and partial files are deleted. */
  removeCompleted(): void {
    const finished = this.items.filter((i) => !isInFlight(i.state))
    for (const item of finished) {
      if (item.savePath && (isQuarantined(item) || item.state === 'interrupted'))
        void this.host.deletePartial(item)
    }
    this.items = this.items.filter((i) => isInFlight(i.state))
    this.persist()
    for (const item of finished) this.onChange({ ...item, removed: true }, 'removed')
  }

  /** @deprecated Older name of `removeCompleted`. */
  clearCompleted(): void {
    this.removeCompleted()
  }

  /**
   * The last private window closed: private transfers stop, their partial files go, and every
   * private row is forgotten (completed files stay on disk, like Firefox).
   */
  endPrivateSession(): void {
    const mine = this.items.filter((i) => i.private)
    if (mine.length === 0) return
    for (const item of mine) {
      if (isInFlight(item.state)) {
        this.host.cancel(item.id)
        this.transfers.get(item.id)?.abort.abort()
        this.transfers.delete(item.id)
      }
      if (
        item.savePath &&
        (isInFlight(item.state) || isQuarantined(item) || item.state === 'interrupted')
      )
        void this.host.deletePartial(item)
    }
    this.items = this.items.filter((i) => !i.private)
    for (const item of mine) this.onChange({ ...item, removed: true }, 'removed')
  }

  async chooseDirectory(win?: ZenWindow): Promise<string | null> {
    return (await this.host.chooseDirectory?.(win)) ?? null
  }

  private persist(): void {
    this.lastPersist = this.now()
    this.store.write({ version: SCHEMA_VERSION, items: this.items.filter((i) => !i.private) })
  }

  flushSync(): void {
    this.store.flushSync()
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private drop(item: DownloadItem): void {
    this.items = this.items.filter((i) => i !== item)
    this.transfers.get(item.id)?.abort.abort()
    this.transfers.delete(item.id)
    this.persist()
    this.onChange({ ...item, removed: true }, 'removed')
  }

  /** The list is capped; finished rows make room before running ones. */
  private trim(): void {
    while (this.items.length > MAX_ITEMS) {
      let victim = -1
      for (let i = this.items.length - 1; i >= 0; i--) {
        const item = this.items[i]
        if (item && !isInFlight(item.state)) {
          victim = i
          break
        }
      }
      if (victim === -1) victim = this.items.length - 1
      this.items.splice(victim, 1)
    }
  }

  private releaseOptions(): { notify: boolean } {
    return { notify: this.deps.settings().notifyOnComplete }
  }

  private async complete(record: DownloadItem, transfer: Transfer | undefined): Promise<void> {
    if (transfer) {
      if (transfer.completing) return
      transfer.completing = true
      if (transfer.verdicts) await transfer.verdicts
    }
    this.transfers.delete(record.id)
    // Cancelled or removed while the verdicts were pending.
    const gone = (): boolean =>
      this.item(record.id) !== record || (record.state as DownloadState) === 'cancelled'
    if (gone()) return
    const now = this.now()
    record.completedAt = now
    record.endedAt = now
    if (record.danger.level === 'safe') {
      const released = await this.host.release(record, this.releaseOptions())
      if (gone()) return
      if (released) {
        record.savePath = released.savePath
        record.finalName = released.finalName || record.finalName
      } else {
        record.state = 'interrupted'
        record.error = 'file-error'
        record.canResume = false
        delete record.completedAt
        this.persist()
        this.onChange(record, 'done')
        return
      }
    }
    record.state = 'completed'
    this.persist()
    this.onChange(record, 'done')
    if (record.danger.level === 'safe') await this.afterRelease(record)
    else this.deps.onDanger?.(record)
  }

  private async afterRelease(record: DownloadItem): Promise<void> {
    const settings = this.deps.settings()
    const auto =
      settings.autoOpenTypes.includes(fileExtension(record.finalName)) &&
      mayAutoOpen(record.finalName, this.deps.os)
    if ((record.openWhenDone || auto) && record.savePath) await this.host.open(record)
  }

  private askProviders(record: DownloadItem, transfer: Transfer): Promise<void> {
    const request = {
      url: record.url,
      referrer: record.referrer,
      filename: record.filename,
      mimeType: record.mimeType,
      totalBytes: record.totalBytes
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    // A provider that ignores the abort signal must not hold the file hostage.
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        transfer.abort.abort()
        resolve()
      }, VERDICT_TIMEOUT_MS)
    })
    const all = this.registry.all().map((p) =>
      p
        .verdict(request, transfer.abort.signal)
        .then((verdict) => {
          if (!verdict || verdict.level === 'safe') return
          if (this.item(record.id) !== record) return
          const danger = makeDanger(verdict.level, verdict.reason || 'url-verdict', verdict.message)
          transfer.urlVerdict = worstDanger(transfer.urlVerdict ?? SAFE, danger)
          record.danger = worstDanger(record.danger, danger)
          this.persist()
          this.onChange(record, 'progress')
        })
        .catch(() => undefined)
    )
    return Promise.race([Promise.all(all).then(() => undefined), timeout]).then(() => {
      if (timer) clearTimeout(timer)
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isInFlight(state: DownloadState): boolean {
  return state === 'progressing' || state === 'paused'
}

/** A finished download whose file is held back behind a danger warning. */
export function isQuarantined(item: DownloadItem): boolean {
  return item.state === 'completed' && item.danger.level !== 'safe' && !item.dangerAccepted
}

/** Failed or cancelled downloads can be started over, except `blob:` ones (the page's object is gone). */
export function canRetry(item: DownloadItem): boolean {
  return (
    (item.state === 'cancelled' || item.state === 'interrupted') && !item.url.startsWith('blob:')
  )
}

export function estimateEta(item: DownloadItem): number | null {
  if (item.state !== 'progressing' || item.totalBytes <= 0 || item.bytesPerSecond <= 0) return null
  const remaining = Math.max(0, item.totalBytes - item.receivedBytes)
  return Math.round((remaining / item.bytesPerSecond) * 1000)
}

function matches(item: DownloadItem, filter: DownloadFilter): boolean {
  return filter.private === undefined || item.private === filter.private
}

/** Copy the defined fields of a host patch onto the record. */
function assignFields(record: DownloadItem, patch: ProgressPatch): void {
  const target = record as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) target[key] = value
  }
}

export function basename(path: string): string {
  const clean = path.replace(/[\\/]+$/, '')
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  return idx === -1 ? clean : clean.slice(idx + 1)
}

/**
 * Read `downloads.json` from any schema. Version 1 records lack the fields added in version 2;
 * whatever was in flight when the browser last quit comes back as interrupted, resumable when
 * the host had told us the server supports ranges (the partial file is checked on resume).
 * Private items are never on disk, so nothing loaded is private.
 */
export function migrate(data: Persisted | null, now: number): DownloadItem[] {
  if (!data || !Array.isArray(data.items)) return []
  const items: DownloadItem[] = []
  for (const raw of data.items as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== 'object' || typeof raw['id'] !== 'string') continue
    const item = data.version === 1 ? fromV1(raw, now) : fromV2(raw, now)
    if (item) items.push(item)
  }
  return items.slice(0, MAX_ITEMS)
}

function fromV1(raw: Record<string, unknown>, now: number): DownloadItem | null {
  const state = raw['state']
  const inFlight = state === 'progressing' || state === 'paused'
  const finalState: DownloadState =
    state === 'completed' || state === 'cancelled' ? state : 'interrupted'
  const filename = str(raw['filename']) || 'download'
  const startedAt = num(raw['startedAt']) || now
  const item: DownloadItem = {
    id: str(raw['id']),
    url: str(raw['url']),
    referrer: '',
    filename,
    finalName: filename,
    savePath: str(raw['savePath']),
    totalBytes: num(raw['totalBytes']),
    receivedBytes: num(raw['receivedBytes']),
    state: finalState,
    startedAt,
    endedAt: startedAt,
    mimeType: str(raw['mimeType']),
    canResume: false,
    danger: SAFE,
    dangerAccepted: false,
    openWhenDone: false,
    bytesPerSecond: 0,
    etaMs: null,
    private: false,
    containerId: DEFAULT_CONTAINER_ID,
    etag: '',
    lastModified: ''
  }
  if (finalState === 'completed') item.completedAt = startedAt
  if (finalState === 'interrupted') item.error = inFlight ? 'shutdown' : 'interrupted'
  return item
}

function fromV2(raw: Record<string, unknown>, now: number): DownloadItem | null {
  const state = raw['state']
  const inFlight = state === 'progressing' || state === 'in-progress' || state === 'paused'
  const finalState: DownloadState =
    state === 'completed' || state === 'cancelled' || state === 'interrupted'
      ? state
      : 'interrupted'
  const danger = raw['danger'] as Partial<DownloadDanger & { kept?: boolean }> | undefined
  const savePath = str(raw['savePath'])
  const filename = str(raw['filename']) || 'download'
  const startedAt = num(raw['startedAt']) || now
  const endedAt = typeof raw['endedAt'] === 'number' ? raw['endedAt'] : inFlight ? now : startedAt
  const item: DownloadItem = {
    id: str(raw['id']),
    url: str(raw['url']),
    referrer: str(raw['referrer']),
    filename,
    finalName: str(raw['finalName']) || filename,
    savePath,
    totalBytes: num(raw['totalBytes']),
    receivedBytes: num(raw['receivedBytes']),
    state: finalState,
    startedAt,
    endedAt,
    mimeType: str(raw['mimeType']),
    canResume: Boolean(raw['canResume']) && finalState === 'interrupted' && savePath !== '',
    danger:
      danger && (danger.level === 'suspicious' || danger.level === 'dangerous')
        ? makeDanger(danger.level, reasonOf(danger.reason), str(danger.message))
        : SAFE,
    dangerAccepted: Boolean(raw['dangerAccepted']) || Boolean(danger?.kept),
    openWhenDone: Boolean(raw['openWhenDone']),
    bytesPerSecond: 0,
    etaMs: null,
    private: false,
    containerId: str(raw['containerId']) || DEFAULT_CONTAINER_ID,
    etag: str(raw['etag']),
    lastModified: str(raw['lastModified'])
  }
  if (finalState === 'completed')
    item.completedAt = typeof raw['completedAt'] === 'number' ? raw['completedAt'] : endedAt
  if (finalState === 'interrupted')
    item.error = inFlight
      ? 'shutdown'
      : typeof raw['error'] === 'string' && raw['error']
        ? raw['error']
        : 'interrupted'
  return item
}

const REASONS = new Set<DownloadDanger['reason']>([
  'executable',
  'script',
  'archive',
  'office-macro',
  'file-type',
  'insecure-download',
  'url-verdict'
])

/** Older builds wrote `insecure` and `url`; anything unknown counts as a plain file-type flag. */
function reasonOf(value: unknown): DownloadDanger['reason'] {
  if (value === 'insecure') return 'insecure-download'
  if (value === 'url') return 'url-verdict'
  return typeof value === 'string' && REASONS.has(value as DownloadDanger['reason'])
    ? (value as DownloadDanger['reason'])
    : 'file-type'
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
