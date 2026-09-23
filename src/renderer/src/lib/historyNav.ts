import { run } from './api'
import {
  reducedMotion,
  SPRING_GENTLE,
  SPRING_SNAPPY,
  SpringAnimation,
  type SpringConfig
} from './motion/spring'
import { REDUCED_FADE_MS } from './motion/fade'
import { activeTab } from './selectors'
import { createStore } from './store'
import { browserStore } from './ui'

/**
 * Overscroll history navigation on touch hosts with the system's three navigation buttons (GN-04).
 *
 * The host owns the page WebView and its touches; in 3-button mode it recognises a drag in from
 * a side of a page that cannot scroll further that way (see `HistoryNavClassifier.kt`) and
 * streams it here as `start` (with the edge), `move` (with the finger's raw travel in CSS px,
 * positive into the page), then `release` or `cancel`. This module turns that travel into the
 * arrow bubble's position the way Chrome's `SideSlideLayout` does – the finger's motion taken
 * in steps of at most a third of the 32 dp drag distance, one to one for the first 32 dp, then a
 * slingshot that stops at 64 dp – arms at 96 dp of motion (Chrome's `THRESHOLD_MULTIPLIER` of 3)
 * with one haptic tick, and on a release past that goes back or forward while the bubble
 * shrinks away; a release short of it springs the bubble home. The bubble is drawn by
 * `HistoryNavBubble` off {@link onHistoryNavFrame}, on transform and opacity only.
 */

export type HistoryNavEdge = 'left' | 'right'

export type HistoryNavPhase = 'idle' | 'dragging' | 'navigating' | 'settling'

/** What the host reports: which touch phase, and the finger's travel since the drag began. */
export type HistoryNavEventPhase = 'start' | 'move' | 'release' | 'cancel'

export interface HistoryNavEventPayload {
  /** The side the drag began at (`start`). */
  edge?: HistoryNavEdge
  /** Finger travel since the drag began, CSS px, positive into the page (`move`). */
  travel?: number
  /** Timestamp of the touch sample, ms on any monotonic clock. */
  time?: number
}

export interface HistoryNavState {
  /** Tab whose page is being dragged (null while idle). */
  tabId: string | null
  edge: HistoryNavEdge
  phase: HistoryNavPhase
  /** Letting go now would navigate: the motion is past the threshold. */
  armed: boolean
}

/** What the bubble draws from, every frame while anything moves. */
export interface HistoryNavFrame {
  /** How far the bubble's leading edge has come in from the page's side, CSS px (0: hidden). */
  offset: number
  /** 0 while the bubble is up; runs to 1 as it shrinks away after a navigation. */
  hide: number
}

/** Chrome's `RAW_SWIPE_LIMIT_DP`: the finger motion the bubble follows one to one, CSS px. */
export const NAV_DRAG_DISTANCE = 32
/** Chrome's `THRESHOLD_MULTIPLIER` of 3: the motion at which a release navigates. */
export const NAV_THRESHOLD = NAV_DRAG_DISTANCE * 3
/** The bubble's furthest reach in from the side: the slingshot ends here, at the threshold. */
export const NAV_BUBBLE_EXTENT = NAV_DRAG_DISTANCE * 2
/** Chrome's `MIN_PULLS_TO_ACTIVATE` of 3: no single touch sample moves the motion by more than this. */
export const NAV_STEP_CLAMP = NAV_DRAG_DISTANCE / 3
/**
 * The hide runs on the spring as a distance of this many px (the spring's rest thresholds are
 * in px, and a 0…1 value would rest at once); `hide` is the fraction of it covered.
 */
const HIDE_RUN = 100

// ---------------------------------------------------------------------------
// The mapping – pure, so it can be tested and reasoned about
// ---------------------------------------------------------------------------

/**
 * The motion after one more touch sample: the finger's travel changed by `travel - lastTravel`,
 * taken in steps of at most {@link NAV_STEP_CLAMP} either way (a fast swipe needs several
 * samples to arm, Chrome's guard against an accidental navigation).
 */
export function navMotion(motion: number, travel: number, lastTravel: number): number {
  const delta = Math.max(-NAV_STEP_CLAMP, Math.min(NAV_STEP_CLAMP, travel - lastTravel))
  return motion + delta
}

/**
 * Where the bubble's leading edge stands for `motion` px of finger, Chrome's slingshot: one to
 * one up to {@link NAV_DRAG_DISTANCE}, then with tension over the next two drag distances to
 * come to rest at {@link NAV_BUBBLE_EXTENT} exactly where the motion reaches the threshold.
 */
export function bubbleOffset(motion: number): number {
  const overscroll = Math.max(0, motion)
  const dragPercent = Math.min(1, overscroll / NAV_DRAG_DISTANCE)
  const extra =
    Math.max(0, Math.min(overscroll - NAV_DRAG_DISTANCE, NAV_DRAG_DISTANCE * 2)) / NAV_DRAG_DISTANCE
  const tension = (extra / 4 - (extra / 4) ** 2) * 2
  return NAV_DRAG_DISTANCE * dragPercent + NAV_DRAG_DISTANCE * tension * 2
}

/** Whether letting go with `motion` px of finger navigates: Chrome's `willNavigate()`. */
export function releaseNavigates(motion: number): boolean {
  return motion > NAV_THRESHOLD
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

export interface HistoryNavMachineOptions {
  /** Go back (`left`) or forward (`right`) in the tab's history. */
  navigate(tabId: string, edge: HistoryNavEdge): void
  /** The bubble is at `frame`; runs every frame while anything moves. */
  paint(tabId: string, frame: HistoryNavFrame): void
  /** The phase or the armed flag changed. */
  onChange(state: HistoryNavState): void
  /** Whether motion is reduced (springs jump, the bubble fades over 120 ms instead). */
  reduced?(): boolean
}

export class HistoryNavMachine {
  private tabId: string | null = null
  private edge: HistoryNavEdge = 'left'
  private phase: HistoryNavPhase = 'idle'
  private armed = false
  private motion = 0
  private lastTravel = 0
  private offset = 0
  private hide = 0
  private readonly spring: SpringAnimation
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: HistoryNavMachineOptions) {
    this.spring = new SpringAnimation(
      SPRING_GENTLE,
      (x) => this.step(x),
      (x) => this.rested(x)
    )
  }

  get state(): HistoryNavState {
    return { tabId: this.tabId, edge: this.edge, phase: this.phase, armed: this.armed }
  }

  /** Where the bubble is right now. */
  get current(): HistoryNavFrame {
    return { offset: this.offset, hide: this.hide }
  }

  /** Host → machine. */
  dispatch(
    tabId: string,
    phase: HistoryNavEventPhase,
    payload?: HistoryNavEventPayload | null
  ): void {
    switch (phase) {
      case 'start':
        this.start(tabId, payload?.edge === 'right' ? 'right' : 'left')
        return
      case 'move':
        if (this.tabId !== tabId || this.phase !== 'dragging') return
        this.move(payload?.travel ?? 0)
        return
      case 'release':
        if (this.tabId !== tabId || this.phase !== 'dragging') return
        this.release()
        return
      case 'cancel':
        if (this.tabId !== tabId || this.phase !== 'dragging') return
        this.retract()
        return
    }
  }

  /** The tab went away or another one is showing: take the bubble down at once and forget the drag. */
  abort(): void {
    if (this.phase === 'idle') return
    this.spring.stop()
    this.clearTimer()
    const tabId = this.tabId
    this.offset = 0
    this.hide = 0
    this.motion = 0
    if (tabId) this.options.paint(tabId, this.current)
    this.setPhase('idle', false)
    this.tabId = null
  }

  private start(tabId: string, edge: HistoryNavEdge): void {
    // A drag that lands while the last one's spring is still going takes over from rest: the
    // host only starts one on a fresh finger at the edge, so nothing is caught mid-flight.
    if (this.phase !== 'idle') this.abort()
    this.tabId = tabId
    this.edge = edge
    this.motion = 0
    this.lastTravel = 0
    this.offset = 0
    this.hide = 0
    this.setPhase('dragging', false)
    this.options.paint(tabId, this.current)
  }

  private move(travel: number): void {
    this.motion = navMotion(this.motion, travel, this.lastTravel)
    this.lastTravel = travel
    this.offset = bubbleOffset(this.motion)
    this.setPhase('dragging', releaseNavigates(this.motion))
    if (this.tabId) this.options.paint(this.tabId, this.current)
  }

  private release(): void {
    if (releaseNavigates(this.motion)) this.commit()
    else this.retract()
  }

  private commit(): void {
    const tabId = this.tabId
    if (!tabId) return
    this.setPhase('navigating', true)
    this.options.navigate(tabId, this.edge)
    // Chrome hides the bubble where it stands, scale and alpha to nothing.
    this.animate(0, HIDE_RUN, SPRING_SNAPPY)
  }

  private retract(): void {
    this.setPhase('settling', false)
    // Chrome's return: the bubble runs back out over the side it came from.
    this.animate(this.offset, 0, SPRING_GENTLE)
  }

  /** Run the phase's value from `from` to `to`: on the spring, or under reduced motion as a 120 ms fade. */
  private animate(from: number, to: number, config: SpringConfig): void {
    if (this.options.reduced?.() ?? reducedMotion()) {
      // The bubble stays where it is and fades (v2 §11.3); the value jumps once the fade is over.
      this.hide = 1
      if (this.tabId) this.options.paint(this.tabId, this.current)
      this.clearTimer()
      this.timer = setTimeout(() => {
        this.timer = null
        this.rested(to)
      }, REDUCED_FADE_MS)
      return
    }
    this.spring.start(from, 0, to, config)
  }

  private step(x: number): void {
    if (this.phase === 'navigating') this.hide = Math.min(1, Math.max(0, x / HIDE_RUN))
    else this.offset = Math.max(0, x)
    if (this.tabId) this.options.paint(this.tabId, this.current)
  }

  private rested(x: number): void {
    this.step(x)
    if (this.phase === 'settling' || this.phase === 'navigating') {
      this.offset = 0
      this.hide = 0
      this.motion = 0
      this.setPhase('idle', false)
      this.tabId = null
    }
  }

  private setPhase(phase: HistoryNavPhase, armed: boolean): void {
    if (this.phase === phase && this.armed === armed) return
    this.phase = phase
    this.armed = armed
    this.options.onChange(this.state)
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}

// ---------------------------------------------------------------------------
// The chrome's instance
// ---------------------------------------------------------------------------

export const historyNavStore = createStore<HistoryNavState>(
  { tabId: null, edge: 'left', phase: 'idle', armed: false },
  'historyNav'
)

type FrameListener = (frame: HistoryNavFrame, state: HistoryNavState) => void
const frameListeners = new Set<FrameListener>()
let lastPainted: HistoryNavFrame = { offset: 0, hide: 0 }

/**
 * Per-frame value for the bubble (write DOM styles through refs; this runs every frame while
 * the bubble moves). The listener is called once with the current value when it subscribes.
 */
export function onHistoryNavFrame(listener: FrameListener): () => void {
  frameListeners.add(listener)
  const state = historyNavStore.get()
  if (state.tabId) listener(lastPainted, state)
  return () => {
    frameListeners.delete(listener)
  }
}

const machine = new HistoryNavMachine({
  navigate: (tabId, edge) => run(edge === 'left' ? 'tab.back' : 'tab.forward', { tabId }),
  paint: (_tabId, frame) => {
    lastPainted = frame
    const state = machine.state
    for (const listener of frameListeners) listener(frame, state)
  },
  onChange: (state) => historyNavStore.set(state)
})

/** Host → chrome: one touch phase of a history drag on the tab's page. */
export function dispatchHistoryNavEvent(
  tabId: string,
  phase: HistoryNavEventPhase,
  payload?: HistoryNavEventPayload | null
): void {
  machine.dispatch(tabId, phase, payload)
}

/** Take the bubble down at once and forget any drag in flight. */
export function abortHistoryNav(): void {
  machine.abort()
}

const flags = globalThis as unknown as { __zenHistoryNavWired?: boolean }
if (!flags.__zenHistoryNavWired) {
  flags.__zenHistoryNavWired = true
  let wasArmed = false
  historyNavStore.subscribe(() => {
    const { armed, phase } = historyNavStore.get()
    // Crossing the threshold is a landmark: one tick, on the way out only (Chrome's KEYBOARD_TAP
    // as `willNavigate()` turns true).
    if (armed && !wasArmed && phase === 'dragging') run('haptic', { kind: 'tick' })
    wasArmed = armed
  })
  browserStore.subscribe(() => {
    const { tabId, phase } = historyNavStore.get()
    if (phase === 'idle' || !tabId) return
    const state = browserStore.get().state
    // The page being dragged must still be the one on screen.
    if (!state || activeTab(state)?.id !== tabId) machine.abort()
  })
}
