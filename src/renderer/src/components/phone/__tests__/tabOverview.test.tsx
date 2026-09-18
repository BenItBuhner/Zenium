// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Space, Tab, UIState } from '@shared/types'
import { BLANK_URL, SETTINGS_URL } from '@shared/url'

/*
 * The phone tab overview rendered for real: (A) every kind of card the grid draws – a pinned
 * tab, a page, a blank tab, an internal page (`zen://settings`), a group and its members, the
 * New Tab card – is a cell of the one FLIP set the grid glides; (B) a card dragged out of a
 * group leaves it, through the re-mount its stand-in causes, and the hover state clears on
 * every way the gesture can end.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { NEW_TAB_CELL, TabOverview } = await import('../TabOverview')
const { activeLiftPointer, cancelLift, liftStore } = await import('../useCardLift')
const { clearDepartures, departStore } = await import('../departureStore')
const { GROUP_HEADER, GROUP_PAD } = await import('../GroupCard')
const { collectCells, FlipTracker, layoutAnimations, REDUCED_FADE_MS } =
  await import('@renderer/lib/motion/flip')
const { SLOT_DWELL_MS } = await import('@renderer/lib/gestures/dropTarget')

// --- a profile ---------------------------------------------------------------------------------

const SPACE = 'space'
const GROUP = 'g'

function tab(id: string, url: string, patch: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: SPACE,
    containerId: 'default',
    url,
    title: id,
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: false,
    discarded: false,
    frozen: false,
    cpuThrottle: 1,
    zoom: 1,
    splitGroupId: null,
    createdAt: 0,
    lastActiveAt: 0,
    errorCode: null,
    bookmarked: false,
    readerable: false,
    blockedCount: 0,
    ...patch
  } as Tab
}

const folder: Folder = {
  id: GROUP,
  spaceId: SPACE,
  name: 'Research',
  icon: '📚',
  collapsed: false,
  color: 'blue'
}

/** `tabs` in track order; the first is active. */
function stateOf(tabs: Tab[], folders: Folder[] = [folder]): UIState {
  const space: Space = {
    id: SPACE,
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId: tabs[0]?.id ?? null,
    pinnedCollapsed: false
  }
  return {
    platform: 'android',
    capabilities: { windowControls: false },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [space],
    activeSpaceId: SPACE,
    folders: Object.fromEntries(folders.map((f) => [f.id, f])),
    essentialTabIds: [],
    containers: [],
    settings: {
      colorScheme: 'light',
      sidebarSide: 'left',
      pinnedCloseBehavior: 'unload',
      containerSpecificEssentials: false
    },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: []
  } as unknown as UIState
}

const OPEN = { phase: 'open', progress: 1, heroTabId: null, target: 1 } as const
const AREA = { x: 0, y: 0, width: 220, height: 600 }

// --- a layout ----------------------------------------------------------------------------------

/**
 * happy-dom lays nothing out: cells answer `getBoundingClientRect` from this table, by their
 * `data-cell` key (a card's inner button answers with its cell's box), and the grid's scroller
 * from `GRID`. A two-column grid: the group across the top with its two members inside, the
 * loose cards below, the New Tab card last.
 */
const GRID = 'grid'
const DEFAULT_LAYOUT: Array<[string, DOMRect]> = [
  [GRID, new DOMRect(0, 0, 220, 600)],
  [`group:${GROUP}`, new DOMRect(0, 0, 220, 170)],
  ['m1', new DOMRect(10, 36, 100, 130)],
  ['m2', new DOMRect(120, 36, 100, 130)],
  ['a', new DOMRect(0, 180, 100, 130)],
  ['b', new DOMRect(110, 180, 100, 130)],
  [NEW_TAB_CELL, new DOMRect(0, 320, 100, 130)]
]
const layout = new Map<string, DOMRect>(DEFAULT_LAYOUT)
/**
 * A group card's body answers `offsetHeight` from here, by the group's cell key: the height its
 * member cards need (the group card runs its own height to `GROUP_HEADER` plus this).
 */
const bodyHeights = new Map<string, number>()
const measured = HTMLElement.prototype.getBoundingClientRect
HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
  if (this.classList.contains('zen-overview-grid')) return layout.get(GRID)!
  const key = this.closest('[data-cell]')?.getAttribute('data-cell')
  return (key ? layout.get(key) : undefined) ?? measured.call(this)
}
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get(this: HTMLElement): number {
    const group = this.parentElement?.classList.contains('zen-group')
      ? this.parentElement.getAttribute('data-cell')
      : null
    if (group && this.classList.contains('grid')) return bodyHeights.get(group) ?? 0
    return this.getBoundingClientRect().height
  }
})

const at = (key: string, fx: number, fy: number): { x: number; y: number } => {
  const r = layout.get(key)!
  return { x: r.left + r.width * fx, y: r.top + r.height * fy }
}
/** Lay the cell `key` out at (x, y), `w` by `h`. */
const place = (key: string, x: number, y: number, w = 100, h = 130): void => {
  layout.set(key, new DOMRect(x, y, w, h))
}
/** The translation a cell is drawn with. */
const translate = (el: HTMLElement): { x: number; y: number } => {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform)
  return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 }
}

// --- a clock -----------------------------------------------------------------------------------

let now = 10_000
let nextFrame = 1
const frames = new Map<number, (t: number) => void>()
/** Time passes: the timers (long press, dwell) and `performance.now()` together. */
const elapse = (ms: number): void => {
  now += ms
  vi.advanceTimersByTime(ms)
}
/** One animation frame of every spring in flight. */
const frame = (): void => {
  elapse(16)
  const batch = [...frames.values()]
  frames.clear()
  for (const cb of batch) cb(now)
}
const settleSprings = (): void => {
  for (let i = 0; i < 600 && frames.size; i++) frame()
}
/** Frames pass until `when` holds; how many it took (600 at most). */
const framesUntil = (when: () => boolean): number => {
  let n = 0
  while (!when() && n < 600) {
    act(() => frame())
    n++
  }
  return n
}

beforeEach(() => {
  layout.clear()
  for (const [key, rect] of DEFAULT_LAYOUT) layout.set(key, rect)
  bodyHeights.clear()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  frames.clear()
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    const id = nextFrame++
    frames.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  invoke.mockClear()
})

afterEach(() => {
  act(() => cancelLift())
  act(() => clearDepartures())
  act(() => root?.unmount())
  layoutAnimations.release()
  root = null
  host?.remove()
  host = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// --- rendering ---------------------------------------------------------------------------------

let root: Root | null = null
let host: HTMLElement | null = null

function render(state: UIState): HTMLElement {
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  act(() =>
    root!.render(createElement(TabOverview, { state, overview: OPEN, area: AREA, edge: 'bottom' }))
  )
  return host!
}

const grid = (): HTMLElement => host!.querySelector<HTMLElement>('.zen-overview-grid')!
const cellOf = (key: string): HTMLElement => grid().querySelector(`[data-cell="${key}"]`)!
/** The group card a cell is drawn inside, or null when it is loose. */
const groupAround = (key: string): string | null =>
  cellOf(key).parentElement?.closest('[data-cell^="group:"]')?.getAttribute('data-cell') ?? null

/** The commands the grid sent the browser, in order. */
const commands = (): Array<[string, unknown]> =>
  invoke.mock.calls.map(([name, args]) => [name, args] as [string, unknown])

// --- a finger ----------------------------------------------------------------------------------

const POINTER = 7

function pointer(type: string, target: EventTarget, x: number, y: number): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        pointerId: POINTER,
        clientX: x,
        clientY: y,
        button: 0,
        bubbles: true,
        cancelable: true,
        pointerType: 'touch',
        isPrimary: true
      })
    )
  })
}

/** Hold the card `key` until it comes off the grid. */
function pickUp(key: string): void {
  const button = cellOf(key).querySelector<HTMLElement>('[role="button"]')!
  const p = at(key, 0.5, 0.5)
  pointer('pointerdown', button, p.x, p.y)
  act(() => elapse(400))
  expect(liftStore.get()).toMatchObject({ tabId: key, phase: 'lifted' })
  expect(activeLiftPointer()).toBe(POINTER)
}

/** Move the finger (the card is in the hand; the session listens on the window). */
function drag(x: number, y: number): void {
  pointer('pointermove', grid(), x, y)
}

const letGo = (x: number, y: number): void => pointer('pointerup', grid(), x, y)
const interrupt = (x: number, y: number): void => pointer('pointercancel', grid(), x, y)

/**
 * The finger moves through `points`, `stepMs` apart, and the chrome hears of it late: every
 * event is dispatched `lagMs` after the last of them was made, as a busy main thread hands the
 * touch's events over – their timestamps the touch's own, well behind `performance.now()`.
 */
function dragLate(points: Array<{ x: number; y: number }>, stepMs: number, lagMs: number): void {
  const events = points.map((p, i) => {
    if (i > 0) elapse(stepMs)
    return new PointerEvent('pointermove', {
      pointerId: POINTER,
      clientX: p.x,
      clientY: p.y,
      button: 0,
      bubbles: true,
      cancelable: true,
      pointerType: 'touch',
      isPrimary: true
    })
  })
  elapse(lagMs)
  events.forEach((e, i) => {
    if (i > 0) elapse(stepMs)
    act(() => {
      grid().dispatchEvent(e)
    })
  })
}

/** A native touchmove as the browser sends it to the node the touch started on. */
function touchmoveOn(target: EventTarget): Event {
  const e = new Event('touchmove', { bubbles: true, cancelable: true })
  act(() => {
    target.dispatchEvent(e)
  })
  return e
}

/** Land the ghost: the grid shows `state`, the drop is confirmed, the springs run out. */
function land(state: UIState): void {
  render(state)
  act(() => settleSprings())
}

// --- (A) the FLIP set --------------------------------------------------------------------------

describe('the overview grid as one FLIP set', () => {
  it('holds every kind of card – pinned, page, blank, settings, group and members, New Tab', () => {
    const commit = vi.spyOn(FlipTracker.prototype, 'commit')
    render(
      stateOf([
        tab('pinned', 'https://pinned.example/', { pinned: true }),
        tab('m1', 'https://one.example/', { folderId: GROUP }),
        tab('m2', 'https://two.example/', { folderId: GROUP }),
        tab('page', 'https://example.com/'),
        tab('blank', BLANK_URL),
        tab('settings', SETTINGS_URL, { title: 'Settings' })
      ])
    )
    const keys = [...collectCells(grid()).keys()]
    expect(keys).toEqual([
      'pinned',
      `group:${GROUP}`,
      'm1',
      'm2',
      'page',
      'blank',
      'settings',
      NEW_TAB_CELL
    ])
    // Exactly that set went to the one tracker on the last commit: nothing registers by hand.
    expect(commit).toHaveBeenCalled()
    const last = commit.mock.calls.at(-1)!
    expect([...last[0].keys()]).toEqual(keys)
    expect(last[1]).toBe(grid())
    // The blank tab's card and the New Tab card are cells like a page's card.
    expect(cellOf('blank').querySelector('[role="button"]')).not.toBeNull()
    expect(cellOf(NEW_TAB_CELL).tagName).toBe('BUTTON')
  })
})

// --- (B) dragging out of a group -----------------------------------------------------------------

describe('a card dragged out of its group', () => {
  const grouped = (): UIState =>
    stateOf([
      tab('m1', 'https://one.example/', { folderId: GROUP }),
      tab('m2', 'https://two.example/', { folderId: GROUP }),
      tab('a', 'https://a.example/'),
      tab('b', 'https://b.example/')
    ])

  it('leaves the group where it was let go, through the re-mount, and the hover clears', () => {
    render(grouped())
    expect(groupAround('m1')).toBe(`group:${GROUP}`)
    const anchor = cellOf('m1').querySelector<HTMLElement>('[role="button"]')!
    pickUp('m1')
    // The card in the hand is drawn at scale(1.02) (v2 §11.4; its 90% opacity is the ghost's CSS).
    act(() => settleSprings())
    expect(liftStore.get().scale).toBeCloseTo(1.02, 3)
    const ghost = host!.querySelector<HTMLElement>('.zen-overview-ghost')!
    expect(ghost.style.transform).toBe('scale(1.02)')

    // Out of the group onto the left edge of the first loose card: the slot before it.
    const edge = at('a', 0.1, 0.5)
    drag(edge.x, edge.y)
    expect(liftStore.get()).toMatchObject({ phase: 'dragging', target: null, slot: null })
    // The finger rests there: the gap opens, and the stand-in moves out of the group – the
    // card's element is re-mounted in the loose grid while the finger is still down.
    act(() => elapse(SLOT_DWELL_MS))
    expect(liftStore.get().slot).toEqual({ folderId: null, index: 0 })
    expect(groupAround('m1')).toBeNull()
    expect(cellOf('m1')).toBeTruthy()
    expect(anchor.isConnected).toBe(false)
    // The gesture survived the re-mount…
    expect(activeLiftPointer()).toBe(POINTER)
    // …and so did the block on the native scroll: Chromium keeps sending the touch's events to
    // the node the finger came down on, detached or not, and they must still be cancelled there
    // or the grid's pan-y would take the touch over and end the drag.
    expect(touchmoveOn(anchor).defaultPrevented).toBe(true)

    // …and the release lands the card where the finger is: first among the loose tabs.
    letGo(edge.x, edge.y)
    expect(activeLiftPointer()).toBeNull()
    expect(touchmoveOn(anchor).defaultPrevented).toBe(false)
    expect(liftStore.get()).toMatchObject({ phase: 'dropping', target: null })
    expect(commands()).toEqual([
      ['tab.move', { tabId: 'm1', spaceId: SPACE, section: 'regular', index: 1 }],
      ['tab.moveToFolder', { tabId: 'm1', folderId: null }]
    ])

    // The browser shows the move; the ghost flies into the slot and the gesture is over.
    land(
      stateOf([
        tab('m2', 'https://two.example/', { folderId: GROUP }),
        tab('m1', 'https://one.example/'),
        tab('a', 'https://a.example/'),
        tab('b', 'https://b.example/')
      ])
    )
    expect(liftStore.get()).toMatchObject({ phase: 'idle', tabId: null, target: null, slot: null })
    expect(groupAround('m1')).toBeNull()
  })

  it('a finger on its way takes no slot, however late its events come; the slot it settles on is its own through a reflow', () => {
    render(grouped())
    pickUp('m1')
    // Down the left edge of a – the slot before it all the way – at 250 px/s, the events
    // reaching the chrome half a second late. A finger on its way commits nothing: read against
    // `performance.now()` its speed would be nought (no sample within the tracker's window) and
    // the slot would take hold in passing, moving the grid under a finger still travelling.
    const way = Array.from({ length: 11 }, (_, i) => ({ x: 8, y: 190 + 10 * i }))
    dragLate(way, 40, 100)
    expect(liftStore.get()).toMatchObject({ phase: 'dragging', target: null, slot: null })
    expect(groupAround('m1')).toBe(`group:${GROUP}`)
    // It stops: the slot takes hold after the dwell, and the finger has settled there.
    act(() => elapse(SLOT_DWELL_MS))
    expect(liftStore.get().slot).toEqual({ folderId: null, index: 0 })
    expect(groupAround('m1')).toBeNull()

    // The grid reflows under the still finger (the group lost its row): b is laid out where
    // the finger rests, whose left edge would read as the slot after a. The slot belongs to the
    // finger (v2 §11.4): a tremor within the slop changes nothing…
    place('b', 0, 180)
    place('a', 110, 180)
    place(NEW_TAB_CELL, 110, 320)
    render(grouped())
    drag(10, 292)
    expect(liftStore.get()).toMatchObject({ target: null, slot: { folderId: null, index: 0 } })
    // …and the release lands the card in the held slot, not the one the reflow put under it.
    letGo(10, 292)
    expect(liftStore.get()).toMatchObject({
      phase: 'dropping',
      target: null,
      slot: { folderId: null, index: 0 }
    })
    expect(commands()).toEqual([
      ['tab.move', { tabId: 'm1', spaceId: SPACE, section: 'regular', index: 1 }],
      ['tab.moveToFolder', { tabId: 'm1', folderId: null }]
    ])
  })

  it('flung out before the gap opens still lands where the finger let go', () => {
    render(grouped())
    pickUp('m1')
    const edge = at('b', 0.9, 0.5)
    drag(edge.x, edge.y)
    // No dwell: the slot after b is pending, not shown…
    expect(liftStore.get().slot).toBeNull()
    expect(groupAround('m1')).toBe(`group:${GROUP}`)
    letGo(edge.x, edge.y)
    // …and the drop commits it all the same: the card goes after b, out of the group.
    expect(liftStore.get()).toMatchObject({
      phase: 'dropping',
      target: null,
      slot: { folderId: null, index: 2 }
    })
    expect(commands()).toEqual([
      ['tab.move', { tabId: 'm1', spaceId: SPACE, section: 'regular', index: 3 }],
      ['tab.moveToFolder', { tabId: 'm1', folderId: null }]
    ])
    expect(activeLiftPointer()).toBeNull()
  })

  it('cancelled over another card drops the ring and puts the card back, changing nothing', () => {
    render(grouped())
    pickUp('m1')
    const middle = at('a', 0.5, 0.5)
    drag(middle.x, middle.y)
    expect(liftStore.get()).toMatchObject({ phase: 'dragging', target: 'card:a' })
    expect(cellOf('a').querySelector('.zen-overview-card-target')).not.toBeNull()
    interrupt(middle.x, middle.y)
    expect(liftStore.get()).toMatchObject({ phase: 'dropping', target: null, slot: null })
    expect(cellOf('a').querySelector('.zen-overview-card-target')).toBeNull()
    expect(activeLiftPointer()).toBeNull()
    act(() => settleSprings())
    expect(liftStore.get().phase).toBe('idle')
    expect(commands()).toEqual([])
    expect(groupAround('m1')).toBe(`group:${GROUP}`)
  })

  it('leaving the grid clears the target; coming back onto its own group targets nothing', () => {
    render(grouped())
    pickUp('a')
    const middle = at('b', 0.5, 0.5)
    drag(middle.x, middle.y)
    expect(liftStore.get().target).toBe('card:b')
    // Off the grid altogether.
    drag(-40, 240)
    expect(liftStore.get()).toMatchObject({ phase: 'dragging', target: null })
    // Onto the group's own chrome: a target for a loose card…
    const chrome = at(`group:${GROUP}`, 0.5, 0.08)
    drag(chrome.x, chrome.y)
    expect(liftStore.get().target).toBe(`group:${GROUP}`)
    letGo(chrome.x, chrome.y)
    expect(liftStore.get()).toMatchObject({ phase: 'dropping', target: null })
    expect(commands()).toEqual([
      ['tab.move', { tabId: 'a', spaceId: SPACE, section: 'regular', index: 2 }],
      ['tab.moveToFolder', { tabId: 'a', folderId: GROUP }]
    ])
    invoke.mockClear()
    land(
      stateOf([
        tab('m1', 'https://one.example/', { folderId: GROUP }),
        tab('m2', 'https://two.example/', { folderId: GROUP }),
        tab('a', 'https://a.example/', { folderId: GROUP }),
        tab('b', 'https://b.example/')
      ])
    )
    expect(liftStore.get().phase).toBe('idle')

    // …but no target for a card that is in it: dropping a member on its group changes nothing.
    pickUp('m2')
    drag(chrome.x, chrome.y)
    expect(liftStore.get()).toMatchObject({ phase: 'dragging', target: null })
    letGo(chrome.x, chrome.y)
    expect(liftStore.get()).toMatchObject({ phase: 'dropping', target: null })
    expect(commands()).toEqual([])
    act(() => settleSprings())
    expect(liftStore.get().phase).toBe('idle')
  })
})

// --- (C) the sequence of a group changing height (v2 §11.4) --------------------------------------

describe('a group changing height', () => {
  /** A group of three across the top (two rows of cards), then a loose card, then the New Tab card. */
  const three = (): UIState =>
    stateOf([
      tab('m1', 'https://one.example/', { folderId: GROUP }),
      tab('m2', 'https://two.example/', { folderId: GROUP }),
      tab('m3', 'https://three.example/', { folderId: GROUP }),
      tab('a', 'https://a.example/')
    ])
  /** The height of a group's body holding `rows` rows of cards, and of the group card itself. */
  const bodyOf = (rows: number): number => rows * 130 + (rows - 1) * 12 + GROUP_PAD
  const groupOf = (rows: number): number => GROUP_HEADER + bodyOf(rows)

  it('a card leaving: it glides while the height runs; the cards below glide after; the New Tab card among them', () => {
    // The group card is 32 + 6 + 2 × 130 + 12 = 312 tall; a and the New Tab card are under it.
    bodyHeights.set(`group:${GROUP}`, bodyOf(2))
    place(`group:${GROUP}`, 0, 0, 220, groupOf(2))
    place('m1', 10, 36)
    place('m2', 120, 36)
    place('m3', 10, 178)
    place('a', 0, groupOf(2) + 10)
    place(NEW_TAB_CELL, 110, groupOf(2) + 10)
    render(three())
    const commit = vi.spyOn(FlipTracker.prototype, 'commit')

    // m3 leaves the group (dragged out; the browser has moved it): the group is one row now.
    // The group card holds itself at the old height for the commit, so the browser lays the row
    // below out where it was; m3 is laid out in its loose slot.
    bodyHeights.set(`group:${GROUP}`, bodyOf(1))
    place('m3', 0, groupOf(2) + 10)
    place('a', 110, groupOf(2) + 10)
    place(NEW_TAB_CELL, 0, groupOf(2) + 150)
    render(
      stateOf([
        tab('m1', 'https://one.example/', { folderId: GROUP }),
        tab('m2', 'https://two.example/', { folderId: GROUP }),
        tab('m3', 'https://three.example/'),
        tab('a', 'https://a.example/')
      ])
    )
    expect(commit).toHaveBeenCalled()
    const group = cellOf(`group:${GROUP}`)
    const m3 = cellOf('m3')
    const a = cellOf('a')
    const plus = cellOf(NEW_TAB_CELL)
    // The group's height is running on its spring, from the old height…
    expect(layoutAnimations.has(`group:${GROUP}`)).toBe(true)
    expect(group.style.height).toBe(`${groupOf(2)}px`)
    // …m3 glides from its inner slot to its loose one, from the first frame (drawn against the
    // slot it will rest in once the height has settled, not the one the browser has it in now)…
    expect(translate(m3)).toEqual({ x: 10, y: 178 - (groupOf(2) + 10) })
    // …and a and the New Tab card, whose slots changed too, are held where they were: a is laid
    // out one column over now and drawn back where it was; nothing below moves yet.
    expect(translate(a)).toEqual({ x: -110, y: 0 })
    expect(translate(plus)).toEqual({ x: 110, y: -140 })

    // The height runs; the browser lays the row below out for each frame's height, and the hold
    // keeps it where it was.
    const rowBelowAt = (h: number): void => {
      place('m3', 0, h + 10)
      place('a', 110, h + 10)
      place(NEW_TAB_CELL, 0, h + 150)
    }
    let previous = groupOf(2)
    const shrank = framesUntil(() => {
      const h = parseFloat(group.style.height)
      if (h < previous) rowBelowAt(h)
      previous = h
      return h < groupOf(2) - 40
    })
    expect(shrank).toBeGreaterThan(0)
    const h = parseFloat(group.style.height)
    expect(translate(a)).toEqual({ x: -110, y: expect.closeTo(groupOf(2) - h, 3) })
    expect(translate(plus).y).toBeCloseTo(groupOf(2) - h - 140, 3)
    expect(layoutAnimations.has(`group:${GROUP}`)).toBe(true)
    // Until the height settles: then the row below glides to its new slots, together.
    rowBelowAt(groupOf(1))
    act(() => settleSprings())
    expect(layoutAnimations.has(`group:${GROUP}`)).toBe(false)
    expect(group.style.height).toBe('')
    expect(a.style.transform).toBe('')
    expect(plus.style.transform).toBe('')
    expect(m3.style.transform).toBe('')
    // The group keeps its header and tint throughout: it still holds cards.
    expect(group.dataset.chrome).toBeUndefined()
  })

  it('a card entering: the mirror – it glides in while the height grows; the cards below glide after', () => {
    // A group of two across the top (one row), then two loose cards, then the New Tab card.
    bodyHeights.set(`group:${GROUP}`, bodyOf(1))
    place(`group:${GROUP}`, 0, 0, 220, groupOf(1))
    place('m1', 10, 36)
    place('m2', 120, 36)
    place('a', 0, groupOf(1) + 10)
    place('b', 110, groupOf(1) + 10)
    place(NEW_TAB_CELL, 0, groupOf(1) + 150)
    render(
      stateOf([
        tab('m1', 'https://one.example/', { folderId: GROUP }),
        tab('m2', 'https://two.example/', { folderId: GROUP }),
        tab('a', 'https://a.example/'),
        tab('b', 'https://b.example/')
      ])
    )

    // b joins the group (dropped on m2; the browser has moved it): two rows now. The group card
    // holds the old height for the commit, so the row below is laid out where it was, one card
    // shorter; b is laid out in its inner slot, the second row of the body.
    bodyHeights.set(`group:${GROUP}`, bodyOf(2))
    place('b', 10, 178)
    place('a', 0, groupOf(1) + 10)
    place(NEW_TAB_CELL, 110, groupOf(1) + 10)
    render(
      stateOf([
        tab('m1', 'https://one.example/', { folderId: GROUP }),
        tab('m2', 'https://two.example/', { folderId: GROUP }),
        tab('b', 'https://b.example/', { folderId: GROUP }),
        tab('a', 'https://a.example/')
      ])
    )
    const group = cellOf(`group:${GROUP}`)
    const b = cellOf('b')
    const a = cellOf('a')
    const plus = cellOf(NEW_TAB_CELL)
    expect(groupAround('b')).toBe(`group:${GROUP}`)
    // The height sets out from the old one on its spring…
    expect(layoutAnimations.has(`group:${GROUP}`)).toBe(true)
    expect(group.style.height).toBe(`${groupOf(1)}px`)
    // …b glides from its loose slot into its inner one from the first frame…
    expect(translate(b)).toEqual({ x: 100, y: 0 })
    // …and a and the New Tab card are held where they were: a is laid out where it was and
    // drawn there, the New Tab card is laid out a column over and a row up and drawn back where
    // it was. Nothing below moves yet.
    expect(a.style.transform).toBe('')
    expect(translate(plus)).toEqual({ x: -110, y: 140 })

    // The height grows; the browser lays the row below out lower for each frame's height, and
    // the hold keeps it where it was, while b's glide runs.
    const rowBelowAt = (h: number): void => {
      place('a', 0, h + 10)
      place(NEW_TAB_CELL, 110, h + 10)
    }
    let previous = groupOf(1)
    const grew = framesUntil(() => {
      const h = parseFloat(group.style.height)
      if (h > previous) rowBelowAt(h)
      previous = h
      return h > groupOf(1) + 40
    })
    expect(grew).toBeGreaterThan(0)
    const h = parseFloat(group.style.height)
    expect(translate(b).x).toBeLessThan(100)
    expect(translate(b).x).toBeGreaterThan(0)
    expect(translate(a).y).toBeCloseTo(groupOf(1) - h, 3)
    expect(translate(plus).y).toBeCloseTo(groupOf(1) - h + 140, 3)
    expect(layoutAnimations.has(`group:${GROUP}`)).toBe(true)
    // Until the height settles: then the row below glides down to its slots, together.
    rowBelowAt(groupOf(2))
    const settledAt = framesUntil(() => !layoutAnimations.has(`group:${GROUP}`))
    expect(settledAt).toBeGreaterThan(0)
    expect(translate(a).y).toBeLessThan(0)
    expect(translate(a).y).toBeGreaterThanOrEqual(groupOf(1) - groupOf(2))
    act(() => settleSprings())
    expect(group.style.height).toBe('')
    expect(a.style.transform).toBe('')
    expect(plus.style.transform).toBe('')
    expect(b.style.transform).toBe('')
    // An existing group keeps its header and tint throughout; only a group being made switches
    // them on at the end.
    expect(group.dataset.chrome).toBeUndefined()
  })

  it('the group dissolving: it shrinks to nothing with its chrome on, and leaves when it has', () => {
    // A group of one, then two loose cards and the New Tab card.
    const single = stateOf([
      tab('m1', 'https://one.example/', { folderId: GROUP }),
      tab('a', 'https://a.example/'),
      tab('b', 'https://b.example/')
    ])
    bodyHeights.set(`group:${GROUP}`, bodyOf(1))
    place(`group:${GROUP}`, 0, 0, 100, groupOf(1))
    place('m1', 6, 36)
    place('a', 110, 0)
    place('b', 0, groupOf(1) + 10)
    place(NEW_TAB_CELL, 110, groupOf(1) + 10)
    render(single)
    expect(cellOf(`group:${GROUP}`).dataset.dissolving).toBeUndefined()

    // m1 leaves; the group is empty and the folder is gone with it. The grid keeps the group
    // card, shrinking to nothing where it stood, out of the flow: m1 takes its cell, and the
    // loose row moves up a row in layout.
    place('m1', 0, 0)
    place('a', 110, 0)
    place('b', 0, 140)
    place(NEW_TAB_CELL, 110, 140)
    render(
      stateOf(
        [
          tab('m1', 'https://one.example/'),
          tab('a', 'https://a.example/'),
          tab('b', 'https://b.example/')
        ],
        []
      )
    )
    const group = cellOf(`group:${GROUP}`)
    expect(group).toBeTruthy()
    expect(group.dataset.dissolving).toBe('true')
    expect(group.dataset.chrome).toBeUndefined()
    expect(group.style.position).toBe('absolute')
    expect(group.style.height).toBe(`${groupOf(1)}px`)
    expect(layoutAnimations.has(`group:${GROUP}`)).toBe(true)
    // m1 glides out of it from the first frame; b and the New Tab card are held where they were,
    // a row under the card shrinking away.
    const m1 = cellOf('m1')
    const b = cellOf('b')
    const plus = cellOf(NEW_TAB_CELL)
    expect(translate(m1)).toEqual({ x: 6, y: 36 })
    expect(translate(b)).toEqual({ x: 0, y: groupOf(1) + 10 - 140 })
    expect(translate(plus)).toEqual({ x: 0, y: groupOf(1) + 10 - 140 })
    const shrank = framesUntil(() => parseFloat(group.style.height) < groupOf(1) - 40)
    expect(shrank).toBeGreaterThan(0)
    expect(translate(b)).toEqual({ x: 0, y: groupOf(1) + 10 - 140 })
    expect(group.dataset.chrome).toBeUndefined()
    // Once its spring has run the card is gone from the grid, and the row below glides up.
    const settledAt = framesUntil(() => !layoutAnimations.has(`group:${GROUP}`))
    expect(settledAt).toBeGreaterThan(0)
    expect(translate(b).y).toBeGreaterThan(0)
    expect(translate(b).y).toBeLessThanOrEqual(groupOf(1) + 10 - 140)
    act(() => settleSprings())
    expect(grid().querySelector(`[data-cell="group:${GROUP}"]`)).toBeNull()
    expect(m1.style.transform).toBe('')
    expect(b.style.transform).toBe('')
    expect(plus.style.transform).toBe('')
  })

  it('a group being made: it grows on its spring with its chrome off until the glide ends', () => {
    const loose = stateOf(
      [
        tab('a', 'https://a.example/'),
        tab('b', 'https://b.example/'),
        tab('c', 'https://c.example/')
      ],
      []
    )
    place('a', 0, 0)
    place('b', 110, 0)
    place('c', 0, 140)
    place(NEW_TAB_CELL, 110, 140)
    render(loose)

    // a was dropped on b: the two are a group now, across the top. The card sets out at the
    // height of the bare row it was made from (its body less the padding) before the grid is
    // measured, so the browser lays the rows below out for that height, and for each height the
    // spring runs through.
    const start = Math.max(GROUP_HEADER, bodyOf(1) - GROUP_PAD)
    const rowBelowAt = (h: number): void => {
      place(`group:${GROUP}`, 0, 0, 220, h)
      place('c', 0, h + 10)
      place(NEW_TAB_CELL, 110, h + 10)
    }
    bodyHeights.set(`group:${GROUP}`, bodyOf(1))
    rowBelowAt(start)
    place('a', 10, 36)
    place('b', 120, 36)
    render(
      stateOf([
        tab('a', 'https://a.example/', { folderId: GROUP }),
        tab('b', 'https://b.example/', { folderId: GROUP }),
        tab('c', 'https://c.example/')
      ])
    )
    const group = cellOf(`group:${GROUP}`)
    // Header and tint are off…
    expect(group.dataset.chrome).toBe('off')
    // …the height runs from the row of bare cards…
    expect(layoutAnimations.has(`group:${GROUP}`)).toBe(true)
    expect(group.style.height).toBe(`${start}px`)
    // …a and b glide into their inner slots from the first frame…
    expect(translate(cellOf('a'))).toEqual({ x: -10, y: -36 })
    expect(translate(cellOf('b'))).toEqual({ x: -10, y: -36 })
    // …and c and the New Tab card are held where they were while the group grows under them.
    const c = cellOf('c')
    const plus = cellOf(NEW_TAB_CELL)
    expect(c.style.transform).toBe('')
    expect(plus.style.transform).toBe('')
    let previous = start
    const grew = framesUntil(() => {
      const h = parseFloat(group.style.height)
      if (h > previous) rowBelowAt(h)
      previous = h
      return h > start + 20
    })
    expect(grew).toBeGreaterThan(0)
    expect(group.dataset.chrome).toBe('off')
    const h = parseFloat(group.style.height)
    expect(translate(c).y).toBeCloseTo(start - h, 3)
    expect(translate(plus).y).toBeCloseTo(start - h, 3)
    // The height has settled: the chrome switches on with the glide's end, and the row below
    // glides down to its slots.
    rowBelowAt(groupOf(1))
    const settledAt = framesUntil(() => !layoutAnimations.has(`group:${GROUP}`))
    expect(settledAt).toBeGreaterThan(0)
    expect(translate(c).y).toBeCloseTo(start - groupOf(1), 3)
    act(() => settleSprings())
    expect(group.dataset.chrome).toBeUndefined()
    expect(group.style.height).toBe('')
    expect(c.style.transform).toBe('')
    expect(plus.style.transform).toBe('')
  })
})

// --- (D) the New Tab card never departs (v2 §11.4) ------------------------------------------------

describe('the New Tab card', () => {
  it('glides into the gap a closing neighbour leaves and never departs, fades or scales', () => {
    const loose = stateOf(
      [
        tab('a', 'https://a.example/'),
        tab('b', 'https://b.example/'),
        tab('c', 'https://c.example/')
      ],
      []
    )
    place('a', 0, 0)
    place('b', 110, 0)
    place('c', 0, 140)
    place(NEW_TAB_CELL, 110, 140)
    render(loose)
    const plus = cellOf(NEW_TAB_CELL)
    const animate = vi.fn()
    plus.animate = animate

    // c closes from its card: c departs in place – only c.
    const close = cellOf('c').querySelector<HTMLElement>('[aria-label="Close tab"]')!
    act(() => close.click())
    expect(commands()).toEqual([['tab.close', { tabId: 'c' }]])
    expect(departStore.get().items.map((i) => i.key)).toEqual(['c'])
    expect(departStore.get().hidden.has(NEW_TAB_CELL)).toBe(false)
    // The exit stands still over c until the grid shows the gap.
    expect(departStore.get().released.has('c')).toBe(false)

    // The browser shows the close: the New Tab card's slot is c's. It glides there – from where
    // it was, on the same frame c's exit starts – and nothing else about it changes.
    place(NEW_TAB_CELL, 0, 140)
    render(stateOf([tab('a', 'https://a.example/'), tab('b', 'https://b.example/')], []))
    expect(departStore.get().released.has('c')).toBe(true)
    expect(translate(plus)).toEqual({ x: 110, y: 0 })
    expect(plus.style.opacity).toBe('')
    expect(plus.style.transform).not.toContain('scale')
    act(() => settleSprings())
    expect(plus.style.transform).toBe('')
    expect(plus.style.opacity).toBe('')
    expect(animate).not.toHaveBeenCalled()
    expect(departStore.get().items).toEqual([])
    expect(cellOf(NEW_TAB_CELL)).toBe(plus)
  })
})

// --- (E) reduced motion (v2 §11.3) ---------------------------------------------------------------

describe('under reduced motion', () => {
  const loose = (): UIState =>
    stateOf(
      [
        tab('a', 'https://a.example/'),
        tab('b', 'https://b.example/'),
        tab('c', 'https://c.example/')
      ],
      []
    )
  const proto = HTMLElement.prototype as { animate?: unknown }
  const hadAnimate = proto.animate
  /** Every `element.animate()` call: the element, the keyframes and the options. */
  let fades: Array<{ el: HTMLElement; frames: unknown; options: KeyframeAnimationOptions }> = []
  let finish: Array<() => void> = []

  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }))
    fades = []
    finish = []
    // happy-dom has no Web Animations: a stand-in that records the call and can be finished.
    proto.animate = function (
      this: HTMLElement,
      frames: unknown,
      options: KeyframeAnimationOptions
    ): { onfinish: (() => void) | null; cancel: () => void } {
      fades.push({ el: this, frames, options })
      const fade = { onfinish: null as (() => void) | null, cancel: () => undefined }
      finish.push(() => fade.onfinish?.())
      return fade
    }
    place('a', 0, 0)
    place('b', 110, 0)
    place('c', 0, 140)
    place(NEW_TAB_CELL, 110, 140)
  })
  afterEach(() => {
    proto.animate = hadAnimate
  })

  it('the grid appears without its scale; a drag tracks the finger 1:1 and the release jumps', () => {
    render(loose())
    // No scale on the way in: the CSS fades the grid in over 120 ms (v2 §11.3).
    expect(host!.querySelector<HTMLElement>('.zen-overview')!.style.transform).toBe('')
    pickUp('a')
    // The lift's springs jumped: the card is at scale(1.02) with no frame run.
    expect(frames.size).toBe(0)
    expect(liftStore.get().scale).toBeCloseTo(1.02, 3)
    const origin = liftStore.get().ghost!
    const from = at('a', 0.5, 0.5)
    // 1:1: the ghost is where the finger put it in the very event, no spring in between (the
    // one frame a move asks for is the autoscroll's look at the edges, which scrolls nothing here).
    drag(from.x + 30, from.y + 44)
    expect(liftStore.get().ghost).toMatchObject({ x: origin.x + 30, y: origin.y + 44 })
    act(() => frame())
    expect(liftStore.get().ghost).toMatchObject({ x: origin.x + 30, y: origin.y + 44 })
    drag(from.x + 61, from.y + 90)
    expect(liftStore.get().ghost).toMatchObject({ x: origin.x + 61, y: origin.y + 90 })
    // Back over its own card and let go there: nothing changes, and the release jumps home –
    // the gesture is over in the same event, without a frame.
    drag(from.x, from.y)
    expect(liftStore.get().ghost).toMatchObject({ x: origin.x, y: origin.y })
    letGo(from.x, from.y)
    expect(frames.size).toBe(0)
    expect(liftStore.get()).toMatchObject({ phase: 'idle', tabId: null, target: null, slot: null })
    expect(commands()).toEqual([])
  })

  it('a closing card fades out in place over 120 ms with no shrink, and its neighbours cross-fade into their slots', () => {
    render(loose())
    const plus = cellOf(NEW_TAB_CELL)
    const close = cellOf('c').querySelector<HTMLElement>('[aria-label="Close tab"]')!
    act(() => close.click())
    expect(departStore.get().items.map((i) => i.key)).toEqual(['c'])
    // Still over its card until the browser shows the close: nothing has started.
    expect(fades).toEqual([])
    // The close lands: the exit fades where it stands; the New Tab card is in c's slot at once,
    // fading in there instead of gliding.
    place(NEW_TAB_CELL, 0, 140)
    render(stateOf([tab('a', 'https://a.example/'), tab('b', 'https://b.example/')], []))
    expect(frames.size).toBe(0)
    const exit = fades.find(({ el }) => !el.hasAttribute('data-cell'))!
    expect(exit).toBeTruthy()
    expect(exit.frames).toEqual([{ opacity: 1 }, { opacity: 0 }])
    expect(exit.options).toMatchObject({ duration: REDUCED_FADE_MS, fill: 'forwards' })
    expect(exit.el.style.transform).toBe('')
    expect(exit.el.style.opacity).toBe('')
    const glide = fades.find(({ el }) => el === plus)!
    expect(glide).toBeTruthy()
    expect(glide.frames).toEqual([{ opacity: 0 }, { opacity: 1 }])
    expect(glide.options).toMatchObject({ duration: REDUCED_FADE_MS })
    expect(plus.style.transform).toBe('')
    // The fade is over: the exit is gone.
    act(() => {
      for (const done of finish) done()
    })
    expect(departStore.get().items).toEqual([])
  })
})
