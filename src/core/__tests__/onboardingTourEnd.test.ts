import { describe, expect, it } from 'vitest'
import { NEW_TAB_URL } from '../../shared/url'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { Browser } from '../browser'
import { createTabRecord } from '../model'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import type { PersistedWindow } from '../state'
import type { ZenWindow } from '../window'

/**
 * The first-run tour's end and the pages under it (W6-S5, W6-HF2's ask). Under the tour a window
 * loads nothing on its own – `onChromeReady` and `onWindowFocused` claim the visible tabs only
 * once `onboardingDone` is up – and `onboarding.complete` ends the tour in a new tab only where
 * the new tab page is served. On a host without it (the phone: `newTabPage` off, one window) a
 * RESTORED page tab under the tour was never loaded or claimed when the tour ended: no view to
 * place, 0 page views on such a profile until the next focus. The tour's end now claims the
 * window's visible tabs itself; the desktop's tour end – on the boot's new tab page, loaded and
 * claimed at its activation – is unchanged.
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

/** What the host's page views were asked, per tab: `loadURL(url)`, `attachTo`, `setVisible(bool)`. */
type ViewLog = Map<string, string[]>

interface Host {
  platform: Platform
  views: ViewLog
  /** The names of the events sent to the window's chrome, in order. */
  sent: string[]
}

/**
 * The desktop (several windows, the new tab page served) or the phone (one window, no new tab
 * page: its chrome draws the blank tab itself), with views that record what they are asked.
 */
function hostOf(opts: { newTabPage: boolean; os?: PlatformOs }): Host {
  const views: ViewLog = new Map()
  const sent: string[] = []
  const capabilities = stub<HostCapabilities>({
    windows: opts.newTabPage,
    newTabPage: opts.newTabPage,
    pageTabs: !opts.newTabPage,
    updates: false,
    agents: false
  })
  const platform: Platform = {
    info: { os: opts.os ?? (opts.newTabPage ? 'linux' : 'android'), version: '0.0.0' },
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
          send: (name) => void sent.push(name)
        })
    },
    views: stub<TabViewHost>({
      createView: (tab) => {
        const log: string[] = []
        views.set(tab.id, log)
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          hasDocument: () => false,
          getURL: () => '',
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          loadURL: (url) => void log.push(`loadURL(${url})`),
          attachTo: () => void log.push('attachTo'),
          setVisible: (visible) => void log.push(`setVisible(${visible})`)
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
  return { platform, views, sent }
}

const persisted = (id: string, spaceId: string, selection: string): PersistedWindow => ({
  id,
  bounds: { x: 0, y: 0, width: 1000, height: 700 },
  maximized: false,
  activeSpaceId: spaceId,
  selection: { [spaceId]: selection },
  compact: false
})

/** A page tab in the model's first space, as the last run left it, restored under the tour. */
function restoreUnderTour(browser: Browser, url: string): string {
  const { state } = browser
  expect(state.settings.onboardingDone).toBe(false)
  const space = state.model.spaces[0]
  const tab = createTabRecord({ spaceId: space.id, containerId: space.containerId, url })
  state.model.tabs[tab.id] = tab
  space.tabIds.push(tab.id)
  space.activeTabId = tab.id
  state.restoredWindows = [persisted('window_1', space.id, tab.id)]
  return tab.id
}

const only = (browser: Browser): ZenWindow => {
  const win = browser.allWindows()[0]
  if (!win) throw new Error('no window')
  return win
}

const completeTour = (browser: Browser, win: ZenWindow): void =>
  browser.handleCommand(win, 'onboarding.complete', {
    searchEngineId: browser.state.settings.searchEngineId,
    colorScheme: 'system',
    essentials: []
  })

const PAGE = 'https://example.com/restored'

describe("the first-run tour's end claims the pages under it (W6-S5)", () => {
  it('on a host without the new tab page a restored page tab is loaded and claimed by the window when the tour ends', () => {
    const host = hostOf({ newTabPage: false })
    const browser = new Browser(host.platform)
    const tabId = restoreUnderTour(browser, PAGE)
    browser.start()
    const win = only(browser)
    expect(win.id).toBe('window_1')
    expect(browser.tabs.activeTabFor(win)?.id).toBe(tabId)
    // The tour is up: the chrome's first load and the window's focus load nothing.
    browser.onChromeReady(win)
    browser.onWindowFocused(win)
    expect(browser.tabs.view(tabId)).toBeUndefined()
    expect(host.views.has(tabId)).toBe(false)
    expect(browser.tabs.ownerOf(tabId)).toBeUndefined()

    completeTour(browser, win)

    expect(browser.state.settings.onboardingDone).toBe(true)
    // The tab has its page now – made in the window that shows it (its owner from the making),
    // hidden until the layout places it, loading its address.
    expect(browser.tabs.view(tabId)).toBeDefined()
    expect(host.views.get(tabId)).toEqual(['setVisible(false)', `loadURL(${PAGE})`])
    expect(browser.tabs.ownerOf(tabId)).toBe(win)
    expect([...browser.tabs.viewsOwnedBy(win).keys()]).toEqual([tabId])
    // No tab was opened beside it: the tour still ends in the URL bar's new-tab mode here.
    expect(Object.keys(browser.state.model.tabs)).toEqual([tabId])
    expect(host.sent).toContain('urlbar.toggle')
  })

  it('the pages stay held under the tour until the tour ends: a focus before it loads nothing, one after it finds the page claimed', () => {
    const host = hostOf({ newTabPage: false })
    const browser = new Browser(host.platform)
    const tabId = restoreUnderTour(browser, PAGE)
    browser.start()
    const win = only(browser)
    browser.onChromeReady(win)
    browser.onWindowFocused(win)
    browser.onWindowFocused(win)
    expect(host.views.has(tabId)).toBe(false)
    completeTour(browser, win)
    const loaded = host.views.get(tabId)
    expect(loaded).toBeDefined()
    const view = browser.tabs.view(tabId)
    // The next focus claims nothing anew: the same page, no second load, no move.
    browser.onWindowFocused(win)
    expect(browser.tabs.view(tabId)).toBe(view)
    expect(host.views.get(tabId)).toEqual(loaded)
  })

  it("on the desktop the tour ends on the boot's new tab page as before: loaded and claimed at its activation, nothing loaded or moved by the tour's end", () => {
    const host = hostOf({ newTabPage: true })
    const browser = new Browser(host.platform)
    expect(browser.state.settings.onboardingDone).toBe(false)
    browser.start()
    const win = only(browser)
    const boot = browser.tabs.activeTabFor(win)
    expect(boot?.url).toBe(NEW_TAB_URL)
    const bootId = boot!.id
    browser.onChromeReady(win)
    // The boot tab's page exists from its activation, owned by the window.
    const view = browser.tabs.view(bootId)
    expect(view).toBeDefined()
    expect(browser.tabs.ownerOf(bootId)).toBe(win)
    const before = [...(host.views.get(bootId) ?? [])]
    expect(before).toContain(`loadURL(${NEW_TAB_URL})`)
    host.sent.length = 0

    completeTour(browser, win)

    expect(browser.state.settings.onboardingDone).toBe(true)
    // The same page, asked nothing more; the one tab; the new tab page's own announcement.
    expect(browser.tabs.view(bootId)).toBe(view)
    expect(host.views.get(bootId)).toEqual(before)
    expect(browser.tabs.ownerOf(bootId)).toBe(win)
    expect(Object.values(browser.state.model.tabs).map((t) => t.url)).toEqual([NEW_TAB_URL])
    expect(host.sent).not.toContain('urlbar.toggle')
  })

  it('a restored page tab under the tour on a host with the new tab page (a desktop profile that ended its first run early) is claimed too, and the tour still ends in a new tab beside it', () => {
    const host = hostOf({ newTabPage: true })
    const browser = new Browser(host.platform)
    const tabId = restoreUnderTour(browser, PAGE)
    browser.start()
    const win = only(browser)
    browser.onChromeReady(win)
    expect(host.views.has(tabId)).toBe(false)
    completeTour(browser, win)
    expect(browser.tabs.ownerOf(tabId)).toBe(win)
    expect(host.views.get(tabId)).toContain(`loadURL(${PAGE})`)
    // The tour's own end, as before: a new tab page opened in front of the restored page.
    const urls = Object.values(browser.state.model.tabs).map((t) => t.url)
    expect(urls.sort()).toEqual([PAGE, NEW_TAB_URL].sort())
    expect(browser.tabs.activeTabFor(win)?.url).toBe(NEW_TAB_URL)
  })

  it("the crash offer's hold is kept, as at boot: a session holding its pages loads nothing at the tour's end, the offer's Restore does", () => {
    // The hold is the desktop's (Android's runs end by a kill and their pages just come back);
    // a host without the new tab page keeps the restored page in front through the tour's end,
    // so the guard is read on that page itself.
    const host = hostOf({ newTabPage: false, os: 'linux' })
    const browser = new Browser(host.platform)
    const tabId = restoreUnderTour(browser, PAGE)
    browser.state.settings.crashRestore = 'ask'
    browser.state.uncleanExit = true
    browser.start()
    const win = only(browser)
    expect(browser.session.holdsPages()).toBe(true)
    browser.onChromeReady(win)
    completeTour(browser, win)
    expect(browser.state.settings.onboardingDone).toBe(true)
    expect(browser.tabs.activeTabFor(win)?.id).toBe(tabId)
    expect(host.views.has(tabId)).toBe(false)
    expect(browser.tabs.ownerOf(tabId)).toBeUndefined()
    browser.session.crashRestore(true)
    expect(browser.tabs.ownerOf(tabId)).toBe(win)
    expect(host.views.get(tabId)).toContain(`loadURL(${PAGE})`)
  })
})
