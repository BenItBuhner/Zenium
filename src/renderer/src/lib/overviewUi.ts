import type { ArchivedTabSummary } from '@shared/types'
import { pushBackSurface } from './back'
import type { ClosedEntrySummary } from './historyAdapter'
import { NO_SELECTION, type OverviewSelection } from './overviewSelection'
import { resetOverviewWindow } from './overviewWindow'
import type { OverviewPane } from './privateTabs'
import { createStore } from './store'

/**
 * The tab overview's own state – what the user has done to THIS overview since it opened: the
 * tab search's field and query (TAB-21), the select-tabs mode with the scope it was entered in
 * (TAB-08), the sheet up over the grid, and how far the grid is scrolled (TABLET-08).
 *
 * It was `TabOverview`'s component state, and went with the component: the phone and the tablet
 * shell each mount their own stage, and a window resized from the one layout into the other –
 * a foldable opening or closing, a tablet window narrowed into split screen – swaps shells with
 * the overview still open (`stageStore` keeps it open; `useStageContinuity`). The next shell's
 * `TabOverview` is a new component, and its first render must find the field, the query, the
 * picks and the sheet where the last one left them, so that the fold changes the columns and
 * nothing else. Held here, outside both shells, it does. The stage resets it when the overview
 * goes (`dismissOverview`), as it resets the picked pane: the next overview opens with the field
 * closed, no picks, no sheet, at the top – the rule the component state kept by construction.
 */
export interface OverviewSearchState {
  /** The field is pinned under the header (the phone) – the magnifier's tap put it there. */
  open: boolean
  query: string
}

export const SEARCH_OFF: OverviewSearchState = { open: false, query: '' }

/**
 * The sheet up over the grid: a card's or a group's menu, the header's menu (with the recently
 * closed list as the menu read it), the close-all question, the recently closed list, the
 * inactive tabs list (as the segment row's entry read it), the select-tabs mode's group picker,
 * a Groups pane row's menu and the delete-group question.
 */
export type OverviewSheet =
  | { kind: 'tab'; tabId: string }
  | { kind: 'group'; folderId: string }
  | { kind: 'menu'; closed: ClosedEntrySummary[] }
  | { kind: 'close-all' }
  | { kind: 'recently-closed'; closed: ClosedEntrySummary[] }
  | { kind: 'inactive-tabs'; entries: ArchivedTabSummary[] }
  | { kind: 'group-picker' }
  | { kind: 'group-row'; folderId: string }
  | { kind: 'delete-group'; folderId: string }

/**
 * The select-tabs mode with the grid it was entered on (`pane|spaceId`, null while the overview
 * is not interactive): read as off under any other scope, and reset there by the component.
 */
export interface KeptSelection {
  scope: string | null
  selection: OverviewSelection
}

export const NO_KEPT_SELECTION: KeptSelection = { scope: null, selection: NO_SELECTION }

/** How far a pane's grid was scrolled, for the grid the next shell draws of the same pane. */
export interface OverviewScroll {
  pane: OverviewPane
  top: number
}

export interface OverviewUiState {
  search: OverviewSearchState
  kept: KeptSelection
  sheet: OverviewSheet | null
  scroll: OverviewScroll | null
}

/** A fresh overview: no query, no mode, no sheet, at the top. */
export const OVERVIEW_UI_OFF: OverviewUiState = {
  search: SEARCH_OFF,
  kept: NO_KEPT_SELECTION,
  sheet: null,
  scroll: null
}

export const overviewUiStore = createStore<OverviewUiState>(OVERVIEW_UI_OFF, 'overview-ui')

type Next<T> = T | ((current: T) => T)
function resolve<T>(next: Next<T>, current: T): T {
  return typeof next === 'function' ? (next as (current: T) => T)(current) : next
}

export function setOverviewSearch(next: Next<OverviewSearchState>): void {
  overviewUiStore.set((s) => ({ search: resolve(next, s.search) }))
}

/**
 * The tab search's back handler: the mounted overview's (`TabOverview`'s `backSearch`, which
 * clears a query first and closes an empty field), set for as long as one is mounted. The
 * surface itself is the store's, below: pushed as the search opens and popped as it closes,
 * not by the mounted component, because a shell swap with the search up (TABLET-08) mounts a
 * new overview, and a surface that mount re-pushed would land on top of whatever opened over
 * the search before the swap – the Spaces drawer – so the first back after a fold would clear
 * the query under the drawer instead of closing the drawer. With no overview mounted the
 * surface closes the search itself.
 */
let searchBack: (() => void) | null = null

export function setOverviewSearchBack(handler: (() => void) | null): void {
  searchBack = handler
}

const wired = globalThis as unknown as { __zenOverviewSearchWired?: boolean }
if (!wired.__zenOverviewSearchWired) {
  wired.__zenOverviewSearchWired = true
  let popSearchSurface: (() => void) | null = null
  overviewUiStore.subscribe(() => {
    const open = overviewUiStore.get().search.open
    if (open && !popSearchSurface) {
      popSearchSurface = pushBackSurface({
        name: 'overview-search',
        onCommit: () => {
          if (searchBack) searchBack()
          else setOverviewSearch(SEARCH_OFF)
        }
      })
    } else if (!open && popSearchSurface) {
      popSearchSurface()
      popSearchSurface = null
    }
  })
}

export function setOverviewSelection(next: Next<KeptSelection>): void {
  overviewUiStore.set((s) => ({ kept: resolve(next, s.kept) }))
}

export function setOverviewSheet(next: Next<OverviewSheet | null>): void {
  overviewUiStore.set((s) => ({ sheet: resolve(next, s.sheet) }))
}

/** The grid of `pane` scrolled to `top` (the grid's own scroll event). */
export function noteOverviewScroll(pane: OverviewPane, top: number): void {
  const current = overviewUiStore.get().scroll
  if (current && current.pane === pane && current.top === top) return
  overviewUiStore.set({ scroll: { pane, top } })
}

/**
 * The overview has gone: the next one starts afresh (the stage calls this as it dismisses) –
 * the grid's window with it (`overviewWindow.ts`: the next grid builds the cards in view first).
 */
export function resetOverviewUi(): void {
  overviewUiStore.set(OVERVIEW_UI_OFF)
  resetOverviewWindow()
}
