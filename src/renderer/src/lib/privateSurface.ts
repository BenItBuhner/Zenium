import type { UIState } from '@shared/types'
import { overviewInteractive, stageStore } from './gestures/stage'
import { overviewPane, privateSurfaceActive, privateTabsStore } from './privateTabs'
import { browserStore } from './ui'

/**
 * The private surface as the chrome stands right now (`privateSurfaceActive` over the live
 * stores): the theme blend in `useTheme`, and on Android the status bar and the window's
 * screenshot guard (`boot.ts`), all read the one answer.
 */
export function privateSurfaceNow(state: UIState | null = browserStore.get().state): boolean {
  if (!state) return false
  const overviewUp = overviewInteractive(stageStore.get().overview)
  return privateSurfaceActive(state, overviewUp, overviewPane(state, privateTabsStore.get().pane))
}

/** Calls `listener` with the new answer whenever the private surface comes or goes. */
export function subscribePrivateSurface(listener: (active: boolean) => void): () => void {
  let last = privateSurfaceNow()
  const check = (): void => {
    const now = privateSurfaceNow()
    if (now === last) return
    last = now
    listener(now)
  }
  const offs = [
    browserStore.subscribe(check),
    stageStore.subscribe(check),
    privateTabsStore.subscribe(check)
  ]
  return () => offs.forEach((off) => off())
}

/** The private surface for a rendering component, from the state it renders. */
export function usePrivateSurface(state: UIState): boolean {
  const overviewUp = stageStore.use((s) => overviewInteractive(s.overview))
  const picked = privateTabsStore.use((s) => s.pane)
  return privateSurfaceActive(state, overviewUp, overviewPane(state, picked))
}
