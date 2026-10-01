// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, UIState } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import {
  dropStore,
  liftTabByTouch,
  listMotions,
  registerCaret,
  startTabDrag,
  type TouchTabDrag
} from '../drag'
import {
  AUTOSCROLL_EDGE,
  AUTOSCROLL_EDGE_TOUCH,
  AUTOSCROLL_FRAME_MS,
  AUTOSCROLL_MAX_STEP,
  autoscrollFrames,
  autoscrollStep
} from '../insertionCaret'
import { SlideMotion } from '../motion/slide'
import { SPRING_STEP_CLAMP_MS } from '../motion/spring'
import { browserStore, uiStore } from '../ui'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

/*
 * TABLET-03: the tablet sidebar's tab drag under a finger – the edge auto-scroll, the drop
 * mark, reduced motion – against the mouse's drag, which must not change. The list overflows
 * its scroller here (eight rows of 36 in a 300 px scroller, scrolled 200 down), so the band at
 * either edge has somewhere to scroll to. The auto-scroll's zone is the draft's 32 px (§9.4)
 * under the mouse and 56 under a finger (the phone grid's figure); its speed is 14 px per 60 Hz
 * frame – the mouse's tick adds that step per frame whatever the frame's length, a finger's tick
 * scales it by the frame's real length, capped at the springs' 64 ms step clamp (3.84 frames),
 * so a 120 Hz tablet scrolls at the 60 Hz speed and not twice it. The drop mark is §9.4's caret:
 * 2 px, inset 8 from the list's edges, in the gap the finger names.
 */

const ROW = 36
const ROWS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
const SIDEBAR_WIDTH = 240
const SCROLLER_TOP = 100
const SCROLLER_HEIGHT = 300
const SCROLLER_BOTTOM = SCROLLER_TOP + SCROLLER_HEIGHT
const SCROLLED = 200

let frames: Array<(now: number) => void> = []
let now = 1000
/** One animation frame `ms` after the last, as the display would raise it. */
const frame = (ms = 16): void => {
  now += ms
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
        tabIds: [...ROWS],
        activeTabId: 'a',
        pinnedCollapsed: false
      }
    ],
    activeSpaceId: 'space',
    tabs: Object.fromEntries(ROWS.map((id) => [id, tab(id)])),
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

/** Eight rows from y 100 on a 36 pitch inside a 300 px scroller at y 100, scrolled 200 down. */
function build(): Layout {
  const sidebar = document.createElement('aside')
  const scroller = document.createElement('div')
  scroller.dataset.tabScroller = ''
  scroller.scrollTop = SCROLLED
  const list = document.createElement('div')
  list.dataset.tabList = 'regular'
  const rows: Record<string, HTMLElement> = {}
  motion = new SlideMotion('y', { scroller })
  for (const id of ROWS) {
    const row = document.createElement('div')
    row.className = 'zen-tab'
    row.dataset.tabId = id
    list.appendChild(row)
    rows[id] = row
    motion.attach(id, row)
  }
  scroller.appendChild(list)
  sidebar.appendChild(scroller)
  const caret = document.createElement('div')
  caret.className = 'zen-tab-caret'
  document.body.append(sidebar, caret)
  registerCaret(caret)
  listMotions.set(scroller, motion)
  // Most specific first: `elementFromPoint` answers with the first box under the point.
  Object.values(rows).forEach((row, i) => box(row, 0, SCROLLER_TOP + i * ROW, SIDEBAR_WIDTH, ROW))
  box(list, 0, SCROLLER_TOP, SIDEBAR_WIDTH, ROWS.length * ROW)
  box(scroller, 0, SCROLLER_TOP, SIDEBAR_WIDTH, SCROLLER_HEIGHT)
  box(sidebar, 0, 0, SIDEBAR_WIDTH, 800)
  return { sidebar, scroller, list, rows, caret }
}

const under = (x: number, y: number): Element | null =>
  boxes.find(([, r]) => x >= r.left && x < r.right && y >= r.top && y < r.bottom)?.[0] ?? null

const handles: TouchTabDrag[] = []

function lift(id: string, x = 120, y = SCROLLER_TOP + ROW * 1.5): TouchTabDrag {
  const h = liftTabByTouch(tab(id), layout.rows[id]!, x, y, now)
  if (!h) throw new Error('no lift')
  handles.push(h)
  return h
}

/** The mouse picks row `id` up and drags it to `x`, `y` (past the 5 px threshold on the way). */
function mouseDrag(id: string, x: number, y: number): void {
  const row = layout.rows[id]!
  const startY = SCROLLER_TOP + ROW * 1.5
  startTabDrag(tab(id), {
    button: 0,
    pointerType: 'mouse',
    pointerId: 7,
    currentTarget: row,
    clientX: 120,
    clientY: startY,
    timeStamp: now
  } as unknown as React.PointerEvent)
  for (const [mx, my] of [
    [130, startY],
    [x, y]
  ] as const) {
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: mx,
        clientY: my,
        pointerId: 7,
        pointerType: 'mouse'
      })
    )
  }
}

function mouseUp(x: number, y: number): void {
  window.dispatchEvent(
    new PointerEvent('pointerup', { clientX: x, clientY: y, pointerId: 7, pointerType: 'mouse' })
  )
}

const drops = (): unknown[] =>
  vi
    .mocked(run)
    .mock.calls.filter(([name]) => name === 'tab.drop')
    .map(([, args]) => args)

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
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
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
  for (const h of handles) h.cancel()
  handles.length = 0
  settle()
  vi.advanceTimersByTime(500)
  settle()
  motion.dispose()
  registerCaret(null)
  layout.sidebar.remove()
  layout.caret.remove()
  browserStore.set({ state: null })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.mocked(run).mockClear()
  vi.mocked(cmd).mockClear()
})

describe('the auto-scroll ramp (§9.4: within 32 px of an edge; 56 under a finger)', () => {
  const scrollerBox = { left: 0, right: SIDEBAR_WIDTH, top: SCROLLER_TOP, bottom: SCROLLER_BOTTOM }

  it('is the draft\u2019s zone, the finger\u2019s wider one and the house step', () => {
    expect(AUTOSCROLL_EDGE).toBe(32)
    expect(AUTOSCROLL_EDGE_TOUCH).toBe(56)
    expect(AUTOSCROLL_MAX_STEP).toBe(14)
  })

  it('ramps over the finger\u2019s 56 px when asked for that band: 0 at 56 in, half way at 28, the step at the edge', () => {
    const touch = (y: number): number => autoscrollStep(scrollerBox, 120, y, 'y', AUTOSCROLL_EDGE_TOUCH)
    expect(touch(SCROLLER_TOP + 150)).toBe(0)
    expect(touch(SCROLLER_TOP + 60)).toBe(0)
    expect(touch(SCROLLER_TOP + AUTOSCROLL_EDGE_TOUCH)).toBe(0)
    expect(touch(SCROLLER_TOP + 40)).toBe(-4)
    expect(touch(SCROLLER_TOP + AUTOSCROLL_EDGE_TOUCH / 2)).toBe(-7)
    expect(touch(SCROLLER_TOP)).toBe(-14)
    expect(touch(SCROLLER_BOTTOM - 60)).toBe(0)
    expect(touch(SCROLLER_BOTTOM - 40)).toBe(4)
    expect(touch(SCROLLER_BOTTOM - AUTOSCROLL_EDGE_TOUCH / 2)).toBe(7)
    expect(touch(SCROLLER_BOTTOM)).toBe(14)
    // The mouse's band, asked for by default, is still nothing 40 px in.
    expect(autoscrollStep(scrollerBox, 120, SCROLLER_TOP + 40)).toBe(0)
    expect(autoscrollStep(scrollerBox, 120, SCROLLER_BOTTOM - 40)).toBe(0)
  })

  it('is nothing away from the edges and ramps to the full step at them, upwards negative', () => {
    expect(autoscrollStep(scrollerBox, 120, SCROLLER_TOP + 150)).toBe(0)
    expect(autoscrollStep(scrollerBox, 120, SCROLLER_TOP + AUTOSCROLL_EDGE)).toBe(0)
    expect(autoscrollStep(scrollerBox, 120, SCROLLER_TOP + AUTOSCROLL_EDGE / 2)).toBe(-7)
    expect(autoscrollStep(scrollerBox, 120, SCROLLER_TOP)).toBe(-14)
    expect(autoscrollStep(scrollerBox, 120, SCROLLER_TOP - 40)).toBe(-14)
    expect(autoscrollStep(scrollerBox, 120, SCROLLER_BOTTOM - AUTOSCROLL_EDGE)).toBe(0)
    expect(autoscrollStep(scrollerBox, 120, SCROLLER_BOTTOM - AUTOSCROLL_EDGE / 2)).toBe(7)
    expect(autoscrollStep(scrollerBox, 120, SCROLLER_BOTTOM)).toBe(14)
    expect(autoscrollStep(scrollerBox, 120, SCROLLER_BOTTOM + 40)).toBe(14)
  })

  it('needs the pointer over the list\u2019s width', () => {
    expect(autoscrollStep(scrollerBox, -1, SCROLLER_TOP)).toBe(0)
    expect(autoscrollStep(scrollerBox, SIDEBAR_WIDTH + 1, SCROLLER_BOTTOM)).toBe(0)
  })

  it('counts a finger\u2019s tick in 60 Hz frames, the springs\u2019 64 ms clamp at most, none for no time', () => {
    expect(AUTOSCROLL_FRAME_MS).toBeCloseTo(1000 / 60, 6)
    expect(SPRING_STEP_CLAMP_MS).toBe(64)
    expect(autoscrollFrames(1000 / 60)).toBeCloseTo(1, 6)
    expect(autoscrollFrames(1000 / 120)).toBeCloseTo(0.5, 6)
    expect(autoscrollFrames(1000 / 90)).toBeCloseTo(2 / 3, 6)
    expect(autoscrollFrames(30)).toBeCloseTo(1.8, 6)
    expect(autoscrollFrames(1000 / 30)).toBeCloseTo(2, 6)
    // The one cap: the spring step clamp – 64 ms is 3.84 frames, and no pause counts for more.
    expect(autoscrollFrames(SPRING_STEP_CLAMP_MS)).toBeCloseTo(3.84, 6)
    expect(autoscrollFrames(100)).toBeCloseTo(3.84, 6)
    expect(autoscrollFrames(400)).toBeCloseTo(SPRING_STEP_CLAMP_MS / AUTOSCROLL_FRAME_MS, 6)
    expect(autoscrollFrames(0)).toBe(0)
    expect(autoscrollFrames(-16)).toBe(0)
    expect(autoscrollFrames(Number.NaN)).toBe(0)
  })
})

describe('a finger near the list\u2019s edge', () => {
  it('scrolls the list up at the top edge by the step per 60 Hz frame, at the same speed on a faster display', () => {
    const h = lift('c')
    h.move(120, SCROLLER_TOP, now)
    expect(layout.scroller.scrollTop).toBe(SCROLLED)
    // The first tick has no frame before it: nothing yet.
    frame(1000 / 60)
    const first = layout.scroller.scrollTop
    frame(1000 / 60)
    expect(first - layout.scroller.scrollTop).toBeCloseTo(14, 5)
    // A 120 Hz display raises two frames in the time: half a step each, the same 14 in all.
    const at120 = layout.scroller.scrollTop
    frame(1000 / 120)
    frame(1000 / 120)
    expect(at120 - layout.scroller.scrollTop).toBeCloseTo(14, 5)
  })

  it('scrolls down at the bottom edge, half way into the finger\u2019s 56 px band at half the step', () => {
    const h = lift('c')
    h.move(120, SCROLLER_BOTTOM - AUTOSCROLL_EDGE_TOUCH / 2, now)
    frame(1000 / 60)
    const before = layout.scroller.scrollTop
    frame(1000 / 60)
    expect(layout.scroller.scrollTop - before).toBeCloseTo(7, 5)
  })

  it('scrolls 40 px in – inside the finger\u2019s band, outside the mouse\u2019s – and not 60 px in', () => {
    const h = lift('c')
    h.move(120, SCROLLER_TOP + 40, now)
    frame(1000 / 60)
    const before = layout.scroller.scrollTop
    frame(1000 / 60)
    // 14 × (56 − 40) / 56 = 4 px per 60 Hz frame.
    expect(before - layout.scroller.scrollTop).toBeCloseTo(4, 5)
    h.move(120, SCROLLER_TOP + 60, now)
    frame(1000 / 60)
    const at60 = layout.scroller.scrollTop
    for (let i = 0; i < 5; i++) frame(1000 / 60)
    expect(layout.scroller.scrollTop).toBe(at60)
  })

  it('after a stall counts the springs\u2019 64 ms clamp (3.84 frames), not two frames and not the whole pause', () => {
    const h = lift('c')
    h.move(120, SCROLLER_TOP, now)
    frame(1000 / 60)
    const before = layout.scroller.scrollTop
    frame(500)
    const clampFrames = SPRING_STEP_CLAMP_MS / AUTOSCROLL_FRAME_MS
    expect(clampFrames).toBeCloseTo(3.84, 6)
    expect(before - layout.scroller.scrollTop).toBeCloseTo(14 * clampFrames, 5)
    expect(before - layout.scroller.scrollTop).toBeCloseTo(53.76, 5)
    // A 30 ms frame is under the clamp: 1.8 frames' worth, as before the clamp changed.
    const before30 = layout.scroller.scrollTop
    frame(30)
    expect(before30 - layout.scroller.scrollTop).toBeCloseTo(14 * 1.8, 5)
  })

  it('away from the edges the list stands still, frame after frame', () => {
    const h = lift('c')
    h.move(120, SCROLLER_TOP + 150, now)
    for (let i = 0; i < 10; i++) frame(1000 / 60)
    expect(layout.scroller.scrollTop).toBe(SCROLLED)
  })

  it('stops with the release', () => {
    const h = lift('c')
    h.move(120, SCROLLER_TOP, now)
    frame(1000 / 60)
    frame(1000 / 60)
    h.release(120, SCROLLER_TOP, now)
    const at = layout.scroller.scrollTop
    settle()
    expect(layout.scroller.scrollTop).toBe(at)
  })
})

describe('the mouse\u2019s drag, unchanged', () => {
  it('scrolls by the full step every frame whatever the frame\u2019s length', () => {
    mouseDrag('c', 120, SCROLLER_TOP)
    expect(uiStore.get().drag?.tabId).toBe('c')
    expect(layout.scroller.scrollTop).toBe(SCROLLED)
    // The first frame already scrolls: the mouse's tick reads no clock.
    frame(1000 / 60)
    expect(layout.scroller.scrollTop).toBe(SCROLLED - 14)
    // A long frame is one step; a short one is one step: per frame, not per second.
    frame(500)
    expect(layout.scroller.scrollTop).toBe(SCROLLED - 28)
    frame(1000 / 120)
    expect(layout.scroller.scrollTop).toBe(SCROLLED - 42)
    mouseUp(120, SCROLLER_TOP)
  })

  it('half way into the band scrolls half the step, per frame', () => {
    mouseDrag('c', 120, SCROLLER_BOTTOM - AUTOSCROLL_EDGE / 2)
    frame(1000 / 60)
    expect(layout.scroller.scrollTop).toBe(SCROLLED + 7)
    frame(1)
    expect(layout.scroller.scrollTop).toBe(SCROLLED + 14)
    mouseUp(120, SCROLLER_BOTTOM - AUTOSCROLL_EDGE / 2)
  })

  it('keeps the 32 px band: 40 px in, where a finger scrolls, the mouse does not', () => {
    mouseDrag('c', 120, SCROLLER_TOP + 40)
    expect(uiStore.get().drag?.tabId).toBe('c')
    for (let i = 0; i < 6; i++) frame(1000 / 60)
    expect(layout.scroller.scrollTop).toBe(SCROLLED)
    mouseUp(120, SCROLLER_TOP + 40)
  })
})

describe('the drop mark under a finger', () => {
  it('is the caret in the gap the finger names: 2 px, inset 8, the list\u2019s width less 16', () => {
    const caret = layout.caret
    expect(caret.style.opacity).toBe('0')
    const h = lift('b')
    // The finger over the lower half of row d: b would land after d, where e begins.
    h.move(120, SCROLLER_TOP + ROW * 3.75, now)
    expect(dropStore.get()).toMatchObject({ key: 'tab:d:after', ghost: 'row' })
    expect(caret.style.opacity).toBe('1')
    expect(caret.style.left).toBe('8px')
    expect(caret.style.width).toBe(`${SIDEBAR_WIDTH - 16}px`)
    expect(caret.style.height).toBe('2px')
    // With b's hole closed, c and d slide up a pitch and a row-tall gap opens where d stood
    // (208 → 244): the caret sits at the gap's centre, where the landed row's middle will be.
    const gapCentre = SCROLLER_TOP + ROW * 3.5
    expect(caret.style.transform).toBe(`translate3d(0, ${gapCentre - 1}px, 0)`)
  })

  it('glides to the next gap and hides when the finger leaves the list', () => {
    const caret = layout.caret
    const h = lift('b')
    h.move(120, SCROLLER_TOP + ROW * 3.75, now)
    const first = caret.style.transform
    h.move(120, SCROLLER_TOP + ROW * 4.75, now)
    // On the snappy spring: the caret is between the two gaps before it lands.
    expect(frames.length).toBeGreaterThan(0)
    settle()
    expect(caret.style.transform).not.toBe(first)
    expect(caret.style.transform).toBe(`translate3d(0, ${SCROLLER_TOP + ROW * 4.5 - 1}px, 0)`)
    h.move(600, 300, now)
    expect(caret.style.opacity).toBe('0')
  })

  it('names the slot the finger lands in, and the core moves the tab there', () => {
    const h = lift('b')
    h.move(120, SCROLLER_TOP + ROW * 3.75, now)
    h.release(120, SCROLLER_TOP + ROW * 3.75, now)
    expect(drops()).toEqual([{ tabId: 'b', key: 'tab:d:after' }])
  })
})

describe('under reduced motion', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }))
  })

  it('the caret jumps to its gap, the rows and the drop are the same', () => {
    const caret = layout.caret
    const h = lift('b')
    h.move(120, SCROLLER_TOP + ROW * 3.75, now)
    expect(caret.style.transform).toBe(`translate3d(0, ${SCROLLER_TOP + ROW * 3.5 - 1}px, 0)`)
    h.move(120, SCROLLER_TOP + ROW * 4.75, now)
    // No spring frames between the gaps: the caret is already there.
    expect(caret.style.transform).toBe(`translate3d(0, ${SCROLLER_TOP + ROW * 4.5 - 1}px, 0)`)
    h.release(120, SCROLLER_TOP + ROW * 4.75, now)
    expect(drops()).toEqual([{ tabId: 'b', key: 'tab:e:after' }])
  })

  it('the release lands at once: the gentle spring jumps, only the ghost\u2019s 100 ms fade remains', () => {
    const h = lift('b')
    h.move(120, SCROLLER_TOP + ROW * 3.75, now)
    frames = []
    h.release(120, SCROLLER_TOP + ROW * 3.75, now)
    // No glide frames are asked for; the drag is settling and ends with the fade's timer.
    expect(frames.length).toBe(0)
    expect(uiStore.get().drag).toMatchObject({ tabId: 'b', settling: true })
    vi.advanceTimersByTime(100)
    expect(uiStore.get().drag).toBeNull()
  })

  it('the auto-scroll still runs: the reorder works without the motion', () => {
    const h = lift('c')
    h.move(120, SCROLLER_TOP, now)
    frame(1000 / 60)
    const before = layout.scroller.scrollTop
    frame(1000 / 60)
    expect(before - layout.scroller.scrollTop).toBeCloseTo(14, 5)
  })
})
