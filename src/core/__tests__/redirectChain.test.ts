import { describe, expect, it } from 'vitest'
import { PRIVATE_CONTAINER_ID, type HostCapabilities, type Tab } from '../../shared/types'
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
 * Redirect chains in history (history-23), as the tabs hand them to the history engine: the
 * hosts report each server redirect of the navigation under way (`onRedirected`), the commit
 * records the hops with the landing as one chain – Chrome's `HistoryAddPageArgs.redirects`. A
 * navigation that starts elsewhere, fails, or lands somewhere else than the chain was bound
 * for leaves no hops behind.
 */

function memoryIo(files: Record<string, string> = {}): StoreIO {
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
  tabId: string
  readonly events: TabViewEvents
}

interface Fixture {
  browser: Browser
  views: Recorded[]
}

function fixture(): Fixture {
  const views: Recorded[] = []
  const platform: Platform = {
    info: { os: 'linux', version: '0.0.0' },
    capabilities: stub<HostCapabilities>({ windows: true, nativeMenus: true }),
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
        views.push({ tabId: tab.id, events })
        let url = tab.url
        return stub<TabView>({
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
          }
        })
      }
    }),
    menus: { popup: () => undefined },
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

const SHORT = 'https://sho.rt/x'
const HTTP = 'http://a.example/'
const LANDING = 'https://a.example/'

/** A live page in the focused window, and its host events. */
function page(f: Fixture, url = SHORT): { tabId: string; events: TabViewEvents } {
  const win = f.browser.focusedWindow()
  const created = f.browser.tabs.createTab({ url, active: true }, win)
  const view = f.views.find((v) => v.tabId === created.id)
  if (!view) throw new Error('no view for the page')
  return { tabId: created.id, events: view.events }
}

/** Every visit in the store, hops included, as recorded: `[url, redirectSource, redirectedFrom]`. */
function recorded(f: Fixture): Array<[string, true | undefined, string[] | undefined]> {
  return f.browser.history
    .exportVisits({ since: 0 })
    .visits.map((v) => [v.url, v.redirectSource, v.redirectedFrom])
}

describe('redirect chains from the hosts to history (history-23)', () => {
  it('records the hops the host reported with the landing as one chain, hidden from the list', () => {
    const f = fixture()
    const { tabId, events } = page(f)
    events.onStartLoading()
    events.onStartNavigation?.(SHORT, false)
    events.onRedirected?.(SHORT, HTTP)
    events.onRedirected?.(HTTP, LANDING)
    events.onNavigated(LANDING, false)
    events.onStopLoading()
    expect(recorded(f)).toEqual([
      [SHORT, true, undefined],
      [HTTP, true, undefined],
      [LANDING, undefined, [SHORT, HTTP]]
    ])
    expect(f.browser.history.visits({ limit: 10 }).map((v) => v.url)).toEqual([LANDING])
    expect(f.browser.history.visits({ limit: 10 })[0].tabId).toBe(tabId)
    // The next commit of the tab is a plain visit: the chain was spent.
    events.onStartNavigation?.('https://b.example/', false)
    events.onNavigated('https://b.example/', false)
    expect(recorded(f).at(-1)).toEqual(['https://b.example/', undefined, undefined])
  })

  it('works without a start event (a host that only reports redirects and commits)', () => {
    const f = fixture()
    const { events } = page(f)
    events.onRedirected?.(SHORT, LANDING)
    events.onNavigated(LANDING, false)
    expect(recorded(f)).toEqual([
      [SHORT, true, undefined],
      [LANDING, undefined, [SHORT]]
    ])
  })

  it('drops the hops when the navigation starts elsewhere, fails, or commits somewhere else', () => {
    const f = fixture()
    const { events } = page(f)
    // A second navigation starts before the redirected one commits.
    events.onStartNavigation?.(SHORT, false)
    events.onRedirected?.(SHORT, HTTP)
    events.onStartNavigation?.('https://b.example/', false)
    events.onNavigated('https://b.example/', false)
    expect(recorded(f)).toEqual([['https://b.example/', undefined, undefined]])
    // The redirect target fails to load: the error page commits, the hop is gone.
    events.onStartNavigation?.(SHORT, false)
    events.onRedirected?.(SHORT, HTTP)
    events.onFailLoad(-105, 'ERR_NAME_NOT_RESOLVED', HTTP)
    events.onStartNavigation?.('https://c.example/', false)
    events.onNavigated('https://c.example/', false)
    expect(recorded(f).at(-1)).toEqual(['https://c.example/', undefined, undefined])
    expect(f.browser.history.visited(SHORT)).toBe(false)
    // The commit is not where the chain was bound for: not this chain's landing.
    events.onStartNavigation?.(SHORT, false)
    events.onRedirected?.(SHORT, HTTP)
    events.onNavigated('https://d.example/', false)
    expect(recorded(f).at(-1)).toEqual(['https://d.example/', undefined, undefined])
    expect(f.browser.history.visited(SHORT)).toBe(false)
  })

  it('continues a chain only from its latest target and never repeats a hop', () => {
    const f = fixture()
    const { events } = page(f)
    events.onStartNavigation?.(SHORT, false)
    events.onRedirected?.(SHORT, HTTP)
    // The same hop reported twice (a host repeating itself) is one hop.
    events.onRedirected?.(SHORT, HTTP)
    events.onRedirected?.(HTTP, LANDING)
    events.onNavigated(LANDING, false)
    expect(recorded(f).at(-1)).toEqual([LANDING, undefined, [SHORT, HTTP]])
  })

  it('leaves a same-document navigation and a private tab out of it', () => {
    const f = fixture()
    const { events } = page(f)
    events.onStartNavigation?.(SHORT, false)
    events.onRedirected?.(SHORT, LANDING)
    events.onNavigated(LANDING, false)
    // A pushState inside the page is a visit of its own, no chain.
    events.onStartNavigation?.(`${LANDING}#s`, true)
    events.onNavigated(`${LANDING}#s`, true)
    expect(recorded(f).at(-1)).toEqual([`${LANDING}#s`, undefined, undefined])
    const before = recorded(f).length
    const win = f.browser.focusedWindow()
    const created = f.browser.tabs.createTab(
      { url: SHORT, active: true, containerId: PRIVATE_CONTAINER_ID },
      win
    )
    const view = f.views.find((v) => v.tabId === created.id)
    view?.events.onStartNavigation?.(SHORT, false)
    view?.events.onRedirected?.(SHORT, LANDING)
    view?.events.onNavigated(LANDING, false)
    expect(recorded(f)).toHaveLength(before)
  })
})
