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
import { closeBootTabs } from './bootTab'

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
type FakeView = TabView & {
  /** The tab the view was made for (`closeBootTabs` drops the boot tab's record by it). */
  tabId: string
  showQuitHold: Mock<(panel: QuitHoldPanel | null) => void>
}

interface Host {
  quits: number
  os: PlatformOs
  /** The page views made, in order. */
  views: FakeView[]
  /** With `objecting`: the "Leave site?" questions asked of the pages, each answered by the test. */
  unloadAnswers: Array<(leave: boolean) => void>
}

interface HostOptions {
  os: PlatformOs
  /** The drives' flag (`AppHost.quitHoldEverywhere`). */
  everywhere?: boolean
  /** A host whose page views draw no panel (Android's `TabView` has no `showQuitHold`). */
  pageless?: boolean
  /** Pages whose `beforeunload` objects: a quit's "Leave site?" stays open until the test answers it. */
  objecting?: boolean
}

/** A desktop host on `os`, counting the quits the core asks of it; `everywhere` is the drives' flag. */
function fakePlatform(
  io: StoreIO,
  { os, everywhere = false, pageless = false, objecting = false }: HostOptions
): Platform & { host: Host } {
  const host: Host = { quits: 0, os, views: [], unloadAnswers: [] }
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
      createView: (tab) => {
        const view = stub<FakeView>({
          tabId: tab.id,
          isDestroyed: () => false,
          isVisible: () => true,
          getZoom: () => 1,
          // No page objects to unloading unless asked to: a quit's checks pass without a
          // "Leave site?"; an objecting page's question waits for the test's answer.
          confirmUnload: objecting
            ? () =>
                new Promise<boolean>((resolve) => {
                  host.unloadAnswers.push(resolve)
                })
            : undefined,
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
  // From the bare space: the scenes below count their tabs, and the boot tab (W5-F2) is not one of them.
  closeBootTabs(browser, platform.host.views)
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

/** What a quit request resolved to once the checks ran, or 'pending' while it waits on an answer. */
async function outcome(request: Promise<boolean>): Promise<boolean | 'pending'> {
  let result: boolean | 'pending' = 'pending'
  void request.then((agreed) => {
    result = agreed
  })
  await settle()
  return result
}

describe('the quit chord held quits (session-08)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('arms the hold in the window the chord was pressed in, on macOS with Warn Before Quitting on (the default), and lets the key through', () => {
    const { browser, win } = start({ os: 'darwin' })
    expect(browser.state.settings.warnBeforeQuitting).toBe(true)
    const requestQuit = vi.spyOn(browser, 'requestQuit')
    // Not consumed: Chromium drops the key up that follows a key down the browser handled, and
    // the key up is what the hold waits for (measured: keys.ts).
    expect(browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)).toBe(false)
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
    expect(browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)).toBe(false)
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

  it('a plain quit request while the hold runs is refused – the unconsumed ⌘Q reaching the menu bar’s Quit role on macOS', async () => {
    const { browser, platform, win } = start({ os: 'darwin' })
    browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win)
    browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)
    // The role's request (`app.quit()` → before-quit → requestQuit) arrives while the keys are down.
    await expect(browser.requestQuit()).resolves.toBe(false)
    await settle()
    expect(win.prompt).toBeNull()
    expect(platform.host.quits).toBe(0)
    expect(browser.quitHold.holding).toBe(true)
    // The hold still decides: the release quits nothing, a full hold quits.
    browser.keys.handle(release('q'), null, win)
    expect(browser.quitHold.holding).toBe(false)
    expect(platform.host.quits).toBe(0)
    const requestQuit = vi.spyOn(browser, 'requestQuit')
    browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)
    vi.advanceTimersByTime(QUIT_HOLD_MS)
    expect(requestQuit).toHaveBeenCalledWith(win, { held: true })
    await expect(requestQuit.mock.results[0]?.value).resolves.toBe(true)
    expect(browser.quitting).toBe(true)
    expect(platform.host.quits).toBe(1)
  })

  it('a hold that fired latches the press: the chord’s repeats arm nothing and pop no panel while the fired quit asks its questions; a key up, then a key down, holds afresh', async () => {
    const { browser, platform, win } = start({ os: 'darwin', objecting: true })
    browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win)
    const view = platform.host.views[0]!
    const requestQuit = vi.spyOn(browser, 'requestQuit')
    browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)
    vi.advanceTimersByTime(QUIT_HOLD_MS)
    await settle()
    // The hold fired: its quit is asking the page's "Leave site?"; the panel went first.
    expect(requestQuit).toHaveBeenCalledTimes(1)
    expect(platform.host.unloadAnswers).toHaveLength(1)
    expect(view.showQuitHold).toHaveBeenCalledTimes(2)
    expect(view.showQuitHold).toHaveBeenLastCalledWith(null)
    // The finger is still down: the chord's repeats keep coming – unconsumed, as the mechanism
    // needs (a consumed one would lose the key up) – and arm nothing.
    for (let i = 0; i < 6; i++) {
      expect(browser.keys.handle(quitChord('darwin', 'keyDown', true), null, win)).toBe(false)
      vi.advanceTimersByTime(300)
    }
    await settle()
    expect(browser.quitHold.holding).toBe(false)
    expect(win.quitHold).toBeNull()
    expect(view.showQuitHold).toHaveBeenCalledTimes(2)
    expect(requestQuit).toHaveBeenCalledTimes(1)
    expect(platform.host.unloadAnswers).toHaveLength(1)
    // The user stays; the keys come up; the next press is a new hold, panel and all.
    platform.host.unloadAnswers[0]!(false)
    await settle()
    expect(browser.quitting).toBe(false)
    browser.keys.handle(release('q'), null, win)
    browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)
    expect(browser.quitHold.holding).toBe(true)
    expect(view.showQuitHold).toHaveBeenCalledTimes(3)
    expect(win.quitHold?.startedAt).toBe(Date.now())
  })

  it('a plain quit request from the chord’s repeats after the hold fired is refused, as during the hold – the menu bar’s Quit role asks nothing twice', async () => {
    const { browser, platform, win } = start({ os: 'darwin', objecting: true })
    browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win)
    browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)
    vi.advanceTimersByTime(QUIT_HOLD_MS)
    await settle()
    expect(platform.host.unloadAnswers).toHaveLength(1)
    // A repeat reached the role while "Leave site?" is up: refused at once, not joined to the
    // fired quit's check.
    browser.keys.handle(quitChord('darwin', 'keyDown', true), null, win)
    expect(await outcome(browser.requestQuit())).toBe(false)
    // The user stays. The keys stay down for longer than a hold takes: the repeats arm no hold
    // that could fire a second time, and the role's requests riding on them are refused, so the
    // page is not asked again.
    platform.host.unloadAnswers[0]!(false)
    await settle()
    for (let i = 0; i < 6; i++) {
      browser.keys.handle(quitChord('darwin', 'keyDown', true), null, win)
      expect(await outcome(browser.requestQuit())).toBe(false)
      vi.advanceTimersByTime(300)
    }
    expect(platform.host.unloadAnswers).toHaveLength(1)
    expect(platform.host.quits).toBe(0)
    // The keys up: a plain request is a plain quit again, asking the page as before.
    browser.keys.handle(release('q'), null, win)
    const plain = browser.requestQuit()
    await settle()
    expect(platform.host.unloadAnswers).toHaveLength(2)
    platform.host.unloadAnswers[1]!(true)
    await expect(plain).resolves.toBe(true)
    expect(platform.host.quits).toBe(1)
  })

  it('the press of a fired hold is over when the window loses the keyboard or closes: the key up will not be seen, and the next press holds afresh', () => {
    const { browser, win } = start({ os: 'darwin', objecting: true })
    browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win)
    browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)
    vi.advanceTimersByTime(QUIT_HOLD_MS)
    expect(browser.quitHold.engaged).toBe(true)
    win.onBlur()
    expect(browser.quitHold.engaged).toBe(false)
    browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)
    expect(browser.quitHold.holding).toBe(true)
  })

  it('a quit request with no hold running goes ahead as before (the Dock, the menu row picked)', async () => {
    const { browser, platform, win } = start({ os: 'darwin' })
    browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win)
    await expect(browser.requestQuit()).resolves.toBe(true)
    expect(platform.host.quits).toBe(1)
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

  it('key repeats while the hold runs are the same hold, let through like the first key: the clock is not restarted', () => {
    const { browser, win } = start({ os: 'darwin' })
    browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)
    const started = win.quitHold
    vi.advanceTimersByTime(700)
    // A consumed repeat would have Chromium drop the release that follows it, like the first key.
    expect(browser.keys.handle(quitChord('darwin', 'keyDown', true), null, win)).toBe(false)
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
    expect(browser.keys.handle(quitChord('darwin', 'keyDown'), tab.id, win)).toBe(false)
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
    expect(browser.keys.handle(quitChord('linux', 'keyDown'), null, win)).toBe(false)
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

  it('the hold’s window losing the keyboard ends it – ⌘Tab, a notification, Spotlight mid-hold – the panel goes and nothing quits', async () => {
    const { browser, platform, win } = start({ os: 'darwin' })
    browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win)
    const view = platform.host.views[0]!
    const requestQuit = vi.spyOn(browser, 'requestQuit')
    browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)
    vi.advanceTimersByTime(700)
    expect(browser.quitHold.holding).toBe(true)
    // The key up goes to whatever took the keyboard; this window sees only its blur.
    win.onBlur()
    expect(browser.quitHold.holding).toBe(false)
    expect(win.quitHold).toBeNull()
    expect(view.showQuitHold).toHaveBeenLastCalledWith(null)
    vi.advanceTimersByTime(QUIT_HOLD_MS)
    await settle()
    expect(requestQuit).not.toHaveBeenCalled()
    expect(platform.host.quits).toBe(0)
    // The focus flag still goes out with the blur, as before.
    expect(win.windowState().quitHold).toBeNull()
  })

  it('another window’s blur is nothing to the hold', () => {
    const { browser, win } = start({ os: 'darwin' })
    const other = browser.openWindow('synced', win)
    if (!other) throw new Error('no second window')
    browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)
    other.onBlur()
    expect(browser.quitHold.holding).toBe(true)
    expect(win.quitHold).not.toBeNull()
    win.onBlur()
    expect(browser.quitHold.holding).toBe(false)
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
