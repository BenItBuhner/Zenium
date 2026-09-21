// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { FormFactor, UIState } from '@shared/types'
import { cmd } from '@renderer/lib/api'
import { drawerStore, openSpacesDrawer } from '@renderer/lib/gestures/drawer'
import { dismissStage, openOverview, stageStore } from '@renderer/lib/gestures/stage'
import { browserStore, contentAreaStore, uiStore } from '@renderer/lib/ui'
import {
  dismissTabletDrawer,
  openTabletDrawer,
  tabletDrawerStore
} from '../../components/tablet/tabletChrome'
import { reconcileStageFor, useStageContinuity } from '../useStageContinuity'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => 'data:image/jpeg;base64,AAAA'),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

/*
 * TABLET-08: a window resized across the 600 dp line swaps its shell (phone <-> tablet) and the
 * transient chrome must come through the swap. The gesture stage (the overview) and the drawers
 * live in stores outside the shells; this hook decides what the NEXT layout cannot draw and
 * drops only that: the desktop has no stage and no Spaces drawer, the phone and the desktop have
 * no tablet sidebar drawer. Everything else stays where it is.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let frames: Array<(now: number) => void> = []
let now = 1000
const settle = (max = 600): void => {
  for (let i = 0; i < max && frames.length; i++) {
    now += 16
    const batch = frames
    frames = []
    for (const cb of batch) cb(now)
  }
}

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

const overviewUp = (): boolean => stageStore.get().overview.phase !== 'closed'
const spacesDrawerUp = (): boolean => drawerStore.get().phase !== 'closed'
const tabletDrawerUp = (): boolean => tabletDrawerStore.get().phase !== 'closed'

function Probe({ formFactor }: { formFactor: FormFactor }): null {
  useStageContinuity(formFactor)
  return null
}

let root: Root | null = null
let host: HTMLDivElement | null = null

function mount(formFactor: FormFactor): void {
  act(() => {
    root!.render(<Probe formFactor={formFactor} />)
  })
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
  browserStore.set({ state: state() })
  contentAreaStore.set({ area: { x: 0, y: 0, width: 600, height: 900 } })
  uiStore.set({ snapshot: null, snapshotTabId: null, floatingChrome: 0, drawerOpen: false })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  host?.remove()
  host = null
  dismissTabletDrawer()
  dismissStage()
  settle()
  browserStore.set({ state: null })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.mocked(cmd).mockClear()
})

describe('reconcileStageFor', () => {
  it('keeps the overview through a phone <-> tablet swap and drops it for the desktop', () => {
    openOverview(state())
    expect(overviewUp()).toBe(true)
    reconcileStageFor('tablet')
    expect(overviewUp()).toBe(true)
    reconcileStageFor('phone')
    expect(overviewUp()).toBe(true)
    reconcileStageFor('desktop')
    expect(overviewUp()).toBe(false)
  })

  it('keeps the Spaces drawer on both touch layouts and drops it for the desktop', async () => {
    await openSpacesDrawer('a')
    settle()
    expect(spacesDrawerUp()).toBe(true)
    expect(uiStore.get().drawerOpen).toBe(true)
    reconcileStageFor('phone')
    reconcileStageFor('tablet')
    expect(spacesDrawerUp()).toBe(true)
    reconcileStageFor('desktop')
    expect(spacesDrawerUp()).toBe(false)
    expect(uiStore.get().drawerOpen).toBe(false)
  })

  it('drops the tablet sidebar drawer for any layout but the tablet, without motion', async () => {
    await openTabletDrawer('a')
    settle()
    expect(tabletDrawerUp()).toBe(true)
    expect(uiStore.get().floatingChrome).toBe(1)
    reconcileStageFor('tablet')
    expect(tabletDrawerUp()).toBe(true)
    reconcileStageFor('phone')
    expect(tabletDrawerUp()).toBe(false)
    expect(uiStore.get().floatingChrome).toBe(0)
    // Nothing left animating: the drop is instant, the next shell draws a clean window.
    expect(frames).toHaveLength(0)
  })
})

describe('useStageContinuity', () => {
  it('carries the overview through the swaps and drops it only for the desktop', () => {
    openOverview(state())
    mount('tablet')
    expect(overviewUp()).toBe(true)

    // Narrowed into the phone chrome: the overview comes through.
    mount('phone')
    expect(overviewUp()).toBe(true)

    // Widened back: nothing to drop; the tablet shell picks the overview up where it is.
    mount('tablet')
    expect(overviewUp()).toBe(true)

    // A mouse arrives (DeX): the desktop has no stage.
    mount('desktop')
    expect(overviewUp()).toBe(false)
  })

  it('drops the tablet sidebar drawer as the window narrows into the phone chrome', async () => {
    // (The drawer and the overview never share the window: the overview's pull takes the drawer
    // down, so the two are carried across a swap one at a time.)
    await openTabletDrawer('a')
    settle()
    mount('tablet')
    expect(tabletDrawerUp()).toBe(true)
    mount('phone')
    expect(tabletDrawerUp()).toBe(false)
    expect(uiStore.get().floatingChrome).toBe(0)
  })

  it('does not touch the stage while the layout stays the same', () => {
    openOverview(state())
    mount('phone')
    const before = stageStore.get()
    mount('phone')
    expect(stageStore.get()).toBe(before)
    expect(overviewUp()).toBe(true)
  })
})
