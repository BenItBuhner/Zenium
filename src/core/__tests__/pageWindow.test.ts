import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { sanitizePageWindows } from '../../shared/types'
import { Browser } from '../browser'
import type {
  KeyEventInput,
  Platform,
  StoreIO,
  TabView,
  TabViewHost,
  WindowCreateInit,
  WindowHost
} from '../platform'
import type { ZenWindow } from '../window'

/**
 * The task manager in its own window (W5-18, Bennett's call of 2026-09-24: as Chrome's and
 * Edge's): `Browser.openTaskManager` behind Shift+Esc, More Tools › Task Manager and the
 * palette's row – a page window (`WindowChrome` `page`) holding the `zen://tasks` page and
 * nothing else, one per profile, remembered where it stood, closed with the last browser window;
 * the page tab where the host has one window.
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

/** Anything the browser touches on the host answers with a harmless no-op. */
function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

interface FakeWindow {
  win: ZenWindow
  init: WindowCreateInit
  shown: number
  focused: number
  closed: number
  titles: string[]
  /** What the host window reports as its normal bounds and display (`onBoundsChanged` reads them). */
  bounds: { x: number; y: number; width: number; height: number } | null
  displayId: number
}

interface Fixture {
  browser: Browser
  hosts: FakeWindow[]
  files: Record<string, string>
  hostOf(win: ZenWindow): FakeWindow
  browserWindow(): ZenWindow
  pageWindows(): ZenWindow[]
}

function fixture(
  options: { windows?: boolean; os?: PlatformOs; files?: Record<string, string> } = {}
): Fixture {
  const hosts: FakeWindow[] = []
  const files = options.files ?? {}
  const capabilities = stub<HostCapabilities>({
    windows: options.windows ?? true,
    updates: false,
    agents: false,
    pinShortcuts: true
  })
  const platform: Platform = {
    info: { os: options.os ?? ('linux' as PlatformOs), version: '0.0.0' },
    capabilities,
    io: memoryIo(files),
    windows: {
      create: (win, init) => {
        const entry: FakeWindow = {
          win,
          init,
          shown: 0,
          focused: 0,
          closed: 0,
          titles: [],
          bounds: null,
          displayId: 1
        }
        hosts.push(entry)
        return stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => entry.bounds,
          displayId: () => entry.displayId,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => false,
          isVisible: () => true,
          show: () => {
            entry.shown++
          },
          focus: () => {
            entry.focused++
          },
          close: () => {
            entry.closed++
          },
          setTitle: (title: string) => {
            entry.titles.push(title)
          }
        })
      }
    },
    views: stub<TabViewHost>({
      createView: () => {
        let url = ''
        return stub<TabView>({
          isDestroyed: () => false,
          postToPage: () => undefined,
          loadURL: (u: string) => {
            url = u
          },
          getURL: () => url,
          getTitle: () => '',
          hasDocument: () => url !== '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          isCurrentlyAudible: () => false,
          isVisible: () => true
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
    shortcuts: { pin: async () => true, unpin: async () => undefined },
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  return {
    browser,
    hosts,
    files,
    hostOf: (win) => {
      const h = hosts.find((e) => e.win === win)
      if (!h) throw new Error('no host for window')
      return h
    },
    browserWindow: () => {
      const win = browser.allWindows().find((w) => w.chrome === 'full')
      if (!win) throw new Error('no browser window')
      return win
    },
    pageWindows: () => browser.allWindows().filter((w) => w.chrome === 'page')
  }
}

const TASKS_URL = 'zen://tasks'

function key(k: string, mods: Partial<KeyEventInput> = {}): KeyEventInput {
  return {
    type: 'keyDown',
    key: k,
    control: false,
    shift: false,
    alt: false,
    meta: false,
    isAutoRepeat: false,
    ...mods
  }
}

const SHIFT_ESC = key('Escape', { shift: true })
const CTRL_T = key('t', { control: true })
const CTRL_SHIFT_W = key('w', { control: true, shift: true })

/** Close a window the way the host reports it: the closing edge, then the closed one. */
function closeWindow(win: ZenWindow): void {
  win.onClosing()
  win.onClosed()
}

describe('the task manager window (W5-18)', () => {
  it('opens the zen://tasks page as the one tab of a page window: unsynced, no browser chrome, titled from the first frame, focused', () => {
    const f = fixture()
    const browserWin = f.browserWindow()
    const page = f.browser.tabs.createTab({ url: 'https://a.example/', active: true }, browserWin)
    const win = f.browser.openTaskManager(browserWin)
    expect(win).not.toBeNull()
    if (!win) return
    expect(win.chrome).toBe('page')
    expect(win.kind).toBe('unsynced')
    expect(win.compactEnabled).toBe(false)
    expect(win.app).toBeNull()
    expect(win.isPrivate).toBe(false)
    expect(f.pageWindows()).toEqual([win])
    // One tab, the page's, and no starter tab beside it.
    const tab = f.browser.tabs.activeTabFor(win)
    expect(tab?.url).toBe(TASKS_URL)
    expect(tab?.title).toBe('Task Manager')
    expect(f.browser.tabs.visibleTabIds(win)).toEqual([tab?.id])
    // The host was told the chrome and the title at creation, and asked to focus the window.
    const host = f.hostOf(win)
    expect(host.init.chrome).toBe('page')
    expect(host.init.title).toBe('Task Manager — Zenium')
    expect(host.init.app).toBeNull()
    expect(host.init.cascadeFrom).toBe(browserWin)
    expect(host.init.bounds).toBeNull()
    expect(host.focused).toBe(1)
    // The browser window keeps its page in front, and the task manager is not one of its tabs.
    expect(f.browser.tabs.activeTabFor(browserWin)?.id).toBe(page.id)
    expect(f.browser.tabs.visibleTabIds(browserWin)).not.toContain(tab?.id)
    // The window's snapshot carries the chrome the renderer routes on.
    expect(win.windowState().chrome).toBe('page')
    // Not the session's: a relaunch restores the browser windows alone.
    f.browser.state.flushSync()
    const persisted = JSON.parse(f.files['state.json'] ?? '{}') as {
      windows?: Array<{ id: string }>
    }
    expect(persisted.windows?.map((w) => w.id)).toContain(browserWin.id)
    expect(persisted.windows?.map((w) => w.id)).not.toContain(win.id)
  })

  it('is one per profile: a second ask, from any window, brings the open one to the front', () => {
    const f = fixture()
    const browserWin = f.browserWindow()
    const win = f.browser.openTaskManager(browserWin)!
    const host = f.hostOf(win)
    const other = f.browser.createWindow({ kind: 'unsynced', from: browserWin })
    const tabs = Object.keys(f.browser.state.model.tabs).length
    const windows = f.browser.allWindows().length
    expect(f.browser.openTaskManager(browserWin)).toBe(win)
    // From a second browser window as well.
    expect(f.browser.openTaskManager(other)).toBe(win)
    // And from the task manager's own window (Shift+Esc pressed in it).
    expect(f.browser.openTaskManager(win)).toBe(win)
    expect(f.browser.allWindows()).toHaveLength(windows)
    expect(Object.keys(f.browser.state.model.tabs)).toHaveLength(tabs)
    expect(host.shown).toBe(3)
    expect(host.focused).toBe(4)
    expect(f.browser.pageWindowIdOf(win)).toBe('tasks')
    expect(f.browser.pageWindowIdOf(browserWin)).toBeNull()
  })

  it('opens again once the window is closed – a fresh window, the old one forgotten', () => {
    const f = fixture()
    const browserWin = f.browserWindow()
    const first = f.browser.openTaskManager(browserWin)!
    closeWindow(first)
    expect(f.pageWindows()).toEqual([])
    expect(f.browser.pageWindowIdOf(first)).toBeNull()
    const second = f.browser.openTaskManager(browserWin)!
    expect(second).not.toBe(first)
    expect(second.chrome).toBe('page')
    expect(f.browser.tabs.activeTabFor(second)?.url).toBe(TASKS_URL)
    expect(f.pageWindows()).toEqual([second])
  })

  it('keeps the page tab where the host has one window (`capabilities.windows` false: the phone)', () => {
    const f = fixture({ windows: false })
    const win = f.browserWindow()
    expect(f.browser.openTaskManager(win)).toBeNull()
    expect(f.pageWindows()).toEqual([])
    expect(f.browser.allWindows()).toEqual([win])
    // The desktop layout's page tab, as it always was there.
    expect(f.browser.tabs.activeTabFor(win)?.url).toBe(TASKS_URL)
  })

  it('leaves zen://tasks typed into a tab as the page tab it always was (no window for the address)', () => {
    const f = fixture()
    const browserWin = f.browserWindow()
    const tab = f.browser.tabs.createTab({ url: 'https://a.example/', active: true }, browserWin)
    f.browser.tabs.navigate(tab.id, TASKS_URL)
    // A chrome page's address opens the page in its own tab next to the typing one
    // (`PageService.routeNavigation`), in the browser window – in front there, as before.
    const active = f.browser.tabs.activeTabFor(browserWin)
    expect(active?.url).toBe(TASKS_URL)
    expect(active?.openerTabId).toBe(tab.id)
    expect(f.browser.tabs.visibleTabIds(browserWin)).toContain(active?.id)
    expect(f.pageWindows()).toEqual([])
    // And Shift+Esc afterwards still opens the window: the tab is not the profile's one task
    // manager, the window is.
    const win = f.browser.openTaskManager(browserWin)
    expect(win?.chrome).toBe('page')
    expect(f.browser.tabs.activeTabFor(browserWin)?.id).toBe(active?.id)
  })

  it('remembers where the window stood on this device and brings it back there, across a relaunch too', () => {
    const f = fixture()
    const browserWin = f.browserWindow()
    const win = f.browser.openTaskManager(browserWin)!
    const host = f.hostOf(win)
    expect(f.browser.state.pageWindowsDevice).toEqual({})
    // The user drags the window to another display and sizes it.
    host.bounds = { x: 2000, y: 140, width: 900, height: 640 }
    host.displayId = 7
    win.onBoundsChanged()
    expect(f.browser.state.pageWindowsDevice).toEqual({
      tasks: { bounds: { x: 2000, y: 140, width: 900, height: 640 }, displayId: 7 }
    })
    // The same report again writes nothing new; a moved window is kept.
    win.onBoundsChanged()
    host.bounds = { x: 2010, y: 140, width: 900, height: 640 }
    win.onBoundsChanged()
    expect(f.browser.state.pageWindowsDevice.tasks?.bounds.x).toBe(2010)
    // Closed and opened again: where it stood, on that display, no cascade.
    closeWindow(win)
    const again = f.browser.openTaskManager(browserWin)!
    expect(f.hostOf(again).init.bounds).toEqual({ x: 2010, y: 140, width: 900, height: 640 })
    expect(f.hostOf(again).init.displayId).toBe(7)
    expect(f.hostOf(again).init.cascadeFrom).toBeNull()

    // The place survives a relaunch with the profile – never as part of the synced model.
    f.browser.state.flushSync()
    const persisted = JSON.parse(f.files['state.json'] ?? '{}') as {
      pageWindowsDevice?: unknown
    }
    expect(persisted.pageWindowsDevice).toEqual({
      tasks: { bounds: { x: 2010, y: 140, width: 900, height: 640 }, displayId: 7 }
    })
    const relaunched = fixture({ files: f.files })
    const back = relaunched.browser.openTaskManager(relaunched.browserWindow())!
    expect(relaunched.hostOf(back).init.bounds).toEqual({
      x: 2010,
      y: 140,
      width: 900,
      height: 640
    })
    expect(relaunched.hostOf(back).init.displayId).toBe(7)
  })

  it('drops a remembered place that is not a whole rectangle when the profile loads; a display that is not a number reads as none', () => {
    expect(sanitizePageWindows(undefined)).toEqual({})
    expect(sanitizePageWindows('no')).toEqual({})
    expect(
      sanitizePageWindows({
        tasks: { bounds: { x: 1, y: 2, width: 3 }, displayId: 1 },
        nan: { bounds: { x: Number.NaN, y: 2, width: 300, height: 200 }, displayId: 1 },
        none: null,
        kept: { bounds: { x: 1, y: 2, width: 300, height: 200 }, displayId: 4 },
        other: { bounds: { x: 1, y: 2, width: 300, height: 200 }, displayId: 'no' },
        unplaced: { bounds: { x: 1, y: 2, width: 300, height: 200 }, displayId: null }
      })
    ).toEqual({
      kept: { bounds: { x: 1, y: 2, width: 300, height: 200 }, displayId: 4 },
      other: { bounds: { x: 1, y: 2, width: 300, height: 200 }, displayId: null },
      unplaced: { bounds: { x: 1, y: 2, width: 300, height: 200 }, displayId: null }
    })
  })

  it('closes with the last browser window – not with a popup’s or an app window’s going, nor while a browser window stays', () => {
    const f = fixture()
    const first = f.browserWindow()
    const second = f.browser.createWindow({ kind: 'unsynced', from: first })
    const tasks = f.browser.openTaskManager(first)!
    const host = f.hostOf(tasks)
    // A popup and an app window come and go: the task manager stays.
    const popup = f.browser.createWindow({ kind: 'unsynced', from: first, chrome: 'popup' })
    closeWindow(popup)
    const app = f.browser.openAppWindow('https://app.example/')!
    closeWindow(app)
    expect(host.closed).toBe(0)
    // The first browser window goes; the second is still up: the task manager stays with it.
    closeWindow(first)
    expect(host.closed).toBe(0)
    expect(tasks.closeApproved).toBe(false)
    // The last browser window goes: the task manager closes at once, with nothing to ask.
    closeWindow(second)
    expect(host.closed).toBe(1)
    expect(tasks.closeApproved).toBe(true)
  })

  it('does not hold the app up on its own: the browser window closing is still the last one for the downloads warning', async () => {
    const f = fixture()
    const browserWin = f.browserWindow()
    f.browser.openTaskManager(browserWin)
    // No downloads, no tabs to warn about: the close goes through as it would with no task
    // manager open (the page window is not counted as another window keeping the app up).
    expect(await f.browser.requestWindowClose(browserWin)).toBe(true)
    expect(f.hostOf(browserWin).closed).toBe(1)
  })

  it('closes on its own close request without a warning: one chrome page, nothing to ask', async () => {
    const f = fixture()
    const browserWin = f.browserWindow()
    f.browser.state.settings.warnOnCloseWindow = true
    const tasks = f.browser.openTaskManager(browserWin)!
    expect(await f.browser.requestWindowClose(tasks)).toBe(true)
    expect(f.hostOf(tasks).closed).toBe(1)
    expect(f.hostOf(browserWin).closed).toBe(0)
  })

  it('finds the browser window behind it for what is the browser’s', () => {
    const f = fixture()
    const browserWin = f.browserWindow()
    const tasks = f.browser.openTaskManager(browserWin)!
    expect(f.browser.browserWindowFor(tasks)).toBe(browserWin)
    // The task manager is never "the focused window" a tab is opened in (a notification's
    // click, a PDF, a protocol handler): the browser window behind it is.
    expect(f.browser.focusedWindow()).toBe(browserWin)
  })

  it('runs only its own chords from its keyboard, and hands the browser’s actions to the browser window behind it', () => {
    const f = fixture()
    const browserWin = f.browserWindow()
    const tasks = f.browser.openTaskManager(browserWin)!
    const tasksHost = f.hostOf(tasks)
    const browserHost = f.hostOf(browserWin)
    const tabsBefore = Object.keys(f.browser.state.model.tabs).length
    // Shift+Esc in the task manager: the window itself, again in front; no second window.
    expect(f.browser.keys.handle(SHIFT_ESC, null, tasks)).toBe(true)
    expect(f.pageWindows()).toEqual([tasks])
    expect(tasksHost.focused).toBe(2)
    // Ctrl+T is not the task manager's: the key is left to the page, and no tab opens anywhere.
    expect(f.browser.keys.handle(CTRL_T, null, tasks)).toBe(false)
    expect(Object.keys(f.browser.state.model.tabs)).toHaveLength(tabsBefore)
    expect(f.browser.tabs.visibleTabIds(tasks)).toHaveLength(1)
    // An action asked with the task manager in front by other means (the menu bar's File › New
    // Tab) runs on the browser window behind it, brought to the front.
    f.browser.actions.run('tab.new', { sourceTabId: null, win: tasks })
    expect(Object.keys(f.browser.state.model.tabs)).toHaveLength(tabsBefore + 1)
    expect(f.browser.tabs.visibleTabIds(tasks)).toHaveLength(1)
    expect(f.browser.tabs.activeTabFor(browserWin)?.url).not.toBe(TASKS_URL)
    expect(browserHost.shown).toBe(1)
    expect(browserHost.focused).toBe(1)
    // Ctrl+Shift+W closes the task manager's window, not the browser's.
    expect(f.browser.keys.handle(CTRL_SHIFT_W, null, tasks)).toBe(true)
  })

  it('lets Ctrl+Shift+W close the task manager window alone', async () => {
    const f = fixture()
    const browserWin = f.browserWindow()
    const tasks = f.browser.openTaskManager(browserWin)!
    f.browser.keys.handle(CTRL_SHIFT_W, null, tasks)
    await new Promise((r) => setTimeout(r, 0))
    expect(f.hostOf(tasks).closed).toBe(1)
    expect(f.hostOf(browserWin).closed).toBe(0)
  })

  it('closes with its page: the tab closed under it takes the window (no strip to open another from)', async () => {
    const f = fixture()
    const browserWin = f.browserWindow()
    const tasks = f.browser.openTaskManager(browserWin)!
    const tab = f.browser.tabs.activeTabFor(tasks)!
    f.browser.tabs.closeTab(tab.id)
    await new Promise((r) => setTimeout(r, 0))
    expect(f.hostOf(tasks).closed).toBe(1)
  })
})
