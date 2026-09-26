import type { UIState } from '@shared/types'
import { searchChoiceListRegion } from '@core/searchChoice'

/**
 * The EEA's search-engine choice screen (W6-2; DMA Art. 6(3)) on the desktop and tablet
 * shells, and on the phone's (OMN-26). The model – the region gate, the list, the record – is
 * the core's (`core/searchChoice.ts`, read through `UIState.searchChoice`); these are the terms
 * the chrome mounts the screen on, whichever shell draws it.
 */

/**
 * Whether the screen stands over this window's chrome on its own (`SearchChoiceScreen`,
 * mounted by `App.tsx` / `TabletShell.tsx`; `PhoneSearchChoiceScreen` by `PhoneShell.tsx`):
 * the screen is owed and the first-run tour is done – before that the tour's search step IS the
 * screen (`tourAsksSearchChoice`) – on the profile's synced window; never a blank or private
 * window, a page's popup or a web app's window, as the tour (`onboardingCovers`). Chrome that
 * waits for the tour (the URL bar, `onboardingUp`) waits for this too.
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

/** The phone list's fold, from its measurements (`phoneSearchChoiceListHeight`). */
export interface PhoneSearchChoiceListFit {
  /** The height the list may take, from its top to the column's bottom padding, in px. */
  available: number
  /** One tile's height as laid out (§9.39's 52; taller where a line wraps and the grid equalises). */
  row: number
  /** The gap between tiles (§9.39's 4: the 56 pitch). */
  gap: number
  /** The list box's own padding, the ring room round the first and last tiles (`--v2-ring-room`). */
  ring: number
  /** How many tiles the list has. */
  count: number
}

/**
 * The phone list's box height under §9.39's scroller rule, or null for no cap: the desktop
 * panel's list shows five tiles whole and the sixth cut at half its height (26 of 52) – a row
 * cut is the pull's affordance (§9.13) where a clean edge would read as the list's end – and
 * "on a frame tall enough the list may grow to show all". The phone has no fixed panel: its
 * column gives the list what the title block leaves it, so the count is the frame's – as many
 * whole tiles as fit with half of the next one under them, at least two – and where every tile
 * fits whole the list takes no cap and nothing scrolls. Chromium 113 (the API 34 image's
 * WebView) has no CSS `round()`, so the arithmetic is here and the measurement the step's.
 */
export function phoneSearchChoiceListHeight(fit: PhoneSearchChoiceListFit): number | null {
  const { available, row, gap, ring, count } = fit
  if (row <= 0 || count <= 0) return null
  const pitch = row + gap
  const whole = ring * 2 + count * pitch - gap
  if (whole <= available) return null
  const half = row / 2
  const fitting = Math.floor((available - ring * 2 - half + gap) / pitch)
  const shown = Math.min(count - 1, Math.max(2, fitting))
  return ring * 2 + shown * pitch - gap + half
}
