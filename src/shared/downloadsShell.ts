import type {
  DownloadDeleteFileResult,
  DownloadInterruptReason,
  DownloadItem,
  DownloadSettings,
  DownloadsProgress
} from './types'

/*
 * Desktop-side view of the downloads engine (shared services own the engine itself, PR #69).
 * Everything here is pure: the row predicates the desktop UI shares between the bubble, the
 * page and the OS shell, the taskbar mapping of the engine's aggregate progress, and the
 * completion notification the desktop program owns under the contract.
 */

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** The name a row shows: the engine's final on-disk name, the suggested one for rows without. */
export function displayName(item: Pick<DownloadItem, 'filename' | 'finalName'>): string {
  return item.finalName || item.filename || 'download'
}

export function isActiveDownload(item: Pick<DownloadItem, 'state'>): boolean {
  return item.state === 'progressing' || item.state === 'paused'
}

/**
 * A finished file the engine holds back behind its warning until the user keeps or discards it
 * (the core's `isQuarantined`, restated here so the renderer needs nothing from `core/`).
 */
export function needsDangerDecision(
  item: Pick<DownloadItem, 'state' | 'danger' | 'dangerAccepted'>
): boolean {
  return item.state === 'completed' && item.danger.level !== 'safe' && !item.dangerAccepted
}

/**
 * The interrupt reasons a Retry can get past, as Chrome 112's bubble offers it: the transfer
 * stopped for something that need not hold next time – the network, the server failing or
 * unreachable, a range it would not serve, a write that failed, the app closing or crashing,
 * a cancel. A verdict the same request meets again gets none: the site lacking or refusing the
 * file, a virus scan, an organisation's policy, a file system limit (space, name length, size,
 * permission), a file already downloaded.
 */
const RETRYABLE_REASONS: ReadonlySet<DownloadInterruptReason> = new Set<DownloadInterruptReason>([
  'network-failed',
  'network-timeout',
  'network-disconnected',
  'network-server-down',
  'server-failed',
  'server-no-range',
  'server-unreachable',
  'file-failed',
  'user-canceled',
  'user-shutdown',
  'crash'
])

/**
 * Whether Retry is offered for a failure with this reason; a failed row without one (nothing
 * the engine could name) is offered it, as before the reasons existed.
 */
export function retryableInterrupt(reason: DownloadInterruptReason | undefined): boolean {
  return reason === undefined || RETRYABLE_REASONS.has(reason)
}

/**
 * Cancelled rows can start over, and so can a failed one whose reason a retry can get past
 * (`retryableInterrupt`) and a finished one whose file the engine found gone from disk
 * (`fileMissing`, Chrome's Retry on a "Deleted" row); never `blob:` ones (the page's object is
 * gone). The core's `canRetry` says what the engine accepts; this says what the desktop offers.
 */
export function canRetryDownload(
  item: Pick<DownloadItem, 'state' | 'url' | 'fileMissing' | 'error'>
): boolean {
  if (item.url.startsWith('blob:')) return false
  if (item.state === 'cancelled') return true
  if (item.state === 'interrupted') return retryableInterrupt(item.error)
  return item.state === 'completed' && item.fileMissing === true
}

/** An interrupted row that can pick up where it stopped (paused rows always can). */
export function canResumeDownload(item: Pick<DownloadItem, 'state' | 'canResume'>): boolean {
  return item.state === 'paused' || (item.state === 'interrupted' && item.canResume)
}

/**
 * What the desktop says after `download.deleteFile` (the row's action and its menu item):
 * nothing when the file went (`deleted`) or was gone already (`missing`) – the row reads
 * Deleted either way – and an error toast when it is still there (`failed`: locked, a folder,
 * no permission). `not-completed` means the row changed under the click (it runs again, or
 * went) and speaks for itself.
 */
export function deleteFileToast(result: DownloadDeleteFileResult, name: string): string | null {
  return result === 'failed' ? `Couldn’t delete “${name}”` : null
}

// ---------------------------------------------------------------------------
// Aggregate progress (toolbar ring, taskbar, dock)
// ---------------------------------------------------------------------------

/** 0–1 of `progress`, 0 while indeterminate or idle. */
export function progressFraction(progress: DownloadsProgress): number {
  if (progress.indeterminate || progress.total <= 0) return 0
  return Math.min(1, progress.received / progress.total)
}

export type ProgressBarMode = 'none' | 'normal' | 'indeterminate' | 'paused' | 'error'

export interface ProgressBar {
  /** `BrowserWindow.setProgressBar` value: -1 clears, 0–1 fills, above 1 is indeterminate. */
  value: number
  mode: ProgressBarMode
}

/** How long the taskbar entry shows a failure before it goes back to the aggregate. */
export const PROGRESS_ERROR_FLASH_MS = 3000

/**
 * What the taskbar (and the toolbar ring) shows for the engine's aggregate: nothing when no
 * transfer runs, the shared fraction otherwise, greyed while every transfer is paused,
 * indeterminate when a running transfer has no size.
 */
export function progressBarFor(progress: DownloadsProgress, allPaused: boolean): ProgressBar {
  if (progress.active === 0) return { value: -1, mode: 'none' }
  if (progress.indeterminate)
    return { value: allPaused ? 0 : 2, mode: allPaused ? 'paused' : 'indeterminate' }
  return { value: progressFraction(progress), mode: allPaused ? 'paused' : 'normal' }
}

/**
 * The taskbar entry just after a transfer failed while others still run: the aggregate's fill
 * in the OS's error tone (red on Windows; hosts without one paint it as usual) for
 * `PROGRESS_ERROR_FLASH_MS`, then `progressBarFor` again. A failure that leaves nothing in
 * flight clears the bar at once, as Chrome does – the toolbar badge carries the failure.
 */
export function failedProgressBar(progress: DownloadsProgress): ProgressBar {
  if (progress.active === 0) return { value: -1, mode: 'none' }
  // Above 1 would turn the entry indeterminate and lose the tone: a size-less aggregate fills.
  return { value: progress.indeterminate ? 1 : progressFraction(progress), mode: 'error' }
}

/** Every in-flight row is paused (the bar greys out); false when nothing is in flight. */
export function allPaused(items: ReadonlyArray<Pick<DownloadItem, 'state'>>): boolean {
  const active = items.filter(isActiveDownload)
  return active.length > 0 && active.every((i) => i.state === 'paused')
}

/** Two bars that would paint the same (the taskbar is only told about visible changes). */
export function sameProgressBar(a: ProgressBar, b: ProgressBar): boolean {
  return a.mode === b.mode && Math.round(a.value * 100) === Math.round(b.value * 100)
}

// ---------------------------------------------------------------------------
// Completion notification
// ---------------------------------------------------------------------------

export interface CompletionNotice {
  title: string
  body: string
}

/** The OS notification for a finished download (shown while no window is focused). */
export function completionNotice(
  item: Pick<DownloadItem, 'filename' | 'finalName'>
): CompletionNotice {
  return { title: 'Download complete', body: displayName(item) }
}

/**
 * Whether a `download.changed` of kind `done` deserves an OS notification: only files that
 * completed and were released (a flagged file waits for Keep in the bubble instead), only when
 * the setting is on, and only while no Zenium window has focus (a focused window shows the
 * bubble).
 */
export function shouldNotifyCompletion(
  item: Pick<DownloadItem, 'state' | 'danger' | 'dangerAccepted'>,
  settings: Pick<DownloadSettings, 'notifyOnComplete'>,
  anyWindowFocused: boolean
): boolean {
  return (
    item.state === 'completed' &&
    !needsDangerDecision(item) &&
    settings.notifyOnComplete &&
    !anyWindowFocused
  )
}
