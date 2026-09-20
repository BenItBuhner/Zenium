import { describe, expect, it, vi } from 'vitest'
import type { EventName, Events, HostCapabilities } from '../../shared/types'
import { Browser } from '../browser'
import type {
  AppHost,
  KeyEventInput,
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'
import type { ZenWindow } from '../window'

/*
 * Keyboard panes (a11y-04/05, shortcuts-menus-35): F6 / Shift+F6 and Shift+Alt+T / Shift+Alt+B
 * reach the chrome as `focus.pane` events, and the core tells the chrome where the key was
 * pressed – a page's view or the chrome document – since the chrome document cannot tell (it
 * reports itself focused while a sibling page view holds the keyboard). A page view that takes
 * the keyboard is reported as `focus.page`, so the chrome lets go of its stale focused control.
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

type Sent = { name: EventName; payload: unknown }

function fakePlatform(io: StoreIO): Platform & {
  sent: Sent[]
  pages: Map<string, TabViewEvents>
} {
  const sent: Sent[] = []
  const pages = new Map<string, TabViewEvents>()
  const capabilities = stub<HostCapabilities>({
    windows: true,
    updates: false,
    agents: false,
    pageControls: false
  })
  return {
    sent,
    pages,
    info: { os: 'linux', version: '0.0.0' },
    capabilities,
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
          isVisible: () => true,
          send: <K extends EventName>(name: K, payload: Events[K]) => {
            sent.push({ name, payload })
          }
        })
    },
    views: stub<TabViewHost>({
      createView: (tab, events) => {
        pages.set(tab.id, events)
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => true,
          getZoom: () => 1
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

function start(): {
  browser: Browser
  platform: ReturnType<typeof fakePlatform>
  win: ZenWindow
  tabId: string
} {
  const platform = fakePlatform(memoryIo())
  const browser = new Browser(platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  const tab = browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
  platform.sent.length = 0
  return { browser, platform, win, tabId: tab.id }
}

const press = (
  key: string,
  mods: Partial<Pick<KeyEventInput, 'shift' | 'alt' | 'control' | 'meta'>> = {}
): KeyEventInput => ({
  type: 'keyDown',
  key,
  control: false,
  alt: false,
  shift: false,
  meta: false,
  isAutoRepeat: false,
  ...mods
})

const paneEvents = (sent: Sent[]): unknown[] =>
  sent.filter((s) => s.name === 'focus.pane').map((s) => s.payload)

describe('F6 and Shift+F6', () => {
  it('are consumed and ask the chrome for the next / previous pane, saying the key came from the page', () => {
    const { browser, platform, win, tabId } = start()
    expect(browser.keys.handle(press('F6'), tabId, win)).toBe(true)
    expect(browser.keys.handle(press('F6', { shift: true }), tabId, win)).toBe(true)
    expect(paneEvents(platform.sent)).toEqual([
      { move: 'next', from: 'page' },
      { move: 'prev', from: 'page' }
    ])
  })

  it('say the key came from the chrome when the chrome document produced it', () => {
    const { browser, platform, win } = start()
    expect(browser.keys.handle(press('F6'), null, win)).toBe(true)
    expect(browser.keys.handle(press('F6', { shift: true }), null, win)).toBe(true)
    expect(paneEvents(platform.sent)).toEqual([
      { move: 'next', from: 'chrome' },
      { move: 'prev', from: 'chrome' }
    ])
  })

  it('no longer open the address bar themselves (F6 used to): Ctrl+L and Alt+D still do', () => {
    const { browser, platform, win, tabId } = start()
    browser.keys.handle(press('F6'), tabId, win)
    expect(platform.sent.some((s) => s.name === 'urlbar.toggle')).toBe(false)
    browser.keys.handle(press('l', { control: true }), tabId, win)
    browser.keys.handle(press('d', { alt: true }), tabId, win)
    expect(platform.sent.filter((s) => s.name === 'urlbar.toggle')).toHaveLength(2)
  })
})

describe('Shift+Alt+T and Shift+Alt+B', () => {
  it('name the toolbar and the bookmarks bar', () => {
    const { browser, platform, win, tabId } = start()
    expect(browser.keys.handle(press('t', { shift: true, alt: true }), tabId, win)).toBe(true)
    expect(browser.keys.handle(press('b', { shift: true, alt: true }), null, win)).toBe(true)
    expect(paneEvents(platform.sent)).toEqual([{ pane: 'toolbar' }, { pane: 'bookmarks' }])
  })
})

describe('a page view that takes the keyboard', () => {
  it('is reported to the chrome as focus.page with its tab', () => {
    const { platform, tabId } = start()
    platform.pages.get(tabId)!.onFocused?.()
    expect(platform.sent.filter((s) => s.name === 'focus.page').map((s) => s.payload)).toEqual([
      { tabId }
    ])
  })
})

describe('activating and closing tabs from the keyboard in the tab strip (a11y-07)', () => {
  it('tab.activate gives the page the keyboard, unless keepFocus keeps it on the strip', () => {
    const { browser, win, tabId } = start()
    const other = browser.tabs.createTab({ url: 'https://example.org/', active: false }, win).id
    const focusContent = vi.spyOn(win, 'focusContent')
    browser.tabs.activateTab(other, win, { keepFocus: true })
    expect(win.activeSpace().activeTabId).toBe(other)
    expect(focusContent).not.toHaveBeenCalled()
    browser.tabs.activateTab(tabId, win)
    expect(focusContent).toHaveBeenCalledTimes(1)
  })

  it('tab.close with keepFocus activates the neighbour without giving the page the keyboard', () => {
    const { browser, win, tabId } = start()
    const other = browser.tabs.createTab({ url: 'https://example.org/', active: false }, win).id
    const focusContent = vi.spyOn(win, 'focusContent')
    browser.tabs.closeTab(tabId, false, win, { keepFocus: true })
    expect(win.activeSpace().activeTabId).toBe(other)
    expect(focusContent).not.toHaveBeenCalled()
    // Closed with the pointer (the row's X, Ctrl+W): the next page takes the keyboard.
    const third = browser.tabs.createTab({ url: 'https://example.net/', active: false }, win).id
    browser.tabs.closeTab(other, false, win)
    expect(win.activeSpace().activeTabId).toBe(third)
    expect(focusContent).toHaveBeenCalledTimes(1)
  })

  it('a close whose unload check takes the page down (the host closes it) keeps the keyboard too', async () => {
    const { browser, platform, win, tabId } = start()
    const other = browser.tabs.createTab({ url: 'https://example.org/', active: false }, win).id
    const view = browser.tabs.view(tabId) as TabView
    // The Electron host runs beforeunload by closing the page: one that does not object is gone
    // at once, so the tab closes through the page's destruction before the check resolves.
    view.confirmUnload = () => {
      platform.pages.get(tabId)?.onDestroyed()
      return Promise.resolve(true)
    }
    const focusContent = vi.spyOn(win, 'focusContent')
    await expect(browser.tabs.requestClose(tabId, false, win, { keepFocus: true })).resolves.toBe(
      true
    )
    expect(browser.tabs.tab(tabId)).toBeUndefined()
    expect(win.activeSpace().activeTabId).toBe(other)
    expect(focusContent).not.toHaveBeenCalled()
    // The same close with the pointer: the neighbour's page takes the keyboard.
    const third = browser.tabs.createTab({ url: 'https://example.net/', active: false }, win).id
    ;(browser.tabs.view(other) as TabView).confirmUnload = () => {
      platform.pages.get(other)?.onDestroyed()
      return Promise.resolve(true)
    }
    await browser.tabs.requestClose(other, false, win)
    expect(win.activeSpace().activeTabId).toBe(third)
    expect(focusContent).toHaveBeenCalledTimes(1)
  })
})
