import { BrowserWindow, Notification, app, nativeImage, shell } from 'electron'
import { existsSync } from 'node:fs'
import type { AppIconId } from '../../shared/appIcon'
import type { DownloadItem } from '../../shared/types'
import {
  completionNotice,
  diffDownloads,
  progressBarFor,
  sameProgressBar,
  shouldNotifyCompletion,
  snapshotDownloads,
  type DownloadRecord,
  type ProgressBar
} from '../../shared/downloadsShell'
import type { Browser } from '../../core/browser'
import type { ZenWindow } from '../../core/window'
import { windowIcon } from './appIcon'
import { downloadDir } from './downloads'
import type { ElectronWindow } from './window'

/**
 * The desktop's OS integration for downloads, built on the engine's list alone: every state
 * broadcast is diffed against the last one, the aggregate progress lands on each window's
 * taskbar entry (and the macOS dock), completions while no window is focused post a
 * notification whose click reveals the item, and the dock badge counts those until a window
 * takes focus again. Nothing here touches `downloads.json` or the transfers.
 */
export class ElectronDownloadsShell {
  private previous: DownloadRecord[] = []
  private bar: ProgressBar = { value: -1, mode: 'none' }
  private unseen = 0
  private readonly notifications = new Set<Notification>()

  constructor(private readonly browser: Browser) {
    this.previous = snapshotDownloads(browser.downloads.items)
    browser.state.subscribe(() => this.sync())
    app.on('browser-window-focus', () => this.onWindowFocused())
    // A window opened mid-download shows the same taskbar progress as the others.
    app.on('browser-window-created', (_event, bw) => {
      if (this.bar.mode !== 'none') bw.setProgressBar(this.bar.value, { mode: this.bar.mode })
    })
  }

  private sync(): void {
    const items = this.browser.downloads.items
    const changes = diffDownloads(this.previous, items)
    this.previous = snapshotDownloads(items)
    this.updateProgressBar(items)
    for (const change of changes) {
      if (change.kind === 'done' && change.item.state === 'completed') {
        this.onCompleted(change.item)
      }
    }
  }

  private updateProgressBar(items: readonly DownloadItem[]): void {
    const next = progressBarFor(items)
    if (sameProgressBar(this.bar, next)) return
    this.bar = next
    for (const bw of BrowserWindow.getAllWindows()) {
      if (!bw.isDestroyed()) bw.setProgressBar(next.value, { mode: next.mode })
    }
  }

  private onCompleted(item: DownloadRecord): void {
    const focused = this.browser.allWindows().some((w) => w.host.isFocused())
    if (focused) return
    this.unseen++
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setBadge(String(this.unseen))
      app.dock.bounce('informational')
    }
    if (!shouldNotifyCompletion(item, this.browser.state.settings.downloads, focused)) return
    if (!Notification.isSupported()) return
    const notice = completionNotice(item)
    const notification = new Notification({
      title: notice.title,
      body: notice.body,
      silent: true
    })
    this.notifications.add(notification)
    notification.on('click', () => this.reveal(item.id))
    notification.on('close', () => this.notifications.delete(notification))
    notification.show()
  }

  private onWindowFocused(): void {
    if (this.unseen === 0) return
    this.unseen = 0
    if (process.platform === 'darwin') app.dock?.setBadge('')
  }

  /** Bring a window up and open the bubble on `id` (a notification was clicked). */
  private reveal(id: string): void {
    const win = this.browser.ensureWindow()
    win.host.show()
    win.host.focus()
    win.send('downloads.reveal', { id })
  }
}

/** Begin a native drag of a finished file out of the chrome (the downloads page's rows). */
export function startFileDrag(item: DownloadItem, win: ZenWindow, appIconId: AppIconId): void {
  const bw = browserWindowOf(win)
  if (!bw || !item.savePath || !existsSync(item.savePath)) return
  const contents = bw.webContents
  void app
    .getFileIcon(item.savePath, { size: 'normal' })
    .catch(() => nativeImage.createEmpty())
    .then((icon) => {
      if (contents.isDestroyed()) return
      contents.startDrag({
        file: item.savePath,
        icon: icon.isEmpty() ? windowIcon(appIconId) : icon
      })
    })
}

/** Open the folder downloads are saved to in the system file manager. */
export function openDownloadsFolder(): void {
  void shell.openPath(downloadDir())
}

function browserWindowOf(win: ZenWindow): BrowserWindow | undefined {
  const host = win.host as ElectronWindow | undefined
  return host?.alive ? host.win : undefined
}
