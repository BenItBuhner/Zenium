import { displayName, isActiveDownload, needsDangerDecision } from '@shared/downloadsShell'
import type { DownloadRecord } from '@shared/downloadsShell'
import { formatBytes } from './utils'

/*
 * Pure presentation helpers for the downloads bubble and the `zen://downloads` page: the status
 * line under a file name, day grouping and search for the page, the file-type glyph.
 */

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

export interface DownloadStatus {
  text: string
  /** Which ink the line is set in: deemphasised text, the warning or the danger colour. */
  tone: 'muted' | 'warn' | 'danger'
}

/** Chrome's phrasing: "3 secs left", "1 min left", "2 hours left", "1 day left". */
export function formatRemaining(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `${Math.max(1, seconds)} ${seconds === 1 ? 'sec' : 'secs'} left`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'min' : 'mins'} left`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} left`
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} left`
}

/** "1.2 MB/s"; '' when the rate is unknown or idle. */
export function formatSpeed(bytesPerSecond: number | undefined): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return ''
  return `${formatBytes(bytesPerSecond)}/s`
}

/**
 * The one-line status under the file name. Speed and time left appear only when the engine
 * reports them; the failure reason likewise.
 */
export function downloadStatus(item: DownloadRecord): DownloadStatus {
  const received = formatBytes(item.receivedBytes)
  const total = item.totalBytes > 0 ? formatBytes(item.totalBytes) : ''
  switch (item.state) {
    case 'progressing': {
      const parts = [formatSpeed(item.bytesPerSecond), total ? `${received} of ${total}` : received]
      if (total) parts.push(formatRemaining(item.etaMs))
      return { text: parts.filter(Boolean).join(' · '), tone: 'muted' }
    }
    case 'paused':
      return { text: total ? `Paused · ${received} of ${total}` : 'Paused', tone: 'muted' }
    case 'cancelled':
      return { text: 'Cancelled', tone: 'muted' }
    case 'interrupted':
      return { text: item.error ? `Failed - ${item.error}` : 'Failed', tone: 'danger' }
    case 'completed':
      if (needsDangerDecision(item) && item.danger) {
        return {
          text: item.danger.message,
          tone: item.danger.level === 'dangerous' ? 'danger' : 'warn'
        }
      }
      return { text: total ? `Done · ${total}` : 'Done', tone: 'muted' }
  }
}

/** A finished file that can be opened, shown or dragged. */
export function isOnDisk(item: DownloadRecord): boolean {
  return item.state === 'completed' && !needsDangerDecision(item) && !item.removed
}

// ---------------------------------------------------------------------------
// The downloads page: day groups and search
// ---------------------------------------------------------------------------

export interface DownloadDayGroup {
  /** "Today", "Yesterday", a weekday for the last week, otherwise a date. */
  label: string
  /** Local midnight the group starts at. */
  day: number
  items: DownloadRecord[]
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function dayLabel(day: number, now: number): string {
  const daysAgo = Math.round((startOfDay(now) - day) / 86_400_000)
  if (daysAgo <= 0) return 'Today'
  if (daysAgo === 1) return 'Yesterday'
  if (daysAgo < 7) return new Date(day).toLocaleDateString(undefined, { weekday: 'long' })
  return new Date(day).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: daysAgo > 300 ? 'numeric' : undefined
  })
}

/** Bucket items by the local day they started, newest first, with Chrome's day labels. */
export function groupDownloadsByDay(
  items: readonly DownloadRecord[],
  now = Date.now()
): DownloadDayGroup[] {
  const groups = new Map<number, DownloadDayGroup>()
  const sorted = [...items].sort((a, b) => b.startedAt - a.startedAt)
  for (const item of sorted) {
    const day = startOfDay(item.startedAt)
    let group = groups.get(day)
    if (!group) {
      group = { label: dayLabel(day, now), day, items: [] }
      groups.set(day, group)
    }
    group.items.push(item)
  }
  return [...groups.values()].sort((a, b) => b.day - a.day)
}

/** Case-insensitive match on the file name and the source URL for the page's search box. */
export function filterDownloads(items: readonly DownloadRecord[], query: string): DownloadRecord[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...items]
  return items.filter(
    (i) =>
      displayName(i).toLowerCase().includes(q) ||
      i.filename.toLowerCase().includes(q) ||
      i.url.toLowerCase().includes(q)
  )
}

/** Something to clear: any record that is not still transferring. */
export function hasClearable(items: readonly DownloadRecord[]): boolean {
  return items.some((i) => !isActiveDownload(i))
}

// ---------------------------------------------------------------------------
// File-type glyph
// ---------------------------------------------------------------------------

export type FileGlyph =
  'text' | 'image' | 'archive' | 'video' | 'audio' | 'code' | 'package' | 'file'

const GLYPH_BY_EXTENSION: Record<string, FileGlyph> = {
  txt: 'text',
  md: 'text',
  rtf: 'text',
  pdf: 'text',
  doc: 'text',
  docx: 'text',
  odt: 'text',
  csv: 'text',
  xls: 'text',
  xlsx: 'text',
  ppt: 'text',
  pptx: 'text',
  epub: 'text',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  gz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  zst: 'archive',
  tar: 'archive',
  tgz: 'archive',
  js: 'code',
  ts: 'code',
  json: 'code',
  html: 'code',
  htm: 'code',
  css: 'code',
  py: 'code',
  sh: 'code',
  bat: 'code',
  cmd: 'code',
  ps1: 'code',
  xml: 'code',
  yml: 'code',
  yaml: 'code',
  exe: 'package',
  msi: 'package',
  msix: 'package',
  dmg: 'package',
  pkg: 'package',
  apk: 'package',
  deb: 'package',
  rpm: 'package',
  appimage: 'package',
  jar: 'package',
  iso: 'package',
  img: 'package',
  app: 'package'
}

/** Lower-case extension without the dot ('' when there is none). */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot <= 0 || dot === filename.length - 1) return ''
  return filename.slice(dot + 1).toLowerCase()
}

/** Which glyph a row shows for a file (by MIME type first, then extension). */
export function fileGlyphFor(filename: string, mimeType = ''): FileGlyph {
  const mime = mimeType.toLowerCase().split(';')[0].trim()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  const ext = extensionOf(filename)
  const byExtension = GLYPH_BY_EXTENSION[ext]
  if (byExtension) return byExtension
  if (mime.startsWith('text/')) return 'text'
  if (mime.includes('zip') || mime.includes('compressed') || mime.includes('tar')) return 'archive'
  return 'file'
}
