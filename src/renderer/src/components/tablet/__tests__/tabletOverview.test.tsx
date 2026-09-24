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
 * (a fold, TABLET-08); the stage's one close path resets it. On the tablet the switcher slides up
 * over the page (`translateY` on the overview's progress), the page's still under it, in place of
 * the phone's fakebox morph; reduced motion is the fade at scale 1 (§11.3). The phone's mount is
 * untouched. Rendered for real in happy-dom, the frame loop cranked by hand, the core stubbed.
 */

const SPACE = 'space'

// --- the core ----------------------------------------------------------------------------------

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) =>
  name === 'session.recentlyClosed' ? [] : null
)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { TabOverview } = await import('../../phone/TabOverview')
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
const { dispatchBackEvent, topBackSurface } = await import('@renderer/lib/back')

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

// --- (E) the slide-up --------------------------------------------------------------------------

describe('the tablet switcher slides up over the page (MOT-04)', () => {
  it('the layer rises on the progress, the page`s still under it in the page`s frame; open lands untransformed', () => {
    const state = stateOf(pages())
    overview({ phase: 'settling', progress: 0.3, heroTabId: 'ex', target: 1 })
    mountStage(state, true)
    const root = layer()
    expect(root.style.opacity).toBe('1')
    expect(root.style.transform).toBe(`translateY(${(1 - 0.3) * 744}px)`)
    // The still: the hero in the page's frame, before the layer's box in the tree (under it).
    const still = hero()!
    expect(still).not.toBeNull()
    expect(still.style.left).toBe(`${AREA.x}px`)
    expect(still.style.top).toBe(`${AREA.y}px`)
    expect(still.style.width).toBe(`${AREA.width}px`)
    expect(still.style.height).toBe(`${AREA.height}px`)
    expect(still.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Frames of the spring: written off React, the same 0…1.
    overview({ progress: 0.75 })
    expect(layer().style.transform).toBe(`translateY(${(1 - 0.75) * 744}px)`)
    expect(hero()!.style.left).toBe(`${AREA.x}px`)
    // Open: at rest, the layer untransformed and the still gone.
    overview({ phase: 'open', progress: 1 })
    expect(layer().style.transform).toBe('')
    expect(layer().style.opacity).toBe('1')
    expect(hero()).toBeNull()
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
})
