// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FILL_BUDGET_MS,
  NO_GRID,
  cancelFill,
  claimOverviewWindow,
  fillCards,
  guessWindow,
  newOverviewWindowToken,
  overviewRowPitch,
  overviewWindowStore,
  pendingFill,
  readWindow,
  releaseOverviewWindow,
  resetOverviewWindow,
  scheduleFill,
  windowOf,
  type CellBox,
  type GridItem
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

describe("guessWindow: the mount's guess before there is a layout", () => {
  const loose = (from: number, to: number): GridItem[] =>
    Array.from({ length: to - from + 1 }, (_, i) => ({
      kind: 'cell',
      key: `t${from + i}`,
      card: true
    }))
  const keys = (from: number, to: number): string[] =>
    Array.from({ length: to - from + 1 }, (_, i) => `t${from + i}`)
  // A phone 412 wide, two columns: a 188 column, a 3 / 4 card 250.7 tall, a 262.7 pitch.
  const PITCH = overviewRowPitch(412, 2, 3 / 4)

  it('sizes a row from the column the grid gives a card at its aspect, plus the gap', () => {
    expect(PITCH).toBeCloseTo(188 / 0.75 + 12, 5)
    // A tablet's four wide cards at 1.29 : 1 on a 1280 grid: a 305 column, 236 tall.
    expect(overviewRowPitch(1280, 4, 1.29)).toBeCloseTo(305 / 1.29 + 12, 5)
    expect(overviewRowPitch(0, 2, 3 / 4)).toBe(0)
  })

  it('takes the rows the view holds from the top and one more, when the hero is among them', () => {
    // 800 / 262.7 = 3.05: four rows touch the view, the fifth is the margin – ten cards.
    expect(guessWindow(loose(0, 29), 't0', 2, 800, PITCH)).toEqual(keys(0, 9))
    expect(guessWindow(loose(0, 29), 't7', 2, 800, PITCH)).toEqual(keys(0, 9))
    // No hero (the tablet's open by the button): the grid's top likewise.
    expect(guessWindow(loose(0, 29), null, 2, 800, PITCH)).toEqual(keys(0, 9))
  })

  it("ends the view at the hero's row when it must scroll into view, a row's margin each side", () => {
    // t25 is row 12: rows 9–12 hold the view (four rows), 8 and 13 are the margins.
    expect(guessWindow(loose(0, 29), 't25', 2, 800, PITCH)).toEqual(keys(16, 27))
    // The last row (14): rows 11–14 hold the view, 10 is the margin above, nothing below.
    expect(guessWindow(loose(0, 29), 't29', 2, 800, PITCH)).toEqual(keys(20, 29))
  })

  it('lays a group spanning the grid in rows of its own, and a folded group or one of one as a cell', () => {
    const items: GridItem[] = [
      ...loose(0, 2),
      { kind: 'row', key: 'group:g', cards: ['g0', 'g1', 'g2'] },
      { kind: 'cell', key: 'group:f', card: false },
      { kind: 'cell', key: 'h0', card: true },
      ...loose(3, 12)
    ]
    // Rows: [t0 t1] [t2 -] [g0 g1] [g2 -] [f h0] [t3 t4] [t5 t6] … – four in view and a margin
    // from the top: t0–t2, the group's three, h0 (the folded group builds nothing), and no more.
    expect(guessWindow(items, 't0', 2, 800, PITCH)).toEqual([
      't0',
      't1',
      't2',
      'g0',
      'g1',
      'g2',
      'h0'
    ])
    // The hero inside the spanning group: its first row is the group's.
    expect(guessWindow(items, 'g2', 2, 800, PITCH)).toEqual([
      't0',
      't1',
      't2',
      'g0',
      'g1',
      'g2',
      'h0'
    ])
    // The hero heading for a folded group's card: that cell's row.
    expect(guessWindow(items, 'group:f', 2, 600, PITCH)).toEqual([
      't2',
      'g0',
      'g1',
      'g2',
      'h0',
      't3',
      't4'
    ])
  })

  it('guesses every card in when it has no pitch or height to go by', () => {
    expect(guessWindow(loose(0, 29), 't0', 2, 0, PITCH)).toEqual(keys(0, 29))
    expect(guessWindow(loose(0, 29), 't0', 2, 800, 0)).toEqual(keys(0, 29))
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
    expect(overviewWindowStore.get()).toEqual({ owner: NO_GRID, all: false, filled: new Set() })
    expect(pendingFill()).toBe(0)
  })
})

describe("the window's owner: one grid at a time, by token", () => {
  afterEach(() => {
    cancelFill()
    resetOverviewWindow()
    vi.unstubAllGlobals()
  })

  it('a claim starts the store afresh under the token and drops a pending fill; a release by the owner resets it', () => {
    vi.stubGlobal('requestIdleCallback', () => 1)
    vi.stubGlobal('cancelIdleCallback', () => undefined)
    const a = newOverviewWindowToken()
    expect(a).not.toBe(NO_GRID)
    fillCards(['stale'])
    scheduleFill(['x', 'y'])
    claimOverviewWindow(a)
    expect(overviewWindowStore.get()).toEqual({ owner: a, all: false, filled: new Set() })
    expect(pendingFill()).toBe(0)
    fillCards(['t0'])
    releaseOverviewWindow(a)
    expect(overviewWindowStore.get()).toEqual({ owner: NO_GRID, all: false, filled: new Set() })
  })

  it("a release by a grid that no longer owns the window does nothing: the shell swap's old grid", () => {
    // A release landing after a newer grid's claim – a cleanup deferred past the new grid's
    // layout effects – must leave that grid's window alone.
    const old = newOverviewWindowToken()
    claimOverviewWindow(old)
    fillCards(['t0', 't1'])
    const fresh = newOverviewWindowToken()
    expect(fresh).toBeGreaterThan(old)
    claimOverviewWindow(fresh)
    fillCards(['t6', 't7'])
    releaseOverviewWindow(old)
    expect(overviewWindowStore.get().owner).toBe(fresh)
    expect([...overviewWindowStore.get().filled].sort()).toEqual(['t6', 't7'])
    // The owner's own release is the one that counts.
    releaseOverviewWindow(fresh)
    expect(overviewWindowStore.get().owner).toBe(NO_GRID)
  })
})

describe('readWindow: the cells from the layout, drawn or at rest', () => {
  const rect = (top: number, height = 260): DOMRect => new DOMRect(0, top, 200, height)
  function grid(): HTMLElement {
    const el = document.createElement('div')
    el.getBoundingClientRect = () => rect(0, 800)
    for (const key of ['t0', 't1', 'new-tab']) {
      const cell = document.createElement('div')
      cell.setAttribute('data-cell', key)
      if (key !== 'new-tab') cell.setAttribute('data-tab-id', key)
      // Drawn 500 px lower than it will rest: a glide in flight. Out of the window as drawn
      // (no card in view, the margin is 35% of the view: 1080).
      cell.getBoundingClientRect = () => rect(key === 't0' ? 1100 : key === 't1' ? 1372 : 1644)
      el.appendChild(cell)
    }
    return el
  }

  it('reads where the cells are drawn by default', () => {
    const read = readWindow(grid())!
    expect(read.view).toEqual({ top: 0, bottom: 800 })
    expect(read.cells.map((c) => [c.key, c.top, c.card])).toEqual([
      ['t0', 1100, true],
      ['t1', 1372, true],
      ['new-tab', 1644, false]
    ])
  })

  it("reads through the rect given – the FLIP tracker's rest positions – where it has one, the drawn box where it has none", () => {
    const rest = new Map([
      ['t0', rect(600)],
      ['t1', rect(872)]
    ])
    const read = readWindow(grid(), (el, key) => rest.get(key) ?? el.getBoundingClientRect())!
    expect(read.cells.map((c) => [c.key, c.top])).toEqual([
      ['t0', 600],
      ['t1', 872],
      ['new-tab', 1644]
    ])
    // Read at rest, t0 is in view and t1 the margin; drawn, both were out of the window.
    expect(windowOf(read.view, read.cells).shown).toEqual(['t0', 't1'])
    expect(windowOf(read.view, readWindow(grid())!.cells).shown).toEqual([])
  })

  it('answers null for a grid with no height to read', () => {
    const el = document.createElement('div')
    el.getBoundingClientRect = () => rect(0, 0)
    expect(readWindow(el)).toBeNull()
  })
})
