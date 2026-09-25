import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { QuitHoldPanel } from '../../shared/quitHoldPanel'
import { resolveTheme, rgbToHex } from '../../shared/theme'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { Browser } from '../browser'
import { QUIT_HOLD_MS } from '../quitHold'
import type {
  AppHost,
  KeyEventInput,
  Platform,
  StoreIO,
  TabView,
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

/** A page view of the fake host, with the panel's posting under the test's eye. */
type FakeView = TabView & { showQuitHold: Mock<(panel: QuitHoldPanel | null) => void> }

interface Host {
  quits: number
  os: PlatformOs
  /** The page views made, in order. */
  views: FakeView[]
}

interface HostOptions {
  os: PlatformOs
  /** The drives' flag (`AppHost.quitHoldEverywhere`). */
  everywhere?: boolean
  /** A host whose page views draw no panel (Android's `TabView` has no `showQuitHold`). */
  pageless?: boolean
}

/** A desktop host on `os`, counting the quits the core asks of it; `everywhere` is the drives' flag. */
function fakePlatform(
  io: StoreIO,
  { os, everywhere = false, pageless = false }: HostOptions
): Platform & { host: Host } {
  const host: Host = { quits: 0, os, views: [] }
  const capabilities = stub<HostCapabilities>({
    windows: true,
    updates: false,
    agents: false,
    pageControls: false,
    darkenSites: false,
    quitsThroughCore: true
  })
  return {
    host,
    info: { os, version: '0.0.0' },
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
      createView: () => {
        const view = stub<FakeView>({
          isDestroyed: () => false,
          isVisible: () => true,
          getZoom: () => 1,
          // No page objects to unloading: a quit's checks pass without a "Leave site?".
          confirmUnload: undefined,
          // An explicit undefined stays undefined through the stub, as a host without the method.
          showQuitHold: pageless ? undefined : vi.fn<(panel: QuitHoldPanel | null) => void>()
        })
        host.views.push(view)
        return view
      }
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub<AppHost>({
      quit: () => void host.quits++,
      ...(everywhere ? { quitHoldEverywhere: () => true } : {})
    }),
    readabilitySource: () => null
  }
}

function start(options: HostOptions): {
  browser: Browser
  platform: ReturnType<typeof fakePlatform>
  win: ZenWindow
} {
  const platform = fakePlatform(memoryIo(), options)
  const browser = new Browser(platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  return { browser, platform, win }
}

/** The Chrome preset's quit chord on `os`: ⌘Q on macOS, Ctrl+Shift+Q elsewhere. */
function quitChord(
  os: PlatformOs,
  type: KeyEventInput['type'],
  isAutoRepeat = false
): KeyEventInput {
  const mac = os === 'darwin'
  return {
    type,
    key: 'q',
    control: !mac,
    alt: false,
    shift: !mac,
    meta: mac,
    isAutoRepeat
  }
}

const release = (key: string): KeyEventInput => ({
  type: 'keyUp',
  key,
  control: false,
  alt: false,
  shift: false,
  meta: false,
  isAutoRepeat: false
})

/** Let the quit's checks (all async) run through. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('the quit chord held quits (session-08)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('arms the hold in the window the chord was pressed in, on macOS with Warn Before Quitting on (the default)', () => {
    const { browser, win } = start({ os: 'darwin' })
    expect(browser.state.settings.warnBeforeQuitting).toBe(true)
    const requestQuit = vi.spyOn(browser, 'requestQuit')
    expect(browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)).toBe(true)
    expect(browser.quitHold.holding).toBe(true)
    // The chord as the panel spells it: the platform's own spelling of the quit binding.
    expect(win.quitHold).toEqual({ startedAt: Date.now(), durationMs: QUIT_HOLD_MS, chord: '⌘Q' })
    expect(win.windowState().quitHold).toEqual(win.quitHold)
    expect(requestQuit).not.toHaveBeenCalled()
  })

  it('posts the panel to the window’s active page with the chrome’s scheme and accent, and takes it down on the release', () => {
    const { browser, platform, win } = start({ os: 'darwin' })
    const tab = browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win)
    browser.tabs.createTab({ url: 'https://example.com/b', active: false }, win)
    const active = platform.host.views[0]!
    const other = platform.host.views[1]!
    expect(browser.tabs.activeTabFor(win)?.id).toBe(tab.id)
    browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)
    expect(active.showQuitHold).toHaveBeenCalledTimes(1)
    const panel = active.showQuitHold.mock.calls[0]![0] as QuitHoldPanel
    expect(panel).toEqual({
      ...win.quitHold,
      dark: browser.darkScheme(),
      accent: expect.stringMatching(/^#[0-9a-f]{6}$/)
    })
    expect(panel.accent).toBe(
      rgbToHex(resolveTheme(win.activeSpace().theme, browser.darkScheme()).accent)
    )
    expect(other.showQuitHold).not.toHaveBeenCalled()
    // A key repeat posts nothing more: the page has the hold and steps its ring from the clock.
    browser.keys.handle(quitChord('darwin', 'keyDown', true), null, win)
    expect(active.showQuitHold).toHaveBeenCalledTimes(1)
    browser.keys.handle(release('q'), null, win)
    expect(active.showQuitHold).toHaveBeenCalledTimes(2)
    expect(active.showQuitHold).toHaveBeenLastCalledWith(null)
  })

  it('takes the panel down before the held quit runs', () => {
    const { browser, platform, win } = start({ os: 'darwin' })
    browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win)
    const view = platform.host.views[0]!
    const requestQuit = vi.spyOn(browser, 'requestQuit').mockResolvedValue(true)
    browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)
    vi.advanceTimersByTime(QUIT_HOLD_MS)
    expect(view.showQuitHold).toHaveBeenLastCalledWith(null)
    expect(view.showQuitHold.mock.invocationCallOrder[1]).toBeLessThan(
      requestQuit.mock.invocationCallOrder[0]!
    )
  })

  it('a page view without the panel (Android’s) leaves the hold to the chrome’s own copy', () => {
    const { browser, win } = start({ os: 'darwin', pageless: true })
    browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win)
    expect(browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)).toBe(true)
    expect(win.quitHold).not.toBeNull()
    browser.keys.handle(release('q'), null, win)
    expect(win.quitHold).toBeNull()
  })

  it('quits once the keys were down for the whole hold, the overlay gone first; the hold is the confirmation', async () => {
    const { browser, platform, win } = start({ os: 'darwin' })
    // Several tabs open with the tab-count warning on: a quit from the Dock would ask first.
    browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win)
    browser.tabs.createTab({ url: 'https://example.com/b', active: false }, win)
    expect(browser.state.settings.warnOnCloseWindow).toBe(true)
    const requestQuit = vi.spyOn(browser, 'requestQuit')
    browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)
    vi.advanceTimersByTime(QUIT_HOLD_MS - 1)
    expect(browser.quitHold.holding).toBe(true)
    expect(platform.host.quits).toBe(0)
    vi.advanceTimersByTime(1)
    expect(browser.quitHold.holding).toBe(false)
    expect(win.quitHold).toBeNull()
    expect(requestQuit).toHaveBeenCalledWith(win, { held: true })
    // No "Quit Zenium?" – the hold confirmed it – and the host was asked to quit.
    await expect(requestQuit.mock.results[0]?.value).resolves.toBe(true)
    expect(win.prompt).toBeNull()
    expect(browser.quitting).toBe(true)
    expect(platform.host.quits).toBe(1)
  })

  it('a quit that was not held still asks about the open tabs', async () => {
    const { browser, platform, win } = start({ os: 'darwin' })
    browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win)
    browser.tabs.createTab({ url: 'https://example.com/b', active: false }, win)
    void browser.requestQuit()
    await settle()
    expect(win.prompt).toMatchObject({ kind: 'quit', count: 2 })
    expect(platform.host.quits).toBe(0)
  })

  it('a key coming up before the hold is over releases it and nothing quits', async () => {
    const { browser, platform, win } = start({ os: 'darwin' })
    const requestQuit = vi.spyOn(browser, 'requestQuit')
    browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)
    vi.advanceTimersByTime(500)
    expect(browser.keys.handle(release('q'), null, win)).toBe(false)
    expect(browser.quitHold.holding).toBe(false)
    expect(win.quitHold).toBeNull()
    vi.advanceTimersByTime(QUIT_HOLD_MS)
    await settle()
    expect(requestQuit).not.toHaveBeenCalled()
    expect(platform.host.quits).toBe(0)
  })

  it('the modifier coming up first releases it too – any key up ends the wait, as Chrome’s panel does', () => {
    const { browser, win } = start({ os: 'darwin' })
    browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)
    browser.keys.handle(release('Meta'), null, win)
    expect(browser.quitHold.holding).toBe(false)
    expect(win.quitHold).toBeNull()
  })

  it('key repeats while the hold runs are the same hold: the clock is not restarted', () => {
    const { browser, win } = start({ os: 'darwin' })
    browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)
    const started = win.quitHold
    vi.advanceTimersByTime(700)
    expect(browser.keys.handle(quitChord('darwin', 'keyDown', true), null, win)).toBe(true)
    expect(win.quitHold).toBe(started)
    vi.advanceTimersByTime(QUIT_HOLD_MS - 700)
    expect(browser.quitHold.holding).toBe(false)
  })

  it('a release, then a new press, starts the hold afresh', () => {
    const { browser, win } = start({ os: 'darwin' })
    browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)
    vi.advanceTimersByTime(1000)
    browser.keys.handle(release('q'), null, win)
    vi.advanceTimersByTime(200)
    browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)
    expect(win.quitHold?.startedAt).toBe(Date.now())
    vi.advanceTimersByTime(QUIT_HOLD_MS - 1)
    expect(browser.quitHold.holding).toBe(true)
  })

  it('the chord from a page of the window arms the hold as the chrome’s does', () => {
    const { browser, win } = start({ os: 'darwin' })
    const tab = browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win)
    expect(browser.keys.handle(quitChord('darwin', 'keyDown'), tab.id, win)).toBe(true)
    expect(win.quitHold).not.toBeNull()
    browser.keys.handle(release('q'), tab.id, win)
    expect(win.quitHold).toBeNull()
  })

  it('with Warn Before Quitting off the chord quits at once, as before', () => {
    const { browser, win } = start({ os: 'darwin' })
    browser.setWarnBeforeQuitting(false)
    const requestQuit = vi.spyOn(browser, 'requestQuit').mockResolvedValue(true)
    expect(browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)).toBe(true)
    expect(browser.quitHold.holding).toBe(false)
    expect(win.quitHold).toBeNull()
    expect(requestQuit).toHaveBeenCalledTimes(1)
    expect(requestQuit).toHaveBeenCalledWith()
  })

  it('never holds off macOS: the Linux chord quits at once', () => {
    const { browser, win } = start({ os: 'linux' })
    const requestQuit = vi.spyOn(browser, 'requestQuit').mockResolvedValue(true)
    expect(browser.keys.handle(quitChord('linux', 'keyDown'), null, win)).toBe(true)
    expect(win.quitHold).toBeNull()
    expect(requestQuit).toHaveBeenCalledTimes(1)
  })

  it('holds on any OS when the host asks (the drives’ --test-quit-hold stand-in)', () => {
    const { browser, win } = start({ os: 'linux', everywhere: true })
    const requestQuit = vi.spyOn(browser, 'requestQuit')
    expect(browser.keys.handle(quitChord('linux', 'keyDown'), null, win)).toBe(true)
    // The stand-in's panel names the Chrome preset's Linux chord, not a Mac's.
    expect(win.quitHold).toEqual({
      startedAt: Date.now(),
      durationMs: QUIT_HOLD_MS,
      chord: 'Ctrl + Shift + Q'
    })
    expect(requestQuit).not.toHaveBeenCalled()
    // The setting still governs it there.
    browser.keys.handle(release('q'), null, win)
    browser.setWarnBeforeQuitting(false)
    browser.keys.handle(quitChord('linux', 'keyDown'), null, win)
    expect(win.quitHold).toBeNull()
    expect(requestQuit).toHaveBeenCalledTimes(1)
  })

  it('the window closing under a hold ends it', () => {
    const { browser, win } = start({ os: 'darwin' })
    const requestQuit = vi.spyOn(browser, 'requestQuit')
    browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)
    win.onClosing()
    expect(browser.quitHold.holding).toBe(false)
    vi.advanceTimersByTime(QUIT_HOLD_MS)
    expect(requestQuit).not.toHaveBeenCalled()
  })

  it('a key up with no hold running is nothing', () => {
    const { browser, win } = start({ os: 'darwin' })
    expect(browser.keys.handle(release('q'), null, win)).toBe(false)
    expect(browser.quitHold.holding).toBe(false)
  })
})
