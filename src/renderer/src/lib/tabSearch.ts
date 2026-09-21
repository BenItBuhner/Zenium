import {
  mediaTabs,
  rankClosed,
  rankTabs,
  type RankedClosed,
  type RankedTab
} from '@shared/tabSearch'
import { internalPageOf } from '@shared/internalPages'
import type { ClosedEntrySummary, SplitGroup, TabSearchCandidate } from '@shared/types'
import { run } from './api'
import { openedFromKeyboard } from './popover'
import { closeUrlbar, type TabPickRequest, uiStore } from './ui'

/*
 * The tab search popover's request (tabs-17): Ctrl+Shift+A, the menu bar's Window › Search
 * Tabs… and the app menu's Search Tabs… all land here through the core's `tabsearch.open`. The
 * popover itself (components/tabsearch/TabSearchPopover.tsx) holds the page's capture and the
 * keyboard while it is up, so the request is all the store keeps.
 */

/**
 * Open the popover, or close it when it is up already – Chrome's Ctrl+Shift+A toggles its tab
 * search. `keyboard` is whether a chrome control had the focus (the popover leaves the keyboard
 * in the chrome on close then, §9.22); from the page the core focused the chrome first, so
 * nothing has it.
 */
export function toggleTabSearch(): void {
  if (uiStore.get().tabSearch) {
    closeTabSearch()
    return
  }
  const keyboard = openedFromKeyboard()
  // The URL bar gives way as it does to every other chrome surface (Chrome's Ctrl+Shift+A works
  // from the omnibox): over a new tab page it stays up on its own, and the popover opened under
  // it would be put away again at once.
  closeUrlbar()
  run('focus.chrome', undefined)
  uiStore.set({ tabSearch: { keyboard }, drawerOpen: false })
}

/**
 * "Choose a tab" in an empty split pane (split-04): the popover in its pick mode, hanging from
 * the pane's button (`data-pick-tab`), placed inside the pane. The pane's URL bar gives way as it
 * does to Ctrl+Shift+A, the keyboard staying in the chrome for the popover's field; the popover
 * closes with the pane (`TabSearchLayer`) and Escape hands the keyboard back to the button.
 */
export function openTabPicker(pick: TabPickRequest): void {
  closeUrlbar({ keepKeyboard: true })
  run('focus.chrome', undefined)
  uiStore.set({ tabSearch: { keyboard: true, pick }, drawerOpen: false })
}

export function closeTabSearch(): void {
  if (!uiStore.get().tabSearch) return
  uiStore.set({ tabSearch: null })
}

/**
 * What the picker offers for the pane (split-04): the window's other open tabs – not the tabs
 * of other windows (a tab is shown in one window), not the tabs already in the split, not the
 * empty pane itself, and no chrome page (Settings fills the frame itself; `splittable: false`).
 */
export function pickCandidates(
  candidates: TabSearchCandidate[],
  pick: TabPickRequest,
  group: SplitGroup | undefined
): TabSearchCandidate[] {
  return candidates.filter(
    (c) =>
      c.windowLabel === null &&
      c.id !== pick.paneTabId &&
      !group?.tabIds.includes(c.id) &&
      internalPageOf(c.url)?.splittable !== false
  )
}

const flags = globalThis as unknown as { __zenTabSearchWired?: boolean }
if (!flags.__zenTabSearchWired) {
  flags.__zenTabSearchWired = true
  // Another chrome surface (URL bar, panel, drawer, site information, the stage) replaces it.
  uiStore.subscribe(() => {
    const ui = uiStore.get()
    if (
      ui.tabSearch &&
      (ui.urlbar.open ||
        ui.overlay !== 'none' ||
        ui.drawerOpen ||
        ui.siteInfoOpen ||
        ui.menu !== null ||
        ui.stageActive)
    )
      closeTabSearch()
  })
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export type Row =
  | { kind: 'heading'; id: string; label: string }
  | { kind: 'tab'; id: string; ranked: RankedTab; index: number }
  | { kind: 'closed'; id: string; ranked: RankedClosed; index: number }
  | { kind: 'empty'; id: string }

/** A row the keyboard can land on and Enter can act on. */
export type Option = Extract<Row, { kind: 'tab' | 'closed' }>

export const isOption = (row: Row): row is Option => row.kind === 'tab' || row.kind === 'closed'

/**
 * The popover's list, in sections: with nothing typed, the tabs playing sound ("Audio and
 * video"), every open tab most recently used first with the current one last, and the newest
 * recently closed entries; with a query, the open tabs and the closed entries it matches, best
 * first. Every selectable row carries its index among the options for the keyboard; a list
 * with none says so in one static row. The pane picker (`pick`) lists the open tabs alone – a
 * closed entry cannot fill a pane and the sound section would only repeat rows – under no
 * heading, the title block naming what the rows are.
 */
export function buildRows(
  candidates: TabSearchCandidate[],
  recentlyClosed: ClosedEntrySummary[],
  query: string,
  pick = false
): Row[] {
  const rows: Row[] = []
  const open = rankTabs(candidates, query)
  const closed = pick ? [] : rankClosed(recentlyClosed, query)
  let index = 0
  const tabRows = (list: RankedTab[], section: string): void => {
    for (const ranked of list) {
      rows.push({ kind: 'tab', id: `${section}:${ranked.tab.id}`, ranked, index: index++ })
    }
  }
  if (pick) {
    tabRows(open, 'open')
    if (index === 0) rows.push({ kind: 'empty', id: 'empty' })
    return rows
  }
  if (!query.trim()) {
    const media = mediaTabs(open)
    if (media.length > 0) {
      rows.push({ kind: 'heading', id: 'heading:media', label: 'Audio and video' })
      tabRows(media, 'media')
    }
  }
  if (open.length > 0) {
    rows.push({ kind: 'heading', id: 'heading:open', label: 'Open tabs' })
    tabRows(open, 'open')
  }
  if (closed.length > 0) {
    rows.push({ kind: 'heading', id: 'heading:closed', label: 'Recently closed' })
    for (const ranked of closed) {
      rows.push({ kind: 'closed', id: `closed:${ranked.entry.id}`, ranked, index: index++ })
    }
  }
  if (index === 0) rows.push({ kind: 'empty', id: 'empty' })
  return rows
}
