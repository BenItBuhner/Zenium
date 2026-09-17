import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { Browser } from '../browser'
import type {
  AppHost,
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'

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

interface FakeView extends TabView {
  attachedTo: WindowHost | null
  loaded: string[]
}

function fakeView(): FakeView {
  const view: Partial<FakeView> = {
    attachedTo: null,
    loaded: [],
    isDestroyed: () => false,
    isVisible: () => false,
    getTitle: () => '',
    getURL: () => '',
    getZoom: () => 1,
    canGoBack: () => false,
    canGoForward: () => false,
    hasDocument: () => false,
    attachTo(host) {
      view.attachedTo = host
    },
    detach() {
      view.attachedTo = null
    },
    loadURL(url) {
      view.loaded?.push(url)
    }
  }
  return stub<FakeView>(view)
}

interface FakeWindowHost extends WindowHost {
  closed: boolean
}

function fakeWindowHost(): FakeWindowHost {
  let closed = false
  const host: Partial<FakeWindowHost> = {
    get alive() {
      return !closed
    },
    get closed() {
      return closed
    },
    contentSize: () => ({ width: 1280, height: 800 }),
    normalBounds: () => null,
    isFullScreen: () => false,
    isMaximized: () => false,
    isFocused: () => true,
    isVisible: () => true,
    close() {
      closed = true
    }
  }
  return stub<FakeWindowHost>(host)
}

type Pages = Map<string, { view: FakeView; events: TabViewEvents }>

/** A desktop-shaped platform: windows allowed, every page a recording fake. */
function fakePlatform(): Platform & { pages: Pages } {
  const pages: Pages = new Map()
  const capabilities = stub<HostCapabilities>({ windows: true, updates: false, agents: false })
  return {
    pages,
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities,
    io: memoryIo(),
    windows: { create: () => fakeWindowHost() },
    views: stub<TabViewHost>({
      createView: (tab: Tab, events: TabViewEvents) => {
        const view = fakeView()
        pages.set(tab.id, { view, events })
        return view
      }
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub<AppHost>(),
    readabilitySource: () => null
  }
}

async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r))
}

function hostOf(win: { host: WindowHost }): FakeWindowHost {
  return win.host as FakeWindowHost
}

/** A browser with one window whose first tab has a live page; returns that page's events. */
function openerWithPage(): {
  browser: Browser
  pages: Pages
  parent: Tab
  events: TabViewEvents
} {
  const platform = fakePlatform()
  const browser = new Browser(platform)
  browser.start()
  const win = browser.allWindows()[0]
  const parent = browser.tabs.createTab({ url: 'https://opener.example/', active: true }, win)
  const page = platform.pages.get(parent.id)
  if (!page) throw new Error('the opener never got a page')
  return { browser, pages: platform.pages, parent, events: page.events }
}

describe('a page opening a window', () => {
  it('refuses URLs the browser cannot navigate to', () => {
    const { events } = openerWithPage()
    expect(events.onOpenWindow('javascript:alert(1)', 'new-window', true, 'width=500')).toBeNull()
  })

  it('lets a mailto: link through so the external-app prompt can take it', () => {
    const { events } = openerWithPage()
    expect(events.onOpenWindow('mailto:someone@example.com', 'foreground-tab', true)?.action).toBe(
      'tab'
    )
  })

  it('keeps a pop-up the blocker refused blocked, listed for the URL bar', () => {
    const { browser, parent, events } = openerWithPage()
    // No gesture reached the page and the host has no verdict of its own.
    expect(events.onOpenWindow('https://ads.example/', 'new-window', null, 'width=500')).toBeNull()
    expect(browser.allWindows()).toHaveLength(1)
    expect(browser.popups.blockedFor(parent.id).map((p) => p.url)).toEqual(['https://ads.example/'])
  })

  it('opens an allowed new-window as a Zenium window and spends the gesture on it', () => {
    const { browser, parent, events } = openerWithPage()
    events.onUserActivation()
    const ticket = events.onOpenWindow('https://example.com/', 'new-window', null, 'width=500')
    expect(ticket?.action).toBe('window')
    ticket!.adopt(fakeView())
    expect(browser.allWindows().some((w) => w.chrome === 'popup')).toBe(true)
    expect(browser.popups.blockedFor(parent.id)).toEqual([])
    // One pop-up per gesture, as in Chrome: the next one without a fresh gesture is blocked.
    expect(events.onOpenWindow('https://example.com/2', 'new-window', null, 'width=500')).toBeNull()
    expect(browser.popups.blockedFor(parent.id).map((p) => p.url)).toEqual([
      'https://example.com/2'
    ])
  })

  it('needs no gesture on a site the user allowed pop-ups for', () => {
    const { browser, parent, events } = openerWithPage()
    browser.popups.setSiteAllowed(parent.id, true)
    const ticket = events.onOpenWindow('https://example.com/', 'new-window', null, 'width=500')
    expect(ticket?.action).toBe('window')
  })

  it('creates nothing until the host hands over the page', () => {
    const { browser, events } = openerWithPage()
    const ticket = events.onOpenWindow('https://example.com/', 'new-window', true, 'width=500,height=400')
    expect(ticket?.action).toBe('window')
    expect(browser.allWindows()).toHaveLength(1)
    expect(Object.keys(browser.state.model.tabs)).toHaveLength(1)
  })

  it('puts a sized window.open into a toolbar-only Zenium window at that size', async () => {
    const { browser, parent, events } = openerWithPage()
    const opener = browser.allWindows()[0]
    const ticket = events.onOpenWindow('https://example.com/', 'new-window', true, 'width=500,height=400')
    const view = fakeView()
    const { tab, events: popupEvents } = ticket!.adopt(view)

    const popup = browser.allWindows().find((w) => w !== opener)!
    expect(popup.chrome).toBe('popup')
    expect(popup.kind).toBe('unsynced')
    expect(popup.compactEnabled).toBe(false)
    expect(popup.initialBounds).toEqual({ x: 80, y: 80, width: 500, height: 400 })
    // The page is the tab's live view, attached to the popup and selected there.
    expect(view.attachedTo).toBe(popup.host)
    expect(browser.tabs.view(tab.id)).toBe(view)
    expect(browser.tabs.ownerOf(tab.id)).toBe(popup)
    expect(popup.selectedTabIn(popup.activeSpace())).toBe(tab.id)
    expect(tab.containerId).toBe(parent.containerId)
    // The core never loads the page itself: Chromium already navigates the opener's page.
    expect(view.loaded).toEqual([])

    // window.close() in the popup closes the tab, and the popup window with it.
    popupEvents.onDestroyed()
    expect(browser.tabs.tab(tab.id)).toBeUndefined()
    expect(browser.tabs.view(tab.id)).toBeUndefined()
    await settle()
    expect(hostOf(popup).closed).toBe(true)
    expect(hostOf(opener).closed).toBe(false)
  })

  it('opens Shift+click (new-window without features) as a full synced window', () => {
    const { browser, events } = openerWithPage()
    const opener = browser.allWindows()[0]
    const ticket = events.onOpenWindow('https://example.com/', 'new-window', true, '')
    expect(ticket?.action).toBe('window')
    const view = fakeView()
    const { tab } = ticket!.adopt(view)
    const win = browser.allWindows().find((w) => w !== opener)!
    expect(win.chrome).toBe('full')
    expect(win.kind).toBe('synced')
    expect(win.activeSpaceId).toBe(opener.activeSpaceId)
    expect(win.initialBounds).toBeNull()
    expect(view.attachedTo).toBe(win.host)
    expect(win.selectedTabIn(win.activeSpace())).toBe(tab.id)
  })

  it('keeps private openers private', () => {
    const { browser, pages } = openerWithPage()
    const priv = browser.createWindow({ kind: 'private' })
    const privTab = browser.tabs.createTab({ url: 'https://private.example/', active: true }, priv)
    const events = pages.get(privTab.id)!.events
    const ticket = events.onOpenWindow('https://example.com/', 'new-window', true, 'popup')
    const { tab } = ticket!.adopt(fakeView())
    const popup = browser.allWindows().find((w) => w.chrome === 'popup')!
    expect(popup.kind).toBe('private')
    expect(browser.tabs.isPrivate(tab)).toBe(true)
  })

  it('places target=_blank and Ctrl+click as tabs next to the opener', () => {
    const { browser, parent, events } = openerWithPage()
    const win = browser.allWindows()[0]
    const space = win.activeSpace()

    const foreground = events.onOpenWindow('https://example.com/a', 'foreground-tab', true)
    expect(foreground?.action).toBe('tab')
    const a = fakeView()
    const { tab: tabA } = foreground!.adopt(a)
    expect(browser.allWindows()).toHaveLength(1)
    expect(a.attachedTo).toBe(win.host)
    expect(space.tabIds.indexOf(tabA.id)).toBe(space.tabIds.indexOf(parent.id) + 1)
    expect(win.selectedTabIn(space)).toBe(tabA.id)

    const background = events.onOpenWindow('https://example.com/b', 'background-tab', true)
    const b = fakeView()
    const { tab: tabB } = background!.adopt(b)
    expect(space.tabIds.indexOf(tabB.id)).toBe(space.tabIds.indexOf(parent.id) + 1)
    expect(win.selectedTabIn(space)).toBe(tabA.id)
    expect(browser.tabs.ownerOf(tabB.id)).toBe(win)
  })

  it('leaves a full window open when a page-initiated close empties it', () => {
    const { browser, events } = openerWithPage()
    const opener = browser.allWindows()[0]
    const ticket = events.onOpenWindow('https://example.com/', 'new-window', true, '')
    const { tab, events: newEvents } = ticket!.adopt(fakeView())
    const win = browser.allWindows().find((w) => w !== opener)!
    newEvents.onDestroyed()
    expect(browser.tabs.tab(tab.id)).toBeUndefined()
    expect(hostOf(win).closed).toBe(false)
  })

  it('ignores a destroyed report for a page the core already tore down', () => {
    const { browser, parent, events } = openerWithPage()
    browser.tabs.discard(parent.id)
    expect(browser.tabs.tab(parent.id)?.discarded).toBe(true)
    events.onDestroyed()
    expect(browser.tabs.tab(parent.id)).toBeDefined()
  })
})
