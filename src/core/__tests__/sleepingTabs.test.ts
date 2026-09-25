import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { Browser } from '../browser'
import { closeBootTabs } from './bootTab'
import { NoopGovernor, SLEEP_CHECK_MS } from '../hostDefaults'
import type { AppHost, Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import { DISCARD_BATCH_INTERVAL_MS, neverUnloaded } from '../memoryPressure'
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

/**
 * The Android shape: no resource governor (the browser falls back to `NoopGovernor`), pages
 * that only record whether they are alive.
 */
function fakePlatform(io: StoreIO): Platform & { live: Set<string> } {
  const live = new Set<string>()
  const capabilities = stub<HostCapabilities>({
    windows: false,
    updates: false,
    agents: false,
    resourceGovernor: false,
    pageControls: true,
    darkenSites: true
  })
  return {
    live,
    info: { os: 'android' as PlatformOs, version: '0.0.0' },
    capabilities,
    io,
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 412, height: 915 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true
        })
    },
    views: stub<TabViewHost>({
      createView: (tab) => {
        live.add(tab.id)
        let destroyed = false
        return stub<TabView>({
          isDestroyed: () => destroyed,
          destroy: () => {
            destroyed = true
            live.delete(tab.id)
          },
          getZoom: () => 1,
          getURL: () => tab.url,
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          navigationEntries: () => ({ entries: [], index: -1 })
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
    app: stub<AppHost>()
  } as unknown as Platform & { live: Set<string> }
}

function start(io = memoryIo()): {
  browser: Browser
  platform: ReturnType<typeof fakePlatform>
  win: ZenWindow
} {
  const platform = fakePlatform(io)
  const browser = new Browser(platform)
  browser.start()
  closeBootTabs(browser)
  const win = browser.allWindows()[0] as ZenWindow
  return { browser, platform, win }
}

/** The desktop's shape for the one figure the leaf needs: a governor that has measured every page. */
class MeasuringGovernor extends NoopGovernor {
  memoryOf(): number | null {
    return 312.4
  }
}

function startMeasuring(io = memoryIo()): ReturnType<typeof start> {
  const platform = fakePlatform(io)
  platform.createGovernor = (browser) => new MeasuringGovernor(browser)
  const browser = new Browser(platform)
  browser.start()
  closeBootTabs(browser)
  const win = browser.allWindows()[0] as ZenWindow
  return { browser, platform, win }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-19T12:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('sleeping tabs on a host without a resource governor', () => {
  it('puts a hidden page to sleep once its timeout has passed and wakes it on focus', () => {
    const { browser, platform, win } = start()
    browser.handleCommand(win, 'settings.update', { unloadTimeoutMinutes: 5 })
    const shown = browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const hidden = browser.tabs.createTab(
      { url: 'https://news.ycombinator.com/', active: false },
      win
    )
    browser.tabs.load(hidden.id, win)
    expect(platform.live.has(hidden.id)).toBe(true)

    // Four minutes on: nothing has waited long enough yet.
    vi.advanceTimersByTime(4 * 60_000)
    expect(browser.tabs.tab(hidden.id)!.discarded).toBe(false)
    // The check runs every half minute; the timeout is honoured on the first check past it.
    vi.advanceTimersByTime(60_000 + SLEEP_CHECK_MS)
    expect(browser.tabs.tab(hidden.id)!.discarded).toBe(true)
    expect(platform.live.has(hidden.id)).toBe(false)
    // The shown page is never put to sleep by the timer.
    expect(browser.tabs.tab(shown.id)!.discarded).toBe(false)
    expect(platform.live.has(shown.id)).toBe(true)

    // Focus wakes it: the page is created again.
    browser.tabs.activateTab(hidden.id, win)
    expect(browser.tabs.tab(hidden.id)!.discarded).toBe(false)
    expect(platform.live.has(hidden.id)).toBe(true)
  })

  it('honours the never-sleep list, audio and the switch', () => {
    const { browser, platform, win } = start()
    browser.handleCommand(win, 'settings.update', {
      unloadTimeoutMinutes: 1,
      unloadExcludedDomains: ['Mail.google.com']
    })
    browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const mail = browser.tabs.createTab({ url: 'https://www.mail.google.com/', active: false }, win)
    const radio = browser.tabs.createTab({ url: 'https://radio.example/', active: false }, win)
    const plain = browser.tabs.createTab({ url: 'https://plain.example/', active: false }, win)
    for (const t of [mail, radio, plain]) browser.tabs.load(t.id, win)
    browser.tabs.tab(radio.id)!.audible = true

    vi.advanceTimersByTime(2 * 60_000)
    expect(browser.tabs.tab(plain.id)!.discarded).toBe(true)
    expect(browser.tabs.tab(mail.id)!.discarded).toBe(false)
    expect(browser.tabs.tab(radio.id)!.discarded).toBe(false)

    browser.tabs.load(plain.id, win)
    browser.handleCommand(win, 'settings.update', { unloadEnabled: false })
    vi.advanceTimersByTime(5 * 60_000)
    expect(browser.tabs.tab(plain.id)!.discarded).toBe(false)
    expect(platform.live.has(plain.id)).toBe(true)
  })

  it("stores Edge's shortest timeout, half a minute, and nothing shorter", () => {
    const { browser, win } = start()
    browser.handleCommand(win, 'settings.update', { unloadTimeoutMinutes: 0.5 })
    expect(browser.state.settings.unloadTimeoutMinutes).toBe(0.5)
    browser.handleCommand(win, 'settings.update', { unloadTimeoutMinutes: 0.1 })
    expect(browser.state.settings.unloadTimeoutMinutes).toBe(0.5)
    browser.handleCommand(win, 'settings.update', { unloadTimeoutMinutes: 2.3 })
    expect(browser.state.settings.unloadTimeoutMinutes).toBe(2.5)
    browser.handleCommand(win, 'settings.update', { unloadTimeoutMinutes: 100_000 })
    expect(browser.state.settings.unloadTimeoutMinutes).toBe(1440)
    browser.handleCommand(win, 'settings.update', { unloadTimeoutMinutes: Number.NaN })
    expect(browser.state.settings.unloadTimeoutMinutes).toBe(20)
  })

  it('sleeps the pages shown longest ago under pressure, a share per level, a few at a time', () => {
    const { browser, win } = start()
    browser.handleCommand(win, 'settings.update', {
      unloadEnabled: false,
      unloadExcludedDomains: ['kept.example']
    })
    browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const hidden: Tab[] = []
    for (let i = 0; i < 8; i++) {
      const tab = browser.tabs.createTab({ url: `https://h${i}.example/`, active: false }, win)
      browser.tabs.load(tab.id, win)
      // Created in order: h0 was shown the longest ago.
      browser.tabs.tab(tab.id)!.lastActiveAt = Date.now() - (20 - i) * 60_000
      hidden.push(tab)
    }
    const kept = browser.tabs.createTab({ url: 'https://kept.example/', active: false }, win)
    browser.tabs.load(kept.id, win)
    browser.tabs.tab(kept.id)!.lastActiveAt = Date.now() - 60 * 60_000
    // Left ten seconds ago: the user is likely on the way back to it.
    const recent = browser.tabs.createTab({ url: 'https://recent.example/', active: false }, win)
    browser.tabs.load(recent.id, win)
    browser.tabs.tab(recent.id)!.lastActiveAt = Date.now() - 10_000
    const asleep = (): string[] =>
      hidden.filter((t) => browser.tabs.tab(t.id)!.discarded).map((t) => t.url)

    // Low: half of the eight eligible pages, oldest first – two at once, the rest in batches.
    browser.tabs.unloadForMemoryPressure('low')
    expect(asleep()).toEqual(['https://h0.example/', 'https://h1.example/'])
    vi.advanceTimersByTime(DISCARD_BATCH_INTERVAL_MS)
    expect(asleep()).toEqual([
      'https://h0.example/',
      'https://h1.example/',
      'https://h2.example/',
      'https://h3.example/'
    ])
    vi.advanceTimersByTime(10 * DISCARD_BATCH_INTERVAL_MS)
    expect(asleep()).toHaveLength(4)
    // The never-sleep list and the page just left hold under low pressure, whatever the
    // switch says.
    expect(browser.tabs.tab(kept.id)!.discarded).toBe(false)
    expect(browser.tabs.tab(recent.id)!.discarded).toBe(false)

    // Critical: every hidden page goes, the never-sleep list included; the shown page and the
    // one just left stay.
    browser.tabs.unloadForMemoryPressure('critical')
    vi.advanceTimersByTime(10 * DISCARD_BATCH_INTERVAL_MS)
    expect(hidden.every((t) => browser.tabs.tab(t.id)!.discarded)).toBe(true)
    expect(browser.tabs.tab(kept.id)!.discarded).toBe(true)
    expect(browser.tabs.tab(recent.id)!.discarded).toBe(false)
    expect(browser.tabs.activeTabFor(win)!.discarded).toBe(false)
  })

  it('a newer signal replaces the pending batches, and a page gone back to is left alone', () => {
    const { browser, win } = start()
    browser.handleCommand(win, 'settings.update', { unloadEnabled: false })
    browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const hidden: Tab[] = []
    for (let i = 0; i < 6; i++) {
      const tab = browser.tabs.createTab({ url: `https://h${i}.example/`, active: false }, win)
      browser.tabs.load(tab.id, win)
      browser.tabs.tab(tab.id)!.lastActiveAt = Date.now() - (20 - i) * 60_000
      hidden.push(tab)
    }
    // Critical plans all six; the first two go now.
    browser.tabs.unloadForMemoryPressure('critical')
    expect(hidden.filter((t) => browser.tabs.tab(t.id)!.discarded)).toHaveLength(2)
    // The user goes back to h2 before its batch: it is shown, and stays loaded.
    browser.tabs.activateTab(hidden[2]!.id, win)
    vi.advanceTimersByTime(10 * DISCARD_BATCH_INTERVAL_MS)
    expect(browser.tabs.tab(hidden[2]!.id)!.discarded).toBe(false)
    expect(hidden.filter((t) => browser.tabs.tab(t.id)!.discarded)).toHaveLength(5)
  })

  it('honours a never-sleep entry written as the registrable domain, not only as the host', () => {
    // The desktop's Add current site and the pill's Never unload this site write `getDomain`
    // (`google.com` for a page of `mail.google.com`); the phone's Add sheet writes a host. Both
    // forms hold a page of the site.
    const excluded = ['google.com', 'news.ycombinator.com', 'localhost']
    expect(neverUnloaded('https://mail.google.com/mail/u/0/', excluded)).toBe(true)
    expect(neverUnloaded('https://www.google.com/', excluded)).toBe(true)
    expect(neverUnloaded('https://news.ycombinator.com/item?id=1', excluded)).toBe(true)
    expect(neverUnloaded('https://www.news.ycombinator.com/', excluded)).toBe(true)
    expect(neverUnloaded('http://localhost:5173/', excluded)).toBe(true)
    // A different site of the same public suffix, an address, an empty list: no match.
    expect(neverUnloaded('https://ycombinator.com/', excluded)).toBe(false)
    expect(neverUnloaded('https://example.com/', excluded)).toBe(false)
    expect(neverUnloaded('not a url', excluded)).toBe(false)
    expect(neverUnloaded('https://google.com/', [])).toBe(false)

    const { browser, win } = start()
    browser.handleCommand(win, 'settings.update', {
      unloadTimeoutMinutes: 1,
      unloadExcludedDomains: ['google.com']
    })
    browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const mail = browser.tabs.createTab({ url: 'https://mail.google.com/', active: false }, win)
    const other = browser.tabs.createTab({ url: 'https://other.example/', active: false }, win)
    for (const t of [mail, other]) browser.tabs.load(t.id, win)
    vi.advanceTimersByTime(2 * 60_000)
    expect(browser.tabs.tab(other.id)!.discarded).toBe(true)
    expect(browser.tabs.tab(mail.id)!.discarded).toBe(false)
  })
})

describe('the wake from sleep (omnibox-40, the pill’s Memory Saver leaf)', () => {
  it('carries what the discard recorded past the wake, with the time of the wake', async () => {
    const io = memoryIo()
    const { browser, win } = startMeasuring(io)
    browser.handleCommand(win, 'settings.update', { unloadTimeoutMinutes: 1 })
    browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const hidden = browser.tabs.createTab({ url: 'https://docs.example/', active: false }, win)
    browser.tabs.load(hidden.id, win)
    expect(browser.tabs.tab(hidden.id)!.memorySaver).toBeUndefined()

    vi.advanceTimersByTime(2 * 60_000)
    const asleep = browser.tabs.tab(hidden.id)!
    expect(asleep.discarded).toBe(true)
    // The sleeping row's line: the governor's figure, rounded.
    expect(asleep.sleepSavedMb).toBe(312)
    expect(asleep.memorySaver).toBeUndefined()

    // The wake: the number moves to the leaf's record with the moment it woke; the sleeping
    // row's line goes with the sleep.
    vi.setSystemTime(new Date('2026-09-19T12:30:00Z'))
    browser.tabs.activateTab(hidden.id, win)
    const awake = browser.tabs.tab(hidden.id)!
    expect(awake.discarded).toBe(false)
    expect(awake.sleepSavedMb).toBeUndefined()
    expect(awake.memorySaver).toEqual({ savedMb: 312, wokeAt: Date.parse('2026-09-19T12:30:00Z') })

    // A session's own: the record on disk carries no wake.
    await browser.state.flush()
    const written = io.readSync('state.json')
    if (!written) throw new Error('state.json was not written')
    const persisted = JSON.parse(written) as { tabs: Array<Record<string, unknown>> }
    const record = persisted.tabs.find((t) => t.url === 'https://docs.example/')
    expect(record).toBeDefined()
    expect(record).not.toHaveProperty('memorySaver')

    // Asleep again: the last wake's leaf is over.
    browser.tabs.discard(hidden.id)
    expect(browser.tabs.tab(hidden.id)!.memorySaver).toBeUndefined()
    expect(browser.tabs.tab(hidden.id)!.sleepSavedMb).toBe(312)
  })

  it('says nothing for a tab restored asleep from disk, or slept without a figure', async () => {
    const io = memoryIo()
    const first = startMeasuring(io)
    first.browser.handleCommand(first.win, 'settings.update', { unloadTimeoutMinutes: 1 })
    first.browser.tabs.createTab({ url: 'https://example.com/', active: true }, first.win)
    const hidden = first.browser.tabs.createTab(
      { url: 'https://docs.example/', active: false },
      first.win
    )
    first.browser.tabs.load(hidden.id, first.win)
    vi.advanceTimersByTime(2 * 60_000)
    expect(first.browser.tabs.tab(hidden.id)!.sleepSavedMb).toBe(312)
    await first.browser.state.flush()

    // The next launch restores the tab asleep, its number left behind: the wake is no saving of
    // this session's, and the leaf stays away.
    const second = startMeasuring(io)
    const restored = second.browser.tabs.tab(hidden.id)!
    expect(restored.discarded).toBe(true)
    expect(restored.sleepSavedMb).toBeUndefined()
    second.browser.tabs.activateTab(hidden.id, second.win)
    expect(second.browser.tabs.tab(hidden.id)!.discarded).toBe(false)
    expect(second.browser.tabs.tab(hidden.id)!.memorySaver).toBeUndefined()

    // A host without a figure (no governor): the sleep records none, and the wake says nothing.
    const { browser, win } = start()
    browser.handleCommand(win, 'settings.update', { unloadTimeoutMinutes: 1 })
    browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const plain = browser.tabs.createTab({ url: 'https://plain.example/', active: false }, win)
    browser.tabs.load(plain.id, win)
    vi.advanceTimersByTime(2 * 60_000)
    expect(browser.tabs.tab(plain.id)!.discarded).toBe(true)
    expect(browser.tabs.tab(plain.id)!.sleepSavedMb).toBeUndefined()
    browser.tabs.activateTab(plain.id, win)
    expect(browser.tabs.tab(plain.id)!.memorySaver).toBeUndefined()
  })
})
