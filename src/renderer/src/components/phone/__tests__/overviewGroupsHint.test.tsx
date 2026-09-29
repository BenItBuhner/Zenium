// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Tab, UIState } from '@shared/types'
import type { OverviewState } from '@renderer/lib/gestures/stage'

/*
 * The overview's drag-to-group in-product help (TB-19, useOverviewGroupsHint.ts): Chrome 152's
 * `IPH_TabGroupsDragAndDrop` dialog, opened by the tab-groups tip's "Try it now"
 * (`ChromeTabbedActivity.java` l.3500–3508), as a §9.33 bubble on a card of the overview the
 * tip opened. Driven in happy-dom with the grid's anchor cell stood in: the request the tips
 * card leaves, taken as the overview comes to rest and dropped with one that never rests; the
 * bubble up once, on the card, spent as it goes up – once per device, and not gated by the
 * session's one education, since Chrome's tip path runs no tracker – and every way it comes
 * down: a touch anywhere, the first drag, the overview leaving its rest, a resize, the unmount.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Object.assign(window, { zen: { invoke: vi.fn(async () => null), on: () => () => undefined } })

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { run } = await import('@renderer/lib/api')
const { useOverviewGroupsHint } = await import('../useOverviewGroupsHint')
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
const ANCHOR = { x: 16, y: 120, width: 160, height: 213 }
const ANCHOR_RECT = { ...ANCHOR, left: ANCHOR.x, top: ANCHOR.y } as DOMRect

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

function Hint({
  state,
  overview,
  anchorTabId = 't1'
}: {
  state: UIState
  overview: OverviewState
  anchorTabId?: string | null
}): null {
  useOverviewGroupsHint({ state, overview, anchorTabId, grid: gridRef })
  return null
}

/**
 * The phone shell's arrangement: the Tabs button's hook (`PhoneShell`) and the overview's, on
 * the one bubble store, the chrome not calm because the overview is open (`PhoneShell`'s `calm`).
 */
function Shell({ state, overview }: { state: UIState; overview: OverviewState }): null {
  useTabSwitcherHint(state, 'bottom', false)
  useOverviewGroupsHint({ state, overview, anchorTabId: 't1', grid: gridRef })
  return null
}

let root: Root | null = null
let host: HTMLDivElement | null = null
let grid: HTMLDivElement | null = null

const render = (state: UIState, overview: OverviewState, anchorTabId?: string | null): void => {
  act(() => root!.render(createElement(Hint, { state, overview, anchorTabId })))
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

/** The grid's scroller with the anchor's cell in it, where the hook reads the card's box. */
function standGrid(withCell = true): void {
  grid?.remove()
  grid = document.createElement('div')
  grid.className = 'zen-overview-grid'
  if (withCell) {
    const cell = document.createElement('div')
    cell.dataset.cell = 't1'
    cell.getBoundingClientRect = () => ANCHOR_RECT
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
    // The request was the one opening's: a re-render, the anchor moving on, the next opening
    // with no tap on the tip behind it – nothing goes up again and nothing more is written.
    forgetHintBubble()
    render({ ...stateOf() }, OPEN)
    render(stateOf(), OPEN, 't2')
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

  it('is dropped by an overview resting with no card to point at – a Groups pane, a grid of groups only', () => {
    requestOverviewGroupsHint()
    render(stateOf(), OPEN, null)
    expect(bubble().bubble).toBeNull()
    expect(iphSessionSpent()).toBe(false)
    render(stateOf(), OPEN, 't1')
    expect(bubble().bubble).toBeNull()
    // Likewise a card the grid has not built.
    remount()
    standGrid(false)
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
