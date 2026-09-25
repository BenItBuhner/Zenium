// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { OverviewState } from '@renderer/lib/gestures/stage'

/*
 * The overview grid's window (W6-0, PERF-5 item (e)), rendered for real through `TabOverview`
 * in happy-dom with a layout of the test's own: rows of two cards, 260 tall at a 272 pitch, in
 * a grid 800 tall. At the mount every tab has its cell (`[data-tab-id]`, the drivers' count),
 * but only the cells in view and one row's margin are CARDS (`.zen-overview-card`, named for
 * TalkBack with the pane's whole count); the rest are placeholders – the frame, `aria-hidden`,
 * no role, no name – until a scroll brings them within the window or, once the overview has
 * settled, the idle fill builds them nearest first under its budget. The hero's card is built
 * from the first frame wherever it stands; a folded group's members are not built at the
 * commit; a query re-windows the cards it leaves; a cell never goes back to a placeholder; and
 * a card built in the window is, byte for byte, the card main's grid built for every tab. The
 * window is one grid's, by token: a grid mounted in the commit that unmounts another (the shell
 * swap) keeps what it builds; the guess is the store's from the render it is made in; a fold is
 * read where the cells will rest, and re-read when the tracker releases.
 */

const SPACE = 'space'
/**
 * A phone 426 wide: two columns of 195 (the grid's 12 gutters and gap taken out), so a 3 / 4
 * card is 260 tall and a row's pitch 272 – the mount's guess (`overviewRowPitch`) and the
 * layout below agree on the rows, and the guess is the measured window at the grid's top.
 */
const AREA = { x: 0, y: 0, width: 426, height: 800 }
const CARD_H = 260
const PITCH = 272
const GRID_H = 800

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) =>
  name === 'session.recentlyClosed' ? [] : null
)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { TabOverview } = await import('../TabOverview')
const { OverviewCard } = await import('../OverviewCard')
const { cancelLift } = await import('../useCardLift')
const { clearDepartures } = await import('../departureStore')
const { layoutAnimations } = await import('@renderer/lib/motion/flip')
const { FrameDialogHost } = await import('@renderer/lib/portals')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { stageStore } = await import('@renderer/lib/gestures/stage')
const { resetOverviewUi, setOverviewSearch } = await import('@renderer/lib/overviewUi')
const { liftStore } = await import('../useCardLift')
const {
  NO_GRID,
  OverviewWindowContext,
  claimOverviewWindow,
  fillCards,
  overviewWindowStore,
  pendingFill,
  resetOverviewWindow,
  useCardFilled
} = await import('@renderer/lib/overviewWindow')

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

/** Thirty loose pages `t0`…`t29`, the last ten titled `zz<n>` for a query to keep. */
const thirty = (): Tab[] =>
  Array.from({ length: 30 }, (_, i) => tab(`t${i}`, { title: i >= 20 ? `zz${i}` : `t${i}` }))

function stateOf(tabs: Tab[], active = tabs[0]!.id, folders: Folder[] = []): UIState {
  const space: Space = {
    id: SPACE,
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId: active,
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

const OPEN: OverviewState = { phase: 'open', progress: 1, heroTabId: null, target: 1 }
const PULL = (hero: string): OverviewState => ({
  phase: 'dragging',
  progress: 0.3,
  heroTabId: hero,
  target: 1
})

// --- a layout ----------------------------------------------------------------------------------

/**
 * happy-dom lays nothing out: the grid answers a box 800 tall, and every `[data-cell]` under it
 * a row-of-two slot by its order in the grid, less the grid's `scrollTop`. Cells inside a
 * group's card take slots of their own in the same run (the group's shell takes none).
 */
const measured = HTMLElement.prototype.getBoundingClientRect
/** Where the cells' rows start, from the grid's top: a test moves them out of the view. */
let layoutOffset = 0
/** How often the grid's own box was read: the window's read of the layout starts with it. */
let gridReads = 0
function installLayout(): void {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    if (this.classList.contains('zen-overview-grid')) {
      gridReads++
      return new DOMRect(0, 0, AREA.width, GRID_H)
    }
    const grid = this.closest<HTMLElement>('.zen-overview-grid')
    if (!grid || !this.hasAttribute('data-cell')) return measured.call(this)
    if (!this.hasAttribute('data-tab-id') && this.classList.contains('zen-group'))
      return new DOMRect(0, layoutOffset - PITCH - grid.scrollTop, AREA.width, 40)
    const cells = [...grid.querySelectorAll<HTMLElement>('[data-cell][data-tab-id]')]
    // The New Tab card (the one cell without a tab id) is the grid's last.
    const i = this.hasAttribute('data-tab-id') ? cells.indexOf(this) : cells.length
    const y = layoutOffset + Math.floor(i / 2) * PITCH - grid.scrollTop
    return new DOMRect((i % 2) * 200, y, 200, CARD_H)
  }
}

// --- a clock -----------------------------------------------------------------------------------

/** The idle callbacks asked for, run by hand with a deadline; the clock moves 2 ms a read. */
const idle = new Map<number, (d: IdleDeadline) => void>()
let seq = 0
let clock = 0
const deadline = (remaining = 50): IdleDeadline => ({
  didTimeout: false,
  timeRemaining: () => remaining
})
function runIdle(remaining = 50): void {
  const [id, cb] = [...idle.entries()][0] ?? []
  if (!cb) throw new Error('no idle callback asked for')
  idle.delete(id!)
  act(() => cb(deadline(remaining)))
}
function runIdleAll(): void {
  let guard = 0
  while (idle.size > 0 && guard++ < 100) runIdle()
}

// --- rendering ---------------------------------------------------------------------------------

let root: Root | null = null
let host: HTMLElement | null = null
let sizes: Array<[string, PropertyDescriptor | undefined]> = []

function render(state: UIState, overview: OverviewState, key?: string): HTMLElement {
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  act(() =>
    root!.render(
      createElement(
        FrameDialogHost,
        null,
        // Keyed, a wrapper makes one grid mount while the other unmounts in the same commit –
        // the shell swap's shape (`App.tsx`, TABLET-08).
        key === undefined
          ? createElement(TabOverview, { state, overview, area: AREA, edge: 'bottom' })
          : createElement(
              'div',
              { key },
              createElement(TabOverview, { state, overview, area: AREA, edge: 'bottom' })
            )
      )
    )
  )
  return host!
}
function show(state: UIState, overview: OverviewState = OPEN): HTMLElement {
  act(() => browserStore.set({ state }))
  return render(state, overview)
}

const grid = (): HTMLElement => host!.querySelector<HTMLElement>('.zen-overview-grid')!
const cells = (): HTMLElement[] => [...host!.querySelectorAll<HTMLElement>('[data-tab-id]')]
const cardIds = (): string[] =>
  [...host!.querySelectorAll<HTMLElement>('[data-tab-id] > .zen-overview-card')].map(
    (el) => el.parentElement!.dataset.tabId!
  )
const placeholderIds = (): string[] =>
  [...host!.querySelectorAll<HTMLElement>('[data-tab-id] > .zen-overview-card-placeholder')].map(
    (el) => el.parentElement!.dataset.tabId!
  )
const ids = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `t${from + i}`)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  installLayout()
  layoutOffset = 0
  gridReads = 0
  idle.clear()
  clock = 0
  vi.stubGlobal('requestIdleCallback', (cb: (d: IdleDeadline) => void) => {
    idle.set(++seq, cb)
    return seq
  })
  vi.stubGlobal('cancelIdleCallback', (id: number) => {
    idle.delete(id)
  })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  vi.spyOn(performance, 'now').mockImplementation(() => (clock += 2))
  // The viewport store re-reads the window on every state change: size the window itself.
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: AREA.width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: AREA.height })
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone', width: AREA.width })
  uiStore.set({ insets: { ...uiStore.get().insets, left: 0, right: 0 } })
  sizes = ['clientHeight', 'offsetHeight'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  ])
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => GRID_H
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 300
  })
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
  // The grid's unmount resets the window; a test that rendered no grid leaves nothing behind.
  act(() => resetOverviewWindow())
  for (const [name, descriptor] of sizes) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
  HTMLElement.prototype.getBoundingClientRect = measured
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// --- the window --------------------------------------------------------------------------------

describe('the grid windowed at the mount', () => {
  it('builds every cell, and the cards in view plus one row; the rest are placeholders out of the tree', () => {
    show(stateOf(thirty()), PULL('t0'))
    // Every tab has its cell: the drivers' `[data-tab-id]` count is the pane's.
    expect(cells().map((c) => c.dataset.tabId)).toEqual(ids(0, 29))
    // Rows 0–2 in view (the third cut at 800), row 3 the margin: eight cards.
    expect(cardIds()).toEqual(ids(0, 7))
    expect(placeholderIds()).toEqual(ids(8, 29))
    // A placeholder: the frame alone – no role, no name, hidden from the tree.
    const ph = host!.querySelector<HTMLElement>('[data-tab-id="t20"] > *')!
    expect(ph.className).toBe('zen-overview-card-placeholder absolute inset-0')
    expect(ph.getAttribute('aria-hidden')).toBe('true')
    expect(ph.hasAttribute('role')).toBe(false)
    expect(ph.hasAttribute('aria-label')).toBe(false)
    expect(ph.children).toHaveLength(0)
    // The cell itself is the card's frame as ever: keyed, sized at the card's aspect.
    const cell = ph.parentElement!
    expect(cell.className).toBe('relative')
    expect(cell.style.aspectRatio).toBe('var(--zen-overview-card-aspect, 3 / 4)')
    expect(cell.dataset.cell).toBe('t20')
    // What a screen reader is told of a card is the pane's count, not the window's.
    expect(
      cardIds().map((id) =>
        host!
          .querySelector(`[data-tab-id="${id}"] > .zen-overview-card`)!
          .getAttribute('aria-label')
      )
    ).toEqual(ids(0, 7).map((id, i) => `${id}, tab ${i + 1} of 30${i === 0 ? ', current' : ''}`))
    // Short of the settle nothing is built in idle time: the pull's frames are the morph's.
    expect(idle.size).toBe(0)
    expect(pendingFill()).toBe(0)
    // The mount's guess is on record with what the layout read: a guessed card stays a card.
    expect([...overviewWindowStore.get().filled].sort()).toEqual(ids(0, 7).sort())
  })

  it("builds the mount's guess in the render itself, before any layout is read", () => {
    // A layout that puts every cell far below the view: the read finds nothing in view, and
    // what stands built is the guess alone – the rows the view holds from the top and one more,
    // the same eight cards, in one pass.
    layoutOffset = 5000
    show(stateOf(thirty()), PULL('t0'))
    expect(cardIds()).toEqual(ids(0, 7))
    expect(placeholderIds()).toEqual(ids(8, 29))
    expect([...overviewWindowStore.get().filled].sort()).toEqual(ids(0, 7).sort())
  })

  it('an eager cell is not re-rendered by a fill; a windowed one once, when its key fills', () => {
    const rendered = vi.fn<(eager: boolean) => void>()
    const renders = (): { eager: number; windowed: number } => ({
      eager: rendered.mock.calls.filter(([eager]) => eager).length,
      windowed: rendered.mock.calls.filter(([eager]) => !eager).length
    })
    const Probe = ({ eager }: { eager: boolean }): null => {
      rendered(eager)
      useCardFilled('x', eager)
      return null
    }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() =>
      root!.render(
        createElement(
          'div',
          null,
          createElement(Probe, { eager: true }),
          createElement(Probe, { eager: false })
        )
      )
    )
    expect(renders()).toEqual({ eager: 1, windowed: 1 })
    act(() => fillCards(['y']))
    expect(renders()).toEqual({ eager: 1, windowed: 1 })
    act(() => fillCards(['x']))
    expect(renders()).toEqual({ eager: 1, windowed: 2 })
    act(() => fillCards(['z']))
    expect(renders()).toEqual({ eager: 1, windowed: 2 })
  })

  it("builds the hero's card from the first frame wherever it stands, and the rows around it", () => {
    show(stateOf(thirty(), 't25'), PULL('t25'))
    // The mount's guess: the hero (t25, row 12) scrolls into view at the view's foot, so the
    // three rows ending at its row and a row's margin each side – rows 9–13, t18–t27 – are
    // built in the render itself. happy-dom scrolls nothing, so the layout read after it adds
    // the rows at the grid's top; a real grid reads the same rows the guess built.
    expect(cardIds()).toEqual([...ids(0, 7), ...ids(18, 27)])
    expect(placeholderIds()).toEqual([...ids(8, 17), 't28', 't29'])
  })

  it('once settled, fills the rest in idle time nearest first, under the budget, and never shrinks', () => {
    show(stateOf(thirty()), OPEN)
    expect(cardIds()).toEqual(ids(0, 7))
    expect(pendingFill()).toBe(22)
    expect(idle.size).toBe(1)
    // A callback builds what fits its budget (the clock here moves 2 ms a read, React's
    // scheduler reading it too), nearest first: row 4 before row 5, never a row out of turn.
    runIdle()
    const first = cardIds()
    expect(first.slice(0, 8)).toEqual(ids(0, 7))
    expect(first.length).toBeGreaterThan(8)
    expect(first.length).toBeLessThan(14)
    expect(first.slice(8)).toEqual(ids(8, first.length - 1))
    expect(idle.size).toBe(1)
    runIdle()
    const second = cardIds()
    expect(second.length).toBeGreaterThan(first.length)
    expect(second.slice(8)).toEqual(ids(8, second.length - 1))
    runIdleAll()
    expect(cardIds()).toEqual(ids(0, 29))
    expect(placeholderIds()).toEqual([])
    expect(pendingFill()).toBe(0)
    expect(idle.size).toBe(0)
  })

  it("the phases read no layout: the settle starts the idle fill from the mount's read, a close cancels it and unbuilds nothing", () => {
    const state = stateOf(thirty())
    show(state, PULL('t0'))
    expect(cardIds()).toEqual(ids(0, 7))
    expect(gridReads).toBe(1)
    expect(idle.size).toBe(0)
    // The spring carries the open the rest of the way: the morph's frames, no read, no fill.
    render(state, { phase: 'settling', progress: 0.7, heroTabId: 't0', target: 1 })
    expect(gridReads).toBe(1)
    expect(idle.size).toBe(0)
    // Settled: the rest fill in idle time, in the order the mount's read left – nothing re-read.
    render(state, { ...OPEN, heroTabId: 't0' })
    expect(gridReads).toBe(1)
    expect(idle.size).toBe(1)
    expect(pendingFill()).toBe(22)
    runIdle()
    const built = cardIds().length
    expect(built).toBeGreaterThan(8)
    // The pick: the overview closes – the fill is off – and the landing holds it mounted, its
    // hero at the page's frame: no read, and no card back to a placeholder.
    render(state, { phase: 'settling', progress: 0.9, heroTabId: 't0', target: 0 })
    expect(idle.size).toBe(0)
    expect(pendingFill()).toBe(0)
    render(state, { phase: 'closed', progress: 0, heroTabId: 't0', target: 0 })
    expect(gridReads).toBe(1)
    expect(cardIds().length).toBe(built)
    // The stage's reset of the overview's own state at the landing (`landOverview`) leaves the
    // window of a grid that still stands alone; the grid's unmount resets it.
    act(() => resetOverviewUi())
    expect(cardIds().length).toBe(built)
    expect(overviewWindowStore.get().filled.size).toBe(built)
    act(() => root?.unmount())
    expect(overviewWindowStore.get().filled.size).toBe(0)
  })

  it('a scroll brings the rows it shows and their margin into the window; the idle order follows', () => {
    show(stateOf(thirty()), OPEN)
    expect(cardIds()).toEqual(ids(0, 7))
    // Four rows down: rows 4–6 in view, 3 and 7 the margin.
    act(() => {
      grid().scrollTop = 4 * PITCH
      grid().dispatchEvent(new Event('scroll'))
    })
    expect(cardIds()).toEqual(ids(0, 15))
    expect(placeholderIds()).toEqual(ids(16, 29))
    // The next idle fill takes the nearest row past the margin: row 8, not row 0's neighbours.
    runIdle()
    const built = cardIds()
    expect(built.slice(0, 17)).toEqual(ids(0, 16))
    expect(built.slice(16)).toEqual(ids(16, built.length - 1))
  })

  it('a query re-windows the cards it leaves: the survivors moved into view are built', () => {
    show(stateOf(thirty()), OPEN)
    expect(cardIds()).toEqual(ids(0, 7))
    // "zz" keeps t20–t29, which now stand in rows 0–4: rows 0–3 are the window, built with
    // the commit; the fifth row waits for idle time.
    act(() => setOverviewSearch({ open: true, query: 'zz' }))
    expect(cells().map((c) => c.dataset.tabId)).toEqual(ids(20, 29))
    expect(cardIds()).toEqual(ids(20, 27))
    expect(placeholderIds()).toEqual(['t28', 't29'])
    runIdleAll()
    expect(cardIds()).toEqual(ids(20, 29))
    // The query cleared: the cards come back, the ones in view built, the rest as placeholders
    // (t0–t7 and t20–t29 were built before and stay built: the window never shrinks).
    act(() => setOverviewSearch({ open: false, query: '' }))
    expect(cardIds()).toEqual([...ids(0, 7), ...ids(20, 29)])
    expect(placeholderIds()).toEqual(ids(8, 19))
  })

  it('a folded group is one card: its members are not built at the commit, and are when it unfolds', () => {
    const folder: Folder = {
      id: 'g',
      spaceId: SPACE,
      name: 'Research',
      icon: '📚',
      collapsed: true,
      color: 'blue'
    }
    const members = ['g1', 'g2', 'g3', 'g4'].map((id) => tab(id, { folderId: 'g' }))
    const state = stateOf([...members, ...thirty()], 't0', [folder])
    show(state, PULL('t0'))
    // The group's cell stands above the loose cards; its members take the first slots of the
    // run and would be "in view" by their boxes – they are folded away, and stay placeholders.
    expect(placeholderIds().slice(0, 4)).toEqual(['g1', 'g2', 'g3', 'g4'])
    expect(cardIds()).not.toContain('g1')
    // Unfolded (still short of the settle): the members in view build with the commit.
    const unfolded = stateOf([...members, ...thirty()], 't0', [{ ...folder, collapsed: false }])
    show(unfolded, PULL('t0'))
    expect(cardIds().slice(0, 4)).toEqual(['g1', 'g2', 'g3', 'g4'])
  })

  it('a grid with no layout to read builds every card, as it always did', () => {
    HTMLElement.prototype.getBoundingClientRect = measured
    show(stateOf(thirty()), OPEN)
    expect(cardIds()).toEqual(ids(0, 29))
    expect(placeholderIds()).toEqual([])
    expect(overviewWindowStore.get().all).toBe(true)
  })
})

describe("the window through the grid's life", () => {
  it('a grid unmounted and another mounted in one commit: the new grid keeps what it built (the shell swap)', () => {
    // The first-line review's probe (TABLET-08): the new grid's layout effects – its claim,
    // its read – run before the old grid's cleanup; a plain reset from that cleanup wiped the
    // rows the new grid had built beyond its guess for a frame.
    const state = stateOf(thirty())
    act(() => browserStore.set({ state }))
    render(state, OPEN, 'A')
    expect(cardIds()).toEqual(ids(0, 7))
    const first = overviewWindowStore.get().owner
    expect(first).not.toBe(NO_GRID)
    act(() => {
      grid().scrollTop = 4 * PITCH
      grid().dispatchEvent(new Event('scroll'))
    })
    expect(cardIds()).toEqual(ids(0, 15))
    // The swap. The new grid restores the scroll (`noteOverviewScroll` took it) and reads its
    // window there: rows 3–7 in view and margin, t6–t15, built with the commit and standing
    // after the old grid's cleanup has run; the store is the new grid's.
    render(state, OPEN, 'B')
    expect(grid().scrollTop).toBe(4 * PITCH)
    expect(cardIds()).toEqual(expect.arrayContaining(ids(6, 15)))
    expect(overviewWindowStore.get().owner).not.toBe(first)
    expect(overviewWindowStore.get().owner).not.toBe(NO_GRID)
    expect([...overviewWindowStore.get().filled].sort()).toEqual(ids(0, 15).sort())
    // The idle fill is the new grid's: it goes on from its read.
    expect(idle.size).toBe(1)
    runIdleAll()
    expect(cardIds()).toEqual(ids(0, 29))
  })

  it("the new grid's first render builds its guess, not the old grid's cards: a filled old grid does not mount every card again", () => {
    const state = stateOf(thirty())
    act(() => browserStore.set({ state }))
    render(state, OPEN, 'A')
    runIdleAll()
    expect(cardIds()).toEqual(ids(0, 29))
    // The swap at the top: the new grid's window is the guess and the read, eight cards; the
    // twenty-two the old grid had built in idle time are placeholders again, to be built in
    // the new grid's idle time – not in its mount.
    render(state, OPEN, 'B')
    expect(cardIds()).toEqual(ids(0, 7))
    expect(placeholderIds()).toEqual(ids(8, 29))
    expect(pendingFill()).toBe(22)
  })

  it('the last grid to go releases the window: nothing built, no owner, no fill pending', () => {
    show(stateOf(thirty()), OPEN)
    expect(overviewWindowStore.get().owner).not.toBe(NO_GRID)
    expect(pendingFill()).toBe(22)
    act(() => root?.unmount())
    expect(overviewWindowStore.get()).toEqual({ owner: NO_GRID, all: false, filled: new Set() })
    expect(pendingFill()).toBe(0)
    expect(idle.size).toBe(0)
  })

  it('a card the guess builds mid-drag stays a card when the drag is cancelled: the store owns the guess', () => {
    show(stateOf(thirty()), OPEN)
    expect(cardIds()).toEqual(ids(0, 7))
    expect(gridReads).toBe(1)
    // t0's stand-in to the grid's end: t1–t8 move up a slot under the finger and t8 – row 3
    // now, the margin – is guessed in and built. The cards' key is the state's order, so no
    // window is read for the drag's render.
    act(() =>
      liftStore.set({ tabId: 't0', phase: 'dragging', slot: { folderId: null, index: 29 } })
    )
    expect(cardIds()).toContain('t8')
    expect(gridReads).toBe(1)
    // The drag cancelled: the order reverts, t8 is out of the guess – and stays a card.
    act(() => liftStore.set({ tabId: null, phase: 'idle', slot: null }))
    expect(cardIds()).toEqual(ids(0, 8))
    expect(placeholderIds()).toEqual(ids(9, 29))
    expect(overviewWindowStore.get().filled.has('t8')).toBe(true)
  })

  it("a fold is read where the cells will rest, and the window is re-read at the tracker's release", () => {
    const folder: Folder = {
      id: 'g',
      spaceId: SPACE,
      name: 'Research',
      icon: '📚',
      collapsed: false,
      color: 'blue'
    }
    const members = Array.from({ length: 8 }, (_, i) => tab(`g${i}`, { folderId: 'g' }))
    const gs = members.map((t) => t.id)
    const open = stateOf([...members, ...thirty()], 'g0', [folder])
    show(open, OPEN)
    // The group's eight cards take rows 0–3 (the view and the margin); the loose cards from
    // row 4 down are placeholders. Four rows down, rows 4–6 are the view and 3 and 7 the
    // margin: t0–t7 build (the group's last row, g6 and g7, stood built already).
    expect(cardIds()).toEqual(gs)
    act(() => {
      grid().scrollTop = 4 * PITCH
      grid().dispatchEvent(new Event('scroll'))
    })
    expect(cardIds()).toEqual([...gs, ...ids(0, 7)])
    const reads = gridReads
    // The fold. The group's card runs its height from the header plus its body (300, this
    // DOM's `offsetHeight`) to the header; the tracker holds the rows below where they are
    // drawn and knows where they will rest, 300 px up (`layoutRect`): row 8 – t8, t9 – is
    // drawn at 1088, past the margin's 1060, and rests at 788, in view. Read where it is
    // drawn the row would set off as placeholders and wait for the idle fill; read at rest it
    // is built with the fold's commit. (The fold's guess lays the rows from the grid's top –
    // the group's one cell and t0–t6 – and reaches none of this; the read does.)
    const folded = stateOf([...members, ...thirty()], 'g0', [{ ...folder, collapsed: true }])
    show(folded, OPEN)
    expect(gridReads).toBe(reads + 1)
    expect(layoutAnimations.any()).toBe(true)
    expect(cardIds()).toEqual([...gs, ...ids(0, 9)])
    expect(placeholderIds()).toEqual(ids(10, 29))
    // The height settles: the tracker releases its hold, measures afresh and the window is
    // re-read from the rest positions (this DOM's rows do not move; nothing shrinks).
    act(() => layoutAnimations.end('group:g'))
    expect(layoutAnimations.any()).toBe(false)
    expect(gridReads).toBe(reads + 2)
    expect(cardIds()).toEqual([...gs, ...ids(0, 9)])
  })

  it('a change of columns re-guesses the rows the view holds, and shrinks nothing', () => {
    show(stateOf(thirty()), OPEN)
    expect(cardIds()).toEqual(ids(0, 7))
    // Rotated to a width of four columns (`overviewColumns`): the guess lays the cards four
    // to a row at the wider pitch – three rows in view and one more, sixteen cards – and the
    // read on the new columns follows. This DOM's rows stay two wide, so what the read finds
    // in view is what it found before: the sixteen come from the guess, and the eight stand.
    act(() => viewportStore.set({ ...viewportStore.get(), width: 900 }))
    expect(cardIds()).toEqual(ids(0, 15))
    expect(placeholderIds()).toEqual(ids(16, 29))
    // Back to two columns: the eight-card guess is inside what is built; nothing shrinks.
    act(() => viewportStore.set({ ...viewportStore.get(), width: AREA.width }))
    expect(cardIds()).toEqual(ids(0, 15))
  })
})

// --- the card ----------------------------------------------------------------------------------

/**
 * The card main's grid built for every tab (`OverviewCard` at `9e2c8aff6`, rendered in
 * happy-dom with these very props), byte for byte: what a windowed cell must render once built.
 */
const MAIN_CARD =
  '<div class="relative" style="aspect-ratio: var(--zen-overview-card-aspect, 3 / 4);" data-tab-id="t1" data-cell="t1">' +
  '<div role="button" tabindex="0" class="zen-overview-card absolute inset-0 flex flex-col overflow-hidden" data-active="false" aria-label="The t1 story, tab 2 of 30">' +
  '<header class="zen-overview-card-header flex shrink-0 items-center gap-2 pl-3 pr-0">' +
  '<span class="zen-overview-card-favicon flex shrink-0">' +
  '<span class="zen-tab-favicon zen-squircle inline-flex shrink-0 items-center justify-center rounded-[5px] bg-[var(--zen-element-bg-active)] font-semibold leading-none" style="width: 16px; height: 16px; font-size: 9px;" aria-hidden="true">T</span>' +
  '</span>' +
  '<span class="zen-overview-card-title min-w-0 flex-1 truncate text-[13px] font-medium">The t1 story</span>' +
  '<span aria-hidden="true" class="zen-toolbar-button zen-overview-card-close-space h-8 w-8"></span>' +
  '</header><div class="zen-overview-card-preview relative min-h-0 flex-1 overflow-hidden">' +
  '<div class="zen-tab-placeholder flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">' +
  '<span class="zen-tab-favicon zen-squircle inline-flex shrink-0 items-center justify-center rounded-[5px] bg-[var(--zen-element-bg-active)] font-semibold leading-none" style="width: 29px; height: 29px; font-size: 16px;" aria-hidden="true">T</span>' +
  '<div class="flex min-w-0 max-w-full flex-col items-center gap-1">' +
  '<span class="max-w-full truncate font-semibold" style="font-size: 12px;">The t1 story</span>' +
  '<span class="max-w-full truncate text-[var(--zen-muted)]" style="font-size: 10px;">t1.example</span>' +
  '</div></div></div></div>' +
  '<button type="button" class="zen-toolbar-button zen-overview-card-close absolute right-0 top-0 h-8 w-8 rounded-[10px]" aria-label="Close The t1 story">' +
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x h-4 w-4" aria-hidden="true">' +
  '<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div>'

describe('a windowed cell, once built, is the card main built', () => {
  const props = (): Parameters<typeof OverviewCard>[0] => ({
    tab: tab('t1', { title: 'The t1 story', url: 'https://t1.example/story' }),
    position: 2,
    count: 30,
    active: false,
    hidden: false,
    onPick: () => undefined,
    onClose: () => undefined,
    lift: {
      enabled: true,
      swipeable: true,
      scroller: () => null,
      onMenu: () => undefined,
      onHover: () => null,
      onDrop: () => undefined
    }
  })
  /** A grid's token, as `TabOverview` provides over its cards. */
  const GRID = 7
  const mount = (windowed: boolean): string => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() =>
      root!.render(
        windowed
          ? createElement(
              OverviewWindowContext.Provider,
              { value: GRID },
              createElement(OverviewCard, props())
            )
          : createElement(OverviewCard, props())
      )
    )
    return host.innerHTML
  }

  it("outside a windowed grid the card is main's card", () => {
    expect(mount(false)).toBe(MAIN_CARD)
  })

  it("under the window the cell is a placeholder until filled, then main's card, byte for byte", () => {
    act(() => claimOverviewWindow(GRID))
    const before = mount(true)
    expect(before).toBe(
      '<div class="relative" style="aspect-ratio: var(--zen-overview-card-aspect, 3 / 4);" data-tab-id="t1" data-cell="t1">' +
        '<div class="zen-overview-card-placeholder absolute inset-0" aria-hidden="true"></div></div>'
    )
    const cell = host!.firstElementChild
    act(() => fillCards(['t1']))
    expect(host!.innerHTML).toBe(MAIN_CARD)
    // The same cell element through the fill: the FLIP set and the hero's measure hold it.
    expect(host!.firstElementChild).toBe(cell)
  })

  it("a fill under another grid's window is not this cell's: it reads the store under its own grid", () => {
    act(() => claimOverviewWindow(GRID + 1))
    mount(true)
    act(() => fillCards(['t1']))
    expect(placeholderIds()).toEqual(['t1'])
    act(() => claimOverviewWindow(GRID))
    act(() => fillCards(['t1']))
    expect(cardIds()).toEqual(['t1'])
  })
})
