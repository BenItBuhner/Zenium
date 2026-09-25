import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIState } from '@shared/types'

/*
 * Q1, the observable landing (the §11 stand-in rule) on the gesture stage: where a swipe or the
 * overview lands, the card that stood in for the page stays until the host has answered the
 * placement that brings the page back – never dropped on the chrome's clock – and leaves on
 * the chrome's next frame after the answer. The safe side is overlap, the forbidden side a gap.
 */

/** The frame loop the springs run on, driven by hand. */
let frames: Array<(now: number) => void> = []
let now = 1000
const frame = (): void => {
  now += 16
  const batch = frames
  frames = []
  for (const cb of batch) cb(now)
}
const settle = (until: () => boolean, max = 600): void => {
  for (let i = 0; i < max && frames.length && !until(); i++) frame()
}

const invoke = vi.fn(async () => null)
vi.stubGlobal('window', { zen: { invoke, on: () => () => undefined }, innerHeight: 900 })
vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
  frames.push(cb)
  return frames.length
})
vi.stubGlobal('cancelAnimationFrame', (id: number) => {
  frames.splice(id - 1, 1)
})

const stage = await import('../gestures/stage')
const { browserStore, contentAreaStore, uiStore } = await import('../ui')
const { coverStore, landingAnswered, landingsSent, SHOWN_WAIT_MS } = await import('../cover')
const { onLayoutApplied, pageViewStore } = await import('../pageView')

function tab(id: string): UIState['tabs'][string] {
  return {
    id,
    spaceId: 'space',
    containerId: 'default',
    url: `https://${id}.test/`,
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
    progress: 0,
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
    openerTabId: null,
    fromIntent: false,
    webApp: null
  }
}

/** Two tabs in one space, `a` active, on a host whose chrome lies under the pages. */
function state(placementAnswered = true, active = 'a'): UIState {
  return {
    platform: 'android',
    capabilities: { placementAnswered },
    spaces: [
      {
        id: 'space',
        name: 'Work',
        icon: '',
        containerId: 'default',
        theme: null,
        tabIds: ['a', 'b'],
        activeTabId: active,
        pinnedCollapsed: false
      }
    ],
    activeSpaceId: 'space',
    tabs: { a: tab('a'), b: tab('b') },
    essentialTabIds: [],
    folders: {},
    settings: { containerSpecificEssentials: false }
  } as unknown as UIState
}

/** Drain the microtasks a capture's promise chain runs on (the timers are faked in these suites). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
const tabs = (): ReturnType<typeof stage.stageStore.get>['tabs'] => stage.stageStore.get().tabs
const landing = (): ReturnType<typeof stage.stageStore.get>['landing'] =>
  stage.stageStore.get().landing
const overview = (): ReturnType<typeof stage.stageStore.get>['overview'] =>
  stage.stageStore.get().overview

/** The core applied the stage's hide: the pages are down (what makes the landing a landing). */
function pagesHidden(): void {
  onLayoutApplied({ contentHidden: false, hid: [], shown: [] })
  onLayoutApplied({ contentHidden: true, hid: ['a'], shown: [] })
}

/**
 * The landing's layout, as `useMainEvents` takes `layout.applied` on a host that answers
 * placements: the wait set for the views brought back, then the phases.
 */
function landingApplied(shown: string[]): void {
  landingsSent(shown)
  onLayoutApplied({ contentHidden: false, hid: [], shown })
}

/** The browser reports `b` as the active tab (the `tab.activate` the stage asked for landed). */
function activated(placementAnswered = true): void {
  browserStore.set({ state: state(placementAnswered, 'b') })
}

/** A swipe from `a` to `b`, run to the commit: the stage has asked for `b` and waits for it. */
function swipeToB(placementAnswered = true): void {
  expect(stage.beginTabSwitch(state(placementAnswered))).toBe(true)
  const advance = tabs().advance
  stage.dragTabSwitch(advance)
  expect(tabs().position).toBeCloseTo(1, 9)
  pagesHidden()
  stage.releaseTabSwitch(0)
  settle(() => tabs().phase === 'committing')
  expect(tabs().phase).toBe('committing')
  expect(invoke).toHaveBeenCalledWith('tab.activate', { tabId: 'b' })
}

describe('the swipe’s landing holds the card for the host’s answer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    frames = []
    now = 1000
    invoke.mockClear()
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    browserStore.set({ state: state() })
    contentAreaStore.set({ area: { x: 0, y: 0, width: 400, height: 800 } })
    coverStore.set({ awaitingShow: new Set() })
    pageViewStore.set({ phases: new Map(), lastApplied: null })
    stage.dismissStage()
  })
  afterEach(() => {
    stage.dismissStage()
    vi.useRealTimers()
    delete (globalThis as { __zenBridgeTrace?: unknown }).__zenBridgeTrace
    vi.restoreAllMocks()
  })

  it('stays through the landing until the answer, then drops', () => {
    swipeToB()
    // The browser shows b: the stage stops hiding the pages, but the landed card stays – the
    // track at rest (nothing for a finger to catch), its geometry kept for the card.
    activated()
    expect(uiStore.get().stageActive).toBe(false)
    expect(landing()).toEqual({ tabId: 'b', stage: 'tabs' })
    expect(tabs()).toMatchObject({ phase: 'idle', order: ['a', 'b'], position: 1, origin: 1 })
    // The reporter's layout brings b's view back; the host has not answered yet.
    landingApplied(['b'])
    expect(landing()).toEqual({ tabId: 'b', stage: 'tabs' })
    expect(tabs().order).toEqual(['a', 'b'])
    // The host's answer: the card leaves now.
    landingAnswered('b')
    expect(landing()).toBeNull()
    expect(tabs()).toMatchObject({ phase: 'idle', order: [] })
    expect(invoke).toHaveBeenCalledWith('focus.content', undefined)
  })

  it('drops at once when the host answers that nothing is coming', () => {
    swipeToB()
    activated()
    landingApplied(['b'])
    expect(landing()).not.toBeNull()
    // `view.shown` with `shown: false` reaches the same `landingAnswered`: the drop is the same.
    landingAnswered('b')
    expect(landing()).toBeNull()
    expect(tabs().order).toEqual([])
  })

  it('drops at the bound when the host never answers', () => {
    swipeToB()
    activated()
    landingApplied(['b'])
    vi.advanceTimersByTime(SHOWN_WAIT_MS - 1)
    expect(landing()).toEqual({ tabId: 'b', stage: 'tabs' })
    vi.advanceTimersByTime(1)
    expect(landing()).toBeNull()
    expect(tabs().order).toEqual([])
  })

  it('drops at once when the landing’s layout brought no view back: nothing to wait for', () => {
    swipeToB()
    activated()
    expect(landing()).not.toBeNull()
    landingApplied([])
    expect(landing()).toBeNull()
    expect(tabs().order).toEqual([])
  })

  it('a landing whose layout never comes is not held for good', () => {
    swipeToB()
    activated()
    expect(landing()).not.toBeNull()
    vi.advanceTimersByTime(SHOWN_WAIT_MS + 200)
    expect(landing()).toBeNull()
  })

  it('on a host without the capability the card drops as it always did, with the activation', () => {
    browserStore.set({ state: state(false) })
    swipeToB(false)
    activated(false)
    expect(landing()).toBeNull()
    expect(tabs()).toMatchObject({ phase: 'idle', order: [] })
    expect(uiStore.get().stageActive).toBe(false)
  })

  it('a swipe too short to have hidden the pages lands as it always did: no gap to fill', () => {
    expect(stage.beginTabSwitch(state())).toBe(true)
    stage.dragTabSwitch(tabs().advance)
    // No hide applied: the pages are still on screen under the stage.
    stage.releaseTabSwitch(0)
    settle(() => tabs().phase === 'committing')
    activated()
    expect(landing()).toBeNull()
    expect(tabs().order).toEqual([])
  })

  it('a new swipe over the held card takes the stage back without a drop of its own, and the answer no longer touches it', () => {
    swipeToB()
    activated()
    landingApplied(['b'])
    expect(landing()).not.toBeNull()
    expect(stage.beginTabSwitch(state(true, 'b'))).toBe(true)
    expect(landing()).toBeNull()
    expect(tabs()).toMatchObject({ phase: 'dragging', order: ['a', 'b'], origin: 1 })
    landingAnswered('b')
    expect(tabs().phase).toBe('dragging')
  })

  it('the overview pulled in over the held card takes the stage back the same way', async () => {
    swipeToB()
    activated()
    landingApplied(['b'])
    expect(stage.beginOverviewDrag(state(true, 'b'))).toBe(true)
    await flush()
    expect(landing()).toBeNull()
    expect(tabs()).toMatchObject({ phase: 'idle', order: [] })
    expect(overview()).toMatchObject({ phase: 'dragging', heroTabId: 'b' })
    landingAnswered('b')
    expect(overview().phase).toBe('dragging')
  })

  it('the drop is marked for the trace where the card actually leaves', () => {
    ;(globalThis as { __zenBridgeTrace?: unknown }).__zenBridgeTrace = true
    const mark = vi.spyOn(performance, 'mark').mockImplementation(() => ({}) as PerformanceMark)
    swipeToB()
    activated()
    landingApplied(['b'])
    expect(mark).not.toHaveBeenCalledWith('cover:drop:b')
    landingAnswered('b')
    expect(mark).toHaveBeenCalledWith('cover:drop:b')
  })
})

describe('the overview’s close holds its hero for the host’s answer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    frames = []
    now = 1000
    invoke.mockClear()
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    browserStore.set({ state: state() })
    contentAreaStore.set({ area: { x: 0, y: 0, width: 400, height: 800 } })
    coverStore.set({ awaitingShow: new Set() })
    pageViewStore.set({ phases: new Map(), lastApplied: null })
    stage.dismissStage()
  })
  afterEach(() => {
    stage.dismissStage()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** The overview opened from `a` and closed into `b`'s card, run to the wait for `b`. */
  async function closeIntoB(placementAnswered = true): Promise<void> {
    stage.openOverview(state(placementAnswered))
    await flush()
    settle(() => overview().phase === 'open')
    expect(overview().phase).toBe('open')
    expect(uiStore.get().stageActive).toBe(true)
    pagesHidden()
    stage.closeOverview('b')
    expect(overview()).toMatchObject({ phase: 'settling', target: 0, heroTabId: 'b' })
    expect(invoke).toHaveBeenCalledWith('tab.activate', { tabId: 'b' })
    settle(() => overview().phase !== 'settling')
    // The spring has landed; the overview waits for the browser to show b.
    expect(overview().phase).toBe('settling')
  }

  it('stays through the landing until the answer, then drops', async () => {
    await closeIntoB()
    activated()
    // Closed for every reader – no back surface, nothing in flight – with the hero kept, so the
    // overview draws it at the page's frame and nothing else.
    expect(uiStore.get().stageActive).toBe(false)
    expect(overview()).toMatchObject({ phase: 'closed', progress: 0, heroTabId: 'b' })
    expect(landing()).toEqual({ tabId: 'b', stage: 'overview' })
    expect(stage.overviewIsOpen()).toBe(false)
    landingApplied(['b'])
    expect(landing()).toEqual({ tabId: 'b', stage: 'overview' })
    landingAnswered('b')
    expect(landing()).toBeNull()
    expect(overview()).toMatchObject({ phase: 'closed', heroTabId: null })
  })

  it('drops at the bound when the host never answers', async () => {
    await closeIntoB()
    activated()
    landingApplied(['b'])
    vi.advanceTimersByTime(SHOWN_WAIT_MS - 1)
    expect(landing()).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(landing()).toBeNull()
    expect(overview().heroTabId).toBeNull()
  })

  it('on a host without the capability the overview leaves with the activation, as it always did', async () => {
    browserStore.set({ state: state(false) })
    await closeIntoB(false)
    activated(false)
    expect(landing()).toBeNull()
    expect(overview()).toMatchObject({ phase: 'closed', heroTabId: null })
  })

  it('a pull that opens the overview again over the held hero starts afresh', async () => {
    await closeIntoB()
    activated()
    landingApplied(['b'])
    expect(stage.beginOverviewDrag(state(true, 'b'))).toBe(true)
    expect(landing()).toBeNull()
    expect(overview()).toMatchObject({ phase: 'dragging', heroTabId: 'b', progress: 0 })
    landingAnswered('b')
    expect(overview().phase).toBe('dragging')
  })
})
