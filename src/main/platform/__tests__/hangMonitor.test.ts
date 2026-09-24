import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HANG_DELAY_MS,
  HANG_MISSES,
  HANG_PING_MS,
  HANG_PROBE_TIMEOUT_MS,
  HangMonitor,
  type HangMonitorPage
} from '../hangMonitor'

/** A page as the monitor asks it: every probe kept open until the test answers or refuses it. */
class FakePage implements HangMonitorPage {
  eligibleNow = true
  readonly probes: Array<{ at: number; answer: () => void; refuse: () => void }> = []
  /** Every word said, with the time it was said at. */
  readonly words: Array<[boolean, number]> = []

  probe(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.probes.push({
        at: Date.now(),
        answer: () => resolve(1),
        refuse: () => reject(new Error('Debugger is not attached'))
      })
    })
  }

  eligible(): boolean {
    return this.eligibleNow
  }

  onHang(hung: boolean): void {
    this.words.push([hung, Date.now()])
  }

  /** Answer every probe still open. */
  answerAll(): void {
    for (const probe of this.probes) probe.answer()
  }
}

const SECOND = 1_000
/** When the second miss lands for a page that never answers: the first ping, then two timeouts. */
const HUNG_AT = HANG_PING_MS + HANG_MISSES * HANG_PROBE_TIMEOUT_MS

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

/**
 * Zenium's hang monitor for pages Chromium's cannot speak for (a DevTools session on the page):
 * a bounded probe every few seconds, two misses → `unresponsive`, the next answer → `responsive`.
 */
describe('HangMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('the constants are Chromium’s: two misses make its hung-renderer delay', () => {
    expect(HANG_MISSES * HANG_PROBE_TIMEOUT_MS).toBe(HANG_DELAY_MS)
    expect(HANG_PING_MS).toBeLessThan(HANG_PROBE_TIMEOUT_MS)
  })

  it('two misses → unresponsive, at Chromium’s delay after the first probe, one unexpired probe at a time', async () => {
    const page = new FakePage()
    const monitor = new HangMonitor(page)
    monitor.setActive(true)
    expect(page.probes).toHaveLength(0)
    await advance(HANG_PING_MS)
    expect(page.probes).toHaveLength(1)
    // The probe is out for its whole timeout: no second one rides along at the ping pace.
    await advance(HANG_PROBE_TIMEOUT_MS - SECOND)
    expect(page.probes).toHaveLength(1)
    expect(page.words).toEqual([])
    // Written off: the next probe goes out at once, the page being suspect.
    await advance(SECOND)
    expect(page.probes).toHaveLength(2)
    expect(page.words).toEqual([])
    await advance(HANG_PROBE_TIMEOUT_MS)
    expect(Date.now()).toBe(HUNG_AT)
    expect(page.words).toEqual([[true, HUNG_AT]])
    expect(monitor.isHung).toBe(true)
    expect(HUNG_AT - HANG_PING_MS).toBeGreaterThanOrEqual(HANG_DELAY_MS)
    monitor.dispose()
  })

  it('an answer → responsive, and the pings resume at the idle pace', async () => {
    const page = new FakePage()
    const monitor = new HangMonitor(page)
    monitor.setActive(true)
    await advance(HUNG_AT)
    expect(page.words).toEqual([[true, HUNG_AT]])
    const outstanding = page.probes.length
    // The probe sent at the second miss is answered a moment later.
    page.probes[outstanding - 1]!.answer()
    await advance(0)
    expect(page.words).toEqual([
      [true, HUNG_AT],
      [false, HUNG_AT]
    ])
    expect(monitor.isHung).toBe(false)
    // Back to a ping every HANG_PING_MS, each answered.
    await advance(HANG_PING_MS)
    expect(page.probes).toHaveLength(outstanding + 1)
    page.answerAll()
    await advance(HANG_PING_MS)
    expect(page.probes).toHaveLength(outstanding + 2)
    expect(page.words).toHaveLength(2)
    monitor.dispose()
  })

  it('a page that answers is never reported, and a timeout after its answer is not a miss', async () => {
    const page = new FakePage()
    const monitor = new HangMonitor(page)
    monitor.setActive(true)
    for (let i = 0; i < 20; i++) {
      await advance(HANG_PING_MS)
      // Answered just inside the timeout: the timeout that would have followed is called off.
      await advance(HANG_PROBE_TIMEOUT_MS - SECOND)
      page.answerAll()
      await advance(0)
    }
    expect(page.words).toEqual([])
    expect(monitor.isHung).toBe(false)
    monitor.dispose()
  })

  it('no pings while the page is hidden or its window unfocused (inactive)', async () => {
    const page = new FakePage()
    const monitor = new HangMonitor(page)
    await advance(60 * SECOND)
    expect(page.probes).toHaveLength(0)
    monitor.setActive(true)
    await advance(HANG_PING_MS)
    expect(page.probes).toHaveLength(1)
    page.answerAll()
    await advance(0)
    // Hidden again before the next ping: nothing more is asked.
    monitor.setActive(false)
    expect(monitor.isWatching).toBe(false)
    await advance(60 * SECOND)
    expect(page.probes).toHaveLength(1)
    expect(page.words).toEqual([])
    monitor.dispose()
  })

  it('no pings while the page is not eligible (no session of ours, the toolbox open); the count starts afresh when it is', async () => {
    const page = new FakePage()
    page.eligibleNow = false
    const monitor = new HangMonitor(page)
    monitor.setActive(true)
    await advance(60 * SECOND)
    expect(page.probes).toHaveLength(0)
    // A session attached: the next look sends the first probe; the page never answers.
    page.eligibleNow = true
    await advance(HANG_PING_MS)
    expect(page.probes).toHaveLength(1)
    const since = Date.now()
    await advance(HANG_MISSES * HANG_PROBE_TIMEOUT_MS)
    expect(page.words).toEqual([[true, since + HANG_MISSES * HANG_PROBE_TIMEOUT_MS]])
    monitor.dispose()
  })

  it('eligibility lost between the misses (the session went) drops the count: Chromium’s monitor is on duty', async () => {
    const page = new FakePage()
    const monitor = new HangMonitor(page)
    monitor.setActive(true)
    await advance(HANG_PING_MS + HANG_PROBE_TIMEOUT_MS)
    expect(page.probes).toHaveLength(2)
    page.eligibleNow = false
    await advance(HANG_PROBE_TIMEOUT_MS)
    expect(page.words).toEqual([])
    // Not asked while the session is away.
    await advance(60 * SECOND)
    expect(page.probes).toHaveLength(2)
    // Back: a fresh count, reported only after a full delay again.
    page.eligibleNow = true
    const back = Date.now()
    await advance(HUNG_AT - SECOND)
    expect(page.words).toEqual([])
    await advance(SECOND)
    expect(page.words).toEqual([[true, back + HUNG_AT]])
    monitor.dispose()
  })

  it('a probe answering late, after it was written off, is the renderer moving: not a miss, and it postpones the report', async () => {
    const page = new FakePage()
    const monitor = new HangMonitor(page)
    monitor.setActive(true)
    await advance(HANG_PING_MS + HANG_PROBE_TIMEOUT_MS)
    // The first probe was written off (one miss) and the second is out; the first answers now.
    expect(page.probes).toHaveLength(2)
    page.probes[0]!.answer()
    await advance(0)
    const answeredAt = Date.now()
    // The second probe's miss is the first of a new count: nothing at what would have been the
    // second miss of the old one …
    await advance(HANG_PROBE_TIMEOUT_MS)
    expect(page.words).toEqual([])
    expect(Date.now() - answeredAt).toBeLessThan(HANG_DELAY_MS)
    // … and the report comes with the second miss of the new count, a full delay after the
    // late answer.
    await advance(HANG_PROBE_TIMEOUT_MS)
    expect(page.words).toEqual([[true, Date.now()]])
    expect(Date.now() - answeredAt).toBe(HANG_DELAY_MS)
    monitor.dispose()
  })

  it('a probe answering late while a hang stands reported is the answer: responsive', async () => {
    const page = new FakePage()
    const monitor = new HangMonitor(page)
    monitor.setActive(true)
    await advance(HUNG_AT + SECOND)
    expect(page.words).toEqual([[true, HUNG_AT]])
    // The very first probe, long written off, answers: the renderer runs its backlog.
    page.probes[0]!.answer()
    await advance(0)
    expect(page.words).toEqual([
      [true, HUNG_AT],
      [false, HUNG_AT + SECOND]
    ])
    monitor.dispose()
  })

  it('a hang that lasts is reported again after another delay, as Chrome’s dialog returns after Wait', async () => {
    const page = new FakePage()
    const monitor = new HangMonitor(page)
    monitor.setActive(true)
    await advance(HUNG_AT)
    expect(page.words).toEqual([[true, HUNG_AT]])
    await advance(HANG_DELAY_MS - SECOND)
    expect(page.words).toHaveLength(1)
    await advance(HANG_PROBE_TIMEOUT_MS)
    expect(page.words).toHaveLength(2)
    expect(page.words[1]![1] - page.words[0]![1]).toBeGreaterThanOrEqual(HANG_DELAY_MS)
    monitor.dispose()
  })

  it('a hang reported is watched to its end when the page leaves the screen: the mark never outlives the hang', async () => {
    const page = new FakePage()
    const monitor = new HangMonitor(page)
    monitor.setActive(true)
    await advance(HUNG_AT)
    expect(page.words).toEqual([[true, HUNG_AT]])
    monitor.setActive(false)
    expect(monitor.isWatching).toBe(true)
    const before = page.probes.length
    // Asked on at the idle pace, but never reported again while hidden.
    await advance(4 * HANG_DELAY_MS)
    expect(page.probes.length).toBeGreaterThan(before)
    expect(page.words).toHaveLength(1)
    page.answerAll()
    await advance(0)
    expect(page.words).toEqual([
      [true, HUNG_AT],
      [false, Date.now()]
    ])
    // Answered and off screen: the watch ends.
    await advance(60 * SECOND)
    expect(monitor.isWatching).toBe(false)
    monitor.dispose()
  })

  it('a hang reported is watched to its end when the session goes too (the probe then rides the frame)', async () => {
    const page = new FakePage()
    const monitor = new HangMonitor(page)
    monitor.setActive(true)
    await advance(HUNG_AT)
    page.eligibleNow = false
    const before = page.probes.length
    await advance(2 * HANG_DELAY_MS)
    expect(page.probes.length).toBeGreaterThan(before)
    expect(page.words).toHaveLength(1)
    page.answerAll()
    await advance(0)
    expect(page.words[1]).toEqual([false, Date.now()])
    monitor.dispose()
  })

  it('reset (the renderer gone) drops the hang without a word, and the stale probe’s outcome counts for nothing', async () => {
    const page = new FakePage()
    const monitor = new HangMonitor(page)
    monitor.setActive(true)
    await advance(HUNG_AT + SECOND)
    expect(monitor.isHung).toBe(true)
    const stale = page.probes.length
    monitor.reset()
    expect(monitor.isHung).toBe(false)
    expect(page.words).toHaveLength(1)
    // The stale probe's timeout passes: no miss counted; the new renderer is asked afresh.
    await advance(HANG_PROBE_TIMEOUT_MS)
    expect(page.words).toHaveLength(1)
    expect(page.probes.length).toBe(stale + 1)
    // The stale probe answering is no word either …
    page.probes[stale - 1]!.answer()
    await advance(0)
    expect(page.words).toHaveLength(1)
    // … and the new count needs a full delay of misses.
    await advance(HANG_PROBE_TIMEOUT_MS)
    expect(page.words).toHaveLength(1)
    await advance(HANG_PROBE_TIMEOUT_MS)
    expect(page.words).toHaveLength(2)
    monitor.dispose()
  })

  it('a probe that cannot be asked (rejects) is no verdict: nothing counted, asked again later', async () => {
    const page = new FakePage()
    const monitor = new HangMonitor(page)
    monitor.setActive(true)
    await advance(HANG_PING_MS)
    page.probes[0]!.refuse()
    await advance(0)
    expect(monitor.isWatching).toBe(true)
    await advance(HANG_PING_MS)
    expect(page.probes).toHaveLength(2)
    page.probes[1]!.refuse()
    await advance(HANG_PING_MS)
    expect(page.probes).toHaveLength(3)
    // The third is left unanswered: the refusals were neither misses nor answers, so the hang
    // takes its two misses from here and the delay from the start.
    const third = Date.now()
    await advance(HANG_MISSES * HANG_PROBE_TIMEOUT_MS - SECOND)
    expect(page.words).toEqual([])
    await advance(SECOND)
    expect(page.words).toEqual([[true, third + HANG_MISSES * HANG_PROBE_TIMEOUT_MS]])
    monitor.dispose()
  })

  it('dispose: nothing more is asked or said, whatever comes back', async () => {
    const page = new FakePage()
    const monitor = new HangMonitor(page)
    monitor.setActive(true)
    await advance(HANG_PING_MS + HANG_PROBE_TIMEOUT_MS)
    monitor.dispose()
    const asked = page.probes.length
    await advance(60 * SECOND)
    page.answerAll()
    await advance(0)
    expect(page.probes).toHaveLength(asked)
    expect(page.words).toEqual([])
    expect(monitor.isWatching).toBe(false)
  })
})
