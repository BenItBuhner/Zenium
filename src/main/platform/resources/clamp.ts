import type { WebContents } from 'electron'
import type { TabLifecycle } from './lifecycle'

/** What the clamp reads of a page view (`ElectronTabView`; the tests use a stand-in). */
export interface ClampedView {
  readonly webContents: WebContents
  /** Shown by the chrome's layout: in front in its window (a split's pane, a glance included). */
  isVisible(): boolean
  isDestroyed(): boolean
}

/**
 * Flips within this window are one decision: a page hidden and shown by the same layout pass
 * (`refreshVisibility`'s false-then-true, a new tab born hidden and placed a frame later) or a tab
 * cycled past costs no session. Short against the ~15 s Chromium's hang monitor takes.
 */
export const CLAMP_SETTLE_MS = 150
/** A burst of flips is decided at the latest this long after its first one. */
const CLAMP_SETTLE_MAX_MS = 4 * CLAMP_SETTLE_MS
/**
 * A shown page still frozen or throttled has its wake in flight (`wakeVisible` runs at the
 * activation, the layout shows the page a frame later): clearing the clamp then would recycle the
 * session under the thaw. Decided again after this long, so many times at most.
 */
const CLAMP_RETRY_MS = 250
const CLAMP_RETRIES = 8

/**
 * The resource governor's CPU clamp – `navigator.hardwareConcurrency` capped at the CPU budget's
 * share of the cores (`Emulation.setHardwareConcurrencyOverride`) – on BACKGROUND pages only.
 *
 * The override rides a DevTools session on the page, and Chromium drops the hang monitor's report
 * for a WebContents with a DevTools client attached (`WebContentsImpl::RendererUnresponsive` →
 * `ShouldIgnoreUnresponsiveRenderer`: a renderer on a breakpoint is not hung) – so a page in front
 * with the clamp on it never raised Electron's `unresponsive`, and the "Page unresponsive" prompt
 * never came in a default install (the CPU limit's default is 50 %). Chromium also drops the
 * report for a page that is not showing, so the clamp sits exactly where Chromium would not
 * report anyway: a hidden page carries it, a page in front in any window – both panes of a split
 * – carries no session of the governor's and keeps its hang monitor and its full core count.
 *
 * Decisions are taken from the page's visibility as the chrome lays it out (`setVisible`), a
 * settle later so a burst of flips is one decision, and applied through the lifecycle's shared
 * session bookkeeping (`setHardwareConcurrency`; `null` detaches when nothing else of the
 * governor's is on the page).
 */
export class ConcurrencyClamp {
  private readonly pending = new Set<ClampedView>()
  private timer: NodeJS.Timeout | null = null
  private pendingSince = 0
  private readonly retries = new WeakMap<ClampedView, number>()
  private flushing: Promise<void> | null = null

  constructor(
    private readonly lifecycle: TabLifecycle,
    /** The cores a background page is to report; null while there is no clamp (the limit at 100 %, the governor off). */
    private readonly override: () => number | null,
    private readonly settleMs = CLAMP_SETTLE_MS
  ) {}

  /** What a page should carry right now: the clamp when hidden and one is set, nothing otherwise. */
  wanted(view: ClampedView): number | null {
    const cores = this.override()
    return cores !== null && !view.isVisible() ? cores : null
  }

  /** The page was shown or hidden, born, lost its session, or the budget changed: decide again soon. */
  touch(view: ClampedView, delay = this.settleMs): void {
    if (view.isDestroyed()) return
    const now = Date.now()
    if (this.pending.size === 0) this.pendingSince = now
    this.pending.add(view)
    const latest = Math.max(0, this.pendingSince + CLAMP_SETTLE_MAX_MS - now)
    const wait = Math.min(delay, latest)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), wait)
  }

  touchAll(views: Iterable<ClampedView>): void {
    for (const view of views) this.touch(view)
  }

  /** The page is gone: nothing to decide for it. */
  forget(view: ClampedView): void {
    this.pending.delete(view)
    this.retries.delete(view)
  }

  /** Decisions still waiting (the tests). */
  get pendingCount(): number {
    return this.pending.size
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
  }

  /** Apply every pending decision now. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const views = [...this.pending]
    this.pending.clear()
    this.flushing = Promise.all(views.map((view) => this.apply(view)))
      .then(() => undefined)
      .finally(() => {
        this.flushing = null
      })
    return this.flushing
  }

  private async apply(view: ClampedView): Promise<void> {
    if (view.isDestroyed()) return
    const wc = view.webContents
    if (wc.isDestroyed()) return
    const wanted = this.wanted(view)
    if (
      wanted === null &&
      this.lifecycle.hardwareConcurrency(wc) !== null &&
      (this.lifecycle.isFrozen(wc) || this.lifecycle.cpuThrottle(wc) !== 1)
    ) {
      // The wake is in flight (see CLAMP_RETRY_MS); a page that stays frozen or throttled in
      // front – nothing does that for long – has the clamp cleared through a recycle at the end.
      const n = this.retries.get(view) ?? 0
      if (n < CLAMP_RETRIES) {
        this.retries.set(view, n + 1)
        this.touch(view, CLAMP_RETRY_MS)
        return
      }
    }
    this.retries.delete(view)
    try {
      await this.lifecycle.setHardwareConcurrency(wc, wanted)
    } catch (error) {
      console.warn('[zen] resource governor could not set a page’s CPU clamp:', error)
    }
    // The page flipped while the override was on its way (a hung renderer answers late, if at
    // all): what stands is decided on what shows now.
    if (!view.isDestroyed() && !wc.isDestroyed() && this.wanted(view) !== wanted) this.touch(view)
  }
}
