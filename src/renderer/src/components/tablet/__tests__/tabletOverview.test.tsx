// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Space, Tab, UIState } from '@shared/types'
import type { OverviewState } from '@renderer/lib/gestures/stage'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { PHONE_MAX_WIDTH } from '@shared/formFactor'
import { BLANK_URL } from '@shared/url'

/*
 * The tablet shell's mount of the tab overview (matrix TABLET-14, TABLET-08, MOT-04; v2 §9.34,
 * §9.36, §11): the phone's `TabOverview` under a `tablet` flag, at the width's columns – three or
 * more at any tablet width – with the tab search as a FIELD standing in the header row where the
 * phone has its magnifier, always up on a searchable pane, its X only over a query. The overview's
 * transient state – the query, the select-tabs mode and its picks, the sheet that is up, the
 * grid's scroll – is `overviewUiStore`'s, not the component's: a window resized between the phone
 * and tablet layouts swaps shells, and the next shell's mount comes up where the last one stood
 * (a fold, TABLET-08); the stage's one close path resets it. On the tablet the switcher comes
 * DOWN from the toolbar's edge over the page (a negative `translateY` on the overview's progress,
 * §9.36's "pulled down from the toolbar"), the page's still under it, in place of the phone's
 * fakebox morph; reduced motion is the fade at scale 1 (§11.3); the cards take the frame's
 * aspect and the grid opens with the active card's row whole. The phone's mount is untouched.
 * Rendered for real in happy-dom, the frame loop cranked by hand, the core stubbed.
 */

const SPACE = 'space'

// --- the core ----------------------------------------------------------------------------------

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) =>
  name === 'session.recentlyClosed' ? [] : null
)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { TabOverview } = await import('../../phone/TabOverview')
const { tabletCardAspect } = await import('@renderer/lib/layout')
const { PhoneStage } = await import('../../phone/PhoneStage')
const { cancelLift } = await import('../../phone/useCardLift')
const { clearDepartures } = await import('../../phone/departureStore')
const { layoutAnimations } = await import('@renderer/lib/motion/flip')
const { FrameDialogHost } = await import('@renderer/lib/portals')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore, claimMessageCards, contentAreaStore, uiStore } =
  await import('@renderer/lib/ui')
const { dismissOverview, stageStore } = await import('@renderer/lib/gestures/stage')
const { resetOverviewPane } = await import('@renderer/lib/privateTabs')
const { OVERVIEW_UI_OFF, overviewUiStore, resetOverviewUi } =
  await import('@renderer/lib/overviewUi')
const { overviewColumns } = await import('@renderer/lib/layout')
const { dispatchBackEvent, pushBackSurface, topBackSurface } = await import('@renderer/lib/back')
const { COVERED_TIMEOUT_MS, onLayoutApplied, onViewDrawn, pageViewStore } =
  await import('@renderer/lib/pageView')

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
    folders: {},
    essentialTabIds: [],
    containers: [],
    settings: { ...DEFAULT_SETTINGS, pinnedCloseBehavior: 'unload' },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: [],
    recentlyClosed: [],
    closingTabIds: [],
    sync: {
      enabled: false,
      folder: null,
      folderName: null,
      folderLost: false,
      deviceId: 'device-tablet',
      deviceName: 'Pixel Tablet',
      scope: {
        spaces: true,
        folders: true,
        pinnedTabs: true,
        essentials: true,
        openTabs: true,
        containers: true,
        bookmarks: true,
        settings: true,
        shortcuts: true,
        boosts: true
      },
      lastSyncAt: null,
      lastError: null,
      syncing: false,
      devices: [],
      pendingMerge: false,
      remoteTabsVersion: 0
    }
  } as unknown as UIState
}

/** Five pages – two on Wikipedia – and a blank tab. */
const pages = (): Tab[] => [
  tab('ex', 'https://example.com/', { title: 'Example Domain' }),
  tab('coffee', 'https://en.wikipedia.org/wiki/Coffee', { title: 'Coffee - Wikipedia' }),
  tab('pulls', 'https://github.com/BenItBuhner/Zenium/pulls', { title: 'Pull requests' }),
  tab('tea', 'https://en.wikipedia.org/wiki/Tea', { title: 'Tea – Wikipédia' }),
  tab('hn', 'https://news.ycombinator.com/', { title: 'Hacker News' }),
  tab('blank', BLANK_URL)
]

const OPEN = { phase: 'open', progress: 1, heroTabId: null, target: 1 } as const
/** The page's frame under the tablet's toolbar, on the tablet shard's 1280 × 800. */
const AREA = { x: 0, y: 56, width: 1280, height: 744 }
/** The tablet shard's window, a finger on it. */
const TABLET = {
  formFactor: 'tablet',
  width: 1280,
  height: 800,
  coarse: true,
  hover: false
} as const
const PHONE = { formFactor: 'phone', width: 412, height: 915, coarse: true, hover: false } as const

// --- a clock and a frame loop ------------------------------------------------------------------

class Frames {
  now = 0
  private queue = new Map<number, (now: number) => void>()
  private seq = 0

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++this.seq
      this.queue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue.delete(id)
    })
    vi.spyOn(performance, 'now').mockImplementation(() => this.now)
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) {
      this.now += 16
      const pending = [...this.queue.values()]
      this.queue.clear()
      for (const cb of pending) cb(this.now)
    }
  }
}

const frames = new Frames()
let root: Root | null = null
let host: HTMLElement | null = null
let sizes: Array<[string, PropertyDescriptor | undefined]> = []
/** Where each scroller stands: happy-dom lays nothing out, so the grid's scroll is kept here. */
const scrollTops = new WeakMap<HTMLElement, number>()
let releaseCards: (() => void) | null = null
let reduced = false

/** The async work between one step and the next: a list read, a commit. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

/** Run the springs out: a sheet lands. */
async function land(): Promise<void> {
  await act(async () => {
    frames.run(150)
  })
  await settle()
}

function ensureRoot(): Root {
  if (!root) {
    host = document.createElement('div')
    host.className = 'zen-window'
    document.body.appendChild(host)
    root = createRoot(host)
  }
  return root
}

/** The overview alone, open, as the tablet shell (or the phone's) mounts it. */
function render(state: UIState, tablet: boolean): void {
  act(() =>
    ensureRoot().render(
      createElement(
        FrameDialogHost,
        null,
        createElement(TabOverview, {
          state,
          overview: OPEN,
          area: AREA,
          edge: tablet ? 'top' : 'bottom',
          tablet
        })
      )
    )
  )
}

/**
 * The stage as a shell mounts it: the phone shell's, or the tablet shell's under its `tablet`
 * flag. A shell swap (`swapTo`) unmounts the one and mounts the other – what a window resized
 * across `PHONE_MAX_WIDTH` does to the tree – with the stores as they were.
 */
function mountStage(state: UIState, tablet: boolean): void {
  act(() =>
    ensureRoot().render(
      createElement(
        FrameDialogHost,
        null,
        createElement(PhoneStage, { state, edge: tablet ? 'top' : 'bottom', tablet })
      )
    )
  )
}

async function swapTo(state: UIState, tablet: boolean): Promise<void> {
  act(() => ensureRoot().render(null))
  viewportStore.set(tablet ? TABLET : PHONE)
  mountStage(state, tablet)
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  frames.install()
  reduced = false
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion') && reduced,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }))
  invoke.mockClear()
  viewportStore.set(TABLET)
  sizes = ['clientHeight', 'offsetHeight', 'scrollTop'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  ])
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-sheet-scroll') ? 300 : 800
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-overview') ? 744 : 300
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return scrollTops.get(this) ?? 0
    },
    set(this: HTMLElement, top: number) {
      scrollTops.set(this, top)
    }
  })
  uiStore.set({ toasts: [] })
  releaseCards = claimMessageCards()
  contentAreaStore.set({ area: AREA })
  stageStore.set({ ...stageStore.get(), overview: OPEN })
})

afterEach(() => {
  act(() => cancelLift())
  act(() => clearDepartures())
  act(() => root?.unmount())
  layoutAnimations.release()
  root = null
  host?.remove()
  host = null
  releaseCards?.()
  releaseCards = null
  uiStore.set({ toasts: [], overlay: 'none', overlayFolderId: null })
  browserStore.set({ state: null })
  contentAreaStore.set({ area: null })
  stageStore.set({
    ...stageStore.get(),
    overview: { phase: 'closed', progress: 0, heroTabId: null, target: 0 }
  })
  act(() => resetOverviewPane())
  act(() => resetOverviewUi())
  pageViewStore.set({ phases: new Map(), lastApplied: null })
  for (const [name, descriptor] of sizes) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  frames.now = 0
})

// --- helpers -----------------------------------------------------------------------------------

const byLabel = (label: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const buttonByText = (text: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === text)
/** The cards in the grid's order (the New Tab card among them). */
const cellKeys = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-cell]')].map((el) =>
    el.getAttribute('data-cell')!
  )
/** The overview's header row (the cards' title rows are not it). */
const header = (): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('header')].find(
    (h) => !h.classList.contains('zen-overview-card-header')
  )!
const headerButtons = (): string[] =>
  [...header().querySelectorAll<HTMLElement>('button')].map(
    (b) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? ''
  )
const field = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>('#overview-search')
const layer = (): HTMLElement => document.querySelector<HTMLElement>('.zen-overview')!
const hero = (): HTMLElement | null => document.querySelector<HTMLElement>('.zen-overview-hero')
/** The Tabs pane's scroller: the grid the finger scrolls (the one the drivers read by `data-pane`). */
const scroller = (): HTMLElement =>
  document.querySelector<HTMLElement>('.zen-overview-grid[data-pane="tabs"]')!
const grid = (): HTMLElement => scroller().querySelector<HTMLElement>('.grid')!
const sheetRows = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('.zen-sheet .zen-sheet-item')].map(
    (e) => e.textContent?.trim() ?? ''
  )
/** The cards that are checkboxes, with their state, in the grid's order. */
const checkboxes = (): Array<[string, boolean]> =>
  [...document.querySelectorAll<HTMLElement>('[data-cell] > [role="checkbox"]')].map((el) => [
    el.closest('[data-cell]')!.getAttribute('data-cell')!,
    el.getAttribute('aria-checked') === 'true'
  ])
const card = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-cell="${id}"] > [role]`)!

/** Type `text` into the search field as a keyboard would, one committed value. */
function type(text: string): void {
  const input = field()!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** The system back, committed. */
function back(): void {
  act(() => {
    dispatchBackEvent('start', { edge: 'left' })
    dispatchBackEvent('commit')
  })
}

/** The finger scrolls the grid to `top`. */
function scrollGridTo(top: number): void {
  const el = scroller()
  act(() => {
    el.scrollTop = top
    el.dispatchEvent(new Event('scroll', { bubbles: false }))
  })
}

async function openMenu(): Promise<void> {
  act(() => byLabel('More')!.click())
  await settle()
  await land()
}

async function pick(text: string): Promise<void> {
  const row = buttonByText(text)
  expect(row, text).toBeDefined()
  act(() => row!.click())
  await land()
}

function overview(patch: Partial<OverviewState>): void {
  act(() => stageStore.set({ overview: { ...stageStore.get().overview, ...patch } }))
}

/** The core took `tabId`'s page view down and the host drew the frame without it. */
function pageOff(tabId: string): void {
  act(() => {
    onLayoutApplied({ contentHidden: true, hid: [tabId], shown: [] })
    onViewDrawn(tabId, false)
  })
}

// --- (A) the grid --------------------------------------------------------------------------------

describe('the tablet grid (TABLET-14)', () => {
  it('spans three columns or more at every tablet width: Chrome`s tablet span counts', () => {
    for (let width = PHONE_MAX_WIDTH; width <= 2560; width += 8) {
      expect(overviewColumns(width), `${width}px`).toBeGreaterThanOrEqual(3)
    }
    expect(overviewColumns(PHONE_MAX_WIDTH)).toBe(3)
    expect(overviewColumns(799)).toBe(3)
    expect(overviewColumns(800)).toBe(4)
    expect(overviewColumns(1280)).toBe(4)
  })

  it('lays the cards at the width`s columns: four on the tablet shard, three at the narrowest tablet', () => {
    render(stateOf(pages()), true)
    expect(grid().style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))')
    act(() => viewportStore.set({ ...TABLET, width: 600, height: 1000 }))
    expect(grid().style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))')
  })
})

// --- (B) the search field in the header --------------------------------------------------------

describe('the search field in the tablet header (TABLET-14, §9.34)', () => {
  it('stands in the header row in the magnifier`s place, up without a tap, the keyboard not taken', () => {
    render(stateOf(pages()), true)
    const input = field()
    expect(input).not.toBeNull()
    expect(input!.getAttribute('aria-label')).toBe('Search tabs')
    expect(header().contains(input)).toBe(true)
    expect(byTestId('overview-search-toggle')).toBeNull()
    expect(byTestId('overview-search')!.classList.contains('zen-overview-search-inline')).toBe(true)
    // The phone's segments row stays: Spaces and More beside the field, no magnifier.
    expect(headerButtons()).toEqual(['Spaces', 'More'])
    expect(document.activeElement).not.toBe(input)
    // An empty field is a control like the others: no X, nothing for back to address.
    expect(byTestId('overview-search-clear')).toBeNull()
    expect(topBackSurface()?.name).not.toBe('overview-search')
  })

  it('narrows the grid as it is typed, the X and the back surface only over a query; back clears the query and keeps the field', () => {
    render(stateOf(pages()), true)
    type('wiki')
    expect(cellKeys()).toEqual(['coffee', 'tea'])
    expect(byTestId('overview-search-clear')?.getAttribute('aria-label')).toBe('Clear search')
    expect(topBackSurface()?.name).toBe('overview-search')
    expect(overviewUiStore.get().search).toEqual({ open: true, query: 'wiki' })
    back()
    expect(field()?.value).toBe('')
    expect(field()).not.toBeNull()
    expect(byTestId('overview-search-clear')).toBeNull()
    expect(topBackSurface()?.name).not.toBe('overview-search')
    expect(cellKeys()).toEqual(['ex', 'coffee', 'pulls', 'tea', 'hn', 'blank', 'new-tab'])
  })

  it('the X over a query clears it and keeps the field with the keyboard', () => {
    render(stateOf(pages()), true)
    type('tea')
    expect(cellKeys()).toEqual(['tea'])
    act(() => byTestId('overview-search-clear')!.click())
    expect(field()?.value).toBe('')
    expect(document.activeElement).toBe(field())
    expect(byTestId('overview-search-clear')).toBeNull()
  })

  it('the phone`s mount is the phone`s: the magnifier, no field until it is tapped', () => {
    viewportStore.set(PHONE)
    render(stateOf(pages()), false)
    expect(field()).toBeNull()
    expect(headerButtons()).toEqual(['Search tabs', 'Spaces', 'More'])
    act(() => byTestId('overview-search-toggle')!.click())
    expect(field()).not.toBeNull()
    expect(byTestId('overview-search')!.classList.contains('zen-overview-search-inline')).toBe(
      false
    )
    expect(header().contains(field())).toBe(false)
  })
})

// --- (C) the shell swap ------------------------------------------------------------------------

describe('the overview across a shell swap (TABLET-08)', () => {
  it('keeps the query, the narrowed grid and the grid`s scroll from the phone shell into the tablet`s', async () => {
    const state = stateOf(pages())
    viewportStore.set(PHONE)
    mountStage(state, false)
    await settle()
    act(() => byTestId('overview-search-toggle')!.click())
    type('wiki')
    expect(cellKeys()).toEqual(['coffee', 'tea'])
    scrollGridTo(240)
    expect(overviewUiStore.get().scroll).toEqual({ pane: 'tabs', top: 240 })

    await swapTo(state, true)
    expect(layer().hasAttribute('data-tablet')).toBe(true)
    expect(field()?.value).toBe('wiki')
    expect(header().contains(field())).toBe(true)
    expect(cellKeys()).toEqual(['coffee', 'tea'])
    expect(scroller().scrollTop).toBe(240)
    // The swap took no keyboard: the field is where it was, not focused anew.
    expect(document.activeElement).not.toBe(field())

    // And back the other way: the tablet's query stands in the phone's pinned field.
    await swapTo(state, false)
    expect(layer().hasAttribute('data-tablet')).toBe(false)
    expect(field()?.value).toBe('wiki')
    expect(header().contains(field())).toBe(false)
    expect(cellKeys()).toEqual(['coffee', 'tea'])
  })

  it('keeps the sheet that is up: the phone`s menu comes up again on the tablet`s mount', async () => {
    const state = stateOf(pages())
    viewportStore.set(PHONE)
    mountStage(state, false)
    await settle()
    await openMenu()
    expect(sheetRows()).toContain('Select Tabs')
    expect(overviewUiStore.get().sheet?.kind).toBe('menu')

    await swapTo(state, true)
    await land()
    expect(overviewUiStore.get().sheet?.kind).toBe('menu')
    expect(sheetRows()).toContain('Select Tabs')
  })

  it('keeps the select-tabs mode and its picks; the stage`s close resets everything', async () => {
    const state = stateOf(pages())
    viewportStore.set(PHONE)
    mountStage(state, false)
    await settle()
    await openMenu()
    await pick('Select Tabs')
    expect(topBackSurface()?.name).toBe('overview-selection')
    act(() => card('coffee').click())
    expect(checkboxes().filter(([, on]) => on)).toEqual([['coffee', true]])

    await swapTo(state, true)
    expect(topBackSurface()?.name).toBe('overview-selection')
    expect(checkboxes().filter(([, on]) => on)).toEqual([['coffee', true]])
    expect(byTestId('overview-selected-count')?.textContent).toContain('1')

    // The overview closes through the stage's one path: the store is off with it.
    act(() => dismissOverview())
    expect(overviewUiStore.get()).toEqual(OVERVIEW_UI_OFF)
    expect(topBackSurface()?.name).not.toBe('overview-selection')
  })

  it('keeps the search`s place in the back stack: what opened over it before the swap stays on top', async () => {
    const state = stateOf(pages())
    viewportStore.set(PHONE)
    mountStage(state, false)
    await settle()
    act(() => byTestId('overview-search-toggle')!.click())
    type('wiki')
    expect(topBackSurface()?.name).toBe('overview-search')
    // The Spaces drawer's place: a surface pushed over the search before the fold.
    const popOver = pushBackSurface({ name: 'over-the-search', onCommit: () => undefined })
    expect(topBackSurface()?.name).toBe('over-the-search')

    await swapTo(state, true)
    // The tablet's mount did not re-push the search above it.
    expect(topBackSurface()?.name).toBe('over-the-search')
    popOver()
    // Below it the search stands, and its back is the new mount's: the query clears first.
    expect(topBackSurface()?.name).toBe('overview-search')
    act(() => {
      dispatchBackEvent('commit')
    })
    expect(field()?.value).toBe('')
    expect(overviewUiStore.get().search).toEqual({ open: false, query: '' })
    expect(topBackSurface()?.name).not.toBe('overview-search')
    expect(cellKeys()).toEqual(['ex', 'coffee', 'pulls', 'tea', 'hn', 'blank', 'new-tab'])
  })

  it('a pane`s scroll is its own: the swap onto another pane comes up at the top', async () => {
    const state = stateOf(pages())
    viewportStore.set(PHONE)
    mountStage(state, false)
    await settle()
    scrollGridTo(400)
    // The store notes the pane with the offset; a grid of another pane reads nothing from it.
    overviewUiStore.set({ scroll: { pane: 'private', top: 400 } })
    await swapTo(state, true)
    expect(scroller().scrollTop).toBe(0)
  })
})

// --- (D) the phone's gates on the tablet mount ---------------------------------------------------

describe("the phone switcher's gates hold on the tablet mount", () => {
  it('the Private pane stands under the lock cover, its grid inert, the cards masked (INC-05)', async () => {
    const { applyPrivateLock, resetPrivateLock } = await import('@renderer/lib/privateLock')
    const { pickOverviewPane } = await import('@renderer/lib/privateTabs')
    const { PRIVATE_CONTAINER_ID } = await import('@shared/types')
    const state = stateOf([
      tab('a', 'https://a.example/'),
      tab('p1', 'https://one.example/', { containerId: PRIVATE_CONTAINER_ID, title: 'one' })
    ])
    ;(state.capabilities as { privateTabs?: boolean }).privateTabs = true
    try {
      act(() => applyPrivateLock({ locked: true, screenLock: true }))
      render(state, true)
      expect(byTestId('private-lock-cover')).toBeNull()
      act(() => pickOverviewPane('private'))
      const cover = byTestId('private-lock-cover')
      expect(cover).not.toBeNull()
      expect(cover!.getAttribute('aria-label')).toBe('Private tabs locked')
      const privateGrid = document.querySelector<HTMLElement>(
        '.zen-overview-grid[data-pane="private"]'
      )!
      expect(privateGrid.hasAttribute('inert')).toBe(true)
      expect(privateGrid.getAttribute('aria-hidden')).toBe('true')
      expect(document.body.textContent).not.toContain('one.example')
      // The header's field is the Private pane's too (a card pane), still in the header row.
      expect(header().contains(field())).toBe(true)
    } finally {
      act(() => resetPrivateLock())
    }
  })

  it('the Inactive tabs entry is absent at 0 and the segment row`s trailing button otherwise (TAB-20, §9.34)', () => {
    const state = stateOf(pages())
    ;(state as unknown as { archivedTabCount: number }).archivedTabCount = 0
    render(state, true)
    expect(byTestId('overview-inactive-tabs')).toBeNull()
    const withArchive = { ...state, archivedTabCount: 2 } as UIState
    render(withArchive, true)
    const entry = byTestId('overview-inactive-tabs')
    expect(entry).not.toBeNull()
    expect(entry!.getAttribute('aria-label')).toBe('Inactive tabs, 2')
    // Never a fourth segment: the pane segments stay two (Tabs, Groups) beside it.
    expect(document.querySelectorAll('[data-testid^="overview-pane-"]').length).toBeLessThan(4)
  })

  it('a group is a card spanning the grid`s columns, its members in it (TAB-16)', () => {
    const research = {
      id: 'research',
      spaceId: SPACE,
      name: 'Research',
      icon: '',
      collapsed: false,
      color: 'blue'
    }
    const state = stateOf([
      tab('m1', 'https://en.wikipedia.org/wiki/Coffee', { title: 'Coffee', folderId: 'research' }),
      tab('m2', 'https://github.com/BenItBuhner/Zenium', { title: 'Zenium', folderId: 'research' }),
      tab('a', 'https://a.example/', { title: 'A' })
    ])
    ;(state.folders as Record<string, unknown>).research = research
    render(state, true)
    const group = document.querySelector<HTMLElement>('[data-cell="group:research"]')
    expect(group).not.toBeNull()
    expect(group!.classList.contains('col-span-full')).toBe(true)
    expect(byTestId('group-card-count')?.textContent?.trim()).toBe('2')
    expect(cellKeys()).toEqual(['group:research', 'm1', 'm2', 'a', 'new-tab'])
    // And the field narrows into the group: a query keeps the group's matching member alone.
    type('zen')
    expect(cellKeys()).toEqual(['group:research', 'm2'])
  })
})

// --- (E) the slide down from the toolbar ---------------------------------------------------------

/** The layer's transform at `p`: a full height above its rest at 0, descending to rest at 1. */
const descent = (p: number): string => `translateY(${-(1 - p) * 744}px)`

describe('the tablet switcher comes down from the toolbar`s edge over the page (MOT-04, §9.36)', () => {
  it('the layer descends on the progress – from above its box, a negative translateY – the page`s still under it in the page`s frame; open lands untransformed', () => {
    const state = stateOf(pages())
    pageOff('ex')
    overview({ phase: 'settling', progress: 0.3, heroTabId: 'ex', target: 1 })
    mountStage(state, true)
    const root = layer()
    expect(root.style.visibility).toBe('')
    expect(root.style.opacity).toBe('1')
    expect(root.style.transform).toBe(descent(0.3))
    // Above its rest, not below: the toolbar's edge is where it comes from.
    expect(parseFloat(root.style.transform.slice('translateY('.length))).toBeLessThan(0)
    // The still: the hero in the page's frame, before the layer's box in the tree (under it).
    const still = hero()!
    expect(still).not.toBeNull()
    expect(still.style.left).toBe(`${AREA.x}px`)
    expect(still.style.top).toBe(`${AREA.y}px`)
    expect(still.style.width).toBe(`${AREA.width}px`)
    expect(still.style.height).toBe(`${AREA.height}px`)
    expect(still.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Frames of the spring: written off React, the same 0…1, the layer lower each frame.
    overview({ progress: 0.75 })
    expect(layer().style.transform).toBe(descent(0.75))
    expect(hero()!.style.left).toBe(`${AREA.x}px`)
    // Open: at rest, the layer untransformed and the still gone.
    overview({ phase: 'open', progress: 1 })
    expect(layer().style.transform).toBe('')
    expect(layer().style.opacity).toBe('1')
    expect(hero()).toBeNull()
  })

  it('the pull and its release read the same direction, and the close is the same writer run back up', () => {
    const state = stateOf(pages())
    pageOff('ex')
    // The finger's pull: the layer follows it down, a full height above its rest at the start.
    overview({ phase: 'dragging', progress: 0, heroTabId: 'ex', target: 1 })
    mountStage(state, true)
    expect(layer().style.transform).toBe(`translateY(${-744}px)`)
    overview({ progress: 0.2 })
    expect(layer().style.transform).toBe(descent(0.2))
    overview({ progress: 0.4 })
    expect(layer().style.transform).toBe(descent(0.4))
    // The release: the spring carries it the rest of the way down, the same sign.
    overview({ phase: 'settling', progress: 0.6, target: 1 })
    expect(layer().style.transform).toBe(descent(0.6))
    overview({ phase: 'open', progress: 1 })
    expect(layer().style.transform).toBe('')
    // The dismissal: the layer goes back up the way it came, to the toolbar's edge.
    overview({ phase: 'settling', progress: 0.5, target: 0 })
    expect(layer().style.transform).toBe(descent(0.5))
    overview({ progress: 0.1 })
    expect(layer().style.transform).toBe(descent(0.1))
    expect(parseFloat(layer().style.transform.slice('translateY('.length))).toBeLessThan(-0.8 * 744)
  })

  it('under reduced motion the slide is the fade at scale 1 (§11.3)', () => {
    reduced = true
    const state = stateOf(pages())
    overview({ phase: 'settling', progress: 0.3, heroTabId: 'ex', target: 1 })
    mountStage(state, true)
    expect(layer().style.transform).toBe('')
    expect(Number(layer().style.opacity)).toBeCloseTo(Math.min(1, 0.3 * 1.6), 6)
    overview({ phase: 'open', progress: 1 })
    expect(layer().style.opacity).toBe('1')
  })

  it('the phone`s mount keeps its morph: the scale and fade, no translate', () => {
    viewportStore.set(PHONE)
    const state = stateOf(pages())
    overview({ phase: 'settling', progress: 0.3, heroTabId: 'ex', target: 1 })
    mountStage(state, false)
    expect(layer().style.transform).toBe(`scale(${0.94 + 0.06 * 0.3})`)
    expect(Number(layer().style.opacity)).toBeCloseTo(Math.min(1, 0.3 * 1.6), 6)
    expect(layer().hasAttribute('data-tablet')).toBe(false)
  })

  it('the layer stays unseen until the host has drawn the frame without the live page, then shows at the finger`s progress', async () => {
    const state = stateOf(pages())
    overview({ phase: 'dragging', progress: 0.3, heroTabId: 'ex', target: 1 })
    mountStage(state, true)
    // On Android the chrome lies under the page: a layer come down now would show beside it, in
    // the sidebar's column. The still stands in the page's frame from this first frame.
    expect(layer().style.visibility).toBe('hidden')
    expect(layer().style.transform).toBe(descent(0.3))
    expect(hero()!.style.left).toBe(`${AREA.x}px`)
    expect(hero()!.style.width).toBe(`${AREA.width}px`)
    // The finger moves while the view is on its way down: the layer follows, still unseen.
    act(() => onLayoutApplied({ contentHidden: true, hid: ['ex'], shown: [] }))
    overview({ progress: 0.5 })
    await settle()
    expect(layer().style.visibility).toBe('hidden')
    expect(layer().style.transform).toBe(descent(0.5))
    // The host drew the frame without the page: the layer shows where the finger has it.
    act(() => onViewDrawn('ex', false))
    await settle()
    expect(layer().style.visibility).toBe('')
    expect(layer().style.transform).toBe(descent(0.5))
    expect(layer().style.opacity).toBe('1')
  })

  it('a host that never says the page is gone: the layer shows after the cover hold`s timeout', async () => {
    const state = stateOf(pages())
    overview({ phase: 'settling', progress: 0.3, heroTabId: 'ex', target: 1 })
    mountStage(state, true)
    expect(layer().style.visibility).toBe('hidden')
    act(() => vi.advanceTimersByTime(COVERED_TIMEOUT_MS - 1))
    await settle()
    expect(layer().style.visibility).toBe('hidden')
    act(() => vi.advanceTimersByTime(1))
    await settle()
    expect(layer().style.visibility).toBe('')
  })

  it('with the page already off the screen, or no hero page, the layer shows from its first frame; the phone never writes it', () => {
    const state = stateOf(pages())
    overview({ phase: 'settling', progress: 0.3, heroTabId: null, target: 1 })
    mountStage(state, true)
    expect(layer().style.visibility).toBe('')
    act(() => ensureRoot().render(null))
    viewportStore.set(PHONE)
    overview({ phase: 'settling', progress: 0.3, heroTabId: 'ex', target: 1 })
    mountStage(state, false)
    expect(layer().style.visibility).toBe('')
    expect(layer().hasAttribute('data-tablet')).toBe(false)
  })
})

// --- (F) the cards' aspect -----------------------------------------------------------------------

/** The layer's box: the slide's clip, where the cards' ratio is set for every cell in it. */
const box = (): HTMLElement => layer().parentElement!

describe('the tablet card takes the frame`s aspect (§9.36)', () => {
  it('a landscape picture on a landscape tablet: the column over the frame`s ratio plus the title row, the phone`s 3 / 4 kept on a phone', () => {
    // The shard's frame beside the sidebar: 1040 × 744, four columns of 245 – the picture
    // 245 × 175 at the frame's 1040 : 744, the card 245 × 219 with its 44 row.
    const shard = tabletCardAspect({ width: 1040, height: 744 }, 4, 44)
    expect(shard).toBeCloseTo(245 / (245 * (744 / 1040) + 44), 6)
    expect(shard).toBeGreaterThan(1)
    expect(shard).toBeCloseTo(1.117, 3)
    // The picture under the row is the frame's: the cell's height less the row, over its width.
    const column = 245
    expect(column / (column / shard - 44)).toBeCloseTo(1040 / 744, 6)
    // A portrait tablet's frame draws a portrait picture; a frame without a size yet, the phone's.
    expect(tabletCardAspect({ width: 800, height: 1224 }, 4, 44)).toBeLessThan(1)
    expect(tabletCardAspect({ width: 0, height: 0 }, 4, 44)).toBe(3 / 4)
  })

  it('the ratio is set on the layer`s box for every cell to read; the phone`s box sets none and its cells draw 3 / 4', () => {
    render(stateOf(pages()), true)
    const ratio = box().style.getPropertyValue('--zen-overview-card-aspect')
    expect(Number(ratio)).toBeCloseTo(tabletCardAspect(AREA, 4, 44), 6)
    expect(Number(ratio)).toBeGreaterThan(1)
    // Every cell: a card, the New Tab card.
    const aspect = `var(--zen-overview-card-aspect, 3 / 4)`
    expect(document.querySelector<HTMLElement>('[data-cell="ex"]')!.style.aspectRatio).toBe(aspect)
    expect(byTestId('overview-new-tab')!.style.aspectRatio).toBe(aspect)
    // The frame narrows (the sidebar's drawer on a split-screen width): the ratio follows it.
    act(() => viewportStore.set({ ...TABLET, width: 600, height: 1000 }))
    act(() =>
      ensureRoot().render(
        createElement(
          FrameDialogHost,
          null,
          createElement(TabOverview, {
            state: stateOf(pages()),
            overview: OPEN,
            area: { x: 0, y: 56, width: 600, height: 944 },
            edge: 'top',
            tablet: true
          })
        )
      )
    )
    expect(Number(box().style.getPropertyValue('--zen-overview-card-aspect'))).toBeCloseTo(
      tabletCardAspect({ width: 600, height: 944 }, 3, 44),
      6
    )
    // The phone: nothing set, the cells' fallback is the ratio they draw.
    act(() => ensureRoot().render(null))
    viewportStore.set(PHONE)
    render(stateOf(pages()), false)
    expect(box().style.getPropertyValue('--zen-overview-card-aspect')).toBe('')
    expect(document.querySelector<HTMLElement>('[data-cell="ex"]')!.style.aspectRatio).toBe(aspect)
  })
})

// --- (G) the opening scroll ----------------------------------------------------------------------

describe('the grid opens with the active card`s row whole (§9.36)', () => {
  let scrolled: Array<[string, ScrollIntoViewOptions | boolean | undefined]> = []
  beforeEach(() => {
    scrolled = []
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (
      this: Element,
      arg?: ScrollIntoViewOptions | boolean
    ) {
      scrolled.push([this.getAttribute('data-cell') ?? this.className, arg])
    })
  })

  it('the hero`s cell is scrolled into view by `nearest` as the layer starts down, before the first paint, and not again once open', () => {
    // Eight tabs at four columns: the active one in the second row.
    const tabs = [
      ...pages(),
      tab('a', 'https://a.example/', { title: 'A' }),
      tab('b', 'https://b.example/', { title: 'B' })
    ]
    const state = stateOf(tabs)
    state.spaces[0]!.activeTabId = 'hn'
    overview({ phase: 'settling', progress: 0.05, heroTabId: 'hn', target: 1 })
    mountStage(state, true)
    // In the commit's layout phase – the mount's act returned with it done – the hero's cell,
    // the least move that shows it whole, the rows above it left as they fall.
    expect(scrolled).toEqual([['hn', { block: 'nearest' }]])
    // The grid keeps the card clear of its fades: the scroll's padding is the rule's other half.
    expect(scroller().style.scrollPaddingBlock).toBe('16px')
    // Frames of the spring move nothing; landing open asks for no second scroll.
    overview({ progress: 0.6 })
    overview({ phase: 'open', progress: 1 })
    expect(scrolled).toHaveLength(1)
  })

  it('a hero inside an open group brings the group`s card first, then its own', () => {
    const research = {
      id: 'research',
      spaceId: SPACE,
      name: 'Research',
      icon: '',
      collapsed: false,
      color: 'blue'
    }
    const state = stateOf([
      tab('a', 'https://a.example/', { title: 'A' }),
      tab('m1', 'https://en.wikipedia.org/wiki/Zen', { title: 'Zen', folderId: 'research' }),
      tab('m2', 'https://github.com/BenItBuhner/Zenium', { title: 'Zenium', folderId: 'research' })
    ])
    ;(state.folders as Record<string, unknown>).research = research
    state.spaces[0]!.activeTabId = 'm2'
    overview({ phase: 'settling', progress: 0.05, heroTabId: 'm2', target: 1 })
    mountStage(state, true)
    expect(scrolled).toEqual([
      ['group:research', { block: 'nearest' }],
      ['m2', { block: 'nearest' }]
    ])
  })

  it('a grid mounted open – the shell swapped under an open overview – scrolls to no card: the last grid`s scroll is restored instead (TABLET-08)', async () => {
    const state = stateOf(pages())
    viewportStore.set(PHONE)
    mountStage(state, false)
    await settle()
    scrollGridTo(240)
    scrolled = []
    await swapTo(state, true)
    expect(scrolled).toEqual([])
    expect(scroller().scrollTop).toBe(240)
  })
})
