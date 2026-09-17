import type { DownloadItem } from '@shared/types'
import { engineFieldsOf, isActiveDownload } from '@shared/downloads'
import { cmd, run } from './api'

/**
 * Commands the services engine will add. False on today's core; the chrome hides the matching
 * controls. Do not call `download.retry` / `acceptDanger` / `discard` / `setOpenWhenDone` until
 * these flip — those names are not on the current host.
 */
export const downloadEngineCapabilities = {
  retry: false,
  acceptDanger: false,
  discard: false,
  setOpenWhenDone: false
}

/**
 * Thin adapter over the current downloads core. Names match the services contract; calls map
 * onto the commands that exist on main today.
 */
export const downloadEngine = {
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
    return cmd('download.chooseDirectory', undefined).catch(() => null)
  },
  dragOut(id: string): void {
    run('download.dragOut', { id })
  },
  openPanel(): void {
    run('download.openPanel', undefined)
  }
}

export function canOpenDownload(item: DownloadItem): boolean {
  return item.state === 'completed' && !engineFieldsOf(item).removed && !needsKeepDiscard(item)
}

export function needsKeepDiscard(item: DownloadItem): boolean {
  if (!downloadEngineCapabilities.acceptDanger && !downloadEngineCapabilities.discard) return false
  const extra = engineFieldsOf(item)
  return Boolean(extra.danger && extra.danger.level !== 'safe' && extra.dangerAccepted !== true)
}

export function canRetryDownload(item: DownloadItem): boolean {
  if (!downloadEngineCapabilities.retry) return false
  return item.state === 'interrupted' || item.state === 'cancelled'
}

export function canResumeDownload(item: DownloadItem): boolean {
  if (item.state === 'paused') return true
  if (item.state !== 'interrupted') return false
  return engineFieldsOf(item).canResume === true
}

export { isActiveDownload }
