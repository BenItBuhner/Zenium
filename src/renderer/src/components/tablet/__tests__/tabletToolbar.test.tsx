// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Tab, UIState } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { defaultShortcuts } from '@shared/shortcuts'
import { viewportStore } from '@renderer/lib/formFactor'
import { contentAreaStore } from '@renderer/lib/ui'
import { dismissOverview, stageStore } from '@renderer/lib/gestures/stage'
import { TabletToolbar } from '../TabletToolbar'

/*
 * The tablet toolbar's tab-count button (TABLET-14; v2 §9.36): the second way into the overview
 * beside the row's pull-down (GN-27) – the phone bar's `Tabs (N)` item at the row's end, before
 * the menu, its badge filled and its pressed state on while the overview is up. Its accessible
 * name is a harness contract (`Tabs (N)`, `data-tablet-tabs`).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function tab(id: string, url: string): Tab {
  return {
    id,
    spaceId: 'space',
    containerId: 'default',
    url,
    title: id,
    canGoBack: false,
    canGoForward: false,
    loading: false,
    readerable: false,
    errorCode: null,
    blockedCount: 0,
    pinned: false,
    essential: false,
    folderId: null
  } as Tab
}

/** Enough of a snapshot for the whole row: three tabs in the space, the first active. */
function stateOf(): UIState {
  const tabs = [
    tab('a', 'https://a.example/'),
    tab('b', 'https://b.example/'),
    tab('c', 'https://c.example/')
  ]
  return {
    platform: 'android',
    capabilities: { windowControls: false },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [
      {
        id: 'space',
        name: 'Work',
        activeTabId: 'a',
        tabIds: tabs.map((t) => t.id),
        containerId: 'default',
        pinnedCollapsed: false
      }
    ],
    activeSpaceId: 'space',
    folders: {},
    essentialTabIds: [],
    settings: { urlbarBehavior: 'normal', sidebarSide: 'left' },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: [],
    downloads: [],
    downloadsProgress: { received: 0, total: 0, indeterminate: false, active: 0 },
    shortcuts: defaultShortcuts('linux', 'chrome'),
    blockedPopups: {},
    translate: { available: false, tabs: {} },
    securityPrompts: [],
    autofill: { prompts: [], picker: null },
    permissionRules: [],
    media: []
  } as unknown as UIState
}

let root: Root | null = null
let mount: HTMLElement | null = null

function render(state: UIState): void {
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() =>
    root!.render(
      createElement(TabletToolbar, {
        state,
        tab: state.tabs.a ?? null,
        sidebarCollapsed: false,
        onToggleSidebar: () => undefined
      })
    )
  )
}

const rowButtons = (): string[] =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-zen-nav-row] > button')].map(
    (b) => b.getAttribute('aria-label') ?? b.title
  )
const tabsButton = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('[data-tablet-tabs]')

beforeEach(() => {
  viewportStore.set({ formFactor: 'tablet', width: 1280, height: 800, coarse: true, hover: false })
  contentAreaStore.set({ area: { x: 0, y: 56, width: 1280, height: 744 } })
})

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  act(() => dismissOverview())
  contentAreaStore.set({ area: null })
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
})

describe('the tablet toolbar’s tab-count button (TABLET-14)', () => {
  it('stands at the row’s end before the menu, named with the count, not pressed while the overview is closed', () => {
    render(stateOf())
    const button = tabsButton()
    expect(button).not.toBeNull()
    expect(button!.getAttribute('aria-label')).toBe('Tabs (3)')
    expect(button!.getAttribute('aria-pressed')).toBe('false')
    const names = rowButtons()
    expect(names.at(-1)!.startsWith('Menu')).toBe(true)
    expect(names.at(-2)).toBe('Tabs (3)')
    // The badge draws the count the name carries.
    expect(button!.textContent?.trim()).toBe('3')
  })

  it('a press opens the overview and reads pressed; the next press closes it', () => {
    const state = stateOf()
    render(state)
    expect(stageStore.get().overview.phase).toBe('closed')
    act(() => tabsButton()!.click())
    expect(stageStore.get().overview.phase).not.toBe('closed')
    expect(stageStore.get().overview.target).toBe(1)
    expect(tabsButton()!.getAttribute('aria-pressed')).toBe('true')
    // Landed open (the spring's end), the press closes it.
    act(() =>
      stageStore.set({ overview: { ...stageStore.get().overview, phase: 'open', progress: 1 } })
    )
    act(() => tabsButton()!.click())
    expect(stageStore.get().overview.target).toBe(0)
  })
})
