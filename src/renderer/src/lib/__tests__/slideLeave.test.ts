// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REDUCED_FADE_MS } from '../motion/fade'
import { LEAVING_CLASS, SlideMotion } from '../motion/slide'

/*
 * The list's departures (MOT-33; v2 §11.4's "a card closing"): a row gone from the list is
 * drawn out of it from where it stood – its element placed in the list's column, stripped of
 * what made it the row, clipped shut from its foot on the spring – while the rows below glide
 * into the gap on the same frame and the scroller's extent runs down with them, so the foot
 * outside it follows rather than jumps. Under reduced motion the picture fades where it stands
 * and nothing travels; the first commit (a restore) draws nothing.
 */

const ROW = 44
const GAP = 2
const SHIFT = ROW + GAP
const HOST_TOP = 60
const HOST_LEFT = 10
const SCROLLER_TOP = 100
const SCROLLER_LEFT = 20
const ROW_LEFT = 28
const ROW_WIDTH = 200

interface Row {
  el: HTMLElement
  layout: { top: number }
}

interface List {
  motion: SlideMotion
  host: HTMLElement
  scroller: HTMLElement
  rows: Row[]
  /** The scroller's natural height right now (the mock's; a test sets it as the layout would). */
  size: { height: number }
  scrollTop: { value: number }
}

function translationOf(transform: string): number {
  const m = /translateY\((-?[\d.]+)px\)/.exec(transform)
  return m ? Number(m[1]) : 0
}

function hiddenOf(clipPath: string): number {
  const m = /inset\(0(?:px)? 0(?:px)? (-?[\d.]+)px 0(?:px)?\)/.exec(clipPath)
  return m ? Number(m[1]) : 0
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

function settle(max = 600): number {
  let n = 0
  while (frames.size > 0 && n < max) {
    runFrames(1)
    n++
  }
  return n
}

function rect(top: number, left: number, width: number, height: number): DOMRect {
  return {
    top,
    left,
    width,
    height,
    bottom: top + height,
    right: left + width,
    x: left,
    y: top,
    toJSON: () => ({})
  } as DOMRect
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
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

/** The list's column: the scroller of rows, then the foot; the rows laid out along y. */
function list(count: number, options: { batch?: number; leave?: boolean } = {}): List {
  const host = document.createElement('div')
  const scroller = document.createElement('div')
  const rowsBox = document.createElement('div')
  const foot = document.createElement('div')
  host.append(scroller, foot)
  scroller.append(rowsBox)
  document.body.append(host)
  const size = { height: count * SHIFT - GAP }
  const scrollTop = { value: 0 }
  Object.defineProperty(scroller, 'scrollTop', { get: () => scrollTop.value, configurable: true })
  host.getBoundingClientRect = () => rect(HOST_TOP, HOST_LEFT, 260, 600)
  scroller.getBoundingClientRect = () => rect(SCROLLER_TOP, SCROLLER_LEFT, 240, size.height)
  const motion = new SlideMotion('y', {
    enter: true,
    leave: options.leave ?? true,
    batch: options.batch ?? 3
  })
  motion.setScroller(scroller)
  const rows: Row[] = []
  for (let i = 0; i < count; i++) {
    const r = row(i * SHIFT, scrollTop)
    rows.push(r)
    rowsBox.append(r.el)
    motion.attach(`r${i}`, r.el)
  }
  motion.flip()
  return { motion, host, scroller, rows, size, scrollTop }
}

function row(top: number, scrollTop: { value: number }, id = 'x'): Row {
  const el = document.createElement('div')
  el.className = 'zen-tab group ml-5'
  el.setAttribute('data-tab-id', id)
  el.setAttribute('data-strip-item', `tab:${id}`)
  el.setAttribute('data-testid', 'tab')
  el.setAttribute('role', 'tab')
  el.setAttribute('tabindex', '-1')
  const layout = { top }
  el.getBoundingClientRect = () =>
    rect(
      SCROLLER_TOP + layout.top - scrollTop.value + translationOf(el.style.transform),
      ROW_LEFT,
      ROW_WIDTH,
      ROW
    )
  return { el, layout }
}

/** Close `index`: React drops the element and the rows below move up a slot in the layout. */
function close(l: List, index: number): HTMLElement {
  const gone = l.rows[index]
  l.motion.attach(`r${index}`, null)
  gone.el.remove()
  l.rows.splice(index, 1)
  for (let i = index; i < l.rows.length; i++) l.rows[i].layout.top -= SHIFT
  l.size.height -= SHIFT
  return gone.el
}

const picturesIn = (host: HTMLElement): HTMLElement[] => [
  ...host.querySelectorAll<HTMLElement>(`.${LEAVING_CLASS}`)
]

describe('SlideMotion.leave', () => {
  it('draws the closed row out of the list from where it stood, the rows below gliding into the gap on the same frame', () => {
    const l = list(3)
    const el = close(l, 1)
    l.motion.flip()
    // The picture stands in the column, in the row's box: the scroller's top plus the row's
    // slot, against the column's top; the row's left against the column's left.
    expect(el.parentElement).toBe(l.host)
    expect(el.classList.contains(LEAVING_CLASS)).toBe(true)
    expect(el.style.position).toBe('absolute')
    expect(el.style.top).toBe(`${SCROLLER_TOP + SHIFT - HOST_TOP}px`)
    expect(el.style.left).toBe(`${ROW_LEFT - HOST_LEFT}px`)
    expect(el.style.height).toBe(`${ROW}px`)
    expect(el.style.width).toBe(`${ROW_WIDTH}px`)
    expect(el.style.margin).toBe('0px')
    expect(l.motion.isLeaving('r1')).toBe(true)
    // Whole at the commit, the row below still at its old place: nothing has jumped.
    expect(hiddenOf(el.style.clipPath)).toBe(0)
    expect(translationOf(l.rows[1].el.style.transform)).toBeCloseTo(SHIFT, 3)
    runFrames(1)
    // One spring value: the part of the picture clipped away and the way the row below has
    // come are the same fraction of their travel.
    const hidden = hiddenOf(el.style.clipPath)
    const come = SHIFT - translationOf(l.rows[1].el.style.transform)
    expect(hidden).toBeGreaterThan(0)
    expect(hidden / ROW).toBeCloseTo(come / SHIFT, 3)
    expect(Number(el.style.opacity)).toBeCloseTo(1 - hidden / ROW, 3)
    // The row's own eases are held off while the spring writes (§11.1's one value).
    expect(el.style.transition).toBe('none')
    expect(el.style.willChange).toBe('clip-path, opacity')
    settle()
    expect(el.isConnected).toBe(false)
    expect(picturesIn(l.host)).toHaveLength(0)
    expect(l.motion.isLeaving('r1')).toBe(false)
    expect(translationOf(l.rows[1].el.style.transform)).toBe(0)
  })

  it('strips the picture of what made it the row: no id, no role, no key, no test id; hidden and inert', () => {
    const l = list(3)
    const el = close(l, 1)
    l.motion.flip()
    for (const name of [
      'data-tab-id',
      'data-strip-item',
      'data-testid',
      'role',
      'tabindex',
      'aria-describedby'
    ])
      expect(el.hasAttribute(name)).toBe(false)
    expect(el.getAttribute('aria-hidden')).toBe('true')
    expect(el.hasAttribute('inert')).toBe(true)
    expect(l.host.querySelectorAll('[data-testid="tab"]')).toHaveLength(2)
    settle()
  })

  it('runs the scroller’s extent down with the departure, whole pixels, and lets it go at rest', () => {
    const l = list(3)
    const before = 3 * SHIFT - GAP
    const after = 2 * SHIFT - GAP
    close(l, 2)
    l.motion.flip()
    // Held where it stood at the commit: the foot has not moved.
    expect(l.scroller.style.minHeight).toBe(`${before}px`)
    runFrames(1)
    const held = Number.parseFloat(l.scroller.style.minHeight)
    expect(held).toBeLessThan(before)
    expect(held).toBeGreaterThan(after)
    expect(Number.isInteger(held)).toBe(true)
    settle()
    expect(l.scroller.style.minHeight).toBe('')
  })

  it('a close on the heels of a close picks the extent up where the hold had brought it', () => {
    const l = list(4)
    close(l, 3)
    l.motion.flip()
    runFrames(2)
    const reached = Number.parseFloat(l.scroller.style.minHeight)
    const first = picturesIn(l.host)[0]
    close(l, 2)
    l.motion.flip()
    // No jump: the new run starts from the extent on screen, and the first picture goes on.
    expect(Number.parseFloat(l.scroller.style.minHeight)).toBe(reached)
    expect(picturesIn(l.host)).toHaveLength(2)
    expect(first?.isConnected).toBe(true)
    settle()
    expect(picturesIn(l.host)).toHaveLength(0)
    expect(l.scroller.style.minHeight).toBe('')
  })

  it('holds nothing when the scroller did not shrink (a list that still overflows)', () => {
    const l = list(3)
    close(l, 1)
    // The column clamps the scroller: its box is as tall as before.
    l.size.height += SHIFT
    l.motion.flip()
    expect(l.scroller.style.minHeight).toBe('')
    expect(picturesIn(l.host)).toHaveLength(1)
    settle()
  })

  it('draws no picture for rows whose departure is another motion’s (a fold), and no hold', () => {
    const l = list(3)
    l.motion.dropNext(['r1'])
    close(l, 1)
    l.motion.flip()
    expect(picturesIn(l.host)).toHaveLength(0)
    expect(l.scroller.style.minHeight).toBe('')
    // The neighbours still glide.
    expect(translationOf(l.rows[1].el.style.transform)).toBeCloseTo(SHIFT, 3)
    settle()
    // The mark is spent: a later departure of the same id leaves as usual.
    const fresh = row(2 * SHIFT, l.scrollTop, 'r1')
    l.rows.push(fresh)
    l.scroller.firstElementChild?.append(fresh.el)
    l.size.height += SHIFT
    l.motion.attach('r1', fresh.el)
    l.motion.flip()
    settle()
    close(l, 2)
    l.motion.flip()
    expect(picturesIn(l.host)).toHaveLength(1)
    settle()
  })

  it('lets a batch leave without pictures (a space cleared)', () => {
    const l = list(5, { batch: 3 })
    for (let i = 4; i >= 1; i--) close(l, i)
    l.motion.flip()
    expect(picturesIn(l.host)).toHaveLength(0)
    expect(l.scroller.style.minHeight).toBe('')
    expect(frames.size).toBe(0)
  })

  it('draws no picture of the row in the hand, of the still row, or when told not to animate', () => {
    const lifted = list(3)
    lifted.rows[1].el.setAttribute('data-lifted', '')
    close(lifted, 1)
    lifted.motion.flip()
    expect(picturesIn(lifted.host)).toHaveLength(0)
    settle()

    const still = list(3)
    close(still, 1)
    still.motion.flip('r1')
    expect(picturesIn(still.host)).toHaveLength(0)
    settle()

    const away = list(3)
    close(away, 1)
    away.motion.flip(null, false)
    expect(picturesIn(away.host)).toHaveLength(0)
    expect(away.scroller.style.minHeight).toBe('')
    expect(frames.size).toBe(0)
  })

  it('draws nothing out of a list without `leave`', () => {
    const l = list(3, { leave: false })
    const el = close(l, 1)
    l.motion.flip()
    expect(el.isConnected).toBe(false)
    expect(picturesIn(l.host)).toHaveLength(0)
    expect(l.scroller.style.minHeight).toBe('')
    settle()
  })

  it('ends the picture at once when the row comes back (a close undone), which enters as new', () => {
    const l = list(3)
    const gone = close(l, 1)
    l.motion.flip()
    runFrames(2)
    expect(gone.isConnected).toBe(true)
    const back = row(SHIFT, l.scrollTop, 'r1')
    l.rows.splice(1, 0, back)
    l.rows[2].layout.top = 2 * SHIFT
    l.size.height += SHIFT
    l.scroller.firstElementChild?.append(back.el)
    l.motion.attach('r1', back.el)
    expect(gone.isConnected).toBe(false)
    expect(l.motion.isLeaving('r1')).toBe(false)
    l.motion.flip()
    expect(hiddenOf(back.el.style.clipPath)).toBeGreaterThan(0)
    settle()
    expect(back.el.style.clipPath).toBe('')
  })

  it('dispose removes every picture and lets the scroller go', () => {
    const l = list(3)
    close(l, 1)
    l.motion.flip()
    runFrames(1)
    expect(picturesIn(l.host)).toHaveLength(1)
    l.motion.dispose()
    expect(picturesIn(l.host)).toHaveLength(0)
    expect(l.scroller.style.minHeight).toBe('')
    expect(frames.size).toBe(0)
  })

  it('draws the picture against the scroll: a list scrolled down places it where the row was seen', () => {
    const l = list(6)
    l.scrollTop.value = SHIFT
    // The rows are seen a slot higher than their layout; the list re-records nothing – the
    // scroll is the scroller's, not a commit's – so the close after it finds them as laid out.
    close(l, 3)
    l.motion.flip()
    const picture = picturesIn(l.host)[0]
    expect(picture?.style.top).toBe(`${SCROLLER_TOP + 3 * SHIFT - SHIFT - HOST_TOP}px`)
    settle()
  })
})

describe('SlideMotion under reduced motion', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }))
  })

  it('fades the closed row where it stands – no clip, no travel, no hold – and removes it after 120 ms', () => {
    const l = list(3)
    const el = close(l, 1)
    l.motion.flip()
    expect(el.parentElement).toBe(l.host)
    expect(el.style.clipPath).toBe('')
    expect(Number(el.style.opacity)).toBe(1)
    // The neighbours cut to their slots; the scroller's extent is the layout's.
    expect(translationOf(l.rows[1].el.style.transform)).toBe(0)
    expect(l.scroller.style.minHeight).toBe('')
    runFrames(3)
    const partway = Number(el.style.opacity)
    expect(partway).toBeGreaterThan(0)
    expect(partway).toBeLessThan(1)
    expect(el.style.clipPath).toBe('')
    runFrames(Math.ceil(REDUCED_FADE_MS / 16) + 1)
    expect(el.isConnected).toBe(false)
    expect(l.motion.isLeaving('r1')).toBe(false)
  })

  it('fades a new row in where it stands, no growth', () => {
    const l = list(2)
    const fresh = row(2 * SHIFT, l.scrollTop, 'r2')
    l.scroller.firstElementChild?.append(fresh.el)
    l.motion.attach('r2', fresh.el)
    l.motion.flip()
    expect(fresh.el.style.clipPath).toBe('')
    expect(Number(fresh.el.style.opacity)).toBe(0)
    runFrames(3)
    expect(Number(fresh.el.style.opacity)).toBeGreaterThan(0)
    runFrames(Math.ceil(REDUCED_FADE_MS / 16) + 1)
    expect(fresh.el.style.opacity).toBe('')
    expect(fresh.el.style.clipPath).toBe('')
  })
})

describe('SlideMotion at the first commit', () => {
  it('mounts restored rows settled: no clip, no fade, no hold, no frame (the boot path)', () => {
    const l = list(3)
    for (const r of l.rows) {
      expect(r.el.style.clipPath).toBe('')
      expect(r.el.style.opacity).toBe('')
      expect(r.el.style.transition).toBe('')
      expect(r.el.style.transform).toBe('')
    }
    expect(l.scroller.style.minHeight).toBe('')
    expect(picturesIn(l.host)).toHaveLength(0)
    expect(frames.size).toBe(0)
  })

  it('a list shown for the first time with rows already gone from it draws them as they are', () => {
    // A panel laid out off screen (recorded, not animated) whose rows changed while it was
    // away: the commit that shows it neither springs nor shrinks anything.
    const l = list(3)
    close(l, 1)
    l.motion.flip(null, false)
    expect(picturesIn(l.host)).toHaveLength(0)
    expect(translationOf(l.rows[1].el.style.transform)).toBe(0)
    expect(l.scroller.style.minHeight).toBe('')
    expect(frames.size).toBe(0)
  })
})
