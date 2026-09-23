// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { NavigationHistoryEntry, Space, Tab, UIState } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'

/*
 * The Back button's hold (GN-08): the tab's history behind the current entry, nearest first,
 * eight rows at most, each a favicon and the title (the URL where the page had none), then
 * "Show full history" – left out on a private tab, as Chrome leaves it out of incognito. A row
 * jumps the tab to its entry; Escape and an empty stack close the popup. Rendered for real in
 * happy-dom through the chrome layer.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, {
  zen: {
    invoke,
    on: () => () => undefined
  }
})
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { BackHistoryMenu, HISTORY_MENU_MAX } = await import('../BackHistoryMenu')

const SPACE = 'space'
const ANCHOR = { x: 8, y: 700, width: 44, height: 44 }

function stateOf(containerId = 'default'): UIState {
  const tab = {
    id: 't',
    spaceId: SPACE,
    containerId,
    url: 'https://a.example/now',
    title: 'Now',
    favicon: null,
    pinned: false,
    essential: false,
    loading: false,
    canGoBack: true,
    canGoForward: false
  } as unknown as Tab
  const space: Space = {
    id: SPACE,
    name: 'Work',
    icon: '',
    containerId,
    theme: null,
    tabIds: [tab.id],
    activeTabId: tab.id,
    pinnedCollapsed: false
  }
  return {
    platform: 'android',
    capabilities: { windowControls: false, extensions: false, pageTabs: true, privateTabs: true },
    tabs: { [tab.id]: tab },
    spaces: [space],
    activeSpaceId: SPACE,
    folders: {},
    essentialTabIds: [],
    containers: [],
    settings: { ...DEFAULT_SETTINGS },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: [],
    recentlyClosed: []
  } as unknown as UIState
}

const STACK: NavigationHistoryEntry[] = [
  { index: 3, url: 'https://a.example/three', title: 'Three', favicon: 'data:image/png;base64,AA' },
  { index: 2, url: 'https://a.example/two', title: '', favicon: null },
  { index: 1, url: 'zen://settings', title: 'Settings', favicon: null }
]

let root: Root | null = null
let host: HTMLElement | null = null
const onClose = vi.fn()

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

async function show(rows: NavigationHistoryEntry[], state = stateOf()): Promise<void> {
  invoke.mockImplementation(async (name) => (name === 'tab.navigationHistory' ? rows : null))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      createElement(BackHistoryMenu, { state, anchor: ANCHOR, direction: 'back', onClose })
    )
  )
  await settle()
}

const popup = (): HTMLElement | null => document.querySelector('[data-testid="back-history-popup"]')
const rows = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-testid="back-history-entry"]'))

beforeEach(() => {
  invoke.mockClear()
  onClose.mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
})

describe('BackHistoryMenu', () => {
  it('asks for the stack behind the current entry, eight at most, and lists it nearest first', async () => {
    await show(STACK)
    expect(invoke).toHaveBeenCalledWith('tab.navigationHistory', {
      tabId: 't',
      direction: 'back',
      limit: HISTORY_MENU_MAX
    })
    expect(HISTORY_MENU_MAX).toBe(8)
    const menu = popup()
    expect(menu?.getAttribute('role')).toBe('menu')
    expect(menu?.getAttribute('aria-label')).toBe('Back history')
    expect(rows().map((r) => r.dataset.index)).toEqual(['3', '2', '1'])
  })

  it('shows the title, the URL where the page had none, and a favicon, glyph or globe', async () => {
    await show(STACK)
    const [three, two, settings] = rows()
    expect(three.textContent).toBe('Three')
    expect(three.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA')
    // Untitled: the URL as the user would see it, never the raw internal form.
    expect(two.textContent).toBe('a.example/two')
    expect(two.querySelector('.zen-histmenu-favicon-fallback')).not.toBeNull()
    expect(two.querySelector('img')).toBeNull()
    // An internal page carries its registered glyph, no image fetched (v2 §10.1).
    expect(settings.querySelector('img')).toBeNull()
    expect(settings.querySelector('svg.zen-histmenu-favicon')).not.toBeNull()
    expect(settings.querySelector('.zen-histmenu-favicon-fallback')).toBeNull()
  })

  it('jumps the tab to a tapped entry and closes', async () => {
    await show(STACK)
    act(() => rows()[1].click())
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('tab.goToIndex', { tabId: 't', index: 2 })
  })

  it('offers "Show full history" after a rule, opening the History page', async () => {
    await show(STACK)
    const full = document.querySelector<HTMLElement>('[data-testid="back-history-full"]')
    expect(full?.textContent).toBe('Show full history')
    expect(popup()?.querySelector('[role="separator"]')).not.toBeNull()
    act(() => full!.click())
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('page.open', { id: 'history', section: undefined })
  })

  it('leaves "Show full history" out on a private tab, as Chrome does in incognito', async () => {
    await show(STACK, stateOf(PRIVATE_CONTAINER_ID))
    expect(rows()).toHaveLength(3)
    expect(document.querySelector('[data-testid="back-history-full"]')).toBeNull()
    expect(popup()?.querySelector('[role="separator"]')).toBeNull()
  })

  it('closes on Escape', async () => {
    await show(STACK)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes at once when the stack has nothing behind the current entry', async () => {
    await show([])
    expect(popup()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
