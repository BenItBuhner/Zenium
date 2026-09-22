// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, StrictMode, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Space, Tab, UIState } from '@shared/types'
import type { OverviewState } from '@renderer/lib/gestures/stage'

/*
 * The overview's morph as the stage drives it (PERF-5 item 3): `PhoneStage` reads the store's
 * overview by its SHAPE – the phase, the hero, where it heads, whether it is short of open – so
 * a frame of the pull or of the spring (`progress` moving) renders nothing above or in the grid,
 * and `TabOverview`'s morph effect writes the frame to the DOM from the store: the root's scale
 * and fade, the hero's rect-lerp (v2 §11.4's layout per frame, unchanged), its radius, shadow
 * and fade into a folded group's card, its title row's height and fade. The hero's picture is
 * the one part React draws as the morph moves, and only where a pixel size of the placeholder
 * changes. Rendered for real in happy-dom through `PhoneStage`, the cards counted as they
 * render, the store ticked by hand.
 */

const SPACE = 'space'
const GROUP = 'g'
const AREA = { x: 0, y: 0, width: 220, height: 600 }

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) =>
  name === 'session.recentlyClosed' ? [] : null
)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Every card counts the renders the grid gives it; the real card is underneath (its cell, its hiding). */
const cardRenders: string[] = []
vi.mock('../OverviewCard', async (importOriginal) => {
  const real = await importOriginal<typeof import('../OverviewCard')>()
  return {
    ...real,
    OverviewCard: (props: ComponentProps<typeof real.OverviewCard>) => {
      cardRenders.push(props.tab.id)
      return createElement(real.OverviewCard, props)
    }
  }
})
/** The pictures are stubs recording the scale each was drawn at; the hero's is the covering one. */
const pictures: Array<{ tab: string; scale: number | undefined; cover: boolean }> = []
vi.mock('../TabPreview', () => ({
  TabPreview: ({ tab, scale, cover }: { tab: Tab; scale?: number; cover?: boolean }) => {
    pictures.push({ tab: tab.id, scale, cover: Boolean(cover) })
    return createElement('div', { 'data-preview': tab.id })
  }
}))

const { PhoneStage } = await import('../PhoneStage')
const { stageStore } = await import('@renderer/lib/gestures/stage')
const { contentAreaStore } = await import('@renderer/lib/ui')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { placeholderPx } = await import('../tabPlaceholder')
const { GROUP_HEADER } = await import('../groupCardHeader')
const { CARD_HEADER } = await import('../overviewCardHeader')
const { CARD_RADIUS } = await import('../OverviewCard')
const { layoutAnimations } = await import('@renderer/lib/motion/flip')
const { cancelLift } = await import('../useCardLift')
const { clearDepartures } = await import('../departureStore')
const { FrameDialogHost } = await import('@renderer/lib/portals')

// --- a profile ---------------------------------------------------------------------------------

function tab(id: string, patch: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: SPACE,
    containerId: 'default',
    url: `https://${id}.example/`,
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

const folder = (collapsed: boolean): Folder => ({
  id: GROUP,
  spaceId: SPACE,
  name: 'Research',
  icon: '📚',
  collapsed,
  color: 'blue'
})

/** Two grouped tabs, two loose; `a` is active. */
const TABS = [tab('a'), tab('b'), tab('m1', { folderId: GROUP }), tab('m2', { folderId: GROUP })]

function stateOf(collapsed = false): UIState {
  const space: Space = {
    id: SPACE,
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: TABS.map((t) => t.id),
    activeTabId: 'a',
    pinnedCollapsed: false
  }
  return {
    platform: 'android',
    capabilities: { windowControls: false },
    tabs: Object.fromEntries(TABS.map((t) => [t.id, t])),
    spaces: [space],
    activeSpaceId: SPACE,
    folders: { [GROUP]: folder(collapsed) },
    essentialTabIds: [],
    containers: [],
    settings: {
      colorScheme: 'light',
      sidebarSide: 'left',
      phoneBarPosition: 'bottom',
      pinnedCloseBehavior: 'unload',
      containerSpecificEssentials: false
    },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: []
  } as unknown as UIState
}

// --- a layout ----------------------------------------------------------------------------------

/**
 * happy-dom lays nothing out: cells answer `getBoundingClientRect` from this table by their
 * `data-cell` key. The group card across the top (under a 40 px header row), its members inside
 * it, the loose cards below. The overview's root answers zeros and no `offsetWidth`, so the
 * hero's measured cell is the table's rect as it stands.
 */
const GROUP_Y = 40
const ROW_1 = GROUP_Y + GROUP_HEADER + 4
const CELLS: Record<string, DOMRect> = {
  [`group:${GROUP}`]: new DOMRect(0, GROUP_Y, 220, 170),
  m1: new DOMRect(10, ROW_1, 100, 130),
  m2: new DOMRect(120, ROW_1, 100, 130),
  a: new DOMRect(0, 260, 100, 130),
  b: new DOMRect(110, 260, 100, 130)
}
const measured = HTMLElement.prototype.getBoundingClientRect
HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
  if (this.classList.contains('zen-overview-grid')) return new DOMRect(0, 0, 220, 600)
  const key = this.closest('[data-cell]')?.getAttribute('data-cell')
  return (key && CELLS[key]) || measured.call(this)
}

/** The page's box morphs towards the cell: the rect-lerp the writer draws at `p`. */
const lerp = (
  cell: DOMRect,
  p: number
): { x: number; y: number; width: number; height: number } => ({
  x: AREA.x + (cell.x - AREA.x) * p,
  y: AREA.y + (cell.y - AREA.y) * p,
  width: AREA.width + (cell.width - AREA.width) * p,
  height: AREA.height + (cell.height - AREA.height) * p
})

// --- a clock -----------------------------------------------------------------------------------

/** A hand-cranked animation frame for the sheets' springs: `run(n)` advances 16 ms a frame. */
let now = 0
let nextFrame = 1
const frames = new Map<number, (t: number) => void>()
const run = (n: number): void => {
  for (let i = 0; i < n; i++) {
    now += 16
    const batch = [...frames.values()]
    frames.clear()
    for (const cb of batch) cb(now)
  }
}

let sizes: Array<[string, PropertyDescriptor | undefined]> = []

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
  // The frame's dialog layer is 800 px tall and a sheet's content 300: a sheet with room to stand.
  sizes = ['clientHeight', 'offsetHeight'].map((name) => [
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
    get: () => 300
  })
  // The sheets are the phone's (the dialog host draws a dialog on the desktop).
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
  contentAreaStore.set({ area: AREA })
  cardRenders.length = 0
  pictures.length = 0
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
  stageStore.set({ overview: { phase: 'closed', progress: 0, heroTabId: null, target: 0 } })
  contentAreaStore.set({ area: null })
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
  for (const [name, descriptor] of sizes) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// --- rendering ---------------------------------------------------------------------------------

let root: Root | null = null
let host: HTMLElement | null = null

/**
 * The stage as the phone shell mounts it, on the frame's dialog host (the sheets). `strict`
 * renders under `StrictMode` as every dev build does – effects mount, clean up and mount again,
 * so a store subscription dropped in a cleanup would be gone for good.
 */
function mount(state: UIState, strict = false): void {
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  const stage = createElement(
    FrameDialogHost,
    null,
    createElement(PhoneStage, { state, edge: 'bottom' })
  )
  act(() => root!.render(strict ? createElement(StrictMode, null, stage) : stage))
}

/** The store's overview: the stage's frames come from here. */
function overview(patch: Partial<OverviewState>): void {
  act(() => stageStore.set({ overview: { ...stageStore.get().overview, ...patch } }))
}
const DRAGGING: OverviewState = { phase: 'dragging', progress: 0.3, heroTabId: 'a', target: 1 }

const rootEl = (): HTMLElement => host!.querySelector<HTMLElement>('.zen-overview')!
const hero = (): HTMLElement | null => host!.querySelector<HTMLElement>('.zen-overview-hero')
const heroHeader = (): HTMLElement => hero()!.firstElementChild as HTMLElement
const cardOf = (id: string): HTMLElement =>
  host!.querySelector<HTMLElement>(`[data-cell="${id}"] > .zen-overview-card`)!
const scaleOf = (el: HTMLElement): number =>
  Number(/scale\(([\d.]+)\)/.exec(el.style.transform)?.[1] ?? NaN)
const px = (value: string): number => parseFloat(value)
/** The frame the hero stands at: its box against the lerp towards `cell` at `p`, its root's scale and fade. */
function expectFrame(cell: DOMRect, p: number): void {
  const el = hero()!
  const r = lerp(cell, p)
  expect(px(el.style.left)).toBeCloseTo(r.x, 6)
  expect(px(el.style.top)).toBeCloseTo(r.y, 6)
  expect(px(el.style.width)).toBeCloseTo(r.width, 6)
  expect(px(el.style.height)).toBeCloseTo(r.height, 6)
  expect(px(el.style.borderRadius)).toBeCloseTo(12 + (CARD_RADIUS - 12) * p, 6)
  expect(px(heroHeader().style.height)).toBeCloseTo(CARD_HEADER * p, 6)
  expect(Number(heroHeader().style.opacity)).toBeCloseTo(p, 6)
  expect(scaleOf(rootEl())).toBeCloseTo(0.94 + 0.06 * p, 6)
  expect(Number(rootEl().style.opacity)).toBeCloseTo(Math.min(1, p * 1.6), 6)
}
const heroPictures = (): number[] => pictures.filter((r) => r.cover).map((r) => r.scale ?? NaN)

// --- the frames --------------------------------------------------------------------------------

describe('the morph frames are written off React', () => {
  it('a frame of the pull renders no card: the hero, the root and the title row move from the store (StrictMode, as the dev builds mount)', () => {
    overview(DRAGGING)
    mount(stateOf(), true)
    // The mount: the hero on its first frame, in the commit; its own card hidden under it.
    expect(hero()).not.toBeNull()
    expectFrame(CELLS.a, 0.3)
    expect(cardOf('a').style.opacity).toBe('0')
    expect(cardOf('b').style.opacity).toBe('')
    expect(cardRenders).toContain('a')
    // Two moves of the finger: the frames are written, nothing in the grid renders.
    cardRenders.length = 0
    overview({ progress: 0.31 })
    expectFrame(CELLS.a, 0.31)
    overview({ progress: 0.32 })
    expectFrame(CELLS.a, 0.32)
    expect(cardRenders).toEqual([])
    expect(cardOf('a').style.opacity).toBe('0')
    // The shadow moves with the frame too.
    const shadowAt = hero()!.style.boxShadow
    overview({ progress: 0.5 })
    expect(hero()!.style.boxShadow).not.toBe('')
    expect(hero()!.style.boxShadow).not.toBe(shadowAt)
    expect(cardRenders).toEqual([])
  })

  it('the rubber band past open unmounts the hero and leaves the root at scale 1; the way back remounts it on its frame', () => {
    overview(DRAGGING)
    mount(stateOf())
    cardRenders.length = 0
    // Past 1 the shape changes (no longer short of open): one render, the hero gone, the card back.
    overview({ progress: 1.05 })
    expect(hero()).toBeNull()
    expect(scaleOf(rootEl())).toBe(1)
    expect(Number(rootEl().style.opacity)).toBe(1)
    expect(cardOf('a').style.opacity).toBe('')
    expect(cardRenders.filter((id) => id === 'a')).toHaveLength(1)
    // Back under 1: the hero is mounted again on the frame the store stands at.
    cardRenders.length = 0
    overview({ progress: 0.95 })
    expect(hero()).not.toBeNull()
    expectFrame(CELLS.a, 0.95)
    expect(cardOf('a').style.opacity).toBe('0')
    expect(cardRenders.filter((id) => id === 'a')).toHaveLength(1)
    // And the frames after it write again without a render.
    cardRenders.length = 0
    overview({ progress: 0.9 })
    expectFrame(CELLS.a, 0.9)
    expect(cardRenders).toEqual([])
  })

  it("the release: a phase change at the same progress renders the grid once and keeps the frame; the spring's ticks render nothing; open lands at scale 1", () => {
    overview(DRAGGING)
    mount(stateOf())
    overview({ progress: 0.32 })
    cardRenders.length = 0
    overview({ phase: 'settling' })
    // One render per card for the phase (the shape changed), the frame unchanged by it.
    expect(cardRenders.sort()).toEqual(['a', 'b', 'm1', 'm2'])
    expectFrame(CELLS.a, 0.32)
    cardRenders.length = 0
    overview({ progress: 0.5 })
    expectFrame(CELLS.a, 0.5)
    overview({ progress: 0.75 })
    expectFrame(CELLS.a, 0.75)
    overview({ progress: 0.99 })
    expectFrame(CELLS.a, 0.99)
    expect(cardRenders).toEqual([])
    overview({ phase: 'open', progress: 1 })
    expect(hero()).toBeNull()
    expect(scaleOf(rootEl())).toBe(1)
    expect(cardOf('a').style.opacity).toBe('')
  })

  it("the hero's group folding re-targets the writer to the group's card, with the late fade into it", () => {
    overview({ ...DRAGGING, heroTabId: 'm1', progress: 0.4 })
    mount(stateOf(false))
    expectFrame(CELLS.m1, 0.4)
    expect(hero()!.style.opacity).toBe('1')
    // The group folds (a state render): the writer reads the render's cell, the group's card.
    mount(stateOf(true))
    expectFrame(CELLS[`group:${GROUP}`], 0.4)
    expect(Number(hero()!.style.opacity)).toBe(1)
    // The frames after it: the fade begins at .55 of the travel, and nothing renders.
    cardRenders.length = 0
    overview({ progress: 0.7 })
    expectFrame(CELLS[`group:${GROUP}`], 0.7)
    expect(Number(hero()!.style.opacity)).toBeCloseTo(1 - (0.7 - 0.55) / 0.45, 6)
    overview({ progress: 0.9 })
    expect(Number(hero()!.style.opacity)).toBeCloseTo(1 - (0.9 - 0.55) / 0.45, 6)
    expect(cardRenders).toEqual([])
  })

  it("the hero's picture is drawn again only at a frame where a pixel size of the placeholder changes", () => {
    overview(DRAGGING)
    mount(stateOf())
    pictures.length = 0
    cardRenders.length = 0
    // The scale is 1 − .2p; these frames round to the same three sizes as .3 does: no draw.
    for (const p of [0.31, 0.32, 0.33]) {
      expect(placeholderPx(1 - 0.2 * p)).toEqual(placeholderPx(1 - 0.2 * 0.3))
      overview({ progress: p })
    }
    expect(heroPictures()).toEqual([])
    // The favicon's size drops a pixel at .4: one draw, at that frame's scale.
    expect(placeholderPx(1 - 0.2 * 0.4)).not.toEqual(placeholderPx(1 - 0.2 * 0.3))
    overview({ progress: 0.4 })
    expect(heroPictures()).toEqual([1 - 0.2 * 0.4])
    // The same three sizes again at .45: nothing.
    expect(placeholderPx(1 - 0.2 * 0.45)).toEqual(placeholderPx(1 - 0.2 * 0.4))
    overview({ progress: 0.45 })
    expect(heroPictures()).toEqual([1 - 0.2 * 0.4])
    // The picture's draw is its own render, not the grid's: no card rendered for any of it.
    expect(cardRenders).toEqual([])
  })
})

// --- the select-tabs mode under the spring -----------------------------------------------------

/** The async work between one step and the next: the list read, a command's answer, a commit. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}
/** Run the springs out: a sheet lands, a picked row's action runs. */
async function land(): Promise<void> {
  await act(async () => {
    run(150)
  })
  await settle()
}
const byLabel = (label: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
const checkboxes = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-cell] > [role="checkbox"]')].map((el) =>
    el.closest('[data-cell]')!.getAttribute('data-cell')!
  )

describe('the select-tabs mode under the spring', () => {
  it("entered while the overview settles open, the mode stays through the spring's frames and its landing", async () => {
    overview({ phase: 'settling', progress: 0.9, heroTabId: 'a', target: 1 })
    mount(stateOf(), true)
    // The header's menu, then its first row: the cards are checkboxes, the header is Done's.
    act(() => byLabel('More')!.click())
    await settle()
    await land()
    const row = [...document.querySelectorAll<HTMLElement>('button')].find(
      (b) => b.textContent?.trim() === 'Select Tabs'
    )
    expect(row).toBeDefined()
    act(() => row!.click())
    await land()
    expect(checkboxes().sort()).toEqual(['a', 'b', 'm1', 'm2'])
    expect(byLabel('Done')).not.toBeNull()
    // The spring's frames: the hero moves, no card renders, the mode is where it was.
    cardRenders.length = 0
    overview({ progress: 0.95 })
    expectFrame(CELLS.a, 0.95)
    overview({ progress: 0.99 })
    expect(cardRenders).toEqual([])
    expect(checkboxes().sort()).toEqual(['a', 'b', 'm1', 'm2'])
    expect(byLabel('Done')).not.toBeNull()
    // The landing (a phase render): the grid it was entered on is the same grid, the mode stays.
    overview({ phase: 'open', progress: 1 })
    expect(hero()).toBeNull()
    expect(checkboxes().sort()).toEqual(['a', 'b', 'm1', 'm2'])
    expect(byLabel('Done')).not.toBeNull()
  })
})
