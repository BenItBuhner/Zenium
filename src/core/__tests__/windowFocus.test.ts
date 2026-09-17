import { describe, expect, it } from 'vitest'
import type {
  HostCapabilities,
  LayoutReport,
  Platform as PlatformOs,
  Tab
} from '../../shared/types'
import { Browser } from '../browser'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
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

function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

/** What the fixture records about one tab view: focus requests and visibility changes. */
interface RecordedView {
  readonly tabId: string
  focusCalls: number
  visible: boolean
  readonly visibility: boolean[]
}

interface Fixture {
  browser: Browser
  win: ZenWindow
  views: RecordedView[]
  /** `focusChrome()` calls on the window's host so far. */
  chromeFocusCalls: () => number
  /** Open a page in a new tab; its view is owned by the window and shown. */
  openPage: (url: string) => RecordedView
}

const AREA = { x: 260, y: 48, width: 1000, height: 740 }

function placementsFor(tabIds: string[]): LayoutReport['placements'] {
  return tabIds.map((tabId) => ({ tabId, rect: AREA, radius: 12 }))
}

function fixture(): Fixture {
  const views: RecordedView[] = []
  let chromeFocus = 0
  const capabilities = stub<HostCapabilities>({ windows: true, updates: false, agents: false })
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities,
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
          isVisible: () => true,
          focusChrome: () => {
            chromeFocus++
          }
        })
    },
    views: stub<TabViewHost>({
      createView: (tab: Tab) => {
        const recorded: RecordedView = {
          tabId: tab.id,
          focusCalls: 0,
          visible: false,
          visibility: []
        }
        views.push(recorded)
        let url = ''
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => recorded.visible,
          setVisible: (visible: boolean) => {
            recorded.visible = visible
            recorded.visibility.push(visible)
          },
          focus: () => {
            recorded.focusCalls++
          },
          hasDocument: () => url !== '',
          getURL: () => url,
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          loadURL: (u: string) => {
            url = u
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
  const win = browser.focusedWindow()
  const openPage = (url: string): RecordedView => {
    browser.handleCommand(win, 'urlbar.submit', {
      input: url,
      newTab: true,
      tabId: null,
      background: false
    })
    const tabId = win.selectedTabIn(win.activeSpace())
    const view = views.find((v) => v.tabId === tabId)
    if (!tabId || !view) throw new Error('the page did not open in a tab of its own')
    win.applyLayout({ placements: placementsFor([tabId]), glance: null, contentHidden: false })
    return view
  }
  return { browser, win, views, chromeFocusCalls: () => chromeFocus, openPage }
}

describe('keyboard focus on layout reports', () => {
  it('keeps focus where it is when a popup that owns the keyboard hides the page', () => {
    const f = fixture()
    const page = f.openPage('https://example.com')
    expect(page.visible).toBe(true)
    const before = f.chromeFocusCalls()
    // The renderer framed an extension popup over the page: the page is hidden behind its
    // capture, but the popup's own view holds the keyboard.
    f.win.applyLayout({
      placements: placementsFor([page.tabId]),
      glance: null,
      contentHidden: true,
      hiddenBy: 'popup'
    })
    expect(page.visible).toBe(false)
    expect(f.chromeFocusCalls()).toBe(before)
    // Re-reports while the popup is up (a resize, a state change) do not steal it either.
    f.win.applyLayout({ placements: [], glance: null, contentHidden: true, hiddenBy: 'popup' })
    expect(f.chromeFocusCalls()).toBe(before)
  })

  it('moves focus to the chrome when a chrome overlay such as Settings hides the page', () => {
    const f = fixture()
    const page = f.openPage('https://example.com')
    const before = f.chromeFocusCalls()
    f.win.applyLayout({
      placements: placementsFor([page.tabId]),
      glance: null,
      contentHidden: true,
      hiddenBy: 'chrome'
    })
    expect(page.visible).toBe(false)
    expect(f.chromeFocusCalls()).toBe(before + 1)
  })

  it('treats a report that does not say what hides the page as a chrome overlay', () => {
    const f = fixture()
    const page = f.openPage('https://example.com')
    const before = f.chromeFocusCalls()
    f.win.applyLayout({
      placements: placementsFor([page.tabId]),
      glance: null,
      contentHidden: true
    })
    expect(f.chromeFocusCalls()).toBe(before + 1)
  })

  it('focuses the chrome for an empty window, where the URL bar is the only thing to type into', () => {
    const f = fixture()
    const before = f.chromeFocusCalls()
    f.win.applyLayout({ placements: [], glance: null, contentHidden: false })
    expect(f.chromeFocusCalls()).toBe(before + 1)
  })

  it('leaves a visible page alone', () => {
    const f = fixture()
    const page = f.openPage('https://example.com')
    const before = f.chromeFocusCalls()
    f.win.applyLayout({
      placements: placementsFor([page.tabId]),
      glance: null,
      contentHidden: false
    })
    expect(f.chromeFocusCalls()).toBe(before)
  })

  it('hands focus back to the page once the overlay that hid it closes', () => {
    const f = fixture()
    const page = f.openPage('https://example.com')
    f.win.applyLayout({
      placements: placementsFor([page.tabId]),
      glance: null,
      contentHidden: true,
      hiddenBy: 'chrome'
    })
    // Closing Settings asks for the page's focus while the layout still says it is hidden: the
    // request waits for the layout that shows the page again.
    const focused = page.focusCalls
    f.browser.handleCommand(f.win, 'focus.content', undefined)
    expect(page.focusCalls).toBe(focused)
    f.win.applyLayout({
      placements: placementsFor([page.tabId]),
      glance: null,
      contentHidden: false
    })
    expect(page.visible).toBe(true)
    expect(page.focusCalls).toBe(focused + 1)
  })
})
