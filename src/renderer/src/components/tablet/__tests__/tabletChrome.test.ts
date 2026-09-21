// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIState } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { dispatchBackEvent, topBackSurface } from '@renderer/lib/back'
import { dismissStage, openOverview, stageStore } from '@renderer/lib/gestures/stage'
import { browserStore, contentAreaStore, uiStore } from '@renderer/lib/ui'
import {
  TABLET_DRAWER_BELOW,
  TABLET_TOOLBAR_HEIGHT,
  closeTabletDrawer,
  dismissTabletDrawer,
  openTabletDrawer,
  setTabletDrawerTravel,
  tabletDrawerLayout,
  tabletDrawerOpen,
  tabletDrawerStore
} from '../tabletChrome'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

/*
 * The tablet's sidebar drawer (TABLET-02) in a window too narrow for a docked expanded sidebar:
 * a store-driven slide over the page's picture. Like every surface over the page on Android it
 * opens in the order the chassis keeps – the live page is captured first, then the content frame
 * is held behind the capture (`holdFloatingChrome`) for as long as the drawer is up – and it is
 * a back surface while it is up, so the system gesture slides it out with its progress. The
 * frame loop the spring runs on is cranked by hand.
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
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

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
  } as unknown as UIState['tabs'][string]
}

function state(): UIState {
  return {
    platform: 'android',
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

let resolveCapture: ((data: string | null) => void) | null = null

/** Open the drawer over tab `a`, deliver its capture and let the spring land it. */
async function openAndLand(): Promise<void> {
  const opened = openTabletDrawer('a')
  resolveCapture?.('data:image/jpeg;base64,AAAA')
  await opened
  settle()
}

beforeEach(() => {
  frames = []
  now = 1000
  vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
    frames.push(cb)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.splice(id - 1, 1)
  })
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.mocked(cmd).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveCapture = resolve
      }) as never
  )
  browserStore.set({ state: state() })
  contentAreaStore.set({ area: { x: 0, y: 0, width: 600, height: 900 } })
  uiStore.set({
    snapshot: null,
    snapshotTabId: null,
    floatingChrome: 0,
    overlay: 'none',
    urlbar: { ...uiStore.get().urlbar, open: false }
  })
  setTabletDrawerTravel(240)
})

afterEach(() => {
  dismissTabletDrawer()
  dismissStage()
  settle()
  resolveCapture = null
  browserStore.set({ state: null })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('the tablet chrome numbers', () => {
  it('floats the expanded sidebar as a drawer only under the split-screen line', () => {
    // A split-screen half of a 10-inch tablet (600) and anything under the line: the drawer.
    expect(tabletDrawerLayout(600)).toBe(true)
    expect(tabletDrawerLayout(TABLET_DRAWER_BELOW - 1)).toBe(true)
    // A 10-inch tablet's portrait (800) and the line itself keep the docked sidebar.
    expect(tabletDrawerLayout(TABLET_DRAWER_BELOW)).toBe(false)
    expect(tabletDrawerLayout(800)).toBe(false)
    expect(tabletDrawerLayout(1280)).toBe(false)
  })

  it('makes the toolbar row as tall as the phone bar band: the 40 icon button padded 8', () => {
    expect(TABLET_TOOLBAR_HEIGHT).toBe(40 + 2 * 8)
  })
})

describe('the tablet drawer', () => {
  it('captures the page first and slides in only once the picture is in place', async () => {
    const opened = openTabletDrawer('a')
    expect(cmd).toHaveBeenCalledWith('overlay.snapshot', { tabId: 'a' })
    // The capture is in flight: nothing moves and the content frame is not held yet.
    await flush()
    expect(tabletDrawerStore.get()).toEqual({ phase: 'closed', progress: 0 })
    expect(uiStore.get().floatingChrome).toBe(0)

    resolveCapture?.('data:image/jpeg;base64,AAAA')
    await opened
    // The frame is held behind the capture, the chrome takes focus, and the spring is under way.
    expect(uiStore.get().floatingChrome).toBe(1)
    expect(uiStore.get().snapshotTabId).toBe('a')
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
    expect(tabletDrawerStore.get().phase).toBe('settling')
    expect(tabletDrawerOpen()).toBe(true)

    settle()
    expect(tabletDrawerStore.get()).toEqual({ phase: 'open', progress: 1 })
  })

  it('a second open while the first waits for its capture joins it', async () => {
    const first = openTabletDrawer('a')
    const second = openTabletDrawer('a')
    expect(second).toBe(first)
    expect(cmd).toHaveBeenCalledTimes(1)
    resolveCapture?.('data:image/jpeg;base64,AAAA')
    await first
    settle()
    expect(tabletDrawerStore.get().phase).toBe('open')
    expect(uiStore.get().floatingChrome).toBe(1)
  })

  it('closes on the spring and lets go of the page once it has left', async () => {
    await openAndLand()
    closeTabletDrawer()
    expect(tabletDrawerStore.get().phase).toBe('settling')
    // Mid-flight the page is still held: the picture stays under the leaving drawer.
    frame()
    expect(uiStore.get().floatingChrome).toBe(1)
    expect(tabletDrawerStore.get().progress).toBeLessThan(1)
    settle()
    expect(tabletDrawerStore.get()).toEqual({ phase: 'closed', progress: 0 })
    expect(uiStore.get().floatingChrome).toBe(0)
    expect(tabletDrawerOpen()).toBe(false)
  })

  it('an open during the close brings it back in from where it is', async () => {
    await openAndLand()
    closeTabletDrawer()
    frame()
    frame()
    const midway = tabletDrawerStore.get().progress
    expect(midway).toBeGreaterThan(0)
    expect(midway).toBeLessThan(1)
    void openTabletDrawer('a')
    // No second capture: the page is still held from the first open.
    expect(cmd).toHaveBeenCalledTimes(1)
    expect(tabletDrawerStore.get().phase).toBe('settling')
    settle()
    expect(tabletDrawerStore.get()).toEqual({ phase: 'open', progress: 1 })
    expect(uiStore.get().floatingChrome).toBe(1)
  })

  it('a close while the capture is still in flight drops the open', async () => {
    const opened = openTabletDrawer('a')
    closeTabletDrawer()
    resolveCapture?.('data:image/jpeg;base64,AAAA')
    await opened
    settle()
    expect(tabletDrawerStore.get()).toEqual({ phase: 'closed', progress: 0 })
    expect(uiStore.get().floatingChrome).toBe(0)
  })

  it('is dismissed without motion when the layout changes under it (TABLET-08)', async () => {
    await openAndLand()
    dismissTabletDrawer()
    expect(tabletDrawerStore.get()).toEqual({ phase: 'closed', progress: 0 })
    expect(uiStore.get().floatingChrome).toBe(0)
    expect(frames).toHaveLength(0)
  })
})

describe('the tablet drawer as a back surface', () => {
  it('registers while it is up and is taken off once it has gone', async () => {
    expect(topBackSurface()?.name).not.toBe('tablet-drawer')
    await openAndLand()
    expect(topBackSurface()?.name).toBe('tablet-drawer')
    closeTabletDrawer()
    // Still up while leaving: a second back press must not fall through to the page.
    expect(topBackSurface()?.name).toBe('tablet-drawer')
    settle()
    expect(topBackSurface()?.name).not.toBe('tablet-drawer')
  })

  it('follows the predictive gesture and commits on the spring', async () => {
    await openAndLand()
    expect(dispatchBackEvent('start', { edge: 'left' })).toBe(true)
    dispatchBackEvent('progress', { progress: 0.4 })
    expect(tabletDrawerStore.get()).toEqual({ phase: 'dragging', progress: 0.6 })
    dispatchBackEvent('commit')
    expect(tabletDrawerStore.get().phase).toBe('settling')
    settle()
    expect(tabletDrawerStore.get()).toEqual({ phase: 'closed', progress: 0 })
    expect(uiStore.get().floatingChrome).toBe(0)
  })

  it('springs back in when the gesture is cancelled', async () => {
    await openAndLand()
    dispatchBackEvent('start', { edge: 'left' })
    dispatchBackEvent('progress', { progress: 0.7 })
    expect(tabletDrawerStore.get().progress).toBeCloseTo(0.3)
    dispatchBackEvent('cancel')
    settle()
    expect(tabletDrawerStore.get()).toEqual({ phase: 'open', progress: 1 })
    expect(uiStore.get().floatingChrome).toBe(1)
  })

  it('a plain back press closes it', async () => {
    await openAndLand()
    expect(dispatchBackEvent('commit')).toBe(true)
    settle()
    expect(tabletDrawerStore.get().phase).toBe('closed')
  })
})

describe('what takes the tablet drawer down', () => {
  it('the URL bar opening over it', async () => {
    await openAndLand()
    uiStore.set({ urlbar: { ...uiStore.get().urlbar, open: true } })
    expect(tabletDrawerStore.get()).toEqual({ phase: 'closed', progress: 0 })
    expect(uiStore.get().floatingChrome).toBe(0)
  })

  it('an overlay opening over it', async () => {
    await openAndLand()
    uiStore.set({ overlay: 'settings' })
    expect(tabletDrawerStore.get().phase).toBe('closed')
    expect(uiStore.get().floatingChrome).toBe(0)
  })

  it('the tab overview pulled down from the toolbar (GN-27)', async () => {
    await openAndLand()
    openOverview(state())
    expect(stageStore.get().overview.phase).not.toBe('closed')
    expect(tabletDrawerStore.get().phase).toBe('closed')
    expect(uiStore.get().floatingChrome).toBe(0)
  })
})
