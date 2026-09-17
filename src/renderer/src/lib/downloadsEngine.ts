import type { UIState } from '@shared/types'
import {
  diffDownloads,
  listedDownloads,
  needsDangerDecision,
  snapshotDownloads,
  type DownloadChange,
  type DownloadRecord
} from '@shared/downloadsShell'
import { run } from './api'
import { browserStore, openOverlay } from './ui'

/*
 * The renderer's adapter to the downloads engine, in the vocabulary of the engine contract
 * (shared services own the engine). The list comes from `StateSnapshot.downloads`; commands map
 * onto the `download.*` commands `main` has today; `download.changed`-style events are derived
 * from consecutive list snapshots. Commands the current engine lacks are `null`: the UI hides
 * their controls and shows them once the engine that provides them lands.
 */

type IdCommand = (id: string) => void

export interface DownloadsEngine {
  /** Records the lists show, newest first, without the ones the user removed. */
  list(state: UIState): DownloadRecord[]
  pause: IdCommand
  resume: IdCommand
  cancel: IdCommand
  open: IdCommand
  showInFolder: IdCommand
  /** Removes the record from the list; the file stays on disk. */
  remove: IdCommand
  /** Clear all: every record that is not still transferring. */
  removeCompleted(): void
  /** The Ctrl+J page (`zen://downloads`). */
  openPanel(activeTabId: string | null): void
  /** Desktop UI plumbing: hand a finished file to the OS drag the host starts. */
  dragOut: IdCommand
  /** Desktop UI plumbing: the downloads folder in the file manager. */
  openFolder(): void
  /** Start an interrupted or cancelled download again (engine contract `download.retry`). */
  retry: IdCommand | null
  /** Keep a file the engine flagged (`download.acceptDanger`). */
  acceptDanger: IdCommand | null
  /** Cancel and delete a flagged file (`download.discard`). */
  discard: IdCommand | null
  /** `download.setOpenWhenDone`. */
  setOpenWhenDone: ((id: string, on: boolean) => void) | null
  /** `download.chooseDirectory`: pick the folder downloads are saved to. */
  chooseDirectory: (() => Promise<string | null>) | null
}

export const downloadsEngine: DownloadsEngine = {
  list: (state) => listedDownloads(state.downloads),
  pause: (id) => run('download.pause', { id }),
  resume: (id) => run('download.resume', { id }),
  cancel: (id) => run('download.cancel', { id }),
  open: (id) => run('download.open', { id }),
  showInFolder: (id) => run('download.showInFolder', { id }),
  remove: (id) => run('download.remove', { id }),
  removeCompleted: () => run('download.clearCompleted', undefined),
  openPanel: (activeTabId) => void openOverlay('downloads', activeTabId),
  dragOut: (id) => run('download.dragOut', { id }),
  openFolder: () => run('download.openFolder', undefined),
  retry: null,
  acceptDanger: null,
  discard: null,
  setOpenWhenDone: null,
  chooseDirectory: null
}

/**
 * Whether a row shows Keep / Discard instead of its actions: the engine flagged the file and
 * it provides the verdict commands to answer with.
 */
export function showsDangerDecision(item: DownloadRecord): boolean {
  return (
    Boolean(downloadsEngine.acceptDanger && downloadsEngine.discard) && needsDangerDecision(item)
  )
}

type ChangeListener = (change: DownloadChange, state: UIState) => void

const listeners = new Set<ChangeListener>()
let previous: DownloadRecord[] | null = null
let unsubscribe: (() => void) | null = null

function onState(): void {
  const state = browserStore.get().state
  if (!state) return
  // The first list is what was on disk when the chrome loaded: nothing in it just happened.
  if (previous === null) {
    previous = snapshotDownloads(state.downloads)
    return
  }
  const changes = diffDownloads(previous, state.downloads)
  previous = snapshotDownloads(state.downloads)
  for (const change of changes) for (const listener of listeners) listener(change, state)
}

/**
 * Subscribe to `download.changed`-style events (`started`, `progress`, `done`, `removed`),
 * each with the record and the snapshot it arrived in.
 */
export function onDownloadChanged(listener: ChangeListener): () => void {
  listeners.add(listener)
  if (!unsubscribe) {
    onState()
    unsubscribe = browserStore.subscribe(onState)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && unsubscribe) {
      unsubscribe()
      unsubscribe = null
      previous = null
    }
  }
}
