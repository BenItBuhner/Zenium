// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode, act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { OverviewState } from '@renderer/lib/gestures/stage'
import {
  SPACE_FADE_MS,
  SPACE_SLIDE_ID,
  SPACE_SLIDE_MS,
  SPACE_SLIDE_PX
} from '@renderer/lib/motion/spaceSwitch'

/*
 * The Space switch in the tab overview (MOT-05, v2 §11.4 / §11.6), rendered for real through
 * `TabOverview` in happy-dom with the window suite's layout (rows of two, 272 pitch, a grid 800
 * tall) and a stand-in for the Web Animations API that records what is asked of it. Two Spaces
 * – Work, thirty tabs; Home, twelve – and the strip's chips laid out at boxes of the test's own.
 * The switch: a still of the grid that left fades 1 → 0 over 120 ms over its slot; the next
 * Space's grid comes up in a slot of its own and SLIDES in over 250 ms on the standard curve
 * from the side the Space stands on in the strip's order (+120 px forward, −120 back); its cards
 * in view and a row's margin are CARDS in that very commit and the rest placeholders (no
 * placeholder slides in); the window's store is the new grid's (its token, its cards alone); the
 * FLIP tracker measures the cells with the slot's transform held off and glides nothing from the
 * grid that left; the strip's indicator is drawn from the old chip's box towards the new one's;
 * the overview leaving mid-slide lands the grid first. Under reduced motion nothing travels –
 * the theme blend (`useTheme.ts`'s, pinned by the hook's own suite) stays, a colour blend being
 * a fade and not travel (§11.6 as amended).
 */

const WORK = 'work'
const HOME = 'home'
const AREA = { x: 0, y: 0, width: 426, height: 800 }
const CARD_H = 260
const PITCH = 272
const GRID_H = 800
/** The strip's chips: where each stands along the strip, and how wide. */
const CHIPS: Record<string, { left: number; width: number }> = {
  [WORK]: { left: 12, width: 80 },
  [HOME]: { left: 100, width: 120 }
}

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) =>
  name === 'session.recentlyClosed' ? [] : null
)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { TabOverview } = await import('../TabOverview')
const { cancelLift } = await import('../useCardLift')
const { clearDepartures } = await import('../departureStore')
const { layoutAnimations } = await import('@renderer/lib/motion/flip')
const { FrameDialogHost } = await import('@renderer/lib/portals')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { stageStore } = await import('@renderer/lib/gestures/stage')
const { resetOverviewUi } = await import('@renderer/lib/overviewUi')
const { overviewWindowStore, pendingFill, resetOverviewWindow } =
  await import('@renderer/lib/overviewWindow')

// --- a profile ---------------------------------------------------------------------------------

function tab(id: string, spaceId: string): Tab {
  return {
    id,
    spaceId,
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
    blockedCount: 0
  } as Tab
}

const work = (): Tab[] => Array.from({ length: 30 }, (_, i) => tab(`w${i}`, WORK))
const home = (): Tab[] => Array.from({ length: 12 }, (_, i) => tab(`h${i}`, HOME))
const ids = (prefix: string, from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`)

function space(id: string, name: string, tabs: Tab[]): Space {
  return {
    id,
    name,
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId: tabs[0]!.id,
    pinnedCollapsed: false
  }
}

/** Two Spaces in the strip's order, Work then Home; `active` the current one. */
function stateOf(active: string): UIState {
  const w = work()
  const h = home()
  return {
    platform: 'android',
    capabilities: { windowControls: false },
    tabs: Object.fromEntries([...w, ...h].map((t) => [t.id, t])),
    spaces: [space(WORK, 'Work', w), space(HOME, 'Home', h)],
    activeSpaceId: active,
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
    sync: { enabled: false, scope: { openTabs: false } }
  } as unknown as UIState
}

/** The same profile with a group in Work: `docs`, open, holding `w0` and `w1` at the head of its grid. */
function grouped(state: UIState): UIState {
  const docs: Folder = {
    id: 'docs',
    spaceId: WORK,
    name: 'Docs',
    icon: '',
    collapsed: false,
    color: 'blue'
  }
  const tabs = { ...state.tabs }
  for (const id of ['w0', 'w1']) tabs[id] = { ...tabs[id]!, folderId: docs.id }
  return { ...state, tabs, folders: { docs } }
}

const OPEN: OverviewState = { phase: 'open', progress: 1, heroTabId: null, target: 1 }
const CLOSING: OverviewState = { phase: 'settling', progress: 0.8, heroTabId: 'h0', target: 0 }

// --- a layout ----------------------------------------------------------------------------------

const measured = HTMLElement.prototype.getBoundingClientRect
/**
 * For every cell measured: whether the Space slot over it had its transform held at none (an
 * inline `!important`) at that moment – the FLIP tracker's read under the slide.
 */
let cellReads: Array<{ id: string; held: boolean; slot: HTMLElement | null }> = []
function installLayout(): void {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    // The Space slot and its grid fill the area under the strip: the box a still is taken in.
    if (
      this.classList.contains('zen-overview-space') ||
      this.classList.contains('zen-overview-grid')
    )
      return new DOMRect(0, 0, AREA.width, GRID_H)
    const grid = this.closest<HTMLElement>('.zen-overview-grid')
    if (!grid || !this.hasAttribute('data-cell')) return measured.call(this)
    const slot = this.closest<HTMLElement>('.zen-overview-space')
    cellReads.push({
      id: this.dataset.cell!,
      held:
        slot?.style.getPropertyValue('transform') === 'none' &&
        slot.style.getPropertyPriority('transform') === 'important',
      slot
    })
    const cells = [...grid.querySelectorAll<HTMLElement>('[data-cell][data-tab-id]')]
    const row = (cell: HTMLElement): number => Math.floor(cells.indexOf(cell) / 2)
    // A group's cell spans the rows of the cards it holds, the full width; one holding none
    // (shrinking to nothing) sits where the New Tab cell does, after the last card.
    const members = [...this.querySelectorAll<HTMLElement>('[data-cell][data-tab-id]')]
    if (this.classList.contains('zen-group') && members.length) {
      const first = row(members[0]!)
      const rows = row(members.at(-1)!) - first + 1
      return new DOMRect(0, first * PITCH - grid.scrollTop, AREA.width, rows * PITCH)
    }
    const i = this.hasAttribute('data-tab-id') ? cells.indexOf(this) : cells.length
    const y = Math.floor(i / 2) * PITCH - grid.scrollTop
    return new DOMRect((i % 2) * 200, y, 200, CARD_H)
  }
}

// --- the Web Animations stand-in ---------------------------------------------------------------

interface FakeAnimation {
  el: HTMLElement
  frames: Keyframe[]
  options: KeyframeAnimationOptions
  finished: Promise<void>
  onfinish: (() => void) | null
  finish: () => void
  cancel: () => void
  finishes: number
}
let animations: FakeAnimation[] = []
const hadAnimate = (HTMLElement.prototype as { animate?: unknown }).animate
function installAnimate(): void {
  ;(HTMLElement.prototype as { animate?: unknown }).animate = function (
    this: HTMLElement,
    frames: Keyframe[],
    options: KeyframeAnimationOptions
  ): FakeAnimation {
    const a: FakeAnimation = {
      el: this,
      frames,
      options,
      finished: Promise.resolve(),
      onfinish: null,
      finishes: 0,
      finish: () => {
        a.finishes++
        a.onfinish?.()
      },
      cancel: () => undefined
    }
    animations.push(a)
    return a
  }
}
const slides = (): FakeAnimation[] => animations.filter((a) => a.options.id === SPACE_SLIDE_ID)
const stillFades = (): FakeAnimation[] =>
  animations.filter((a) => a.el.dataset.testid === 'pane-still')

// --- rendering ---------------------------------------------------------------------------------

let root: Root | null = null
let host: HTMLElement | null = null
let sizes: Array<[string, PropertyDescriptor | undefined]> = []
let reduced = false

function render(state: UIState, overview: OverviewState = OPEN, strict = false): HTMLElement {
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  act(() => browserStore.set({ state }))
  const tree = createElement(
    FrameDialogHost,
    null,
    createElement(TabOverview, { state, overview, area: AREA, edge: 'bottom' })
  )
  // Under StrictMode React replays a new mount's effects (cleanup, then the effect again) after
  // the commit, the development check for effects that do not survive a replay.
  act(() => root!.render(strict ? createElement(StrictMode, null, tree) : tree))
  return host!
}

const grid = (): HTMLElement => host!.querySelector<HTMLElement>('.zen-overview-grid')!
const slot = (): HTMLElement => host!.querySelector<HTMLElement>('.zen-overview-space')!
const cardIds = (): string[] =>
  [...host!.querySelectorAll<HTMLElement>('[data-tab-id] > .zen-overview-card')].map(
    (el) => el.parentElement!.dataset.tabId!
  )
const placeholderIds = (): string[] =>
  [...host!.querySelectorAll<HTMLElement>('[data-tab-id] > .zen-overview-card-placeholder')].map(
    (el) => el.parentElement!.dataset.tabId!
  )
const stills = (): HTMLElement[] => [
  ...host!.querySelectorAll<HTMLElement>('[data-testid="pane-still"]')
]
const chip = (id: string): HTMLElement =>
  host!.querySelector<HTMLElement>(`.zen-overview-strip-chip[data-space-id="${id}"]`)!
const indicator = (): HTMLElement =>
  host!.querySelector<HTMLElement>('[data-testid="overview-strip-indicator"]')!
const newTabCell = (): HTMLElement => host!.querySelector<HTMLElement>('[data-cell="new-tab"]')!
/** The group cells of the live grid (never a still's). */
const groupCells = (): HTMLElement[] => [...grid().querySelectorAll<HTMLElement>('.zen-group')]

/** The idle callbacks asked for (the window suite's clock), run by hand until none is left. */
const idle = new Map<number, (d: IdleDeadline) => void>()
let idleSeq = 0
function runIdleAll(): void {
  let guard = 0
  while (idle.size > 0 && guard++ < 100) {
    const [id, cb] = [...idle.entries()][0]!
    idle.delete(id)
    act(() => cb({ didTimeout: false, timeRemaining: () => 50 }))
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  installLayout()
  installAnimate()
  animations = []
  cellReads = []
  reduced = false
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduced && query.includes('reduce'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }))
  idle.clear()
  vi.stubGlobal('requestIdleCallback', (cb: (d: IdleDeadline) => void) => {
    idle.set(++idleSeq, cb)
    return idleSeq
  })
  vi.stubGlobal('cancelIdleCallback', (id: number) => {
    idle.delete(id)
  })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: AREA.width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: AREA.height })
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone', width: AREA.width })
  uiStore.set({ insets: { ...uiStore.get().insets, left: 0, right: 0 } })
  sizes = ['clientHeight', 'offsetHeight', 'offsetLeft', 'offsetWidth', 'offsetTop'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  ])
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => GRID_H
  })
  // The chips' boxes along the strip; everything else 36 tall at the top.
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 36
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get: () => 2 })
  Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
    configurable: true,
    get(this: HTMLElement) {
      return CHIPS[this.dataset.spaceId ?? '']?.left ?? 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return CHIPS[this.dataset.spaceId ?? '']?.width ?? AREA.width
    }
  })
  HTMLElement.prototype.scrollIntoView = () => undefined
  uiStore.set({ toasts: [] })
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
  browserStore.set({ state: null })
  stageStore.set({
    ...stageStore.get(),
    overview: { phase: 'closed', progress: 0, heroTabId: null, target: 0 }
  })
  act(() => resetOverviewUi())
  act(() => resetOverviewWindow())
  for (const [name, descriptor] of sizes) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
  HTMLElement.prototype.getBoundingClientRect = measured
  ;(HTMLElement.prototype as { animate?: unknown }).animate = hadAnimate
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// --- the switch --------------------------------------------------------------------------------

describe('a Space switch in the overview', () => {
  it('a chip tap activates the Space', () => {
    render(stateOf(WORK))
    act(() => chip(HOME).click())
    expect(
      invoke.mock.calls.some(
        ([name, args]) =>
          name === 'space.activate' && (args as { spaceId: string }).spaceId === HOME
      )
    ).toBe(true)
  })

  it('the next grid slides in from the trailing side over 250 ms while a still of the last fades 120 ms; its cards are built before the slide draws them', () => {
    render(stateOf(WORK))
    expect(cardIds()).toEqual(ids('w', 0, 7))
    expect(slides()).toEqual([])
    const workOwner = overviewWindowStore.get().owner
    grid().scrollTop = 30
    animations = []
    cellReads = []

    render(stateOf(HOME))

    // The new Space's grid is up in the slot – its cells alone, the window's word from the
    // commit: the first three rows and the margin row as cards, the rest placeholders.
    expect(grid().dataset.pane).toBe('tabs')
    expect(grid().closest('.zen-overview-space')).toBe(slot())
    expect(cardIds()).toEqual(ids('h', 0, 7))
    expect(placeholderIds()).toEqual(ids('h', 8, 11))
    // The window is the new grid's: another owner, the guess recorded under it, none of Work's
    // cards in it, and the rest of Home's cards queued for idle time.
    const store = overviewWindowStore.get()
    expect(store.owner).not.toBe(workOwner)
    expect(store.all).toBe(false)
    expect([...store.filled].sort()).toEqual(expect.arrayContaining(ids('h', 0, 7)))
    expect([...store.filled].every((id) => id.startsWith('h'))).toBe(true)
    expect(pendingFill()).toBe(4)
    // Its slide: from +120 px (Home stands after Work in the strip) to rest, 250 ms on the
    // standard curve, the opacity solid by the slide's first half.
    const [slide] = slides()
    expect(slides()).toHaveLength(1)
    expect(slide.el).toBe(slot())
    expect(slide.options).toMatchObject({
      duration: SPACE_SLIDE_MS,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      id: SPACE_SLIDE_ID
    })
    expect(slide.frames[0]).toMatchObject({
      transform: `translate3d(${SPACE_SLIDE_PX}px, 0, 0)`,
      opacity: 0,
      offset: 0
    })
    expect(slide.frames.at(-1)).toMatchObject({ transform: 'translate3d(0, 0, 0)', opacity: 1 })
    // Over it, a still of Work's grid as it stood – scrolled where it was, out of reach, none
    // of its hooks left – fading 1 → 0 over the fade's 120 ms.
    const [still] = stills()
    expect(stills()).toHaveLength(1)
    expect(still.getAttribute('aria-hidden')).toBe('true')
    expect(still.hasAttribute('inert')).toBe(true)
    expect(still.querySelector<HTMLElement>('[data-pane="tabs"]')!.scrollTop).toBe(30)
    expect(still.textContent).toContain('w0')
    expect(still.querySelector('[data-cell], [data-testid], .zen-overview-grid')).toBeNull()
    const fades = stillFades()
    expect(fades.length).toBeGreaterThan(0)
    for (const fade of fades) {
      expect(fade.frames).toEqual([{ opacity: 1 }, { opacity: 0 }])
      expect(fade.options).toMatchObject({ duration: SPACE_FADE_MS, fill: 'forwards' })
    }
    expect(SPACE_FADE_MS).toBe(120)
    // The strip stays: it is the pane's, not the slot's.
    expect(host!.querySelectorAll('.zen-overview-strip')).toHaveLength(1)
    expect(still.querySelector('.zen-overview-strip')).toBeNull()
    // The slot's own transform is the animation's: nothing inline is left on it after the
    // tracker's measurement.
    expect(slot().style.getPropertyValue('transform')).toBe('')
  })

  it('the still copies the cards its box shows; the cells beyond the box are empty boxes at their laid-out heights, every row in its place', () => {
    render(stateOf(WORK))
    // Every card of Work built, as a grid at rest after its idle fill stands.
    runIdleAll()
    expect(cardIds()).toEqual(ids('w', 0, 29))
    grid().scrollTop = 30

    render(stateOf(HOME))

    const [still] = stills()
    const cells = [
      ...still.querySelector<HTMLElement>('[data-still-scroller]')!.firstElementChild!.children
    ] as HTMLElement[]
    // Thirty cards and the New Tab cell: the same count as the grid, the rows unchanged.
    expect(cells).toHaveLength(31)
    // Rows 0–3 (with the scroll of 30 px, the fourth row's top is inside the 800 px box): the
    // cards as they stood, thumbnails and titles.
    for (const [i, cell] of cells.slice(0, 8).entries()) {
      expect(cell.querySelector('.zen-overview-card')).not.toBeNull()
      expect(cell.textContent).toContain(`w${i}`)
      expect(cell.style.height).toBe('')
    }
    // Rows 4–15 lie below the box: each cell an empty box the height the card had.
    for (const cell of cells.slice(8)) {
      expect(cell.childElementCount).toBe(0)
      expect(cell.textContent).toBe('')
      expect(cell.style.height).toBe(`${CARD_H}px`)
    }
    // The still is drawn where the pane stood, scrolled where it was.
    expect(still.querySelector<HTMLElement>('[data-still-scroller]')!.scrollTop).toBe(30)
  })

  it('a group of the Space that left is simply not in the next grid: it neither lingers there as a group shrinking to nothing nor forms again when its Space is back', () => {
    render(grouped(stateOf(WORK)))
    // Work's grid: the Docs group's cell holding its two cards, the loose cards, the New Tab cell.
    expect(groupCells()).toHaveLength(1)
    expect(groupCells()[0]!.querySelectorAll('[data-tab-id]')).toHaveLength(2)
    expect(groupCells()[0]!.dataset.dissolving).toBeUndefined()
    expect(grid().querySelectorAll('[data-cell]')).toHaveLength(32)
    expect(cardIds()).toContain('w0')

    render(grouped(stateOf(HOME)))

    // Home's grid: its twelve cells and the New Tab cell, no group cell – Work's Docs group did
    // not lose its cards, Home never had it.
    expect(groupCells()).toEqual([])
    expect(grid().querySelectorAll('[data-cell]')).toHaveLength(13)
    expect(cardIds()).toEqual(ids('h', 0, 7))
    // The still over it shows Work as it stood, the group's header among it.
    expect(stills()[0]!.textContent).toContain('Docs')

    render(grouped(stateOf(WORK)))

    // Back in Work: the group holds its two cards as before, a card among cards – neither
    // dissolving nor forming (its header and tint drawn from the first frame).
    const [docs] = groupCells()
    expect(groupCells()).toHaveLength(1)
    expect(docs!.querySelectorAll('[data-tab-id]')).toHaveLength(2)
    expect(docs!.dataset.dissolving).toBeUndefined()
    expect(docs!.dataset.chrome).toBeUndefined()
    expect(grid().querySelectorAll('[data-cell]')).toHaveLength(32)
  })

  it("the new grid's edge fades attach once the commit that mounts it is over, not inside it", async () => {
    render(stateOf(WORK))
    render(stateOf(HOME))
    // Nothing measured the scroller in the commit: the fade's variables are not on it yet.
    expect(grid().dataset.fadeAxis).toBeUndefined()
    expect(grid().style.getPropertyValue('--zen-fade-end')).toBe('')
    await Promise.resolve()
    expect(grid().dataset.fadeAxis).toBe('y')
    expect(grid().style.getPropertyValue('--zen-fade-end')).toBe('0px')
  })

  it('the grid and the strip attach their edge fades once for their life, not again on each render of the overview; a switch attaches the new grid alone', async () => {
    // Every measurement `attachFadeEdges` makes writes `--zen-fade-end` (nothing else does): one
    // at each attach – a read of the scroller's size and scroll, a forced layout – and one per
    // frame after a scroll or a mutation (no frame runs here: the frame is stubbed).
    const original = CSSStyleDeclaration.prototype.setProperty
    let measured = 0
    vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty').mockImplementation(function (
      this: CSSStyleDeclaration,
      name: string,
      value: string | null,
      priority?: string
    ) {
      if (name === '--zen-fade-end') measured++
      return original.call(this, name, value, priority)
    })
    render(stateOf(WORK))
    await Promise.resolve()
    // The strip's and the grid's: once each.
    expect(measured).toBe(2)
    // The overview rendered again with the same Space – the state set anew, its props the same
    // values: nothing measured again.
    render(stateOf(WORK))
    render(stateOf(WORK))
    await Promise.resolve()
    expect(measured).toBe(2)
    // A switch: the next Space's grid is a new element and measures once; the strip stays as it is.
    render(stateOf(HOME))
    await Promise.resolve()
    expect(measured).toBe(3)
    render(stateOf(HOME))
    await Promise.resolve()
    expect(measured).toBe(3)
  })

  it('the next grid fills the rest of its cards in idle time after the switch, as a mounting grid does', () => {
    render(stateOf(WORK))
    runIdleAll()
    expect(cardIds()).toEqual(ids('w', 0, 29))
    expect(overviewWindowStore.get().filled.size).toBe(30)

    render(stateOf(HOME))

    // Work's thirty built cards do not carry over; Home's guess is in the store, the rest queued.
    expect(cardIds()).toEqual(ids('h', 0, 7))
    expect(placeholderIds()).toEqual(ids('h', 8, 11))
    expect(overviewWindowStore.get().filled.size).toBe(8)
    expect(pendingFill()).toBe(4)
    runIdleAll()
    expect(cardIds()).toEqual(ids('h', 0, 11))
    expect(placeholderIds()).toEqual([])
    expect(pendingFill()).toBe(0)
  })

  it("keeps the window through StrictMode's replayed effects: the claim, the guess and the read are one component's, in that order", () => {
    // A claim in a child component of its own ran before the reads by React's child-first order
    // and, replayed as a new mount's effect after the commit, wiped the window the reads had
    // built – the incoming grid's placeholders never filled (the host screencast's finding).
    render(stateOf(WORK), OPEN, true)
    expect(cardIds()).toEqual(ids('w', 0, 7))
    expect(overviewWindowStore.get().filled.size).toBe(8)
    expect(pendingFill()).toBe(22)
    runIdleAll()
    expect(cardIds()).toEqual(ids('w', 0, 29))

    render(stateOf(HOME), OPEN, true)

    const store = overviewWindowStore.get()
    expect(cardIds()).toEqual(ids('h', 0, 7))
    expect([...store.filled].sort()).toEqual(ids('h', 0, 7).sort())
    expect(store.all).toBe(false)
    expect(pendingFill()).toBe(4)
    runIdleAll()
    expect(cardIds()).toEqual(ids('h', 0, 11))
    expect(placeholderIds()).toEqual([])
  })

  it('slides in from the leading side going back in the strip order', () => {
    render(stateOf(HOME))
    animations = []
    render(stateOf(WORK))
    const [slide] = slides()
    expect(slide.frames[0]).toMatchObject({ transform: `translate3d(-${SPACE_SLIDE_PX}px, 0, 0)` })
    expect(cardIds()).toEqual(ids('w', 0, 7))
    expect(placeholderIds()).toEqual(ids('w', 8, 29))
  })

  it('the FLIP tracker measures the new grid with the slot held at rest, and glides nothing from the grid that left', () => {
    render(stateOf(WORK))
    // Work's New Tab card is the thirty-first cell, row 15; Home's the thirteenth, row 6: the
    // one key both grids hold changes rows.
    expect(newTabCell().style.transform).toBe('')
    cellReads = []
    render(stateOf(HOME))
    // Every cell of the new grid was read with the slot's transform held off. (The grid that
    // left is read too, for its still – in its own slot, before the new one is up.)
    const reads = cellReads.filter((r) => r.slot === slot())
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every((r) => r.id.startsWith('h') || r.id === 'new-tab')).toBe(true)
    expect(reads.every((r) => r.held)).toBe(true)
    // And no glide: the New Tab card stands at its slot, no transform written for a travel
    // from Work's grid.
    expect(newTabCell().style.transform).toBe('')
  })

  it('the overview leaving mid-slide lands the grid first', () => {
    render(stateOf(WORK))
    render(stateOf(HOME))
    const [slide] = slides()
    expect(slide.finishes).toBe(0)
    render(stateOf(HOME), CLOSING)
    expect(slide.finishes).toBe(1)
  })

  it('a second Space picked mid-slide finishes the first slide, starts its own, and its still carries the entrance opacity', () => {
    render(stateOf(WORK))
    render(stateOf(HOME))
    const [first] = slides()
    // Home's grid stands mid-entrance, faint: the slide's opacity as the compositor computes it
    // – an animation's, which no copy of the DOM carries (an inline style would be cloned with
    // the node; the slot's says nothing) – so the still written from it would jump to solid
    // before its fade unless `takeStill` writes the computed opacity onto the copy.
    const faint = slot()
    expect(faint.style.opacity).toBe('')
    const view = document.defaultView!
    const computed = view.getComputedStyle.bind(view)
    vi.spyOn(view, 'getComputedStyle').mockImplementation((el, pseudo) => {
      const style = computed(el, pseudo)
      return el === faint
        ? new Proxy(style, { get: (t, p) => (p === 'opacity' ? '0.4' : Reflect.get(t, p, t)) })
        : style
    })
    render(stateOf(WORK))
    expect(first.finishes).toBe(1)
    expect(slides()).toHaveLength(2)
    expect(slides()[1].frames[0]).toMatchObject({
      transform: `translate3d(-${SPACE_SLIDE_PX}px, 0, 0)`
    })
    // Two stills up: Work's grid from the first switch (taken solid – no opacity written) and
    // Home's from the second, as faint as it stood.
    const [workStill, homeStill] = stills()
    expect(stills()).toHaveLength(2)
    expect((workStill.firstElementChild as HTMLElement).style.opacity).toBe('')
    expect((homeStill.firstElementChild as HTMLElement).style.opacity).toBe('0.4')
    // The still's own fade runs 1 → 0 over the wrapper as ever: the copy's opacity multiplies
    // it, so the fade starts from 0.4 and not from a jump to solid.
    expect(stillFades()).toHaveLength(2)
    expect(stillFades()[1].frames).toEqual([{ opacity: 1 }, { opacity: 0 }])
  })
})

describe('the strip indicator', () => {
  it('rests on the current chip at the mount, and is drawn from the old chip towards the new one at the switch', () => {
    render(stateOf(WORK))
    const ind = indicator()
    expect(ind.getAttribute('aria-hidden')).toBe('true')
    expect([ind.style.left, ind.style.width, ind.style.top, ind.style.height]).toEqual([
      '12px',
      '80px',
      '2px',
      '36px'
    ])
    expect(ind.style.transform).toBe('translate3d(0px, 0, 0) scaleX(1)')
    // The current chip draws no fill of its own; the other its element fill.
    expect(chip(WORK).className).not.toContain('bg-[var(--zen-element-bg)]')
    expect(chip(HOME).className).toContain('bg-[var(--zen-element-bg)]')
    expect(chip(WORK).getAttribute('aria-current')).toBe('true')

    render(stateOf(HOME))
    // Laid out at Home's box, drawn at Work's on the spring's first frame: 88 px back, at
    // 80 / 120 of the width, the ends' radius held round under the scale.
    expect([ind.style.left, ind.style.width]).toEqual(['100px', '120px'])
    expect(ind.style.transform).toBe(`translate3d(-88px, 0, 0) scaleX(${80 / 120})`)
    expect(ind.style.getPropertyValue('--zen-strip-indicator-scale')).toBe(String(80 / 120))
    expect(chip(HOME).getAttribute('aria-current')).toBe('true')
    expect(chip(WORK).hasAttribute('aria-current')).toBe(false)
  })

  it('jumps under reduced motion', () => {
    reduced = true
    render(stateOf(WORK))
    render(stateOf(HOME))
    const ind = indicator()
    expect([ind.style.left, ind.style.width]).toEqual(['100px', '120px'])
    expect(ind.style.transform).toBe('translate3d(0px, 0, 0) scaleX(1)')
    expect(ind.style.getPropertyValue('--zen-strip-indicator-scale')).toBe('')
  })
})

describe('under reduced motion', () => {
  it('nothing travels: the next grid fades in place over 120 ms, the still fades the same, the slot is never held', () => {
    reduced = true
    render(stateOf(WORK))
    animations = []
    cellReads = []
    render(stateOf(HOME))
    const [slide] = slides()
    expect(slides()).toHaveLength(1)
    expect(slide.frames).toEqual([{ opacity: 0 }, { opacity: 1 }])
    expect(slide.options).toMatchObject({ duration: 120 })
    expect(stillFades().length).toBeGreaterThan(0)
    for (const fade of stillFades()) expect(fade.options).toMatchObject({ duration: 120 })
    expect(cellReads.some((r) => r.held)).toBe(false)
    expect(cardIds()).toEqual(ids('h', 0, 7))
  })
})

describe('the stylesheet', () => {
  const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')
  const rule = (selector: string): string => {
    const m = new RegExp(`${selector.replace(/[.[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)
    if (!m) throw new Error(`no rule for ${selector}`)
    return m[1]!.replace(/\s+/g, ' ').trim()
  }

  it('the indicator is the accent tint scaled from its leading edge; the chips fills are 120 ms state changes', () => {
    const ind = rule('.zen-overview-strip-indicator')
    expect(ind).toContain('background: rgb(var(--zen-accent-rgb) / 0.16)')
    expect(ind).toContain('transform-origin: left center')
    expect(ind).toContain('border-radius: calc(18px / var(--zen-strip-indicator-scale, 1)) / 18px')
    expect(ind).not.toMatch(/transition/)
    expect(rule('.zen-overview-strip-chip')).toContain(
      'transition: background-color 120ms var(--zen-ease)'
    )
  })

  it('the Space slot has no entrance of its own in the sheet: the slide is the Web Animations one', () => {
    expect(css).not.toMatch(/\.zen-overview-space\s*\{/)
  })
})
