// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Space, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { viewportStore } from '@renderer/lib/formFactor'
import { browserStore, uiStore } from '@renderer/lib/ui'
import { Sidebar } from '../Sidebar'

/*
 * A double-click on the strip's empty room is the OS title bar's (tabs-47, shortcuts-menus-94):
 * the sidebar asks the core (`window.captionDoubleClick`), which maximises / restores on Windows
 * and Linux and follows the Mac's own setting; it no longer opens a tab (the New Tab row and its
 * chord do that). A row's double-click stays the row's.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 'work',
    containerId: DEFAULT_CONTAINER_ID,
    url: `https://${id}.example/`,
    title: `${id.toUpperCase()} PAGE`,
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
    ...over
  } as Tab
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

/** The desktop sidebar with the space `work`'s tabs. */
function sidebar(tabs: Tab[]): void {
  const space = {
    id: 'work',
    name: 'Work',
    icon: '',
    containerId: DEFAULT_CONTAINER_ID,
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId: tabs[0]?.id ?? null,
    pinnedCollapsed: false
  } as Space
  const state = {
    platform: 'linux',
    window: {
      id: 'w1',
      kind: 'synced',
      fullscreen: false,
      htmlFullscreenTabId: null,
      chrome: 'full',
      name: null
    },
    capabilities: { privateTabs: true, windowControls: true, windowControlsOverlay: false },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [space],
    activeSpaceId: 'work',
    folders: {},
    liveFolders: {},
    splitGroups: {},
    essentialTabIds: [],
    foreignTabIds: [],
    agents: [],
    containers: [],
    media: [],
    mods: [],
    settings: {
      showTabSeparator: false,
      sidebarExpanded: true,
      sidebarSide: 'left',
      toolbarLayout: 'multiple',
      containerSpecificEssentials: false
    }
  } as unknown as UIState
  browserStore.set({ state })
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false, hover: true })
  render(<Sidebar state={state} isDark={false} compact={false} navRow={false} />)
}

const q = <T extends HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)

function dblclick(target: Element | null): void {
  expect(target).not.toBeNull()
  act(() => {
    target!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  })
}

/** The commands the sidebar ran, by name. */
const ran = (): string[] => vi.mocked(run).mock.calls.map(([name]) => name as string)

let newTabRequests = 0
const hearNewTab = (): void => {
  newTabRequests += 1
}

beforeEach(() => {
  uiStore.set({ drag: null, selectedTabIds: [], renamingTabId: null })
  newTabRequests = 0
  window.addEventListener('zen-new-tab', hearNewTab)
})

afterEach(() => {
  window.removeEventListener('zen-new-tab', hearNewTab)
  act(() => root?.unmount())
  root = null
  mount?.remove()
  mount = null
  vi.mocked(run).mockClear()
})

describe('a double-click on the strip’s empty room', () => {
  it('asks the core for the title bar’s double-click from the room below the rows', () => {
    sidebar([tab('home'), tab('docs')])
    dblclick(q('[data-tab-scroller][data-active="true"] [data-strip-empty]'))
    expect(ran()).toEqual(['window.captionDoubleClick'])
    expect(newTabRequests).toBe(0)
  })

  it('asks for it from the list’s own padding, where the scroller is the target', () => {
    sidebar([tab('home'), tab('docs')])
    dblclick(q('[data-tab-scroller][data-active="true"]'))
    expect(ran()).toEqual(['window.captionDoubleClick'])
    expect(newTabRequests).toBe(0)
  })

  it('leaves a row’s double-click to the row', () => {
    sidebar([tab('home'), tab('docs')])
    dblclick(q('[data-testid="tab"][data-tab-id="docs"]'))
    expect(ran()).not.toContain('window.captionDoubleClick')
  })
})
