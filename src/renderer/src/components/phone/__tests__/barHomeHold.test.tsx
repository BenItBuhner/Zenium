// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Rect, Tab } from '@shared/types'

/*
 * The bar's Home item held (TB-15: Chrome's long-press on its Home button opens the homepage
 * setting): Settings › Look and Feel opened on its Home group – the page asked for the Homepage
 * row (`?row=homepage`, the id `homepageGroup` gives the row in sections.tsx and the SET-36 /
 * NTP-30 suite pins), which the page lands on by scrolling the row's group to the top – not the
 * section's top with the group somewhere below. The dispatch is `barHold`, what `useBarHold`
 * calls once a hold has fired (its firing is barHoldRelease.test.tsx's); the other items keep
 * their surfaces: Tabs its quick menu, Back with history its popup, the rest the editor.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { barHold } = await import('../barHold')
const { uiStore } = await import('@renderer/lib/ui')

const tab: Tab = {
  id: 't1',
  spaceId: 'space',
  containerId: 'default',
  url: 'https://example.com/',
  title: 'Example',
  favicon: null,
  pinned: false,
  essential: false,
  pinnedUrl: null,
  customTitle: null,
  customIcon: null,
  windowId: null,
  folderId: null,
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

const rect: Rect = { x: 340, y: 860, width: 48, height: 48 }

const pageOpens = (): unknown[] =>
  invoke.mock.calls.filter(([name]) => name === 'page.open').map(([, args]) => args)

/** Let the openers' awaited work (the page snapshot before a sheet) finish. */
const flush = (): Promise<void> => act(async () => {})

beforeEach(() => {
  invoke.mockClear()
  uiStore.set({ barEditorOpen: false })
})

afterEach(() => {
  uiStore.set({ barEditorOpen: false })
})

describe('the bar’s Home item held (TB-15)', () => {
  it('opens Settings › Look and Feel on the Home group – the Homepage row asked for – and nothing else', async () => {
    barHold('home', rect, tab, 't1')
    expect(pageOpens()).toEqual([{ id: 'settings', section: 'look', query: { row: 'homepage' } }])
    await flush()
    expect(uiStore.get().barEditorOpen).toBe(false)
  })

  it('the other holds are theirs: the editor on the bar’s background and on a Back with nothing behind it, no Settings', async () => {
    barHold(null, rect, tab, 't1')
    await flush()
    expect(pageOpens()).toEqual([])
    expect(uiStore.get().barEditorOpen).toBe(true)
    uiStore.set({ barEditorOpen: false })
    barHold('back', rect, tab, 't1')
    await flush()
    expect(pageOpens()).toEqual([])
    expect(uiStore.get().barEditorOpen).toBe(true)
  })
})
