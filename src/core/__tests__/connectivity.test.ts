import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Tab } from '../../shared/types'
import { errorPageUrl } from '../../shared/url'
import { Browser } from '../browser'
import { CONNECTIVITY_DEBOUNCE_MS, ERROR_PAGE_RELOADING_SCRIPT } from '../connectivity'
import type {
  ConnectivityHost,
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'

/*
 * The device's connectivity (ERR-06, ERR-07): the host's raw word is debounced into the one
 * `network.online` the chrome renders, and the error pages that stood for being offline reload
 * themselves, once, when the device comes back – the visible ones at once, a hidden one on its
 * turn on screen, and never a page the user navigated away from or closed meanwhile.
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
  tabId: string
  readonly events: TabViewEvents
  readonly loads: string[]
  readonly scripts: string[]
  reloads: number
  destroyed: boolean
}

/** A host whose word the test sets: `set(online)` is `NetworkCallback`'s verdict as Kotlin reports it. */
class FakeConnectivity implements ConnectivityHost {
  private online = true
  private readonly listeners = new Set<(online: boolean) => void>()

  isOnline(): boolean {
    return this.online
  }

  onChange(listener: (online: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  set(online: boolean): void {
    this.online = online
    for (const l of this.listeners) l(online)
  }
}

interface Fixture {
  browser: Browser
  host: FakeConnectivity
  views: Recorded[]
}

function fixture(withHost = true): Fixture {
  const views: Recorded[] = []
  const host = new FakeConnectivity()
  const capabilities = stub<HostCapabilities>({
    windows: true,
    updates: false,
    agents: false,
    newTabPage: false,
    pageTabs: false
  })
  const platform: Platform = {
    info: { os: 'linux', version: '0.0.0' },
    capabilities,
    io: memoryIo(),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          send: () => undefined,
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
        const record: Recorded = {
          tabId: tab.id,
          events,
          loads: [],
          scripts: [],
          reloads: 0,
          destroyed: false
        }
        views.push(record)
        let url = tab.url
        return stub<TabView>({
          isDestroyed: () => record.destroyed,
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
          },
          reload: () => {
            record.reloads += 1
          },
          executeJavaScript: (code: string) => {
            record.scripts.push(code)
            return Promise.resolve(undefined)
          },
          destroy: () => {
            record.destroyed = true
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
    readabilitySource: () => null,
    ...(withHost ? { connectivity: host } : {})
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  return { browser, host, views }
}

function viewOf(f: Fixture, tab: Tab): Recorded {
  const record = f.views.find((v) => v.tabId === tab.id && !v.destroyed)
  if (!record) throw new Error(`no live view for ${tab.url}`)
  return record
}

function online(f: Fixture): boolean {
  return f.browser.state.snapshot(f.browser.focusedWindow()).network.online
}

const PAGE = 'https://news.example/today'
const OTHER = 'https://other.example/'
/** The core writes the default theme's accent into the page's URL (§9.11; the fixture's space has no theme). */
const ACCENT = { light: '#6264dc', dark: '#8284f0' }
const OFFLINE = errorPageUrl(-106, 'net::ERR_INTERNET_DISCONNECTED', PAGE, null, ACCENT)

/** The tab's load of `url` failed with `code` and the error page committed, as the host reports it. */
function fail(view: Recorded, code: number, name: string, url = PAGE): void {
  view.events.onFailLoad(code, `net::${name}`, url)
  const page = view.loads.at(-1)!
  expect(page.startsWith('zen://error?')).toBe(true)
  view.events.onNavigated(page, false)
}

describe('the debounced verdict', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("takes the host's word at start and is online for good without a host", () => {
    const f = fixture()
    expect(online(f)).toBe(true)
    const noHost = fixture(false)
    expect(noHost.browser.platform.connectivity).toBeUndefined()
    expect(online(noHost)).toBe(true)
  })

  it('believes a loss only after it has held for the debounce window', () => {
    const f = fixture()
    f.host.set(false)
    expect(online(f)).toBe(true)
    vi.advanceTimersByTime(CONNECTIVITY_DEBOUNCE_MS - 1)
    expect(online(f)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(online(f)).toBe(false)
  })

  it('never shows a network switch: lost and back within the window is nothing', () => {
    const f = fixture()
    // Every word the chrome could have rendered: the state at each commit.
    const shown: boolean[] = []
    f.browser.state.subscribe(() => shown.push(online(f)))
    f.host.set(false)
    vi.advanceTimersByTime(600)
    f.host.set(true)
    vi.advanceTimersByTime(CONNECTIVITY_DEBOUNCE_MS * 2)
    expect(online(f)).toBe(true)
    expect(shown.filter((o) => !o)).toEqual([])
  })

  it('debounces the way back too, so a network that validates and drops again reloads nothing', () => {
    const f = fixture()
    f.host.set(false)
    vi.advanceTimersByTime(CONNECTIVITY_DEBOUNCE_MS)
    expect(online(f)).toBe(false)
    f.host.set(true)
    vi.advanceTimersByTime(300)
    f.host.set(false)
    vi.advanceTimersByTime(CONNECTIVITY_DEBOUNCE_MS * 2)
    expect(online(f)).toBe(false)
    f.host.set(true)
    vi.advanceTimersByTime(CONNECTIVITY_DEBOUNCE_MS)
    expect(online(f)).toBe(true)
  })

  it('restarts the window on every change of the word', () => {
    const f = fixture()
    f.host.set(false)
    vi.advanceTimersByTime(800)
    f.host.set(true)
    vi.advanceTimersByTime(100)
    f.host.set(false)
    vi.advanceTimersByTime(800)
    expect(online(f)).toBe(true)
    vi.advanceTimersByTime(200)
    expect(online(f)).toBe(false)
  })
})

describe('the error pages that reload themselves', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** The device goes offline (held), then comes back (held). */
  function offline(f: Fixture): void {
    f.host.set(false)
    vi.advanceTimersByTime(CONNECTIVITY_DEBOUNCE_MS)
    expect(online(f)).toBe(false)
  }
  function back(f: Fixture): void {
    f.host.set(true)
    vi.advanceTimersByTime(CONNECTIVITY_DEBOUNCE_MS)
    expect(online(f)).toBe(true)
  }

  it('reloads the visible offline error page, with its own Reloading state first, when the device is back', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    offline(f)
    fail(view, -106, 'ERR_INTERNET_DISCONNECTED')
    expect(f.browser.tabs.tab(tab.id)!.url).toBe(OFFLINE)
    expect(f.browser.connectivity.isArmed(tab.id)).toBe(true)

    back(f)

    expect(view.scripts).toEqual([ERROR_PAGE_RELOADING_SCRIPT])
    // The error page's reload is the page it stands in for, loaded again.
    expect(view.loads.at(-1)).toBe(PAGE)
    expect(f.browser.connectivity.isArmed(tab.id)).toBe(false)
  })

  it('reloads once: a second return without a new failure leaves the page alone', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    offline(f)
    fail(view, -106, 'ERR_INTERNET_DISCONNECTED')
    back(f)
    const loads = view.loads.length
    // The page came back but the network flaps again before it commits: nothing more to do.
    offline(f)
    back(f)
    expect(view.loads).toHaveLength(loads)
    expect(view.scripts).toHaveLength(1)
  })

  it('arms itself again when the reload fails offline too, so the next return tries once more', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    offline(f)
    fail(view, -106, 'ERR_INTERNET_DISCONNECTED')
    const before = view.loads.length
    back(f)
    expect(view.loads.at(-1)).toBe(PAGE)
    // The network went again before the page answered: the reload fails the same way.
    offline(f)
    fail(view, -106, 'ERR_INTERNET_DISCONNECTED')
    back(f)
    expect(view.loads.at(-1)).toBe(PAGE)
    expect(view.loads.slice(before).filter((u) => u === PAGE)).toHaveLength(2)
  })

  it('leaves a page the user navigated away from alone', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    offline(f)
    fail(view, -106, 'ERR_INTERNET_DISCONNECTED')
    // The user typed another address while offline; that load committed (a cached page, say).
    f.browser.tabs.navigate(tab.id, OTHER)
    view.events.onNavigated(OTHER, false)
    const loads = view.loads.length

    back(f)

    expect(view.loads).toHaveLength(loads)
    expect(view.scripts).toEqual([])
    expect(f.browser.connectivity.isArmed(tab.id)).toBe(false)
  })

  it('leaves a page whose second failure was not about being offline alone', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    offline(f)
    fail(view, -106, 'ERR_INTERNET_DISCONNECTED')
    // Back on a captive network, the same tab now fails for another reason: not ours to retry.
    f.host.set(true)
    fail(view, -102, 'ERR_CONNECTION_REFUSED')
    expect(f.browser.connectivity.isArmed(tab.id)).toBe(false)
    const loads = view.loads.length
    vi.advanceTimersByTime(CONNECTIVITY_DEBOUNCE_MS)
    expect(view.loads).toHaveLength(loads)
  })

  it('forgets a tab that was closed meanwhile', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    f.browser.tabs.createTab({ url: OTHER, active: true }, win)
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    offline(f)
    fail(view, -106, 'ERR_INTERNET_DISCONNECTED')
    const loads = view.loads.length
    f.browser.tabs.closeTab(tab.id, true, win)
    expect(f.browser.connectivity.isArmed(tab.id)).toBe(false)
    back(f)
    expect(view.loads).toHaveLength(loads)
    expect(view.scripts).toEqual([])
  })

  it('waits for a hidden tab to come on screen, as Chrome reloads what is looked at', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    offline(f)
    fail(view, -106, 'ERR_INTERNET_DISCONNECTED')
    // The user moves to another tab while offline.
    const other = f.browser.tabs.createTab({ url: OTHER, active: true }, win)
    expect(f.browser.tabs.visibleTabIds(win)).toContain(other.id)
    expect(f.browser.tabs.visibleTabIds(win)).not.toContain(tab.id)

    back(f)

    // Nothing yet: the error page is not on screen, and stays armed.
    expect(view.loads.at(-1)).toBe(OFFLINE)
    expect(f.browser.connectivity.isArmed(tab.id)).toBe(true)

    f.browser.tabs.activateTab(tab.id, win)

    expect(view.scripts).toEqual([ERROR_PAGE_RELOADING_SCRIPT])
    expect(view.loads.at(-1)).toBe(PAGE)
    expect(f.browser.connectivity.isArmed(tab.id)).toBe(false)
  })

  it('does not reload a hidden tab that comes on screen while the device is still offline', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    offline(f)
    fail(view, -106, 'ERR_INTERNET_DISCONNECTED')
    f.browser.tabs.createTab({ url: OTHER, active: true }, win)
    f.browser.tabs.activateTab(tab.id, win)
    expect(view.loads.at(-1)).toBe(OFFLINE)
    expect(f.browser.connectivity.isArmed(tab.id)).toBe(true)
  })

  it("arms a name that would not resolve, or an address out of reach, only on the host's word that the device was offline", () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    // Online: a DNS failure is the site's problem, not the device's.
    fail(view, -105, 'ERR_NAME_NOT_RESOLVED')
    expect(f.browser.connectivity.isArmed(tab.id)).toBe(false)
    // The host says offline (raw, not yet debounced): the same failure now means offline.
    f.host.set(false)
    fail(view, -105, 'ERR_NAME_NOT_RESOLVED')
    expect(f.browser.connectivity.isArmed(tab.id)).toBe(true)
    fail(view, -109, 'ERR_ADDRESS_UNREACHABLE')
    expect(f.browser.connectivity.isArmed(tab.id)).toBe(true)
    // ERR_INTERNET_DISCONNECTED says so by itself, whatever the host's word.
    f.host.set(true)
    fail(view, -106, 'ERR_INTERNET_DISCONNECTED')
    expect(f.browser.connectivity.isArmed(tab.id)).toBe(true)
    // A failure of another kind is never armed.
    fail(view, -102, 'ERR_CONNECTION_REFUSED')
    expect(f.browser.connectivity.isArmed(tab.id)).toBe(false)
  })

  it('reloads the DNS error page it armed when the device comes back', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    offline(f)
    fail(view, -105, 'ERR_NAME_NOT_RESOLVED')
    back(f)
    expect(view.loads.at(-1)).toBe(PAGE)
  })

  it('stops following the host when the browser stops', () => {
    const f = fixture()
    f.browser.connectivity.stop()
    f.host.set(false)
    vi.advanceTimersByTime(CONNECTIVITY_DEBOUNCE_MS * 2)
    expect(online(f)).toBe(true)
  })
})
