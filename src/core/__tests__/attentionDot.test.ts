import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { Browser } from '../browser'
import type {
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'

/*
 * The attention dot on a pinned tab (tabs-11, Chrome's): a pinned or essential tab whose page
 * changes its title while the tab is not in front asks for attention – a mail count, a new
 * message – and the row's favicon wears the dot until the tab is activated. A regular row's
 * title is its own telling, and a change seen in front is no news.
 */

function memoryIo(files: Record<string, string>): StoreIO {
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

interface Recorded {
  tabId: string
  readonly events: TabViewEvents
  destroyed: boolean
}

interface Fixture {
  browser: Browser
  views: Recorded[]
  files: Record<string, string>
}

function fixture(os: PlatformOs = 'linux'): Fixture {
  const views: Recorded[] = []
  const files: Record<string, string> = {}
  const capabilities = stub<HostCapabilities>({
    windows: true,
    updates: false,
    agents: false,
    newTabPage: false,
    pageTabs: false
  })
  const platform: Platform = {
    info: { os, version: '0.0.0' },
    capabilities,
    io: memoryIo(files),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          send: () => undefined,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true
        })
    },
    views: stub<TabViewHost>({
      createView: (tab: Tab, events: TabViewEvents) => {
        const record: Recorded = { tabId: tab.id, events, destroyed: false }
        views.push(record)
        let url = tab.url
        return stub<TabView>({
          isDestroyed: () => record.destroyed,
          isVisible: () => false,
          hasDocument: () => url !== '',
          getURL: () => url,
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          navigationEntries: () => ({ entries: [], index: -1 }),
          loadURL: (u: string) => {
            url = u
          },
          destroy: () => {
            record.destroyed = true
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
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  return { browser, views, files }
}

function viewOf(f: Fixture, tab: Tab): Recorded {
  const record = f.views.find((v) => v.tabId === tab.id && !v.destroyed)
  if (!record) throw new Error(`no live view for ${tab.url}`)
  return record
}

const MAIL = 'https://mail.example/inbox'
const NEWS = 'https://news.example/'

describe('the attention dot on a pinned tab', () => {
  it('is set when a pinned tab in the background changes its title, and cleared on activation', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const mail = f.browser.tabs.createTab({ url: MAIL, active: true }, win)
    viewOf(f, mail).events.onNavigated(MAIL, false)
    viewOf(f, mail).events.onTitleUpdated('Inbox')
    f.browser.tabs.togglePin(mail.id, win)
    expect(f.browser.tabs.tab(mail.id)!.pinned).toBe(true)
    // Seen in front: a title change is no news.
    viewOf(f, mail).events.onTitleUpdated('Inbox (1)')
    expect(f.browser.tabs.tab(mail.id)!.attention).toBeUndefined()

    // Another tab in front; the mail's title ticks over in the background.
    const news = f.browser.tabs.createTab({ url: NEWS, active: true }, win)
    expect(win.selectedTabIn(win.activeSpace())).toBe(news.id)
    viewOf(f, mail).events.onTitleUpdated('Inbox (2)')
    const marked = f.browser.tabs.tab(mail.id)!
    expect(marked.attention).toBe(true)
    expect(marked.title).toBe('Inbox (2)')
    // The same title again is not a change; the dot stays as it is.
    viewOf(f, mail).events.onTitleUpdated('Inbox (2)')
    expect(f.browser.tabs.tab(mail.id)!.attention).toBe(true)

    // Activating the tab is seeing it: the dot goes.
    f.browser.tabs.activateTab(mail.id, win)
    expect(f.browser.tabs.tab(mail.id)!.attention).toBeUndefined()
    // And a change while it is in front sets nothing.
    viewOf(f, mail).events.onTitleUpdated('Inbox (3)')
    expect(f.browser.tabs.tab(mail.id)!.attention).toBeUndefined()
  })

  it('is never set on a regular tab: its row shows the title itself', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const mail = f.browser.tabs.createTab({ url: MAIL, active: true }, win)
    viewOf(f, mail).events.onNavigated(MAIL, false)
    viewOf(f, mail).events.onTitleUpdated('Inbox')
    f.browser.tabs.createTab({ url: NEWS, active: true }, win)
    viewOf(f, mail).events.onTitleUpdated('Inbox (4)')
    const tab = f.browser.tabs.tab(mail.id)!
    expect(tab.title).toBe('Inbox (4)')
    expect(tab.attention).toBeUndefined()
  })

  it('is set on an essential tab too', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const mail = f.browser.tabs.createTab({ url: MAIL, active: true }, win)
    viewOf(f, mail).events.onNavigated(MAIL, false)
    viewOf(f, mail).events.onTitleUpdated('Inbox')
    f.browser.tabs.toggleEssential(mail.id, win)
    expect(f.browser.tabs.tab(mail.id)!.essential).toBe(true)
    f.browser.tabs.createTab({ url: NEWS, active: true }, win)
    viewOf(f, mail).events.onTitleUpdated('Inbox (5)')
    expect(f.browser.tabs.tab(mail.id)!.attention).toBe(true)
  })

  it("is the session's own: the persisted record never carries it", () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const mail = f.browser.tabs.createTab({ url: MAIL, active: true }, win)
    viewOf(f, mail).events.onNavigated(MAIL, false)
    viewOf(f, mail).events.onTitleUpdated('Inbox')
    f.browser.tabs.togglePin(mail.id, win)
    f.browser.tabs.createTab({ url: NEWS, active: true }, win)
    viewOf(f, mail).events.onTitleUpdated('Inbox (6)')
    expect(f.browser.tabs.tab(mail.id)!.attention).toBe(true)

    f.browser.state.flushSync()
    const state = f.files['state.json']
    if (!state) throw new Error('state.json was not written')
    const persisted = JSON.parse(state) as { tabs: Array<Record<string, unknown>> }
    const record = persisted.tabs.find((t) => t.id === mail.id)
    expect(record).toBeDefined()
    expect(record).not.toHaveProperty('attention')
    expect(record!.title).toBe('Inbox (6)')
  })
})
