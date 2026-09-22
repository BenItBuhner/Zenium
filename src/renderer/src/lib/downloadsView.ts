import type { DownloadDanger, DownloadInterruptReason, DownloadItem } from '@shared/types'
import {
  allPaused,
  awaitsAutoResume,
  canKeepInsecureDownload,
  displayName,
  isActiveDownload,
  isInsecureBlocked,
  needsDangerDecision
} from '@shared/downloadsShell'
import { formatBytes } from './utils'

/*
 * Pure presentation helpers for the downloads bubble and the `zen://downloads` page: the status
 * line under a file name, the wording of a failure and of a flagged file's warning, the split
 * that lets a long name truncate in its middle, day grouping and search for the page, the
 * file-type glyph.
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
  /** A tooltip on the line where Chrome shows one: the engine's sentence for a failure. */
  hint?: string
}

/**
 * The engine's interrupt reasons (`DownloadInterruptReason`, Chromium's in kebab case) onto the
 * one-line statuses of Chrome 112's download bubble, as its `BubbleStatusTextBuilder` words
 * them. Keyed by the closed set, so a member without a line does not compile; the engine's
 * `interruptMessage` carries the same sentences for consumers without a table of their own.
 */
export const INTERRUPT_WORDING: Readonly<Record<DownloadInterruptReason, string>> = {
  'network-failed': 'Check internet connection',
  'network-timeout': 'Check internet connection',
  'network-disconnected': 'Check internet connection',
  'network-server-down': 'Site wasn’t available',
  'server-failed': 'Site wasn’t available',
  'server-no-range': 'Something went wrong',
  'server-bad-content': 'File wasn’t available on site',
  'server-unauthorized': 'File wasn’t available on site',
  'server-forbidden': 'File wasn’t available on site',
  'server-unreachable': 'Site wasn’t available',
  'file-failed': 'Something went wrong',
  'file-access-denied': 'Needs permission to download',
  'file-no-space': 'Out of storage space',
  'file-name-too-long': 'File name or location is too long',
  'file-too-large': 'File is too big for this device',
  'file-virus-infected': 'Virus detected',
  'file-blocked': 'Blocked by your organization',
  'file-security-check-failed': 'Virus scan failed',
  'file-same-as-source': 'Already downloaded',
  'user-canceled': 'Cancelled',
  'user-shutdown': 'Couldn’t finish download',
  crash: 'Couldn’t finish download'
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

/** "1.2 MB/s"; '' while the rate is unknown or the transfer idle (the engine reports 0). */
export function formatSpeed(bytesPerSecond: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return ''
  return `${formatBytes(bytesPerSecond)}/s`
}

/**
 * Why a transfer stopped, as `Failed · <reason>` in the words of Chrome's download bubble (the
 * status line's caption shape, `Done · 2 MB`), from the engine's `error`. No reason at all
 * reads a bare `Failed` rather than a guess.
 */
export function describeDownloadError(error: DownloadInterruptReason | undefined): string {
  return error ? `Failed · ${INTERRUPT_WORDING[error]}` : 'Failed'
}

/**
 * Chrome's status for a blocked file, naming the engine's tier (HB-19 / PS-34): `Blocked ·
 * Dangerous` for a dangerous file type or a dangerous URL, `Blocked · Suspicious` for a type of
 * the lesser tier (a disk image, a macro-bearing document; Chrome's "Suspicious download
 * blocked"), `Blocked · Uncommon file` for a URL verdict short of dangerous, `Blocked · Insecure
 * download` for a plaintext transfer from a secure page.
 */
export function blockedStatus(danger: DownloadDanger): string {
  switch (danger.reason) {
    case 'insecure-download':
      return 'Blocked · Insecure download'
    case 'url-verdict':
      return danger.level === 'dangerous' ? 'Blocked · Dangerous' : 'Blocked · Uncommon file'
    default:
      return danger.level === 'dangerous' ? 'Blocked · Dangerous' : 'Blocked · Suspicious'
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

/**
 * The sentence under an `insecure-blocked` row: Chrome's ("This file can’t be downloaded
 * securely", `IDS_PROMPT_DOWNLOAD_INSECURE_BLOCKED`), and when the type is dangerous too the
 * verdict's sentence after it – that row offers no Keep anyway (`canKeepInsecure`).
 */
export function insecureSummary(item: Pick<DownloadItem, 'danger'>): string {
  const base = 'This file can’t be downloaded securely'
  return item.danger.level === 'dangerous' ? `${base} · ${dangerSummary(item.danger)}` : base
}

export interface DangerActionLabels {
  keep: string
  discard: string
  /**
   * Which of the two is the filled primary (§6): the action the app recommends, which on every
   * tier is the protective verb – the one that takes the file away. Never the danger ink: that
   * is for actions that destroy the user's own data, and a verb is not danger-inked for sounding
   * destructive. Kept a field rather than a constant so the renderers stay data-driven.
   */
  prominent: 'keep' | 'discard' | null
}

/**
 * The Keep / Delete pair's labels for a flagged file, as Chrome's bubble words them: Delete takes
 * the file away in every case; Keep releases it. Delete is the filled, recommended one on the
 * dangerous and the suspicious tier alike (§6 as the lead widened it for #297: the primary is the
 * protective verb; Chrome fills it on every tier of its bubble), Keep the plain secondary – so
 * the verdict's tier no longer enters: it names the row's status and ink, not its pair.
 */
export function dangerActionLabels(): DangerActionLabels {
  return { keep: 'Keep', discard: 'Delete', prominent: 'discard' }
}

export interface DecisionLabels {
  /** The releasing action's label; null when the row offers none (a dangerous type blocked as insecure). */
  keep: string | null
  discard: string
  prominent: 'keep' | 'discard' | null
}

/**
 * The pair a row waiting on the user shows, by its state (the interface's verbs table): a
 * flagged file's Keep / Delete (`dangerActionLabels`; the file is on disk in quarantine, so
 * Chrome's word is Delete), an `insecure-blocked` row's **Keep anyway** / **Discard** – nothing
 * is on disk, so not Delete – with Keep anyway only while the engine would honour it
 * (`canKeepInsecureDownload`). Discard is the filled primary as Delete is on the other tiers
 * (§6: the protective verb, trailing per §9.11), Keep anyway the plain secondary. Keep and Keep
 * anyway are one command (`download.acceptDanger`), Delete and Discard another
 * (`download.discard`).
 */
export function decisionLabels(
  item: Pick<DownloadItem, 'state' | 'danger' | 'dangerAccepted'>
): DecisionLabels {
  if (isInsecureBlocked(item)) {
    return {
      keep: canKeepInsecureDownload(item) ? 'Keep anyway' : null,
      discard: 'Discard',
      prominent: 'discard'
    }
  }
  return dangerActionLabels()
}

/**
 * The status of an interrupted row the engine will try again on its own (HB-43): `Resuming in
 * N s…` counting down to `autoResumeAt`, `Resuming…` once the moment has come and the host's
 * progress has not (Chrome's own line, `IDS_DOWNLOAD_BUBBLE_STATUS_RESUMING`). N is whole
 * seconds rounded up, so a schedule 2 s out reads 2, 1, then Resuming…
 */
export function autoResumeStatus(autoResumeAt: number, now: number): string {
  const seconds = Math.ceil((autoResumeAt - now) / 1000)
  return seconds > 0 ? `Resuming in ${seconds} s…` : 'Resuming…'
}

/**
 * The one-line status under the file name: the engine's speed and time left while running,
 * `Failed · <reason>` when interrupted (the engine's sentence as the line's tooltip) – or, while
 * the engine will try the transfer again on its own (HB-43), `Resuming in N s…` in the plain
 * ink, counting down from `now` (the row re-renders each second to move it; the failure's
 * sentence stays the tooltip) – Chrome's blocked status with the verdict's sentence as its
 * detail while a flagged file waits, `Deleted` for a finished file the engine found gone from
 * disk. The interface's verbs table names each state's line.
 */
export function downloadStatus(item: DownloadItem, now = Date.now()): DownloadStatus {
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
      if (awaitsAutoResume(item)) {
        return {
          text: autoResumeStatus(item.autoResumeAt, now),
          tone: 'muted',
          hint: item.errorMessage || undefined
        }
      }
      return {
        text: describeDownloadError(item.error),
        tone: 'danger',
        hint: item.errorMessage || undefined
      }
    // Refused before a byte was written (HB-44); the row waits for Keep anyway or Discard. The
    // engine's default wording: the desktop program draws the state from the interface.
    case 'insecure-blocked':
      return {
        text: 'Blocked · Insecure download',
        tone: item.danger.level === 'dangerous' ? 'danger' : 'warn',
        detail: insecureSummary(item)
      }
    case 'completed':
      if (needsDangerDecision(item)) {
        return {
          text: blockedStatus(item.danger),
          tone: item.danger.level === 'dangerous' ? 'danger' : 'warn',
          detail: dangerSummary(item.danger)
        }
      }
      if (isDeletedRow(item)) return { text: 'Deleted', tone: 'muted' }
      return { text: total ? `Done · ${total}` : 'Done', tone: 'muted' }
  }
}

/**
 * Chrome's greyed "Deleted" row: a finished file the engine found gone from disk – deleted
 * through "Delete file" or by the user outside the browser (`fileMissing`, which the engine
 * sets only on a completed, released file). Its name and glyph go to the deemphasised ink,
 * nothing opens or reveals it, Retry downloads it again and Remove from list still applies.
 */
export function isDeletedRow(item: Pick<DownloadItem, 'state' | 'fileMissing'>): boolean {
  return item.state === 'completed' && item.fileMissing === true
}

/**
 * A finished file that can be opened, shown, dragged or deleted (a flagged one waits for Keep;
 * one the engine found deleted has nothing to open).
 */
export function isOnDisk(item: DownloadItem): boolean {
  return item.state === 'completed' && !needsDangerDecision(item) && !isDeletedRow(item)
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
