import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { Browser } from '../browser'
import type { Platform, StoreIO, TabView, TabViewEvents, TabViewHost, WindowHost } from '../platform'

/**
 * The relaunch tab-loss race (#344 finding 5): the Android host tears the Activity down while
 * the core inside its chrome WebView is still running, and the views it destroys used to reach
 * the core as `destroyed` – a page-initiated close – so the outgoing core closed every tab and
 * wrote the tab-less state over the profile the next Activity's core was booting from. The host
 * now says `teardown` first (`Browser.onHostTeardown`): from then on a view's going is not a
 * close, and nothing is written.
 */

interface Written {
  name: string
  text: string
}

function recordingIo(): { io: StoreIO; writes: Written[] } {
  const files: Record<string, string> = {}
  const writes: Written[] = []
  const land = (name: string, text: string): void => {
    files[name] = text
    writes.push({ name, text })
  }
  return {
    writes,
    io: {
      readSync: (name) => files[name] ?? null,
      write: async (name, text) => land(name, text),
      writeSync: (name, text) => land(name, text)
    }
  }
}

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
  destroyCalls: number
}

function fakeView(tab: Tab, events: TabViewEvents): FakeView {
  let url = ''
  const fake: FakeView = { tabId: tab.id, events, destroyCalls: 0, view: undefined as unknown as TabView }
  fake.view = stub<TabView>({
    isDestroyed: () => false,
    destroy: () => {
      fake.destroyCalls += 1
    },
    loadURL: (u) => {
      url = u
    },
    getURL: () => url,
    getTitle: () => '',
    hasDocument: () => url !== '',
    canGoBack: () => false,
    canGoForward: () => false,
    getZoom: () => 1,
    isCurrentlyAudible: () => false
  })
  return fake
}

function fixture(): { browser: Browser; views: FakeView[]; writes: Written[] } {
  const views: FakeView[] = []
  const { io, writes } = recordingIo()
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities: stub<HostCapabilities>({ windows: true, updates: false, agents: false }),
    io,
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
      createView: (tab, events) => {
        const fake = fakeView(tab, events)
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
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  return { browser, views, writes }
}

/** Every debounced write has landed: what follows is the teardown's doing alone. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5_000)
}

function stateWrites(writes: Written[]): Written[] {
  return writes.filter((w) => w.name === 'state.json')
}

/** The URLs of the tabs a written `state.json` would restore. */
function tabUrls(written: Written | undefined): string[] {
  if (!written) return []
  const persisted = JSON.parse(written.text) as { tabs: Array<{ url: string }> }
  return persisted.tabs.map((t) => t.url)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the host tearing itself down under the running browser (Android’s teardown event)', () => {
  it('control: without it, a view that goes is a page close – the tab leaves and the state is written', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const win = f.browser.allWindows()[0]
    const a = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    f.browser.tabs.createTab({ url: 'https://example.org/', active: true }, win)
    await settle()
    const before = stateWrites(f.writes).length

    f.views[0].events.onDestroyed()
    await settle()

    expect(f.browser.tabs.tab(a.id)).toBeUndefined()
    const after = stateWrites(f.writes)
    expect(after.length).toBeGreaterThan(before)
    expect(tabUrls(after.at(-1))).toEqual(['https://example.org/'])
  })

  it('after it, the views’ going closes no tab and writes nothing – the tabs stay for the next core', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const win = f.browser.allWindows()[0]
    const a = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const b = f.browser.tabs.createTab({ url: 'https://example.org/', active: true }, win)
    await settle()
    const before = f.writes.length
    const persisted = stateWrites(f.writes).at(-1)
    expect(tabUrls(persisted)).toEqual(['https://example.com/', 'https://example.org/'])

    f.browser.onHostTeardown()
    expect(f.browser.hostGone).toBe(true)
    // The host dropped its views without a word; a `destroyed` that still arrives (one queued on
    // the bridge before the teardown was heard) is what the race used to turn into a close.
    for (const v of f.views) v.events.onDestroyed()
    await settle()

    for (const id of [a.id, b.id]) {
      const tab = f.browser.tabs.tab(id)
      expect(tab).toBeDefined()
      expect(tab?.discarded).toBe(false)
      expect(f.browser.tabs.view(id)).toBeUndefined()
    }
    expect(Object.keys(f.browser.state.model.tabs)).toHaveLength(2)
    expect(f.writes.length).toBe(before)
    // The state is frozen: not even a close the core is asked for, nor a last-chance flush (a
    // `pause` cannot follow the teardown, but the host's ordering is not what this rests on),
    // puts another `state.json` under the core that boots next.
    f.browser.tabs.closeTab(a.id)
    f.browser.flushSync()
    await settle()
    expect(stateWrites(f.writes).at(-1)).toBe(persisted)
    // The core never destroys a view a dead host cannot hear about.
    for (const v of f.views) expect(v.destroyCalls).toBe(0)
  })

  it('is idempotent and leaves the quit path alone', () => {
    vi.useFakeTimers()
    const f = fixture()
    f.browser.onHostTeardown()
    expect(() => f.browser.onHostTeardown()).not.toThrow()
    expect(f.browser.quitting).toBe(false)
    expect(() => f.browser.shutdown()).not.toThrow()
    expect(f.browser.quitting).toBe(true)
  })
})
