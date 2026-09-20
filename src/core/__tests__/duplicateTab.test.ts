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
 * Chrome's Duplicate (tabs-22, context-menus-95) clones the tab's back/forward stack; its tab
 * menu moves a tab to a new window or to another one by name (tabs-23, context-menus-93).
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

/** A page as the host sees it: a scripted back/forward stack, and what it was asked to do. */
interface FakeView {
  readonly tabId: string
  view: TabView
  /** What `navigationEntries()` reports; tests script the page's stack here. */
  snapshot: NavigationSnapshot
  /** Every stack the host was asked to replay. */
  restored: NavigationSnapshot[]
  /** Every bare `loadURL`. */
  loads: string[]
}

function fakeView(tab: Tab): FakeView {
  let url = ''
  const fake: FakeView = {
    tabId: tab.id,
    snapshot: { entries: [], index: -1 },
    restored: [],
    loads: [],
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
    canGoBack: () => false,
    canGoForward: () => false,
    getZoom: () => 1,
    isCurrentlyAudible: () => false,
    navigationEntries: () => fake.snapshot,
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
  /** The last template handed to the host's menu popup. */
  shown: () => MenuItemTemplate[]
  /** The newest page of a tab. */
  viewOf: (tabId: string) => FakeView
  /** A regular tab in the window's space, loaded (active) unless told otherwise. */
  open: (
    url: string,
    win?: ZenWindow,
    opts?: { folderId?: string; containerId?: string; active?: boolean; load?: boolean }
  ) => Tab
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
    open: (url, w = win, opts = {}) => browser.tabs.createTab({ url, active: true, ...opts }, w)
  }
}

function item(items: MenuItemTemplate[], label: string): MenuItemTemplate {
  const found = items.find((i) => i.label === label)
  if (!found) throw new Error(`no "${label}" in ${items.map((i) => i.label ?? '-').join(', ')}`)
  return found
}

const stack: NavigationSnapshot = {
  entries: [
    { url: 'https://a.test/one', title: 'One' },
    { url: 'https://a.test/two', title: 'Two', pageState: 'scrolled-to-400' },
    { url: 'https://a.test/three', title: 'Three' }
  ],
  index: 1
}

describe('Duplicate Tab (tabs-22, context-menus-95)', () => {
  it('the copy comes up with the tab’s back/forward stack, right after it, active', () => {
    const h = harness()
    const source = h.open('https://a.test/two')
    h.open('https://b.test/')
    h.viewOf(source.id).snapshot = stack
    const copy = h.browser.tabs.duplicate(source.id, h.win)
    expect(copy).toBeDefined()
    if (!copy) return
    expect(copy.id).not.toBe(source.id)
    expect(copy.url).toBe('https://a.test/two')
    expect(copy.containerId).toBe(source.containerId)
    const order = h.win.activeSpace().tabIds
    expect(order.indexOf(copy.id)).toBe(order.indexOf(source.id) + 1)
    expect(h.win.selectedTabIn(h.win.activeSpace())).toBe(copy.id)
    // The page replays the stack, current entry and page state included, instead of a bare load.
    expect(h.viewOf(copy.id).restored).toEqual([stack])
    expect(h.viewOf(copy.id).loads).toEqual([])
    // The source keeps its own page.
    expect(h.viewOf(source.id).restored).toEqual([])
  })

  it('a tab in a folder duplicates into the folder, next to itself', () => {
    const h = harness()
    const source = h.open('https://a.test/two')
    const folderId = h.browser.handleCommand(h.win, 'folder.create', {
      spaceId: h.win.activeSpaceId,
      name: 'Research',
      icon: '📁',
      rename: false
    }) as string
    h.browser.tabs.moveToFolder(source.id, folderId)
    h.viewOf(source.id).snapshot = stack
    const copy = h.browser.tabs.duplicate(source.id, h.win)
    expect(copy?.folderId).toBe(folderId)
    const order = h.win.activeSpace().tabIds
    expect(order.indexOf(copy?.id ?? '')).toBe(order.indexOf(source.id) + 1)
  })

  it('an unloaded tab duplicates from its remembered stack; one with nothing remembered loads its URL', () => {
    const h = harness()
    h.open('https://c.test/')
    const remembered = h.open('https://a.test/two', h.win, { active: false, load: false })
    const bare = h.open('https://d.test/', h.win, { active: false, load: false })
    expect(() => h.viewOf(remembered.id)).toThrow()
    h.browser.state.tabNavigation.set(remembered.id, stack)

    const copy = h.browser.tabs.duplicate(remembered.id, h.win)
    expect(copy).toBeDefined()
    if (!copy) return
    expect(h.viewOf(copy.id).restored).toEqual([stack])
    expect(h.viewOf(copy.id).loads).toEqual([])

    const plain = h.browser.tabs.duplicate(bare.id, h.win)
    expect(plain).toBeDefined()
    if (!plain) return
    expect(h.viewOf(plain.id).restored).toEqual([])
    expect(h.viewOf(plain.id).loads).toEqual(['https://d.test/'])
  })

  it('the tab menu’s Duplicate Tab does the same', () => {
    const h = harness()
    const source = h.open('https://a.test/two')
    h.viewOf(source.id).snapshot = stack
    h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: source.id })
    item(h.shown(), 'Duplicate Tab').click?.()
    const order = h.win.activeSpace().tabIds
    expect(order).toHaveLength(2)
    const copyId = order[order.indexOf(source.id) + 1]
    expect(copyId).toBeDefined()
    expect(h.viewOf(copyId ?? '').restored).toEqual([stack])
  })
})

describe('Move Tab to New Window / Move Tab to Another Window (tabs-23, context-menus-93)', () => {
  it('with one window the submenu is greyed; another window is listed by its active tab and takes the tab', () => {
    const h = harness()
    const tab = h.open('https://a.test/')
    h.open('https://a.test/stay')
    h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: tab.id })
    let items = h.shown()
    expect(item(items, 'Move Tab to New Window').enabled).not.toBe(false)
    const greyed = item(items, 'Move Tab to Another Window')
    expect(greyed.enabled).toBe(false)
    expect(greyed.submenu).toEqual([])

    const other = h.browser.createWindow({
      kind: 'unsynced',
      from: h.win,
      bounds: { x: 1400, y: 100, width: 800, height: 600 },
      empty: true
    })
    const theirs = h.open('https://b.test/', other)
    theirs.title = 'Their page'
    h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: tab.id })
    items = h.shown()
    const submenu = item(items, 'Move Tab to Another Window')
    expect(submenu.enabled).not.toBe(false)
    expect(submenu.submenu?.map((i) => i.label)).toEqual(['Their page'])

    submenu.submenu?.[0]?.click?.()
    expect(other.localSpace?.tabIds).toContain(tab.id)
    expect(h.win.activeSpace().tabIds).not.toContain(tab.id)
    expect(other.selectedTabIn(other.activeSpace())).toBe(tab.id)
  })

  it('Move Tab to New Window opens a window around the tab', () => {
    const h = harness()
    const tab = h.open('https://a.test/')
    h.open('https://a.test/stay')
    h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: tab.id })
    item(h.shown(), 'Move Tab to New Window').click?.()
    const windows = h.browser.allWindows()
    expect(windows).toHaveLength(2)
    const torn = windows.find((w) => w !== h.win)
    expect(torn?.localSpace?.tabIds).toEqual([tab.id])
    expect(h.win.activeSpace().tabIds).not.toContain(tab.id)
  })
})
