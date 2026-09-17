import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { DEFAULT_CONTAINERS } from '../../shared/defaults'
import { Browser } from '../browser'
import type {
  AppHost,
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'
import type { ZenWindow } from '../window'

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

class FakeTabView {
  destroyed = false
  events: TabViewEvents | null = null
  destroyCalls = 0

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    this.destroyCalls += 1
    this.destroyed = true
    this.events?.onDestroyed()
  }

  /** Electron tearing the view down with its parent window, before `destroyView`. */
  hostDestroyed(): void {
    this.destroyed = true
    this.events?.onDestroyed()
  }
}

function fakePlatform(
  views: FakeTabView[]
): Platform & { hosts: Array<{ alive: boolean; zen: ZenWindow | null; close: () => void }> } {
  const hosts: Array<{ alive: boolean; zen: ZenWindow | null; close: () => void }> = []
  const capabilities = stub<HostCapabilities>({ windows: true, updates: false, agents: false })
  return {
    hosts,
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities,
    io: memoryIo({
      'state.json': JSON.stringify({
        version: 2,
        spaces: [{ id: 'space_1', name: 'Default', icon: '', tabIds: [], activeTabId: null }],
        tabs: [],
        essentialTabIds: [],
        activeSpaceId: 'space_1',
        containers: DEFAULT_CONTAINERS,
        folders: [],
        splitGroups: [],
        settings: { onboardingDone: true, restoreSession: false },
        shortcutOverrides: {},
        bookmarks: [],
        windows: [
          {
            id: 'window_main',
            bounds: null,
            maximized: false,
            activeSpaceId: 'space_1',
            selection: {},
            compact: false
          }
        ]
      })
    }),
    windows: {
      create: (zen: ZenWindow) => {
        const hostState = {
          alive: true,
          zen,
          close: () => {
            hostState.alive = false
            zen.onClosing()
            zen.onClosed()
          }
        }
        hosts.push(hostState)
        return stub<WindowHost>({
          get alive() {
            return hostState.alive
          },
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => hosts[0] === hostState,
          isVisible: () => hostState.alive,
          close: () => hostState.close()
        })
      }
    },
    views: stub<TabViewHost>({
      createView: (_tab, events) => {
        const view = new FakeTabView()
        view.events = events
        views.push(view)
        return stub<TabView>({
          isDestroyed: () => view.isDestroyed(),
          isVisible: () => false,
          destroy: () => view.destroy(),
          detach: () => undefined,
          attachTo: () => undefined,
          hasDocument: () => true,
          getURL: () => 'https://example.com/',
          getTitle: () => 'Example Domain',
          canGoBack: () => false,
          canGoForward: () => false
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
    app: stub<AppHost>(),
    readabilitySource: () => null
  }
}

describe('tab view destruction ordering', () => {
  it('forgets the live page when the host destroys it first, then destroyView is a no-op', () => {
    const created: FakeTabView[] = []
    const platform = fakePlatform(created)
    const browser = new Browser(platform)
    browser.start()
    const win = browser.allWindows()[0]
    const tab = browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    expect(created).toHaveLength(1)
    expect(browser.tabs.view(tab.id)).toBeDefined()

    created[0].hostDestroyed()
    expect(browser.tabs.view(tab.id)).toBeUndefined()
    expect(() => browser.tabs.destroyView(tab.id)).not.toThrow()
    expect(created[0].destroyCalls).toBe(0)
  })

  it('does not throw when onDestroyed fires after destroyView already dropped the record', () => {
    const created: FakeTabView[] = []
    const platform = fakePlatform(created)
    const browser = new Browser(platform)
    browser.start()
    const win = browser.allWindows()[0]
    const tab = browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const fake = created[0]

    expect(() => browser.tabs.destroyView(tab.id)).not.toThrow()
    expect(fake.destroyCalls).toBe(1)
    expect(browser.tabs.view(tab.id)).toBeUndefined()
    expect(() => fake.events?.onDestroyed()).not.toThrow()
  })

  it('closing one of two windows does not throw when the host then reports the view destroyed', () => {
    const created: FakeTabView[] = []
    const platform = fakePlatform(created)
    const browser = new Browser(platform)
    browser.start()
    const first = browser.allWindows()[0]
    browser.tabs.createTab({ url: 'https://example.com/', active: true }, first)
    const second = browser.createWindow({ kind: 'synced', from: first })
    browser.tabs.createTab({ url: 'https://example.org/', active: true }, second)
    expect(browser.allWindows()).toHaveLength(2)

    expect(() => first.host.close()).not.toThrow()
    expect(browser.allWindows()).toHaveLength(1)
    expect(second.alive).toBe(true)
  })
})
