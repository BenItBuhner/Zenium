import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { DevtoolsDock, Space, Tab, UIState } from '@shared/types'
import {
  DESKTOP_CONTENT_RADIUS,
  PHONE_CONTENT_RADIUS,
  contentRadius,
  devtoolsDockedInFrame
} from '../contentRadius'

/*
 * The frame's radius under a docked developer toolbox (design language v2 §9.29). The host docks
 * the toolbox inside the page's own view and can round only the page layer of it, never the
 * toolbox's, so the frame yields to a square box while a toolbox stands docked on a page the
 * window shows – and to nothing else: an undocked toolbox is a window of its own, a toolbox on a
 * tab out of view is not in the frame.
 */

const tab = (id: string, splitGroupId: string | null = null): Tab =>
  ({ id, spaceId: 's1', containerId: 'default', url: 'https://example.com', splitGroupId }) as Tab

function state(patch: {
  activeTabId?: string
  devtoolsOpenFor?: string[]
  devtoolsDock?: DevtoolsDock
  borderless?: boolean
  fullscreen?: boolean
  split?: boolean
}): UIState {
  const split = patch.split ?? false
  const space = {
    id: 's1',
    name: 'Work',
    containerId: 'default',
    tabIds: ['a', 'b', 'c'],
    activeTabId: patch.activeTabId ?? 'a'
  } as unknown as Space
  return {
    platform: 'electron',
    tabs: {
      a: tab('a', split ? 'g1' : null),
      b: tab('b', split ? 'g1' : null),
      c: tab('c')
    },
    spaces: [space],
    activeSpaceId: 's1',
    splitGroups: split
      ? {
          g1: { id: 'g1', spaceId: 's1', tabIds: ['a', 'b'], layout: 'vertical', sizes: [0.5, 0.5] }
        }
      : {},
    devtoolsOpenFor: patch.devtoolsOpenFor ?? [],
    settings: {
      ...DEFAULT_SETTINGS,
      borderless: patch.borderless ?? false,
      devtoolsDock: patch.devtoolsDock ?? DEFAULT_SETTINGS.devtoolsDock
    },
    window: { kind: 'normal', fullscreen: patch.fullscreen ?? false, htmlFullscreenTabId: null }
  } as unknown as UIState
}

describe('the frame radius under a docked toolbox (v2 §9.29)', () => {
  it('is the pair’s outer 10 on the desktop and 14 on the phone, with no toolbox up', () => {
    expect(DESKTOP_CONTENT_RADIUS).toBe(10)
    expect(PHONE_CONTENT_RADIUS).toBe(14)
    expect(contentRadius(state({}), 'desktop')).toBe(10)
    expect(contentRadius(state({}), 'tablet')).toBe(10)
    expect(contentRadius(state({}), 'phone')).toBe(14)
    expect(devtoolsDockedInFrame(state({}))).toBe(false)
  })

  it('yields to a square box while the active tab’s toolbox is docked in the frame – bottom, right or left', () => {
    for (const dock of ['bottom', 'right', 'left'] as const) {
      const s = state({ devtoolsOpenFor: ['a'], devtoolsDock: dock })
      expect(devtoolsDockedInFrame(s)).toBe(true)
      expect(contentRadius(s, 'desktop')).toBe(0)
    }
  })

  it('keeps its radius for an undocked toolbox: that one is a window of its own', () => {
    const s = state({ devtoolsOpenFor: ['a'], devtoolsDock: 'undocked' })
    expect(devtoolsDockedInFrame(s)).toBe(false)
    expect(contentRadius(s, 'desktop')).toBe(10)
  })

  it('keeps its radius while the only toolbox open is on a tab out of view', () => {
    const s = state({ activeTabId: 'a', devtoolsOpenFor: ['c'] })
    expect(devtoolsDockedInFrame(s)).toBe(false)
    expect(contentRadius(s, 'desktop')).toBe(10)
  })

  it('counts every pane of the split on screen: a toolbox docked in the other pane squares the frame too', () => {
    const s = state({ activeTabId: 'a', devtoolsOpenFor: ['b'], split: true })
    expect(devtoolsDockedInFrame(s)).toBe(true)
    expect(contentRadius(s, 'desktop')).toBe(0)
    // The same toolbox with the split's tab out of view is not in the frame.
    expect(
      contentRadius(state({ activeTabId: 'c', devtoolsOpenFor: ['b'], split: true }), 'desktop')
    ).toBe(10)
  })

  it('has no radius borderless or fullscreen, toolbox or none, on every chassis', () => {
    for (const formFactor of ['desktop', 'tablet', 'phone'] as const) {
      expect(contentRadius(state({ borderless: true }), formFactor)).toBe(0)
      expect(contentRadius(state({ fullscreen: true }), formFactor)).toBe(0)
      expect(contentRadius(state({ borderless: true, devtoolsOpenFor: ['a'] }), formFactor)).toBe(0)
    }
  })

  it('reads a state that carries no toolbox fields yet as one with no toolbox up', () => {
    const bare = state({}) as unknown as {
      devtoolsOpenFor?: string[]
      settings: { devtoolsDock?: string }
    }
    delete bare.devtoolsOpenFor
    delete bare.settings.devtoolsDock
    expect(devtoolsDockedInFrame(bare as unknown as UIState)).toBe(false)
    expect(contentRadius(bare as unknown as UIState, 'desktop')).toBe(10)
  })
})
