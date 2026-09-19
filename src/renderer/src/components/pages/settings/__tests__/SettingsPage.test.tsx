// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Settings, Tab, UIState } from '@shared/types'
import { emptyBlockingStatus } from '@shared/blocking'
import {
  DEFAULT_CONTAINERS,
  DEFAULT_SETTINGS,
  emptyAgentServerStatus,
  emptyPasswordsStatus,
  emptyResourceSnapshot
} from '@shared/defaults'
import { DEFAULT_PAGE_ENVIRONMENT } from '@shared/pageControls'
import { DEFAULT_SEARCH_ENGINES } from '@shared/search'
import { emptyUpdateStatus } from '@shared/updates'

/*
 * The Settings tab where two panes fit (design language v2 §10.5; Zen's about:preferences): the
 * nav column with the gear and "Settings", the categories in Zen's order with the two hairlines,
 * the open one marked; the content column with the section's title first and its rows in the
 * desktop vocabulary (menulist, checkbox, inline field, button); the nav switching sections
 * through `page.navigate` with `replace: true`; and below 720 px of the page's own width the
 * phone landing and drill-in (§10.2).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { SettingsPage, TWO_PANE_MIN_WIDTH } = await import('../SettingsPage')
const { viewportStore } = await import('@renderer/lib/formFactor')

/** Electron's capabilities (`src/main/platform/index.ts`): no page controls on the desktop. */
const DESKTOP: HostCapabilities = {
  windowControls: true,
  windowControlsOverlay: false,
  windowMaterial: false,
  nativeMenus: true,
  windowDrag: true,
  devtools: true,
  compactReveal: true,
  pictureInPicture: true,
  viewSource: true,
  windows: true,
  extensions: true,
  resourceGovernor: true,
  sync: true,
  print: true,
  agents: true,
  updates: true,
  share: false,
  clipboardChip: false,
  appLinkSettings: false,
  pullToRefresh: false,
  passwords: true,
  defaultBrowser: true,
  requestBlocking: true,
  reducedExtensionIsolation: false,
  pageControls: false,
  privateTabs: false,
  secureDns: true,
  newTabPage: true,
  pageTabs: true,
  pinShortcuts: false
}

const ANDROID: HostCapabilities = {
  ...DESKTOP,
  windowControls: false,
  nativeMenus: false,
  windowDrag: false,
  devtools: false,
  compactReveal: false,
  pictureInPicture: false,
  viewSource: false,
  windows: false,
  extensions: false,
  resourceGovernor: false,
  sync: false,
  share: true,
  clipboardChip: true,
  appLinkSettings: true,
  pullToRefresh: true,
  pageControls: true,
  privateTabs: true,
  secureDns: false,
  newTabPage: false
}

function tab(url: string, patch: Partial<Tab> = {}): Tab {
  return {
    id: 'settings',
    spaceId: 'space',
    containerId: 'default',
    url,
    title: 'Settings',
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
    blockedCount: 0,
    openerTabId: null,
    ...patch
  } as Tab
}

function state(
  capabilities: HostCapabilities = DESKTOP,
  platform: UIState['platform'] = 'linux',
  settings: Partial<Settings> = {},
  url = 'zen://settings'
): UIState {
  const settingsTab = tab(url)
  return {
    platform,
    capabilities,
    version: '0.3.0-test',
    tabs: { settings: settingsTab },
    essentialTabIds: [],
    spaces: [{ id: 'space', name: 'Personal', activeTabId: 'settings', tabIds: ['settings'] }],
    activeSpaceId: 'space',
    containers: DEFAULT_CONTAINERS,
    folders: {},
    splitGroups: {},
    settings: { ...DEFAULT_SETTINGS, ...settings },
    shortcuts: [],
    searchEngines: DEFAULT_SEARCH_ENGINES,
    glance: null,
    compactSidebarRevealed: false,
    window: {
      id: 'w',
      kind: 'main',
      maximized: false,
      fullscreen: false,
      focused: true,
      htmlFullscreenTabId: null
    },
    downloads: [],
    bookmarks: [],
    recentlyClosedCount: 0,
    media: [],
    findResult: null,
    devtoolsOpenFor: [],
    resources: emptyResourceSnapshot(),
    foreignTabIds: [],
    windowCount: 1,
    boosts: [],
    zappingTabId: null,
    liveFolders: {},
    extensions: [],
    mods: [],
    agents: [],
    agentServer: emptyAgentServerStatus(),
    updates: emptyUpdateStatus('0.3.0-test', { os: 'linux', arch: 'x64', kind: 'appimage' }),
    passwords: emptyPasswordsStatus(),
    defaultBrowser: { isDefault: false, prompt: null },
    permissionRules: [],
    blocking: emptyBlockingStatus(),
    pageEnvironment: DEFAULT_PAGE_ENVIRONMENT,
    newTabShortcuts: [],
    newTabBackground: { image: false, canPick: false }
  } as unknown as UIState
}

/** A window of `width` with a mouse (`hover`), classified as the layout the width gives. */
function viewport(width: number, hover = true): void {
  viewportStore.set({
    ...viewportStore.get(),
    width,
    height: 1000,
    hover,
    coarse: !hover,
    formFactor: width >= TWO_PANE_MIN_WIDTH ? 'desktop' : 'phone'
  })
}

/** The page as static markup: `useLayoutEffect` never runs, so the window's width stands in. */
function render(s: UIState): string {
  return renderToStaticMarkup(createElement(SettingsPage, { state: s, tab: s.tabs.settings! }))
}

/** The labels of the nav column's items, in order, with `|` where a hairline sits. */
function navItems(markup: string): string[] {
  const nav = markup.match(/<nav[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? ''
  return Array.from(
    nav.matchAll(/<hr[^>]*>|<span class="zen-settings-nav-item-label">([^<]*)<\/span>/g),
    (m) => m[1] ?? '|'
  )
}

let root: Root | null = null
let mount: HTMLElement | null = null

function mountPage(s: UIState): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(createElement(SettingsPage, { state: s, tab: s.tabs.settings! })))
  return mount
}

beforeEach(() => {
  invoke.mockClear()
  viewport(1200)
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
})

describe('the two-pane Settings tab (§10.5)', () => {
  it('is the two-pane root marked settings-page, with the gear and "Settings" over the nav column', () => {
    const markup = render(state())
    expect(markup).toContain('data-layout="two-pane"')
    expect(markup).toContain('data-testid="settings-page"')
    expect(markup).toMatch(/<nav class="zen-settings-nav" aria-label="Settings categories">/)
    expect(markup).toMatch(/zen-settings-nav-title-glyph[\s\S]*?<h1>Settings<\/h1>/)
    expect(markup).not.toContain('zen-settings-landing')
    expect(markup).not.toContain('zen://')
  })

  it("lists the categories in Zen's order with the two hairlines, before Sync and before About", () => {
    expect(navItems(render(state()))).toEqual([
      'Look and Feel',
      'Compact Mode',
      'New Tab',
      'Tab Management',
      'Downloads',
      'Resources',
      'Search',
      'Privacy and Security',
      'Space Routing',
      'Containers',
      'Boosts',
      'Mods',
      'Extensions',
      'AI Agents',
      'Passwords',
      '|',
      'Sync',
      'Keyboard Shortcuts',
      'Default Browser',
      'Updates',
      '|',
      'About'
    ])
  })

  it('has no Accessibility category on the desktop, where Chrome keeps zoom in the menu', () => {
    const items = navItems(render(state()))
    expect(items).not.toContain('Accessibility')
    expect(items.slice(0, 2)).toEqual(['Look and Feel', 'Compact Mode'])
  })

  it('keeps Default Browser off a host that has no way to register (Android in two panes)', () => {
    const items = navItems(render(state(ANDROID, 'android')))
    expect(items).not.toContain('Default Browser')
    expect(items).toContain('Accessibility')
    // Compact Mode follows the layout, not the platform: a DeX desktop has a sidebar to hide.
    expect(items).toContain('Compact Mode')
  })

  it('shows the first category with its title first in the pane when the URL names none', () => {
    const markup = render(state())
    expect(markup).toContain('data-section="look"')
    expect(markup).toMatch(
      /<section[^>]*class="zen-settings-pane"[^>]*>\s*<h2 id="zen-settings-section-title" class="zen-settings-section-title">Look and Feel<\/h2>/
    )
    const active = markup.match(/<button[^>]*aria-current="page"[^>]*>/g) ?? []
    expect(active).toHaveLength(1)
    expect(active[0]).toContain('data-section="look"')
  })

  it("opens the section the tab's URL names and marks it in the nav", () => {
    const s = state(DESKTOP, 'linux', {}, 'zen://settings/privacy')
    const markup = render(s)
    expect(markup).toContain('data-section="privacy"')
    expect(markup).toContain(
      '<h2 id="zen-settings-section-title" class="zen-settings-section-title">Privacy and Security</h2>'
    )
    expect(
      markup.match(
        /aria-current="page"[^>]*data-section="privacy"|data-section="privacy"[^>]*aria-current="page"/
      )
    ).not.toBeNull()
  })

  it('falls back to the first category for a section this host does not have', () => {
    const markup = render(state(DESKTOP, 'linux', {}, 'zen://settings/accessibility'))
    expect(markup).toContain('data-section="look"')
    expect(markup).not.toContain('Default zoom')
  })

  it("keeps Chrome's Page zoom menulist and the per-site zooms under Look and Feel on the desktop", () => {
    const markup = render(
      state(DESKTOP, 'linux', {
        pageControls: { ...DEFAULT_SETTINGS.pageControls, siteZooms: { 'wikipedia.org': 1.25 } }
      })
    )
    expect(markup).toContain('Page zoom')
    expect(markup).toContain('Sites with their own zoom')
    expect(markup).toContain('wikipedia.org')
    expect(markup).toContain('125%')
    // The Android sheet's rows stay off the desktop.
    expect(markup).not.toContain('Default zoom')
    expect(markup).not.toContain('Desktop site')
  })

  it('draws the rows in the desktop vocabulary: menulists, checkboxes, no sheet chevrons', () => {
    const markup = render(state())
    // A value row trails its menulist (§9.13) rather than opening a picker sheet.
    expect(markup).toContain('zen-settings-control-row')
    expect(markup).toContain('zen-v2-menulist')
    // A boolean is the 16 px checkbox left of its label (§10.5), not the phone's switch.
    expect(markup).toContain('zen-v2-checkbox')
    expect(markup).not.toContain('zen-v2-switch')
    // No "Category › Group" captions and no results list without a search.
    expect(markup).not.toContain('zen-settings-results')
  })

  it("renders a desktop-only category's own content (Keyboard Shortcuts) under its title", () => {
    const markup = render(state(DESKTOP, 'linux', {}, 'zen://settings/shortcuts'))
    expect(markup).toContain(
      '<h2 id="zen-settings-section-title" class="zen-settings-section-title">Keyboard Shortcuts</h2>'
    )
    expect(markup).toContain('zen-settings-desktop-body')
  })
})

describe('switching categories', () => {
  it('replaces the URL through page.navigate without a history entry', () => {
    const el = mountPage(state())
    const privacy = el.querySelector<HTMLButtonElement>(
      '.zen-settings-nav-item[data-section="privacy"]'
    )
    expect(privacy).not.toBeNull()
    act(() => privacy!.click())
    expect(invoke).toHaveBeenCalledWith('page.navigate', {
      tabId: 'settings',
      section: 'privacy',
      replace: true
    })
  })

  it('a checkbox row patches its setting on the desktop', () => {
    const el = mountPage(state())
    const box = el.querySelector<HTMLInputElement>('[data-row="borderless"] input.zen-v2-checkbox')
    expect(box).not.toBeNull()
    expect(box!.checked).toBe(DEFAULT_SETTINGS.borderless)
    act(() => box!.click())
    expect(invoke).toHaveBeenCalledWith('settings.update', {
      borderless: !DEFAULT_SETTINGS.borderless
    })
  })
})

describe('below the two-pane width', () => {
  it('shows the phone landing and drill-in (§10.2) instead', () => {
    viewport(TWO_PANE_MIN_WIDTH - 1, false)
    const markup = render(state(ANDROID, 'android'))
    expect(markup).toContain('data-layout="phone"')
    expect(markup).toContain('zen-settings-landing')
    expect(markup).not.toContain('data-testid="settings-page"')
    expect(markup).not.toContain('zen-settings-nav"')
  })

  it('is the two-pane layout from exactly 720 px, on a touch host too', () => {
    viewport(TWO_PANE_MIN_WIDTH, false)
    viewportStore.set({ ...viewportStore.get(), formFactor: 'tablet' })
    const markup = render(state(ANDROID, 'android'))
    expect(markup).toContain('data-layout="two-pane"')
    expect(markup).toContain('data-testid="settings-page"')
  })
})
