import { describe, expect, it, vi } from 'vitest'
import {
  PRIVATE_CONTAINER_ID,
  type HostCapabilities,
  type Platform as PlatformOs,
  type Tab
} from '@shared/types'
import { Browser } from '@core/browser'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '@core/platform'
import type { ZenWindow } from '@core/window'
import { rootBackAction } from '@renderer/lib/back'
import { PRIVATE_TABS_UNAVAILABLE, openShortcutPrivateTab } from '../privateShortcut'

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

/** A running browser on a phone-shaped host, private tabs on unless said otherwise. */
function running(capabilities: Partial<HostCapabilities> = {}): {
  browser: Browser
  win: ZenWindow
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
  return { browser, win: browser.allWindows()[0] }
}

describe("the launcher shortcut's private tab", () => {
  it('is one active tab in the private container, sent by another app: back at its root returns to the launcher', () => {
    const { browser, win } = running()
    const before = Object.keys(browser.state.model.tabs).length
    const regular = browser.tabs.createTab({ url: 'https://open.example/', active: true }, win)
    const toast = vi.spyOn(browser, 'toast')

    const tab = openShortcutPrivateTab(browser, win)

    expect(tab).not.toBeNull()
    expect(Object.keys(browser.state.model.tabs).length).toBe(before + 2)
    expect(tab!.containerId).toBe(PRIVATE_CONTAINER_ID)
    expect(tab!.fromIntent).toBe(true)
    expect(tab!.openerTabId).toBeNull()
    expect(browser.tabs.privateTabs().map((t) => t.id)).toEqual([tab!.id])
    // #117's rule for a tab another app sent: `caller`, not `closeTab` into the regular tab.
    const state = browser.state.snapshot(win)
    expect(state.spaces.find((s) => s.id === state.activeSpaceId)?.activeTabId).toBe(tab!.id)
    expect(rootBackAction(state.tabs[tab!.id], state)).toBe('caller')
    expect(rootBackAction(state.tabs[regular.id], state)).not.toBe('caller')
    expect(toast).not.toHaveBeenCalled()
  })

  it('files in the current space like every private tab, so the private pane and the wipe see it', () => {
    const { browser, win } = running()
    const tab = openShortcutPrivateTab(browser, win)!
    expect(tab.spaceId).toBe(win.activeSpace().id)
    const viaMenu = browser.tabs.newPrivateTab(undefined, win)!
    expect(browser.tabs.tab(viaMenu)!.containerId).toBe(tab.containerId)
    expect(browser.tabs.tab(viaMenu)!.fromIntent).toBe(false)
  })

  it('opens nothing on a WebView without profiles and says why', () => {
    const { browser, win } = running({ privateTabs: false })
    const before = Object.keys(browser.state.model.tabs).length
    const toast = vi.spyOn(browser, 'toast')

    expect(openShortcutPrivateTab(browser, win)).toBeNull()

    expect(Object.keys(browser.state.model.tabs).length).toBe(before)
    expect(browser.tabs.privateTabs()).toEqual([])
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith(PRIVATE_TABS_UNAVAILABLE, 'error', win)
  })
})
