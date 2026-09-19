import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIState } from '@shared/types'
import type { OverviewState } from '../gestures/stage'

/**
 * The frame loop the springs run on, driven by hand: `frame()` advances one 16 ms frame,
 * `settle()` runs until nothing is queued. `now` is what `performance.now()` answers.
 */
let frames: Array<(now: number) => void> = []
let now = 1000
const frame = (): void => {
  now += 16
  const batch = frames
  frames = []
  for (const cb of batch) cb(now)
}
const settle = (max = 600): void => {
  for (let i = 0; i < max && frames.length; i++) frame()
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

/** Two tabs in one space, `a` active: all the overview needs of the browser state. */
function state(): UIState {
  return {
    spaces: [
      {
        id: 'space',
        name: 'Work',
        icon: '',
        containerId: 'default',
        theme: null,
        tabIds: ['a', 'b'],
        activeTabId: 'a',
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

const overview = (): OverviewState => stage.stageStore.get().overview

describe('overviewInteractive', () => {
  const base = { progress: 1, heroTabId: null } as const
  it('is true once the overview is on its way open, not only at rest', () => {
    expect(stage.overviewInteractive({ ...base, phase: 'open', target: 1 })).toBe(true)
    expect(
      stage.overviewInteractive({ ...base, phase: 'settling', target: 1, progress: 0.4 })
    ).toBe(true)
  })
  it('is false while closing, while a finger drags it, and when closed', () => {
    expect(
      stage.overviewInteractive({ ...base, phase: 'settling', target: 0, progress: 0.9 })
    ).toBe(false)
    expect(
      stage.overviewInteractive({ ...base, phase: 'dragging', target: 1, progress: 0.9 })
    ).toBe(false)
    expect(stage.overviewInteractive({ ...base, phase: 'closed', target: 0 })).toBe(false)
  })
})

describe('the overview and its first tap', () => {
  beforeEach(() => {
    frames = []
    now = 1000
    invoke.mockClear()
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    browserStore.set({ state: state() })
    contentAreaStore.set({ area: { x: 0, y: 0, width: 400, height: 800 } })
    stage.dismissStage()
  })
  afterEach(() => {
    stage.dismissStage()
    vi.restoreAllMocks()
  })

  it('takes taps from the first frame after the tabs button, while the spring still runs', () => {
    stage.openOverview(state())
    expect(overview()).toMatchObject({ phase: 'settling', target: 1, heroTabId: 'a' })
    expect(stage.overviewInteractive(overview())).toBe(true)

    // The last stretch of the settle is invisible (under a percent of the travel) but takes a
    // good many frames; the grid must be tappable throughout, or a quick tap is lost.
    let looksOpenAt: number | null = null
    let frameCount = 0
    while (overview().phase === 'settling' && frameCount < 600) {
      frame()
      frameCount++
      if (looksOpenAt === null && overview().progress >= 0.99) looksOpenAt = frameCount
      expect(stage.overviewInteractive(overview())).toBe(true)
    }
    expect(overview().phase).toBe('open')
    expect(looksOpenAt).not.toBeNull()
    expect(frameCount).toBeGreaterThan(looksOpenAt! + 3)
  })

  it('takes taps the moment the finger lets go of a pull that will open it', () => {
    stage.beginOverviewDrag(state())
    stage.dragOverview(0.7 * stage.overviewTravel())
    expect(stage.overviewInteractive(overview())).toBe(false)
    stage.releaseOverview(600)
    expect(overview()).toMatchObject({ phase: 'settling', target: 1 })
    expect(stage.overviewInteractive(overview())).toBe(true)
    settle()
    expect(overview().phase).toBe('open')
  })

  it('a pull let go too early heads back closed and is not tappable on the way', () => {
    stage.beginOverviewDrag(state())
    stage.dragOverview(0.2 * stage.overviewTravel())
    stage.releaseOverview(0)
    expect(overview()).toMatchObject({ phase: 'settling', target: 0 })
    expect(stage.overviewInteractive(overview())).toBe(false)
    settle()
    expect(overview().phase).toBe('closed')
  })

  it('a card picked mid-settle turns the overview round at once and activates that tab', () => {
    stage.openOverview(state())
    for (let i = 0; i < 6; i++) frame()
    expect(overview().phase).toBe('settling')
    expect(overview().progress).toBeGreaterThan(0.2)
    expect(overview().progress).toBeLessThan(1)

    stage.closeOverview('b')
    expect(overview()).toMatchObject({ phase: 'settling', target: 0, heroTabId: 'b' })
    expect(stage.overviewInteractive(overview())).toBe(false)
    expect(invoke).toHaveBeenCalledWith('tab.activate', { tabId: 'b' })

    // The browser reports the pick; the overview finishes closing and lets the page through.
    const s = state()
    s.spaces[0].activeTabId = 'b'
    browserStore.set({ state: s })
    settle()
    expect(overview().phase).toBe('closed')
    expect(uiStore.get().stageActive).toBe(false)
  })
})
