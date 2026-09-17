import { useEffect, useMemo, useRef, useState } from 'react'
import type { UIState } from '@shared/types'
import { BookmarkTree } from '@shared/bookmarks'
import { useBackSurface } from '@renderer/lib/back'
import { pushToast, uiStore } from '@renderer/lib/ui'
import { undoableDeletes } from '@renderer/lib/undo'

/**
 * What the phone panels share besides their look: undoable deletes and the step back inside a
 * panel that the system back gesture takes before dismissing the panel itself.
 */

/** The rows hidden by deletes that can still be undone; re-renders as they are undone or go through. */
export function usePendingDeletes(): ReadonlySet<string> {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => undoableDeletes.pendingKeys())
  useEffect(() => undoableDeletes.subscribe(() => setKeys(undoableDeletes.pendingKeys())), [])
  return keys
}

/** Hide `keys` now, run `commit` after the grace period, and offer Undo in a toast meanwhile. */
export function removeWithUndo(keys: readonly string[], message: string, commit: () => void): void {
  const handle = undoableDeletes.schedule(keys, commit)
  pushToast(message, 'info', {
    action: {
      label: 'Undo',
      run: () => {
        handle.undo()
      }
    }
  })
}

/**
 * A step back inside a panel – leaving selection mode, climbing out of a folder – taken by the
 * system back gesture and Escape ahead of the panel's own dismissal. The shell that dismisses the
 * panel is rendered *inside* it, so its surface is registered first and this one sits on top.
 */
export function usePanelStep(enabled: boolean, step: () => void): void {
  const latest = useRef(step)
  useEffect(() => {
    latest.current = step
  })
  useBackSurface(enabled ? { name: 'panel-step', onCommit: () => latest.current() } : null)
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // A sheet above the panel (a menu, the bookmark editor) takes its own Escape.
      const ui = uiStore.get()
      if (ui.menu || ui.bookmarkEdit) return
      e.preventDefault()
      e.stopImmediatePropagation()
      latest.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [enabled])
}

/** Index over the mirrored bookmark nodes; rebuilt when the core pushes a new list. */
export function useBookmarkTree(state: UIState): BookmarkTree {
  return useMemo(() => new BookmarkTree(state.bookmarks), [state.bookmarks])
}
