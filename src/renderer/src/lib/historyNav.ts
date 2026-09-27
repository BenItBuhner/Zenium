import type { Tab, UIState } from '@shared/types'
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
import { dragBack, dragCloseTarget, type CloseTarget } from './back'
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
 * never carries the disc into the page. The disc (v2 §11.9: 44 in the panel with a 20 arrow in
 * the text ink) grows from {@link BUBBLE_MIN_SCALE} to 1 on `SPRING_SNAPPY` as the drag
 * approaches the threshold – the growth is the one part of the drag on a spring, its target the
 * finger's approach ({@link navGrowth}), so easing back shrinks it again – and crossing the
 * threshold is the landmark: the disc full, the arrow whole, one haptic tick (Chrome's
 * `KEYBOARD_TAP`). A release past the threshold goes back or forward while the disc leaves on
 * the exit fade where it stands (§11.4's departure: opacity out with a tenth of shrink on the
 * exit spring); a release short of it springs the bubble home, shrinking back on the growth's
 * spring. The bubble is drawn by `HistoryNavBubble` off {@link onHistoryNavFrame}, on transform
 * and opacity only – in the chrome's DOM where the chrome is on top, or by a host that draws the
 * disc itself ({@link HistoryNavHost}) where the pages are layered above the chrome.
 *
 * A back drag is always a drag (Chrome's `NavigationHandler.canNavigate`: "navigating back is
 * considered always possible – actual navigation, closing tab, or exiting app"): at the first
 * page of the tab's history the release performs Chrome's back at the root (`lib/back.ts`,
 * `dragBack`), and while the drag is armed the bubble carries the caption Chrome's
 * `NavigationBubble` shows for it – 'Close tab' or 'Close Zenium' ({@link captionText}, Chrome's
 * `CloseTarget`), the pill widening out of the disc on the growth's spring
 * ({@link HistoryNavFrame.caption}) and closing again as the finger eases back under the
 * threshold (`SideSlideLayout.pull()`: `showCaption` while `mWillNavigate`, `hideCloseIndicator`
 * after). A page turn – the page's own back, the tab starting over as a new-tab page (Chrome's
 * new-tab page history entry) – carries no caption.
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
  /**
   * What the drag's release would close where the page has no back of its own – the caption the
   * bubble carries while armed (Chrome's `CloseTarget`); `none` for a page turn, and for every
   * forward drag. Fixed at the drag's start, as Chrome sets `CLOSE_INDICATOR` at `triggerUi`.
   */
  closeTarget: CloseTarget
}

/** What the bubble draws from, every frame while anything moves. */
export interface HistoryNavFrame {
  /** How far the bubble's leading edge has come in from the page's side, CSS px (0: hidden). */
  offset: number
  /** 0 while the bubble is up; runs to 1 as it leaves on the exit fade after a navigation. */
  hide: number
  /**
   * The growth's progress: 0 (the disc at {@link BUBBLE_MIN_SCALE}, the drag just begun) to 1
   * (full, at the threshold). Under reduced motion 1 for the whole drag (v2 §11.9).
   */
  grow: number
  /**
   * How far the caption's pill has come out of the disc: 0 (a disc) to 1 (the whole caption),
   * on the growth's spring while the drag is armed and has a close target ({@link captionShown}),
   * back to 0 as the finger eases under the threshold. Under reduced motion 0 or 1 outright.
   */
  caption: number
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
/** The disc's scale as the drag begins; it is 1 – full – at the threshold (v2 §11.9's .6 → 1). */
export const BUBBLE_MIN_SCALE = 0.6
/**
 * The growth runs on its spring as a distance of this many px (the spring's rest thresholds are
 * in px, and a 0…1 value would rest at once); `grow` is the fraction of it covered.
 */
const GROW_RUN = 100
/**
 * The exit fade the disc leaves on after a navigation, v2 §11.4's departure as `Departures`
 * runs it: `SPRING_SNAPPY` over this many px of travel, `hide` the fraction covered, the disc at
 * `scale(1 − HIDE_SHRINK · hide)` and opacity `1 − hide`.
 */
const HIDE_RUN = 120
/** How far the disc shrinks on its way out: §11.4's tenth. */
export const HIDE_SHRINK = 0.1
/** The disc's diameter, CSS px: Chrome's `navigation_bubble_size`, v2 §11.9's 44. */
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
  /**
   * About the disc's centre: {@link BUBBLE_MIN_SCALE} → 1 by the growth, a tenth less by the end
   * of the hide – except under reduced motion, where the hide is a fade alone (v2 §11.9) and the
   * disc keeps its size while it goes.
   */
  scale: number
  /** Up over the first {@link BUBBLE_FADE_IN} px of offset, taken to nothing by the hide. */
  opacity: number
}

/**
 * Transform and opacity for a frame of the machine – the one mapping the DOM disc and a host's
 * share. Under reduced motion (`reduced`) the machine's hide arrives whole in one frame, so the
 * exit's shrink would be a snap to ×0.9 the frame the disc starts to fade: the fade is the
 * whole of the leave then, and the scale is the growth's alone.
 */
export function bubbleVisuals(frame: HistoryNavFrame, reduced = false): BubbleVisuals {
  const shrink = reduced ? 1 : 1 - HIDE_SHRINK * frame.hide
  return {
    x: frame.offset - BUBBLE_SIZE,
    scale: (BUBBLE_MIN_SCALE + (1 - BUBBLE_MIN_SCALE) * frame.grow) * shrink,
    opacity: Math.min(1, frame.offset / BUBBLE_FADE_IN) * (1 - frame.hide)
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

/**
 * Where the growth is heading for `motion` px of finger: the drag's approach to the threshold,
 * 0 as it begins to 1 at {@link NAV_THRESHOLD} and past it (v2 §11.9: the disc grows from .6 to
 * 1 on the spring as the drag approaches the commit, and is full at it).
 */
export function navGrowth(motion: number): number {
  return Math.min(1, Math.max(0, motion) / NAV_THRESHOLD)
}

/**
 * Whether the bubble carries its caption: Chrome's `SideSlideLayout.pull()` shows the close
 * indicator only while `mWillNavigate` and only when there is one (`CloseTarget.NONE` shows
 * nothing) – the caption is the threshold's second sign, after the disc's growth and the tap,
 * and goes again as the finger eases back under it.
 */
export function captionShown(armed: boolean, closeTarget: CloseTarget): boolean {
  return armed && closeTarget !== 'none'
}

/**
 * The caption's text: Chrome's `NavigationBubble.showCaption` – "Close tab" for the tab, "Close
 * %app%" for the app (`android_chrome_strings.grd`: `IDS_OVERSCROLL_NAVIGATION_CLOSE_TAB`,
 * `IDS_OVERSCROLL_NAVIGATION_CLOSE_CHROME`); null for a page turn.
 */
export function captionText(closeTarget: CloseTarget): string | null {
  switch (closeTarget) {
    case 'tab':
      return 'Close tab'
    case 'app':
      return 'Close Zenium'
    case 'none':
      return null
  }
}

/**
 * Chrome's `COLOR_TRANSITION_DURATION_MS` (`NavigationBubble.java` l.51): the arrow's tint to the
 * accent as the drag arms, and back as it disarms.
 */
export const TINT_MS = 250
/** The tint under reduced motion: §11.3's 120 ms, a tween still (the lead's 04:34 ruling). */
export const REDUCED_TINT_MS = REDUCED_FADE_MS
/**
 * The custom property the DOM disc writes the tint to, 0 the text ink to 1 the accent, and
 * `main.css` mixes the glyph's and the caption's `color` from (`.zen-histnav-glyph`,
 * `.zen-histnav-caption`).
 */
export const TINT_PROPERTY = '--zen-histnav-tint'

/**
 * The arrow's tint as the drag arms, on the frames the machine paints and the clock between
 * them: Chrome's `NavigationBubble` runs its arrow's tint from the ink to the accent over 250 ms
 * as `willNavigate()` turns true and back over 250 ms as it turns false (152.0.7977.89
 * `NavigationBubble.java` l.51, l.101–102 the colour animator, l.201–206 `setImageTint`) – a
 * `ValueAnimator` reversed from wherever it stands, so a finger that eases back under the
 * threshold mid-tint takes the colour back from where it is, with no jump. This keeps the same:
 * a value 0 (the text ink) to 1 (the accent) moving toward its target at the leg's rate, the
 * rising `armed` setting the target to 1 and the falling one to 0, each leg starting from the
 * value as it stands, the ends exact. Under reduced motion the leg is §11.3's 120 ms – a shorter
 * tween, not a jump (the lead's 04:34 ruling, v2 §11.9 amended for the arrow alone). A null
 * frame (the bubble down) resets it, so the next drag starts in the ink.
 *
 * Written per frame, like `fadeOpacity`: the reduced-motion stylesheet removes every transition
 * it does not re-declare and re-declares opacity fades alone (`reducedMotion.test.ts`), so a CSS
 * transition could not carry a 120 ms colour tween; the same class in Kotlin drives the host's
 * disc (`HistoryNavBubbleView.kt` `ArmedTint`), so both discs mix the one ink the one way. The
 * DOM disc writes the value to `--zen-histnav-tint` for `main.css` to mix the arrow's and the
 * caption's `color` from (one ink per pill); the fill and the hairline never tint.
 */
export class ArmedTint {
  /** Where the tint stands: 0 the text ink, 1 the accent. */
  value = 0
  private target = 0
  private durationMs = TINT_MS
  /** The leg under way, as it started: the value it left from and when – each step lands where the clock says, no residue. */
  private legFrom = 0
  private legStartMs = 0

  /** The tint has a way to go: the disc keeps stepping it between the machine's frames. */
  get running(): boolean {
    return this.value !== this.target
  }

  /**
   * A frame's armed flag (null: the bubble is down – the tint is reset at once) and reduced flag,
   * at `nowMs` on the animation clock; the value as it stands on this frame. A change of target
   * starts a leg from the value as it stands; the same target lets the leg run on.
   */
  take(armed: boolean | null, reduced: boolean, nowMs: number): number {
    if (armed === null) {
      this.value = 0
      this.target = 0
      this.legFrom = 0
      this.legStartMs = nowMs
      return this.value
    }
    this.step(nowMs)
    const duration = reduced ? REDUCED_TINT_MS : TINT_MS
    if (duration !== this.durationMs) {
      this.durationMs = duration
      this.legFrom = this.value
      this.legStartMs = nowMs
    }
    const next = armed ? 1 : 0
    if (next !== this.target) {
      this.target = next
      this.legFrom = this.value
      this.legStartMs = nowMs
    }
    return this.value
  }

  /** The clock at `nowMs`: the value the leg's rate puts between where it left from and its target, and no further. */
  step(nowMs: number): number {
    if (this.value === this.target) return this.value
    const travel = Math.max(0, nowMs - this.legStartMs) / this.durationMs
    this.value =
      this.target > this.legFrom
        ? Math.min(this.target, this.legFrom + travel)
        : Math.max(this.target, this.legFrom - travel)
    return this.value
  }
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

export interface HistoryNavMachineOptions {
  /**
   * Go back (`left`) or forward (`right`) in the tab's history – for a back with no page behind,
   * Chrome's back at the root (close the tab, leave the app; `lib/back.ts`).
   */
  navigate(tabId: string, edge: HistoryNavEdge): void
  /** The bubble is at `frame`; runs every frame while anything moves. */
  paint(tabId: string, frame: HistoryNavFrame): void
  /** The phase, the armed flag or the close target changed. */
  onChange(state: HistoryNavState): void
  /** Whether motion is reduced (springs jump, the bubble fades over 120 ms instead). */
  reduced?(): boolean
  /**
   * What a release of this drag would close where the page has no back of its own: the caption
   * the bubble carries while armed. Asked once, as the drag begins; none: `none`.
   */
  closeTarget?(tabId: string, edge: HistoryNavEdge): CloseTarget
}

export class HistoryNavMachine {
  private tabId: string | null = null
  private edge: HistoryNavEdge = 'left'
  private phase: HistoryNavPhase = 'idle'
  private armed = false
  private closeTarget: CloseTarget = 'none'
  private motion = 0
  private lastTravel = 0
  private offset = 0
  private hide = 0
  private grow = 0
  private caption = 0
  /** The release's motion: the return home, or the exit fade after a navigation. */
  private readonly spring: SpringAnimation
  /** The growth, the one spring that runs while the finger is down: its target the finger's approach. */
  private readonly growth: SpringAnimation
  /** The caption's pill, out of the disc and back on the growth's spring as the drag arms and disarms. */
  private readonly captioning: SpringAnimation
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
    this.captioning = new SpringAnimation(
      SPRING_SNAPPY,
      (x) => this.captioned(x),
      () => this.captioned(this.captioning.destination)
    )
  }

  get state(): HistoryNavState {
    return {
      tabId: this.tabId,
      edge: this.edge,
      phase: this.phase,
      armed: this.armed,
      closeTarget: this.closeTarget
    }
  }

  /** Where the bubble is right now. */
  get current(): HistoryNavFrame {
    return { offset: this.offset, hide: this.hide, grow: this.grow, caption: this.caption }
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
    this.captioning.stop()
    this.clearTimer()
    const tabId = this.tabId
    this.offset = 0
    this.hide = 0
    this.grow = 0
    this.caption = 0
    this.motion = 0
    if (tabId) this.options.paint(tabId, this.current)
    this.setPhase('idle', false, 'none')
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
    this.caption = 0
    // Under reduced motion the disc is drawn at its full size the moment the drag arms (v2
    // §11.9): the growth is movement, and movement goes.
    this.grow = this.reduced() ? 1 : 0
    // Chrome sets the close indicator as the UI triggers (`NavigationHandler.triggerUi`): what
    // the release would close is read once, here, and holds for the drag.
    this.setPhase('dragging', false, this.options.closeTarget?.(tabId, edge) ?? 'none')
    this.options.paint(tabId, this.current)
  }

  private move(travel: number): void {
    this.motion = navMotion(this.motion, travel, this.lastTravel)
    this.lastTravel = travel
    this.offset = bubbleOffset(this.motion)
    this.setPhase('dragging', releaseNavigates(this.motion), this.closeTarget)
    if (this.tabId) this.options.paint(this.tabId, this.current)
    // The growth follows the finger's approach to the threshold on its spring: out as the drag
    // comes in, back as it eases out.
    this.growTo(navGrowth(this.motion))
    // The caption is the threshold's: out as the drag arms, back as it eases under.
    this.captionTo(captionShown(this.armed, this.closeTarget) ? 1 : 0)
  }

  private release(): void {
    if (releaseNavigates(this.motion)) this.commit()
    else this.retract()
  }

  private commit(): void {
    const tabId = this.tabId
    if (!tabId) return
    this.setPhase('navigating', true, this.closeTarget)
    this.options.navigate(tabId, this.edge)
    // The growth is heading for full already (the motion is past the threshold) and runs on to
    // it; the disc leaves on the exit fade where it stands (v2 §11.9), the spring resting both.
    // The caption leaves with it, as it stands: the fade takes the pill whole.
    this.animate(0, HIDE_RUN, SPRING_SNAPPY)
  }

  private retract(): void {
    this.setPhase('settling', false, this.closeTarget)
    // The disc shrinks back on the same spring it grew on while the return runs (v2 §11.9).
    if (this.grow !== 0 || this.growth.running) this.growTo(0)
    // A cancel while armed lets go of the caption too (Chrome's `hideCloseIndicator` as the
    // bubble resets); a release short of the threshold has none out.
    if (this.caption !== 0 || this.captioning.running) this.captionTo(0)
    // Chrome's return: the bubble runs back out over the side it came from.
    this.animate(this.offset, 0, SPRING_GENTLE)
  }

  /**
   * Head the caption's pill for `target` (1 out, 0 in) on `SPRING_SNAPPY`, retargeted in
   * flight. Under reduced motion it is set outright: the caption is a state, and only its
   * motion goes (v2 §11.3).
   */
  private captionTo(target: number): void {
    if (this.reduced()) {
      if (this.caption === target) return
      this.caption = target
      if (this.tabId) this.options.paint(this.tabId, this.current)
      return
    }
    const to = target * GROW_RUN
    if (this.captioning.running) {
      this.captioning.retarget(to)
      return
    }
    const from = this.caption * GROW_RUN
    if (Math.abs(from - to) < 1e-6) return
    this.captioning.start(from, 0, to)
  }

  private captioned(x: number): void {
    this.caption = Math.min(1, Math.max(0, x / GROW_RUN))
    if (this.tabId) this.options.paint(this.tabId, this.current)
  }

  /**
   * Head the growth for `target` on `SPRING_SNAPPY`: retargeted in flight, set off from rest.
   * Under reduced motion nothing runs – the disc is full from the drag's start ({@link start}).
   */
  private growTo(target: number): void {
    if (this.reduced()) return
    const to = target * GROW_RUN
    if (this.growth.running) {
      this.growth.retarget(to)
      return
    }
    const from = this.grow * GROW_RUN
    if (Math.abs(from - to) < 1e-6) return
    this.growth.start(from, 0, to)
  }

  private grown(x: number): void {
    this.grow = Math.min(1, Math.max(0, x / GROW_RUN))
    if (this.tabId) this.options.paint(this.tabId, this.current)
  }

  private reduced(): boolean {
    return this.options.reduced?.() ?? reducedMotion()
  }

  /** Run the phase's value from `from` to `to`: on the spring, or under reduced motion as a 120 ms fade. */
  private animate(from: number, to: number, config: SpringConfig): void {
    if (this.reduced()) {
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
      this.captioning.stop()
      this.offset = 0
      this.hide = 0
      this.grow = 0
      this.caption = 0
      this.motion = 0
      if (this.tabId) this.options.paint(this.tabId, this.current)
      this.setPhase('idle', false, 'none')
      this.tabId = null
    }
  }

  private setPhase(phase: HistoryNavPhase, armed: boolean, closeTarget: CloseTarget): void {
    if (this.phase === phase && this.armed === armed && this.closeTarget === closeTarget) return
    this.phase = phase
    this.armed = armed
    this.closeTarget = closeTarget
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
  { tabId: null, edge: 'left', phase: 'idle', armed: false, closeTarget: 'none' },
  'historyNav'
)

type FrameListener = (frame: HistoryNavFrame, state: HistoryNavState) => void
const frameListeners = new Set<FrameListener>()
let lastPainted: HistoryNavFrame = { offset: 0, hide: 0, grow: 0, caption: 0 }

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
  /**
   * Letting go would navigate – the drag's state, for a host that wants it. The disc draws no
   * mark of its own for it: v2 §11.9's threshold shows as the full disc and the haptic.
   */
  armed: boolean
  /**
   * Motion is reduced: the leave (the frame that takes the disc to nothing) fades over 120 ms
   * and nothing else animates – the scale carries no exit shrink; the box still follows the finger.
   */
  reduced: boolean
  /**
   * The page frame's box the disc is clipped to, as the DOM disc is by the frame's
   * `overflow: hidden`: the disc comes out from beyond the frame's side, and what is still beyond
   * it is not drawn – over the gutter between the frame and the window's edge, or the sidebar.
   */
  clip: BubbleClip
  /**
   * How far the caption's pill is out of the disc, 0 (a disc) to 1 (the whole caption): the
   * pill widens from the disc's far side into the page, the arrow staying where it is
   * ({@link HistoryNavFrame.caption}).
   */
  caption: number
  /** The caption's text ({@link captionText}); null when the drag has none, and `caption` stays 0. */
  captionText: string | null
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
  const { x, scale, opacity } = bubbleVisuals(frame, reduced)
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
    clip: anchor.clip,
    caption: frame.caption,
    captionText: captionText(state.closeTarget)
  }
}

/** The tab a drag is on, as the chrome's state has it right now; null once it is gone. */
function draggedTab(tabId: string): { tab: Tab; state: UIState } | null {
  const state = browserStore.get().state
  const tab = state?.tabs[tabId]
  return state && tab ? { tab, state } : null
}

const machine = new HistoryNavMachine({
  navigate: (tabId, edge) => {
    if (edge === 'right') {
      run('tab.forward', { tabId })
      return
    }
    // Chrome's `NavigationHandler.navigate(back)` through the `BackActionDelegate`: the page's
    // own back, or Chrome's back at the root – the tab closed, the app to the background.
    const dragged = draggedTab(tabId)
    if (dragged) dragBack(dragged.tab, dragged.state)
    else run('tab.back', { tabId })
  },
  closeTarget: (tabId, edge) => {
    if (edge === 'right') return 'none'
    const dragged = draggedTab(tabId)
    return dragged ? dragCloseTarget(dragged.tab, dragged.state) : 'none'
  },
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
    // as `willNavigate()` turns true). A host that draws the disc performs Chrome's constant
    // itself on the frame that arms (`HistoryNavBubbleLayer`, one message with the disc's full
    // frame): the chrome's tick is for the DOM disc alone.
    if (armed && !wasArmed && phase === 'dragging' && bubbleHost === null)
      run('haptic', { kind: 'tick' })
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
