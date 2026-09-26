import type { UIState } from '@shared/types'
import { searchChoiceListRegion } from '@core/searchChoice'

/**
 * The EEA's search-engine choice screen (W6-2; DMA Art. 6(3)) on the desktop and tablet
 * shells. The model – the region gate, the list, the record – is the core's
 * (`core/searchChoice.ts`, read through `UIState.searchChoice`); these are the terms the chrome
 * mounts the screen on. The phone shell reads neither: it draws nothing until Android has a
 * screen of its own.
 */

/**
 * Whether the screen stands over this window's chrome on its own (`SearchChoiceScreen`,
 * mounted by `App.tsx` / `TabletShell.tsx`): the screen is owed and the first-run tour is done –
 * before that the tour's search step IS the screen (`tourAsksSearchChoice`) – on the profile's
 * synced window; never a blank or private window, a page's popup or a web app's window, as the
 * tour (`onboardingCovers`). Chrome that waits for the tour (the URL bar, `onboardingUp`) waits
 * for this too.
 */
export function searchChoiceCovers(
  state: Pick<UIState, 'settings' | 'window' | 'searchChoice'>
): boolean {
  const { chrome, kind } = state.window
  return (
    state.settings.onboardingDone &&
    state.searchChoice?.required === true &&
    kind === 'synced' &&
    chrome !== 'popup' &&
    chrome !== 'app'
  )
}

/**
 * Whether the tour's search step is the choice screen: the screen is owed at the first run (the
 * device is in the EEA with no record). Outside the EEA the step keeps its three tiles.
 */
export function tourAsksSearchChoice(state: Pick<UIState, 'searchChoice'>): boolean {
  return state.searchChoice?.required === true
}

/**
 * The region whose list the screen draws (`shuffledSearchChoiceTiles`): the core's resolution
 * over the host's region and the device's record (`searchChoiceListRegion`), so the list shown
 * is the list `searchChoice.choose` accepts a pick from.
 */
export function searchChoiceListRegionOf(
  state: Pick<UIState, 'settings' | 'searchChoice'>
): string | null {
  return searchChoiceListRegion(state.searchChoice?.region, state.settings.searchChoice)
}
