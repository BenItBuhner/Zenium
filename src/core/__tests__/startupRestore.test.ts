import { describe, expect, it } from 'vitest'
import type { HostCapabilities } from '../../shared/types'
import { Browser } from '../browser'
import { createTabRecord } from '../model'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import type { PersistedWindow } from '../state'

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

/** A desktop host (several windows) whose windows and views do nothing. */
function desktopPlatform(): Platform {
  const capabilities = stub<HostCapabilities>({ windows: true, updates: false, agents: false })
  return {
    info: { os: 'linux', version: '0.0.0' },
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

const PAGES = ['https://example.com/a', 'https://example.com/b']

/**
 * A browser over a profile as the last run left it: "Restore previous session" off, two synced
 * windows and two open (unpinned) tabs in the one space – not started yet.
 */
function lastSession(): Browser {
  const browser = new Browser(desktopPlatform())
  const state = browser.state
  state.settings.onboardingDone = true
  state.settings.restoreSession = false
  const space = state.model.spaces[0]
  for (const url of PAGES) {
    const tab = createTabRecord({ spaceId: space.id, containerId: space.containerId, url })
    state.model.tabs[tab.id] = tab
    space.tabIds.push(tab.id)
  }
  const window = (id: string): PersistedWindow => ({
    id,
    bounds: { x: 0, y: 0, width: 1000, height: 700 },
    maximized: false,
    activeSpaceId: space.id,
    selection: { [space.id]: space.tabIds[0] },
    compact: false
  })
  state.restoredWindows = [window('window_1'), window('window_2')]
  return browser
}

const openUrls = (browser: Browser): string[] =>
  Object.values(browser.state.model.tabs)
    .map((t) => t.url)
    .filter((url) => url.startsWith('https://'))
    .sort()

describe('start({ restoreLastSession }) – the --restore-last-session switch', () => {
  it('leaves the setting in charge without it: one fresh window, the last tabs forgotten', () => {
    const browser = lastSession()
    browser.start()
    expect(browser.allWindows()).toHaveLength(1)
    expect(openUrls(browser)).toEqual([])
    // The setting itself is not touched by a launch either way.
    expect(browser.state.settings.restoreSession).toBe(false)
  })

  it('brings every window and tab of the last session back over the setting', () => {
    const browser = lastSession()
    browser.start({ restoreLastSession: true })
    expect(
      browser
        .allWindows()
        .map((w) => w.id)
        .sort()
    ).toEqual(['window_1', 'window_2'])
    expect(openUrls(browser)).toEqual([...PAGES].sort())
    expect(browser.state.settings.restoreSession).toBe(false)
  })

  it('holds for the browser windows a run on an app window alone opens later', () => {
    const browser = lastSession()
    browser.start({ windows: false, restoreLastSession: true })
    expect(browser.allWindows()).toHaveLength(0)
    expect(openUrls(browser)).toEqual([...PAGES].sort())
    browser.ensureBrowserWindow()
    expect(
      browser
        .allWindows()
        .map((w) => w.id)
        .sort()
    ).toEqual(['window_1', 'window_2'])
  })
})
