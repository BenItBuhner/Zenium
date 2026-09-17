import { run } from './api'
import { rubberBand } from './gestures/swipe'
import { SPRING_GENTLE, SpringAnimation } from './motion/spring'
import { VelocityTracker } from './motion/velocity'
import { activeTab } from './selectors'
import { createStore } from './store'
import { browserStore } from './ui'

/**
 * Pull-to-refresh on touch hosts.
 *
 * The host owns the page WebView and its touches; it recognises a downward drag that begins with
 * the page at the top (see `PullGestureClassifier.kt`) and streams it here as `start`, `move`
 * (with the finger's raw travel in CSS px), then `release` or `cancel`. This module turns that
 * travel into one value – how far the page has come down off the top edge of the content frame,
 * with rubber-band resistance – paints it through {@link onPullFrame} for the chrome's indicator
 * and hands the same value back to the host, which moves the page by it. On release past the
 * threshold (or a fling) the tab reloads; the page waits at {@link PULL_REST} with the disc
 * spinning until the load is over, then everything springs back. Every motion is a spring on
 * {@link SPRING_GENTLE}, and a finger landing on a spring in flight takes over from where it is.
 */

export type PullPhase = 'idle' | 'pulling' | 'settling' | 'refreshing' | 'finishing'

/** What the host reports: which touch phase, and the finger's travel since the pull began. */
export type PullEventPhase = 'start' | 'move' | 'release' | 'cancel'

export interface PullEventPayload {
  /** Finger travel since the pull began, CSS px, positive downwards. */
  travel: number
  /** Timestamp of the touch sample, ms on any monotonic clock (velocity needs the deltas). */
  time: number
}

export interface PullState {
  /** Tab whose page is being pulled (null while idle). */
  tabId: string | null
  phase: PullPhase
  /** Letting go now would refresh: the pull is past the threshold. */
  armed: boolean
}

/** Resisted travel (CSS px) at which a release refreshes; the indicator's progress is 1 here. */
export const PULL_THRESHOLD = 72
/** The page never comes down further than this, however far the finger goes. */
export const PULL_EXTENT = 180
/** Where the page waits while the reload runs: the 40 px disc with 8 px above and below it. */
export const PULL_REST = 56
/** A finger this fast (px/s) refreshes from half the threshold on. */
export const PULL_FLING_VELOCITY = 1600
/** A fling refreshes only once the disc has come this far out (a fraction of the threshold). */
export const PULL_FLING_MIN = 0.5
/** The spinner stays at least this long, even for a page that reloads from cache in a blink. */
const MIN_SPIN_MS = 450
/** A reload that has not started loading after this long is treated as done (nothing to wait for). */
const LOADING_GRACE_MS = 1500
/** No page is allowed to keep the spinner up longer than this. */
const MAX_SPIN_MS = 20_000

// ---------------------------------------------------------------------------
// The mapping – pure, so it can be tested and reasoned about
// ---------------------------------------------------------------------------

/**
 * How far the page has come down for a finger that travelled `travel` px: one to one at first,
 * then with diminishing returns towards {@link PULL_EXTENT}. 120 px of finger reach the
 * threshold, about what Chrome asks for.
 */
export function pullOffset(travel: number): number {
  return rubberBand(Math.max(0, travel), PULL_EXTENT, 1)
}

/** The finger travel that would put the page at `offset` – the inverse of {@link pullOffset}. */
export function pullTravelFor(offset: number): number {
  const o = Math.min(Math.max(0, offset), PULL_EXTENT - 1e-6)
  return (o * PULL_EXTENT) / (PULL_EXTENT - o)
}

/** 0 at rest, 1 at the threshold, up to `PULL_EXTENT / PULL_THRESHOLD` at the very end. */
export function pullProgress(offset: number): number {
  return Math.max(0, offset) / PULL_THRESHOLD
}

/**
 * Whether letting go with the page at `offset` and the finger moving at `velocity` px/s (positive
 * downwards) refreshes: past the threshold, or flung down once the disc is clearly out.
 */
export function releaseRefreshes(offset: number, velocity: number): boolean {
  if (offset >= PULL_THRESHOLD) return true
  return velocity >= PULL_FLING_VELOCITY && offset >= PULL_THRESHOLD * PULL_FLING_MIN
}

/** The rate at which the page moves per px of finger at `travel` (the slope of the rubber band). */
function pullRate(travel: number): number {
  const d = PULL_EXTENT / (Math.max(0, travel) + PULL_EXTENT)
  return d * d
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

export interface PullMachineOptions {
  /** Reload the tab (the release was past the threshold). */
  refresh(tabId: string): void
  /** The page and the indicator are `offset` px down; runs every frame while anything moves. */
  paint(tabId: string, offset: number): void
  /** The phase or the armed flag changed. */
  onChange(state: PullState): void
  /** Whether the tab is loading right now; null once the tab is gone. */
  isLoading(tabId: string): boolean | null
}

export class PullMachine {
  private tabId: string | null = null
  private phase: PullPhase = 'idle'
  private armed = false
  private offset = 0
  /** Finger travel the current pull started from, so a caught spring continues seamlessly. */
  private bias = 0
  private lastTravel = 0
  private readonly tracker = new VelocityTracker()
  private readonly spring: SpringAnimation
  private refreshedAt = 0
  private sawLoading = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: PullMachineOptions) {
    this.spring = new SpringAnimation(
      SPRING_GENTLE,
      (x) => this.paint(x),
      (x) => this.rested(x)
    )
  }

  get state(): PullState {
    return { tabId: this.tabId, phase: this.phase, armed: this.armed }
  }

  /** Where the page is right now (CSS px down from the frame's top edge). */
  get current(): number {
    return this.offset
  }

  /** Host → machine. */
  dispatch(tabId: string, phase: PullEventPhase, payload?: PullEventPayload | null): void {
    switch (phase) {
      case 'start':
        this.start(tabId)
        return
      case 'move':
        if (this.tabId !== tabId || this.phase !== 'pulling') return
        this.move(payload?.travel ?? 0, payload?.time ?? 0)
        return
      case 'release':
        if (this.tabId !== tabId || this.phase !== 'pulling') return
        this.release(payload?.time)
        return
      case 'cancel':
        if (this.tabId !== tabId || this.phase !== 'pulling') return
        this.retract(this.velocity(payload?.time))
        return
    }
  }

  /** The tab went away or another one is showing: put the page back at once and forget the pull. */
  abort(): void {
    if (this.phase === 'idle') return
    this.spring.stop()
    this.clearTimer()
    const tabId = this.tabId
    this.offset = 0
    this.bias = 0
    if (tabId) this.options.paint(tabId, 0)
    this.setPhase('idle', false)
    this.tabId = null
  }

  /** Something about the tabs changed: while a reload runs, watch it finish. */
  poll(): void {
    if (this.phase !== 'refreshing' || !this.tabId) return
    const loading = this.options.isLoading(this.tabId)
    if (loading === null) {
      this.finish()
      return
    }
    if (loading) this.sawLoading = true
    const elapsed = performance.now() - this.refreshedAt
    if (elapsed >= MAX_SPIN_MS) {
      this.finish()
      return
    }
    if (!this.sawLoading && elapsed >= LOADING_GRACE_MS) {
      this.finish()
      return
    }
    if (this.sawLoading && !loading) {
      if (elapsed >= MIN_SPIN_MS) this.finish()
      else this.pollIn(MIN_SPIN_MS - elapsed)
      return
    }
    this.pollIn((this.sawLoading ? MAX_SPIN_MS : LOADING_GRACE_MS) - elapsed)
  }

  private start(tabId: string): void {
    if (this.tabId && this.tabId !== tabId) this.abort()
    const caught = this.phase !== 'idle'
    this.spring.stop()
    this.clearTimer()
    this.tabId = tabId
    // A finger landing on a spring in flight carries on from where the page is.
    this.bias = caught ? pullTravelFor(this.offset) : 0
    this.lastTravel = 0
    this.tracker.reset()
    if (!caught) this.offset = 0
    this.setPhase('pulling', releaseRefreshes(this.offset, 0))
    if (!caught) this.options.paint(tabId, 0)
  }

  private move(travel: number, time: number): void {
    this.lastTravel = travel
    this.tracker.add(time, 0, travel)
    this.offset = pullOffset(this.bias + travel)
    this.setPhase('pulling', releaseRefreshes(this.offset, 0))
    if (this.tabId) this.options.paint(this.tabId, this.offset)
  }

  private release(time?: number): void {
    // The decision is about the finger (a tug is a tug however far out the disc is); the spring
    // that follows starts from the page's own, resisted speed so nothing jumps.
    const finger = this.tracker.velocity(time).vy
    const v = this.pageVelocity(finger)
    if (releaseRefreshes(this.offset, finger)) this.commit(v)
    else this.retract(v)
  }

  /** The finger's velocity, translated into the page's resisted motion (px/s, down positive). */
  private velocity(time?: number): number {
    return this.pageVelocity(this.tracker.velocity(time).vy)
  }

  private pageVelocity(finger: number): number {
    return finger * pullRate(this.bias + this.lastTravel)
  }

  private commit(velocity: number): void {
    const tabId = this.tabId
    if (!tabId) return
    this.setPhase('refreshing', true)
    this.refreshedAt = performance.now()
    this.sawLoading = false
    this.options.refresh(tabId)
    this.spring.start(this.offset, velocity, PULL_REST)
    this.poll()
  }

  private retract(velocity: number): void {
    this.setPhase('settling', false)
    this.spring.start(this.offset, Math.min(0, velocity), 0)
  }

  private finish(): void {
    this.clearTimer()
    if (this.phase !== 'refreshing') return
    this.setPhase('finishing', false)
    this.spring.start(this.offset, 0, 0)
  }

  private paint(x: number): void {
    this.offset = Math.max(0, x)
    if (this.tabId) this.options.paint(this.tabId, this.offset)
  }

  private rested(x: number): void {
    this.paint(x)
    if (this.phase === 'settling' || this.phase === 'finishing') {
      this.setPhase('idle', false)
      this.tabId = null
      this.bias = 0
    }
  }

  private setPhase(phase: PullPhase, armed: boolean): void {
    if (this.phase === phase && this.armed === armed) return
    this.phase = phase
    this.armed = armed
    this.options.onChange(this.state)
  }

  private pollIn(ms: number): void {
    this.clearTimer()
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.poll()
      },
      Math.max(16, ms)
    )
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}

// ---------------------------------------------------------------------------
// The chrome's instance
// ---------------------------------------------------------------------------

export const pullStore = createStore<PullState>(
  { tabId: null, phase: 'idle', armed: false },
  'pull'
)

/** What the host does with the value: move the tab's page down by `offset` CSS px. */
export interface PullHost {
  setOffset(tabId: string, offset: number): void
}

type FrameListener = (offset: number, tabId: string) => void
const frameListeners = new Set<FrameListener>()
let host: PullHost | null = null
let lastPainted = 0

/**
 * Per-frame offset for the indicator (write DOM styles through refs; this runs every frame while
 * the page moves). The listener is called once with the current value when it subscribes.
 */
export function onPullFrame(listener: FrameListener): () => void {
  frameListeners.add(listener)
  const tabId = pullStore.get().tabId
  if (tabId) listener(lastPainted, tabId)
  return () => {
    frameListeners.delete(listener)
  }
}

/** The host that moves pages (Android's bridge); hosts without pull-to-refresh set none. */
export function setPullHost(next: PullHost | null): void {
  host = next
}

const machine = new PullMachine({
  refresh: (tabId) => run('tab.reload', { tabId }),
  paint: (tabId, offset) => {
    lastPainted = offset
    host?.setOffset(tabId, offset)
    for (const listener of frameListeners) listener(offset, tabId)
  },
  onChange: (state) => pullStore.set(state),
  isLoading: (tabId) => {
    const tab = browserStore.get().state?.tabs[tabId]
    return tab ? tab.loading : null
  }
})

/** Host → chrome: one touch phase of a pull on the tab's page. */
export function dispatchPullEvent(
  tabId: string,
  phase: PullEventPhase,
  payload?: PullEventPayload | null
): void {
  machine.dispatch(tabId, phase, payload)
}

const flags = globalThis as unknown as { __zenPullWired?: boolean }
if (!flags.__zenPullWired) {
  flags.__zenPullWired = true
  let wasArmed = false
  pullStore.subscribe(() => {
    const { armed, phase } = pullStore.get()
    // Crossing the threshold is a landmark: one tick, on the way out only.
    if (armed && !wasArmed && phase === 'pulling') run('haptic', { kind: 'tick' })
    wasArmed = armed
  })
  browserStore.subscribe(() => {
    const { tabId, phase } = pullStore.get()
    if (phase === 'idle' || !tabId) return
    const state = browserStore.get().state
    // The page being pulled must still be the one on screen.
    if (!state || activeTab(state)?.id !== tabId) {
      machine.abort()
      return
    }
    machine.poll()
  })
}
