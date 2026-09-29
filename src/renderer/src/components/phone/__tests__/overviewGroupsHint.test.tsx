// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Tab, UIState } from '@shared/types'
import type { OverviewState } from '@renderer/lib/gestures/stage'

/*
 * The overview's drag-to-group in-product help (TB-19, useOverviewGroupsHint.ts): Chrome 152's
 * `IPH_TabGroupsDragAndDrop` dialog, opened by the tab-groups tip's "Try it now"
 * (`ChromeTabbedActivity.java` l.3500–3508), as a §9.33 bubble on a card of the overview the
 * tip opened. Driven in happy-dom with the grid's view and its cells stood in: the request the
 * tips card leaves, the opening overview's from its mount (StrictMode's rehearsal included) and
 * dropped with one that never rests – closed, or unmounted, on its way; the bubble up once, on
 * the card, spent as it goes up – once per device, and not gated by the
 * session's one education, since Chrome's tip path runs no tracker – and every way it comes
 * down: a touch anywhere, the first drag, the overview leaving its rest, a resize, the unmount.
 * Which card (the design lead's fold on #701): the loose page card in view nearest the active
 * card – before it in grid order, else after – the active card itself only when no other page
 * card is in view, never the new tab page's.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Object.assign(window, { zen: { invoke: vi.fn(async () => null), on: () => () => undefined } })

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { run } = await import('@renderer/lib/api')
const { cellInView, overviewHintCandidates, useOverviewGroupsHint } =
  await import('../useOverviewGroupsHint')
const { useTabSwitcherHint } = await import('../useTabSwitcherHint')
const { liftStore } = await import('../useCardLift')
const { OverviewCard } = await import('../OverviewCard')
const {
  forgetHintBubble,
  HINT_BUBBLE_EXIT_MS,
  HINT_BUBBLE_ID,
  hintBubbleStore,
  iphSessionSpent,
  requestOverviewGroupsHint,
  resetIphSession,
  showHintBubble,
  spendIphSession,
  TAB_GROUPS_DRAG_HINT_TEXT,
  takeOverviewGroupsHintRequest
} = await import('@renderer/lib/iph')

const NOW = 1_800_000_000_000
type Box = { x: number; y: number; width: number; height: number }
/** The grid's view: the scroller's box, where the hook reads which cells are in view. */
const VIEW = { top: 120, bottom: 900 }
const ANCHOR: Box = { x: 16, y: 120, width: 160, height: 213 }
const rectOf = (b: Box): DOMRect =>
  ({ ...b, left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height }) as DOMRect
/** A two-column grid's cell: the columns at 16 and 196, the rows 225 apart from the view's top. */
const cellAt = (col: 0 | 1, row: number): Box => ({
  x: col === 0 ? 16 : 196,
  y: VIEW.top + row * 225,
  width: 160,
  height: 213
})
const card = (id: string, page = true): { id: string; page: boolean } => ({ id, page })

function stateOf(shown = false): UIState {
  return {
    activeSpaceId: 's1',
    spaces: [{ id: 's1', activeTabId: 't1', containerId: 'default' }],
    tabs: {},
    essentialTabIds: [],
    settings: {
      onboardingDone: true,
      iph: {
        tabSwitcher: { availableAt: null, shown: false },
        tabGroupsDragAndDrop: { availableAt: null, shown }
      }
    }
  } as unknown as UIState
}

const OPEN: OverviewState = { phase: 'open', progress: 1, heroTabId: 't1', target: 1 }
const SETTLING: OverviewState = { phase: 'settling', progress: 0.8, heroTabId: 't1', target: 1 }
/** The predictive back's drag, or the swipe that closes the overview: on its way out. */
const LEAVING: OverviewState = { phase: 'dragging', progress: 0.9, heroTabId: 't1', target: 0 }
const CLOSED: OverviewState = { phase: 'closed', progress: 0, heroTabId: null, target: 0 }

const gridRef = { current: null as HTMLDivElement | null }

const T1 = ['t1']

function Hint({
  state,
  overview,
  candidates = T1
}: {
  state: UIState
  overview: OverviewState
  candidates?: readonly string[]
}): null {
  useOverviewGroupsHint({ state, overview, candidates, grid: gridRef })
  return null
}

/**
 * The phone shell's arrangement: the Tabs button's hook (`PhoneShell`) and the overview's, on
 * the one bubble store, the chrome not calm because the overview is open (`PhoneShell`'s `calm`).
 */
function Shell({ state, overview }: { state: UIState; overview: OverviewState }): null {
  useTabSwitcherHint(state, 'bottom', false)
  useOverviewGroupsHint({ state, overview, candidates: T1, grid: gridRef })
  return null
}

let root: Root | null = null
let host: HTMLDivElement | null = null
let grid: HTMLDivElement | null = null

const render = (state: UIState, overview: OverviewState, candidates?: readonly string[]): void => {
  act(() => root!.render(createElement(Hint, { state, overview, candidates })))
}
/** As a dev build mounts it (`src/android/main.tsx`): under StrictMode, the mount rehearsed. */
const renderStrict = (state: UIState, overview: OverviewState): void => {
  act(() => root!.render(createElement(StrictMode, null, createElement(Hint, { state, overview }))))
}
const wait = (ms: number): void => {
  act(() => vi.advanceTimersByTime(ms))
}
const bubble = (): ReturnType<typeof hintBubbleStore.get> => hintBubbleStore.get()
const updates = (): unknown[] =>
  vi
    .mocked(run)
    .mock.calls.filter((c) => c[0] === 'settings.update')
    .map((c) => c[1])

/**
 * The grid's scroller with cells stood in, where the hook reads the view's box and the cards':
 * each cell its tab id and its box – t1 at the anchor's, by default; none for a grid that has
 * built no card.
 */
function standGrid(cells: Record<string, Box> = { t1: ANCHOR }, view = VIEW): void {
  grid?.remove()
  grid = document.createElement('div')
  grid.className = 'zen-overview-grid'
  grid.getBoundingClientRect = () =>
    rectOf({ x: 0, y: view.top, width: 360, height: view.bottom - view.top })
  for (const [id, box] of Object.entries(cells)) {
    const cell = document.createElement('div')
    cell.dataset.cell = id
    cell.getBoundingClientRect = () => rectOf(box)
    grid.appendChild(cell)
  }
  document.body.appendChild(grid)
  gridRef.current = grid
}

/** A fresh mount, as the overview's next opening would be. */
function remount(): void {
  act(() => root?.unmount())
  root = createRoot(host!)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.mocked(run).mockClear()
  takeOverviewGroupsHintRequest()
  resetIphSession()
  forgetHintBubble()
  liftStore.set({ phase: 'idle', tabId: null })
  standGrid()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  grid?.remove()
  grid = null
  gridRef.current = null
  takeOverviewGroupsHintRequest()
  forgetHintBubble()
  resetIphSession()
  liftStore.set({ phase: 'idle', tabId: null })
  vi.useRealTimers()
})

describe('the bubble goes up', () => {
  it('on the card, once the overview the tip opened is at rest – once, spent as it goes', () => {
    requestOverviewGroupsHint()
    render(stateOf(), OPEN)
    expect(bubble()).toMatchObject({ leaving: false })
    expect(bubble().bubble).toEqual({
      id: 'tabGroupsDragAndDrop',
      at: 'overview',
      tabId: 't1',
      anchor: ANCHOR,
      text: TAB_GROUPS_DRAG_HINT_TEXT
    })
    // The session's one education is taken, so the Tabs button's bubble is not owed after it.
    expect(iphSessionSpent()).toBe(true)
    // Spent for the device as it goes up, the stamp the day it was spent, this record alone.
    expect(updates()).toEqual([
      { iph: { tabGroupsDragAndDrop: { availableAt: NOW, shown: true } } }
    ])
    // The request was the one opening's: a re-render, the cards moving on, the next opening
    // with no tap on the tip behind it – nothing goes up again and nothing more is written.
    forgetHintBubble()
    render({ ...stateOf() }, OPEN)
    render(stateOf(), OPEN, ['t2'])
    remount()
    render(stateOf(), OPEN)
    expect(bubble().bubble).toBeNull()
    expect(updates()).toHaveLength(1)
  })

  it('waits for the rest: not while the overview is still on its way open', () => {
    requestOverviewGroupsHint()
    render(stateOf(), SETTLING)
    expect(bubble().bubble).toBeNull()
    expect(updates()).toHaveLength(0)
    render(stateOf(), OPEN)
    expect(bubble().bubble).not.toBeNull()
  })

  it("never for an overview the tip did not open, and never twice on a device – Chrome's dialog is the tap's", () => {
    render(stateOf(), OPEN)
    expect(bubble().bubble).toBeNull()
    remount()
    requestOverviewGroupsHint()
    render(stateOf(true), OPEN)
    expect(bubble().bubble).toBeNull()
    expect(iphSessionSpent()).toBe(false)
    // A spent record eats the request too: the next opening, whoever opens it, owes nothing.
    render(stateOf(), OPEN)
    expect(bubble().bubble).toBeNull()
    expect(updates()).toHaveLength(0)
  })

  it("is not gated by the session's one education: Chrome's tip path runs no tracker", () => {
    spendIphSession()
    requestOverviewGroupsHint()
    render(stateOf(), OPEN)
    expect(bubble().bubble).not.toBeNull()
  })

  it("stands beside the Tabs button's hook, mounted as the shell mounts it under a chrome the open overview keeps from calm (the emulator's first run: that hook took any bubble down)", () => {
    requestOverviewGroupsHint()
    act(() => root!.render(createElement(Shell, { state: stateOf(), overview: OPEN })))
    expect(bubble()).toMatchObject({ leaving: false })
    expect(bubble().bubble).toMatchObject({ id: 'tabGroupsDragAndDrop', tabId: 't1' })
    wait(HINT_BUBBLE_EXIT_MS * 5)
    expect(bubble()).toMatchObject({ leaving: false })
    expect(bubble().bubble).toMatchObject({ id: 'tabGroupsDragAndDrop', tabId: 't1' })
    // Its own rules still hold there: the first touch takes it down.
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    })
    expect(bubble().leaving).toBe(true)
  })

  it('is dropped with an overview that closes before it rests', () => {
    requestOverviewGroupsHint()
    render(stateOf(), LEAVING)
    render(stateOf(), CLOSED)
    render(stateOf(), OPEN)
    expect(bubble().bubble).toBeNull()
    expect(updates()).toHaveLength(0)
  })

  it("is dropped with an overview unmounted before it rests – the URL bar or an overlay dismissing it during the settle (`dismissOverview`: no 'closed' render, `PhoneStage` unmounts it) – so the next Tabs-button opening owes nothing", () => {
    // The first-line review's probe P9: request → settling → unmount → a fresh mount, open.
    requestOverviewGroupsHint()
    render(stateOf(), SETTLING)
    remount()
    render(stateOf(), OPEN)
    expect(bubble().bubble).toBeNull()
    expect(iphSessionSpent()).toBe(false)
    expect(updates()).toHaveLength(0)
    // A request left while the overview already stood – its tap during the leave, the phase
    // not yet moved on – dies with the overview the same.
    remount()
    render(stateOf(), LEAVING)
    requestOverviewGroupsHint()
    remount()
    render(stateOf(), OPEN)
    expect(bubble().bubble).toBeNull()
    expect(updates()).toHaveLength(0)
  })

  it("survives StrictMode's rehearsal of the mount (every dev build: mount, cleanup, mount) – the request is the opening overview's from its first frame, not the dry run's to drop", () => {
    requestOverviewGroupsHint()
    renderStrict(stateOf(), SETTLING)
    expect(bubble().bubble).toBeNull()
    renderStrict(stateOf(), OPEN)
    expect(bubble()).toMatchObject({ leaving: false })
    expect(bubble().bubble).toMatchObject({ id: 'tabGroupsDragAndDrop', tabId: 't1' })
    expect(updates()).toHaveLength(1)
    // And the real unmount still takes it down, and with it any request.
    requestOverviewGroupsHint()
    act(() => root!.unmount())
    root = createRoot(host!)
    expect(bubble()).toEqual({ bubble: null, leaving: false })
    expect(takeOverviewGroupsHintRequest()).toBe(false)
  })

  it("is dropped by an overview resting with no card to point at – a Groups pane, a grid of groups only, the tablet's overview: no candidates", () => {
    requestOverviewGroupsHint()
    render(stateOf(), OPEN, [])
    expect(bubble().bubble).toBeNull()
    expect(iphSessionSpent()).toBe(false)
    render(stateOf(), OPEN, ['t1'])
    expect(bubble().bubble).toBeNull()
    // Likewise a card the grid has not built.
    remount()
    standGrid({})
    requestOverviewGroupsHint()
    render(stateOf(), OPEN)
    expect(bubble().bubble).toBeNull()
    expect(updates()).toHaveLength(0)
  })

  it("wears the card: the halo under it and the bubble as the card's description, while it stands", () => {
    const face = (hinted: boolean): string =>
      renderToStaticMarkup(
        createElement(OverviewCard, {
          tab: {
            id: 't1',
            url: 'https://example.com/',
            title: 'Example',
            containerId: 'default',
            folderId: null
          } as unknown as Tab,
          position: 1,
          count: 2,
          active: true,
          hidden: false,
          hinted,
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
      )
    const hinted = face(true)
    expect(hinted).toContain('data-iph-anchor="true"')
    expect(hinted).toContain(`aria-describedby="${HINT_BUBBLE_ID}"`)
    const plain = face(false)
    expect(plain).not.toContain('data-iph-anchor')
    expect(plain).not.toContain('aria-describedby')
  })
})

describe('the card it stands on – the loose page card in view nearest the active card (the design lead’s fold on #701)', () => {
  /** The overview's next opening, the grid stood anew. */
  const reopen = (cells: Record<string, Box>, view = VIEW): void => {
    forgetHintBubble()
    remount()
    standGrid(cells, view)
    requestOverviewGroupsHint()
  }

  it('names the cards in order: at each distance the one before the active card, then the one after; the active card itself last, and only when a page’s; never the new tab page’s', () => {
    // The tip's case: the new tab page the finger came from is the last card, the pages before it.
    expect(overviewHintCandidates([card('a'), card('b'), card('n', false)], 'n')).toEqual([
      'b',
      'a'
    ])
    // Pages on both sides: before, after, then the next pair out.
    expect(
      overviewHintCandidates([card('a'), card('b'), card('n', false), card('c'), card('d')], 'n')
    ).toEqual(['b', 'c', 'a', 'd'])
    // The active card a page's: the others first, itself last.
    expect(overviewHintCandidates([card('a'), card('p'), card('c')], 'p')).toEqual(['a', 'c', 'p'])
    // New tab pages are never named, wherever they stand – the active one included.
    expect(
      overviewHintCandidates(
        [card('m', false), card('a'), card('n', false), card('o', false), card('c')],
        'n'
      )
    ).toEqual(['a', 'c'])
    expect(overviewHintCandidates([card('n', false)], 'n')).toEqual([])
    // No active card among the loose ones – a grouped or pinned tab active, none active: the
    // pages from the first.
    expect(overviewHintCandidates([card('a'), card('n', false), card('b')], 'g1')).toEqual([
      'a',
      'b'
    ])
    expect(overviewHintCandidates([card('a'), card('b')], null)).toEqual(['a', 'b'])
    expect(overviewHintCandidates([], null)).toEqual([])
  })

  it('knows a cell in view by more than half its height inside the grid’s box', () => {
    expect(cellInView({ top: 120, bottom: 333 }, VIEW)).toBe(true)
    // Cut at the top: 113 of 213 inside is in view, 93 is not.
    expect(cellInView({ top: 20, bottom: 233 }, VIEW)).toBe(true)
    expect(cellInView({ top: 0, bottom: 213 }, VIEW)).toBe(false)
    // Cut at the bottom: 120 of 213 inside is in view, 105 is not.
    expect(cellInView({ top: 780, bottom: 993 }, VIEW)).toBe(true)
    expect(cellInView({ top: 795, bottom: 1008 }, VIEW)).toBe(false)
    // Wholly out, either way.
    expect(cellInView({ top: -300, bottom: -87 }, VIEW)).toBe(false)
    expect(cellInView({ top: 1000, bottom: 1213 }, VIEW)).toBe(false)
  })

  it('stands on the card before the active one when it is in view – the tip’s case: the page before the new tab page the finger came from', () => {
    // Rows of two – a b / c n – the new tab page active, every row in the view.
    standGrid({ a: cellAt(0, 0), b: cellAt(1, 0), c: cellAt(0, 1), n: cellAt(1, 1) })
    requestOverviewGroupsHint()
    render(
      stateOf(),
      OPEN,
      overviewHintCandidates([card('a'), card('b'), card('c'), card('n', false)], 'n')
    )
    expect(bubble().bubble).toMatchObject({ tabId: 'c', anchor: cellAt(0, 1) })
    expect(iphSessionSpent()).toBe(true)
  })

  it('else on the one after it: the cards before it scrolled off the top of the view, or none before it', () => {
    // Scrolled: a b / c d stand above the view, n (active) and e in it.
    reopen({
      a: cellAt(0, -2),
      b: cellAt(1, -2),
      c: cellAt(0, -1),
      d: cellAt(1, -1),
      n: cellAt(0, 0),
      e: cellAt(1, 0)
    })
    const cards = [card('a'), card('b'), card('c'), card('d'), card('n', false), card('e')]
    render(stateOf(), OPEN, overviewHintCandidates(cards, 'n'))
    expect(bubble().bubble).toMatchObject({ tabId: 'e', anchor: cellAt(1, 0) })
    // The active card the grid's first: nothing before it, the one after takes it.
    reopen({ n: cellAt(0, 0), a: cellAt(1, 0), b: cellAt(0, 1) })
    render(stateOf(), OPEN, overviewHintCandidates([card('n', false), card('a'), card('b')], 'n'))
    expect(bubble().bubble).toMatchObject({ tabId: 'a', anchor: cellAt(1, 0) })
    // The card before it cut at the view's top edge with less than half in: the one after.
    reopen({ c: { x: 16, y: 0, width: 160, height: 213 }, n: cellAt(1, 0), e: cellAt(0, 1) })
    render(stateOf(), OPEN, overviewHintCandidates([card('c'), card('n', false), card('e')], 'n'))
    expect(bubble().bubble).toMatchObject({ tabId: 'e', anchor: cellAt(0, 1) })
    // With more than half in, the card before it stands.
    reopen({ c: { x: 16, y: 20, width: 160, height: 213 }, n: cellAt(1, 0), e: cellAt(0, 1) })
    render(stateOf(), OPEN, overviewHintCandidates([card('c'), card('n', false), card('e')], 'n'))
    expect(bubble().bubble).toMatchObject({ tabId: 'c', anchor: { x: 16, y: 20 } })
  })

  it('on the active card itself only when no other page card is in view – and only when it is a page’s', () => {
    // p active and a page's; its neighbours a and c are off the view, above and below.
    standGrid({ a: cellAt(0, -1), p: cellAt(1, 0), c: cellAt(0, 4) })
    requestOverviewGroupsHint()
    const cards = [card('a'), card('p'), card('c')]
    render(stateOf(), OPEN, overviewHintCandidates(cards, 'p'))
    expect(bubble().bubble).toMatchObject({ tabId: 'p', anchor: cellAt(1, 0) })
    // With a in view, a takes it over the active card.
    reopen({ a: cellAt(0, 0), p: cellAt(1, 0), c: cellAt(0, 4) })
    render(stateOf(), OPEN, overviewHintCandidates(cards, 'p'))
    expect(bubble().bubble).toMatchObject({ tabId: 'a', anchor: cellAt(0, 0) })
    // A card the grid has not built (the window's fill still to come) is not in view either:
    // the next in view takes it.
    reopen({ p: cellAt(1, 0), c: cellAt(0, 1) })
    render(stateOf(), OPEN, overviewHintCandidates(cards, 'p'))
    expect(bubble().bubble).toMatchObject({ tabId: 'c', anchor: cellAt(0, 1) })
  })

  it('never the new tab page’s card: with no page card in view, nothing goes up and nothing is written – the request dropped, not kept', () => {
    // The tip's page alone in view, the pages scrolled off above it.
    standGrid({ a: cellAt(0, -1), b: cellAt(1, -1), n: cellAt(0, 0) })
    requestOverviewGroupsHint()
    const cards = [card('a'), card('b'), card('n', false)]
    render(stateOf(), OPEN, overviewHintCandidates(cards, 'n'))
    expect(bubble().bubble).toBeNull()
    expect(iphSessionSpent()).toBe(false)
    expect(updates()).toHaveLength(0)
    // The pages coming into view later do not raise it: the request was the one rest's.
    standGrid({ a: cellAt(0, 0), b: cellAt(1, 0), n: cellAt(0, 1) })
    render(stateOf(), OPEN, ['a', 'b'])
    expect(bubble().bubble).toBeNull()
    // A new tab page alone in the grid – the tip's first tab – names no card at all.
    reopen({ n: cellAt(0, 0) })
    render(stateOf(), OPEN, overviewHintCandidates([card('n', false)], 'n'))
    expect(bubble().bubble).toBeNull()
    expect(updates()).toHaveLength(0)
  })
})

describe('the bubble comes down', () => {
  const up = (): void => {
    requestOverviewGroupsHint()
    render(stateOf(), OPEN)
    expect(bubble()).toMatchObject({ leaving: false })
    expect(bubble().bubble).not.toBeNull()
  }
  const leaving = (): boolean => bubble().leaving

  it('on a touch anywhere, heard in the capture phase and not swallowed: the touched card still runs', () => {
    up()
    // The finger lands on the card the bubble points at – the tap that picks the tab, or the
    // hold that begins the drag it teaches. The cell's own handler stands for the card's: it
    // runs, on an event nothing has cancelled, after the bubble heard the touch.
    const cell = grid!.firstElementChild as HTMLElement
    const pressed = vi.fn((e: Event) => ({
      swallowed: e.defaultPrevented,
      bubbleLeaving: leaving()
    }))
    cell.addEventListener('pointerdown', pressed)
    act(() => {
      cell.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    })
    expect(leaving()).toBe(true)
    expect(pressed).toHaveBeenCalledTimes(1)
    expect(pressed).toHaveReturnedWith({ swallowed: false, bubbleLeaving: true })
    wait(HINT_BUBBLE_EXIT_MS)
    expect(bubble()).toEqual({ bubble: null, leaving: false })
    cell.removeEventListener('pointerdown', pressed)
  })

  it('on the first drag – the card lifted into the hand', () => {
    up()
    act(() => liftStore.set({ phase: 'lifted', tabId: 't1' }))
    expect(leaving()).toBe(true)
  })

  it("on the overview leaving its rest – a close, the predictive back's drag", () => {
    up()
    render(stateOf(), LEAVING)
    expect(leaving()).toBe(true)
  })

  it('on the window changing size', () => {
    up()
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(leaving()).toBe(true)
  })

  it('with the overview, outright – and never another bubble', () => {
    up()
    act(() => root!.unmount())
    expect(bubble()).toEqual({ bubble: null, leaving: false })
    root = createRoot(host!)
    render(stateOf(), OPEN)
    act(() =>
      showHintBubble({
        id: 'tabSwitcher',
        anchorItem: 'tabs',
        edge: 'bottom',
        anchor: { x: 296, y: 860, width: 44, height: 44 },
        text: 'Tap here to see your open tabs'
      })
    )
    act(() => root!.unmount())
    root = createRoot(host!)
    expect(bubble().bubble).toMatchObject({ id: 'tabSwitcher' })
  })
})
