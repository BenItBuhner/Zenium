import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { DevtoolsDock, Space, Tab, UIState } from '@shared/types'
import {
  DESKTOP_CONTENT_RADIUS,
  PHONE_CONTENT_RADIUS,
  contentRadius,
  devtoolsDockOf,
  devtoolsDockedInFrame
} from '../contentRadius'

/*
 * The frame's radius under a docked developer toolbox (design language v2 §9.29). The host docks
 * the toolbox inside the page's own view and can round only the page layer of it, never the
 * toolbox's, so the frame yields to a square box while a toolbox stands docked on a page the
 * window shows – and to nothing else: an undocked toolbox is a window of its own, a toolbox on a
 * tab out of view is not in the frame. Each tab's toolbox is read where it stands
 * (`Tab.devtools`, the host's read-back per view): the frame follows the toolbox in front.
 */

const tab = (id: string, splitGroupId: string | null = null, dock?: DevtoolsDock): Tab =>
  ({
    id,
    spaceId: 's1',
    containerId: 'default',
    url: 'https://example.com',
    splitGroupId,
    ...(dock ? { devtools: { dock } } : {})
  }) as Tab

function state(patch: {
  activeTabId?: string
  devtoolsOpenFor?: string[]
  devtoolsDock?: DevtoolsDock
  /** Where each tab's own toolbox stands (`Tab.devtools`); tabs not named carry none. */
  devtools?: Partial<Record<'a' | 'b' | 'c', DevtoolsDock>>
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
      a: tab('a', split ? 'g1' : null, patch.devtools?.a),
      b: tab('b', split ? 'g1' : null, patch.devtools?.b),
      c: tab('c', null, patch.devtools?.c)
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

  describe('follows the toolbox in the tab in front, where each tab carries its own dock', () => {
    it('tab A docked at the bottom and tab B undocked: switching tabs switches the frame’s shape', () => {
      const both: Parameters<typeof state>[0] = {
        devtoolsOpenFor: ['a', 'b'],
        devtools: { a: 'bottom', b: 'undocked' }
      }
      const onA = state({ ...both, activeTabId: 'a' })
      const onB = state({ ...both, activeTabId: 'b' })
      expect(devtoolsDockOf(onA, 'a')).toBe('bottom')
      expect(devtoolsDockOf(onA, 'b')).toBe('undocked')
      expect(devtoolsDockOf(onA, 'c')).toBeNull()
      expect(devtoolsDockedInFrame(onA)).toBe(true)
      expect(contentRadius(onA, 'desktop')).toBe(0)
      expect(devtoolsDockedInFrame(onB)).toBe(false)
      expect(contentRadius(onB, 'desktop')).toBe(10)
    })

    it('reads the tab’s own dock over the setting: the setting is the default for the next opening alone', () => {
      // The setting says undocked (the user's last choice), A's toolbox still stands docked.
      const docked = state({
        devtoolsOpenFor: ['a'],
        devtoolsDock: 'undocked',
        devtools: { a: 'left' }
      })
      expect(devtoolsDockOf(docked, 'a')).toBe('left')
      expect(devtoolsDockedInFrame(docked)).toBe(true)
      // The setting says bottom, A's toolbox was undocked by its own button.
      const loose = state({
        devtoolsOpenFor: ['a'],
        devtoolsDock: 'bottom',
        devtools: { a: 'undocked' }
      })
      expect(devtoolsDockOf(loose, 'a')).toBe('undocked')
      expect(devtoolsDockedInFrame(loose)).toBe(false)
      expect(contentRadius(loose, 'desktop')).toBe(10)
    })

    it('reads a toolbox the host reports open but not where – the default applied on opening – at the setting', () => {
      const s = state({ devtoolsOpenFor: ['a'], devtoolsDock: 'right' })
      expect(devtoolsDockOf(s, 'a')).toBe('right')
      expect(devtoolsDockedInFrame(s)).toBe(true)
      const u = state({ devtoolsOpenFor: ['a'], devtoolsDock: 'undocked' })
      expect(devtoolsDockOf(u, 'a')).toBe('undocked')
      expect(devtoolsDockedInFrame(u)).toBe(false)
    })

    it('counts each pane of the split by its own toolbox', () => {
      // A's undocked, B's docked at the right in the other pane: the frame is square.
      const s = state({
        activeTabId: 'a',
        split: true,
        devtoolsOpenFor: ['a', 'b'],
        devtools: { a: 'undocked', b: 'right' }
      })
      expect(devtoolsDockedInFrame(s)).toBe(true)
      // Both undocked: whole.
      expect(
        devtoolsDockedInFrame(
          state({
            activeTabId: 'a',
            split: true,
            devtoolsOpenFor: ['a', 'b'],
            devtools: { a: 'undocked', b: 'undocked' }
          })
        )
      ).toBe(false)
    })

    it('reads a dock it does not know at the setting', () => {
      const s = state({ devtoolsOpenFor: ['a'], devtoolsDock: 'right' })
      ;(s.tabs.a as { devtools?: unknown }).devtools = { dock: 'sideways' }
      expect(devtoolsDockOf(s, 'a')).toBe('right')
    })
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
