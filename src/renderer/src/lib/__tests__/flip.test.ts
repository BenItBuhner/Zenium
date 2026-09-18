// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CELL_ATTR, collectCells, FlipTracker } from '../motion/flip'

/*
 * The grid's glide (`lib/motion/flip.ts`): one tracker, one spring, every cell. Cells are what
 * carries `data-cell` under the grid, whatever drew them, so the New Tab card moves with the tab
 * cards it sits among.
 */

let frames: Array<(now: number) => void> = []
let now = 1000
const frame = (): void => {
  now += 16
  const batch = frames
  frames = []
  for (const cb of batch) cb(now)
}

beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
    frames.push(cb)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.splice(id - 1, 1)
  })
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

type Cell = HTMLElement & { moveTo: (x: number, y: number) => void }

/** A cell whose layout position the test moves by hand. */
function cell(key: string, x: number, y: number): Cell {
  const el = document.createElement('div')
  el.setAttribute(CELL_ATTR, key)
  let at = { x, y }
  el.getBoundingClientRect = () => new DOMRect(at.x, at.y, 100, 130)
  return Object.assign(el, {
    moveTo: (nx: number, ny: number) => {
      at = { x: nx, y: ny }
    }
  })
}

function translate(el: HTMLElement): { x: number; y: number } {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform)
  return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 }
}

describe('collectCells', () => {
  it('finds every data-cell under the root, by key, in document order', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <div data-cell="pinned"></div>
      <div data-cell="group:g"><div><div data-cell="a"></div><div data-cell="b"></div></div></div>
      <div data-cell="c"></div>
      <button data-cell="new-tab"></button>
      <div class="not-a-cell"></div>`
    const cells = collectCells(root)
    expect([...cells.keys()]).toEqual(['pinned', 'group:g', 'a', 'b', 'c', 'new-tab'])
    expect(cells.get('new-tab')?.tagName).toBe('BUTTON')
    expect(collectCells(null).size).toBe(0)
  })
})

describe('FlipTracker', () => {
  it('glides every cell that moved on one shared spring – the New Tab card with the tab cards', () => {
    const a = cell('a', 0, 0)
    const b = cell('b', 110, 0)
    const c = cell('c', 220, 0)
    const plus = cell('new-tab', 0, 140)
    const tracker = new FlipTracker()
    const cells = new Map<string, HTMLElement>([
      ['a', a],
      ['b', b],
      ['c', c],
      ['new-tab', plus]
    ])
    tracker.commit(cells, null, true)
    expect(frames).toHaveLength(0)

    // Card a closes: b, c and the New Tab card each move up one slot.
    cells.delete('a')
    b.moveTo(0, 0)
    c.moveTo(110, 0)
    plus.moveTo(220, 0)
    tracker.commit(cells, null, true)
    // Drawn where they were a moment ago…
    expect(translate(b)).toEqual({ x: 110, y: 0 })
    expect(translate(c)).toEqual({ x: 110, y: 0 })
    expect(translate(plus)).toEqual({ x: -220, y: 140 })
    // …and one spring takes them all back: the same fraction of the way on every frame.
    for (let i = 0; i < 6; i++) frame()
    const tb = translate(b)
    const tp = translate(plus)
    expect(tb.x).toBeGreaterThan(0)
    expect(tb.x).toBeLessThan(110)
    expect(tp.x / -220).toBeCloseTo(tb.x / 110, 6)
    expect(tp.y / 140).toBeCloseTo(tb.x / 110, 6)
    for (let i = 0; i < 400 && frames.length; i++) frame()
    expect(b.style.transform).toBe('')
    expect(plus.style.transform).toBe('')
  })

  it('answers where a cell rests and which element it is, also before the grid has settled', () => {
    const a = cell('a', 0, 0)
    const plus = cell('new-tab', 110, 0)
    const tracker = new FlipTracker()
    const cells = new Map<string, HTMLElement>([
      ['a', a],
      ['new-tab', plus]
    ])
    tracker.observe(cells)
    expect(tracker.element('new-tab')).toBe(plus)
    expect(tracker.layoutRect('new-tab')).toBeNull()
    tracker.commit(cells, null, true)
    expect(tracker.layoutRect('new-tab')).toMatchObject({ x: 110, y: 0, width: 100, height: 130 })
    tracker.stop()
  })
})
