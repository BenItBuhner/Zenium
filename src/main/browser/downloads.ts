import {
  app,
  shell,
  type DownloadItem as ElectronDownloadItem,
  type Session,
  type WebContents
} from 'electron'
import { basename, extname, join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import type { DownloadItem } from '../../shared/types'
import { newId } from '../../shared/ids'
import { JsonStore } from '../store/JsonStore'

interface Persisted {
  version: 1
  items: DownloadItem[]
}

const MAX_ITEMS = 100

/** The Downloads folder; Electron falls back to $HOME when the XDG dir is missing, so create it. */
function downloadDir(): string {
  let dir = app.getPath('downloads')
  if (!dir || dir === app.getPath('home')) dir = join(app.getPath('home'), 'Downloads')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** `file.txt` → `file(1).txt`, `file(2).txt`, … until the name is free (Firefox style). */
export function uniquePath(dir: string, filename: string): string {
  const ext = extname(filename)
  const stem = filename.slice(0, filename.length - ext.length)
  let candidate = join(dir, filename)
  for (let n = 1; existsSync(candidate); n++) candidate = join(dir, `${stem}(${n})${ext}`)
  return candidate
}

export class DownloadService {
  items: DownloadItem[] = []
  private readonly live = new Map<string, ElectronDownloadItem>()
  private readonly store: JsonStore<Persisted>
  private lastBroadcast = 0

  constructor(
    userDataDir: string,
    private readonly askWhereToSave: () => boolean,
    private readonly onChange: (item: DownloadItem, kind: 'started' | 'progress' | 'done') => void
  ) {
    this.store = new JsonStore<Persisted>(join(userDataDir, 'zen', 'downloads.json'), 1000)
    const data = this.store.readSync()
    if (data?.version === 1 && Array.isArray(data.items)) {
      // Anything that was in flight when we quit is now interrupted.
      this.items = data.items.map((i) =>
        i.state === 'progressing' || i.state === 'paused' ? { ...i, state: 'interrupted' } : i
      )
    }
  }

  attach(ses: Session, onStarted?: (source: WebContents | undefined) => void): void {
    ses.on('will-download', (_event, item, source) => {
      this.track(item)
      onStarted?.(source)
    })
  }

  private track(item: ElectronDownloadItem): void {
    // Without a save path Electron shows the OS save dialog; Zen saves to Downloads by default.
    if (!this.askWhereToSave() && !item.getSavePath()) {
      item.setSavePath(uniquePath(downloadDir(), item.getFilename() || 'download'))
    }
    const id = newId('dl')
    const record: DownloadItem = {
      id,
      url: item.getURL(),
      filename: item.getFilename(),
      savePath: '',
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      state: 'progressing',
      startedAt: Date.now(),
      mimeType: item.getMimeType()
    }
    this.live.set(id, item)
    this.items.unshift(record)
    if (this.items.length > MAX_ITEMS) this.items.length = MAX_ITEMS
    this.persist()
    this.onChange(record, 'started')

    item.on('updated', (_e, state) => {
      record.receivedBytes = item.getReceivedBytes()
      record.totalBytes = item.getTotalBytes()
      record.savePath = item.getSavePath()
      record.filename = record.savePath ? basename(record.savePath) : item.getFilename()
      record.state =
        state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing'
      const now = Date.now()
      if (now - this.lastBroadcast > 250 || state === 'interrupted') {
        this.lastBroadcast = now
        this.onChange(record, 'progress')
      }
    })
    item.once('done', (_e, state) => {
      record.receivedBytes = item.getReceivedBytes()
      record.totalBytes = item.getTotalBytes()
      record.savePath = item.getSavePath()
      record.filename = record.savePath ? basename(record.savePath) : item.getFilename()
      record.state =
        state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'
      this.live.delete(id)
      this.persist()
      this.onChange(record, 'done')
    })
  }

  /** Register a file we produced ourselves (e.g. a screenshot) so it shows in the panel. */
  addCompleted(savePath: string, mimeType: string): DownloadItem {
    const record: DownloadItem = {
      id: newId('dl'),
      url: `file://${savePath}`,
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
    this.live.get(id)?.pause()
  }

  resume(id: string): void {
    const item = this.live.get(id)
    if (item?.canResume()) item.resume()
  }

  cancel(id: string): void {
    this.live.get(id)?.cancel()
  }

  showInFolder(id: string): void {
    const item = this.items.find((i) => i.id === id)
    if (item?.savePath && existsSync(item.savePath)) shell.showItemInFolder(item.savePath)
  }

  async open(id: string): Promise<void> {
    const item = this.items.find((i) => i.id === id)
    if (item?.savePath && existsSync(item.savePath)) await shell.openPath(item.savePath)
  }

  remove(id: string): void {
    this.cancel(id)
    this.items = this.items.filter((i) => i.id !== id)
    this.persist()
  }

  clearCompleted(): void {
    this.items = this.items.filter((i) => i.state === 'progressing' || i.state === 'paused')
    this.persist()
  }

  static defaultDirectory(): string {
    return app.getPath('downloads')
  }

  private persist(): void {
    this.store.write({ version: 1, items: this.items })
  }

  flushSync(): void {
    this.store.flushSync()
  }
}
