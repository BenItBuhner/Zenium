import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { INTERNAL_PAGES, type InternalPageRegistry } from '../../shared/internalPages'
import { Browser } from '../browser'
import type { ZenWindow } from '../window'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import { createSpace, createTabRecord } from '../model'
import { PageService } from '../pages'

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
  /** URLs loaded into page views, in order. */
  loaded: string[]
  /** Events the core sent the chrome. */
  sent: Sent[]
}

function fixture(
  opts: { pageTabs?: boolean; profile?: unknown; pages?: InternalPageRegistry } = {}
): Fixture {
  const viewsFor: string[] = []
  const loaded: string[] = []
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
            loaded.push(u)
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
  // A registry on trial (a document page before the desktop registers it) replaces the service.
  if (opts.pages) {
    ;(browser as { pages: PageService }).pages = new PageService(browser, opts.pages)
  }
  browser.state.settings.onboardingDone = true
  browser.start()
  const win = browser.focusedWindow()
  return { browser, win, viewsFor, loaded, sent }
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

/** The tab's back – the toolbar's, the bottom bar's and the system's are all `tab.back`. */
function back(f: Fixture, tabId: string): void {
  f.browser.handleCommand(f.win, 'tab.back', { tabId })
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
    back(f, id)
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

  it('opens a deep link from outside the app without an opener, marked as the intent’s', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    f.browser.openExternalUrl('zenium://settings/privacy', f.win, { fromIntent: true })
    const tab = activeTab(f)
    expect(tab?.url).toBe('zen://settings/privacy')
    expect(tab?.openerTabId).toBeNull()
    // The chrome's root-back rule reads this: back at the landing returns to the app that sent it.
    expect(tab?.fromIntent).toBe(true)
    // A second deep link reuses the tab.
    f.browser.openExternalUrl('zenium://settings/look', f.win, { fromIntent: true })
    expect(spaceUrls(f).filter((u) => u.startsWith('zen://settings'))).toHaveLength(1)
    expect(activeTab(f)?.url).toBe('zen://settings/look')
  })

  it('does not mark a page the browser opens on its own behalf as another app’s', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    f.browser.openExternalUrl('zenium://settings', f.win)
    expect(activeTab(f)?.fromIntent).toBe(false)
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

  it('replaces the entry shown instead of pushing one when asked (the two-pane nav, v2 §10.5)', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f, 'look') ?? ''
    const tab = (): Tab | undefined => f.browser.tabs.tab(id)
    // A deep link keeps the landing beneath the section; the sidebar's picks swap the section.
    expect(tab()?.canGoBack).toBe(true)
    f.browser.handleCommand(f.win, 'page.navigate', {
      tabId: id,
      section: 'privacy',
      replace: true
    })
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'about', replace: true })
    expect(tab()?.url).toBe('zen://settings/about')
    expect(tab()?.title).toBe('Settings')
    expect(tab()?.canGoForward).toBe(false)
    f.browser.tabs.goBack(id)
    expect(tab()?.url).toBe('zen://settings')
    expect(tab()?.canGoBack).toBe(false)
    // Replacing from the middle of a history keeps the entries after it.
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'tabs', replace: true })
    expect(tab()?.url).toBe('zen://settings/tabs')
    expect(tab()?.canGoForward).toBe(true)
    f.browser.tabs.goForward(id)
    expect(tab()?.url).toBe('zen://settings/about')
  })
})

describe('back inside Settings (the tab’s history)', () => {
  it('steps back through the sections; at the landing the tab stays for the chrome’s root rule', () => {
    const f = fixture()
    const site = openSite(f, 'https://a.test/')
    const id = openPage(f) ?? ''
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'privacy' })
    expect(f.browser.tabs.tab(id)?.canGoBack).toBe(true)
    back(f, id)
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://settings')
    expect(f.browser.tabs.tab(id)?.canGoBack).toBe(false)
    // Nothing beneath the landing: the tab is left as it is, and the chrome's one root-back rule
    // (`rootBackAction`, renderer back.ts) decides from what the tab remembers – here the
    // opener it closes back to.
    back(f, id)
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://settings')
    expect(activeTab(f)?.id).toBe(id)
    expect(f.browser.tabs.tab(id)?.openerTabId).toBe(site.id)
    expect(f.browser.tabs.tab(id)?.fromIntent).toBe(false)
  })

  it('remembers the opener as an id the chrome checks is still open', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const b = openSite(f, 'https://b.test/')
    const id = openPage(f) ?? ''
    expect(f.browser.tabs.tab(id)?.openerTabId).toBe(b.id)
    f.browser.tabs.closeTab(b.id, false, f.win)
    // A dangling opener is no opener: the root rule falls through to the previous tab.
    expect(f.browser.tabs.tab(id)?.openerTabId).toBe(b.id)
    expect(f.browser.tabs.tab(b.id)).toBeUndefined()
  })

  it('forgets a closed page tab’s history and starts a reopened one afresh', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f) ?? ''
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'privacy' })
    f.browser.tabs.closeTab(id, false, f.win)
    const again = openPage(f) ?? ''
    expect(again).not.toBe(id)
    expect(f.browser.tabs.tab(again)?.url).toBe('zen://settings')
    expect(f.browser.tabs.tab(again)?.canGoBack).toBe(false)
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
    // Opener relationships are a session's own (Chrome forgets them too), and a restored tab
    // was restored by us, not sent by an app.
    expect(restored?.openerTabId).toBeNull()
    expect(restored?.fromIntent).toBe(false)
    expect(f.viewsFor).not.toContain(settings.id)
    // Its history starts afresh from the URL: the landing beneath the section.
    expect(restored?.canGoBack).toBe(true)
    back(f, settings.id)
    expect(f.browser.tabs.tab(settings.id)?.url).toBe('zen://settings')
    expect(f.browser.tabs.tab(settings.id)?.canGoBack).toBe(false)
    expect(f.browser.tabs.tab(site.id)).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Document pages: the same route with a page view (the new tab page, once the desktop
// registers it). Tried here with a registry the desktop's entries would look like.
// ---------------------------------------------------------------------------

// `welcome` stands in for the new tab page: `zen://newtab` is an alias `inputToUrl` folds into
// `zen://blank` today, and the shared normaliser only knows the pages in the real registry.
const TRIAL: InternalPageRegistry = {
  ...INTERNAL_PAGES,
  welcome: { id: 'welcome', title: 'Welcome', render: 'document', reuse: 'none', sections: [] },
  downloads: {
    id: 'downloads',
    title: 'Downloads',
    render: 'document',
    reuse: 'window',
    sections: [{ id: 'active', label: 'Active', keywords: [] }]
  }
}

describe('a document page on the same route', () => {
  it('opens in a tab with a page view every time (reuse: none), an opener remembered', () => {
    const f = fixture({ pages: TRIAL })
    const site = openSite(f, 'https://a.test/')
    const first = f.browser.handleCommand(f.win, 'page.open', { id: 'welcome' }) as string
    const second = f.browser.handleCommand(f.win, 'page.open', { id: 'welcome' }) as string
    expect(first).not.toBe(second)
    expect(f.browser.tabs.tab(first)?.url).toBe('zen://welcome')
    // The page's title until the document reports its own.
    expect(f.browser.tabs.tab(first)?.title).toBe('Welcome')
    expect(f.browser.tabs.tab(first)?.openerTabId).toBe(site.id)
    // Its page is a document: the view loads it, and the view's history is the tab's.
    expect(f.viewsFor).toContain(first)
    expect(f.loaded).toContain('zen://welcome')
    expect(spaceUrls(f).filter((u) => u === 'zen://welcome')).toHaveLength(2)
  })

  it('is a tab on a host without page tabs too: only chrome pages fall back to an overlay', () => {
    const f = fixture({ pages: TRIAL, pageTabs: false })
    openSite(f, 'https://a.test/')
    const id = f.browser.handleCommand(f.win, 'page.open', { id: 'downloads' })
    expect(typeof id).toBe('string')
    expect(activeTab(f)?.url).toBe('zen://downloads')
    expect(f.sent.filter((s) => s.name === 'overlay.open')).toHaveLength(0)
  })

  it('keeps one per window when asked, focusing it from a typed address in another tab', () => {
    const f = fixture({ pages: TRIAL })
    const site = openSite(f, 'https://a.test/')
    const id = f.browser.handleCommand(f.win, 'page.open', { id: 'downloads' }) as string
    f.browser.tabs.activateTab(site.id, f.win)
    // (The canonical form: `inputToUrl` only knows the alias for pages in the real registry.)
    f.browser.handleCommand(f.win, 'urlbar.submit', {
      input: 'zen://downloads/active',
      newTab: false,
      tabId: site.id,
      background: false
    })
    expect(activeTab(f)?.id).toBe(id)
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://downloads/active')
    expect(f.browser.tabs.tab(site.id)?.url).toBe('https://a.test/')
    expect(spaceUrls(f).filter((u) => u.startsWith('zen://downloads'))).toHaveLength(1)
    // Loaded by the view, as a document: no section history of the service's own.
    expect(f.loaded).toContain('zen://downloads/active')
    expect(f.browser.tabs.tab(id)?.canGoBack).toBe(false)
  })

  it('loads a typed address for a page with no tab to reuse in the tab it was typed into', () => {
    const f = fixture({ pages: TRIAL })
    const site = openSite(f, 'https://a.test/')
    f.browser.handleCommand(f.win, 'urlbar.submit', {
      input: 'zen://welcome',
      newTab: false,
      tabId: site.id,
      background: false
    })
    expect(activeTab(f)?.id).toBe(site.id)
    expect(f.browser.tabs.tab(site.id)?.url).toBe('zen://welcome')
  })

  it('navigates a document page to a section through its view', () => {
    const f = fixture({ pages: TRIAL })
    openSite(f, 'https://a.test/')
    const id = f.browser.handleCommand(f.win, 'page.open', { id: 'downloads' }) as string
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'active' })
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://downloads/active')
    expect(f.loaded.at(-1)).toBe('zen://downloads/active')
  })
})
