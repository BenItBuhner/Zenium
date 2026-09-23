import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  HostCapabilities,
  NavigationSnapshot,
  Platform as PlatformOs,
  Tab
} from '../../shared/types'
import { INACTIVE_TAB_AUTO_CLOSE_DAYS } from '../../shared/defaults'
import { Browser } from '../browser'
import {
  DAY_MS,
  INACTIVE_TABS_FIRST_PASS_DELAY_MS,
  INACTIVE_TABS_MAX_PER_PASS,
  sanitizeArchiveDays
} from '../inactiveTabs'
import { NAVIGATION_STATE_INDEX, navigationDocumentName } from '../navigationState'
import type { AppHost, Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import type { ZenWindow } from '../window'

/** A profile folder in memory; without `remove`, so a removed document is the tombstone `{}`. */
function memoryIo(): StoreIO & { files: Record<string, string> } {
  const files: Record<string, string> = {}
  return {
    files,
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

/** What the fake host records and what it is told to report. */
interface FakeHost {
  live: Set<string>
  sent: Array<[string, string]>
  /** Each `restoreNavigation`: the tab and the URLs of the stack replayed. */
  restores: Array<[string, string[]]>
  /** Each `restoreNavigation`'s host-state blob (the WebView bundle), by tab. */
  restoredHostState: Map<string, string | undefined>
  /** A page's saved-state bundle, reported with its stack (`navigationEntries`) once set here. */
  blobs: Map<string, string>
}

/** The Android shape: one window, private tabs, the archive; pages that only record being alive. */
function fakePlatform(io: StoreIO, inactiveTabs = true): Platform & FakeHost {
  const live = new Set<string>()
  const sent: Array<[string, string]> = []
  const restores: Array<[string, string[]]> = []
  const restoredHostState = new Map<string, string | undefined>()
  const blobs = new Map<string, string>()
  const capabilities = stub<HostCapabilities>({
    windows: false,
    updates: false,
    agents: false,
    resourceGovernor: false,
    pageControls: true,
    darkenSites: true,
    privateTabs: true,
    inactiveTabs
  })
  return {
    live,
    sent,
    restores,
    restoredHostState,
    blobs,
    info: { os: 'android' as PlatformOs, version: '0.0.0' },
    capabilities,
    io,
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 412, height: 915 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          send: (channel: string) => {
            sent.push(['event', channel])
          }
        })
    },
    views: stub<TabViewHost>({
      createView: (tab) => {
        live.add(tab.id)
        let destroyed = false
        return stub<TabView>({
          isDestroyed: () => destroyed,
          destroy: () => {
            destroyed = true
            live.delete(tab.id)
          },
          getZoom: () => 1,
          getURL: () => tab.url,
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          restoreNavigation: async (snapshot: NavigationSnapshot) => {
            restores.push([tab.id, snapshot.entries.map((e) => e.url)])
            restoredHostState.set(tab.id, snapshot.hostState)
          },
          // A page that came from somewhere: a two-entry stack (with the host's bundle when the
          // test gave the page one); a blank tab has only itself.
          navigationEntries: (): NavigationSnapshot => {
            if (tab.url.startsWith('zen://'))
              return { entries: [{ url: tab.url, title: '' }], index: 0 }
            const snapshot: NavigationSnapshot = {
              entries: [
                { url: 'https://example.com/start', title: 'Start' },
                { url: tab.url, title: tab.title }
              ],
              index: 1
            }
            const blob = blobs.get(tab.id)
            if (blob !== undefined) snapshot.hostState = blob
            return snapshot
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
    app: stub<AppHost>()
  } as unknown as Platform & FakeHost
}

const T0 = new Date('2026-09-19T12:00:00Z').getTime()

function start(
  io = memoryIo(),
  inactiveTabs = true
): { browser: Browser; platform: ReturnType<typeof fakePlatform>; win: ZenWindow; io: StoreIO } {
  const platform = fakePlatform(io, inactiveTabs)
  const browser = new Browser(platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  return { browser, platform, win, io }
}

/** A regular tab last looked at `daysAgo` days before T0. */
function idleTab(browser: Browser, win: ZenWindow, url: string, daysAgo: number): Tab {
  const tab = browser.tabs.createTab({ url, active: false }, win)
  tab.lastActiveAt = T0 - daysAgo * DAY_MS
  return tab
}

function archivedUrls(browser: Browser): string[] {
  return browser.inactiveTabs.list().map((s) => s.url)
}

function gridUrls(browser: Browser, win: ZenWindow): string[] {
  const space = win.activeSpace()
  return space.tabIds.map((id) => browser.tabs.tab(id)!.url)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the inactive tabs archive (TAB-20)', () => {
  it('moves tabs idle past the threshold out of the grid, the most recently used first', () => {
    const { browser, platform, win } = start()
    const shown = browser.tabs.createTab({ url: 'https://shown.example/', active: true }, win)
    const fresh = idleTab(browser, win, 'https://fresh.example/', 20)
    const old = idleTab(browser, win, 'https://old.example/', 22)
    const older = idleTab(browser, win, 'https://older.example/', 30)
    browser.tabs.load(old.id, win)
    expect(platform.live.has(old.id)).toBe(true)

    const result = browser.handleCommand(win, 'inactiveTabs.runPasses', {})
    expect(result).toEqual({ archived: 2, closed: 0 })
    expect(archivedUrls(browser)).toEqual(['https://old.example/', 'https://older.example/'])
    expect(gridUrls(browser, win)).toEqual(['https://shown.example/', 'https://fresh.example/'])
    // The archived page's document is gone, as a sleeping tab's is; the tab is not a tab any more.
    expect(platform.live.has(old.id)).toBe(false)
    expect(browser.tabs.tab(old.id)).toBeUndefined()
    expect(browser.tabs.tab(older.id)).toBeUndefined()
    expect(browser.tabs.tab(shown.id)).toBeDefined()
    expect(browser.tabs.tab(fresh.id)).toBeDefined()
    // The switcher's row reads the count from the snapshot; the list surface hears the event.
    expect(browser.state.snapshot(win).archivedTabCount).toBe(2)
    expect(platform.sent).toContainEqual(['event', 'inactiveTabs.changed'])
    // Not "Recently closed": archiving is not closing.
    expect(browser.session.summaries()).toEqual([])

    const [entry] = browser.inactiveTabs.list()
    expect(entry).toMatchObject({
      url: 'https://old.example/',
      lastActiveAt: T0 - 22 * DAY_MS,
      archivedAt: T0
    })
  })

  it('reads the clock it is given, so a threshold is crossed without a wait', () => {
    const { browser, win } = start()
    browser.tabs.createTab({ url: 'https://shown.example/', active: true }, win)
    const tab = idleTab(browser, win, 'https://a.example/', 0)
    expect(browser.inactiveTabs.runPasses(T0 + 20 * DAY_MS)).toEqual({ archived: 0, closed: 0 })
    expect(browser.inactiveTabs.runPasses(T0 + 21 * DAY_MS)).toEqual({ archived: 1, closed: 0 })
    expect(browser.tabs.tab(tab.id)).toBeUndefined()
  })

  it('follows the threshold setting: 7, 14, 21 days or Never', () => {
    const { browser, win } = start()
    browser.tabs.createTab({ url: 'https://shown.example/', active: true }, win)
    idleTab(browser, win, 'https://eight.example/', 8)
    idleTab(browser, win, 'https://fifteen.example/', 15)
    browser.handleCommand(win, 'settings.update', { inactiveTabsArchiveDays: 0 })
    expect(browser.inactiveTabs.runPasses()).toEqual({ archived: 0, closed: 0 })
    browser.handleCommand(win, 'settings.update', { inactiveTabsArchiveDays: 14 })
    // Before the startup pass a change waits for it (a value synced in during boot): nothing
    // moves until the first pass, which takes the 15-day tab and leaves the 8-day one.
    expect(archivedUrls(browser)).toEqual([])
    vi.advanceTimersByTime(INACTIVE_TABS_FIRST_PASS_DELAY_MS)
    expect(archivedUrls(browser)).toEqual(['https://fifteen.example/'])
    // Once the startup pass has run, a change applies at once: at 7 the 8-day tab goes too.
    browser.handleCommand(win, 'settings.update', { inactiveTabsArchiveDays: 7 })
    expect(archivedUrls(browser)).toEqual(['https://eight.example/', 'https://fifteen.example/'])
  })

  it('leaves the shown tab, pinned tabs, Essentials, private tabs, grouped and heard tabs alone', () => {
    const { browser, win } = start()
    const shown = browser.tabs.createTab({ url: 'https://shown.example/', active: true }, win)
    shown.lastActiveAt = T0 - 40 * DAY_MS
    const pinned = idleTab(browser, win, 'https://pinned.example/', 40)
    browser.tabs.togglePin(pinned.id, win)
    expect(pinned.pinned).toBe(true)
    const essential = idleTab(browser, win, 'https://essential.example/', 40)
    browser.tabs.toggleEssential(essential.id, win)
    expect(essential.essential).toBe(true)
    const grouped = idleTab(browser, win, 'https://grouped.example/', 40)
    const folder = browser.createFolder(win.activeSpace().id, 'Group', '', win, { rename: false })
    browser.tabs.moveToFolder(grouped.id, folder.id)
    expect(browser.tabs.tab(grouped.id)!.folderId).toBe(folder.id)
    const privateId = browser.tabs.newPrivateTab('https://private.example/', win)!
    browser.tabs.tab(privateId)!.lastActiveAt = T0 - 40 * DAY_MS
    const heard = idleTab(browser, win, 'https://heard.example/', 40)
    heard.audible = true
    const blank = idleTab(browser, win, 'zen://newtab', 40)
    browser.tabs.activateTab(shown.id, win)
    shown.lastActiveAt = T0 - 40 * DAY_MS

    browser.inactiveTabs.runPasses()
    expect(archivedUrls(browser)).toEqual([])
    for (const id of [shown.id, pinned.id, essential.id, grouped.id, privateId, heard.id])
      expect(browser.tabs.tab(id), id).toBeDefined()
    // A never-visited blank tab has nothing to archive: it is simply closed.
    expect(browser.tabs.tab(blank.id)).toBeUndefined()
    expect(browser.inactiveTabs.list()).toEqual([])
  })

  it('archives at most 150 tabs in one pass, the longest unused first', () => {
    const { browser, win } = start()
    browser.tabs.createTab({ url: 'https://shown.example/', active: true }, win)
    for (let i = 0; i < INACTIVE_TABS_MAX_PER_PASS + 5; i++)
      idleTab(browser, win, `https://t${i}.example/`, 22 + i)
    expect(browser.inactiveTabs.runPasses().archived).toBe(INACTIVE_TABS_MAX_PER_PASS)
    // The five most recently used (22…26 days) are the ones still in the grid.
    expect(gridUrls(browser, win).slice(1)).toEqual([
      'https://t0.example/',
      'https://t1.example/',
      'https://t2.example/',
      'https://t3.example/',
      'https://t4.example/'
    ])
    expect(browser.inactiveTabs.runPasses().archived).toBe(5)
  })

  it('restores a tab to the start of the grid, to the front, its stack and last use with it', () => {
    const { browser, platform, win } = start()
    const shown = browser.tabs.createTab({ url: 'https://shown.example/', active: true }, win)
    const old = idleTab(browser, win, 'https://old.example/', 22)
    browser.tabs.load(old.id, win)
    browser.inactiveTabs.runPasses()
    const [entry] = browser.inactiveTabs.list()

    vi.setSystemTime(new Date(T0 + DAY_MS))
    browser.handleCommand(win, 'inactiveTabs.restore', { id: entry.id })
    expect(browser.inactiveTabs.list()).toEqual([])
    expect(browser.state.snapshot(win).archivedTabCount).toBe(0)
    expect(gridUrls(browser, win)).toEqual(['https://old.example/', 'https://shown.example/'])
    const restored = browser.tabs.tab(old.id)!
    expect(win.selectedTabIn(win.activeSpace())).toBe(restored.id)
    expect(restored.lastActiveAt).toBe(T0 + DAY_MS)
    expect(browser.tabs.tab(shown.id)).toBeDefined()
    // The page comes back with its back/forward stack: the restore replays the closed stack.
    expect(platform.live.has(restored.id)).toBe(true)
    expect(platform.restores).toEqual([
      [restored.id, ['https://example.com/start', 'https://old.example/']]
    ])
    // Now it has been used: the next pass leaves it alone.
    expect(browser.inactiveTabs.runPasses(T0 + DAY_MS).archived).toBe(0)
  })

  it('restores all in the list’s order without changing the shown tab', () => {
    const { browser, win } = start()
    const shown = browser.tabs.createTab({ url: 'https://shown.example/', active: true }, win)
    idleTab(browser, win, 'https://a.example/', 22)
    idleTab(browser, win, 'https://b.example/', 23)
    idleTab(browser, win, 'https://c.example/', 24)
    browser.inactiveTabs.runPasses()
    expect(archivedUrls(browser)).toEqual([
      'https://a.example/',
      'https://b.example/',
      'https://c.example/'
    ])
    browser.handleCommand(win, 'inactiveTabs.restoreAll', undefined)
    expect(browser.inactiveTabs.list()).toEqual([])
    expect(gridUrls(browser, win)).toEqual([
      'https://a.example/',
      'https://b.example/',
      'https://c.example/',
      'https://shown.example/'
    ])
    expect(win.selectedTabIn(win.activeSpace())).toBe(shown.id)
    expect(browser.inactiveTabs.runPasses().archived).toBe(0)
  })

  it('closes one archived tab into "Recently closed" and all of them for good', () => {
    const { browser, win } = start()
    browser.tabs.createTab({ url: 'https://shown.example/', active: true }, win)
    idleTab(browser, win, 'https://a.example/', 22)
    idleTab(browser, win, 'https://b.example/', 23)
    idleTab(browser, win, 'https://c.example/', 24)
    browser.inactiveTabs.runPasses()
    const [a] = browser.inactiveTabs.list()
    browser.handleCommand(win, 'inactiveTabs.close', { id: a.id })
    expect(archivedUrls(browser)).toEqual(['https://b.example/', 'https://c.example/'])
    expect(browser.session.summaries().map((s) => s.url)).toEqual(['https://a.example/'])

    browser.handleCommand(win, 'inactiveTabs.closeAll', undefined)
    expect(browser.inactiveTabs.list()).toEqual([])
    expect(browser.state.snapshot(win).archivedTabCount).toBe(0)
    expect(browser.session.summaries().map((s) => s.url)).toEqual(['https://a.example/'])
    expect(gridUrls(browser, win)).toEqual(['https://shown.example/'])
  })

  it('leaves an ordinary close on its way to "Recently closed" after a pass: the archive’s divert is the pass’s alone', async () => {
    const { browser, win } = start()
    browser.tabs.createTab({ url: 'https://shown.example/', active: true }, win)
    const kept = idleTab(browser, win, 'https://kept.example/', 5)
    idleTab(browser, win, 'https://old.example/', 22)
    expect(browser.inactiveTabs.runPasses()).toEqual({ archived: 1, closed: 0 })
    expect(archivedUrls(browser)).toEqual(['https://old.example/'])
    expect(browser.session.summaries()).toEqual([])

    // The user closes a tab the pass left in the grid (`tab.close`, the switcher's X): its entry
    // is the undo list's, not the archive's – `archiveTab` hands the close's entry to the pass
    // for that one close only.
    await expect(browser.tabs.requestClose(kept.id, false, win)).resolves.toBe(true)
    expect(browser.tabs.tab(kept.id)).toBeUndefined()
    expect(browser.session.summaries().map((s) => s.url)).toEqual(['https://kept.example/'])
    expect(archivedUrls(browser)).toEqual(['https://old.example/'])
  })

  it('closes archived tabs 90 days after archiving when the switch is on, by archive time', () => {
    const { browser, win } = start()
    browser.tabs.createTab({ url: 'https://shown.example/', active: true }, win)
    idleTab(browser, win, 'https://a.example/', 22)
    browser.inactiveTabs.runPasses()
    idleTab(browser, win, 'https://b.example/', 22)
    browser.inactiveTabs.runPasses(T0 + 10 * DAY_MS)
    expect(archivedUrls(browser)).toEqual(['https://b.example/', 'https://a.example/'])
    const limit = INACTIVE_TAB_AUTO_CLOSE_DAYS * DAY_MS
    // A day short: nothing goes, however long ago the tabs were last used.
    expect(browser.inactiveTabs.runPasses(T0 + limit - DAY_MS)).toEqual({ archived: 0, closed: 0 })
    // The first's 90 days are up; the second's are not (archived ten days later).
    expect(browser.inactiveTabs.runPasses(T0 + limit)).toEqual({ archived: 0, closed: 1 })
    expect(archivedUrls(browser)).toEqual(['https://b.example/'])
    // Off: the archive keeps its tabs however long.
    browser.handleCommand(win, 'settings.update', { inactiveTabsAutoClose: false })
    expect(browser.inactiveTabs.runPasses(T0 + 400 * DAY_MS)).toEqual({ archived: 0, closed: 0 })
    expect(archivedUrls(browser)).toEqual(['https://b.example/'])
    browser.handleCommand(win, 'settings.update', { inactiveTabsAutoClose: true })
    expect(browser.inactiveTabs.runPasses(T0 + 400 * DAY_MS)).toEqual({ archived: 0, closed: 1 })
    expect(browser.inactiveTabs.list()).toEqual([])
    expect(browser.session.summaries()).toEqual([])
  })

  it('brings every archived tab back when the threshold becomes Never', () => {
    const { browser, win } = start()
    const shown = browser.tabs.createTab({ url: 'https://shown.example/', active: true }, win)
    idleTab(browser, win, 'https://a.example/', 22)
    idleTab(browser, win, 'https://b.example/', 23)
    browser.inactiveTabs.runPasses()
    expect(gridUrls(browser, win)).toEqual(['https://shown.example/'])
    browser.handleCommand(win, 'settings.update', { inactiveTabsArchiveDays: 0 })
    expect(browser.inactiveTabs.list()).toEqual([])
    expect(gridUrls(browser, win).sort()).toEqual([
      'https://a.example/',
      'https://b.example/',
      'https://shown.example/'
    ])
    expect(win.selectedTabIn(win.activeSpace())).toBe(shown.id)
  })

  it('keeps the archive across a restart, the tabs’ places and stacks with it', () => {
    const io = memoryIo()
    const first = start(io)
    first.browser.tabs.createTab({ url: 'https://shown.example/', active: true }, first.win)
    const old = idleTab(first.browser, first.win, 'https://old.example/', 22)
    old.title = 'Old page'
    first.browser.tabs.load(old.id, first.win)
    first.browser.inactiveTabs.runPasses()
    first.browser.state.flushSync()

    const second = start(io)
    expect(second.browser.state.snapshot(second.win).archivedTabCount).toBe(1)
    const [entry] = second.browser.inactiveTabs.list()
    expect(entry).toMatchObject({
      title: 'Old page',
      url: 'https://old.example/',
      lastActiveAt: T0 - 22 * DAY_MS,
      archivedAt: T0
    })
    second.browser.inactiveTabs.restore(entry.id, second.win)
    expect(gridUrls(second.browser, second.win)).toEqual([
      'https://old.example/',
      'https://shown.example/'
    ])
    expect(second.platform.restores).toEqual([
      [old.id, ['https://example.com/start', 'https://old.example/']]
    ])
  })

  it('keeps an archived page’s host state across a restart: its document outlives the sweep and the restore replays it', async () => {
    const io = memoryIo()
    const first = start(io)
    first.browser.tabs.createTab({ url: 'https://shown.example/', active: true }, first.win)
    const old = idleTab(first.browser, first.win, 'https://old.example/', 22)
    // The page's saved-state bundle (a WebView's `saveState`, base64 on the host): the one part
    // of a stack that lives in `navigation/<tabId>.json` and never in `state.json`.
    const BLOB = 'YnVuZGxlOnNjcm9sbCwgZm9ybSBzdGF0ZSwgaGlzdG9yeQ=='
    first.platform.blobs.set(old.id, BLOB)
    first.browser.tabs.load(old.id, first.win)
    first.browser.tabs.rememberNavigation(old.id)
    await first.browser.state.navigationState.flush()
    const document = navigationDocumentName(old.id)
    const written = (): unknown => JSON.parse(io.files[document] ?? 'null')
    expect(written()).toMatchObject({ version: 1, hostState: BLOB })

    // Archived: the tab is no tab any more, and the store asks what its document is to hold now
    // – the archive entry's stack, so the document stays (a document no entry speaks for goes).
    expect(first.browser.inactiveTabs.runPasses()).toEqual({ archived: 1, closed: 0 })
    await first.browser.state.navigationState.flush()
    expect(written()).toMatchObject({ version: 1, hostState: BLOB })
    first.browser.state.flushSync()
    expect(io.files['state.json']).not.toContain(BLOB)

    // A document the index lists for a tab nothing refers to any more: the next run's sweep.
    io.files[navigationDocumentName('tab_stray')] = JSON.stringify({
      version: 1,
      list: '0',
      hostState: 'stray'
    })
    io.files[NAVIGATION_STATE_INDEX] = JSON.stringify({ version: 1, ids: [old.id, 'tab_stray'] })

    const second = start(io)
    await second.browser.state.navigationState.flush()
    // The sweep takes the stray (the tombstone: this host has no `remove`) and leaves the
    // archived tab's alone – `state.json` refers to it through the archive.
    expect(io.files[navigationDocumentName('tab_stray')]).toBe('{}')
    expect(written()).toMatchObject({ version: 1, hostState: BLOB })

    const [entry] = second.browser.inactiveTabs.list()
    second.browser.inactiveTabs.restore(entry.id, second.win)
    // The restore replays the stack with the bundle read back from the document, that being the
    // very list it describes.
    expect(second.platform.restores).toEqual([
      [old.id, ['https://example.com/start', 'https://old.example/']]
    ])
    expect(second.platform.restoredHostState.get(old.id)).toBe(BLOB)
  })

  it('runs its first pass off the boot path and never on a host without the archive', () => {
    const { browser, win } = start()
    browser.tabs.createTab({ url: 'https://shown.example/', active: true }, win)
    idleTab(browser, win, 'https://old.example/', 22)
    expect(browser.inactiveTabs.list()).toEqual([])
    vi.advanceTimersByTime(INACTIVE_TABS_FIRST_PASS_DELAY_MS - 1)
    expect(browser.inactiveTabs.list()).toEqual([])
    vi.advanceTimersByTime(1)
    expect(archivedUrls(browser)).toEqual(['https://old.example/'])

    const desktop = start(memoryIo(), false)
    desktop.browser.tabs.createTab({ url: 'https://shown.example/', active: true }, desktop.win)
    const tab = idleTab(desktop.browser, desktop.win, 'https://old.example/', 22)
    vi.advanceTimersByTime(INACTIVE_TABS_FIRST_PASS_DELAY_MS)
    expect(desktop.browser.inactiveTabs.runPasses()).toEqual({ archived: 0, closed: 0 })
    expect(desktop.browser.tabs.tab(tab.id)).toBeDefined()
  })

  it('sanitizes the settings', () => {
    expect(sanitizeArchiveDays(7)).toBe(7)
    expect(sanitizeArchiveDays(0)).toBe(0)
    expect(sanitizeArchiveDays(9)).toBe(21)
    expect(sanitizeArchiveDays('14')).toBe(21)
    const { browser, win } = start()
    browser.handleCommand(win, 'settings.update', { inactiveTabsArchiveDays: 3 })
    expect(browser.state.settings.inactiveTabsArchiveDays).toBe(21)
    browser.handleCommand(win, 'settings.update', { inactiveTabsArchiveDays: 14 })
    expect(browser.state.settings.inactiveTabsArchiveDays).toBe(14)
  })
})
