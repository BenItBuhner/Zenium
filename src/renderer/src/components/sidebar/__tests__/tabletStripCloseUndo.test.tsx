// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Space, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

/*
 * The strip row's × on a touch layout – the tablet's sidebar – comes with Undo on the toast
 * (`TabItem.tsx` → `lib/closeUndo.ts`, §9.33; OS-40 part B, §9.23: on a touch host a page
 * objecting under a close is let go, so the toast's Undo is the protection "Leave site?" was,
 * as on the phone overview's cards). The desktop's × is as it was: a bare `tab.close`, its
 * page free to ask. The undo is a pass-through here, so the core's command reads the same.
 */

Object.assign(window, { zen: { invoke: async () => null, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))
vi.mock('@renderer/lib/closeUndo', () => ({
  closeWithUndo: vi.fn((request: { close: () => void }) => request.close())
}))

const { run } = await import('@renderer/lib/api')
const { closeWithUndo } = await import('@renderer/lib/closeUndo')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { defaultShortcuts } = await import('@shared/shortcuts')
const { SpacePanel } = await import('../SpacePanel')

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 'space',
    containerId: DEFAULT_CONTAINER_ID,
    url: `https://${id}.example/`,
    title: id.toUpperCase(),
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    progress: 0,
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
    blockedCount: 0,
    ...over
  } as Tab
}

function fixture(tabs: Tab[]): { state: UIState; space: Space } {
  const space: Space = {
    id: 'space',
    name: 'Home',
    icon: '',
    containerId: DEFAULT_CONTAINER_ID,
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId: tabs[0]?.id ?? null,
    pinnedCollapsed: false
  }
  const state = {
    platform: 'android',
    capabilities: { windowControls: false },
    window: { kind: 'synced', fullscreen: false, htmlFullscreenTabId: null },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [space],
    activeSpaceId: 'space',
    folders: {},
    liveFolders: {},
    splitGroups: {},
    essentialTabIds: [],
    foreignTabIds: [],
    agents: [],
    awayAgents: [],
    containers: [],
    media: [],
    boosts: [],
    extensions: [],
    bookmarks: [],
    downloads: [],
    downloadsProgress: { received: 0, total: 0, indeterminate: false, active: 0 },
    shortcuts: defaultShortcuts('linux', 'chrome'),
    blockedPopups: {},
    permissionRules: [],
    translate: { available: true, tabs: {} },
    securityPrompts: [],
    autofill: { prompts: [], picker: null },
    settings: {
      showTabSeparator: true,
      sidebarExpanded: true,
      sidebarSide: 'left',
      toolbarLayout: 'single',
      urlbarBehavior: 'normal',
      pinnedCloseBehavior: 'unload'
    }
  } as unknown as UIState
  return { state, space }
}

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): void {
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(el))
}

function closeOf(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-tab-id="${id}"] .zen-tab-close`)
  if (!el) throw new Error(`no × on ${id}`)
  return el
}

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  uiStore.set({ toasts: [], stripFocus: null })
  browserStore.set({ state: null })
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false, hover: true })
  vi.mocked(run).mockClear()
  vi.mocked(closeWithUndo).mockClear()
})

describe("the strip row's × (TabItem.tsx)", () => {
  it('on the tablet closes through the close family’s Undo: the tab, the tab the user is on, the settings, and the core’s tab.close', () => {
    const { state, space } = fixture([tab('a'), tab('b')])
    browserStore.set({ state })
    // After the state: the store's change refreshes the viewport from the window's chrome.
    viewportStore.set({ ...viewportStore.get(), formFactor: 'tablet', coarse: true, hover: false })
    render(<SpacePanel state={state} space={space} isActive compact={false} />)
    act(() => closeOf('b').click())
    expect(vi.mocked(closeWithUndo)).toHaveBeenCalledTimes(1)
    const request = vi.mocked(closeWithUndo).mock.calls[0][0]
    expect(request.tabs.map((t) => t.id)).toEqual(['b'])
    expect(request.activeTabId).toBe('a')
    expect(request.settings).toBe(state.settings)
    expect(vi.mocked(run).mock.calls).toEqual([['tab.close', { tabId: 'b' }]])
  })

  it('on the desktop closes as it always has: a bare tab.close, no undo of the chrome’s', () => {
    const { state, space } = fixture([tab('a'), tab('b')])
    browserStore.set({ state })
    render(<SpacePanel state={state} space={space} isActive compact={false} />)
    act(() => closeOf('b').click())
    expect(vi.mocked(closeWithUndo)).not.toHaveBeenCalled()
    expect(vi.mocked(run).mock.calls).toEqual([['tab.close', { tabId: 'b' }]])
  })
})
