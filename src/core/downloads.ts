import type { DownloadInterruptReason, DownloadItem, DownloadState } from '../shared/types'
import { newId } from '../shared/ids'
import {
  DOWNLOADS_STORE_VERSION,
  SpeedEstimator,
  aggregateProgress,
  classifyDownloadDanger,
  isActiveDownload,
  migrateDownloads,
  needsDangerDecision,
  safeFilename,
  type AggregateProgress
} from '../shared/downloads'
import { JsonStore } from './store/JsonStore'
import type { DownloadHost, StoreIO } from './platform'

interface Persisted {
  version: typeof DOWNLOADS_STORE_VERSION
  items: DownloadItem[]
}

const MAX_ITEMS = 100
/** In-flight records are written this often so a crash keeps most of the received count. */
const PROGRESS_PERSIST_MS = 5000
const BROADCAST_MS = 250

export interface DownloadInit {
  url: string
  urlChain?: string[]
  referrer?: string
  filename: string
  totalBytes: number
  mimeType: string
  savePath?: string
  etag?: string
  lastModified?: string
  /** Bytes already on disk when a transfer resumes. */
  receivedBytes?: number
  startedAt?: number
}

export type DownloadChangeKind = 'started' | 'progress' | 'done' | 'list'

export type DownloadProgressPatch = Partial<
  Pick<
    DownloadItem,
    'receivedBytes' | 'totalBytes' | 'savePath' | 'filename' | 'canResume' | 'etag' | 'lastModified'
  >
> & { state: Extract<DownloadState, 'progressing' | 'paused' | 'interrupted'> }

export type DownloadFinishPatch = Partial<
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
  >
> & { interruptReason?: DownloadInterruptReason }

/**
 * The downloads list Zen shows in its bubble and on the downloads page. Records and their
 * persistence live here; the host owns the actual transfers and reports them through `begin` /
 * `restart` / `progress` / `finish`. Aggregate progress for the taskbar or dock is derived here
 * and pushed to the host whenever it changes.
 */
export class DownloadService {
  items: DownloadItem[] = []
  private readonly store: JsonStore<Persisted>
  private readonly speeds = new Map<string, SpeedEstimator>()
  private lastBroadcast = 0
  private lastProgressPersist = 0
  /** A transfer failed and nobody has looked at the list since (drives the error indicator). */
  private undismissedFailure = false
  private lastProgress: AggregateProgress = { mode: 'idle', value: 0 }

  constructor(
    io: StoreIO,
    private readonly host: DownloadHost,
    private readonly onChange: (item: DownloadItem | null, kind: DownloadChangeKind) => void
  ) {
    this.store = new JsonStore<Persisted>(io, 'downloads.json', 1000)
    const raw = this.store.readSync()
    this.items = migrateDownloads(raw)
    // Rewrite older documents and interrupted transfers in the current shape straight away.
    if (raw && (raw as { version?: unknown }).version !== DOWNLOADS_STORE_VERSION) this.persist()
  }

  /** The record with this id, if it is still in the list. */
  get(id: string): DownloadItem | undefined {
    return this.items.find((i) => i.id === id)
  }

  /** Records that are downloading or paused. */
  active(): DownloadItem[] {
    return this.items.filter(isActiveDownload)
  }

  /** A transfer started; returns the record the host should keep updating. */
  begin(init: DownloadInit): DownloadItem {
    const record = this.recordFor(newId('dl'), init)
    this.items.unshift(record)
    this.trim()
    this.speeds.set(record.id, new SpeedEstimator())
    this.undismissedFailure = false
    this.persist()
    this.onChange(record, 'started')
    this.pushProgress()
    return record
  }

  /**
   * A retry of an existing record began (resumed at `init.receivedBytes` or from scratch). The
   * record keeps its id so the row stays where the user clicked; it moves to the top like a new
   * download. Falls back to `begin` when the record was removed meanwhile.
   */
  restart(id: string, init: DownloadInit): DownloadItem {
    const existing = this.get(id)
    if (!existing) return this.begin(init)
    const fresh = this.recordFor(id, init)
    fresh.danger = existing.danger
    fresh.referrer = init.referrer ?? existing.referrer
    Object.assign(existing, fresh)
    delete existing.interruptReason
    delete existing.endedAt
    delete existing.dangerDecision
    delete existing.opened
    if (!init.etag) delete existing.etag
    if (!init.lastModified) delete existing.lastModified
    this.items = [existing, ...this.items.filter((i) => i.id !== id)]
    const speed = new SpeedEstimator()
    speed.reset(existing.receivedBytes, existing.startedAt)
    this.speeds.set(id, speed)
    this.undismissedFailure = false
    this.persist()
    this.onChange(existing, 'started')
    this.pushProgress()
    return existing
  }

  /** Progress update; broadcasts are throttled unless the state changed. */
  progress(id: string, patch: DownloadProgressPatch, now = Date.now()): void {
    const record = this.get(id)
    if (!record) return
    const stateChanged = record.state !== patch.state
    const { state, ...fields } = patch
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) (record as unknown as Record<string, unknown>)[key] = value
    }
    record.state = state
    if (state === 'progressing') {
      const speed = this.speeds.get(id) ?? new SpeedEstimator()
      this.speeds.set(id, speed)
      if (stateChanged) speed.reset(record.receivedBytes, now)
      record.bytesPerSecond = speed.sample(record.receivedBytes, now)
    } else {
      this.speeds.get(id)?.reset(record.receivedBytes, now)
      record.bytesPerSecond = 0
    }
    if (stateChanged || now - this.lastProgressPersist > PROGRESS_PERSIST_MS) {
      this.lastProgressPersist = now
      this.persist()
    }
    if (stateChanged || now - this.lastBroadcast > BROADCAST_MS) {
      this.lastBroadcast = now
      this.onChange(record, 'progress')
    }
    this.pushProgress()
  }

  finish(
    id: string,
    state: Extract<DownloadState, 'completed' | 'cancelled' | 'interrupted'>,
    patch: DownloadFinishPatch = {},
    now = Date.now()
  ): void {
    const record = this.get(id)
    if (!record) return
    const { interruptReason, ...fields } = patch
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) (record as unknown as Record<string, unknown>)[key] = value
    }
    record.state = state
    record.endedAt = now
    record.bytesPerSecond = 0
    this.speeds.delete(id)
    if (state === 'interrupted') {
      record.canResume = patch.canResume ?? record.canResume
      record.interruptReason = interruptReason ?? (record.canResume ? 'network' : 'unknown')
      this.undismissedFailure = true
    } else {
      record.canResume = false
      delete record.interruptReason
      if (state === 'completed' && record.totalBytes <= 0) record.totalBytes = record.receivedBytes
      if (state === 'completed' && record.totalBytes > 0) record.receivedBytes = record.totalBytes
    }
    if (record.filename) record.danger = this.classify(record.filename, record.mimeType)
    this.persist()
    this.onChange(record, 'done')
    this.pushProgress()
  }

  /** Register a file we produced ourselves (e.g. a screenshot) so it shows in the list. */
  addCompleted(savePath: string, mimeType: string): DownloadItem {
    const url = savePath.startsWith('content:') ? savePath : `file://${savePath}`
    const now = Date.now()
    const record: DownloadItem = {
      id: newId('dl'),
      url,
      urlChain: [url],
      referrer: '',
      filename: basename(savePath),
      savePath,
      mimeType,
      totalBytes: 0,
      receivedBytes: 0,
      bytesPerSecond: 0,
      state: 'completed',
      canResume: false,
      danger: 'safe',
      startedAt: now,
      endedAt: now
    }
    this.items.unshift(record)
    this.trim()
    this.persist()
    this.onChange(record, 'done')
    return record
  }

  pause(id: string): void {
    this.host.pause(id)
  }

  resume(id: string): void {
    this.host.resume(id)
  }

  cancel(id: string): void {
    this.host.cancel(id)
  }

  /** Interrupted or cancelled: hand the record back to the host to fetch it again. */
  retry(id: string): void {
    const record = this.get(id)
    if (!record || isActiveDownload(record) || record.state === 'completed') return
    if (!this.host.retry) return
    this.undismissedFailure = false
    this.host.retry(record)
    this.pushProgress()
  }

  /** The user looked at the list: a failed transfer no longer needs the error indicator. */
  acknowledge(): void {
    if (!this.undismissedFailure) return
    this.undismissedFailure = false
    this.pushProgress()
  }

  keep(id: string): void {
    const record = this.get(id)
    if (!record || record.danger === 'safe') return
    record.dangerDecision = 'kept'
    this.persist()
    this.onChange(record, 'list')
  }

  async discard(id: string): Promise<void> {
    const record = this.get(id)
    if (!record || record.danger === 'safe' || record.dangerDecision === 'discarded') return
    await this.deleteFile(record)
    record.dangerDecision = 'discarded'
    this.persist()
    this.onChange(record, 'list')
  }

  showInFolder(id: string): void {
    const item = this.get(id)
    if (item?.savePath && item.dangerDecision !== 'discarded') this.host.showInFolder(item)
  }

  async open(id: string): Promise<void> {
    const item = this.get(id)
    if (!item?.savePath || item.state !== 'completed') return
    if (needsDangerDecision(item) || item.dangerDecision === 'discarded') return
    item.opened = true
    this.persist()
    this.onChange(item, 'list')
    await this.host.open(item)
  }

  remove(id: string): void {
    const item = this.get(id)
    if (!item) return
    if (isActiveDownload(item)) this.host.cancel(id)
    // A dangerous file nobody kept leaves with its row, like Chrome's discard.
    if (needsDangerDecision(item)) void this.deleteFile(item).catch(() => undefined)
    this.items = this.items.filter((i) => i.id !== id)
    this.speeds.delete(id)
    this.persist()
    this.onChange(null, 'list')
    this.pushProgress()
  }

  clearCompleted(): void {
    for (const item of this.items) {
      if (needsDangerDecision(item)) void this.deleteFile(item).catch(() => undefined)
    }
    this.items = this.items.filter(isActiveDownload)
    this.undismissedFailure = false
    this.persist()
    this.onChange(null, 'list')
    this.pushProgress()
  }

  /** The current taskbar / dock value (what the host was last told). */
  osProgress(): AggregateProgress {
    return this.lastProgress
  }

  private recordFor(id: string, init: DownloadInit): DownloadItem {
    const filename = safeFilename(init.filename)
    const startedAt = init.startedAt ?? Date.now()
    const record: DownloadItem = {
      id,
      url: init.url,
      urlChain: init.urlChain?.length ? init.urlChain : [init.url],
      referrer: init.referrer ?? '',
      filename,
      savePath: init.savePath ?? '',
      mimeType: init.mimeType,
      totalBytes: init.totalBytes,
      receivedBytes: init.receivedBytes ?? 0,
      bytesPerSecond: 0,
      state: 'progressing',
      canResume: false,
      danger: this.classify(filename, init.mimeType),
      startedAt
    }
    if (init.etag) record.etag = init.etag
    if (init.lastModified) record.lastModified = init.lastModified
    return record
  }

  private classify(filename: string, mimeType: string): DownloadItem['danger'] {
    return this.host.deleteFile ? classifyDownloadDanger(filename, mimeType) : 'safe'
  }

  private async deleteFile(item: DownloadItem): Promise<void> {
    if (this.host.deleteFile) await this.host.deleteFile(item)
  }

  /** Keep the list bounded without ever dropping a live transfer. */
  private trim(): void {
    if (this.items.length <= MAX_ITEMS) return
    const kept: DownloadItem[] = []
    let inactive = 0
    const budget = MAX_ITEMS - this.items.filter(isActiveDownload).length
    for (const item of this.items) {
      if (isActiveDownload(item)) kept.push(item)
      else if (inactive < budget) {
        kept.push(item)
        inactive++
      }
    }
    this.items = kept
  }

  private pushProgress(): void {
    const next = aggregateProgress(this.items, { undismissedFailure: this.undismissedFailure })
    const last = this.lastProgress
    if (last.mode === next.mode && Math.round(last.value * 100) === Math.round(next.value * 100))
      return
    this.lastProgress = next
    this.host.setProgress?.(next)
  }

  private persist(): void {
    this.store.write({ version: DOWNLOADS_STORE_VERSION, items: this.items })
  }

  flushSync(): void {
    // Whatever is in flight will be interrupted by the time we are back; say so on disk.
    if (this.items.some(isActiveDownload)) this.persist()
    this.store.flushSync()
  }
}

export function basename(path: string): string {
  const clean = path.replace(/[\\/]+$/, '')
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  return idx === -1 ? clean : clean.slice(idx + 1)
}
