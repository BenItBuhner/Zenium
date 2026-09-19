// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Space, Tab, UIState } from '@shared/types'
import type { PillGestureHandlers } from '../usePillGestures'

/*
 * Token families on the phone shell (design language v2 §9.29): the phone bar and the address
 * pill are window surfaces, so a chip or icon button inside them reads the window family from
 * `data-surface="window"` on its nearest surface root; the Settings page and its sheets are page
 * surfaces (`InternalPageHost`, `sheets.tsx`).
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { PhoneBar } = await import('../PhoneShell')

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
  bookmarks: []
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

describe('phone shell surfaces (§9.29)', () => {
  it('tags the bar and the pill as window surfaces, so their chips read the window family', () => {
    const pillHandlers = {} as PillGestureHandlers
    const el = render(
      <PhoneBar
        state={state}
        edge="bottom"
        pill={pillHandlers}
        overviewOpen={false}
        pillLook="docked"
      />
    )
    const bar = el.querySelector<HTMLElement>('.zen-phone-bar')!
    expect(bar.getAttribute('data-surface')).toBe('window')
    const pill = el.querySelector<HTMLElement>('[role="group"][aria-label="Address"]')!
    expect(pill.getAttribute('data-surface')).toBe('window')
    const chip = pill.querySelector<HTMLElement>('[data-site-info]')!
    expect(chip.closest('[data-surface]')).toBe(pill)
    // The bar's own buttons sit on the bar (in its row of controls).
    const button = bar.querySelector<HTMLElement>('.zen-phone-bar-row > button')!
    expect(button.closest('[data-surface]')).toBe(bar)
  })
})
