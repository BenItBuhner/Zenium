// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Space, Tab, UIState } from '@shared/types'
import { BLANK_URL } from '@shared/url'
import type { OverviewState } from '@renderer/lib/gestures/stage'

/*
 * The overview's wiring of the drag-to-group hint (TB-19: `TabOverview.tsx` hands
 * `useOverviewGroupsHint` the cards it may stand on), rendered for real – the grid, its cells,
 * the panes, the tablet flag – where the hook's own tests stand the cells in by hand. What the
 * first-line review of #701 found unpinned at the wiring (its mutants M3, M6, M7): a grouped tab
 * active, the bubble falls back to the loose run – never a group's card or a member's; the
 * tablet's overview names no card; nor do the Private and Groups panes. Mounted under StrictMode
 * as every dev build mounts it, on its way open and then at rest, as the stage mounts it.
 */

const SPACE = 'space'
const GROUP = 'g'

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) =>
  name === 'session.recentlyClosed' ? [] : null
)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { TabOverview } = await import('../TabOverview')
const { cancelLift } = await import('../useCardLift')
const { clearDepartures } = await import('../departureStore')
const { pickOverviewPane, resetOverviewPane } = await import('@renderer/lib/privateTabs')
const { resetOverviewUi } = await import('@renderer/lib/overviewUi')
const { layoutAnimations } = await import('@renderer/lib/motion/flip')
const { PRIVATE_CONTAINER_ID } = await import('@shared/types')
const {
  forgetHintBubble,
  HINT_BUBBLE_ID,
  hintBubbleStore,
  iphSessionSpent,
  requestOverviewGroupsHint,
  resetIphSession,
  takeOverviewGroupsHintRequest
} = await import('@renderer/lib/iph')

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

/** `tabs` in track order; the first is active. The drag hint's record unspent. */
function stateOf(tabs: Tab[], privateTabs = false): UIState {
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
    capabilities: { windowControls: false, privateTabs },
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
      containerSpecificEssentials: false,
      onboardingDone: true,
      iph: {
        tabSwitcher: { availableAt: null, shown: false },
        tabGroupsDragAndDrop: { availableAt: null, shown: false }
      }
    },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: [],
    closingTabIds: [],
    sync: { enabled: false, scope: { openTabs: false } }
  } as unknown as UIState
}

/**
 * The tip's profile: the active tab in a group with a second, two loose pages after them, and
 * the new tab page the tip stood on last.
 */
const grouped = (): Tab[] => [
  tab('m1', 'https://one.example/', { folderId: GROUP }),
  tab('m2', 'https://two.example/', { folderId: GROUP }),
  tab('a', 'https://a.example/'),
  tab('b', 'https://b.example/'),
  tab('n', BLANK_URL)
]

// --- a layout ----------------------------------------------------------------------------------

/**
 * happy-dom lays nothing out: the grid's scroller answers `getBoundingClientRect` with one box,
 * and every cell (a card's inner button with its cell's) with a box inside it – in view – unless
 * `layout` places it elsewhere.
 */
const GRID_BOX = new DOMRect(0, 0, 360, 800)
const IN_VIEW = new DOMRect(16, 120, 160, 213)
const layout = new Map<string, DOMRect>()
const measured = HTMLElement.prototype.getBoundingClientRect
HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
  if (this.classList.contains('zen-overview-grid')) return GRID_BOX
  const key = this.closest('[data-cell]')?.getAttribute('data-cell')
  if (key) return layout.get(key) ?? IN_VIEW
  return measured.call(this)
}
afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = measured
})

// --- rendering ---------------------------------------------------------------------------------

let root: Root | null = null
let host: HTMLElement | null = null

const SETTLING: OverviewState = { phase: 'settling', progress: 0.8, heroTabId: null, target: 1 }
const OPEN: OverviewState = { phase: 'open', progress: 1, heroTabId: null, target: 1 }
const AREA = { x: 0, y: 0, width: 360, height: 800 }

function render(state: UIState, overview: OverviewState, tablet: boolean): void {
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
        createElement(TabOverview, { state, overview, area: AREA, edge: 'bottom', tablet })
      )
    )
  )
}
/** The tip's opening: its request left, the overview mounted on its way and coming to rest. */
function openFromTip(state: UIState, tablet = false): void {
  requestOverviewGroupsHint()
  render(state, SETTLING, tablet)
  render(state, OPEN, tablet)
}
/** The overview's next opening: a fresh mount. */
function remount(): void {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
}

const bubble = (): ReturnType<typeof hintBubbleStore.get>['bubble'] => hintBubbleStore.get().bubble
const cellOf = (key: string): HTMLElement | null =>
  host!.querySelector<HTMLElement>(`.zen-overview-grid [data-cell="${key}"]`)
/** The cells wearing the halo (`OverviewCard`'s `hinted`), by key. */
const haloed = (): Array<string | null> =>
  [...host!.querySelectorAll('[data-iph-anchor]')].map(
    (el) => el.closest('[data-cell]')?.getAttribute('data-cell') ?? null
  )
const writes = (): unknown[] =>
  invoke.mock.calls.filter(([name]) => name === 'settings.update').map(([, args]) => args)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  // The grid's springs are not these pins': no frame ever runs.
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  invoke.mockClear()
  layout.clear()
  takeOverviewGroupsHintRequest()
  resetIphSession()
  forgetHintBubble()
})

afterEach(() => {
  act(() => cancelLift())
  act(() => clearDepartures())
  remount()
  layoutAnimations.release()
  act(() => resetOverviewUi())
  resetOverviewPane()
  takeOverviewGroupsHintRequest()
  forgetHintBubble()
  resetIphSession()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("the overview's wiring of the drag-to-group hint (the first-line review's mutants on #701)", () => {
  it("a grouped tab active: the bubble falls back to the loose run – its first page card in grid order, never a group's card or a member's – and that card wears it (M3)", () => {
    openFromTip(stateOf(grouped()))
    expect(bubble()).toMatchObject({ id: 'tabGroupsDragAndDrop', at: 'overview', tabId: 'a' })
    expect(haloed()).toEqual(['a'])
    expect(cellOf('a')!.querySelector(`[aria-describedby="${HINT_BUBBLE_ID}"]`)).not.toBeNull()
    for (const key of ['m1', 'm2', `group:${GROUP}`, 'b', 'n'])
      expect(cellOf(key)!.querySelector('[data-iph-anchor]')).toBeNull()
    expect(writes()).toEqual([
      { iph: { tabGroupsDragAndDrop: { availableAt: expect.any(Number), shown: true } } }
    ])
    // The in-view rule read off the real grid: with `a` scrolled off the layer, `b` takes it.
    remount()
    layout.set('a', new DOMRect(16, 2000, 160, 213))
    openFromTip(stateOf(grouped()))
    expect(bubble()).toMatchObject({ tabId: 'b' })
    expect(haloed()).toEqual(['b'])
  })

  it('never on the tablet, which has no tips card: no card named, nothing written, the request dropped (M6)', () => {
    openFromTip(stateOf(grouped()), true)
    expect(cellOf('a')).not.toBeNull()
    expect(bubble()).toBeNull()
    expect(haloed()).toEqual([])
    expect(writes()).toEqual([])
    expect(iphSessionSpent()).toBe(false)
    expect(takeOverviewGroupsHintRequest()).toBe(false)
  })

  it('never on the private view – its cards group nothing (M7; cleanup spec §3)', () => {
    const state = stateOf(
      [...grouped(), tab('p', 'https://p.example/', { containerId: PRIVATE_CONTAINER_ID })],
      true
    )
    pickOverviewPane('private')
    openFromTip(state)
    // The private page's card is on the grid, in view, and bare.
    expect(cellOf('p')).not.toBeNull()
    expect(cellOf('a')).toBeNull()
    expect(bubble()).toBeNull()
    expect(haloed()).toEqual([])
    expect(writes()).toEqual([])
    expect(takeOverviewGroupsHintRequest()).toBe(false)
    // The regular view of the same profile: the rule as above.
    remount()
    pickOverviewPane('tabs')
    openFromTip(state)
    expect(bubble()).toMatchObject({ tabId: 'a' })
  })
})
