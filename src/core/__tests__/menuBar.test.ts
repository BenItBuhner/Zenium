import { describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
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
import { menuSignature } from '../menuBar'

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
  it('is handed to the host at start with Chrome’s eight menus', () => {
    const h = harness()
    expect(h.bars.length).toBe(1)
    expect(last(h).map((m) => m.label)).toEqual([
      'Zenium',
      'File',
      'Edit',
      'View',
      'History',
      'Bookmarks',
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

    it('Warn Before Quitting is a checkbox on the quit warning’s setting: on by default, flipped by a pick, the bar redrawn to match', () => {
      vi.useFakeTimers()
      try {
        const h = harness()
        const row = (): MenuItemTemplate =>
          item(submenu(last(h), 'Zenium'), 'Warn Before Quitting (⌘Q)')
        expect(row().type).toBe('checkbox')
        expect(row().checked).toBe(true)
        expect(h.browser.state.settings.warnOnCloseWindow).toBe(true)
        row().click?.()
        expect(h.browser.state.settings.warnOnCloseWindow).toBe(false)
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        expect(row().checked).toBe(false)
        // Back on from the redrawn bar; a pick with every window closed still flips it.
        h.win.onClosing()
        h.win.onClosed()
        row().click?.()
        expect(h.browser.state.settings.warnOnCloseWindow).toBe(true)
        expect(h.browser.allWindows()).toHaveLength(0)
        // Settings' own switch and the bar agree: the one setting.
        vi.advanceTimersByTime(MENU_BAR_SETTLE_MS)
        expect(row().checked).toBe(true)
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
