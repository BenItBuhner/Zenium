import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { BLANK_URL, NEW_TAB_URL } from '../../shared/url'
import { Browser } from '../browser'
import { NoExtensions } from '../hostDefaults'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'

/**
 * W8-F14: a launch that carries a URL – `zenium <url>`, another app's link with Zenium as the
 * default browser while it is closed, a dropped file – comes up with ONE tab on the page and no
 * URL bar over it, as Chrome launched with a URL does.
 *
 * The sequence is `src/main/index.ts`'s: `platform.start()` first (→ `openStartupWindows` →
 * `ensureFirstTab` → `openFreshTab`: a fresh empty tab, its announcement armed for the chrome's
 * ready), then `openLaunch(initial)` (→ `Browser.openLaunchUrls`), then the chrome's first load
 * (`onChromeReady`). Since W5-F2 (`eb02d836e`, #490: `ensureFirstTab` in `openStartupWindows`)
 * the argv page went in as a SECOND tab beside the fresh one, and at chrome-ready the arm –
 * made for the window, not the tab – found the page active and emitted `urlbar.toggle
 * {mode:'new-tab'}` with no tab id: the window-level bar over the launched page, which the
 * renderer's `urlbarFollowsActiveTab` never closes, and whose layer took the pointer. Two
 * halves here: the first URL takes the fresh tab, and the arm is the fresh tab's alone.
 */

const FIRST = 'https://first.example/first.html'
const SECOND = 'https://second.example/second.html'

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

interface Fixture {
  browser: Browser
  sent: Array<{ name: string; payload: unknown }>
  override: { url: string | null }
}

function fixture(opts: { newTabPage?: boolean } = {}): Fixture {
  const sent: Fixture['sent'] = []
  const override = { url: null as string | null }
  const capabilities = stub<HostCapabilities>({
    windows: true,
    updates: false,
    agents: false,
    newTabPage: opts.newTabPage ?? true
  })
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
          isVisible: () => true,
          send: (name: string, payload: unknown) => {
            sent.push({ name, payload })
          }
        })
    },
    views: stub<TabViewHost>({
      createView: () => {
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
    readabilitySource: () => null,
    createExtensions: (browser) => {
      const host = new NoExtensions(browser)
      host.newTabUrl = () => override.url
      return host
    }
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  return { browser, sent, override }
}

/** The chrome's first load, and the 150 ms the fresh tab's announcement waits after it. */
async function chromeReady(f: Fixture, win = f.browser.focusedWindow()): Promise<void> {
  f.sent.length = 0
  win.onChromeReady()
  await vi.advanceTimersByTimeAsync(200)
}

function named(f: Fixture, name: string): unknown[] {
  return f.sent.filter((e) => e.name === name).map((e) => e.payload)
}

function tabUrls(f: Fixture): string[] {
  return Object.values(f.browser.state.model.tabs).map((t) => t.url)
}

describe('a launch that carries a URL (zenium <url>, the default-browser path)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('on a fresh profile: one tab on the page, and no URL bar over it at chrome-ready', async () => {
    const f = fixture()
    // 1. `platform.start()`: the startup window and its fresh first tab, chrome not ready yet.
    f.browser.start()
    const win = f.browser.focusedWindow()
    const fresh = f.browser.tabs.activeTabFor(win)
    expect(fresh?.url).toBe(NEW_TAB_URL)
    // 2. `openLaunch(initial)`: the argv URL takes the fresh tab.
    f.browser.openLaunchUrls([FIRST], win)
    expect(tabUrls(f)).toEqual([FIRST])
    expect(f.browser.tabs.activeTabFor(win)?.id).toBe(fresh?.id)
    // 3. The chrome's first load: the page is the content; nothing opens over it.
    await chromeReady(f, win)
    expect(named(f, 'urlbar.toggle')).toEqual([])
    expect(named(f, 'newtab.opened')).toEqual([])
    expect(tabUrls(f)).toEqual([FIRST])
  })

  it('two URLs: the first in the fresh tab, the second beside it, the first in front', async () => {
    const f = fixture()
    f.browser.start()
    const win = f.browser.focusedWindow()
    const fresh = f.browser.tabs.activeTabFor(win)
    f.browser.openLaunchUrls([FIRST, SECOND], win)
    expect(tabUrls(f)).toEqual([FIRST, SECOND])
    expect(f.browser.tabs.tab(fresh!.id)?.url).toBe(FIRST)
    // The second opens as any external URL does – active, the way `openExternalUrl` opens it.
    expect(f.browser.tabs.activeTabFor(win)?.url).toBe(SECOND)
    await chromeReady(f, win)
    expect(named(f, 'urlbar.toggle')).toEqual([])
    expect(named(f, 'newtab.opened')).toEqual([])
  })

  it('a launch with no URL: the fresh tab and its new tab page announced, as before', async () => {
    const f = fixture()
    f.browser.start()
    const win = f.browser.focusedWindow()
    const fresh = f.browser.tabs.activeTabFor(win)
    f.browser.openLaunchUrls([], win)
    expect(tabUrls(f)).toEqual([NEW_TAB_URL])
    await chromeReady(f, win)
    expect(named(f, 'newtab.opened')).toEqual([{ tabId: fresh?.id }])
    expect(named(f, 'urlbar.toggle')).toEqual([])
  })

  it('without the new tab page ("Open the New Tab page" start): the blank tab and the bar, as before; with a URL, the page alone', async () => {
    // No new tab page to seed (`ensureFirstTab` opens nothing there): the fresh tab is the
    // startup plan's, the blank page, when the session does not continue (`openFreshTab`).
    const f = fixture({ newTabPage: false })
    f.browser.state.settings.startup = { ...f.browser.state.settings.startup, mode: 'newTab' }
    f.browser.start()
    const win = f.browser.focusedWindow()
    expect(tabUrls(f)).toEqual([BLANK_URL])
    f.browser.openLaunchUrls([], win)
    await chromeReady(f, win)
    expect(named(f, 'urlbar.toggle')).toEqual([{ mode: 'new-tab' }])

    const g = fixture({ newTabPage: false })
    g.browser.state.settings.startup = { ...g.browser.state.settings.startup, mode: 'newTab' }
    g.browser.start()
    const gWin = g.browser.focusedWindow()
    const blank = g.browser.tabs.activeTabFor(gWin)
    g.browser.openLaunchUrls([FIRST], gWin)
    expect(tabUrls(g)).toEqual([FIRST])
    expect(g.browser.tabs.activeTabFor(gWin)?.id).toBe(blank?.id)
    await chromeReady(g, gWin)
    expect(named(g, 'urlbar.toggle')).toEqual([])
  })

  it("a private window's launch with a URL: the URL in its starter tab, no bar", async () => {
    const f = fixture()
    f.browser.start()
    // `zenium --private-window <url>`: the window, then its URLs (`openLaunch`).
    const priv = f.browser.createWindow({ kind: 'private' })
    const starter = f.browser.tabs.activeTabFor(priv)
    expect(starter?.url).toBe(NEW_TAB_URL)
    f.browser.openLaunchUrls([FIRST], priv)
    expect(f.browser.tabs.activeTabFor(priv)?.id).toBe(starter?.id)
    expect(f.browser.tabs.tab(starter!.id)?.url).toBe(FIRST)
    expect(priv.localSpace?.tabIds).toEqual([starter?.id])
    await chromeReady(f, priv)
    expect(named(f, 'urlbar.toggle')).toEqual([])
    expect(named(f, 'newtab.opened')).toEqual([])
  })

  it("a blank window's launch with a URL: the URL in its starter tab, no bar; without one, the bar", async () => {
    const f = fixture()
    f.browser.start()
    // `zenium --blank-window <url>`.
    const blank = f.browser.createWindow({ kind: 'unsynced' })
    const starter = f.browser.tabs.activeTabFor(blank)
    f.browser.openLaunchUrls([FIRST], blank)
    expect(f.browser.tabs.activeTabFor(blank)?.id).toBe(starter?.id)
    expect(blank.localSpace?.tabIds).toEqual([starter?.id])
    expect(f.browser.tabs.tab(starter!.id)?.url).toBe(FIRST)
    await chromeReady(f, blank)
    expect(named(f, 'urlbar.toggle')).toEqual([])
    expect(named(f, 'newtab.opened')).toEqual([])
    // `zenium --blank-window` alone: the empty tab, and its announcement once the chrome is up.
    const bare = f.browser.createWindow({ kind: 'unsynced' })
    const bareTab = f.browser.tabs.activeTabFor(bare)
    f.browser.openLaunchUrls([], bare)
    await chromeReady(f, bare)
    expect(named(f, 'newtab.opened')).toEqual([{ tabId: bareTab?.id }])
  })

  it('a fresh tab navigated before the chrome is ready does not announce itself', async () => {
    const f = fixture()
    f.browser.start()
    const win = f.browser.focusedWindow()
    const fresh = f.browser.tabs.activeTabFor(win)
    f.browser.tabs.navigate(fresh!.id, FIRST)
    await chromeReady(f, win)
    expect(named(f, 'urlbar.toggle')).toEqual([])
    expect(named(f, 'newtab.opened')).toEqual([])
    // Nor when a page opened beside it took its place in front before the chrome was ready.
    const g = fixture()
    g.browser.start()
    const gWin = g.browser.focusedWindow()
    g.browser.openExternalUrl(SECOND, gWin)
    await chromeReady(g, gWin)
    expect(named(g, 'urlbar.toggle')).toEqual([])
    expect(named(g, 'newtab.opened')).toEqual([])
  })

  it("the fresh tab on an extension's new-tab override is still announced (the bar over it)", async () => {
    const f = fixture()
    f.override.url = 'chrome-extension://laookkfknpbbblfpciffpaejjkokdgca/dashboard.html'
    f.browser.start()
    const win = f.browser.focusedWindow()
    expect(f.browser.tabs.activeTabFor(win)?.url).toBe(f.override.url)
    await chromeReady(f, win)
    expect(named(f, 'urlbar.toggle')).toEqual([{ mode: 'new-tab' }])
  })

  it('a running window on a page: the URL opens beside it, as a second instance always did', async () => {
    const f = fixture()
    f.browser.start()
    const win = f.browser.focusedWindow()
    f.browser.openLaunchUrls([FIRST], win)
    await chromeReady(f, win)
    // A second `zenium <url>` while the window shows a page: a tab beside it.
    f.browser.openLaunchUrls([SECOND], win)
    expect(tabUrls(f)).toEqual([FIRST, SECOND])
    expect(f.browser.tabs.activeTabFor(win)?.url).toBe(SECOND)
  })

  it('a new tab page the user has been somewhere from is not fresh: the URL opens beside it', async () => {
    const f = fixture()
    f.browser.start()
    const win = f.browser.focusedWindow()
    const fresh = f.browser.tabs.activeTabFor(win)!
    // The page went to a site and came back (Back): the tab keeps its history.
    fresh.canGoForward = true
    f.browser.openLaunchUrls([FIRST], win)
    expect(tabUrls(f)).toEqual([NEW_TAB_URL, FIRST])
    // A pinned new tab page is the user's to keep too.
    const g = fixture()
    g.browser.start()
    const gWin = g.browser.focusedWindow()
    const gFresh = g.browser.tabs.activeTabFor(gWin)!
    g.browser.tabs.togglePin(gFresh.id, gWin)
    expect(g.browser.tabs.tab(gFresh.id)?.pinned).toBe(true)
    g.browser.openLaunchUrls([FIRST], gWin)
    expect(tabUrls(g).sort()).toEqual([FIRST, NEW_TAB_URL].sort())
    expect(g.browser.tabs.tab(gFresh.id)?.url).toBe(NEW_TAB_URL)
  })
})
