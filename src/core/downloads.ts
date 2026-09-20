import {
  DEFAULT_CONTAINER_ID,
  PRIVATE_CONTAINER_ID,
  type DownloadChangeKind,
  type DownloadDanger,
  type DownloadDeleteFileResult,
  type DownloadInterruptReason,
  type DownloadItem,
  type DownloadSettings,
  type DownloadState,
  type DownloadsProgress,
  type Platform as PlatformOs
} from '../shared/types'
import {
  fileExtension,
  finalName as stripPartial,
  interruptMessage,
  interruptReasonFrom
} from '../shared/downloads'
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

/** Earlier schemas are read field by field; their rows are whatever an older build wrote. */
interface PersistedV1 {
  version: 1
  items: unknown[]
}

/** Version 2 had the version 3 shape with a free-form `error` string and no `fileMissing`. */
interface PersistedV2 {
  version: 2
  items: unknown[]
}

/**
 * Version 3 (interrupt reasons): `error` is a `DownloadInterruptReason`, `fileMissing` is kept,
 * and `shutdown()` writes the in-flight rows as interrupted by `user-shutdown` before the app
 * quits, so a row still in flight in the file means the browser never got to shut down (`crash`).
 */
interface PersistedV3 {
  version: 3
  items: DownloadItem[]
}

type Persisted = PersistedV1 | PersistedV2 | PersistedV3

const MAX_ITEMS = 100
const SCHEMA_VERSION = 3
/** Progress events per item are throttled to this (4 Hz); state changes go out at once. */
const PROGRESS_INTERVAL_MS = 250
const PERSIST_INTERVAL_MS = 2000
/** How long a dead download link's note waits for the failure of the navigation it came from. */
const DEAD_LINK_MS = 10_000

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
  /**
   * The transfer is what the tab's own navigation produced – a response the engine could not
   * show (Android's WebView on a PDF) – rather than a "Download link" or a save the user asked
   * for. With `disposition`, what decides whether a PDF opens in the viewer (`core/pdf.ts`).
   */
  navigation?: boolean
  /** The response's `Content-Disposition` type, when the host has it. */
  disposition?: 'inline' | 'attachment' | null
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
  /**
   * A transfer began, with what the host said of it (`begin`'s `init`, which the record does
   * not keep): the PDF viewer notes the ones that open in a tab when they complete.
   */
  onBegin?: (item: DownloadItem, init: DownloadInit) => void
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
  /** Set by `shutdown()`: the rows are frozen as persisted, later host reports are teardown noise. */
  private quitting = false
  /** Completed rows opened or revealed since the last snapshot: their files are checked again then. */
  private readonly recheck = new Set<string>()
  /** Navigations turned into failed rows (`tabId\nurl` → when), see `noteDeadLink`. */
  private readonly deadLinks = new Map<string, number>()
  /** The existence sweep over the loaded list, for callers that want to wait for it (tests). */
  readonly loaded: Promise<void>

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
    // Files deleted while the browser was closed: the loaded rows are checked as the list loads
    // (the host answers asynchronously), so the first snapshot goes out at once and the rows
    // that lost their file follow as changes.
    this.loaded = this.refreshFiles([...this.items])
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

  /**
   * The list a window may show: private windows see everything, the rest no private item. A
   * snapshot after a row was opened or revealed checks that row's file again (the user may have
   * deleted it from the file manager); a change follows when it is gone.
   */
  visibleTo(privateWindow: boolean): DownloadItem[] {
    if (this.recheck.size > 0) {
      const again = [...this.recheck].map((id) => this.item(id)).filter(isDefined)
      this.recheck.clear()
      void this.refreshFiles(again)
    }
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
    if (!existing) this.deps.onBegin?.(record, init)
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
    this.clearError(record)
    delete record.fileMissing
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
    if (this.quitting) return
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
    if (state === 'interrupted') this.setError(record, record.error ?? 'network-failed')
    else this.clearError(record)
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
    if (this.quitting) return
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
      this.clearError(record)
      const partial = record.savePath
      record.savePath = ''
      if (partial) void this.host.deletePartial({ ...record, savePath: partial })
    } else {
      this.setError(record, record.error ?? 'network-failed')
    }
    this.persist()
    this.onChange(record, 'done')
  }

  /**
   * The host learned the exact reason after the row was already interrupted (it asked the
   * server again what it had answered Chromium's resume with): the row's `error` and wording
   * follow, as long as it is still interrupted. A row resumed, retried or removed meanwhile
   * keeps its own state.
   */
  reclassify(id: string, reason: DownloadInterruptReason): void {
    if (this.quitting) return
    const record = this.item(id)
    if (!record || record.state !== 'interrupted' || record.error === reason) return
    this.setError(record, reason)
    this.persist()
    this.onChange(record, 'progress')
  }

  /**
   * A navigation the host turned into a failed row instead of a page (a link to a download the
   * server refuses: Chrome shows "Failed · No file" and no error page). The tab service asks
   * with `takeDeadLink` when that navigation's failure arrives, so the tab is left as it was.
   */
  noteDeadLink(tabId: string | null, url: string): void {
    if (!tabId) return
    const now = this.now()
    for (const [key, at] of this.deadLinks) if (now - at > DEAD_LINK_MS) this.deadLinks.delete(key)
    this.deadLinks.set(`${tabId}\n${url}`, now)
  }

  /** Whether the failed navigation of `url` in `tabId` is a dead download link noted just now; consumed. */
  takeDeadLink(tabId: string, url: string): boolean {
    const key = `${tabId}\n${url}`
    const at = this.deadLinks.get(key)
    if (at === undefined) return false
    this.deadLinks.delete(key)
    return this.now() - at <= DEAD_LINK_MS
  }

  /** Both fields together: the reason and Chrome's wording of it for the row. */
  private setError(record: DownloadItem, reason: DownloadInterruptReason): void {
    record.error = reason
    record.errorMessage = interruptMessage(reason)
  }

  private clearError(record: DownloadItem): void {
    delete record.error
    delete record.errorMessage
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
    else if (canRetry(item)) this.retry(id)
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
    // A completed row retries only once its file is gone: nothing of ours is left to delete.
    if (item.savePath && item.state !== 'completed') void this.host.deletePartial(item)
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

  /** Reveal the file; a completed row is checked for its file now and again at the next snapshot. */
  showInFolder(id: string): void {
    const item = this.item(id)
    if (!item?.savePath) return
    if (hasCompletedFile(item)) {
      this.recheck.add(id)
      void this.checkFile(item)
    }
    this.host.showInFolder(item)
  }

  /** Open a completed file; a row whose file turns out to be gone reads `fileMissing` instead. */
  async open(id: string): Promise<void> {
    const item = this.item(id)
    if (!item?.savePath || !hasCompletedFile(item)) return
    if (!(await this.checkFile(item))) return
    this.recheck.add(id)
    await this.host.open(item)
  }

  /**
   * Chrome's "Delete file": remove a completed download's file from disk and mark the row
   * `fileMissing` (it stays in the list, greyed "Deleted", with Retry). Says what happened; a
   * file that was gone already is `missing`, and the row is marked all the same.
   */
  async deleteFile(id: string): Promise<DownloadDeleteFileResult> {
    const item = this.item(id)
    if (!item?.savePath || !hasCompletedFile(item)) return 'not-completed'
    if (item.fileMissing) return 'missing'
    const result = await this.host.deleteFile(item)
    if (this.item(id) === item && result !== 'failed') this.setFileMissing(item, true)
    return result
  }

  /** Whether a completed row's file is still on disk, checked now; `fileMissing` follows. */
  async exists(id: string): Promise<boolean> {
    const item = this.item(id)
    if (!item?.savePath || !hasCompletedFile(item)) return false
    return this.checkFile(item)
  }

  /**
   * Check the files of completed rows (every released one by default) and mark those that are
   * gone; a row whose file came back is un-marked. Runs when the list loads and on demand.
   */
  async refreshFiles(items: DownloadItem[] = this.items): Promise<void> {
    await Promise.all(
      items.filter((i) => i.savePath && hasCompletedFile(i)).map((i) => this.checkFile(i))
    )
  }

  /** One row's existence check; resolves with whether the file is there. Host failures change nothing. */
  private async checkFile(item: DownloadItem): Promise<boolean> {
    let present: boolean
    try {
      present = await this.host.exists(item)
    } catch {
      return !item.fileMissing
    }
    if (this.item(item.id) === item) this.setFileMissing(item, !present)
    return present
  }

  private setFileMissing(item: DownloadItem, missing: boolean): void {
    if (Boolean(item.fileMissing) === missing) return
    if (missing) item.fileMissing = true
    else delete item.fileMissing
    this.persist()
    this.onChange(item, 'progress')
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

  /** Finished regular rows whose transfer began in `[fromMs, toMs)` (clear browsing data). */
  finishedInRange(fromMs: number, toMs: number): DownloadItem[] {
    return this.items.filter(
      (i) => !i.private && !isInFlight(i.state) && i.startedAt >= fromMs && i.startedAt < toMs
    )
  }

  /** Clear browsing data: the finished rows of the range leave the list, as `removeCompleted`. */
  removeFinishedInRange(fromMs: number, toMs: number): void {
    const gone = this.finishedInRange(fromMs, toMs)
    if (gone.length === 0) return
    const ids = new Set(gone.map((i) => i.id))
    for (const item of gone) {
      if (item.savePath && (isQuarantined(item) || item.state === 'interrupted'))
        void this.host.deletePartial(item)
    }
    this.items = this.items.filter((i) => !ids.has(i.id))
    this.persist()
    for (const item of gone) this.onChange({ ...item, removed: true }, 'removed')
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

  /**
   * The app is quitting. The host's engine is about to cancel every in-flight transfer and
   * delete its partial file (Chromium does on shutdown), so each regular in-flight row asks the
   * host to keep the file and records where it went, and is written as `interrupted` by
   * `user-shutdown`: "Resume" continues from the kept bytes next time. A row the next launch
   * still finds in flight was never shut down this way and loads as `crash`. Private rows are
   * not kept. Reports arriving after this point are ignored, so the teardown cannot mark the
   * rows cancelled or delete what was just kept; nothing is broadcast, the windows are closing.
   * Followed by `flushSync()`.
   */
  shutdown(): void {
    if (this.quitting) return
    this.quitting = true
    const park = this.host.park?.bind(this.host)
    let changed = false
    for (const item of this.items) {
      if (!isInFlight(item.state) || item.private) continue
      if (park && item.savePath) {
        const kept = park(item)
        if (kept && kept !== item.savePath) item.savePath = kept
      }
      item.state = 'interrupted'
      item.endedAt = this.now()
      item.bytesPerSecond = 0
      item.etaMs = null
      this.setError(item, 'user-shutdown')
      changed = true
    }
    if (changed) this.persist()
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
        this.setError(record, 'file-failed')
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

/** A completed row whose file was released to the user (not quarantined): the one "Delete file" acts on. */
export function hasCompletedFile(item: DownloadItem): boolean {
  return item.state === 'completed' && !isQuarantined(item)
}

/**
 * Failed and cancelled downloads can be started over, and so can a completed one whose file is
 * gone (Chrome's Retry on a "Deleted" row); never `blob:` ones (the page's object is gone).
 */
export function canRetry(item: DownloadItem): boolean {
  if (item.url.startsWith('blob:')) return false
  if (item.state === 'cancelled' || item.state === 'interrupted') return true
  return item.state === 'completed' && item.fileMissing === true
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
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
 * Versions 1 and 2 named the reason loosely (`interrupted`, `shutdown`, `file-error`, at times
 * a `net::` error): each becomes the closest `DownloadInterruptReason`, `network-failed` when
 * nothing closer is known. Rows in flight in a version 3 file were never shut down (`crash`);
 * in older files the shutdown did not write them, so they read `user-shutdown`. Private items
 * are never on disk, so nothing loaded is private.
 */
export function migrate(data: Persisted | null, now: number): DownloadItem[] {
  if (!data || !Array.isArray(data.items)) return []
  const items: DownloadItem[] = []
  for (const entry of data.items as unknown[]) {
    if (!entry || typeof entry !== 'object') continue
    const raw = entry as Record<string, unknown>
    if (typeof raw['id'] !== 'string') continue
    const item =
      data.version === 1
        ? fromV1(raw, now)
        : fromV2(raw, now, data.version >= 3 ? 'crash' : 'user-shutdown')
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
  if (finalState === 'interrupted') stampError(item, inFlight ? 'user-shutdown' : 'network-failed')
  return item
}

/**
 * Versions 2 and 3 share a shape; `inFlightReason` is what a row still in flight in the file
 * means (the writer's shutdown stamps rows since version 3, so there it is a crash).
 */
function fromV2(
  raw: Record<string, unknown>,
  now: number,
  inFlightReason: DownloadInterruptReason
): DownloadItem | null {
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
  if (finalState === 'completed') {
    item.completedAt = typeof raw['completedAt'] === 'number' ? raw['completedAt'] : endedAt
    if (raw['fileMissing'] === true && savePath !== '') item.fileMissing = true
  }
  if (finalState === 'interrupted')
    stampError(item, inFlight ? inFlightReason : interruptReasonFrom(raw['error']))
  return item
}

/** The wording is never trusted from disk: it follows this build's table. */
function stampError(item: DownloadItem, reason: DownloadInterruptReason): void {
  item.error = reason
  item.errorMessage = interruptMessage(reason)
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
