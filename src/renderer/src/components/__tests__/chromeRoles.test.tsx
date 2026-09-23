// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ExternalProtocolRequest, Folder, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

/*
 * The chrome's roles (parity matrix a11y-02; the WAI-ARIA patterns Chrome's chrome follows),
 * rendered for real in happy-dom: the sidebar as the complementary landmark with the tab strip
 * as its navigation landmark and the navigation row as a toolbar; the top toolbar as the banner
 * in the multiple-toolbar layout; each run of tab rows as a vertical tablist that holds tabs
 * alone, with the space, folder and separator controls between the lists rather than in one; a
 * row's own controls as buttons by role that take no focus (a `tab`'s children are
 * presentational, so a focusable one is a control the keyboard cannot name); a toast as a polite
 * status region; the external protocol dialog modal.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { run } = await import('@renderer/lib/api')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { defaultShortcuts } = await import('@shared/shortcuts')
const { Sidebar } = await import('../sidebar/Sidebar')
const { SidebarBottom } = await import('../sidebar/SidebarBottom')
const { SpacePanel } = await import('../sidebar/SpacePanel')
const { Toolbar } = await import('../Toolbar')
const { ExternalProtocolLayer } = await import('../protocol/ExternalProtocolSheet')

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

function folder(id: string, name: string, over: Partial<Folder> = {}): Folder {
  return {
    id,
    spaceId: 'space',
    name,
    icon: '📁',
    color: null,
    collapsed: false,
    ...over
  } as Folder
}

interface Fixture {
  tabs: Tab[]
  folders?: Folder[]
  essentials?: string[]
  activeTabId?: string
  separator?: boolean
  expanded?: boolean
}

function fixture({
  tabs,
  folders = [],
  essentials = [],
  activeTabId = tabs[0]?.id,
  separator = true,
  expanded = true
}: Fixture): { state: UIState; space: Space } {
  const space: Space = {
    id: 'space',
    name: 'Home',
    icon: '',
    containerId: DEFAULT_CONTAINER_ID,
    theme: null,
    // Essentials stand outside the space's own list.
    tabIds: tabs.filter((t) => !t.essential).map((t) => t.id),
    activeTabId: activeTabId ?? null,
    pinnedCollapsed: false
  }
  const state = {
    platform: 'linux',
    capabilities: { windowControls: false },
    // A synced window: the one with Essentials and spaces (a local window has neither).
    window: { kind: 'synced', fullscreen: false, htmlFullscreenTabId: null },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [space],
    activeSpaceId: 'space',
    folders: Object.fromEntries(folders.map((f) => [f.id, f])),
    liveFolders: {},
    splitGroups: {},
    essentialTabIds: essentials,
    foreignTabIds: [],
    agents: [],
    containers: [],
    media: [],
    boosts: [],
    extensions: [],
    bookmarks: [],
    downloads: [],
    downloadsProgress: { received: 0, total: 0, indeterminate: false, active: 0 },
    shortcuts: defaultShortcuts('linux', 'chrome'),
    blockedPopups: {},
    translate: { available: true, tabs: {} },
    securityPrompts: [],
    autofill: { prompts: [], picker: null },
    settings: {
      showTabSeparator: separator,
      sidebarExpanded: expanded,
      sidebarSide: 'left',
      toolbarLayout: 'single',
      urlbarBehavior: 'normal'
    }
  } as unknown as UIState
  return { state, space }
}

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(el))
  return mount!
}

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  uiStore.set({ toasts: [], externalProtocol: null, stripFocus: null })
  vi.mocked(run).mockClear()
})

const q = <T extends Element = HTMLElement>(selector: string, from: ParentNode = document): T => {
  const el = from.querySelector<T>(selector)
  if (!el) throw new Error(`missing ${selector}`)
  return el
}
const all = <T extends Element = HTMLElement>(
  selector: string,
  from: ParentNode = document
): T[] => [...from.querySelectorAll<T>(selector)]

/**
 * The elements a tablist owns, as ARIA (and axe's `aria-required-children`) sees them: every
 * element under it that has a role or a tabindex, stopping at each one found – a tab's own
 * children are its, not the list's. All of them must be tabs.
 */
function owned(list: Element): Element[] {
  const found: Element[] = []
  const walk = (el: Element): void => {
    for (const child of el.children) {
      if (child.hasAttribute('role') || child.hasAttribute('tabindex')) found.push(child)
      else walk(child)
    }
  }
  walk(list)
  return found
}

describe('the sidebar’s landmarks and its toolbar row (a11y-02)', () => {
  it('is the complementary landmark, with the navigation row as a toolbar and the strip as the Tabs navigation', () => {
    const { state } = fixture({
      tabs: [tab('a', { essential: true }), tab('b')],
      essentials: ['a']
    })
    browserStore.set({ state })
    render(<Sidebar state={state} isDark={false} />)
    const aside = q('aside[aria-label="Sidebar"]')
    const toolbar = q('[role="toolbar"]', aside)
    expect(toolbar.getAttribute('aria-label')).toBe('Toolbar')
    // Tab and F6 are the row's keyboard (§9.22), as in Chrome: the role asks nothing of the arrows.
    expect(toolbar.hasAttribute('aria-orientation')).toBe(false)
    expect(toolbar.getAttribute('data-pane')).toBe('toolbar')
    const nav = q('nav[aria-label="Tabs"]', aside)
    expect(nav.contains(toolbar)).toBe(false)
    // The strip's tablists – the Essentials tiles, the space's rows – are the navigation's.
    const lists = all('[role="tablist"]', aside)
    expect(lists.length).toBeGreaterThan(1)
    for (const list of lists) expect(nav.contains(list)).toBe(true)
    expect(q('[role="tablist"][aria-label="Essentials"]', nav)).toBeTruthy()
    // The New Tab row and the spaces row are the strip's neighbours, not its tabs.
    expect(q('[data-new-tab]', nav)).toBeTruthy()
    expect(nav.contains(q('button[aria-label="New Space"]', aside))).toBe(false)
  })

  it('says the toolbar runs vertically when the sidebar is the icon rail', () => {
    const { state } = fixture({ tabs: [tab('a')], expanded: false })
    browserStore.set({ state })
    render(<Sidebar state={state} isDark={false} />)
    expect(q('[role="toolbar"]').getAttribute('aria-orientation')).toBe('vertical')
  })

  it('makes the top toolbar of the multiple-toolbar layout a header: the window’s banner', () => {
    const { state } = fixture({ tabs: [tab('a')] })
    browserStore.set({ state })
    const el = render(<Toolbar state={state} tab={state.tabs.a ?? null} />)
    const bar = q('[data-testid="toolbar"]', el)
    expect(bar.tagName).toBe('HEADER')
    expect(q('[role="toolbar"][aria-label="Toolbar"]', bar)).toBeTruthy()
  })
})

describe('the strip’s tablists (a11y-07, a11y-31, a11y-02)', () => {
  const strip = (): { state: UIState; space: Space } =>
    fixture({
      tabs: [
        tab('p1', { pinned: true }),
        tab('p2', { pinned: true }),
        tab('f1', { folderId: 'work' }),
        tab('f2', { folderId: 'work' }),
        tab('l1'),
        tab('l2', { audible: true })
      ],
      folders: [folder('work', 'Work')],
      activeTabId: 'l1'
    })

  it('are one vertical, named tablist per run of rows – pinned, a folder’s, the loose rows – holding tabs alone', () => {
    const { state, space } = strip()
    browserStore.set({ state })
    render(<SpacePanel state={state} space={space} isActive compact={false} />)
    const lists = all('[role="tablist"]')
    expect(lists.map((l) => l.getAttribute('aria-label'))).toEqual([
      'Home pinned tabs',
      'Work tabs',
      'Home tabs'
    ])
    for (const list of lists) {
      expect(list.getAttribute('aria-orientation')).toBe('vertical')
      const children = owned(list)
      expect(children.length).toBeGreaterThan(0)
      expect(children.every((el) => el.getAttribute('role') === 'tab')).toBe(true)
    }
    expect(all('[role="tab"]', lists[0]!).map((t) => t.getAttribute('aria-label'))).toEqual([
      'P1',
      'P2'
    ])
    expect(all('[role="tab"]', lists[1]!).map((t) => t.getAttribute('aria-label'))).toEqual([
      'F1',
      'F2'
    ])
    expect(all('[role="tab"]', lists[2]!).map((t) => t.getAttribute('aria-label'))).toEqual([
      'L1',
      'L2'
    ])
    expect(all('[role="tab"][aria-selected="true"]').map((t) => t.dataset.tabId)).toEqual(['l1'])
    // The keyboard's list is unchanged (lib/tabStrip.ts): the items in the order they are drawn.
    expect(all('[data-strip-item]').map((el) => el.dataset.stripItem)).toEqual([
      'header:space',
      'tab:p1',
      'tab:p2',
      'folder:work',
      'tab:f1',
      'tab:f2',
      'tab:l1',
      'tab:l2'
    ])
  })

  it('keep the space header, the folder header and the separator’s button between the lists, in none of them', () => {
    const { state, space } = strip()
    browserStore.set({ state })
    render(<SpacePanel state={state} space={space} isActive compact={false} />)
    const outside = [
      q('[data-strip-item="header:space"]'),
      q('[data-tab-folder="work"]'),
      q('button[title^="Clear unpinned tabs"]')
    ]
    for (const el of outside) expect(el.closest('[role="tablist"]')).toBeNull()
    expect(q('[data-strip-item="header:space"]').getAttribute('aria-expanded')).toBe('true')
    expect(q('[data-tab-folder="work"]').getAttribute('aria-expanded')).toBe('true')
    // The folder's rows are the list under its header, in its fold.
    const fold = q('[data-tab-folder="work"]').parentElement!
    expect(fold.classList.contains('zen-group-fold')).toBe(true)
    expect(q('[role="tablist"]', fold).getAttribute('aria-label')).toBe('Work tabs')
    // The drag's lists (lib/drag.ts) are the rows' parents: the loose rows' is the regular list.
    expect(q('[data-tab-list="regular"]').getAttribute('role')).toBe('tablist')
    expect(
      all(':scope > [data-tab-id]', q('[data-tab-list="regular"]')).map((r) => r.dataset.tabId)
    ).toEqual(['l1', 'l2'])
    expect(
      all(':scope > [data-tab-id]', q('[data-tab-list="pinned"]')).map((r) => r.dataset.tabId)
    ).toEqual(['p1', 'p2'])
  })

  it('has no list where there are no rows: a folded folder, a space whose tabs are all in folders', () => {
    const { state, space } = fixture({
      tabs: [tab('f1', { folderId: 'work' })],
      folders: [folder('work', 'Work', { collapsed: true })]
    })
    browserStore.set({ state })
    render(<SpacePanel state={state} space={space} isActive compact={false} />)
    expect(all('[role="tablist"]')).toEqual([])
    expect(document.querySelector('[data-tab-list]')).toBeNull()
    // A folded folder's block is its header alone: no empty list taking the column's gap.
    expect(q('[data-tab-folder="work"]').parentElement!.children).toHaveLength(1)
  })
})

describe('a row’s controls (§9.22)', () => {
  it('are buttons by role, named by their tooltips, that take no focus: nothing focusable stands inside a tab', () => {
    const { state, space } = fixture({
      tabs: [
        tab('a'),
        tab('b', { audible: true }),
        tab('c', { muted: true }),
        tab('d', { discarded: true })
      ]
    })
    browserStore.set({ state })
    render(<SpacePanel state={state} space={space} isActive compact={false} />)
    expect(all('[role="tab"] button')).toEqual([])
    expect(all('[role="tab"] [tabindex]')).toEqual([])
    const controls = all('[role="tab"] [role="button"]')
    expect(controls.length).toBeGreaterThanOrEqual(5)
    for (const control of controls) {
      expect(control.tagName).toBe('SPAN')
      expect(control.hasAttribute('tabindex')).toBe(false)
      expect(control.getAttribute('title')).toBeTruthy()
    }
    expect(q('[data-tab-id="a"] .zen-tab-close').getAttribute('title')).toBe('Close tab')
    expect(q('[data-tab-id="b"] .zen-tab-audio').getAttribute('aria-pressed')).toBe('false')
    expect(q('[data-tab-id="c"] .zen-tab-audio').getAttribute('aria-pressed')).toBe('true')
    expect(q('[data-tab-id="c"] .zen-tab-audio').getAttribute('title')).toBe('Unmute tab')
    expect(q('[data-tab-id="d"] .zen-tab-sleeping').getAttribute('aria-label')).toBe(
      'Sleeping – click to wake'
    )
  })

  it('take their own clicks: the close closes and the mute mutes, and neither activates the row', () => {
    const { state, space } = fixture({ tabs: [tab('a'), tab('b', { audible: true })] })
    browserStore.set({ state })
    render(<SpacePanel state={state} space={space} isActive compact={false} />)
    act(() => q('[data-tab-id="b"] .zen-tab-close').click())
    expect(vi.mocked(run)).toHaveBeenCalledWith('tab.close', { tabId: 'b' })
    act(() => q('[data-tab-id="b"] .zen-tab-audio').click())
    expect(vi.mocked(run)).toHaveBeenCalledWith('tab.toggleMute', { tabId: 'b' })
    expect(vi.mocked(run)).not.toHaveBeenCalledWith('tab.activate', expect.anything())
    // The glyph inside the control is the control's too.
    act(() =>
      q('[data-tab-id="a"] .zen-tab-close svg').dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      )
    )
    expect(vi.mocked(run)).toHaveBeenCalledWith('tab.close', { tabId: 'a' })
    expect(vi.mocked(run)).not.toHaveBeenCalledWith('tab.activate', expect.anything())
  })
})

describe('live regions and dialogs (a11y-02, a11y-32)', () => {
  it('reads a sidebar toast as a polite status region, its action a button', () => {
    const { state } = fixture({ tabs: [tab('a')] })
    browserStore.set({ state })
    uiStore.set({
      toasts: [
        {
          id: 1,
          message: 'Tab closed',
          kind: 'info',
          duration: 5000,
          action: { label: 'Undo', onPick: () => undefined }
        }
      ]
    })
    render(<SidebarBottom state={state} compact={false} isDark={false} />)
    const status = q('[role="status"]')
    expect(status.textContent).toContain('Tab closed')
    expect(q('button', status).textContent).toBe('Undo')
  })

  it('makes the external protocol panel a modal dialog named by its question', () => {
    act(() => viewportStore.set({ ...viewportStore.get(), coarse: false, formFactor: 'desktop' }))
    const request: ExternalProtocolRequest = {
      requestId: 'r1',
      url: 'mailto:ada@example.com',
      scheme: 'mailto',
      appName: 'Mail',
      site: 'example.com',
      canRemember: true
    }
    uiStore.set({ externalProtocol: request })
    render(<ExternalProtocolLayer />)
    const dialog = q('[role="dialog"]')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe('Open in Mail?')
  })
})
