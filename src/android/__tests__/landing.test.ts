import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PRIVATE_CONTAINER_ID,
  type HostCapabilities,
  type Platform as PlatformOs,
  type Tab
} from '@shared/types'
import { BLANK_URL } from '@shared/url'
import { Browser } from '@core/browser'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '@core/platform'
import type { ZenWindow } from '@core/window'
import { rootBackAction } from '@renderer/lib/back'
import { browserStore } from '@renderer/lib/browserStore'
import {
  LANDING_STATES,
  landFromIntent,
  parseLanding,
  surfaceOf,
  type LandingSurfaces
} from '../landing'
import { PRIVATE_TABS_UNAVAILABLE } from '../privateShortcut'

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

/** Anything the browser touches on the host answers with a harmless no-op. */
function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

function fakeView(tab: Tab): TabView {
  let url = tab.url
  let destroyed = false
  return stub<TabView>({
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
    },
    loadURL: (u: string) => {
      url = u
    },
    getURL: () => url,
    getTitle: () => '',
    hasDocument: () => url !== '',
    canGoBack: () => false,
    canGoForward: () => false,
    getZoom: () => 1,
    isCurrentlyAudible: () => false,
    isVisible: () => true
  })
}

/** A running browser on a phone-shaped host with a page open, private tabs on unless said otherwise. */
function running(capabilities: Partial<HostCapabilities> = {}): {
  browser: Browser
  win: ZenWindow
  page: Tab
} {
  const platform: Platform = {
    info: { os: 'android' as PlatformOs, version: '0.0.0' },
    capabilities: stub<HostCapabilities>({
      windows: false,
      updates: false,
      agents: false,
      passwords: false,
      extensions: false,
      privateTabs: true,
      ...capabilities
    }),
    io: memoryIo(),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 400, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true
        })
    },
    views: stub<TabViewHost>({
      createView: (tab: Tab) => fakeView(tab)
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
  const win = browser.allWindows()[0]
  const page = browser.tabs.createTab({ url: 'https://open.example/', active: true }, win)
  return { browser, win, page }
}

/** The surfaces as a recorder: which one went up, over which tab. */
function recorder(): { over: LandingSurfaces; calls: Array<[keyof LandingSurfaces, string]> } {
  const calls: Array<[keyof LandingSurfaces, string]> = []
  return {
    calls,
    over: {
      omnibox: (tabId) => calls.push(['omnibox', tabId]),
      voice: (tabId) => calls.push(['voice', tabId]),
      scan: (tabId) => calls.push(['scan', tabId])
    }
  }
}

const now = (fn: () => void): void => fn()

const activeTabId = (browser: Browser, win: ZenWindow): string | null | undefined => {
  const state = browser.state.snapshot(win)
  return state.spaces.find((s) => s.id === state.activeSpaceId)?.activeTabId
}

afterEach(() => {
  browserStore.set({ state: null })
  vi.restoreAllMocks()
})

describe('the landing words', () => {
  it("are Landing.kt's five, read as they come and canonicalised", () => {
    expect(LANDING_STATES).toEqual(['search', 'voice', 'private', 'scan', 'newTab'])
    for (const state of LANDING_STATES) expect(parseLanding(state)).toBe(state)
    expect(parseLanding(' Search ')).toBe('search')
    expect(parseLanding('NEWTAB')).toBe('newTab')
  })

  it('reject anything else', () => {
    for (const junk of ['', '  ', 'lens', 'search voice', 'https://example.com/', null, 4, {}])
      expect(parseLanding(junk)).toBeNull()
  })

  it('name the surface each state puts over its tab', () => {
    expect(surfaceOf('search')).toBe('omnibox')
    expect(surfaceOf('voice')).toBe('voice')
    expect(surfaceOf('scan')).toBe('scan')
    expect(surfaceOf('newTab')).toBeNull()
    expect(surfaceOf('private')).toBeNull()
  })
})

describe('landing from a widget or a shortcut', () => {
  it("search: a new blank tab is active in this turn – the page never paints – and the omnibox goes up over it", () => {
    const { browser, win, page } = running()
    const { over, calls } = recorder()

    const tab = landFromIntent('search', browser, win, over, now)

    expect(tab).not.toBeNull()
    expect(tab!.id).not.toBe(page.id)
    expect(tab!.url).toBe(BLANK_URL)
    expect(tab!.containerId).not.toBe(PRIVATE_CONTAINER_ID)
    expect(activeTabId(browser, win)).toBe(tab!.id)
    expect(calls).toEqual([['omnibox', tab!.id]])
  })

  it('voice and scan: the same new tab, the sheet over it', () => {
    const { browser, win } = running()
    const { over, calls } = recorder()

    const voice = landFromIntent('voice', browser, win, over, now)!
    const scan = landFromIntent('scan', browser, win, over, now)!

    expect(voice.id).not.toBe(scan.id)
    expect(calls).toEqual([
      ['voice', voice.id],
      ['scan', scan.id]
    ])
    expect(activeTabId(browser, win)).toBe(scan.id)
  })

  it('newTab: a new blank tab at rest, nothing over it', () => {
    const { browser, win } = running()
    const { over, calls } = recorder()
    const before = Object.keys(browser.state.model.tabs).length

    const tab = landFromIntent('newTab', browser, win, over, now)!

    expect(Object.keys(browser.state.model.tabs).length).toBe(before + 1)
    expect(tab.url).toBe(BLANK_URL)
    expect(activeTabId(browser, win)).toBe(tab.id)
    expect(calls).toEqual([])
  })

  it("private: the shortcut's private tab, as before the widget", () => {
    const { browser, win } = running()
    const { over, calls } = recorder()

    const tab = landFromIntent('private', browser, win, over, now)!

    expect(tab.containerId).toBe(PRIVATE_CONTAINER_ID)
    expect(tab.fromIntent).toBe(true)
    expect(activeTabId(browser, win)).toBe(tab.id)
    expect(calls).toEqual([])
  })

  it('private on a WebView without profiles: nothing opens and the toast says why', () => {
    const { browser, win, page } = running({ privateTabs: false })
    const toast = vi.spyOn(browser, 'toast')

    expect(landFromIntent('private', browser, win, recorder().over, now)).toBeNull()

    expect(activeTabId(browser, win)).toBe(page.id)
    expect(toast).toHaveBeenCalledWith(PRIVATE_TABS_UNAVAILABLE, 'error', win)
  })

  it("the widget's tab is one the launcher sent: back at its root returns to the launcher and closes it (#117)", () => {
    const { browser, win, page } = running()
    const tab = landFromIntent('search', browser, win, recorder().over, now)!

    expect(tab.fromIntent).toBe(true)
    const state = browser.state.snapshot(win)
    expect(rootBackAction(state.tabs[tab.id], state)).toBe('caller')
    expect(rootBackAction(state.tabs[page.id], state)).not.toBe('caller')
  })

  it('a word the chrome does not know lands nowhere, and says so once', () => {
    const { browser, win, page } = running()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const before = Object.keys(browser.state.model.tabs).length

    expect(landFromIntent('lens', browser, win, recorder().over, now)).toBeNull()

    expect(Object.keys(browser.state.model.tabs).length).toBe(before)
    expect(activeTabId(browser, win)).toBe(page.id)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('when the surface goes up', () => {
  it('cold: the tab is made in this turn, the surface waits for the chrome to hold the state, then goes up once', () => {
    const { browser, win } = running()
    const { over, calls } = recorder()
    browserStore.set({ state: null })

    const tab = landFromIntent('search', browser, win, over)!

    expect(activeTabId(browser, win)).toBe(tab.id)
    expect(calls).toEqual([])
    browserStore.set({ state: browser.state.snapshot(win) })
    expect(calls).toEqual([['omnibox', tab.id]])
    browserStore.set({ state: browser.state.snapshot(win) })
    expect(calls).toHaveLength(1)
  })

  it("warm: the chrome holds the state already, so the surface goes up in the intent's own turn", () => {
    const { browser, win } = running()
    const { over, calls } = recorder()
    browserStore.set({ state: browser.state.snapshot(win) })

    const tab = landFromIntent('voice', browser, win, over)!

    expect(calls).toEqual([['voice', tab.id]])
  })
})
