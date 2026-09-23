import { describe, expect, it, vi } from 'vitest'
import type {
  HostCapabilities,
  NavigationSnapshot,
  Platform as PlatformOs,
  Tab
} from '../../shared/types'
import { PRIVATE_CONTAINER_ID } from '../../shared/types'
import { Browser } from '../browser'
import { dialogSite, isEmbeddedDialog } from '../pageDialogs'
import type {
  AppHost,
  MenuHost,
  MenuItemTemplate,
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'
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

/** Anything the browser touches on the host answers with a harmless no-op. */
function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** A page as the host sees it, with a scripted answer to its `beforeunload` check. */
interface FakeView {
  readonly tabId: string
  readonly events: TabViewEvents
  view: TabView
  destroyed: boolean
  /** How the page answers `confirmUnload`: leave (true), stay (false), or no handler (closes). */
  unload: 'leave' | 'stay' | 'none'
  unloadChecks: number
  /** While true the page's `beforeunload` holds every navigation: `loadURL` leaves it in place. */
  objects: boolean
  /** What `navigationEntries()` reports; tests script the page's stack here. */
  snapshot: NavigationSnapshot
  /** Every stack the host was asked to replay. */
  restored: NavigationSnapshot[]
}

function fakeView(tab: Tab, events: TabViewEvents): FakeView {
  let url = ''
  const fake: FakeView = {
    tabId: tab.id,
    events,
    destroyed: false,
    unload: 'none',
    unloadChecks: 0,
    objects: false,
    snapshot: { entries: [], index: -1 },
    restored: [],
    view: undefined as unknown as TabView
  }
  const overrides: Partial<TabView> = {
    isDestroyed: () => fake.destroyed,
    destroy: () => {
      fake.destroyed = true
    },
    loadURL: (u) => {
      if (!fake.objects) url = u
    },
    getURL: () => url,
    getTitle: () => (url ? 'Page title' : ''),
    hasDocument: () => url !== '',
    canGoBack: () => false,
    canGoForward: () => false,
    getZoom: () => 1,
    isCurrentlyAudible: () => false,
    navigationEntries: () => fake.snapshot,
    restoreNavigation: async (snapshot) => {
      fake.restored.push(snapshot)
      url = snapshot.entries[snapshot.index]?.url ?? ''
    },
    confirmUnload: async () => {
      fake.unloadChecks += 1
      if (fake.unload === 'stay') return false
      // A page without an objecting handler is closed by the check itself.
      if (fake.unload === 'none') {
        fake.destroyed = true
        events.onDestroyed()
      }
      return true
    }
  }
  fake.view = new Proxy(overrides as TabView, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
  return fake
}

interface Fixture {
  browser: Browser
  views: FakeView[]
  /** `host.close()` calls per window – what a real host would turn into destruction. */
  closes: Map<string, number>
  quits: number
  /** The items of the last context menu the core asked the host to show. */
  menu: MenuItemTemplate[]
  viewOf(tabId: string): FakeView
}

function fixture(io: StoreIO = memoryIo(), os: PlatformOs = 'linux'): Fixture {
  const views: FakeView[] = []
  const closes = new Map<string, number>()
  const f: Fixture = {
    browser: undefined as unknown as Browser,
    views,
    closes,
    quits: 0,
    menu: [],
    viewOf: (tabId) => {
      // The newest page of the tab: a reloaded tab has a destroyed one before it.
      const v = [...views].reverse().find((x) => x.tabId === tabId)
      if (!v) throw new Error(`no view for ${tabId}`)
      return v
    }
  }
  const capabilities = stub<HostCapabilities>({ windows: true, updates: false, agents: false })
  const platform: Platform = {
    info: { os, version: '0.0.0' },
    capabilities,
    io,
    windows: {
      create: (win) =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          close: () => closes.set(win.id, (closes.get(win.id) ?? 0) + 1)
        })
    },
    views: stub<TabViewHost>({
      createView: (tab, events) => {
        const fake = fakeView(tab, events)
        views.push(fake)
        return fake.view
      }
    }),
    menus: stub<MenuHost>({
      popup: (items) => {
        f.menu = items
      }
    }),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub<AppHost>({
      quit: () => {
        f.quits += 1
      }
    }),
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  f.browser = browser
  return f
}

function firstWindow(f: Fixture): ZenWindow {
  const win = f.browser.allWindows()[0]
  if (!win) throw new Error('no window')
  return win
}

describe('page dialogs', () => {
  it('titles a dialog after the site of the frame that opened it', () => {
    expect(dialogSite('https://example.com/a/b?c')).toBe('example.com')
    expect(dialogSite('http://localhost:8080/')).toBe('localhost:8080')
    expect(dialogSite('file:///tmp/page.html')).toBe('')
    expect(dialogSite('data:text/html,hi')).toBe('')
    expect(dialogSite('not a url')).toBe('')
    expect(isEmbeddedDialog('https://ads.example.net/f', 'https://example.com/')).toBe(true)
    expect(isEmbeddedDialog('https://example.com/frame', 'https://example.com/')).toBe(false)
    expect(isEmbeddedDialog('about:blank', 'https://example.com/')).toBe(false)
    expect(isEmbeddedDialog('about:srcdoc', 'https://example.com/')).toBe(false)
  })

  it('queues alert / confirm / prompt for the chrome and hands back a sanitised answer', async () => {
    const f = fixture()
    const win = firstWindow(f)
    const tab = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const { pageDialogs } = f.browser

    const alert = pageDialogs.ask(tab.id, {
      kind: 'alert',
      message: 'Hello',
      defaultValue: '',
      frameUrl: 'https://example.com/',
      pageUrl: 'https://example.com/'
    })
    const listed = pageDialogs.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      kind: 'alert',
      tabId: tab.id,
      site: 'example.com',
      embedded: false,
      message: 'Hello'
    })
    expect(f.browser.state.snapshot(win).pageDialogs).toEqual(listed)
    // An alert is accepted however the chrome answers it.
    pageDialogs.respond(listed[0].id, { accepted: false, value: 'ignored' })
    await expect(alert).resolves.toEqual({ accepted: true, value: null })
    expect(pageDialogs.list()).toEqual([])

    const confirm = pageDialogs.ask(tab.id, {
      kind: 'confirm',
      message: 'Sure?',
      defaultValue: '',
      frameUrl: 'https://ads.example.net/frame',
      pageUrl: 'https://example.com/'
    })
    expect(pageDialogs.list()[0]).toMatchObject({ site: 'ads.example.net', embedded: true })
    pageDialogs.respond(pageDialogs.list()[0].id, { accepted: true, value: 'text' })
    // Only prompts carry text.
    await expect(confirm).resolves.toEqual({ accepted: true, value: null })

    const prompt = pageDialogs.ask(tab.id, {
      kind: 'prompt',
      message: 'Name?',
      defaultValue: 'Ada',
      frameUrl: 'https://example.com/',
      pageUrl: 'https://example.com/'
    })
    expect(pageDialogs.list()[0]).toMatchObject({ kind: 'prompt', defaultValue: 'Ada' })
    pageDialogs.respond(pageDialogs.list()[0].id, { accepted: true, value: 'Grace' })
    await expect(prompt).resolves.toEqual({ accepted: true, value: 'Grace' })

    const cancelled = pageDialogs.ask(tab.id, {
      kind: 'prompt',
      message: 'Name?',
      defaultValue: '',
      frameUrl: 'https://example.com/',
      pageUrl: 'https://example.com/'
    })
    pageDialogs.respond(pageDialogs.list()[0].id, { accepted: false, value: null })
    await expect(cancelled).resolves.toEqual({ accepted: false, value: null })
  })

  it('dismisses the dialogs of a tab that goes away, and answers nothing for an unknown tab', async () => {
    const f = fixture()
    const win = firstWindow(f)
    const tab = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const request = {
      kind: 'confirm' as const,
      message: '',
      defaultValue: '',
      frameUrl: 'https://example.com/',
      pageUrl: 'https://example.com/'
    }
    const pending = f.browser.pageDialogs.ask(tab.id, request)
    expect(f.browser.pageDialogs.hasPending(tab.id)).toBe(true)
    f.browser.tabs.closeTab(tab.id, true)
    await expect(pending).resolves.toEqual({ accepted: false, value: null })
    expect(f.browser.pageDialogs.hasPending(tab.id)).toBe(false)
    await expect(f.browser.pageDialogs.ask('tab_missing', request)).resolves.toEqual({
      accepted: false,
      value: null
    })
  })

  it('"Leave site?" brings the tab to the front and reports the answer', async () => {
    const f = fixture()
    const win = firstWindow(f)
    const a = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const b = f.browser.tabs.createTab({ url: 'https://example.org/', active: true }, win)
    expect(f.browser.tabs.activeTabFor(win)?.id).toBe(b.id)

    const leave = f.browser.pageDialogs.confirmLeave(a.id, false)
    expect(f.browser.tabs.activeTabFor(win)?.id).toBe(a.id)
    const [dialog] = f.browser.pageDialogs.list()
    expect(dialog).toMatchObject({ kind: 'beforeunload', tabId: a.id, message: 'leave' })
    f.browser.pageDialogs.respond(dialog.id, { accepted: false, value: null })
    await expect(leave).resolves.toBe(false)

    const reload = f.browser.pageDialogs.confirmLeave(a.id, true)
    const [again] = f.browser.pageDialogs.list()
    expect(again.message).toBe('reload')
    f.browser.pageDialogs.respond(again.id, { accepted: true, value: null })
    await expect(reload).resolves.toBe(true)
  })

  it('Stay after an address-bar navigation puts the page that stayed back into the tab', async () => {
    const f = fixture()
    const win = firstWindow(f)
    const tab = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const fake = f.viewOf(tab.id)
    fake.objects = true
    // The pill shows the destination as soon as it is typed…
    f.browser.tabs.navigate(tab.id, 'https://example.org/next')
    expect(f.browser.tabs.tab(tab.id)?.url).toBe('https://example.org/next')
    // …the page objects, the host asks, the user stays.
    const leave = fake.events.onLeaveSite(false)
    const [dialog] = f.browser.pageDialogs.list()
    f.browser.pageDialogs.respond(dialog.id, { accepted: false, value: null })
    await expect(leave).resolves.toBe(false)
    expect(f.browser.tabs.tab(tab.id)).toMatchObject({
      url: 'https://example.com/',
      title: 'Page title'
    })
    // Leaving changes nothing here: the navigation that follows writes the new page itself.
    f.browser.tabs.navigate(tab.id, 'https://example.org/next')
    const go = fake.events.onLeaveSite(false)
    f.browser.pageDialogs.respond(f.browser.pageDialogs.list()[0].id, {
      accepted: true,
      value: null
    })
    await expect(go).resolves.toBe(true)
    expect(f.browser.tabs.tab(tab.id)?.url).toBe('https://example.org/next')
  })
})

describe('closing tabs with beforeunload', () => {
  it('closes a tab whose page does not object, and keeps one whose page says stay', async () => {
    const f = fixture()
    const win = firstWindow(f)
    const a = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const b = f.browser.tabs.createTab({ url: 'https://example.org/', active: true }, win)

    f.viewOf(b.id).unload = 'stay'
    await expect(f.browser.tabs.requestClose(b.id)).resolves.toBe(false)
    expect(f.browser.tabs.tab(b.id)).toBeDefined()
    expect(f.viewOf(b.id).destroyed).toBe(false)

    f.viewOf(b.id).unload = 'leave'
    await expect(f.browser.tabs.requestClose(b.id)).resolves.toBe(true)
    expect(f.browser.tabs.tab(b.id)).toBeUndefined()

    // No handler: the check itself closes the page, and the tab goes with it.
    await expect(f.browser.tabs.requestClose(a.id)).resolves.toBe(true)
    expect(f.browser.tabs.tab(a.id)).toBeUndefined()
  })

  it('the tab.close command goes through the check', async () => {
    const f = fixture()
    const win = firstWindow(f)
    const tab = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    f.viewOf(tab.id).unload = 'stay'
    f.browser.handleCommand(win, 'tab.close', { tabId: tab.id })
    await tick()
    expect(f.browser.tabs.tab(tab.id)).toBeDefined()
    expect(f.viewOf(tab.id).unloadChecks).toBe(1)
  })

  it('"Close N Tabs" on a selection asks each page in turn and keeps the one that says stay', async () => {
    const f = fixture()
    const win = firstWindow(f)
    const a = f.browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win)
    const b = f.browser.tabs.createTab({ url: 'https://example.com/b', active: true }, win)
    const c = f.browser.tabs.createTab({ url: 'https://example.com/c', active: true }, win)
    f.viewOf(b.id).unload = 'stay'
    f.viewOf(c.id).unload = 'leave'

    f.browser.menus.showSelectionContextMenu([a.id, b.id, c.id], win)
    const close = f.menu.find((item) => item.label === 'Close 3 Tabs')
    expect(close?.click).toBeDefined()
    close?.click?.()
    await tick()
    await tick()

    expect(f.browser.tabs.tab(a.id)).toBeUndefined()
    expect(f.browser.tabs.tab(b.id)).toBeDefined()
    expect(f.browser.tabs.tab(c.id)).toBeUndefined()
    // Every page was asked, one after the other.
    expect(f.views.filter((v) => v.unloadChecks === 1).map((v) => v.tabId)).toEqual([
      a.id,
      b.id,
      c.id
    ])
  })
})

describe('closing a window', () => {
  it('asks "Close N tabs?" first when several tabs close and the setting is on', async () => {
    const f = fixture()
    const win = firstWindow(f)
    for (const url of ['https://a.test/', 'https://b.test/', 'https://c.test/'])
      f.browser.tabs.createTab({ url, active: true }, win)
    expect(f.browser.tabs.closingTabCount(win)).toBe(3)

    const closing = f.browser.requestWindowClose(win)
    await tick()
    expect(win.prompt).toMatchObject({ kind: 'close-tabs', count: 3 })
    expect(f.browser.state.snapshot(win).window.prompt).toEqual(win.prompt)
    // A second request while the question is up joins the first instead of asking again.
    const again = f.browser.requestWindowClose(win)
    expect(win.prompt).not.toBeNull()

    f.browser.handleCommand(win, 'window.respondPrompt', { id: win.prompt!.id, accepted: false })
    await expect(closing).resolves.toBe(false)
    await expect(again).resolves.toBe(false)
    expect(win.prompt).toBeNull()
    expect(win.closeApproved).toBe(false)
    expect(f.closes.get(win.id)).toBeUndefined()
    expect(f.browser.allWindows()).toEqual([win])
  })

  it('closes for real once the tabs question and every page agreed', async () => {
    const f = fixture()
    const win = firstWindow(f)
    const a = f.browser.tabs.createTab({ url: 'https://a.test/', active: true }, win)
    const b = f.browser.tabs.createTab({ url: 'https://b.test/', active: true }, win)
    f.viewOf(a.id).unload = 'leave'

    const closing = f.browser.requestWindowClose(win)
    await tick()
    f.browser.windowPrompts.respond(win.prompt!.id, true)
    await expect(closing).resolves.toBe(true)
    expect(f.viewOf(a.id).unloadChecks).toBe(1)
    expect(f.viewOf(b.id).unloadChecks).toBe(1)
    expect(win.closeApproved).toBe(true)
    expect(f.closes.get(win.id)).toBe(1)
    // The tabs are still in the model: the host's close is what takes the window down.
    expect(f.browser.tabs.tab(a.id)).toBeDefined()
    expect(f.browser.tabs.tab(b.id)).toBeDefined()
  })

  it('a page that says stay stops the close and leaves the other tabs in place, unloaded', async () => {
    const f = fixture()
    const win = firstWindow(f)
    const a = f.browser.tabs.createTab({ url: 'https://a.test/', active: true }, win)
    const b = f.browser.tabs.createTab({ url: 'https://b.test/', active: true }, win)
    f.browser.state.settings.warnOnCloseWindow = false
    f.viewOf(b.id).unload = 'stay'

    await expect(f.browser.requestWindowClose(win)).resolves.toBe(false)
    expect(win.prompt).toBeNull()
    expect(win.closeApproved).toBe(false)
    expect(f.closes.get(win.id)).toBeUndefined()
    // Page a had no handler: the check closed its page, the tab stays (unloaded) for the window
    // that is still open.
    expect(f.browser.tabs.tab(a.id)?.discarded).toBe(true)
    expect(f.browser.tabs.tab(b.id)).toBeDefined()
    expect(f.viewOf(b.id).destroyed).toBe(false)
  })

  it('does not ask about the tabs with the setting off or a single tab', async () => {
    const f = fixture()
    const win = firstWindow(f)
    f.browser.tabs.createTab({ url: 'https://a.test/', active: true }, win)
    await expect(f.browser.requestWindowClose(win)).resolves.toBe(true)
    expect(f.closes.get(win.id)).toBe(1)

    const g = fixture()
    const w = firstWindow(g)
    g.browser.state.settings.warnOnCloseWindow = false
    for (const url of ['https://a.test/', 'https://b.test/'])
      g.browser.tabs.createTab({ url, active: true }, w)
    await expect(g.browser.requestWindowClose(w)).resolves.toBe(true)
    expect(w.prompt).toBeNull()
  })

  it('counts only the tabs that leave with a synced window while another one stays open', () => {
    const f = fixture()
    const first = firstWindow(f)
    for (const url of ['https://a.test/', 'https://b.test/'])
      f.browser.tabs.createTab({ url, active: true }, first)
    const second = f.browser.openWindow('synced', first)
    if (!second) throw new Error('no second window')
    // Shared tabs stay open in the other window: nothing closes with this one.
    expect(f.browser.tabs.closingTabCount(first)).toBe(0)
    expect(f.browser.tabs.closingTabCount(second)).toBe(0)
    expect(f.browser.tabs.openTabCount()).toBe(2)
  })

  it('an approved or quitting window closes straight away', async () => {
    const f = fixture()
    const win = firstWindow(f)
    for (const url of ['https://a.test/', 'https://b.test/'])
      f.browser.tabs.createTab({ url, active: true }, win)
    f.browser.shutdown()
    await expect(f.browser.requestWindowClose(win)).resolves.toBe(true)
    expect(win.prompt).toBeNull()
    expect(win.closeApproved).toBe(true)
    expect(f.closes.get(win.id)).toBe(1)
  })
})

describe('quitting', () => {
  it('asks "Quit Zenium?" with every open tab counted, then quits once agreed', async () => {
    const f = fixture()
    const win = firstWindow(f)
    for (const url of ['https://a.test/', 'https://b.test/', 'https://c.test/'])
      f.browser.tabs.createTab({ url, active: true }, win)

    const quitting = f.browser.requestQuit(win)
    await tick()
    expect(win.prompt).toMatchObject({ kind: 'quit', count: 3, downloads: null })
    f.browser.windowPrompts.respond(win.prompt!.id, true)
    await expect(quitting).resolves.toBe(true)
    expect(f.browser.quitting).toBe(true)
    expect(f.quits).toBe(1)
  })

  it('a cancelled question or a page that stays keeps the app running', async () => {
    const f = fixture()
    const win = firstWindow(f)
    const a = f.browser.tabs.createTab({ url: 'https://a.test/', active: true }, win)
    f.browser.tabs.createTab({ url: 'https://b.test/', active: true }, win)

    const first = f.browser.requestQuit(win)
    await tick()
    f.browser.windowPrompts.respond(win.prompt!.id, false)
    await expect(first).resolves.toBe(false)
    expect(f.browser.quitting).toBe(false)
    expect(f.quits).toBe(0)

    f.browser.state.settings.warnOnCloseWindow = false
    f.viewOf(a.id).unload = 'stay'
    await expect(f.browser.requestQuit(win)).resolves.toBe(false)
    expect(f.browser.quitting).toBe(false)
    expect(f.quits).toBe(0)
    expect(f.browser.tabs.tab(a.id)).toBeDefined()
  })

  it('quits without questions when nothing is open, and only once while a check runs', async () => {
    const f = fixture()
    const win = firstWindow(f)
    for (const url of ['https://a.test/', 'https://b.test/'])
      f.browser.tabs.createTab({ url, active: true }, win)
    const one = f.browser.requestQuit(win)
    const two = f.browser.requestQuit(win)
    await tick()
    f.browser.windowPrompts.respond(win.prompt!.id, true)
    await expect(Promise.all([one, two])).resolves.toEqual([true, true])
    expect(f.quits).toBe(1)
  })

  it('hands the quit to the host only once the final write of the profile has landed', async () => {
    // A host whose asynchronous writes land when the test says so (a slow disk).
    const gates: Array<() => void> = []
    const landed: string[] = []
    const files: Record<string, string> = {}
    const io: StoreIO = {
      readSync: (name) => files[name] ?? null,
      write: async (name, text) => {
        await new Promise<void>((resolve) => gates.push(resolve))
        files[name] = text
        landed.push(name)
      },
      writeSync: (name, text) => {
        files[name] = text
        landed.push(name)
      }
    }
    vi.useFakeTimers()
    try {
      const f = fixture(io)
      const win = firstWindow(f)
      f.browser.tabs.createTab({ url: 'https://a.test/', active: true }, win)
      // The debounced write of that tab has started and waits on the disk when the user quits.
      await vi.advanceTimersByTimeAsync(400)
      expect(f.browser.writing).toBe(true)

      const quitting = f.browser.requestQuit(win)
      await vi.advanceTimersByTimeAsync(0)
      expect(f.browser.quitting).toBe(true)
      expect(f.quits).toBe(0)

      for (const open of gates.splice(0)) open()
      await vi.advanceTimersByTimeAsync(0)
      await expect(quitting).resolves.toBe(true)
      expect(f.quits).toBe(1)
      expect(f.browser.writing).toBe(false)
      // The document the quit ended with is the one on disk: the in-flight write landed before it.
      const stateWrites = landed.filter((name) => name === 'state.json')
      expect(stateWrites.length).toBeGreaterThanOrEqual(3)
      const state = files['state.json']
      if (!state) throw new Error('state.json was not written')
      expect((JSON.parse(state) as { cleanExit?: boolean }).cleanExit).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('downloads in progress (downloads-35)', () => {
  /** A transfer running in the engine, regular or private. */
  function download(f: Fixture, name: string, isPrivate = false): string {
    return f.browser.downloads.begin({
      url: `https://cdn.example.com/${name}`,
      filename: name,
      totalBytes: 1000,
      mimeType: 'application/octet-stream',
      savePath: `/dl/${name}.zeniumdownload`,
      sourceTabId: null,
      private: isPrivate
    }).id
  }

  it('a quit asks about the running downloads in the same prompt as the tabs, and parks them once agreed', async () => {
    const f = fixture()
    const win = firstWindow(f)
    for (const url of ['https://a.test/', 'https://b.test/', 'https://c.test/'])
      f.browser.tabs.createTab({ url, active: true }, win)
    const one = download(f, 'one.zip')
    const two = download(f, 'two.zip')
    // A finished download is not in progress.
    f.browser.downloads.finish(download(f, 'done.zip'), 'cancelled')

    const quitting = f.browser.requestQuit(win)
    await tick()
    expect(win.prompt).toMatchObject({
      kind: 'quit',
      count: 3,
      downloads: { count: 2, end: 'quit' }
    })
    f.browser.windowPrompts.respond(win.prompt!.id, true)
    await expect(quitting).resolves.toBe(true)
    expect(f.quits).toBe(1)
    // The quit's shutdown ends the transfers: interrupted by the shutdown, Resume next launch.
    expect(f.browser.downloads.item(one)).toMatchObject({ state: 'interrupted' })
    expect(f.browser.downloads.item(two)).toMatchObject({ state: 'interrupted' })
  })

  it('asks about a download alone when the tabs warning does not apply, and Cancel keeps everything running', async () => {
    const f = fixture()
    const win = firstWindow(f)
    f.browser.tabs.createTab({ url: 'https://a.test/', active: true }, win)
    const id = download(f, 'one.zip')

    const quitting = f.browser.requestQuit(win)
    await tick()
    // No tabs warning for a single tab: the prompt's count is 0, the downloads are the question.
    expect(win.prompt).toMatchObject({
      kind: 'quit',
      count: 0,
      downloads: { count: 1, end: 'quit' }
    })
    f.browser.windowPrompts.respond(win.prompt!.id, false)
    await expect(quitting).resolves.toBe(false)
    expect(f.quits).toBe(0)
    expect(f.browser.quitting).toBe(false)
    expect(f.browser.downloads.item(id)).toMatchObject({ state: 'progressing' })

    // The setting off silences the tabs warning, never the download question.
    f.browser.state.settings.warnOnCloseWindow = false
    f.browser.tabs.createTab({ url: 'https://b.test/', active: true }, win)
    const again = f.browser.requestQuit(win)
    await tick()
    expect(win.prompt).toMatchObject({
      kind: 'quit',
      count: 0,
      downloads: { count: 1, end: 'quit' }
    })
    f.browser.windowPrompts.respond(win.prompt!.id, false)
    await expect(again).resolves.toBe(false)
  })

  it('no download running: the quit asks nothing it did not ask before', async () => {
    const f = fixture()
    const win = firstWindow(f)
    f.browser.tabs.createTab({ url: 'https://a.test/', active: true }, win)
    await expect(f.browser.requestQuit(win)).resolves.toBe(true)
    expect(win.prompt).toBeNull()
    expect(f.quits).toBe(1)
  })

  it('closing the last window asks, since that quits; not while another window stays open', async () => {
    const f = fixture()
    // The tabs warning off: the download question is the one asked here.
    f.browser.state.settings.warnOnCloseWindow = false
    const first = firstWindow(f)
    f.browser.tabs.createTab({ url: 'https://a.test/', active: true }, first)
    download(f, 'one.zip')
    const second = f.browser.openWindow('unsynced', first)
    if (!second) throw new Error('no second window')
    f.browser.tabs.createTab({ url: 'https://b.test/', active: true }, second)

    // The download goes on in the window that stays: no question.
    await expect(f.browser.requestWindowClose(second)).resolves.toBe(true)
    expect(second.prompt).toBeNull()
    f.browser.onWindowClosing(second)
    f.browser.onWindowClosed(second)

    const closing = f.browser.requestWindowClose(first)
    await tick()
    expect(first.prompt).toMatchObject({
      kind: 'close-tabs',
      count: 0,
      downloads: { count: 1, end: 'quit' }
    })
    f.browser.windowPrompts.respond(first.prompt!.id, false)
    await expect(closing).resolves.toBe(false)
    expect(f.closes.get(first.id)).toBeUndefined()
  })

  it('on macOS the last window closes without a question: the app stays and the download with it', async () => {
    const f = fixture(memoryIo(), 'darwin')
    const win = firstWindow(f)
    f.browser.tabs.createTab({ url: 'https://a.test/', active: true }, win)
    download(f, 'one.zip')
    await expect(f.browser.requestWindowClose(win)).resolves.toBe(true)
    expect(win.prompt).toBeNull()
  })

  it('the last private window asks about the private downloads alone, whose session ends with it', async () => {
    const f = fixture()
    f.browser.state.settings.warnOnCloseWindow = false
    const first = firstWindow(f)
    f.browser.tabs.createTab({ url: 'https://a.test/', active: true }, first)
    const secret = f.browser.openWindow('private', first)
    if (!secret) throw new Error('no private window')
    f.browser.tabs.createTab({ url: 'https://p.test/', active: true }, secret)
    download(f, 'regular.zip')
    download(f, 'secret.zip', true)
    download(f, 'secret-two.zip', true)

    const closing = f.browser.requestWindowClose(secret)
    await tick()
    // The regular download goes on in the window that stays; the two private ones are asked about.
    expect(secret.prompt).toMatchObject({
      kind: 'close-tabs',
      count: 0,
      downloads: { count: 2, end: 'private-window' }
    })
    f.browser.windowPrompts.respond(secret.prompt!.id, true)
    await expect(closing).resolves.toBe(true)
    expect(f.closes.get(secret.id)).toBe(1)

    // A second private window keeps the session: its close asks nothing.
    const other = f.browser.openWindow('private', first)
    if (!other) throw new Error('no other private window')
    f.browser.tabs.createTab({ url: 'https://q.test/', active: true }, other)
    await expect(f.browser.requestWindowClose(other)).resolves.toBe(true)
    expect(other.prompt).toBeNull()
  })

  it('the private window’s count is the private downloads alone; the quit’s is every download (#357 B2)', async () => {
    const f = fixture()
    f.browser.state.settings.warnOnCloseWindow = false
    const first = firstWindow(f)
    f.browser.tabs.createTab({ url: 'https://a.test/', active: true }, first)
    const secret = f.browser.openWindow('private', first)
    if (!secret) throw new Error('no private window')
    f.browser.tabs.createTab({ url: 'https://p.test/', active: true }, secret)
    const regular = download(f, 'regular.zip')
    const hidden = download(f, 'secret.zip', true)

    // The last private window closing: one download ends with it, the regular one goes on.
    const closing = f.browser.requestWindowClose(secret)
    await tick()
    expect(secret.prompt).toMatchObject({
      kind: 'close-tabs',
      count: 0,
      downloads: { count: 1, end: 'private-window' }
    })
    f.browser.windowPrompts.respond(secret.prompt!.id, false)
    await expect(closing).resolves.toBe(false)
    expect(f.closes.get(secret.id)).toBeUndefined()
    expect(f.browser.downloads.item(regular)).toMatchObject({ state: 'progressing' })
    expect(f.browser.downloads.item(hidden)).toMatchObject({ state: 'progressing' })

    // Quitting ends both: the count is every download, from whichever window asks.
    const quitting = f.browser.requestQuit(first)
    await tick()
    expect(first.prompt).toMatchObject({
      kind: 'quit',
      count: 0,
      downloads: { count: 2, end: 'quit' }
    })
    f.browser.windowPrompts.respond(first.prompt!.id, false)
    await expect(quitting).resolves.toBe(false)
    expect(f.quits).toBe(0)
  })

  it('the tabs warning and the download question make one prompt', async () => {
    const f = fixture()
    const win = firstWindow(f)
    for (const url of ['https://a.test/', 'https://b.test/'])
      f.browser.tabs.createTab({ url, active: true }, win)
    download(f, 'one.zip')
    const closing = f.browser.requestWindowClose(win)
    await tick()
    expect(win.prompt).toMatchObject({
      kind: 'close-tabs',
      count: 2,
      downloads: { count: 1, end: 'quit' }
    })
    f.browser.windowPrompts.respond(win.prompt!.id, false)
    await expect(closing).resolves.toBe(false)
    // One question was asked and answered: nothing else is up.
    expect(win.prompt).toBeNull()
  })
})

describe('window prompts', () => {
  it('answers no to a question raised while another is up, and to a window that closed', async () => {
    const f = fixture()
    const win = firstWindow(f)
    const first = f.browser.windowPrompts.ask(win, 'close-tabs', 4)
    const second = f.browser.windowPrompts.ask(win, 'quit', 4)
    await expect(second).resolves.toBe(false)
    expect(win.prompt?.kind).toBe('close-tabs')
    // The chrome cannot answer a question that is not (or no longer) up.
    f.browser.windowPrompts.respond('prompt_missing', true)
    expect(win.prompt?.kind).toBe('close-tabs')
    f.browser.windowPrompts.cancelForWindow(win)
    await expect(first).resolves.toBe(false)
    expect(win.prompt).toBeNull()
  })
})

describe('back/forward stacks across unloads and launches', () => {
  const stack: NavigationSnapshot = {
    entries: [
      { url: 'https://example.com/', title: 'Home', pageState: 'c2Nyb2xs' },
      { url: 'https://example.com/article', title: 'Article', pageState: 'ZG93bg==' }
    ],
    index: 1
  }

  it('records the stack of a page that navigated and replays it when the unloaded tab is opened again', () => {
    const f = fixture()
    const win = firstWindow(f)
    const tab = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const first = f.viewOf(tab.id)
    first.snapshot = stack
    first.events.onNavigated('https://example.com/article', false)
    expect(f.browser.state.tabNavigation.get(tab.id)).toEqual(stack)

    f.browser.tabs.discard(tab.id)
    expect(f.browser.tabs.tab(tab.id)?.discarded).toBe(true)
    // The stack (with its page state) is what a reload brings back, not a bare URL.
    f.browser.tabs.ensureLoaded(tab.id)
    const second = f.viewOf(tab.id)
    expect(second).not.toBe(first)
    expect(second.restored).toEqual([stack])
    expect(second.view.getURL()).toBe('https://example.com/article')
  })

  it('a URL typed into an unloaded tab goes on top of its stack, forward entries dropped', () => {
    const f = fixture()
    const win = firstWindow(f)
    const tab = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    f.viewOf(tab.id).snapshot = { ...stack, index: 0 }
    f.browser.tabs.discard(tab.id)
    f.browser.tabs.navigate(tab.id, 'https://example.org/typed')
    const view = f.viewOf(tab.id)
    expect(view.restored).toEqual([
      {
        entries: [stack.entries[0], { url: 'https://example.org/typed', title: 'example.org' }],
        index: 1
      }
    ])
    expect(view.view.getURL()).toBe('https://example.org/typed')
  })

  it("the host's own serialisation of the stack rides along on a replay of the same list only", () => {
    const withHost: NavigationSnapshot = { ...stack, hostState: 'cGFyY2Vs' }
    const f = fixture()
    const win = firstWindow(f)
    const tab = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    f.viewOf(tab.id).snapshot = withHost
    f.viewOf(tab.id).events.onNavigated('https://example.com/article', false)
    expect(f.browser.state.tabNavigation.get(tab.id)).toEqual(withHost)
    f.browser.tabs.discard(tab.id)
    // The list the blob describes, replayed whole: the blob goes with it.
    f.browser.tabs.ensureLoaded(tab.id)
    expect(f.viewOf(tab.id).restored).toEqual([withHost])

    // A URL typed meanwhile changes the list, and the blob – another list's – stays behind.
    f.viewOf(tab.id).snapshot = withHost
    f.browser.tabs.discard(tab.id)
    f.browser.tabs.navigate(tab.id, 'https://example.org/typed')
    const replayed = f.viewOf(tab.id).restored[0]
    expect(replayed.entries.map((e) => e.url)).toEqual([
      'https://example.com/',
      'https://example.com/article',
      'https://example.org/typed'
    ])
    expect(replayed).not.toHaveProperty('hostState')
  })

  it('a private tab leaves no stack behind and a closed tab takes its stack with it', () => {
    const f = fixture()
    const win = firstWindow(f)
    const tab = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    f.viewOf(tab.id).snapshot = stack
    f.browser.tabs.discard(tab.id)
    expect(f.browser.state.tabNavigation.has(tab.id)).toBe(true)
    f.browser.tabs.closeTab(tab.id, true, win)
    expect(f.browser.state.tabNavigation.has(tab.id)).toBe(false)

    const priv = f.browser.tabs.createTab(
      { url: 'https://secret.test/', active: true, containerId: PRIVATE_CONTAINER_ID },
      win
    )
    f.viewOf(priv.id).snapshot = { entries: [{ url: 'https://secret.test/', title: '' }], index: 0 }
    f.viewOf(priv.id).events.onNavigated('https://secret.test/', false)
    f.browser.tabs.discard(priv.id)
    expect(f.browser.state.tabNavigation.has(priv.id)).toBe(false)
  })

  it('a graceful shutdown reads every open page once more before the last write', () => {
    const f = fixture()
    const win = firstWindow(f)
    const tab = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const view = f.viewOf(tab.id)
    view.snapshot = { ...stack, index: 0 }
    view.events.onNavigated('https://example.com/', false)
    // The user scrolled since: the engine's page state moved on.
    view.snapshot = stack
    f.browser.shutdown()
    expect(f.browser.state.tabNavigation.get(tab.id)).toEqual(stack)
  })
})
