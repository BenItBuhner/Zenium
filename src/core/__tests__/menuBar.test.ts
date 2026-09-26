import { describe, expect, it, vi } from 'vitest'
import type {
  HostCapabilities,
  Platform as PlatformOs,
  ShortcutAction,
  SyncDeviceTabs,
  SyncRemoteTab
} from '../../shared/types'
import { bindingFor, toAccelerator } from '../../shared/shortcuts'
import { NEW_TAB_URL } from '../../shared/url'
import { Browser } from '../browser'
import type {
  AppHost,
  MenuHost,
  MenuItemTemplate,
  Platform,
  StoreIO,
  TabView,
  TabViewHost,
  WindowHost
} from '../platform'
import type { ZenWindow } from '../window'
import { HELP_URL, ISSUES_URL, menuSignature } from '../menuBar'

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
  /** The templates handed to the host's menu bar so far, oldest first. */
  bars: MenuItemTemplate[][]
  /** The last template handed to the host's popup. */
  popup: () => MenuItemTemplate[]
  /** Events the core sent the window's chrome, oldest first. */
  sent: Array<{ name: string; payload: unknown }>
  focused: { value: boolean }
}

/** The deferred state broadcast (one `setImmediate`) has gone out. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Long enough for the menu bar's debounce (under fake timers). */
const MENU_BAR_SETTLE_MS = 500

/** A desktop browser (macOS by default) whose host has a menu bar that only records templates. */
function harness(os: PlatformOs = 'darwin', menuBar = true): Harness {
  const bars: MenuItemTemplate[][] = []
  let lastPopup: MenuItemTemplate[] = []
  const sent: Harness['sent'] = []
  const focused = { value: true }
  const menus: MenuHost = {
    popup: (items) => {
      lastPopup = items
    },
    ...(menuBar
      ? {
          setApplicationMenu: (items: MenuItemTemplate[]) => {
            bars.push(items)
          }
        }
      : {})
  }
  const capabilities = stub<HostCapabilities>({
    windows: true,
    extensions: true,
    devtools: true,
    print: true,
    updates: false,
    agents: false,
    // Without the new tab page, New Tab is the URL bar alone (newtab.test.ts covers the page).
    newTabPage: false,
    // The desktop: Settings is its overlay, not a tab (the stub's default is a truthy function).
    pageTabs: false
  })
  const platform: Platform = {
    info: { os, version: '1.2.3' },
    capabilities,
    io: memoryIo(),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => focused.value,
          isVisible: () => true,
          send: (name: string, payload: unknown) => {
            sent.push({ name, payload })
          }
        })
    },
    views: stub<TabViewHost>({
      createView: () => stub<TabView>({ isDestroyed: () => false, isVisible: () => false })
    }),
    menus,
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub<AppHost>(),
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  return { browser, win, bars, popup: () => lastPopup, sent, focused }
}

const last = (h: Harness): MenuItemTemplate[] => h.bars[h.bars.length - 1] ?? []

function submenu(bar: MenuItemTemplate[], label: string): MenuItemTemplate[] {
  const menu = bar.find((m) => m.label === label)
  if (!menu?.submenu) throw new Error(`no ${label} menu`)
  return menu.submenu
}

function item(items: MenuItemTemplate[], label: string): MenuItemTemplate {
  const found = items.find((i) => i.label === label)
  if (!found) throw new Error(`no item ${label} in ${items.map((i) => i.label).join(', ')}`)
  return found
}

describe('the macOS menu bar', () => {
  it('is handed to the host at start with Chrome’s menus in Chrome’s order, less Profiles', () => {
    const h = harness()
    expect(h.bars.length).toBe(1)
    expect(last(h).map((m) => m.label)).toEqual([
      'Zenium',
      'File',
      'Edit',
      'View',
      'History',
      'Bookmarks',
      'Tab',
      'Window',
      'Help'
    ])
    // System menus are the host's roles.
    expect(item(last(h), 'Window').role).toBe('window')
    expect(item(last(h), 'Help').role).toBe('help')
    expect(item(submenu(last(h), 'Zenium'), 'Quit Zenium').role).toBe('quit')
    expect(item(submenu(last(h), 'Edit'), 'Copy').role).toBe('copy')
  })

  it('shows every action’s chord from the active table', () => {
    const h = harness()
    const file = submenu(last(h), 'File')
    expect(item(file, 'New Tab').accelerator).toBe('Cmd+T')
    expect(item(file, 'New Private Window').accelerator).toBe('Cmd+Shift+N')
    expect(item(file, 'Open File…').accelerator).toBe('Cmd+O')
    expect(item(file, 'Save Page As…').accelerator).toBe('Cmd+S')
    const view = submenu(last(h), 'View')
    expect(item(view, 'Compact Mode').accelerator).toBe('Cmd+Ctrl+S')
    expect(item(submenu(view, 'Developer'), 'Developer Tools').accelerator).toBe('Cmd+Alt+I')
    expect(item(submenu(last(h), 'Edit'), 'Copy').accelerator).toBeUndefined()
  })

  it('is rebuilt when the preset changes, and only when something it shows changed', async () => {
    const h = harness()
    await tick()
    const before = h.bars.length
    h.browser.handleCommand(h.win, 'settings.update', { shortcutPreset: 'zen' })
    await tick()
    expect(h.bars.length).toBe(before + 1)
    expect(item(submenu(last(h), 'File'), 'New Private Window').accelerator).toBe('Cmd+Shift+P')
    expect(item(submenu(last(h), 'View'), 'Compact Mode').accelerator).toBe('Cmd+S')
    // The same settings again: nothing to redraw.
    h.browser.handleCommand(h.win, 'settings.update', { shortcutPreset: 'zen' })
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(h.bars.length).toBe(before + 1)
  })

  it('runs the same action as the key from an item', () => {
    const h = harness()
    // New Tab opens the URL bar in new-tab mode, exactly what the chord does.
    item(submenu(last(h), 'File'), 'New Tab').click?.()
    expect(h.sent.at(-1)).toEqual({ name: 'urlbar.toggle', payload: { mode: 'new-tab' } })
    // Toggling compact mode from the menu flips the window like the chord.
    expect(h.win.compactEnabled).toBe(false)
    item(submenu(last(h), 'View'), 'Compact Mode').click?.()
    expect(h.win.compactEnabled).toBe(true)
  })

  it('carries Chrome’s Window › Name Window… in a group of its own, asking the front window’s chrome for the prompt and ignored with every window closed (shortcuts-menus-121)', () => {
    const h = harness()
    const window = submenu(last(h), 'Window')
    const labels = window.map((i) => (i.type === 'separator' ? '-' : i.label))
    const at = labels.indexOf('Name Window…')
    expect(at).toBeGreaterThan(0)
    // The group about this window: its name, then its double (session-19) – the order More
    // Tools lists the pair in (one order in both menus, the #451 lead check's) – right after the
    // window's own rows (Chrome's Window menu carries no tab rows: those are the Tab menu's).
    expect(labels.slice(0, at + 4)).toEqual([
      'Minimize',
      'Zoom',
      '-',
      'Name Window…',
      'Duplicate Window',
      '-',
      'Next Space'
    ])
    const row = item(window, 'Name Window…')
    expect(row.action).toBe('window.name')
    expect(row.enabled).toBe(true)
    expect(row.accelerator).toBeUndefined()
    h.sent.length = 0
    row.click?.()
    expect(h.sent.at(-1)).toEqual({ name: 'windowName.open', payload: undefined })
    // Nothing to name without a window: no window opens for it.
    h.win.onClosing()
    h.win.onClosed()
    expect(h.browser.allWindows()).toHaveLength(0)
    row.click?.()
    expect(h.browser.allWindows()).toHaveLength(0)
  })

  it('carries Window › Duplicate Window beside Name Window…: a second window on the front window’s space, none with every window closed (session-19)', () => {
    const h = harness()
    const row = item(submenu(last(h), 'Window'), 'Duplicate Window')
    expect(row.action).toBe('window.duplicate')
    expect(row.enabled).toBe(true)
    // Unbound in both presets: no chord after the label.
    expect(row.accelerator).toBeUndefined()
    row.click?.()
    const windows = h.browser.allWindows()
    expect(windows).toHaveLength(2)
    const dup = windows.find((w) => w !== h.win)
    expect(dup?.kind).toBe('synced')
    expect(dup?.activeSpace().id).toBe(h.win.activeSpace().id)
    expect(dup?.cascadeFrom).toBe(h.win)
    // Nothing to duplicate without a window: no window opens for it.
    for (const w of windows) {
      w.onClosing()
      w.onClosed()
    }
    expect(h.browser.allWindows()).toHaveLength(0)
    row.click?.()
    expect(h.browser.allWindows()).toHaveLength(0)
  })

  it('runs an action from the menu bar with every window closed by opening one first', () => {
    const h = harness()
    const openTab = item(submenu(last(h), 'File'), 'New Tab')
    const closeTab = item(submenu(last(h), 'File'), 'Close Tab')
    // The host closes the window (macOS keeps the app running).
    h.win.onClosing()
    h.win.onClosed()
    expect(h.browser.allWindows()).toHaveLength(0)
    // Close Tab needs a window and is ignored without one.
    closeTab.click?.()
    expect(h.browser.allWindows()).toHaveLength(0)
    openTab.click?.()
    expect(h.browser.allWindows()).toHaveLength(1)
  })

  it('carries Close Private Window – Close 2 Private Windows for more – in the Window menu’s first group while a private window is up, closing every private window (profiles-25)', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      const labels = (): string[] =>
        submenu(last(h), 'Window').map((i) => (i.type === 'separator' ? '-' : (i.label ?? '')))
      expect(labels().slice(0, 3)).toEqual(['Minimize', 'Zoom', '-'])
      const priv = h.browser.openWindow('private', h.win)!
      vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
      expect(labels().slice(0, 4)).toEqual(['Minimize', 'Zoom', 'Close Private Window', '-'])
      const other = h.browser.openWindow('private', h.win)!
      vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
      const row = item(submenu(last(h), 'Window'), 'Close 2 Private Windows')
      expect(row.action).toBeUndefined()
      row.click?.()
      // The close checks are promises: let them settle (no timer of the chain is longer).
      await vi.advanceTimersByTimeAsync(MENU_BAR_SETTLE_MS)
      expect(priv.closeApproved).toBe(true)
      expect(other.closeApproved).toBe(true)
      expect(h.win.closeApproved).toBe(false)
      // Gone with the private windows: the regular window's bar has no such row.
      priv.onClosing()
      priv.onClosed()
      other.onClosing()
      other.onClosed()
      vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
      expect(labels().slice(0, 3)).toEqual(['Minimize', 'Zoom', '-'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reflects the front window: compact mode is a checkbox that follows it', () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      const compact = (): MenuItemTemplate => item(submenu(last(h), 'View'), 'Compact Mode')
      expect(compact().type).toBe('checkbox')
      expect(compact().checked).toBe(false)
      h.browser.toggleCompactMode(h.win)
      vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
      expect(compact().checked).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is never built for hosts without a menu bar', () => {
    vi.useFakeTimers()
    try {
      const h = harness('linux', false)
      h.browser.toggleCompactMode(h.win)
      vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
      expect(h.bars).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  describe('the Zenium menu is Chrome’s application menu (shortcuts-menus-153)', () => {
    const labels = (items: MenuItemTemplate[]): string[] =>
      items.map((i) => (i.type === 'separator' ? '-' : (i.label ?? '')))

    it('runs About; Settings, Delete Browsing Data, Import; Services; the hide trio; Warn Before Quitting; Quit', () => {
      const h = harness()
      expect(labels(submenu(last(h), 'Zenium'))).toEqual([
        'About Zenium',
        '-',
        'Settings…',
        'Delete Browsing Data…',
        'Import Bookmarks and Settings…',
        '-',
        'Services',
        '-',
        'Hide Zenium',
        'Hide Others',
        'Show All',
        '-',
        'Warn Before Quitting (⌘Q)',
        '-',
        'Quit Zenium'
      ])
    })

    it('Delete Browsing Data… carries Cmd+Shift+Delete and asks the front window’s chrome for the dialog – a fresh window’s with every window closed', () => {
      const h = harness()
      const row = item(submenu(last(h), 'Zenium'), 'Delete Browsing Data…')
      expect(row.accelerator).toBe('Cmd+Shift+Delete')
      h.sent.length = 0
      row.click?.()
      expect(h.sent.map((s) => s.name)).toContain('clearBrowsingData.open')
      h.win.onClosing()
      h.win.onClosed()
      expect(h.browser.allWindows()).toHaveLength(0)
      h.sent.length = 0
      row.click?.()
      expect(h.browser.allWindows()).toHaveLength(1)
      expect(h.sent.map((s) => s.name)).toContain('clearBrowsingData.open')
    })

    it('Import Bookmarks and Settings… opens the import dialog, as the Bookmarks menu’s row does', () => {
      const h = harness()
      h.sent.length = 0
      item(submenu(last(h), 'Zenium'), 'Import Bookmarks and Settings…').click?.()
      expect(h.sent.map((s) => s.name)).toEqual(['import.open'])
      h.sent.length = 0
      item(submenu(last(h), 'Bookmarks'), 'Import Bookmarks and Settings…').click?.()
      expect(h.sent.map((s) => s.name)).toEqual(['import.open'])
    })

    it('Warn Before Quitting is a checkbox on its own setting (session-08): on by default, flipped by a pick, the bar redrawn to match', () => {
      vi.useFakeTimers()
      try {
        const h = harness()
        const row = (): MenuItemTemplate =>
          item(submenu(last(h), 'Zenium'), 'Warn Before Quitting (⌘Q)')
        expect(row().type).toBe('checkbox')
        expect(row().checked).toBe(true)
        expect(h.browser.state.settings.warnBeforeQuitting).toBe(true)
        row().click?.()
        expect(h.browser.state.settings.warnBeforeQuitting).toBe(false)
        // The tab-count warning is another setting: the pick leaves it alone.
        expect(h.browser.state.settings.warnOnCloseWindow).toBe(true)
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        expect(row().checked).toBe(false)
        // Back on from the redrawn bar; a pick with every window closed still flips it.
        h.win.onClosing()
        h.win.onClosed()
        row().click?.()
        expect(h.browser.state.settings.warnBeforeQuitting).toBe(true)
        expect(h.browser.allWindows()).toHaveLength(0)
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        expect(row().checked).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('Quit Zenium keeps the host’s quit role, whose registered chord quits with every window closed', () => {
      const h = harness()
      const row = item(submenu(last(h), 'Zenium'), 'Quit Zenium')
      expect(row.role).toBe('quit')
      expect(row.click).toBeUndefined()
    })
  })

  describe('the History menu carries Tabs from Other Devices (shortcuts-menus-108)', () => {
    const remote = (tabId: string, url: string, title: string): SyncRemoteTab => ({
      tabId,
      url,
      title,
      favicon: null,
      lastActive: 1,
      windowId: null
    })
    /** Sync on with Open tabs in scope, listing the phone; the bar redrawn to it. */
    const syncing = (h: Harness, lists: SyncDeviceTabs[]): void => {
      const status = h.browser.sync.status()
      vi.spyOn(h.browser.sync, 'status').mockReturnValue({
        ...status,
        enabled: true,
        scope: { ...status.scope, openTabs: true }
      })
      vi.spyOn(h.browser.sync, 'tabsFromDevices').mockReturnValue(lists)
      h.browser.state.commitVolatile()
      vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
    }
    const labels = (items: MenuItemTemplate[]): string[] =>
      items.map((i) => (i.type === 'separator' ? '-' : (i.label ?? '')))

    it('lists the devices as submenus after Recently Closed, behind a separator, and not at all while sync lists none', () => {
      vi.useFakeTimers()
      try {
        const h = harness()
        expect(labels(submenu(last(h), 'History'))).toEqual([
          'Home',
          'Back',
          'Forward',
          '-',
          'Reopen Closed Tab',
          'Recently Closed',
          '-',
          'Show Full History'
        ])
        syncing(h, [
          {
            deviceId: 'phone',
            deviceName: 'Pixel 9',
            updatedAt: 20,
            tabs: [remote('p1', 'https://a.test/', 'A'), remote('p2', 'https://b.test/', 'B')]
          }
        ])
        const menu = submenu(last(h), 'History')
        expect(labels(menu)).toEqual([
          'Home',
          'Back',
          'Forward',
          '-',
          'Reopen Closed Tab',
          'Recently Closed',
          '-',
          'Tabs from Other Devices',
          'Pixel 9',
          '-',
          'Show Full History'
        ])
        expect(item(menu, 'Tabs from Other Devices').enabled).toBe(false)
        expect(labels(item(menu, 'Pixel 9').submenu!)).toEqual(['A', 'B', '-', 'Open All in Tabs'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('a tab’s row opens it in the front window through the held-tab rule, and in a window opened for it when every window is closed', () => {
      vi.useFakeTimers()
      try {
        const h = harness()
        const held = h.browser.tabs.createTab(
          { id: 'p2', url: 'https://b.test/', active: false },
          h.win
        )
        const mine = h.browser.tabs.createTab({ url: 'https://mine.test/', active: true }, h.win)
        syncing(h, [
          {
            deviceId: 'phone',
            deviceName: 'Pixel 9',
            updatedAt: 20,
            tabs: [remote('p1', 'https://a.test/', 'A'), remote('p2', 'https://b.test/', 'B')]
          }
        ])
        const phone = (): MenuItemTemplate[] =>
          item(submenu(last(h), 'History'), 'Pixel 9').submenu!
        const urls = (): string[] => Object.values(h.browser.state.model.tabs).map((t) => t.url)
        expect(h.browser.tabs.activeTabFor(h.win)?.id).toBe(mine.id)
        // Held here under its own id: to the front, not opened again.
        const before = urls()
        item(phone(), 'B').click?.()
        expect(urls()).toEqual(before)
        expect(h.browser.tabs.activeTabFor(h.win)?.id).toBe(held.id)
        // Not held: a new tab in front.
        item(phone(), 'A').click?.()
        expect(urls().filter((u) => !before.includes(u))).toEqual(['https://a.test/'])
        expect(h.browser.tabs.activeTabFor(h.win)?.url).toBe('https://a.test/')
        // The bar stands with every window closed: a row opens a window for its tab.
        for (const w of h.browser.allWindows()) {
          w.onClosing()
          w.onClosed()
        }
        expect(h.browser.allWindows()).toHaveLength(0)
        item(phone(), 'A').click?.()
        expect(h.browser.allWindows()).toHaveLength(1)
        const opened = h.browser.allWindows()[0]!
        expect(h.browser.tabs.activeTabFor(opened)?.url).toBe('https://a.test/')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('the History menu lists Recently Visited (history-12, shortcuts-menus-157)', () => {
    /** The history's visit notification (throttled) and then the bar's debounce. */
    const HISTORY_SETTLE_MS = 500 + MENU_BAR_SETTLE_MS
    const labels = (items: MenuItemTemplate[]): string[] =>
      items.map((i) => (i.type === 'separator' ? '-' : (i.label ?? '')))
    const visit = (h: Harness, url: string, title: string, at: number): void =>
      h.browser.history.visit(url, title, title ? `data:image/png;base64,${title}` : null, { at })

    it('lists the ten pages last visited, newest first, by title, behind a separator and Chrome’s header, between Recently Closed and Tabs from Other Devices; nothing while history is empty', () => {
      vi.useFakeTimers()
      try {
        const h = harness()
        expect(labels(submenu(last(h), 'History'))).not.toContain('Recently Visited')
        const base = Date.now() - 60_000
        for (let i = 1; i <= 12; i++) visit(h, `https://p${i}.test/`, `Page ${i}`, base + i * 1000)
        // A page without a title is listed by its address.
        visit(h, 'https://notitle.test/path', '', base + 500)
        // A visit is not a model change: the history's own notification redraws the bar.
        vi.advanceTimersByTime(HISTORY_SETTLE_MS)
        const menu = submenu(last(h), 'History')
        expect(labels(menu)).toEqual([
          'Home',
          'Back',
          'Forward',
          '-',
          'Reopen Closed Tab',
          'Recently Closed',
          '-',
          'Recently Visited',
          'Page 12',
          'Page 11',
          'Page 10',
          'Page 9',
          'Page 8',
          'Page 7',
          'Page 6',
          'Page 5',
          'Page 4',
          'Page 3',
          '-',
          'Show Full History'
        ])
        // The header is a heading, in the note form the sibling "Tabs from Other Devices"
        // heading takes (#396's A7): disabled, and a note to a renderer that draws the template.
        expect(item(menu, 'Recently Visited')).toMatchObject({ enabled: false, note: true })
        expect(item(menu, 'Recently Visited').click).toBeUndefined()
        expect(item(menu, 'Page 12').click).toBeTypeOf('function')
        // Each row carries its page's favicon (shortcuts-menus-157).
        expect(item(menu, 'Page 12').icon).toBe('data:image/png;base64,Page 12')
        // Only the newest ten are listed; older visits, and the untitled one, wait their turn
        // (a deletion redraws the bar at once).
        h.browser.history.deleteUrls(
          Array.from({ length: 10 }, (_, i) => `https://p${i + 3}.test/`)
        )
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        expect(labels(submenu(last(h), 'History')).slice(7, 11)).toEqual([
          'Recently Visited',
          'Page 2',
          'Page 1',
          'notitle.test/path'
        ])
        // Clearing history takes the block, separator and header with it.
        h.browser.history.clear()
        vi.advanceTimersByTime(HISTORY_SETTLE_MS)
        expect(labels(submenu(last(h), 'History'))).toEqual([
          'Home',
          'Back',
          'Forward',
          '-',
          'Reopen Closed Tab',
          'Recently Closed',
          '-',
          'Show Full History'
        ])
      } finally {
        vi.useRealTimers()
      }
    })

    it('a row loads its page in the front window’s current tab, as Chrome’s does, and in a window opened for it when every window is closed', () => {
      vi.useFakeTimers()
      try {
        const h = harness()
        const mine = h.browser.tabs.createTab({ url: 'https://mine.test/', active: true }, h.win)
        visit(h, 'https://a.test/', 'A', Date.now() - 1000)
        vi.advanceTimersByTime(HISTORY_SETTLE_MS)
        const count = Object.keys(h.browser.state.model.tabs).length
        item(submenu(last(h), 'History'), 'A').click?.()
        // The same tab, navigated; no tab spent on it.
        expect(h.browser.tabs.activeTabFor(h.win)?.id).toBe(mine.id)
        expect(h.browser.tabs.tab(mine.id)?.url).toBe('https://a.test/')
        expect(Object.keys(h.browser.state.model.tabs)).toHaveLength(count)
        // The bar stands with every window closed: a row opens a window for its page.
        for (const w of h.browser.allWindows()) {
          w.onClosing()
          w.onClosed()
        }
        expect(h.browser.allWindows()).toHaveLength(0)
        item(submenu(last(h), 'History'), 'A').click?.()
        expect(h.browser.allWindows()).toHaveLength(1)
        const opened = h.browser.allWindows()[0]!
        expect(h.browser.tabs.activeTabFor(opened)?.url).toBe('https://a.test/')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('opens Help › Keyboard Shortcuts through the Settings page’s one route: the overlay on this host, at its Shortcuts section', () => {
    const h = harness()
    h.sent.length = 0
    item(submenu(last(h), 'Help'), 'Keyboard Shortcuts').click?.()
    // The desktop has no page tabs: `page.open` opens the Settings overlay on the section (the
    // panel draws the Shortcuts section either way). A host with page tabs gets the tab instead,
    // from the same call (pages.test.ts).
    const overlays = h.sent.filter((s) => s.name === 'overlay.open')
    expect(overlays).toHaveLength(1)
    expect(overlays[0]!.payload).toEqual({ kind: 'settings', section: 'shortcuts' })
  })

  it("orders Help as the app menu's Help submenu does, less About Zenium, which is the application menu's: What's New over the hairline, then Zenium Help, Keyboard Shortcuts, Report an Issue…; the help role for macOS's Search field; no Report Unsafe Site, Zenium having no Safe Browsing report path (shortcuts-menus-162)", () => {
    const h = harness()
    const help = submenu(last(h), 'Help')
    expect(help.map((i) => (i.type === 'separator' ? '-' : i.label))).toEqual([
      "What's New",
      '-',
      'Zenium Help',
      'Keyboard Shortcuts',
      'Report an Issue…'
    ])
    expect(item(last(h), 'Help').role).toBe('help')
    // Chrome's Help chords name no action of the key table: no row shows one.
    for (const row of help) expect(row.accelerator).toBeUndefined()
    // Every row is a pick: enabled, with a click.
    for (const row of help.filter((i) => i.type !== 'separator')) {
      expect(row.enabled).not.toBe(false)
      expect(row.click).toBeTypeOf('function')
    }
    expect(help.map((i) => i.label)).not.toContain('About Zenium')
  })

  it('Help › Zenium Help and Report an Issue… open their pages in the system browser; What’s New opens this version’s release notes (in a window opened for it with every window closed)', () => {
    const h = harness()
    const opened: string[] = []
    h.browser.platform.shell.openExternal = (url: string) => {
      opened.push(url)
    }
    const help = submenu(last(h), 'Help')
    item(help, 'Zenium Help').click?.()
    item(help, 'Report an Issue…').click?.()
    expect(opened).toEqual([HELP_URL, ISSUES_URL])
    expect(ISSUES_URL).toMatch(/\/issues/)
    const whatsNew = vi.spyOn(h.browser.updates, 'openWhatsNew').mockImplementation(() => undefined)
    item(help, "What's New").click?.()
    expect(whatsNew).toHaveBeenCalledWith(h.win)
    h.win.onClosing()
    h.win.onClosed()
    expect(h.browser.allWindows()).toHaveLength(0)
    item(help, "What's New").click?.()
    expect(h.browser.allWindows()).toHaveLength(1)
    expect(whatsNew).toHaveBeenLastCalledWith(h.browser.allWindows()[0])
  })

  it('Zenium › About Zenium is an enabled row opening the About page (Settings › About) through the Settings page’s one route, as the ⋯ menu’s Help › About Zenium does – not the host’s About panel (shortcuts-menus-123)', () => {
    const h = harness()
    const row = item(submenu(last(h), 'Zenium'), 'About Zenium')
    expect(row.role).toBeUndefined()
    expect(row.enabled).not.toBe(false)
    h.sent.length = 0
    row.click?.()
    const overlays = h.sent.filter((s) => s.name === 'overlay.open')
    expect(overlays).toHaveLength(1)
    expect(overlays[0]!.payload).toEqual({ kind: 'settings', section: 'about' })
    // The bar stands with every window closed: the row opens a window for the page.
    h.win.onClosing()
    h.win.onClosed()
    expect(h.browser.allWindows()).toHaveLength(0)
    h.sent.length = 0
    row.click?.()
    expect(h.browser.allWindows()).toHaveLength(1)
    expect(h.sent.filter((s) => s.name === 'overlay.open')).toHaveLength(1)
  })

  describe('the Tab menu is Chrome’s, between Bookmarks and Window (shortcuts-menus-160)', () => {
    const labels = (items: MenuItemTemplate[]): string[] =>
      items.map((i) => (i.type === 'separator' ? '-' : (i.label ?? '')))
    const tabMenu = (h: Harness): MenuItemTemplate[] => submenu(last(h), 'Tab')
    /** The rows' enabled states by label. */
    const enabled = (h: Harness): Record<string, boolean> =>
      Object.fromEntries(tabMenu(h).map((i) => [i.label, i.enabled !== false]))

    it('lists Chrome’s rows in Chrome’s order, the vertical strip’s twins for the two rows Chrome words by direction, and Zenium’s folder rows for Group Tab', () => {
      const h = harness()
      expect(labels(tabMenu(h))).toEqual([
        'New Tab Below',
        'Select Next Tab',
        'Select Previous Tab',
        'Duplicate Tab',
        'Mute Site',
        'Pin Tab',
        'Add Tab to New Folder',
        'Remove from Folder',
        'Close Other Tabs',
        'Close Tabs Below',
        'Move Tab to New Window',
        'Search Tabs…'
      ])
      // The tab rows left the Window menu for it, as Chrome's Window menu has none.
      const window = labels(submenu(last(h), 'Window'))
      for (const row of ['Select Next Tab', 'Select Previous Tab', 'Search Tabs…'])
        expect(window).not.toContain(row)
    })

    it('shows each chord row the key table’s binding – never a second truth – and none on the rows without an action', () => {
      const h = harness()
      const menu = tabMenu(h)
      const chords = Object.fromEntries(menu.map((i) => [i.label, i.accelerator]))
      const table = h.browser.state.shortcuts
      const expectChord = (label: string, action: ShortcutAction): void => {
        expect(item(menu, label).action).toBe(action)
        expect(chords[label]).toBe(toAccelerator(bindingFor(table, action)))
        expect(chords[label]).toBeTypeOf('string')
      }
      expectChord('Select Next Tab', 'tab.next')
      expectChord('Select Previous Tab', 'tab.prev')
      expectChord('Duplicate Tab', 'tab.duplicate')
      expectChord('Pin Tab', 'tab.togglePin')
      expectChord('Search Tabs…', 'tab.search')
      // Chrome's chords, in the chrome preset.
      expect(chords['Select Next Tab']).toBe('Ctrl+Tab')
      expect(chords['Select Previous Tab']).toBe('Ctrl+Shift+Tab')
      expect(chords['Duplicate Tab']).toBe('Cmd+Shift+K')
      expect(chords['Pin Tab']).toBe('Cmd+Ctrl+P')
      expect(chords['Search Tabs…']).toBe('Cmd+Shift+A')
      for (const label of [
        'New Tab Below',
        'Mute Site',
        'Add Tab to New Folder',
        'Remove from Folder',
        'Close Other Tabs',
        'Close Tabs Below',
        'Move Tab to New Window'
      ]) {
        expect(item(menu, label).action).toBeUndefined()
        expect(chords[label]).toBeUndefined()
      }
    })

    it('follows the preset: the chords are redrawn from the new table', async () => {
      const h = harness()
      await tick()
      h.browser.handleCommand(h.win, 'settings.update', { shortcutPreset: 'zen' })
      await tick()
      const menu = tabMenu(h)
      const table = h.browser.state.shortcuts
      for (const [label, action] of [
        ['Select Next Tab', 'tab.next'],
        ['Select Previous Tab', 'tab.prev'],
        ['Duplicate Tab', 'tab.duplicate'],
        ['Pin Tab', 'tab.togglePin'],
        ['Search Tabs…', 'tab.search']
      ] as Array<[string, ShortcutAction]>)
        expect(item(menu, label).accelerator ?? null).toBe(
          toAccelerator(bindingFor(table, action))
        )
    })

    it('greys with the active tab: a page without a site cannot be muted, one tab leaves nothing to close, a tab in no folder has none to leave; a site tab among others enables them; every row greys with every window closed', () => {
      vi.useFakeTimers()
      try {
        const h = harness()
        // The fresh window holds no tab (this host's New Tab is the URL bar alone): every row
        // about a tab greys; Search Tabs… wants a window alone.
        const none = enabled(h)
        expect(none['Search Tabs…']).toBe(true)
        expect(Object.entries(none).filter(([, on]) => on).map(([l]) => l)).toEqual([
          'Search Tabs…'
        ])
        // A new tab page: no site to mute, nothing else to close, no folder to leave.
        h.browser.tabs.createTab({ url: NEW_TAB_URL, active: true }, h.win)
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        expect(enabled(h)).toEqual({
          'New Tab Below': true,
          'Select Next Tab': true,
          'Select Previous Tab': true,
          'Duplicate Tab': true,
          'Mute Site': false,
          'Pin Tab': true,
          'Add Tab to New Folder': true,
          'Remove from Folder': false,
          'Close Other Tabs': false,
          'Close Tabs Below': false,
          'Move Tab to New Window': true,
          'Search Tabs…': true
        })
        const site = h.browser.tabs.createTab({ url: 'https://a.test/', active: true }, h.win)
        h.browser.tabs.createTab({ url: 'https://b.test/', active: false }, h.win)
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        expect(h.browser.tabs.activeTabFor(h.win)?.id).toBe(site.id)
        expect(enabled(h)).toMatchObject({
          'Mute Site': true,
          'Close Other Tabs': true,
          'Close Tabs Below': true
        })
        for (const w of h.browser.allWindows()) {
          w.onClosing()
          w.onClosed()
        }
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        expect(h.browser.allWindows()).toHaveLength(0)
        expect(Object.values(enabled(h)).every((on) => !on)).toBe(true)
        // The rows stand, greyed: same labels, nothing gone.
        expect(labels(tabMenu(h))).toHaveLength(12)
      } finally {
        vi.useRealTimers()
      }
    })

    it('the toggles read their state: Pin Tab / Unpin Tab through the key’s action, Mute Site / Unmute Site through the site’s sound setting, as the tab’s context menu words them', () => {
      vi.useFakeTimers()
      try {
        const h = harness()
        const tab = h.browser.tabs.createTab({ url: 'https://a.test/', active: true }, h.win)
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        item(tabMenu(h), 'Pin Tab').click?.()
        expect(h.browser.tabs.tab(tab.id)?.pinned).toBe(true)
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        const unpin = item(tabMenu(h), 'Unpin Tab')
        expect(unpin.action).toBe('tab.togglePin')
        // A pinned tab is one no folder takes: the folder row greys with it.
        expect(item(tabMenu(h), 'Add Tab to New Folder').enabled).toBe(false)
        unpin.click?.()
        expect(h.browser.tabs.tab(tab.id)?.pinned).toBe(false)
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        expect(labels(tabMenu(h))).toContain('Pin Tab')
        expect(item(tabMenu(h), 'Add Tab to New Folder').enabled).toBe(true)

        expect(h.browser.tabs.siteMuted('https://a.test/')).toBe(false)
        item(tabMenu(h), 'Mute Site').click?.()
        expect(h.browser.tabs.siteMuted('https://a.test/')).toBe(true)
        expect(h.browser.tabs.tab(tab.id)?.muted).toBe(true)
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        item(tabMenu(h), 'Unmute Site').click?.()
        expect(h.browser.tabs.siteMuted('https://a.test/')).toBe(false)
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        expect(labels(tabMenu(h))).toContain('Mute Site')
      } finally {
        vi.useRealTimers()
      }
    })

    it('Group Tab is the tab context menu’s folder rows: Add Tab to New Folder while the space has none, else Move to Folder ▸ with a new folder first and the space’s folders, the tab’s own checked; Remove from Folder beside it, greyed outside one', () => {
      vi.useFakeTimers()
      try {
        const h = harness()
        const tab = h.browser.tabs.createTab({ url: 'https://a.test/', active: true }, h.win)
        const other = h.browser.tabs.createTab({ url: 'https://b.test/', active: false }, h.win)
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        expect(labels(tabMenu(h))).not.toContain('Move to Folder')
        // The row makes a folder around the active tab, the context menu's command.
        item(tabMenu(h), 'Add Tab to New Folder').click?.()
        const folderId = h.browser.tabs.tab(tab.id)?.folderId
        expect(folderId).toBeTypeOf('string')
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        expect(labels(tabMenu(h))).not.toContain('Add Tab to New Folder')
        const move = item(tabMenu(h), 'Move to Folder')
        expect(move.enabled).toBe(true)
        const folder = h.browser.state.model.folders[folderId!]!
        expect(labels(move.submenu!)).toEqual([
          'New Folder…',
          '-',
          `${folder.icon} ${folder.name}`
        ])
        expect(move.submenu![2]).toMatchObject({ type: 'checkbox', checked: true })
        const remove = item(tabMenu(h), 'Remove from Folder')
        expect(remove.enabled).toBe(true)
        remove.click?.()
        expect(h.browser.tabs.tab(tab.id)?.folderId).toBeNull()
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        expect(item(tabMenu(h), 'Remove from Folder').enabled).toBe(false)
        expect(item(tabMenu(h), 'Move to Folder').submenu![2]).toMatchObject({ checked: false })
        // A folder's row moves the active tab into it; the checked one's takes it out again.
        item(tabMenu(h), 'Move to Folder').submenu![2]!.click?.()
        expect(h.browser.tabs.tab(tab.id)?.folderId).toBe(folderId)
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        item(tabMenu(h), 'Move to Folder').submenu![2]!.click?.()
        expect(h.browser.tabs.tab(tab.id)?.folderId).toBeNull()
        // The other tab, made active, reads its own state: no folder, the row unchecked.
        h.browser.tabs.activateTab(other.id, h.win)
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        expect(item(tabMenu(h), 'Move to Folder').submenu![2]).toMatchObject({ checked: false })
      } finally {
        vi.useRealTimers()
      }
    })

    it('runs the tab context menu’s commands on the front window’s active tab: New Tab Below, Duplicate Tab, Close Tabs Below, Close Other Tabs, Move Tab to New Window, Select Next Tab', () => {
      vi.useFakeTimers()
      try {
        const h = harness()
        const { tabs } = h.browser
        const first = tabs.createTab({ url: 'https://a.test/', active: true }, h.win)
        const ids = (): string[] => h.win.activeSpace().tabIds
        const before = ids()
        item(tabMenu(h), 'New Tab Below').click?.()
        expect(ids()).toHaveLength(before.length + 1)
        expect(ids()[before.indexOf(first.id) + 1]).not.toBe(first.id)
        const below = ids()[ids().indexOf(first.id) + 1]!
        tabs.activateTab(first.id, h.win)
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        item(tabMenu(h), 'Duplicate Tab').click?.()
        expect(ids()).toHaveLength(before.length + 2)
        const dup = tabs.activeTabFor(h.win)!
        expect(dup.id).not.toBe(first.id)
        expect(dup.url).toBe('https://a.test/')
        tabs.activateTab(first.id, h.win)
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        item(tabMenu(h), 'Close Tabs Below').click?.()
        expect(ids()).not.toContain(below)
        expect(ids()).not.toContain(dup.id)
        expect(ids()).toContain(first.id)
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        item(tabMenu(h), 'Close Other Tabs').click?.()
        expect(ids()).toEqual([first.id])
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        // The one tab left: nothing to cycle to, but the rows run – and Move Tab to New Window
        // opens a second window around it.
        item(tabMenu(h), 'Select Next Tab').click?.()
        expect(tabs.activeTabFor(h.win)?.id).toBe(first.id)
        item(tabMenu(h), 'Move Tab to New Window').click?.()
        expect(h.browser.allWindows()).toHaveLength(2)
        const moved = h.browser.allWindows().find((w) => w !== h.win)!
        expect(tabs.activeTabFor(moved)?.id).toBe(first.id)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})

describe('menuSignature', () => {
  it('ignores click handlers and sees labels, states and chords', () => {
    const a: MenuItemTemplate[] = [{ label: 'X', accelerator: 'Ctrl+X', click: () => undefined }]
    const b: MenuItemTemplate[] = [{ label: 'X', accelerator: 'Ctrl+X', click: () => undefined }]
    expect(menuSignature(a)).toBe(menuSignature(b))
    expect(menuSignature([{ label: 'X', accelerator: 'Ctrl+Y' }])).not.toBe(menuSignature(a))
    expect(menuSignature([{ label: 'X', enabled: false }])).not.toBe(
      menuSignature([{ label: 'X' }])
    )
    expect(menuSignature([{ label: 'X', submenu: [{ label: 'Y' }] }])).not.toBe(
      menuSignature([{ label: 'X', submenu: [{ label: 'Z' }] }])
    )
  })
})
