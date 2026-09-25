import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

interface Host {
  quits: number
  os: PlatformOs
}

/** A desktop host on `os`, counting the quits the core asks of it; `everywhere` is the drives' flag. */
function fakePlatform(
  io: StoreIO,
  { os, everywhere = false }: { os: PlatformOs; everywhere?: boolean }
): Platform & { host: Host } {
  const host: Host = { quits: 0, os }
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
      createView: () =>
        stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => true,
          getZoom: () => 1,
          // No page objects to unloading: a quit's checks pass without a "Leave site?".
          confirmUnload: undefined
        })
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

function start(options: { os: PlatformOs; everywhere?: boolean }): {
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
    expect(win.quitHold).toEqual({ startedAt: Date.now(), durationMs: QUIT_HOLD_MS })
    expect(win.windowState().quitHold).toEqual(win.quitHold)
    expect(requestQuit).not.toHaveBeenCalled()
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
    expect(win.quitHold).toEqual({ startedAt: Date.now(), durationMs: QUIT_HOLD_MS })
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
