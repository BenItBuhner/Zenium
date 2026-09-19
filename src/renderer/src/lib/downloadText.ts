import type { DownloadItem } from '@shared/types'
import { normalizeExtension } from '@shared/downloads'
import { formatBytes, relativeTime } from './utils'

/**
 * Words for the downloads sheet: every string a row shows apart from the file name. Pure, so
 * the sheet stays a layout and the wording is testable on its own.
 */

/**
 * A row's one description line, Chrome's phrasing: size and time left while running. The rate
 * only stands in while there is no estimate (unknown size), so the line fits a phone row.
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
      return `${size || received} · ${relativeTime(item.completedAt ?? item.endedAt ?? item.startedAt, now)}`
    case 'cancelled':
      return 'Cancelled'
    case 'interrupted':
      return item.canResume
        ? `Interrupted · ${ofTotal}`
        : `Failed · ${describeDownloadError(item.error)}`
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
 * The engine's `error` is a short machine reason (Android: `network-timeout`, `file-no-space`;
 * the core: `shutdown`, `file-error`; Electron: `interrupted`). One plain sentence each.
 */
export function describeDownloadError(error: string | undefined): string {
  const e = (error ?? '').toLowerCase()
  if (!e) return 'Something went wrong'
  if (e === 'shutdown') return 'Zenium was closed'
  if (e.includes('no-space') || e.includes('disk_full')) return 'Not enough storage space'
  if (e.includes('access-denied') || e.includes('access_denied')) return 'Zenium needs permission'
  if (e.startsWith('file')) return 'The file could not be saved'
  if (e.includes('timeout') || e.includes('timed_out')) return 'The connection timed out'
  if (e.includes('disconnected') || e.includes('internet')) return 'No internet connection'
  if (e.startsWith('network') || e.includes('connection') || e.includes('name_not_resolved'))
    return 'Network error'
  if (e.startsWith('server')) return 'The server stopped sending the file'
  return 'Something went wrong'
}

/** Whether the row is holding a flagged file behind its Keep / Discard warning. */
export function isQuarantined(item: DownloadItem): boolean {
  return item.state === 'completed' && item.danger.level !== 'safe' && !item.dangerAccepted
}

/** Whether the row can start its transfer again from scratch (`blob:` bytes are gone with the page). */
export function canRetry(item: DownloadItem): boolean {
  return (
    (item.state === 'interrupted' || item.state === 'cancelled') && !item.url.startsWith('blob:')
  )
}

/**
 * The Downloads settings row's name for the current folder. Android keeps a picked folder as a
 * document-tree URI (`content://…/tree/primary%3ADownload%2FZenium`); the last path segment is
 * `volume:relative/path`, so show the relative path (`Download/Zenium`). A plain path shows its
 * last segment, and nothing set is the platform's Downloads folder.
 */
export function downloadFolderLabel(directory: string | null): string {
  if (!directory) return 'Downloads'
  if (directory.startsWith('content:')) {
    const tree = directory.match(/\/tree\/([^/?#]+)/)
    const segment = tree ? safeDecode(tree[1]) : safeDecode(directory)
    const relative = segment.includes(':') ? segment.slice(segment.indexOf(':') + 1) : segment
    return relative.replace(/^\/+|\/+$/g, '') || 'Storage'
  }
  const parts = directory.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || directory
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** "pdf, PNG, .jpg" -> ['pdf', 'png', 'jpg'], unique, in the order typed. */
export function parseAutoOpenTypes(text: string): string[] {
  const seen = new Set<string>()
  for (const raw of text.split(/[\s,;]+/)) {
    const ext = normalizeExtension(raw)
    if (ext) seen.add(ext)
  }
  return [...seen]
}
