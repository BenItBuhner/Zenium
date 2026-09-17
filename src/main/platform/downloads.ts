import {
  BrowserWindow,
  Notification,
  app,
  dialog,
  nativeImage,
  shell,
  type DownloadItem as ElectronDownloadItem,
  type Session,
  type WebContents
} from 'electron'
import { basename, join } from 'node:path'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import type { DownloadItem, Settings } from '../../shared/types'
import { safeFilename, uniqueName, type AggregateProgress } from '../../shared/downloads'
import type { DownloadHost } from '../../core/platform'
import type { DownloadInit, DownloadService } from '../../core/downloads'
import type { ZenWindow } from '../../core/window'
import type { ElectronWindow } from './window'
import appIcon from '../../../resources/icon.png?asset'

export { uniquePath } from './uniquePath'

/** The Downloads folder; Electron falls back to $HOME when the XDG dir is missing, so create it. */
export function downloadDir(): string {
  let dir = app.getPath('downloads')
  if (!dir || dir === app.getPath('home')) dir = join(app.getPath('home'), 'Downloads')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A retry the core asked for; matched against the `will-download` it produces. */
interface PendingRetry {
  id: string
  url: string
  path: string
  /** Bytes already on disk that the transfer continues from (0 for a fresh fetch). */
  offset: number
}

/** `BrowserWindow.setProgressBar` arguments for an aggregate value. */
export function progressBarFor(progress: AggregateProgress): {
  value: number
  mode: 'none' | 'normal' | 'indeterminate' | 'error' | 'paused'
} {
  switch (progress.mode) {
    case 'idle':
      return { value: -1, mode: 'none' }
    case 'normal':
      return { value: progress.value, mode: 'normal' }
    case 'paused':
      return { value: progress.value, mode: 'paused' }
    case 'indeterminate':
      return { value: 2, mode: 'indeterminate' }
    case 'error':
      return { value: 1, mode: 'error' }
  }
}

/**
 * Tracks Electron's download items and feeds the core's `DownloadService`. Zenium saves straight
 * into the downloads folder (Settings, else the system one) under a unique `name (1).ext` unless
 * "ask where to save" is on. Retries resume the partial file through
 * `session.createInterruptedDownload` when the record allows it and fetch afresh otherwise; the
 * aggregate progress lands on every window's taskbar entry.
 */
export class ElectronDownloads implements DownloadHost {
  private readonly live = new Map<string, ElectronDownloadItem>()
  private readonly tracked = new WeakSet<ElectronDownloadItem>()
  private readonly reserved = new Set<string>()
  private readonly pendingRetries: PendingRetry[] = []
  private service: DownloadService | null = null
  private retrySession: Session | null = null
  private directory: string | null = null

  constructor(private readonly settings: () => Pick<Settings, 'askWhereToSave' | 'downloads'>) {}

  bind(service: DownloadService): void {
    this.service = service
  }

  attach(ses: Session, onStarted: (source: WebContents | undefined) => void): void {
    // Retries go through the first (default) session; private sessions come and go.
    this.retrySession ??= ses
    ses.on('will-download', (_event, item, source) => {
      const retry = this.takeRetry(item)
      if (retry) {
        this.trackRetry(item, retry)
        return
      }
      this.track(item, source)
      onStarted(source)
    })
  }

  private track(item: ElectronDownloadItem, source: WebContents | undefined): void {
    const service = this.service
    if (!service || this.tracked.has(item)) return
    this.tracked.add(item)
    const dir = this.directoryForNew()
    const filename = safeFilename(item.getFilename() || 'download')
    // Without a save path Electron shows the OS save dialog; the default is the downloads folder
    // and a name no finished or in-flight download already uses.
    let reservedPath: string | null = null
    if (this.settings().askWhereToSave) {
      item.setSaveDialogOptions({ defaultPath: join(dir, filename) })
    } else if (!item.getSavePath()) {
      const name = uniqueName(filename, (candidate) => {
        const path = join(dir, candidate)
        return existsSync(path) || this.reserved.has(path)
      })
      reservedPath = join(dir, name)
      this.reserved.add(reservedPath)
      item.setSavePath(reservedPath)
    }
    const referrer = source && !source.isDestroyed() ? source.getURL() : ''
    const record = service.begin({ ...this.initFor(item), referrer })
    this.watch(item, record.id, reservedPath)
  }

  private trackRetry(item: ElectronDownloadItem, retry: PendingRetry): void {
    const service = this.service
    if (!service || this.tracked.has(item)) return
    this.tracked.add(item)
    if (!item.getSavePath()) item.setSavePath(retry.path)
    const record = service.restart(retry.id, {
      ...this.initFor(item),
      savePath: retry.path,
      filename: basename(retry.path),
      receivedBytes: retry.offset
    })
    this.watch(item, record.id, retry.path)
    // Items made by createInterruptedDownload wait for resume(); downloadURL ones are running.
    if (item.getState() === 'interrupted') item.resume()
  }

  private initFor(item: ElectronDownloadItem): DownloadInit {
    const savePath = item.getSavePath()
    return {
      url: item.getURL(),
      urlChain: item.getURLChain(),
      filename: savePath ? basename(savePath) : item.getFilename(),
      totalBytes: item.getTotalBytes(),
      mimeType: item.getMimeType(),
      savePath,
      etag: item.getETag() || undefined,
      lastModified: item.getLastModifiedTime() || undefined,
      receivedBytes: item.getReceivedBytes(),
      startedAt: Math.round(item.getStartTime() * 1000) || Date.now()
    }
  }

  private watch(item: ElectronDownloadItem, id: string, reservedPath: string | null): void {
    const service = this.service
    if (!service) return
    this.live.set(id, item)
    const fields = (): Pick<
      DownloadItem,
      | 'receivedBytes'
      | 'totalBytes'
      | 'savePath'
      | 'filename'
      | 'canResume'
      | 'etag'
      | 'lastModified'
    > => {
      const savePath = item.getSavePath()
      return {
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        savePath,
        filename: savePath ? basename(savePath) : item.getFilename(),
        canResume: item.canResume(),
        etag: item.getETag() || undefined,
        lastModified: item.getLastModifiedTime() || undefined
      }
    }
    item.on('updated', (_e, state) => {
      service.progress(id, {
        ...fields(),
        state: state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing'
      })
    })
    item.once('done', (_e, state) => {
      if (reservedPath) this.reserved.delete(reservedPath)
      this.live.delete(id)
      const final =
        state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'
      const partial = fields()
      // Electron reports no reason; a partial file that can continue points at the network.
      const interruptReason =
        final === 'interrupted'
          ? partial.canResume || partial.receivedBytes > 0
            ? 'network'
            : 'server'
          : undefined
      service.finish(id, final, {
        ...partial,
        mimeType: item.getMimeType() || undefined,
        interruptReason
      })
    })
  }

  private takeRetry(item: ElectronDownloadItem): PendingRetry | null {
    const savePath = item.getSavePath()
    const url = item.getURL()
    const first = item.getURLChain()[0]
    const index = this.pendingRetries.findIndex(
      (p) => (savePath && p.path === savePath) || p.url === url || p.url === first
    )
    return index === -1 ? null : (this.pendingRetries.splice(index, 1)[0] ?? null)
  }

  // ---------------------------------------------------------------------------
  // DownloadHost
  // ---------------------------------------------------------------------------

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

  retry(record: DownloadItem): void {
    const live = this.live.get(record.id)
    if (live) {
      if (live.canResume()) live.resume()
      return
    }
    const ses = this.retrySession
    if (!ses || !record.url) return
    const path = record.savePath || join(this.directoryForNew(), record.filename)
    const onDisk = record.savePath && existsSync(record.savePath) ? fileSize(record.savePath) : 0
    if (record.canResume && onDisk > 0 && record.urlChain.length > 0) {
      this.pendingRetries.push({ id: record.id, url: record.url, path, offset: onDisk })
      ses.createInterruptedDownload({
        path,
        urlChain: record.urlChain,
        mimeType: record.mimeType || undefined,
        offset: onDisk,
        length: record.totalBytes,
        lastModified: record.lastModified,
        eTag: record.etag,
        startTime: Math.floor(record.startedAt / 1000)
      })
      return
    }
    // A fresh fetch reuses the name: whatever the failed attempt left behind is ours to drop.
    if (onDisk > 0 || existsSync(path)) rmSync(path, { force: true })
    this.pendingRetries.push({ id: record.id, url: record.url, path, offset: 0 })
    ses.downloadURL(record.url)
  }

  showInFolder(item: DownloadItem): void {
    if (item.savePath && existsSync(item.savePath)) shell.showItemInFolder(item.savePath)
  }

  async open(item: DownloadItem): Promise<void> {
    if (item.savePath && existsSync(item.savePath)) await shell.openPath(item.savePath)
  }

  async deleteFile(item: DownloadItem): Promise<void> {
    if (!item.savePath || !existsSync(item.savePath)) return
    try {
      await shell.trashItem(item.savePath)
    } catch {
      await unlink(item.savePath)
    }
  }

  defaultDirectory(): string {
    this.directory ??= downloadDir()
    return this.directory
  }

  openDirectory(path: string): void {
    if (!existsSync(path)) mkdirSync(path, { recursive: true })
    void shell.openPath(path)
  }

  async chooseDirectory(win: ZenWindow): Promise<string | null> {
    const bw = browserWindowOf(win)
    const options: Electron.OpenDialogOptions = {
      title: 'Choose where downloads are saved',
      defaultPath: this.directoryForNew(),
      properties: ['openDirectory', 'createDirectory']
    }
    const result = bw
      ? await dialog.showOpenDialog(bw, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }

  startFileDrag(item: DownloadItem, win: ZenWindow): void {
    const bw = browserWindowOf(win)
    if (!bw || !item.savePath || !existsSync(item.savePath)) return
    const wc = bw.webContents
    void app
      .getFileIcon(item.savePath, { size: 'normal' })
      .catch(() => nativeImage.createEmpty())
      .then((icon) => {
        if (wc.isDestroyed()) return
        wc.startDrag({
          file: item.savePath,
          icon: icon.isEmpty() ? nativeImage.createFromPath(appIcon) : icon
        })
      })
  }

  setProgress(progress: AggregateProgress): void {
    const { value, mode } = progressBarFor(progress)
    const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    for (const bw of windows) bw.setProgressBar(value, { mode })
    console.debug(
      `[zen] downloads: setProgressBar(${value.toFixed(2)}, ${mode}) on ${windows.length} window(s)`
    )
  }

  notifyCompleted(
    item: DownloadItem,
    options: { notify: boolean; badge: number; onActivate: () => void }
  ): void {
    if (options.badge > 0 && process.platform === 'darwin' && app.dock) {
      app.dock.setBadge(String(options.badge))
      app.dock.bounce('informational')
    }
    if (!options.notify) return
    if (!Notification.isSupported()) {
      console.debug('[zen] downloads: notifications are not supported here')
      return
    }
    try {
      const notification = new Notification({ title: 'Download complete', body: item.filename })
      notification.on('click', options.onActivate)
      notification.show()
      console.debug(`[zen] downloads: notification shown for ${item.filename}`)
    } catch (error) {
      console.warn('[zen] downloads: notification failed:', (error as Error).message)
    }
  }

  clearBadge(): void {
    if (process.platform === 'darwin') app.dock?.setBadge('')
  }

  /** Where a new download lands: the folder from Settings when it can be used, else Downloads. */
  private directoryForNew(): string {
    const location = this.settings().downloads.location
    if (location) {
      try {
        mkdirSync(location, { recursive: true })
        return location
      } catch {
        // Unusable folder (removed drive, permissions): fall through to the default.
      }
    }
    return this.defaultDirectory()
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function browserWindowOf(win: ZenWindow): BrowserWindow | undefined {
  const host = win.host as ElectronWindow | undefined
  return host?.alive ? host.win : undefined
}
