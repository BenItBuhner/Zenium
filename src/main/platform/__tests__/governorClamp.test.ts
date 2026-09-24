import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { TabLifecycle } from '../resources/lifecycle'
import { CLAMP_SETTLE_MS, ConcurrencyClamp, type ClampedView } from '../resources/clamp'
import { setDebuggerRecycler } from '../pageDebugger'

/**
 * `WebContents.debugger` as the governor sees it: one session, every command recorded; `detach`
 * emits `detach` after letting go, as Electron's does (the lifecycle's watcher and the view's
 * hold both listen to it).
 */
class FakeDebugger extends EventEmitter {
  attached = false
  readonly log: string[] = []
  /** The renderer answers nothing (a hung page): commands stay pending until the session goes. */
  hung = false
  private readonly pendingRejects: Array<(e: Error) => void> = []
  isAttached(): boolean {
    return this.attached
  }
  attach(): void {
    if (this.attached) throw new Error('Debugger is already attached')
    this.attached = true
    this.log.push('attach')
  }
  detach(): void {
    this.attached = false
    this.log.push('detach')
    for (const reject of this.pendingRejects.splice(0)) reject(new Error('target closed'))
    this.emit('detach', {}, 'target closed')
  }
  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.attached) throw new Error('Debugger is not attached')
    this.log.push(params ? `${method} ${JSON.stringify(params)}` : method)
    if (this.hung) {
      return new Promise((_, reject) => {
        this.pendingRejects.push(reject)
      })
    }
    return {}
  }
}

/** A tab page as the clamp reads it: its web contents and whether the layout shows it. */
class FakeView implements ClampedView {
  readonly dbg = new FakeDebugger()
  readonly webContents: WebContents
  private shown = false
  private gone = false
  constructor(id: number) {
    this.webContents = {
      id,
      debugger: this.dbg,
      isDestroyed: () => this.gone
    } as unknown as WebContents
  }
  isVisible(): boolean {
    return this.shown
  }
  isDestroyed(): boolean {
    return this.gone
  }
  /** The chrome's layout showing or hiding the page (`ElectronTabView.setVisible`). */
  setVisible(visible: boolean): boolean {
    const flipped = this.shown !== visible
    this.shown = visible
    return flipped
  }
  destroy(): void {
    this.gone = true
  }
  /** The session and what it carries, as one line. */
  get session(): string {
    return `${this.dbg.attached ? 'attached' : 'detached'}${this.dbg.log.length ? ' ' + this.dbg.log.join(' | ') : ''}`
  }
}

const CORES = 4
const CLAMPED = `Emulation.setHardwareConcurrencyOverride {"hardwareConcurrency":${CORES}}`

/** The governor's wiring in miniature: every flip is a touch, a lost session is a touch. */
function harness(override: () => number | null = () => CORES): {
  lifecycle: TabLifecycle
  clamp: ConcurrencyClamp
  views: FakeView[]
  page: (visible?: boolean) => FakeView
  show: (view: FakeView) => void
  hide: (view: FakeView) => void
  switchTo: (next: FakeView, from: FakeView) => void
  settle: () => Promise<void>
} {
  const lifecycle = new TabLifecycle()
  const clamp = new ConcurrencyClamp(lifecycle, override)
  const views: FakeView[] = []
  let nextId = 1
  lifecycle.onSessionLost = (wc) => {
    const view = views.find((v) => v.webContents.id === wc.id)
    if (view) clamp.touch(view)
  }
  const flip = (view: FakeView, visible: boolean): void => {
    if (view.setVisible(visible)) clamp.touch(view)
  }
  return {
    lifecycle,
    clamp,
    views,
    page: (visible = false) => {
      const view = new FakeView(nextId++)
      views.push(view)
      // Born hidden (`onViewCreated`), then placed by the layout when it is in front.
      clamp.touch(view)
      if (visible) flip(view, true)
      return view
    },
    show: (view) => flip(view, true),
    hide: (view) => flip(view, false),
    switchTo: (next, from) => {
      // One layout pass hides the page that was in front and shows the next.
      flip(from, false)
      flip(next, true)
    },
    settle: async () => {
      // The batch is not awaited – a hung page's never answers – but its commands answer (or are
      // rejected by a detach) within the turn; what a decision touched again is decided by the
      // second pass.
      for (let i = 0; i < 2; i++) {
        void clamp.flush()
        await new Promise((r) => setImmediate(r))
      }
    }
  }
}

describe('ConcurrencyClamp – the CPU clamp on background pages only', () => {
  afterEach(() => {
    setDebuggerRecycler(null)
    vi.useRealTimers()
  })

  it('leaves the page in front with no session and clamps the one behind', async () => {
    const h = harness()
    const front = h.page(true)
    const behind = h.page()
    await h.settle()
    expect(front.session).toBe('detached')
    expect(behind.session).toBe(`attached attach | ${CLAMPED}`)
    expect(h.lifecycle.hardwareConcurrency(front.webContents)).toBeNull()
    expect(h.lifecycle.hardwareConcurrency(behind.webContents)).toBe(CORES)
  })

  it('a tab switch flips both: the new front page loses its session, the old one gains the clamp', async () => {
    const h = harness()
    const a = h.page(true)
    const b = h.page()
    await h.settle()
    h.switchTo(b, a)
    await h.settle()
    expect(a.session).toBe(`attached attach | ${CLAMPED}`)
    expect(b.session).toBe(`detached attach | ${CLAMPED} | detach`)
    expect(h.lifecycle.hardwareConcurrency(a.webContents)).toBe(CORES)
    expect(h.lifecycle.hardwareConcurrency(b.webContents)).toBeNull()
    // And back.
    h.switchTo(a, b)
    await h.settle()
    expect(a.dbg.attached).toBe(false)
    expect(b.dbg.attached).toBe(true)
    expect(b.dbg.log.slice(-2)).toEqual(['attach', CLAMPED])
  })

  it('both panes of a split are in front: neither carries a session; the tabs behind them do', async () => {
    const h = harness()
    const left = h.page(true)
    const right = h.page(true)
    const behind = h.page()
    await h.settle()
    expect(left.session).toBe('detached')
    expect(right.session).toBe('detached')
    expect(behind.dbg.attached).toBe(true)
  })

  it('a page in front in any window is in front: two windows, two pages with no session', async () => {
    const h = harness()
    const win1Front = h.page(true)
    const win2Front = h.page(true)
    const win1Behind = h.page()
    const win2Behind = h.page()
    await h.settle()
    expect(win1Front.session).toBe('detached')
    expect(win2Front.session).toBe('detached')
    expect(win1Behind.dbg.attached).toBe(true)
    expect(win2Behind.dbg.attached).toBe(true)
    // The second window closes: its page goes behind (its view hidden), and is clamped.
    h.hide(win2Front)
    await h.settle()
    expect(win2Front.session).toBe(`attached attach | ${CLAMPED}`)
  })

  it('a burst of flips within the settle is one decision: the thaw’s hide-then-show costs no session, a new front tab never gets one', async () => {
    const h = harness()
    const front = h.page(true)
    await h.settle()
    // `refreshVisibility`: hidden and shown in the same tick.
    h.hide(front)
    h.show(front)
    await h.settle()
    expect(front.session).toBe('detached')
    // A tab opened in front: born hidden, placed by the layout before the settle runs out.
    const opened = h.page()
    h.show(opened)
    await h.settle()
    expect(opened.session).toBe('detached')
    // A tab cycled past on the way to another: no session either.
    const a = h.page()
    const b = h.page()
    await h.settle()
    h.switchTo(a, opened)
    h.switchTo(b, a)
    await h.settle()
    expect(a.dbg.log).toEqual(['attach', CLAMPED])
    expect(opened.dbg.log).toEqual(['attach', CLAMPED])
    expect(b.session).toBe(`detached attach | ${CLAMPED} | detach`)
  })

  it('waits the settle before deciding, and decides a long burst at the latest four settles in', () => {
    vi.useFakeTimers()
    const lifecycle = new TabLifecycle()
    const clamp = new ConcurrencyClamp(lifecycle, () => CORES)
    const view = new FakeView(90)
    clamp.touch(view)
    vi.advanceTimersByTime(CLAMP_SETTLE_MS - 1)
    expect(view.dbg.log).toEqual([])
    vi.advanceTimersByTime(1)
    expect(view.dbg.log).toEqual(['attach', CLAMPED])
    // A page flipping every 100 ms for a second is decided by 600 ms, not never.
    const busy = new FakeView(91)
    for (let t = 0; t < 600; t += 100) {
      busy.setVisible(t % 200 === 0)
      clamp.touch(busy)
      vi.advanceTimersByTime(100)
    }
    expect(busy.dbg.log.length).toBeGreaterThan(0)
    clamp.stop()
  })

  it('the CPU limit at 100 % (or the governor off) takes the clamp off every page; back under it, the hidden pages are clamped again', async () => {
    let cores: number | null = CORES
    const h = harness(() => cores)
    const front = h.page(true)
    const behind = h.page()
    await h.settle()
    expect(behind.dbg.attached).toBe(true)
    cores = null
    h.clamp.touchAll(h.views)
    await h.settle()
    expect(behind.session).toBe(`detached attach | ${CLAMPED} | detach`)
    expect(front.session).toBe('detached')
    cores = 2
    h.clamp.touchAll(h.views)
    await h.settle()
    expect(behind.dbg.log.slice(-2)).toEqual([
      'attach',
      'Emulation.setHardwareConcurrencyOverride {"hardwareConcurrency":2}'
    ])
    expect(front.session).toBe('detached')
  })

  it('a frozen or throttled page behind keeps its session when the clamp comes off it – the freeze stays', async () => {
    let cores: number | null = CORES
    const h = harness(() => cores)
    const behind = h.page()
    await h.settle()
    await h.lifecycle.freeze(behind.webContents)
    behind.dbg.log.length = 0
    cores = null
    h.clamp.touchAll(h.views)
    await h.settle()
    // Recycled: the concurrency override is gone with the old session, the freeze is back on the new.
    expect(behind.dbg.log).toEqual([
      'detach',
      'attach',
      'Page.setWebLifecycleState {"state":"frozen"}'
    ])
    expect(h.lifecycle.isFrozen(behind.webContents)).toBe(true)
    expect(h.lifecycle.hardwareConcurrency(behind.webContents)).toBeNull()
  })

  it('a page coming in front whose thaw is still in flight is decided again once it has landed, not recycled under it', async () => {
    vi.useFakeTimers()
    const lifecycle = new TabLifecycle()
    const clamp = new ConcurrencyClamp(lifecycle, () => CORES)
    const view = new FakeView(80)
    clamp.touch(view)
    await clamp.flush()
    await lifecycle.freeze(view.webContents)
    expect(view.dbg.log).toEqual([
      'attach',
      CLAMPED,
      'Page.setWebLifecycleState {"state":"frozen"}'
    ])
    view.dbg.log.length = 0
    // Shown by the layout while the governor's `wakeVisible` thaw has not answered yet.
    view.setVisible(true)
    clamp.touch(view)
    await clamp.flush()
    expect(view.dbg.log).toEqual([])
    expect(view.dbg.attached).toBe(true)
    // The thaw lands; the retry finds the page awake and takes the clamp off: nothing is left, so the session goes.
    await lifecycle.thaw(view.webContents)
    expect(view.dbg.attached).toBe(true)
    await vi.advanceTimersByTimeAsync(260)
    expect(view.dbg.log).toEqual(['Page.setWebLifecycleState {"state":"active"}', 'detach'])
    expect(view.dbg.attached).toBe(false)
    expect(lifecycle.hardwareConcurrency(view.webContents)).toBeNull()
    clamp.stop()
  })

  it('a session lost from under the clamp (another client, a hold ending) is put back on a page behind', async () => {
    const h = harness()
    const behind = h.page()
    await h.settle()
    expect(behind.dbg.attached).toBe(true)
    // Another client took the page, then let it go.
    behind.dbg.detach()
    expect(h.lifecycle.hardwareConcurrency(behind.webContents)).toBeNull()
    await h.settle()
    expect(behind.dbg.log).toEqual(['attach', CLAMPED, 'detach', 'attach', CLAMPED])
    expect(h.lifecycle.hardwareConcurrency(behind.webContents)).toBe(CORES)
  })

  it('shares a session another holder opened, detaches it to clear the clamp (that holder attaches again), and never drops one that carries nothing of its own', async () => {
    const h = harness()
    const behind = h.page()
    // The dark theme for sites' hold attached first.
    behind.dbg.attach()
    behind.dbg.log.length = 0
    await h.settle()
    expect(behind.dbg.log).toEqual([CLAMPED])
    // In front: the only way to clear an emulation override is the session's end.
    h.show(behind)
    await h.settle()
    expect(behind.dbg.log).toEqual([CLAMPED, 'detach'])
    // A purge on a page whose session is another holder's leaves that session alone.
    const other = new FakeView(70)
    other.dbg.attach()
    other.dbg.log.length = 0
    await h.lifecycle.purge(other.webContents)
    expect(other.dbg.log).toEqual(['HeapProfiler.collectGarbage'])
    expect(other.dbg.attached).toBe(true)
  })

  it('a hung page: the override never answers; shown, the session goes anyway so Chromium can report the hang', async () => {
    const h = harness()
    const page = h.page()
    page.dbg.hung = true
    await h.settle()
    // Attached, the command pending on a renderer that does not answer.
    expect(page.dbg.log).toEqual(['attach', CLAMPED])
    expect(h.lifecycle.hardwareConcurrency(page.webContents)).toBeNull()
    h.show(page)
    await h.settle()
    expect(page.dbg.attached).toBe(false)
    expect(page.dbg.log).toEqual(['attach', CLAMPED, 'detach'])
    // Behind again, the renderer answering now: clamped.
    page.dbg.hung = false
    h.hide(page)
    await h.settle()
    expect(page.dbg.log.slice(-2)).toEqual(['attach', CLAMPED])
    expect(h.lifecycle.hardwareConcurrency(page.webContents)).toBe(CORES)
  })

  it('a destroyed page is forgotten: nothing is sent to it', async () => {
    const h = harness()
    const page = h.page()
    page.destroy()
    h.clamp.forget(page)
    await h.settle()
    expect(page.dbg.log).toEqual([])
    const pending = h.page()
    pending.destroy()
    await h.settle()
    expect(pending.dbg.log).toEqual([])
  })
})
