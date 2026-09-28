// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REDUCED_FADE_MS } from '../motion/fade'
import { LAYER_CLASS, LEAVING_CLASS, SlideMotion } from '../motion/slide'

/*
 * The list's departures (MOT-33; v2 §11.4's "a card closing"): a row gone from the list is
 * drawn out of it from where it stood – its element placed in the scroller's layer, in the
 * scroller's content coordinates (under its fades, scrolling with the rows), stripped of what
 * made it the row, clipped shut from its foot on the spring – while the rows below glide into
 * the gap on the same frame and the scroller's extent runs down with them, so the foot outside
 * it follows rather than jumps. The New Tab row under the list follows the list's layout
 * (`follow`): on a grow it glides from its old place on the rows' spring, its own FLIP; on a
 * shrink it rides the hold. Under reduced motion the picture fades where it stands and nothing
 * travels; the first commit (a restore) draws nothing. Every FLIP is read against where the rows
 * stood just before the commit (`record`, the panels' `SlideSnapshot`): the chrome moving under
 * the list between commits moves no row whose box the commit did not change.
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
/** The New Tab row's gap above it (`spaced`: `mt-0.5`). */
const FOOT_GAP = 2

interface Row {
  el: HTMLElement
  layout: { top: number }
}

/** Where the list stands in the window and how far it is scrolled: what the rows' boxes follow. */
interface Geometry {
  /** The scroller's top in the window (the chrome above it can move without a commit). */
  origin: { top: number }
  scrollTop: { value: number }
}

interface List extends Geometry {
  motion: SlideMotion
  host: HTMLElement
  scroller: HTMLElement
  /** The New Tab row in the foot under the scroller, a follower when the list is made with one. */
  newTab: HTMLElement
  rows: Row[]
  /** The scroller's natural height right now (the mock's; a test sets it as the layout would). */
  size: { height: number }
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

/**
 * The list's column: the scroller of rows, then the foot with the New Tab row; the rows laid out
 * along y. The scroller's box is its rows' extent, or the hold's floor while one is written (the
 * layout the floor makes); the New Tab row stands `FOOT_GAP` under it.
 */
function list(
  count: number,
  options: { batch?: number; leave?: boolean; follow?: boolean } = {}
): List {
  const host = document.createElement('div')
  const scroller = document.createElement('div')
  const rowsBox = document.createElement('div')
  const foot = document.createElement('div')
  const newTab = document.createElement('button')
  newTab.setAttribute('data-new-tab', '')
  host.append(scroller, foot)
  scroller.append(rowsBox)
  foot.append(newTab)
  document.body.append(host)
  const size = { height: count * SHIFT - GAP }
  const origin = { top: SCROLLER_TOP }
  const scrollTop = { value: 0 }
  const extent = (): number =>
    Math.max(size.height, Number.parseFloat(scroller.style.minHeight) || 0)
  Object.defineProperty(scroller, 'scrollTop', { get: () => scrollTop.value, configurable: true })
  host.getBoundingClientRect = () => rect(HOST_TOP, HOST_LEFT, 260, 600)
  scroller.getBoundingClientRect = () => rect(origin.top, SCROLLER_LEFT, 240, extent())
  newTab.getBoundingClientRect = () =>
    rect(
      origin.top + extent() + FOOT_GAP + translationOf(newTab.style.transform),
      ROW_LEFT,
      ROW_WIDTH,
      ROW
    )
  const motion = new SlideMotion('y', {
    enter: true,
    leave: options.leave ?? true,
    batch: options.batch ?? 3
  })
  motion.setScroller(scroller)
  if (options.follow) motion.follow('foot:new-tab', newTab)
  const geometry: Geometry = { origin, scrollTop }
  const rows: Row[] = []
  for (let i = 0; i < count; i++) {
    const r = row(i * SHIFT, geometry)
    rows.push(r)
    rowsBox.append(r.el)
    motion.attach(`r${i}`, r.el)
  }
  motion.flip()
  return { motion, host, scroller, newTab, rows, size, origin, scrollTop }
}

function row(top: number, g: Geometry, id = 'x'): Row {
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
      g.origin.top + layout.top - g.scrollTop.value + translationOf(el.style.transform),
      ROW_LEFT,
      ROW_WIDTH,
      ROW
    )
  return { el, layout }
}

/** Open a row at the end of the list: React appends the element and the foot moves down a slot. */
function grow(l: List): Row {
  const index = l.rows.length
  const fresh = row(index * SHIFT, l, `r${index}`)
  l.rows.push(fresh)
  l.scroller.firstElementChild?.append(fresh.el)
  l.size.height += SHIFT
  l.motion.attach(`r${index}`, fresh.el)
  return fresh
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

const layerOf = (l: List): HTMLElement | null => l.scroller.querySelector(`.${LAYER_CLASS}`)

describe('SlideMotion.leave', () => {
  it('draws the closed row out of the list from where it stood, the rows below gliding into the gap on the same frame', () => {
    const l = list(3)
    const el = close(l, 1)
    l.motion.flip()
    // The picture stands in the scroller's layer, in the row's box in the scroller's content
    // coordinates: the row's slot from the scroller's top, the row's left from the scroller's.
    const layer = layerOf(l)
    expect(layer).not.toBeNull()
    expect(layer?.parentElement).toBe(l.scroller)
    expect(layer?.getAttribute('aria-hidden')).toBe('true')
    expect(el.parentElement).toBe(layer)
    expect(el.classList.contains(LEAVING_CLASS)).toBe(true)
    expect(el.style.position).toBe('absolute')
    expect(el.style.top).toBe(`${SHIFT}px`)
    expect(el.style.left).toBe(`${ROW_LEFT - SCROLLER_LEFT}px`)
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
    // The layer goes with the last picture: the scroller's children are its rows' again.
    expect(layerOf(l)).toBeNull()
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

  it('holds the scroller’s box where it would shrink – the room the picture stood in – and runs it down with the departure, whole pixels, gone at rest', () => {
    const l = list(3)
    const before = 3 * SHIFT - GAP
    const after = 2 * SHIFT - GAP
    const el = close(l, 2)
    l.motion.flip()
    // Held where it stood at the commit: the foot has not moved, and the last row's picture –
    // at the foot of the scroller's content – has the scroller's box under all of it.
    expect(l.scroller.style.minHeight).toBe(`${before}px`)
    expect(el.style.top).toBe(`${2 * SHIFT}px`)
    expect(l.scroller.getBoundingClientRect().height).toBe(before)
    runFrames(1)
    const held = Number.parseFloat(l.scroller.style.minHeight)
    expect(held).toBeLessThan(before)
    expect(held).toBeGreaterThan(after)
    expect(Number.isInteger(held)).toBe(true)
    // The box gives up the slot (the row and its gap) as the picture gives up the row, on the
    // one spring: the picture's showing foot is never more than the gap past the box's edge.
    const shown = ROW - hiddenOf(el.style.clipPath)
    expect(held).toBeGreaterThanOrEqual(2 * SHIFT + shown - GAP)
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
    const layer = layerOf(l)
    close(l, 2)
    l.motion.flip()
    // No jump: the new run starts from the extent on screen, and the first picture goes on, the
    // second beside it in the one layer.
    expect(Number.parseFloat(l.scroller.style.minHeight)).toBe(reached)
    expect(picturesIn(l.host)).toHaveLength(2)
    expect(first?.isConnected).toBe(true)
    expect(layerOf(l)).toBe(layer)
    expect(picturesIn(l.host).every((p) => p.parentElement === layer)).toBe(true)
    settle()
    expect(picturesIn(l.host)).toHaveLength(0)
    expect(layerOf(l)).toBeNull()
    expect(l.scroller.style.minHeight).toBe('')
  })

  it('holds nothing when the scroller did not shrink (a list that still overflows): its box never shrinks, the picture scrolls with the rows under it', () => {
    const l = list(3)
    const el = close(l, 1)
    // The column clamps the scroller: its box is as tall as before.
    l.size.height += SHIFT
    l.motion.flip()
    expect(l.scroller.style.minHeight).toBe('')
    expect(picturesIn(l.host)).toHaveLength(1)
    expect(el.parentElement?.parentElement).toBe(l.scroller)
    expect(el.style.top).toBe(`${SHIFT}px`)
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
    const fresh = row(2 * SHIFT, l, 'r1')
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
    const back = row(SHIFT, l, 'r1')
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

  it('dispose removes every picture and the layer, and lets the scroller go', () => {
    const l = list(3)
    close(l, 1)
    l.motion.flip()
    runFrames(1)
    expect(picturesIn(l.host)).toHaveLength(1)
    l.motion.dispose()
    expect(picturesIn(l.host)).toHaveLength(0)
    expect(layerOf(l)).toBeNull()
    expect(l.scroller.style.minHeight).toBe('')
    expect(frames.size).toBe(0)
  })

  it('draws the picture in the scroller’s content: a list scrolled down places it in the row’s slot, where it was seen, scrolling with the rows', () => {
    const l = list(6)
    l.scrollTop.value = SHIFT
    // The rows are seen a slot higher than their layout; the list re-records nothing – the
    // scroll is the scroller's, not a commit's – so the close after it finds them as laid out,
    // and the picture in the row's slot of the content is seen a slot higher, as the row was.
    close(l, 3)
    l.motion.flip()
    const picture = picturesIn(l.host)[0]
    expect(picture?.style.top).toBe(`${3 * SHIFT}px`)
    settle()
  })

  it('a read before the commit (`record`) keeps the picture where the row was seen when the list was scrolled between commits', () => {
    const l = list(6)
    l.scrollTop.value = SHIFT
    l.motion.record()
    close(l, 3)
    l.motion.flip()
    // The record put the row at its layout plus the scroll: the same slot of the content.
    expect(picturesIn(l.host)[0]?.style.top).toBe(`${3 * SHIFT}px`)
    settle()
  })
})

describe('SlideMotion read before the commit', () => {
  it('a grow after the chrome moved under the list (the host’s insets landing after the first paint) moves no row whose box the commit did not change', () => {
    const l = list(3, { follow: true })
    // The status bar's inset lands after the first paint: the whole chrome, the list with it,
    // stands 24 lower, with no commit of the list's own.
    l.origin.top += 24
    // The panel reads the list where it stands just before the commit that grows it.
    l.motion.record()
    const fresh = grow(l)
    l.motion.flip()
    for (const r of l.rows.slice(0, 3)) expect(r.el.style.transform).toBe('')
    // The new row grows into its slot; the New Tab row glides down from where it stood.
    expect(hiddenOf(fresh.el.style.clipPath)).toBe(ROW)
    expect(translationOf(l.newTab.style.transform)).toBeCloseTo(-SHIFT, 3)
    settle()
    expect(l.newTab.style.transform).toBe('')
  })

  it('refreshes the boxes too: a row closed after the list moved is drawn out from where it stands now', () => {
    const l = list(3)
    l.origin.top += 24
    l.motion.record()
    const el = close(l, 1)
    l.motion.flip()
    // In the scroller's content coordinates the slot is the same; the row above wears nothing.
    expect(el.style.top).toBe(`${SHIFT}px`)
    expect(l.rows[0].el.style.transform).toBe('')
    expect(translationOf(l.rows[1].el.style.transform)).toBeCloseTo(SHIFT, 3)
    settle()
  })

  it('records nothing for rows the list has not placed yet, which enter as new', () => {
    const l = list(2)
    const fresh = grow(l)
    l.motion.record()
    l.motion.flip()
    expect(hiddenOf(fresh.el.style.clipPath)).toBe(ROW)
    settle()
  })
})

describe('SlideMotion.follow', () => {
  it('the New Tab row under the list follows a grow: its own FLIP from its old place on the rows’ spring, no hold', () => {
    const l = list(2, { follow: true })
    l.motion.record()
    const fresh = grow(l)
    l.motion.flip()
    // At the commit the row is drawn where it stood, a slot above its new place; nothing is
    // held (a grow has no hold).
    expect(translationOf(l.newTab.style.transform)).toBeCloseTo(-SHIFT, 3)
    expect(l.scroller.style.minHeight).toBe('')
    runFrames(1)
    // One spring: the way the row has come down and the part of the new row that shows are the
    // same fraction of their travel.
    const come = SHIFT + translationOf(l.newTab.style.transform)
    const shown = ROW - hiddenOf(fresh.el.style.clipPath)
    expect(come).toBeGreaterThan(0)
    expect(come / SHIFT).toBeCloseTo(shown / ROW, 3)
    settle()
    expect(l.newTab.style.transform).toBe('')
    // The follower is no item: nothing enters or leaves for it.
    expect(l.motion.has('foot:new-tab')).toBe(false)
  })

  it('on a shrink it rides the hold: the hold puts it back where it stood, so no FLIP of its own', () => {
    const l = list(3, { follow: true })
    l.motion.record()
    close(l, 2)
    l.motion.flip()
    expect(l.scroller.style.minHeight).toBe(`${3 * SHIFT - GAP}px`)
    expect(l.newTab.style.transform).toBe('')
    // The foot glides with the extent, on the hold.
    const at = l.newTab.getBoundingClientRect().top
    runFrames(1)
    expect(l.newTab.getBoundingClientRect().top).toBeLessThan(at)
    expect(l.newTab.style.transform).toBe('')
    settle()
    expect(l.newTab.getBoundingClientRect().top).toBe(SCROLLER_TOP + 2 * SHIFT - GAP + FOOT_GAP)
  })

  it('a close on the heels of a close: the foot is read where the hold has it, and the new hold picks it up there – no jump', () => {
    const l = list(4, { follow: true })
    l.motion.record()
    close(l, 3)
    l.motion.flip()
    runFrames(2)
    const seen = l.newTab.getBoundingClientRect().top
    l.motion.record()
    close(l, 2)
    l.motion.flip()
    expect(l.newTab.style.transform).toBe('')
    expect(Math.abs(l.newTab.getBoundingClientRect().top - seen)).toBeLessThan(1)
    settle()
  })

  it('a follower placed after the first commit is placed, not moved; let go, it wears nothing', () => {
    const l = list(2)
    const late = document.createElement('button')
    late.getBoundingClientRect = () => rect(400, ROW_LEFT, ROW_WIDTH, ROW)
    l.motion.follow('late', late)
    l.motion.flip()
    expect(late.style.transform).toBe('')
    late.getBoundingClientRect = () => rect(300, ROW_LEFT, ROW_WIDTH, ROW)
    l.motion.flip()
    expect(translationOf(late.style.transform)).toBeCloseTo(100, 3)
    l.motion.follow('late', null)
    expect(late.style.transform).toBe('')
    expect(frames.size).toBe(0)
  })

  it('under reduced motion the follower cuts to its place', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }))
    const l = list(2, { follow: true })
    l.motion.record()
    grow(l)
    l.motion.flip()
    expect(l.newTab.style.transform).toBe('')
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
    expect(el.parentElement).toBe(layerOf(l))
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
    const fresh = row(2 * SHIFT, l, 'r2')
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
