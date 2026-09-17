import type { DownloadItem, DownloadSettings } from './types'

/*
 * Desktop-side view of the downloads engine (shared services own the engine itself). Everything
 * here is pure: the additive record fields of the engine contract, the settings keys the desktop
 * UI binds to, the aggregate progress the taskbar and the toolbar ring show, and the diff that
 * turns two list snapshots into `download.changed`-style events.
 */

// ---------------------------------------------------------------------------
// The engine contract's additive record fields
// ---------------------------------------------------------------------------

export type DownloadDangerLevel = 'safe' | 'suspicious' | 'dangerous'

export interface DownloadDanger {
  level: DownloadDangerLevel
  /** Machine reason ('executable', 'archive', 'insecure-download', 'url-verdict', ...). */
  reason: string
  /** Human sentence for the row, already worded by the engine. */
  message: string
}

/**
 * Fields the engine contract adds to `DownloadItem`. They are optional here because the engine
 * that publishes them is not on `main` yet: the UI shows each one when it is present and leaves
 * it out otherwise, so the same components work before and after the engine lands.
 */
export interface DownloadExtras {
  referrer?: string
  /** File name as finally chosen on disk (`name (1).ext`); `filename` is the suggested one. */
  finalName?: string
  /** The interrupted transfer can continue from `receivedBytes`. */
  canResume?: boolean
  /** Why the transfer stopped, while `state === 'interrupted'`. */
  error?: string
  danger?: DownloadDanger
  dangerAccepted?: boolean
  openWhenDone?: boolean
  bytesPerSecond?: number
  etaMs?: number | null
  completedAt?: number
  /** Removed from the list by the user; the file stays on disk. */
  removed?: boolean
}

export type DownloadRecord = DownloadItem & DownloadExtras

/** The name a row shows: the engine's final on-disk name when it reports one. */
export function displayName(item: DownloadRecord): string {
  return item.finalName || item.filename || 'download'
}

export function isActiveDownload(item: Pick<DownloadItem, 'state'>): boolean {
  return item.state === 'progressing' || item.state === 'paused'
}

/** A verdict the user still has to answer with Keep or Discard. */
export function needsDangerDecision(item: DownloadRecord): boolean {
  if (!item.danger || item.danger.level === 'safe' || item.dangerAccepted) return false
  return item.state === 'completed' || isActiveDownload(item)
}

/** Items the lists show (the engine keeps removed ones around for the file on disk). */
export function listedDownloads(items: readonly DownloadRecord[]): DownloadRecord[] {
  return items.filter((i) => !i.removed)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const DEFAULT_DOWNLOAD_SETTINGS: DownloadSettings = {
  directory: null,
  askWhereToSave: false,
  notifyOnComplete: true,
  openPanelOnStart: false,
  openPanelOnComplete: true,
  autoOpenTypes: [],
  alwaysShowButton: false
}

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

/**
 * Bring a stored `settings.downloads` up to shape. `legacyAskWhereToSave` is the pre-contract
 * top-level `Settings.askWhereToSave`, inherited when the nested key has never been written.
 */
export function sanitizeDownloadSettings(
  raw: Partial<DownloadSettings> | undefined | null,
  legacyAskWhereToSave?: boolean
): DownloadSettings {
  const d = DEFAULT_DOWNLOAD_SETTINGS
  const r: Partial<DownloadSettings> = raw && typeof raw === 'object' ? raw : {}
  return {
    directory: typeof r.directory === 'string' && r.directory ? r.directory : null,
    askWhereToSave: bool(r.askWhereToSave, bool(legacyAskWhereToSave, d.askWhereToSave)),
    notifyOnComplete: bool(r.notifyOnComplete, d.notifyOnComplete),
    openPanelOnStart: bool(r.openPanelOnStart, d.openPanelOnStart),
    openPanelOnComplete: bool(r.openPanelOnComplete, d.openPanelOnComplete),
    autoOpenTypes: Array.isArray(r.autoOpenTypes)
      ? r.autoOpenTypes.filter((t): t is string => typeof t === 'string')
      : [...d.autoOpenTypes],
    alwaysShowButton: bool(r.alwaysShowButton, d.alwaysShowButton)
  }
}

// ---------------------------------------------------------------------------
// Aggregate progress (toolbar ring, taskbar, dock)
// ---------------------------------------------------------------------------

/** The contract's `StateSnapshot.downloadsProgress` shape, computed here until the engine publishes it. */
export interface DownloadsProgress {
  received: number
  total: number
  /** An active transfer has no known size, so no fraction is meaningful. */
  indeterminate: boolean
}

export function aggregateProgress(
  items: ReadonlyArray<Pick<DownloadItem, 'state' | 'receivedBytes' | 'totalBytes'>>
): DownloadsProgress {
  const active = items.filter(isActiveDownload)
  if (active.length === 0) return { received: 0, total: 0, indeterminate: false }
  if (active.some((i) => i.totalBytes <= 0)) return { received: 0, total: 0, indeterminate: true }
  let received = 0
  let total = 0
  for (const i of active) {
    total += i.totalBytes
    received += Math.min(i.receivedBytes, i.totalBytes)
  }
  return { received, total, indeterminate: false }
}

/** 0–1 of `progress`, 0 while indeterminate or idle. */
export function progressFraction(progress: DownloadsProgress): number {
  if (progress.indeterminate || progress.total <= 0) return 0
  return Math.min(1, progress.received / progress.total)
}

export type ProgressBarMode = 'none' | 'normal' | 'indeterminate' | 'paused'

export interface ProgressBar {
  /** `BrowserWindow.setProgressBar` value: -1 clears, 0–1 fills, above 1 is indeterminate. */
  value: number
  mode: ProgressBarMode
}

/**
 * What the taskbar (and the toolbar ring) shows for the list: nothing when no transfer runs,
 * the shared fraction otherwise, greyed while every transfer is paused, indeterminate when a
 * size is unknown.
 */
export function progressBarFor(
  items: ReadonlyArray<Pick<DownloadItem, 'state' | 'receivedBytes' | 'totalBytes'>>
): ProgressBar {
  const active = items.filter(isActiveDownload)
  if (active.length === 0) return { value: -1, mode: 'none' }
  const progress = aggregateProgress(active)
  const allPaused = active.every((i) => i.state === 'paused')
  if (progress.indeterminate)
    return { value: allPaused ? 0 : 2, mode: allPaused ? 'paused' : 'indeterminate' }
  return { value: progressFraction(progress), mode: allPaused ? 'paused' : 'normal' }
}

/** Two bars that would paint the same (the taskbar is only told about visible changes). */
export function sameProgressBar(a: ProgressBar, b: ProgressBar): boolean {
  return a.mode === b.mode && Math.round(a.value * 100) === Math.round(b.value * 100)
}

// ---------------------------------------------------------------------------
// `download.changed` from two list snapshots
// ---------------------------------------------------------------------------

export type DownloadChangeKind = 'started' | 'progress' | 'done' | 'removed'

export interface DownloadChange {
  item: DownloadRecord
  kind: DownloadChangeKind
}

/**
 * The engine contract's `download.changed { item, kind }` events, derived from consecutive
 * `StateSnapshot.downloads` lists (the only notification the engine on `main` sends). New
 * records are `started` when in flight and `done` when they arrive finished (files the browser
 * produced itself); a record that left the list is `removed`.
 */
export function diffDownloads(
  previous: readonly DownloadRecord[],
  next: readonly DownloadRecord[]
): DownloadChange[] {
  const before = new Map(previous.map((i) => [i.id, i]))
  const changes: DownloadChange[] = []
  for (const item of next) {
    const prev = before.get(item.id)
    before.delete(item.id)
    if (!prev) {
      changes.push({ item, kind: isActiveDownload(item) ? 'started' : 'done' })
      continue
    }
    if (prev.state !== item.state) {
      changes.push({ item, kind: isActiveDownload(item) ? 'progress' : 'done' })
    } else if (
      isActiveDownload(item) &&
      (prev.receivedBytes !== item.receivedBytes || prev.totalBytes !== item.totalBytes)
    ) {
      changes.push({ item, kind: 'progress' })
    }
  }
  for (const item of before.values()) changes.push({ item, kind: 'removed' })
  return changes
}

/** Records are mutated in place by the engine; keep a copy to diff the next snapshot against. */
export function snapshotDownloads(items: readonly DownloadRecord[]): DownloadRecord[] {
  return items.map((i) => ({ ...i }))
}

// ---------------------------------------------------------------------------
// Completion notification
// ---------------------------------------------------------------------------

export interface CompletionNotice {
  title: string
  body: string
}

/** The OS notification for a finished download (shown while no window is focused). */
export function completionNotice(item: DownloadRecord): CompletionNotice {
  return { title: 'Download complete', body: displayName(item) }
}

/**
 * Whether a finished download deserves an OS notification: only completions, only when the
 * setting is on, and only while no Zenium window has focus (a focused window shows the bubble).
 */
export function shouldNotifyCompletion(
  item: DownloadRecord,
  settings: Pick<DownloadSettings, 'notifyOnComplete'>,
  anyWindowFocused: boolean
): boolean {
  return item.state === 'completed' && settings.notifyOnComplete && !anyWindowFocused
}
