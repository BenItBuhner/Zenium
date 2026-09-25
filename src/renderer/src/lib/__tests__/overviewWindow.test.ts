import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FILL_BUDGET_MS,
  cancelFill,
  fillCards,
  overviewWindowStore,
  pendingFill,
  resetOverviewWindow,
  scheduleFill,
  windowOf,
  type CellBox
} from '../overviewWindow'

/*
 * The overview grid's window (W6-0, PERF-5 item (e)): which cells the grid builds as cards at a
 * commit – the ones in view and a row's margin past each edge, a folded group's members
 * excepted – and the order the rest are built in idle time, nearest the view first; and the
 * idle fill itself, one card at a time under its frame budget and the idle deadline, never
 * more than the budget's worth in one callback, always at least one when the deadline has
 * timed out. The model is pure; the fill is driven here by a hand-cranked idle callback and a
 * clock that moves a fixed step per read.
 */

/** Rows of two cards, 260 tall at a 272 pitch, from `top`. */
function rows(count: number, top = 0, folded = false): CellBox[] {
  const cells: CellBox[] = []
  for (let i = 0; i < count; i++) {
    const y = top + Math.floor(i / 2) * 272
    cells.push({ key: `t${i}`, top: y, bottom: y + 260, card: true, folded })
  }
  return cells
}
const VIEW = { top: 0, bottom: 800 }

describe('windowOf: the cells in view and a row past each edge', () => {
  it('builds the rows in view and the next row, and lists the rest nearest first', () => {
    const { shown, rest } = windowOf(VIEW, rows(30))
    // Rows 0–2 are in view (the third cut at the bottom), row 3 (816–1076) is the margin.
    expect(shown).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'])
    expect(rest).toEqual(Array.from({ length: 22 }, (_, i) => `t${i + 8}`))
  })

  it('reaches a row above the view too, and orders the rest by distance whichever side', () => {
    // Scrolled four rows: rows 0–3 above the view, rows 4–6 in it, 7 the margin below, 3 above.
    const { shown, rest } = windowOf(VIEW, rows(30, -1088))
    expect(shown).toEqual(['t6', 't7', 't8', 't9', 't10', 't11', 't12', 't13', 't14', 't15'])
    // Row 2 ends 284 above the view, row 8 starts 288 below it: the row above comes first.
    expect(rest.slice(0, 4)).toEqual(['t4', 't5', 't16', 't17'])
    // The top row, 828 above, comes before the last row, 1920 below.
    expect(rest.indexOf('t0')).toBeLessThan(rest.indexOf('t28'))
    expect(rest.slice(-2)).toEqual(['t28', 't29'])
  })

  it('sizes the margin by the tallest card in view, and by a share of the view where none is', () => {
    const tall: CellBox[] = [
      { key: 'g', top: 0, bottom: 600, card: false, folded: false },
      { key: 'a', top: 0, bottom: 600, card: true, folded: false },
      { key: 'b', top: 1300, bottom: 1400, card: true, folded: false },
      { key: 'c', top: 1500, bottom: 1600, card: true, folded: false }
    ]
    // The margin is 600 (the card in view): `b` at 1300 is within 1400, `c` is not.
    expect(windowOf(VIEW, tall).shown).toEqual(['g', 'a', 'b'])
    const none: CellBox[] = [
      { key: 'a', top: 1000, bottom: 1100, card: true, folded: false },
      { key: 'b', top: 1200, bottom: 1300, card: true, folded: false }
    ]
    // No card in view: the margin is 35% of the view's 800 – 280 – so `a` at 1000 is within.
    expect(windowOf(VIEW, none)).toEqual({ shown: ['a'], rest: ['b'] })
  })

  it("never builds a folded group's members at the commit: they go last of the rest", () => {
    const cells = [...rows(4, 0, true), ...rows(30, 0).map((c) => ({ ...c, key: `l${c.key}` }))]
    const { shown, rest } = windowOf(VIEW, cells)
    expect(shown.every((k) => k.startsWith('l'))).toBe(true)
    expect(shown).toHaveLength(8)
    expect(rest.slice(-4)).toEqual(['t0', 't1', 't2', 't3'])
    expect(rest[0]).toBe('lt8')
  })

  it('keeps group cards and the New Tab card out of the rest: only cards are deferred', () => {
    const cells: CellBox[] = [
      { key: 'group:g', top: 2000, bottom: 2300, card: false, folded: false },
      { key: 'new-tab', top: 2400, bottom: 2600, card: false, folded: false },
      { key: 't', top: 2400, bottom: 2600, card: true, folded: false }
    ]
    expect(windowOf(VIEW, cells)).toEqual({ shown: [], rest: ['t'] })
  })
})

describe('the idle fill', () => {
  const idle = new Map<number, (deadline: IdleDeadline) => void>()
  let seq = 0
  let clock = 0
  let tick = 0
  const deadline = (remaining: number, didTimeout = false): IdleDeadline => ({
    didTimeout,
    timeRemaining: () => remaining
  })
  const filled = (): string[] => [...overviewWindowStore.get().filled].sort()

  beforeEach(() => {
    idle.clear()
    clock = 0
    tick = 0
    vi.stubGlobal('requestIdleCallback', (cb: (d: IdleDeadline) => void) => {
      idle.set(++seq, cb)
      return seq
    })
    vi.stubGlobal('cancelIdleCallback', (id: number) => {
      idle.delete(id)
    })
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += tick))
    resetOverviewWindow()
  })
  afterEach(() => {
    cancelFill()
    resetOverviewWindow()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** Run the one idle callback asked for. */
  const runIdle = (d: IdleDeadline): void => {
    const [id, cb] = [...idle.entries()][0] ?? []
    expect(cb).toBeDefined()
    idle.delete(id!)
    cb!(d)
  }

  it('fills one card at a time under the budget, nearest first, then asks for the next idle period', () => {
    // Every read of the clock moves it 2 ms: a card measures 2 ms, and the budget's check after
    // it counts 6 ms per card – two cards fit 12 ms, a third would not.
    tick = 2
    scheduleFill(['t8', 't9', 't10', 't11', 't12'])
    expect(idle.size).toBe(1)
    expect(pendingFill()).toBe(5)
    runIdle(deadline(50))
    expect(filled()).toEqual(['t8', 't9'])
    expect(pendingFill()).toBe(3)
    expect(idle.size).toBe(1)
    runIdle(deadline(50))
    expect(filled()).toEqual(['t10', 't11', 't8', 't9'])
    runIdle(deadline(50))
    expect(filled()).toHaveLength(5)
    expect(idle.size).toBe(0)
    expect(pendingFill()).toBe(0)
  })

  it('stops when the idle time left is less than the last card cost; a timed-out deadline is bounded by the budget alone', () => {
    tick = 2
    scheduleFill(['a', 'b', 'c', 'd', 'e'])
    // 1 ms left after the first card's 2: the second waits for the next idle period.
    runIdle(deadline(1))
    expect(filled()).toEqual(['a'])
    // The deadline timed out (no idle time came): the fill goes on regardless, two cards to
    // the budget, so a busy main thread still sees the grid finish.
    runIdle(deadline(0, true))
    expect(filled()).toEqual(['a', 'b', 'c'])
    runIdle(deadline(0, true))
    expect(filled()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('takes as many as fit when cards are cheap, within the budget', () => {
    // Each read moves the clock 0.5 ms: a card counts 1.5 ms against the 12 ms budget.
    tick = 0.5
    scheduleFill(Array.from({ length: 40 }, (_, i) => `t${i}`))
    runIdle(deadline(50))
    const count = filled().length
    expect(count).toBeGreaterThan(4)
    expect(count * 1.5).toBeLessThanOrEqual(FILL_BUDGET_MS + 1.5)
  })

  it('a new order replaces the queue and skips cards already built; a cancel drops it', () => {
    tick = 2
    fillCards(['t1'])
    scheduleFill(['t1', 't2', 't3'])
    expect(pendingFill()).toBe(2)
    scheduleFill(['t9', 't2'])
    expect(pendingFill()).toBe(2)
    // One callback asked for, whichever order came: it reads the queue it finds.
    expect(idle.size).toBe(1)
    runIdle(deadline(50))
    expect(filled()).toEqual(['t1', 't2', 't9'])
    scheduleFill(['t5'])
    expect(idle.size).toBe(1)
    cancelFill()
    expect(pendingFill()).toBe(0)
    expect(idle.size).toBe(0)
    // An order with nothing left to build asks for nothing.
    scheduleFill(['t1'])
    expect(pendingFill()).toBe(0)
  })

  it('resetting the window drops the queue and every card built', () => {
    tick = 2
    scheduleFill(['x', 'y'])
    runIdle(deadline(50))
    expect(filled()).toEqual(['x', 'y'])
    resetOverviewWindow()
    expect(overviewWindowStore.get()).toEqual({ all: false, filled: new Set() })
    expect(pendingFill()).toBe(0)
  })
})
