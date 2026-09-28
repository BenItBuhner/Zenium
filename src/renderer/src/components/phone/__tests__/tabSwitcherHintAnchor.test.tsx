// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Space, Tab, UIState } from '@shared/types'
import type { PillGestureHandlers } from '../usePillGestures'

/*
 * The bar under a standing in-product help bubble (TB-19; PhoneShell.tsx, BarButton.tsx): the
 * bar carries the item the bubble is about for the stylesheet's pulse (`data-iph-anchor`,
 * §9.23's halo), and that item – the Tabs button – names the bubble as its description while it
 * stands (`aria-describedby` = `HINT_BUBBLE_ID`, the lead's (j) on #641); the other items carry
 * no description, an inert preview of the bar carries neither, and a bar with no bubble nothing.
 * Rendered for real in happy-dom.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Object.assign(window, { zen: { invoke: vi.fn(async () => null), on: () => () => undefined } })

const { PhoneBar } = await import('../PhoneShell')
const { HINT_BUBBLE_ID } = await import('@renderer/lib/iph')

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
  settings: {
    ...DEFAULT_SETTINGS,
    phoneBarPosition: 'bottom',
    phoneBar: { left: ['back'], right: ['tabs', 'menu'] }
  },
  window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
  boosts: [],
  extensions: [],
  bookmarks: [],
  translate: { available: true, tabs: {} }
} as unknown as UIState

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
}

const bar = (props: { iphAnchor?: 'tabs' | null; inert?: boolean }): ReactElement => (
  <PhoneBar
    state={state}
    edge="bottom"
    pill={{} as PillGestureHandlers}
    overviewOpen={false}
    pillLook="docked"
    {...props}
  />
)

const nav = (): HTMLElement => document.querySelector<HTMLElement>('nav.zen-phone-bar')!
const item = (id: string): HTMLElement =>
  nav().querySelector<HTMLElement>(`[data-bar-item="${id}"]`)!

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
})

describe('the bar under a standing hint bubble', () => {
  it('pulses the Tabs button and has it name the bubble as its description, the other items silent', () => {
    render(bar({ iphAnchor: 'tabs' }))
    expect(nav().dataset.iphAnchor).toBe('tabs')
    expect(item('tabs').getAttribute('aria-describedby')).toBe(HINT_BUBBLE_ID)
    expect(item('back').hasAttribute('aria-describedby')).toBe(false)
    expect(item('menu').hasAttribute('aria-describedby')).toBe(false)
  })

  it('drops both as the bubble goes: the description stands only while the bubble does', () => {
    render(bar({ iphAnchor: 'tabs' }))
    act(() => root!.render(bar({ iphAnchor: null })))
    expect(nav().dataset.iphAnchor).toBeUndefined()
    expect(item('tabs').hasAttribute('aria-describedby')).toBe(false)
  })

  it("gives an inert preview of the bar neither: the carry's copy is not the bubble's anchor", () => {
    render(bar({ iphAnchor: 'tabs', inert: true }))
    expect(nav().dataset.iphAnchor).toBeUndefined()
    expect(item('tabs').hasAttribute('aria-describedby')).toBe(false)
  })
})
