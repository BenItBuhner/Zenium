import type {
  DownloadDanger,
  DownloadItem,
  DownloadSettings,
  DownloadState,
  DownloadInterruptReason
} from './types'
import { formatBytes } from './siteInfo'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const DEFAULT_DOWNLOAD_SETTINGS: DownloadSettings = {
  location: '',
  showWhenDone: true,
  notifyOnComplete: true,
  alwaysShowButton: false
}

export function sanitizeDownloadSettings(
  raw: Partial<DownloadSettings> | undefined | null
): DownloadSettings {
  const d = DEFAULT_DOWNLOAD_SETTINGS
  const r = raw ?? {}
  return {
    location: typeof r.location === 'string' ? r.location : d.location,
    showWhenDone: typeof r.showWhenDone === 'boolean' ? r.showWhenDone : d.showWhenDone,
    notifyOnComplete:
      typeof r.notifyOnComplete === 'boolean' ? r.notifyOnComplete : d.notifyOnComplete,
    alwaysShowButton:
      typeof r.alwaysShowButton === 'boolean' ? r.alwaysShowButton : d.alwaysShowButton
  }
}

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

/** Multi-part extensions that stay together when a counter is inserted (`a (1).tar.gz`). */
const COMPOUND_EXTENSION = /\.tar\.(gz|bz2|xz|zst|lz|lzma)$/i

/** `report.pdf` → `['report', '.pdf']`; dotfiles and bare names keep an empty extension. */
export function splitExtension(filename: string): [string, string] {
  const compound = COMPOUND_EXTENSION.exec(filename)
  if (compound) return [filename.slice(0, compound.index), compound[0]]
  const dot = filename.lastIndexOf('.')
  if (dot <= 0) return [filename, '']
  return [filename.slice(0, dot), filename.slice(dot)]
}

/** Lower-case extension without the dot ('' when there is none). */
export function extensionOf(filename: string): string {
  const [, ext] = splitExtension(filename)
  const last = ext.lastIndexOf('.')
  return last === -1 ? '' : ext.slice(last + 1).toLowerCase()
}

/**
 * Chrome's uniquifier: `file.txt` → `file (1).txt`, `file (2).txt`, … until `taken` says the
 * name is free. Pure – callers decide what "taken" means (files on disk, reserved paths).
 */
export function uniqueName(filename: string, taken: (name: string) => boolean): string {
  if (!taken(filename)) return filename
  const [stem, ext] = splitExtension(filename)
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken(candidate)) return candidate
  }
}

/** Strip path separators and control characters a server could smuggle into a suggested name. */
export function safeFilename(filename: string, fallback = 'download'): string {
  let clean = ''
  for (const ch of filename.replace(/[\\/]+/g, '_')) {
    const code = ch.charCodeAt(0)
    if (code > 0x1f && code !== 0x7f) clean += ch
  }
  clean = clean.trim()
  if (!clean || clean === '.' || clean === '..') return fallback
  return clean
}

// ---------------------------------------------------------------------------
// Danger classification (local table; no reputation service)
// ---------------------------------------------------------------------------

/**
 * Types Chromium's `download_file_types` marks DANGEROUS: they run when opened. Platform-specific
 * lists are merged – a `.dmg` is as much a warning on Windows as a `.exe` is on macOS, since the
 * file leaves this machine as easily as it arrived.
 */
const DANGEROUS_EXTENSIONS = new Set([
  // Windows executables and installers
  'exe',
  'msi',
  'msix',
  'msixbundle',
  'appx',
  'appxbundle',
  'msp',
  'mst',
  'com',
  'scr',
  'pif',
  'cpl',
  'msc',
  'gadget',
  'application',
  'xbap',
  'website',
  'settingcontent-ms',
  // Scripts and shell hooks
  'bat',
  'cmd',
  'js',
  'jse',
  'vbs',
  'vbe',
  'vb',
  'ws',
  'wsf',
  'wsh',
  'ps1',
  'psm1',
  'ps1xml',
  'hta',
  'sct',
  'shb',
  'shs',
  'scf',
  'inf',
  'ins',
  'isp',
  'reg',
  'chm',
  'lnk',
  'url',
  // Java, macOS, Linux, Android
  'jar',
  'jnlp',
  'dmg',
  'pkg',
  'app',
  'command',
  'apk',
  'deb',
  'rpm',
  'sh',
  'bash',
  'zsh',
  'run',
  // Disk images mount and autorun
  'iso',
  'img',
  'vhd',
  'vhdx'
])

/** Rarely downloaded types that are executable or loadable in some context. */
const UNCOMMON_EXTENSIONS = new Set([
  'crx',
  'xpi',
  'dll',
  'sys',
  'ocx',
  'drv',
  'efi',
  'elf',
  'bin',
  'py',
  'pyc',
  'pyw',
  'pl',
  'rb',
  'php',
  'ps2',
  'psd1',
  'ade',
  'adp',
  'mdb',
  'mde',
  'accdb',
  'diagcab'
])

const DANGEROUS_MIME = new Set([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-ms-installer',
  'application/x-executable',
  'application/vnd.microsoft.portable-executable',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-bat',
  'application/x-java-archive',
  'application/vnd.android.package-archive',
  'application/x-apple-diskimage',
  'application/x-debian-package',
  'application/x-rpm',
  'application/x-iso9660-image'
])

/** Verdict for a file by its name (the extension decides) with the MIME type as a fallback. */
export function classifyDownloadDanger(filename: string, mimeType = ''): DownloadDanger {
  const ext = extensionOf(filename)
  if (ext && DANGEROUS_EXTENSIONS.has(ext)) return 'dangerous'
  if (ext && UNCOMMON_EXTENSIONS.has(ext)) return 'uncommon'
  if (!ext && DANGEROUS_MIME.has(mimeType.toLowerCase().split(';')[0].trim())) return 'dangerous'
  return 'safe'
}

// ---------------------------------------------------------------------------
// File-type glyphs
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

/** Which Lucide glyph a row shows for a file (by MIME type first, then extension). */
export function fileGlyphFor(filename: string, mimeType = ''): FileGlyph {
  const mime = mimeType.toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  const ext = extensionOf(filename)
  if (ext in GLYPH_BY_EXTENSION) return GLYPH_BY_EXTENSION[ext]
  if (/^image\//.test(mime)) return 'image'
  if (mime.startsWith('text/')) return 'text'
  if (mime.includes('zip') || mime.includes('compressed') || mime.includes('tar')) return 'archive'
  return 'file'
}

// ---------------------------------------------------------------------------
// Speed and time remaining
// ---------------------------------------------------------------------------

/**
 * Exponential moving average of the transfer rate. Samples arrive whenever the host reports
 * progress (bursty, often several per second); the estimate follows a real change within ~3 s
 * and ignores jitter. Time-weighted so a sample after a long silence counts more than one that
 * arrived a few milliseconds after the previous.
 */
export class SpeedEstimator {
  private lastBytes: number | null = null
  private lastAt = 0
  private rate = 0

  constructor(private readonly halfLifeMs = 1500) {}

  /** Feed the running byte count; returns the smoothed bytes/second. */
  sample(receivedBytes: number, now: number): number {
    if (this.lastBytes === null) {
      this.lastBytes = receivedBytes
      this.lastAt = now
      return 0
    }
    const dt = now - this.lastAt
    if (dt <= 0) return this.rate
    const dBytes = receivedBytes - this.lastBytes
    // A rewind (retry from an earlier offset) restarts the estimate.
    if (dBytes < 0) {
      this.lastBytes = receivedBytes
      this.lastAt = now
      this.rate = 0
      return 0
    }
    const instant = (dBytes * 1000) / dt
    const weight = 1 - Math.pow(0.5, dt / this.halfLifeMs)
    this.rate = this.rate === 0 ? instant : this.rate + (instant - this.rate) * weight
    this.lastBytes = receivedBytes
    this.lastAt = now
    return Math.round(this.rate)
  }

  /** The transfer paused or stalled: the next sample starts a fresh interval. */
  reset(receivedBytes: number, now: number): void {
    this.lastBytes = receivedBytes
    this.lastAt = now
    this.rate = 0
  }

  get bytesPerSecond(): number {
    return Math.round(this.rate)
  }
}

/** Seconds left at the given rate, or null when it cannot be known yet. */
export function secondsRemaining(
  receivedBytes: number,
  totalBytes: number,
  bytesPerSecond: number
): number | null {
  if (totalBytes <= 0 || bytesPerSecond <= 0) return null
  const left = Math.max(0, totalBytes - receivedBytes)
  return Math.ceil(left / bytesPerSecond)
}

/** Chrome's phrasing: "3 secs left", "1 min left", "2 hours left"; null → ''. */
export function formatRemaining(seconds: number | null): string {
  if (seconds === null) return ''
  if (seconds < 60) return `${Math.max(1, seconds)} sec${seconds === 1 ? '' : 's'} left`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'} left`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} left`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} left`
}

// ---------------------------------------------------------------------------
// Aggregate progress (taskbar / dock)
// ---------------------------------------------------------------------------

export interface AggregateProgress {
  /** `idle` clears the indicator; `error` shows a failed transfer until it is dismissed. */
  mode: 'idle' | 'normal' | 'paused' | 'indeterminate' | 'error'
  /** 0–1 fraction of all active bytes (0 in `idle` and `error`). */
  value: number
}

export function isActiveDownload(item: Pick<DownloadItem, 'state'>): boolean {
  return item.state === 'progressing' || item.state === 'paused'
}

/**
 * One value for every active download: bytes received over bytes expected. An unknown total
 * makes the whole thing indeterminate; a fresh failure that has not been dismissed shows as an
 * error until the user looks at it or another transfer starts.
 */
export function aggregateProgress(
  items: ReadonlyArray<Pick<DownloadItem, 'state' | 'receivedBytes' | 'totalBytes'>>,
  options: { undismissedFailure?: boolean } = {}
): AggregateProgress {
  const active = items.filter(isActiveDownload)
  if (active.length === 0) {
    return options.undismissedFailure ? { mode: 'error', value: 0 } : { mode: 'idle', value: 0 }
  }
  const allPaused = active.every((i) => i.state === 'paused')
  if (active.some((i) => i.totalBytes <= 0)) {
    return { mode: allPaused ? 'paused' : 'indeterminate', value: 0 }
  }
  const total = active.reduce((sum, i) => sum + i.totalBytes, 0)
  const received = active.reduce((sum, i) => sum + Math.min(i.receivedBytes, i.totalBytes), 0)
  const value = total > 0 ? Math.min(1, received / total) : 0
  return { mode: allPaused ? 'paused' : 'normal', value }
}

// ---------------------------------------------------------------------------
// Persistence and migration
// ---------------------------------------------------------------------------

export const DOWNLOADS_STORE_VERSION = 2

const STATES: ReadonlySet<string> = new Set<DownloadState>([
  'progressing',
  'paused',
  'completed',
  'cancelled',
  'interrupted'
])
const DANGERS: ReadonlySet<string> = new Set<DownloadDanger>(['safe', 'dangerous', 'uncommon'])
const REASONS: ReadonlySet<string> = new Set<DownloadInterruptReason>([
  'network',
  'server',
  'disk',
  'unknown'
])

interface LegacyItem {
  id?: unknown
  url?: unknown
  filename?: unknown
  savePath?: unknown
  totalBytes?: unknown
  receivedBytes?: unknown
  state?: unknown
  startedAt?: unknown
  mimeType?: unknown
  urlChain?: unknown
  referrer?: unknown
  bytesPerSecond?: unknown
  interruptReason?: unknown
  canResume?: unknown
  danger?: unknown
  dangerDecision?: unknown
  endedAt?: unknown
  etag?: unknown
  lastModified?: unknown
  opened?: unknown
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/**
 * Bring one stored record (any version) up to the current shape. Anything that was in flight
 * when the browser quit is interrupted now; a v1 record that finished before the danger table
 * existed keeps its verdict for the glyph but is marked kept so nothing warns retroactively.
 */
export function migrateDownloadItem(raw: unknown, version: number): DownloadItem | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as LegacyItem
  if (typeof r.id !== 'string' || !r.id) return null
  const url = str(r.url)
  const filename = str(r.filename) || 'download'
  const mimeType = str(r.mimeType)
  const stored = str(r.state)
  const wasActive = stored === 'progressing' || stored === 'paused'
  const state: DownloadState = wasActive
    ? 'interrupted'
    : STATES.has(stored)
      ? (stored as DownloadState)
      : 'interrupted'
  const receivedBytes = num(r.receivedBytes)
  const totalBytes = num(r.totalBytes)
  const danger = DANGERS.has(str(r.danger))
    ? (r.danger as DownloadDanger)
    : classifyDownloadDanger(filename, mimeType)
  const item: DownloadItem = {
    id: r.id,
    url,
    urlChain:
      Array.isArray(r.urlChain) && r.urlChain.every((u) => typeof u === 'string')
        ? (r.urlChain as string[])
        : url
          ? [url]
          : [],
    referrer: str(r.referrer),
    filename,
    savePath: str(r.savePath),
    mimeType,
    totalBytes,
    receivedBytes,
    bytesPerSecond: 0,
    state,
    // A transfer cut off by quitting can pick up where its partial file ends.
    canResume:
      state === 'interrupted'
        ? wasActive
          ? receivedBytes > 0
          : typeof r.canResume === 'boolean' && r.canResume
        : false,
    danger,
    startedAt: num(r.startedAt, Date.now())
  }
  if (state === 'interrupted') {
    item.interruptReason = REASONS.has(str(r.interruptReason))
      ? (r.interruptReason as DownloadInterruptReason)
      : wasActive
        ? 'network'
        : 'unknown'
  }
  if (r.dangerDecision === 'kept' || r.dangerDecision === 'discarded') {
    item.dangerDecision = r.dangerDecision
  } else if (version < 2 && danger !== 'safe' && state === 'completed') {
    item.dangerDecision = 'kept'
  }
  if (typeof r.endedAt === 'number') item.endedAt = r.endedAt
  else if (state !== 'progressing' && state !== 'paused') item.endedAt = item.startedAt
  if (typeof r.etag === 'string' && r.etag) item.etag = r.etag
  if (typeof r.lastModified === 'string' && r.lastModified) item.lastModified = r.lastModified
  if (r.opened === true) item.opened = true
  return item
}

/** Parse a stored `downloads.json` of any version into current records (invalid ones dropped). */
export function migrateDownloads(data: unknown): DownloadItem[] {
  if (!data || typeof data !== 'object') return []
  const doc = data as { version?: unknown; items?: unknown }
  const version = typeof doc.version === 'number' ? doc.version : 1
  if (!Array.isArray(doc.items)) return []
  const items: DownloadItem[] = []
  const seen = new Set<string>()
  for (const raw of doc.items) {
    const item = migrateDownloadItem(raw, version)
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
  }
  return items
}

// ---------------------------------------------------------------------------
// Grouping for the downloads page
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

/** Bucket items by the local day they started, newest first, with Chrome's day labels. */
export function groupDownloadsByDay(items: DownloadItem[], now: number): DownloadDayGroup[] {
  const today = startOfDay(now)
  const groups = new Map<number, DownloadDayGroup>()
  const sorted = [...items].sort((a, b) => b.startedAt - a.startedAt)
  for (const item of sorted) {
    const day = startOfDay(item.startedAt)
    let group = groups.get(day)
    if (!group) {
      const daysAgo = Math.round((today - day) / 86_400_000)
      const label =
        daysAgo <= 0
          ? 'Today'
          : daysAgo === 1
            ? 'Yesterday'
            : daysAgo < 7
              ? new Date(day).toLocaleDateString(undefined, { weekday: 'long' })
              : new Date(day).toLocaleDateString(undefined, {
                  month: 'long',
                  day: 'numeric',
                  year: daysAgo > 300 ? 'numeric' : undefined
                })
      group = { label, day, items: [] }
      groups.set(day, group)
    }
    group.items.push(item)
  }
  return [...groups.values()].sort((a, b) => b.day - a.day)
}

/** Case-insensitive match on file name and source URL for the page's search box. */
export function filterDownloads(items: DownloadItem[], query: string): DownloadItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter(
    (i) => i.filename.toLowerCase().includes(q) || i.url.toLowerCase().includes(q)
  )
}

/** A dangerous or uncommon file the user has not decided about yet. */
export function needsDangerDecision(item: DownloadItem): boolean {
  return item.state === 'completed' && item.danger !== 'safe' && !item.dangerDecision
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

export interface DownloadStatus {
  text: string
  /** Which ink the line is set in: the muted foreground, the warning or the danger colour. */
  tone: 'muted' | 'warn' | 'danger'
}

const INTERRUPT_TEXT: Record<DownloadInterruptReason, string> = {
  network: 'Network error',
  server: 'Server problem',
  disk: 'Disk error',
  unknown: 'Something went wrong'
}

/**
 * Chrome's one-line status under the file name: "2.3 MB of 100 MB · 1 min left", "Paused",
 * "Failed - Network error", "Done · 100 MB", "Removed", "This file may be dangerous".
 */
export function downloadStatus(item: DownloadItem): DownloadStatus {
  const received = formatBytes(item.receivedBytes)
  const total = item.totalBytes > 0 ? formatBytes(item.totalBytes) : ''
  switch (item.state) {
    case 'progressing': {
      const size = total ? `${received} of ${total}` : received
      const left = formatRemaining(
        secondsRemaining(item.receivedBytes, item.totalBytes, item.bytesPerSecond)
      )
      return { text: left ? `${size} · ${left}` : size, tone: 'muted' }
    }
    case 'paused':
      return { text: total ? `Paused · ${received} of ${total}` : 'Paused', tone: 'muted' }
    case 'cancelled':
      return { text: 'Cancelled', tone: 'muted' }
    case 'interrupted':
      return {
        text: `Failed - ${INTERRUPT_TEXT[item.interruptReason ?? 'unknown']}`,
        tone: 'danger'
      }
    case 'completed':
      if (item.dangerDecision === 'discarded') return { text: 'Removed', tone: 'muted' }
      if (needsDangerDecision(item)) {
        return {
          text:
            item.danger === 'dangerous'
              ? 'This file may be dangerous'
              : 'This file type is not commonly downloaded',
          tone: 'warn'
        }
      }
      return { text: total ? `Done · ${total}` : 'Done', tone: 'muted' }
  }
}
