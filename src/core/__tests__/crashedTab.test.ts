import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { crashPageUrl, displayUrl, errorPageUrl, fullUrl } from '../../shared/url'
import { CRASH_ERROR_CODE } from '../../shared/zenPages'
import { Browser } from '../browser'
import type {
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'

/*
 * The sad tab (tabs-44): a renderer that goes away in front of the user is replaced by the
 * crash page for the page it was showing, the row marked crashed until the next load; one that
 * goes away out of sight, or out of memory, is unloaded and reloads on activation as before.
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

interface Recorded {
  tabId: string
  readonly events: TabViewEvents
  readonly loads: string[]
  destroyed: boolean
}

interface Fixture {
  browser: Browser
  views: Recorded[]
  sent: Array<{ name: string; payload: unknown }>
}

function fixture(os: PlatformOs = 'linux'): Fixture {
  const views: Recorded[] = []
  const sent: Array<{ name: string; payload: unknown }> = []
  const capabilities = stub<HostCapabilities>({
    windows: true,
    updates: false,
    agents: false,
    newTabPage: false,
    pageTabs: false
  })
  const platform: Platform = {
    info: { os, version: '0.0.0' },
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
        const record: Recorded = { tabId: tab.id, events, loads: [], destroyed: false }
        views.push(record)
        let url = tab.url
        return stub<TabView>({
          isDestroyed: () => record.destroyed,
          isVisible: () => false,
          hasDocument: () => url !== '',
          getURL: () => url,
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          navigationEntries: () => ({ entries: [], index: -1 }),
          loadURL: (u: string) => {
            url = u
            record.loads.push(u)
          },
          destroy: () => {
            record.destroyed = true
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
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  return { browser, views, sent }
}

function viewOf(f: Fixture, tab: Tab): Recorded {
  const record = f.views.find((v) => v.tabId === tab.id && !v.destroyed)
  if (!record) throw new Error(`no live view for ${tab.url}`)
  return record
}

function toasts(f: Fixture): string[] {
  return f.sent
    .filter((e) => e.name === 'toast')
    .map((e) => (e.payload as { message: string }).message)
}

const PAGE = 'https://crashed.example/article?id=7'
/**
 * The accent the core writes into every error page's URL (§9.11): the fixture's space has no
 * theme, so it is the default theme's, per scheme (`resolveTheme(null, dark).accent`).
 */
const ACCENT = { light: '#6264dc', dark: '#8284f0' }

describe('a renderer that goes away in front of the user', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shows the crash page for the page the tab held and marks the row crashed', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    view.events.onNavigated(PAGE, false)
    view.events.onTitleUpdated('The article')
    f.sent.length = 0

    view.events.onCrashed('crashed', 11)

    const page = errorPageUrl(CRASH_ERROR_CODE, 'SIGSEGV', PAGE, null, ACCENT)
    expect(view.loads.at(-1)).toBe(page)
    const after = f.browser.tabs.tab(tab.id)!
    expect(after.errorCode).toBe(CRASH_ERROR_CODE)
    expect(after.discarded).toBe(false)
    expect(after.loading).toBe(false)
    // The page is the message: nothing doubles it.
    expect(toasts(f)).toEqual([])

    // The crash page commits: the tab's address is the page it stands in for, in the omnibox
    // and for copying, the row stays crashed and keeps the page's title (the crash page's own
    // title, the site, is not taken up), as Chrome's strip does.
    view.events.onNavigated(page, false)
    view.events.onTitleUpdated('crashed.example')
    const shown = f.browser.tabs.tab(tab.id)!
    expect(shown.errorCode).toBe(CRASH_ERROR_CODE)
    expect(f.browser.tabs.isSadTab(shown)).toBe(true)
    expect(shown.title).toBe('The article')
    expect(displayUrl(shown.url)).toBe('crashed.example/article?id=7')
    expect(fullUrl(shown.url)).toBe(PAGE)
    expect(f.browser.tabs.errorPageTarget(tab.id)).toBe(PAGE)
    // History keeps the page's visit and never the crash page.
    expect(f.browser.history.recent(10).map((e) => e.url)).toEqual([PAGE])

    // Reload commits the page again: the mark goes and titles are the page's again.
    view.events.onStartLoading()
    expect(f.browser.tabs.tab(tab.id)!.loading).toBe(true)
    view.events.onNavigated(PAGE, false)
    view.events.onTitleUpdated('The article, reloaded')
    const reloaded = f.browser.tabs.tab(tab.id)!
    expect(reloaded.errorCode).toBeNull()
    expect(f.browser.tabs.isSadTab(reloaded)).toBe(false)
    expect(reloaded.url).toBe(PAGE)
    expect(reloaded.title).toBe('The article, reloaded')
  })

  it("writes the code line the way the host's platform names the end", () => {
    const f = fixture('win32')
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    view.events.onNavigated(PAGE, false)
    // `forcefullyCrashRenderer` on Windows and macOS shuts the renderer down as hung.
    view.events.onCrashed('killed', 2)
    expect(view.loads.at(-1)).toBe(
      errorPageUrl(CRASH_ERROR_CODE, 'RESULT_CODE_HUNG', PAGE, null, ACCENT)
    )
  })

  it('stands in for the page a crashed error page stood in for, never for itself', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    view.events.onNavigated(PAGE, false)
    view.events.onCrashed('crashed', 11)
    view.events.onNavigated(view.loads.at(-1)!, false)
    view.events.onCrashed('crashed', 5)
    expect(view.loads.at(-1)).toBe(errorPageUrl(CRASH_ERROR_CODE, 'SIGTRAP', PAGE, null, ACCENT))
  })

  it("shows the memory variant for a renderer the system killed in front of the user (Android's !didCrash)", () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    view.events.onNavigated(PAGE, false)
    f.sent.length = 0

    view.events.onCrashed('oom-kill')

    // A page in front is offered again, not unloaded: the crash page says why it went.
    expect(view.loads.at(-1)).toBe(
      crashPageUrl('Out of Memory', PAGE, { variant: 'memory', accent: ACCENT })
    )
    const after = f.browser.tabs.tab(tab.id)!
    expect(after.discarded).toBe(false)
    expect(after.errorCode).toBe(CRASH_ERROR_CODE)
    expect(toasts(f)).toEqual([])
  })

  it('unloads a hidden tab the system killed for memory, saying so, like any other hidden loss', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    f.browser.tabs.createTab({ url: 'https://shown.example/', active: true }, win)
    const hidden = f.browser.tabs.createTab({ url: PAGE, active: false }, win)
    f.browser.tabs.load(hidden.id, win)
    const view = viewOf(f, hidden)
    view.events.onNavigated(PAGE, false)
    f.sent.length = 0

    view.events.onCrashed('oom-kill')

    expect(f.browser.tabs.tab(hidden.id)!.discarded).toBe(true)
    expect(view.loads.some((u) => u.startsWith('zen://error'))).toBe(false)
    expect(toasts(f)).toEqual([`"crashed.example" ran out of memory and was unloaded.`])
  })

  it('shows the hung variant for a page the user ended for not responding', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    view.events.onNavigated(PAGE, false)

    view.events.onCrashed('hung')

    expect(view.loads.at(-1)).toBe(
      crashPageUrl('RESULT_CODE_HUNG', PAGE, { variant: 'hung', accent: ACCENT })
    )
  })

  it("marks a repeat within the minute on the host's word, so the page suggests closing other tabs", () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    view.events.onNavigated(PAGE, false)

    view.events.onCrashed('crashed', undefined, { repeat: true })

    const page = crashPageUrl('CRASHED', PAGE, { variant: 'crash', repeat: true, accent: ACCENT })
    expect(view.loads.at(-1)).toBe(page)
    expect(page).toContain('repeat=1')
    // A first crash carries neither parameter: the URL is the plain crash page's.
    expect(crashPageUrl('CRASHED', PAGE)).toBe(errorPageUrl(CRASH_ERROR_CODE, 'CRASHED', PAGE))
  })

  it("writes the tab's own theme accent into the page's URL, and the private window's in a private tab (§9.11)", () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    // A themed space: the accent is the theme's primary colour in both schemes.
    const space = win.activeSpace()
    space.theme = {
      type: 'gradient',
      colors: [{ c: [96, 110, 235], x: 0.3, y: 0.35, isPrimary: true }],
      opacity: 0.55,
      texture: 0,
      algorithm: 'floating',
      monochrome: false,
      rotation: 40
    }
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    expect(f.browser.tabs.errorPageAccent(tab.id)).toEqual({ light: '#606eeb', dark: '#606eeb' })
    const view = viewOf(f, tab)
    view.events.onNavigated(PAGE, false)
    view.events.onCrashed('crashed')
    expect(view.loads.at(-1)).toContain('&accent=606eeb&accentDark=606eeb')

    // A private tab: the private window's accent, the one its new tab page takes.
    const priv = f.browser.createWindow({ kind: 'private', from: win })
    const secret = f.browser.tabs.createTab({ url: PAGE, active: true }, priv)
    expect(f.browser.tabs.errorPageAccent(secret.id)).toEqual({ light: '#a98bff', dark: '#a98bff' })

    // A tab the core no longer has: the default theme's, never a throw.
    expect(f.browser.tabs.errorPageAccent('gone')).toEqual(ACCENT)
  })

  it('does nothing for a clean exit', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    view.events.onNavigated(PAGE, false)
    const loads = view.loads.length
    view.events.onCrashed('clean-exit', 0)
    expect(view.loads).toHaveLength(loads)
    expect(f.browser.tabs.tab(tab.id)!.errorCode).toBeNull()
  })
})

describe('a renderer that goes away out of sight or out of memory', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('unloads a hidden tab and says so, no crash page', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    f.browser.tabs.createTab({ url: 'https://shown.example/', active: true }, win)
    const hidden = f.browser.tabs.createTab({ url: PAGE, active: false }, win)
    f.browser.tabs.load(hidden.id, win)
    const view = viewOf(f, hidden)
    view.events.onNavigated(PAGE, false)
    f.sent.length = 0

    view.events.onCrashed('crashed', 11)

    const after = f.browser.tabs.tab(hidden.id)!
    expect(after.discarded).toBe(true)
    expect(after.errorCode).toBeNull()
    expect(after.url).toBe(PAGE)
    expect(view.loads.some((u) => u.startsWith('zen://error'))).toBe(false)
    expect(toasts(f)).toEqual([`"crashed.example" crashed and was unloaded.`])

    // Activation loads the page again.
    f.browser.tabs.activateTab(hidden.id, win)
    expect(f.browser.tabs.tab(hidden.id)!.discarded).toBe(false)
    expect(viewOf(f, hidden).tabId).toBe(hidden.id)
  })

  it('unloads a shown tab that ran out of memory rather than show a page', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    view.events.onNavigated(PAGE, false)
    f.sent.length = 0

    view.events.onCrashed('oom', 0)

    const after = f.browser.tabs.tab(tab.id)!
    expect(after.discarded).toBe(true)
    expect(after.errorCode).toBeNull()
    expect(view.loads.some((u) => u.startsWith('zen://error'))).toBe(false)
    expect(toasts(f)).toEqual([`"crashed.example" ran out of memory and was unloaded.`])
  })
})
