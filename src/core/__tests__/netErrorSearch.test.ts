import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { errorPageSearchOf } from '../../shared/url'
import { Browser } from '../browser'
import type {
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'

/*
 * The error page's search action in the core (ERR-05, "Search <engine> for <term>"): a name
 * that did not resolve is the one failure a typed word ends in, so its zen://error URL carries
 * the profile's default engine – the Settings pick, never a hard-coded one – for the page to
 * fill with the term it derives; every other failure's page carries no engine at all.
 */

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
  /** Documents the core asked the view to load (`loadURL`): the Android WebView's way. */
  readonly loads: string[]
}

function fixture(): { browser: Browser; views: Recorded[] } {
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
          contentSize: () => ({ width: 412, height: 915 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true
        })
    },
    views: stub<TabViewHost>({
      createView: (tab: Tab, events: TabViewEvents) => {
        let url = ''
        const record: Recorded = { tabId: tab.id, events, loads: [] }
        views.push(record)
        return stub<TabView>({
          showErrorPage: undefined,
          isDestroyed: () => false,
          isVisible: () => false,
          hasDocument: () => url !== '',
          getURL: () => url,
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          navigationEntries: () => ({ entries: [], index: -1 }),
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
    privacy: { apply: () => undefined },
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  return { browser, views }
}

/** The failed load of `url` with `code`, as the host reports it; the error page the core loaded. */
function failed(f: ReturnType<typeof fixture>, code: number, name: string, url: string): URL {
  const win = f.browser.focusedWindow()
  f.browser.handleCommand(win, 'urlbar.submit', {
    input: url,
    newTab: true,
    tabId: null,
    background: false
  })
  const view = f.views[f.views.length - 1]
  view.events.onFailLoad(code, `net::${name}`, url)
  const page = new URL(view.loads[view.loads.length - 1])
  expect(page.protocol).toBe('zen:')
  expect(page.searchParams.get('code')).toBe(String(code))
  return page
}

describe("the engine in a DNS miss's error page URL (ERR-05)", () => {
  it("carries the profile's default engine – its name and template – for a name that did not resolve", () => {
    const f = fixture()
    const page = failed(f, -105, 'ERR_NAME_NOT_RESOLVED', 'http://zeniumm/')
    const engine = f.browser.defaultSearchEngine()
    expect(page.searchParams.get('engine')).toBe(engine.name)
    expect(page.searchParams.get('search')).toBe(engine.searchUrl)
    expect(engine.searchUrl).toContain('%s')
    // What the page reads back is the same engine, whole.
    expect(errorPageSearchOf(page.searchParams)).toEqual({
      engine: engine.name,
      template: engine.searchUrl
    })
  })

  it('follows the Settings pick: a custom default is the engine offered, not a shipped one', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const id = f.browser.handleCommand(win, 'search.addEngine', {
      name: 'Marginalia',
      url: 'https://search.marginalia.nu/search?query=%s'
    })
    f.browser.handleCommand(win, 'settings.update', { searchEngineId: id })
    expect(f.browser.defaultSearchEngine().id).toBe(id)

    const page = failed(f, -105, 'ERR_NAME_NOT_RESOLVED', 'http://zeniumm/')
    expect(errorPageSearchOf(page.searchParams)).toEqual({
      engine: 'Marginalia',
      template: 'https://search.marginalia.nu/search?query=%s'
    })
    expect(page.searchParams.get('search')).not.toContain('google')
  })

  it('carries the engine for every unresolved name – the page decides whether the site reads as a term', () => {
    const f = fixture()
    // A dotted host is no search term, but the core does not judge that: the page does, once.
    const page = failed(f, -105, 'ERR_NAME_NOT_RESOLVED', 'https://nowhere.invalid/')
    expect(errorPageSearchOf(page.searchParams)).not.toBeNull()
  })

  it('carries no engine for any other failure: refused, timed out, reset, offline', () => {
    const f = fixture()
    for (const [code, name] of [
      [-102, 'ERR_CONNECTION_REFUSED'],
      [-118, 'ERR_CONNECTION_TIMED_OUT'],
      [-101, 'ERR_CONNECTION_RESET'],
      [-106, 'ERR_INTERNET_DISCONNECTED']
    ] as const) {
      const page = failed(f, code, name, 'http://zeniumm/')
      expect(page.searchParams.has('engine')).toBe(false)
      expect(page.searchParams.has('search')).toBe(false)
      expect(errorPageSearchOf(page.searchParams)).toBeNull()
    }
  })
})
