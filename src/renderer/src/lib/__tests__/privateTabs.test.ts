import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Space, Tab, UIState } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import { PRIVATE_THEME, blendResolvedThemes, resolveTheme } from '@shared/theme'
import { isAtRest, stepSpring } from '@shared/spring'
import { SPRING_THEME_BLEND } from '@renderer/hooks/useTheme'
import {
  activeTabIsPrivate,
  isPrivateTab,
  openInPrivateItems,
  overviewPane,
  pickOverviewPane,
  privateSurfaceActive,
  privateTabsOf,
  privateTabsStore,
  resetOverviewPane,
  sameModeAs,
  tabsOnPane
} from '../privateTabs'
import { tabOrderOf } from '../selectors'

function tab(id: string, patch: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 's1',
    containerId: 'default',
    url: `https://${id}.example`,
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
    webApp: null,
    ...patch
  }
}

const priv = { containerId: PRIVATE_CONTAINER_ID }

function stateWith(activeTabId: string): UIState {
  const space: Space = {
    id: 's1',
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: ['p1', 'r1', 'x1', 'r2', 'x2'],
    activeTabId,
    pinnedCollapsed: false
  }
  return {
    tabs: {
      p1: tab('p1', { pinned: true }),
      r1: tab('r1'),
      x1: tab('x1', priv),
      r2: tab('r2'),
      x2: tab('x2', priv)
    },
    essentialTabIds: [],
    spaces: [space],
    activeSpaceId: 's1',
    folders: {},
    settings: { containerSpecificEssentials: false }
  } as unknown as UIState
}

afterEach(() => resetOverviewPane())

describe('private tabs on the phone', () => {
  it('tells private tabs by the private container', () => {
    expect(isPrivateTab(tab('a'))).toBe(false)
    expect(isPrivateTab(tab('b', priv))).toBe(true)
    expect(privateTabsOf(stateWith('r1')).map((t) => t.id)).toEqual(['x1', 'x2'])
    expect(activeTabIsPrivate(stateWith('r1'))).toBe(false)
    expect(activeTabIsPrivate(stateWith('x1'))).toBe(true)
  })

  it('keeps the overview panes apart: private cards never show in the regular pane, nor the reverse', () => {
    const state = stateWith('r1')
    const order = tabOrderOf(state, state.spaces[0])
    expect(tabsOnPane(order, 'tabs').map((t) => t.id)).toEqual(['p1', 'r1', 'r2'])
    expect(tabsOnPane(order, 'private').map((t) => t.id)).toEqual(['x1', 'x2'])
  })

  it('keeps the swipe track in the mode it started in', () => {
    const state = stateWith('r1')
    const order = tabOrderOf(state, state.spaces[0])
    expect(sameModeAs(state.tabs.r1, order).map((t) => t.id)).toEqual(['p1', 'r1', 'r2'])
    expect(sameModeAs(state.tabs.x2, order).map((t) => t.id)).toEqual(['x1', 'x2'])
  })

  it('opens the overview on the pane of the tab in view until a segment is picked', () => {
    expect(overviewPane(stateWith('r1'))).toBe('tabs')
    expect(overviewPane(stateWith('x1'))).toBe('private')
    pickOverviewPane('private')
    expect(overviewPane(stateWith('r1'))).toBe('private')
    expect(privateTabsStore.get().pane).toBe('private')
    resetOverviewPane()
    expect(overviewPane(stateWith('r1'))).toBe('tabs')
  })

  it('stands on the private surface with a private tab in view or the private pane up', () => {
    expect(privateSurfaceActive(stateWith('x1'), false)).toBe(true)
    expect(privateSurfaceActive(stateWith('r1'), false)).toBe(false)
    // The open overview shows its pane, whichever tab is behind it.
    expect(privateSurfaceActive(stateWith('r1'), true, 'private')).toBe(true)
    expect(privateSurfaceActive(stateWith('x1'), true, 'tabs')).toBe(false)
    // Without a pick the pane is the tab's own.
    expect(privateSurfaceActive(stateWith('x1'), true)).toBe(true)
    expect(privateSurfaceActive(stateWith('r1'), true)).toBe(false)
  })
})

describe('the private theme blend (MOT-14)', () => {
  const space = resolveTheme(null, false)
  const privateTheme = resolveTheme(PRIVATE_THEME, true)

  /** The blend's spring frame by frame at 60 Hz: the value trace until it rests. */
  function run(from: number, to: number): number[] {
    let state = { x: from, v: 0 }
    const trace = [from]
    for (let i = 0; i < 600 && !isAtRest(state, to); i++) {
      state = stepSpring(state, to, 1 / 60, SPRING_THEME_BLEND)
      trace.push(state.x)
    }
    return trace
  }

  it('has the colours all but there about 240 ms after a private tab comes into view, without overshoot', () => {
    const trace = run(0, 1)
    const frameMs = 1000 / 60
    const arrived = trace.findIndex((t) => t >= 0.99) * frameMs
    expect(arrived).toBeGreaterThanOrEqual(150)
    expect(arrived).toBeLessThanOrEqual(250)
    // The spring formally rests a few invisible frames later, exactly on the private theme.
    const rest = (trace.length - 1) * frameMs
    expect(rest).toBeLessThanOrEqual(330)
    expect(Math.max(...trace)).toBeLessThanOrEqual(1.002)
    expect(trace[trace.length - 1]).toBe(1)
  })

  it('lands on the private theme and flips the polarity at the midpoint of the run', () => {
    const trace = run(0, 1)
    const painted = trace.map((t) => blendResolvedThemes(space, privateTheme, t))
    expect(painted[0]).toBe(space)
    expect(painted[painted.length - 1]).toBe(privateTheme)
    const flip = painted.findIndex((theme) => theme.isDark)
    expect(flip).toBeGreaterThan(0)
    expect(trace[flip]).toBeGreaterThanOrEqual(0.5)
    expect(trace[flip - 1]).toBeLessThan(0.5)
    // The way back runs on the same spring and ends on the space theme again.
    const back = run(1, 0)
    expect(blendResolvedThemes(space, privateTheme, back[back.length - 1])).toBe(space)
  })
})

describe('the "Open in Private Tab" row of the history and bookmark menus (INC-08)', () => {
  const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
  Object.assign(globalThis, { window: { zen: { invoke, on: () => () => undefined } } })

  afterEach(() => {
    invoke.mockClear()
  })

  it('is one row on a host with private tabs, none on a host without one or with nothing to open', () => {
    expect(openInPrivateItems({ privateTabs: false }, ['https://a.example/'])).toEqual([])
    expect(openInPrivateItems({ privateTabs: true }, [])).toEqual([])
    expect(openInPrivateItems({ privateTabs: true }, ['', ''])).toEqual([])
    const [one] = openInPrivateItems({ privateTabs: true }, ['https://a.example/'])
    expect(one.label).toBe('Open in Private Tab')
    const [all] = openInPrivateItems({ privateTabs: true }, [
      'https://a.example/',
      '',
      'https://b.example/'
    ])
    expect(all.label).toBe('Open All in Private (2)')
  })

  it('picked, it opens each address as a private tab through the core and then runs the follow-up', () => {
    const after = vi.fn()
    const [item] = openInPrivateItems(
      { privateTabs: true },
      ['https://a.example/', 'https://b.example/'],
      after
    )
    item.onSelect()
    expect(invoke.mock.calls).toEqual([
      ['tab.newPrivate', { url: 'https://a.example/' }],
      ['tab.newPrivate', { url: 'https://b.example/' }]
    ])
    expect(after).toHaveBeenCalledTimes(1)
  })
})
