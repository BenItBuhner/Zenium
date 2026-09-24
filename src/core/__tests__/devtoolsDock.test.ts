import { describe, expect, it } from 'vitest'
import type { DevtoolsDock, HostCapabilities } from '../../shared/types'
import { Browser } from '../browser'
import type {
  AppHost,
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'
import type { ZenWindow } from '../window'

/*
 * Where each tab's toolbox stands (design language v2 §9.29; the lead's rulings 5 and 6 on
 * #414). The host reports the dock per view – the one it opened the toolbox at, then every move
 * the toolbox's own buttons make – and the core keeps it on the tab (`Tab.devtools`), so the
 * frame follows the toolbox in the tab in front rather than the one setting for every toolbox.
 * The setting stays the default for the next opening, and a toolbox is a session's own: never
 * written to the profile.
 */

function memoryIo(): StoreIO & { writes: string[] } {
  const io = {
    writes: [] as string[],
    readSync: () => null,
    write: async (_name: string, text: string) => {
      io.writes.push(text)
    },
    writeSync: (_name: string, text: string) => {
      io.writes.push(text)
    }
  }
  return io
}

/** Anything the browser touches on the host answers with a harmless no-op. */
function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

interface Page {
  events: TabViewEvents
  calls: string[]
}

/** A desktop host with developer tools, whose pages record what they are told about their toolbox. */
function fakePlatform(io: StoreIO): Platform & { pages: Map<string, Page> } {
  const pages = new Map<string, Page>()
  const capabilities = stub<HostCapabilities>({
    windows: true,
    devtools: true,
    updates: false,
    agents: false,
    pageControls: false,
    darkenSites: false
  })
  return {
    pages,
    info: { os: 'linux', version: '0.0.0' },
    capabilities,
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
      createView: (tab, events) => {
        const page: Page = { events, calls: [] }
        pages.set(tab.id, page)
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => true,
          getZoom: () => 1,
          openDevTools: (mode: string, dock: DevtoolsDock) =>
            void page.calls.push(`openDevTools(${mode},${dock})`),
          setDevtoolsDock: (dock: DevtoolsDock) => void page.calls.push(`setDevtoolsDock(${dock})`)
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
    app: stub<AppHost>(),
    readabilitySource: () => null
  }
}

function start(): {
  browser: Browser
  platform: ReturnType<typeof fakePlatform>
  io: ReturnType<typeof memoryIo>
  win: ZenWindow
  open: (url: string) => { id: string; page: Page }
} {
  const io = memoryIo()
  const platform = fakePlatform(io)
  const browser = new Browser(platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  const open = (url: string): { id: string; page: Page } => {
    const tab = browser.tabs.createTab({ url, active: true }, win)
    return { id: tab.id, page: platform.pages.get(tab.id)! }
  }
  return { browser, platform, io, win, open }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('where each tab’s toolbox stands (v2 §9.29)', () => {
  it('reads the dock back per view: tab A’s toolbox docked at the bottom, tab B’s undocked, each tab carries its own', () => {
    const { browser, open } = start()
    const a = open('https://a.example/')
    const b = open('https://b.example/')
    expect(browser.tabs.tab(a.id)?.devtools).toBeUndefined()
    a.page.events.onDevtoolsOpened('bottom')
    b.page.events.onDevtoolsOpened('undocked')
    expect(browser.tabs.tab(a.id)?.devtools).toEqual({ dock: 'bottom' })
    expect(browser.tabs.tab(b.id)?.devtools).toEqual({ dock: 'undocked' })
    expect([...browser.state.devtoolsOpenFor]).toEqual([a.id, b.id])
    // The setting is the default for the next opening, not what either toolbox did.
    expect(browser.state.settings.devtoolsDock).toBe('bottom')
    // B's own dock button: B has moved, A stands where it was, the choice is remembered.
    b.page.events.onDevtoolsDockChanged?.('left')
    expect(browser.tabs.tab(b.id)?.devtools).toEqual({ dock: 'left' })
    expect(browser.tabs.tab(a.id)?.devtools).toEqual({ dock: 'bottom' })
    expect(browser.state.settings.devtoolsDock).toBe('left')
    // Closed, the tab carries no toolbox.
    a.page.events.onDevtoolsClosed()
    expect(browser.tabs.tab(a.id)?.devtools).toBeNull()
    expect([...browser.state.devtoolsOpenFor]).toEqual([b.id])
    expect(browser.tabs.tab(b.id)?.devtools).toEqual({ dock: 'left' })
  })

  it('the window’s state carries each tab’s toolbox, so the chrome in front of tab A reads A’s dock and in front of tab B reads B’s', () => {
    const { browser, win, open } = start()
    const a = open('https://a.example/')
    const b = open('https://b.example/')
    a.page.events.onDevtoolsOpened('bottom')
    b.page.events.onDevtoolsOpened('undocked')
    const inFront = (): { active: string; dock: DevtoolsDock | undefined } => {
      const ui = browser.state.snapshot(win)
      const active = ui.spaces.find((s) => s.id === ui.activeSpaceId)!.activeTabId!
      return { active, dock: ui.tabs[active]?.devtools?.dock }
    }
    expect(inFront()).toEqual({ active: b.id, dock: 'undocked' })
    browser.tabs.activateTab(a.id, win)
    expect(inFront()).toEqual({ active: a.id, dock: 'bottom' })
    browser.tabs.activateTab(b.id, win)
    expect(inFront()).toEqual({ active: b.id, dock: 'undocked' })
    expect(browser.state.snapshot(win).devtoolsOpenFor).toEqual([a.id, b.id])
  })

  it('opens at the remembered dock, the default, and a host that cannot say where it opened is read at the setting', () => {
    const { browser, win, open } = start()
    const a = open('https://a.example/')
    browser.tabs.toggleDevtools(a.id)
    expect(a.page.calls).toEqual(['openDevTools(toggle,bottom)'])
    a.page.events.onDevtoolsOpened()
    expect(browser.tabs.tab(a.id)?.devtools).toEqual({ dock: 'bottom' })
    a.page.events.onDevtoolsClosed()
    // The menu's choice for the next opening.
    browser.tabs.setDevtoolsDock('right', win)
    const b = open('https://b.example/')
    browser.tabs.toggleDevtools(b.id)
    expect(b.page.calls).toEqual(['openDevTools(toggle,right)'])
    b.page.events.onDevtoolsOpened()
    expect(browser.tabs.tab(b.id)?.devtools).toEqual({ dock: 'right' })
    // The host's own reading wins over the setting where the two differ.
    browser.tabs.toggleDevtools(a.id)
    a.page.events.onDevtoolsOpened('undocked')
    expect(browser.tabs.tab(a.id)?.devtools).toEqual({ dock: 'undocked' })
    expect(browser.state.settings.devtoolsDock).toBe('right')
  })

  it('the app menu’s row moves every open toolbox and each tab’s reading takes the dock at once; the read-back confirms it', () => {
    const { browser, win, open } = start()
    const a = open('https://a.example/')
    const b = open('https://b.example/')
    a.page.events.onDevtoolsOpened('bottom')
    b.page.events.onDevtoolsOpened('undocked')
    a.page.calls.length = 0
    b.page.calls.length = 0
    browser.tabs.setDevtoolsDock('right', win)
    expect(a.page.calls).toEqual(['setDevtoolsDock(right)'])
    expect(b.page.calls).toEqual(['setDevtoolsDock(right)'])
    expect(browser.tabs.tab(a.id)?.devtools).toEqual({ dock: 'right' })
    expect(browser.tabs.tab(b.id)?.devtools).toEqual({ dock: 'right' })
    a.page.events.onDevtoolsDockChanged?.('right')
    b.page.events.onDevtoolsDockChanged?.('right')
    expect(browser.tabs.tab(a.id)?.devtools).toEqual({ dock: 'right' })
    expect(browser.state.settings.devtoolsDock).toBe('right')
    // A read-back for a tab with no toolbox up is remembered alone: the tab takes no toolbox.
    a.page.events.onDevtoolsClosed()
    a.page.events.onDevtoolsDockChanged?.('left')
    expect(browser.tabs.tab(a.id)?.devtools).toBeNull()
    expect(browser.state.settings.devtoolsDock).toBe('left')
  })

  it('a toolbox goes with its page: a discarded tab carries none, and none is written to the profile – not on the tab, not in a Recently Closed entry', async () => {
    const { browser, io, win, open } = start()
    const a = open('https://a.example/')
    const b = open('https://b.example/')
    const c = open('https://c.example/')
    a.page.events.onDevtoolsOpened('bottom')
    b.page.events.onDevtoolsOpened('right')
    c.page.events.onDevtoolsOpened('left')
    browser.tabs.discard(a.id)
    expect(browser.tabs.tab(a.id)?.devtools).toBeNull()
    expect([...browser.state.devtoolsOpenFor]).toEqual([b.id, c.id])
    // C closes with its toolbox up: the entry that reopens it carries no toolbox.
    browser.tabs.closeTab(c.id, false, win)
    expect([...browser.state.devtoolsOpenFor]).toEqual([b.id])
    await tick()
    await browser.state.flush()
    const written = JSON.parse(io.writes[io.writes.length - 1]) as {
      tabs: Array<{ id: string } & Record<string, unknown>>
      recentlyClosed: Array<{ kind: string; tab?: Record<string, unknown> }>
    }
    const records = written.tabs.filter((t) => t.id === a.id || t.id === b.id)
    expect(records).toHaveLength(2)
    for (const record of records) expect('devtools' in record).toBe(false)
    const closed = written.recentlyClosed.find((e) => e.kind === 'tab' && e.tab?.id === c.id)
    expect(closed).toBeDefined()
    expect('devtools' in closed!.tab!).toBe(false)
    // In memory B's toolbox still stands where it was.
    expect(browser.tabs.tab(b.id)?.devtools).toEqual({ dock: 'right' })
  })

  it('the window’s set is cleared the moment a page’s view goes, the tab’s own reading a step later: the set is the one truth for “open”', () => {
    // Every teardown path (a discard, a close, a window's release, the host's own going) runs
    // through `destroyView`, which drops the tab from `devtoolsOpenFor`; the tab's reading is
    // nulled by the path that follows. For that step the two disagree – the chrome's read
    // (`lib/contentRadius.ts`'s `devtoolsDockOf`) takes the set first and never reports a dock
    // the set does not back, so the frame and the cover never see a toolbox that has gone.
    const { browser, win, open } = start()
    const a = open('https://a.example/')
    const b = open('https://b.example/')
    a.page.events.onDevtoolsOpened('bottom')
    b.page.events.onDevtoolsOpened('right')
    browser.tabs.destroyView(a.id)
    expect([...browser.state.devtoolsOpenFor]).toEqual([b.id])
    const ui = browser.state.snapshot(win)
    expect(ui.devtoolsOpenFor).toEqual([b.id])
    expect(ui.tabs[a.id]?.devtools).toEqual({ dock: 'bottom' })
    // The path that follows squares the two (here the discard's).
    browser.tabs.discard(a.id)
    expect(browser.tabs.tab(a.id)?.devtools).toBeNull()
    expect([...browser.state.devtoolsOpenFor]).toEqual([b.id])
    expect(browser.tabs.tab(b.id)?.devtools).toEqual({ dock: 'right' })
  })
})
