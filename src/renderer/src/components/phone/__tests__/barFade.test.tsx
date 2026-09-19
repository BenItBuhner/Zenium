// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Space, Tab, UIState } from '@shared/types'
import { barFade } from '@renderer/lib/motion/recede'
import type { PillGestureHandlers } from '../usePillGestures'

/*
 * The bar under a sheet, at either dock (design language v2 draft §11.1, ruled 23:50): the bar
 * docked at the bottom edge – where the sheet arrives – fades by `1 − p`, and the bar docked at
 * the top does not; it stays at 1, inert under the scrim and dimmed by it like the page. The
 * stylesheet's rule names the edge (`recede.test.ts`), so the bar must say which edge it is
 * docked at and write no opacity of its own at rest at either – a number inline would beat the
 * rule at the bottom (the review of #168 measured exactly that) and fade the bar at the top.
 * While its pill is carried the bar's own fade goes through `barFade`, which composes the recede
 * into it at the bottom edge only.
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

function stateDocked(edge: 'top' | 'bottom'): UIState {
  return {
    platform: 'android',
    capabilities: { windowControls: false },
    tabs: { t1: tab },
    spaces: [space],
    activeSpaceId: 'space',
    essentialTabIds: [],
    folders: [],
    settings: { ...DEFAULT_SETTINGS, phoneBarPosition: edge },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: [],
    // The pill reads the translate slice for its chip (an engine that is up, no tab offered).
    translate: { available: true, tabs: {} }
  } as unknown as UIState
}

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

const pillHandlers = {} as PillGestureHandlers

describe('the bar under a sheet, at either dock (§11.1)', () => {
  for (const edge of ['bottom', 'top'] as const) {
    it(`docked at the ${edge}: names its edge for the stylesheet, writes no opacity of its own at rest, and is chrome the sheet holds inert`, () => {
      const el = render(
        <PhoneBar
          state={stateDocked(edge)}
          edge={edge}
          pill={pillHandlers}
          overviewOpen={false}
          pillLook="docked"
        />
      )
      const bar = el.querySelector<HTMLElement>('.zen-phone-bar')!
      expect(bar.getAttribute('data-edge')).toBe(edge)
      // Nothing inline: the bottom-docked bar takes main.css's `1 − recede`, the top-docked
      // bar keeps the opacity the stylesheet leaves it, 1.
      expect(bar.style.opacity).toBe('')
      // Under the scrim it is inert with the rest of the chrome (`holdChromeInert`, §9.22).
      expect(bar.hasAttribute('data-shell-chrome')).toBe(true)
    })
  }

  it('a pill carry fades the bar by its own share, composed with the recede at the bottom edge only', () => {
    // The bar the pill leaves and the slot it heads for, as PhoneShell writes them mid-carry.
    const leaving = render(
      <PhoneBar
        state={stateDocked('bottom')}
        edge="bottom"
        pill={pillHandlers}
        overviewOpen={false}
        pillLook="well"
        style={{ opacity: barFade('bottom', 1 - 0.3) }}
      />
    ).querySelector<HTMLElement>('.zen-phone-bar')!
    expect(leaving.style.opacity).toBe(
      'calc((1 - var(--zen-recede, 0) * var(--zen-recede-gain, 1)) * 0.7000)'
    )
    act(() => root!.unmount())
    root = null
    const arriving = render(
      <PhoneBar
        state={stateDocked('bottom')}
        edge="top"
        pill={pillHandlers}
        overviewOpen={false}
        pillLook="well"
        inert
        style={{ opacity: barFade('top', 0.3) }}
      />
    ).querySelector<HTMLElement>('.zen-phone-bar')!
    expect(arriving.getAttribute('data-edge')).toBe('top')
    expect(Number(arriving.style.opacity)).toBe(0.3)
    expect(arriving.style.opacity).not.toContain('--zen-recede')
  })
})
