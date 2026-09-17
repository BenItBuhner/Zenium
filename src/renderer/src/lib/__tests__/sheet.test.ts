import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACK_PEEK, SHEET_CLOSED, SheetMotion, type SheetState } from '../motion/sheet'
import {
  SHEET_BACK_TRAVEL,
  SHEET_OVERDRAG,
  computeDetents,
  settleDetent,
  sheetBackPosition,
  sheetDragPosition,
  sheetFrame,
  sheetMaxHeight
} from '../gestures/sheet'

/**
 * A hand-cranked animation frame: `frames(n)` advances the clock 16 ms at a time and runs the
 * callbacks the motion scheduled, so a spring can be followed to rest without a real browser.
 */
class Frames {
  now = 0
  private queue = new Map<number, (now: number) => void>()
  private seq = 0

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++this.seq
      this.queue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue.delete(id)
    })
    vi.stubGlobal('performance', { now: () => this.now })
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
      innerHeight: 800
    })
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) {
      this.now += 16
      const pending = [...this.queue.values()]
      this.queue.clear()
      for (const cb of pending) cb(this.now)
    }
  }

  get scheduled(): boolean {
    return this.queue.size > 0
  }
}

describe('SheetMotion', () => {
  const frames = new Frames()
  let states: SheetState[]
  let closed: number
  let motion: SheetMotion

  beforeEach(() => {
    frames.install()
    states = []
    closed = 0
    motion = new SheetMotion({
      travel: () => 500,
      onChange: (s) => states.push(s),
      onClosed: () => closed++
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  const last = (): SheetState => states[states.length - 1]

  it('presents from off screen and settles open', () => {
    expect(motion.current).toEqual(SHEET_CLOSED)
    motion.present()
    expect(last()).toEqual({ phase: 'settling', progress: 1 })
    frames.run(3)
    expect(last().phase).toBe('settling')
    expect(last().progress).toBeLessThan(1)
    expect(last().progress).toBeGreaterThan(0)
    frames.run(120)
    expect(last()).toEqual({ phase: 'open', progress: 0 })
    expect(closed).toBe(0)
    expect(frames.scheduled).toBe(false)
  })

  it('dismisses with a spring and reports once it is gone', () => {
    motion.present()
    frames.run(120)
    motion.dismiss()
    expect(last().phase).toBe('settling')
    frames.run(120)
    expect(motion.current).toEqual(SHEET_CLOSED)
    expect(closed).toBe(1)
  })

  it('follows a finger and springs back after a short drag', () => {
    motion.present()
    frames.run(120)
    expect(motion.beginDrag()).toBe(true)
    motion.drag(100)
    expect(last()).toEqual({ phase: 'dragging', progress: 0.2 })
    // Upward overshoot rubber-bands: a little, and never far.
    motion.drag(-200)
    expect(last().progress).toBeLessThan(0)
    expect(last().progress).toBeGreaterThan(-0.2)
    motion.drag(100)
    motion.release(0)
    frames.run(120)
    expect(motion.current).toEqual({ phase: 'open', progress: 0 })
    expect(closed).toBe(0)
  })

  it('a long drag or a fling dismisses', () => {
    motion.present()
    frames.run(120)
    motion.beginDrag()
    motion.drag(300)
    motion.release(0)
    frames.run(120)
    expect(motion.current).toEqual(SHEET_CLOSED)
    expect(closed).toBe(1)

    motion.present()
    frames.run(120)
    motion.beginDrag()
    motion.drag(40)
    motion.release(1800)
    frames.run(120)
    expect(closed).toBe(2)
  })

  it('a finger catches the spring in flight and continues from there', () => {
    motion.present()
    frames.run(4)
    const caught = motion.current.progress
    expect(caught).toBeGreaterThan(0)
    expect(caught).toBeLessThan(1)
    expect(motion.beginDrag()).toBe(true)
    expect(motion.current).toEqual({ phase: 'dragging', progress: caught })
    expect(frames.scheduled).toBe(false)
    motion.drag(-caught * 500)
    expect(motion.current.progress).toBeCloseTo(0, 5)
    motion.release(0)
    frames.run(120)
    expect(motion.current).toEqual({ phase: 'open', progress: 0 })
  })

  it('is driven by the system back gesture: peek, then commit or cancel', () => {
    motion.present()
    frames.run(120)
    motion.backProgress(0.5)
    expect(last()).toEqual({ phase: 'dragging', progress: 0.5 * BACK_PEEK })
    motion.backProgress(2)
    expect(last().progress).toBe(BACK_PEEK)
    motion.backCancel()
    frames.run(120)
    expect(motion.current).toEqual({ phase: 'open', progress: 0 })
    expect(closed).toBe(0)

    motion.backProgress(1)
    motion.backCommit()
    expect(last().phase).toBe('settling')
    frames.run(120)
    expect(motion.current).toEqual(SHEET_CLOSED)
    expect(closed).toBe(1)
  })

  it('ignores gestures while closed and closes at once on demand', () => {
    expect(motion.beginDrag()).toBe(false)
    motion.drag(50)
    motion.release(0)
    motion.backProgress(0.5)
    motion.backCommit()
    motion.dismiss()
    expect(states).toEqual([])
    expect(closed).toBe(0)

    motion.present()
    frames.run(2)
    motion.close()
    expect(motion.current).toEqual(SHEET_CLOSED)
    expect(closed).toBe(1)
    expect(frames.scheduled).toBe(false)
    motion.close()
    expect(closed).toBe(1)
  })
})

// A phone: 914 CSS px tall layer, 24 px of status bar.
const layer = 914
const insetTop = 24
const two = computeDetents(1000, layer, insetTop)

describe('computeDetents', () => {
  it('a tall sheet peeks at about half the screen and expands to the top margin', () => {
    expect(two.collapsed).toBe(Math.round(layer * 0.52))
    expect(two.expanded).toBe(sheetMaxHeight(layer, insetTop))
    expect(two.expanded).toBeLessThan(layer - insetTop)
  })

  it('content that fits gets a single detent at its own height', () => {
    const one = computeDetents(320, layer, insetTop)
    expect(one).toEqual({ collapsed: 320, expanded: 320 })
  })

  it('content barely taller than the peek is not worth a second stop', () => {
    const peek = Math.round(layer * 0.52)
    const one = computeDetents(peek + 40, layer, insetTop)
    expect(one.collapsed).toBe(one.expanded)
    expect(one.expanded).toBe(peek + 40)
  })

  it('never asks for more than the layer minus the inset and margin', () => {
    expect(computeDetents(5000, layer, insetTop).expanded).toBe(sheetMaxHeight(layer, insetTop))
    expect(sheetMaxHeight(100, 200)).toBe(0)
  })
})

describe('sheetFrame', () => {
  it('between the detents the sheet grows in place and the scrim is fully on', () => {
    const at = sheetFrame(600, two)
    expect(at).toEqual({ height: 600, translateY: 0, scrim: 1 })
    expect(sheetFrame(two.expanded, two).height).toBe(two.expanded)
  })

  it('below the peek detent the sheet slides down whole and the scrim thins with it', () => {
    const half = sheetFrame(two.collapsed / 2, two)
    expect(half.height).toBe(two.collapsed)
    expect(half.translateY).toBe(two.collapsed / 2)
    expect(half.scrim).toBeCloseTo(0.5)
    const gone = sheetFrame(0, two)
    expect(gone.translateY).toBe(two.collapsed)
    expect(gone.scrim).toBe(0)
  })

  it('an overshooting spring below zero reads as fully off screen', () => {
    expect(sheetFrame(-12, two)).toEqual(sheetFrame(0, two))
  })
})

describe('sheetDragPosition', () => {
  it('follows the finger one to one between the detents', () => {
    expect(sheetDragPosition(two.collapsed, 100, two)).toBe(two.collapsed + 100)
    expect(sheetDragPosition(two.collapsed, -100, two)).toBe(two.collapsed - 100)
  })

  it('cannot be pushed below the screen edge', () => {
    expect(sheetDragPosition(two.collapsed, -two.collapsed - 300, two)).toBe(0)
  })

  it('resists past the expanded detent and never stretches more than the overdrag', () => {
    const a = sheetDragPosition(two.expanded, 60, two)
    const b = sheetDragPosition(two.expanded, 400, two)
    expect(a).toBeGreaterThan(two.expanded)
    expect(a).toBeLessThan(two.expanded + 60)
    expect(b).toBeGreaterThan(a)
    expect(b).toBeLessThan(two.expanded + SHEET_OVERDRAG)
  })
})

describe('settleDetent', () => {
  it('a slow release goes to the nearest detent', () => {
    expect(settleDetent(two.collapsed + 40, 0, two)).toBe(two.collapsed)
    expect(settleDetent(two.expanded - 40, 0, two)).toBe(two.expanded)
    expect(settleDetent(two.collapsed * 0.7, 0, two)).toBe(two.collapsed)
    expect(settleDetent(two.collapsed * 0.3, 0, two)).toBe(0)
  })

  it('a fling goes to the next detent in its own direction', () => {
    expect(settleDetent(two.collapsed + 20, 900, two)).toBe(two.expanded)
    expect(settleDetent(two.collapsed, 900, two)).toBe(two.expanded)
    expect(settleDetent(two.expanded - 20, -900, two)).toBe(two.collapsed)
    expect(settleDetent(two.expanded, -900, two)).toBe(two.collapsed)
    expect(settleDetent(two.collapsed, -900, two)).toBe(0)
  })

  it('a mid-drag reversal lands where the finger was heading, not where it started', () => {
    // Dragged most of the way up from the peek, then flicked back down: peek again.
    expect(settleDetent(two.expanded - 60, -700, two)).toBe(two.collapsed)
    // Pulled far down from the peek, then flicked back up: peek, not dismissed.
    expect(settleDetent(two.collapsed * 0.4, 700, two)).toBe(two.collapsed)
  })

  it('projects a slow velocity into the decision', () => {
    const mid = two.collapsed / 2
    expect(settleDetent(mid + 10, -300, two)).toBe(0)
    expect(settleDetent(mid - 10, 300, two)).toBe(two.collapsed)
  })

  it('a single-detent sheet only knows open and dismissed', () => {
    const one = computeDetents(320, layer, insetTop)
    expect(settleDetent(320, 900, one)).toBe(320)
    expect(settleDetent(320, -900, one)).toBe(0)
    expect(settleDetent(200, 0, one)).toBe(320)
    expect(settleDetent(100, 0, one)).toBe(0)
  })

  it('never settles above the expanded detent after an overdrag', () => {
    expect(settleDetent(two.expanded + 40, 1500, two)).toBe(two.expanded)
    expect(settleDetent(two.expanded + 40, 0, two)).toBe(two.expanded)
  })
})

describe('sheetBackPosition', () => {
  it('pulls the sheet down with the gesture but keeps it on screen', () => {
    expect(sheetBackPosition(500, 0)).toBe(500)
    expect(sheetBackPosition(500, 0.5)).toBe(500 * (1 - SHEET_BACK_TRAVEL / 2))
    expect(sheetBackPosition(500, 1)).toBe(500 * (1 - SHEET_BACK_TRAVEL))
    expect(sheetBackPosition(500, 1)).toBeGreaterThan(250)
  })

  it('clamps progress to the unit range', () => {
    expect(sheetBackPosition(500, -1)).toBe(500)
    expect(sheetBackPosition(500, 3)).toBe(sheetBackPosition(500, 1))
  })
})
