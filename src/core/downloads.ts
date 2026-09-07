import type { DownloadItem, DownloadState } from '../shared/types'
import { newId } from '../shared/ids'
import { JsonStore } from './store/JsonStore'
import type { DownloadHost, StoreIO } from './platform'

interface Persisted {
  version: 1
  items: DownloadItem[]
}

const MAX_ITEMS = 100

export interface DownloadInit {
  url: string
  filename: string
  totalBytes: number
  mimeType: string
  savePath?: string
}

/**
 * The downloads list Zen shows in its panel. Records and their persistence live here; the host
 * owns the actual transfers and reports progress through `begin` / `progress` / `finish`.
 */
export class DownloadService {
  items: DownloadItem[] = []
  private readonly store: JsonStore<Persisted>
  private lastBroadcast = 0

  constructor(
    io: StoreIO,
    private readonly host: DownloadHost,
    private readonly onChange: (item: DownloadItem, kind: 'started' | 'progress' | 'done') => void
  ) {
    this.store = new JsonStore<Persisted>(io, 'downloads.json', 1000)
    const data = this.store.readSync()
    if (data?.version === 1 && Array.isArray(data.items)) {
      // Anything that was in flight when we quit is now interrupted.
      this.items = data.items.map((i) =>
        i.state === 'progressing' || i.state === 'paused' ? { ...i, state: 'interrupted' } : i
      )
    }
  }

  /** A transfer started; returns the record the host should keep updating. */
  begin(init: DownloadInit): DownloadItem {
    const record: DownloadItem = {
      id: newId('dl'),
      url: init.url,
      filename: init.filename || 'download',
      savePath: init.savePath ?? '',
      totalBytes: init.totalBytes,
      receivedBytes: 0,
      state: 'progressing',
      startedAt: Date.now(),
      mimeType: init.mimeType
    }
    this.items.unshift(record)
    if (this.items.length > MAX_ITEMS) this.items.length = MAX_ITEMS
    this.persist()
    this.onChange(record, 'started')
    return record
  }

  /** Progress update; broadcasts are throttled unless the state changed. */
  progress(
    id: string,
    patch: Partial<Pick<DownloadItem, 'receivedBytes' | 'totalBytes' | 'savePath' | 'filename'>> & {
      state: Extract<DownloadState, 'progressing' | 'paused' | 'interrupted'>
    }
  ): void {
    const record = this.items.find((i) => i.id === id)
    if (!record) return
    const stateChanged = record.state !== patch.state
    Object.assign(record, patch)
    const now = Date.now()
    if (stateChanged || now - this.lastBroadcast > 250) {
      this.lastBroadcast = now
      this.onChange(record, 'progress')
    }
  }

  finish(
    id: string,
    state: Extract<DownloadState, 'completed' | 'cancelled' | 'interrupted'>,
    patch: Partial<
      Pick<DownloadItem, 'receivedBytes' | 'totalBytes' | 'savePath' | 'filename'>
    > = {}
  ): void {
    const record = this.items.find((i) => i.id === id)
    if (!record) return
    Object.assign(record, patch)
    record.state = state
    this.persist()
    this.onChange(record, 'done')
  }

  /** Register a file we produced ourselves (e.g. a screenshot) so it shows in the panel. */
  addCompleted(savePath: string, mimeType: string): DownloadItem {
    const record: DownloadItem = {
      id: newId('dl'),
      url: savePath.startsWith('content:') ? savePath : `file://${savePath}`,
      filename: basename(savePath),
      savePath,
      totalBytes: 0,
      receivedBytes: 0,
      state: 'completed',
      startedAt: Date.now(),
      mimeType
    }
    this.items.unshift(record)
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

  showInFolder(id: string): void {
    const item = this.items.find((i) => i.id === id)
    if (item?.savePath) this.host.showInFolder(item)
  }

  async open(id: string): Promise<void> {
    const item = this.items.find((i) => i.id === id)
    if (item?.savePath) await this.host.open(item)
  }

  remove(id: string): void {
    this.host.cancel(id)
    this.items = this.items.filter((i) => i.id !== id)
    this.persist()
  }

  clearCompleted(): void {
    this.items = this.items.filter((i) => i.state === 'progressing' || i.state === 'paused')
    this.persist()
  }

  private persist(): void {
    this.store.write({ version: 1, items: this.items })
  }

  flushSync(): void {
    this.store.flushSync()
  }
}

export function basename(path: string): string {
  const clean = path.replace(/[\\/]+$/, '')
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  return idx === -1 ? clean : clean.slice(idx + 1)
}
