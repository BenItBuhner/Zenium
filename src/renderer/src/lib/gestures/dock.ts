import type { PhoneBarPosition, Rect, UIState } from '@shared/types'
import { run } from '../api'
import {
  SPRING_GENTLE,
  isAtRest,
  reducedMotion,
  stepSpring,
  type SpringConfig,
  type SpringState
} from '../motion/spring'
import { activeTab } from '../selectors'
import { createStore } from '../store'
import { captureThumbnail } from '../thumbnails'
import { browserStore, invalidateSnapshot, returnFocusToPage, uiStore } from '../ui'
import { setStageLayerShown, takePendingCapture } from './stage'
import { rubberBand, settleTarget, type SwipeThresholds } from './swipe'

/**
 * Carrying the phone's address bar to the other edge of the screen. A stationary long-press on
 * the pill picks it up (`beginDock`); it then follows the finger on a one-dimensional track from
 * its own slot (0) to the slot at the opposite edge (1) while the page – drawn as a card – slides
 * out of the way. Letting go settles it on whichever slot position and velocity point at; the
 * bar's edge is only committed to Settings once the pill has landed. Every motion is a spring a
 * finger can catch, so a move can be reversed at any point.
 */
export type DockPhase = 'idle' | 'lifted' | 'settling' | 'landing'

export interface DockState {
  phase: DockPhase
  /** Edge the bar was docked at when the pill was picked up. */
  from: PhoneBarPosition
  /** Edge the pill is heading for once released (`from` again when the move was cancelled). */
  target: PhoneBarPosition | null
  /** 0 = in its own slot … 1 = in the slot at the other edge; rubber-banded beyond both. */
  progress: number
  /** Sideways drift of the carried pill (px). */
  drift: number
  /** 0 = flat in the bar … 1 = fully lifted (scale and shadow). */
  lift: number
  /** The slot the pill left, in window coordinates. */
  slot: Rect
  /** Distance (px) between the pill's centres at the two edges. */
  travel: number
  /** Tab whose page slides along as a card. */
  heroTabId: string | null
}

const IDLE: DockState = {
  phase: 'idle',
  from: 'bottom',
  target: null,
  progress: 0,
  drift: 0,
  lift: 0,
  slot: { x: 0, y: 0, width: 0, height: 0 },
  travel: 1,
  heroTabId: null
}

export const dockStore = createStore<DockState>(IDLE, 'dock')

/** Height of the bar's row of controls (CSS px), read from the stylesheet. */
export function phoneBarHeight(): number {
  return cssPx('--zen-phone-bar', 56)
}

/**
 * Height of the whole bar band (CSS px): the row and, while the active tab is in a group, the
 * group strip's share (`--zen-group-strip`, written by the shell; `--zen-phone-band` in main.css
 * is the same sum for the stylesheet). What the content column leaves free at the bar's edge,
 * so what a carry slides the page by. Summed here rather than read as the band: an unregistered
 * property's computed value keeps its `calc()`, which would not parse.
 */
export function phoneBandHeight(): number {
  return phoneBarHeight() + cssPx('--zen-group-strip', 0)
}

/** A length custom property of the document root in px (`fallback` outside a document). */
export function cssPx(name: string, fallback: number): number {
  if (typeof document === 'undefined') return fallback
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name))
  return Number.isFinite(value) ? value : fallback
}

/** The pill tracks the finger through a stiff spring: a hair of lag and weight, no rubbery drag. */
export const SPRING_FOLLOW: SpringConfig = {
  stiffness: 1200,
  damping: 68,
  mass: 1,
  restDelta: 0.2,
  restSpeed: 4
}

/** Flying into a slot after release: the overview's gentle spring, a whisper of overshoot. */
export const SPRING_DOCK: SpringConfig = SPRING_GENTLE

/** Pick-up and set-down (0…100). */
const SPRING_LIFT: SpringConfig = {
  stiffness: 520,
  damping: 34,
  mass: 1,
  restDelta: 0.5,
  restSpeed: 10
}

/** A fling commits regardless of distance; a slow release docks on the nearer half. */
export const DOCK_THRESHOLDS: SwipeThresholds = {
  flingVelocity: 550,
  commitFraction: 0.5,
  projectionSeconds: 0.12
}

/** How far past either slot the pill may be pulled before the rubber band takes over. */
const OVERSHOOT = 56

export function otherEdge(edge: PhoneBarPosition): PhoneBarPosition {
  return edge === 'bottom' ? 'top' : 'bottom'
}

/** Direction (sign of a vertical delta) that carries the pill from `from` towards the other edge. */
export function towardsOther(from: PhoneBarPosition): 1 | -1 {
  return from === 'bottom' ? -1 : 1
}

/** Finger travel along the track (px), rubber-banded beyond both slots. */
export function bandAlong(along: number, travel: number): number {
  if (along < 0) return rubberBand(along, OVERSHOOT)
  if (along > travel) return travel + rubberBand(along - travel, OVERSHOOT)
  return along
}

/** Which slot a released pill settles in: 0 = back where it came from, 1 = the other edge. */
export function relocationTarget(progress: number, velocity: number, travel: number): 0 | 1 {
  return settleTarget(
    { position: progress, origin: 0, velocity, extent: travel, min: 0, max: 1 },
    DOCK_THRESHOLDS
  ) >= 1
    ? 1
    : 0
}

/**
 * Where the content frame sits while the bar is `progress` of the way to the other edge: it
 * keeps its size and slides by the bar band minus the gutter it gets instead.
 */
export function contentShift(
  from: PhoneBarPosition,
  progress: number,
  bar: number,
  gutter: number
): number {
  const p = Math.min(1, Math.max(0, progress))
  return (bar - gutter) * p * (from === 'bottom' ? 1 : -1)
}

/** Centre of the pill (window y) when the bar is docked at `edge`. */
export function pillCentreAt(
  edge: PhoneBarPosition,
  insets: { top: number; bottom: number },
  height: number,
  bar: number
): number {
  return edge === 'top' ? insets.top + bar / 2 : height - insets.bottom - bar / 2
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

const sim = {
  along: { x: 0, v: 0 } as SpringState,
  alongTarget: 0,
  drift: { x: 0, v: 0 } as SpringState,
  driftTarget: 0,
  lift: { x: 0, v: 0 } as SpringState,
  liftTarget: 0
}
let frame: number | null = null
let last = 0
/** Side of the midpoint the pill was last on, for the notch as it crosses over. */
let side: 0 | 1 = 0
/** The bar's new edge has reached the browser state (or the wait timed out). */
let committed = false
let cancelCommit: (() => void) | null = null

function ensureLoop(): void {
  if (frame !== null) return
  last = performance.now()
  frame = requestAnimationFrame(tick)
}

function stopLoop(): void {
  if (frame !== null) cancelAnimationFrame(frame)
  frame = null
}

function publish(): void {
  const s = dockStore.get()
  const progress = sim.along.x / s.travel
  dockStore.set({ progress, drift: sim.drift.x, lift: sim.lift.x / 100 })
  if (s.phase === 'lifted') {
    const now: 0 | 1 = progress >= 0.5 ? 1 : 0
    if (now !== side) {
      side = now
      run('haptic', { kind: 'tick' })
    }
  }
}

function tick(now: number): void {
  frame = null
  const dt = Math.min(0.064, Math.max(0.001, (now - last) / 1000))
  last = now
  const { phase } = dockStore.get()
  if (reducedMotion()) {
    sim.along = { x: sim.alongTarget, v: 0 }
    sim.drift = { x: sim.driftTarget, v: 0 }
    sim.lift = { x: sim.liftTarget, v: 0 }
  } else {
    const alongSpring = phase === 'settling' ? SPRING_DOCK : SPRING_FOLLOW
    sim.along = stepSpring(sim.along, sim.alongTarget, dt, alongSpring)
    sim.drift = stepSpring(sim.drift, sim.driftTarget, dt, SPRING_FOLLOW)
    sim.lift = stepSpring(sim.lift, sim.liftTarget, dt, SPRING_LIFT)
  }
  publish()
  const rest =
    isAtRest(sim.along, sim.alongTarget) &&
    isAtRest(sim.drift, sim.driftTarget) &&
    isAtRest(sim.lift, sim.liftTarget)
  if (!rest) {
    frame = requestAnimationFrame(tick)
    return
  }
  const current = dockStore.get().phase
  if (current === 'settling') landed()
  else if (current === 'landing') finishIfReady()
}

// ---------------------------------------------------------------------------
// Gesture entry points
// ---------------------------------------------------------------------------

/**
 * A stationary long-press on the pill: pick it up. `slot` is the pill's rect in window
 * coordinates, `from` the edge the bar is docked at. Returns false when a move is already on.
 */
export function beginDock(state: UIState, slot: Rect, from: PhoneBarPosition): boolean {
  if (dockStore.get().phase !== 'idle') return false
  const tab = activeTab(state)
  const insets = uiStore.get().insets
  const bar = phoneBarHeight()
  const height = window.innerHeight
  const travel = Math.max(
    1,
    pillCentreAt('bottom', insets, height, bar) - pillCentreAt('top', insets, height, bar)
  )
  sim.along = { x: 0, v: 0 }
  sim.alongTarget = 0
  sim.drift = { x: 0, v: 0 }
  sim.driftTarget = 0
  sim.lift = { x: 0, v: 0 }
  sim.liftTarget = 100
  side = 0
  committed = false
  cancelCommit?.()
  cancelCommit = null
  dockStore.set({
    phase: 'lifted',
    from,
    target: null,
    progress: 0,
    drift: 0,
    lift: 0,
    slot,
    travel,
    heroTabId: tab?.id ?? null
  })
  run('haptic', { kind: 'lift' })
  // The page becomes a card once its thumbnail exists; until then the live view still covers it.
  const show = (): void => {
    if (dockStore.get().phase !== 'idle') setStageLayerShown('dock', true)
  }
  const pending = takePendingCapture()
  if (pending) void pending.then(show, show)
  else if (tab) void captureThumbnail(tab.id).then(show, show)
  else show()
  ensureLoop()
  return true
}

/** A finger came down while the pill was flying to a slot: hold it there and take over. */
export function catchDock(): boolean {
  const s = dockStore.get()
  if (s.phase !== 'settling') return false
  sim.alongTarget = sim.along.x
  sim.driftTarget = sim.drift.x
  side = s.progress >= 0.5 ? 1 : 0
  dockStore.set({ phase: 'lifted', target: null })
  ensureLoop()
  return true
}

/** The finger moved (`dx`, `dy`) px since it picked the pill up (or caught it). */
export function dragDock(dx: number, dy: number, alongStart = 0): void {
  const s = dockStore.get()
  if (s.phase !== 'lifted') return
  const along = alongStart + dy * towardsOther(s.from)
  sim.alongTarget = bandAlong(along, s.travel)
  sim.driftTarget = rubberBand(dx * 0.35, 48)
  ensureLoop()
}

/** Where the carried pill currently is along the track (px), for a drag that catches it. */
export function dockAlong(): number {
  return sim.along.x
}

/** The finger lifted, moving at `vy` px/s (window y). */
export function releaseDock(vy: number): void {
  const s = dockStore.get()
  if (s.phase !== 'lifted') return
  const velocity = vy * towardsOther(s.from)
  const to = relocationTarget(sim.along.x / s.travel, velocity, s.travel)
  sim.along = { x: sim.along.x, v: velocity }
  sim.alongTarget = to * s.travel
  sim.driftTarget = 0
  dockStore.set({ phase: 'settling', target: to === 1 ? otherEdge(s.from) : s.from })
  ensureLoop()
}

/** Whether a relocation is in progress (the pill is off its slot). */
export function dockIsActive(): boolean {
  return dockStore.get().phase !== 'idle'
}

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

function landed(): void {
  const s = dockStore.get()
  const target = s.target ?? s.from
  dockStore.set({ phase: 'landing', target, progress: target === s.from ? 0 : 1 })
  run('haptic', { kind: 'dock' })
  sim.liftTarget = 0
  if (target === s.from) {
    committed = true
  } else {
    run('settings.update', { phoneBarPosition: target })
    cancelCommit = whenBarAt(target, () => {
      cancelCommit = null
      committed = true
      finishIfReady()
    })
  }
  ensureLoop()
}

/** The ghost sets down flat and the browser state carries the new edge: hand back to the bar. */
function finishIfReady(): void {
  if (dockStore.get().phase !== 'landing') return
  if (!committed || !isAtRest(sim.lift, 0)) return
  finish()
}

function finish(): void {
  stopLoop()
  cancelCommit?.()
  cancelCommit = null
  dockStore.set(IDLE)
  setStageLayerShown('dock', false)
  invalidateSnapshot()
  returnFocusToPage()
}

/** Drop the move without ceremony (the phone layout went away). */
export function dismissDock(): void {
  if (dockStore.get().phase === 'idle') return
  finish()
}

/** Runs `then` once the browser reports the bar docked at `edge` (or gives up after a while). */
function whenBarAt(edge: PhoneBarPosition, then: () => void): () => void {
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
  const at = (): boolean => browserStore.get().state?.settings.phoneBarPosition === edge
  if (at()) {
    fire()
    return cancel
  }
  unsubscribe = browserStore.subscribe(() => {
    if (at()) fire()
  })
  timer = setTimeout(fire, 800)
  return cancel
}
