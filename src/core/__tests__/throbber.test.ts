import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Tab } from '../../shared/types'
import { Browser } from '../browser'
import { BrowserState } from '../state'
import type {
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'

/*
 * The throbber's two phases (tabs-41, Chrome's): a load "waits" from its start until the
 * document commits (the server's first response), then "loads" until the stop; a
 * same-document navigation (pushState, a hash change) is no load to the row, although the
 * frame's loading state toggles around it; a restored tab never wakes up spinning.
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
  io: StoreIO
}

function fixture(io: StoreIO = memoryIo()): Fixture {
  const views: Recorded[] = []
  const platform: Platform = {
    info: { os: 'linux', version: '0.0.0' },
    capabilities: stub<HostCapabilities>({ windows: true, nativeMenus: true }),
    io,
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
  return { browser, views, io }
}

const PAGE = 'https://slow.example/article'

/** A live page in the focused window, and its host events. */
function page(f: Fixture): { tab: () => Tab; events: TabViewEvents } {
  const win = f.browser.focusedWindow()
  const created = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
  const view = f.views.find((v) => v.tabId === created.id)
  if (!view) throw new Error('no view for the page')
  return { tab: () => f.browser.tabs.tab(created.id)!, events: view.events }
}

/** The row's throbber phase as the renderer reads it. */
function phase(tab: Tab): 'waiting' | 'loading' | 'none' {
  if (!tab.loading) return 'none'
  return tab.waiting ? 'waiting' : 'loading'
}

describe('the throbber’s phases (tabs-41)', () => {
  it('waits from the start of a load until the document commits, then loads until the stop', () => {
    const f = fixture()
    const { tab, events } = page(f)
    events.onStartLoading()
    events.onStartNavigation?.(PAGE, false)
    expect(phase(tab())).toBe('waiting')
    // Redirects keep the row waiting: nothing has committed yet.
    events.onStartNavigation?.(`${PAGE}?moved`, false)
    expect(phase(tab())).toBe('waiting')
    // The first byte: the document commits and the ring turns to its loading colour.
    events.onNavigated(`${PAGE}?moved`, false)
    expect(phase(tab())).toBe('loading')
    events.onStopLoading()
    expect(phase(tab())).toBe('none')
    expect(tab().waiting).toBe(false)
    expect(tab().progress).toBe(1)
  })

  it('shows no throbber for a same-document navigation', () => {
    const f = fixture()
    const { tab, events } = page(f)
    events.onStartLoading()
    events.onNavigated(PAGE, false)
    events.onStopLoading()
    // Chromium toggles the frame's loading state around a hash change / pushState too.
    events.onStartLoading()
    events.onStartNavigation?.(`${PAGE}#section-2`, true)
    expect(phase(tab())).toBe('none')
    events.onNavigated(`${PAGE}#section-2`, true)
    expect(phase(tab())).toBe('none')
    events.onStopLoading()
    expect(phase(tab())).toBe('none')
    // The address followed the navigation all the same.
    expect(tab().url).toBe(`${PAGE}#section-2`)
  })

  it('goes back to waiting when a further navigation starts inside a load', () => {
    const f = fixture()
    const { tab, events } = page(f)
    events.onStartLoading()
    events.onStartNavigation?.(PAGE, false)
    events.onNavigated(PAGE, false)
    expect(phase(tab())).toBe('loading')
    // The page's script sends the frame elsewhere before it finished loading: `did-start-loading`
    // does not fire again (the frame was loading already), the navigation does.
    events.onStartNavigation?.('https://elsewhere.example/', false)
    expect(phase(tab())).toBe('waiting')
    events.onNavigated('https://elsewhere.example/', false)
    expect(phase(tab())).toBe('loading')
    events.onStopLoading()
    expect(phase(tab())).toBe('none')
  })

  it('a same-document navigation followed by a real one spins again', () => {
    const f = fixture()
    const { tab, events } = page(f)
    events.onStartLoading()
    events.onStartNavigation?.(`${PAGE}#top`, true)
    expect(phase(tab())).toBe('none')
    events.onStartNavigation?.('https://next.example/', false)
    expect(phase(tab())).toBe('waiting')
    events.onNavigated('https://next.example/', false)
    expect(phase(tab())).toBe('loading')
  })

  it('works for hosts that never report the navigation start (waiting until the commit)', () => {
    const f = fixture()
    const { tab, events } = page(f)
    events.onStartLoading()
    expect(phase(tab())).toBe('waiting')
    events.onNavigated(PAGE, false)
    expect(phase(tab())).toBe('loading')
    events.onStopLoading()
    expect(phase(tab())).toBe('none')
  })

  it('a failed load and a crash end the throbber', () => {
    const f = fixture()
    const { tab, events } = page(f)
    events.onStartLoading()
    events.onStartNavigation?.(PAGE, false)
    expect(phase(tab())).toBe('waiting')
    events.onFailLoad(-105, 'ERR_NAME_NOT_RESOLVED', PAGE)
    expect(phase(tab())).toBe('none')
    expect(tab().waiting).toBe(false)

    events.onStartLoading()
    events.onNavigated(PAGE, false)
    expect(phase(tab())).toBe('loading')
    events.onCrashed('crashed', 11)
    expect(phase(tab())).toBe('none')
    expect(tab().waiting).toBe(false)
  })

  it('never persists a spinning row, and restores one at rest whatever the record says', async () => {
    const io = memoryIo()
    const f = fixture(io)
    const { tab, events } = page(f)
    events.onStartLoading()
    events.onStartNavigation?.(PAGE, false)
    expect(phase(tab())).toBe('waiting')
    await f.browser.state.flush()
    const written = io.readSync('state.json')
    if (!written) throw new Error('state.json was not written')
    const persisted = JSON.parse(written) as { tabs: Array<Record<string, unknown>> }
    const record = persisted.tabs.find((t) => t.url === PAGE)
    expect(record).toMatchObject({ loading: false, waiting: false })

    // A record that claims to be mid-load (an older build's, a crash mid-write) comes back at
    // rest: the throbber is a session's own.
    const doctored = JSON.stringify({
      ...persisted,
      tabs: persisted.tabs.map((t) => (t.url === PAGE ? { ...t, loading: true, waiting: true } : t))
    })
    const state = new BrowserState(
      memoryIo({ 'state.json': doctored }),
      'linux',
      {} as HostCapabilities,
      '0.0.0'
    )
    state.load()
    const restored = Object.values(state.model.tabs).find((t) => t.url === PAGE)
    expect(restored).toBeDefined()
    expect(restored!.loading).toBe(false)
    expect(restored!.waiting).toBe(false)
  })
})
