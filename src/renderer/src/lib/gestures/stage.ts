import type { UIState } from '@shared/types'
import { run } from '../api'
import { SPRING_GENTLE, SPRING_SNAPPY, SpringAnimation } from '../motion/spring'
import { activeSpace, activeTab, tabOrderOf } from '../selectors'
import { createStore } from '../store'
import { captureThumbnail, pruneThumbnails } from '../thumbnails'
import {
  browserStore,
  contentAreaStore,
  invalidateSnapshot,
  registerBackHandler,
  returnFocusToPage,
  uiStore
} from '../ui'
import { dragPosition, settleTarget } from './swipe'

/**
 * The phone "stage": chrome that stands in for the live page while a gesture anchored on the
 * address pill is in flight. Two gestures share it –
 *
 *  - a horizontal swipe moves along the track of the space's tabs; the cards are the tabs'
 *    thumbnails, the position is continuous, and settling is a spring that a finger can catch;
 *  - a vertical swipe towards the middle of the screen pulls the tab overview in, driven by
 *    finger position on a 0…1 track with the same catch / cancel / fling rules.
 *
 * Host page views sit above the chrome, so the stage is only visible once the layout reporter
 * has hidden them (`uiStore.stageActive`); until then it renders unseen underneath.
 */
export type TabSwitchPhase = 'idle' | 'dragging' | 'settling' | 'committing'

export interface TabSwitchState {
  phase: TabSwitchPhase
  /** Tab ids along the track, in sidebar order, fixed for the duration of the gesture. */
  order: string[]
  /** Continuous position on the track (index of the tab under the finger). */
  position: number
  /** Index of the tab the browser shows – or is switching to. */
  origin: number
  /** Distance between neighbouring cards in px (card width + gap). */
  advance: number
}

export type OverviewPhase = 'closed' | 'dragging' | 'settling' | 'open'

export interface OverviewState {
  phase: OverviewPhase
  /** 0 = closed … 1 = open; rubber-banded beyond both ends while dragging. */
  progress: number
  /** Tab whose card the page morphs out of (opening) or into (closing). */
  heroTabId: string | null
}

export interface StageState {
  tabs: TabSwitchState
  overview: OverviewState
}

/** Gap between neighbouring cards on the tab track. */
export const CARD_GAP = 16

const TABS_IDLE: TabSwitchState = { phase: 'idle', order: [], position: 0, origin: 0, advance: 1 }
const OVERVIEW_CLOSED: OverviewState = { phase: 'closed', progress: 0, heroTabId: null }

export const stageStore = createStore<StageState>(
  { tabs: TABS_IDLE, overview: OVERVIEW_CLOSED },
  'stage'
)

/** Finger travel (px) that opens the overview completely. */
export function overviewTravel(): number {
  const height = contentAreaStore.get().area?.height ?? window.innerHeight
  return Math.max(220, Math.round(height * 0.42))
}

function currentState(): UIState | null {
  return browserStore.get().state
}

function currentActiveTabId(): string | null {
  const state = currentState()
  return state ? (activeTab(state)?.id ?? null) : null
}

// ---------------------------------------------------------------------------
// Visibility of the stage (hides the live page views)
// ---------------------------------------------------------------------------

let tabsShown = false
let overviewShown = false

function syncStageActive(): void {
  const active = tabsShown || overviewShown
  if (uiStore.get().stageActive !== active) uiStore.set({ stageActive: active })
}

/**
 * Runs `then` once the browser reports `tabId` as the active tab (or gives up after a while).
 * Returns a function that stops waiting without running `then`.
 */
function whenActive(tabId: string, then: () => void): () => void {
  let done = false
  let unsubscribe: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = (): void => {
    done = true
    unsubscribe?.()
    if (timer) clearTimeout(timer)
  }
  const fire = (): void => {
    if (done) return
    cancel()
    then()
  }
  if (currentActiveTabId() === tabId) {
    fire()
    return cancel
  }
  unsubscribe = browserStore.subscribe(() => {
    if (currentActiveTabId() === tabId) fire()
  })
  timer = setTimeout(fire, 800)
  return cancel
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

let tabDragStart = 0
let pendingCapture: Promise<unknown> | null = null
let cancelCommit: (() => void) | null = null

const tabSpring = new SpringAnimation(
  SPRING_SNAPPY,
  (x) => {
    const tabs = stageStore.get().tabs
    if (tabs.phase !== 'settling') return
    stageStore.set({ tabs: { ...tabs, position: x / tabs.advance } })
  },
  (x) => {
    const tabs = stageStore.get().tabs
    if (tabs.phase !== 'settling') return
    settleTabSwitchAt(Math.round(x / tabs.advance))
  }
)

/**
 * A finger touched the pill: capture the page now, while it is still on screen, so the card
 * is ready the moment the touch turns into a swipe. Harmless when it turns out to be a tap.
 */
export function prepareStage(state: UIState): void {
  const tab = activeTab(state)
  if (!tab) return
  pruneThumbnails((id) => Boolean(state.tabs[id]))
  pendingCapture = captureThumbnail(tab.id)
}

/** Start dragging the tab track. Returns false when there is no tab to move away from. */
export function beginTabSwitch(state: UIState): boolean {
  const tab = activeTab(state)
  if (!tab) return false
  const order = tabOrderOf(state, activeSpace(state)).map((t) => t.id)
  let origin = order.indexOf(tab.id)
  if (origin < 0) {
    order.unshift(tab.id)
    origin = 0
  }
  const width = contentAreaStore.get().area?.width ?? window.innerWidth
  tabDragStart = origin
  stageStore.set({
    tabs: { phase: 'dragging', order, position: origin, origin, advance: width + CARD_GAP }
  })
  const show = (): void => {
    if (stageStore.get().tabs.phase === 'idle') return
    tabsShown = true
    syncStageActive()
  }
  if (pendingCapture) void pendingCapture.then(show, show)
  else show()
  pendingCapture = null
  return true
}

/**
 * A finger came down while the track was still moving (or the switch was being confirmed):
 * freeze it where it is and let the finger take over. Returns false when nothing was in flight.
 */
export function catchTabSwitch(): boolean {
  const tabs = stageStore.get().tabs
  if (tabs.phase === 'settling') {
    const { x } = tabSpring.stop()
    const position = x / tabs.advance
    tabDragStart = position
    stageStore.set({ tabs: { ...tabs, phase: 'dragging', position } })
    return true
  }
  if (tabs.phase === 'committing') {
    cancelCommit?.()
    cancelCommit = null
    tabDragStart = tabs.position
    stageStore.set({ tabs: { ...tabs, phase: 'dragging' } })
    return true
  }
  return false
}

/** The finger moved `delta` px along the track since the drag began (positive = next tab). */
export function dragTabSwitch(delta: number): void {
  const tabs = stageStore.get().tabs
  if (tabs.phase !== 'dragging') return
  const position = dragPosition(tabDragStart, delta, tabs.advance, 0, tabs.order.length - 1)
  if (position !== tabs.position) stageStore.set({ tabs: { ...tabs, position } })
}

/** The finger lifted, moving at `velocity` px/s along the track. */
export function releaseTabSwitch(velocity: number): void {
  const tabs = stageStore.get().tabs
  if (tabs.phase !== 'dragging') return
  const target = settleTarget({
    position: tabs.position,
    velocity,
    extent: tabs.advance,
    min: 0,
    max: tabs.order.length - 1
  })
  stageStore.set({ tabs: { ...tabs, phase: 'settling' } })
  tabSpring.start(tabs.position * tabs.advance, velocity, target * tabs.advance)
}

function settleTabSwitchAt(index: number): void {
  const tabs = stageStore.get().tabs
  const tabId = tabs.order[index]
  if (!tabId || tabId === currentActiveTabId()) {
    endTabSwitch()
    return
  }
  stageStore.set({ tabs: { ...tabs, phase: 'committing', position: index, origin: index } })
  run('tab.activate', { tabId })
  cancelCommit = whenActive(tabId, () => {
    cancelCommit = null
    if (stageStore.get().tabs.phase === 'committing') endTabSwitch()
  })
}

function endTabSwitch(): void {
  tabSpring.stop()
  cancelCommit?.()
  cancelCommit = null
  pendingCapture = null
  stageStore.set({ tabs: TABS_IDLE })
  tabsShown = false
  syncStageActive()
  invalidateSnapshot()
  returnFocusToPage()
}

// ---------------------------------------------------------------------------
// Tab overview
// ---------------------------------------------------------------------------

let overviewDragStart = 0
let cancelOverviewCommit: (() => void) | null = null

const overviewSpring = new SpringAnimation(
  SPRING_GENTLE,
  (x) => {
    const overview = stageStore.get().overview
    if (overview.phase !== 'settling') return
    stageStore.set({ overview: { ...overview, progress: x / overviewTravel() } })
  },
  (x) => {
    const overview = stageStore.get().overview
    if (overview.phase !== 'settling') return
    if (Math.round(x / overviewTravel()) >= 1) {
      stageStore.set({ overview: { ...overview, phase: 'open', progress: 1 } })
    } else {
      finishOverviewClose()
    }
  }
)

export function overviewIsOpen(): boolean {
  return stageStore.get().overview.phase !== 'closed'
}

function showOverview(state: UIState): void {
  const hero = activeTab(state)
  const overview = stageStore.get().overview
  if (overview.phase !== 'closed') return
  stageStore.set({
    overview: { phase: 'dragging', progress: 0, heroTabId: hero?.id ?? null }
  })
  run('focus.chrome', undefined)
  const show = (): void => {
    if (stageStore.get().overview.phase === 'closed') return
    overviewShown = true
    syncStageActive()
  }
  if (pendingCapture) void pendingCapture.then(show, show)
  else if (hero) void captureThumbnail(hero.id).then(show, show)
  else show()
  pendingCapture = null
}

/** Start dragging the overview in (from closed) or out (from open). */
export function beginOverviewDrag(state: UIState): boolean {
  if (stageStore.get().overview.phase === 'closed') showOverview(state)
  const overview = stageStore.get().overview
  if (overview.phase === 'settling') overviewSpring.stop()
  overviewDragStart = overview.progress
  if (overview.phase !== 'dragging')
    stageStore.set({ overview: { ...overview, phase: 'dragging' } })
  return true
}

/** A finger came down while the overview was animating: hold it there. */
export function catchOverview(): boolean {
  const overview = stageStore.get().overview
  if (overview.phase !== 'settling') return false
  const { x } = overviewSpring.stop()
  cancelOverviewCommit?.()
  cancelOverviewCommit = null
  const progress = x / overviewTravel()
  overviewDragStart = progress
  stageStore.set({ overview: { ...overview, phase: 'dragging', progress } })
  return true
}

/** The finger moved `delta` px towards the middle of the screen since the drag began. */
export function dragOverview(delta: number): void {
  const overview = stageStore.get().overview
  if (overview.phase !== 'dragging') return
  const progress = dragPosition(overviewDragStart, delta, overviewTravel(), 0, 1)
  if (progress !== overview.progress) stageStore.set({ overview: { ...overview, progress } })
}

/** The finger lifted, moving at `velocity` px/s towards the middle of the screen. */
export function releaseOverview(velocity: number): void {
  const overview = stageStore.get().overview
  if (overview.phase !== 'dragging') return
  const target = settleTarget({
    position: overview.progress,
    velocity,
    extent: overviewTravel(),
    min: 0,
    max: 1
  })
  settleOverview(target >= 1 ? 1 : 0, velocity)
}

function settleOverview(target: 0 | 1, velocity = 0): void {
  const overview = stageStore.get().overview
  const travel = overviewTravel()
  stageStore.set({ overview: { ...overview, phase: 'settling' } })
  overviewSpring.start(overview.progress * travel, velocity, target * travel)
}

/** Open the overview with the spring (the tabs button). */
export function openOverview(state: UIState): void {
  if (stageStore.get().overview.phase === 'closed') showOverview(state)
  else if (stageStore.get().overview.phase === 'settling') overviewSpring.stop()
  settleOverview(1)
}

/**
 * Close the overview. With `tabId` the page morphs into that tab's card and the tab is
 * activated, so the live page that appears at the end is the one the user picked.
 */
export function closeOverview(tabId?: string): void {
  const overview = stageStore.get().overview
  if (overview.phase === 'closed') return
  if (overview.phase === 'settling') overviewSpring.stop()
  cancelOverviewCommit?.()
  cancelOverviewCommit = null
  const hero = tabId ?? currentActiveTabId()
  stageStore.set({ overview: { ...overview, heroTabId: hero } })
  if (tabId && tabId !== currentActiveTabId()) run('tab.activate', { tabId })
  settleOverview(0)
}

export function toggleOverview(state: UIState): void {
  const { phase } = stageStore.get().overview
  if (phase === 'open' || phase === 'dragging') closeOverview()
  else openOverview(state)
}

function finishOverviewClose(): void {
  const hero = stageStore.get().overview.heroTabId
  const done = (): void => {
    cancelOverviewCommit = null
    dismissOverview()
  }
  // Wait for the picked tab to be the one the layout will show, otherwise the old page flashes.
  cancelOverviewCommit = hero ? whenActive(hero, done) : null
  if (!hero) done()
}

/** Drop the overview without animation (another overlay took over, the layout changed). */
export function dismissOverview(): void {
  overviewSpring.stop()
  cancelOverviewCommit?.()
  cancelOverviewCommit = null
  if (stageStore.get().overview.phase !== 'closed') stageStore.set({ overview: OVERVIEW_CLOSED })
  overviewShown = false
  syncStageActive()
  invalidateSnapshot()
  returnFocusToPage()
}

/** Everything off the stage at once (the phone layout went away). */
export function dismissStage(): void {
  if (stageStore.get().tabs.phase !== 'idle') endTabSwitch()
  dismissOverview()
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const flags = globalThis as unknown as { __zenStageWired?: boolean }
if (!flags.__zenStageWired) {
  flags.__zenStageWired = true
  // Hardware / gesture back closes the overview before anything else.
  registerBackHandler(() => {
    const { phase } = stageStore.get().overview
    if (phase === 'closed') return false
    closeOverview()
    return true
  })
  // Any other chrome surface (URL bar, panels, drawer, menu) replaces the overview outright.
  uiStore.subscribe(() => {
    const ui = uiStore.get()
    if (
      (ui.urlbar.open || ui.overlay !== 'none' || ui.drawerOpen || ui.menu) &&
      stageStore.get().overview.phase !== 'closed'
    )
      dismissOverview()
  })
}
