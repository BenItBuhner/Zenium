import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACK_PEEK, SHEET_CLOSED, SheetMotion, type SheetState } from '../motion/sheet'

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
