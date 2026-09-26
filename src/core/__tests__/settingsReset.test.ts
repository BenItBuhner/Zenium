import { describe, expect, it } from 'vitest'
import type { ExtensionInfo, HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/defaults'
import { DEFAULT_NEW_TAB_SETTINGS } from '../../shared/newTab'
import { Browser } from '../browser'
import { NoExtensions } from '../hostDefaults'
import type {
  AppHost,
  ExtensionHost,
  Platform,
  SessionHost,
  StoreIO,
  TabView,
  TabViewHost,
  WindowHost
} from '../platform'
import { SETTINGS_RESET_DATA, planSettingsReset, settingsResetPlan } from '../settingsReset'
import type { ZenWindow } from '../window'

/*
 * Settings › Reset settings › "Restore settings to their original defaults" (W7-6, settings-70):
 * the plan is the sentence's six clauses read off the state, and the run does what the
 * sentence says through the services that own each setting – startup pages, new tab page,
 * search engine (and the EEA's choice screen owed again), pinned tabs, extensions, cookies and
 * cache – and nothing to the bookmarks, the history or the passwords.
 */

describe('planSettingsReset', () => {
  const settings = {
    startup: { mode: 'pages' as const, pages: ['https://news.example/'] },
    searchEngineId: 'duckduckgo',
    searchChoice: { engineId: 'duckduckgo', region: 'DE', madeAt: 1, version: 1 }
  }

  it('answers every clause in the sentence’s order, reading the state for the tabs and extensions', () => {
    const plan = planSettingsReset({
      settings,
      tabs: [
        { id: 'a', pinned: true, essential: false },
        { id: 'b', pinned: false, essential: false },
        { id: 'c', pinned: true, essential: true },
        { id: 'd', pinned: true, essential: false }
      ],
      extensions: [
        { id: 'on', enabled: true },
        { id: 'off', enabled: false },
        { id: 'on-too', enabled: true }
      ],
      eea: false
    })
    expect(plan).toEqual([
      { kind: 'startup', patch: { startup: { mode: 'continue', pages: [] } } },
      { kind: 'newTab' },
      {
        kind: 'searchEngine',
        patch: { searchEngineId: 'google', searchChoice: null },
        reAsk: false
      },
      // Zen's Essentials are not Chrome's pinned tabs: `c` stays.
      { kind: 'unpin', tabIds: ['a', 'd'] },
      // Disabled ones are left as they are; every enabled one goes off.
      { kind: 'disableExtensions', ids: ['on', 'on-too'] },
      { kind: 'clearData', types: ['cookies', 'cache'] }
    ])
    expect(SETTINGS_RESET_DATA).toEqual(['cookies', 'cache'])
    // The default startup model is copied, not shared, so a later mutation cannot reach the constant.
    const startup = plan[0]
    if (startup.kind !== 'startup') throw new Error('not the startup step')
    expect(startup.patch.startup).not.toBe(DEFAULT_SETTINGS.startup)
  })

  it('owes the EEA’s choice screen again once the record goes, and stands with empty steps elsewhere', () => {
    const plan = planSettingsReset({ settings, tabs: [], extensions: [], eea: true })
    expect(plan[2]).toEqual({
      kind: 'searchEngine',
      patch: { searchEngineId: 'google', searchChoice: null },
      reAsk: true
    })
    // Nothing pinned, nothing enabled: the clauses still stand, empty, so the plan reads whole.
    expect(plan[3]).toEqual({ kind: 'unpin', tabIds: [] })
    expect(plan[4]).toEqual({ kind: 'disableExtensions', ids: [] })
    expect(plan).toHaveLength(6)
  })
})

/* ---- the browser: `settings.reset` over the services ---- */

function memoryIo(files: Record<string, string> = {}): StoreIO & { files: Record<string, string> } {
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

function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

function extension(id: string, enabled: boolean): ExtensionInfo {
  return { id, name: id, enabled } as unknown as ExtensionInfo
}

/**
 * An extension host with three installed, two enabled, that records what the reset asks of it:
 * the host that does nothing (`NoExtensions`) with a list and a `setEnabled` of its own.
 */
interface FakeExtensions {
  host: ExtensionHost
  infos: ExtensionInfo[]
  calls: Array<[string, boolean]>
}

function fakeExtensions(browser: Browser): FakeExtensions {
  const infos = [extension('reader', true), extension('dark', false), extension('notes', true)]
  const calls: Array<[string, boolean]> = []
  const host: ExtensionHost = Object.create(new NoExtensions(browser))
  host.list = () => infos
  host.setEnabled = async (id, enabled) => {
    calls.push([id, enabled])
    const info = infos.find((e) => e.id === id)
    if (info) info.enabled = enabled
  }
  return { host, infos, calls }
}

interface Harness {
  browser: Browser
  win: ZenWindow
  io: ReturnType<typeof memoryIo>
  extensions: FakeExtensions
  /** What the engine was asked to clear: the containers and the kinds, per call. */
  cleared: Array<{ containers: string[]; kinds: string[] }>
}

function setup(region: string | null | undefined, files: Record<string, string> = {}): Harness {
  const io = memoryIo(files)
  const cleared: Harness['cleared'] = []
  let extensions: FakeExtensions | null = null
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0', region },
    capabilities: stub<HostCapabilities>({ windows: false, updates: false, agents: false }),
    io,
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
      createView: () => stub<TabView>({ isDestroyed: () => false, isVisible: () => false })
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub<SessionHost>({
      clearBrowsingData: async (containers, kinds) => {
        cleared.push({ containers: [...containers], kinds: [...kinds] })
      }
    }),
    app: stub<AppHost>(),
    readabilitySource: () => null,
    createExtensions: (browser) => {
      extensions = fakeExtensions(browser)
      return extensions.host
    }
  }
  const browser = new Browser(platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  if (!extensions) throw new Error('no extension host')
  return { browser, win, io, extensions, cleared }
}

/**
 * A profile with everything the sentence names moved off its default: a startup page, a
 * non-default engine, a custom new tab page with a shortcut, a pinned tab beside an Essential,
 * and – what the sentence promises to keep – a bookmark and a history visit.
 */
function customised(h: Harness): { pinned: string; essential: string } {
  const { browser, win } = h
  browser.handleCommand(win, 'settings.update', {
    startup: { mode: 'pages', pages: ['https://news.example/'] },
    searchEngineId: 'duckduckgo',
    newTab: { ...DEFAULT_NEW_TAB_SETTINGS, enabled: false, preset: 'custom', background: 'none' }
  })
  browser.handleCommand(win, 'newtab.addShortcut', { title: 'News', url: 'https://news.example/' })
  const pinned = browser.tabs.createTab({ url: 'https://pinned.example/', active: false }, win)
  browser.tabs.togglePin(pinned.id, win)
  const essential = browser.tabs.createTab(
    { url: 'https://essential.example/', active: false },
    win
  )
  browser.tabs.toggleEssential(essential.id, win)
  browser.bookmarks.create({ title: 'Kept', url: 'https://kept.example/' })
  browser.history.visit('https://visited.example/', 'Visited', null)
  return { pinned: pinned.id, essential: essential.id }
}

describe('settings.reset', () => {
  it('puts back what the sentence names through the services, and leaves what it promises to keep', async () => {
    const h = setup('us')
    const { browser, win, io, extensions, cleared } = h
    const { pinned, essential } = customised(h)
    expect(browser.state.settings.startup).toEqual({
      mode: 'pages',
      pages: ['https://news.example/']
    })
    expect(browser.state.settings.searchEngineId).toBe('duckduckgo')
    expect(browser.state.settings.newTab.preset).toBe('custom')
    expect(browser.state.newTabDevice.shortcuts).toHaveLength(1)
    expect(browser.tabs.tab(pinned)!.pinned).toBe(true)
    expect(browser.tabs.tab(essential)!.essential).toBe(true)

    // The plan as the state stands, before the run: the pinned tab and the two enabled extensions.
    expect(settingsResetPlan(browser)).toMatchObject([
      { kind: 'startup' },
      { kind: 'newTab' },
      { kind: 'searchEngine', reAsk: false },
      { kind: 'unpin', tabIds: [pinned] },
      { kind: 'disableExtensions', ids: ['reader', 'notes'] },
      { kind: 'clearData', types: ['cookies', 'cache'] }
    ])

    await browser.handleCommand(win, 'settings.reset', undefined)

    const settings = browser.state.settings
    expect(settings.startup).toEqual(DEFAULT_SETTINGS.startup)
    expect(settings.searchEngineId).toBe(DEFAULT_SETTINGS.searchEngineId)
    expect(settings.searchChoice).toBeNull()
    // The new tab page back to its defaults; whether a new tab opens it at all stays as it was.
    expect(settings.newTab).toEqual({ ...DEFAULT_NEW_TAB_SETTINGS, enabled: false })
    expect(browser.state.newTabDevice.shortcuts).toEqual([])
    // The pinned tab is a regular tab again, open still; the Essential stays an Essential.
    expect(browser.tabs.tab(pinned)).toMatchObject({ pinned: false })
    expect(browser.tabs.tab(essential)).toMatchObject({ essential: true })
    // Every enabled extension disabled, the disabled one not asked about; none removed.
    expect(extensions.calls).toEqual([
      ['reader', false],
      ['notes', false]
    ])
    expect(extensions.host.list().map((e) => [e.id, e.enabled])).toEqual([
      ['reader', false],
      ['dark', false],
      ['notes', false]
    ])
    // Cookies, site data and the cache of every container, through the existing clear-data engine.
    expect(cleared).toHaveLength(1)
    expect(cleared[0].kinds).toEqual(['cookies', 'storage', 'cache'])
    expect(cleared[0].containers.length).toBeGreaterThan(0)
    // Bookmarks and history are not touched.
    expect(browser.bookmarks.all().map((b) => b.url)).toContain('https://kept.example/')
    expect(browser.history.recent(10).map((e) => e.url)).toContain('https://visited.example/')
    // The defaults are on disk.
    await browser.state.flush()
    const persisted = JSON.parse(io.files['state.json']).settings
    expect(persisted.startup).toEqual(DEFAULT_SETTINGS.startup)
    expect(persisted.searchEngineId).toBe('google')
    // No choice screen is owed outside the EEA.
    expect(browser.state.snapshot(win).searchChoice.required).toBe(false)
  })

  it('in the EEA clears the choice record and owes the screen at the next run, not over the Settings page', async () => {
    const h = setup('de')
    const { browser, win, io } = h
    browser.handleCommand(win, 'searchChoice.choose', { engineId: 'duckduckgo' })
    expect(browser.state.settings.searchEngineId).toBe('duckduckgo')
    expect(browser.state.settings.searchChoice).toMatchObject({ engineId: 'duckduckgo' })
    expect(browser.state.snapshot(win).searchChoice.required).toBe(false)

    expect(settingsResetPlan(browser)[2]).toMatchObject({ kind: 'searchEngine', reAsk: true })
    await browser.handleCommand(win, 'settings.reset', undefined)

    expect(browser.state.settings.searchEngineId).toBe('google')
    expect(browser.state.settings.searchChoice).toBeNull()
    // This run: the screen does not cover the page the reset was asked from (a skip's reading).
    expect(browser.state.searchChoiceSession.skipped).toBe(true)
    expect(browser.state.snapshot(win).searchChoice.required).toBe(false)
    // The next run, from the same disk: the record is gone, so the screen is owed again.
    await browser.state.flush()
    const next = setup('de', { ...io.files })
    expect(next.browser.state.settings.searchChoice).toBeNull()
    expect(next.browser.state.snapshot(next.win).searchChoice.required).toBe(true)
  })
})
