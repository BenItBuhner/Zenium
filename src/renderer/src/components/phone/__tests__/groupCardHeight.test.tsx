// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, StrictMode, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Tab } from '@shared/types'

/*
 * The group card's height effect (`GroupCard.tsx`, the fold measurement) rendered for real: it
 * reads the body's `offsetHeight` – a forced layout – so it must run once per change of what it
 * measures (a fold, a card entering or leaving, the columns, forming, dissolving) and never on a
 * render of the grid around it that changes none of them. PERF-5's profiling of the overview
 * (#315) found the effect without a dependency array: a layout per group card per commit through
 * the lift's and the pick's phase renders, 34 ms of the baseline pick's script on six tabs and 52
 * on thirty (11 / 31 with fewer renders). This pins the array.
 */

Object.assign(window, { zen: { invoke: vi.fn(async () => null), on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { GroupCard, GROUP_PAD } = await import('../GroupCard')
const { GROUP_HEADER } = await import('../groupCardHeader')
const { layoutAnimations } = await import('@renderer/lib/motion/flip')
const { SPRING_GENTLE, isAtRest, stepSpring } = await import('@renderer/lib/motion/spring')

const GROUP = 'g'
const KEY = `group:${GROUP}`

function tab(id: string): Tab {
  return {
    id,
    spaceId: 'space',
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
    folderId: GROUP,
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

const folderOf = (collapsed: boolean): Folder => ({
  id: GROUP,
  spaceId: 'space',
  name: 'Research',
  icon: '📚',
  collapsed,
  color: 'blue'
})

// --- a layout ----------------------------------------------------------------------------------

/** The body's height for `rows` rows of 130 cards at a 12 gap, over the card's inset. */
const bodyOf = (rows: number): number => rows * 130 + (rows - 1) * 12 + GROUP_PAD
/** What the body answers `offsetHeight` with, and how often it was asked (the forced layouts). */
let bodyHeight = bodyOf(1)
let bodyReads = 0
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get(this: HTMLElement): number {
    if (this.classList.contains('grid') && this.parentElement?.classList.contains('zen-group')) {
      bodyReads++
      return bodyHeight
    }
    return 0
  }
})

// --- rendering ---------------------------------------------------------------------------------

interface Inputs {
  collapsed: boolean
  tabs: Tab[]
  columns: number
  forming?: boolean
  dissolving?: boolean
}

/**
 * The grid around the card, rendering it as `TabOverview` does: a folder object, the member
 * list, the card renderer and the menu callback all new on every render – what a render of the
 * grid for its own reasons (a phase change, a lift, a selection) hands the card.
 */
function Grid({ collapsed, tabs, columns, forming, dissolving }: Inputs): JSX.Element {
  return createElement(GroupCard, {
    folder: folderOf(collapsed),
    tabs: [...tabs],
    card: (t: Tab) => createElement('div', { key: t.id, 'data-cell': t.id }, t.title),
    onMenu: () => undefined,
    columns,
    forming,
    dissolving,
    held: dissolving ? 1 : undefined,
    onDissolved: () => undefined
  })
}

let root: Root | null = null
let host: HTMLElement | null = null

/** Rendered under `StrictMode`, as every dev build renders it. */
function render(inputs: Inputs): void {
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  act(() => root!.render(createElement(StrictMode, null, createElement(Grid, inputs))))
}

const shell = (): HTMLElement => host!.querySelector<HTMLElement>(`[data-cell="${KEY}"]`)!

const frames = new Map<number, (t: number) => void>()
let nextFrame = 1
let now = 10_000

beforeEach(() => {
  bodyHeight = bodyOf(1)
  bodyReads = 0
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
  vi.spyOn(layoutAnimations, 'start')
  vi.spyOn(layoutAnimations, 'retarget')
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  layoutAnimations.release()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** One animation frame of every spring in flight. */
const frame = (): void => {
  now += 16
  const batch = [...frames.values()]
  frames.clear()
  for (const cb of batch) cb(now)
}
const settle = (): void => {
  act(() => {
    for (let i = 0; i < 600 && frames.size; i++) frame()
  })
}

const two = [tab('m1'), tab('m2')]
const three = [...two, tab('m3')]

describe("the group card's height effect", () => {
  it('measures once at the mount and not again for renders of the grid that change nothing it reads', () => {
    render({ collapsed: false, tabs: two, columns: 2 })
    // The mount measures (twice under StrictMode: mount, cleanup, mount again) and settles at
    // the stylesheet's height with no spring – nothing moved.
    expect(bodyReads).toBeGreaterThan(0)
    expect(shell().style.height).toBe('')
    expect(layoutAnimations.start).not.toHaveBeenCalled()

    // The grid renders again and again around the card – the overview's phase renders at a
    // lift and a pick – with a new folder object, a new member list, a new card renderer and a
    // new menu callback each time, none of them changing what the card holds. Not one layout.
    bodyReads = 0
    for (let i = 0; i < 5; i++) render({ collapsed: false, tabs: two, columns: 2 })
    expect(bodyReads).toBe(0)
    expect(layoutAnimations.start).not.toHaveBeenCalled()
    expect(shell().style.height).toBe('')
  })

  it('measures once when a card enters, sets out from the height it had, and not again until the next change', () => {
    render({ collapsed: false, tabs: two, columns: 2 })
    bodyReads = 0

    // A third card: two rows now. One layout, and the height sets out from the one-row height
    // on its spring, the tracker told.
    bodyHeight = bodyOf(2)
    render({ collapsed: false, tabs: three, columns: 2 })
    expect(bodyReads).toBe(1)
    expect(layoutAnimations.start).toHaveBeenCalledTimes(1)
    expect(layoutAnimations.start).toHaveBeenCalledWith(
      KEY,
      GROUP_HEADER + bodyOf(1),
      GROUP_HEADER + bodyOf(2),
      true
    )
    expect(shell().style.height).toBe(`${GROUP_HEADER + bodyOf(1)}px`)

    // The grid renders around the card while the spring runs: no layout, no restart, no retarget.
    for (let i = 0; i < 3; i++) render({ collapsed: false, tabs: three, columns: 2 })
    expect(bodyReads).toBe(1)
    expect(layoutAnimations.start).toHaveBeenCalledTimes(1)
    expect(layoutAnimations.retarget).not.toHaveBeenCalled()

    settle()
    expect(shell().style.height).toBe('')
    expect(layoutAnimations.has(KEY)).toBe(false)

    // A card leaving: one layout, one spring, from the two-row height.
    bodyHeight = bodyOf(1)
    render({ collapsed: false, tabs: two, columns: 2 })
    expect(bodyReads).toBe(2)
    expect(layoutAnimations.start).toHaveBeenCalledTimes(2)
    expect(layoutAnimations.start).toHaveBeenLastCalledWith(
      KEY,
      GROUP_HEADER + bodyOf(2),
      GROUP_HEADER + bodyOf(1),
      true
    )
  })

  it('a fold and an unfold run the measurement once each; the columns changing runs it once', () => {
    bodyHeight = bodyOf(2)
    render({ collapsed: false, tabs: three, columns: 2 })
    bodyReads = 0

    // Folding: the card is clipped to the shell and the spring heads for the header's height.
    // A collapsed card reads no body – its height is the header's – so the fold is told by the
    // spring alone.
    render({ collapsed: true, tabs: three, columns: 2 })
    expect(bodyReads).toBe(0)
    expect(layoutAnimations.start).toHaveBeenCalledTimes(1)
    expect(layoutAnimations.start).toHaveBeenLastCalledWith(
      KEY,
      GROUP_HEADER + bodyOf(2),
      GROUP_HEADER,
      true
    )
    expect(shell().dataset.clip).toBe('')
    for (let i = 0; i < 3; i++) render({ collapsed: true, tabs: three, columns: 2 })
    expect(layoutAnimations.start).toHaveBeenCalledTimes(1)
    expect(layoutAnimations.retarget).not.toHaveBeenCalled()
    settle()

    // Unfolding: one layout, the spring back to the whole.
    render({ collapsed: false, tabs: three, columns: 2 })
    expect(bodyReads).toBe(1)
    expect(layoutAnimations.start).toHaveBeenCalledTimes(2)
    expect(layoutAnimations.start).toHaveBeenLastCalledWith(
      KEY,
      GROUP_HEADER,
      GROUP_HEADER + bodyOf(2),
      true
    )
    settle()

    // The window's columns change (three cards fit one row now): one layout, one spring.
    bodyHeight = bodyOf(1)
    render({ collapsed: false, tabs: three, columns: 3 })
    expect(bodyReads).toBe(2)
    expect(layoutAnimations.start).toHaveBeenCalledTimes(3)
    expect(layoutAnimations.start).toHaveBeenLastCalledWith(
      KEY,
      GROUP_HEADER + bodyOf(2),
      GROUP_HEADER + bodyOf(1),
      true
    )
    for (let i = 0; i < 3; i++) render({ collapsed: false, tabs: three, columns: 3 })
    expect(bodyReads).toBe(2)
    expect(layoutAnimations.start).toHaveBeenCalledTimes(3)
  })

  it('a fold rests the frame its height reaches the header, an unfold at its thresholds: the spring’s way to rest beneath the header draws nothing, and the cells below set off there (PERF-5, #349)', () => {
    /** Frames of the spring alone, `from` → `to` at the test’s 16 ms, to its rest thresholds. */
    const springFrames = (from: number, to: number): number => {
      let state = { x: from, v: 0 }
      let n = 0
      while (!isAtRest(state, to) && n < 600) {
        state = stepSpring(state, to, 16 / 1000, SPRING_GENTLE)
        n++
      }
      return n
    }
    /** Frames until the tracker is told the height is over; the heights written on the way. */
    const foldFrames = (): { frames: number; heights: number[] } => {
      const heights: number[] = []
      let frames = 0
      while (layoutAnimations.has(KEY) && frames < 600) {
        act(() => frame())
        frames++
        if (layoutAnimations.has(KEY)) heights.push(parseFloat(shell().style.height))
      }
      return { frames, heights }
    }
    bodyHeight = bodyOf(2)
    render({ collapsed: false, tabs: three, columns: 2 })
    const open = GROUP_HEADER + bodyOf(2)
    // After the mount: StrictMode’s mount, cleanup and mount again `end` once on the way.
    vi.spyOn(layoutAnimations, 'end')

    // Folding: every frame before the rest writes a height above the header – the card is still
    // visibly closing – and the frame that reaches the header is the rest: `end` tells the
    // tracker in that very frame, the inline height and the clip go, nothing is written at the
    // header and held there.
    render({ collapsed: true, tabs: three, columns: 2 })
    expect(shell().style.height).toBe(`${open}px`)
    const fold = foldFrames()
    expect(fold.heights.length).toBeGreaterThan(5)
    expect(fold.heights.every((h) => h > GROUP_HEADER)).toBe(true)
    expect(layoutAnimations.end).toHaveBeenCalledTimes(1)
    expect(shell().style.height).toBe('')
    expect(shell().dataset.clip).toBeUndefined()
    // The spring on its own would run on beneath the header to its thresholds – the hair of
    // overshoot and back – for several frames more (~100 ms at 60 Hz), the tail the cells below
    // used to wait out.
    expect(springFrames(open, GROUP_HEADER) - fold.frames).toBeGreaterThanOrEqual(5)

    // Unfolding: nothing above the height to stop at, so the rest is the spring’s own (the
    // overshoot past the whole is drawn, as §7 has it), the same frames as the spring alone.
    render({ collapsed: false, tabs: three, columns: 2 })
    expect(shell().style.height).toBe(`${GROUP_HEADER}px`)
    const unfold = foldFrames()
    expect(unfold.heights.some((h) => h > open)).toBe(true)
    expect(unfold.frames).toBe(springFrames(GROUP_HEADER, open))
    expect(layoutAnimations.end).toHaveBeenCalledTimes(2)
    expect(shell().style.height).toBe('')
  })

  it('a change mid-flight retargets the spring in the one commit that carries it, and renders after it leave it be', () => {
    render({ collapsed: false, tabs: two, columns: 2 })
    bodyHeight = bodyOf(2)
    render({ collapsed: false, tabs: three, columns: 2 })
    act(() => frame())
    act(() => frame())
    expect(layoutAnimations.has(KEY)).toBe(true)
    bodyReads = 0

    // The third card leaves again before the height has arrived: the spring turns around from
    // where it is – one layout, one retarget, no second start.
    bodyHeight = bodyOf(1)
    render({ collapsed: false, tabs: two, columns: 2 })
    expect(bodyReads).toBe(1)
    expect(layoutAnimations.start).toHaveBeenCalledTimes(1)
    expect(layoutAnimations.retarget).toHaveBeenCalledTimes(1)
    expect(layoutAnimations.retarget).toHaveBeenCalledWith(KEY, GROUP_HEADER + bodyOf(1))
    for (let i = 0; i < 3; i++) render({ collapsed: false, tabs: two, columns: 2 })
    expect(bodyReads).toBe(1)
    expect(layoutAnimations.retarget).toHaveBeenCalledTimes(1)
    settle()
    expect(shell().style.height).toBe('')
  })
})
