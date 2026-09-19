import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { Browser } from '../browser'
import type {
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowCreateInit,
  WindowHost
} from '../platform'
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

/** Anything the browser touches on the host answers with a harmless no-op. */
function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

interface FakeView {
  readonly tabId: string
  view: TabView
  readonly events: TabViewEvents
  url: string
}

interface FakeWindow {
  win: ZenWindow
  init: WindowCreateInit
  shown: number
  focused: number
  titles: string[]
}

interface Fixture {
  browser: Browser
  views: FakeView[]
  hosts: FakeWindow[]
  hostOf(win: ZenWindow): FakeWindow
  viewOf(tabId: string): FakeView
}

function fixture(options: { windows?: boolean; os?: PlatformOs } = {}): Fixture {
  const views: FakeView[] = []
  const hosts: FakeWindow[] = []
  const capabilities = stub<HostCapabilities>({
    windows: true,
    updates: false,
    agents: false,
    pinShortcuts: true
  })
  const platform: Platform = {
    info: { os: options.os ?? ('linux' as PlatformOs), version: '0.0.0' },
    capabilities,
    io: memoryIo(),
    windows: {
      create: (win, init) => {
        const entry: FakeWindow = { win, init, shown: 0, focused: 0, titles: [] }
        hosts.push(entry)
        return stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => false,
          isVisible: () => true,
          show: () => {
            entry.shown++
          },
          focus: () => {
            entry.focused++
          },
          setTitle: (title: string) => {
            entry.titles.push(title)
          }
        })
      }
    },
    views: stub<TabViewHost>({
      createView: (tab: Tab, events: TabViewEvents) => {
        const fake: FakeView = { tabId: tab.id, events, url: '', view: undefined as never }
        const overrides: Partial<TabView> = {
          isDestroyed: () => false,
          loadURL: (u: string) => {
            fake.url = u
          },
          getURL: () => fake.url,
          getTitle: () => '',
          hasDocument: () => fake.url !== '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          isCurrentlyAudible: () => false,
          isVisible: () => true
        }
        fake.view = stub<TabView>(overrides)
        views.push(fake)
        return fake.view
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
    shortcuts: { pin: async () => true, unpin: async () => undefined },
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start(options.windows === false ? { windows: false } : {})
  return {
    browser,
    views,
    hosts,
    hostOf: (win) => {
      const h = hosts.find((e) => e.win === win)
      if (!h) throw new Error('no host for window')
      return h
    },
    viewOf: (tabId) => {
      const v = views.find((e) => e.tabId === tabId)
      if (!v) throw new Error(`no view for ${tabId}`)
      return v
    }
  }
}

const APP_URL = 'https://app.example/dash/'

describe('standalone app windows (MW-23)', () => {
  it('opens the URL in a window with the app chrome, named after its host when no app is installed', () => {
    const f = fixture()
    const win = f.browser.openAppWindow(APP_URL)
    expect(win).not.toBeNull()
    if (!win) return
    expect(win.chrome).toBe('app')
    expect(win.kind).toBe('unsynced')
    expect(win.compactEnabled).toBe(false)
    expect(win.app).toEqual({
      name: 'app.example',
      icon: null,
      scope: 'https://app.example/',
      appId: null,
      startUrl: APP_URL
    })
    // The host learns about the app at creation (icon on the frame, taskbar grouping).
    const host = f.hostOf(win)
    expect(host.init.chrome).toBe('app')
    expect(host.init.app).toEqual(win.app)
    expect(host.init.title).toBe('app.example')
    // One page, the app's, active.
    const tab = f.browser.tabs.activeTabFor(win)
    expect(tab?.url).toBe(APP_URL)
    expect(f.viewOf(tab!.id).url).toBe(APP_URL)
    expect(win.windowState().app).toEqual(win.app)
  })

  it('refuses URLs that cannot be a page', () => {
    const f = fixture()
    const count = f.browser.allWindows().length
    expect(f.browser.openAppWindow('javascript:alert(1)')).toBeNull()
    expect(f.browser.openAppWindow('zen://settings')).toBeNull()
    expect(f.browser.allWindows()).toHaveLength(count)
  })

  it('titles the window with the page title alone and falls back to the app name', () => {
    const f = fixture()
    const win = f.browser.openAppWindow(APP_URL)!
    const host = f.hostOf(win)
    const tab = f.browser.tabs.activeTabFor(win)!
    f.viewOf(tab.id).events.onTitleUpdated('Dashboard')
    win.updateTitle()
    expect(host.titles.at(-1)).toBe('Dashboard')
    f.viewOf(tab.id).events.onTitleUpdated('')
    win.updateTitle()
    // No page title: the app's name, never "Zenium".
    expect(host.titles.at(-1)).not.toContain('Zenium')
  })

  it('keeps an in-scope navigation and hands an out-of-scope one to a browser tab', () => {
    const f = fixture()
    const browserWin = f.browser.allWindows()[0]
    const win = f.browser.openAppWindow(APP_URL)!
    const tab = f.browser.tabs.activeTabFor(win)!
    const events = f.viewOf(tab.id).events
    const before = Object.keys(f.browser.state.model.tabs).length
    expect(events.onWillNavigate('https://app.example/dash/settings')).toBe(false)
    expect(events.onWillNavigate('https://app.example/other')).toBe(false)
    expect(events.onWillNavigate('about:blank')).toBe(false)
    expect(Object.keys(f.browser.state.model.tabs)).toHaveLength(before)

    expect(events.onWillNavigate('https://docs.example/help')).toBe(true)
    const opened = f.browser.tabs.activeTabFor(browserWin)
    expect(opened?.url).toBe('https://docs.example/help')
    expect(f.browser.tabs.ownerOf(opened!.id)).toBe(browserWin)
    expect(f.hostOf(browserWin).shown).toBe(1)
    expect(f.hostOf(browserWin).focused).toBe(1)
    // The app window keeps its one page.
    expect(f.browser.tabs.activeTabFor(win)?.id).toBe(tab.id)
  })

  it('leaves a browser window’s own navigations alone', () => {
    const f = fixture()
    const browserWin = f.browser.allWindows()[0]
    const tab = f.browser.tabs.createTab({ url: 'https://a.example/', active: true }, browserWin)
    expect(f.viewOf(tab.id).events.onWillNavigate('https://b.example/')).toBe(false)
  })

  it('opens the app’s installed record: name, icon, scope and remembered bounds', async () => {
    const f = fixture()
    const browserWin = f.browser.allWindows()[0]
    const tab = f.browser.tabs.createTab({ url: APP_URL, active: true }, browserWin)
    f.browser.webApps.handleMessage(tab.id, {
      type: 'webapp',
      webapp: 'manifest',
      manifestUrl: 'https://app.example/dash/manifest.webmanifest',
      manifest: { name: 'Dash Board', short_name: 'Dash', start_url: '/dash/', scope: '/dash/' }
    })
    await f.browser.webApps.pin(tab.id, 'Dash', browserWin)
    f.browser.webApps.onPinned('https://app.example/dash/', { icon: 'file:///icons/dash.png' })
    // Installing on desktop moved the page into an app window.
    const appWin = f.browser.allWindows().find((w) => w.chrome === 'app')!
    expect(appWin.app).toEqual({
      name: 'Dash',
      icon: 'file:///icons/dash.png',
      scope: 'https://app.example/dash/',
      appId: 'https://app.example/dash/',
      startUrl: 'https://app.example/dash/'
    })
    expect(f.browser.tabs.activeTabFor(appWin)?.url).toBe(APP_URL)
    expect(f.browser.tabs.tab(tab.id)).toBeUndefined()
    expect(f.hostOf(appWin).init.app?.icon).toBe('file:///icons/dash.png')

    // The bounds the window ends at are the app's next launch position.
    f.browser.webApps.rememberBounds('https://app.example/dash/', {
      x: 5,
      y: 6,
      width: 700,
      height: 500
    })
    const again = f.browser.openAppWindow('https://app.example/dash/reports')!
    expect(f.hostOf(again).init.bounds).toEqual({ x: 5, y: 6, width: 700, height: 500 })
    // Within the app's scope; outside it the origin is the scope.
    expect(again.app?.scope).toBe('https://app.example/dash/')
    const other = f.browser.openAppWindow('https://app.example/blog/')!
    expect(other.app?.appId).toBeNull()
    expect(other.app?.scope).toBe('https://app.example/')
  })

  it('routes pages opened from the app window (target=_blank) to the browser window behind it', () => {
    const f = fixture()
    const browserWin = f.browser.allWindows()[0]
    const win = f.browser.openAppWindow(APP_URL)!
    const tab = f.browser.tabs.activeTabFor(win)!
    const ticket = f
      .viewOf(tab.id)
      .events.onOpenWindow('https://docs.example/', 'foreground-tab', true, '')
    expect(ticket?.action).toBe('tab')
    if (!ticket) return
    const adopted = ticket.adopt(
      stub<TabView>({ isDestroyed: () => false, getURL: () => '', isVisible: () => true })
    )
    const owner = f.browser.tabs.ownerOf(adopted.tab.id)
    expect(owner).toBe(browserWin)
    expect(f.browser.tabs.activeTabFor(browserWin)?.id).toBe(adopted.tab.id)
    // Not "next to the opener": the opener's tab is not in this window.
    expect(adopted.tab.openerTabId).toBeNull()
    expect(f.hostOf(browserWin).shown).toBe(1)
  })

  it('finds the browser window behind an app window, opening one when none is alive', () => {
    const f = fixture()
    const browserWin = f.browser.allWindows()[0]
    const win = f.browser.openAppWindow(APP_URL)!
    expect(f.browser.browserWindowFor(win)).toBe(browserWin)
    expect(f.browser.browserWindowFor(browserWin)).toBe(browserWin)
    // The browser window went away: a new one opens for the page.
    browserWin.onClosing()
    browserWin.onClosed()
    const opened = f.browser.browserWindowFor(win)
    expect(opened).not.toBe(win)
    expect(opened.chrome).toBe('full')
    expect(f.browser.allWindows()).toContain(opened)
  })

  it('cannot receive a dragged tab and closes with its page', async () => {
    const f = fixture()
    const browserWin = f.browser.allWindows()[0]
    const win = f.browser.openAppWindow(APP_URL)!
    const tab = f.browser.tabs.createTab({ url: 'https://a.example/', active: true }, browserWin)
    expect(f.browser.tabs.canMoveToWindow(tab, win, browserWin)).toBe(false)
    const appTab = f.browser.tabs.activeTabFor(win)!
    const host = f.hostOf(win)
    let closed = 0
    ;(host.win.host as { close: () => void }).close = () => {
      closed++
    }
    f.browser.tabs.closeTab(appTab.id)
    await new Promise((r) => setTimeout(r, 0))
    expect(closed).toBe(1)
  })
})

describe('--app= launches (MW-23)', () => {
  it('starts on the app window alone and opens the session’s browser windows on demand', () => {
    const f = fixture({ windows: false })
    expect(f.browser.allWindows()).toHaveLength(0)
    const win = f.browser.openAppWindow(APP_URL)!
    expect(f.browser.allWindows()).toEqual([win])
    // The first browser window needed brings the session up: one fresh window.
    const browserWin = f.browser.ensureBrowserWindow()
    expect(browserWin.chrome).toBe('full')
    expect(browserWin.kind).toBe('synced')
    expect(f.browser.allWindows()).toHaveLength(2)
    // Asking again reuses it rather than restoring the session twice.
    expect(f.browser.ensureBrowserWindow()).toBe(browserWin)
    expect(f.browser.allWindows()).toHaveLength(2)
  })

  it('opens the browser windows from an out-of-scope link when the app came up alone', () => {
    const f = fixture({ windows: false })
    const win = f.browser.openAppWindow(APP_URL)!
    const tab = f.browser.tabs.activeTabFor(win)!
    expect(f.viewOf(tab.id).events.onWillNavigate('https://docs.example/')).toBe(true)
    const browserWin = f.browser.allWindows().find((w) => w.chrome === 'full')!
    expect(browserWin).toBeDefined()
    expect(f.browser.tabs.activeTabFor(browserWin)?.url).toBe('https://docs.example/')
  })

  it('opens a plain start as before: the session’s window at once', () => {
    const f = fixture()
    expect(f.browser.allWindows()).toHaveLength(1)
    expect(f.browser.allWindows()[0].chrome).toBe('full')
  })
})
