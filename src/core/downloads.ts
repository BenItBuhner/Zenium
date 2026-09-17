import type {
  DownloadDanger,
  DownloadItem,
  DownloadSettings,
  DownloadState,
  Platform as PlatformOs
} from '../shared/types'
import { fileExtension, finalName } from '../shared/downloads'
import { newId } from '../shared/ids'
import { JsonStore } from './store/JsonStore'
import type { DownloadHost, StoreIO, WindowHost } from './platform'
import type { ZenWindow } from './window'
import {
  SAFE,
  VERDICT_TIMEOUT_MS,
  classifyDownload,
  mayAutoOpen,
  worstDanger,
  type DangerVerdictProvider
} from './downloadDanger'

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

/** Everything a host knows when a transfer starts. */
export interface DownloadInit {
  url: string
  filename: string
  totalBytes: number
  mimeType: string
  savePath?: string
  referrer?: string
  /** Tab whose page started it (owning window, "familiar site" check); null for retries and resumes. */
  sourceTabId?: string | null
  /** Chromium's user-gesture flag when the host has it; null when unknown (Android's WebView). */
  userGesture?: boolean | null
  canResume?: boolean
  etag?: string
  lastModified?: string
  /** Continuation of an existing record (resume after a restart) instead of a new download. */
  resumes?: string
}

/** The subset of a browser window the service needs for taskbar / dock progress. */
export interface ProgressWindow {
  readonly id: string
  readonly alive: boolean
  readonly host: Pick<WindowHost, 'setProgressBar'>
}

export interface DownloadServiceDeps {
  os: PlatformOs
  settings: () => DownloadSettings
  /** Window that owns a tab, or the focused window when there is no tab. */
  windowForTab: (tabId: string | null) => ProgressWindow | null
  windows: () => Iterable<ProgressWindow>
  /** The referrer's site was visited before today (Chromium's file-type warning exemption). */
  referrerFamiliar: (referrer: string) => boolean
  now?: () => number
}

export type DownloadChange = 'started' | 'progress' | 'done'

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
  windowId: string | null
  /** Provider verdicts still outstanding; the file stays quarantined until they settle. */
  verdicts: Promise<void> | null
  abort: AbortController
  /** Completion is waiting for the verdicts. */
  completing: boolean
}

/**
 * The downloads list Zenium shows in its panel. Records and their persistence live here; the
 * host owns the actual transfers and reports through `begin` / `progress` / `finish`, then acts
 * on `pause` / `resume` / `cancel` / `retry` / `release` / `discard`.
 *
 * Files arrive under `PARTIAL_SUFFIX`. When a transfer completes the service waits for every
 * danger verdict, then either has the host release the file to its final name (safe) or keeps
 * it quarantined until the user chooses Keep or Discard (flagged).
 */
export class DownloadService {
  items: DownloadItem[] = []
  private readonly store: JsonStore<Persisted>
  private lastBroadcast = 0
  private lastPersist = 0
  private readonly transfers = new Map<string, Transfer>()
  private readonly providers: DangerVerdictProvider[] = []
  private readonly progressShown = new Map<string, string>()
  private readonly now: () => number

  constructor(
    io: StoreIO,
    private readonly host: DownloadHost,
    private readonly onChange: (item: DownloadItem, kind: DownloadChange) => void,
    private readonly deps: DownloadServiceDeps
  ) {
    this.now = deps.now ?? (() => Date.now())
    this.store = new JsonStore<Persisted>(io, 'downloads.json', 1000)
    this.items = migrate(this.store.readSync(), this.now())
  }

  /** Safe Browsing and friends register here. */
  addVerdictProvider(provider: DangerVerdictProvider): void {
    this.providers.push(provider)
  }

  item(id: string): DownloadItem | undefined {
    return this.items.find((i) => i.id === id)
  }

  get inFlight(): DownloadItem[] {
    return this.items.filter((i) => isInFlight(i.state))
  }

  // ---------------------------------------------------------------------------
  // Host reports
  // ---------------------------------------------------------------------------

  /** A transfer started; returns the record the host should keep updating. */
  begin(init: DownloadInit): DownloadItem {
    const now = this.now()
    const resumed = init.resumes ? this.item(init.resumes) : undefined
    const referrer = init.referrer ?? resumed?.referrer ?? ''
    const filename = init.filename || resumed?.filename || 'download'
    const record: DownloadItem = resumed ?? {
      id: newId('dl'),
      url: init.url,
      referrer,
      filename,
      savePath: init.savePath ?? '',
      totalBytes: init.totalBytes,
      receivedBytes: 0,
      state: 'in-progress',
      startedAt: now,
      endedAt: null,
      mimeType: init.mimeType,
      canResume: init.canResume ?? false,
      error: null,
      danger: SAFE,
      openWhenDone: false,
      bytesPerSecond: 0,
      etaMs: null,
      etag: init.etag ?? '',
      lastModified: init.lastModified ?? ''
    }
    if (resumed) {
      resumed.state = 'in-progress'
      resumed.error = null
      resumed.endedAt = null
      if (init.savePath) resumed.savePath = init.savePath
      if (init.totalBytes > 0) resumed.totalBytes = init.totalBytes
    } else {
      record.danger = classifyDownload({
        url: record.url,
        referrer,
        filename,
        mimeType: record.mimeType,
        os: this.deps.os,
        referrerFamiliar:
          init.userGesture !== false && Boolean(referrer) && this.deps.referrerFamiliar(referrer)
      })
      this.items.unshift(record)
      if (this.items.length > MAX_ITEMS) this.items.length = MAX_ITEMS
    }
    const transfer: Transfer = {
      rate: new RateEstimator(now),
      windowId: this.deps.windowForTab(init.sourceTabId ?? null)?.id ?? null,
      verdicts: null,
      abort: new AbortController(),
      completing: false
    }
    transfer.rate.reset(record.receivedBytes, now)
    this.transfers.set(record.id, transfer)
    if (!resumed && this.providers.length > 0)
      transfer.verdicts = this.askProviders(record, transfer)
    this.persist()
    this.onChange(record, 'started')
    this.applyProgressBars()
    return record
  }

  /** Progress update; broadcasts are throttled unless the state changed. */
  progress(
    id: string,
    patch: Partial<
      Pick<
        DownloadItem,
        | 'receivedBytes'
        | 'totalBytes'
        | 'savePath'
        | 'filename'
        | 'canResume'
        | 'etag'
        | 'lastModified'
        | 'mimeType'
        | 'error'
      >
    > & {
      state: Extract<DownloadState, 'in-progress' | 'paused' | 'interrupted'>
    }
  ): void {
    const record = this.item(id)
    // Finished records never come back to life; a resumable interruption does (interrupted → in-progress).
    if (!record || record.state === 'completed' || record.state === 'cancelled') return
    const transfer = this.transfers.get(id)
    const now = this.now()
    const stateChanged = record.state !== patch.state
    const { state, ...fields } = patch
    assignFields(record, fields)
    if (patch.filename) record.filename = finalName(patch.filename)
    record.state = state
    if (state === 'in-progress') record.error = null
    else if (state === 'interrupted' && !record.error) record.error = 'interrupted'
    if (transfer) {
      if (stateChanged) transfer.rate.reset(record.receivedBytes, now)
      else transfer.rate.update(record.receivedBytes, now)
      record.bytesPerSecond = state === 'in-progress' ? transfer.rate.bytesPerSecond(now) : 0
    }
    record.etaMs = estimateEta(record)
    if (stateChanged || now - this.lastPersist > 2000) this.persist()
    if (stateChanged || now - this.lastBroadcast > 250) {
      this.lastBroadcast = now
      this.onChange(record, 'progress')
      this.applyProgressBars()
    }
  }

  /** The transfer ended: completed (bytes are in the partial file), cancelled or interrupted. */
  finish(
    id: string,
    state: Extract<DownloadState, 'completed' | 'cancelled' | 'interrupted'>,
    patch: Partial<
      Pick<
        DownloadItem,
        | 'receivedBytes'
        | 'totalBytes'
        | 'savePath'
        | 'filename'
        | 'canResume'
        | 'error'
        | 'mimeType'
      >
    > = {}
  ): void {
    const record = this.item(id)
    if (!record || record.state === 'completed' || record.state === 'cancelled') return
    const transfer = this.transfers.get(id)
    assignFields(record, patch)
    if (patch.filename) record.filename = finalName(patch.filename)
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
      record.error = null
      const partial = record.savePath
      record.savePath = ''
      if (partial) void this.host.discard({ ...record, savePath: partial })
    } else if (!record.error) {
      record.error = 'interrupted'
    }
    this.persist()
    this.onChange(record, 'done')
    this.applyProgressBars()
  }

  /** Register a file we produced ourselves (e.g. a screenshot) so it shows in the panel. */
  addCompleted(savePath: string, mimeType: string): DownloadItem {
    const now = this.now()
    const record: DownloadItem = {
      id: newId('dl'),
      url: savePath.startsWith('content:') ? savePath : `file://${savePath}`,
      referrer: '',
      filename: basename(savePath),
      savePath,
      totalBytes: 0,
      receivedBytes: 0,
      state: 'completed',
      startedAt: now,
      endedAt: now,
      mimeType,
      canResume: false,
      error: null,
      danger: SAFE,
      openWhenDone: false,
      bytesPerSecond: 0,
      etaMs: null,
      etag: '',
      lastModified: ''
    }
    this.items.unshift(record)
    this.persist()
    this.onChange(record, 'done')
    return record
  }

  // ---------------------------------------------------------------------------
  // User actions
  // ---------------------------------------------------------------------------

  pause(id: string): void {
    const item = this.item(id)
    if (item?.state === 'in-progress') this.host.pause(id)
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

  /** Start over (a new record replaces the failed one, like Chrome's Retry). */
  retry(id: string): void {
    const item = this.item(id)
    if (!item || !canRetry(item)) return
    this.items = this.items.filter((i) => i.id !== id)
    if (item.savePath) void this.host.discard(item)
    this.persist()
    this.host.retry(item)
    this.onChange(item, 'done')
  }

  /** "Keep": release a flagged file from quarantine. */
  async keep(id: string): Promise<void> {
    const item = this.item(id)
    if (!item || !isQuarantined(item)) return
    const released = await this.host.release(item)
    if (released) {
      item.savePath = released.savePath
      item.filename = released.filename || item.filename
    }
    item.danger = { ...item.danger, kept: true }
    this.persist()
    this.onChange(item, 'done')
    await this.afterRelease(item)
  }

  /** "Discard" a flagged file, or delete what is left of a failed download; the record goes too. */
  async discard(id: string): Promise<void> {
    const item = this.item(id)
    if (!item) return
    if (isInFlight(item.state)) {
      this.host.cancel(id)
      return
    }
    if (item.savePath && (isQuarantined(item) || item.state === 'interrupted'))
      await this.host.discard(item)
    this.items = this.items.filter((i) => i.id !== id)
    this.persist()
    this.onChange(item, 'done')
  }

  setOpenWhenDone(id: string, open: boolean): void {
    const item = this.item(id)
    if (!item) return
    item.openWhenDone = open
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

  remove(id: string): void {
    const item = this.item(id)
    if (!item) return
    if (isInFlight(item.state)) this.host.cancel(id)
    else if (item.savePath && (isQuarantined(item) || item.state === 'interrupted'))
      void this.host.discard(item)
    this.items = this.items.filter((i) => i.id !== id)
    this.persist()
  }

  clearCompleted(): void {
    for (const item of this.items) {
      if (
        !isInFlight(item.state) &&
        item.savePath &&
        (isQuarantined(item) || item.state === 'interrupted')
      )
        void this.host.discard(item)
    }
    this.items = this.items.filter((i) => isInFlight(i.state))
    this.persist()
  }

  async chooseLocation(win?: ZenWindow): Promise<string | null> {
    return (await this.host.chooseLocation?.(win)) ?? null
  }

  /** Aggregate progress of the in-flight downloads a window owns, for its taskbar button. */
  progressFor(
    windowId: string
  ): { value: number; mode: 'normal' | 'indeterminate' | 'paused' } | null {
    const mine = this.inFlight.filter(
      (i) => (this.transfers.get(i.id)?.windowId ?? null) === windowId
    )
    if (mine.length === 0) return null
    if (mine.every((i) => i.state === 'paused')) {
      const known = mine.filter((i) => i.totalBytes > 0)
      const value = known.length
        ? sum(known, (i) => i.receivedBytes) / sum(known, (i) => i.totalBytes)
        : 0
      return { value: Math.min(1, value), mode: 'paused' }
    }
    if (mine.some((i) => i.totalBytes <= 0)) return { value: 2, mode: 'indeterminate' }
    const value = sum(mine, (i) => i.receivedBytes) / sum(mine, (i) => i.totalBytes)
    return { value: Math.min(1, value), mode: 'normal' }
  }

  private persist(): void {
    this.lastPersist = this.now()
    this.store.write({ version: SCHEMA_VERSION, items: this.items })
  }

  flushSync(): void {
    this.store.flushSync()
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

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
    record.endedAt = this.now()
    if (record.danger.level === 'safe') {
      const released = await this.host.release(record)
      if (gone()) return
      if (released) {
        record.savePath = released.savePath
        record.filename = released.filename || record.filename
      } else {
        record.state = 'interrupted'
        record.error = 'file-error'
        record.canResume = false
        this.persist()
        this.onChange(record, 'done')
        this.applyProgressBars()
        return
      }
    }
    record.state = 'completed'
    this.persist()
    this.onChange(record, 'done')
    this.applyProgressBars()
    if (record.danger.level === 'safe') await this.afterRelease(record)
  }

  private async afterRelease(record: DownloadItem): Promise<void> {
    const settings = this.deps.settings()
    const auto =
      settings.autoOpen.includes(fileExtension(record.filename)) &&
      mayAutoOpen(record.filename, this.deps.os)
    if (settings.showNotifications) this.host.notifyCompleted?.(record)
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
    const all = this.providers.map((p) =>
      p
        .verdict(request, transfer.abort.signal)
        .then((verdict) => {
          if (!verdict || verdict.level === 'safe') return
          if (this.item(record.id) !== record) return
          record.danger = worstDanger(record.danger, verdict)
          this.persist()
          this.onChange(record, 'progress')
        })
        .catch(() => undefined)
    )
    return Promise.race([Promise.all(all).then(() => undefined), timeout]).then(() => {
      if (timer) clearTimeout(timer)
    })
  }

  private applyProgressBars(): void {
    for (const win of this.deps.windows()) {
      if (!win.alive || !win.host.setProgressBar) continue
      const progress = this.progressFor(win.id)
      const key = progress ? `${progress.mode}:${progress.value.toFixed(2)}` : 'none'
      if (this.progressShown.get(win.id) === key) continue
      this.progressShown.set(win.id, key)
      if (progress) win.host.setProgressBar(progress.value, progress.mode)
      else win.host.setProgressBar(-1)
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isInFlight(state: DownloadState): boolean {
  return state === 'in-progress' || state === 'paused'
}

/** A finished download whose file is held back behind a danger warning. */
export function isQuarantined(item: DownloadItem): boolean {
  return item.state === 'completed' && item.danger.level !== 'safe' && !item.danger.kept
}

/** Failed or cancelled downloads can be started over, except `blob:` ones (the page's object is gone). */
export function canRetry(item: DownloadItem): boolean {
  return (
    (item.state === 'cancelled' || item.state === 'interrupted') && !item.url.startsWith('blob:')
  )
}

export function estimateEta(item: DownloadItem): number | null {
  if (item.state !== 'in-progress' || item.totalBytes <= 0 || item.bytesPerSecond <= 0) return null
  const remaining = Math.max(0, item.totalBytes - item.receivedBytes)
  return Math.round((remaining / item.bytesPerSecond) * 1000)
}

function sum(items: DownloadItem[], pick: (i: DownloadItem) => number): number {
  return items.reduce((a, i) => a + pick(i), 0)
}

/** Copy the defined fields of a host patch onto the record. */
function assignFields(record: DownloadItem, patch: Partial<DownloadItem>): void {
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
  const savePath = str(raw['savePath'])
  return {
    id: str(raw['id']),
    url: str(raw['url']),
    referrer: '',
    filename: str(raw['filename']) || 'download',
    savePath,
    totalBytes: num(raw['totalBytes']),
    receivedBytes: num(raw['receivedBytes']),
    state: finalState,
    startedAt: num(raw['startedAt']) || now,
    endedAt: num(raw['startedAt']) || now,
    mimeType: str(raw['mimeType']),
    canResume: false,
    error: finalState === 'interrupted' ? (inFlight ? 'shutdown' : 'interrupted') : null,
    danger: SAFE,
    openWhenDone: false,
    bytesPerSecond: 0,
    etaMs: null,
    etag: '',
    lastModified: ''
  }
}

function fromV2(raw: Record<string, unknown>, now: number): DownloadItem | null {
  const state = raw['state']
  const inFlight = state === 'in-progress' || state === 'paused'
  const finalState: DownloadState =
    state === 'completed' || state === 'cancelled' || state === 'interrupted'
      ? state
      : 'interrupted'
  const danger = raw['danger'] as Partial<DownloadDanger> | undefined
  const savePath = str(raw['savePath'])
  return {
    id: str(raw['id']),
    url: str(raw['url']),
    referrer: str(raw['referrer']),
    filename: str(raw['filename']) || 'download',
    savePath,
    totalBytes: num(raw['totalBytes']),
    receivedBytes: num(raw['receivedBytes']),
    state: finalState,
    startedAt: num(raw['startedAt']) || now,
    endedAt: typeof raw['endedAt'] === 'number' ? raw['endedAt'] : inFlight ? now : null,
    mimeType: str(raw['mimeType']),
    canResume: Boolean(raw['canResume']) && finalState === 'interrupted' && savePath !== '',
    error:
      finalState === 'interrupted'
        ? inFlight
          ? 'shutdown'
          : typeof raw['error'] === 'string'
            ? raw['error']
            : 'interrupted'
        : null,
    danger:
      danger && (danger.level === 'suspicious' || danger.level === 'dangerous')
        ? {
            level: danger.level,
            reason: danger.reason ?? 'file-type',
            ...(danger.kept ? { kept: true } : {})
          }
        : SAFE,
    openWhenDone: Boolean(raw['openWhenDone']),
    bytesPerSecond: 0,
    etaMs: null,
    etag: str(raw['etag']),
    lastModified: str(raw['lastModified'])
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
