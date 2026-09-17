import type { DownloadItem, DownloadSettings, DownloadState } from './types'
import { formatBytes } from './siteInfo'

/** Settings the desktop chrome stores until the services engine owns the same keys. */
export const DEFAULT_DOWNLOAD_SETTINGS: DownloadSettings = {
  directory: null,
  notifyOnComplete: false,
  openPanelOnStart: false,
  openPanelOnComplete: true,
  autoOpenTypes: [],
  alwaysShowButton: false
}

export function sanitizeDownloadSettings(
  raw: Partial<DownloadSettings> | undefined | null
): DownloadSettings {
  const d = DEFAULT_DOWNLOAD_SETTINGS
  const r = (raw ?? {}) as Partial<DownloadSettings> & {
    location?: unknown
    showWhenDone?: unknown
  }
  const directory =
    typeof r.directory === 'string'
      ? r.directory
      : typeof r.location === 'string'
        ? r.location
        : d.directory
  const autoOpenTypes = Array.isArray(r.autoOpenTypes)
    ? r.autoOpenTypes.filter((t): t is string => typeof t === 'string')
    : d.autoOpenTypes
  return {
    directory: directory === '' ? null : directory,
    notifyOnComplete:
      typeof r.notifyOnComplete === 'boolean' ? r.notifyOnComplete : d.notifyOnComplete,
    openPanelOnStart:
      typeof r.openPanelOnStart === 'boolean' ? r.openPanelOnStart : d.openPanelOnStart,
    openPanelOnComplete:
      typeof r.openPanelOnComplete === 'boolean'
        ? r.openPanelOnComplete
        : typeof r.showWhenDone === 'boolean'
          ? r.showWhenDone
          : d.openPanelOnComplete,
    autoOpenTypes,
    alwaysShowButton:
      typeof r.alwaysShowButton === 'boolean' ? r.alwaysShowButton : d.alwaysShowButton
  }
}

// ---------------------------------------------------------------------------
// Optional engine fields the current core does not persist
// ---------------------------------------------------------------------------

export type DownloadDangerLevel = 'safe' | 'suspicious' | 'dangerous'

export interface DownloadDangerView {
  level: DownloadDangerLevel
  reason: string
  message: string
}

/**
 * Contract-shaped extras that may ride on a `DownloadItem` once the services engine lands.
 * Absent on today's records; the chrome hides the matching UI when they are missing.
 */
export interface DownloadEngineFields {
  referrer?: string
  finalName?: string
  canResume?: boolean
  error?: string
  danger?: DownloadDangerView
  dangerAccepted?: boolean
  openWhenDone?: boolean
  bytesPerSecond?: number
  etaMs?: number | null
  completedAt?: number
  removed?: boolean
}

function asRecord(item: DownloadItem): DownloadItem & Record<string, unknown> {
  return item as DownloadItem & Record<string, unknown>
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read additive engine fields when present; never invents them. */
export function engineFieldsOf(item: DownloadItem): DownloadEngineFields {
  const raw = asRecord(item)
  const dangerRaw = raw.danger
  let danger: DownloadDangerView | undefined
  if (dangerRaw && typeof dangerRaw === 'object') {
    const d = dangerRaw as Record<string, unknown>
    const level = d.level
    if (level === 'safe' || level === 'suspicious' || level === 'dangerous') {
      danger = {
        level,
        reason: typeof d.reason === 'string' ? d.reason : '',
        message: typeof d.message === 'string' ? d.message : ''
      }
    }
  }
  const eta = raw.etaMs
  return {
    referrer: optionalString(raw.referrer),
    finalName: optionalString(raw.finalName),
    canResume: optionalBoolean(raw.canResume),
    error: optionalString(raw.error),
    danger,
    dangerAccepted: optionalBoolean(raw.dangerAccepted),
    openWhenDone: optionalBoolean(raw.openWhenDone),
    bytesPerSecond: optionalNumber(raw.bytesPerSecond),
    etaMs: eta === null ? null : optionalNumber(eta),
    completedAt: optionalNumber(raw.completedAt),
    removed: optionalBoolean(raw.removed)
  }
}

export function displayNameOf(item: DownloadItem): string {
  return engineFieldsOf(item).finalName || item.filename
}

export function needsDangerDecision(item: DownloadItem): boolean {
  const extra = engineFieldsOf(item)
  return Boolean(extra.danger && extra.danger.level !== 'safe' && extra.dangerAccepted !== true)
}

// ---------------------------------------------------------------------------
// File-type glyph (chrome only; not the engine danger table)
// ---------------------------------------------------------------------------

export type FileGlyph = 'text' | 'image' | 'archive' | 'video' | 'audio' | 'code' | 'package' | 'file'

const COMPOUND_EXTENSION = /\.tar\.(gz|bz2|xz|zst|lz|lzma)$/i

export function splitExtension(filename: string): [string, string] {
  const compound = COMPOUND_EXTENSION.exec(filename)
  if (compound) return [filename.slice(0, compound.index), compound[0]]
  const dot = filename.lastIndexOf('.')
  if (dot <= 0) return [filename, '']
  return [filename.slice(0, dot), filename.slice(dot)]
}

export function extensionOf(filename: string): string {
  const [, ext] = splitExtension(filename)
  const last = ext.lastIndexOf('.')
  return last === -1 ? '' : ext.slice(last + 1).toLowerCase()
}

const GLYPH_BY_EXTENSION: Record<string, FileGlyph> = {
  txt: 'text',
  md: 'text',
  rtf: 'text',
  pdf: 'text',
  doc: 'text',
  docx: 'text',
  odt: 'text',
  csv: 'text',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  ico: 'image',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  mp4: 'video',
  mkv: 'video',
  webm: 'video',
  mov: 'video',
  avi: 'video',
  mp3: 'audio',
  wav: 'audio',
  flac: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  js: 'code',
  ts: 'code',
  tsx: 'code',
  jsx: 'code',
  json: 'code',
  html: 'code',
  css: 'code',
  py: 'code',
  rs: 'code',
  go: 'code',
  java: 'code',
  sh: 'code',
  exe: 'package',
  msi: 'package',
  dmg: 'package',
  pkg: 'package',
  apk: 'package',
  deb: 'package',
  rpm: 'package',
  appimage: 'package'
}

export function fileGlyphFor(filename: string, mimeType = ''): FileGlyph {
  const mime = mimeType.toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('text/')) return 'text'
  const ext = extensionOf(filename)
  return GLYPH_BY_EXTENSION[ext] ?? 'file'
}

// ---------------------------------------------------------------------------
// Aggregate progress (taskbar / dock / toolbar ring)
// ---------------------------------------------------------------------------

export interface AggregateProgress {
  mode: 'idle' | 'normal' | 'paused' | 'indeterminate' | 'error'
  value: number
}

export interface DownloadsProgress {
  received: number
  total: number
  indeterminate: boolean
}

export function isActiveDownload(item: Pick<DownloadItem, 'state'>): boolean {
  return item.state === 'progressing' || item.state === 'paused'
}

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

/** Snapshot shape from the services contract, derived from the current list. */
export function downloadsProgressOf(
  items: ReadonlyArray<Pick<DownloadItem, 'state' | 'receivedBytes' | 'totalBytes'>>
): DownloadsProgress {
  const active = items.filter(isActiveDownload)
  const unknown = active.some((i) => i.totalBytes <= 0)
  return {
    received: active.reduce((sum, i) => sum + Math.max(0, i.receivedBytes), 0),
    total: unknown ? 0 : active.reduce((sum, i) => sum + i.totalBytes, 0),
    indeterminate: unknown && active.length > 0
  }
}

/** `BrowserWindow.setProgressBar` arguments for an aggregate value. */
export function progressBarFor(progress: AggregateProgress): {
  value: number
  mode: 'none' | 'normal' | 'indeterminate' | 'error' | 'paused'
} {
  switch (progress.mode) {
    case 'idle':
      return { value: -1, mode: 'none' }
    case 'normal':
      return { value: progress.value, mode: 'normal' }
    case 'paused':
      return { value: progress.value, mode: 'paused' }
    case 'indeterminate':
      return { value: 2, mode: 'indeterminate' }
    case 'error':
      return { value: 1, mode: 'error' }
  }
}

// ---------------------------------------------------------------------------
// Status, search, day groups
// ---------------------------------------------------------------------------

export function secondsRemaining(
  receivedBytes: number,
  totalBytes: number,
  bytesPerSecond: number
): number | null {
  if (totalBytes <= 0 || bytesPerSecond <= 0) return null
  const left = Math.max(0, totalBytes - receivedBytes)
  return Math.ceil(left / bytesPerSecond)
}

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

export interface DownloadDayGroup {
  label: string
  day: number
  items: DownloadItem[]
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function groupDownloadsByDay(items: DownloadItem[], now = Date.now()): DownloadDayGroup[] {
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

export function filterDownloads(items: DownloadItem[], query: string): DownloadItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter((i) => {
    const extra = engineFieldsOf(i)
    const name = (extra.finalName || i.filename).toLowerCase()
    const url = i.url.toLowerCase()
    const referrer = (extra.referrer ?? '').toLowerCase()
    return name.includes(q) || url.includes(q) || referrer.includes(q)
  })
}

export interface DownloadStatus {
  text: string
  tone: 'muted' | 'warn' | 'danger'
}

export function downloadStatus(item: DownloadItem): DownloadStatus {
  const extra = engineFieldsOf(item)
  const received = formatBytes(item.receivedBytes)
  const total = item.totalBytes > 0 ? formatBytes(item.totalBytes) : ''
  switch (item.state) {
    case 'progressing': {
      const size = total ? `${received} of ${total}` : received
      const left = formatRemaining(
        extra.etaMs != null
          ? Math.ceil(extra.etaMs / 1000)
          : secondsRemaining(item.receivedBytes, item.totalBytes, extra.bytesPerSecond ?? 0)
      )
      return { text: left ? `${size} · ${left}` : size, tone: 'muted' }
    }
    case 'paused':
      return { text: total ? `Paused · ${received} of ${total}` : 'Paused', tone: 'muted' }
    case 'cancelled':
      return { text: 'Cancelled', tone: 'muted' }
    case 'interrupted':
      return {
        text: extra.error ? `Failed - ${extra.error}` : 'Failed',
        tone: 'danger'
      }
    case 'completed':
      if (extra.removed) return { text: 'Removed', tone: 'muted' }
      if (needsDangerDecision(item) && extra.danger) {
        return { text: extra.danger.message || 'This file may be dangerous', tone: 'warn' }
      }
      return { text: total ? `Done · ${total}` : 'Done', tone: 'muted' }
  }
}

export function isSettledDownload(state: DownloadState): boolean {
  return state === 'completed' || state === 'cancelled' || state === 'interrupted'
}
