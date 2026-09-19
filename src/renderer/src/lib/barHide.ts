import type { PhoneBarPosition } from '@shared/types'
import { isEmptyTabUrl, isInternalUrl } from '@shared/url'
import { dockStore } from './gestures/dock'
import { SPRING_SNAPPY, SpringAnimation } from './motion/spring'
import { VelocityTracker } from './motion/velocity'
import { pullStore } from './pull'
import { activeTab } from './selectors'
import { createStore } from './store'
import { browserStore, pageHidden, uiStore, type UiState } from './ui'

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
 * carried, and with the setting off. A gate closing on a hidden bar brings it back on the spring.
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
/** A fling has ended when the page has not scrolled for this long. */
export const BAR_HIDE_FLING_GAP_MS = 96
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
    !gate.carrying
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
   * Whether the bar may hide right now. Closing the gate brings a bar that is off back on the
   * spring and ignores the scroll until it opens again.
   */
  setAllowed(allowed: boolean): void {
    if (this.allowed === allowed) return
    this.allowed = allowed
    if (!allowed) {
      this.clearGap()
      if (this.offset > 0 || this.phase !== 'rest') this.snapTo(0)
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
  { progress: 0, phase: 'rest', edge: 'bottom', travel: 48, allowed: false },
  'bar-hide'
)

/** What the host is told each frame: where to put the page's edge on the bar's side. */
export interface BarHideHostFrame {
  edge: PhoneBarPosition
  /** How far the bar is off (CSS px, 0 … `travel`). */
  offset: number
  travel: number
  /** Window y (CSS px) of the page's edge on the bar's side with the bar fully shown. */
  shownEdge: number
}

/** The host that moves pages (Android's bridge); hosts without a phone bar set none. */
export interface BarHideHost {
  /** Per frame while anything moves, and once with `null` when the bar may not hide at all. */
  apply(frame: BarHideHostFrame | null): void
}

let host: BarHideHost | null = null
let lastHostFrame: string | null = null

export function setBarHideHost(next: BarHideHost | null): void {
  host = next
  lastHostFrame = null
  publishHost()
}

/** What the shell knows: where the bar is docked and whether this layout has one at all. */
interface BarHideContext {
  edge: PhoneBarPosition
  /** The phone shell is up with its bar (not HTML fullscreen, not onboarding). */
  present: boolean
  /** The bar band (`--zen-phone-bar`) and the content gutter (`--zen-padding`), CSS px. */
  band: number
  gutter: number
}

const context: BarHideContext = { edge: 'bottom', present: false, band: 56, gutter: 8 }

function root(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement
}

/** Window y of the page's edge on the bar's side with the bar shown, from the shell's insets. */
function shownEdge(): number {
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
      // comes back under a frame that is already there for it.
      if (progress < 1 && uiStore.get().barHidden) uiStore.set({ barHidden: false })
    },
    onChange: (phase) => {
      barHideStore.set({ phase })
      const hidden = machine.hidden
      if (uiStore.get().barHidden !== hidden) uiStore.set({ barHidden: hidden })
      const el = root()
      if (el) {
        if (hidden) el.dataset.barHidden = 'true'
        else delete el.dataset.barHidden
      }
      publishHost()
    }
  },
  48
)

/** Host → chrome: one report of the active page's scroll. */
export function dispatchBarScroll(
  tabId: string,
  phase: BarScrollPhase,
  payload?: BarScrollPayload | null
): void {
  const state = browserStore.get().state
  // Only the page on screen moves the bar.
  if (state && activeTab(state)?.id !== tabId) return
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
  machine.show()
}

/** Put the bar back at once and forget any motion (the preview's reset). */
export function resetBarHide(): void {
  machine.reset()
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
    carrying: dockStore.get().phase !== 'idle'
  }
}

/** The active tab and its document (`id`, URL without the fragment) and whether it is loading. */
let lastPage: string | null | undefined
let lastLoading = false

function evaluateGate(): void {
  const allowed = barMayHide(currentGate())
  if (barHideStore.get().allowed !== allowed) barHideStore.set({ allowed })
  machine.setAllowed(allowed)
  // Another tab, another document or a reload starting: the bar starts in place, as Chrome's
  // does. A fragment navigation stays on the page and keeps the bar where it is.
  const state = browserStore.get().state
  const tab = state ? activeTab(state) : null
  const page = tab ? `${tab.id}\n${tab.url.split('#')[0]}` : null
  const loading = Boolean(tab?.loading)
  if (lastPage !== undefined && (page !== lastPage || (loading && !lastLoading))) machine.show()
  lastPage = page
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
  if (typeof window !== 'undefined') window.addEventListener('resize', publishHost)
}
