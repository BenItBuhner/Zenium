import { describe, expect, it } from 'vitest'
import type {
  HostCapabilities,
  NavigationSnapshot,
  Platform as PlatformOs,
  Tab
} from '../../shared/types'
import { Browser } from '../browser'
import type {
  MenuHost,
  MenuItemTemplate,
  Platform,
  StoreIO,
  TabView,
  TabViewHost,
  WindowHost
} from '../platform'
import type { ZenWindow } from '../window'

/**
 * Chrome's middle-click / Ctrl+click (⌘+click on macOS) on Back and Forward (shortcuts-menus-93):
 * the page one step back or forward opens in a new background tab beside the current one, which
 * stays where it is – on the tab's own stack, on the stack menu's rows with the modifier held,
 * and through the two commands the toolbar's buttons send.
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

interface FakeView {
  readonly tabId: string
  view: TabView
  snapshot: NavigationSnapshot
  restored: NavigationSnapshot[]
  loads: string[]
  jumps: number[]
}

function fakeView(tab: Tab): FakeView {
  let url = ''
  const fake: FakeView = {
    tabId: tab.id,
    snapshot: { entries: [], index: -1 },
    restored: [],
    loads: [],
    jumps: [],
    view: undefined as unknown as TabView
  }
  const overrides: Partial<TabView> = {
    isDestroyed: () => false,
    isVisible: () => false,
    loadURL: (u) => {
      fake.loads.push(u)
      url = u
    },
    getURL: () => url,
    getTitle: () => '',
    hasDocument: () => url !== '',
    canGoBack: () => fake.snapshot.index > 0,
    canGoForward: () => fake.snapshot.index < fake.snapshot.entries.length - 1,
    getZoom: () => 1,
    isCurrentlyAudible: () => false,
    navigationEntries: () => fake.snapshot,
    goToIndex: (index) => {
      fake.jumps.push(index)
    },
    restoreNavigation: async (snapshot) => {
      fake.restored.push(snapshot)
      url = snapshot.entries[snapshot.index]?.url ?? ''
    }
  }
  fake.view = new Proxy(overrides as TabView, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
  return fake
}

interface Harness {
  browser: Browser
  win: ZenWindow
  shown: () => MenuItemTemplate[]
  viewOf: (tabId: string) => FakeView
  open: (url: string, opts?: { active?: boolean; load?: boolean }) => Tab
}

function harness(): Harness {
  let last: MenuItemTemplate[] = []
  const views: FakeView[] = []
  const menus: MenuHost = {
    popup: (items) => {
      last = items
    }
  }
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '1.2.3' },
    capabilities: stub<HostCapabilities>({ windows: true, nativeMenus: true }),
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
      createView: (tab) => {
        const fake = fakeView(tab)
        views.push(fake)
        return fake.view
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
    shown: () => last,
    viewOf: (tabId) => {
      const v = [...views].reverse().find((x) => x.tabId === tabId)
      if (!v) throw new Error(`no view for ${tabId}`)
      return v
    },
    open: (url, opts = {}) => browser.tabs.createTab({ url, active: true, ...opts }, win)
  }
}

const stack: NavigationSnapshot = {
  entries: [
    { url: 'https://a.test/one', title: 'One' },
    { url: 'https://a.test/two', title: 'Two', pageState: 'scrolled-to-400' },
    { url: 'https://a.test/three', title: 'Three' }
  ],
  index: 1
}

/** The tab right after `tab` in its space, or undefined. */
function after(win: ZenWindow, tab: Tab): string | undefined {
  const order = win.activeSpace().tabIds
  return order[order.indexOf(tab.id) + 1]
}

describe('middle-click / Ctrl+click Back and Forward (shortcuts-menus-93)', () => {
  it('Back in a new tab: the previous entry loads in a background tab right after this one, which stays put', () => {
    const h = harness()
    const source = h.open('https://a.test/two')
    h.viewOf(source.id).snapshot = stack
    const loadsBefore = [...h.viewOf(source.id).loads]
    const opened = h.browser.tabs.openNavigationStepInNewTab(source.id, -1, h.win)
    expect(opened).toBeDefined()
    if (!opened) return
    expect(opened.url).toBe('https://a.test/one')
    expect(opened.containerId).toBe(source.containerId)
    expect(opened.openerTabId).toBe(source.id)
    expect(after(h.win, source)).toBe(opened.id)
    // The current tab is still the selected one and its own stack was not touched.
    expect(h.win.selectedTabIn(h.win.activeSpace())).toBe(source.id)
    expect(h.viewOf(source.id).jumps).toEqual([])
    expect(h.viewOf(source.id).loads).toEqual(loadsBefore)
    // A fresh load of the entry's URL – a new navigation, not the entry's page state.
    expect(h.viewOf(opened.id).loads).toEqual(['https://a.test/one'])
    expect(h.viewOf(opened.id).restored).toEqual([])
  })

  it('Forward in a new tab takes the next entry; at either end of the stack nothing opens', () => {
    const h = harness()
    const source = h.open('https://a.test/two')
    h.viewOf(source.id).snapshot = stack
    const forward = h.browser.tabs.openNavigationStepInNewTab(source.id, 1, h.win)
    expect(forward?.url).toBe('https://a.test/three')

    const first = h.open('https://b.test/')
    h.viewOf(first.id).snapshot = { entries: [{ url: 'https://b.test/', title: 'B' }], index: 0 }
    const before = h.win.activeSpace().tabIds.length
    expect(h.browser.tabs.openNavigationStepInNewTab(first.id, -1, h.win)).toBeUndefined()
    expect(h.browser.tabs.openNavigationStepInNewTab(first.id, 1, h.win)).toBeUndefined()
    expect(h.win.activeSpace().tabIds).toHaveLength(before)
  })

  it('the toolbar’s commands route to the same', () => {
    const h = harness()
    const source = h.open('https://a.test/two')
    h.viewOf(source.id).snapshot = stack
    h.browser.handleCommand(h.win, 'tab.backInNewTab', { tabId: source.id })
    const back = h.browser.tabs.tab(after(h.win, source))
    expect(back?.url).toBe('https://a.test/one')
    h.browser.handleCommand(h.win, 'tab.forwardInNewTab', { tabId: source.id })
    // The second background open lands after the first (the opener's group, tabs-30).
    const order = h.win.activeSpace().tabIds
    const urls = order.map((id) => h.browser.tabs.tab(id)?.url)
    expect(urls).toEqual(['https://a.test/two', 'https://a.test/one', 'https://a.test/three'])
    expect(h.win.selectedTabIn(h.win.activeSpace())).toBe(source.id)
  })

  it('a stack menu row picked with Ctrl (or ⌘) held opens its entry in a new tab; a plain pick jumps the tab', () => {
    const h = harness()
    const source = h.open('https://a.test/two')
    h.viewOf(source.id).snapshot = stack
    h.browser.handleCommand(h.win, 'tab.navigationMenu', { tabId: source.id })
    const rows = h.shown()
    const three = rows.find((r) => r.label === 'Three')
    const one = rows.find((r) => r.label === 'One')
    expect(three?.click).toBeDefined()
    expect(one?.click).toBeDefined()

    three?.click?.({ control: true, meta: false, shift: false, alt: false })
    expect(h.browser.tabs.tab(after(h.win, source))?.url).toBe('https://a.test/three')
    expect(h.viewOf(source.id).jumps).toEqual([])

    one?.click?.({ control: false, meta: true, shift: false, alt: false })
    const urls = h.win.activeSpace().tabIds.map((id) => h.browser.tabs.tab(id)?.url)
    expect(urls).toContain('https://a.test/one')
    expect(h.viewOf(source.id).jumps).toEqual([])

    one?.click?.()
    expect(h.viewOf(source.id).jumps).toEqual([0])
    expect(h.win.selectedTabIn(h.win.activeSpace())).toBe(source.id)
  })

  it('an unloaded tab opens from its remembered stack', () => {
    const h = harness()
    h.open('https://c.test/')
    const sleeping = h.open('https://a.test/two', { active: false, load: false })
    expect(() => h.viewOf(sleeping.id)).toThrow()
    h.browser.state.tabNavigation.set(sleeping.id, stack)
    const opened = h.browser.tabs.openNavigationStepInNewTab(sleeping.id, -1, h.win)
    expect(opened?.url).toBe('https://a.test/one')
    expect(after(h.win, sleeping)).toBe(opened?.id)
    // The sleeping tab was not woken for it.
    expect(() => h.viewOf(sleeping.id)).toThrow()
  })
})
