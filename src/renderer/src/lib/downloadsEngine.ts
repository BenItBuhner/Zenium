import type { DownloadItem } from '@shared/types'
import { engineFieldsOf, isActiveDownload } from '@shared/downloads'
import { run } from './api'

/**
 * Thin adapter over the current downloads core. Names match the services contract; calls map
 * onto the commands that exist on main today. Retry / Keep / Discard / Open when done stay
 * unavailable until the engine exposes them.
 */
export const downloadEngine = {
  retry: false,
  acceptDanger: false,
  discard: false,
  setOpenWhenDone: false,
  pause(id: string): void {
    run('download.pause', { id })
  },
  resume(id: string): void {
    run('download.resume', { id })
  },
  cancel(id: string): void {
    run('download.cancel', { id })
  },
  open(id: string): void {
    void run('download.open', { id })
  },
  showInFolder(id: string): void {
    run('download.showInFolder', { id })
  },
  remove(id: string): void {
    run('download.remove', { id })
  },
  removeCompleted(): void {
    run('download.removeCompleted', undefined)
  },
  openFolder(): void {
    run('download.openFolder', undefined)
  },
  chooseDirectory(): Promise<string | null> {
    return run('download.chooseDirectory', undefined)
  },
  dragOut(id: string): void {
    run('download.dragOut', { id })
  },
  openPanel(): void {
    run('download.openPanel', undefined)
  },
  retryItem(id: string): void {
    if (!this.retry) return
    run('download.retry', { id })
  },
  acceptDanger(id: string): void {
    if (!this.acceptDanger) return
    run('download.acceptDanger', { id })
  },
  discard(id: string): void {
    if (!this.discard) return
    run('download.discard', { id })
  }
}

export function canOpenDownload(item: DownloadItem): boolean {
  return item.state === 'completed' && !engineFieldsOf(item).removed && !needsKeepDiscard(item)
}

export function needsKeepDiscard(item: DownloadItem): boolean {
  if (!downloadEngine.acceptDanger && !downloadEngine.discard) return false
  const extra = engineFieldsOf(item)
  return Boolean(extra.danger && extra.danger.level !== 'safe' && extra.dangerAccepted !== true)
}

export function canRetryDownload(item: DownloadItem): boolean {
  if (!downloadEngine.retry) return false
  return item.state === 'interrupted' || item.state === 'cancelled'
}

export function canResumeDownload(item: DownloadItem): boolean {
  if (item.state === 'paused') return true
  if (item.state !== 'interrupted') return false
  return engineFieldsOf(item).canResume === true
}

export { isActiveDownload }
