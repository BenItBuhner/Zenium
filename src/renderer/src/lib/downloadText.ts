import type { DownloadItem } from '@shared/types'
import { awaitsAutoResume, needsDangerDecision } from '@shared/downloadsShell'
import {
  autoResumeStatus,
  blockedStatus,
  describeDownloadError,
  isDeletedRow
} from './downloadsView'
import { formatBytes, relativeTime } from './utils'

/**
 * Words for the Android downloads sheet: the row's description line and the Downloads settings
 * row's name for the folder. Pure, so the sheet stays a layout and the wording is testable on
 * its own. The states a phone row shares with the desktop bubble read the same there (#161,
 * `lib/downloadsView.ts`): `Failed · <reason>` in Chrome's words, `Deleted` for a finished file
 * the engine found gone, `Blocked · …` while a flagged file waits; the phone's own lines are the
 * running row's, which has one line to fit, and the finished row's size and age.
 */

/**
 * A row's one description line, Chrome's phrasing: size and time left while running. The rate
 * only stands in while there is no estimate (unknown size), so the line fits a phone row. An
 * interrupted row reads the engine's sentence for its reason (`errorMessage`) after `Failed ·`,
 * whether or not Resume can pick it up, as the desktop row does – unless the engine (the phone's
 * downloader) will try it again on its own, when the line counts down to that attempt
 * (`Resuming in 3 s…`, HB-43; the interface's verbs table) and `now` moves it.
 */
export function downloadStatus(item: DownloadItem, now = Date.now()): string {
  const size = item.totalBytes > 0 ? formatBytes(item.totalBytes) : ''
  const received = formatBytes(item.receivedBytes)
  const ofTotal = size ? `${received} of ${size}` : received
  switch (item.state) {
    case 'progressing': {
      const eta = formatEta(item.etaMs)
      if (eta) return `${ofTotal} · ${eta}`
      return item.bytesPerSecond > 0
        ? `${ofTotal} · ${formatBytes(item.bytesPerSecond)}/s`
        : ofTotal
    }
    case 'paused':
      return `Paused · ${ofTotal}`
    case 'completed':
      if (needsDangerDecision(item)) return blockedStatus(item.danger)
      if (isDeletedRow(item)) return 'Deleted'
      return `${size || received} · ${relativeTime(item.completedAt ?? item.endedAt ?? item.startedAt, now)}`
    case 'cancelled':
      return 'Cancelled'
    case 'interrupted':
      if (awaitsAutoResume(item)) return autoResumeStatus(item.autoResumeAt, now)
      return item.errorMessage ? `Failed · ${item.errorMessage}` : describeDownloadError(item.error)
    // Refused before a byte was written (HB-44): the same status the desktop row reads.
    case 'insecure-blocked':
      return 'Blocked · Insecure download'
  }
}

/** "4 s left", "2 min left", "1 hr 5 min left"; empty without an estimate. */
export function formatEta(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return ''
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${Math.max(1, seconds)} s left`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min left`
  const hours = Math.floor(minutes / 60)
  const rest = minutes - hours * 60
  if (hours >= 24) return 'More than a day left'
  return rest ? `${hours} hr ${rest} min left` : `${hours} hr left`
}

/**
 * The Downloads settings row's name for a picked folder. Android keeps it as a document-tree
 * URI (`content://…/tree/primary%3ADownload%2FZenium`) whose last path segment is
 * `volume:relative/path`, so the row shows the relative path (`Download/Zenium`); a desktop
 * path is shown as it is, the way Chrome's Location row does.
 */
export function downloadFolderLabel(directory: string): string {
  if (!directory.startsWith('content:')) return directory
  const tree = directory.match(/\/tree\/([^/?#]+)/)
  const segment = tree ? safeDecode(tree[1]) : safeDecode(directory)
  const relative = segment.includes(':') ? segment.slice(segment.indexOf(':') + 1) : segment
  return relative.replace(/^\/+|\/+$/g, '') || 'Storage'
}

/**
 * Settings › Downloads › Location's line (HB-20): the folder new downloads go to, shown as
 * Chrome's row shows it – the engine's answer to `download.directory` when it has one (the
 * desktop names the platform's Downloads folder by its path), else the setting (a phone's
 * picked tree by its relative path), else the system folder by name, which is all the phone's
 * downloader can say of it.
 */
export function downloadLocationLabel(
  current: string | null | undefined,
  setting: string | null
): string {
  const folder = current || setting
  return folder ? downloadFolderLabel(folder) : 'The system Downloads folder'
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
