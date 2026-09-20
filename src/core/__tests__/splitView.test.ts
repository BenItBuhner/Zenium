import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { Browser } from '../browser'
import type {
  MenuHost,
  MenuItemTemplate,
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'
import type { ZenWindow } from '../window'

/*
 * The split view's active pane and the ways into a split (split-06, split-01, split-04): the pane
 * the user is in is the active tab, the menus open a split where Chrome's and Edge's users look,
 * and an empty pane takes a tab picked from the window's others.
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
  /** The events the core wired for a tab's page: the test plays the view's reports through them. */
  eventsOf: (tabId: string) => TabViewEvents
  /** The names of the events sent to the window's chrome, in order, with their payloads. */
  sent: { name: string; payload: unknown }[]
  /** The last template handed to the host's menu popup. */
  shown: () => MenuItemTemplate[]
  open: (url: string) => Tab
  activeId: () => string | undefined
}

function harness(): Harness {
  const events = new Map<string, TabViewEvents>()
  const sent: { name: string; payload: unknown }[] = []
  let last: MenuItemTemplate[] = []
  const menus: MenuHost = {
    popup: (items) => {
      last = items
    }
  }
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '1.2.3' },
    capabilities: stub<HostCapabilities>({ windows: true }),
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
          send: (name, payload) => void sent.push({ name, payload })
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
    menus,
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
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  return {
    browser,
    win,
    sent,
    shown: () => last,
    eventsOf: (tabId) => {
      const e = events.get(tabId)
      if (!e) throw new Error(`no page for ${tabId}`)
      return e
    },
    open: (url) => browser.tabs.createTab({ url, active: true }, win),
    activeId: () => browser.tabs.activeTabFor(win)?.id
  }
}

describe('the active pane of a split (split-06)', () => {
  it('goes to the pane whose page took the keyboard, and the omnibox with it', () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    h.browser.tabs.createSplit([a.id, b.id], 'vertical', h.win)
    expect(h.activeId()).toBe(b.id)
    h.eventsOf(a.id).onFocused?.()
    expect(h.activeId()).toBe(a.id)
    // The chrome's address pill follows the active tab: the state it is sent names a's tab.
    const state = h.browser.state.snapshot(h.win)
    expect(state.spaces.find((s) => s.id === h.win.activeSpaceId)?.activeTabId).toBe(a.id)
  })

  it('goes to the pane a press or a key landed in', () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    h.browser.tabs.createSplit([a.id, b.id], 'horizontal', h.win)
    h.eventsOf(a.id).onUserActivation()
    expect(h.activeId()).toBe(a.id)
    h.eventsOf(b.id).onUserActivation()
    expect(h.activeId()).toBe(b.id)
    // The active pane's own input changes nothing.
    h.eventsOf(b.id).onUserActivation()
    h.eventsOf(b.id).onFocused?.()
    expect(h.activeId()).toBe(b.id)
  })

  it('is not traded with a page outside the shown split', () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    const c = h.open('https://c.example/')
    const d = h.open('https://d.example/')
    h.browser.tabs.createSplit([a.id, b.id], 'vertical', h.win)
    h.browser.tabs.createSplit([c.id, d.id], 'vertical', h.win)
    h.browser.tabs.activateTab(b.id, h.win)
    expect(h.activeId()).toBe(b.id)
    // A pane of another split, or a tab of no split, reporting focus leaves the active tab alone.
    h.eventsOf(c.id).onFocused?.()
    h.eventsOf(d.id).onUserActivation()
    expect(h.activeId()).toBe(b.id)
    const e = h.open('https://e.example/')
    h.browser.tabs.activateTab(b.id, h.win)
    h.eventsOf(e.id).onFocused?.()
    expect(h.activeId()).toBe(b.id)
  })

  it('moves along the split on the pane chords and around its end; outside a split they do nothing', () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    const c = h.open('https://c.example/')
    h.browser.tabs.createSplit([a.id, b.id, c.id], 'grid', h.win)
    h.browser.tabs.activateTab(a.id, h.win)
    h.browser.actions.run('split.nextPane', { sourceTabId: null, win: h.win })
    expect(h.activeId()).toBe(b.id)
    h.browser.actions.run('split.nextPane', { sourceTabId: null, win: h.win })
    h.browser.actions.run('split.nextPane', { sourceTabId: null, win: h.win })
    expect(h.activeId()).toBe(a.id)
    h.browser.actions.run('split.prevPane', { sourceTabId: null, win: h.win })
    expect(h.activeId()).toBe(c.id)
    const lone = h.open('https://lone.example/')
    h.browser.actions.run('split.nextPane', { sourceTabId: null, win: h.win })
    expect(h.activeId()).toBe(lone.id)
  })
})
