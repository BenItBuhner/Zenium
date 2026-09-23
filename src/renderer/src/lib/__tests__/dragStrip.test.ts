// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, UIState } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { dropStore, listMotions, registerCaret, startTabDrag } from '../drag'
import { SlideMotion } from '../motion/slide'
import { STRIP_TEAR_PAST } from '../tabStripLayout'
import { browserStore, uiStore } from '../ui'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

/*
 * The mouse's drag with the tabs along the caption band (v2 §9.37): the same session as the
 * sidebar's, read along x – the slot from the tabs' horizontal midpoints, the neighbours
 * sliding along the strip, the caret upright in the gap 4 inside the row's top and bottom –
 * and the band's own way out: a tab pulled more than 16 under the band leaves the window,
 * where in the sidebar only the page tears a tab off. Laid out by hand: the band with three
 * tabs from x 8 (no gap: happy-dom computes none), the rail and the frame under it.
 */

const TAB = 177
const ROW = 32
const BAND = 38
const FRAME_TOP = 82
const RAIL = 56

let frames: Array<(now: number) => void> = []
let now = 1000
const frame = (): void => {
  now += 16
  const batch = frames
  frames = []
  for (const cb of batch) cb(now)
}
const settle = (max = 600): void => {
  for (let i = 0; i < max && frames.length; i++) frame()
}

function tab(id: string): Tab {
  return {
    id,
    spaceId: 'space',
    containerId: 'default',
    url: `https://${id}.test/`,
    title: id,
    favicon: null,
    pinned: false,
    essential: false,
    folderId: null,
    discarded: false,
    frozen: false
  } as unknown as Tab
}

function state(): UIState {
  return {
    platform: 'linux',
    spaces: [
      {
        id: 'space',
        name: 'Work',
        icon: '',
        containerId: 'default',
        theme: null,
        tabIds: ['a', 'b', 'c'],
        activeTabId: 'a',
        pinnedCollapsed: false
      }
    ],
    activeSpaceId: 'space',
    tabs: { a: tab('a'), b: tab('b'), c: tab('c') },
    essentialTabIds: [],
    folders: {},
    settings: { containerSpecificEssentials: false, toolbarLayout: 'horizontal' }
  } as unknown as UIState
}

interface Layout {
  band: HTMLElement
  rail: HTMLElement
  rows: Record<string, HTMLElement>
  page: HTMLElement
  caret: HTMLElement
}

let layout: Layout
let motion: SlideMotion
const boxes: Array<[HTMLElement, DOMRect]> = []

function box(el: HTMLElement, x: number, y: number, width: number, height: number): void {
  const rect = new DOMRect(x, y, width, height)
  el.getBoundingClientRect = () => rect
  boxes.push([el, rect])
}

const translateX = (el: HTMLElement): number => {
  const m = /^translateX\((-?[\d.]+)px\)$/.exec(el.style.transform)
  return m ? Number(m[1]) : 0
}

/** A row's box follows the translation the motion writes, as a real layout's would. */
function rowBox(el: HTMLElement, x: number, y: number, width: number, height: number): void {
  el.getBoundingClientRect = () => new DOMRect(x + translateX(el), y, width, height)
  boxes.push([el, new DOMRect(x, y, width, height)])
}

/** The tabs at x 8, 185, 362 in the band's row (y 6–38); the rail and the frame from y 82. */
function build(): Layout {
  const band = document.createElement('div')
  band.dataset.tabStrip = ''
  const scroller = document.createElement('div')
  scroller.dataset.tabScroller = ''
  const list = document.createElement('div')
  list.dataset.tabList = 'regular'
  const rows: Record<string, HTMLElement> = {}
  motion = new SlideMotion('x', { scroller })
  for (const id of ['a', 'b', 'c']) {
    const row = document.createElement('div')
    row.className = 'zen-tab'
    row.dataset.tabId = id
    list.appendChild(row)
    rows[id] = row
    motion.attach(id, row)
  }
  scroller.appendChild(list)
  band.appendChild(scroller)
  const rail = document.createElement('aside')
  rail.dataset.rail = ''
  const page = document.createElement('div')
  page.dataset.tearZone = ''
  const caret = document.createElement('div')
  document.body.append(band, rail, page, caret)
  listMotions.set(scroller, motion)
  registerCaret(caret)
  // Most specific first: `elementFromPoint` answers with the first box under the point.
  Object.values(rows).forEach((row, i) => rowBox(row, 8 + i * TAB, 6, TAB, ROW))
  box(list, 8, 6, 3 * TAB, ROW)
  box(scroller, 8, 6, 1400, ROW)
  box(band, 0, 0, 1600, BAND)
  box(rail, 0, FRAME_TOP, RAIL, 1000 - FRAME_TOP)
  box(page, RAIL, FRAME_TOP, 1600 - RAIL - 8, 1000 - FRAME_TOP - 8)
  return { band, rail, rows, page, caret }
}

const under = (x: number, y: number): Element | null =>
  boxes.find(([, r]) => x >= r.left && x < r.right && y >= r.top && y < r.bottom)?.[0] ?? null

const POINTER = 7
const pointer = (type: string, x: number, y: number): void => {
  window.dispatchEvent(
    new PointerEvent(type, { clientX: x, clientY: y, pointerId: POINTER, pointerType: 'mouse' })
  )
}

/** Grab `id` by the mouse at the row's centre and move 8 right: past the 5 px threshold. */
function grab(id: string): void {
  const row = layout.rows[id]!
  const r = row.getBoundingClientRect()
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  startTabDrag(tab(id), {
    button: 0,
    pointerType: 'mouse',
    pointerId: POINTER,
    currentTarget: row,
    clientX: x,
    clientY: y,
    timeStamp: now
  } as unknown as React.PointerEvent)
  pointer('pointermove', x + 8, y)
}

const calls = (name: string): unknown[] =>
  vi
    .mocked(run)
    .mock.calls.filter(([n]) => n === name)
    .map(([, args]) => args)

/** The caret's centre along the strip: its 2 px line drawn 1 short of it. */
const caretCentre = (): number => {
  const m = /^translate3d\((-?[\d.]+)px, 0, 0\)$/.exec(layout.caret.style.transform)
  expect(m, layout.caret.style.transform).not.toBeNull()
  return Number(m?.[1]) + 1
}

beforeEach(() => {
  frames = []
  now = 1000
  boxes.length = 0
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
    frames.push(cb)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.splice(id - 1, 1)
  })
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true, writable: true })
  document.elementFromPoint = under
  layout = build()
  browserStore.set({ state: state() })
  uiStore.set({ drag: null, snapshot: null, snapshotTabId: null })
  dropStore.set({ key: null, ghost: 'row', zones: false, page: false })
})

afterEach(() => {
  // Whatever a test left in the hand is let go, and its settle runs out.
  pointer('pointercancel', 0, 0)
  settle()
  vi.advanceTimersByTime(500)
  settle()
  motion.dispose()
  registerCaret(null)
  layout.band.remove()
  layout.rail.remove()
  layout.page.remove()
  layout.caret.remove()
  browserStore.set({ state: null })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.mocked(run).mockClear()
  vi.mocked(cmd).mockClear()
})

describe('a tab dragged along the strip', () => {
  it('opens the session on the row and counts the band as the window’s own chrome', () => {
    grab('b')
    expect(uiStore.get().drag).toMatchObject({ tabId: 'b', remote: false, width: TAB, height: ROW })
    expect(run).toHaveBeenCalledWith('tab.dragStart', { tabId: 'b' })
    expect(calls('tab.dragMove').at(-1)).toMatchObject({ tabId: 'b', inSidebar: true })
  })

  it('reads the slot from the tabs’ horizontal midpoints and slides the neighbour along x', () => {
    grab('b')
    // The pointer over the right half of c: b would land after c.
    pointer('pointermove', 8 + 2 * TAB + TAB * 0.75, 22)
    expect(dropStore.get()).toMatchObject({ key: 'tab:c:after', ghost: 'row', page: false })
    // c glides left into b's hole along the strip, never down.
    expect(frames.length).toBeGreaterThan(0)
    settle()
    expect(translateX(layout.rows['c']!)).toBeCloseTo(-TAB, 3)
    expect(layout.rows['a']!.style.transform).toBe('')
  })

  it('stands the caret upright in the gap: 2 wide, 4 inside the row’s top and bottom, centred', () => {
    grab('b')
    const caret = layout.caret
    // Lifted, the caret marks the row's own slot: the centre of b's hole.
    expect(caret.style.opacity).toBe('1')
    expect(caret.style.width).toBe('2px')
    expect(caret.style.height).toBe(`${ROW - 8}px`)
    expect(caret.style.top).toBe('10px')
    expect(caretCentre()).toBe(8 + TAB + TAB / 2)
    // Named the slot after c, it glides there on the spring – never jumps – and stops in the
    // gap c opened: c's old end less half a tab.
    pointer('pointermove', 8 + 2 * TAB + TAB * 0.75, 22)
    expect(caretCentre()).toBe(8 + TAB + TAB / 2)
    frame()
    const partWay = caretCentre()
    expect(partWay).toBeGreaterThan(8 + TAB + TAB / 2)
    expect(partWay).toBeLessThan(8 + 3 * TAB - TAB / 2)
    settle()
    expect(caretCentre()).toBeCloseTo(8 + 3 * TAB - TAB / 2, 0)
    // The pointer still over the gap the neighbour opened keeps resolving to that gap.
    pointer('pointermove', 8 + 2 * TAB + TAB * 0.75, 22)
    expect(dropStore.get().key).toBe('tab:c:after')
  })

  it('let go in the slot drops the tab there', () => {
    grab('b')
    const x = 8 + 2 * TAB + TAB * 0.75
    pointer('pointermove', x, 22)
    pointer('pointerup', x, 22)
    expect(calls('tab.drop')).toEqual([{ tabId: 'b', key: 'tab:c:after' }])
    expect(calls('tab.dragEnd')).toEqual([{ tabId: 'b', x, y: 22, outcome: 'cancel' }])
    expect(uiStore.get().drag).toMatchObject({ settling: true })
    expect(layout.caret.style.opacity).toBe('0')
  })

  it('pulled under the band it stays a row for 16 px, then tears off', () => {
    grab('b')
    // Over the toolbar row, 12 under the band: nothing there is a target, and it is too near.
    pointer('pointermove', 600, BAND + STRIP_TEAR_PAST - 4)
    expect(dropStore.get()).toMatchObject({ key: null, ghost: 'row', page: false })
    // One px more than 16 under the band: the tab is leaving the window.
    pointer('pointermove', 600, BAND + STRIP_TEAR_PAST + 1)
    expect(dropStore.get().ghost).toBe('tearoff')
    expect(calls('tab.dragMove').at(-1)).toMatchObject({ inSidebar: false })
    pointer('pointerup', 600, BAND + STRIP_TEAR_PAST + 1)
    expect(calls('tab.drop')).toEqual([])
    expect(calls('tab.dragEnd')).toEqual([
      { tabId: 'b', x: 600, y: BAND + STRIP_TEAR_PAST + 1, outcome: 'release' }
    ])
  })

  it('over the page tears off as it always did', () => {
    grab('b')
    pointer('pointermove', 800, 500)
    expect(dropStore.get()).toMatchObject({ ghost: 'tearoff', page: true })
  })

  it('over the rail it is still in the window’s chrome, and the rail’s zones are offered', () => {
    grab('b')
    pointer('pointermove', RAIL / 2, 500)
    expect(dropStore.get()).toMatchObject({ key: null, ghost: 'row', zones: true })
    expect(calls('tab.dragMove').at(-1)).toMatchObject({ inSidebar: true })
  })

  it('Escape puts the row back and takes the caret down', () => {
    grab('b')
    pointer('pointermove', 8 + 2 * TAB + TAB * 0.75, 22)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(calls('tab.drop')).toEqual([])
    expect(calls('tab.dragEnd')).toEqual([
      expect.objectContaining({ tabId: 'b', outcome: 'cancel' })
    ])
    expect(layout.caret.style.opacity).toBe('0')
    expect(dropStore.get()).toMatchObject({ key: null, ghost: 'row' })
  })
})
