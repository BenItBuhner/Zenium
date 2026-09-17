import { BrowserWindow, Notification, app, dialog, nativeImage, shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import type { DownloadItem } from '../../shared/types'
import { aggregateProgress, progressBarFor, type AggregateProgress } from '../../shared/downloads'
import type { ZenWindow } from '../../core/window'
import type { ElectronWindow } from './window'
import { downloadDir } from './downloads'
import appIcon from '../../../resources/icon.png?asset'

function browserWindowOf(win: ZenWindow | undefined): BrowserWindow | undefined {
  const host = win?.host as ElectronWindow | undefined
  return host?.alive ? host.win : undefined
}

/**
 * Desktop-owned OS chrome for downloads: taskbar/dock progress, completion notifications,
 * folder picking, and drag-out. The transfer host never calls these.
 */
export class ElectronDownloadsShell {
  private lastProgress: AggregateProgress = { mode: 'idle', value: 0 }

  defaultDirectory(): string {
    return downloadDir()
  }

  openDirectory(path: string): void {
    if (!existsSync(path)) mkdirSync(path, { recursive: true })
    void shell.openPath(path)
  }

  async chooseDirectory(win: ZenWindow, defaultPath: string): Promise<string | null> {
    const bw = browserWindowOf(win)
    const options: Electron.OpenDialogOptions = {
      title: 'Choose where downloads are saved',
      defaultPath,
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

  setProgress(
    items: ReadonlyArray<Pick<DownloadItem, 'state' | 'receivedBytes' | 'totalBytes'>>
  ): void {
    const progress = aggregateProgress(items)
    if (progress.mode === this.lastProgress.mode && progress.value === this.lastProgress.value)
      return
    this.lastProgress = progress
    const { value, mode } = progressBarFor(progress)
    const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    for (const bw of windows) bw.setProgressBar(value, { mode })
  }

  notifyCompleted(
    item: DownloadItem,
    options: { notify: boolean; badge: number; onActivate: () => void }
  ): void {
    if (options.badge > 0 && process.platform === 'darwin' && app.dock) {
      app.dock.setBadge(String(options.badge))
      app.dock.bounce('informational')
      if (item.savePath) app.dock.downloadFinished(item.savePath)
    }
    if (!options.notify) return
    if (!Notification.isSupported()) return
    try {
      const notification = new Notification({ title: 'Download complete', body: item.filename })
      notification.on('click', options.onActivate)
      notification.show()
    } catch (error) {
      console.warn('[zen] downloads: notification failed:', (error as Error).message)
    }
  }

  clearBadge(): void {
    if (process.platform === 'darwin') app.dock?.setBadge('')
  }
}
