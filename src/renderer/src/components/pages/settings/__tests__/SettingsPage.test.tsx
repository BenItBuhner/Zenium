// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import axe from 'axe-core'
import type { HostCapabilities, Settings, Tab, UIState } from '@shared/types'
import { emptyBlockingStatus } from '@shared/blocking'
import {
  DEFAULT_CONTAINERS,
  DEFAULT_SETTINGS,
  emptyAgentServerStatus,
  emptyAgentSkillStatus,
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
  agentSkills: true,
  updates: true,
  share: false,
  sharePanel: false,
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
  inactiveTabs: false,
  secureDns: true,
  quitsThroughCore: true,
  lookalikeHolds: true,
  newTabPage: true,
  pageTabs: true,
  pinShortcuts: false,
  printPreview: true,
  savePageFormats: true,
  pdfViewer: false,
  translate: true,
  voiceSearch: false,
  screenCapture: true,
  shareSheet: true,
  selectionToolbar: false,
  popupSurface: true,
  qrScan: false,
  readAloud: true,
  pageLanguages: true,
  genericFontFamilies: true,
  caretBrowsing: true,
  placementAnswered: false
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
  sharePanel: false,
  clipboardChip: true,
  appLinkSettings: true,
  pullToRefresh: true,
  pageControls: true,
  privateTabs: true,
  inactiveTabs: true,
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
    extensionControls: {},
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
    readingList: [],
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
    webApps: [],
    agents: [],
    agentServer: emptyAgentServerStatus(),
    agentSkills: emptyAgentSkillStatus(),
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
    deviceGrants: [],
    lastSafetyCheck: null,
    blocking: emptyBlockingStatus(),
    privacy: emptyPrivacyStatus(),
    pageEnvironment: DEFAULT_PAGE_ENVIRONMENT,
    siteData: emptySiteDataStatus(),
    newTabShortcuts: [],
    newTabBackground: { image: false, canPick: false, accent: null },
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
      // W8-2: Chrome's Performance page (Memory Saver, Energy Saver) right after the tabs it sleeps.
      'Performance',
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
      // settings-70: Chrome's "Reset settings" at the foot of its list (W7-6).
      'Reset Settings',
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

  it('a checkbox row carries its tone, so a note under it takes the status ink', () => {
    // The Agent skill group's rows are the checkbox rows that carry one: an agent whose folder
    // could not be written keeps the failure sentence under its label in the danger ink – the
    // ink of a failure wherever it is said, the same as the status row's for it (the lead's #468
    // delta read) – and the rows with nothing to say carry no tone at all.
    const s = state(DESKTOP, 'linux', {}, 'zen://settings/agents')
    const sentence =
      'Could not install: something else is in the way at ~/.codex/skills/zenium-browser'
    const target = (
      id: string,
      label: string,
      installed: boolean,
      note: string | null
    ): UIState['agentSkills']['targets'][number] => ({
      id,
      label,
      dir: `~/.${id}/skills/zenium-browser`,
      detected: true,
      installed,
      installedVersion: installed ? s.version : null,
      note
    })
    s.agentSkills = {
      version: s.version,
      error: sentence,
      targets: [
        target('claude', 'Claude Code', true, null),
        target('codex', 'Codex', false, sentence)
      ]
    }
    const markup = render(s)
    expect(markup).toMatch(/<label data-row="skill:codex" data-tone="danger"/)
    expect(markup).toMatch(/<label data-row="skill:claude" class=/)
    expect(markup).not.toMatch(/<label data-row="skill:claude" data-tone/)
    expect(markup).toMatch(/data-row="skill-status"[^>]*data-tone="danger"/)
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

  it('spans the same 664 column the rows do, so their trailing controls end on its trailing edge (§10.3, §10.5)', () => {
    // The field sits 32 in from the column's edge (the find's 16 padding plus the search
    // wrapper's 16 margin) at the 664 content width; the pane gives its rows 664 between the
    // labels' edge and the controls' edge only when its box adds both margins – its own 16
    // padding and the rows' 16 gutter – per side. At 664 + 2 × 16 the controls stopped 32 short
    // of the field's end while the labels sat on its start.
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../../assets/main.css'),
      'utf8'
    )
    const rule = (selector: string): string => {
      const start = css.indexOf(`\n${selector} {`)
      expect(start, selector).toBeGreaterThan(-1)
      return css.slice(start, css.indexOf('\n}', start))
    }
    // The find's side padding is the 16; its top and bottom are the column's two custom
    // properties (16 and 8), which the column's scroll padding reads too.
    expect(rule('.zen-settings-find')).toMatch(
      /^ {2}padding: var\(--zen-settings-find-pad-top\) 16px var\(--zen-settings-find-pad-bottom\);$/m
    )
    expect(rule('.zen-settings-search')).toMatch(/^ {2}margin: 0 16px 8px;$/m)
    expect(rule('.zen-settings-find > .zen-settings-search')).toMatch(
      /^ {2}max-width: var\(--v2-content-max\);$/m
    )
    const pane = rule('.zen-settings-pane')
    expect(pane).toMatch(/^ {2}padding: 8px 16px 40px;$/m)
    expect(pane).toMatch(
      /^ {2}max-width: calc\(var\(--v2-content-max\) \+ 2 \* \(16px \+ 16px\)\);$/m
    )
    // The row primitive's gutter is the 16 the pane adds for it.
    expect(rule('.zen-v2-row')).toMatch(/^ {2}padding: var\(--v2-row-pad\) 16px;$/m)
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

describe('a section’s drill-in page (zen://settings/<section>/<page>, §10.2)', () => {
  const panes = (el: ParentNode): HTMLElement[] =>
    Array.from(el.querySelectorAll<HTMLElement>('.zen-settings-drill-in'))

  it('stands over its section on the phone layout: a second pane with the page’s title and "Back to <section>", the section’s pane inert under it and the landing under both', () => {
    viewport(TWO_PANE_MIN_WIDTH - 1, false)
    const el = mountPage(state(ANDROID, 'android', {}, 'zen://settings/privacy/site-data'))
    expect(el.querySelector('.zen-settings-phone')?.getAttribute('data-section')).toBe('privacy')
    expect(el.querySelector('.zen-settings-phone')?.getAttribute('data-page')).toBe('site-data')
    const [section, page] = panes(el)
    expect(panes(el)).toHaveLength(2)
    expect(section?.getAttribute('aria-label')).toBe('Privacy and Security')
    expect(section?.hasAttribute('inert')).toBe(true)
    expect(page?.getAttribute('aria-label')).toBe('Site data')
    expect(page?.hasAttribute('inert')).toBe(false)
    expect(page?.querySelector('.zen-settings-bar-title')?.textContent).toBe('Site data')
    expect(page?.querySelector('.zen-settings-back')?.getAttribute('aria-label')).toBe(
      'Back to Privacy and Security'
    )
    expect(page?.querySelector('[data-testid="site-data-page"]')).not.toBeNull()
    expect(el.querySelector('.zen-settings-landing')?.hasAttribute('inert')).toBe(true)
  })

  it('is reached from the section’s row: "See all site data and permissions" navigates the tab to the page rather than opening a sheet', () => {
    viewport(TWO_PANE_MIN_WIDTH - 1, false)
    const el = mountPage(state(ANDROID, 'android', {}, 'zen://settings/privacy'))
    expect(panes(el)).toHaveLength(1)
    const row = el.querySelector<HTMLButtonElement>('[data-row="site-data-see-all"]')!
    expect(row.getAttribute('aria-haspopup')).toBeNull()
    act(() => row.click())
    expect(invoke).toHaveBeenCalledWith('page.navigate', {
      tabId: 'settings',
      section: 'privacy',
      subpage: 'site-data'
    })
    expect(el.querySelector('[role="dialog"]')).toBeNull()
  })

  it('shows the section for the page’s address on the two-pane layout, where the row opens the viewer as a dialog (§10.5)', () => {
    viewport(TWO_PANE_MIN_WIDTH)
    const markup = render(state(DESKTOP, 'linux', {}, 'zen://settings/privacy/site-data'))
    expect(markup).toContain('data-layout="two-pane"')
    expect(markup).not.toContain('zen-settings-drill-in')
    expect(markup).not.toContain('data-testid="site-data-page"')
    // The row's control opens the dialog: the desktop row carries "See all…" as its button.
    expect(markup).toMatch(/data-row="site-data-see-all"[\s\S]*?aria-haspopup="dialog"/)
  })

  it('draws nothing over the section for a page its section does not name', () => {
    viewport(TWO_PANE_MIN_WIDTH - 1, false)
    const el = mountPage(state(ANDROID, 'android', {}, 'zen://settings/privacy/no-such-page'))
    expect(panes(el)).toHaveLength(1)
    expect(panes(el)[0]?.hasAttribute('inert')).toBe(false)
    expect(el.querySelector('.zen-settings-phone')?.hasAttribute('data-page')).toBe(false)
  })
})

describe('Languages’ Add language page (zen://settings/languages/add?list=<list>, §10.2, #350 ruling 3)', () => {
  const panes = (el: ParentNode): HTMLElement[] =>
    Array.from(el.querySelectorAll<HTMLElement>('.zen-settings-drill-in'))

  it('stands over Languages on the phone layout as the find-and-pick page for the list its address names', () => {
    viewport(TWO_PANE_MIN_WIDTH - 1, false)
    const el = mountPage(state(ANDROID, 'android', {}, 'zen://settings/languages/add?list=always'))
    expect(el.querySelector('.zen-settings-phone')?.getAttribute('data-page')).toBe('add')
    const [section, page] = panes(el)
    expect(panes(el)).toHaveLength(2)
    expect(section?.hasAttribute('inert')).toBe(true)
    expect(page?.querySelector('.zen-settings-bar-title')?.textContent).toBe('Add language')
    expect(page?.querySelector('.zen-settings-back')?.getAttribute('aria-label')).toBe(
      'Back to Languages'
    )
    const body = page?.querySelector<HTMLElement>('[data-testid="add-language-page"]')
    expect(body?.getAttribute('data-list')).toBe('always')
    // The field pinned first under the bar, the rows – the translator's languages less the
    // Always translate list – after it.
    expect(body?.firstElementChild?.querySelector('input[role="searchbox"]')).not.toBeNull()
    expect(body?.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe(
      'Always translate'
    )
    expect(
      [...(body?.querySelectorAll('[role="group"] > button .zen-settings-label') ?? [])].map(
        (l) => l.textContent
      )
    ).toEqual(['English', 'French', 'German', 'Spanish'])
    // No address for the list: the preferred list, the catalogue less what is on it.
    act(() => root!.unmount())
    root = null
    mount?.remove()
    const plain = mountPage(state(ANDROID, 'android', {}, 'zen://settings/languages/add'))
    const preferred = plain.querySelector<HTMLElement>('[data-testid="add-language-page"]')
    expect(preferred?.getAttribute('data-list')).toBe('preferred')
    expect(preferred?.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe(
      'Add language'
    )
    expect(preferred!.querySelectorAll('[role="group"] > button').length).toBeGreaterThan(150)
  })

  it('every Add row of the section opens the one page with its list in the address, no sheet', () => {
    viewport(TWO_PANE_MIN_WIDTH - 1, false)
    const el = mountPage(state(ANDROID, 'android', {}, 'zen://settings/languages'))
    expect(panes(el)).toHaveLength(1)
    for (const [rowId, list] of [
      ['languages-add', 'preferred'],
      ['languages-always-add', 'always'],
      ['languages-never-add', 'never']
    ]) {
      invoke.mockClear()
      const row = el.querySelector<HTMLButtonElement>(`[data-row="${rowId}"]`)!
      expect(row, rowId).not.toBeNull()
      expect(row.getAttribute('aria-haspopup')).toBeNull()
      act(() => row.click())
      expect(invoke).toHaveBeenCalledWith('page.navigate', {
        tabId: 'settings',
        section: 'languages',
        subpage: 'add',
        query: { list }
      })
      expect(el.querySelector('[role="dialog"]')).toBeNull()
    }
  })

  it('on the two-pane layout the address shows the section, and each Add row’s button opens the filtered dialog instead (§10.5)', () => {
    viewport(TWO_PANE_MIN_WIDTH)
    const markup = render(state(DESKTOP, 'linux', {}, 'zen://settings/languages/add?list=never'))
    expect(markup).toContain('data-layout="two-pane"')
    expect(markup).not.toContain('zen-settings-drill-in')
    expect(markup).not.toContain('data-testid="add-language-page"')
    for (const rowId of ['languages-add', 'languages-always-add', 'languages-never-add']) {
      expect(markup).toMatch(
        new RegExp(`data-row="${rowId}"[\\s\\S]*?aria-haspopup="dialog"[^>]*>Add…<`)
      )
    }
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

describe('a group is not a landmark (axe landmark-unique, the desktop’s #358)', () => {
  /**
   * axe's `landmark-unique` over the page: a `region` needs a name no other landmark of its role
   * shares, and a `<section>` named by its heading is one. The Search section's pane (the
   * desktop) and its drill-in (the phone) are regions named "Search"; its first group is headed
   * "Search" too, and as a region of that name it doubled them – the boot smoke's one moderate.
   */
  async function landmarkUnique(el: HTMLElement): Promise<string[]> {
    const results = await axe.run(el, {
      runOnly: { type: 'rule', values: ['landmark-unique'] },
      resultTypes: ['violations']
    })
    return results.violations.flatMap((v) => v.nodes.map((n) => String(n.target[0])))
  }

  it('the Search pane yields no landmark-unique finding: its groups are `group`s named by their headings, the pane the one region "Search"', async () => {
    viewport(TWO_PANE_MIN_WIDTH)
    const el = mountPage(state(DESKTOP, 'linux', {}, 'zen://settings/search'))
    const pane = el.querySelector('.zen-settings-pane')!
    expect(pane.getAttribute('aria-labelledby')).toBe('zen-settings-section-title')
    expect(el.querySelector('#zen-settings-section-title')?.textContent).toBe('Search')
    const groups = [...el.querySelectorAll<HTMLElement>('.zen-settings-group')]
    expect(groups.length).toBeGreaterThan(1)
    expect(groups[0]!.getAttribute('aria-label')).toBe('Search')
    for (const group of groups) expect(group.getAttribute('role')).toBe('group')
    // The one region of that name is the pane; nothing else on the page is a named region.
    expect(
      el.querySelectorAll('section[aria-label]:not([role]), section[aria-labelledby]:not([role])')
    ).toHaveLength(1)
    expect(await landmarkUnique(el)).toEqual([])
  })

  it('the Search drill-in on the phone the same: the drill-in is the region "Search", its groups are groups', async () => {
    viewport(TWO_PANE_MIN_WIDTH - 1, false)
    const el = mountPage(state(ANDROID, 'android', {}, 'zen://settings/search'))
    const drillIn = el.querySelector('.zen-settings-drill-in')!
    expect(drillIn.getAttribute('aria-label')).toBe('Search')
    const groups = [...drillIn.querySelectorAll<HTMLElement>('.zen-settings-group')]
    expect(groups[0]!.getAttribute('aria-label')).toBe('Search')
    for (const group of groups) expect(group.getAttribute('role')).toBe('group')
    expect(await landmarkUnique(el)).toEqual([])
  })
})

describe('the outline steps by one (axe heading-order; the phone’s pre-existing finding on #391)', () => {
  /** axe's `heading-order` over the page: every heading at most one level below the one before it. */
  async function headingOrder(el: HTMLElement): Promise<string[]> {
    const results = await axe.run(el, {
      runOnly: { type: 'rule', values: ['heading-order'] },
      resultTypes: ['violations']
    })
    return results.violations.flatMap((v) => v.nodes.map((n) => String(n.target[0])))
  }
  const levels = (el: ParentNode): string[] =>
    [...el.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => h.tagName.toLowerCase())

  it('the desktop: the page title h1, the section title h2, the groups h3', async () => {
    viewport(TWO_PANE_MIN_WIDTH)
    const el = mountPage(state(DESKTOP, 'linux', {}, 'zen://settings/search'))
    const outline = levels(el)
    expect(outline.slice(0, 3)).toEqual(['h1', 'h2', 'h3'])
    expect(new Set(outline)).toEqual(new Set(['h1', 'h2', 'h3']))
    for (const heading of el.querySelectorAll('.zen-settings-group > .zen-settings-heading'))
      expect(heading.tagName).toBe('H3')
    expect(await headingOrder(el)).toEqual([])
  })

  it('the phone: the landing’s h1, the drill-in bar’s h1, then the groups at h2 – no level skipped; the styles stay on the class', async () => {
    viewport(TWO_PANE_MIN_WIDTH - 1, false)
    const el = mountPage(state(ANDROID, 'android', {}, 'zen://settings/search'))
    const drillIn = el.querySelector<HTMLElement>('.zen-settings-drill-in')!
    expect(drillIn.querySelector('.zen-settings-bar-title')!.tagName).toBe('H1')
    const headings = [
      ...drillIn.querySelectorAll<HTMLElement>('.zen-settings-group > .zen-settings-heading')
    ]
    expect(headings.length).toBeGreaterThan(0)
    for (const heading of headings) {
      expect(heading.tagName).toBe('H2')
      expect(heading.classList.contains('zen-v2-heading')).toBe(true)
    }
    expect(new Set(levels(el))).toEqual(new Set(['h1', 'h2']))
    expect(await headingOrder(el)).toEqual([])
  })
})

describe('a section asked for one of its rows (zen://settings/<section>?row=<id>)', () => {
  /** A phone that syncs (`ANDROID` has no sync engine; the row asked for is Sync's). */
  const SYNCING_PHONE: HostCapabilities = { ...ANDROID, sync: true }

  it("opens Sync with the row's group on screen: the History page's Open sync settings row lands on the Open tabs switch", () => {
    viewport(TWO_PANE_MIN_WIDTH - 1, false)
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    const el = mountPage(
      state(SYNCING_PHONE, 'android', {}, 'zen://settings/sync?row=sync-scope%3AopenTabs')
    )
    const row = el.querySelector('[data-row="sync-scope:openTabs"]')!
    expect(row.textContent).toContain('Open tabs')
    expect(scrolled).toHaveBeenCalledTimes(1)
    const target = scrolled.mock.instances[0] as Element
    expect(target).toBe(row.closest('[data-group]'))
    expect(target.getAttribute('data-group')).toBe('sync-scope')
    expect(scrolled).toHaveBeenCalledWith({ block: 'start' })
    scrolled.mockRestore()
  })

  it('a row the section does not have, or an id that is not one, opens the section at the top', () => {
    viewport(TWO_PANE_MIN_WIDTH - 1, false)
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    mountPage(state(SYNCING_PHONE, 'android', {}, 'zen://settings/sync?row=no-such-row'))
    expect(scrolled).not.toHaveBeenCalled()
    act(() => root!.unmount())
    root = null
    mountPage(state(SYNCING_PHONE, 'android', {}, 'zen://settings/sync?row=%22%5D%2C%20*'))
    expect(scrolled).not.toHaveBeenCalled()
    scrolled.mockRestore()
  })
})

describe('a landing reaches the top of the column at a 1000 px window (the desktop’s #356)', () => {
  const SYNCING_PHONE: HostCapabilities = { ...ANDROID, sync: true }
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../../assets/main.css'),
    'utf8'
  )
  const rule = (selector: string): string => {
    const start = css.indexOf(`\n${selector} {`)
    expect(start, selector).toBeGreaterThan(-1)
    return css.slice(start, css.indexOf('\n}', start))
  }

  /*
   * happy-dom lays nothing out, so the column and the landed group take the desktop's #356
   * geometry at a 1000 px window: the content column's viewport 944 tall, 1113 of content –
   * 169 of scroll, the number the desktop measured – and Sync's Open tabs group (`sync-scope`)
   * starting 521 down the content, so that scrolled as far as the content allowed it stopped at
   * 352, mid-page. The desktop's column has the sticky find field's box as its scroll padding
   * (`main.css`'s declaration, pinned below; the stylesheet in `layout` carries its value:
   * 16 + 32 + 8 – a landed group lands flush under the field, the #553 lead check's N1); the
   * phone's column none. `scrollIntoView({ block: 'start' })` scrolls as Chrome would: to the
   * group's top less the padding, and no further than the content allows.
   */
  const VIEWPORT = 944
  const GROUP_TOP = 521
  const INSET = 56

  function layout(content: number): () => void {
    const isColumn = (el: Element): boolean =>
      el.classList.contains('zen-settings-content') || el.classList.contains('zen-settings-scroll')
    const pad = (column: Element): number =>
      parseFloat(
        column
          .closest<HTMLElement>('.zen-settings-page')
          ?.style.getPropertyValue('--zen-settings-landing-pad') ?? ''
      ) || 0
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return isColumn(this) ? VIEWPORT : 0
      })
    const scrollHeight = vi
      .spyOn(Element.prototype, 'scrollHeight', 'get')
      .mockImplementation(function (this: Element) {
        return isColumn(this) ? content + pad(this) : 0
      })
    const rect = Element.prototype.getBoundingClientRect
    const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      const column = this.closest<HTMLElement>('.zen-settings-content, .zen-settings-scroll')
      if (this.getAttribute('data-group') === 'sync-scope' && column) {
        return { ...rect.call(this), top: GROUP_TOP - column.scrollTop }
      }
      return rect.call(this)
    })
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (
      this: Element
    ) {
      const column = this.closest<HTMLElement>('.zen-settings-content, .zen-settings-scroll')!
      const top =
        this.getBoundingClientRect().top - column.getBoundingClientRect().top + column.scrollTop
      const inset = parseFloat(getComputedStyle(column).scrollPaddingTop) || 0
      column.scrollTop = Math.max(
        0,
        Math.min(top - inset, column.scrollHeight - column.clientHeight)
      )
    })
    // happy-dom leaves `calc()` unevaluated in a computed style, so the sheet carries the
    // declaration's value at the desktop's 32 control – 16 + 32 + 8; the pin below holds the
    // declaration itself.
    const sheet = document.createElement('style')
    sheet.textContent = `.zen-settings-content { scroll-padding-top: ${INSET}px; }`
    document.head.appendChild(sheet)
    return () => {
      clientHeight.mockRestore()
      scrollHeight.mockRestore()
      rects.mockRestore()
      scrolled.mockRestore()
      sheet.remove()
    }
  }

  /** Where the landed group's top sits from the column's top, after the landing. */
  function landed(el: HTMLElement): { page: HTMLElement; column: HTMLElement; groupTop: number } {
    const page = el.querySelector<HTMLElement>('.zen-settings-page')!
    const group = el.querySelector<HTMLElement>('[data-group="sync-scope"]')!
    const column = group.closest<HTMLElement>('.zen-settings-content, .zen-settings-scroll')!
    return {
      page,
      column,
      groupTop: group.getBoundingClientRect().top - column.getBoundingClientRect().top
    }
  }

  it('the desktop column pads its end by what the group lacks, and the group lands flush under the find field – the column’s top for scrolled content (N1)', () => {
    const restore = layout(1113)
    try {
      viewport(TWO_PANE_MIN_WIDTH)
      const el = mountPage(
        state(DESKTOP, 'linux', {}, 'zen://settings/sync?row=sync-scope%3AopenTabs')
      )
      const { page, column, groupTop } = landed(el)
      expect(parseFloat(getComputedStyle(column).scrollPaddingTop)).toBe(INSET)
      expect(page.hasAttribute('data-landing')).toBe(true)
      // 521 − 56 + 944 − 1113: the 296 the group stopped short of the field's edge (at 352).
      expect(page.style.getPropertyValue('--zen-settings-landing-pad')).toBe('296px')
      expect(column.scrollTop).toBe(465)
      expect(groupTop).toBe(INSET)
    } finally {
      restore()
    }
  })

  it('the phone column the same, to its own top', () => {
    const restore = layout(1113)
    try {
      viewport(TWO_PANE_MIN_WIDTH - 1, false)
      const el = mountPage(
        state(SYNCING_PHONE, 'android', {}, 'zen://settings/sync?row=sync-scope%3AopenTabs')
      )
      const { page, column, groupTop } = landed(el)
      expect(column.classList.contains('zen-settings-scroll')).toBe(true)
      expect(page.hasAttribute('data-landing')).toBe(true)
      expect(page.style.getPropertyValue('--zen-settings-landing-pad')).toBe('352px')
      expect(column.scrollTop).toBe(GROUP_TOP)
      expect(groupTop).toBe(0)
    } finally {
      restore()
    }
  })

  it('a group that reaches the top on its own is not padded for; a section without a landing keeps its end', () => {
    const restore = layout(3000)
    try {
      viewport(TWO_PANE_MIN_WIDTH)
      const asked = landed(
        mountPage(state(DESKTOP, 'linux', {}, 'zen://settings/sync?row=sync-scope%3AopenTabs'))
      )
      expect(asked.page.hasAttribute('data-landing')).toBe(true)
      expect(asked.page.style.getPropertyValue('--zen-settings-landing-pad')).toBe('')
      expect(asked.groupTop).toBe(INSET)
      act(() => root!.unmount())
      root = null
      const plain = landed(mountPage(state(DESKTOP, 'linux', {}, 'zen://settings/sync')))
      expect(plain.page.hasAttribute('data-landing')).toBe(false)
      expect(plain.page.style.getPropertyValue('--zen-settings-landing-pad')).toBe('')
    } finally {
      restore()
    }
  })

  it('main.css: the pad is the column body’s padding-bottom only under `data-landing`, and the desktop column’s scroll padding is the find field’s box – a landed group lands flush under it (N1)', () => {
    // The field's box: the control between the two paddings the column names and the field
    // reads (`.zen-settings-find`), so the scroll padding and the field's padding cannot drift;
    // no air rides on it (the #553 lead check's N1 – the section's 32 stays its layout gap).
    const column = rule('.zen-settings-content').replace(/\s+/g, ' ')
    expect(column).toContain('--zen-settings-find-pad-top: 16px;')
    expect(column).toContain('--zen-settings-find-pad-bottom: 8px;')
    expect(column).not.toContain('landing-air')
    expect(column).toContain(
      'scroll-padding-top: calc( var(--v2-control) + var(--zen-settings-find-pad-top) + var(--zen-settings-find-pad-bottom) );'
    )
    expect(rule('.zen-settings-find')).toMatch(
      /^ {2}padding: var\(--zen-settings-find-pad-top\) 16px var\(--zen-settings-find-pad-bottom\);$/m
    )
    const selectors =
      '.zen-settings-page[data-landing] .zen-settings-scroll > .zen-settings-body,\n' +
      '.zen-settings-page[data-landing] .zen-settings-pane > .zen-settings-body'
    const start = css.indexOf(`\n${selectors} {`)
    expect(start).toBeGreaterThan(-1)
    expect(css.slice(start, css.indexOf('\n}', start))).toMatch(
      /^ {2}padding-bottom: var\(--zen-settings-landing-pad, 0px\);$/m
    )
    // Nothing pads a body's end without the landing: the rule is the only one taking the pad.
    expect(css.match(/--zen-settings-landing-pad/g)).toHaveLength(1)
  })
})

/* ---- W7-6: the Privacy and security hub cards land on their groups; Reset settings ---- */

const { FrameDialogHost } = await import('@renderer/lib/portals')

/** The page under the frame's dialog host, so a row's dialog has somewhere to portal to. */
function mountHosted(s: UIState): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() =>
    root!.render(
      createElement(
        FrameDialogHost,
        null,
        createElement(SettingsPage, { state: s, tab: s.tabs.settings! })
      )
    )
  )
  return mount
}

/** A few microtasks: the primitive's focus effects and the stack's state settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** A key press on `from`; the event comes back, `defaultPrevented` when a surface answered it. */
function press(from: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => {
    from.dispatchEvent(e)
  })
  return e
}

describe('a section asked for one of its groups (zen://settings/<section>?group=<id>; the hub cards, W7-6)', () => {
  it('the two-pane Privacy and security leads with the cards; the phone layout has none', () => {
    const markup = render(state(DESKTOP, 'linux', {}, 'zen://settings/privacy'))
    const cards = [...markup.matchAll(/data-row="(hub-[\w-]+)"/g)].map((m) => m[1])
    expect(cards).toEqual([
      'hub-clear-data',
      'hub-cookies',
      'hub-security',
      'hub-site-settings',
      'hub-safety-check'
    ])
    // The cards stand first in the column, before Safety check's own group.
    expect(markup.indexOf('data-group="privacy-hub"')).toBeLessThan(
      markup.indexOf('data-group="safety-check"')
    )
    viewport(TWO_PANE_MIN_WIDTH - 1, false)
    const phone = render(state(ANDROID, 'android', {}, 'zen://settings/privacy'))
    expect(phone).toContain('zen-settings-phone')
    expect(phone).not.toContain('data-row="hub-')
    expect(phone).not.toContain('data-group="privacy-hub"')
  })

  it('the four landing cards trail the chevron; the dialog card carries §9.1’s ellipsis and none (F1, Q5); Safety check draws list-checks (F3)', () => {
    const el = mountPage(state(DESKTOP, 'linux', {}, 'zen://settings/privacy'))
    const card = (id: string): HTMLButtonElement =>
      el.querySelector<HTMLButtonElement>(`[data-row="${id}"]`)!
    const chevron = (id: string): boolean =>
      card(id).querySelector('.zen-settings-trailing svg.lucide-chevron-right') !== null
    for (const id of ['hub-cookies', 'hub-security', 'hub-site-settings', 'hub-safety-check']) {
      expect(chevron(id)).toBe(true)
      expect(card(id).hasAttribute('aria-haspopup')).toBe(false)
    }
    expect(chevron('hub-clear-data')).toBe(false)
    expect(card('hub-clear-data').querySelector('.zen-settings-trailing')).toBeNull()
    expect(card('hub-clear-data').querySelector('.zen-settings-label')?.textContent).toBe(
      'Clear browsing data…'
    )
    expect(card('hub-security').querySelector('.zen-settings-label')?.textContent).toBe(
      'Safe Browsing'
    )
    // The glyphs: the shield stays on Safe Browsing; Safety check's is a check over a list.
    expect(card('hub-security').querySelector('svg.zen-settings-glyph')?.classList).toContain(
      'lucide-shield-half'
    )
    expect(card('hub-safety-check').querySelector('svg.zen-settings-glyph')?.classList).toContain(
      'lucide-list-checks'
    )
    // The nav's Security category keeps its own shield-check.
    const nav = el.querySelector<HTMLElement>('.zen-settings-nav-item[data-section="security"]')!
    expect(nav.querySelector('svg')?.classList).toContain('lucide-shield-check')
  })

  it('a card asks the page for its group through page.navigate (`?group=`, the entry rewritten), and the group is scrolled to the top', () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    const el = mountPage(state(DESKTOP, 'linux', {}, 'zen://settings/privacy'))
    expect(scrolled).not.toHaveBeenCalled()
    const card = el.querySelector<HTMLButtonElement>('[data-row="hub-security"]')!
    expect(card.tagName).toBe('BUTTON')
    expect(card.textContent).toContain('Safe Browsing')
    act(() => card.click())
    expect(invoke).toHaveBeenCalledWith('page.navigate', {
      tabId: 'settings',
      section: 'privacy',
      query: { group: 'safe-browsing' },
      replace: true
    })
    act(() => root!.unmount())
    root = null
    // The address the card asked for, as the core answers it: the group at the column's top.
    mountPage(state(DESKTOP, 'linux', {}, 'zen://settings/privacy?group=safe-browsing'))
    expect(scrolled).toHaveBeenCalledTimes(1)
    const target = scrolled.mock.instances[0] as Element
    expect(target.getAttribute('data-group')).toBe('safe-browsing')
    expect(scrolled).toHaveBeenCalledWith({ block: 'start' })
    expect(mount!.querySelector('.zen-settings-page')?.hasAttribute('data-landing')).toBe(true)
    scrolled.mockRestore()
  })

  it('a group the section does not have, or an id that is not one, opens the section at the top', () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    mountPage(state(DESKTOP, 'linux', {}, 'zen://settings/privacy?group=no-such-group'))
    expect(scrolled).not.toHaveBeenCalled()
    act(() => root!.unmount())
    root = null
    mountPage(state(DESKTOP, 'linux', {}, 'zen://settings/privacy?group=%22%5D%2C%20*'))
    expect(scrolled).not.toHaveBeenCalled()
    expect(mount!.querySelector('.zen-settings-page')?.hasAttribute('data-landing')).toBe(false)
    scrolled.mockRestore()
  })

  it('Clear browsing data… opens the PS-13 dialog over the section instead of landing anywhere', () => {
    const el = mountHosted(state(DESKTOP, 'linux', {}, 'zen://settings/privacy'))
    const card = el.querySelector<HTMLButtonElement>('[data-row="hub-clear-data"]')!
    expect(card.getAttribute('aria-haspopup')).toBe('dialog')
    act(() => card.click())
    expect(invoke).not.toHaveBeenCalledWith('page.navigate', expect.anything())
    const dialog = el.querySelector<HTMLElement>('[data-dialog="form:hub-clear-data"]')
    expect(dialog).not.toBeNull()
    // One name for one thing: the card reads as the dialog it opens is titled today.
    expect(dialog!.textContent).toContain('Clear browsing data')
  })
})

describe('Reset settings (zen://settings/reset; W7-6, settings-70)', () => {
  const DIALOG = '[data-dialog="confirm:reset-settings"]'
  // The host keeps a closed prompt through its exit animation, `data-leaving` (#188): open is
  // what is not leaving.
  const open = (el: ParentNode): HTMLElement | null =>
    el.querySelector<HTMLElement>(`${DIALOG}:not([data-leaving])`)
  const resetButton = (el: ParentNode): HTMLButtonElement =>
    el.querySelector<HTMLButtonElement>('[data-row="reset-settings"] button')!
  /** The prompt opened from the keyboard: the Reset… button holds the focus and is pressed. */
  async function opened(
    el: HTMLElement
  ): Promise<{ prompt: HTMLElement; cancel: HTMLButtonElement; verb: HTMLButtonElement }> {
    const button = resetButton(el)
    act(() => button.focus())
    act(() => button.click())
    await settle()
    const prompt = open(el)!
    expect(prompt).not.toBeNull()
    const [cancel, verb] = [...prompt.querySelectorAll<HTMLButtonElement>('button')]
    return { prompt, cancel: cancel!, verb: verb! }
  }

  it('is the last category before About with one row and its trailing danger button, under the 22 title with no sub-heading (F2)', () => {
    const markup = render(state(DESKTOP, 'linux', {}, 'zen://settings/reset'))
    const items = navItems(markup)
    expect(items.indexOf('Reset Settings')).toBe(items.indexOf('|', items.indexOf('Sync')) - 1)
    expect(items[items.length - 1]).toBe('About')
    expect(markup).toContain('Restore settings to their original defaults')
    expect(markup).toMatch(/data-row="reset-settings"[\s\S]*?aria-haspopup="dialog"[^>]*>Reset…</)
    // Both panes one form: the row stands under the category's title as the hub's cards do.
    const pane = markup.slice(markup.indexOf('class="zen-settings-pane'))
    expect(pane).toMatch(/<h2[^>]*class="zen-settings-section-title">Reset Settings<\/h2>/)
    expect(pane).not.toContain('zen-settings-heading')
  })

  it('confirms on §9.23’s prompt with Chrome’s copy – Cancel runs nothing, Reset settings runs settings.reset', () => {
    const el = mountHosted(state(DESKTOP, 'linux', {}, 'zen://settings/reset'))
    const button = resetButton(el)
    expect(button.textContent).toBe('Reset…')
    act(() => button.click())
    let prompt = el.querySelector<HTMLElement>(DIALOG)!
    expect(prompt).not.toBeNull()
    expect(prompt.getAttribute('role')).toBe('alertdialog')
    expect(document.getElementById(prompt.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Reset settings?'
    )
    expect(document.getElementById(prompt.getAttribute('aria-describedby')!)?.textContent).toBe(
      'This will reset your startup page, home page, new tab page, search engine, pinned tabs, and site permissions. It will also disable all extensions and clear temporary data like cookies. Your bookmarks, history, and saved passwords will not be cleared.'
    )
    let [cancel, verb] = [...prompt.querySelectorAll<HTMLButtonElement>('button')]
    expect(cancel!.textContent).toBe('Cancel')
    expect(verb!.textContent).toBe('Reset settings')
    // A destructive prompt: the verb in the danger ink, no primary (§9.23).
    expect(verb!.hasAttribute('data-danger')).toBe(true)
    expect(verb!.hasAttribute('data-primary')).toBe(false)
    act(() => cancel!.click())
    expect(open(el)).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('settings.reset', undefined)

    act(() => button.click())
    prompt = open(el)!
    expect(prompt).not.toBeNull()
    ;[cancel, verb] = [...prompt.querySelectorAll<HTMLButtonElement>('button')]
    act(() => verb!.click())
    expect(invoke).toHaveBeenCalledWith('settings.reset', undefined)
    expect(open(el)).toBeNull()
  })

  it('holds its container, Tab reaches Cancel then the verb and wraps, and Enter from the container is inert on the destructive verb (§9.22 as amended on #392; Q2)', async () => {
    const el = mountHosted(state(DESKTOP, 'linux', {}, 'zen://settings/reset'))
    const { prompt, cancel, verb } = await opened(el)
    // The container holds the focus as the prompt opens: neither button is preselected.
    expect(document.activeElement).toBe(prompt)
    // Tab from the container enters at Cancel; from Cancel the hop to the verb is the browser's
    // own (not prevented); from the verb it wraps to Cancel; Shift+Tab from the container is the verb.
    expect(press(prompt, 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(cancel)
    expect(press(cancel, 'Tab').defaultPrevented).toBe(false)
    act(() => verb.focus())
    expect(press(verb, 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(cancel)
    act(() => prompt.focus())
    expect(press(prompt, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(verb)
    // Enter from the held container: swallowed, the prompt stands, nothing runs – a destructive
    // prompt has no default, so a second Return can never be what resets the profile.
    act(() => prompt.focus())
    expect(press(prompt, 'Enter').defaultPrevented).toBe(true)
    expect(open(el)).toBe(prompt)
    expect(invoke).not.toHaveBeenCalledWith('settings.reset', undefined)
    // A focused button answers its own Enter and Space as any button does: the prompt leaves
    // the keys to it (not prevented) – the verb is reached by Tab and pressed, never defaulted.
    act(() => verb.focus())
    expect(press(verb, 'Enter').defaultPrevented).toBe(false)
    expect(press(verb, ' ').defaultPrevented).toBe(false)
    expect(open(el)).toBe(prompt)
  })

  it('Escape and Cancel return the focus to the Reset… button that opened it (§9.5, one hop; Q2)', async () => {
    const el = mountHosted(state(DESKTOP, 'linux', {}, 'zen://settings/reset'))
    const button = resetButton(el)
    const first = await opened(el)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await settle()
    expect(open(el)).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('settings.reset', undefined)
    expect(document.activeElement).toBe(button)
    expect(first.prompt.isConnected ? first.prompt.hasAttribute('data-leaving') : true).toBe(true)

    const second = await opened(el)
    act(() => second.cancel.focus())
    act(() => second.cancel.click())
    await settle()
    expect(open(el)).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('settings.reset', undefined)
    expect(document.activeElement).toBe(button)
  })

  it('after the verb runs the focus returns to the Reset… button, the row standing as it was; the toast is the core’s word (Q2)', async () => {
    const el = mountHosted(state(DESKTOP, 'linux', {}, 'zen://settings/reset'))
    const button = resetButton(el)
    const { verb } = await opened(el)
    act(() => verb.focus())
    act(() => verb.click())
    await settle()
    expect(invoke).toHaveBeenCalledWith('settings.reset', undefined)
    expect(open(el)).toBeNull()
    // The row stays – a reset leaves the page where it was – and its button takes the keyboard
    // back, one hop from the prompt; "Settings reset" is the core's toast (`settingsReset.ts`),
    // sent to the window as the run ends, not this page's to show.
    expect(resetButton(el)).toBe(button)
    expect(document.activeElement).toBe(button)
    expect(el.textContent).not.toContain('Settings reset')
  })

  it('is not among the phone layout’s categories', () => {
    viewport(TWO_PANE_MIN_WIDTH - 1, false)
    const markup = render(state(ANDROID, 'android', {}, 'zen://settings'))
    expect(markup).toContain('zen-settings-landing')
    expect(markup).not.toContain('Reset Settings')
  })
})
