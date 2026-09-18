import { BrowserWindow, Notification, app, nativeImage, shell } from 'electron'
import { existsSync } from 'node:fs'
import type { AppIconId } from '../../shared/appIcon'
import type { DownloadItem } from '../../shared/types'
import { resolveDownloadSettings } from '../../shared/downloads'
import {
  PROGRESS_ERROR_FLASH_MS,
  allPaused,
  completionNotice,
  failedProgressBar,
  needsDangerDecision,
  progressBarFor,
  sameProgressBar,
  shouldNotifyCompletion,
  type ProgressBar
} from '../../shared/downloadsShell'
import type { Browser } from '../../core/browser'
import type { ZenWindow } from '../../core/window'
import { windowIcon } from './appIcon'
import { downloadDir } from './downloads'
import type { ElectronWindow } from './window'

/**
 * The desktop's OS integration for downloads, driven by the engine's `download.changed`: the
 * aggregate progress lands on each window's taskbar entry (and the macOS dock) – normal, paused
 * while everything is, indeterminate for size-less transfers, the error tone for a moment after
 * a failure while others run, cleared when the last one ends – completions while no window is
 * focused post a notification whose click reveals the item, and the dock badge counts those
 * until a window takes focus again. The engine calls neither `setProgressBar` nor
 * `Notification` (contract); nothing here touches `downloads.json` or the transfers.
 */
export class ElectronDownloadsShell {
  private readonly bars = new WeakMap<BrowserWindow, ProgressBar>()
  private unseen = 0
  private readonly notifications = new Set<Notification>()
  /** A transfer just failed: its list's entries paint the error tone until this fires. */
  private errorFlash: { timer: ReturnType<typeof setTimeout>; private: boolean } | null = null
  /** Rows known to be interrupted, so a failure flashes once, not on every later update. */
  private readonly interrupted = new Set<string>()

  constructor(private readonly browser: Browser) {
    browser.onDownloadChange((item, kind) => {
      // A resumable interruption (the connection dropped) arrives as a progress change, a
      // terminal one as done; both are the failure the taskbar shows for a moment.
      if (item.state === 'interrupted' && kind !== 'removed') {
        if (!this.interrupted.has(item.id)) this.flashError(item.private)
        this.interrupted.add(item.id)
      } else {
        this.interrupted.delete(item.id)
      }
      this.updateProgressBars()
      if (kind === 'done') this.onDone(item)
    })
    app.on('browser-window-focus', () => this.onWindowFocused())
    // A window opened mid-download shows the same taskbar progress as the others.
    app.on('browser-window-created', () => this.updateProgressBars())
  }

  /**
   * Each window's taskbar entry shows the aggregate of the downloads that window lists: private
   * windows count their private transfers too, the rest see the regular list only.
   */
  private updateProgressBars(): void {
    for (const win of this.browser.allWindows()) {
      const bw = browserWindowOf(win)
      if (!bw) continue
      const next = this.barFor(win)
      const previous = this.bars.get(bw)
      if (previous && sameProgressBar(previous, next)) continue
      this.bars.set(bw, next)
      bw.setProgressBar(next.value, { mode: next.mode })
    }
  }

  private barFor(win: ZenWindow): ProgressBar {
    const filter = win.isPrivate ? {} : { private: false }
    const progress = this.browser.downloads.aggregateProgress(filter)
    // A private failure is only the private windows' business; a regular one is everyone's.
    if (this.errorFlash && (win.isPrivate || !this.errorFlash.private))
      return failedProgressBar(progress)
    return progressBarFor(progress, allPaused(this.browser.downloads.visibleTo(win.isPrivate)))
  }

  /** Paint the failure for a moment, then go back to the aggregate; a second failure restarts it. */
  private flashError(isPrivate: boolean): void {
    if (this.errorFlash) clearTimeout(this.errorFlash.timer)
    const timer = setTimeout(() => {
      this.errorFlash = null
      this.updateProgressBars()
    }, PROGRESS_ERROR_FLASH_MS)
    this.errorFlash = { timer, private: isPrivate }
  }

  /** `done` covers completed, cancelled and interrupted; a flagged file waits for Keep instead. */
  private onDone(item: DownloadItem): void {
    if (item.state !== 'completed' || needsDangerDecision(item)) return
    const focused = this.browser.allWindows().some((w) => w.host.isFocused())
    if (focused) return
    this.unseen++
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setBadge(String(this.unseen))
      app.dock.bounce('informational')
    }
    const settings = resolveDownloadSettings(this.browser.state.settings)
    if (!shouldNotifyCompletion(item, settings, focused)) return
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
