import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { Browser } from '../browser'
import type {
  ExtensionHost,
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'
import type { ZenWindow } from '../window'

/*
 * An extension's action popup and the tabs navigating around it: Chrome keeps the popup open
 * while a tab it does not cover navigates (Read Aloud's popup opens its player in a background
 * tab and reads the page through it), and the popup goes with the page under it. The core
 * closes the popup on a top-level navigation of a tab a window shows, and on nothing else.
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

interface Harness {
  browser: Browser
  win: ZenWindow
  /** How many times the core told the extension host to close the popup. */
  closes: () => number
  navigate: (tabId: string, url: string, inPage?: boolean) => void
  open: (url: string, active: boolean) => Tab
}

function harness(): Harness {
  let closes = 0
  const events = new Map<string, TabViewEvents>()
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '1.2.3' },
    capabilities: stub<HostCapabilities>({ windows: true, extensions: true }),
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
      createView: (tab, tabEvents) => {
        events.set(tab.id, tabEvents)
        let url = ''
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
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
    readabilitySource: () => null,
    createExtensions: () =>
      stub<ExtensionHost>({
        start: async () => undefined,
        list: () => [],
        closePopup: () => {
          closes++
        }
      })
  }
  const browser = new Browser(platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  return {
    browser,
    win,
    closes: () => closes,
    navigate: (tabId, url, inPage = false) => {
      const e = events.get(tabId)
      if (!e) throw new Error(`no page for ${tabId}`)
      e.onNavigated(url, inPage)
    },
    open: (url, active) => browser.tabs.createTab({ url, active }, win)
  }
}

describe("an extension's popup while tabs navigate", () => {
  it('stays open while a tab no window shows navigates behind it', () => {
    const h = harness()
    const shown = h.open('https://example.com/', true)
    const player = h.open('https://ext.example/player.html', false)
    expect(h.browser.tabs.activeTabFor(h.win)?.id).toBe(shown.id)
    const before = h.closes()
    h.navigate(player.id, 'https://ext.example/player.html')
    h.navigate(player.id, 'https://ext.example/player.html#reading', true)
    expect(h.closes()).toBe(before)
  })

  it('goes with a top-level navigation of the page under it, not with a fragment change', () => {
    const h = harness()
    const shown = h.open('https://example.com/', true)
    const before = h.closes()
    h.navigate(shown.id, 'https://example.com/#section', true)
    expect(h.closes()).toBe(before)
    h.navigate(shown.id, 'https://example.com/next')
    expect(h.closes()).toBe(before + 1)
  })
})
