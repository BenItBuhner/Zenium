import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { crashPageUrl } from '../../shared/url'
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
 * The "Page unresponsive" prompt's core (tabs-45, Chrome's hung-renderer dialog): the host's
 * hang monitor marks a tab whose renderer stopped answering (`Tab.unresponsive`) and clears it
 * when the page answers again; the chrome's Wait drops the mark until the host asks again; its
 * Exit page ends the renderer, and the crash that follows reads as a page ended for not
 * responding – the crash page's `hung` words in front, a silent unload out of sight. A
 * navigation's commit and an unload clear the mark too, and the persisted record never carries
 * it.
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
  /** How many times the core asked the host to end this page's renderer. */
  ended: number
  destroyed: boolean
}

interface Fixture {
  browser: Browser
  views: Recorded[]
  sent: Array<{ name: string; payload: unknown }>
  files: Record<string, string>
}

/** `canEnd: false` is a host without a hang monitor's kill (Android's WebView): no `endRenderer`. */
function fixture(os: PlatformOs = 'linux', canEnd = true): Fixture {
  const views: Recorded[] = []
  const sent: Array<{ name: string; payload: unknown }> = []
  const files: Record<string, string> = {}
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
    io: memoryIo(files),
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
        const record: Recorded = { tabId: tab.id, events, loads: [], ended: 0, destroyed: false }
        views.push(record)
        let url = tab.url
        const view: Partial<TabView> = {
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
        }
        // The stub answers every method; a host without the kill leaves it out, spelt here as
        // an own `undefined` so the proxy reports the absence rather than answering for it.
        view.endRenderer = canEnd
          ? () => {
              record.ended += 1
            }
          : undefined
        return stub<TabView>(view)
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
  return { browser, views, sent, files }
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

const PAGE = 'https://hung.example/editor'
const OTHER = 'https://other.example/'
/** The default theme's accent per scheme: the fixture's space has no theme (§9.11). */
const ACCENT = { light: '#6264dc', dark: '#8284f0' }

describe('a page whose renderer stopped answering', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("is marked on the host's word and cleared when the page answers again", () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    view.events.onNavigated(PAGE, false)
    expect(f.browser.tabs.tab(tab.id)!.unresponsive).toBeUndefined()

    view.events.onUnresponsive!()
    expect(f.browser.tabs.tab(tab.id)!.unresponsive).toBe(true)

    // The page answers: the mark is gone, not false – the field is absent as on a record that
    // never had it.
    view.events.onResponsive!()
    const after = f.browser.tabs.tab(tab.id)!
    expect(after.unresponsive).toBeUndefined()
    expect(after).not.toHaveProperty('unresponsive')
    // A page answering that was never marked changes nothing.
    view.events.onResponsive!()
    expect(f.browser.tabs.tab(tab.id)!).not.toHaveProperty('unresponsive')
  })

  it("is cleared by the prompt's Wait, and marked again when the host reports the hang again", () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    view.events.onNavigated(PAGE, false)
    view.events.onUnresponsive!()

    f.browser.handleCommand(win, 'tab.waitUnresponsive', { tabIds: [tab.id] })
    expect(f.browser.tabs.tab(tab.id)!.unresponsive).toBeUndefined()
    // Waiting ends nothing: the page is left to come back on its own.
    expect(view.ended).toBe(0)
    expect(f.browser.tabs.tab(tab.id)!.discarded).toBe(false)

    view.events.onUnresponsive!()
    expect(f.browser.tabs.tab(tab.id)!.unresponsive).toBe(true)
  })

  it("is cleared by a navigation's commit, never by an in-page one", () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    view.events.onNavigated(PAGE, false)
    view.events.onUnresponsive!()

    view.events.onNavigated(`${PAGE}#part`, true)
    expect(f.browser.tabs.tab(tab.id)!.unresponsive).toBe(true)
    view.events.onNavigated(OTHER, false)
    expect(f.browser.tabs.tab(tab.id)!.unresponsive).toBeUndefined()
  })

  it('is cleared when the tab is unloaded: a sleeping page has no renderer to be hung', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    f.browser.tabs.createTab({ url: OTHER, active: true }, win)
    const tab = f.browser.tabs.createTab({ url: PAGE, active: false }, win)
    f.browser.tabs.load(tab.id, win)
    viewOf(f, tab).events.onNavigated(PAGE, false)
    viewOf(f, tab).events.onUnresponsive!()
    expect(f.browser.tabs.tab(tab.id)!.unresponsive).toBe(true)

    f.browser.tabs.discard(tab.id)
    const after = f.browser.tabs.tab(tab.id)!
    expect(after.discarded).toBe(true)
    expect(after.unresponsive).toBeUndefined()
  })

  it("is the session's own: the persisted record never carries it", () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    viewOf(f, tab).events.onNavigated(PAGE, false)
    viewOf(f, tab).events.onUnresponsive!()
    expect(f.browser.tabs.tab(tab.id)!.unresponsive).toBe(true)

    f.browser.state.flushSync()
    const state = f.files['state.json']
    if (!state) throw new Error('state.json was not written')
    const persisted = JSON.parse(state) as { tabs: Array<Record<string, unknown>> }
    const record = persisted.tabs.find((t) => t.id === tab.id)
    expect(record).toBeDefined()
    expect(record).not.toHaveProperty('unresponsive')
  })
})

describe("the prompt's Exit page", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("ends the renderer, and the crash that follows in front is the crash page's hung words with the code the process died of", () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    view.events.onNavigated(PAGE, false)
    view.events.onTitleUpdated('The editor')
    view.events.onUnresponsive!()
    f.sent.length = 0

    f.browser.handleCommand(win, 'tab.exitUnresponsive', { tabIds: [tab.id] })
    expect(view.ended).toBe(1)
    // The kill is the host's to report: until it does, the page stands, its mark on it.
    expect(f.browser.tabs.tab(tab.id)!.unresponsive).toBe(true)
    expect(f.browser.tabs.tab(tab.id)!.discarded).toBe(false)

    // Electron on Linux ends a hung renderer with a forced crash (Chrome's own way there):
    // `crashed`, SIGTRAP. The words are the hung variant's; the code line is the process's.
    view.events.onCrashed('crashed', 5)
    expect(view.loads.at(-1)).toBe(
      crashPageUrl('SIGTRAP', PAGE, { variant: 'hung', accent: ACCENT })
    )
    const after = f.browser.tabs.tab(tab.id)!
    expect(after.errorCode).toBe(CRASH_ERROR_CODE)
    expect(after.discarded).toBe(false)
    expect(after.unresponsive).toBeUndefined()
    // The prompt was the word: no toast doubles it.
    expect(toasts(f)).toEqual([])
    // The crash page commits: a sad tab for the page, its title kept.
    view.events.onNavigated(view.loads.at(-1)!, false)
    expect(f.browser.tabs.isSadTab(f.browser.tabs.tab(tab.id)!)).toBe(true)
    expect(f.browser.tabs.tab(tab.id)!.title).toBe('The editor')
  })

  it("reads Windows' and macOS' RESULT_CODE_HUNG on the code line, as Chrome's sad tab does", () => {
    const f = fixture('win32')
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    view.events.onNavigated(PAGE, false)
    view.events.onUnresponsive!()

    f.browser.tabs.exitUnresponsive([tab.id])
    view.events.onCrashed('killed', 2)
    expect(view.loads.at(-1)).toBe(
      crashPageUrl('RESULT_CODE_HUNG', PAGE, { variant: 'hung', accent: ACCENT })
    )
  })

  it('unloads a page ended out of sight without a word: the prompt was the word', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const front = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const hidden = f.browser.tabs.createTab({ url: OTHER, active: false }, win)
    f.browser.tabs.load(hidden.id, win)
    const frontView = viewOf(f, front)
    const hiddenView = viewOf(f, hidden)
    frontView.events.onNavigated(PAGE, false)
    hiddenView.events.onNavigated(OTHER, false)
    // The two share the hung renderer: the host reports both.
    frontView.events.onUnresponsive!()
    hiddenView.events.onUnresponsive!()
    f.sent.length = 0

    f.browser.tabs.exitUnresponsive([front.id, hidden.id])
    expect(frontView.ended).toBe(1)
    expect(hiddenView.ended).toBe(1)

    hiddenView.events.onCrashed('crashed', 5)
    const after = f.browser.tabs.tab(hidden.id)!
    expect(after.discarded).toBe(true)
    expect(after.unresponsive).toBeUndefined()
    expect(after.errorCode).toBeNull()
    expect(hiddenView.loads.some((u) => u.startsWith('zen://error'))).toBe(false)
    expect(toasts(f)).toEqual([])

    frontView.events.onCrashed('crashed', 5)
    expect(frontView.loads.at(-1)).toBe(
      crashPageUrl('SIGTRAP', PAGE, { variant: 'hung', accent: ACCENT })
    )
    // A crash out of sight that the user did not ask for still says so.
    f.browser.tabs.activateTab(hidden.id, win)
    const fresh = viewOf(f, hidden)
    fresh.events.onNavigated(OTHER, false)
    f.browser.tabs.activateTab(front.id, win)
    fresh.events.onCrashed('crashed', 11)
    expect(toasts(f)).toEqual([`"other.example" crashed and was unloaded.`])
  })

  it('ends nothing for a tab that is not marked, or one whose page answered meanwhile', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    view.events.onNavigated(PAGE, false)

    f.browser.tabs.exitUnresponsive([tab.id, 'gone'])
    expect(view.ended).toBe(0)

    view.events.onUnresponsive!()
    view.events.onResponsive!()
    f.browser.tabs.exitUnresponsive([tab.id])
    expect(view.ended).toBe(0)
    // A crash later is a crash: the user ended nothing.
    view.events.onCrashed('crashed', 5)
    expect(view.loads.at(-1)).toBe(
      crashPageUrl('SIGTRAP', PAGE, { variant: 'crash', accent: ACCENT })
    )
  })

  it("forgets the user's word when the page commits a document instead: the kill never came", () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    view.events.onNavigated(PAGE, false)
    view.events.onUnresponsive!()
    f.browser.tabs.exitUnresponsive([tab.id])
    expect(view.ended).toBe(1)

    view.events.onNavigated(OTHER, false)
    expect(f.browser.tabs.tab(tab.id)!.unresponsive).toBeUndefined()
    view.events.onCrashed('crashed', 11)
    expect(view.loads.at(-1)).toBe(
      crashPageUrl('SIGSEGV', OTHER, { variant: 'crash', accent: ACCENT })
    )
  })

  it('drops the mark on a host that cannot end a renderer, so the prompt goes', () => {
    const f = fixture('linux', false)
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const view = viewOf(f, tab)
    view.events.onNavigated(PAGE, false)
    view.events.onUnresponsive!()
    expect(f.browser.tabs.tab(tab.id)!.unresponsive).toBe(true)

    f.browser.tabs.exitUnresponsive([tab.id])
    const after = f.browser.tabs.tab(tab.id)!
    expect(after.unresponsive).toBeUndefined()
    expect(after.discarded).toBe(false)
    expect(view.loads.some((u) => u.startsWith('zen://error'))).toBe(false)
  })
})
