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
  /** `focus()` calls on the view. */
  focusCalls: number
  visible: boolean
  /** Whether the view holds the keyboard (set by `focus()`, or by the test to fake a state). */
  focused: boolean
}

/**
 * The keyboard as the host sees it. `focusChrome()` and a view's `focus()` move it like the
 * real host would; a test moves it to a foreign document (an extension popup's view) by hand.
 */
interface Keyboard {
  document: 'chrome' | 'other' | 'none'
}

interface Fixture {
  browser: Browser
  win: ZenWindow
  views: RecordedView[]
  keyboard: Keyboard
  /** `focusChrome()` calls on the window's host so far. */
  chromeFocusCalls: () => number
  /** Open a page in a new tab; its view is owned by the window and shown. */
  openPage: (url: string) => RecordedView
}

const AREA = { x: 260, y: 48, width: 1000, height: 740 }

function placementsFor(tabIds: string[]): LayoutReport['placements'] {
  return tabIds.map((tabId) => ({ tabId, rect: AREA, radius: 12 }))
}

const shown = (tabIds: string[]): LayoutReport => ({
  placements: placementsFor(tabIds),
  glance: null,
  contentHidden: false
})

const hidden = (tabIds: string[]): LayoutReport => ({
  placements: placementsFor(tabIds),
  glance: null,
  contentHidden: true
})

/** `hostTellsFocus` false models a host without `focusedDocument` / `isFocused` (Android). */
function fixture(hostTellsFocus = true): Fixture {
  const views: RecordedView[] = []
  const keyboard: Keyboard = { document: 'chrome' }
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
            keyboard.document = 'chrome'
            for (const v of views) v.focused = false
          },
          ...(hostTellsFocus ? { focusedDocument: () => keyboard.document } : {})
        })
    },
    views: stub<TabViewHost>({
      createView: (tab: Tab) => {
        const recorded: RecordedView = {
          tabId: tab.id,
          focusCalls: 0,
          visible: false,
          focused: false
        }
        views.push(recorded)
        let url = ''
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => recorded.visible,
          setVisible: (visible: boolean) => {
            recorded.visible = visible
          },
          focus: () => {
            recorded.focusCalls++
            for (const v of views) v.focused = v === recorded
            keyboard.document = 'other'
          },
          ...(hostTellsFocus ? { isFocused: () => recorded.focused } : {}),
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
    win.applyLayout(shown([tabId]))
    return view
  }
  return { browser, win, views, keyboard, chromeFocusCalls: () => chromeFocus, openPage }
}

/** The page has the keyboard, as after a click into it. */
function typingIn(f: Fixture, page: RecordedView): void {
  page.focused = true
  f.keyboard.document = 'other'
}

describe('keyboard focus on layout reports', () => {
  it('does not take the keyboard from a foreign document when chrome UI covers the page', () => {
    const f = fixture()
    const page = f.openPage('https://example.com')
    expect(page.visible).toBe(true)
    // An extension popup's view took the keyboard (while still hidden behind its frame); the
    // renderer then hides the page behind the frame's capture.
    f.keyboard.document = 'other'
    page.focused = false
    const before = f.chromeFocusCalls()
    f.win.applyLayout(hidden([page.tabId]))
    expect(page.visible).toBe(false)
    expect(f.chromeFocusCalls()).toBe(before)
    // Re-reports while the popup is up (a resize, a state change) leave it alone as well.
    f.win.applyLayout({ placements: [], glance: null, contentHidden: true })
    expect(f.chromeFocusCalls()).toBe(before)
  })

  it('moves the keyboard to the chrome when an overlay covers the page the user types in', () => {
    const f = fixture()
    const page = f.openPage('https://example.com')
    typingIn(f, page)
    const before = f.chromeFocusCalls()
    f.win.applyLayout(hidden([page.tabId]))
    expect(page.visible).toBe(false)
    expect(f.chromeFocusCalls()).toBe(before + 1)
    expect(f.keyboard.document).toBe('chrome')
  })

  it('still hands the keyboard to the chrome when the chrome already holds it', () => {
    const f = fixture()
    const page = f.openPage('https://example.com')
    f.keyboard.document = 'chrome'
    const before = f.chromeFocusCalls()
    f.win.applyLayout(hidden([page.tabId]))
    expect(f.chromeFocusCalls()).toBe(before + 1)
  })

  it('does nothing for a hidden report that covers no showing page', () => {
    const f = fixture()
    const page = f.openPage('https://example.com')
    typingIn(f, page)
    f.win.applyLayout(hidden([page.tabId]))
    const before = f.chromeFocusCalls()
    // The user clicked into a foreign document meanwhile; a second hidden report (the overlay
    // re-laid out) must not pull the keyboard back.
    f.keyboard.document = 'other'
    f.win.applyLayout({ placements: [], glance: null, contentHidden: true })
    expect(f.chromeFocusCalls()).toBe(before)
  })

  it('keeps moving the keyboard on a host that cannot say who holds it', () => {
    const f = fixture(false)
    const page = f.openPage('https://example.com')
    const before = f.chromeFocusCalls()
    f.win.applyLayout(hidden([page.tabId]))
    expect(f.chromeFocusCalls()).toBe(before + 1)
  })

  it('focuses the chrome for an empty window, where the URL bar is the only thing to type into', () => {
    const f = fixture()
    const before = f.chromeFocusCalls()
    f.win.applyLayout(shown([]))
    expect(f.chromeFocusCalls()).toBe(before + 1)
  })

  it('leaves a visible page alone, also in a split', () => {
    const f = fixture()
    const first = f.openPage('https://example.com')
    const second = f.openPage('https://example.org')
    typingIn(f, second)
    const before = f.chromeFocusCalls()
    f.win.applyLayout(shown([first.tabId, second.tabId]))
    expect(first.visible).toBe(true)
    expect(second.visible).toBe(true)
    expect(f.chromeFocusCalls()).toBe(before)
    expect(second.focused).toBe(true)
  })

  it('leaves the keyboard alone while a Glance card is up over its parent', () => {
    const f = fixture()
    const parent = f.openPage('https://example.com')
    f.browser.handleCommand(f.win, 'glance.open', {
      url: 'https://example.net',
      parentTabId: parent.tabId,
      originX: 400,
      originY: 300
    })
    const glanceTabId = f.win.glance?.tabId
    expect(glanceTabId).toBeDefined()
    if (!glanceTabId) return
    const card = f.views.find((v) => v.tabId === glanceTabId)
    expect(card).toBeDefined()
    const before = f.chromeFocusCalls()
    // The parent is frozen behind the card (no placement for it), the card is placed.
    f.win.applyLayout({
      placements: [],
      glance: { tabId: glanceTabId, rect: { x: 400, y: 120, width: 720, height: 600 }, radius: 12 },
      contentHidden: false
    })
    expect(card?.visible).toBe(true)
    expect(parent.visible).toBe(false)
    expect(f.chromeFocusCalls()).toBe(before)
  })

  it('gives a page the user typed in the keyboard back when the chrome over it lifts by itself', () => {
    const f = fixture()
    const page = f.openPage('https://example.com')
    typingIn(f, page)
    // The tab hover card rests over the page and goes again without asking for its focus.
    f.win.applyLayout(hidden([page.tabId]))
    expect(f.keyboard.document).toBe('chrome')
    const focused = page.focusCalls
    f.win.applyLayout(shown([page.tabId]))
    expect(page.focusCalls).toBe(focused + 1)
    expect(page.focused).toBe(true)
  })

  it('leaves the keyboard with the chrome when it held it before the cover', () => {
    const f = fixture()
    const page = f.openPage('https://example.com')
    // A row of the sidebar has the keyboard (keyboard focus put the hover card up).
    f.keyboard.document = 'chrome'
    page.focused = false
    f.win.applyLayout(hidden([page.tabId]))
    const focused = page.focusCalls
    f.win.applyLayout(shown([page.tabId]))
    expect(page.focusCalls).toBe(focused)
    expect(f.keyboard.document).toBe('chrome')
  })

  it('does not pull the keyboard into a window the user has left', () => {
    const f = fixture()
    const page = f.openPage('https://example.com')
    typingIn(f, page)
    f.win.applyLayout(hidden([page.tabId]))
    // The user went to another window; the chrome that covered the page closes on the blur.
    ;(f.win.host as { isFocused: () => boolean }).isFocused = () => false
    const focused = page.focusCalls
    f.win.applyLayout(shown([page.tabId]))
    expect(page.focusCalls).toBe(focused)
  })

  it('hands the keyboard back to the page once the overlay that hid it closes', () => {
    const f = fixture()
    const page = f.openPage('https://example.com')
    typingIn(f, page)
    f.win.applyLayout(hidden([page.tabId]))
    expect(f.keyboard.document).toBe('chrome')
    // Closing Settings asks for the page's focus while the layout still says it is hidden: the
    // request waits for the layout that shows the page again.
    const focused = page.focusCalls
    f.browser.handleCommand(f.win, 'focus.content', undefined)
    expect(page.focusCalls).toBe(focused)
    f.win.applyLayout(shown([page.tabId]))
    expect(page.visible).toBe(true)
    expect(page.focusCalls).toBe(focused + 1)
    expect(page.focused).toBe(true)
  })
})

/**
 * A surface beside the page that held the keyboard goes away (an extension's side panel closes,
 * a Glance card, a popup frame): its host asks the window for the keyboard with `focusContent()`,
 * and the window decides between its page and its chrome. Under chrome that covers the page the
 * request waits for the layout that shows it again (the overlay case above).
 */
describe('keyboard focus when a surface beside the page goes away', () => {
  it('hands the keyboard to the active page when the window shows one', () => {
    const f = fixture()
    const page = f.openPage('https://example.com')
    // The panel's document had the keyboard, the page did not.
    f.keyboard.document = 'other'
    page.focused = false
    const chrome = f.chromeFocusCalls()
    const focused = page.focusCalls
    f.win.focusContent()
    expect(page.focusCalls).toBe(focused + 1)
    expect(page.focused).toBe(true)
    expect(f.chromeFocusCalls()).toBe(chrome)
  })

  it('hands the keyboard to the chrome when the window shows no page', () => {
    const f = fixture()
    f.win.applyLayout(shown([]))
    f.keyboard.document = 'other'
    const chrome = f.chromeFocusCalls()
    f.win.focusContent()
    expect(f.chromeFocusCalls()).toBe(chrome + 1)
    expect(f.keyboard.document).toBe('chrome')
    expect(f.views.every((v) => !v.focused)).toBe(true)
  })
})
