import type { Platform } from '@shared/types'
import { chromeUnderPages, COVER_WAIT_MS } from './cover'
import { createStore } from './store'

/**
 * Where each tab's page view stands between the chrome asking for it and the host's frame.
 *
 * On Android the chrome lies under the page views, so a sheet that recedes the page is really
 * receding the page's cover (`lib/cover.ts`), and the swap between the live view and the cover
 * must fall on a frame where the two are pixel-identical: before any recede has begun on the way
 * in, and after the recede has fully reversed on the way out. The chrome learns where the swap
 * stands from two events: the core's `layout.applied` (which views a layout report took down or
 * brought back – a tab without a view, or one already placed, is in neither list) and the host's
 * `view.drawn` (the frame carrying that change has been drawn). `pageCovered` waits for the
 * first, `pageOffScreen` holds the cover until the second.
 */
export type PageViewPhase = 'shown' | 'hiding' | 'hidden' | 'showing'

export interface AppliedLayout {
  contentHidden: boolean
  hid: string[]
  shown: string[]
}

export interface PageViewState {
  /** Per tab: its page view's phase. A tab that is absent is shown (never asked to move). */
  phases: ReadonlyMap<string, PageViewPhase>
  /** The last layout the core applied, or null before the first. */
  lastApplied: AppliedLayout | null
}

export const pageViewStore = createStore<PageViewState>(
  { phases: new Map(), lastApplied: null },
  'page-view'
)

/**
 * A host that took a view down or brought it back and never said so (a frame that never came,
 * an old host): the chrome moves on as if it had, from this long after the ask. Longer than the
 * host's own deadline for a deferred hide (`PageVisibility.DEADLINE_MS`) plus the frames after it.
 */
export const ACK_TIMEOUT_MS = 1000

/**
 * The most a sheet holds for the page to be covered before it comes up over the live page
 * regardless: a cover that never paints (`COVER_WAIT_MS`), then a host that never answers.
 */
export const COVERED_TIMEOUT_MS = COVER_WAIT_MS + ACK_TIMEOUT_MS + 200

export function pageViewPhase(
  state: PageViewState,
  tabId: string | null | undefined
): PageViewPhase {
  return (tabId && state.phases.get(tabId)) || 'shown'
}

/** The core placed the views as a report asked: the ones it flipped are on their way. */
export function applyLayout(state: PageViewState, applied: AppliedLayout): PageViewState {
  const phases = new Map(state.phases)
  for (const tabId of applied.hid) phases.set(tabId, 'hiding')
  for (const tabId of applied.shown) phases.set(tabId, 'showing')
  return { phases, lastApplied: applied }
}

/** The host drew the frame with `tabId`'s view `visible` or gone. */
export function applyDrawn(state: PageViewState, tabId: string, visible: boolean): PageViewState {
  const phases = new Map(state.phases)
  if (visible) phases.delete(tabId)
  else phases.set(tabId, 'hidden')
  return { ...state, phases }
}

/** A flip the host never confirmed: settle it where it was heading. */
export function settlePhase(state: PageViewState, tabId: string): PageViewState {
  const phase = state.phases.get(tabId)
  if (phase !== 'hiding' && phase !== 'showing') return state
  return applyDrawn(state, tabId, phase === 'showing')
}

/**
 * Whether `tabId`'s live page is off the screen now, so that a sheet may start receding what
 * stands in for it: the host drew the frame without the view, or the last layout the core applied
 * hid the pages and had no view of this tab to take down (a page without a view, or one that was
 * hidden already).
 */
export function coveredNow(state: PageViewState, tabId: string): boolean {
  const phase = pageViewPhase(state, tabId)
  if (phase === 'hidden') return true
  if (phase === 'hiding') return false
  return state.lastApplied?.contentHidden === true && !state.lastApplied.hid.includes(tabId)
}

/**
 * Whether the cover must still stand where `tabId`'s page is: the view is on its way down,
 * down, or on its way back but not yet drawn. Only once the host has drawn the page again may
 * the cover go (the close direction's half of the guarantee; the frame between would show the
 * window's gradient).
 */
export function pageOffScreen(state: PageViewState, tabId: string | null | undefined): boolean {
  return pageViewPhase(state, tabId) !== 'shown'
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()

function armSettle(tabId: string): void {
  const previous = timers.get(tabId)
  if (previous !== undefined) clearTimeout(previous)
  timers.set(
    tabId,
    setTimeout(() => {
      timers.delete(tabId)
      pageViewStore.set((s) => settlePhase(s, tabId))
    }, ACK_TIMEOUT_MS)
  )
}

function disarm(tabId: string): void {
  const timer = timers.get(tabId)
  if (timer === undefined) return
  clearTimeout(timer)
  timers.delete(tabId)
}

/** `layout.applied` from the core. */
export function onLayoutApplied(applied: AppliedLayout): void {
  pageViewStore.set((s) => applyLayout(s, applied))
  for (const tabId of applied.hid) armSettle(tabId)
  for (const tabId of applied.shown) armSettle(tabId)
}

/** `view.drawn` from the host. */
export function onViewDrawn(tabId: string, visible: boolean): void {
  disarm(tabId)
  pageViewStore.set((s) => applyDrawn(s, tabId, visible))
}

export interface Hold {
  /** Resolves once the page is covered (or the wait ran out); never rejects. */
  promise: Promise<void>
  /** Give up waiting: the promise never resolves. */
  cancel(): void
}

/**
 * Wait for `tabId`'s live page to be off the screen, so the cover standing in for it can begin
 * to recede without a visible swap. Resolves at once where the chrome does not lie under the
 * pages (the desktop hosts have the overlay painted before a view goes), with no page, or with
 * the view already down; otherwise when `coveredNow` turns true, and in any case after
 * `COVERED_TIMEOUT_MS`.
 */
export function pageCovered(tabId: string | null, platform: Platform): Hold {
  if (!chromeUnderPages(platform) || !tabId || coveredNow(pageViewStore.get(), tabId)) {
    return { promise: Promise.resolve(), cancel: () => undefined }
  }
  let unsubscribe: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let done = false
  const finish = (): void => {
    done = true
    unsubscribe?.()
    unsubscribe = null
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const promise = new Promise<void>((resolve) => {
    unsubscribe = pageViewStore.subscribe(() => {
      if (done || !coveredNow(pageViewStore.get(), tabId)) return
      finish()
      resolve()
    })
    timer = setTimeout(() => {
      if (done) return
      finish()
      resolve()
    }, COVERED_TIMEOUT_MS)
  })
  return { promise, cancel: finish }
}
