import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { displayUrl, errorPageUrl, fullUrl } from '../../shared/url'
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

    const page = errorPageUrl(CRASH_ERROR_CODE, 'SIGSEGV', PAGE)
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
    expect(view.loads.at(-1)).toBe(errorPageUrl(CRASH_ERROR_CODE, 'RESULT_CODE_HUNG', PAGE))
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
    expect(view.loads.at(-1)).toBe(errorPageUrl(CRASH_ERROR_CODE, 'SIGTRAP', PAGE))
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
