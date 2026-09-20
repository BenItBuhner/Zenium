import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Space, Tab, UIState } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import { PRIVATE_THEME, blendResolvedThemes, resolveTheme } from '@shared/theme'
import { THEME_BLEND_MS } from '@renderer/hooks/useTheme'
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

describe('the theme blend (MOT-14, design language v2 §11.6)', () => {
  const space = resolveTheme(null, false)
  const privateTheme = resolveTheme(PRIVATE_THEME, true)
  const frameMs = 1000 / 60
  /** The blend's value frame by frame at 60 Hz: the time elapsed over its 240 ms, then 1. */
  const trace = Array.from({ length: 16 }, (_, i) => Math.min(1, (i * frameMs) / THEME_BLEND_MS))

  it('is one value over 240 ms, the colours landing exactly on the private theme at its end', () => {
    expect(THEME_BLEND_MS).toBe(240)
    const painted = trace.map((t) => blendResolvedThemes(space, privateTheme, t))
    expect(painted[0]).toBe(space)
    expect(painted[painted.length - 1]).toBe(privateTheme)
    // Every frame between is a colour of its own on the way: the solid colour's channels move one
    // way from the space theme's to the private theme's, none overshooting either end.
    const solids = painted.map((theme) => theme.averageColor)
    for (let channel = 0; channel < 3; channel++) {
      const values = solids.map((c) => c[channel]!)
      const lo = Math.min(space.averageColor[channel]!, privateTheme.averageColor[channel]!)
      const hi = Math.max(space.averageColor[channel]!, privateTheme.averageColor[channel]!)
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).toBeGreaterThanOrEqual(lo)
        expect(values[i]).toBeLessThanOrEqual(hi)
        if (space.averageColor[channel]! > privateTheme.averageColor[channel]!)
          expect(values[i]).toBeLessThanOrEqual(values[i - 1]!)
        else expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]!)
      }
    }
  })

  it('flips the polarity at the midpoint, 120 ms in, on the way there and on the way back', () => {
    const painted = trace.map((t) => blendResolvedThemes(space, privateTheme, t))
    const flip = painted.findIndex((theme) => theme.isDark)
    expect((flip - 1) * frameMs).toBeLessThan(120)
    expect(flip * frameMs).toBeGreaterThanOrEqual(120)
    const back = trace.map((t) => blendResolvedThemes(privateTheme, space, t))
    expect(back.findIndex((theme) => !theme.isDark)).toBe(flip)
    expect(back[back.length - 1]).toBe(space)
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
