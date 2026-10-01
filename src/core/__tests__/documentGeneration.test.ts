import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Tab } from '../../shared/types'
import { crashPageUrl, errorPageUrl } from '../../shared/url'
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
 * `Tab.documentGeneration` (motion spec §3.2; the Design Lead's ruling on #740): the core counts
 * a tab's documents as the host reports their commits – up at every committed navigation of a
 * NEW document (`onNavigated` with `inPage` false), unmoved by a same-document navigation (a
 * pushState, a replaceState, a hash change) however the address moves. The page-edge band's
 * dismissal on navigation reads it (`components/band/useBandTabs.ts`): the URL alone cannot
 * tell a pushState to another path from a document. A session's own: never written to
 * state.json, and a restored tab starts over.
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

const PAGE = 'https://feed.example/'

/** A live page in the focused window, and its host events. */
function page(f: Fixture): { tab: () => Tab; events: TabViewEvents } {
  const win = f.browser.focusedWindow()
  const created = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
  const view = f.views.find((v) => v.tabId === created.id)
  if (!view) throw new Error('no view for the page')
  return { tab: () => f.browser.tabs.tab(created.id)!, events: view.events }
}

describe('Tab.documentGeneration (motion spec §3.2, the band’s word for “the document changed”)', () => {
  it('counts up at every committed document and never at a same-document navigation, whatever the address does', () => {
    const f = fixture()
    const { tab, events } = page(f)
    // No document committed yet: absent, read as 0.
    expect(tab().documentGeneration).toBeUndefined()
    events.onStartLoading()
    events.onNavigated(PAGE, false)
    events.onStopLoading()
    expect(tab().documentGeneration).toBe(1)
    // A hash change: the address moves, the document stays.
    events.onNavigated(`${PAGE}#comments`, true)
    expect(tab().url).toBe(`${PAGE}#comments`)
    expect(tab().documentGeneration).toBe(1)
    // A pushState to another path – a feed rewriting its address as it scrolls: still the same
    // document to the core, as the host reported it. The URL is what the band cannot read.
    events.onNavigated(`${PAGE}page/2`, true)
    expect(tab().url).toBe(`${PAGE}page/2`)
    expect(tab().documentGeneration).toBe(1)
    // A reload at the very same address is a new document.
    events.onStartLoading()
    events.onNavigated(`${PAGE}page/2`, false)
    events.onStopLoading()
    expect(tab().documentGeneration).toBe(2)
    // And a navigation to another page, the plain case.
    events.onStartLoading()
    events.onNavigated('https://next.example/', false)
    events.onStopLoading()
    expect(tab().documentGeneration).toBe(3)
    // Another tab's documents are its own count.
    const other = page(f)
    other.events.onNavigated(PAGE, false)
    expect(other.tab().documentGeneration).toBe(1)
    expect(tab().documentGeneration).toBe(3)
  })

  it('an error page and the crash page commit documents of their own (unlike Quick Delete’s stamp, the band is not a visit)', () => {
    const f = fixture()
    const { tab, events } = page(f)
    events.onNavigated(PAGE, false)
    expect(tab().documentGeneration).toBe(1)
    events.onNavigated(errorPageUrl(-106, 'ERR_INTERNET_DISCONNECTED', 'https://b.example/'), false)
    expect(tab().documentGeneration).toBe(2)
    events.onNavigated(crashPageUrl('CRASHED', 'https://b.example/'), false)
    expect(tab().documentGeneration).toBe(3)
  })

  it('is a session’s own: never written to state.json, and a restored tab starts over', async () => {
    const io = memoryIo()
    const f = fixture(io)
    const { tab, events } = page(f)
    events.onNavigated(PAGE, false)
    events.onNavigated('https://next.example/', false)
    expect(tab().documentGeneration).toBe(2)
    await f.browser.state.flush()
    const written = io.readSync('state.json')
    if (!written) throw new Error('state.json was not written')
    const persisted = JSON.parse(written) as { tabs: Array<Record<string, unknown>> }
    const record = persisted.tabs.find((t) => t.url === 'https://next.example/')
    expect(record).toBeDefined()
    expect(record).not.toHaveProperty('documentGeneration')
    // A record that carries one anyway (a hand-edited file, another build's) comes back without:
    // the count is of this session's documents.
    const doctored = JSON.stringify({
      ...persisted,
      tabs: persisted.tabs.map((t) =>
        t.url === 'https://next.example/' ? { ...t, documentGeneration: 7 } : t
      )
    })
    const state = new BrowserState(
      memoryIo({ 'state.json': doctored }),
      'linux',
      {} as HostCapabilities,
      '0.0.0'
    )
    state.load()
    const restored = Object.values(state.model.tabs).find((t) => t.url === 'https://next.example/')
    expect(restored).toBeDefined()
    expect(restored!.documentGeneration).toBeUndefined()
  })
})
