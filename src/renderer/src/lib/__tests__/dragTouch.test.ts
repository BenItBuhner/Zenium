// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, UIState } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { dropStore, liftTabByTouch, listMotions, startTabDrag, type TouchTabDrag } from '../drag'
import { SlideMotion } from '../motion/slide'
import { browserStore, uiStore } from '../ui'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

/*
 * TABLET-02: a tab row lifted by a finger (`liftTabByTouch`) runs on the mouse's drag session –
 * the same slots, the same rows sliding open, the same `tab.drop` – with one difference: the
 * page and the window's edge are no target. A finger let go over the page puts the row back
 * where it was, where the mouse's release there tears the tab off into a new window, and the
 * core is never asked to follow the finger across windows (`tab.dragMove`). Laid out by hand: a
 * sidebar with three rows and the page beside it, with the geometry the session reads stubbed.
 */

const ROW = 36
const SIDEBAR_WIDTH = 240

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
    platform: 'android',
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
    settings: { containerSpecificEssentials: false }
  } as unknown as UIState
}

interface Layout {
  sidebar: HTMLElement
  scroller: HTMLElement
  list: HTMLElement
  rows: Record<string, HTMLElement>
  page: HTMLElement
}

let layout: Layout
let motion: SlideMotion
const boxes: Array<[HTMLElement, DOMRect]> = []

function box(el: HTMLElement, x: number, y: number, width: number, height: number): void {
  const rect = new DOMRect(x, y, width, height)
  el.getBoundingClientRect = () => rect
  boxes.push([el, rect])
}

/** The rows at y 100, 136, 172 (no row gap: happy-dom computes none); the page from x 240. */
function build(): Layout {
  const sidebar = document.createElement('aside')
  const scroller = document.createElement('div')
  scroller.dataset.tabScroller = ''
  const list = document.createElement('div')
  list.dataset.tabList = 'regular'
  const rows: Record<string, HTMLElement> = {}
  motion = new SlideMotion('y', { scroller })
  for (const id of ['a', 'b', 'c']) {
    const row = document.createElement('div')
    row.className = 'zen-tab'
    row.dataset.tabId = id
    list.appendChild(row)
    rows[id] = row
    motion.attach(id, row)
  }
  scroller.appendChild(list)
  sidebar.appendChild(scroller)
  const page = document.createElement('div')
  page.dataset.tearZone = ''
  document.body.append(sidebar, page)
  listMotions.set(scroller, motion)
  // Most specific first: `elementFromPoint` answers with the first box under the point.
  Object.values(rows).forEach((row, i) => box(row, 0, 100 + i * ROW, SIDEBAR_WIDTH, ROW))
  box(list, 0, 100, SIDEBAR_WIDTH, 3 * ROW)
  box(scroller, 0, 100, SIDEBAR_WIDTH, 600)
  box(sidebar, 0, 0, SIDEBAR_WIDTH, 800)
  box(page, SIDEBAR_WIDTH, 0, 800, 800)
  return { sidebar, scroller, list, rows, page }
}

const under = (x: number, y: number): Element | null =>
  boxes.find(([, r]) => x >= r.left && x < r.right && y >= r.top && y < r.bottom)?.[0] ?? null

const handles: TouchTabDrag[] = []

function lift(id: string, x = 120, y = 100 + ROW * 1.5): TouchTabDrag | null {
  const h = liftTabByTouch(tab(id), layout.rows[id]!, x, y, now)
  if (h) handles.push(h)
  return h
}

const dragEnds = (): unknown[] =>
  vi
    .mocked(run)
    .mock.calls.filter(([name]) => name === 'tab.dragEnd')
    .map(([, args]) => args)
const drops = (): unknown[] =>
  vi
    .mocked(run)
    .mock.calls.filter(([name]) => name === 'tab.drop')
    .map(([, args]) => args)
const commands = (): string[] => vi.mocked(run).mock.calls.map(([name]) => name)

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
  Object.defineProperty(window, 'innerWidth', { value: 1040, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true })
  document.elementFromPoint = under
  layout = build()
  browserStore.set({ state: state() })
  uiStore.set({ drag: null, snapshot: null, snapshotTabId: null })
  dropStore.set({ key: null, ghost: 'row', zones: false, page: false })
})

afterEach(() => {
  // Whatever a test left in the hand goes home, and its settle runs out.
  for (const h of handles) h.cancel()
  handles.length = 0
  settle()
  vi.advanceTimersByTime(500)
  settle()
  motion.dispose()
  layout.sidebar.remove()
  layout.page.remove()
  browserStore.set({ state: null })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.mocked(run).mockClear()
  vi.mocked(cmd).mockClear()
})

describe('a row lifted by a finger', () => {
  it('opens the drag session on the row, with the page captured behind the ghost', () => {
    const h = lift('b')
    expect(h).not.toBeNull()
    expect(uiStore.get().drag).toMatchObject({ tabId: 'b', remote: false, settling: false })
    expect(run).toHaveBeenCalledWith('tab.dragStart', { tabId: 'b' })
    expect(cmd).toHaveBeenCalledWith('overlay.snapshot', { tabId: 'a' })
  })

  it('refuses a second lift while one has the rows', () => {
    expect(lift('b')).not.toBeNull()
    expect(lift('c')).toBeNull()
    expect(uiStore.get().drag?.tabId).toBe('b')
  })

  it('moved down the list, reads the slot below the next row and slides the rows open', () => {
    const h = lift('b')!
    // The finger over the lower half of row c: b would land after c.
    h.move(120, 100 + ROW * 2.75, now)
    expect(dropStore.get()).toMatchObject({ key: 'tab:c:after', ghost: 'row' })
    // Row c slides up into b's hole: a slide is under way on the list's motion.
    expect(frames.length).toBeGreaterThan(0)
    // The core is not asked to follow a finger across windows.
    expect(commands()).not.toContain('tab.dragMove')
  })

  it('over the page is no target: the ghost stays a row and the split zones are offered', () => {
    const h = lift('b')!
    h.move(600, 300, now)
    expect(dropStore.get()).toMatchObject({ key: null, ghost: 'row', page: true })
  })

  it('let go over the page goes home: no drop, no tear-off', () => {
    const h = lift('b')!
    h.move(600, 300, now)
    h.release(600, 300, now)
    expect(drops()).toEqual([])
    expect(dragEnds()).toEqual([{ tabId: 'b', x: 600, y: 300, outcome: 'cancel' }])
    expect(uiStore.get().drag).toMatchObject({ tabId: 'b', settling: true })
    // Once the ghost has glided home the session is over and the drag is gone.
    settle()
    vi.advanceTimersByTime(200)
    expect(uiStore.get().drag).toBeNull()
    expect(dropStore.get()).toEqual({ key: null, ghost: 'row', zones: false, page: false })
  })

  it('let go past the window\u2019s edge goes home too', () => {
    const h = lift('b')!
    h.move(-20, 300, now)
    expect(dropStore.get().ghost).toBe('row')
    h.release(-20, 300, now)
    expect(drops()).toEqual([])
    expect(dragEnds()).toEqual([{ tabId: 'b', x: -20, y: 300, outcome: 'cancel' }])
  })

  it('let go in a slot drops the tab there', () => {
    const h = lift('b')!
    h.move(120, 100 + ROW * 2.75, now)
    h.release(120, 100 + ROW * 2.75, now)
    expect(drops()).toEqual([{ tabId: 'b', key: 'tab:c:after' }])
    expect(dragEnds()).toEqual([{ tabId: 'b', x: 120, y: 100 + ROW * 2.75, outcome: 'cancel' }])
    expect(uiStore.get().drag).toMatchObject({ settling: true })
  })

  it('let go in its own slot is a cancel, not a drop', () => {
    const h = lift('b')!
    h.move(120, 100 + ROW * 1.6, now)
    expect(dropStore.get().key).toBe('tab:a:after')
    h.release(120, 100 + ROW * 1.6, now)
    expect(drops()).toEqual([])
    expect(dragEnds()).toHaveLength(1)
  })

  it('taken away sends the row home', () => {
    const h = lift('b')!
    h.move(120, 100 + ROW * 2.75, now)
    h.cancel()
    expect(drops()).toEqual([])
    expect(dragEnds()).toEqual([expect.objectContaining({ tabId: 'b', outcome: 'cancel' })])
    expect(uiStore.get().drag).toMatchObject({ settling: true })
    // Nothing more from the handle once it is done.
    h.move(120, 400, now)
    h.release(120, 400, now)
    expect(dragEnds()).toHaveLength(1)
  })
})

describe('the mouse\u2019s drag, for contrast', () => {
  it('tears the tab off over the page', () => {
    const row = layout.rows['b']!
    startTabDrag(tab('b'), {
      button: 0,
      pointerType: 'mouse',
      pointerId: 7,
      currentTarget: row,
      clientX: 120,
      clientY: 100 + ROW * 1.5,
      timeStamp: now
    } as unknown as React.PointerEvent)
    const move = (x: number, y: number): void => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: x,
          clientY: y,
          pointerId: 7,
          pointerType: 'mouse'
        })
      )
    }
    move(130, 100 + ROW * 1.5)
    expect(uiStore.get().drag?.tabId).toBe('b')
    move(600, 300)
    expect(dropStore.get().ghost).toBe('tearoff')
    expect(commands()).toContain('tab.dragMove')
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        clientX: 600,
        clientY: 300,
        pointerId: 7,
        pointerType: 'mouse'
      })
    )
    expect(dragEnds()).toEqual([{ tabId: 'b', x: 600, y: 300, outcome: 'release' }])
  })
})
