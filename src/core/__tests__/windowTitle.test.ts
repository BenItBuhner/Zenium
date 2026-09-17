import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { Browser } from '../browser'
import type {
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
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

function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

/** State broadcasts (and with them title updates) are deferred to the next macrotask. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

interface Recorded {
  readonly tabId: string
  readonly events: TabViewEvents
}

interface Fixture {
  browser: Browser
  views: Recorded[]
  /** Every title each window's host was asked to set, in order. */
  titles: Map<ZenWindow, string[]>
}

function fixture(): Fixture {
  const views: Recorded[] = []
  const titles = new Map<ZenWindow, string[]>()
  const capabilities = stub<HostCapabilities>({ windows: true, updates: false, agents: false })
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities,
    io: memoryIo(),
    windows: {
      create: (win) => {
        const log: string[] = []
        titles.set(win, log)
        return stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          setTitle: (title: string) => {
            if (log.at(-1) !== title) log.push(title)
          }
        })
      }
    },
    views: stub<TabViewHost>({
      createView: (tab: Tab, events: TabViewEvents) => {
        views.push({ tabId: tab.id, events })
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
  return { browser, views, titles }
}

describe('native window title', () => {
  it('is the bare product name for a window without an active tab', async () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    await tick()
    expect(f.titles.get(win)?.at(-1)).toBe('Zenium')
  })

  it('follows the active tab title and updates when the page title changes', async () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    f.browser.handleCommand(win, 'urlbar.submit', {
      input: 'https://example.com',
      newTab: true,
      tabId: null,
      background: false
    })
    await tick()
    expect(f.titles.get(win)?.at(-1)).toBe('example.com - Zenium')
    f.views[0].events.onTitleUpdated('Example Domain')
    await tick()
    expect(f.titles.get(win)?.at(-1)).toBe('Example Domain - Zenium')
  })

  it('prefers a custom tab name and tracks the active tab across switches', async () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    f.browser.handleCommand(win, 'urlbar.submit', {
      input: 'https://example.com',
      newTab: true,
      tabId: null,
      background: false
    })
    const first = win.selectedTabIn(win.activeSpace())
    f.views[0].events.onTitleUpdated('Example Domain')
    f.browser.handleCommand(win, 'urlbar.submit', {
      input: 'https://example.org',
      newTab: true,
      tabId: null,
      background: false
    })
    const second = win.selectedTabIn(win.activeSpace())
    f.views[1].events.onTitleUpdated('Second')
    await tick()
    expect(f.titles.get(win)?.at(-1)).toBe('Second - Zenium')

    f.browser.handleCommand(win, 'tab.rename', { tabId: second, title: 'Renamed' })
    await tick()
    expect(f.titles.get(win)?.at(-1)).toBe('Renamed - Zenium')

    f.browser.handleCommand(win, 'tab.activate', { tabId: first })
    await tick()
    expect(f.titles.get(win)?.at(-1)).toBe('Example Domain - Zenium')

    f.browser.handleCommand(win, 'tab.close', { tabId: first, force: true })
    await tick()
    expect(f.titles.get(win)?.at(-1)).toBe('Renamed - Zenium')
  })

  it('names a second synced window after the shared active tab, also once the first closes', async () => {
    const f = fixture()
    const first = f.browser.focusedWindow()
    f.browser.handleCommand(first, 'urlbar.submit', {
      input: 'https://example.com',
      newTab: true,
      tabId: null,
      background: false
    })
    f.views[0].events.onTitleUpdated('Example Domain')
    const second = f.browser.openWindow('synced', first)
    expect(second).not.toBeNull()
    if (!second) return
    await tick()
    expect(f.titles.get(second)?.at(-1)).toBe('Example Domain - Zenium')

    first.onClosing()
    first.onClosed()
    await tick()
    expect(f.titles.get(second)?.at(-1)).toBe('Example Domain - Zenium')
  })

  it('marks private windows', async () => {
    const f = fixture()
    const origin = f.browser.focusedWindow()
    const priv = f.browser.openWindow('private', origin)
    expect(priv).not.toBeNull()
    if (!priv) return
    await tick()
    // A private window opens on an empty tab with the URL bar up.
    expect(f.titles.get(priv)?.at(-1)).toBe('New Tab - Zenium (Private)')
    f.browser.handleCommand(priv, 'urlbar.submit', {
      input: 'https://example.com',
      newTab: true,
      tabId: null,
      background: false
    })
    const view = f.views.find((v) => v.tabId === priv.selectedTabIn(priv.activeSpace()))
    expect(view).toBeDefined()
    view?.events.onTitleUpdated('Example Domain')
    await tick()
    expect(f.titles.get(priv)?.at(-1)).toBe('Example Domain - Zenium (Private)')
    // The origin window is unaffected by the private one's tabs.
    expect(f.titles.get(origin)?.at(-1)).toBe('Zenium')
  })
})
