import type { UIState } from '@shared/types'
import { cmd, onEvent } from './api'
import { createStore } from './store'
import { shareUnchanged } from './structuralShare'

// ---------------------------------------------------------------------------
// Browser state mirrored from the main process
// ---------------------------------------------------------------------------

/**
 * The core's `UIState` as the chrome last received it. A module of its own so the layout
 * (`formFactor.ts`, which reads the window's chrome from it) and the UI state (`ui.ts`, which
 * reads the layout) can both import it without importing each other; `ui.ts` re-exports it.
 */
export const browserStore = createStore<{ state: UIState | null }>({ state: null }, 'browser')

export function useBrowser(): UIState {
  const state = browserStore.use((s) => s.state)
  if (!state) throw new Error('Browser state not loaded')
  return state
}

/**
 * Takes a snapshot in: the fresh object, with every tab, space and list that did not change
 * since the snapshot before it kept as the object it was (`structuralShare.ts`), so a row or a
 * memo below the root sees "the same" by `===` and is spared the render.
 */
function receiveState(state: UIState): void {
  browserStore.set({ state: shareUnchanged(browserStore.get().state, state) })
}

export function startBrowserSync(): void {
  const flags = globalThis as unknown as { __zenSyncStarted?: boolean }
  if (flags.__zenSyncStarted) return
  flags.__zenSyncStarted = true
  onEvent('state', receiveState)
  void cmd('app.getState', undefined).then(receiveState)
}
