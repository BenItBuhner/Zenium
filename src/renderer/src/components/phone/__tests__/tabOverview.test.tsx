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
const { collectCells, FlipTracker } = await import('@renderer/lib/motion/flip')
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
function stateOf(tabs: Tab[]): UIState {
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
    folders: { [GROUP]: folder },
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
const layout = new Map<string, DOMRect>([
  [GRID, new DOMRect(0, 0, 220, 600)],
  [`group:${GROUP}`, new DOMRect(0, 0, 220, 170)],
  ['m1', new DOMRect(10, 36, 100, 130)],
  ['m2', new DOMRect(120, 36, 100, 130)],
  ['a', new DOMRect(0, 180, 100, 130)],
  ['b', new DOMRect(110, 180, 100, 130)],
  [NEW_TAB_CELL, new DOMRect(0, 320, 100, 130)]
])
const measured = HTMLElement.prototype.getBoundingClientRect
HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
  if (this.classList.contains('zen-overview-grid')) return layout.get(GRID)!
  const key = this.closest('[data-cell]')?.getAttribute('data-cell')
  return (key ? layout.get(key) : undefined) ?? measured.call(this)
}

const at = (key: string, fx: number, fy: number): { x: number; y: number } => {
  const r = layout.get(key)!
  return { x: r.left + r.width * fx, y: r.top + r.height * fy }
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

beforeEach(() => {
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
  act(() => root?.unmount())
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
    pickUp('m1')

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
    // The gesture survived the re-mount…
    expect(activeLiftPointer()).toBe(POINTER)

    // …and the release lands the card where the finger is: first among the loose tabs.
    letGo(edge.x, edge.y)
    expect(activeLiftPointer()).toBeNull()
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
