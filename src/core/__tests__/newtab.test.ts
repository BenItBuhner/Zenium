import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  HostCapabilities,
  NewTabPageState,
  Platform as PlatformOs,
  Tab
} from '../../shared/types'
import { PRIVATE_CONTAINER_ID } from '../../shared/types'
import { NEW_TAB_URL, SETTINGS_URL } from '../../shared/url'
import { Browser } from '../browser'
import { MAX_NEW_TAB_SHORTCUTS, normalizeShortcutInput } from '../newtab'
import type {
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'

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

interface Recorded {
  tabId: string
  readonly events: TabViewEvents
  readonly loads: string[]
  readonly pushes: NewTabPageState[]
  destroyed: boolean
  /** Whether the view is a child of a window (`createView` attaches; `detach` undoes it). */
  attached: boolean
}

interface Fixture {
  browser: Browser
  views: Recorded[]
  sent: Array<{ name: string; payload: unknown }>
  background: { current: string | null; picks: number }
}

function fixture(opts: { newTabPage?: boolean; withBackground?: boolean } = {}): Fixture {
  const views: Recorded[] = []
  const sent: Array<{ name: string; payload: unknown }> = []
  const background = { current: null as string | null, picks: 0 }
  const capabilities = stub<HostCapabilities>({
    windows: true,
    updates: false,
    agents: false,
    newTabPage: opts.newTabPage ?? true,
    // The desktop: Settings is its overlay, not a tab (the stub's default is a truthy function).
    pageTabs: false
  })
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities,
    io: memoryIo(),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          send: (name: string, payload: unknown) => {
            sent.push({ name, payload })
          },
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true
        })
    },
    views: stub<TabViewHost>({
      createView: (tab: Tab, events: TabViewEvents) => {
        const record: Recorded = {
          tabId: tab.id,
          events,
          loads: [],
          pushes: [],
          destroyed: false,
          attached: true
        }
        views.push(record)
        let url = ''
        return stub<TabView>({
          isDestroyed: () => record.destroyed,
          isVisible: () => false,
          attachTo: () => {
            record.attached = true
          },
          detach: () => {
            record.attached = false
          },
          hasDocument: () => url !== '',
          getURL: () => url,
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          loadURL: (u: string) => {
            url = u
            record.loads.push(u)
          },
          destroy: () => {
            record.destroyed = true
          },
          sendNewTabState: (state: NewTabPageState) => {
            record.pushes.push(state)
          }
        })
      },
      retargetView: (view: TabView, tabId: string) => {
        const record = views.find((v) => v.tabId === (view as unknown as { tabId?: string }).tabId)
        if (record) record.tabId = tabId
        // The stub view has no id of its own: the most recent placeholder is the one adopted.
        const placeholder = views.find((v) => v.tabId.startsWith('newtab_preload'))
        if (placeholder) placeholder.tabId = tabId
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
    newTabBackground: opts.withBackground
      ? {
          current: () => background.current,
          pick: async () => {
            background.picks += 1
            background.current = 'zen://newtab-background?v=1'
            return background.current
          },
          clear: async () => {
            background.current = null
          }
        }
      : undefined
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  return { browser, views, sent, background }
}

/** Let deferred state broadcasts (and `afterBroadcast` queues) run. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)
}

function eventsNamed(f: Fixture, name: string): unknown[] {
  return f.sent.filter((e) => e.name === name).map((e) => e.payload)
}

function activeTab(f: Fixture): Tab | undefined {
  const win = f.browser.focusedWindow()
  return f.browser.tabs.activeTabFor(win)
}

describe('NewTabService: opening', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('Ctrl+T creates an active tab at zen://newtab and tells the chrome once it holds the tab', async () => {
    const f = fixture()
    const before = Object.keys(f.browser.state.model.tabs).length
    f.browser.handleCommand(f.browser.focusedWindow(), 'newtab.open', undefined)
    const tab = activeTab(f)
    expect(tab?.url).toBe(NEW_TAB_URL)
    expect(tab?.title).toBe('New Tab')
    expect(Object.keys(f.browser.state.model.tabs)).toHaveLength(before + 1)
    // Not yet: the state broadcast that carries the tab goes out first.
    expect(eventsNamed(f, 'newtab.opened')).toEqual([])
    await settle()
    expect(eventsNamed(f, 'newtab.opened')).toEqual([{ tabId: tab?.id }])
    // The page loads through the view like any tab (no preload was ready yet).
    expect(f.views.some((v) => v.tabId === tab?.id && v.loads.includes(NEW_TAB_URL))).toBe(true)
  })

  it('with the page turned off only the URL bar opens, as before', async () => {
    const f = fixture()
    f.browser.state.settings.newTab.enabled = false
    const before = Object.keys(f.browser.state.model.tabs).length
    f.browser.handleCommand(f.browser.focusedWindow(), 'newtab.open', undefined)
    await settle()
    expect(Object.keys(f.browser.state.model.tabs)).toHaveLength(before)
    expect(eventsNamed(f, 'urlbar.toggle')).toEqual([{ mode: 'new-tab' }])
    expect(eventsNamed(f, 'newtab.opened')).toEqual([])
  })

  it('without the host capability the setting cannot turn the page on', async () => {
    const f = fixture({ newTabPage: false })
    expect(f.browser.newTab.enabled).toBe(false)
    expect(f.browser.newTab.homeUrl()).toBeNull()
    f.browser.handleCommand(f.browser.focusedWindow(), 'newtab.open', undefined)
    await settle()
    expect(eventsNamed(f, 'urlbar.toggle')).toEqual([{ mode: 'new-tab' }])
  })

  it('never records the page in history', async () => {
    const f = fixture()
    f.browser.handleCommand(f.browser.focusedWindow(), 'newtab.open', undefined)
    const tab = activeTab(f)
    const view = f.views.find((v) => v.tabId === tab?.id)
    view?.events.onNavigated(NEW_TAB_URL, false)
    view?.events.onTitleUpdated('New Tab')
    await settle()
    expect(f.browser.history.recent(10)).toEqual([])
    expect(f.browser.history.topSites(10)).toEqual([])
  })

  it('zen://settings typed into the URL bar opens the Settings overlay instead of a page', async () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const before = Object.keys(f.browser.state.model.tabs).length
    f.browser.handleCommand(win, 'urlbar.submit', {
      input: 'about:preferences',
      newTab: true,
      tabId: null,
      background: false
    })
    await settle()
    expect(Object.keys(f.browser.state.model.tabs)).toHaveLength(before)
    expect(eventsNamed(f, 'overlay.open')).toEqual([{ kind: 'settings' }])
    f.browser.handleCommand(win, 'newtab.open', undefined)
    const tab = activeTab(f)
    f.browser.tabs.navigate(tab!.id, SETTINGS_URL)
    expect(tab?.url).toBe(NEW_TAB_URL)
    expect(eventsNamed(f, 'overlay.open')).toHaveLength(2)
  })

  it('typing into the page navigates the same tab (plain submit over the new tab page)', async () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    f.browser.handleCommand(win, 'newtab.open', undefined)
    const tab = activeTab(f)
    const count = Object.keys(f.browser.state.model.tabs).length
    f.browser.handleCommand(win, 'urlbar.submit', {
      input: 'https://example.com',
      newTab: false,
      tabId: tab!.id,
      background: false
    })
    expect(Object.keys(f.browser.state.model.tabs)).toHaveLength(count)
    const view = f.views.find((v) => v.tabId === tab?.id)
    expect(view?.loads.at(-1)).toBe('https://example.com')
  })
})

describe('NewTabService: preloading', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('preloads one hidden page per window after the chrome is ready and adopts it on Ctrl+T', async () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    win.onChromeReady()
    await settle()
    expect(f.views.filter((v) => v.tabId.startsWith('newtab_preload'))).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(800)
    const preloads = f.views.filter((v) => v.tabId.startsWith('newtab_preload'))
    expect(preloads).toHaveLength(1)
    expect(preloads[0].loads).toEqual([NEW_TAB_URL])
    // It loads off the window: a document committing in a hidden child view would take focus.
    expect(preloads[0].attached).toBe(false)
    // It is not a tab.
    expect(Object.values(f.browser.state.model.tabs).some((t) => t.url === NEW_TAB_URL)).toBe(false)
    // The page gets its state pushed like a live one.
    await settle()
    expect(preloads[0].pushes.length).toBeGreaterThan(0)

    const created = f.views.length
    f.browser.handleCommand(win, 'newtab.open', undefined)
    const tab = activeTab(f)
    expect(tab?.url).toBe(NEW_TAB_URL)
    // Adopted: the preloaded view now answers for the tab and joins the window; no view was
    // created for it.
    expect(preloads[0].tabId).toBe(tab?.id)
    expect(preloads[0].attached).toBe(true)
    expect(f.browser.tabs.view(tab!.id)).toBeDefined()
    expect(f.views.filter((v) => v.tabId === tab?.id && v !== preloads[0])).toHaveLength(0)
    // Its host events now reach the tab.
    preloads[0].events.onTitleUpdated('New Tab')
    expect(f.browser.tabs.tab(tab!.id)?.title).toBe('New Tab')
    // And the next page is preloaded straight away.
    await settle()
    expect(f.views.length).toBe(created + 1)
    expect(f.views.at(-1)?.tabId.startsWith('newtab_preload')).toBe(true)
  })

  it('drops the preload when the page is turned off and when the window closes', async () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    win.onChromeReady()
    await vi.advanceTimersByTimeAsync(800)
    const preload = f.views.find((v) => v.tabId.startsWith('newtab_preload'))
    expect(preload).toBeDefined()
    f.browser.handleCommand(win, 'settings.update', { newTab: { enabled: false } })
    await settle()
    expect(preload?.destroyed).toBe(true)
    f.browser.handleCommand(win, 'settings.update', { newTab: { enabled: true } })
    await settle()
    const again = f.views.filter((v) => v.tabId.startsWith('newtab_preload') && !v.destroyed)
    expect(again).toHaveLength(1)
    f.browser.onWindowClosed(win)
    expect(again[0].destroyed).toBe(true)
  })

  it('a preload that crashes before adoption is replaced, never adopted', async () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    win.onChromeReady()
    await vi.advanceTimersByTimeAsync(800)
    const first = f.views.find((v) => v.tabId.startsWith('newtab_preload'))!
    first.events.onCrashed('crashed')
    expect(first.destroyed).toBe(true)
    await settle()
    const live = f.views.filter((v) => v.tabId.startsWith('newtab_preload') && !v.destroyed)
    expect(live).toHaveLength(1)
    expect(live[0]).not.toBe(first)
  })
})

describe('NewTabService: state for the page', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('carries both colour schemes of the space theme and the settings', async () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    f.browser.handleCommand(win, 'newtab.open', undefined)
    const tab = activeTab(f)!
    const state = f.browser.newTab.stateFor(tab.id)!
    expect(state.light.vars['--zen-bg']).toBeTruthy()
    expect(state.dark.vars['--zen-bg']).toBeTruthy()
    expect(state.light.isDark).toBe(false)
    expect(state.dark.isDark).toBe(true)
    expect(state.isPrivate).toBe(false)
    expect(state.shortcutsMode).toBe('most-visited')
    expect(state.background).toBe('space')
    expect(state.greeting).toBe(false)
    expect(state.canPickImage).toBe(false)
    expect(f.browser.newTab.stateFor('tab_nope')).toBeNull()
  })

  it('a tab that left the page gets no state and its actions are ignored', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    f.browser.handleCommand(win, 'newtab.open', undefined)
    const tab = activeTab(f)!
    tab.url = 'https://example.com/'
    expect(f.browser.newTab.stateFor(tab.id)).toBeNull()
    f.browser.newTab.handleAction(tab.id, { type: 'add-shortcut', title: 'X', url: 'x.example' })
    expect(f.browser.state.newTabDevice.shortcuts).toEqual([])
  })

  it('pushes fresh state to every live page after a commit that changed it, and only then', async () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    f.browser.handleCommand(win, 'newtab.open', undefined)
    const tab = activeTab(f)!
    const view = f.views.find((v) => v.tabId === tab.id)!
    await settle()
    const n = view.pushes.length
    expect(n).toBeGreaterThan(0)
    f.browser.state.commit()
    await settle()
    expect(view.pushes.length).toBe(n)
    // The greeting is a section: turning it on is the `custom` preset with that module set.
    f.browser.handleCommand(win, 'settings.update', {
      newTab: { preset: 'custom', modules: { greeting: true } }
    })
    await settle()
    expect(view.pushes.length).toBe(n + 1)
    expect(view.pushes.at(-1)?.greeting).toBe(true)
    // `ready` from the page always answers with the current state.
    f.browser.newTab.handleAction(tab.id, { type: 'ready' })
    expect(view.pushes.length).toBe(n + 2)
  })

  it('private windows: private flag, no tiles – neither most visited nor custom shortcuts', async () => {
    const f = fixture()
    f.browser.history.visit('https://news.example/a', 'News', null)
    const priv = f.browser.openWindow('private')!
    const tab = f.browser.tabs.activeTabFor(priv)!
    expect(tab.url).toBe(NEW_TAB_URL)
    expect(tab.containerId).toBe(PRIVATE_CONTAINER_ID)
    const state = f.browser.newTab.stateFor(tab.id)!
    expect(state.isPrivate).toBe(true)
    expect(state.topSites).toEqual([])
    const main = f.browser.focusedWindow()
    f.browser.handleCommand(main, 'newtab.open', undefined)
    const normal = f.browser.newTab.stateFor(activeTab(f)!.id)!
    expect(normal.topSites.map((s) => s.url)).toEqual(['https://news.example/a'])
    // The explainer stands where the grid would: a private page carries no shortcuts either.
    f.browser.newTab.addShortcut('Docs', 'docs.example')
    f.browser.updateSettings(
      { newTab: { ...f.browser.state.settings.newTab, mode: 'my-shortcuts' } },
      main
    )
    expect(f.browser.newTab.stateFor(tab.id)!.shortcuts).toEqual([])
    expect(f.browser.newTab.stateFor(activeTab(f)!.id)!.shortcuts.map((s) => s.url)).toEqual([
      'https://docs.example/'
    ])
  })

  it('the grid is four by two: eight most-visited sites and eight shortcuts', () => {
    expect(MAX_NEW_TAB_SHORTCUTS).toBe(8)
    const f = fixture()
    for (let i = 0; i < 12; i++) f.browser.history.visit(`https://s${i}.example/`, `S${i}`, null)
    const win = f.browser.focusedWindow()
    f.browser.handleCommand(win, 'newtab.open', undefined)
    expect(f.browser.newTab.stateFor(activeTab(f)!.id)!.topSites).toHaveLength(8)
  })

  it('a search typed into the page opens the URL bar over that tab with the text', async () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    f.browser.handleCommand(win, 'newtab.open', undefined)
    const tab = activeTab(f)!
    await settle()
    f.browser.newTab.handleAction(tab.id, { type: 'search', text: 'z' })
    expect(eventsNamed(f, 'newtab.opened').at(-1)).toEqual({ tabId: tab.id, text: 'z' })
  })
})

describe('NewTabService: my shortcuts and most visited', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('normalises addresses and falls back to the host as title', () => {
    expect(normalizeShortcutInput('  ', 'example.com')).toEqual({
      title: 'example.com',
      url: 'https://example.com/'
    })
    expect(normalizeShortcutInput('Docs', 'https://www.docs.example/x?y=1')).toEqual({
      title: 'Docs',
      url: 'https://www.docs.example/x?y=1'
    })
    expect(normalizeShortcutInput('nope', 'not a url at all')).toBeNull()
    expect(normalizeShortcutInput('nope', 'javascript:alert(1)')).toBeNull()
    expect(normalizeShortcutInput('nope', 'zen://newtab')).toBeNull()
  })

  it('adds, edits, removes with undo, reorders and caps the grid at eight', () => {
    const f = fixture()
    const svc = f.browser.newTab
    const shortcuts = (): { id: string; title: string; url: string }[] =>
      f.browser.state.newTabDevice.shortcuts
    const a = svc.addShortcut('A', 'a.example')!
    const b = svc.addShortcut('', 'https://b.example/path')!
    expect(shortcuts()).toEqual([
      { id: a, title: 'A', url: 'https://a.example/' },
      { id: b, title: 'b.example', url: 'https://b.example/path' }
    ])
    expect(svc.addShortcut('bad', '???')).toBeNull()
    // A site that has a tile is not added twice: its tile answers.
    expect(svc.addShortcut('A again', 'https://a.example/')).toBe(a)
    expect(shortcuts()).toHaveLength(2)
    expect(svc.updateShortcut(a, 'AA', 'aa.example')).toBe(true)
    expect(svc.updateShortcut('missing', 'x', 'x.example')).toBe(false)
    // Nor may an edit give a tile another tile's address.
    expect(svc.updateShortcut(a, 'B too', 'https://b.example/path')).toBe(false)
    expect(shortcuts()[0]).toEqual({ id: a, title: 'AA', url: 'https://aa.example/' })
    const removed = svc.removeShortcut(a)!
    expect(removed.index).toBe(0)
    expect(shortcuts().map((s) => s.id)).toEqual([b])
    expect(svc.restoreShortcut(removed.shortcut, removed.index)).toBe(true)
    expect(shortcuts().map((s) => s.id)).toEqual([a, b])
    // Restoring the same id twice is a no-op.
    expect(svc.restoreShortcut(removed.shortcut, 0)).toBe(false)
    svc.reorderShortcuts([b, 'bogus', a])
    expect(shortcuts().map((s) => s.id)).toEqual([b, a])
    for (let i = 0; i < MAX_NEW_TAB_SHORTCUTS; i++) svc.addShortcut(`S${i}`, `s${i}.example`)
    expect(shortcuts()).toHaveLength(MAX_NEW_TAB_SHORTCUTS)
    expect(svc.addShortcut('one more', 'more.example')).toBeNull()
  })

  it('a shortcut fronts the most-visited grid in place of its host, in either mode', () => {
    const f = fixture()
    const svc = f.browser.newTab
    for (const host of ['a', 'b', 'c'])
      f.browser.history.visit(`https://${host}.example/`, host, null)
    const win = f.browser.focusedWindow()
    f.browser.handleCommand(win, 'newtab.open', undefined)
    const tab = activeTab(f)!
    svc.addShortcut('B', 'https://www.b.example/')
    let state = svc.stateFor(tab.id)!
    expect(state.shortcutsMode).toBe('most-visited')
    expect(state.shortcuts.map((s) => s.url)).toEqual(['https://www.b.example/'])
    expect(state.topSites.map((s) => s.url)).toEqual(['https://a.example/', 'https://c.example/'])
    f.browser.handleCommand(win, 'settings.update', { newTab: { mode: 'my-shortcuts' } })
    state = svc.stateFor(tab.id)!
    expect(state.shortcutsMode).toBe('my-shortcuts')
    expect(state.shortcuts.map((s) => s.url)).toEqual(['https://www.b.example/'])
    expect(state.topSites).toEqual([])
    // The shortcuts section off: no grid at all, whatever the mode says.
    f.browser.handleCommand(win, 'settings.update', {
      newTab: { preset: 'custom', modules: { shortcuts: false } }
    })
    state = svc.stateFor(tab.id)!
    expect(state.shortcutsMode).toBe('hidden')
    expect(state.shortcuts).toEqual([])
    expect(state.topSites).toEqual([])
  })

  it("the phone's tile menu pins, unpins and removes through the same device state", () => {
    const f = fixture()
    const svc = f.browser.newTab
    f.browser.history.visit('https://www.news.example/a', 'News', null)
    f.browser.history.visit('https://docs.example/', 'Docs', null)
    const device = (): { shortcuts: { url: string }[]; hiddenHosts: string[] } =>
      f.browser.state.newTabDevice
    svc.remove('https://www.news.example/a')
    expect(device().hiddenHosts).toEqual(['news.example'])
    expect(f.browser.history.topSites(8, device().hiddenHosts).map((s) => s.url)).toEqual([
      'https://docs.example/'
    ])
    // Pinning a removed site brings its host back and gives it a tile.
    svc.pin('https://news.example/', 'News')
    expect(device().hiddenHosts).toEqual([])
    expect(device().shortcuts.map((s) => s.url)).toEqual(['https://news.example/'])
    // Pinning twice is once.
    svc.pin('https://news.example/', 'News again')
    expect(device().shortcuts).toHaveLength(1)
    svc.unpin('https://news.example/')
    expect(device().shortcuts).toEqual([])
    expect(device().hiddenHosts).toEqual([])
    // Removing a pinned site drops the tile and blocks the host.
    svc.pin('https://docs.example/', 'Docs')
    svc.remove('https://docs.example/')
    expect(device()).toEqual({ shortcuts: [], hiddenHosts: ['docs.example'] })
    svc.pin('javascript:alert(1)', 'nope')
    expect(device().shortcuts).toEqual([])
  })

  it('actions from the page drive the same operations', async () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    f.browser.handleCommand(win, 'newtab.open', undefined)
    const tab = activeTab(f)!
    const svc = f.browser.newTab
    const shortcuts = (): { id: string; title: string; url: string }[] =>
      f.browser.state.newTabDevice.shortcuts
    svc.handleAction(tab.id, { type: 'add-shortcut', title: 'Zen', url: 'zen-browser.app' })
    const [sc] = shortcuts()
    expect(sc).toMatchObject({ title: 'Zen', url: 'https://zen-browser.app/' })
    svc.handleAction(tab.id, { type: 'update-shortcut', id: sc.id, title: 'Z', url: sc.url })
    expect(shortcuts()[0].title).toBe('Z')
    svc.handleAction(tab.id, { type: 'remove-shortcut', id: sc.id })
    expect(shortcuts()).toEqual([])
    svc.handleAction(tab.id, {
      type: 'restore-shortcut',
      id: sc.id,
      title: 'Z',
      url: sc.url,
      index: 0
    })
    expect(shortcuts().map((s) => s.id)).toEqual([sc.id])
    svc.handleAction(tab.id, { type: 'add-shortcut', title: 'bad', url: '!!' })
    await settle()
    expect(eventsNamed(f, 'toast')).toEqual([
      { message: 'That is not a web address.', kind: 'error' }
    ])
  })

  it('the Add tile and Edit ask the chrome for the shortcut dialog over the page', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    f.browser.handleCommand(win, 'newtab.open', undefined)
    const tab = activeTab(f)!
    const svc = f.browser.newTab
    svc.handleAction(tab.id, { type: 'edit-shortcut', id: null })
    expect(eventsNamed(f, 'newtab.shortcutDialog')).toEqual([
      { tabId: tab.id, id: null, title: '', url: '' }
    ])
    const id = svc.addShortcut('Zen', 'zen-browser.app')!
    svc.handleAction(tab.id, { type: 'edit-shortcut', id })
    expect(eventsNamed(f, 'newtab.shortcutDialog').at(-1)).toEqual({
      tabId: tab.id,
      id,
      title: 'Zen',
      url: 'https://zen-browser.app/'
    })
    // A tile that is gone, or an add on a full grid, opens nothing.
    svc.handleAction(tab.id, { type: 'edit-shortcut', id: 'shortcut_gone' })
    expect(eventsNamed(f, 'newtab.shortcutDialog')).toHaveLength(2)
    for (let i = 1; i < MAX_NEW_TAB_SHORTCUTS; i++) svc.addShortcut(`S${i}`, `s${i}.example`)
    svc.handleAction(tab.id, { type: 'edit-shortcut', id: null })
    expect(eventsNamed(f, 'newtab.shortcutDialog')).toHaveLength(2)
  })

  it('a tile menu is the host menu, placed where the tile is in the window', () => {
    const f = fixture()
    const popups: Array<{ labels: string[]; options: Record<string, unknown> }> = []
    f.browser.platform.menus.popup = (items, options) => {
      popups.push({
        labels: items.map((item) => item.label ?? (item.type === 'separator' ? '-' : '?')),
        options: options as unknown as Record<string, unknown>
      })
    }
    const win = f.browser.focusedWindow()
    f.browser.handleCommand(win, 'newtab.open', undefined)
    const tab = activeTab(f)!
    // The page sits to the right of the sidebar: its CSS pixels are offset in the window's.
    win.applyLayout({
      placements: [{ tabId: tab.id, rect: { x: 300, y: 60, width: 900, height: 700 }, radius: 8 }],
      glance: null,
      contentHidden: false
    })
    const svc = f.browser.newTab
    const tile = { id: 'site:news.example', url: 'https://news.example/', title: 'News' }
    svc.handleAction(tab.id, { ...tile, type: 'tile-menu', x: 100, y: 200, keyboard: false })
    expect(popups).toHaveLength(1)
    expect(popups[0].labels).toEqual([
      'Open in New Tab',
      'Open in New Window',
      'Open in New Private Window',
      '-',
      'Remove'
    ])
    expect(popups[0].options).toMatchObject({ source: 'page', x: 400, y: 260, keyboard: false })
    // A shortcut's tile offers Edit as well (in either mode: shortcuts front the grid in both).
    const id = svc.addShortcut('Zen', 'zen-browser.app')!
    svc.handleAction(tab.id, {
      type: 'tile-menu',
      id,
      url: 'https://zen-browser.app/',
      title: 'Zen',
      x: 10,
      y: 20,
      keyboard: true
    })
    expect(popups[1].labels).toEqual([
      'Open in New Tab',
      'Open in New Window',
      'Open in New Private Window',
      '-',
      'Edit Shortcut',
      'Remove'
    ])
    expect(popups[1].options).toMatchObject({ x: 310, y: 80, keyboard: true })
    // Nothing for a tile that is not a web address.
    svc.handleAction(tab.id, {
      type: 'tile-menu',
      id: 'x',
      url: 'javascript:alert(1)',
      title: 'x',
      x: 0,
      y: 0,
      keyboard: false
    })
    expect(popups).toHaveLength(2)
  })

  it('Remove from the menu hands the removal back to the page, so its Undo follows', () => {
    const f = fixture()
    const commands: unknown[] = []
    const win = f.browser.focusedWindow()
    f.browser.handleCommand(win, 'newtab.open', undefined)
    const tab = activeTab(f)!
    const view = f.browser.tabs.view(tab.id)!
    view.sendNewTabCommand = (command) => {
      commands.push(command)
    }
    f.browser.newTab.removeTileFromPage(tab.id, 'site:news.example')
    expect(commands).toEqual([{ type: 'remove-tile', id: 'site:news.example' }])
  })

  it('Customize opens Settings at the New Tab section', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    f.browser.handleCommand(win, 'newtab.open', undefined)
    const tab = activeTab(f)!
    f.browser.newTab.handleAction(tab.id, { type: 'customize' })
    expect(eventsNamed(f, 'overlay.open').at(-1)).toEqual({ kind: 'settings', section: 'newtab' })
  })

  it('removing a most-visited tile hides its host until undone', () => {
    const f = fixture()
    f.browser.history.visit('https://www.news.example/a', 'News', null)
    f.browser.history.visit('https://docs.example/', 'Docs', null)
    const win = f.browser.focusedWindow()
    f.browser.handleCommand(win, 'newtab.open', undefined)
    const tab = activeTab(f)!
    const svc = f.browser.newTab
    svc.handleAction(tab.id, { type: 'hide-site', url: 'https://www.news.example/a' })
    expect(f.browser.state.newTabDevice.hiddenHosts).toEqual(['news.example'])
    expect(f.browser.state.snapshot(win).newTabHiddenHosts).toEqual(['news.example'])
    expect(svc.stateFor(tab.id)?.topSites.map((s) => s.url)).toEqual(['https://docs.example/'])
    svc.handleAction(tab.id, { type: 'unhide-site', url: 'https://news.example/other' })
    expect(f.browser.state.newTabDevice.hiddenHosts).toEqual([])
    expect(svc.stateFor(tab.id)?.topSites).toHaveLength(2)
  })

  it('the topSites command hands the chrome the same list', () => {
    const f = fixture()
    f.browser.history.visit('https://a.example/', 'A', null)
    f.browser.history.visit('https://b.example/', 'B', null)
    const win = f.browser.focusedWindow()
    const sites = f.browser.handleCommand(win, 'history.topSites', {
      n: 5,
      excludedHosts: ['a.example']
    }) as Array<{ url: string }>
    expect(sites.map((s) => s.url)).toEqual(['https://b.example/'])
  })

  it('background image: picking switches to it, clearing falls back to the space gradient', async () => {
    const f = fixture({ withBackground: true })
    const win = f.browser.focusedWindow()
    f.browser.handleCommand(win, 'newtab.open', undefined)
    const tab = activeTab(f)!
    const svc = f.browser.newTab
    expect(svc.stateFor(tab.id)?.canPickImage).toBe(true)
    // Settings' "Choose image…" opens the picker; a pick switches the background to the image.
    await f.browser.handleCommand(win, 'newtab.pickBackgroundImage', undefined)
    await settle()
    expect(f.background.picks).toBe(1)
    expect(f.browser.state.settings.newTab.background).toBe('image')
    expect(svc.stateFor(tab.id)?.backgroundImage).toBe('zen://newtab-background?v=1')
    await svc.clearBackgroundImage()
    expect(f.browser.state.settings.newTab.background).toBe('space')
    expect(svc.stateFor(tab.id)?.backgroundImage).toBeNull()
  })

  it('a picked image is shown: on a layout without a wallpaper the section comes on', async () => {
    const f = fixture({ withBackground: true })
    const win = f.browser.focusedWindow()
    f.browser.handleCommand(win, 'newtab.open', undefined)
    const tab = activeTab(f)!
    const svc = f.browser.newTab
    expect(f.browser.state.settings.newTab.preset).toBe('focused')
    await svc.pickBackgroundImage(win)
    expect(f.browser.state.settings.newTab).toMatchObject({
      preset: 'custom',
      background: 'image',
      modules: { wallpaper: true, greeting: false }
    })
    expect(svc.stateFor(tab.id)?.background).toBe('image')
    // A layout that shows a wallpaper already keeps its name.
    f.browser.handleCommand(win, 'settings.update', {
      newTab: { preset: 'inspirational', background: 'space' }
    })
    await svc.pickBackgroundImage(win)
    expect(f.browser.state.settings.newTab).toMatchObject({
      preset: 'inspirational',
      background: 'image'
    })
  })

  it("the phone's chooser hands the image over through setBackgroundImage", async () => {
    const stored: Array<string | null> = []
    const f = fixture({ withBackground: true })
    f.browser.platform.newTabBackground!.set = async (dataUrl) => {
      stored.push(dataUrl)
      f.background.current = dataUrl
    }
    const win = f.browser.focusedWindow()
    await f.browser.handleCommand(win, 'newtab.setBackgroundImage', {
      dataUrl: 'data:image/png;base64,AA'
    })
    expect(stored).toEqual(['data:image/png;base64,AA'])
    expect(f.browser.handleCommand(win, 'newtab.backgroundImage', undefined)).toBe(
      'data:image/png;base64,AA'
    )
    expect(f.browser.state.settings.newTab).toMatchObject({ preset: 'custom', background: 'image' })
    await f.browser.handleCommand(win, 'newtab.setBackgroundImage', { dataUrl: null })
    expect(stored).toEqual(['data:image/png;base64,AA', null])
    expect(f.browser.state.settings.newTab.background).toBe('space')
    expect(f.browser.state.settings.newTab.modules.wallpaper).toBe(true)
    // A host with no way to keep an image refuses.
    const bare = fixture()
    await expect(
      bare.browser.handleCommand(bare.browser.focusedWindow(), 'newtab.setBackgroundImage', {
        dataUrl: 'data:image/png;base64,AA'
      })
    ).rejects.toThrow()
  })

  it('the chrome state says whether an image is set and whether the host can pick one', async () => {
    const f = fixture({ withBackground: true })
    const win = f.browser.focusedWindow()
    expect(f.browser.state.snapshot(win).newTabBackground).toEqual({ image: false, canPick: true })
    f.browser.handleCommand(win, 'newtab.open', undefined)
    await f.browser.newTab.pickBackgroundImage(win)
    expect(f.browser.state.snapshot(win).newTabBackground).toEqual({ image: true, canPick: true })
    const bare = fixture()
    expect(bare.browser.state.snapshot(bare.browser.focusedWindow()).newTabBackground).toEqual({
      image: false,
      canPick: false
    })
  })

  it('Settings edits the same shortcuts list through the newtab commands', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const a = f.browser.handleCommand(win, 'newtab.addShortcut', {
      title: 'A',
      url: 'a.example'
    }) as string
    const b = f.browser.handleCommand(win, 'newtab.addShortcut', {
      title: '',
      url: 'https://b.example/x'
    }) as string
    expect(f.browser.state.snapshot(win).newTabShortcuts.map((s) => s.title)).toEqual([
      'A',
      'b.example'
    ])
    f.browser.handleCommand(win, 'newtab.reorderShortcuts', { ids: [b, a] })
    f.browser.handleCommand(win, 'newtab.updateShortcut', { id: a, title: 'A2', url: 'a2.example' })
    expect(f.browser.state.snapshot(win).newTabShortcuts).toEqual([
      { id: b, title: 'b.example', url: 'https://b.example/x' },
      { id: a, title: 'A2', url: 'https://a2.example/' }
    ])
    f.browser.handleCommand(win, 'newtab.removeShortcut', { id: b })
    expect(f.browser.state.snapshot(win).newTabShortcuts.map((s) => s.id)).toEqual([a])
  })

  it('settings.update sanitises the new tab keys and keeps the rest of the settings', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    // The desktop's first spelling of the mode is read for one release; a one-section patch of
    // the modules keeps the other sections.
    f.browser.handleCommand(win, 'settings.update', {
      newTab: { mode: 'custom', preset: 'custom', background: 'nope', modules: { greeting: true } }
    })
    const modules = {
      searchBox: true,
      shortcuts: true,
      wallpaper: false,
      feed: false,
      greeting: true
    }
    expect(f.browser.state.settings.newTab).toEqual({
      enabled: true,
      mode: 'my-shortcuts',
      preset: 'custom',
      modules,
      background: 'space'
    })
    f.browser.handleCommand(win, 'settings.update', { newTab: { enabled: false } })
    expect(f.browser.state.settings.newTab).toEqual({
      enabled: false,
      mode: 'my-shortcuts',
      preset: 'custom',
      modules,
      background: 'space'
    })
    // A named preset stands over the modules: the page reads the preset's sections.
    f.browser.handleCommand(win, 'settings.update', {
      newTab: { enabled: true, preset: 'inspirational', background: 'image' }
    })
    f.browser.handleCommand(win, 'newtab.open', undefined)
    const state = f.browser.newTab.stateFor(activeTab(f)!.id)!
    expect(state.greeting).toBe(true)
    // An image source with no image on this device paints the space gradient.
    expect(state.background).toBe('space')
    expect(f.browser.state.settings.newTab.modules).toEqual(modules)
  })
})

describe('NewTabService: what the page never leaves behind', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a tab that only ever showed the new tab page is not kept in Recently Closed', async () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    f.browser.handleCommand(win, 'newtab.open', undefined)
    const tab = activeTab(f)!
    expect(tab.url).toBe(NEW_TAB_URL)
    const before = f.browser.state.recentlyClosed.length
    f.browser.tabs.closeTab(tab.id, false, win)
    expect(f.browser.state.recentlyClosed).toHaveLength(before)
  })
})
