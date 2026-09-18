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

interface Recorded {
  readonly tabId: string
  readonly events: TabViewEvents
  readonly loads: string[]
}

interface Fixture {
  browser: Browser
  views: Recorded[]
}

function fixture(): Fixture {
  const views: Recorded[] = []
  const capabilities = stub<HostCapabilities>({ windows: true, updates: false, agents: false })
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
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
      createView: (tab: Tab, events: TabViewEvents) => {
        const record: Recorded = { tabId: tab.id, events, loads: [] }
        views.push(record)
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
            record.loads.push(u)
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
  return { browser, views }
}

function submit(browser: Browser, input: string, opts: { background?: boolean } = {}): void {
  const win = browser.focusedWindow()
  browser.handleCommand(win, 'urlbar.submit', {
    input,
    newTab: true,
    tabId: null,
    background: opts.background ?? false
  })
}

describe('submitting a URL from the URL bar', () => {
  it('loads a new active tab exactly once (no blank-document double load)', () => {
    const f = fixture()
    submit(f.browser, 'https://example.com')
    expect(f.views).toHaveLength(1)
    expect(f.views[0].loads).toEqual(['https://example.com'])
  })

  it('loads a new background tab exactly once', () => {
    const f = fixture()
    submit(f.browser, 'https://example.net', { background: true })
    expect(f.views).toHaveLength(1)
    expect(f.views[0].loads).toEqual(['https://example.net'])
  })

  it('upgrades a bare host to https once and still falls back to http on a connection failure', () => {
    const f = fixture()
    f.browser.state.settings.privacy.httpsOnly = 'off'
    submit(f.browser, 'example.com')
    const view = f.views[0]
    expect(view.loads).toEqual(['https://example.com'])
    // -105 (name not resolved) is an http-fallback code: the single upgraded load must have
    // recorded the original host so the fallback can retry over http.
    view.events.onFailLoad(-105, 'net::ERR_NAME_NOT_RESOLVED', 'https://example.com')
    expect(view.loads).toEqual(['https://example.com', 'http://example.com'])
  })

  it('asks before the http fallback while HTTPS-only mode is on (the default)', () => {
    const f = fixture()
    expect(f.browser.state.settings.privacy.httpsOnly).toBe('ask')
    submit(f.browser, 'example.com')
    const view = f.views[0]
    view.events.onFailLoad(-105, 'net::ERR_NAME_NOT_RESOLVED', 'https://example.com')
    expect(view.loads).toHaveLength(2)
    const warning = new URL(view.loads[1])
    expect(warning.protocol).toBe('zen:')
    expect(warning.searchParams.get('kind')).toBe('https-only')
    expect(warning.searchParams.get('url')).toBe('http://example.com')
    expect(warning.searchParams.get('code')).toBe('-105')
  })

  it('navigates an existing tab in place without creating a second view', () => {
    const f = fixture()
    submit(f.browser, 'https://example.com')
    const win = f.browser.focusedWindow()
    const tabId = win.selectedTabIn(win.activeSpace())
    expect(tabId).toBeTruthy()
    f.browser.handleCommand(win, 'urlbar.submit', {
      input: 'https://example.org',
      newTab: false,
      tabId,
      background: false
    })
    expect(f.views).toHaveLength(1)
    expect(f.views[0].loads).toEqual(['https://example.com', 'https://example.org'])
  })
})
