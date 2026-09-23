// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, StrictMode } from 'react'
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

const SPACE = 'space'
const GROUP = 'g'

/**
 * The browser: every command is taken; a group made on the grid is `GROUP`; nothing was closed
 * lately (the search's reach, `useSearchReach`, reads the list while a query stands).
 */
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) =>
  name === 'folder.create' ? GROUP : name === 'session.recentlyClosed' ? [] : null
)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { NEW_TAB_CELL, TabOverview } = await import('../TabOverview')
const { activeLiftPointer, cancelLift, liftStore } = await import('../useCardLift')
const { privateTabsStore, resetOverviewPane } = await import('@renderer/lib/privateTabs')
const { BAR_ITEMS, barContext, tabCount } = await import('../barItems')
const { PRIVATE_CONTAINER_ID } = await import('@shared/types')
const { clearDepartures, departStore } = await import('../departureStore')
const { GROUP_PAD } = await import('../GroupCard')
const { GROUP_HEADER } = await import('../groupCardHeader')
/** Where a group's member rows sit: the title row, the inset, then a 130 card and its 12 gap. */
const ROW_1 = GROUP_HEADER + 4
const ROW_2 = ROW_1 + 142
const { collectCells, FlipTracker, layoutAnimations, REDUCED_FADE_MS } =
  await import('@renderer/lib/motion/flip')
const { SLOT_DWELL_MS } = await import('@renderer/lib/gestures/dropTarget')

// --- a profile ---------------------------------------------------------------------------------

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
    bookmarks: [],
    closingTabIds: [],
    // Sync off: the tab search's reach has no other devices to look through (TAB-21).
    sync: { enabled: false, scope: { openTabs: false } }
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
/** The pane's slot (the strip and the grid or the explainer), under the header and the segment. */
const SLOT = 'slot'
const DEFAULT_LAYOUT: Array<[string, DOMRect]> = [
  [GRID, new DOMRect(0, 0, 220, 600)],
  [SLOT, new DOMRect(4, 56, 212, 600)],
  [`group:${GROUP}`, new DOMRect(0, 0, 220, 170)],
  ['m1', new DOMRect(10, ROW_1, 100, 130)],
  ['m2', new DOMRect(120, ROW_1, 100, 130)],
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
  if (this.classList.contains('zen-overview-pane')) return layout.get(SLOT)!
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

/**
 * Rendered under `StrictMode`, as every dev build (the preview host) renders it: React mounts,
 * runs every effect's cleanup and mounts again, so a subscription taken once and dropped in a
 * cleanup would be gone for good – the tracker's hearing of the groups' height animations was,
 * once.
 */
function render(state: UIState): HTMLElement {
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  act(() =>
    root!.render(
      createElement(
        StrictMode,
        null,
        createElement(TabOverview, { state, overview: OPEN, area: AREA, edge: 'bottom' })
      )
    )
  )
  return host!
}

const grid = (): HTMLElement => host!.querySelector<HTMLElement>('.zen-overview-grid')!
const cellOf = (key: string): HTMLElement => grid().querySelector(`[data-cell="${key}"]`)!
/** The group card a cell is drawn inside, or null when it is loose. */
const groupAround = (key: string): string | null =>
  cellOf(key).parentElement?.closest('[data-cell^="group:"]')?.getAttribute('data-cell') ?? null

/** The commands the grid sent the browser, in order (not the cards' reads of their pictures). */
const commands = (): Array<[string, unknown]> =>
  invoke.mock.calls
    .filter(([name]) => name !== 'thumbnail.load')
    .map(([name, args]) => [name, args] as [string, unknown])

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

// --- the card and group menus ------------------------------------------------------------------

/*
 * A held card's menu (#94) and a held group's menu (#147) are menus of the overview: their rows
 * are menu items and take Title Case (v2 §9.1, the ruling from #207's review), where the card's
 * X, the header's controls and the sheets' titles stay sentence case.
 */
describe('the card and group menus', () => {
  const sheetLabels = (): Array<string | null> =>
    [...document.querySelectorAll<HTMLElement>('.zen-sheet-item')].map((el) => el.textContent)
  const grouped = (): UIState =>
    stateOf([
      tab('m1', 'https://one.example/', { folderId: GROUP }),
      tab('m2', 'https://two.example/', { folderId: GROUP }),
      tab('a', 'https://a.example/'),
      tab('b', 'https://b.example/')
    ])

  it("a held card's rows are menu items in Title Case, the group's own name as given; Select Tabs leads (TAB-08)", () => {
    render(grouped())
    pickUp('a')
    const p = at('a', 0.5, 0.5)
    letGo(p.x, p.y)
    act(() => elapse(300))
    act(() => settleSprings())
    expect(sheetLabels()).toEqual([
      'Select Tabs',
      'New Group',
      'Add to Research',
      'Close Other Tabs (3)',
      'Close Tab'
    ])
  })

  it("a held member's rows offer the move out of its group in Title Case", () => {
    render(grouped())
    pickUp('m1')
    const p = at('m1', 0.5, 0.5)
    letGo(p.x, p.y)
    act(() => elapse(300))
    act(() => settleSprings())
    expect(sheetLabels()).toEqual([
      'Select Tabs',
      'New Group',
      'Remove from Group',
      'Close Other Tabs (3)',
      'Close Tab'
    ])
  })

  it("a held group's rows are menu items in Title Case, the count with its unit", () => {
    render(grouped())
    // A right click is the hold, for the mouse (`useLongPress`): the header opens its sheet.
    const header = document.querySelector<HTMLElement>('[aria-label^="Research, tab group"]')!
    act(() => {
      header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    act(() => settleSprings())
    expect(sheetLabels()).toEqual([
      'Rename',
      'Collapse',
      'Ungroup',
      'Close Group (2 Tabs)',
      'Delete Group'
    ])
    // Close Group keeps the group, saved with its pages (`folder.close`): the plain ink, as on
    // every group menu; Delete Group alone takes the danger ink (v2 §6).
    const items = [...document.querySelectorAll<HTMLElement>('.zen-sheet-item')]
    const ink = (label: string): string =>
      items.find((el) => el.textContent?.startsWith(label))!.style.color
    expect(ink('Close Group')).toBe('')
    expect(ink('Delete Group')).toBe('var(--zen-danger)')
    // The colour swatches are a radio group, named for assistive technology; not menu rows.
    expect(document.querySelector('[role="radiogroup"][aria-label="Colour"]')).not.toBeNull()
  })

  it('a group of one counts its tab in the singular', () => {
    render(
      stateOf([
        tab('m1', 'https://one.example/', { folderId: GROUP }),
        tab('a', 'https://a.example/')
      ])
    )
    const header = document.querySelector<HTMLElement>('[aria-label^="Research, tab group"]')!
    act(() => {
      header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    act(() => settleSprings())
    expect(sheetLabels()).toContain('Close Group (1 Tab)')
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

// --- a drop on a card: one order, making a group or joining one (v2 §11.4) -----------------------

describe('a drop on a card', () => {
  /** The keys of the cards inside the group, in the order the group shows them. */
  const membersShown = (): string[] =>
    [...cellOf(`group:${GROUP}`).querySelectorAll('[data-cell]')].map((el) =>
      el.getAttribute('data-cell')!
    )

  it('a group made by a drop orders like joining one: the dropped card lands right behind the target', async () => {
    // Three loose cards, a ahead of c in the grid.
    place('a', 0, 0)
    place('b', 110, 0)
    place('c', 0, 140)
    place(NEW_TAB_CELL, 110, 140)
    render(
      stateOf(
        [
          tab('a', 'https://a.example/'),
          tab('b', 'https://b.example/'),
          tab('c', 'https://c.example/')
        ],
        []
      )
    )
    pickUp('a')
    const ontoC = at('c', 0.5, 0.5)
    drag(ontoC.x, ontoC.y)
    expect(liftStore.get().target).toBe('card:c')
    letGo(ontoC.x, ontoC.y)
    await act(async () => {})
    // a goes right behind c first, then the two are grouped – not grouped where they stood,
    // which would have put a, the dropped card, ahead of the card it was dropped on.
    expect(commands()).toEqual([
      ['tab.move', { tabId: 'a', spaceId: SPACE, section: 'regular', index: 2 }],
      ['folder.create', expect.objectContaining({ spaceId: SPACE, rename: false })],
      ['tab.moveToFolder', { tabId: 'c', folderId: GROUP }],
      ['tab.moveToFolder', { tabId: 'a', folderId: GROUP }]
    ])
    // The browser shows it: b loose, then the group with c first and a behind it.
    const oneRow = 130 + GROUP_PAD
    bodyHeights.set(`group:${GROUP}`, oneRow)
    place('b', 0, 0)
    place(`group:${GROUP}`, 0, 140, 220, GROUP_HEADER + oneRow)
    place('c', 10, 176)
    place('a', 120, 176)
    place(NEW_TAB_CELL, 0, 140 + GROUP_HEADER + oneRow + 10)
    land(
      stateOf([
        tab('b', 'https://b.example/'),
        tab('c', 'https://c.example/', { folderId: GROUP }),
        tab('a', 'https://a.example/', { folderId: GROUP })
      ])
    )
    expect(liftStore.get().phase).toBe('idle')
    expect(membersShown()).toEqual(['c', 'a'])
    invoke.mockClear()

    // Joining that group by a drop on a: the same rule, b lands right behind a.
    pickUp('b')
    const ontoA = at('a', 0.5, 0.5)
    drag(ontoA.x, ontoA.y)
    expect(liftStore.get().target).toBe('card:a')
    letGo(ontoA.x, ontoA.y)
    expect(commands()).toEqual([
      ['tab.move', { tabId: 'b', spaceId: SPACE, section: 'regular', index: 2 }],
      ['tab.moveToFolder', { tabId: 'b', folderId: GROUP }]
    ])
    const twoRows = 2 * 130 + 12 + GROUP_PAD
    bodyHeights.set(`group:${GROUP}`, twoRows)
    place(`group:${GROUP}`, 0, 0, 220, GROUP_HEADER + twoRows)
    place('c', 10, ROW_1)
    place('a', 120, ROW_1)
    place('b', 10, ROW_2)
    place(NEW_TAB_CELL, 0, GROUP_HEADER + twoRows + 10)
    land(
      stateOf([
        tab('c', 'https://c.example/', { folderId: GROUP }),
        tab('a', 'https://a.example/', { folderId: GROUP }),
        tab('b', 'https://b.example/', { folderId: GROUP })
      ])
    )
    expect(liftStore.get().phase).toBe('idle')
    expect(membersShown()).toEqual(['c', 'a', 'b'])
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
    place('m1', 10, ROW_1)
    place('m2', 120, ROW_1)
    place('m3', 10, ROW_2)
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
    expect(translate(m3)).toEqual({ x: 10, y: ROW_2 - (groupOf(2) + 10) })
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
    place('m1', 10, ROW_1)
    place('m2', 120, ROW_1)
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
    place('b', 10, ROW_2)
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
    place('m1', 6, ROW_1)
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
    expect(translate(m1)).toEqual({ x: 6, y: ROW_1 })
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
    place('a', 10, ROW_1)
    place('b', 120, ROW_1)
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
    expect(translate(cellOf('a'))).toEqual({ x: -10, y: -ROW_1 })
    expect(translate(cellOf('b'))).toEqual({ x: -10, y: -ROW_1 })
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

  it("a group made by a drop forms in one step: the stand-in's slot goes with the confirmation", async () => {
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
    pickUp('c')
    // Onto the left edge of a, resting there: c's stand-in takes the slot before a, and the
    // grid reflows – a moves a column over, b down a row.
    const edge = at('a', 0.08, 0.5)
    drag(edge.x, edge.y)
    place('c', 0, 0)
    place('a', 110, 0)
    place('b', 0, 140)
    place(NEW_TAB_CELL, 110, 140)
    act(() => elapse(SLOT_DWELL_MS))
    expect(liftStore.get().slot).toEqual({ folderId: null, index: 0 })
    expect(groupAround('c')).toBeNull()
    act(() => settleSprings())
    // Then onto the middle of a, where it is now, and let go: the two become a group. The
    // stand-in keeps its slot until the browser shows the drop.
    const middle = at('a', 0.5, 0.5)
    drag(middle.x, middle.y)
    expect(liftStore.get().target).toBe('card:a')
    letGo(middle.x, middle.y)
    expect(liftStore.get()).toMatchObject({
      phase: 'dropping',
      target: null,
      slot: { folderId: null, index: 0 }
    })
    await act(async () => {})
    // c goes right behind a (the order joining a group gives), and the two are grouped.
    expect(commands()).toEqual([
      ['tab.move', { tabId: 'c', spaceId: SPACE, section: 'regular', index: 1 }],
      ['folder.create', expect.objectContaining({ spaceId: SPACE, rename: false })],
      ['tab.moveToFolder', { tabId: 'a', folderId: GROUP }],
      ['tab.moveToFolder', { tabId: 'c', folderId: GROUP }]
    ])

    // The browser shows the group: a and c in it across the top, b and the New Tab card below.
    // The card sets out at the height of the bare row (see above), the grid laid out for it.
    const start = Math.max(GROUP_HEADER, bodyOf(1) - GROUP_PAD)
    const rowBelowAt = (h: number): void => {
      place(`group:${GROUP}`, 0, 0, 220, h)
      place('b', 0, h + 10)
      place(NEW_TAB_CELL, 110, h + 10)
    }
    bodyHeights.set(`group:${GROUP}`, bodyOf(1))
    rowBelowAt(start)
    place('a', 10, ROW_1)
    place('c', 120, ROW_1)
    render(
      stateOf([
        tab('a', 'https://a.example/', { folderId: GROUP }),
        tab('c', 'https://c.example/', { folderId: GROUP }),
        tab('b', 'https://b.example/')
      ])
    )
    // One step: the stand-in's slot went with the confirmation, so c is in the group from this
    // very render – not loose in the slot it held, with a alone in the group, joining once the
    // ghost had landed – and the group forms with both cards, header and tint off, its height
    // setting out from the bare row…
    expect(liftStore.get()).toMatchObject({ phase: 'dropping', slot: null })
    expect(groupAround('c')).toBe(`group:${GROUP}`)
    expect(groupAround('a')).toBe(`group:${GROUP}`)
    const group = cellOf(`group:${GROUP}`)
    expect(group.querySelectorAll('[data-cell]')).toHaveLength(2)
    expect(group.dataset.chrome).toBe('off')
    expect(layoutAnimations.has(`group:${GROUP}`)).toBe(true)
    expect(group.style.height).toBe(`${start}px`)
    // …a and c gliding into their inner slots from their loose ones, b held where it was.
    expect(translate(cellOf('c'))).toEqual({ x: -120, y: -ROW_1 })
    expect(translate(cellOf('a'))).toEqual({ x: 100, y: -ROW_1 })
    expect(cellOf('b').style.transform).toBe('')
    // The height runs out, the row below laid out for it; the ghost lands; the chrome comes on
    // at the end – and no second height run, no second glide, follows the landing.
    const runs = vi.spyOn(layoutAnimations, 'start')
    let previous = start
    framesUntil(() => {
      const h = parseFloat(group.style.height)
      if (h > previous) rowBelowAt(h)
      previous = h
      return !layoutAnimations.has(`group:${GROUP}`)
    })
    rowBelowAt(groupOf(1))
    act(() => settleSprings())
    expect(liftStore.get().phase).toBe('idle')
    expect(runs).not.toHaveBeenCalled()
    expect(group.dataset.chrome).toBeUndefined()
    expect(group.style.height).toBe('')
    expect(groupAround('c')).toBe(`group:${GROUP}`)
    expect(cellOf('c').style.transform).toBe('')
    expect(cellOf('a').style.transform).toBe('')
    expect(cellOf('b').style.transform).toBe('')
  })
})

// --- (C′) a group whose every card goes leaves whole (v2 §11.4, ruling 3) -------------------------

describe('a group whose every card goes', () => {
  const bodyOf = (rows: number): number => rows * 130 + (rows - 1) * 12 + GROUP_PAD
  const groupOf = (rows: number): number => GROUP_HEADER + bodyOf(rows)
  /** The exit `Departures` draws over a group card: a `.zen-group` that is no cell of the grid. */
  const groupGhost = (): HTMLElement | null =>
    [...host!.querySelectorAll<HTMLElement>('.zen-group')].find(
      (el) => !el.hasAttribute('data-cell')
    ) ?? null
  /** A group of one at the top left, a loose card beside it, a row below, the New Tab card. */
  const withOne = (): UIState =>
    stateOf([
      tab('m1', 'https://one.example/', { folderId: GROUP }),
      tab('a', 'https://alpha.test/'),
      tab('b', 'https://beta.test/')
    ])
  const layOut = (): void => {
    bodyHeights.set(`group:${GROUP}`, bodyOf(1))
    place(`group:${GROUP}`, 0, 0, 100, groupOf(1))
    place('m1', 6, ROW_1)
    place('a', 110, 0)
    place('b', 0, groupOf(1) + 10)
    place(NEW_TAB_CELL, 110, groupOf(1) + 10)
  }
  /** The grid without the group: a takes its column, the row below moves up. */
  const withoutGroup = (): void => {
    place('a', 0, 0)
    place('b', 110, 0)
    place(NEW_TAB_CELL, 0, 140)
  }
  const typeQuery = (text: string): void => {
    const input = host!.querySelector<HTMLInputElement>('#overview-search')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  /**
   * The commit that takes the group's card off the grid: no dissolving card, no height spring
   * to wait for, the exit released, and every cell drawn where it was, about to glide.
   */
  const leftInOneCommit = (a: HTMLElement, b: HTMLElement): void => {
    expect(grid().querySelector(`[data-cell="group:${GROUP}"]`)).toBeNull()
    expect(grid().querySelector('[data-dissolving]')).toBeNull()
    expect(layoutAnimations.has(`group:${GROUP}`)).toBe(false)
    expect(departStore.get().released.has(`group:${GROUP}`)).toBe(true)
    expect(translate(a)).toEqual({ x: 110, y: 0 })
    expect(translate(b)).toEqual({ x: -110, y: groupOf(1) + 10 })
  }

  it("its last card's X: the frame departs in place as a card does – one exit, no shrink, the cells below gliding on the same frame", () => {
    layOut()
    render(withOne())
    const group = cellOf(`group:${GROUP}`)
    const a = cellOf('a')
    const b = cellOf('b')
    const plus = cellOf(NEW_TAB_CELL)
    const close = cellOf('m1').querySelector<HTMLElement>('[aria-label^="Close "]')!
    act(() => close.click())
    // The group closes as a group – saved with its page – and departs as one: the frame's exit,
    // m1 drawn inside it, and no exit of m1's own.
    expect(commands()).toEqual([['folder.close', { folderId: GROUP }]])
    expect(departStore.get().items).toMatchObject([
      {
        key: `group:${GROUP}`,
        kind: 'group',
        tabs: [{ id: 'm1' }],
        rect: { x: 0, y: 0, width: 100, height: groupOf(1) }
      }
    ])
    expect(departStore.get().hidden.has('m1')).toBe(true)
    const ghost = groupGhost()!
    expect(ghost).toBeTruthy()
    expect(ghost.querySelectorAll('.zen-overview-card')).toHaveLength(1)
    // The exit stands still over the card until the browser shows the close; the card is whole
    // under it, not shrinking.
    expect(departStore.get().released.has(`group:${GROUP}`)).toBe(false)
    expect(ghost.style.opacity).toBe('')
    expect(group.style.opacity).toBe('0')
    expect(group.dataset.dissolving).toBeUndefined()
    expect(layoutAnimations.has(`group:${GROUP}`)).toBe(false)

    // The close lands (the folder stays, saved): the card is off the grid in this very commit.
    withoutGroup()
    render(stateOf([tab('a', 'https://alpha.test/'), tab('b', 'https://beta.test/')]))
    leftInOneCommit(a, b)
    expect(groupGhost()).toBe(ghost)
    expect(translate(plus)).toEqual({ x: 110, y: groupOf(1) + 10 - 140 })
    // One frame: the exit fades and shrinks where the card stood, and every cell moves – the
    // one wave, on the same spring frame.
    act(() => frame())
    expect(parseFloat(ghost.style.opacity)).toBeLessThan(1)
    expect(ghost.style.transform).toMatch(/^scale\(0\.9\d*\)$/)
    expect(Math.abs(translate(a).x)).toBeLessThan(110)
    expect(Math.abs(translate(b).y)).toBeLessThan(groupOf(1) + 10)
    expect(Math.abs(translate(plus).y)).toBeLessThan(groupOf(1) + 10 - 140)
    act(() => settleSprings())
    expect(a.style.transform).toBe('')
    expect(b.style.transform).toBe('')
    expect(plus.style.transform).toBe('')
    expect(departStore.get().items).toEqual([])
    expect(groupGhost()).toBeNull()
  })

  it('the search dropping its every card: the frame leaves whole – one exit, its card drawn in it – and comes back whole', () => {
    layOut()
    render(withOne())
    const group = cellOf(`group:${GROUP}`)
    const a = cellOf('a')
    const b = cellOf('b')
    act(() => host!.querySelector<HTMLElement>('[data-testid="overview-search-toggle"]')!.click())
    // "test" is in a's and b's addresses and not in m1's: the group's one card is dropped, and
    // the group with it – one exit, m1 drawn inside it, none of m1's own; the New Tab card's
    // beside it (§9.34). The grid re-lays out without them.
    withoutGroup()
    typeQuery('test')
    expect(departStore.get().items.map((i) => [i.key, i.kind])).toEqual([
      [`group:${GROUP}`, 'group'],
      [NEW_TAB_CELL, 'new-tab']
    ])
    expect(departStore.get().items[0]).toMatchObject({ filtered: true, tabs: [{ id: 'm1' }] })
    expect(departStore.get().hidden.has('m1')).toBe(true)
    leftInOneCommit(a, b)
    const ghost = groupGhost()!
    expect(ghost.querySelectorAll('.zen-overview-card')).toHaveLength(1)
    act(() => frame())
    expect(parseFloat(ghost.style.opacity)).toBeLessThan(1)
    expect(Math.abs(translate(b).y)).toBeLessThan(groupOf(1) + 10)
    act(() => settleSprings())
    expect(departStore.get().items).toEqual([])
    expect(groupGhost()).toBeNull()
    expect(a.style.transform).toBe('')
    expect(b.style.transform).toBe('')

    // The query cleared: the group is back whole, its card entering as the exit run backwards
    // – fading in from .9 – with m1 drawn in it and no entrance of m1's own; the New Tab card
    // comes back with it.
    layOut()
    typeQuery('')
    const back = cellOf(`group:${GROUP}`)
    expect(back).toBeTruthy()
    expect(back).not.toBe(group)
    expect(back.dataset.dissolving).toBeUndefined()
    expect(departStore.get().items).toEqual([])
    act(() => frame())
    expect(parseFloat(back.style.opacity)).toBeLessThan(1)
    expect(back.style.opacity).not.toBe('0')
    expect(cellOf('m1').style.opacity).toBe('')
    expect(parseFloat(cellOf(NEW_TAB_CELL).style.opacity)).toBeLessThan(1)
    act(() => settleSprings())
    expect(back.style.opacity).toBe('')
    expect(cellOf(NEW_TAB_CELL).style.opacity).toBe('')
  })

  it('its last card swiped off: the frame leaves whole as it stands on the close, its slot empty', () => {
    layOut()
    render(withOne())
    const button = cellOf('m1').querySelector<HTMLElement>('[role="button"]')!
    const from = at('m1', 0.5, 0.5)
    pointer('pointerdown', button, from.x, from.y)
    act(() => elapse(30))
    pointer('pointermove', button, from.x + 20, from.y)
    act(() => elapse(30))
    pointer('pointermove', button, from.x + 90, from.y)
    act(() => elapse(30))
    pointer('pointerup', button, from.x + 90, from.y)
    // The card is flying off on its spring; nothing has closed yet.
    expect(commands()).toEqual([])
    expect(departStore.get().items).toEqual([])
    act(() => settleSprings())
    // At its rest the tab closes, and the group – of that one card – departs as one: the
    // frame's exit where the card stood, with no card drawn in it (that one has flown) and the
    // count as it read; the card itself is whole, not shrinking.
    expect(commands()).toEqual([['tab.close', { tabId: 'm1' }]])
    expect(departStore.get().items).toMatchObject([
      { key: `group:${GROUP}`, kind: 'group', flown: true, tabs: [{ id: 'm1' }] }
    ])
    const ghost = groupGhost()!
    expect(ghost).toBeTruthy()
    expect(ghost.querySelectorAll('.zen-overview-card')).toHaveLength(0)
    expect(ghost.querySelector('.zen-group-header')!.textContent).toContain('1')
    expect(cellOf(`group:${GROUP}`).dataset.dissolving).toBeUndefined()
    // The close lands: off the grid at once, the exit released.
    withoutGroup()
    render(stateOf([tab('a', 'https://alpha.test/'), tab('b', 'https://beta.test/')]))
    leftInOneCommit(cellOf('a'), cellOf('b'))
    act(() => settleSprings())
    expect(departStore.get().items).toEqual([])
    expect(groupGhost()).toBeNull()
  })

  /**
   * A group of two under the query "test": the card it keeps (two.test) shown alone – a group of
   * one at the top left, a beside it, b below, the block's layout – and the card it drops
   * (one.example) hidden but open; the New Tab card off. The query's exits have run out. From
   * the grid's default layout (the group across the top, both members in its one row).
   */
  const partlyFiltered = (): { m1: Tab; loose: Tab[] } => {
    const m1 = tab('m1', 'https://one.example/', { folderId: GROUP })
    const m2 = tab('m2', 'https://two.test/', { folderId: GROUP })
    const loose = [tab('a', 'https://alpha.test/'), tab('b', 'https://beta.test/')]
    bodyHeights.set(`group:${GROUP}`, bodyOf(1))
    render(stateOf([m1, m2, ...loose]))
    act(() => host!.querySelector<HTMLElement>('[data-testid="overview-search-toggle"]')!.click())
    place(`group:${GROUP}`, 0, 0, 100, groupOf(1))
    place('m2', 6, ROW_1)
    place('a', 110, 0)
    place('b', 0, groupOf(1) + 10)
    typeQuery('test')
    expect(departStore.get().items.map((i) => [i.key, i.kind])).toEqual([
      ['m1', 'tab'],
      [NEW_TAB_CELL, 'new-tab']
    ])
    act(() => settleSprings())
    expect(departStore.get().items).toEqual([])
    expect(grid().querySelector('[data-cell="m1"]')).toBeNull()
    expect(groupAround('m2')).toBe(`group:${GROUP}`)
    return { m1, loose }
  }
  /** The closes sent (the search's read of the recently closed list under a query is none). */
  const closes = (): Array<[string, unknown]> =>
    commands().filter(([name]) => name !== 'session.recentlyClosed')

  it("a partly-filtered group's last shown card's X: the card departs whole as it stands on the grid – one exit, no shrink – while the group stays open with its hidden card, and comes back whole with it", () => {
    const { m1, loose } = partlyFiltered()
    const group = cellOf(`group:${GROUP}`)
    const a = cellOf('a')
    const b = cellOf('b')

    const close = cellOf('m2').querySelector<HTMLElement>('[aria-label^="Close "]')!
    act(() => close.click())
    // The tab closes ALONE – the group is not whole among the pane's tabs (m1 is open, hidden),
    // so no `folder.close`: it stays open, m1 in it. But on the grid the card is a group whose
    // every card goes, and it departs as one: the frame's exit where it stands, m2 drawn inside
    // it, no exit of m2's own – neither the query's kind nor the swipe's.
    expect(closes()).toEqual([['tab.close', { tabId: 'm2' }]])
    expect(departStore.get().items).toMatchObject([
      {
        key: `group:${GROUP}`,
        kind: 'group',
        tabs: [{ id: 'm2' }],
        rect: { x: 0, y: 0, width: 100, height: groupOf(1) }
      }
    ])
    expect(departStore.get().items[0]).not.toHaveProperty('filtered')
    expect(departStore.get().items[0]).not.toHaveProperty('flown')
    expect(departStore.get().hidden.has('m2')).toBe(true)
    const ghost = groupGhost()!
    expect(ghost).toBeTruthy()
    expect(ghost.querySelectorAll('.zen-overview-card')).toHaveLength(1)
    expect(departStore.get().released.has(`group:${GROUP}`)).toBe(false)
    expect(group.style.opacity).toBe('0')
    expect(group.dataset.dissolving).toBeUndefined()
    expect(layoutAnimations.has(`group:${GROUP}`)).toBe(false)

    // The close lands – the folder stays, OPEN, with m1 – and the card, with nothing left to
    // show under the query, is off the grid in this very commit: no dissolving shell, no height
    // spring, the cells below gliding on the same frame as the exit's fade.
    withoutGroup()
    render(stateOf([m1, ...loose]))
    leftInOneCommit(a, b)
    expect(groupGhost()).toBe(ghost)
    act(() => frame())
    expect(parseFloat(ghost.style.opacity)).toBeLessThan(1)
    expect(ghost.style.transform).toMatch(/^scale\(0\.9\d*\)$/)
    expect(Math.abs(translate(a).x)).toBeLessThan(110)
    expect(Math.abs(translate(b).y)).toBeLessThan(groupOf(1) + 10)
    act(() => settleSprings())
    expect(a.style.transform).toBe('')
    expect(b.style.transform).toBe('')
    expect(departStore.get().items).toEqual([])
    expect(groupGhost()).toBeNull()
    expect(grid().querySelector(`[data-cell="group:${GROUP}"]`)).toBeNull()

    // The query cleared: the group is back whole with m1 – its card entering as a card does,
    // m1 drawn in it with no entrance of its own – and the New Tab card with it.
    layOut()
    typeQuery('')
    const back = cellOf(`group:${GROUP}`)
    expect(back).toBeTruthy()
    expect(back).not.toBe(group)
    expect(back.dataset.dissolving).toBeUndefined()
    expect(groupAround('m1')).toBe(`group:${GROUP}`)
    expect(departStore.get().items).toEqual([])
    act(() => frame())
    expect(parseFloat(back.style.opacity)).toBeLessThan(1)
    expect(back.style.opacity).not.toBe('0')
    expect(cellOf('m1').style.opacity).toBe('')
    expect(parseFloat(cellOf(NEW_TAB_CELL).style.opacity)).toBeLessThan(1)
    act(() => settleSprings())
    expect(back.style.opacity).toBe('')
  })

  it("a partly-filtered group's last shown card swiped off: the frame leaves whole as it stands, its slot empty, the group open with its hidden card", () => {
    const { m1, loose } = partlyFiltered()
    const button = cellOf('m2').querySelector<HTMLElement>('[role="button"]')!
    const from = at('m2', 0.5, 0.5)
    pointer('pointerdown', button, from.x, from.y)
    act(() => elapse(30))
    pointer('pointermove', button, from.x + 20, from.y)
    act(() => elapse(30))
    pointer('pointermove', button, from.x + 90, from.y)
    act(() => elapse(30))
    pointer('pointerup', button, from.x + 90, from.y)
    expect(closes()).toEqual([])
    expect(departStore.get().items).toEqual([])
    act(() => settleSprings())
    // At its rest the tab closes alone (the group stays open with m1) and the card – the last
    // the grid shows of the group – departs as one: the frame's exit, its slot empty, no
    // shrink; then off the grid on the commit the close lands, the exit released with it.
    expect(closes()).toEqual([['tab.close', { tabId: 'm2' }]])
    expect(departStore.get().items).toMatchObject([
      { key: `group:${GROUP}`, kind: 'group', flown: true, tabs: [{ id: 'm2' }] }
    ])
    const ghost = groupGhost()!
    expect(ghost).toBeTruthy()
    expect(ghost.querySelectorAll('.zen-overview-card')).toHaveLength(0)
    expect(cellOf(`group:${GROUP}`).dataset.dissolving).toBeUndefined()
    withoutGroup()
    render(stateOf([m1, ...loose]))
    leftInOneCommit(cellOf('a'), cellOf('b'))
    act(() => settleSprings())
    expect(departStore.get().items).toEqual([])
    expect(groupGhost()).toBeNull()
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
    const close = cellOf('c').querySelector<HTMLElement>('[aria-label^="Close "]')!
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
    const close = cellOf('c').querySelector<HTMLElement>('[aria-label^="Close "]')!
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

// --- (G) the private pane (TAB-02, TAB-03) --------------------------------------------------------

describe('the private pane', () => {
  const privateTab = (id: string, url: string, patch: Partial<Tab> = {}): Tab =>
    tab(id, url, { containerId: PRIVATE_CONTAINER_ID, ...patch })
  /** The same state on a host with private tabs (the Android host): the segment shows. */
  const withPrivate = (state: UIState): UIState => ({
    ...state,
    capabilities: { ...state.capabilities, privateTabs: true }
  })
  /** Two regular tabs and two private ones, interleaved in the space's track; a is in view. */
  const mixed = (): UIState =>
    withPrivate(
      stateOf(
        [
          tab('a', 'https://a.example/'),
          privateTab('p1', 'https://one.example/'),
          tab('b', 'https://b.example/'),
          privateTab('p2', 'https://two.example/')
        ],
        []
      )
    )
  const cellKeys = (): string[] => [...collectCells(grid()).keys()]
  const segment = (pane: 'tabs' | 'private'): HTMLElement =>
    host!.querySelector<HTMLElement>(`[data-testid="overview-pane-${pane}"]`)!
  const selected = (pane: 'tabs' | 'private'): boolean =>
    segment(pane).getAttribute('aria-selected') === 'true'
  const countShown = (): string =>
    host!.querySelector<HTMLElement>('[data-testid="overview-count"]')!.textContent!
  /** The `zen-new-tab` requests the overview makes while `during` runs: their details. */
  const newTabRequests = (during: () => void): unknown[] => {
    const asked: unknown[] = []
    const hear = (e: Event): void => {
      asked.push((e as CustomEvent).detail)
    }
    window.addEventListener('zen-new-tab', hear)
    during()
    window.removeEventListener('zen-new-tab', hear)
    return asked
  }

  afterEach(() => {
    act(() => resetOverviewPane())
  })

  it('a host without private tabs has no Private segment, and a private card never reaches its grid', () => {
    render(stateOf([tab('a', 'https://a.example/'), privateTab('p1', 'https://one.example/')], []))
    // The segment stays for the Groups pane (TAB-16); the Private pane alone needs the host's say.
    expect([...host!.querySelectorAll('[role="tab"]')].map((b) => b.textContent)).toEqual([
      'Tabs',
      'Groups'
    ])
    // The list's name names the segments present, no more.
    const tablist = (): string | null =>
      host!.querySelector('[role="tablist"]')!.getAttribute('aria-label')
    expect(tablist()).toBe('Tabs and groups')
    expect(cellKeys()).toEqual(['a', NEW_TAB_CELL])
    render(mixed())
    expect(tablist()).toBe('Tabs, groups and private tabs')
  })

  it('PRIVATE-BROWSING LEAK, fixed: a group that private tabs alone fill is named on no regular surface of the overview – not a card’s sheet, not the Groups pane, not its count', () => {
    // Ghost: a PRIVATE group (private tabs alone, nothing saved), made on the tablet's sidebar;
    // Research: a regular group. The space holds the private tabs among the regular ones.
    const ghost: Folder = { ...folder, id: 'ghost', name: 'Ghost', color: 'red' }
    render(
      withPrivate(
        stateOf(
          [
            tab('a', 'https://a.example/'),
            tab('m1', 'https://one.example/', { folderId: GROUP }),
            privateTab('p1', 'https://p1.example/', { folderId: 'ghost' }),
            privateTab('p2', 'https://p2.example/', { folderId: 'ghost' })
          ],
          [folder, ghost]
        )
      )
    )
    const sheetLabels = (): Array<string | null> =>
      [...document.querySelectorAll<HTMLElement>('.zen-sheet-item')].map((el) => el.textContent)
    // The Tabs pane: no card of Ghost's, and a held card's sheet offers Research alone.
    expect(cellKeys()).toEqual([`group:${GROUP}`, 'm1', 'a', NEW_TAB_CELL])
    expect(host!.textContent).not.toContain('Ghost')
    pickUp('a')
    const p = at('a', 0.5, 0.5)
    letGo(p.x, p.y)
    act(() => elapse(300))
    act(() => settleSprings())
    expect(sheetLabels()).toContain('Add to Research')
    expect(sheetLabels().some((label) => label?.includes('Ghost'))).toBe(false)
    expect(document.body.textContent).not.toContain('Ghost')
    // The Groups pane: Research's row alone, one group counted, Ghost's name nowhere.
    act(() => host!.querySelector<HTMLElement>('[data-testid="overview-pane-groups"]')!.click())
    expect(countShown()).toBe('1 group')
    expect(
      [...host!.querySelectorAll<HTMLElement>('.zen-list-title')].map((el) => el.textContent)
    ).toEqual(['Research'])
    expect(host!.textContent).not.toContain('Ghost')
    expect(host!.innerHTML).not.toContain('Ghost')
  })

  it('the regular pane shows the space without its private tabs; the private pane every private tab and no regular one', () => {
    render(mixed())
    expect(selected('tabs')).toBe(true)
    expect(cellKeys()).toEqual(['a', 'b', NEW_TAB_CELL])
    expect(countShown()).toBe('2 tabs')
    expect(grid().dataset.pane).toBe('tabs')
    const regularGrid = grid()

    // The segment switches panes: the private grid is a fresh one (it fades in over the backdrop).
    act(() => segment('private').click())
    expect(privateTabsStore.get().pane).toBe('private')
    expect(selected('private')).toBe(true)
    expect(selected('tabs')).toBe(false)
    expect(cellKeys()).toEqual(['p1', 'p2', NEW_TAB_CELL])
    expect(countShown()).toBe('2 tabs')
    expect(grid().dataset.pane).toBe('private')
    expect(grid()).not.toBe(regularGrid)
    expect(host!.querySelector('.zen-title')!.textContent).toBe('Private')
    // Its last card asks for a private tab.
    expect(cellOf(NEW_TAB_CELL).dataset.testid).toBe('overview-new-private-tab')

    // And back: the space's grid again, the space's name over it.
    act(() => segment('tabs').click())
    expect(cellKeys()).toEqual(['a', 'b', NEW_TAB_CELL])
    expect(host!.querySelector('.zen-title')!.textContent).toBe('Work')
    expect(cellOf(NEW_TAB_CELL).dataset.testid).toBe('overview-new-tab')
  })

  it('the Tabs button counts the pane the overview opens on: the regular tabs from a regular tab, the private ones from a private tab', () => {
    const state = mixed()
    expect(tabCount(state)).toBe(2)
    state.spaces[0].activeTabId = 'p1'
    expect(tabCount(state)).toBe(2)
    // One private tab open: 1 from it, and the regular count is untouched by it.
    const one = withPrivate(
      stateOf(
        [
          tab('a', 'https://a.example/'),
          tab('b', 'https://b.example/'),
          tab('c', 'https://c.example/'),
          privateTab('p1', 'https://one.example/')
        ],
        []
      )
    )
    expect(tabCount(one)).toBe(3)
    one.spaces[0].activeTabId = 'p1'
    expect(tabCount(one)).toBe(1)
  })

  it("the bar's New tab keeps the mode: a private tab from a private tab, a regular one from a regular tab", () => {
    const button = document.createElement('button')
    button.getBoundingClientRect = () => new DOMRect(10, 700, 48, 48)
    const state = mixed()
    const requests = newTabRequests(() =>
      BAR_ITEMS['new-tab'].run(barContext(state, false), button)
    )
    expect(requests).toEqual([
      { origin: { x: 10, y: 700, width: 48, height: 48 }, containerId: undefined }
    ])

    state.spaces[0].activeTabId = 'p1'
    const fromPrivate = newTabRequests(() =>
      BAR_ITEMS['new-tab'].run(barContext(state, false), button)
    )
    expect(fromPrivate).toEqual([
      { origin: { x: 10, y: 700, width: 48, height: 48 }, containerId: PRIVATE_CONTAINER_ID }
    ])
  })

  it('opens on the pane of the tab in view: a private tab up, the private pane – without a pick', () => {
    const state = mixed()
    state.spaces[0].activeTabId = 'p1'
    render(state)
    expect(privateTabsStore.get().pane).toBeNull()
    expect(selected('private')).toBe(true)
    expect(cellKeys()).toEqual(['p1', 'p2', NEW_TAB_CELL])
    // Pinned and grouped regular tabs stay on their pane too.
    render(
      withPrivate(
        stateOf([
          privateTab('p1', 'https://one.example/'),
          tab('pinned', 'https://pinned.example/', { pinned: true }),
          tab('m1', 'https://m1.example/', { folderId: GROUP }),
          tab('m2', 'https://m2.example/', { folderId: GROUP })
        ])
      )
    )
    expect(cellKeys()).toEqual(['p1', NEW_TAB_CELL])
    act(() => segment('tabs').click())
    expect(cellKeys()).toEqual(['pinned', `group:${GROUP}`, 'm1', 'm2', NEW_TAB_CELL])
  })

  it('a Settings tab opened from a private tab sits on the Tabs pane with the regular surface (#232: a page tab never takes the private container)', async () => {
    const { privateSurfaceActive } = await import('@renderer/lib/privateTabs')
    // What the core makes of Settings asked from p1 since #232: a default-container tab that
    // remembers the private tab as its opener, in front.
    const settings = tab('settings', SETTINGS_URL, { title: 'Settings', openerTabId: 'p1' })
    const state = withPrivate(
      stateOf(
        [settings, privateTab('p1', 'https://one.example/'), tab('a', 'https://a.example/')],
        []
      )
    )
    // The surface is the regular one while Settings is in view: no private theme, no guard
    // (`privateSurfaceActive` is what `useTheme` and the Android host read), and the overview
    // opens on the Tabs pane – its card among the regular ones, never on the Private pane.
    expect(privateSurfaceActive(state, false)).toBe(false)
    render(state)
    expect(privateTabsStore.get().pane).toBeNull()
    expect(selected('tabs')).toBe(true)
    expect(grid().dataset.pane).toBe('tabs')
    expect(cellKeys()).toEqual(['settings', 'a', NEW_TAB_CELL])
    expect(privateSurfaceActive(state, true)).toBe(false)
    act(() => segment('private').click())
    expect(cellKeys()).toEqual(['p1', NEW_TAB_CELL])
  })

  /*
   * The lock cover over the Private pane (INC-05, v2 §9.19): nothing of a locked private tab's
   * identity shows or reads before the unlock – the cards' title rows read "Private tab" behind
   * the mask, their names say the same, the grid is inert and hidden from readers under the
   * opaque cover, and the hero of a morph from a locked private tab reads the placeholder too.
   * The Tabs pane beside it is untouched.
   */
  it('under the lock the Private pane is covered whole: an opaque cover, an inert grid, "Private tab" on every card and the hero, the Tabs pane as before', async () => {
    const { applyPrivateLock, resetPrivateLock } = await import('@renderer/lib/privateLock')
    const state = mixed()
    state.spaces[0].activeTabId = 'p1'
    try {
      act(() => applyPrivateLock({ locked: true, screenLock: true }))
      render(state)
      expect(selected('private')).toBe(true)
      const cover = host!.querySelector<HTMLElement>('[data-testid="private-lock-cover"]')!
      expect(cover).not.toBeNull()
      // The cover stands on its own base: no `data-backdrop` variant leaning on a blur of what
      // lies under it (the composited overview never gave it one).
      expect(cover.hasAttribute('data-backdrop')).toBe(false)
      expect(cover.querySelector('.zen-private-lock-block h2')!.textContent).toBe(
        'Your private tabs are locked'
      )
      // The grid is out of reach – inert, hidden from readers – and its cards read the word.
      expect(grid().hasAttribute('inert')).toBe(true)
      expect(grid().getAttribute('aria-hidden')).toBe('true')
      for (const id of ['p1', 'p2']) {
        const card = cellOf(id).querySelector<HTMLElement>('.zen-overview-card')!
        // The card's name is composed as every card's (#237: the title, then its place), the
        // placeholder standing where the title would; the close beside it names the word too.
        expect(card.getAttribute('aria-label')).toMatch(/^Private tab, tab [12] of 2(, current)?$/)
        expect(
          cellOf(id).querySelector('.zen-overview-card-close')?.getAttribute('aria-label')
        ).toBe('Close Private tab')
        expect(card.hasAttribute('data-masked')).toBe(true)
        expect(card.querySelector('.zen-overview-card-title')!.textContent).toBe('Private tab')
        expect(
          card.querySelector('.zen-overview-card-favicon svg.lucide-venetian-mask')
        ).not.toBeNull()
        expect(card.querySelector('.zen-overview-card-favicon img')).toBeNull()
      }
      expect(host!.textContent).not.toContain('one.example')
      expect(host!.textContent).not.toContain('two.example')
      // The hero of the morph from the locked tab: the placeholder, never the title.
      act(() =>
        root!.render(
          createElement(
            StrictMode,
            null,
            createElement(TabOverview, {
              state,
              overview: { phase: 'settling', progress: 0.5, heroTabId: 'p1', target: 1 },
              area: AREA,
              edge: 'bottom'
            })
          )
        )
      )
      const hero = host!.querySelector<HTMLElement>('.zen-overview-hero')!
      expect(hero).not.toBeNull()
      expect(hero.textContent).toBe('Private tab')
      expect(hero.querySelector('svg.lucide-venetian-mask')).not.toBeNull()
      // The Tabs pane beside it is not locked: its cards keep their names, the grid is reachable.
      render(state)
      act(() => segment('tabs').click())
      expect(grid().hasAttribute('inert')).toBe(false)
      expect(grid().hasAttribute('aria-hidden')).toBe(false)
      expect(
        cellOf('a').querySelector<HTMLElement>('.zen-overview-card')!.getAttribute('aria-label')
      ).toMatch(/^a, tab 1 of 2/)
      expect(host!.querySelector('[data-testid="private-lock-cover"]')).toBeNull()
      // The lock off: the cards read their titles again.
      act(() => segment('private').click())
      act(() => applyPrivateLock({ locked: false }))
      render(state)
      expect(grid().hasAttribute('inert')).toBe(false)
      expect(cellOf('p1').querySelector<HTMLElement>('.zen-overview-card-title')!.textContent).toBe(
        'p1'
      )
    } finally {
      act(() => resetPrivateLock())
    }
  })

  it('with no private tab the private pane is the explainer, whose button asks for a private tab', () => {
    render(withPrivate(stateOf([tab('a', 'https://a.example/')], [])))
    act(() => segment('private').click())
    expect(host!.querySelector('.zen-overview-grid')).toBeNull()
    const empty = host!.querySelector<HTMLElement>('[data-testid="overview-private-empty"]')!
    expect(empty.querySelector('h2')!.textContent).toBe('No private tabs')
    expect(countShown()).toBe('0 tabs')
    const button = empty.querySelector<HTMLElement>('[data-testid="overview-private-empty-new"]')!
    // A button, so sentence case (v2 §9.1); the menus' rows stay Title Case.
    expect(button.textContent).toBe('New private tab')
    expect(newTabRequests(() => act(() => button.click()))).toEqual([
      { containerId: PRIVATE_CONTAINER_ID }
    ])
    // The first private tab replaces the explainer with the grid.
    render(
      withPrivate(
        stateOf([tab('a', 'https://a.example/'), privateTab('p1', 'https://one.example/')], [])
      )
    )
    expect(host!.querySelector('[data-testid="overview-private-empty"]')).toBeNull()
    expect(cellKeys()).toEqual(['p1', NEW_TAB_CELL])
  })

  /*
   * The last private tab closing returns the overview to the Tabs pane, picked or followed
   * (Chrome's switcher); the explainer is still a pick away with none open.
   */
  it('returns to the Tabs pane when the last private tab closes with the Private pane picked; Private picked again is the explainer', () => {
    const state = mixed()
    render(state)
    act(() => segment('private').click())
    expect(privateTabsStore.get().pane).toBe('private')
    expect(cellKeys()).toEqual(['p1', 'p2', NEW_TAB_CELL])

    // One private tab closes: the pane stays, the other card remains.
    render(
      withPrivate(
        stateOf(
          [
            tab('a', 'https://a.example/'),
            tab('b', 'https://b.example/'),
            privateTab('p2', 'https://two.example/')
          ],
          []
        )
      )
    )
    expect(selected('private')).toBe(true)
    expect(cellKeys()).toEqual(['p2', NEW_TAB_CELL])

    // The last one closes: back to the Tabs pane, the pick released to it.
    render(
      withPrivate(stateOf([tab('a', 'https://a.example/'), tab('b', 'https://b.example/')], []))
    )
    expect(privateTabsStore.get().pane).toBe('tabs')
    expect(selected('tabs')).toBe(true)
    expect(grid().dataset.pane).toBe('tabs')
    expect(cellKeys()).toEqual(['a', 'b', NEW_TAB_CELL])
    expect(host!.querySelector('[data-testid="overview-private-empty"]')).toBeNull()

    // Private picked with none open: the explainer, as before.
    act(() => segment('private').click())
    expect(host!.querySelector('[data-testid="overview-private-empty"]')).not.toBeNull()
    expect(selected('private')).toBe(true)
  })

  it('returns to the Tabs pane when the last private tab closes with the pane following the tab in view', () => {
    const state = mixed()
    state.spaces[0].activeTabId = 'p1'
    render(state)
    expect(privateTabsStore.get().pane).toBeNull()
    expect(selected('private')).toBe(true)
    // The core closes p1 and brings a regular tab into view; nothing is picked, so the pane follows.
    render(
      withPrivate(stateOf([tab('a', 'https://a.example/'), tab('b', 'https://b.example/')], []))
    )
    expect(privateTabsStore.get().pane).toBeNull()
    expect(selected('tabs')).toBe(true)
    expect(cellKeys()).toEqual(['a', 'b', NEW_TAB_CELL])
  })

  it('opening the overview on an empty private session with Private picked shows the explainer, not the Tabs pane', () => {
    // No transition from some to none: the pick holds (a pick made before the overview came up).
    act(() => privateTabsStore.set({ pane: 'private' }))
    render(withPrivate(stateOf([tab('a', 'https://a.example/')], [])))
    expect(privateTabsStore.get().pane).toBe('private')
    expect(host!.querySelector('[data-testid="overview-private-empty"]')).not.toBeNull()
  })

  it("each pane's New Tab card asks for a tab of its own mode", () => {
    render(mixed())
    const asked = newTabRequests(() => {
      act(() => cellOf(NEW_TAB_CELL).click())
      act(() => segment('private').click())
      act(() => cellOf(NEW_TAB_CELL).click())
    })
    expect(asked).toEqual([{}, { containerId: PRIVATE_CONTAINER_ID }])
  })

  it('a held private card offers to close the other private tabs only', () => {
    // Four private tabs and two regular ones: "Close other tabs" on p1 counts three, not five.
    render(
      withPrivate(
        stateOf(
          [
            privateTab('p1', 'https://one.example/'),
            tab('a', 'https://a.example/'),
            privateTab('p2', 'https://two.example/'),
            tab('b', 'https://b.example/'),
            privateTab('p3', 'https://three.example/'),
            privateTab('p4', 'https://four.example/')
          ],
          []
        )
      )
    )
    expect(selected('private')).toBe(true)
    place('p1', 0, 0)
    pickUp('p1')
    const p = at('p1', 0.5, 0.5)
    letGo(p.x, p.y)
    act(() => elapse(300))
    act(() => settleSprings())
    const labels = [...document.querySelectorAll<HTMLElement>('.zen-sheet-item')].map(
      (el) => el.textContent
    )
    expect(labels).toContain('Close Other Tabs (3)')
    // No grouping on the private pane: the session is not a workspace.
    expect(labels).not.toContain('New Group')
  })

  /*
   * A drag on the private pane rearranges its cards like the Tabs pane's (Chrome's incognito grid
   * allows it) and does nothing else: a card's middle is no merge target and no group is made.
   * The browser's index counts the space's whole regular section, the regular tabs between the
   * private ones included.
   */
  it('a private card dragged past another lands right after it: a move in the space track, no group', () => {
    // The space's track: p1, a, p2, b, p3 (private tabs interleaved with the regular ones).
    render(
      withPrivate(
        stateOf(
          [
            privateTab('p1', 'https://one.example/'),
            tab('a', 'https://a.example/'),
            privateTab('p2', 'https://two.example/'),
            tab('b', 'https://b.example/'),
            privateTab('p3', 'https://three.example/')
          ],
          []
        )
      )
    )
    expect(selected('private')).toBe(true)
    expect(cellKeys()).toEqual(['p1', 'p2', 'p3', NEW_TAB_CELL])
    place('p1', 0, 0)
    place('p2', 110, 0)
    place('p3', 0, 140)
    place(NEW_TAB_CELL, 110, 140)

    pickUp('p1')
    // Over p3's middle: on the regular pane that would merge the two; here it targets nothing.
    const middle = at('p3', 0.5, 0.5)
    drag(middle.x, middle.y)
    expect(liftStore.get().target).toBeNull()
    // Its trailing edge: the slot after it.
    const trailing = at('p3', 0.9, 0.5)
    drag(trailing.x, trailing.y)
    expect(liftStore.get().target).toBeNull()
    act(() => elapse(SLOT_DWELL_MS))
    expect(liftStore.get().slot).toEqual({ folderId: null, index: 2 })
    // The stand-in shows the order the drop would make.
    expect(cellKeys()).toEqual(['p2', 'p3', 'p1', NEW_TAB_CELL])
    letGo(trailing.x, trailing.y)
    // p1 goes to the end of the space's regular tabs (index 4 of a, p2, b, p3); no folder command.
    expect(commands()).toEqual([
      ['tab.move', { tabId: 'p1', spaceId: SPACE, section: 'regular', index: 4 }]
    ])
    const moved = withPrivate(
      stateOf(
        [
          tab('a', 'https://a.example/'),
          privateTab('p2', 'https://two.example/'),
          tab('b', 'https://b.example/'),
          privateTab('p3', 'https://three.example/'),
          privateTab('p1', 'https://one.example/')
        ],
        []
      )
    )
    // p1 is still the tab in view, so the overview stays on its pane.
    moved.spaces[0].activeTabId = 'p1'
    land(moved)
    expect(liftStore.get()).toMatchObject({ phase: 'idle', tabId: null, target: null, slot: null })
    expect(cellKeys()).toEqual(['p2', 'p3', 'p1', NEW_TAB_CELL])
  })

  it('a private card dragged before another lands right before it in the space track', () => {
    render(
      withPrivate(
        stateOf(
          [
            privateTab('p1', 'https://one.example/'),
            tab('a', 'https://a.example/'),
            privateTab('p2', 'https://two.example/'),
            tab('b', 'https://b.example/'),
            privateTab('p3', 'https://three.example/')
          ],
          []
        )
      )
    )
    place('p1', 0, 0)
    place('p2', 110, 0)
    place('p3', 0, 140)
    place(NEW_TAB_CELL, 110, 140)
    pickUp('p3')
    const leading = at('p1', 0.1, 0.5)
    drag(leading.x, leading.y)
    act(() => elapse(SLOT_DWELL_MS))
    expect(liftStore.get().slot).toEqual({ folderId: null, index: 0 })
    letGo(leading.x, leading.y)
    // Right before p1, which heads the track: index 0.
    expect(commands()).toEqual([
      ['tab.move', { tabId: 'p3', spaceId: SPACE, section: 'regular', index: 0 }]
    ])
  })

  it('on the Tabs pane the index skips the private tabs between the regular ones', () => {
    // The space's track: a, p1, b, p2, c: the Tabs pane shows a, b, c.
    render(
      withPrivate(
        stateOf(
          [
            tab('a', 'https://a.example/'),
            privateTab('p1', 'https://one.example/'),
            tab('b', 'https://b.example/'),
            privateTab('p2', 'https://two.example/'),
            tab('c', 'https://c.example/')
          ],
          []
        )
      )
    )
    expect(cellKeys()).toEqual(['a', 'b', 'c', NEW_TAB_CELL])
    place('a', 0, 0)
    place('b', 110, 0)
    place('c', 0, 140)
    place(NEW_TAB_CELL, 110, 140)
    pickUp('a')
    const leading = at('c', 0.1, 0.5)
    drag(leading.x, leading.y)
    act(() => elapse(SLOT_DWELL_MS))
    expect(liftStore.get().slot).toEqual({ folderId: null, index: 1 })
    letGo(leading.x, leading.y)
    // Right before c, which is fourth in the track without a (p1, b, p2, c): index 3, not 1.
    expect(commands()).toEqual([
      ['tab.move', { tabId: 'a', spaceId: SPACE, section: 'regular', index: 3 }]
    ])
  })

  /*
   * A pane switch is a cross-fade (v2 §11.4): the pane leaving is kept in view as a still of
   * itself fading 1 → 0 over 120 ms, in the slot it stood in, while the next pane comes up on
   * its own 120 ms fade in (the stylesheet's, pinned in (F)); the same under reduced motion.
   */
  const stills = (): HTMLElement[] => [
    ...host!.querySelectorAll<HTMLElement>('[data-testid="overview-pane-still"]')
  ]
  /** A stand-in for `element.animate()` that records each call and can finish them all. */
  const recordFades = (): {
    fades: Array<{ el: HTMLElement; frames: unknown; options: KeyframeAnimationOptions }>
    finish: () => void
    restore: () => void
  } => {
    const proto = HTMLElement.prototype as { animate?: unknown }
    const had = proto.animate
    const fades: Array<{ el: HTMLElement; frames: unknown; options: KeyframeAnimationOptions }> = []
    const ends: Array<() => void> = []
    proto.animate = function (
      this: HTMLElement,
      frames: unknown,
      options: KeyframeAnimationOptions
    ): { onfinish: (() => void) | null; cancel: () => void } {
      fades.push({ el: this, frames, options })
      const fade = { onfinish: null as (() => void) | null, cancel: () => undefined }
      ends.push(() => fade.onfinish?.())
      return fade
    }
    return {
      fades,
      finish: () => act(() => ends.splice(0).forEach((end) => end())),
      restore: () => {
        proto.animate = had
      }
    }
  }

  it('a pane switch cross-fades: a still of the pane leaving fades out over its slot while the next pane fades in, 120 ms each', () => {
    const { fades, finish, restore } = recordFades()
    try {
      render(mixed())
      expect(stills()).toEqual([])
      grid().scrollTop = 40

      act(() => segment('private').click())
      // The private grid is up, fresh, on the stylesheet's fade in.
      expect(grid().dataset.pane).toBe('private')
      expect(grid().closest('.zen-overview-pane')).not.toBeNull()
      expect(cellKeys()).toEqual(['p1', 'p2', NEW_TAB_CELL])
      // Over its slot, a still of the Tabs pane as it stood: its grid scrolled where it was,
      // out of the way of touch and of assistive technology, none of its hooks left on it.
      const [still] = stills()
      expect(stills()).toHaveLength(1)
      expect(still.getAttribute('aria-hidden')).toBe('true')
      expect(still.hasAttribute('inert')).toBe(true)
      expect(still.style.pointerEvents || still.className).toMatch(/none|pointer-events-none/)
      expect([still.style.left, still.style.top, still.style.width, still.style.height]).toEqual([
        '4px',
        '56px',
        '212px',
        '600px'
      ])
      const stillGrid = still.querySelector<HTMLElement>('[data-pane="tabs"]')!
      expect(stillGrid).not.toBeNull()
      expect(stillGrid.scrollTop).toBe(40)
      expect(still.textContent).toContain('a')
      expect(still.querySelector('[data-cell], [data-testid], .zen-overview-grid')).toBeNull()
      expect(still.querySelector('.zen-overview-pane')).toBeNull()
      // The still is no cell of the FLIP set: the set is the private grid's alone.
      expect(cellKeys()).toEqual(['p1', 'p2', NEW_TAB_CELL])
      // Its fade: 1 → 0 over the pane's 120 ms, held at 0 until it is taken down.
      // (StrictMode replays the effect that starts it – the first is cancelled – so more than
      // one call lands on the one still; every one is the same fade.)
      expect(fades.length).toBeGreaterThan(0)
      for (const fade of fades) {
        expect(fade.el).toBe(still)
        expect(fade.frames).toEqual([{ opacity: 1 }, { opacity: 0 }])
        expect(fade.options).toMatchObject({ duration: REDUCED_FADE_MS, fill: 'forwards' })
      }
      finish()
      expect(stills()).toEqual([])

      // Back to Tabs: the still is the private pane's.
      act(() => segment('tabs').click())
      expect(stills()).toHaveLength(1)
      expect(stills()[0].querySelector('[data-pane="private"]')).not.toBeNull()
      expect(grid().dataset.pane).toBe('tabs')
      finish()
      expect(stills()).toEqual([])
    } finally {
      restore()
    }
  })

  it('the pane following the tab in view cross-fades the same when the core moves it; the explainer too', () => {
    const { finish, restore } = recordFades()
    try {
      const state = mixed()
      state.spaces[0].activeTabId = 'p1'
      render(state)
      expect(selected('private')).toBe(true)
      // The private tabs close and a regular tab comes into view: the pane follows, over a
      // still of the private grid.
      render(
        withPrivate(stateOf([tab('a', 'https://a.example/'), tab('b', 'https://b.example/')], []))
      )
      expect(selected('tabs')).toBe(true)
      expect(stills()).toHaveLength(1)
      expect(stills()[0].querySelector('[data-pane="private"]')).not.toBeNull()
      finish()

      // Private picked with none open: the explainer comes up over a still of the Tabs grid,
      // and leaves the same way.
      act(() => segment('private').click())
      expect(host!.querySelector('[data-testid="overview-private-empty"]')).not.toBeNull()
      expect(stills()).toHaveLength(1)
      finish()
      act(() => segment('tabs').click())
      expect(stills()[0].textContent).toContain('No private tabs')
      expect(host!.querySelector('[data-testid="overview-private-empty"]')).toBeNull()
      finish()
      expect(stills()).toEqual([])
    } finally {
      restore()
    }
  })

  it('under reduced motion the cross-fade is the same 120 ms, and without the Web Animations API the still leaves on a timer', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }))
    const { fades, finish, restore } = recordFades()
    try {
      render(mixed())
      act(() => segment('private').click())
      expect(stills()).toHaveLength(1)
      expect(fades[0].frames).toEqual([{ opacity: 1 }, { opacity: 0 }])
      expect(fades[0].options.duration).toBe(REDUCED_FADE_MS)
      finish()
      expect(stills()).toEqual([])
    } finally {
      restore()
    }
    // No `animate`: the still is taken down when its 120 ms are up.
    const proto = HTMLElement.prototype as { animate?: unknown }
    const had = proto.animate
    proto.animate = undefined
    try {
      act(() => segment('tabs').click())
      expect(stills()).toHaveLength(1)
      act(() => elapse(REDUCED_FADE_MS - 1))
      expect(stills()).toHaveLength(1)
      act(() => elapse(1))
      expect(stills()).toEqual([])
    } finally {
      proto.animate = had
    }
  })

  it('a host without private tabs never switches panes, so nothing is ever kept in view', () => {
    const { fades, restore } = recordFades()
    try {
      render(stateOf([tab('a', 'https://a.example/')], []))
      render(stateOf([tab('a', 'https://a.example/'), tab('b', 'https://b.example/')], []))
      expect(stills()).toEqual([])
      expect(fades).toEqual([])
    } finally {
      restore()
    }
  })
})

// --- (F) the chrome switch in the stylesheet (v2 §11.4, §11.3) -----------------------------------

/** A style rule of main.css: its selectors, its declarations, whether it is under reduced motion. */
interface CssRule {
  selectors: string[]
  declarations: Map<string, { value: string; important: boolean }>
  reduced: boolean
}

/** The style rules of a stylesheet, walked through its layers and media queries; comments dropped. */
function rulesOf(css: string): CssRule[] {
  const rules: CssRule[] = []
  const open: string[] = []
  let buffer = ''
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') {
      open.push(buffer.trim().replace(/\s+/g, ' '))
      buffer = ''
    } else if (ch === '}') {
      const prelude = open.pop()!
      if (!prelude.startsWith('@')) {
        const declarations = new Map<string, { value: string; important: boolean }>()
        for (const line of buffer.split(';')) {
          const at = line.indexOf(':')
          if (at === -1) continue
          const value = line
            .slice(at + 1)
            .trim()
            .replace(/\s+/g, ' ')
          declarations.set(line.slice(0, at).trim(), {
            value: value.replace(/\s*!important$/, ''),
            important: value.endsWith('!important')
          })
        }
        rules.push({
          selectors: prelude.split(',').map((s) => s.trim()),
          declarations,
          reduced: open.some((p) => p.includes('prefers-reduced-motion: reduce'))
        })
      }
      buffer = ''
    } else buffer += ch
  }
  return rules
}

/** A comma-separated list, split at the commas outside parentheses. */
const commaList = (value: string): string[] => {
  const items: string[] = []
  let depth = 0
  let current = ''
  for (const ch of value) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      items.push(current.trim())
      current = ''
    } else current += ch
  }
  items.push(current.trim())
  return items
}
const ms = (token: string): number => {
  const m = /^([\d.]+)(m?s)$/.exec(token)
  if (!m) throw new Error(`${token} is no duration`)
  return Number(m[1]) * (m[2] === 's' ? 1000 : 1)
}

describe('the chrome switch in the stylesheet', () => {
  const rules = rulesOf(
    readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')
  ).filter((r) =>
    r.selectors.some(
      (s) =>
        s === '*' ||
        s.startsWith('.zen-overview') ||
        s.startsWith('.zen-group') ||
        s.startsWith('.zen-v2-segment') ||
        s.startsWith('.zen-pill-well') ||
        s.endsWith('.zen-window')
    )
  )
  const forSelector = (selector: string, reduced: boolean): CssRule[] =>
    rules.filter((r) => r.reduced === reduced && r.selectors.includes(selector))
  /** The last value a selector's own rules give a property, in full motion. */
  const declared = (selector: string, property: string): string | undefined =>
    forSelector(selector, false)
      .map((r) => r.declarations.get(property)?.value)
      .filter((v) => v !== undefined)
      .at(-1)
  /**
   * The transitions an element matching `selector` (and nothing else) ends up with: the property
   * and its duration in ms. Under reduced motion the sheet's closing rule – `*, ::before, ::after
   * { transition-property: none !important }` – removes every transition, pseudo-elements'
   * included (§11.3 as amended: removed, never shortened), and an element transitions only what
   * its own reduced rule re-declares as a `transition` shorthand `!important` (a layered important
   * declaration beats the unlayered one at the foot): that fade, and nothing else.
   */
  const transitions = (selector: string, reduced = false): Map<string, number> => {
    const list = commaList(declared(selector, 'transition') ?? '').filter(Boolean)
    const properties = list.map((entry) => entry.split(' ')[0])
    const durations = list.map((entry) => ms(entry.split(' ').find((t) => /m?s$/.test(t))!))
    if (reduced) {
      const remover = rules.find(
        (r) => r.reduced && r.selectors.includes('*') && r.declarations.has('transition-property')
      )
      expect(remover?.selectors).toEqual(['*', '::before', '::after'])
      expect(remover?.declarations.get('transition-property')).toEqual({
        value: 'none',
        important: true
      })
      const kept = forSelector(selector, true)
        .map((rule) => rule.declarations.get('transition'))
        .filter((shorthand) => shorthand?.important)
        .at(-1)
      const entries = kept ? commaList(kept.value) : []
      properties.splice(0, properties.length, ...entries.map((e) => e.split(' ')[0]))
      durations.splice(
        0,
        durations.length,
        ...entries.map((e) => ms(e.split(' ').find((t) => /m?s$/.test(t))!))
      )
    }
    return new Map(properties.map((p, i) => [p, durations[i]]))
  }

  it('fades the header and the tint over 120 ms at the switch, and cuts the radius (v2 §11.4)', () => {
    // With the chrome off, header and tint are at opacity 0 – the tint a layer of its own so
    // that it can fade by itself; the group card carries no tint of its own to cut.
    expect(declared(".zen-group[data-chrome='off'] > .zen-group-header", 'opacity')).toBe('0')
    expect(declared(".zen-group[data-chrome='off']::before", 'opacity')).toBe('0')
    expect(declared('.zen-group::before', 'background')).toContain('--zen-group-rgb')
    expect(declared('.zen-group', 'background')).toBeUndefined()
    expect(declared(".zen-group[data-chrome='off']", 'background')).toBeUndefined()
    // The switch is a 120 ms opacity fade on both…
    expect(transitions('.zen-group-header').get('opacity')).toBe(120)
    expect(transitions('.zen-group::before').get('opacity')).toBe(120)
    // …and the radius cuts: no transition on it, on the group, its tint or its header (the
    // tint's radius is the group's own).
    for (const selector of ['.zen-group', '.zen-group::before', '.zen-group-header']) {
      const animated = [...transitions(selector).keys()]
      expect(animated, selector).not.toContain('border-radius')
      expect(animated, selector).not.toContain('all')
    }
    expect(declared('.zen-group::before', 'border-radius')).toBe('inherit')
  })

  it('under reduced motion the fade stays at 120 ms – an appearance in place – and every other transition is removed, not shortened (v2 §11.3)', () => {
    // The header's and the tint's opacity fades are re-declared where they live; the header's
    // background tween, and everything the group card transitions, is gone: the change lands on
    // the frame it is written, no frame of the old value.
    expect([...transitions('.zen-group-header', true).entries()]).toEqual([['opacity', 120]])
    expect([...transitions('.zen-group::before', true).entries()]).toEqual([['opacity', 120]])
    expect(transitions('.zen-group', true).size).toBe(0)
    // The sheet's closing rule removes every animation too (`animation: none !important`): the
    // grid's own appearance, a 120 ms fade at scale 1, is written out in full and `!important`
    // past it.
    const remover = rules.find((r) => r.reduced && r.selectors.includes('*'))
    expect(remover?.declarations.get('animation')).toEqual({ value: 'none', important: true })
    const overview = forSelector('.zen-overview', true)
    expect(overview.map((r) => r.declarations.get('animation')).find(Boolean)).toEqual({
      value: 'zen-fade 120ms var(--zen-ease)',
      important: true
    })
  })

  it('the panes and the segment change in place on a 120 ms opacity fade with no movement, the same under reduced motion (v2 §11.4)', () => {
    // A pane coming up: the 120 ms fade, written out again `!important` past the sheet's closing
    // rule that removes every other animation.
    expect(declared('.zen-overview-pane', 'animation')).toMatch(/^zen-fade 120ms/)
    expect(
      forSelector('.zen-overview-pane', true)
        .map((r) => r.declarations.get('animation'))
        .find(Boolean)
    ).toEqual({ value: 'zen-fade 120ms var(--zen-ease)', important: true })
    // The segment primitive (§9.34): the label's ink and the line's opacity, nothing that moves.
    // Under reduced motion the line's opacity fade stays (re-declared, opacity alone) and the
    // ink's colour tween is removed: §11.3 keeps opacity fades, no other property's.
    const tab = ".zen-v2-segment > [role='tab']"
    expect([...transitions(tab).entries()]).toEqual([['color', 120]])
    expect([...transitions(`${tab}::after`).entries()]).toEqual([['opacity', 120]])
    expect(transitions(tab, true).size).toBe(0)
    expect([...transitions(`${tab}::after`, true).entries()]).toEqual([['opacity', 120]])
    // The line is 2 px of the family's accent at the label's width, no pill and no fill.
    expect(declared(`${tab}::after`, 'height')).toBe('2px')
    expect(declared(`${tab}::after`, 'background')).toContain('--v2-control-accent')
    expect(declared(tab, 'background')).toBeUndefined()
    expect(declared('.zen-v2-segment', 'background')).toBeUndefined()
    expect(declared('.zen-v2-segment', 'min-height')).toBe('var(--v2-row)')
    expect(declared(tab, 'font-weight')).toBe('var(--v2-weight-heading)')
  })

  it('nothing on the phone tweens a theme token per element: the blend is the one colour animation (v2 §11.6)', () => {
    // The two fills in the theme's ink that used to re-tween each frame of the blend and trail it.
    expect(declared('.zen-pill-well', 'background')).toContain('--zen-fg-rgb')
    expect(declared('.zen-pill-well', 'transition')).toBeUndefined()
    expect(declared('.zen-overview-new', 'background')).toContain('--zen-fg-rgb')
    expect(declared('.zen-overview-new', 'transition')).toBeUndefined()
    // The phone window's own background transition is off (the desktop keeps its 600 ms).
    expect(declared(":root[data-form-factor='phone'] .zen-window", 'transition')).toBe('none')
  })
})
