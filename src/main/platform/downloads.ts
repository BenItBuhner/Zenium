import {
  app,
  shell,
  type DownloadItem as ElectronDownloadItem,
  type Session,
  type WebContents
} from 'electron'
import { basename, join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import type { DownloadItem } from '../../shared/types'
import type { DownloadHost } from '../../core/platform'
import type { DownloadService } from '../../core/downloads'
import { uniquePath } from './uniquePath'

export { uniquePath } from './uniquePath'

/** The Downloads folder; Electron falls back to $HOME when the XDG dir is missing, so create it. */
export function downloadDir(): string {
  let dir = app.getPath('downloads')
  if (!dir || dir === app.getPath('home')) dir = join(app.getPath('home'), 'Downloads')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Tracks Electron's download items and feeds the core's `DownloadService`. Zen saves straight
 * into the Downloads folder unless "always ask where to save" is on.
 */
export class ElectronDownloads implements DownloadHost {
  private readonly live = new Map<string, ElectronDownloadItem>()
  private readonly tracked = new WeakSet<ElectronDownloadItem>()
  private readonly reserved = new Set<string>()
  private service: DownloadService | null = null

  constructor(private readonly askWhereToSave: () => boolean) {}

  bind(service: DownloadService): void {
    this.service = service
  }

  attach(ses: Session, onStarted: (source: WebContents | undefined) => void): void {
    ses.on('will-download', (_event, item, source) => {
      this.track(item)
      onStarted(source)
    })
  }

  private track(item: ElectronDownloadItem): void {
    const service = this.service
    if (!service || this.tracked.has(item)) return
    this.tracked.add(item)
    // Without a save path Electron shows the OS save dialog; Zen saves to Downloads by default.
    // Paths of in-flight downloads are reserved so simultaneous downloads never share a file.
    let reservedPath: string | null = null
    if (!this.askWhereToSave() && !item.getSavePath()) {
      reservedPath = uniquePath(
        downloadDir(),
        item.getFilename() || 'download',
        (p) => existsSync(p) || this.reserved.has(p)
      )
      this.reserved.add(reservedPath)
      item.setSavePath(reservedPath)
    }
    const record = service.begin({
      url: item.getURL(),
      filename: item.getFilename(),
      totalBytes: item.getTotalBytes(),
      mimeType: item.getMimeType()
    })
    this.live.set(record.id, item)

    const fileFields = (): Pick<
      DownloadItem,
      'receivedBytes' | 'totalBytes' | 'savePath' | 'filename'
    > => {
      const savePath = item.getSavePath()
      return {
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        savePath,
        filename: savePath ? basename(savePath) : item.getFilename()
      }
    }
    item.on('updated', (_e, state) => {
      service.progress(record.id, {
        ...fileFields(),
        state: state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing'
      })
    })
    item.once('done', (_e, state) => {
      if (reservedPath) this.reserved.delete(reservedPath)
      this.live.delete(record.id)
      service.finish(
        record.id,
        state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted',
        fileFields()
      )
    })
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

  showInFolder(item: DownloadItem): void {
    if (item.savePath && existsSync(item.savePath)) shell.showItemInFolder(item.savePath)
  }

  async open(item: DownloadItem): Promise<void> {
    if (item.savePath && existsSync(item.savePath)) await shell.openPath(item.savePath)
  }
}
