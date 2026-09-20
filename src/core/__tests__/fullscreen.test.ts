import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostCapabilities } from '../../shared/types'
import { HINT_DELAY_MS, HINT_SNOOZE_MS, type PageHint } from '../../shared/fullscreenHint'
import { Browser } from '../browser'
import { ESCAPE_HOLD_MS, EscapeHold, hostOf } from '../fullscreen'
import type {
  AppHost,
  KeyEventInput,
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

interface Page {
  hints: Array<PageHint | null>
  events: TabViewEvents
}

/** A desktop host whose window can be put in fullscreen and whose pages record their hints. */
function fakePlatform(io: StoreIO): Platform & {
  pages: Map<string, Page>
  frame: { fullscreen: boolean }
} {
  const pages = new Map<string, Page>()
  const frame = { fullscreen: false }
  const capabilities = stub<HostCapabilities>({
    windows: true,
    updates: false,
    agents: false,
    pageControls: false,
    darkenSites: false
  })
  return {
    pages,
    frame,
    info: { os: 'linux', version: '0.0.0' },
    capabilities,
    io,
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => frame.fullscreen,
          setFullScreen: (on: boolean) => {
            frame.fullscreen = on
          },
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true
        })
    },
    views: stub<TabViewHost>({
      createView: (tab, events) => {
        const page: Page = { hints: [], events }
        pages.set(tab.id, page)
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => true,
          getZoom: () => 1,
          showHint: (hint: PageHint | null) => void page.hints.push(hint)
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
  win: ZenWindow
} {
  const platform = fakePlatform(memoryIo())
  const browser = new Browser(platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  return { browser, platform, win }
}

function last<T>(list: T[]): T | undefined {
  return list[list.length - 1]
}

const key = (type: KeyEventInput['type'], isAutoRepeat = false): KeyEventInput => ({
  type,
  key: 'Escape',
  control: false,
  alt: false,
  shift: false,
  meta: false,
  isAutoRepeat
})

describe('the hint for a page in fullscreen', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('names the host and Esc, half a second after the page went fullscreen', () => {
    const { browser, platform, win } = start()
    const tab = browser.tabs.createTab(
      { url: 'https://www.youtube.com/watch?v=1', active: true },
      win
    )
    const page = platform.pages.get(tab.id)!
    page.events.onEnterHtmlFullscreen()
    expect(win.htmlFullscreenTabId).toBe(tab.id)
    expect(page.hints).toEqual([])
    vi.advanceTimersByTime(HINT_DELAY_MS - 1)
    expect(page.hints).toEqual([])
    vi.advanceTimersByTime(1)
    expect(last(page.hints)).toMatchObject({
      text: null,
      exit: { before: 'Press ', key: 'Esc', after: ' to exit full screen' },
      duration: 3800,
      dark: false
    })
    // Leaving takes the hint down.
    page.events.onLeaveHtmlFullscreen()
    expect(last(page.hints)).toBeNull()
  })

  it('keeps quiet when the page leaves fullscreen before the hint is due', () => {
    const { browser, platform, win } = start()
    const tab = browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win)
    const page = platform.pages.get(tab.id)!
    page.events.onEnterHtmlFullscreen()
    vi.advanceTimersByTime(200)
    page.events.onLeaveHtmlFullscreen()
    vi.advanceTimersByTime(HINT_DELAY_MS)
    expect(page.hints).toEqual([null])
  })

  it('shows the hint once per site in fifteen minutes, on every tab of the site', () => {
    const { browser, platform, win } = start()
    const a = browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win)
    const pageA = platform.pages.get(a.id)!
    pageA.events.onEnterHtmlFullscreen()
    vi.advanceTimersByTime(HINT_DELAY_MS)
    expect(pageA.hints).toHaveLength(1)
    pageA.events.onLeaveHtmlFullscreen()
    // Again at once: the site is snoozed.
    pageA.events.onEnterHtmlFullscreen()
    vi.advanceTimersByTime(HINT_DELAY_MS)
    expect(pageA.hints.filter(Boolean)).toHaveLength(1)
    pageA.events.onLeaveHtmlFullscreen()
    // Another tab of the same site is snoozed too; another site is not.
    const b = browser.tabs.createTab({ url: 'https://sub.example.com/b', active: true }, win)
    const pageB = platform.pages.get(b.id)!
    pageB.events.onEnterHtmlFullscreen()
    vi.advanceTimersByTime(HINT_DELAY_MS)
    expect(pageB.hints).toEqual([])
    pageB.events.onLeaveHtmlFullscreen()
    const c = browser.tabs.createTab({ url: 'https://other.org/', active: true }, win)
    const pageC = platform.pages.get(c.id)!
    pageC.events.onEnterHtmlFullscreen()
    vi.advanceTimersByTime(HINT_DELAY_MS)
    expect(last(pageC.hints)).toMatchObject({
      exit: { before: 'Press ', key: 'Esc', after: ' to exit full screen' }
    })
    pageC.events.onLeaveHtmlFullscreen()
    // The snooze runs out.
    vi.advanceTimersByTime(HINT_SNOOZE_MS)
    pageA.events.onEnterHtmlFullscreen()
    vi.advanceTimersByTime(HINT_DELAY_MS)
    expect(pageA.hints.filter(Boolean)).toHaveLength(2)
  })

  it('says to hold Esc while the page has the keyboard locked, until it navigates', () => {
    const { browser, platform, win } = start()
    const tab = browser.tabs.createTab(
      { url: 'https://remote.example.net/desk', active: true },
      win
    )
    const page = platform.pages.get(tab.id)!
    browser.fullscreen.keyboardLockRequested(tab.id)
    page.events.onEnterHtmlFullscreen()
    vi.advanceTimersByTime(HINT_DELAY_MS)
    expect(last(page.hints)).toMatchObject({
      text: null,
      exit: { before: 'Press and hold ', key: 'Esc', after: ' to exit full screen' }
    })
    page.events.onLeaveHtmlFullscreen()
    expect(browser.fullscreen.isKeyboardLocked(tab.id)).toBe(true)
    page.events.onNavigated('https://remote.example.net/other', false)
    expect(browser.fullscreen.isKeyboardLocked(tab.id)).toBe(false)
  })

  it('brings the hint back, snoozed or not, when a page in fullscreen takes the keyboard', () => {
    const { browser, platform, win } = start()
    const tab = browser.tabs.createTab(
      { url: 'https://remote.example.net/desk', active: true },
      win
    )
    const page = platform.pages.get(tab.id)!
    page.events.onEnterHtmlFullscreen()
    vi.advanceTimersByTime(HINT_DELAY_MS)
    expect(last(page.hints)).toMatchObject({
      exit: { before: 'Press ', key: 'Esc', after: ' to exit full screen' }
    })
    // The site is snoozed now; the lock still gets its hint, with the new way out.
    browser.fullscreen.keyboardLockRequested(tab.id)
    expect(page.hints.filter(Boolean)).toHaveLength(1)
    vi.advanceTimersByTime(HINT_DELAY_MS)
    expect(page.hints.filter(Boolean)).toHaveLength(2)
    expect(last(page.hints)).toMatchObject({
      text: null,
      exit: { before: 'Press and hold ', key: 'Esc', after: ' to exit full screen' }
    })
    // Asking again changes nothing; a lock taken outside fullscreen shows nothing.
    browser.fullscreen.keyboardLockRequested(tab.id)
    vi.advanceTimersByTime(HINT_DELAY_MS)
    expect(page.hints.filter(Boolean)).toHaveLength(2)
    page.events.onLeaveHtmlFullscreen()
    page.events.onNavigated('https://remote.example.net/other', false)
    browser.fullscreen.keyboardLockRequested(tab.id)
    vi.advanceTimersByTime(HINT_DELAY_MS)
    expect(page.hints.filter(Boolean)).toHaveLength(2)
  })

  it('follows the dark scheme of the chrome', () => {
    const { browser, platform, win } = start()
    browser.handleCommand(win, 'settings.update', { colorScheme: 'dark' })
    const tab = browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const page = platform.pages.get(tab.id)!
    page.events.onEnterHtmlFullscreen()
    vi.advanceTimersByTime(HINT_DELAY_MS)
    expect(last(page.hints)).toMatchObject({ dark: true })
  })
})

describe('a page gone while in fullscreen', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('ends the window’s HTML fullscreen when its tab is closed, without a leave from the host', () => {
    // The host's own leave on the tear-down (Android drops the view and exits its fullscreen
    // layer on `view.destroy`) reaches a view the core has dropped and is not heard; the
    // window must not keep a fullscreen tab id that names no tab, its chrome away for good.
    const { browser, platform, win } = start()
    const other = browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win)
    const tab = browser.tabs.createTab({ url: 'https://example.com/video', active: true }, win)
    const page = platform.pages.get(tab.id)!
    page.events.onEnterHtmlFullscreen()
    expect(win.htmlFullscreenTabId).toBe(tab.id)
    browser.tabs.closeTab(tab.id, true, win)
    expect(win.htmlFullscreenTabId).toBeNull()
    expect(win.windowState().htmlFullscreenTabId).toBeNull()
    expect(win.selectedTabIn(win.activeSpace())).toBe(other.id)
    // The hint due for the fullscreen is not shown to a page that is gone.
    vi.advanceTimersByTime(HINT_DELAY_MS)
    expect(page.hints).toEqual([])
  })

  it('ends it when the tab is put to sleep, and leaves another window’s fullscreen alone', () => {
    const { browser, platform, win } = start()
    browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win)
    const tab = browser.tabs.createTab({ url: 'https://example.com/video', active: true }, win)
    platform.pages.get(tab.id)!.events.onEnterHtmlFullscreen()
    expect(win.htmlFullscreenTabId).toBe(tab.id)
    browser.tabs.discard(tab.id)
    expect(win.htmlFullscreenTabId).toBeNull()
    expect(browser.tabs.tab(tab.id)?.discarded).toBe(true)
  })
})

describe("the window's fullscreen (F11)", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shows how to get out in the active page half a second after entering, and clears it on leaving', () => {
    const { browser, platform, win } = start()
    const tab = browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const page = platform.pages.get(tab.id)!
    browser.toggleFullscreen(win)
    win.onWindowStateChanged()
    expect(page.hints).toEqual([])
    vi.advanceTimersByTime(HINT_DELAY_MS)
    expect(last(page.hints)).toEqual({
      text: null,
      exit: { before: 'Press ', key: 'F11', after: ' to exit full screen' },
      duration: 3800,
      dark: false
    })
    // Other state changes (focus, maximise) while fullscreen do not repeat it.
    win.onWindowStateChanged()
    vi.advanceTimersByTime(HINT_DELAY_MS)
    expect(page.hints).toHaveLength(1)
    browser.toggleFullscreen(win)
    win.onWindowStateChanged()
    expect(last(page.hints)).toBeNull()
  })

  it('leaves fullscreen when Esc is held for 1.5 s, not on a short press', () => {
    const { browser, platform, win } = start()
    const tab = browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    browser.toggleFullscreen(win)
    win.onWindowStateChanged()
    expect(platform.frame.fullscreen).toBe(true)
    // A short press, with key repeats, does nothing.
    browser.keys.handle(key('keyDown'), tab.id, win)
    browser.keys.handle(key('keyDown', true), tab.id, win)
    vi.advanceTimersByTime(ESCAPE_HOLD_MS - 100)
    browser.keys.handle(key('keyUp'), tab.id, win)
    vi.advanceTimersByTime(ESCAPE_HOLD_MS)
    expect(platform.frame.fullscreen).toBe(true)
    // Held long enough, from the chrome this time.
    browser.keys.handle(key('keyDown'), null, win)
    vi.advanceTimersByTime(ESCAPE_HOLD_MS)
    expect(platform.frame.fullscreen).toBe(false)
  })

  it('leaves Esc alone in a window that is not fullscreen, or whose page is in its own fullscreen', () => {
    const { browser, platform, win } = start()
    const tab = browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    browser.keys.handle(key('keyDown'), tab.id, win)
    vi.advanceTimersByTime(ESCAPE_HOLD_MS)
    expect(platform.frame.fullscreen).toBe(false)
    browser.toggleFullscreen(win)
    win.onWindowStateChanged()
    platform.pages.get(tab.id)!.events.onEnterHtmlFullscreen()
    browser.keys.handle(key('keyDown'), tab.id, win)
    vi.advanceTimersByTime(ESCAPE_HOLD_MS)
    expect(platform.frame.fullscreen).toBe(true)
  })
})

describe('EscapeHold', () => {
  it('fires once after the hold, and not when the key comes up first', () => {
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
    let held = 0
    const hold = new EscapeHold(
      () => held++,
      (fn, ms) => {
        const t = { fn, ms, cleared: false }
        timers.push(t)
        return t as unknown as ReturnType<typeof setTimeout>
      },
      (t) => {
        ;(t as unknown as { cleared: boolean }).cleared = true
      }
    )
    hold.down()
    hold.down()
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(ESCAPE_HOLD_MS)
    expect(hold.holding).toBe(true)
    hold.up()
    expect(timers[0].cleared).toBe(true)
    expect(hold.holding).toBe(false)
    hold.down()
    timers[1].fn()
    expect(held).toBe(1)
    expect(hold.holding).toBe(false)
  })
})

describe('hostOf', () => {
  it('names the host with its port, and the scheme of a page without one', () => {
    expect(hostOf('https://www.youtube.com/watch?v=1')).toBe('www.youtube.com')
    expect(hostOf('http://localhost:8787/video.html')).toBe('localhost:8787')
    expect(hostOf('file:///tmp/video.html')).toBe('file')
    expect(hostOf('zen://settings')).toBe('settings')
    expect(hostOf('not a url')).toBe('not a url')
  })
})
