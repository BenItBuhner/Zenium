import { describe, expect, it, vi } from 'vitest'
import type {
  EventName,
  Events,
  HostCapabilities,
  LayoutReport,
  Platform as PlatformOs,
  Rect,
  Tab
} from '../../shared/types'
import { SidePanelApi } from '../../main/platform/extensionApi/sidePanel'
import type { PanelView, PanelViewHost } from '../../main/platform/extensionApi/sidePanelBridge'
import type { ApiHost, LoadedExtension } from '../../main/platform/extensionApi/types'
import { Browser } from '../browser'
import { NoExtensions } from '../hostDefaults'
import type {
  ExtensionHost,
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
  /** How often the core asked the chrome document (not a page) to take the keyboard. */
  focusedChrome: number
}

interface ViewRecord {
  tabId: string
  muted: boolean
  /** Reparenting the core asked for: `attachTo` and `detach` calls. */
  attached: number
  detached: number
  bounds: Rect | null
  visible: boolean
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

function fixture(opts: { extensions?: (browser: Browser) => ExtensionHost } = {}): Fixture {
  const hosts: HostRecord[] = []
  const views: ViewRecord[] = []
  const capabilities = stub<HostCapabilities>({ windows: true, updates: false, agents: false })
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities,
    io: memoryIo(),
    windows: {
      create: (win: ZenWindow, init: WindowCreateInit) => {
        // Windows without bounds of their own go where the first one is (a cascade in life).
        const bounds = init.bounds ?? {
          ...FIRST_BOUNDS,
          x: 40 * hosts.length,
          y: 30 * hosts.length
        }
        const record: HostRecord = {
          bounds,
          sent: [],
          closed: false,
          focused: 0,
          focusedChrome: 0,
          host: stub()
        }
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
          focusChrome: () => {
            record.focusedChrome++
          },
          // A native window closes in two steps, the core told at each (Electron's `close` and
          // `closed`).
          close: () => {
            if (record.closed) return
            record.closed = true
            win.onClosing()
            win.onClosed()
          }
        })
        hosts.push(record)
        return record.host
      }
    },
    views: stub<TabViewHost>({
      createView: (tab: Tab) => {
        const recorded: ViewRecord = {
          tabId: tab.id,
          muted: false,
          attached: 0,
          detached: 0,
          bounds: null,
          visible: false
        }
        views.push(recorded)
        let url = ''
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => recorded.visible,
          setVisible: (visible: boolean) => {
            recorded.visible = visible
          },
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
          },
          setBounds: (rect: Rect) => {
            recorded.bounds = rect
          },
          attachTo: () => {
            recorded.attached++
          },
          detach: () => {
            recorded.detached++
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
    readabilitySource: () => null,
    createExtensions: opts.extensions
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

function release(f: Fixture, win: ZenWindow, tabId: string, at: { x: number; y: number }): void {
  f.browser.handleCommand(win, 'tab.dragEnd', { tabId, x: at.x, y: at.y, outcome: 'release' })
}

/** A layout report as a window's chrome sends it: one page placed, nothing else. */
function layoutShowing(tabId: string, sidePanel?: Rect | null): LayoutReport {
  return {
    placements: [{ tabId, rect: { x: 260, y: 8, width: 1000, height: 780 }, radius: 8 }],
    glance: null,
    contentHidden: false,
    sidePanel
  }
}

/**
 * The address of a page tab as the Android program's mechanism will make them (`zen://settings`
 * and friends): an ordinary tab record that the chrome draws itself, so the manager's
 * `ensureLoaded`, `load` and `discard` do nothing for it and no view ever exists. Until that
 * mechanism reaches main the fixture stubs those three at the manager for the address.
 */
const PAGE_URL = 'zen://settings'

function stubPageTabs(f: Fixture): void {
  const tabs = f.browser.tabs
  // A page tab is never pending: the mechanism clears the flag where a load would have.
  const page = (tabId: string): Tab | undefined => {
    const tab = tabs.tab(tabId)
    if (tab?.url !== PAGE_URL) return undefined
    tab.discarded = false
    return tab
  }
  const load = tabs.load.bind(tabs)
  const ensureLoaded = tabs.ensureLoaded.bind(tabs)
  const discard = tabs.discard.bind(tabs)
  vi.spyOn(tabs, 'load').mockImplementation((tabId, win) =>
    page(tabId) ? undefined : load(tabId, win)
  )
  vi.spyOn(tabs, 'ensureLoaded').mockImplementation((tabId, win, opts) =>
    page(tabId) ? undefined : ensureLoaded(tabId, win, opts)
  )
  vi.spyOn(tabs, 'discard').mockImplementation((tabId) => {
    if (!page(tabId)) discard(tabId)
  })
}

function openPageTab(f: Fixture, win: ZenWindow): Tab {
  const tab = f.browser.tabs.createTab({ url: PAGE_URL, active: true }, win)
  expect(f.browser.tabs.view(tab.id)).toBeUndefined()
  expect(f.browser.tabs.ownerOf(tab.id)).toBeUndefined()
  return tab
}

describe('parseDropKey', () => {
  it('reads every kind of target', () => {
    expect(parseDropKey('tab:tab_1:before')).toEqual({
      kind: 'tab',
      tabId: 'tab_1',
      position: 'before'
    })
    expect(parseDropKey('tab:tab_1:after')).toEqual({
      kind: 'tab',
      tabId: 'tab_1',
      position: 'after'
    })
    expect(parseDropKey('tab:tab_1:into')).toEqual({
      kind: 'tab',
      tabId: 'tab_1',
      position: 'into'
    })
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
    expect(parseDropKey('split:bottom')).toEqual({ kind: 'split', side: 'bottom' })
    expect(parseDropKey('pane:tab_1')).toEqual({ kind: 'pane', tabId: 'tab_1' })
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
    expect(parseDropKey('split:diagonal')).toBeNull()
    expect(parseDropKey('pane:')).toBeNull()
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

describe('page tabs without a view', () => {
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

  it('moves between windows as a record: no view made or reparented, the target draws it itself', () => {
    const f = fixture()
    stubPageTabs(f)
    const { a, b } = twoWindows(f)
    const local = b.localSpace
    if (!local) throw new Error('a blank window has a local space')
    const first = f.openPage(a, 'https://example.com')
    const page = openPageTab(f, a)
    // The chrome of `a` showed the page tab: its report names the id, and nothing is placed.
    a.applyLayout(layoutShowing(page.id))
    // `b` shows an ordinary page of its own before the page tab arrives.
    const site = f.openPage(b, 'https://example.net')
    b.applyLayout(layoutShowing(site.id))
    const siteView = f.views.find((v) => v.tabId === site.id)
    if (!siteView) throw new Error('the site has a view')
    expect(siteView.visible).toBe(true)
    expect(f.views.map((v) => v.tabId)).toEqual([first.id, site.id])
    drag(f, a, page.id, { x: 1500, y: 300 })
    // The ghost the other window draws comes from the record alone.
    expect(f.sentTo(b, 'tab.dragOver')).toEqual([
      { tabId: page.id, title: page.title, favicon: null, x: 100, y: 200 }
    ])
    f.browser.handleCommand(b, 'tab.dragTarget', {
      tabId: page.id,
      key: `section:regular:${local.id}`
    })
    release(f, a, page.id, { x: 1500, y: 300 })
    expect(local.tabIds).toEqual([site.id, page.id])
    expect(b.selectedTabIn(local)).toBe(page.id)
    expect(f.browser.tabs.tab(page.id)?.spaceId).toBe(local.id)
    expect(a.activeSpace().tabIds).not.toContain(page.id)
    expect(a.selectedTabIn(a.activeSpace())).toBe(first.id)
    // Still no view, no owner, nothing attached or detached anywhere.
    expect(f.views.map((v) => v.tabId)).toEqual([first.id, site.id])
    expect(f.browser.tabs.view(page.id)).toBeUndefined()
    expect(f.browser.tabs.ownerOf(page.id)).toBeUndefined()
    for (const v of f.views) expect(v).toMatchObject({ attached: 0, detached: 0 })
    expect(f.browser.tabs.tab(page.id)?.discarded).toBe(false)
    // The target's chrome reports the page tab in place: the page it showed before hides, there
    // is no view to place, and the keyboard goes to the chrome that draws the page tab. The
    // source re-applying its stale report does nothing either.
    const chromeFocusBefore = f.hostOf(b).focusedChrome
    b.applyLayout(layoutShowing(page.id))
    expect(siteView.visible).toBe(false)
    expect(f.hostOf(b).focusedChrome).toBeGreaterThan(chromeFocusBefore)
    a.relayout()
    expect(f.views.find((v) => v.tabId === first.id)?.bounds).toBeNull()
    expect(f.hostOf(b).focused).toBeGreaterThan(0)
    expect(f.browser.allWindows()).toHaveLength(2)
  })

  it('a page tab and an ordinary tab side by side: only the page with a view is reparented', () => {
    const f = fixture()
    stubPageTabs(f)
    const { a, b } = twoWindows(f)
    const local = b.localSpace
    if (!local) throw new Error('a blank window has a local space')
    const page = openPageTab(f, a)
    const site = f.openPage(a, 'https://example.com')
    for (const tab of [page, site]) {
      f.browser.tabs.activateTab(tab.id, a)
      drag(f, a, tab.id, { x: 1500, y: 300 })
      f.browser.handleCommand(b, 'tab.dragTarget', {
        tabId: tab.id,
        key: `section:regular:${local.id}`
      })
      release(f, a, tab.id, { x: 1500, y: 300 })
    }
    expect(local.tabIds).toEqual([page.id, site.id])
    expect(f.views.map((v) => v.tabId)).toEqual([site.id])
    // The site's page changed hands (detached from `a`, attached to `b`); the page tab had none.
    expect(f.views[0]).toMatchObject({ attached: 1, detached: 1 })
    expect(f.browser.tabs.ownerOf(site.id)).toBe(b)
    expect(f.browser.tabs.ownerOf(page.id)).toBeUndefined()
  })

  it('tears off into a window of its own, whose chrome draws it', () => {
    const f = fixture()
    stubPageTabs(f)
    const win = f.browser.focusedWindow()
    const first = f.openPage(win, 'https://example.com')
    const page = openPageTab(f, win)
    win.applyLayout(layoutShowing(page.id))
    drag(f, win, page.id, { x: 1500, y: 400 })
    release(f, win, page.id, { x: 1500, y: 400 })
    const torn = f.browser.allWindows().find((w) => w !== win)
    if (!torn) throw new Error('no new window')
    expect(torn.kind).toBe('unsynced')
    expect(torn.localSpace?.tabIds).toEqual([page.id])
    expect(torn.selectedTabIn(torn.activeSpace())).toBe(page.id)
    expect(torn.initialBounds).toEqual({ x: 1500 - 160, y: 400 - 24, width: 1280, height: 800 })
    expect(f.views.map((v) => v.tabId)).toEqual([first.id])
    expect(f.browser.tabs.view(page.id)).toBeUndefined()
    expect(f.browser.tabs.ownerOf(page.id)).toBeUndefined()
    // The new window's first report names the tab; nothing to place, the chrome keeps the keys.
    torn.applyLayout(layoutShowing(page.id))
    expect(f.hostOf(torn).focusedChrome).toBeGreaterThan(0)
    expect(f.views[0].bounds).toBeNull()
    // The source moved on to its neighbour and its stale report is harmless.
    expect(win.selectedTabIn(win.activeSpace())).toBe(first.id)
    win.relayout()
    expect(win.activeSpace().tabIds).not.toContain(page.id)
  })

  it('"Move Tab to New Window" from the menu takes a page tab along without a view', () => {
    const f = fixture()
    stubPageTabs(f)
    const win = f.browser.focusedWindow()
    f.openPage(win, 'https://example.com')
    const page = openPageTab(f, win)
    f.browser.handleCommand(win, 'tab.moveToNewWindow', { tabId: page.id })
    const torn = f.browser.allWindows().find((w) => w !== win)
    expect(torn?.localSpace?.tabIds).toEqual([page.id])
    expect(torn?.selectedTabIn(torn.activeSpace())).toBe(page.id)
    expect(f.browser.tabs.view(page.id)).toBeUndefined()
  })

  it('a blank window left with nothing closes behind the tear-off with no page to tear down', async () => {
    const f = fixture()
    stubPageTabs(f)
    const a = f.browser.focusedWindow()
    f.openPage(a, 'https://example.com')
    const blank = f.browser.createWindow({
      kind: 'unsynced',
      from: a,
      bounds: { x: 1400, y: 100, width: 800, height: 600 },
      empty: true
    })
    const page = openPageTab(f, blank)
    blank.applyLayout(layoutShowing(page.id))
    // Let go below every window.
    drag(f, blank, page.id, { x: 1500, y: 900 })
    release(f, blank, page.id, { x: 1500, y: 900 })
    const torn = f.browser.allWindows().find((w) => w !== a && w !== blank)
    if (!torn) throw new Error('no new window')
    expect(torn.localSpace?.tabIds).toEqual([page.id])
    expect(blank.localSpace?.tabIds).toEqual([])
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(f.hostOf(blank).closed).toBe(true)
    expect(f.browser.allWindows()).toEqual(expect.arrayContaining([a, torn]))
    expect(f.browser.allWindows()).toHaveLength(2)
    expect(f.browser.tabs.tab(page.id)?.spaceId).toBe(torn.localSpace?.id)
    expect(f.browser.tabs.view(page.id)).toBeUndefined()
  })
})

const PANEL_EXT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

interface PanelRecord {
  win: ZenWindow
  loads: string[]
  bounds: Rect | null
  visible: boolean
  closed: boolean
}

interface PanelFixture extends Fixture {
  api: SidePanelApi
  panels: PanelRecord[]
}

/**
 * The fixture with the real `chrome.sidePanel` module docking its views: one per window, placed
 * from that window's layout report. The extension host hands the core exactly what the Electron
 * one does (`sidePanel`, `toggleSidePanel`, `closeSidePanel`, `placeSidePanel`).
 */
function panelFixture(): PanelFixture {
  const panels: PanelRecord[] = []
  let api: SidePanelApi | null = null
  const f = fixture({
    extensions: (browser) => {
      const chromeIds = new Map<string, number>()
      const ext = {
        id: PANEL_EXT,
        manifest: { side_panel: { default_path: 'panel.html' } },
        extension: { name: 'Panel' },
        sessions: [{}],
        path: '/ext/panel',
        unpacked: true
      } as unknown as LoadedExtension
      const host = {
        browser,
        model: {
          chromeTabId: (tab: Tab) => {
            let id = chromeIds.get(tab.id)
            if (id === undefined) chromeIds.set(tab.id, (id = 100 + chromeIds.size))
            return id
          },
          zenTab: (tabId: number) => {
            for (const [zenId, id] of chromeIds) if (id === tabId) return browser.tabs.tab(zenId)
            return undefined
          },
          windowOfTab: (tab: Tab) => browser.tabs.windowFor(tab.id),
          windowIdOf: (w: ZenWindow) => browser.allWindows().indexOf(w) + 1,
          zenWindow: (windowId: number) => browser.allWindows()[windowId - 1],
          lastFocusedWindow: () => browser.focusedWindow()
        },
        store: {
          sidePanelOnActionClick: () => false,
          setSidePanelOnActionClick: () => undefined
        },
        loaded: (id: string) => (id === PANEL_EXT ? ext : undefined),
        grants: () => ({ permissions: ['sidePanel'], origins: [] }),
        commitUi: () => browser.state.commitVolatile()
      }
      const viewHost: PanelViewHost = {
        create: (win) => {
          const record: PanelRecord = {
            win,
            loads: [],
            bounds: null,
            visible: false,
            closed: false
          }
          panels.push(record)
          const view: PanelView = {
            loadURL: (url) => void record.loads.push(url),
            setBounds: (rect) => {
              record.bounds = rect
            },
            setVisible: (visible) => {
              record.visible = visible
            },
            visible: () => record.visible,
            focus: () => undefined,
            destroyed: () => record.closed,
            close: () => {
              record.closed = true
            },
            hostsWebContents: () => false
          }
          return view
        }
      }
      const panelApi = new SidePanelApi(host as unknown as ApiHost, viewHost)
      panelApi.load(ext)
      api = panelApi
      const none = new NoExtensions(browser)
      const extensions: ExtensionHost = Object.assign(Object.create(none) as ExtensionHost, {
        sidePanel: (win: ZenWindow) => panelApi.info(win),
        toggleSidePanel: (id: string, win: ZenWindow) => panelApi.toggle(id, win),
        closeSidePanel: (win: ZenWindow) => panelApi.close(win),
        placeSidePanel: (win: ZenWindow, rect: Rect | null) => panelApi.place(win, rect)
      })
      return extensions
    }
  })
  if (!api) throw new Error('the side panel module was not created')
  return { ...f, api, panels }
}

describe('the extension side panel stays with its window', () => {
  const PANEL_RECT: Rect = { x: 900, y: 8, width: 360, height: 780 }

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

  function panelInfo(f: Fixture, win: ZenWindow): string | null {
    return f.browser.state.snapshot(win).sidePanel?.extensionId ?? null
  }

  it('a tab moving into another window leaves the panel behind; the other report places nothing', () => {
    const f = panelFixture()
    const { a, b } = twoWindows(f)
    const local = b.localSpace
    if (!local) throw new Error('a blank window has a local space')
    const first = f.openPage(a, 'https://example.com')
    const second = f.openPage(a, 'https://example.org')
    f.browser.handleCommand(a, 'extension.toggleSidePanel', { id: PANEL_EXT })
    expect(f.panels).toHaveLength(1)
    expect(f.panels[0].win).toBe(a)
    expect(panelInfo(f, a)).toBe(PANEL_EXT)
    expect(panelInfo(f, b)).toBeNull()
    drag(f, a, second.id, { x: 1500, y: 300 })
    f.browser.handleCommand(b, 'tab.dragTarget', {
      tabId: second.id,
      key: `section:regular:${local.id}`
    })
    release(f, a, second.id, { x: 1500, y: 300 })
    f.api.refresh()
    expect(local.tabIds).toEqual([second.id])
    expect(a.selectedTabIn(a.activeSpace())).toBe(first.id)
    // One panel, still `a`'s; the window that took the tab shows none.
    expect(f.panels).toHaveLength(1)
    expect(f.panels[0].closed).toBe(false)
    expect(f.api.showing(a)).toBe(PANEL_EXT)
    expect(f.api.showing(b)).toBeNull()
    expect(panelInfo(f, a)).toBe(PANEL_EXT)
    expect(panelInfo(f, b)).toBeNull()
    // Each window's report places its own panel and nobody else's.
    b.applyLayout(layoutShowing(second.id, PANEL_RECT))
    expect(f.panels[0].bounds).toBeNull()
    expect(f.panels[0].visible).toBe(false)
    a.applyLayout(layoutShowing(first.id, PANEL_RECT))
    expect(f.panels[0].bounds).toEqual(PANEL_RECT)
    expect(f.panels[0].visible).toBe(true)
  })

  it('a tear-off makes a window without a panel; the source keeps its own in place', () => {
    const f = panelFixture()
    const win = f.browser.focusedWindow()
    const first = f.openPage(win, 'https://example.com')
    const second = f.openPage(win, 'https://example.org')
    f.browser.handleCommand(win, 'extension.toggleSidePanel', { id: PANEL_EXT })
    win.applyLayout(layoutShowing(second.id, PANEL_RECT))
    expect(f.panels[0].visible).toBe(true)
    drag(f, win, second.id, { x: 1500, y: 400 })
    release(f, win, second.id, { x: 1500, y: 400 })
    f.api.refresh()
    const torn = f.browser.allWindows().find((w) => w !== win)
    if (!torn) throw new Error('no new window')
    expect(torn.localSpace?.tabIds).toEqual([second.id])
    expect(f.panels).toHaveLength(1)
    expect(f.api.showing(torn)).toBeNull()
    expect(panelInfo(f, torn)).toBeNull()
    expect(f.api.showing(win)).toBe(PANEL_EXT)
    expect(panelInfo(f, win)).toBe(PANEL_EXT)
    // The new window's chrome has no strip to report; were it to name one, nothing is there.
    torn.applyLayout(layoutShowing(second.id, null))
    torn.applyLayout(layoutShowing(second.id, PANEL_RECT))
    expect(f.panels[0].bounds).toEqual(PANEL_RECT)
    expect(f.panels[0].win).toBe(win)
    // The source's panel follows the source's new active tab.
    win.applyLayout(layoutShowing(first.id, PANEL_RECT))
    expect(f.panels[0].visible).toBe(true)
    expect(f.panels[0].loads).toEqual([`chrome-extension://${PANEL_EXT}/panel.html`])
  })

  it('two windows with panels of their own: a move between them touches neither', () => {
    const f = panelFixture()
    const { a, b } = twoWindows(f)
    const local = b.localSpace
    if (!local) throw new Error('a blank window has a local space')
    f.openPage(a, 'https://example.com')
    const second = f.openPage(a, 'https://example.org')
    f.openPage(b, 'https://example.net')
    f.browser.handleCommand(a, 'extension.toggleSidePanel', { id: PANEL_EXT })
    f.browser.handleCommand(b, 'extension.toggleSidePanel', { id: PANEL_EXT })
    expect(f.panels.map((p) => p.win)).toEqual([a, b])
    drag(f, a, second.id, { x: 1500, y: 300 })
    f.browser.handleCommand(b, 'tab.dragTarget', {
      tabId: second.id,
      key: `section:regular:${local.id}`
    })
    release(f, a, second.id, { x: 1500, y: 300 })
    f.api.refresh()
    expect(local.tabIds).toContain(second.id)
    expect(f.panels).toHaveLength(2)
    expect(f.panels.map((p) => p.closed)).toEqual([false, false])
    expect(f.api.showing(a)).toBe(PANEL_EXT)
    expect(f.api.showing(b)).toBe(PANEL_EXT)
    const rectB: Rect = { x: 400, y: 8, width: 300, height: 580 }
    b.applyLayout(layoutShowing(second.id, rectB))
    expect(f.panels[1].bounds).toEqual(rectB)
    expect(f.panels[0].bounds).toBeNull()
    a.applyLayout(layoutShowing(a.selectedTabIn(a.activeSpace()) ?? '', PANEL_RECT))
    expect(f.panels[0].bounds).toEqual(PANEL_RECT)
    expect(f.panels[1].bounds).toEqual(rectB)
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
    expect(f.browser.tabs.dropTab(a.id, 'split:diagonal', win)).toBe(false)
    expect(f.browser.tabs.dropTab(a.id, 'pane:nope', win)).toBe(false)
  })
})

describe('a tab dropped on the content area (split edges and panes)', () => {
  function groupOf(f: Fixture, tabId: string): { tabIds: string[]; layout: string } | null {
    const tab = f.browser.tabs.tab(tabId)
    const group = tab?.splitGroupId ? f.browser.state.model.splitGroups[tab.splitGroupId] : null
    return group ? { tabIds: group.tabIds, layout: group.layout } : null
  }

  it('splits the shown tab with the dropped one, side by side or stacked, on the dropped side', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const a = f.openPage(win, 'https://a.example')
    const b = f.openPage(win, 'https://b.example')
    f.browser.tabs.activateTab(a.id, win)
    expect(f.browser.tabs.dropTab(b.id, 'split:left', win)).toBe(true)
    expect(groupOf(f, a.id)).toEqual({ tabIds: [b.id, a.id], layout: 'vertical' })
    f.browser.tabs.unsplit(undefined, a.id, win)
    expect(groupOf(f, a.id)).toBeNull()
    expect(f.browser.tabs.dropTab(b.id, 'split:bottom', win)).toBe(true)
    expect(groupOf(f, a.id)).toEqual({ tabIds: [a.id, b.id], layout: 'horizontal' })
    // The shown tab cannot split with itself.
    f.browser.tabs.unsplit(undefined, a.id, win)
    expect(f.browser.tabs.dropTab(a.id, 'split:right', win)).toBe(false)
  })

  it('joins the split shown as a pane on that side; across its axis the layout turns (BUG-039)', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const a = f.openPage(win, 'https://a.example')
    const b = f.openPage(win, 'https://b.example')
    const c = f.openPage(win, 'https://c.example')
    const d = f.openPage(win, 'https://d.example')
    f.browser.tabs.createSplit([a.id, b.id], 'vertical', win)
    f.browser.tabs.activateTab(a.id, win)
    // Along the axis: a third column, on the left.
    expect(f.browser.tabs.dropTab(c.id, 'split:left', win)).toBe(true)
    expect(groupOf(f, a.id)).toEqual({ tabIds: [c.id, a.id, b.id], layout: 'vertical' })
    expect(win.selectedTabIn(win.activeSpace())).toBe(c.id)
    // Across it: "Split top" stacks, the new pane above the others.
    expect(f.browser.tabs.dropTab(d.id, 'split:top', win)).toBe(true)
    expect(groupOf(f, a.id)).toEqual({ tabIds: [d.id, c.id, a.id, b.id], layout: 'horizontal' })
    expect(win.selectedTabIn(win.activeSpace())).toBe(d.id)
  })

  it('moves a pane of the split to the edge it is dropped on', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const a = f.openPage(win, 'https://a.example')
    const b = f.openPage(win, 'https://b.example')
    const c = f.openPage(win, 'https://c.example')
    f.browser.tabs.createSplit([a.id, b.id, c.id], 'vertical', win)
    f.browser.tabs.activateTab(a.id, win)
    expect(f.browser.tabs.dropTab(a.id, 'split:right', win)).toBe(true)
    expect(groupOf(f, a.id)).toEqual({ tabIds: [b.id, c.id, a.id], layout: 'vertical' })
    expect(f.browser.tabs.dropTab(c.id, 'split:bottom', win)).toBe(true)
    expect(groupOf(f, a.id)).toEqual({ tabIds: [b.id, a.id, c.id], layout: 'horizontal' })
  })

  it('a full split takes no more and says so', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tabs = ['a', 'b', 'c', 'd', 'e'].map((n) => f.openPage(win, `https://${n}.example`))
    const four = tabs.slice(0, 4).map((t) => t.id)
    f.browser.tabs.createSplit(four, 'vertical', win)
    f.browser.tabs.activateTab(four[0], win)
    expect(f.browser.tabs.dropTab(tabs[4].id, 'split:right', win)).toBe(false)
    expect(groupOf(f, four[0])).toEqual({ tabIds: four, layout: 'vertical' })
    expect(f.sentTo(win, 'toast').at(-1)).toEqual({
      message: 'Split views can hold up to 4 tabs.',
      kind: 'info'
    })
  })

  it('a tab dropped on a pane takes it over; the tab shown there leaves the split and stays open', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const a = f.openPage(win, 'https://a.example')
    const b = f.openPage(win, 'https://b.example')
    const c = f.openPage(win, 'https://c.example')
    f.browser.tabs.createSplit([a.id, b.id], 'vertical', win)
    f.browser.tabs.activateTab(a.id, win)
    expect(f.browser.tabs.dropTab(c.id, `pane:${a.id}`, win)).toBe(true)
    expect(groupOf(f, c.id)).toEqual({ tabIds: [c.id, b.id], layout: 'vertical' })
    expect(f.browser.tabs.tab(a.id)?.splitGroupId).toBeNull()
    expect(win.activeSpace().tabIds).toContain(a.id)
    expect(win.selectedTabIn(win.activeSpace())).toBe(c.id)
    // Dropped on the pane it already shows: nothing to do.
    expect(f.browser.tabs.dropTab(c.id, `pane:${c.id}`, win)).toBe(false)
  })

  it('two panes of one split swap places', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const a = f.openPage(win, 'https://a.example')
    const b = f.openPage(win, 'https://b.example')
    const c = f.openPage(win, 'https://c.example')
    f.browser.tabs.createSplit([a.id, b.id, c.id], 'vertical', win)
    expect(f.browser.tabs.dropTab(a.id, `pane:${c.id}`, win)).toBe(true)
    expect(groupOf(f, a.id)).toEqual({ tabIds: [c.id, b.id, a.id], layout: 'vertical' })
  })

  it('from another window: the tab moves in, then splits with (or takes a pane of) what that window shows', () => {
    const f = fixture()
    const a = f.browser.focusedWindow()
    const b = f.browser.createWindow({
      kind: 'unsynced',
      from: a,
      bounds: { x: 1400, y: 100, width: 800, height: 600 },
      empty: true
    })
    const local = b.localSpace
    if (!local) throw new Error('a blank window has a local space')
    const shown = f.openPage(b, 'https://shown.example')
    const first = f.openPage(a, 'https://first.example')
    const second = f.openPage(a, 'https://second.example')
    drag(f, a, first.id, { x: 1500, y: 300 })
    f.browser.handleCommand(b, 'tab.dragTarget', { tabId: first.id, key: 'split:right' })
    release(f, a, first.id, { x: 1500, y: 300 })
    expect(local.tabIds).toEqual([shown.id, first.id])
    expect(groupOf(f, shown.id)).toEqual({ tabIds: [shown.id, first.id], layout: 'vertical' })
    expect(b.selectedTabIn(local)).toBe(first.id)
    drag(f, a, second.id, { x: 1500, y: 300 })
    f.browser.handleCommand(b, 'tab.dragTarget', { tabId: second.id, key: `pane:${shown.id}` })
    release(f, a, second.id, { x: 1500, y: 300 })
    expect(local.tabIds).toEqual([shown.id, first.id, second.id])
    expect(groupOf(f, second.id)).toEqual({ tabIds: [second.id, first.id], layout: 'vertical' })
    expect(f.browser.tabs.tab(shown.id)?.splitGroupId).toBeNull()
    expect(a.activeSpace().tabIds).not.toContain(first.id)
    expect(a.activeSpace().tabIds).not.toContain(second.id)
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
