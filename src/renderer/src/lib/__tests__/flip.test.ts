// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CELL_ATTR,
  collectCells,
  FlipTracker,
  layoutAnimations,
  REDUCED_FADE_MS
} from '../motion/flip'

/*
 * The grid's glide (`lib/motion/flip.ts`): one tracker, one spring, every cell. Cells are what
 * carries `data-cell` under the grid, whatever drew them, so the New Tab card moves with the tab
 * cards it sits among. A group animating its height holds the cells below it until it has
 * settled, then they glide (v2 §11.4); under reduced motion a glide is a fade in at the new
 * slot (v2 §11.3).
 */

let frames: Array<(now: number) => void> = []
let now = 1000
const frame = (): void => {
  now += 16
  const batch = frames
  frames = []
  for (const cb of batch) cb(now)
}
const settle = (): void => {
  for (let i = 0; i < 400 && frames.length; i++) frame()
}

/**
 * Every tracker a test makes, listening for layout animations as the grid's hook has it, and
 * disposed after the test whatever happened to it.
 */
let trackers: FlipTracker[] = []
const tracker = (): FlipTracker => {
  const t = new FlipTracker()
  t.listen()
  trackers.push(t)
  return t
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
  for (const t of trackers) t.dispose()
  trackers = []
  for (const owner of ['group:g', 'group:x']) layoutAnimations.end(owner)
  layoutAnimations.release()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

type Cell = HTMLElement & {
  moveTo: (x: number, y: number) => void
  resize: (height: number) => void
  /** The transforms the tracker had on the element when it was measured. */
  measured: string[]
}

/** A cell whose layout position and size the test moves by hand. */
function cell(key: string, x: number, y: number, height = 130): Cell {
  const el = document.createElement('div')
  el.setAttribute(CELL_ATTR, key)
  let at = { x, y }
  let h = height
  const measured: string[] = []
  el.getBoundingClientRect = () => {
    measured.push(el.style.transform)
    return new DOMRect(at.x, at.y, 100, h)
  }
  return Object.assign(el, {
    moveTo: (nx: number, ny: number) => {
      at = { x: nx, y: ny }
    },
    resize: (nh: number) => {
      h = nh
    },
    measured
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
    const flip = tracker()
    const cells = new Map<string, HTMLElement>([
      ['a', a],
      ['b', b],
      ['c', c],
      ['new-tab', plus]
    ])
    flip.commit(cells, null, true)
    expect(frames).toHaveLength(0)

    // Card a closes: b, c and the New Tab card each move up one slot.
    cells.delete('a')
    b.moveTo(0, 0)
    c.moveTo(110, 0)
    plus.moveTo(220, 0)
    flip.commit(cells, null, true)
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
    settle()
    expect(b.style.transform).toBe('')
    expect(plus.style.transform).toBe('')
    flip.dispose()
  })

  it('answers where a cell rests and which element it is, also before the grid has settled', () => {
    const a = cell('a', 0, 0)
    const plus = cell('new-tab', 110, 0)
    const flip = tracker()
    const cells = new Map<string, HTMLElement>([
      ['a', a],
      ['new-tab', plus]
    ])
    flip.observe(cells)
    expect(flip.element('new-tab')).toBe(plus)
    expect(flip.layoutRect('new-tab')).toBeNull()
    flip.commit(cells, null, true)
    expect(flip.layoutRect('new-tab')).toMatchObject({ x: 110, y: 0, width: 100, height: 130 })
    flip.dispose()
  })

  it('measures with every transform cleared, and draws a nested cell against its parent', () => {
    const group = cell('group:g', 0, 0, 300)
    const a = cell('a', 6, 38)
    group.appendChild(a)
    const plus = cell('new-tab', 0, 310)
    const flip = tracker()
    const cells = new Map<string, HTMLElement>([
      ['group:g', group],
      ['a', a],
      ['new-tab', plus]
    ])
    flip.commit(cells, null, true)
    // Everything moves down a row together (a card was pinned above).
    group.moveTo(0, 140)
    a.moveTo(6, 178)
    plus.moveTo(0, 450)
    flip.commit(cells, null, true)
    // Two passes: transforms off, then measured – never a measurement of a transformed cell.
    expect(group.measured.every((t) => t === '')).toBe(true)
    expect(a.measured.every((t) => t === '')).toBe(true)
    // The group carries its child: the child's own transform is nothing.
    expect(translate(group)).toEqual({ x: 0, y: -140 })
    expect(a.style.transform).toBe('')
    expect(translate(plus)).toEqual({ x: 0, y: -140 })
    flip.dispose()
  })

  describe('a group animating its height (v2 §11.4)', () => {
    /** A three-row grid: the group, then a row of cards, then the New Tab card. */
    function grid(): {
      flip: FlipTracker
      cells: Map<string, HTMLElement>
      group: Cell
      a: Cell
      b: Cell
      c: Cell
      plus: Cell
    } {
      const group = cell('group:g', 0, 0, 300)
      const a = cell('a', 6, 38)
      const b = cell('b', 116, 38)
      group.append(a, b)
      const c = cell('c', 0, 310)
      const plus = cell('new-tab', 110, 310)
      const flip = tracker()
      const cells = new Map<string, HTMLElement>([
        ['group:g', group],
        ['a', a],
        ['b', b],
        ['c', c],
        ['new-tab', plus]
      ])
      flip.commit(cells, null, true)
      return { flip, cells, group, a, b, c, plus }
    }

    /**
     * The group's height runs to `h` and the browser lays the cells below out for it – the row
     * is as tall as the taller of the group and the card beside it, and c and the New Tab card
     * sit 10 px under it.
     */
    const layoutFor = (h: number, group: Cell, below: Cell[], beside = 130): void => {
      group.resize(h)
      const row = Math.max(h, beside)
      for (const el of below) el.moveTo(el.getBoundingClientRect().x, row + 10)
    }

    it('holds the cells below where they were while the height runs, and glides them after', () => {
      const { flip, cells, group, a, b, c, plus } = grid()
      const released = vi.fn()
      flip.onRelease(released)
      // Card b leaves the group for the loose row: the group is one column wide and 170 tall
      // once its spring has run. The group card holds itself at 300 for the commit, so the row
      // below is laid out where it was.
      layoutAnimations.start('group:g', 300, 170)
      b.remove()
      b.moveTo(110, 0)
      flip.commit(cells, null, true)
      // b glides from its inner slot to its loose one: a glide, not a hold…
      expect(translate(b).x).toBeCloseTo(6, 6)
      expect(translate(b).y).toBeCloseTo(38, 6)
      // …while c and the New Tab card have nothing to do yet.
      expect(c.style.transform).toBe('')
      expect(plus.style.transform).toBe('')
      settle()
      expect(b.style.transform).toBe('')
      // The height runs and the browser moves the row up by layout each frame: the hold puts it
      // back where it was, frame by frame – nothing below moves while the group shrinks.
      for (const h of [280, 235, 190]) {
        layoutFor(h, group, [c, plus])
        layoutAnimations.frame('group:g', h)
        expect(translate(c).y).toBeCloseTo(300 - h, 6)
        expect(translate(plus).y).toBeCloseTo(300 - h, 6)
        expect(c.getBoundingClientRect().y + translate(c).y).toBeCloseTo(310, 6)
      }
      expect(released).not.toHaveBeenCalled()
      expect(a.style.transform).toBe('')
      // The height has settled: the hold is released into a glide of the cells below, from
      // where they were held to their new slots.
      layoutFor(170, group, [c, plus])
      layoutAnimations.frame('group:g', 170)
      layoutAnimations.end('group:g')
      expect(released).toHaveBeenCalledTimes(1)
      expect(layoutAnimations.has('group:g')).toBe(false)
      expect(translate(c).y).toBeCloseTo(130, 6)
      expect(translate(plus).y).toBeCloseTo(130, 6)
      expect(flip.layoutRect('c')).toMatchObject({ x: 0, y: 180 })
      for (let i = 0; i < 6; i++) frame()
      expect(translate(c).y).toBeGreaterThan(0)
      expect(translate(c).y).toBeLessThan(130)
      settle()
      expect(c.style.transform).toBe('')
      expect(plus.style.transform).toBe('')
    })

    it('lets the hold go only once the glide in flight has ended', () => {
      const { flip, cells, group, b, c, plus } = grid()
      const released = vi.fn()
      flip.onRelease(released)
      layoutAnimations.start('group:g', 300, 170)
      b.remove()
      b.moveTo(110, 0)
      flip.commit(cells, null, true)
      // The height settles at once (a jump); b is still gliding.
      layoutFor(170, group, [c, plus])
      layoutAnimations.frame('group:g', 170)
      layoutAnimations.end('group:g')
      expect(released).not.toHaveBeenCalled()
      // c and the New Tab card stay held where they were…
      expect(translate(c)).toEqual({ x: 0, y: 130 })
      expect(translate(plus)).toEqual({ x: 0, y: 130 })
      for (let i = 0; i < 400 && released.mock.calls.length === 0; i++) frame()
      // …until b has landed; then they glide, from there.
      expect(released).toHaveBeenCalledTimes(1)
      expect(b.style.transform).toBe('')
      expect(translate(c).y).toBeCloseTo(130, 6)
      settle()
      expect(c.style.transform).toBe('')
    })

    it('holds by the row: a group beside a taller card moves the row by the taller of the two', () => {
      const group = cell('group:g', 0, 0, 100)
      const tall = cell('t', 110, 0, 130)
      const c = cell('c', 0, 140)
      const flip = tracker()
      const cells = new Map<string, HTMLElement>([
        ['group:g', group],
        ['t', tall],
        ['c', c]
      ])
      flip.commit(cells, null, true)
      // A card enters the group, which grows past its row-mate: the row gets taller from 130 up.
      layoutAnimations.start('group:g', 100, 200)
      flip.commit(cells, null, true)
      expect(c.style.transform).toBe('')
      for (const h of [120, 130, 165, 200]) {
        layoutFor(h, group, [c])
        layoutAnimations.frame('group:g', h)
        expect(translate(c).y).toBeCloseTo(130 - Math.max(h, 130), 6)
        expect(c.getBoundingClientRect().y + translate(c).y).toBeCloseTo(140, 6)
      }
      layoutAnimations.end('group:g')
      expect(translate(c).y).toBeCloseTo(-70, 6)
      settle()
      expect(c.style.transform).toBe('')
    })

    it('forgets an animation nobody holds for', () => {
      layoutAnimations.start('group:x', 100, 200)
      expect(layoutAnimations.has('group:x')).toBe(true)
      layoutAnimations.end('group:x')
      expect(layoutAnimations.has('group:x')).toBe(false)
    })

    it('hears again after dispose and listen – the mount, cleanup, mount of StrictMode', () => {
      const { flip, cells, group, b, c, plus } = grid()
      // A second `listen()` adds nothing: one dispose leaves the tracker deaf, as it should be.
      const off = flip.listen()
      expect(flip.listening).toBe(true)
      flip.dispose()
      expect(flip.listening).toBe(false)
      // What the effect's cleanup dropped, the effect that follows takes again.
      flip.listen()
      expect(flip.listening).toBe(true)
      const released = vi.fn()
      flip.onRelease(released)
      layoutAnimations.start('group:g', 300, 170)
      b.remove()
      b.moveTo(110, 0)
      flip.commit(cells, null, true)
      settle()
      // The tracker hears the frames: the hold keeps the cells below where they were…
      layoutFor(235, group, [c, plus])
      layoutAnimations.frame('group:g', 235)
      expect(translate(c).y).toBeCloseTo(65, 6)
      // …and the settling, which releases them into their glide.
      layoutFor(170, group, [c, plus])
      layoutAnimations.frame('group:g', 170)
      layoutAnimations.end('group:g')
      expect(released).toHaveBeenCalledTimes(1)
      expect(layoutAnimations.has('group:g')).toBe(false)
      settle()
      expect(c.style.transform).toBe('')
      // Disposing twice, or after the unsubscribe it handed out, is nothing.
      off()
      flip.dispose()
      flip.dispose()
      expect(flip.listening).toBe(false)
    })
  })

  it('under reduced motion a cell that moved fades in at its new slot instead of gliding (v2 §11.3)', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }))
    const a = cell('a', 0, 0)
    const b = cell('b', 110, 0)
    const plus = cell('new-tab', 220, 0)
    const animate = vi.fn()
    for (const el of [a, b, plus]) el.animate = animate
    const flip = tracker()
    const cells = new Map<string, HTMLElement>([
      ['a', a],
      ['b', b],
      ['new-tab', plus]
    ])
    flip.commit(cells, null, true)
    cells.delete('a')
    b.moveTo(0, 0)
    plus.moveTo(110, 0)
    flip.commit(cells, null, true)
    expect(b.style.transform).toBe('')
    expect(plus.style.transform).toBe('')
    expect(frames).toHaveLength(0)
    expect(animate).toHaveBeenCalledTimes(2)
    expect(animate).toHaveBeenCalledWith(
      [{ opacity: 0 }, { opacity: 1 }],
      expect.objectContaining({ duration: REDUCED_FADE_MS })
    )
    flip.dispose()
  })
})
