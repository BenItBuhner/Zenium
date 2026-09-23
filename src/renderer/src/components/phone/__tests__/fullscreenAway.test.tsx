// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Space, Tab, UIState } from '@shared/types'
import type { PillGestureHandlers } from '../usePillGestures'

/*
 * The phone bar around a page's fullscreen (MOT-32): the bar the shell mounts binds itself to
 * the motion (lib/fullscreenMotion.ts), so it carries `--zen-fullscreen-away` – the bar's way
 * off its edge – from the moment it mounts, whatever the motion stands at, and drops it as it
 * unmounts; the preview of the bar at the other edge, drawn during a carry, does not leave.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { PhoneBar } = await import('../PhoneShell')
const { fullscreenAwayStore, settleChromeAway } = await import('@renderer/lib/fullscreenMotion')

const tab = {
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

const VAR = '--zen-fullscreen-away'
const pillHandlers = {} as PillGestureHandlers

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
  return mount
}

function unmount(): void {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
}

afterEach(() => {
  unmount()
  settleChromeAway(false)
})

describe('the phone bar around a page’s fullscreen (MOT-32)', () => {
  it('carries the bar’s way off from the moment it mounts, and per change, and drops it as it goes', () => {
    // The chrome mounts while a page is fullscreen (a shell remount under the layer): the bar
    // is off at once, no frame of it in place first.
    settleChromeAway(true)
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
    expect(bar.style.getPropertyValue(VAR)).toBe('1.0000')
    expect(fullscreenAwayStore.get().phase).toBe('away')
    // The value is the bar's, never the root's (PERF-2's H3).
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe('')
    act(() => settleChromeAway(false))
    expect(bar.style.getPropertyValue(VAR)).toBe('')
    act(() => settleChromeAway(true))
    expect(bar.style.getPropertyValue(VAR)).toBe('1.0000')
    unmount()
    // Unbound with the unmount: a later frame writes nothing on the element that was.
    act(() => settleChromeAway(false))
    act(() => settleChromeAway(true))
    expect(bar.style.getPropertyValue(VAR)).toBe('')
  })

  it('the preview of the bar at the other edge does not leave', () => {
    settleChromeAway(true)
    const el = render(
      <PhoneBar
        state={state}
        edge="top"
        pill={pillHandlers}
        overviewOpen={false}
        pillLook="docked"
        inert
      />
    )
    const bar = el.querySelector<HTMLElement>('.zen-phone-bar')!
    expect(bar.style.getPropertyValue(VAR)).toBe('')
  })
})
