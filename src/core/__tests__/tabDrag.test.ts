import { describe, expect, it } from 'vitest'
import type {
  EventName,
  Events,
  HostCapabilities,
  Platform as PlatformOs,
  Rect,
  Tab
} from '../../shared/types'
import { Browser } from '../browser'
import type {
  Platform,
  StoreIO,
  TabView,
  TabViewHost,
  WindowCreateInit,
  WindowHost
} from '../platform'
import { contains, parseDropKey } from '../tabDrag'
import type { ZenWindow } from '../window'

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

interface Sent {
  name: EventName
  payload: unknown
}

/** What the fixture records about one window's host: where it is and what the core told it. */
interface HostRecord {
  host: WindowHost
  bounds: Rect
  sent: Sent[]
  closed: boolean
  focused: number
}

interface ViewRecord {
  tabId: string
  muted: boolean
}

interface Fixture {
  browser: Browser
  hosts: HostRecord[]
  views: ViewRecord[]
  hostOf: (win: ZenWindow) => HostRecord
  openPage: (win: ZenWindow, url: string) => Tab
  sentTo: (win: ZenWindow, name: EventName) => unknown[]
}

const FIRST_BOUNDS: Rect = { x: 0, y: 0, width: 1280, height: 800 }

function fixture(): Fixture {
  const hosts: HostRecord[] = []
  const views: ViewRecord[] = []
  const capabilities = stub<HostCapabilities>({ windows: true, updates: false, agents: false })
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities,
    io: memoryIo(),
    windows: {
      create: (_win: ZenWindow, init: WindowCreateInit) => {
        // Windows without bounds of their own go where the first one is (a cascade in life).
        const bounds = init.bounds ?? {
          ...FIRST_BOUNDS,
          x: 40 * hosts.length,
          y: 30 * hosts.length
        }
        const record: HostRecord = { bounds, sent: [], closed: false, focused: 0, host: stub() }
        record.host = stub<WindowHost>({
          get alive() {
            return !record.closed
          },
          send: <K extends EventName>(name: K, payload: Events[K]) => {
            record.sent.push({ name, payload })
          },
          contentSize: () => ({ width: bounds.width, height: bounds.height }),
          contentBounds: () => record.bounds,
          normalBounds: () => record.bounds,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          focus: () => {
            record.focused++
          },
          close: () => {
            record.closed = true
          }
        })
        hosts.push(record)
        return record.host
      }
    },
    views: stub<TabViewHost>({
      createView: (tab: Tab) => {
        const recorded: ViewRecord = { tabId: tab.id, muted: false }
        views.push(recorded)
        let url = ''
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => true,
          hasDocument: () => url !== '',
          getURL: () => url,
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          loadURL: (u: string) => {
            url = u
          },
          setMuted: (muted: boolean) => {
            recorded.muted = muted
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
  const hostOf = (win: ZenWindow): HostRecord => {
    const record = hosts.find((h) => h.host === win.host)
    if (!record) throw new Error('unknown window host')
    return record
  }
  const openPage = (win: ZenWindow, url: string): Tab => {
    browser.handleCommand(win, 'urlbar.submit', {
      input: url,
      newTab: true,
      tabId: null,
      background: false
    })
    const tabId = win.selectedTabIn(win.activeSpace())
    const tab = tabId ? browser.tabs.tab(tabId) : undefined
    if (!tab) throw new Error('the page did not open in a tab of its own')
    return tab
  }
  const sentTo = (win: ZenWindow, name: EventName): unknown[] =>
    hostOf(win)
      .sent.filter((s) => s.name === name)
      .map((s) => s.payload)
  return { browser, hosts, views, hostOf, openPage, sentTo }
}

function drag(
  f: Fixture,
  win: ZenWindow,
  tabId: string,
  to: { x: number; y: number },
  inSidebar = false
): void {
  f.browser.handleCommand(win, 'tab.dragStart', { tabId })
  f.browser.handleCommand(win, 'tab.dragMove', { tabId, x: to.x, y: to.y, inSidebar })
}

describe('parseDropKey', () => {
  it('reads every kind of target', () => {
    expect(parseDropKey('tab:tab_1:before')).toEqual({ kind: 'tab', tabId: 'tab_1', after: false })
    expect(parseDropKey('tab:tab_1:after')).toEqual({ kind: 'tab', tabId: 'tab_1', after: true })
    expect(parseDropKey('section:pinned:space_1')).toEqual({
      kind: 'section',
      section: 'pinned',
      spaceId: 'space_1'
    })
    expect(parseDropKey('section:essential:')).toEqual({
      kind: 'section',
      section: 'essential',
      spaceId: ''
    })
    expect(parseDropKey('folder:folder_1')).toEqual({ kind: 'folder', folderId: 'folder_1' })
    expect(parseDropKey('space:space_1')).toEqual({ kind: 'space', spaceId: 'space_1' })
    expect(parseDropKey('split:left')).toEqual({ kind: 'split', side: 'left' })
    expect(parseDropKey('bookmark:toolbar:3')).toEqual({
      kind: 'bookmark',
      folderId: 'toolbar',
      index: 3
    })
    expect(parseDropKey('bookmark:toolbar:')).toEqual({
      kind: 'bookmark',
      folderId: 'toolbar',
      index: null
    })
  })

  it("keeps a blank window's local space id, colons and all", () => {
    expect(parseDropKey('section:regular:win:window_1')).toEqual({
      kind: 'section',
      section: 'regular',
      spaceId: 'win:window_1'
    })
    expect(parseDropKey('space:win:window_1')).toEqual({ kind: 'space', spaceId: 'win:window_1' })
  })

  it('rejects what it cannot read', () => {
    expect(parseDropKey('')).toBeNull()
    expect(parseDropKey('tab')).toBeNull()
    expect(parseDropKey('tab:tab_1')).toBeNull()
    expect(parseDropKey('tab:tab_1:sideways')).toBeNull()
    expect(parseDropKey('tab::after')).toBeNull()
    expect(parseDropKey('section:pinned')).toBeNull()
    expect(parseDropKey('folder:')).toBeNull()
    expect(parseDropKey('bookmark:toolbar:x')).toBeNull()
    expect(parseDropKey('elsewhere:1')).toBeNull()
  })
})

describe('contains', () => {
  it('is inclusive at the near edges and exclusive at the far ones', () => {
    const r: Rect = { x: 10, y: 20, width: 100, height: 50 }
    expect(contains(r, { x: 10, y: 20 })).toBe(true)
    expect(contains(r, { x: 109, y: 69 })).toBe(true)
    expect(contains(r, { x: 110, y: 20 })).toBe(false)
    expect(contains(r, { x: 9, y: 20 })).toBe(false)
  })
})

describe('tear-off', () => {
  it('lets go of a tab outside every window into a new window at that spot', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const first = f.openPage(win, 'https://example.com')
    const second = f.openPage(win, 'https://example.org')
    expect(win.selectedTabIn(win.activeSpace())).toBe(second.id)
    drag(f, win, second.id, { x: 1500, y: 400 })
    f.browser.handleCommand(win, 'tab.dragEnd', {
      tabId: second.id,
      x: 1500,
      y: 400,
      outcome: 'release'
    })
    const windows = f.browser.allWindows()
    expect(windows).toHaveLength(2)
    const torn = windows.find((w) => w !== win)
    if (!torn) throw new Error('no new window')
    // Shared tabs (sync all) can only live alone in a blank window, which owns the tab now.
    expect(torn.kind).toBe('unsynced')
    expect(torn.localSpace?.tabIds).toEqual([second.id])
    expect(torn.selectedTabIn(torn.activeSpace())).toBe(second.id)
    expect(f.browser.tabs.tab(second.id)?.spaceId).toBe(torn.localSpace?.id)
    // Placed from the drop point, sized like the window it came from.
    expect(torn.initialBounds).toEqual({ x: 1500 - 160, y: 400 - 24, width: 1280, height: 800 })
    // The source moved on to the neighbour.
    expect(win.selectedTabIn(win.activeSpace())).toBe(first.id)
    expect(win.activeSpace().tabIds).not.toContain(second.id)
  })

  it('does nothing on Escape', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    f.openPage(win, 'https://example.com')
    const second = f.openPage(win, 'https://example.org')
    drag(f, win, second.id, { x: 1500, y: 400 })
    f.browser.handleCommand(win, 'tab.dragEnd', {
      tabId: second.id,
      x: 1500,
      y: 400,
      outcome: 'cancel'
    })
    expect(f.browser.allWindows()).toHaveLength(1)
    expect(win.selectedTabIn(win.activeSpace())).toBe(second.id)
  })

  it('"Move Tab to New Window" from the menu opens the window beside this one', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.openPage(win, 'https://example.com')
    f.browser.handleCommand(win, 'tab.moveToNewWindow', { tabId: tab.id })
    const windows = f.browser.allWindows()
    expect(windows).toHaveLength(2)
    const torn = windows.find((w) => w !== win)
    expect(torn?.localSpace?.tabIds).toEqual([tab.id])
    expect(torn?.initialBounds).toBeNull()
  })

  it('under "sync only pinned tabs" the new window is a synced one that owns the tab', () => {
    const f = fixture()
    f.browser.state.settings.windowSync = 'pinned'
    const win = f.browser.focusedWindow()
    const tab = f.openPage(win, 'https://example.com')
    f.browser.handleCommand(win, 'tab.moveToNewWindow', { tabId: tab.id })
    const torn = f.browser.allWindows().find((w) => w !== win)
    expect(torn?.kind).toBe('synced')
    expect(f.browser.tabs.tab(tab.id)?.windowId).toBe(torn?.id)
    expect(torn?.selectedTabIn(torn.activeSpace())).toBe(tab.id)
  })
})

describe('drag between windows', () => {
  function twoWindows(f: Fixture): { a: ZenWindow; b: ZenWindow } {
    const a = f.browser.focusedWindow()
    const b = f.browser.createWindow({
      kind: 'unsynced',
      from: a,
      bounds: { x: 1400, y: 100, width: 800, height: 600 },
      empty: true
    })
    return { a, b }
  }

  it('tells the hovered window about the drag in its own coordinates, and takes it back', () => {
    const f = fixture()
    const { a, b } = twoWindows(f)
    const tab = f.openPage(a, 'https://example.com')
    drag(f, a, tab.id, { x: 1500, y: 300 })
    expect(f.sentTo(b, 'tab.dragOver')).toEqual([
      { tabId: tab.id, title: tab.title, favicon: null, x: 100, y: 200 }
    ])
    // Back over its own window: the other one is told the drag left.
    f.browser.handleCommand(a, 'tab.dragMove', { tabId: tab.id, x: 600, y: 300, inSidebar: true })
    expect(f.sentTo(b, 'tab.dragOver').at(-1)).toBeNull()
  })

  it('moves the tab into the other window where its chrome said the pointer was', () => {
    const f = fixture()
    const { a, b } = twoWindows(f)
    const first = f.openPage(a, 'https://example.com')
    const second = f.openPage(a, 'https://example.org')
    const local = b.localSpace
    if (!local) throw new Error('a blank window has a local space')
    drag(f, a, second.id, { x: 1500, y: 300 })
    f.browser.handleCommand(b, 'tab.dragTarget', {
      tabId: second.id,
      key: `section:regular:${local.id}`
    })
    f.browser.handleCommand(a, 'tab.dragEnd', {
      tabId: second.id,
      x: 1500,
      y: 300,
      outcome: 'release'
    })
    expect(local.tabIds).toEqual([second.id])
    expect(b.selectedTabIn(local)).toBe(second.id)
    expect(f.browser.tabs.tab(second.id)?.spaceId).toBe(local.id)
    expect(a.activeSpace().tabIds).not.toContain(second.id)
    expect(a.selectedTabIn(a.activeSpace())).toBe(first.id)
    expect(f.sentTo(b, 'tab.dragOver').at(-1)).toBeNull()
    expect(f.hostOf(b).focused).toBeGreaterThan(0)
    expect(f.browser.allWindows()).toHaveLength(2)
  })

  it('ignores a target report from a window the drag is not over', () => {
    const f = fixture()
    const { a, b } = twoWindows(f)
    const tab = f.openPage(a, 'https://example.com')
    drag(f, a, tab.id, { x: 600, y: 300 }, true)
    f.browser.handleCommand(b, 'tab.dragTarget', { tabId: tab.id, key: 'section:regular:x' })
    f.browser.handleCommand(a, 'tab.dragEnd', { tabId: tab.id, x: 600, y: 300, outcome: 'cancel' })
    expect(a.activeSpace().tabIds).toContain(tab.id)
    expect(b.localSpace?.tabIds).toEqual([])
  })

  it('keeps private and regular tabs apart', () => {
    const f = fixture()
    const a = f.browser.focusedWindow()
    const p = f.browser.createWindow({
      kind: 'private',
      from: a,
      bounds: { x: 1400, y: 100, width: 800, height: 600 },
      empty: true
    })
    const tab = f.openPage(a, 'https://example.com')
    drag(f, a, tab.id, { x: 1500, y: 300 })
    // The private window is not a target: it hears nothing, and the release tears off instead.
    expect(f.sentTo(p, 'tab.dragOver')).toEqual([])
    f.browser.handleCommand(a, 'tab.dragEnd', {
      tabId: tab.id,
      x: 1500,
      y: 300,
      outcome: 'release'
    })
    expect(p.localSpace?.tabIds).toEqual([])
    expect(f.browser.allWindows()).toHaveLength(3)
  })

  it('drops the session when the source window closes mid-drag', () => {
    const f = fixture()
    const { a, b } = twoWindows(f)
    const tab = f.openPage(a, 'https://example.com')
    drag(f, a, tab.id, { x: 1500, y: 300 })
    f.browser.tabDrag.onWindowClosed(a)
    expect(f.sentTo(b, 'tab.dragOver').at(-1)).toBeNull()
    f.browser.handleCommand(a, 'tab.dragEnd', {
      tabId: tab.id,
      x: 1500,
      y: 300,
      outcome: 'release'
    })
    expect(b.localSpace?.tabIds).toEqual([])
    expect(f.browser.allWindows()).toHaveLength(2)
  })
})

describe('dropTab', () => {
  it('reorders beside another tab of the same list', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const a = f.openPage(win, 'https://a.example')
    const b = f.openPage(win, 'https://b.example')
    const c = f.openPage(win, 'https://c.example')
    const order = (): string[] => win.activeSpace().tabIds
    expect(order()).toEqual([a.id, b.id, c.id])
    expect(f.browser.tabs.dropTab(a.id, `tab:${c.id}:after`, win)).toBe(true)
    expect(order()).toEqual([b.id, c.id, a.id])
    expect(f.browser.tabs.dropTab(a.id, `tab:${b.id}:before`, win)).toBe(true)
    expect(order()).toEqual([a.id, b.id, c.id])
    expect(f.browser.tabs.dropTab(c.id, `tab:${a.id}:after`, win)).toBe(true)
    expect(order()).toEqual([a.id, c.id, b.id])
  })

  it('refuses a key that names nothing', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const a = f.openPage(win, 'https://a.example')
    expect(f.browser.tabs.dropTab(a.id, `tab:${a.id}:after`, win)).toBe(false)
    expect(f.browser.tabs.dropTab(a.id, 'folder:nope', win)).toBe(false)
    expect(f.browser.tabs.dropTab(a.id, 'section:sideways:x', win)).toBe(false)
  })
})

describe('Mute Site', () => {
  it('mutes every tab of the host, remembers it, and lifts it again', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const one = f.openPage(win, 'https://www.example.com/a')
    const two = f.openPage(win, 'https://example.com/b')
    const other = f.openPage(win, 'https://example.org')
    f.browser.handleCommand(win, 'tab.toggleMuteSite', { tabId: one.id })
    expect(f.browser.state.settings.mutedHosts).toEqual(['example.com'])
    expect(f.browser.tabs.tab(one.id)?.muted).toBe(true)
    expect(f.browser.tabs.tab(two.id)?.muted).toBe(true)
    expect(f.browser.tabs.tab(other.id)?.muted).toBe(false)
    expect(f.views.find((v) => v.tabId === two.id)?.muted).toBe(true)
    // A new page of the host starts muted.
    const three = f.openPage(win, 'https://example.com/c')
    expect(f.browser.tabs.tab(three.id)?.muted).toBe(true)
    f.browser.handleCommand(win, 'tab.toggleMuteSite', { tabId: two.id })
    expect(f.browser.state.settings.mutedHosts).toEqual([])
    for (const t of [one, two, three]) expect(f.browser.tabs.tab(t.id)?.muted).toBe(false)
  })
})
