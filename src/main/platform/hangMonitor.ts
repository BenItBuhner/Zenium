/**
 * Zenium's own hang monitor, for the pages Chromium's cannot speak for (tabs-45).
 *
 * Chromium reports a renderer that stopped answering (`WebContentsImpl::RendererUnresponsive`,
 * Electron's `unresponsive`) only for a WebContents with no DevTools client on it
 * (`ShouldIgnoreUnresponsiveRenderer`: a renderer at a breakpoint is no hang) – and
 * `webContents.debugger.attach()` is such a client. Zenium holds sessions on pages in front
 * (the dark theme for sites' override, an agent action in flight, an emulation hold), so the
 * "Page unresponsive" prompt never came for them. This monitor asks such a page for an answer
 * every few seconds with a bounded probe – a hung renderer never answers, so the race against
 * the timeout is the detector – and speaks the same two words Chromium's monitor does.
 *
 * Pure: the page, the eligibility and the words are injected, the clock too. One unexpired probe
 * at a time; a probe past its timeout is written off (a hung renderer never answers it), and an
 * answer that still comes late is the renderer moving again. The cadence is Chromium's: a hang
 * is reported once no probe has been answered for its hung-renderer delay (two misses), and
 * reported again after another delay while it lasts, as Chrome's dialog returns after Wait.
 * Once a hang is reported the page is asked on until it answers, on screen or not, so the mark
 * the core keeps never outlives the hang.
 */

/** How often a page that answers is asked. */
export const HANG_PING_MS = 3_000
/** How long a probe has to answer before it is written off as a miss. */
export const HANG_PROBE_TIMEOUT_MS = 7_500
/** Consecutive misses before a page counts as hung (two: 15 s of unanswered probes). */
export const HANG_MISSES = 2
/** Chromium's hung-renderer delay: no answer for this long is a hang, and a hang is said again after as long. */
export const HANG_DELAY_MS = 15_000

/** The clock the monitor runs on (the system's, or a test's). */
export interface HangClock {
  now(): number
  /** Run `fn` after `ms`; returns the way to call it off. */
  after(fn: () => void, ms: number): () => void
}

export const systemHangClock: HangClock = {
  now: () => Date.now(),
  after: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  }
}

export interface HangMonitorPage {
  /**
   * Ask the page for an answer: resolves when the renderer answered (with anything), rejects
   * when it could not be asked at all (no session, no frame) – which is no verdict either way.
   */
  probe(): Promise<unknown>
  /**
   * Whether a hang may be reported now: the page carries a DevTools session of Zenium's (with
   * none, Chromium's own monitor speaks) and nothing that pauses renderers at will (the toolbox).
   * Read at every ping and every miss; a page that stops being eligible restarts its count when
   * it is eligible again.
   */
  eligible(): boolean
  /** The word to the host: the renderer stopped answering (again, after a delay), or answers. */
  onHang(hung: boolean): void
}

interface Probe {
  /** Settled one way: answered, or written off at its timeout. */
  done: boolean
  /** The renderer it went to (`HangMonitor.renderer`): whatever comes back from one since gone is nothing. */
  renderer: number
  cancelTimeout: () => void
}

export class HangMonitor {
  /** The page is on screen in a focused window (`setActive`): the one time a hang matters. */
  private active = false
  private hung = false
  private misses = 0
  private lastAnswerAt: number
  private lastReportAt = 0
  private disposed = false
  /** Which renderer the probes go to, counted up as one goes (`reset`). */
  private renderer = 0
  /** The scheduled ping's cancel; null when none is due. */
  private cancelPing: (() => void) | null = null
  /** The unexpired probe in flight; null between probes. */
  private probe: Probe | null = null

  constructor(
    private readonly page: HangMonitorPage,
    private readonly clock: HangClock = systemHangClock
  ) {
    this.lastAnswerAt = clock.now()
  }

  /** Whether a hang stands reported. */
  get isHung(): boolean {
    return this.hung
  }

  /** Whether a probe is in flight or a ping due (the tests). */
  get isWatching(): boolean {
    return this.probe !== null || this.cancelPing !== null
  }

  /**
   * The page came on screen in a focused window, or left it: only such a page is watched for a
   * hang – Chromium reports none for a page that does not show, and the prompt belongs to the
   * window looking at the page. A hang already reported is watched to its end either way.
   */
  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return
    this.active = active
    if (active) {
      this.misses = 0
      this.lastAnswerAt = this.clock.now()
      if (!this.probe) this.schedule(HANG_PING_MS)
    } else if (!this.hung) {
      this.unschedule()
    }
  }

  /**
   * The renderer is gone (crashed, ended): no hang stands, nothing is said – the core drops its
   * mark with the renderer – and every probe sent to it, out or written off, is nothing now.
   * The watch goes on for the renderer to come (the page in front is reloaded into a new one).
   */
  reset(): void {
    if (this.disposed) return
    this.hung = false
    this.misses = 0
    this.lastAnswerAt = this.clock.now()
    this.renderer += 1
    this.writeOff()
    this.unschedule()
    if (this.active) this.schedule(HANG_PING_MS)
  }

  /** The page is gone: nothing more is asked or said. */
  dispose(): void {
    this.disposed = true
    this.unschedule()
    this.writeOff()
  }

  private writeOff(): void {
    const probe = this.probe
    if (!probe) return
    probe.done = true
    probe.cancelTimeout()
    this.probe = null
  }

  private schedule(ms: number): void {
    this.unschedule()
    if (!this.active && !this.hung) return
    this.cancelPing = this.clock.after(() => {
      this.cancelPing = null
      this.ping()
    }, ms)
  }

  private unschedule(): void {
    if (this.cancelPing) this.cancelPing()
    this.cancelPing = null
  }

  private ping(): void {
    if (this.disposed || this.probe || (!this.active && !this.hung)) return
    if (this.active && !this.page.eligible()) {
      // On screen with no session of ours, or under the toolbox: Chromium's monitor is on duty
      // (or nobody is, by Chrome's own rule). The count starts afresh when this one takes over.
      this.misses = 0
      this.lastAnswerAt = this.clock.now()
      if (!this.hung) {
        this.schedule(HANG_PING_MS)
        return
      }
    }
    this.send()
  }

  private send(): void {
    const probe: Probe = { done: false, renderer: this.renderer, cancelTimeout: () => undefined }
    this.probe = probe
    let asked: Promise<unknown>
    try {
      asked = this.page.probe()
    } catch (error) {
      asked = Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    probe.cancelTimeout = this.clock.after(() => this.missed(probe), HANG_PROBE_TIMEOUT_MS)
    asked.then(
      () => this.answered(probe),
      () => this.unanswerable(probe)
    )
  }

  /** The renderer answered – in time, or late after the probe was written off: it moves. */
  private answered(probe: Probe): void {
    if (this.disposed || probe.renderer !== this.renderer) return
    if (probe.done && this.probe !== null) {
      // A written-off probe answering while a newer one is out: the newer one's own answer, or
      // miss, carries the loop on – but the renderer did just move.
      this.misses = 0
      this.lastAnswerAt = this.clock.now()
      this.recovered()
      return
    }
    probe.done = true
    probe.cancelTimeout()
    if (this.probe === probe) this.probe = null
    this.misses = 0
    this.lastAnswerAt = this.clock.now()
    this.recovered()
    this.schedule(HANG_PING_MS)
  }

  private recovered(): void {
    if (!this.hung) return
    this.hung = false
    this.page.onHang(false)
  }

  /** The probe's timeout: written off; the next one goes out at once while the page is suspect. */
  private missed(probe: Probe): void {
    if (this.disposed || probe.done) return
    probe.done = true
    if (this.probe === probe) this.probe = null
    if (!this.active && !this.hung) return
    const now = this.clock.now()
    if (this.active && this.page.eligible()) {
      this.misses += 1
      if (this.misses >= HANG_MISSES && now - this.lastAnswerAt >= HANG_DELAY_MS) {
        if (!this.hung) {
          this.hung = true
          this.lastReportAt = now
          this.page.onHang(true)
        } else if (now - this.lastReportAt >= HANG_DELAY_MS) {
          this.lastReportAt = now
          this.page.onHang(true)
        }
      }
      this.ping()
      return
    }
    if (this.active) {
      // On screen but not this monitor's to judge at the moment (the session gone, the toolbox
      // open): the miss is nobody's, and the count starts afresh when it is on duty again.
      this.misses = 0
      this.lastAnswerAt = now
    }
    // Off screen with a hang reported, or not on duty: asked on at the idle pace.
    this.schedule(HANG_PING_MS)
  }

  /** The page could not be asked (no session, no frame): no verdict; asked again later. */
  private unanswerable(probe: Probe): void {
    if (this.disposed || probe.done) return
    probe.done = true
    probe.cancelTimeout()
    if (this.probe === probe) this.probe = null
    this.schedule(HANG_PING_MS)
  }
}
