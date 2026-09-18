import { describe, expect, it } from 'vitest'
import type {
  HostCapabilities,
  PageBackOutcome,
  Platform as PlatformOs,
  Tab
} from '../../shared/types'
import { Browser } from '../browser'
import type { ZenWindow } from '../window'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import { createSpace, createTabRecord } from '../model'

function memoryIo(initial: string | null = null): StoreIO {
  const files: Record<string, string> = {}
  return {
    readSync: (name) => files[name] ?? initial,
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

interface Sent {
  name: string
  payload: unknown
}

interface Fixture {
  browser: Browser
  win: ZenWindow
  /** Tab ids a page view was created for, in order. */
  viewsFor: string[]
  /** Events the core sent the chrome. */
  sent: Sent[]
}

function fixture(opts: { pageTabs?: boolean; profile?: unknown } = {}): Fixture {
  const viewsFor: string[] = []
  const sent: Sent[] = []
  const capabilities = stub<HostCapabilities>({
    windows: false,
    updates: false,
    agents: false,
    pageTabs: opts.pageTabs ?? true
  })
  const platform: Platform = {
    info: { os: 'android' as PlatformOs, version: '0.0.0' },
    capabilities,
    io: memoryIo(opts.profile === undefined ? null : JSON.stringify(opts.profile)),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 412, height: 915 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          send: (name: string, payload: unknown) => {
            sent.push({ name, payload })
          }
        })
    },
    views: stub<TabViewHost>({
      createView: (tab: Tab) => {
        viewsFor.push(tab.id)
        let url = ''
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          hasDocument: () => url !== '',
          getURL: () => url,
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          loadURL: (u: string) => {
            url = u
          }
        })
      }
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  const win = browser.focusedWindow()
  return { browser, win, viewsFor, sent }
}

function activeTab(f: Fixture): Tab | undefined {
  return f.browser.tabs.activeTabFor(f.win)
}

function spaceUrls(f: Fixture): string[] {
  return f.win.activeSpace().tabIds.map((id) => f.browser.tabs.tab(id)?.url ?? '?')
}

function openSite(f: Fixture, url: string): Tab {
  return f.browser.tabs.createTab({ url, active: true }, f.win)
}

function openPage(f: Fixture, section?: string | null, openerTabId?: string | null): string | null {
  return f.browser.handleCommand(f.win, 'page.open', {
    id: 'settings',
    section,
    openerTabId
  }) as string | null
}

function back(f: Fixture, tabId: string): PageBackOutcome {
  return f.browser.handleCommand(f.win, 'page.back', { tabId }) as PageBackOutcome
}

describe('opening Settings as a tab', () => {
  it('creates an active zen://settings tab next to its opener, without a page view', () => {
    const f = fixture()
    const site = openSite(f, 'https://a.test/')
    const viewsBefore = f.viewsFor.length
    const id = openPage(f)
    const tab = f.browser.tabs.tab(id ?? undefined)
    expect(tab).toBeDefined()
    expect(tab?.url).toBe('zen://settings')
    expect(tab?.title).toBe('Settings')
    expect(tab?.favicon).toBeNull()
    expect(tab?.discarded).toBe(false)
    expect(tab?.openerTabId).toBe(site.id)
    expect(activeTab(f)?.id).toBe(id)
    expect(f.viewsFor.length).toBe(viewsBefore)
    expect(spaceUrls(f).indexOf('zen://settings')).toBe(spaceUrls(f).indexOf('https://a.test/') + 1)
  })

  it('opens straight into a section, still called Settings, with the landing page beneath it', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f, 'privacy') ?? ''
    const tab = f.browser.tabs.tab(id)
    expect(tab?.url).toBe('zen://settings/privacy')
    expect(tab?.title).toBe('Settings')
    // v2 §10.2: a link into a section has the landing beneath it in history.
    expect(tab?.canGoBack).toBe(true)
    expect(back(f, id)).toBe('popped')
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://settings')
    expect(f.browser.tabs.tab(id)?.canGoBack).toBe(false)
  })

  it('reuses the Settings tab already open in the space and moves it to the section', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const first = openPage(f, 'look')
    openSite(f, 'https://b.test/')
    const again = openPage(f, 'privacy')
    expect(again).toBe(first)
    expect(spaceUrls(f).filter((u) => u.startsWith('zen://settings'))).toHaveLength(1)
    expect(activeTab(f)?.id).toBe(first)
    expect(activeTab(f)?.url).toBe('zen://settings/privacy')
    // The reuse remembered where it came from: back goes to Look and Feel.
    expect(activeTab(f)?.canGoBack).toBe(true)
  })

  it('reuses without moving when no section is asked for, and lands when null is', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f, 'look')
    openSite(f, 'https://b.test/')
    openPage(f, undefined)
    expect(activeTab(f)?.id).toBe(id)
    expect(activeTab(f)?.url).toBe('zen://settings/look')
    openPage(f, null)
    expect(activeTab(f)?.url).toBe('zen://settings')
  })

  it('keeps one Settings tab per window: opening from another space switches to it (v2 §10.1)', () => {
    const f = fixture()
    const home = f.win.activeSpaceId
    openSite(f, 'https://a.test/')
    const first = openPage(f)
    const other = createSpace('Other', '')
    f.browser.state.model.spaces.push(other)
    f.browser.tabs.switchSpace(other.id, f.win)
    openSite(f, 'https://b.test/')
    const again = openPage(f, 'privacy')
    expect(again).toBe(first)
    expect(f.win.activeSpaceId).toBe(home)
    expect(activeTab(f)?.id).toBe(first)
    expect(activeTab(f)?.url).toBe('zen://settings/privacy')
    expect(
      Object.values(f.browser.state.model.tabs).filter((t) => t.url.startsWith('zen://settings'))
    ).toHaveLength(1)
  })

  it('falls back to the settings overlay on a host without page tabs (the desktop)', () => {
    const f = fixture({ pageTabs: false })
    openSite(f, 'https://a.test/')
    const before = spaceUrls(f)
    const result = openPage(f, 'resources')
    expect(result).toBeNull()
    expect(spaceUrls(f)).toEqual(before)
    expect(f.sent.filter((s) => s.name === 'overlay.open').pop()?.payload).toEqual({
      kind: 'settings',
      section: 'resources'
    })
  })
})

describe('typed and external page addresses', () => {
  it('opens the page tab from the URL bar with the current tab as opener, leaving it alone', () => {
    const f = fixture()
    const site = openSite(f, 'https://a.test/')
    f.browser.handleCommand(f.win, 'urlbar.submit', {
      input: 'zenium://settings/look',
      newTab: false,
      tabId: site.id,
      background: false
    })
    const tab = activeTab(f)
    expect(tab?.url).toBe('zen://settings/look')
    expect(tab?.openerTabId).toBe(site.id)
    expect(f.browser.tabs.tab(site.id)?.url).toBe('https://a.test/')
  })

  it('moves the Settings tab itself when the address is typed into it', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f)
    f.browser.handleCommand(f.win, 'urlbar.submit', {
      input: 'zenium://settings/about',
      newTab: false,
      tabId: id,
      background: false
    })
    expect(spaceUrls(f).filter((u) => u.startsWith('zen://settings'))).toHaveLength(1)
    expect(activeTab(f)?.url).toBe('zen://settings/about')
  })

  it('opens a deep link from outside the app without an opener', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    f.browser.openExternalUrl('zenium://settings/privacy', f.win)
    const tab = activeTab(f)
    expect(tab?.url).toBe('zen://settings/privacy')
    expect(tab?.openerTabId).toBeNull()
    // A second deep link reuses the tab.
    f.browser.openExternalUrl('zenium://settings/look', f.win)
    expect(spaceUrls(f).filter((u) => u.startsWith('zen://settings'))).toHaveLength(1)
    expect(activeTab(f)?.url).toBe('zen://settings/look')
  })
})

describe('moving between sections', () => {
  it('keeps a history the toolbar reads like a document history', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f) ?? ''
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'look' })
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'privacy' })
    const tab = (): Tab | undefined => f.browser.tabs.tab(id)
    expect(tab()?.url).toBe('zen://settings/privacy')
    expect(tab()?.canGoBack).toBe(true)
    expect(tab()?.canGoForward).toBe(false)
    f.browser.tabs.goBack(id)
    expect(tab()?.url).toBe('zen://settings/look')
    expect(tab()?.canGoForward).toBe(true)
    f.browser.tabs.goBack(id)
    expect(tab()?.url).toBe('zen://settings')
    expect(tab()?.title).toBe('Settings')
    expect(tab()?.canGoBack).toBe(false)
    f.browser.tabs.goForward(id)
    expect(tab()?.url).toBe('zen://settings/look')
    // A new section from the middle drops the forward entries.
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'about' })
    expect(tab()?.canGoForward).toBe(false)
    f.browser.tabs.goBack(id)
    expect(tab()?.url).toBe('zen://settings/look')
  })

  it('does not record a move to the section already shown', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f) ?? ''
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'look' })
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'look' })
    f.browser.tabs.goBack(id)
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://settings')
    expect(f.browser.tabs.tab(id)?.canGoBack).toBe(false)
  })
})

describe('system back inside Settings', () => {
  it('pops the section first, then closes the tab and returns to its opener', () => {
    const f = fixture()
    const site = openSite(f, 'https://a.test/')
    const id = openPage(f) ?? ''
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'privacy' })
    expect(back(f, id)).toBe('popped')
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://settings')
    expect(back(f, id)).toBe('closed')
    expect(f.browser.tabs.tab(id)).toBeUndefined()
    expect(activeTab(f)?.id).toBe(site.id)
  })

  it('switches to the most recent other tab when it has no opener (a deep link)', () => {
    const f = fixture()
    const a = openSite(f, 'https://a.test/')
    const b = openSite(f, 'https://b.test/')
    f.browser.tabs.activateTab(a.id, f.win)
    f.browser.tabs.tab(b.id)!.lastActiveAt = 1
    f.browser.tabs.tab(a.id)!.lastActiveAt = 2
    f.browser.openExternalUrl('zenium://settings/privacy', f.win)
    const id = activeTab(f)?.id ?? ''
    // The deep link's landing page first, then out to the most recently used tab.
    expect(back(f, id)).toBe('popped')
    expect(back(f, id)).toBe('switched')
    expect(activeTab(f)?.id).toBe(a.id)
    // The Settings tab stays open in the space: nothing of it was the user's to lose.
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://settings')
  })

  it('switches to another tab when the opener is gone', () => {
    const f = fixture()
    const a = openSite(f, 'https://a.test/')
    const b = openSite(f, 'https://b.test/')
    const id = openPage(f) ?? ''
    expect(f.browser.tabs.tab(id)?.openerTabId).toBe(b.id)
    f.browser.tabs.closeTab(b.id, false, f.win)
    f.browser.tabs.activateTab(id, f.win)
    expect(f.browser.tabs.tab(id)?.openerTabId).toBeNull()
    expect(back(f, id)).toBe('switched')
    expect(activeTab(f)?.id).toBe(a.id)
  })

  it('keeps a pinned Settings tab and only leaves it', () => {
    const f = fixture()
    const site = openSite(f, 'https://a.test/')
    const id = openPage(f) ?? ''
    f.browser.tabs.tab(id)!.pinned = true
    expect(back(f, id)).toBe('switched')
    expect(f.browser.tabs.tab(id)).toBeDefined()
    expect(activeTab(f)?.id).toBe(site.id)
  })

  it('has nothing to do when Settings is the only tab, and for tabs that are not pages', () => {
    const f = fixture()
    const site = openSite(f, 'https://a.test/')
    f.browser.tabs.closeTab(site.id, false, f.win)
    for (const t of Object.values(f.browser.state.model.tabs)) {
      f.browser.tabs.closeTab(t.id, true, f.win)
    }
    const id = openPage(f, null, null) ?? ''
    expect(spaceUrls(f)).toEqual(['zen://settings'])
    expect(back(f, id)).toBe('none')
    expect(f.browser.tabs.tab(id)).toBeDefined()
    const other = openSite(f, 'https://b.test/')
    expect(back(f, other.id)).toBe('none')
  })
})

describe('a restored session', () => {
  it('brings the Settings tab back on its section, loaded and without an opener', () => {
    const space = createSpace('Work', '')
    const site = createTabRecord({
      spaceId: space.id,
      containerId: 'default',
      url: 'https://a.test/'
    })
    const settings = createTabRecord({
      spaceId: space.id,
      containerId: 'default',
      url: 'zen://settings/privacy',
      openerTabId: site.id
    })
    space.tabIds = [site.id, settings.id]
    space.activeTabId = settings.id
    const f = fixture({
      profile: {
        version: 2,
        spaces: [space],
        tabs: [site, settings],
        essentialTabIds: [],
        activeSpaceId: space.id,
        settings: { onboardingDone: true }
      }
    })
    const restored = f.browser.tabs.tab(settings.id)
    expect(restored?.url).toBe('zen://settings/privacy')
    expect(restored?.title).toBe('Settings')
    expect(restored?.discarded).toBe(false)
    expect(restored?.openerTabId).toBeNull()
    expect(f.viewsFor).not.toContain(settings.id)
    // Its history starts afresh from the URL: the landing beneath the section, then the tab
    // leaves for the other tab of the space.
    expect(restored?.canGoBack).toBe(true)
    expect(back(f, settings.id)).toBe('popped')
    expect(f.browser.tabs.tab(settings.id)?.url).toBe('zen://settings')
    expect(back(f, settings.id)).toBe('switched')
    expect(activeTab(f)?.id).toBe(site.id)
  })
})
