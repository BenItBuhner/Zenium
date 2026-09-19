import type {
  DownloadChangeKind,
  DownloadDeleteFileResult,
  DownloadItem,
  UIState
} from '@shared/types'
import { needsDangerDecision } from '@shared/downloadsShell'
import { cmd, onEvent, run } from './api'
import { openOverlay } from './ui'

/*
 * The renderer's handle on the downloads engine (shared services own it, PR #69), in the
 * contract's vocabulary: the list rides in `StateSnapshot.downloads`, every `download.*`
 * command is the engine's, and `download.changed` / `download.danger` arrive as events. What
 * stays here beyond one-liners is desktop UI plumbing the contract leaves to this program:
 * drag-out, the downloads folder, and the panel (the Ctrl+J page is a chrome overlay).
 */

type IdCommand = (id: string) => void

export interface DownloadsEngine {
  /** Records the lists show, newest first (the engine drops removed rows itself). */
  list(state: UIState): DownloadItem[]
  pause: IdCommand
  /** Continues a paused or resumable interrupted transfer; otherwise starts over. */
  resume: IdCommand
  cancel: IdCommand
  open: IdCommand
  showInFolder: IdCommand
  /** Removes the record from the list; the file stays on disk. */
  remove: IdCommand
  /** Clear all: every record that is not still transferring. */
  removeCompleted(): void
  /** Start an interrupted or cancelled download again, keeping its row. */
  retry: IdCommand
  /** Keep a file the engine flagged. */
  acceptDanger: IdCommand
  /** Discard a flagged file (or what is left of a failed one) and drop the row. */
  discard: IdCommand
  setOpenWhenDone(id: string, on: boolean): void
  /**
   * Chrome's "Delete file": the finished file goes from disk and the row stays, reading
   * Deleted (`fileMissing`, which the engine's `download.changed` carries). Resolves with what
   * happened; `failed` leaves the file and the row as they were.
   */
  deleteFile(id: string): Promise<DownloadDeleteFileResult>
  /**
   * Ask the engine whether the finished files among `items` are still on disk (Chrome checks
   * when its bubble or page opens); every row whose answer changed follows as `download.changed`.
   */
  refreshFiles(items: readonly DownloadItem[]): void
  /** Pick the folder downloads are saved to; null when the dialog was dismissed. */
  chooseDirectory(): Promise<string | null>
  /** The Ctrl+J page (`zen://downloads`). */
  openPanel(activeTabId: string | null): void
  /** Desktop UI plumbing: hand a finished file to the OS drag the host starts. */
  dragOut: IdCommand
  /** Desktop UI plumbing: the downloads folder in the file manager. */
  openFolder(): void
  /**
   * The row's context menu (downloads-11), built by the core from the record's state; at the
   * pointer, or at `x, y` with `keyboard` when the menu key or Shift+F10 opened it.
   */
  contextMenu(id: string, at?: { x: number; y: number; keyboard?: boolean }): void
}

export const downloadsEngine: DownloadsEngine = {
  list: (state) => state.downloads,
  pause: (id) => run('download.pause', { id }),
  resume: (id) => run('download.resume', { id }),
  cancel: (id) => run('download.cancel', { id }),
  open: (id) => run('download.open', { id }),
  showInFolder: (id) => run('download.showInFolder', { id }),
  remove: (id) => run('download.remove', { id }),
  removeCompleted: () => run('download.removeCompleted', undefined),
  retry: (id) => run('download.retry', { id }),
  acceptDanger: (id) => run('download.acceptDanger', { id }),
  discard: (id) => run('download.discard', { id }),
  setOpenWhenDone: (id, on) => run('download.setOpenWhenDone', { id, on }),
  deleteFile: (id) => cmd('download.deleteFile', { id }),
  refreshFiles: (items) => {
    for (const item of items) {
      if (hasReleasedFile(item)) run('download.exists', { id: item.id })
    }
  },
  chooseDirectory: () => cmd('download.chooseDirectory', undefined),
  openPanel: (activeTabId) => void openOverlay('downloads', activeTabId),
  dragOut: (id) => run('download.dragOut', { id }),
  openFolder: () => run('download.openFolder', undefined),
  contextMenu: (id, at) => run('download.contextMenu', { id, ...at })
}

/** A row shows Keep / Discard instead of its actions while the engine holds its file back. */
export function showsDangerDecision(item: DownloadItem): boolean {
  return needsDangerDecision(item)
}

/**
 * A finished file the engine released to the user – the rows whose presence on disk is worth
 * a check, marked Deleted or not (a file that came back is un-marked). Never a row still
 * running, cancelled, failed or waiting behind a warning: `download.exists` says false for
 * those without looking.
 */
function hasReleasedFile(item: DownloadItem): boolean {
  return item.state === 'completed' && !needsDangerDecision(item)
}

export interface DownloadChange {
  item: DownloadItem
  kind: DownloadChangeKind
}

/**
 * The engine's `download.changed` (`started`, `progress` at 4 Hz, `done` for completed,
 * cancelled and interrupted alike, `removed`), each with the record as it was sent.
 */
export function onDownloadChanged(listener: (change: DownloadChange) => void): () => void {
  return onEvent('download.changed', listener)
}

/** The engine's `download.danger`: a flagged file finished and waits for Keep / Discard. */
export function onDownloadDanger(listener: (id: string) => void): () => void {
  return onEvent('download.danger', ({ id }) => listener(id))
}
