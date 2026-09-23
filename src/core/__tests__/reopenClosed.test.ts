import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { Browser } from '../browser'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import type { ZenWindow } from '../window'

/**
 * Ctrl+Shift+T (shortcuts-menus-04; `SessionService.reopenClosed`): the most recently closed
 * entry comes back first; a tab returns to its own position – among its old neighbours, in its
 * group, in its pinned section – and a closed window comes back as one unit with its tabs in
 * order and its active tab selected, ahead of a tab closed before it.
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
  /** A regular tab in `win`'s active space, active unless said otherwise; returns its id. */
  open: (url: string, opts?: { folderId?: string; active?: boolean; pinned?: boolean }) => string
  /** A group of the window's space. */
  group: (name: string) => string
  /** A space's tabs in order, as their URLs (the window's active space by default). */
  urls: (win?: ZenWindow) => string[]
  /** Close a tab as the user does (the shortcut, the X). */
  close: (tabId: string, win?: ZenWindow) => void
  /** Close a window as the host does once the close is approved. */
  closeWindow: (win: ZenWindow) => void
  /** Ctrl+Shift+T in `win`. */
  reopen: (win?: ZenWindow) => void
  /** The live tab with `url`. */
  tabByUrl: (url: string) => { id: string; folderId: string | null; pinned: boolean } | undefined
  /** The windows the core asked the host to bring forward, in order. */
  focused: string[]
}

function harness(): Harness {
  const focused: string[] = []
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '1.2.3' },
    capabilities: stub<HostCapabilities>({ windows: true, nativeMenus: true }),
    io: memoryIo(),
    windows: {
      create: (win) =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          focus: () => void focused.push(win.id)
        })
    },
    views: stub<TabViewHost>({
      createView: () =>
        stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          getZoom: () => 1,
          navigationEntries: () => ({ index: 0, entries: [] })
        })
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
  const win = browser.allWindows()[0] as ZenWindow
  return {
    browser,
    win,
    open: (url, opts = {}) =>
      browser.tabs.createTab(
        { url, active: opts.active ?? true, folderId: opts.folderId, pinned: opts.pinned },
        win
      ).id,
    group: (name) =>
      browser.createFolder(win.activeSpaceId, name, '📁', win, { rename: false, color: 'blue' }).id,
    urls: (w = win) => w.activeSpace().tabIds.map((id) => browser.tabs.tab(id)!.url),
    close: (tabId, w = win) => browser.tabs.closeTab(tabId, false, w),
    closeWindow: (w) => {
      browser.onWindowClosing(w)
      browser.onWindowClosed(w)
    },
    reopen: (w = win) => browser.tabs.reopenClosed(w),
    tabByUrl: (url) => Object.values(browser.state.model.tabs).find((t) => t.url === url),
    focused
  }
}

describe('Ctrl+Shift+T', () => {
  it('reopens the most recently closed tab first, then the one before it', () => {
    const h = harness()
    const a = h.open('https://a.test/')
    const b = h.open('https://b.test/')
    h.close(a)
    h.close(b)
    expect(h.browser.session.summaries().map((e) => e.url)).toEqual([
      'https://b.test/',
      'https://a.test/'
    ])

    h.reopen()
    expect(h.urls()).toContain('https://b.test/')
    expect(h.urls()).not.toContain('https://a.test/')
    // The reopened tab is the one the user is on.
    expect(h.browser.tabs.tab(h.win.selectedTabIn(h.win.activeSpace())!)?.url).toBe(
      'https://b.test/'
    )
    h.reopen()
    expect(h.urls()).toContain('https://a.test/')
    expect(h.browser.session.summaries()).toEqual([])
    // Nothing left: another press does nothing.
    h.reopen()
    expect(h.urls().filter((u) => u === 'https://a.test/')).toHaveLength(1)
  })

  it('puts a tab back at its original position among its neighbours', () => {
    const h = harness()
    // The window's first tab is the blank one it opened with; the pages follow it.
    for (const u of ['https://a.test/', 'https://b.test/', 'https://c.test/', 'https://d.test/'])
      h.open(u)
    const before = h.urls()
    const b = h.tabByUrl('https://b.test/')!.id
    h.close(b)
    h.open('https://e.test/')
    expect(h.urls()).toEqual([...before.filter((u) => u !== 'https://b.test/'), 'https://e.test/'])

    h.reopen()
    expect(h.urls()).toEqual([...before, 'https://e.test/'])
  })

  it('puts several tabs closed one after another back where each stood', () => {
    const h = harness()
    for (const u of ['https://a.test/', 'https://b.test/', 'https://c.test/', 'https://d.test/'])
      h.open(u)
    const before = h.urls()
    // Close b, then d, then a – as the user might, in no particular order.
    h.close(h.tabByUrl('https://b.test/')!.id)
    h.close(h.tabByUrl('https://d.test/')!.id)
    h.close(h.tabByUrl('https://a.test/')!.id)
    expect(h.urls()).toEqual(before.filter((u) => u === 'https://c.test/' || !u.includes('test')))

    h.reopen()
    h.reopen()
    h.reopen()
    expect(h.urls()).toEqual(before)
  })

  it('"Restore All" puts every tab back where it stood, whichever order the closes came in', () => {
    const h = harness()
    for (const u of ['https://a.test/', 'https://b.test/', 'https://c.test/', 'https://d.test/'])
      h.open(u)
    const before = h.urls()
    // Two neighbours closed in turn: the second's index was counted with the first gone.
    h.close(h.tabByUrl('https://b.test/')!.id)
    h.close(h.tabByUrl('https://c.test/')!.id)
    h.browser.session.restoreAll(h.win)
    expect(h.urls()).toEqual(before)
    expect(h.browser.session.summaries()).toEqual([])
    // The user ends on the newest closed tab, as after one Ctrl+Shift+T.
    expect(h.browser.tabs.tab(h.win.selectedTabIn(h.win.activeSpace())!)?.url).toBe(
      'https://c.test/'
    )
  })

  it('a tab closed in another window that is still open goes back to that window, at its place, and the window comes forward', () => {
    const h = harness()
    const second = h.browser.openWindow('unsynced', h.win)
    if (!second) throw new Error('no second window')
    for (const u of ['https://p.test/', 'https://q.test/', 'https://r.test/'])
      h.browser.tabs.createTab({ url: u, active: true }, second)
    const before = h.urls(second)
    const main = h.urls()
    h.close(h.tabByUrl('https://q.test/')!.id, second)
    h.focused.length = 0

    // Ctrl+Shift+T in the main window: the tab is the other window's and returns there.
    h.reopen(h.win)
    expect(h.urls(second)).toEqual(before)
    expect(h.urls()).toEqual(main)
    expect(h.browser.tabs.tab(second.selectedTabIn(second.activeSpace())!)?.url).toBe(
      'https://q.test/'
    )
    expect(h.focused).toEqual([second.id])
  })

  it('a tab whose window has since closed comes back into the window the user is in', () => {
    const h = harness()
    const second = h.browser.openWindow('unsynced', h.win)
    if (!second) throw new Error('no second window')
    h.browser.tabs.createTab({ url: 'https://p.test/', active: true }, second)
    const q = h.browser.tabs.createTab({ url: 'https://q.test/', active: true }, second)
    h.close(q.id, second)
    h.closeWindow(second)
    // Newest first: the window (with p) is the newest entry, the tab q the one before it.
    expect(h.browser.session.summaries().map((e) => e.kind)).toEqual(['window', 'tab'])
    h.browser.session.restoreClosed(h.browser.session.summaries()[1].id, h.win)
    expect(h.urls()).toContain('https://q.test/')
    expect(h.browser.allWindows()).toEqual([h.win])
  })

  it('puts a tab back into its group, between the members it stood between', () => {
    const h = harness()
    const folder = h.group('Trip')
    h.open('https://x.test/', { folderId: folder })
    const y = h.open('https://y.test/', { folderId: folder })
    h.open('https://z.test/', { folderId: folder })
    h.open('https://loose.test/')
    const before = h.urls()

    h.close(y)
    expect(h.tabByUrl('https://y.test/')).toBeUndefined()
    h.reopen()
    expect(h.urls()).toEqual(before)
    expect(h.tabByUrl('https://y.test/')?.folderId).toBe(folder)
  })

  it('puts a closed pinned tab back into the pinned section at its place', () => {
    const h = harness()
    h.browser.state.settings.pinnedCloseBehavior = 'close'
    h.open('https://p1.test/', { pinned: true })
    const p2 = h.open('https://p2.test/', { pinned: true })
    h.open('https://p3.test/', { pinned: true })
    h.open('https://r.test/')
    const before = h.urls()

    h.close(p2)
    expect(h.urls()).toEqual(before.filter((u) => u !== 'https://p2.test/'))
    h.reopen()
    expect(h.urls()).toEqual(before)
    expect(h.tabByUrl('https://p2.test/')?.pinned).toBe(true)
  })

  it('brings a closed window back as one unit – its tabs in order, its active tab selected – ahead of a tab closed before it', () => {
    const h = harness()
    const loose = h.open('https://loose.test/')
    const second = h.browser.openWindow('unsynced', h.win)
    if (!second) throw new Error('no second window')
    for (const u of ['https://p.test/', 'https://q.test/', 'https://r.test/'])
      h.browser.tabs.createTab({ url: u, active: true }, second)
    const q = Object.values(h.browser.state.model.tabs).find((t) => t.url === 'https://q.test/')!
    h.browser.tabs.activateTab(q.id, second)
    const windowTabs = h.urls(second)
    expect(windowTabs).toEqual(
      expect.arrayContaining(['https://p.test/', 'https://q.test/', 'https://r.test/'])
    )

    // A tab closes in the first window, then the second window closes.
    h.close(loose)
    h.closeWindow(second)
    expect(h.browser.allWindows()).toEqual([h.win])
    expect(h.browser.session.summaries().map((e) => [e.kind, e.tabCount])).toEqual([
      ['window', 3],
      ['tab', 1]
    ])

    // Ctrl+Shift+T: the window first, whole.
    h.reopen()
    const windows = h.browser.allWindows()
    expect(windows).toHaveLength(2)
    const back = windows.find((w) => w !== h.win)!
    expect(h.urls(back)).toEqual(['https://p.test/', 'https://q.test/', 'https://r.test/'])
    expect(h.browser.tabs.tab(back.selectedTabIn(back.activeSpace())!)?.url).toBe('https://q.test/')
    expect(h.urls()).not.toContain('https://loose.test/')

    // Then the tab, into the window it was closed from.
    h.reopen()
    expect(h.urls()).toContain('https://loose.test/')
    expect(h.browser.session.summaries()).toEqual([])
  })
})
