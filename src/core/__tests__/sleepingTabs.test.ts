import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { Browser } from '../browser'
import { SLEEP_CHECK_MS } from '../hostDefaults'
import type { AppHost, Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import { KEEP_UNDER_PRESSURE } from '../tabs'
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

function start(): { browser: Browser; platform: ReturnType<typeof fakePlatform>; win: ZenWindow } {
  const platform = fakePlatform(memoryIo())
  const browser = new Browser(platform)
  browser.start()
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

  it('sleeps the pages idle longest under low memory and keeps the recent few', () => {
    const { browser, win } = start()
    browser.handleCommand(win, 'settings.update', {
      unloadEnabled: false,
      unloadExcludedDomains: ['kept.example']
    })
    browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const hidden: Tab[] = []
    for (let i = 0; i < KEEP_UNDER_PRESSURE + 3; i++) {
      const tab = browser.tabs.createTab({ url: `https://h${i}.example/`, active: false }, win)
      browser.tabs.load(tab.id, win)
      // Created in order: h0 has been idle the longest.
      browser.tabs.tab(tab.id)!.lastActiveAt = Date.now() - (10 - i) * 60_000
      hidden.push(tab)
    }
    const kept = browser.tabs.createTab({ url: 'https://kept.example/', active: false }, win)
    browser.tabs.load(kept.id, win)
    browser.tabs.tab(kept.id)!.lastActiveAt = Date.now() - 60 * 60_000

    browser.tabs.unloadForMemoryPressure('low')
    const asleep = hidden.filter((t) => browser.tabs.tab(t.id)!.discarded).map((t) => t.url)
    expect(asleep).toEqual(['https://h0.example/', 'https://h1.example/', 'https://h2.example/'])
    // The never-sleep list holds under low pressure, whatever the switch says.
    expect(browser.tabs.tab(kept.id)!.discarded).toBe(false)

    // Critical: every hidden page goes, the never-sleep list included; the shown page stays.
    browser.tabs.unloadForMemoryPressure('critical')
    expect(hidden.every((t) => browser.tabs.tab(t.id)!.discarded)).toBe(true)
    expect(browser.tabs.tab(kept.id)!.discarded).toBe(true)
    expect(browser.tabs.activeTabFor(win)!.discarded).toBe(false)
  })
})
