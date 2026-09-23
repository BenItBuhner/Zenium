import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Tab } from '../../shared/types'
import { Browser } from '../browser'
import type { KeyEventInput, Platform, StoreIO, TabView, TabViewEvents, TabViewHost, WindowHost } from '../platform'

/*
 * Stopping a page that never answers (BUG-009, shortcuts-menus-73): the server accepts the
 * connection and never writes, so the navigation hangs before its document commits. Chromium
 * (Electron 44 / Chromium 152, measured) aborts that navigation from `webContents.stop()` and
 * reports it with `did-stop-loading` alone, synchronously; `did-fail-load` is not emitted for
 * ERR_ABORTED. The host below behaves exactly so, and the tests drive the two shapes of the hang
 * — a committed page leaving for a dead address, and a fresh tab's first navigation with no
 * document yet — through every way the user has of stopping: the Stop button's command, Escape
 * in the page, ⌘. on macOS and the `nav.stop` action.
 */

function memoryIo(files: Record<string, string> = {}): StoreIO {
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

/** A page whose server hangs: what Chromium tells the tab, in Chromium's order. */
interface HangingPage {
  tabId: string
  readonly events: TabViewEvents
  /** How often the tab asked the page to stop. */
  stops: number
  /** Whether the frame is loading, as `webContents.isLoading()` would say. */
  loading: boolean
  /** The address of the navigation that hangs, once one does. */
  hanging: string | null
  /**
   * A host that reports the aborted request as a failed load too (Android's WebView does, with
   * its ERROR_UNKNOWN; Electron filters ERR_ABORTED). Off by default: Chromium's shape.
   */
  reportsAbort: boolean
  /** The server answers after all: the document commits and the load finishes. */
  answer(): void
}

interface Fixture {
  browser: Browser
  pages: HangingPage[]
}

function fixture(os: 'linux' | 'darwin' = 'linux'): Fixture {
  const pages: HangingPage[] = []
  const platform: Platform = {
    info: { os, version: '0.0.0' },
    capabilities: stub<HostCapabilities>({ windows: true, nativeMenus: true }),
    io: memoryIo(),
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
      createView: (tab: Tab, events: TabViewEvents) => {
        let committed = ''
        const page: HangingPage = {
          tabId: tab.id,
          events,
          stops: 0,
          loading: false,
          hanging: null,
          reportsAbort: false,
          answer() {
            if (!page.hanging) throw new Error('nothing is hanging')
            committed = page.hanging
            page.hanging = null
            events.onNavigated(committed, false)
            page.loading = false
            events.onStopLoading()
          }
        }
        pages.push(page)
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => true,
          hasDocument: () => committed !== '',
          getURL: () => committed,
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          navigationEntries: () => ({ entries: [], index: -1 }),
          // `loadURL` towards a server that never writes: the frame starts loading (when it was
          // not already) and the navigation starts; the response never comes, so nothing else.
          loadURL: (url: string) => {
            if (!page.loading) {
              page.loading = true
              events.onStartLoading()
            }
            page.hanging = url
            events.onStartNavigation?.(url, false)
          },
          // `webContents.stop()` on a navigation still waiting for its first byte: Chromium
          // aborts it and emits `did-stop-loading` before `stop()` returns. ERR_ABORTED is
          // filtered, so no `did-fail-load`; a frame that is not loading gets nothing at all.
          stop: () => {
            page.stops++
            if (!page.loading) return
            const url = page.hanging
            page.loading = false
            page.hanging = null
            if (page.reportsAbort && url) events.onFailLoad(-3, 'ERR_ABORTED', url)
            events.onStopLoading()
          }
        })
      }
    }),
    menus: { popup: () => undefined },
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
  return { browser, pages }
}

const PAGE = 'https://committed.example/article'
const DEAD = 'http://127.0.0.1:9/never-answers'

function pageOf(f: Fixture, tabId: string): HangingPage {
  const page = f.pages.find((p) => p.tabId === tabId)
  if (!page) throw new Error(`no page for ${tabId}`)
  return page
}

/** Shape (a): a committed page, whose user then goes to an address that never answers. */
function committedPageLeaving(f: Fixture): { tab: () => Tab; page: HangingPage } {
  const win = f.browser.focusedWindow()
  const created = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
  const page = pageOf(f, created.id)
  page.answer()
  expect(f.browser.tabs.tab(created.id)!.loading).toBe(false)
  f.browser.tabs.navigate(created.id, DEAD)
  return { tab: () => f.browser.tabs.tab(created.id)!, page }
}

/** Shape (b): a new tab whose first navigation hangs; it has no document. */
function firstNavigation(f: Fixture): { tab: () => Tab; page: HangingPage } {
  const win = f.browser.focusedWindow()
  const created = f.browser.tabs.createTab({ url: DEAD, active: true }, win)
  return { tab: () => f.browser.tabs.tab(created.id)!, page: pageOf(f, created.id) }
}

const shapes = [
  ['a committed page leaving for a dead address', committedPageLeaving],
  ["a new tab's first navigation, with no document yet", firstNavigation]
] as const

function escape(): KeyEventInput {
  return {
    type: 'keyDown',
    key: 'Escape',
    control: false,
    alt: false,
    shift: false,
    meta: false,
    isAutoRepeat: false
  }
}

function commandPeriod(): KeyEventInput {
  return {
    type: 'keyDown',
    key: '.',
    control: false,
    alt: false,
    shift: false,
    meta: true,
    isAutoRepeat: false
  }
}

describe.each(shapes)('stopping a page that never answers: %s', (_shape, hang) => {
  it('hangs waiting, with the row spinning', () => {
    const f = fixture()
    const { tab, page } = hang(f)
    expect(page.hanging).toBe(DEAD)
    expect(tab().loading).toBe(true)
    expect(tab().waiting).toBe(true)
  })

  it("the Stop button's command ends the load, once, with no double report", () => {
    const f = fixture()
    const { tab, page } = hang(f)
    const win = f.browser.focusedWindow()
    void f.browser.handleCommand(win, 'tab.stop', { tabId: tab().id })
    expect(page.stops).toBe(1)
    expect(page.hanging).toBeNull()
    expect(tab().loading).toBe(false)
    expect(tab().waiting).toBe(false)
    expect(tab().progress).toBe(1)
    // The row is at rest and stays there: the tab keeps the address it was going to.
    expect(tab().url).toBe(DEAD)
    expect(tab().errorCode).toBeNull()
  })

  it('Escape in the page stops the load and is left to the page otherwise', () => {
    const f = fixture()
    const { tab, page } = hang(f)
    const win = f.browser.focusedWindow()
    f.browser.keys.handle(escape(), tab().id, win)
    expect(page.stops).toBe(1)
    expect(tab().loading).toBe(false)
    // At rest, Escape asks the page for nothing: it is the page's key (a dialog, a fullscreen video).
    f.browser.keys.handle(escape(), tab().id, win)
    expect(page.stops).toBe(1)
  })

  it('the nav.stop action stops the active tab', () => {
    const f = fixture()
    const { tab, page } = hang(f)
    const win = f.browser.focusedWindow()
    f.browser.actions.run('nav.stop', { sourceTabId: null, win })
    expect(page.stops).toBe(1)
    expect(tab().loading).toBe(false)
  })

  it('⌘. stops the load on macOS in both presets; Windows and Linux leave the chord to the page', () => {
    for (const preset of ['zen', 'chrome'] as const) {
      const mac = fixture('darwin')
      mac.browser.state.settings.shortcutPreset = preset
      const { tab, page } = hang(mac)
      const win = mac.browser.focusedWindow()
      expect(mac.browser.keys.handle(commandPeriod(), tab().id, win)).toBe(true)
      expect(page.stops).toBe(1)
      expect(tab().loading).toBe(false)
    }
    const linux = fixture('linux')
    const { tab, page } = hang(linux)
    expect(linux.browser.keys.handle(commandPeriod(), tab().id, linux.browser.focusedWindow())).toBe(
      false
    )
    expect(page.stops).toBe(0)
    expect(tab().loading).toBe(true)
  })

  it('a stop that arrives after the server answered after all is a no-op', () => {
    const f = fixture()
    const { tab, page } = hang(f)
    page.answer()
    expect(tab().loading).toBe(false)
    f.browser.tabs.stop(tab().id)
    expect(page.stops).toBe(1)
    expect(tab().loading).toBe(false)
    expect(tab().url).toBe(DEAD)
  })
})

describe('what a stopped navigation leaves behind', () => {
  it.each(shapes)(
    'a host that reports the abort as a failed load too changes nothing: %s',
    (_shape, hang) => {
      const f = fixture()
      const { tab, page } = hang(f)
      page.reportsAbort = true
      f.browser.tabs.stop(tab().id)
      expect(page.stops).toBe(1)
      expect(tab().loading).toBe(false)
      expect(tab().waiting).toBe(false)
      // The abort is the user's, never an error page: the tab keeps its address and no error code.
      expect(tab().errorCode).toBeNull()
      expect(tab().url).toBe(DEAD)
    }
  )

  it('the next navigation after a stop spins again and commits normally', () => {
    const f = fixture()
    const { tab, page } = firstNavigation(f)
    f.browser.tabs.stop(tab().id)
    expect(tab().loading).toBe(false)
    f.browser.tabs.navigate(tab().id, PAGE)
    expect(tab().loading).toBe(true)
    expect(tab().waiting).toBe(true)
    page.answer()
    expect(tab().loading).toBe(false)
    expect(tab().url).toBe(PAGE)
  })
})
