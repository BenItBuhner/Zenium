import { describe, expect, it } from 'vitest'
import { NEW_TAB_URL } from '../../shared/url'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { Browser } from '../browser'
import { NoExtensions } from '../hostDefaults'
import { createTabRecord } from '../model'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import type { StartupOverride } from '../startup'
import type { PersistedWindow } from '../state'
import type { ZenWindow } from '../window'

function memoryIo(): StoreIO {
  const files: Record<string, string> = {}
  return {
    readSync: (name) => files[name] ?? null,
    write: async (name, text) => {
      files[name] = text
    },
    writeSync: (name, text) => {
      files[name] = text
    }
  }
}

function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

/** An extension host with nothing installed but an optional `startup_pages` override to offer. */
class OverridingExtensions extends NoExtensions {
  override: StartupOverride | null = null

  startupPagesOverride(): StartupOverride | null {
    return this.override
  }
}

/** A host whose windows and views do nothing: the desktop (several windows) or a phone (one). */
function platformOf(opts: { windows: boolean; os?: PlatformOs }): Platform {
  const capabilities = stub<HostCapabilities>({
    windows: opts.windows,
    updates: false,
    agents: false
  })
  return {
    info: { os: opts.os ?? 'linux', version: '0.0.0' },
    capabilities,
    io: memoryIo(),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true
        })
    },
    views: stub<TabViewHost>({
      createView: () =>
        stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          hasDocument: () => false,
          getURL: () => '',
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1
        })
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    createExtensions: (browser) => new OverridingExtensions(browser),
    readabilitySource: () => null
  }
}

const PAGES = ['https://example.com/a', 'https://example.com/b']
const EXT_PAGES = ['https://ext.example/one', 'https://ext.example/two']

const EXT: StartupOverride = {
  extensionId: 'a'.repeat(32),
  name: 'Startup Pages',
  pages: EXT_PAGES,
  installedAt: 1_000
}

/** A browser over a profile that has been through onboarding, not started yet. */
function fresh(opts: { windows?: boolean; os?: PlatformOs } = {}): Browser {
  const browser = new Browser(platformOf({ windows: opts.windows ?? true, os: opts.os }))
  browser.state.settings.onboardingDone = true
  return browser
}

const extensionsOf = (browser: Browser): OverridingExtensions =>
  browser.extensions as OverridingExtensions

const persistedWindow = (
  id: string,
  spaceId: string,
  selection: string | null
): PersistedWindow => ({
  id,
  bounds: { x: 0, y: 0, width: 1000, height: 700 },
  maximized: false,
  activeSpaceId: spaceId,
  selection: selection ? { [spaceId]: selection } : {},
  compact: false
})

/** Open a page tab in the model's first space, as the last run would have left it. */
function seedTab(browser: Browser, url: string, pinned = false): string {
  const { state } = browser
  const space = state.model.spaces[0]
  const tab = createTabRecord({ spaceId: space.id, containerId: space.containerId, url })
  tab.pinned = pinned
  state.model.tabs[tab.id] = tab
  if (pinned) space.tabIds.unshift(tab.id)
  else space.tabIds.push(tab.id)
  space.activeTabId = tab.id
  return tab.id
}

/** The last session: two open tabs in the one space, two synced windows. */
function withLastSession(browser: Browser): string {
  const space = browser.state.model.spaces[0]
  const first = seedTab(browser, PAGES[0])
  seedTab(browser, PAGES[1])
  browser.state.restoredWindows = [
    persistedWindow('window_1', space.id, first),
    persistedWindow('window_2', space.id, first)
  ]
  return first
}

const only = (browser: Browser): ZenWindow => {
  const win = browser.allWindows()[0]
  if (!win) throw new Error('no window')
  return win
}

/** The first space's tabs in strip order, by address. */
const stripUrls = (browser: Browser): string[] =>
  browser.state.model.spaces[0].tabIds.map((id) => browser.state.model.tabs[id].url)
const activeUrl = (browser: Browser, win: ZenWindow): string | undefined =>
  browser.tabs.activeTabFor(win)?.url

describe('Settings › On startup – "Open a specific page or set of pages"', () => {
  it('a fresh profile opens the pages as the one window\u2019s tabs, in order, the first active', () => {
    const browser = fresh()
    browser.state.settings.startup = { mode: 'pages', pages: PAGES }
    browser.start()
    expect(browser.allWindows()).toHaveLength(1)
    expect(stripUrls(browser)).toEqual(PAGES)
    expect(activeUrl(browser, only(browser))).toBe(PAGES[0])
    expect(browser.startupPlan()).toEqual({ mode: 'pages', pages: PAGES, control: null })
  })

  it('the order holds under "after current" new-tab placement', () => {
    const browser = fresh()
    browser.state.settings.newTabPosition = 'after-current'
    browser.state.settings.startup = { mode: 'pages', pages: [...PAGES, 'https://example.com/c'] }
    browser.start()
    expect(stripUrls(browser)).toEqual([...PAGES, 'https://example.com/c'])
    expect(activeUrl(browser, only(browser))).toBe(PAGES[0])
  })

  it('the last session\u2019s tabs and windows are forgotten; the pages stand alone', () => {
    const browser = fresh()
    withLastSession(browser)
    browser.state.settings.startup = { mode: 'pages', pages: [EXT_PAGES[0]] }
    browser.start()
    expect(browser.allWindows()).toHaveLength(1)
    expect(stripUrls(browser)).toEqual([EXT_PAGES[0]])
    expect(activeUrl(browser, only(browser))).toBe(EXT_PAGES[0])
  })

  it('pinned tabs the profile kept stay ahead of the pages; the first page is still the active one', () => {
    const browser = fresh()
    seedTab(browser, 'https://pinned.example/', true)
    seedTab(browser, 'https://gone.example/')
    browser.state.restoredWindows = [
      persistedWindow('window_1', browser.state.model.spaces[0].id, null)
    ]
    browser.state.settings.startup = { mode: 'pages', pages: PAGES }
    browser.start()
    expect(stripUrls(browser)).toEqual(['https://pinned.example/', ...PAGES])
    expect(activeUrl(browser, only(browser))).toBe(PAGES[0])
  })

  it('"pages" with no page left opens one fresh New Tab page, as Chrome falls back', () => {
    const browser = fresh()
    withLastSession(browser)
    browser.state.settings.startup = { mode: 'pages', pages: [] }
    browser.start()
    expect(stripUrls(browser)).toEqual([NEW_TAB_URL])
    expect(browser.startupPlan().mode).toBe('newTab')
  })

  it('"Continue where you left off" brings the session back and leaves the pages list unread', () => {
    const browser = fresh()
    const first = withLastSession(browser)
    browser.state.settings.startup = { mode: 'continue', pages: PAGES }
    browser.start()
    expect(
      browser
        .allWindows()
        .map((w) => w.id)
        .sort()
    ).toEqual(['window_1', 'window_2'])
    expect(stripUrls(browser)).toEqual(PAGES)
    expect(browser.tabs.activeTabFor(only(browser))?.id).toBe(first)
  })

  it('"Open the New Tab page" forgets the session and opens one fresh tab', () => {
    const browser = fresh()
    withLastSession(browser)
    browser.state.settings.startup = { mode: 'newTab', pages: PAGES }
    browser.start()
    expect(browser.allWindows()).toHaveLength(1)
    expect(stripUrls(browser)).toEqual([NEW_TAB_URL])
  })

  it('the pages come up in the browser window a run on an app window opens later', () => {
    const browser = fresh()
    browser.state.settings.startup = { mode: 'pages', pages: PAGES }
    browser.start({ windows: false })
    expect(browser.allWindows()).toHaveLength(0)
    expect(stripUrls(browser)).toEqual([])
    const win = browser.ensureBrowserWindow()
    expect(stripUrls(browser)).toEqual(PAGES)
    expect(activeUrl(browser, win)).toBe(PAGES[0])
  })

  it('updateSettings keeps the pages web addresses alone, each once, and a known mode', () => {
    const browser = fresh()
    browser.start()
    const win = only(browser)
    browser.updateSettings(
      { startup: { mode: 'pages', pages: ['a.example', 'https://a.example/', 'zenium://x'] } },
      win
    )
    expect(browser.state.settings.startup).toEqual({ mode: 'pages', pages: ['https://a.example/'] })
    browser.updateSettings({ startup: { mode: 'continue' } as never }, win)
    expect(browser.state.settings.startup).toEqual({
      mode: 'continue',
      pages: ['https://a.example/']
    })
    browser.updateSettings({ startup: { mode: 'sideways' } as never }, win)
    expect(browser.state.settings.startup.mode).toBe('continue')
  })
})

describe('an enabled extension\u2019s chrome_settings_overrides.startup_pages', () => {
  it('its pages open over the user\u2019s choice; the plan names the extension', () => {
    for (const own of [
      { mode: 'newTab' as const, pages: [] },
      { mode: 'continue' as const, pages: [] },
      { mode: 'pages' as const, pages: PAGES }
    ]) {
      const browser = fresh()
      withLastSession(browser)
      browser.state.settings.startup = own
      extensionsOf(browser).override = EXT
      browser.start()
      expect(browser.allWindows()).toHaveLength(1)
      expect(stripUrls(browser)).toEqual(EXT_PAGES)
      expect(activeUrl(browser, only(browser))).toBe(EXT_PAGES[0])
      expect(browser.startupPlan().control).toEqual({
        extensionId: EXT.extensionId,
        name: 'Startup Pages',
        value: EXT_PAGES,
        pages: EXT_PAGES
      })
      // The user's own value is kept underneath, untouched.
      expect(browser.state.settings.startup).toEqual(own)
    }
  })

  it('with the extension disabled or gone the user\u2019s own value stands again', () => {
    const browser = fresh()
    browser.state.settings.startup = { mode: 'pages', pages: PAGES }
    extensionsOf(browser).override = EXT
    expect(browser.startupPlan().pages).toEqual(EXT_PAGES)
    extensionsOf(browser).override = null
    expect(browser.startupPlan()).toEqual({ mode: 'pages', pages: PAGES, control: null })
    browser.start()
    expect(stripUrls(browser)).toEqual(PAGES)
  })

  it('--restore-last-session wins over the extension as over the setting', () => {
    const browser = fresh()
    const first = withLastSession(browser)
    browser.state.settings.startup = { mode: 'newTab', pages: [] }
    extensionsOf(browser).override = EXT
    browser.start({ restoreLastSession: true })
    expect(browser.allWindows()).toHaveLength(2)
    expect(stripUrls(browser)).toEqual(PAGES)
    expect(browser.tabs.activeTabFor(only(browser))?.id).toBe(first)
  })
})

describe('the phone\u2019s boot is unchanged', () => {
  it('"pages" on a host with one window boots as "continue" – the last session back', () => {
    const browser = fresh({ windows: false, os: 'android' })
    const space = browser.state.model.spaces[0]
    const first = seedTab(browser, PAGES[0])
    seedTab(browser, PAGES[1])
    browser.state.restoredWindows = [persistedWindow('window_1', space.id, first)]
    browser.state.settings.startup = { mode: 'pages', pages: [EXT_PAGES[0]] }
    browser.start()
    expect(browser.startupPlan()).toEqual({ mode: 'continue', pages: [], control: null })
    expect(browser.allWindows()).toHaveLength(1)
    expect(stripUrls(browser)).toEqual(PAGES)
    expect(browser.tabs.activeTabFor(only(browser))?.id).toBe(first)
  })

  it('an override a host without windows offers is not consulted', () => {
    const browser = fresh({ windows: false, os: 'android' })
    browser.state.settings.startup = { mode: 'newTab', pages: [] }
    extensionsOf(browser).override = EXT
    browser.start()
    expect(browser.startupPlan()).toEqual({ mode: 'newTab', pages: [], control: null })
    expect(stripUrls(browser)).toEqual([NEW_TAB_URL])
  })

  it('a fresh phone profile boots on one New Tab page with the default setting, as before', () => {
    const browser = fresh({ windows: false, os: 'android' })
    expect(browser.state.settings.startup).toEqual({ mode: 'continue', pages: [] })
    browser.start()
    expect(stripUrls(browser)).toEqual([NEW_TAB_URL])
    expect(activeUrl(browser, only(browser))).toBe(NEW_TAB_URL)
  })
})
