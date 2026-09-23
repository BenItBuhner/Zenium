import { run } from './api'
import { rubberBand } from './gestures/swipe'
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
 * positive into the page), then `release` or `cancel`. While the finger is down the bubble is
 * input, not animation (v2 §11.3): its leading edge rides the finger one to one up to the
 * threshold – 96 dp of motion, Chrome's `THRESHOLD_MULTIPLIER` of 3 drag distances of 32 dp
 * (`SideSlideLayout.java`), the motion taken in steps of at most a third of a drag distance as
 * Chrome's `MIN_PULLS_TO_ACTIVATE` guards a fast fling from navigating by accident – and past
 * the threshold the finger's excess is rubber-banded with the app's shared band, so a long pull
 * never carries the disc into the page. Crossing the threshold is the landmark: one haptic tick
 * (Chrome's `KEYBOARD_TAP`), the arrow's tint to the accent (Chrome's 250 ms), and the disc grows
 * by {@link ARMED_GROWTH} on `SPRING_SNAPPY` – the one part of the drag on a spring; easing back
 * below it shrinks the disc again. A release past the threshold goes back or forward while the
 * bubble shrinks away where it stands (Chrome's hiding animation); a release short of it springs
 * the bubble home. The bubble is drawn by `HistoryNavBubble` off {@link onHistoryNavFrame}, on
 * transform and opacity only – in the chrome's DOM where the chrome is on top, or by a host that
 * draws the disc itself ({@link HistoryNavHost}) where the pages are layered above the chrome.
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
  /** The armed growth's progress, 0 (the disc at its size) to 1 (grown by {@link ARMED_GROWTH}). */
  grow: number
}

/** Chrome's `RAW_SWIPE_LIMIT_DP`: one drag distance, CSS px. */
export const NAV_DRAG_DISTANCE = 32
/** Chrome's `THRESHOLD_MULTIPLIER` of 3: the motion at which a release navigates. */
export const NAV_THRESHOLD = NAV_DRAG_DISTANCE * 3
/** Chrome's `MIN_PULLS_TO_ACTIVATE` of 3: no single touch sample moves the motion by more than this. */
export const NAV_STEP_CLAMP = NAV_DRAG_DISTANCE / 3
/**
 * Past the threshold the finger's excess is rubber-banded over one drag distance: the disc's
 * leading edge never comes further in than the threshold plus this.
 */
export const NAV_BAND_EXTENT = NAV_DRAG_DISTANCE
/** How much the disc grows once letting go would navigate: `scale(1 + ARMED_GROWTH)`. */
export const ARMED_GROWTH = 0.15
/**
 * The hide and the growth run on their springs as distances of this many px (the spring's rest
 * thresholds are in px, and a 0…1 value would rest at once); `hide` and `grow` are the
 * fractions of it covered.
 */
const HIDE_RUN = 100
/** The disc's diameter, CSS px: Chrome's `navigation_bubble_size`. */
export const BUBBLE_SIZE = 44
/** The bubble is fully opaque once its leading edge has come this far in from the side. */
export const BUBBLE_FADE_IN = 16

/** What the disc is drawn with for one frame, whoever draws it. */
export interface BubbleVisuals {
  /**
   * The disc's shift along the drag from its rest, CSS px: at rest its far side sits on the
   * page's side (a whole disc out, `-BUBBLE_SIZE`); its leading edge is `offset` in.
   */
  x: number
  /** About the disc's centre: the armed growth, taken to nothing by the hide. */
  scale: number
  /** Up over the first {@link BUBBLE_FADE_IN} px of offset, taken to nothing by the hide. */
  opacity: number
}

/** Transform and opacity for a frame of the machine – the one mapping the DOM disc and a host's share. */
export function bubbleVisuals(frame: HistoryNavFrame): BubbleVisuals {
  const shown = 1 - frame.hide
  return {
    x: frame.offset - BUBBLE_SIZE,
    scale: (1 + ARMED_GROWTH * frame.grow) * shown,
    opacity: Math.min(1, frame.offset / BUBBLE_FADE_IN) * shown
  }
}

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
 * Where the bubble's leading edge stands for `motion` px of finger: one to one up to
 * {@link NAV_THRESHOLD} (input, v2 §11.3), then the excess rubber-banded over
 * {@link NAV_BAND_EXTENT} so the disc slows and stops short of a drag distance past it.
 */
export function bubbleOffset(motion: number): number {
  const overscroll = Math.max(0, motion)
  if (overscroll <= NAV_THRESHOLD) return overscroll
  return NAV_THRESHOLD + rubberBand(overscroll - NAV_THRESHOLD, NAV_BAND_EXTENT)
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
  private grow = 0
  /** The release's motion: the return home, or the hide after a navigation. */
  private readonly spring: SpringAnimation
  /** The armed growth, the one spring that runs while the finger is down. */
  private readonly growth: SpringAnimation
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: HistoryNavMachineOptions) {
    this.spring = new SpringAnimation(
      SPRING_GENTLE,
      (x) => this.step(x),
      (x) => this.rested(x)
    )
    this.growth = new SpringAnimation(
      SPRING_SNAPPY,
      (x) => this.grown(x),
      // At rest the spring stands a hair off its target: land exactly on 0 or 1.
      () => this.grown(this.growth.destination)
    )
  }

  get state(): HistoryNavState {
    return { tabId: this.tabId, edge: this.edge, phase: this.phase, armed: this.armed }
  }

  /** Where the bubble is right now. */
  get current(): HistoryNavFrame {
    return { offset: this.offset, hide: this.hide, grow: this.grow }
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
    this.growth.stop()
    this.clearTimer()
    const tabId = this.tabId
    this.offset = 0
    this.hide = 0
    this.grow = 0
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
    this.grow = 0
    this.setPhase('dragging', false)
    this.options.paint(tabId, this.current)
  }

  private move(travel: number): void {
    this.motion = navMotion(this.motion, travel, this.lastTravel)
    this.lastTravel = travel
    this.offset = bubbleOffset(this.motion)
    const armed = releaseNavigates(this.motion)
    const wasArmed = this.armed
    this.setPhase('dragging', armed)
    if (this.tabId) this.options.paint(this.tabId, this.current)
    // Crossing the threshold either way: the disc grows, or shrinks back, on its spring.
    if (armed !== wasArmed) this.growTo(armed ? 1 : 0)
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
    // The growth holds where it got to: the hide shrinks the disc from that size.
    this.growth.stop()
    // Chrome hides the bubble where it stands, scale and alpha to nothing.
    this.animate(0, HIDE_RUN, SPRING_SNAPPY)
  }

  private retract(): void {
    this.setPhase('settling', false)
    // A cancel can land while armed: the growth runs back with the return.
    if (this.grow !== 0 || this.growth.running) this.growTo(0)
    // Chrome's return: the bubble runs back out over the side it came from.
    this.animate(this.offset, 0, SPRING_GENTLE)
  }

  /** Run the growth to 0 or 1 on `SPRING_SNAPPY` from wherever it is; under reduced motion it jumps. */
  private growTo(target: number): void {
    if (this.options.reduced?.() ?? reducedMotion()) {
      this.growth.stop()
      this.grown(target * HIDE_RUN)
      return
    }
    const wasRunning = this.growth.running
    const { v } = this.growth.stop()
    this.growth.start(this.grow * HIDE_RUN, wasRunning ? v : 0, target * HIDE_RUN)
  }

  private grown(x: number): void {
    this.grow = Math.min(1, Math.max(0, x / HIDE_RUN))
    if (this.tabId) this.options.paint(this.tabId, this.current)
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
      this.growth.stop()
      this.offset = 0
      this.hide = 0
      this.grow = 0
      this.motion = 0
      if (this.tabId) this.options.paint(this.tabId, this.current)
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
let lastPainted: HistoryNavFrame = { offset: 0, hide: 0, grow: 0 }

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

// ---------------------------------------------------------------------------
// A host that draws the disc
// ---------------------------------------------------------------------------

/**
 * Where the disc stands, for a host that draws it itself: on Android the page WebViews are
 * layered above the chrome's (`cover.ts`, `ContentCover.kt`), so a disc the chrome painted at a
 * page's side would never show – Chrome's own bubble is a view above the content
 * (`HistoryNavigationCoordinator` adds its layout to the content's parent; `SideSlideLayout`
 * holds the `NavigationBubble`). Everything here is in CSS px of the chrome's window, for the
 * host to scale by its density; per frame only the box, its scale and its opacity change.
 */
export interface HistoryNavHostFrame {
  edge: HistoryNavEdge
  /** Window x of the disc's left side, and y of its top, at scale 1. */
  left: number
  top: number
  /** The disc's diameter at scale 1 ({@link BUBBLE_SIZE}). */
  size: number
  /** About the disc's centre. */
  scale: number
  opacity: number
  /** Letting go would navigate: the arrow's accent tint (the host's own 250 ms fade). */
  armed: boolean
  /** Motion is reduced: an opacity change fades over 120 ms; the box still follows the finger. */
  reduced: boolean
  /**
   * The page frame's box the disc is clipped to, as the DOM disc is by the frame's
   * `overflow: hidden`: the disc comes out from beyond the frame's side, and what is still beyond
   * it is not drawn – over the gutter between the frame and the window's edge, or the sidebar.
   */
  clip: BubbleClip
}

/** A box in window CSS px, left / top / right / bottom as `DOMRect` has them. */
export interface BubbleClip {
  left: number
  top: number
  right: number
  bottom: number
}

/** The host that draws the disc (Android's bridge); hosts whose chrome is on top set none. */
export interface HistoryNavHost {
  /** Per frame while the bubble is up, and once with `null` when it has gone. */
  apply(frame: HistoryNavHostFrame | null): void
}

let bubbleHost: HistoryNavHost | null = null

export function setHistoryNavHost(next: HistoryNavHost | null): void {
  bubbleHost = next
}

/** The host drawing the disc, if one is bound. */
export function historyNavHost(): HistoryNavHost | null {
  return bubbleHost
}

/**
 * What the disc is laid against: the page frame's side the drag began at, its vertical centre,
 * and the frame's box that clips it (window CSS px).
 */
export interface BubbleAnchor {
  x: number
  centerY: number
  clip: BubbleClip
}

/** The host's frame for the machine's: the disc's box against `anchor`, the visuals as the DOM disc draws them. */
export function bubbleHostFrame(
  frame: HistoryNavFrame,
  state: HistoryNavState,
  anchor: BubbleAnchor,
  reduced: boolean
): HistoryNavHostFrame {
  const { x, scale, opacity } = bubbleVisuals(frame)
  return {
    edge: state.edge,
    // The DOM disc sits with its far side on the anchor and shifts by `x` into the page.
    left: state.edge === 'left' ? anchor.x + x : anchor.x - x - BUBBLE_SIZE,
    top: anchor.centerY - BUBBLE_SIZE / 2,
    size: BUBBLE_SIZE,
    scale,
    opacity,
    armed: state.armed,
    reduced,
    clip: anchor.clip
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
