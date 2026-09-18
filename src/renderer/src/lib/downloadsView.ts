import type { DownloadDanger, DownloadItem } from '@shared/types'
import {
  allPaused,
  displayName,
  isActiveDownload,
  needsDangerDecision
} from '@shared/downloadsShell'
import { formatBytes } from './utils'

/*
 * Pure presentation helpers for the downloads bubble and the `zen://downloads` page: the status
 * line under a file name, the wording of a flagged file's warning, the split that lets a long
 * name truncate in its middle, day grouping and search for the page, the file-type glyph.
 */

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

export interface DownloadStatus {
  text: string
  /** Which ink the line is set in: deemphasised text, the warning or the danger colour. */
  tone: 'muted' | 'warn' | 'danger'
  /** A second line explaining the status (a flagged file's warning); the rows show it under `text`. */
  detail?: string
}

/**
 * Chrome's interrupt reasons (the `chrome.downloads` `InterruptReason` names) onto the one-line
 * statuses of its download bubble, as Chrome 112's `BubbleStatusTextBuilder` words them; a
 * reason outside the table (`FILE_FAILED`, `FILE_HASH_MISMATCH`, `FILE_TOO_SHORT`,
 * `SERVER_NO_RANGE`, `SERVER_CROSS_ORIGIN_REDIRECT`) reads `REASON_FALLBACK` there too.
 */
const BUBBLE_REASONS: Record<string, string> = {
  FILE_ACCESS_DENIED: 'Needs permission to download',
  FILE_NO_SPACE: 'Out of storage space',
  FILE_NAME_TOO_LONG: 'File name or location is too long',
  FILE_TOO_LARGE: 'File is too big for this device',
  FILE_VIRUS_INFECTED: 'Virus detected',
  FILE_BLOCKED: 'Blocked by your organization',
  FILE_SECURITY_CHECK_FAILED: 'Virus scan failed',
  FILE_SAME_AS_SOURCE: 'Already downloaded',
  NETWORK_INVALID_REQUEST: 'Check internet connection',
  NETWORK_FAILED: 'Check internet connection',
  NETWORK_INSTABILITY: 'Check internet connection',
  NETWORK_TIMEOUT: 'Check internet connection',
  NETWORK_DISCONNECTED: 'Check internet connection',
  NETWORK_SERVER_DOWN: 'Site wasn’t available',
  SERVER_FAILED: 'Site wasn’t available',
  SERVER_CERT_PROBLEM: 'Site wasn’t available',
  SERVER_UNREACHABLE: 'Site wasn’t available',
  SERVER_UNAUTHORIZED: 'File wasn’t available on site',
  SERVER_FORBIDDEN: 'File wasn’t available on site',
  SERVER_BAD_CONTENT: 'File wasn’t available on site',
  FILE_TRANSIENT_ERROR: 'Couldn’t finish download',
  USER_SHUTDOWN: 'Couldn’t finish download',
  CRASH: 'Couldn’t finish download',
  SERVER_CONTENT_LENGTH_MISMATCH: 'Couldn’t finish download'
}
const REASON_FALLBACK = 'Something went wrong'

/**
 * Chromium `net::` error names a host may pass through, onto the interrupt reasons above – the
 * same reading the `chrome.downloads` bridge gives extensions, so a row and an extension agree
 * on why a transfer stopped.
 */
const NET_ERROR_REASONS: Array<[RegExp, string]> = [
  [/^ERR_(TIMED_OUT|CONNECTION_TIMED_OUT)$/, 'NETWORK_TIMEOUT'],
  [/^ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED)$/, 'NETWORK_DISCONNECTED'],
  [/^ERR_(CONNECTION_REFUSED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE)$/, 'SERVER_UNREACHABLE'],
  [/^ERR_(CERT_|SSL_)/, 'SERVER_CERT_PROBLEM'],
  [/^ERR_HTTP_RESPONSE_CODE_FAILURE$/, 'SERVER_FAILED'],
  [/^ERR_INVALID_RESPONSE$/, 'SERVER_BAD_CONTENT'],
  [/^ERR_CONTENT_LENGTH_MISMATCH$/, 'SERVER_CONTENT_LENGTH_MISMATCH'],
  [/^ERR_UNSAFE_REDIRECT$/, 'SERVER_CROSS_ORIGIN_REDIRECT'],
  [/^ERR_ACCESS_DENIED$/, 'FILE_ACCESS_DENIED'],
  [/^ERR_FILE_NO_SPACE$/, 'FILE_NO_SPACE'],
  [/^ERR_FILE_TOO_BIG$/, 'FILE_TOO_LARGE'],
  [/^ERR_FILE_VIRUS_INFECTED$/, 'FILE_VIRUS_INFECTED'],
  [/^ERR_BLOCKED_BY_CLIENT$/, 'FILE_BLOCKED'],
  [
    /^ERR_(CONNECTION_|NETWORK_|SOCKET_|EMPTY_RESPONSE|INCOMPLETE_CHUNKED_ENCODING)/,
    'NETWORK_FAILED'
  ]
]

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

/** "1.2 MB/s"; '' while the rate is unknown or the transfer idle (the engine reports 0). */
export function formatSpeed(bytesPerSecond: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return ''
  return `${formatBytes(bytesPerSecond)}/s`
}

/**
 * Why a transfer stopped, as `Failed – <reason>` in the words of Chrome's download bubble, from
 * the engine's `error`: its short reasons (`shutdown` for rows in flight when the app quit,
 * `file-error` when the final rename failed), Chrome's interrupt-reason names and the Chromium
 * `net::` error names a host may pass through. The Electron host names no reason at all
 * (`interrupted`): that row reads a bare `Failed` rather than a guess.
 */
export function describeDownloadError(error: string | undefined): string {
  switch (error) {
    case undefined:
    case '':
    case 'interrupted':
      return 'Failed'
    case 'shutdown':
      return `Failed – ${BUBBLE_REASONS.USER_SHUTDOWN}`
    case 'file-error':
      return `Failed – ${REASON_FALLBACK}`
    default: {
      let name = error.replace(/^net::/, '').replace(/^DOWNLOAD_INTERRUPT_REASON_/, '')
      if (name.startsWith('ERR_')) {
        name = NET_ERROR_REASONS.find(([pattern]) => pattern.test(name))?.[1] ?? ''
      }
      return `Failed – ${BUBBLE_REASONS[name] ?? REASON_FALLBACK}`
    }
  }
}

/**
 * Chrome's status for a blocked file, by the engine's verdict: `Blocked · Dangerous` for a
 * flagged file type or a dangerous URL, `Blocked · Uncommon file` for a URL verdict short of
 * dangerous, `Blocked · Insecure download` for a plaintext transfer from a secure page.
 */
export function blockedStatus(danger: DownloadDanger): string {
  switch (danger.reason) {
    case 'insecure-download':
      return 'Blocked · Insecure download'
    case 'url-verdict':
      return danger.level === 'dangerous' ? 'Blocked · Dangerous' : 'Blocked · Uncommon file'
    default:
      return 'Blocked · Dangerous'
  }
}

/**
 * The sentence explaining a blocked file (Chrome's subpage summary): the engine's own wording
 * for the verdict when it sent one, else Chrome's sentence for the reason.
 */
export function dangerSummary(danger: DownloadDanger): string {
  if (danger.message) return danger.message
  switch (danger.reason) {
    case 'insecure-download':
      return "This file may have been read or edited because this site isn't using a secure connection"
    case 'url-verdict':
      return danger.level === 'dangerous'
        ? 'Zenium blocked this file because it is dangerous'
        : 'This file is not commonly downloaded and may be dangerous'
    default:
      return 'Zenium blocked this file because this type of file is dangerous'
  }
}

export interface DangerActionLabels {
  keep: string
  discard: string
  /** Which of the two Chrome sets in the prominent (filled) style; null when neither. */
  prominent: 'keep' | 'discard' | null
}

/**
 * The Keep / Discard pair's labels for a verdict, as Chrome's bubble words them: Delete takes
 * the file away in every case; Keep releases it. A dangerous verdict makes Delete the prominent
 * one, the way Chrome fills it; a lesser warning leaves both plain.
 */
export function dangerActionLabels(danger: DownloadDanger): DangerActionLabels {
  return {
    keep: 'Keep',
    discard: 'Delete',
    prominent: danger.level === 'dangerous' ? 'discard' : null
  }
}

/**
 * The one-line status under the file name: the engine's speed and time left while running,
 * the failure reason when interrupted, Chrome's blocked status with the verdict's sentence as
 * its detail while a flagged file waits.
 */
export function downloadStatus(item: DownloadItem): DownloadStatus {
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
      return { text: describeDownloadError(item.error), tone: 'danger' }
    case 'completed':
      if (needsDangerDecision(item)) {
        return {
          text: blockedStatus(item.danger),
          tone: item.danger.level === 'dangerous' ? 'danger' : 'warn',
          detail: dangerSummary(item.danger)
        }
      }
      return { text: total ? `Done · ${total}` : 'Done', tone: 'muted' }
  }
}

/** A finished file that can be opened, shown or dragged (a flagged one waits for Keep). */
export function isOnDisk(item: DownloadItem): boolean {
  return item.state === 'completed' && !needsDangerDecision(item)
}

// ---------------------------------------------------------------------------
// Names and the bubble's description
// ---------------------------------------------------------------------------

/** How many characters before the extension the tail of a split name keeps. */
const NAME_TAIL_STEM = 6
/** Names this many characters over the tail's length are split; shorter ones show whole. */
const NAME_SPLIT_SLACK = 4

/**
 * A file name in two parts for middle truncation: the `head` may lose its end to an ellipsis
 * while the `tail` – the extension and the last few characters of the stem, which tell one
 * `report-final-v2.pdf` from another – always shows. Short names come back whole, `tail` empty.
 */
export function splitFileName(name: string): { head: string; tail: string } {
  const ext = extensionOf(name)
  const tailLength = NAME_TAIL_STEM + (ext ? ext.length + 1 : 0)
  if (name.length <= tailLength + NAME_SPLIT_SLACK) return { head: name, tail: '' }
  return { head: name.slice(0, -tailLength), tail: name.slice(-tailLength) }
}

/**
 * The line under the bubble's title, summing the list up: what is still running (or that all
 * of it is paused), else what waits on a Keep / Discard, else what failed, else that all is
 * done; null for an empty list, whose empty state speaks instead.
 */
export function bubbleDescription(items: readonly DownloadItem[]): string | null {
  if (items.length === 0) return null
  const active = items.filter(isActiveDownload).length
  if (active > 0) return allPaused(items) ? `${active} paused` : `${active} in progress`
  const blocked = items.filter(needsDangerDecision).length
  if (blocked > 0) return blocked === 1 ? '1 file blocked' : `${blocked} files blocked`
  const failed = items.filter((i) => i.state === 'interrupted').length
  if (failed > 0) return `${failed} failed`
  return 'All done'
}

// ---------------------------------------------------------------------------
// The downloads page: day groups and search
// ---------------------------------------------------------------------------

export interface DownloadDayGroup {
  /** "Today", "Yesterday", a weekday for the last week, otherwise a date. */
  label: string
  /** Local midnight the group starts at. */
  day: number
  items: DownloadItem[]
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
  items: readonly DownloadItem[],
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
export function filterDownloads(items: readonly DownloadItem[], query: string): DownloadItem[] {
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
export function hasClearable(items: readonly DownloadItem[]): boolean {
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
