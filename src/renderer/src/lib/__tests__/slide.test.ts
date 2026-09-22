import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlideMotion } from '../motion/slide'

/**
 * A list of fake rows laid out along y: each knows where the layout puts it and reports its
 * drawn place (layout plus the translation the motion wrote into its style).
 */
interface FakeRow {
  el: HTMLElement
  style: { transform: string; clipPath: string; opacity: string }
  layout: { top: number; height: number }
}

const ROW = 36
const GAP = 2
const SHIFT = ROW + GAP

function translationOf(style: { transform: string }): number {
  const m = /translateY\((-?[\d.]+)px\)/.exec(style.transform)
  return m ? Number(m[1]) : 0
}

function row(top: number): FakeRow {
  const style = { transform: '', clipPath: '', opacity: '' }
  const layout = { top, height: ROW }
  const el = {
    style,
    getBoundingClientRect: () => {
      const y = layout.top + translationOf(style)
      return { top: y, bottom: y + layout.height, left: 0, right: 200, width: 200, height: ROW }
    }
  } as unknown as HTMLElement
  return { el, style, layout }
}

/** Frame clock: the springs' animation frames, run by hand. */
const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 1
let now = 0

function runFrames(count: number, dt = 16): void {
  for (let i = 0; i < count; i++) {
    now += dt
    const due = [...frames.entries()]
    frames.clear()
    for (const [, cb] of due) cb(now)
  }
}

/** Run frames until no spring asks for another (or `max` frames pass). */
function settle(max = 600): number {
  let n = 0
  while (frames.size > 0 && n < max) {
    runFrames(1)
    n++
  }
  return n
}

beforeEach(() => {
  frames.clear()
  nextFrame = 1
  now = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    const id = nextFrame++
    frames.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    frames.delete(id)
  })
  vi.stubGlobal('performance', { now: () => now })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function list(count: number): { motion: SlideMotion; rows: FakeRow[] } {
  const motion = new SlideMotion('y', { enter: true, batch: 3 })
  const rows: FakeRow[] = []
  for (let i = 0; i < count; i++) {
    const r = row(i * SHIFT)
    rows.push(r)
    motion.attach(`r${i}`, r.el)
  }
  motion.flip()
  return { motion, rows }
}

describe('SlideMotion.slide', () => {
  it('springs the named rows to their offsets and the rest home', () => {
    const { motion, rows } = list(4)
    motion.slide(new Map([['r3', -SHIFT]]))
    expect(frames.size).toBeGreaterThan(0)
    settle()
    expect(translationOf(rows[3].style)).toBeCloseTo(-SHIFT, 3)
    expect(translationOf(rows[2].style)).toBe(0)
    motion.slide(new Map())
    settle()
    expect(translationOf(rows[3].style)).toBe(0)
  })

  it('retargets a row mid-flight instead of restarting it', () => {
    const { motion, rows } = list(3)
    motion.slide(new Map([['r1', SHIFT]]))
    runFrames(3)
    const partway = translationOf(rows[1].style)
    expect(partway).toBeGreaterThan(0)
    expect(partway).toBeLessThan(SHIFT)
    motion.slide(new Map())
    runFrames(1)
    // It turns back from where it was, not from the far end.
    expect(translationOf(rows[1].style)).toBeLessThan(SHIFT / 2)
    settle()
    expect(translationOf(rows[1].style)).toBe(0)
  })

  it('reports resting and drawn rects apart while a row slides', () => {
    const { motion, rows } = list(2)
    vi.stubGlobal(
      'DOMRect',
      class {
        constructor(
          public x: number,
          public y: number,
          public width: number,
          public height: number
        ) {}
        get top(): number {
          return this.y
        }
        get left(): number {
          return this.x
        }
      }
    )
    motion.slide(new Map([['r1', -SHIFT]]))
    settle()
    expect(rows[1].el.getBoundingClientRect().top).toBeCloseTo(0, 3)
    expect(motion.restingRect('r1')?.top).toBeCloseTo(SHIFT, 3)
    expect(motion.visualRect('r1')?.top).toBeCloseTo(0, 3)
    expect(motion.offsetOf('r1')).toBeCloseTo(-SHIFT, 3)
  })
})

describe('SlideMotion.flip', () => {
  it('keeps a row where it was drawn and springs it to its new slot', () => {
    const { motion, rows } = list(3)
    // r0 closed: r1 and r2 move up one slot in the layout.
    motion.attach('r0', null)
    rows[1].layout.top = 0
    rows[2].layout.top = SHIFT
    motion.flip()
    // First paint: still at the old place.
    expect(translationOf(rows[1].style)).toBeCloseTo(SHIFT, 3)
    expect(rows[1].el.getBoundingClientRect().top).toBeCloseTo(SHIFT, 3)
    settle()
    expect(translationOf(rows[1].style)).toBe(0)
    expect(translationOf(rows[2].style)).toBe(0)
  })

  it('has nothing left to do for rows that already slid to where the commit put them', () => {
    const { motion, rows } = list(3)
    motion.slide(new Map([['r2', -SHIFT]]))
    settle()
    // The drop commits: r1 (lifted) lands after r2, r2 takes r1's slot.
    rows[2].layout.top = SHIFT
    rows[1].layout.top = 2 * SHIFT
    motion.flip('r1')
    expect(translationOf(rows[2].style)).toBe(0)
    expect(translationOf(rows[1].style)).toBe(0)
    expect(frames.size).toBe(0)
  })

  it('catches a row still sliding and springs it on from there', () => {
    const { motion, rows } = list(3)
    motion.slide(new Map([['r2', -SHIFT]]))
    runFrames(2)
    const partway = translationOf(rows[2].style)
    expect(partway).toBeLessThan(0)
    expect(partway).toBeGreaterThan(-SHIFT)
    rows[2].layout.top = SHIFT
    rows[1].layout.top = 2 * SHIFT
    motion.flip('r1')
    // Drawn where it was a frame ago, against the new layout.
    expect(translationOf(rows[2].style)).toBeCloseTo(SHIFT + partway, 3)
    settle()
    expect(translationOf(rows[2].style)).toBe(0)
  })

  it('grows a new row into its slot once the list has been laid out before', () => {
    const { motion, rows } = list(2)
    const fresh = row(2 * SHIFT)
    motion.attach('r2', fresh.el)
    motion.flip()
    expect(fresh.style.clipPath).not.toBe('')
    expect(Number(fresh.style.opacity)).toBeLessThan(0.1)
    settle()
    expect(fresh.style.clipPath).toBe('')
    expect(fresh.style.opacity).toBe('')
    expect(translationOf(rows[0].style)).toBe(0)
  })

  it('carries a new row’s entry across a detach and re-attach of the same element (StrictMode)', () => {
    const { motion } = list(2)
    const fresh = row(2 * SHIFT)
    motion.attach('r2', fresh.el)
    motion.flip()
    runFrames(2)
    const midway = fresh.style.clipPath
    expect(midway).not.toBe('')
    // A dev build's StrictMode detaches the ref and attaches the element again at once.
    motion.attach('r2', null)
    motion.attach('r2', fresh.el)
    expect(fresh.style.clipPath).toBe(midway)
    expect(motion.has('r2')).toBe(true)
    settle()
    expect(fresh.style.clipPath).toBe('')
    expect(fresh.style.opacity).toBe('')
    // Its slot was kept too: the next commit finds it laid out, not new, so it does not grow again.
    motion.flip()
    expect(fresh.style.clipPath).toBe('')
    expect(frames.size).toBe(0)
  })

  it('draws a row whole when it is let go mid-entry, and grows the element that takes its id', () => {
    const { motion } = list(2)
    const first = row(2 * SHIFT)
    motion.attach('r2', first.el)
    motion.flip()
    runFrames(2)
    expect(first.style.clipPath).not.toBe('')
    // The row re-parented: its element goes, another with the same id arrives in the same commit.
    const second = row(2 * SHIFT)
    motion.attach('r2', null)
    motion.attach('r2', second.el)
    expect(first.style.clipPath).toBe('')
    expect(first.style.opacity).toBe('')
    motion.flip()
    expect(second.style.clipPath).not.toBe('')
    settle()
    expect(second.style.clipPath).toBe('')
  })

  it('lets a row that leaves for good go at the commit that follows', () => {
    const { motion } = list(2)
    const fresh = row(2 * SHIFT)
    motion.attach('r2', fresh.el)
    motion.flip()
    runFrames(2)
    motion.attach('r2', null)
    motion.flip()
    expect(fresh.style.clipPath).toBe('')
    expect(motion.has('r2')).toBe(false)
    settle()
    expect(frames.size).toBe(0)
  })

  it('places a batch of new rows without motion', () => {
    const { motion } = list(2)
    const batch = [3, 4, 5, 6].map((i) => row(i * SHIFT))
    batch.forEach((r, i) => motion.attach(`n${i}`, r.el))
    motion.flip()
    for (const r of batch) expect(r.style.clipPath).toBe('')
    expect(frames.size).toBe(0)
  })

  it('only records positions when told not to animate', () => {
    const { motion, rows } = list(2)
    rows[0].layout.top = SHIFT
    rows[1].layout.top = 0
    motion.flip(null, false)
    expect(translationOf(rows[0].style)).toBe(0)
    expect(frames.size).toBe(0)
  })

  it('releaseSoon slides rows home unless a commit lands first', () => {
    // Only the timers: the animation frames stay on the test's own clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { motion, rows } = list(2)
    motion.slide(new Map([['r1', -SHIFT]]))
    settle()
    motion.releaseSoon(100)
    rows[1].layout.top = 0
    rows[0].layout.top = SHIFT
    motion.flip('r0')
    vi.advanceTimersByTime(200)
    // The commit put r1 where it had slid: it stays, no timer moved it.
    expect(translationOf(rows[1].style)).toBe(0)
    motion.slide(new Map([['r1', SHIFT]]))
    settle()
    motion.releaseSoon(100)
    vi.advanceTimersByTime(200)
    settle()
    expect(translationOf(rows[1].style)).toBe(0)
    vi.useRealTimers()
  })
})
