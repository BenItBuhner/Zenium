import type { PhoneBarPosition, Rect } from '@shared/types'
import { isEmptyTabUrl, isInternalUrl } from '@shared/url'
import { dockStore } from './gestures/dock'
import { SPRING_SNAPPY, SpringAnimation } from './motion/spring'
import { VelocityTracker } from './motion/velocity'
import { pullStore } from './pull'
import { activeTab } from './selectors'
import { createStore } from './store'
import { browserStore, contentAreaStore, pageHidden, uiStore, type UiState } from './ui'

/**
 * The phone bar hiding on scroll (Chrome / Edge parity; design language v2 draft §11).
 *
 * The host owns the page WebView and its touches; it streams the page's scroll here as `start`
 * (a finger down), `move` (how far the page scrolled since the last report, CSS px, positive
 * when the page moves up under a finger going down the page) and `end` (the finger lifted),
 * batched per frame (see `BarHideGesture.kt`). This module turns that stream into one value –
 * how far the bar has gone off its edge, 0 … {@link travel} – clamped and one to one with the
 * scroll while a finger or a fling drives it, and snapped fully in or out on a spring when the
 * scroll ends. The value is published three ways every frame: `--zen-bar-hide` (0 shown … 1
 * hidden) on the document root for the bar and anything that slides with it, the host command
 * that moves the page's edge to follow (the page gets the bar's band as the bar leaves it), and
 * `uiStore.barHidden`, a boolean that flips only at rest, so the content column re-lays itself
 * out at the two ends of the motion and never in between.
 *
 * Gating (`barMayHide`): the bar stays put on the new tab page and the internal pages, while
 * the omnibox is editing, while a sheet or any chrome covers the page, while find or the zoom
 * panel is docked, during a pull-to-refresh, while the keyboard is up, while the pill is being
 * carried, while an accessibility service explores the screen by touch, and with the setting
 * off. A gate closing on a hidden bar brings it back on the spring.
 */

export type BarHidePhase = 'rest' | 'dragging' | 'flinging' | 'settling'

export type BarScrollPhase = 'start' | 'move' | 'end' | 'show'

export interface BarScrollPayload {
  /** The page's scroll since the last report, CSS px, positive when scrolling down the page. */
  delta?: number
  /** Timestamp of the sample, ms on any monotonic clock. */
  time?: number
}

/** A release scrolling faster than this (px/s) snaps in its direction, wherever the bar is. */
export const BAR_HIDE_FLING_VELOCITY = 400
/** A release slower than this settles at once; faster ones wait for the fling's scroll to end. */
export const BAR_HIDE_SETTLE_VELOCITY = 200
/**
 * A fling has ended when the page has not scrolled for this long. Longer than the host's own
 * window for a fling's scroll (`BarHideGesture.FLING_GAP_MS`, 120 ms), by a frame or two of the
 * bridge: a fling's last report must never find the bar settled already, or it would set it
 * flinging again for a px and snap it a second time.
 */
export const BAR_HIDE_FLING_GAP_MS = 150
/** A bottom inset this large (CSS px) is the keyboard: no gesture bar comes close. */
export const KEYBOARD_INSET_MIN = 120

// ---------------------------------------------------------------------------
// The mapping – pure, so it can be tested and reasoned about
// ---------------------------------------------------------------------------

/** Where the bar is after the page scrolled `delta` more: one to one, clamped to its travel. */
export function stepOffset(offset: number, delta: number, travel: number): number {
  if (!Number.isFinite(delta)) return offset
  return Math.min(travel, Math.max(0, offset + delta))
}

/**
 * Where a release with the bar at `offset` and the page scrolling at `velocity` px/s (positive
 * down the page) snaps to: the direction of a fling, else the nearer end.
 */
export function snapTarget(offset: number, velocity: number, travel: number): number {
  if (velocity >= BAR_HIDE_FLING_VELOCITY) return travel
  if (velocity <= -BAR_HIDE_FLING_VELOCITY) return 0
  return offset >= travel / 2 ? travel : 0
}

/** Everything that keeps the bar in place. */
export interface BarHideGate {
  /** Settings › Look and Feel › URL bar › Hide toolbar when scrolling. */
  enabled: boolean
  /** The active page is the new tab page (or blank) or one of the browser's own pages. */
  internalPage: boolean
  /** The omnibox is editing. */
  editing: boolean
  /** A sheet, a menu, the stage or any other chrome covers the page. */
  covered: boolean
  /** Find in page or the zoom panel is docked at the frame's edge (§9.32). */
  panelDocked: boolean
  /** The keyboard is up. */
  keyboardUp: boolean
  /** A pull-to-refresh is in flight. */
  pulling: boolean
  /** The pill is being carried to the other edge. */
  carrying: boolean
  /**
   * An accessibility service explores the screen by touch (TalkBack; the host's
   * `AccessibilityManager.isTouchExplorationEnabled`). Chrome never hides its controls while an
   * accessibility service is on: a user reading the page by swipes would lose the toolbar and
   * have to find it again. The same here, keyed on touch exploration – a service that leaves it
   * off (switch access) still has the bar come back when its focus lands on the hidden pill
   * (`showBar`). The Settings switch is left as it is.
   */
  touchExploring: boolean
}

export function barMayHide(gate: BarHideGate): boolean {
  return (
    gate.enabled &&
    !gate.internalPage &&
    !gate.editing &&
    !gate.covered &&
    !gate.panelDocked &&
    !gate.keyboardUp &&
    !gate.pulling &&
    !gate.carrying &&
    !gate.touchExploring
  )
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

export interface BarHideMachineOptions {
  /** The bar is `offset` px off its edge; runs every frame while anything moves. */
  paint(offset: number): void
  /** The phase changed. */
  onChange(phase: BarHidePhase): void
  /** Schedules `fn` after `ms` (a seam for tests); returns a cancel. */
  later?(fn: () => void, ms: number): () => void
}

export class BarHideMachine {
  private offset = 0
  private phase: BarHidePhase = 'rest'
  private allowed = true
  /** Cumulative scroll of the current drag or fling, what the velocity is read from. */
  private scrolled = 0
  private readonly tracker = new VelocityTracker()
  private readonly spring: SpringAnimation
  private cancelGap: (() => void) | null = null

  constructor(
    private readonly options: BarHideMachineOptions,
    private travelPx: number
  ) {
    this.spring = new SpringAnimation(
      SPRING_SNAPPY,
      (x) => this.paintAt(x),
      (x) => this.rested(x)
    )
  }

  /** How far the bar goes: the band the page gains once it is hidden (CSS px). */
  get travel(): number {
    return this.travelPx
  }

  set travel(px: number) {
    if (px === this.travelPx || !(px > 0)) return
    const progress = this.travelPx > 0 ? this.offset / this.travelPx : 0
    this.travelPx = px
    this.paintAt(progress * px)
  }

  /** Where the bar is (CSS px off its edge). */
  get current(): number {
    return this.offset
  }

  get state(): BarHidePhase {
    return this.phase
  }

  /** At rest and fully off its edge. */
  get hidden(): boolean {
    return this.phase === 'rest' && this.offset >= this.travelPx
  }

  /** Host → machine. */
  dispatch(phase: BarScrollPhase, payload?: BarScrollPayload | null): void {
    switch (phase) {
      case 'start':
        this.start()
        return
      case 'move':
        this.move(payload?.delta ?? 0, payload?.time ?? performance.now())
        return
      case 'end':
        this.end(payload?.time)
        return
      case 'show':
        this.snapTo(0)
        return
    }
  }

  /**
   * Whether the bar may hide right now. Closing the gate brings a bar that is off back – on the
   * spring, or at once with `atOnce` (a sheet arriving over a bottom-docked bar: the recede is
   * already fading the bar, and a bar sliding in while it fades is a ghost) – and ignores the
   * scroll until it opens again.
   */
  setAllowed(allowed: boolean, atOnce = false): void {
    if (this.allowed === allowed) return
    this.allowed = allowed
    if (!allowed) {
      this.clearGap()
      if (this.offset > 0 || this.phase !== 'rest') {
        if (atOnce) this.reset()
        else this.snapTo(0)
      }
    }
  }

  /** Put the bar back on the spring (a tab switch, a load). */
  show(): void {
    if (this.offset === 0 && this.phase === 'rest') return
    this.clearGap()
    this.snapTo(0)
  }

  /** Put the bar back at once, without motion (the preview's reset, a layout change). */
  reset(): void {
    this.spring.stop()
    this.clearGap()
    this.scrolled = 0
    this.paintAt(0)
    this.setPhase('rest')
  }

  private start(): void {
    if (!this.allowed) return
    // A finger landing on a spring in flight takes over from where the bar is.
    this.spring.stop()
    this.clearGap()
    this.scrolled = 0
    this.tracker.reset()
    this.setPhase('dragging')
  }

  private move(delta: number, time: number): void {
    if (!this.allowed) return
    if (this.phase === 'rest' || this.phase === 'settling') {
      // The page scrolls with no finger on it (a fling, an in-page scroll): the bar rides along.
      this.spring.stop()
      this.scrolled = 0
      this.tracker.reset()
      this.setPhase('flinging')
    }
    this.scrolled += delta
    this.tracker.add(time, 0, this.scrolled)
    this.paintAt(stepOffset(this.offset, delta, this.travelPx))
    if (this.phase === 'flinging') this.armGap()
  }

  private end(time?: number): void {
    if (this.phase !== 'dragging') return
    const v = this.tracker.velocity(time).vy
    if (Math.abs(v) < BAR_HIDE_SETTLE_VELOCITY) {
      this.snapTo(snapTarget(this.offset, v, this.travelPx), v)
      return
    }
    // A fling: the page keeps scrolling and the bar with it; it settles when the scroll ends.
    this.setPhase('flinging')
    this.armGap()
  }

  /** The fling's scroll stopped: settle where the last of it was heading. */
  private gapClosed(): void {
    this.cancelGap = null
    if (this.phase !== 'flinging') return
    const v = this.tracker.velocity().vy
    this.snapTo(snapTarget(this.offset, v, this.travelPx), v)
  }

  private armGap(): void {
    this.clearGap()
    const later =
      this.options.later ??
      ((fn, ms) => {
        const id = setTimeout(fn, ms)
        return () => clearTimeout(id)
      })
    this.cancelGap = later(() => this.gapClosed(), BAR_HIDE_FLING_GAP_MS)
  }

  private clearGap(): void {
    this.cancelGap?.()
    this.cancelGap = null
  }

  private snapTo(target: number, velocity = 0): void {
    if (this.offset === target) {
      this.spring.stop()
      this.setPhase('rest')
      return
    }
    this.setPhase('settling')
    this.spring.start(this.offset, velocity, target)
  }

  private paintAt(x: number): void {
    const next = Math.min(this.travelPx, Math.max(0, x))
    if (next === this.offset) return
    this.offset = next
    this.options.paint(next)
  }

  private rested(x: number): void {
    this.paintAt(x)
    if (this.phase === 'settling') this.setPhase('rest')
  }

  private setPhase(phase: BarHidePhase): void {
    if (this.phase === phase) return
    this.phase = phase
    this.options.onChange(phase)
  }
}

// ---------------------------------------------------------------------------
// The chrome's instance
// ---------------------------------------------------------------------------

export interface BarHideState {
  /** 0 shown … 1 hidden, per frame (the root's `--zen-bar-hide`). */
  progress: number
  phase: BarHidePhase
  /** The edge the bar hides off (the phone bar's dock). */
  edge: PhoneBarPosition
  /** The band the page gains once the bar is hidden (CSS px). */
  travel: number
  /** Whether the bar may hide right now (the gate). */
  allowed: boolean
}

export const barHideStore = createStore<BarHideState>(
  { progress: 0, phase: 'rest', edge: 'bottom', travel: 50, allowed: false },
  'bar-hide'
)

/** What the host is told each frame: where to put the page's edge on the bar's side. */
export interface BarHideHostFrame {
  edge: PhoneBarPosition
  /** How far the bar is off (CSS px, 0 … `travel`). */
  offset: number
  travel: number
  /**
   * Window y (CSS px) of the page's edge on the bar's side with the bar fully shown – the
   * page's, not the bar's: chrome between the two (a translate bar, a banner, the blocked
   * pop-ups chip) is counted in.
   */
  shownEdge: number
}

/** The host that moves pages (Android's bridge); hosts without a phone bar set none. */
export interface BarHideHost {
  /** Per frame while anything moves, and once with `null` when the bar may not hide at all. */
  apply(frame: BarHideHostFrame | null): void
  /**
   * The bar moved by itself – not under the finger's scroll: a gate closing, another tab, a
   * load, a document committing, focus landing on the hidden pill, the host's own `show` – or
   * changed phase. For the host's record, so a bar found where a finger did not put it can be
   * read back to what put it there.
   */
  note?(reason: string): void
}

let host: BarHideHost | null = null
let lastHostFrame: string | null = null

export function setBarHideHost(next: BarHideHost | null): void {
  host = next
  lastHostFrame = null
  publishHost()
}

function note(reason: string): void {
  host?.note?.(reason)
}

/** A show that will move the bar (one with the bar home and at rest is nothing) is noted first. */
function showNoted(reason: string): void {
  if (machine.current > 0 || machine.state !== 'rest') note(`show: ${reason}`)
  machine.show()
}

/** What the shell knows: where the bar is docked and whether this layout has one at all. */
interface BarHideContext {
  edge: PhoneBarPosition
  /** The phone shell is up with its bar (not HTML fullscreen, not onboarding). */
  present: boolean
  /**
   * The bar band (`--zen-phone-band`: the row and, while the active tab is grouped, the tab
   * group strip) and the content gutter (`--zen-padding`, the theme's `chromeGutter`), CSS px.
   * Their difference is the travel; a bar off its edge keeps its ratio when either changes (the
   * strip entering or leaving under a hidden bar takes it off or brings it in with the row).
   */
  band: number
  gutter: number
}

const context: BarHideContext = { edge: 'bottom', present: false, band: 56, gutter: 6 }

function root(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement
}

/**
 * The page's frame as the layout reporter last measured it, read together with the column
 * layout it was measured in: `away` when the content column had taken the bar's band
 * (`PhoneShell`'s `barAway`). The reporter measures after the commit that laid the column out,
 * so the pair is consistent where it is taken and is never mixed across a frame here.
 */
let measured: { area: Rect; away: boolean } | null = null

function noteMeasured(): void {
  const area = contentAreaStore.get().area
  const ui = uiStore.get()
  measured = area ? { area, away: ui.barHidden && !ui.urlbar.open } : null
}

/**
 * Window y of the page's edge on the bar's side with the bar shown. Off the measured frame when
 * there is one – the edge it was measured at, plus the travel when the column had the band –
 * so chrome between the bar and the page (a translate bar, a banner, the blocked pop-ups chip)
 * is counted in: the host tells the two column layouts apart by which lies nearer this edge,
 * and read from the insets and the band alone a strip taller than half the travel would have
 * made the tall layout read as the short one and put the page a band into the strip. Without a
 * measurement (before the first report) the insets and the band stand in.
 */
function shownEdge(): number {
  const travel = barHideStore.get().travel
  if (measured) {
    const { area, away } = measured
    return context.edge === 'top'
      ? area.y + (away ? travel : 0)
      : area.y + area.height - (away ? travel : 0)
  }
  const insets = uiStore.get().insets
  return context.edge === 'top'
    ? insets.top + context.band
    : window.innerHeight - insets.bottom - context.band
}

function publishHost(): void {
  if (!host) return
  const state = barHideStore.get()
  const frame: BarHideHostFrame | null =
    state.allowed || state.progress > 0
      ? {
          edge: context.edge,
          offset: Math.round(machine.current * 100) / 100,
          travel: state.travel,
          shownEdge: shownEdge()
        }
      : null
  const key = JSON.stringify(frame)
  if (key === lastHostFrame) return
  lastHostFrame = key
  host.apply(frame)
}

const machine = new BarHideMachine(
  {
    paint: (offset) => {
      const travel = machine.travel
      const progress = travel > 0 ? Math.min(1, Math.max(0, offset / travel)) : 0
      const el = root()
      if (el) el.style.setProperty('--zen-bar-hide', progress.toFixed(4))
      barHideStore.set({ progress })
      publishHost()
      // Leaving the hidden rest: the content column takes its shown layout at once, so the page
      // comes back under a frame that is already there for it (a reset from the hidden rest
      // leaves the phase at rest, so this is the one place that sees it go).
      if (progress < 1 && uiStore.get().barHidden) publishHidden(false)
    },
    onChange: (phase) => {
      barHideStore.set({ phase })
      publishHidden(machine.hidden)
      publishHost()
      note(`${phase} at ${Math.round(machine.current * 100) / 100} of ${machine.travel}`)
    }
  },
  50
)

/** The boolean at rest, on the store and the root together (`uiStore.barHidden`, `data-bar-hidden`). */
function publishHidden(hidden: boolean): void {
  if (uiStore.get().barHidden !== hidden) uiStore.set({ barHidden: hidden })
  const el = root()
  if (!el) return
  if (hidden) el.dataset.barHidden = 'true'
  else delete el.dataset.barHidden
}

/** Host → chrome: one report of the active page's scroll. */
export function dispatchBarScroll(
  tabId: string,
  phase: BarScrollPhase,
  payload?: BarScrollPayload | null
): void {
  const state = browserStore.get().state
  // Only the page on screen moves the bar.
  if (state && activeTab(state)?.id !== tabId) return
  if (phase === 'show') note('show: the host (a fling reached the top)')
  machine.dispatch(phase, payload)
}

/**
 * The phone shell says where its bar is docked (and that it has one): the machine follows, and
 * a bar off its edge comes back when the layout changes under it.
 */
export function setBarHideContext(next: Partial<BarHideContext>): void {
  const edgeChanged = next.edge !== undefined && next.edge !== context.edge
  Object.assign(context, next)
  const travel = Math.max(1, context.band - context.gutter)
  machine.travel = travel
  if (barHideStore.get().travel !== travel || barHideStore.get().edge !== context.edge) {
    barHideStore.set({ travel, edge: context.edge })
  }
  if (edgeChanged) machine.reset()
  evaluateGate()
}

/** Bring the bar back (TalkBack focus landing on the hidden pill, a tap on its edge). */
export function showBar(): void {
  showNoted('asked by the host (focus on the hidden pill)')
}

/** Put the bar back at once and forget any motion (the preview's reset). */
export function resetBarHide(): void {
  machine.reset()
}

/** An accessibility service explores the screen by touch, as the host last said. */
let touchExploration = false

/**
 * Host → chrome: touch exploration (TalkBack) turned on or off
 * (`AccessibilityManager.isTouchExplorationEnabled` and its change listener, `Host.kt`; the
 * boot payload carries the state at start). On, the bar does not hide and comes back if it was
 * off its edge, as Chrome's controls stay while an accessibility service is on.
 */
export function setBarHideTouchExploration(enabled: boolean): void {
  if (touchExploration === enabled) return
  touchExploration = enabled
  evaluateGate()
}

/** The gate as the stores stand. */
export function currentGate(): BarHideGate {
  const state = browserStore.get().state
  const ui: UiState = uiStore.get()
  const tab = state ? activeTab(state) : null
  const url = tab?.url ?? ''
  return {
    enabled: Boolean(state?.settings.hideToolbarOnScroll) && context.present && tab !== null,
    internalPage: isEmptyTabUrl(url) || isInternalUrl(url),
    editing: ui.urlbar.open,
    covered: pageHidden(ui),
    panelDocked: ui.findOpen || ui.zoomTabId !== null,
    keyboardUp: ui.insets.bottom >= KEYBOARD_INSET_MIN,
    pulling: pullStore.get().phase !== 'idle',
    carrying: dockStore.get().phase !== 'idle',
    touchExploring: touchExploration
  }
}

/**
 * Host → chrome: a navigation committed on a tab's page. A new document (`inPage` false) starts
 * with its bar in place, as Chrome's does; a same-document navigation – `pushState`,
 * `replaceState`, a fragment – stays on the page and keeps the bar where it is (Chrome ignores
 * those too). The URL is not consulted at all: a page rewriting its own URL as it scrolls (a
 * scroll-spy, an infinite feed) is the very case that must not pop the bar back.
 */
export function dispatchBarNavigation(tabId: string, inPage: boolean): void {
  if (inPage) return
  const state = browserStore.get().state
  if (state && activeTab(state)?.id !== tabId) return
  showNoted('a document committed on the page')
}

/** The active tab (`id`) and whether it is loading, as of the last state seen. */
let lastTabId: string | null | undefined
let lastLoading = false

function evaluateGate(): void {
  const gate = currentGate()
  const allowed = barMayHide(gate)
  const changed = barHideStore.get().allowed !== allowed
  if (changed && !allowed && (machine.current > 0 || machine.state !== 'rest')) {
    const closed = (Object.keys(gate) as Array<keyof BarHideGate>).filter((k) =>
      k === 'enabled' ? !gate.enabled : gate[k]
    )
    note(`show: the gate closed (${closed.join(', ')})`)
  }
  // A sheet over a bottom-docked bar: the bar is back at once under the recede's fade (§11.1),
  // not slid in while fading. The top bar is not in the sheet's path and is not faded, so its
  // return is seen and rides the spring. The machine hears first, the store after: a subscriber
  // that scrolls the moment the store says the gate is open (the preview's `barhide` state)
  // finds the machine ready to take it.
  machine.setAllowed(allowed, !allowed && gate.covered && context.edge === 'bottom')
  if (changed) barHideStore.set({ allowed })
  // Another tab, or a load starting on this one (a link followed, a reload): the bar starts in
  // place. The document itself is keyed by the host's `navigated` event (`dispatchBarNavigation`),
  // not by the URL, so a same-document navigation leaves the bar alone.
  const state = browserStore.get().state
  const tab = state ? activeTab(state) : null
  const tabId = tab?.id ?? null
  const loading = Boolean(tab?.loading)
  if (lastTabId !== undefined && (tabId !== lastTabId || (loading && !lastLoading))) {
    showNoted(tabId !== lastTabId ? 'another tab' : 'a load began on the page')
  }
  lastTabId = tabId
  lastLoading = loading
  publishHost()
}

const flags = globalThis as unknown as { __zenBarHideWired?: boolean }
if (!flags.__zenBarHideWired) {
  flags.__zenBarHideWired = true
  uiStore.subscribe(evaluateGate)
  browserStore.subscribe(evaluateGate)
  pullStore.subscribe(evaluateGate)
  dockStore.subscribe(evaluateGate)
  // The page's frame moved or was measured anew (the reporter's `ResizeObserver`): the edge the
  // host lays out against follows, with the layout it was measured in.
  contentAreaStore.subscribe(() => {
    noteMeasured()
    publishHost()
  })
  if (typeof window !== 'undefined') window.addEventListener('resize', publishHost)
}
