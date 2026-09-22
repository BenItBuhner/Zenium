// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Space, Tab, UIState } from '@shared/types'
import type { PillGestureHandlers } from '../usePillGestures'

/*
 * The bar is one of the two elements the pill's focus motion writes its value on (MOT-07,
 * lib/omniboxFocus.ts; PERF-2's H3: written on the root the value had the whole chrome's style
 * recalculated every spring frame). The shell binds the bar element itself (`useOmniboxFocusBinding`
 * through `setBar`), and every bar-side reader in main.css – the row's items, the pill and its
 * words – is under it; the omnibox's layer is the other half, `phoneOmnibox.test.tsx`.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { PhoneBar } = await import('../PhoneShell')
const { omniboxFocusSurfaces } = await import('@renderer/lib/omniboxFocus')

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

const space: Space = {
  id: 'space',
  name: 'Work',
  icon: '',
  containerId: 'default',
  theme: null,
  tabIds: ['t1'],
  activeTabId: 't1',
  pinnedCollapsed: false
}

const state = {
  platform: 'android',
  capabilities: { windowControls: false },
  tabs: { t1: tab },
  spaces: [space],
  activeSpaceId: 'space',
  essentialTabIds: [],
  folders: [],
  settings: { ...DEFAULT_SETTINGS, phoneBarPosition: 'bottom' },
  window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
  boosts: [],
  extensions: [],
  bookmarks: [],
  translate: { available: true, tabs: {} }
} as unknown as UIState

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
  return mount
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
})

describe('the bar carries the focus motion’s value (MOT-07, PERF-2 H3)', () => {
  it('binds the bar element itself, with the row, its items and the pill under it, and releases it on unmount', () => {
    const el = render(
      <PhoneBar
        state={state}
        edge="bottom"
        pill={{} as PillGestureHandlers}
        overviewOpen={false}
        pillLook="docked"
      />
    )
    const bar = el.querySelector<HTMLElement>('.zen-phone-bar')!
    expect(omniboxFocusSurfaces()).toContain(bar)
    // The readers, all inside the bound element: nothing in the bar reads the fallback.
    expect(bar.querySelector('.zen-phone-bar-row > [data-bar-item]')).not.toBeNull()
    expect(bar.querySelector('.zen-phone-pill')).not.toBeNull()
    expect(bar.closest('html')).toBe(document.documentElement)
    act(() => root!.unmount())
    root = null
    expect(omniboxFocusSurfaces()).not.toContain(bar)
  })
})
