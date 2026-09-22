import type { Rect } from '@shared/types'
import { createStore } from './store'

/**
 * Where the page's view stands on the chrome's return from a page's fullscreen (MED-01), for
 * the return fade to start on the view's landing rather than over its shrink (v2 §11.5).
 *
 * Leaving fullscreen, the host shows the system bars again and gives the orientation back. A
 * screen that turns back while the bars are on their way in is laid out on the bars as they
 * stand at the turn – the navigation bar's frame in the new orientation comes with a later
 * dispatch – so the chrome's first inline layout can be one the final insets undo a moment
 * later. The host says where the bars stand on each `insets` (`settling`, `FullscreenLanding.kt`)
 * and, after every change of a page view's size, the size it has drawn the page at
 * (`view.sized`). The view has landed once nothing is settling, the chrome's latest placement
 * for the tab was laid out on the settled insets, and the host has drawn that size.
 */
export interface Placement {
  rect: Rect
  /** Laid out on settled insets (none on their way), or marked so once the settle changed nothing. */
  settled: boolean
}

export interface LandingState {
  /** The host's word on the system bars: on their way (true), at rest (false), or a host without the word (undefined). */
  settling: boolean | undefined
  /** The chrome's latest layout report: the placement of every view it asked for. */
  placed: ReadonlyMap<string, Placement>
  /** The size the host last drew each view at, in CSS px. */
  sized: ReadonlyMap<string, { width: number; height: number }>
  /** How many placement reports the chrome has made: a landing tells the reports since it began by this. */
  reports: number
}

export const landingStore = createStore<LandingState>(
  { settling: undefined, placed: new Map(), sized: new Map(), reports: 0 },
  'fullscreen-landing'
)

/**
 * The fade waits this long at most for a landing the host never reports: a view that never
 * changes size, bars that never settle. Past the host's own outside wait for a slow exit
 * (`FullscreenLanding.SAME_SCREEN_DEADLINE_MS` is longer still, for a device state changed under
 * the fullscreen) would leave the chrome away too long; this covers an emulator's exit with room.
 */
export const LANDING_TIMEOUT_MS = 2500

/** A CSS pixel: the host rounds the frame to device pixels and back. */
const SIZE_TOLERANCE_PX = 1

/** The host's insets carried `settling` (a host that reports landings). */
export function landingReported(state: LandingState): boolean {
  return state.settling !== undefined
}

/**
 * `tabId`'s view has landed: nothing settling, its latest placement laid out on settled insets,
 * and the host has drawn it at that size.
 */
export function hasLanded(state: LandingState, tabId: string): boolean {
  if (state.settling !== false) return false
  const placement = state.placed.get(tabId)
  const size = state.sized.get(tabId)
  if (!placement || !size || !placement.settled) return false
  return (
    Math.abs(size.width - placement.rect.width) <= SIZE_TOLERANCE_PX &&
    Math.abs(size.height - placement.rect.height) <= SIZE_TOLERANCE_PX
  )
}

/**
 * The chrome is back from `tabId`'s fullscreen and has not laid the page out inline yet: the
 * placement kept from before the fullscreen is no word on where the view goes now – unless the
 * chrome lay under the page's layer as it was, its report unchanged, and the host held the view
 * there (`keepPlacement`; Android, MOT-32): then it is the word, and a layout the exit does not
 * change lands on it without a report. The host's word on the size it has drawn stands either
 * way (the view is at it, whatever the chrome asks next). Returns the count of placement
 * reports so far, for `landingLost` to tell the reports since the landing began from none yet.
 */
export function beginLanding(tabId: string, keepPlacement = false): number {
  if (!keepPlacement) {
    landingStore.set((prev) => {
      if (!prev.placed.has(tabId)) return {}
      const placed = new Map(prev.placed)
      placed.delete(tabId)
      return { placed }
    })
  }
  return landingStore.get().reports
}

/**
 * `tabId`'s landing is not coming: the chrome has reported its placements since the landing
 * began (`since`, `beginLanding`'s count) and the report did not name the tab. The report names
 * every view the chrome wants on screen, so a tab left out of it has no placement to land on –
 * it is gone (a page that closed itself while fullscreen, a tab the host or the core closed at
 * the exit) or another tab has the screen – and the return that waited for it would sit at
 * nothing until `LANDING_TIMEOUT_MS`; it fades at once instead.
 */
export function landingLost(state: LandingState, tabId: string, since: number): boolean {
  return state.reports > since && !state.placed.has(tabId)
}

/**
 * The host's insets came: `settling` is its word on the bars (undefined from a host without
 * one). The bars settling changes the chrome's layout, or not: `layoutMark` names the layout as
 * it stands (the content area's rect, set as it is measured), and once the chrome has had its
 * frames to follow the settled insets, a layout that has not moved was laid out on them
 * (`markPlacementsSettled`); one that has reports its placements anew, settled.
 */
export function noteInsetsSettling(
  settling: boolean | undefined,
  layoutMark: () => unknown = () => null
): void {
  const was = landingStore.get().settling
  landingStore.set({ settling })
  if (settling !== false || was === false) return
  const mark = layoutMark()
  afterFrames(2, () => {
    if (layoutMark() === mark) markPlacementsSettled()
  })
}

/** `then` at the start of the `count`-th frame from now (the frame after the next paint, for two). */
function afterFrames(count: number, then: () => void): void {
  if (typeof requestAnimationFrame !== 'function') {
    then()
    return
  }
  requestAnimationFrame(() => {
    if (count <= 1) then()
    else afterFrames(count - 1, then)
  })
}

/**
 * The chrome reported these placements, laid out while the bars were `settling` or not. The
 * report names every view the chrome wants on screen, so it replaces what was kept; a size
 * drawn for a view no longer placed goes with it. Each report counts (`reports`), a report of
 * no placements too: a landing that finds its tab left out since it began is lost.
 */
export function notePlacements(
  placements: ReadonlyArray<{ tabId: string; rect: Rect }>,
  settling: boolean | undefined
): void {
  landingStore.set((prev) => {
    const placed = new Map<string, Placement>()
    for (const p of placements) placed.set(p.tabId, { rect: p.rect, settled: settling !== true })
    const sized = new Map<string, { width: number; height: number }>()
    for (const [tabId, size] of prev.sized) if (placed.has(tabId)) sized.set(tabId, size)
    return { placed, sized, reports: prev.reports + 1 }
  })
}

/**
 * The bars settled and the layout did not move for it: what stands was laid out on the insets
 * the settle confirmed.
 */
export function markPlacementsSettled(): void {
  landingStore.set((prev) => {
    if (prev.settling !== false) return {}
    let changed = false
    const placed = new Map(prev.placed)
    for (const [tabId, p] of placed) {
      if (p.settled) continue
      placed.set(tabId, { ...p, settled: true })
      changed = true
    }
    return changed ? { placed } : {}
  })
}

/** The host drew `tabId`'s view at a new size (CSS px). */
export function noteViewSized(tabId: string, width: number, height: number): void {
  landingStore.set((prev) => {
    const sized = new Map(prev.sized)
    sized.set(tabId, { width, height })
    return { sized }
  })
}
