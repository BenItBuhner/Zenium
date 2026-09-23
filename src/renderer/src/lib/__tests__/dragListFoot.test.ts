// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, UIState } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { dropStore, liftTabByTouch, listMotions, type TouchTabDrag } from '../drag'
import { SlideMotion } from '../motion/slide'
import { browserStore, uiStore } from '../ui'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

/*
 * The list's foot (tabs-28): a space panel's New Tab row and the empty room under it stand
 * outside the rows' scroller, in the panel's column after it, so the row stays in view however
 * long the list. To a drag the foot is what the room under the rows was: a row carried over it
 * lands after the last row (the regular list's band runs to the panel's end, `listColumn`), and
 * a pointer that reaches it from outside the list finds the panel's scroller (`scrollerAt`). A
 * scroller with no panel round it – the strip's, a harness's – keeps its own end as before. Laid
 * out by hand, the geometry stubbed: happy-dom lays nothing out.
 */

const ROW = 36
const WIDTH = 240

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
    settings: { containerSpecificEssentials: false }
  } as unknown as UIState
}

interface Layout {
  sidebar: HTMLElement
  panel: HTMLElement | null
  scroller: HTMLElement
  list: HTMLElement
  rows: Record<string, HTMLElement>
  newTab: HTMLElement
  empty: HTMLElement
}

let layout: Layout
let motion: SlideMotion
const boxes: Array<[HTMLElement, DOMRect]> = []

function box(el: HTMLElement, x: number, y: number, width: number, height: number): void {
  const rect = new DOMRect(x, y, width, height)
  el.getBoundingClientRect = () => rect
  boxes.push([el, rect])
}

/**
 * The rows at y 100, 136, 172 in a scroller that ends with them (208); under it the foot: the
 * New Tab row 208–244 and the empty room 244–400. With `panel`, the column round them is a
 * space panel's (`data-tab-panel`); without, the foot is a stranger's box under the scroller.
 */
function build(panel: boolean): Layout {
  const sidebar = document.createElement('aside')
  const column = document.createElement('div')
  if (panel) column.dataset.tabPanel = ''
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
  const foot = document.createElement('div')
  foot.dataset.stripFoot = ''
  const newTab = document.createElement('button')
  newTab.dataset.newTab = ''
  const empty = document.createElement('div')
  empty.dataset.stripEmpty = ''
  foot.append(newTab, empty)
  column.append(scroller, foot)
  sidebar.appendChild(column)
  document.body.append(sidebar)
  listMotions.set(scroller, motion)
  // Most specific first: `elementFromPoint` answers with the first box under the point.
  Object.values(rows).forEach((row, i) => box(row, 0, 100 + i * ROW, WIDTH, ROW))
  box(list, 0, 100, WIDTH, 3 * ROW)
  box(scroller, 0, 100, WIDTH, 3 * ROW)
  box(newTab, 0, 208, WIDTH, ROW)
  box(empty, 0, 244, WIDTH, 156)
  box(foot, 0, 208, WIDTH, 192)
  box(column, 0, 100, WIDTH, 300)
  box(sidebar, 0, 0, WIDTH, 800)
  return { sidebar, panel: panel ? column : null, scroller, list, rows, newTab, empty }
}

const under = (x: number, y: number): Element | null =>
  boxes.find(([, r]) => x >= r.left && x < r.right && y >= r.top && y < r.bottom)?.[0] ?? null

const handles: TouchTabDrag[] = []

function lift(id: string, x = 120, y = 100 + ROW * 0.5): TouchTabDrag {
  const h = liftTabByTouch(tab(id), layout.rows[id]!, x, y, now)
  expect(h).not.toBeNull()
  handles.push(h!)
  return h!
}

const drops = (): unknown[] =>
  vi
    .mocked(run)
    .mock.calls.filter(([name]) => name === 'tab.drop')
    .map(([, args]) => args)

function setUp(panel: boolean): void {
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
  layout = build(panel)
  browserStore.set({ state: state() })
  uiStore.set({ drag: null, snapshot: null, snapshotTabId: null })
  dropStore.set({ key: null, ghost: 'row', zones: false, page: false })
}

afterEach(() => {
  for (const h of handles) h.cancel()
  handles.length = 0
  settle()
  vi.advanceTimersByTime(500)
  settle()
  motion.dispose()
  layout.sidebar.remove()
  browserStore.set({ state: null })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.mocked(run).mockClear()
  vi.mocked(cmd).mockClear()
})

describe('a row carried over a space panel’s foot', () => {
  beforeEach(() => setUp(true))

  it('lands after the last row from the empty room under the New Tab row', () => {
    const h = lift('a')
    h.move(120, 300, now)
    expect(dropStore.get()).toMatchObject({ key: 'tab:c:after', ghost: 'row' })
    h.release(120, 300, now)
    expect(drops()).toEqual([{ tabId: 'a', key: 'tab:c:after' }])
  })

  it('lands after the last row from the New Tab row itself, as from the room under the rows before', () => {
    const h = lift('a')
    h.move(120, 226, now)
    expect(dropStore.get().key).toBe('tab:c:after')
  })

  it('reads the slots between the rows as before', () => {
    const h = lift('a')
    // The lower half of row b: a would land after b.
    h.move(120, 100 + ROW * 1.75, now)
    expect(dropStore.get().key).toBe('tab:b:after')
  })
})

describe('a row carried under a scroller with no panel round it', () => {
  beforeEach(() => setUp(false))

  it('finds no slot in a stranger’s box under the list: the band ends with the scroller', () => {
    const h = lift('a')
    h.move(120, 300, now)
    expect(dropStore.get().key).toBeNull()
  })
})
