// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Space, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

/*
 * The sidebar's own closes of a tab – the strip row's × and middle-click, the Essentials tile's
 * middle-click – go through the chrome's one close seam, `closeTabFromChrome`
 * (`lib/closeUndo.ts`, §9.33; OS-40 part B, §9.23): on a touch layout – the tablet's sidebar –
 * it comes with Undo on the toast, as on the phone overview's cards (on a touch host a page
 * objecting under a close is let go, so the toast's Undo is the protection "Leave site?" was);
 * on the desktop it is the bare `tab.close` it always was, its page free to ask. The seam's two
 * sides are pinned where it lives (`hooks/__tests__/closeUndoable.test.tsx`); here the
 * components are held to the seam, on either layout, so no close of theirs slips past it.
 */

Object.assign(window, { zen: { invoke: async () => null, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))
vi.mock('@renderer/lib/closeUndo', () => ({
  closeTabFromChrome: vi.fn()
}))

const { run } = await import('@renderer/lib/api')
const { closeTabFromChrome } = await import('@renderer/lib/closeUndo')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { defaultShortcuts } = await import('@shared/shortcuts')
const { SpacePanel } = await import('../SpacePanel')
const { Essentials } = await import('../Essentials')

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

function itemOf(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)
  if (!el) throw new Error(`no row or tile for ${id}`)
  return el
}

/** A middle-click as the browser delivers it: `auxclick` with the middle button. */
function middleClick(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))
  })
}

function tablet(): void {
  // After the state: the store's change refreshes the viewport from the window's chrome.
  viewportStore.set({ ...viewportStore.get(), formFactor: 'tablet', coarse: true, hover: false })
}

/** The seam was asked to close `id` once, with no args of the caller's, and nothing ran around it. */
function closedThroughSeam(id: string): void {
  expect(vi.mocked(closeTabFromChrome).mock.calls).toEqual([[id]])
  expect(vi.mocked(run).mock.calls.map(([name]) => name)).not.toContain('tab.close')
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
  vi.mocked(closeTabFromChrome).mockClear()
})

describe("the strip row's × and middle-click (TabItem.tsx)", () => {
  it('the × on the tablet closes through the chrome’s seam, which carries the Undo', () => {
    const { state, space } = fixture([tab('a'), tab('b')])
    browserStore.set({ state })
    tablet()
    render(<SpacePanel state={state} space={space} isActive compact={false} />)
    act(() => closeOf('b').click())
    closedThroughSeam('b')
  })

  it('the × on the desktop goes through the same seam, which there is the bare tab.close it always was', () => {
    const { state, space } = fixture([tab('a'), tab('b')])
    browserStore.set({ state })
    render(<SpacePanel state={state} space={space} isActive compact={false} />)
    act(() => closeOf('b').click())
    closedThroughSeam('b')
  })

  it('a middle-click on the row closes through the seam too (§9.23: the seventh path’s strip half)', () => {
    const { state, space } = fixture([tab('a'), tab('b')])
    browserStore.set({ state })
    tablet()
    render(<SpacePanel state={state} space={space} isActive compact={false} />)
    middleClick(itemOf('b'))
    closedThroughSeam('b')
  })
})

describe("the Essentials tile's middle-click (Essentials.tsx)", () => {
  it('closes through the chrome’s seam on the tablet', () => {
    const essential = tab('e', { essential: true })
    const { state } = fixture([essential, tab('a')])
    browserStore.set({ state: { ...state, essentialTabIds: ['e'] } as UIState })
    tablet()
    render(<Essentials essentials={[essential]} activeTabId={null} compact={false} />)
    middleClick(itemOf('e'))
    closedThroughSeam('e')
  })
})
