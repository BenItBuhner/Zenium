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
  emptyAutofillUIState,
  emptyPasswordsStatus,
  emptyResourceSnapshot
} from '@shared/defaults'
import { DEFAULT_PAGE_ENVIRONMENT } from '@shared/pageControls'
import { emptyPrivacyStatus } from '@shared/privacy'
import { emptySiteDataStatus } from '@shared/siteData'
import { DEFAULT_SEARCH_ENGINES } from '@shared/search'
import { UNAVAILABLE_SPELLCHECK } from '@shared/spellcheck'
import type { TranslateUIState } from '@shared/translate'
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
  darkenSites: true,
  privateTabs: false,
  secureDns: true,
  quitsThroughCore: true,
  newTabPage: true,
  pageTabs: true,
  pinShortcuts: false,
  printPreview: true,
  pdfViewer: false,
  translate: true,
  voiceSearch: false,
  screenCapture: true,
  shareSheet: true,
  selectionToolbar: false,
  popupSurface: true,
  qrScan: false,
  readAloud: true
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
  quitsThroughCore: false,
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

/** The translation engine with a registry and one model on the device (the Languages rows read it). */
const TRANSLATE: TranslateUIState = {
  available: true,
  preferences: {
    preferred: ['en'],
    alwaysTranslate: [],
    neverTranslate: [],
    neverTranslateSites: [],
    autoOffer: true
  },
  languages: ['de', 'en', 'es', 'fr'],
  installed: [
    { from: 'es', to: 'en', version: '1.0', bytes: 40_000_000, installed: true, downloading: false }
  ],
  downloading: [],
  registryDate: '2026-09-01',
  modelLicense: 'MPL-2.0',
  tabs: {}
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
    extensionUpdates: { lastCheckedAt: null, checking: false },
    mods: [],
    agents: [],
    agentServer: emptyAgentServerStatus(),
    updates: emptyUpdateStatus('0.3.0-test', { os: 'linux', arch: 'x64', kind: 'appimage' }),
    passwords: emptyPasswordsStatus(),
    autofill: emptyAutofillUIState(),
    defaultBrowser: { isDefault: false, prompt: null },
    sync: {
      enabled: false,
      folder: null,
      deviceId: 'device',
      deviceName: 'Test machine',
      scope: {
        spaces: true,
        folders: true,
        pinnedTabs: true,
        essentials: true,
        openTabs: false,
        containers: true,
        bookmarks: true,
        settings: true,
        shortcuts: true,
        boosts: true
      },
      lastSyncAt: null,
      lastError: null,
      syncing: false,
      devices: []
    },
    permissionRules: [],
    permissionDefaults: {},
    lastSafetyCheck: null,
    blocking: emptyBlockingStatus(),
    privacy: emptyPrivacyStatus(),
    pageEnvironment: DEFAULT_PAGE_ENVIRONMENT,
    siteData: emptySiteDataStatus(),
    newTabShortcuts: [],
    newTabBackground: { image: false, canPick: false },
    translate: TRANSLATE,
    spellcheck: UNAVAILABLE_SPELLCHECK
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
      'Autofill',
      'Languages',
      'Privacy and Security',
      'Space Routing',
      'Containers',
      'Boosts',
      'Mods',
      'Extensions',
      'AI Agents',
      'Passwords',
      'Security',
      '|',
      'Sync',
      'Import',
      'Accessibility',
      'Keyboard Shortcuts',
      'Default Browser',
      'Updates',
      '|',
      'About'
    ])
  })

  it('has Accessibility on the desktop for Read aloud alone: Chrome keeps zoom in the menu, and a host with no speech engine has no category', () => {
    const items = navItems(render(state()))
    expect(items.slice(0, 2)).toEqual(['Look and Feel', 'Compact Mode'])
    expect(items).toContain('Accessibility')
    const markup = render(state(DESKTOP, 'linux', {}, 'zen://settings/accessibility'))
    expect(markup).toContain('Read aloud')
    expect(markup).toContain('Voices')
    expect(markup).not.toContain('Page zoom')
    expect(markup).not.toContain('Default zoom')
    expect(navItems(render(state({ ...DESKTOP, readAloud: false })))).not.toContain('Accessibility')
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
    // A desktop without a speech engine has no Accessibility (neither page controls nor Read aloud).
    const markup = render(
      state({ ...DESKTOP, readAloud: false }, 'linux', {}, 'zen://settings/accessibility')
    )
    expect(markup).toMatch(
      /aria-current="page"[^>]*data-section="look"|data-section="look"[^>]*aria-current="page"/
    )
    expect(markup).not.toContain('Default zoom')
    expect(markup).not.toContain('Read aloud')
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
    const s = state(DESKTOP, 'linux', {}, 'zen://settings/shortcuts')
    s.shortcuts = [
      {
        id: 'zen-compact-mode-toggle',
        action: 'compact.toggle',
        group: 'zen-compact-mode',
        label: 'Toggle Compact Mode',
        binding: { ctrl: true, alt: true, shift: false, meta: false, key: 'c' },
        extraBindings: []
      }
    ]
    const markup = render(s)
    expect(markup).toContain(
      '<h2 id="zen-settings-section-title" class="zen-settings-section-title">Keyboard Shortcuts</h2>'
    )
    // The category is built like every other: the preset menulist, then one group per Zen group
    // with a `ShortcutRow` (its chord a button that records) for each shortcut.
    expect(markup).toContain('data-row="shortcut-preset"')
    expect(markup).toContain('Shortcut set')
    expect(markup).toContain('data-group="shortcuts-zen-compact-mode"')
    expect(markup).toContain('data-shortcut-id="zen-compact-mode-toggle"')
    expect(markup).toContain('zen-settings-chord')
    expect(markup).toContain('Ctrl + Alt + C')
    expect(markup).not.toContain('zen-settings-desktop-body')
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

/** Type `text` into a controlled input: the native value set behind React's tracker, then `input`. */
function type(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function key(el: HTMLElement, key: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

const findField = (el: HTMLElement): HTMLInputElement =>
  el.querySelector<HTMLInputElement>('.zen-settings-find input[role="searchbox"]')!

describe('Find in Settings (§10.5)', () => {
  it('is the 32 px field at the top of the content column, before the section title', () => {
    const markup = render(state())
    const column = markup.match(/<div class="zen-settings-content"[^>]*>([\s\S]*)/)?.[1] ?? ''
    const field = column.indexOf('placeholder="Find in Settings"')
    const title = column.indexOf('zen-settings-section-title')
    expect(field).toBeGreaterThan(-1)
    expect(field).toBeLessThan(title)
    expect(column).toMatch(/<div class="zen-settings-find">/)
    expect(column).toContain('class="zen-v2-field zen-settings-search-field"')
    // No clear button and no results without a query.
    expect(column).not.toContain('Clear search')
    expect(column).not.toContain('zen-settings-find-results')
  })

  it('takes Ctrl+F / "Find in Page" for the tab and focuses the field', async () => {
    const { offerChromeShortcut } = await import('@renderer/lib/chromeShortcuts')
    const el = mountPage(state())
    const field = findField(el)
    expect(document.activeElement).not.toBe(field)
    expect(offerChromeShortcut('find.open', { tabId: 'other', text: '' })).toBe(false)
    expect(document.activeElement).not.toBe(field)
    expect(offerChromeShortcut('find.open', { tabId: 'settings', text: '' })).toBe(true)
    expect(document.activeElement).toBe(field)
  })

  it('filters the open category in place and lists the other categories\u2019 matches under a caption', () => {
    const el = mountPage(state(DESKTOP, 'linux', {}, 'zen://settings/look'))
    const before = el.querySelectorAll('.zen-settings-pane [data-row]').length
    type(findField(el), 'tab')
    const results = el.querySelector<HTMLElement>('.zen-settings-find-results')
    expect(results).not.toBeNull()
    // The title stays; the open category's matching groups keep their headings and drop the
    // rows that do not match.
    expect(el.querySelector('.zen-settings-section-title')?.textContent).toBe('Look and Feel')
    const here = [...results!.querySelectorAll<HTMLElement>('.zen-settings-group[data-group]')]
    expect(here.length).toBeGreaterThan(0)
    const hereRows = here.flatMap((g) => [...g.querySelectorAll<HTMLElement>('[data-row]')])
    expect(hereRows.length).toBeGreaterThan(0)
    expect(hereRows.length).toBeLessThan(before)
    expect(hereRows.map((r) => r.dataset.row)).toContain('sidebar-expanded')
    for (const group of here) expect(group.querySelector('.zen-settings-heading')).not.toBeNull()
    // A row of the open category carries no caption; another category's carries its own.
    for (const group of here) expect(group.querySelector('.zen-settings-caption')).toBeNull()
    const other = el.querySelector<HTMLElement>('.zen-settings-other-categories')
    expect(other).not.toBeNull()
    expect(other!.querySelector('.zen-settings-heading')?.textContent).toBe('Other categories')
    const captions = [...other!.querySelectorAll('.zen-settings-caption')].map(
      (c) => c.textContent ?? ''
    )
    expect(captions.length).toBeGreaterThan(0)
    // "Category › Group", or the category alone over a group without a heading (an "Add a site"
    // action under a list).
    for (const caption of captions) expect(caption).toMatch(/^[A-Z][^›]+( › .+)?$/)
    expect(captions.some((c) => c.startsWith('Tab Management › '))).toBe(true)
    expect(captions.some((c) => c.startsWith('Look and Feel'))).toBe(false)
    // The rows are the desktop's (a menulist, not a picker chevron).
    expect(results!.querySelector('.zen-v2-menulist')).not.toBeNull()
  })

  it('says so when nothing matches anywhere', () => {
    const el = mountPage(state())
    type(findField(el), 'qzxv nothing')
    const status = el.querySelector('[role="status"]')
    expect(status?.textContent).toBe('No settings match “qzxv nothing”')
    expect(el.querySelector('.zen-settings-find-results')).toBeNull()
  })

  it('Escape clears the query and puts the category back; a second Escape leaves the field', () => {
    const el = mountPage(state())
    const field = findField(el)
    act(() => field.focus())
    type(field, 'engine')
    expect(el.querySelector('.zen-settings-find-results')).not.toBeNull()
    expect(el.querySelector('[aria-label="Clear search"]')).not.toBeNull()
    key(field, 'Escape')
    expect(field.value).toBe('')
    expect(el.querySelector('.zen-settings-find-results')).toBeNull()
    expect(el.querySelector('[data-group="appearance"]')).not.toBeNull()
    expect(document.activeElement).toBe(field)
    key(field, 'Escape')
    expect(document.activeElement).not.toBe(field)
  })

  it('the clear button restores the category and keeps the focus in the field', () => {
    const el = mountPage(state())
    type(findField(el), 'engine')
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Clear search"]')!.click())
    expect(findField(el).value).toBe('')
    expect(el.querySelector('.zen-settings-find-results')).toBeNull()
    expect(document.activeElement).toBe(findField(el))
  })

  it('choosing a category in the nav drops the query with it', () => {
    const el = mountPage(state())
    type(findField(el), 'engine')
    act(() =>
      el.querySelector<HTMLButtonElement>('.zen-settings-nav-item[data-section="search"]')!.click()
    )
    expect(invoke).toHaveBeenCalledWith('page.navigate', {
      tabId: 'settings',
      section: 'search',
      replace: true
    })
    expect(findField(el).value).toBe('')
    expect(el.querySelector('.zen-settings-find-results')).toBeNull()
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

describe('Privacy asked for a site (zen://settings/privacy?site=<origin>)', () => {
  /** Settings opened from a site's information sheet: the site's tab is the opener. */
  function fromSheet(url: string): UIState {
    const s = state(ANDROID, 'android', {}, url)
    s.tabs.site = tab('https://news.example/story', { id: 'site', blockedCount: 3 })
    s.tabs.settings = { ...s.tabs.settings!, openerTabId: 'site' }
    return s
  }

  it('opens the drill-in with the site’s group on screen: "Block on <host>" scrolled to the top', () => {
    viewport(TWO_PANE_MIN_WIDTH - 1, false)
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    const el = mountPage(fromSheet('zen://settings/privacy?site=https%3A%2F%2Fnews.example'))
    const row = el.querySelector('[data-row="tracking-site-current"]')!
    expect(row.textContent).toContain('Block on news.example')
    expect(scrolled).toHaveBeenCalledTimes(1)
    const target = scrolled.mock.instances[0] as Element
    expect(target).toBe(row.closest('[data-group]'))
    expect(target.getAttribute('data-group')).toBe('tracking-exceptions')
    expect(scrolled).toHaveBeenCalledWith({ block: 'start' })
    scrolled.mockRestore()
  })

  it('opens the two-pane content column the same way, and the section alone at the top', () => {
    viewport(TWO_PANE_MIN_WIDTH, false)
    viewportStore.set({ ...viewportStore.get(), formFactor: 'tablet' })
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    mountPage(fromSheet('zen://settings/privacy?site=https%3A%2F%2Fnews.example'))
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect((scrolled.mock.instances[0] as Element).getAttribute('data-group')).toBe(
      'tracking-exceptions'
    )
    act(() => root!.unmount())
    root = null
    // The section reached from the landing or the nav (no `site`): nothing is scrolled to.
    mountPage(fromSheet('zen://settings/privacy'))
    expect(scrolled).toHaveBeenCalledTimes(1)
    scrolled.mockRestore()
  })
})
