import { describe, expect, it } from 'vitest'
import { NEW_TAB_URL } from '../../shared/url'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { Browser } from '../browser'
import { createSpace, createTabRecord } from '../model'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import type { PersistedWindow } from '../state'
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

/** A host whose windows and views do nothing: the desktop (several windows) or a phone (one). */
function platformOf(opts: { windows: boolean; os?: PlatformOs }): Platform {
  const capabilities = stub<HostCapabilities>({
    windows: opts.windows,
    updates: false,
    agents: false
  })
  return {
    info: { os: opts.os ?? 'linux', version: '0.0.0' },
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
      createView: () =>
        stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          hasDocument: () => false,
          getURL: () => '',
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1
        })
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
}

/** A browser over a profile that has been through onboarding; "Restore previous session" on. */
function fresh(opts: { windows?: boolean; os?: PlatformOs } = {}): Browser {
  const browser = new Browser(platformOf({ windows: opts.windows ?? true, os: opts.os }))
  browser.state.settings.onboardingDone = true
  return browser
}

const window = (id: string, spaceId: string, selection: string | null): PersistedWindow => ({
  id,
  bounds: { x: 0, y: 0, width: 1000, height: 700 },
  maximized: false,
  activeSpaceId: spaceId,
  selection: selection ? { [spaceId]: selection } : {},
  compact: false
})

/** Open a page tab in the model's first space, as the last run would have left it. */
function seedTab(browser: Browser, url: string): string {
  const { state } = browser
  const space = state.model.spaces[0]
  const tab = createTabRecord({ spaceId: space.id, containerId: space.containerId, url })
  state.model.tabs[tab.id] = tab
  space.tabIds.push(tab.id)
  space.activeTabId = tab.id
  return tab.id
}

const urls = (browser: Browser): string[] =>
  Object.values(browser.state.model.tabs).map((t) => t.url)
const activeUrl = (browser: Browser, win: ZenWindow): string | undefined =>
  browser.tabs.activeTabFor(win)?.url
const only = (browser: Browser): ZenWindow => {
  const win = browser.allWindows()[0]
  if (!win) throw new Error('no window')
  return win
}

describe('a window always has a tab from its creation (W5-F2)', () => {
  it('a first boot with "Restore previous session" on opens the window on one new tab page', () => {
    const browser = fresh()
    expect(browser.state.settings.restoreSession).toBe(true)
    browser.start()
    expect(browser.allWindows()).toHaveLength(1)
    expect(urls(browser)).toEqual([NEW_TAB_URL])
    expect(activeUrl(browser, only(browser))).toBe(NEW_TAB_URL)
  })

  it('the same on a host with one window (the phone)', () => {
    const browser = fresh({ windows: false, os: 'android' })
    browser.start()
    expect(browser.allWindows()).toHaveLength(1)
    expect(urls(browser)).toEqual([NEW_TAB_URL])
    expect(activeUrl(browser, only(browser))).toBe(NEW_TAB_URL)
  })

  it('with the setting off one fresh tab, as before', () => {
    const browser = fresh()
    browser.state.settings.restoreSession = false
    browser.start()
    expect(urls(browser)).toEqual([NEW_TAB_URL])
  })

  it('a restored window whose space has no tabs left gets one', () => {
    const browser = fresh()
    const space = browser.state.model.spaces[0]
    browser.state.restoredWindows = [window('window_1', space.id, null)]
    browser.start()
    const win = only(browser)
    expect(win.id).toBe('window_1')
    expect(urls(browser)).toEqual([NEW_TAB_URL])
    expect(activeUrl(browser, win)).toBe(NEW_TAB_URL)
  })

  it('a restored window with its tabs comes back as it was, no new tab beside them', () => {
    const browser = fresh()
    const space = browser.state.model.spaces[0]
    const a = seedTab(browser, 'https://example.com/a')
    seedTab(browser, 'https://example.com/b')
    browser.state.restoredWindows = [window('window_1', space.id, a)]
    browser.start()
    expect(urls(browser).sort()).toEqual(['https://example.com/a', 'https://example.com/b'])
    expect(browser.tabs.activeTabFor(only(browser))?.id).toBe(a)
  })

  it('of two restored windows only the one showing an empty space gets a tab', () => {
    const browser = fresh()
    const m = browser.state.model
    const first = m.spaces[0]
    const a = seedTab(browser, 'https://example.com/a')
    const second = createSpace('Empty', '', first.containerId)
    m.spaces.push(second)
    browser.state.restoredWindows = [
      window('window_1', first.id, a),
      window('window_2', second.id, null)
    ]
    browser.start()
    const wins = browser.allWindows()
    expect(wins.map((w) => w.id).sort()).toEqual(['window_1', 'window_2'])
    const w1 = wins.find((w) => w.id === 'window_1')!
    const w2 = wins.find((w) => w.id === 'window_2')!
    expect(browser.tabs.activeTabFor(w1)?.id).toBe(a)
    expect(activeUrl(browser, w2)).toBe(NEW_TAB_URL)
    expect(urls(browser).sort()).toEqual(['https://example.com/a', NEW_TAB_URL])
    expect(second.tabIds).toHaveLength(1)
  })

  it('New Window into an empty space opens on a new tab; into a space with tabs on them', () => {
    const browser = fresh()
    browser.start()
    const first = only(browser)
    const boot = browser.tabs.activeTabFor(first)!
    browser.tabs.closeTab(boot.id, true, first)
    expect(urls(browser)).toEqual([])
    const second = browser.openWindow('synced', first)!
    expect(second).not.toBeNull()
    expect(activeUrl(browser, second)).toBe(NEW_TAB_URL)
    expect(urls(browser)).toEqual([NEW_TAB_URL])
    // A synced window shares the space: a third one shows the same tab, adds none.
    const third = browser.openWindow('synced', second)!
    expect(browser.tabs.activeTabFor(third)?.id).toBe(browser.tabs.activeTabFor(second)?.id)
    expect(urls(browser)).toEqual([NEW_TAB_URL])
  })

  it('a private window starts on its own empty tab, as before', () => {
    const browser = fresh()
    browser.start()
    const priv = browser.openWindow('private', only(browser))!
    expect(priv.isPrivate).toBe(true)
    expect(activeUrl(browser, priv)).toBe(NEW_TAB_URL)
  })

  it('the user closing the last tab leaves the space empty, as today', () => {
    const browser = fresh()
    browser.start()
    const win = only(browser)
    const boot = browser.tabs.activeTabFor(win)!
    browser.tabs.closeTab(boot.id, true, win)
    expect(browser.allWindows()).toHaveLength(1)
    expect(browser.tabs.activeTabFor(win)).toBeUndefined()
    expect(urls(browser)).toEqual([])
  })

  it('a run that "never" restores its pages after a crash starts on one fresh tab, not two', () => {
    const browser = fresh()
    browser.state.settings.crashRestore = 'never'
    browser.state.uncleanExit = true
    browser.start()
    expect(urls(browser)).toEqual([NEW_TAB_URL])
  })

  it('the browser window a run on an app window opens later has its tab too', () => {
    const browser = fresh()
    browser.start({ windows: false })
    expect(browser.allWindows()).toHaveLength(0)
    expect(urls(browser)).toEqual([])
    const win = browser.ensureBrowserWindow()
    expect(browser.allWindows()).toHaveLength(1)
    expect(activeUrl(browser, win)).toBe(NEW_TAB_URL)
  })

  it('the onboarding tour ends on the boot tab instead of opening a second one', () => {
    const browser = new Browser(platformOf({ windows: true }))
    expect(browser.state.settings.onboardingDone).toBe(false)
    browser.start()
    const win = only(browser)
    expect(urls(browser)).toEqual([NEW_TAB_URL])
    browser.handleCommand(win, 'onboarding.complete', {
      searchEngineId: browser.state.settings.searchEngineId,
      colorScheme: 'system',
      essentials: []
    })
    expect(browser.state.settings.onboardingDone).toBe(true)
    expect(urls(browser)).toEqual([NEW_TAB_URL])
    expect(activeUrl(browser, win)).toBe(NEW_TAB_URL)
  })
})
