import { describe, expect, it } from 'vitest'
import type { HostCapabilities, PageRules, Platform as PlatformOs } from '../../shared/types'
import { Browser } from '../browser'
import type { AppHost, Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import type { ZenWindow } from '../window'

/** In-memory documents; `state.json` is what the settings round-trip through. */
function memoryIo(files: Record<string, string> = {}): StoreIO & { files: Record<string, string> } {
  return {
    files,
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

interface Recorded {
  zoom: number[]
  desktop: boolean[]
  darken: boolean[]
  loads: string[]
  reloads: number
}

/**
 * A page-controls host (Android's shape): every view records what it is told, the view host
 * keeps the last rules it was handed.
 */
function fakePlatform(
  io: StoreIO
): Platform & { rules: PageRules[]; records: Map<string, Recorded> } {
  const rules: PageRules[] = []
  const records = new Map<string, Recorded>()
  const capabilities = stub<HostCapabilities>({
    windows: false,
    updates: false,
    agents: false,
    pageControls: true
  })
  return {
    rules,
    records,
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
        const record: Recorded = { zoom: [], desktop: [], darken: [], loads: [], reloads: 0 }
        records.set(tab.id, record)
        let zoom = 1
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          getZoom: () => zoom,
          setZoom: (factor: number) => {
            zoom = factor
            record.zoom.push(factor)
          },
          setDesktopMode: (on: boolean) => void record.desktop.push(on),
          setDarkening: (on: boolean) => void record.darken.push(on),
          loadURL: (url: string) => void record.loads.push(url),
          reload: () => void record.reloads++
        })
      },
      setPageRules: (r: PageRules) => void rules.push(r)
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

function start(io = memoryIo()): {
  browser: Browser
  platform: ReturnType<typeof fakePlatform>
  win: ZenWindow
  io: ReturnType<typeof memoryIo>
} {
  const platform = fakePlatform(io)
  const browser = new Browser(platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  return { browser, platform, win, io }
}

function last<T>(list: T[]): T | undefined {
  return list[list.length - 1]
}

describe('page controls in the browser', () => {
  it('hands the host its rules at start and pushes each change', () => {
    const { browser, platform, win } = start()
    expect(platform.rules).toHaveLength(1)
    expect(platform.rules[0]).toEqual({
      desktop: { default: false, sites: {} },
      darken: { default: false, sites: {} },
      zoom: { default: 1, sites: {}, scale: 1 },
      forceZoom: false
    })
    browser.handleCommand(win, 'settings.update', { pageControls: { forceZoom: true, zoom: 1.25 } })
    expect(last(platform.rules)).toMatchObject({ forceZoom: true, zoom: { default: 1.25 } })
    expect(browser.state.settings.pageControls.forceZoom).toBe(true)
    // The same values again are not a change.
    browser.handleCommand(win, 'settings.update', { pageControls: { forceZoom: true } })
    expect(platform.rules).toHaveLength(2)
  })

  it('remembers zoom per site, applies it to the live page and persists it', async () => {
    const { browser, platform, win, io } = start()
    const tab = browser.tabs.createTab(
      { url: 'https://en.wikipedia.org/wiki/Zen', active: true },
      win
    )
    const record = platform.records.get(tab.id)!
    expect(last(record.zoom)).toBe(1)

    browser.handleCommand(win, 'tab.setZoomFactor', { tabId: tab.id, factor: 1.5 })
    expect(browser.state.settings.pageControls.siteZooms).toEqual({ 'wikipedia.org': 1.5 })
    expect(last(record.zoom)).toBe(1.5)
    expect(browser.tabs.tab(tab.id)!.zoom).toBe(1.5)
    expect(last(platform.rules)!.zoom.sites).toEqual({ 'wikipedia.org': 1.5 })

    // The keyboard steps walk the zoom table from the site's factor.
    browser.handleCommand(win, 'tab.setZoom', { tabId: tab.id, delta: 1 })
    expect(last(record.zoom)).toBe(1.75)
    browser.handleCommand(win, 'tab.setZoom', { tabId: tab.id, delta: null })
    expect(last(record.zoom)).toBe(1)
    expect(browser.state.settings.pageControls.siteZooms).toEqual({})

    browser.handleCommand(win, 'tab.setZoomFactor', { tabId: tab.id, factor: 1.25 })
    await new Promise((r) => setImmediate(r))
    await browser.state.flush()
    expect(JSON.parse(io.files['state.json']).settings.pageControls.siteZooms).toEqual({
      'wikipedia.org': 1.25
    })
  })

  it('folds the system font scale into the default zoom only', () => {
    const { browser, platform, win } = start()
    const tab = browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const record = platform.records.get(tab.id)!
    browser.pageControls.setEnvironment({
      largeScreen: false,
      pointerAndKeyboard: false,
      fontScale: 1.3
    })
    expect(last(record.zoom)).toBe(1.3)
    expect(last(platform.rules)!.zoom.scale).toBe(1.3)
    browser.handleCommand(win, 'settings.update', {
      pageControls: { zoomIncludesOsFontSize: false }
    })
    expect(last(record.zoom)).toBe(1)
    expect(last(platform.rules)!.zoom.scale).toBe(1)
  })

  it('switches a site to the desktop layout and reloads the tab that asked', () => {
    const { browser, platform, win } = start()
    const tab = browser.tabs.createTab({ url: 'https://en.wikipedia.org/', active: true }, win)
    const other = browser.tabs.createTab({ url: 'https://de.wikipedia.org/', active: false }, win)
    const record = platform.records.get(tab.id)!
    const otherRecord = platform.records.get(other.id)!
    expect(last(record.desktop)).toBe(false)
    expect(browser.pageControls.isDesktop(tab)).toBe(false)

    browser.handleCommand(win, 'tab.setDesktopSite', { tabId: tab.id, on: true })
    expect(browser.state.settings.pageControls.desktopSites).toEqual({ 'wikipedia.org': true })
    expect(browser.pageControls.isDesktop(tab)).toBe(true)
    expect(last(record.desktop)).toBe(true)
    expect(record.reloads).toBe(1)
    // The other tab of the site follows the new user agent on its next load, without a reload now.
    expect(last(otherRecord.desktop)).toBe(true)
    expect(otherRecord.reloads).toBe(0)

    // A tablet makes the desktop the default; turning it off there is the exception.
    browser.pageControls.setEnvironment({
      largeScreen: true,
      pointerAndKeyboard: false,
      fontScale: 1
    })
    browser.handleCommand(win, 'tab.setDesktopSite', { tabId: tab.id, on: false })
    expect(browser.state.settings.pageControls.desktopSites).toEqual({ 'wikipedia.org': false })
    browser.handleCommand(win, 'tab.setDesktopSite', { tabId: tab.id, on: true })
    expect(browser.state.settings.pageControls.desktopSites).toEqual({})
  })

  it('darkens sites under the switch minus their exceptions', () => {
    const { browser, platform, win } = start()
    const tab = browser.tabs.createTab({ url: 'https://github.com/', active: true }, win)
    const record = platform.records.get(tab.id)!
    expect(last(record.darken)).toBe(false)
    browser.handleCommand(win, 'settings.update', { pageControls: { darkenSites: true } })
    expect(last(record.darken)).toBe(true)
    browser.handleCommand(win, 'tab.setDarkenSite', { tabId: tab.id, on: false })
    expect(browser.state.settings.pageControls.darkenSiteExceptions).toEqual({
      'github.com': false
    })
    expect(last(record.darken)).toBe(false)
    browser.handleCommand(win, 'pageControls.forgetSite', { kind: 'darken', domain: 'github.com' })
    expect(browser.state.settings.pageControls.darkenSiteExceptions).toEqual({})
    expect(last(record.darken)).toBe(true)
  })

  it('ignores internal pages', () => {
    const { browser, platform, win } = start()
    const tab = browser.tabs.createTab({ url: 'zen://settings', active: true }, win)
    const record = platform.records.get(tab.id)!
    browser.handleCommand(win, 'tab.setZoomFactor', { tabId: tab.id, factor: 2 })
    browser.handleCommand(win, 'tab.setDesktopSite', { tabId: tab.id, on: true })
    expect(browser.state.settings.pageControls.siteZooms).toEqual({})
    expect(browser.state.settings.pageControls.desktopSites).toEqual({})
    expect(record.zoom.every((z) => z === 1)).toBe(true)
    expect(record.reloads).toBe(0)
  })
})
