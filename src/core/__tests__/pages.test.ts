import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONTAINER_ID,
  PRIVATE_CONTAINER_ID,
  type HostCapabilities,
  type Platform as PlatformOs,
  type Tab
} from '../../shared/types'
import { INTERNAL_PAGES, type InternalPageRegistry } from '../../shared/internalPages'
import { Browser } from '../browser'
import type { ZenWindow } from '../window'
import type {
  ClipboardHost,
  Platform,
  SessionHost,
  ShellHost,
  StoreIO,
  TabView,
  TabViewHost,
  WindowHost
} from '../platform'
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
  /** The window whose chrome received it. */
  winId: string
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
  /** `host.focus()` calls per window id (a window brought to the front). */
  raised: Map<string, number>
  /** Text put on the clipboard, in order. */
  copied: string[]
  /** URLs handed to the system share sheet, in order. */
  shared: string[]
  /** How often the host was told to wipe the private session (`sessions.clearPrivate`). */
  privateCleared: { count: number }
}

function fixture(
  opts: {
    pageTabs?: boolean
    /** A host with several windows (the desktop); one window (Android) by default. */
    windows?: boolean
    /** Private browsing as tabs of the one window (Android); off by default. */
    privateTabs?: boolean
    profile?: unknown
    pages?: InternalPageRegistry
  } = {}
): Fixture {
  const viewsFor: string[] = []
  const loaded: string[] = []
  const sent: Sent[] = []
  const raised = new Map<string, number>()
  const copied: string[] = []
  const shared: string[] = []
  const privateCleared = { count: 0 }
  const capabilities = stub<HostCapabilities>({
    windows: opts.windows ?? false,
    privateTabs: opts.privateTabs ?? false,
    updates: false,
    agents: false,
    pageTabs: opts.pageTabs ?? true
  })
  const platform: Platform = {
    info: { os: 'android' as PlatformOs, version: '0.0.0' },
    capabilities,
    io: memoryIo(opts.profile === undefined ? null : JSON.stringify(opts.profile)),
    windows: {
      create: (win: ZenWindow) => {
        let alive = true
        return stub<WindowHost>({
          get alive() {
            return alive
          },
          contentSize: () => ({ width: 412, height: 915 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          focus: () => {
            raised.set(win.id, (raised.get(win.id) ?? 0) + 1)
          },
          close: () => {
            alive = false
          },
          send: (name: string, payload: unknown) => {
            sent.push({ name, payload, winId: win.id })
          }
        })
      }
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
    clipboard: stub<ClipboardHost>({
      writeText: (text: string) => {
        copied.push(text)
      }
    }),
    shell: stub<ShellHost>({
      share: async (payload: { url?: string }) => {
        shared.push(payload.url ?? '')
      }
    }),
    net: stub(),
    downloads: stub(),
    sessions: stub<SessionHost>({
      clearPrivate: async () => {
        privateCleared.count += 1
      }
    }),
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
  return { browser, win, viewsFor, loaded, sent, raised, copied, shared, privateCleared }
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

  it('opens the New Tab section from the new tab page’s Customize as a tab of this tab, never the overlay', () => {
    const f = fixture()
    f.browser.handleCommand(f.win, 'newtab.open', undefined)
    const ntp = activeTab(f)!
    expect(ntp.url).toBe('zen://newtab')
    f.browser.newTab.handleAction(ntp.id, { type: 'customize' })
    const settings = activeTab(f)
    expect(settings?.url).toBe('zen://settings/newtab')
    expect(settings?.openerTabId).toBe(ntp.id)
    expect(f.sent.some((s) => s.name === 'overlay.open')).toBe(false)
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

describe('History, the bookmarks manager and Downloads as page tabs (styling pass 6, v2 §10.1)', () => {
  const PAGES = [
    ['history', 'history.open', 'History'],
    ['bookmarks', 'bookmarks.open', 'Bookmarks'],
    ['downloads', 'downloads.open', 'Downloads']
  ] as const

  function overlays(f: Fixture): unknown[] {
    return f.sent.filter((s) => s.name === 'overlay.open').map((s) => s.payload)
  }

  it('opens one chrome page tab per window from the shortcut’s action and re-focuses it on a second press', () => {
    for (const [id, action, title] of PAGES) {
      const f = fixture()
      const site = openSite(f, 'https://a.test/')
      f.browser.actions.run(action, { sourceTabId: site.id, win: f.win })
      const tab = activeTab(f)
      expect(tab?.url).toBe(`zen://${id}`)
      expect(tab?.title).toBe(title)
      expect(tab?.openerTabId).toBe(site.id)
      // A chrome page: no page view, nothing loaded.
      expect(f.viewsFor).not.toContain(tab?.id)
      expect(f.browser.pages.isChromePage(tab!)).toBe(true)
      // Something else in front, then the shortcut again: the one tab is re-focused.
      openSite(f, 'https://b.test/')
      f.browser.actions.run(action, { sourceTabId: null, win: f.win })
      expect(activeTab(f)?.id).toBe(tab?.id)
      expect(spaceUrls(f).filter((u) => u.startsWith(`zen://${id}`))).toHaveLength(1)
      expect(overlays(f)).toEqual([])
    }
  })

  it('opens the tab from the typed zenium:// address, the chrome:// one and a deep link, one per window', () => {
    for (const [id] of PAGES) {
      const f = fixture()
      const site = openSite(f, 'https://a.test/')
      f.browser.handleCommand(f.win, 'urlbar.submit', {
        input: `zenium://${id}`,
        newTab: false,
        tabId: site.id,
        background: false
      })
      const tab = activeTab(f)
      expect(tab?.url).toBe(`zen://${id}`)
      expect(tab?.openerTabId).toBe(site.id)
      expect(f.browser.tabs.tab(site.id)?.url).toBe('https://a.test/')
      f.browser.tabs.activateTab(site.id, f.win)
      f.browser.handleCommand(f.win, 'urlbar.submit', {
        input: `chrome://${id}`,
        newTab: false,
        tabId: site.id,
        background: false
      })
      expect(activeTab(f)?.id).toBe(tab?.id)
      f.browser.openExternalUrl(`zenium://${id}`, f.win, { fromIntent: true })
      expect(activeTab(f)?.id).toBe(tab?.id)
      expect(spaceUrls(f).filter((u) => u.startsWith(`zen://${id}`))).toHaveLength(1)
    }
  })

  it('carries the page’s query: @history and @bookmarks search the page, a folder opens the manager on it', () => {
    const f = fixture()
    const site = openSite(f, 'https://a.test/')
    f.browser.handleCommand(f.win, 'urlbar.submit', {
      input: '@history zen browser',
      newTab: false,
      tabId: site.id,
      background: false
    })
    const history = activeTab(f)
    expect(history?.url).toBe('zen://history?q=zen+browser')
    expect(history?.title).toBe('History')
    // The search of the open tab changes: the tab is re-focused and moved, a step it can back out of.
    f.browser.tabs.activateTab(site.id, f.win)
    f.browser.handleCommand(f.win, 'urlbar.submit', {
      input: '@history other',
      newTab: false,
      tabId: site.id,
      background: false
    })
    expect(activeTab(f)?.id).toBe(history?.id)
    expect(activeTab(f)?.url).toBe('zen://history?q=other')
    expect(activeTab(f)?.canGoBack).toBe(true)
    back(f, history!.id)
    expect(activeTab(f)?.url).toBe('zen://history?q=zen+browser')
    // A plain open leaves the search as it is; the landing (section null) with no query clears it.
    f.browser.pages.open('history', undefined, f.win)
    expect(activeTab(f)?.url).toBe('zen://history?q=zen+browser')
    f.browser.pages.open('history', null, f.win)
    expect(activeTab(f)?.url).toBe('zen://history')

    const bookmarks = f.browser.pages.open('bookmarks', null, f.win, undefined, {
      query: { folder: 'f_work' }
    })
    expect(f.browser.tabs.tab(bookmarks ?? undefined)?.url).toBe('zen://bookmarks?folder=f_work')
    f.browser.handleCommand(f.win, 'urlbar.submit', {
      input: '@bookmarks zen',
      newTab: false,
      tabId: bookmarks,
      background: false
    })
    expect(activeTab(f)?.id).toBe(bookmarks)
    expect(activeTab(f)?.url).toBe('zen://bookmarks?q=zen')
    expect(spaceUrls(f).filter((u) => u.startsWith('zen://bookmarks'))).toHaveLength(1)
  })

  it('is the phone’s panel or sheet on its layout although the host has page tabs, the query as the overlay knows it', () => {
    const f = fixture()
    f.browser.handleCommand(f.win, 'window.formFactor', { formFactor: 'phone' })
    const site = openSite(f, 'https://a.test/')
    const before = spaceUrls(f)
    for (const [id, action] of PAGES) {
      f.browser.actions.run(action, { sourceTabId: site.id, win: f.win })
      expect(overlays(f).pop()).toEqual({ kind: id, section: undefined, folderId: undefined })
    }
    expect(
      f.browser.pages.open('bookmarks', null, f.win, undefined, { query: { folder: 'f1' } })
    ).toBeNull()
    expect(overlays(f).pop()).toEqual({ kind: 'bookmarks', section: undefined, folderId: 'f1' })
    // Typed, the address opens the panel too, the tab left alone.
    f.browser.handleCommand(f.win, 'urlbar.submit', {
      input: 'zenium://history',
      newTab: false,
      tabId: site.id,
      background: false
    })
    expect(overlays(f).pop()).toEqual({ kind: 'history', section: undefined, folderId: undefined })
    expect(spaceUrls(f)).toEqual(before)
    // Settings names no layouts: the phone's Settings is the tab.
    expect(f.browser.pages.opensPageAsTab('settings', f.win)).toBe(true)
    expect(f.browser.pages.opensPageAsTab('history', f.win)).toBe(false)
    // The tablet's layout holds the tabs as the desktop's does.
    f.browser.handleCommand(f.win, 'window.formFactor', { formFactor: 'tablet' })
    expect(f.browser.pages.opensPageAsTab('downloads', f.win)).toBe(true)
  })

  it('falls back to the overlay on a host without page tabs', () => {
    const f = fixture({ pageTabs: false })
    openSite(f, 'https://a.test/')
    for (const [id, action] of PAGES) {
      f.browser.actions.run(action, { sourceTabId: null, win: f.win })
      expect(overlays(f).pop()).toEqual({ kind: id, section: undefined, folderId: undefined })
    }
    expect(spaceUrls(f).some((u) => u.startsWith('zen://history'))).toBe(false)
  })

  it('opens the three pages from a private window in the regular window used last, none in the private one', () => {
    const f = fixture({ windows: true })
    openSite(f, 'https://a.test/')
    const priv = f.browser.createWindow({ kind: 'private', from: f.win })
    if (!priv.isPrivate || !priv.localSpace) throw new Error('a private window has a local space')
    const privBefore = [...priv.localSpace.tabIds]
    for (const [id, action] of PAGES) {
      f.browser.actions.run(action, { sourceTabId: null, win: priv })
      const tab = f.browser.tabs.tab(f.browser.tabs.activeTabFor(f.win)?.id)
      expect(tab?.url).toBe(`zen://${id}`)
      expect(f.browser.tabs.windowFor(tab?.id ?? '')).toBe(f.win)
      expect(tab?.openerTabId).toBeNull()
      expect(tab?.containerId).toBe(DEFAULT_CONTAINER_ID)
      expect(f.browser.tabs.isPrivate(tab!)).toBe(false)
    }
    expect(priv.localSpace.tabIds).toEqual(privBefore)
    expect(f.browser.tabs.privateTabs()).toHaveLength(1)
    expect(f.raised.get(f.win.id)).toBe(3)
    // Typed into the private tab: the same reroute, the private tab left on its page.
    const privTab = f.browser.tabs.tab(privBefore[0])!
    f.browser.tabs.navigate(privTab.id, 'https://p.test/')
    f.browser.handleCommand(priv, 'urlbar.submit', {
      input: 'zenium://downloads',
      newTab: false,
      tabId: privTab.id,
      background: false
    })
    expect(f.browser.tabs.tab(privTab.id)?.url).toBe('https://p.test/')
    expect(
      Object.values(f.browser.state.model.tabs).filter((t) => t.url.startsWith('zen://downloads'))
    ).toHaveLength(1)
    expect(overlays(f)).toEqual([])
  })

  it('never shares a split and takes no star', () => {
    const f = fixture()
    const a = openSite(f, 'https://a.test/')
    for (const [id] of PAGES) {
      const tabId = f.browser.pages.open(id, undefined, f.win) ?? ''
      f.browser.tabs.createSplit([a.id, tabId], 'vertical', f.win)
      expect(f.browser.tabs.tab(tabId)?.splitGroupId).toBeNull()
      expect(f.browser.bookmarkable(`zen://${id}`)).toBe(false)
    }
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

  it('opens a section’s drill-in page as one more history entry, back landing on the section (v2 §10.2)', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f, 'privacy') ?? ''
    const tab = (): Tab | undefined => f.browser.tabs.tab(id)
    f.browser.handleCommand(f.win, 'page.navigate', {
      tabId: id,
      section: 'privacy',
      subpage: 'site-data'
    })
    expect(tab()?.url).toBe('zen://settings/privacy/site-data')
    expect(tab()?.title).toBe('Settings')
    expect(tab()?.canGoBack).toBe(true)
    back(f, id)
    expect(tab()?.url).toBe('zen://settings/privacy')
    expect(tab()?.canGoForward).toBe(true)
    f.browser.tabs.goForward(id)
    expect(tab()?.url).toBe('zen://settings/privacy/site-data')
    // A move to a section drops the page: the address is the section's.
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'privacy' })
    expect(tab()?.url).toBe('zen://settings/privacy')
    // The landing has no drill-in pages of its own.
    f.browser.handleCommand(f.win, 'page.navigate', {
      tabId: id,
      section: null,
      subpage: 'site-data'
    })
    expect(tab()?.url).toBe('zen://settings')
  })

  it('restores a drill-in page with its section and the landing beneath it', () => {
    const space = createSpace('Work', '')
    const settings = createTabRecord({
      spaceId: space.id,
      containerId: 'default',
      url: 'zen://settings/privacy/site-data'
    })
    space.tabIds = [settings.id]
    space.activeTabId = settings.id
    const f = fixture({
      profile: {
        version: 2,
        spaces: [space],
        tabs: [settings],
        essentialTabIds: [],
        activeSpaceId: space.id,
        settings: { onboardingDone: true }
      }
    })
    const tab = (): Tab | undefined => f.browser.tabs.tab(settings.id)
    expect(tab()?.url).toBe('zen://settings/privacy/site-data')
    expect(tab()?.title).toBe('Settings')
    expect(tab()?.canGoBack).toBe(true)
    back(f, settings.id)
    expect(tab()?.url).toBe('zen://settings/privacy')
    back(f, settings.id)
    expect(tab()?.url).toBe('zen://settings')
    expect(tab()?.canGoBack).toBe(false)
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

  it('re-focusing the singleton page from another site makes that site its opener (#260 seed)', () => {
    const f = fixture()
    const a = openSite(f, 'https://a.test/')
    const id = openPage(f) ?? ''
    expect(f.browser.tabs.tab(id)?.openerTabId).toBe(a.id)
    // From a second site the page is re-focused, not opened again: one tab, the new opener.
    const b = openSite(f, 'https://b.test/')
    expect(openPage(f)).toBe(id)
    expect(spaceUrls(f).filter((u) => u === 'zen://settings')).toHaveLength(1)
    expect(activeTab(f)?.id).toBe(id)
    expect(f.browser.tabs.tab(id)?.openerTabId).toBe(b.id)
    // Asked again from the page tab itself, the opener stays.
    expect(openPage(f)).toBe(id)
    expect(f.browser.tabs.tab(id)?.openerTabId).toBe(b.id)
    // An explicit "no opener" (a deep link, a rerouted request) clears it rather than leaving b.
    expect(openPage(f, undefined, null)).toBe(id)
    expect(f.browser.tabs.tab(id)?.openerTabId).toBeNull()
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

describe('registry attributes the core reads', () => {
  it('keeps a page out of splits while its entry says splittable: false (Settings)', () => {
    const f = fixture()
    const a = openSite(f, 'https://a.test/')
    const b = openSite(f, 'https://b.test/')
    const id = openPage(f) ?? ''
    f.browser.tabs.createSplit([a.id, id], 'vertical', f.win)
    // Settings was filtered out; one tab left is no split.
    expect(f.browser.tabs.tab(id)?.splitGroupId).toBeNull()
    expect(f.browser.tabs.tab(a.id)?.splitGroupId).toBeNull()
    f.browser.tabs.createSplit([a.id, b.id], 'vertical', f.win)
    const group = f.browser.tabs.tab(a.id)?.splitGroupId ?? ''
    expect(group).not.toBe('')
    f.browser.tabs.addToSplit(group, id)
    expect(f.browser.tabs.tab(id)?.splitGroupId).toBeNull()
    expect(f.browser.state.model.splitGroups[group]?.tabIds).toEqual([a.id, b.id])
  })

  it('lets a page whose entry allows it share a split (a document page)', () => {
    const f = fixture({ pages: TRIAL })
    const a = openSite(f, 'https://a.test/')
    const id = f.browser.handleCommand(f.win, 'page.open', { id: 'library' }) as string
    f.browser.tabs.createSplit([a.id, id], 'vertical', f.win)
    const group = f.browser.tabs.tab(a.id)?.splitGroupId
    expect(group).toBeTruthy()
    expect(f.browser.tabs.tab(id)?.splitGroupId).toBe(group)
  })

  it('keeps the star on a page whose entry shows it, and off every other zen:// document', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f, 'privacy') ?? ''
    expect(f.browser.bookmarkable('zen://settings/privacy')).toBe(true)
    expect(f.browser.bookmarkable('https://a.test/')).toBe(true)
    expect(f.browser.bookmarkable('zen://history')).toBe(false)
    expect(f.browser.bookmarkable('zen://blank')).toBe(false)
    f.browser.toggleBookmark(id, f.win)
    expect(f.browser.bookmarks.has('zen://settings/privacy')).toBe(true)
    expect(f.browser.tabs.tab(id)?.bookmarked).toBe(true)
    // A section is its own address: the star follows the tab's history like a site's.
    back(f, id)
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://settings')
    expect(f.browser.tabs.tab(id)?.bookmarked).toBe(false)
    f.browser.tabs.goForward(id)
    expect(f.browser.tabs.tab(id)?.bookmarked).toBe(true)
  })

  it('does not star a page whose entry hides it', () => {
    const f = fixture({ pages: TRIAL })
    openSite(f, 'https://a.test/')
    const id = f.browser.handleCommand(f.win, 'page.open', { id: 'welcome' }) as string
    expect(f.browser.bookmarkable('zen://welcome')).toBe(false)
    f.browser.toggleBookmark(id, f.win)
    expect(f.browser.bookmarks.has('zen://welcome')).toBe(false)
  })

  it('leaves zoom alone on a chrome page: no view to zoom, so the factor stays 1 and no chip shows', () => {
    const f = fixture()
    const id = openPage(f) ?? ''
    f.sent.length = 0
    f.browser.handleCommand(f.win, 'tab.setZoom', { tabId: id, delta: 1 })
    f.browser.handleCommand(f.win, 'tab.setZoomFactor', { tabId: id, factor: 1.5 })
    f.browser.handleCommand(f.win, 'tab.setZoom', { tabId: id, delta: null })
    expect(f.browser.tabs.tab(id)?.zoom).toBe(1)
    expect(f.sent.some((s) => s.name === 'zoom.changed')).toBe(false)
    expect(f.browser.state.settings.pageControls.siteZooms).toEqual({})
  })
})

describe('the address the user gets (zen:// never leaves tab.url)', () => {
  it('copies the zenium:// alias, plain and as Markdown', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f, 'privacy') ?? ''
    f.browser.handleCommand(f.win, 'tab.copyUrl', { tabId: id, markdown: false })
    f.browser.handleCommand(f.win, 'tab.copyUrl', { tabId: id, markdown: true })
    expect(f.copied).toEqual(['zenium://settings/privacy', '[Settings](zenium://settings/privacy)'])
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://settings/privacy')
  })

  it('shares the alias – the deep link another app opens the page by', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f, 'look') ?? ''
    f.browser.shareTab(id, f.win)
    expect(f.shared).toEqual(['zenium://settings/look'])
    // Other zen:// documents still have nothing to share.
    const blank = f.browser.tabs.createTab({ url: 'zen://blank', active: true }, f.win)
    f.browser.shareTab(blank.id, f.win)
    expect(f.shared).toEqual(['zenium://settings/look'])
  })
})

describe('a page asked for from a popup window (core rule)', () => {
  /** A page's sized `window.open` on a desktop-shaped host: a toolbar-only window off `f.win`. */
  function popupOff(f: Fixture, from: ZenWindow = f.win): ZenWindow {
    return f.browser.createWindow({
      kind: 'unsynced',
      from,
      chrome: 'popup',
      bounds: { x: 80, y: 80, width: 500, height: 400 },
      empty: true
    })
  }

  it('opens the page in the popup’s opener, brought to the front, and never in the popup', () => {
    const f = fixture({ windows: true })
    openSite(f, 'https://a.test/')
    const popup = popupOff(f)
    const inPopup = f.browser.tabs.createTab({ url: 'https://popup.test/', active: true }, popup)
    const id = f.browser.handleCommand(popup, 'page.open', { id: 'settings', section: 'privacy' })
    const tab = f.browser.tabs.tab(typeof id === 'string' ? id : undefined)
    expect(tab?.url).toBe('zen://settings/privacy')
    // In the opener's space, active there; the popup's own tab is not in that window.
    expect(spaceUrls(f)).toContain('zen://settings/privacy')
    expect(activeTab(f)?.id).toBe(id)
    expect(tab?.openerTabId).toBeNull()
    expect(popup.localSpace?.tabIds).toEqual([inPopup.id])
    expect(f.raised.get(f.win.id)).toBe(1)
    // The window that asked is the one a chrome page's overlay fallback would go to as well.
    expect(f.browser.pages.hostWindowFor(popup)).toBe(f.win)
    expect(f.browser.pages.hostWindowFor(f.win)).toBe(f.win)
  })

  it('reuses the opener’s Settings tab from the popup as it would from the opener', () => {
    const f = fixture({ windows: true })
    openSite(f, 'https://a.test/')
    const first = openPage(f, 'look')
    const popup = popupOff(f)
    f.browser.tabs.createTab({ url: 'https://popup.test/', active: true }, popup)
    const again = f.browser.handleCommand(popup, 'page.open', { id: 'settings', section: 'about' })
    expect(again).toBe(first)
    expect(f.browser.tabs.tab(first ?? undefined)?.url).toBe('zen://settings/about')
    expect(spaceUrls(f).filter((u) => u.startsWith('zen://settings'))).toHaveLength(1)
  })

  it('walks a popup’s popup up to the full window, else takes the full window used last', () => {
    const f = fixture({ windows: true })
    openSite(f, 'https://a.test/')
    const popup = popupOff(f)
    const nested = popupOff(f, popup)
    expect(f.browser.pages.hostWindowFor(nested)).toBe(f.win)
    // The opener closed: the last full window used stands in.
    const other = f.browser.createWindow({ kind: 'synced', from: f.win })
    other.onFocused()
    f.win.host.close()
    f.browser.onWindowClosed(f.win)
    expect(f.browser.pages.hostWindowFor(popup)).toBe(other)
  })

  it('sends a chrome page’s overlay to the opener on a host without page tabs', () => {
    const f = fixture({ windows: true, pageTabs: false })
    openSite(f, 'https://a.test/')
    const popup = popupOff(f)
    f.browser.tabs.createTab({ url: 'https://popup.test/', active: true }, popup)
    f.sent.length = 0
    const result = f.browser.handleCommand(popup, 'page.open', { id: 'settings' })
    expect(result).toBeNull()
    const overlays = f.sent.filter((s) => s.name === 'overlay.open')
    expect(overlays).toHaveLength(1)
    expect(overlays[0].winId).toBe(f.win.id)
    expect(f.raised.get(f.win.id)).toBe(1)
  })
})

describe('a page asked for from a private window (Chrome opens Settings from Incognito in a regular window)', () => {
  /** Ctrl+Shift+N off `from` on a desktop-shaped host: a private window with its starter tab. */
  function privateOff(f: Fixture, from: ZenWindow = f.win): ZenWindow {
    const win = f.browser.createWindow({ kind: 'private', from })
    if (!win.isPrivate || !win.localSpace) throw new Error('a private window has a local space')
    return win
  }

  /** The tabs a window with a space of its own holds, by URL. */
  function localUrls(f: Fixture, win: ZenWindow): string[] {
    return (win.localSpace?.tabIds ?? []).map((id) => f.browser.tabs.tab(id)?.url ?? '?')
  }

  function settingsTabs(f: Fixture): Tab[] {
    return Object.values(f.browser.state.model.tabs).filter((t) =>
      t.url.startsWith('zen://settings')
    )
  }

  it('opens the page in the regular window used last, active and in front, without an opener; the private window is left as it was', () => {
    const f = fixture({ windows: true })
    openSite(f, 'https://a.test/')
    // Two regular windows: the synced one the session started with and a blank one used later.
    const blank = f.browser.createWindow({ kind: 'unsynced', from: f.win })
    f.win.lastFocusedAt = 1000
    blank.lastFocusedAt = 2000
    const priv = privateOff(f)
    const privBefore = localUrls(f, priv)
    const privateBefore = f.browser.tabs.privateTabs().map((t) => t.id)
    expect(privateBefore).toHaveLength(1)
    const id = f.browser.handleCommand(priv, 'page.open', { id: 'settings', section: 'privacy' })
    const tab = f.browser.tabs.tab(typeof id === 'string' ? id : undefined)
    expect(tab?.url).toBe('zen://settings/privacy')
    // In the blank window – the regular window used last – active there and in front.
    expect(localUrls(f, blank)).toContain('zen://settings/privacy')
    expect(f.browser.tabs.activeTabFor(blank)?.id).toBe(id)
    expect(f.browser.tabs.windowFor(tab?.id ?? '')).toBe(blank)
    expect(f.raised.get(blank.id)).toBe(1)
    expect(f.raised.get(f.win.id)).toBeUndefined()
    expect(f.raised.get(priv.id)).toBeUndefined()
    // The asking window's tab is not in that window: no opener, and a regular container.
    expect(tab?.openerTabId).toBeNull()
    expect(tab?.containerId).toBe(DEFAULT_CONTAINER_ID)
    expect(f.browser.tabs.isPrivate(tab!)).toBe(false)
    // The private window kept its one starter tab and nothing else; the other regular window
    // was not touched either.
    expect(localUrls(f, priv)).toEqual(privBefore)
    expect(f.browser.tabs.privateTabs().map((t) => t.id)).toEqual(privateBefore)
    expect(f.browser.tabs.activeTabFor(priv)?.id).toBe(priv.localSpace?.tabIds[0])
    expect(spaceUrls(f)).not.toContain('zen://settings/privacy')
    // Recency decides: with the synced window used last, the page goes there (one per window).
    f.win.lastFocusedAt = 3000
    const again = f.browser.handleCommand(priv, 'page.open', { id: 'settings' })
    expect(again).not.toBe(id)
    expect(spaceUrls(f)).toContain('zen://settings')
    expect(f.raised.get(f.win.id)).toBe(1)
    expect(localUrls(f, priv)).toEqual(privBefore)
  })

  it('makes a new regular window for the page when no regular window is alive', () => {
    const f = fixture({ windows: true })
    openSite(f, 'https://a.test/')
    const priv = privateOff(f)
    const privBefore = localUrls(f, priv)
    f.win.onClosing()
    f.win.host.close()
    f.win.onClosed()
    expect(f.browser.allWindows()).toEqual([priv])
    const id = f.browser.handleCommand(priv, 'page.open', { id: 'settings', section: 'look' })
    const windows = f.browser.allWindows()
    expect(windows).toHaveLength(2)
    const fresh = windows.find((w) => w !== priv)
    if (!fresh) throw new Error('a regular window was opened for the page')
    // What Ctrl+N makes: a synced window with the full chrome, not private, brought to the front.
    expect(fresh.kind).toBe('synced')
    expect(fresh.isPrivate).toBe(false)
    expect(fresh.chrome).toBe('full')
    expect(f.browser.tabs.activeTabFor(fresh)?.id).toBe(id)
    expect(f.browser.tabs.tab(typeof id === 'string' ? id : undefined)?.url).toBe(
      'zen://settings/look'
    )
    expect(f.browser.tabs.tab(typeof id === 'string' ? id : undefined)?.openerTabId).toBeNull()
    expect(f.raised.get(fresh.id)).toBe(1)
    expect(localUrls(f, priv)).toEqual(privBefore)
    expect(f.browser.tabs.privateTabs()).toHaveLength(1)
  })

  it('keeps one Settings tab: asked twice from the private window, the regular window’s is focused and moved to the section', () => {
    const f = fixture({ windows: true })
    openSite(f, 'https://a.test/')
    const priv = privateOff(f)
    const first = f.browser.handleCommand(priv, 'page.open', { id: 'settings', section: 'look' })
    // Something else in front in the regular window meanwhile.
    openSite(f, 'https://b.test/')
    expect(activeTab(f)?.url).toBe('https://b.test/')
    const again = f.browser.handleCommand(priv, 'page.open', { id: 'settings', section: 'about' })
    expect(again).toBe(first)
    expect(settingsTabs(f)).toHaveLength(1)
    expect(activeTab(f)?.id).toBe(first)
    expect(activeTab(f)?.url).toBe('zen://settings/about')
    expect(activeTab(f)?.canGoBack).toBe(true)
    expect(f.raised.get(f.win.id)).toBe(2)
    expect(localUrls(f, priv)).toHaveLength(1)
    expect(localUrls(f, priv)[0]).not.toContain('zen://settings')
  })

  it('leaves a private tab on its page when the address is typed into it: the page opens in the regular window', () => {
    const f = fixture({ windows: true })
    openSite(f, 'https://a.test/')
    const priv = privateOff(f)
    const privTab = f.browser.tabs.createTab({ url: 'https://p.test/', active: true }, priv)
    expect(f.browser.tabs.isPrivate(privTab)).toBe(true)
    // The TabManager's navigation of the private tab (`routeNavigation`).
    f.browser.tabs.navigate(privTab.id, 'zen://settings/look')
    expect(f.browser.tabs.tab(privTab.id)?.url).toBe('https://p.test/')
    expect(f.browser.tabs.activeTabFor(priv)?.id).toBe(privTab.id)
    expect(spaceUrls(f)).toContain('zen://settings/look')
    const settings = activeTab(f)
    expect(settings?.url).toBe('zen://settings/look')
    expect(settings?.openerTabId).toBeNull()
    expect(settings?.containerId).toBe(DEFAULT_CONTAINER_ID)
    expect(f.raised.get(f.win.id)).toBe(1)
    // The URL bar of the private window says the same.
    f.browser.handleCommand(priv, 'urlbar.submit', {
      input: 'zenium://settings/about',
      newTab: false,
      tabId: privTab.id,
      background: false
    })
    expect(f.browser.tabs.tab(privTab.id)?.url).toBe('https://p.test/')
    expect(settingsTabs(f)).toHaveLength(1)
    expect(activeTab(f)?.url).toBe('zen://settings/about')
    expect(localUrls(f, priv).filter((u) => u.startsWith('zen://settings'))).toHaveLength(0)
  })

  it('lets the private session end when the private window closes: no private tab is left behind', () => {
    const f = fixture({ windows: true })
    openSite(f, 'https://a.test/')
    const priv = privateOff(f)
    f.browser.tabs.createTab({ url: 'https://p.test/', active: true }, priv)
    const id = f.browser.handleCommand(priv, 'page.open', { id: 'settings', section: 'privacy' })
    expect(f.browser.tabs.privateTabs()).toHaveLength(2)
    expect(f.privateCleared.count).toBe(0)
    priv.onClosing()
    priv.host.close()
    priv.onClosed()
    expect(f.browser.allWindows()).toEqual([f.win])
    expect(f.browser.tabs.privateTabs()).toEqual([])
    expect(f.privateCleared.count).toBe(1)
    // Settings stays where it went, in the regular window.
    expect(f.browser.tabs.tab(typeof id === 'string' ? id : undefined)?.url).toBe(
      'zen://settings/privacy'
    )
    expect(activeTab(f)?.id).toBe(id)
  })

  it('resolves a popup whose opener is a private window to a regular window', () => {
    const f = fixture({ windows: true })
    openSite(f, 'https://a.test/')
    const priv = privateOff(f)
    // A private page's sized `window.open`: a toolbar-only window that is private itself.
    const popup = f.browser.createWindow({
      kind: 'private',
      from: priv,
      chrome: 'popup',
      bounds: { x: 80, y: 80, width: 500, height: 400 },
      empty: true
    })
    const inPopup = f.browser.tabs.createTab({ url: 'https://popup.test/', active: true }, popup)
    expect(f.browser.tabs.isPrivate(inPopup)).toBe(true)
    // The overlay's host is the private opener; a tab's host is the regular window.
    expect(f.browser.pages.hostWindowFor(popup)).toBe(priv)
    expect(f.browser.pages.tabWindowFor(popup)).toBe(f.win)
    expect(f.browser.pages.tabWindowFor(priv)).toBe(f.win)
    expect(f.browser.pages.tabWindowFor(f.win)).toBe(f.win)
    const id = f.browser.handleCommand(popup, 'page.open', { id: 'settings' })
    const tab = f.browser.tabs.tab(typeof id === 'string' ? id : undefined)
    expect(tab?.url).toBe('zen://settings')
    expect(tab?.openerTabId).toBeNull()
    expect(activeTab(f)?.id).toBe(id)
    expect(f.raised.get(f.win.id)).toBe(1)
    expect(popup.localSpace?.tabIds).toEqual([inPopup.id])
    expect(localUrls(f, priv)).toHaveLength(1)
    // No regular window left: the resolver says so and `open` makes one.
    f.win.onClosing()
    f.win.host.close()
    f.win.onClosed()
    expect(f.browser.pages.tabWindowFor(popup)).toBeNull()
    expect(f.browser.pages.tabWindowFor(priv)).toBeNull()
  })

  it('keeps a chrome page’s overlay over the private window that asked, on a host without page tabs', () => {
    const f = fixture({ windows: true, pageTabs: false })
    openSite(f, 'https://a.test/')
    const priv = privateOff(f)
    f.sent.length = 0
    const result = f.browser.handleCommand(priv, 'page.open', {
      id: 'settings',
      section: 'privacy'
    })
    expect(result).toBeNull()
    const overlays = f.sent.filter((s) => s.name === 'overlay.open')
    expect(overlays).toHaveLength(1)
    expect(overlays[0].winId).toBe(priv.id)
    expect(f.raised.size).toBe(0)
    expect(f.browser.allWindows()).toHaveLength(2)
  })
})

describe('a page asked for from a private tab (one window, private browsing as tabs)', () => {
  it('opens Settings as a regular-container tab that remembers the private tab as its opener', () => {
    const f = fixture({ privateTabs: true })
    openSite(f, 'https://a.test/')
    const privId = f.browser.tabs.newPrivateTab('https://p.test/', f.win)
    const priv = f.browser.tabs.tab(privId ?? undefined)
    if (!priv) throw new Error('a private tab opened')
    expect(priv.containerId).toBe(PRIVATE_CONTAINER_ID)
    expect(activeTab(f)?.id).toBe(priv.id)
    const id = openPage(f, 'privacy')
    const tab = f.browser.tabs.tab(id ?? undefined)
    expect(tab?.url).toBe('zen://settings/privacy')
    expect(tab?.containerId).toBe(DEFAULT_CONTAINER_ID)
    expect(f.browser.tabs.isPrivate(tab!)).toBe(false)
    // Back still works: the opener is the private tab, and it is left as it was.
    expect(tab?.openerTabId).toBe(priv.id)
    expect(activeTab(f)?.id).toBe(id)
    expect(f.browser.tabs.tab(priv.id)?.url).toBe('https://p.test/')
    expect(f.browser.tabs.tab(priv.id)?.containerId).toBe(PRIVATE_CONTAINER_ID)
    expect(f.browser.tabs.privateTabs().map((t) => t.id)).toEqual([priv.id])
    // Asked again from the private tab, the one Settings tab is reused.
    f.browser.tabs.activateTab(priv.id, f.win)
    expect(openPage(f, 'about')).toBe(id)
    expect(spaceUrls(f).filter((u) => u.startsWith('zen://settings'))).toHaveLength(1)
    // Typed into the private tab's bar: the private tab stays, the regular Settings tab moves.
    f.browser.tabs.activateTab(priv.id, f.win)
    f.browser.handleCommand(f.win, 'urlbar.submit', {
      input: 'zenium://settings/look',
      newTab: false,
      tabId: priv.id,
      background: false
    })
    expect(activeTab(f)?.id).toBe(id)
    expect(activeTab(f)?.url).toBe('zen://settings/look')
    expect(f.browser.tabs.tab(priv.id)?.url).toBe('https://p.test/')
    // Closing the private tab ends the private session even while Settings is open.
    f.browser.tabs.closeTab(priv.id, false, f.win)
    expect(f.browser.tabs.privateTabs()).toEqual([])
    expect(f.privateCleared.count).toBe(1)
    expect(f.browser.tabs.tab(id ?? undefined)?.url).toBe('zen://settings/look')
  })

  it('opens a deep link with a private tab in front as a regular-container tab', () => {
    const f = fixture({ privateTabs: true })
    openSite(f, 'https://a.test/')
    f.browser.tabs.newPrivateTab('https://p.test/', f.win)
    f.browser.openExternalUrl('zenium://settings/privacy', f.win, { fromIntent: true })
    const tab = activeTab(f)
    expect(tab?.url).toBe('zen://settings/privacy')
    expect(tab?.containerId).toBe(DEFAULT_CONTAINER_ID)
    expect(tab?.openerTabId).toBeNull()
    expect(tab?.fromIntent).toBe(true)
    expect(f.browser.tabs.privateTabs()).toHaveLength(1)
  })

  it('keeps a regular opener’s own container, default or not', () => {
    const f = fixture({ privateTabs: true })
    const work = f.browser.tabs.createTab(
      { url: 'https://work.test/', active: true, containerId: 'work' },
      f.win
    )
    expect(work.containerId).toBe('work')
    const id = openPage(f, 'privacy')
    const tab = f.browser.tabs.tab(id ?? undefined)
    expect(tab?.containerId).toBe('work')
    expect(tab?.openerTabId).toBe(work.id)
    f.browser.tabs.closeTab(id ?? '', false, f.win)
    const plain = openSite(f, 'https://a.test/')
    expect(plain.containerId).toBe(DEFAULT_CONTAINER_ID)
    const again = f.browser.tabs.tab(openPage(f) ?? undefined)
    expect(again?.containerId).toBe(DEFAULT_CONTAINER_ID)
    expect(again?.openerTabId).toBe(plain.id)
  })
})

describe('a chrome page tab has no view to attach (the guarantee for moves and tear-off)', () => {
  it('is whole without one: load, claim and claimVisible leave it as it is', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f, 'look') ?? ''
    const tabs = f.browser.tabs
    expect(tabs.view(id)).toBeUndefined()
    expect(tabs.ensureLoaded(id, f.win)).toBeUndefined()
    expect(tabs.load(id, f.win)).toBeUndefined()
    expect(tabs.claim(id, f.win)).toBe(false)
    tabs.claimVisible(f.win)
    expect(tabs.ownerOf(id)).toBeUndefined()
    expect(f.viewsFor).not.toContain(id)
    // Shown all the same: the window resolves through what it shows, not through a view owner.
    expect(tabs.visibleTabIds(f.win)).toEqual([id])
    expect(tabs.windowFor(id)).toBe(f.win)
    expect(tabs.tab(id)?.discarded).toBe(false)
    expect(tabs.tab(id)?.loading).toBe(false)
    expect(tabs.tab(id)?.canGoBack).toBe(true)
  })

  it('moves into another window and shows there view-less, its section history intact', () => {
    const f = fixture({ windows: true })
    openSite(f, 'https://a.test/')
    const id = openPage(f, 'look') ?? ''
    const blank = f.browser.createWindow({ kind: 'unsynced', from: f.win })
    const local = blank.localSpace
    if (!local) throw new Error('a blank window has a local space')
    f.browser.handleCommand(blank, 'tab.moveToSpace', { tabId: id, spaceId: local.id })
    f.browser.tabs.activateTab(id, blank)
    f.browser.tabs.claimVisible(blank)
    expect(f.browser.tabs.tab(id)?.spaceId).toBe(local.id)
    expect(f.browser.tabs.visibleTabIds(blank)).toEqual([id])
    expect(f.browser.tabs.windowFor(id)).toBe(blank)
    expect(f.viewsFor).not.toContain(id)
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://settings/look')
    expect(f.browser.tabs.tab(id)?.canGoBack).toBe(true)
    back(f, id)
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://settings')
    // One per window: the window it left has none now, so opening there makes a new tab.
    const again = openPage(f)
    expect(again).not.toBe(id)
    expect(spaceUrls(f).filter((u) => u.startsWith('zen://settings'))).toHaveLength(1)
  })

  it('outlives the window that showed it when another window remains, and shows there', () => {
    const f = fixture({ windows: true })
    openSite(f, 'https://a.test/')
    const id = openPage(f, 'privacy') ?? ''
    const other = f.browser.createWindow({ kind: 'synced', from: f.win })
    f.win.onClosing()
    f.win.host.close()
    f.win.onClosed()
    expect(f.browser.allWindows()).toEqual([other])
    expect(f.browser.tabs.tab(id)).toBeDefined()
    expect(f.browser.tabs.tab(id)?.discarded).toBe(false)
    f.browser.tabs.activateTab(id, other)
    f.browser.tabs.claimVisible(other)
    expect(f.browser.tabs.visibleTabIds(other)).toEqual([id])
    expect(f.viewsFor).not.toContain(id)
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://settings/privacy')
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

  it('brings History, Bookmarks and Downloads back as page tabs, the query they were left on kept', () => {
    const space = createSpace('Work', '')
    const records = [
      ['zen://history?q=zen', 'History'],
      ['zen://bookmarks?folder=f1', 'Bookmarks'],
      ['zen://downloads', 'Downloads']
    ].map(([url]) => createTabRecord({ spaceId: space.id, containerId: 'default', url }))
    space.tabIds = records.map((t) => t.id)
    space.activeTabId = records[0].id
    const f = fixture({
      profile: {
        version: 2,
        spaces: [space],
        tabs: records,
        essentialTabIds: [],
        activeSpaceId: space.id,
        settings: { onboardingDone: true }
      }
    })
    for (const [i, [url, title]] of [
      ['zen://history?q=zen', 'History'],
      ['zen://bookmarks?folder=f1', 'Bookmarks'],
      ['zen://downloads', 'Downloads']
    ].entries()) {
      const restored = f.browser.tabs.tab(records[i].id)
      expect(restored?.url).toBe(url)
      expect(restored?.title).toBe(title)
      expect(restored?.discarded).toBe(false)
      expect(f.viewsFor).not.toContain(records[i].id)
      expect(f.browser.pages.isChromePage(restored!)).toBe(true)
      // No section beneath: the page is the whole history.
      expect(restored?.canGoBack).toBe(false)
    }
    // The restored tab is the window's one: a second open re-focuses it.
    openSite(f, 'https://a.test/')
    expect(f.browser.pages.open('downloads', undefined, f.win)).toBe(records[2].id)
  })
})

describe('a closed page tab (Recently closed, Ctrl+Shift+T)', () => {
  it('lands in Recently closed under its title and address, and comes back as a page on its query', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = f.browser.handleCommand(f.win, 'page.open', {
      id: 'history',
      query: { q: 'zen' }
    }) as string
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://history?q=zen')
    f.browser.tabs.closeTab(id, true, f.win)
    expect(f.browser.tabs.tab(id)).toBeUndefined()
    // The entry the chrome lists (the History page's group, the tab search popover), whose
    // favicon slot draws the page's glyph from the address: no icon was ever fetched.
    const [entry] = f.browser.session.summaries()
    expect(entry).toMatchObject({
      kind: 'tab',
      title: 'History',
      url: 'zen://history?q=zen',
      favicon: null
    })
    f.browser.session.reopenClosed(f.win)
    const back = activeTab(f)
    expect(back?.url).toBe('zen://history?q=zen')
    expect(back?.title).toBe('History')
    expect(back && f.browser.pages.isChromePage(back)).toBe(true)
    expect(f.viewsFor).not.toContain(back?.id)
    // It is the window's History tab again: the shortcut re-focuses it rather than opening another.
    expect(f.browser.pages.open('history', undefined, f.win)).toBe(back?.id)
    expect(spaceUrls(f).filter((u) => u.startsWith('zen://history'))).toHaveLength(1)
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
  welcome: {
    id: 'welcome',
    title: 'Welcome',
    render: 'document',
    singleton: false,
    pill: { showStar: false },
    splittable: true,
    sections: []
  },
  // A singleton document page with a section, standing in for none in the real registry (whose
  // Downloads is a chrome page without sections since pass 6).
  library: {
    id: 'library',
    title: 'Library',
    render: 'document',
    singleton: true,
    glyph: 'download',
    pill: { showStar: true },
    splittable: true,
    sections: [{ id: 'active', label: 'Active', keywords: [] }]
  }
}

describe('a document page on the same route', () => {
  it('opens in a tab with a page view every time (singleton: false), an opener remembered', () => {
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
    const id = f.browser.handleCommand(f.win, 'page.open', { id: 'library' })
    expect(typeof id).toBe('string')
    expect(activeTab(f)?.url).toBe('zen://library')
    expect(f.sent.filter((s) => s.name === 'overlay.open')).toHaveLength(0)
  })

  it('keeps one per window when asked, focusing it from a typed address in another tab', () => {
    const f = fixture({ pages: TRIAL })
    const site = openSite(f, 'https://a.test/')
    const id = f.browser.handleCommand(f.win, 'page.open', { id: 'library' }) as string
    f.browser.tabs.activateTab(site.id, f.win)
    // (The canonical form: `inputToUrl` only knows the alias for pages in the real registry.)
    f.browser.handleCommand(f.win, 'urlbar.submit', {
      input: 'zen://library/active',
      newTab: false,
      tabId: site.id,
      background: false
    })
    expect(activeTab(f)?.id).toBe(id)
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://library/active')
    expect(f.browser.tabs.tab(site.id)?.url).toBe('https://a.test/')
    expect(spaceUrls(f).filter((u) => u.startsWith('zen://library'))).toHaveLength(1)
    // Loaded by the view, as a document: no section history of the service's own.
    expect(f.loaded).toContain('zen://library/active')
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
    const id = f.browser.handleCommand(f.win, 'page.open', { id: 'library' }) as string
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'active' })
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://library/active')
    expect(f.loaded.at(-1)).toBe('zen://library/active')
  })
})
