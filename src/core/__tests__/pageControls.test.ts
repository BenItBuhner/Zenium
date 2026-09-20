import { describe, expect, it } from 'vitest'
import type { HostCapabilities, PageRules, Platform as PlatformOs } from '../../shared/types'
import { Browser } from '../browser'
import type {
  AppHost,
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'
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
  events: TabViewEvents
  /** The page committed a navigation to `url` (what the engine reports through the events). */
  navigate: (url: string) => void
}

type Host = 'android' | 'desktop'

interface Sent {
  name: string
  payload: unknown
}

/**
 * A page-controls host (Android's shape) or a plain desktop host: every view records what it
 * is told, the view host keeps the last rules it was handed, the window what it was sent.
 */
function fakePlatform(
  io: StoreIO,
  host: Host = 'android',
  darkenSites: boolean = host === 'android'
): Platform & { rules: PageRules[]; records: Map<string, Recorded>; sent: Sent[] } {
  const rules: PageRules[] = []
  const records = new Map<string, Recorded>()
  const sent: Sent[] = []
  const capabilities = stub<HostCapabilities>({
    windows: host === 'desktop',
    updates: false,
    agents: false,
    pageControls: host === 'android',
    darkenSites
  })
  return {
    rules,
    records,
    sent,
    info: { os: (host === 'android' ? 'android' : 'linux') as PlatformOs, version: '0.0.0' },
    capabilities,
    io,
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () =>
            host === 'android' ? { width: 412, height: 915 } : { width: 1280, height: 800 },
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          send: (name: string, payload: unknown) => void sent.push({ name, payload })
        })
    },
    views: stub<TabViewHost>({
      createView: (tab, events) => {
        let url = tab.url
        const record: Recorded = {
          zoom: [],
          desktop: [],
          darken: [],
          loads: [],
          reloads: 0,
          events,
          navigate: (next: string) => {
            url = next
            events.onNavigated(next, false)
          }
        }
        records.set(tab.id, record)
        let zoom = 1
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          getURL: () => url,
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

function start(
  io = memoryIo(),
  host: Host = 'android',
  darkenSites: boolean = host === 'android'
): {
  browser: Browser
  platform: ReturnType<typeof fakePlatform>
  win: ZenWindow
  io: ReturnType<typeof memoryIo>
} {
  const platform = fakePlatform(io, host, darkenSites)
  const browser = new Browser(platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  return { browser, platform, win, io }
}

function last<T>(list: T[]): T | undefined {
  return list[list.length - 1]
}

function zoomChanges(platform: ReturnType<typeof fakePlatform>): unknown[] {
  return platform.sent.filter((s) => s.name === 'zoom.changed').map((s) => s.payload)
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

  it('remembers zoom per host, applies it to the live page and persists it', async () => {
    const { browser, platform, win, io } = start()
    const tab = browser.tabs.createTab(
      { url: 'https://en.wikipedia.org/wiki/Zen', active: true },
      win
    )
    const record = platform.records.get(tab.id)!
    expect(last(record.zoom)).toBe(1)

    browser.handleCommand(win, 'tab.setZoomFactor', { tabId: tab.id, factor: 1.5 })
    expect(browser.state.settings.pageControls.siteZooms).toEqual({ 'en.wikipedia.org': 1.5 })
    expect(last(record.zoom)).toBe(1.5)
    expect(browser.tabs.tab(tab.id)!.zoom).toBe(1.5)
    expect(last(platform.rules)!.zoom.sites).toEqual({ 'en.wikipedia.org': 1.5 })

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
      'en.wikipedia.org': 1.25
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
    // An internal page is drawn by the chrome: the tab never gets a view to zoom or reload.
    const tab = browser.tabs.createTab({ url: 'zen://settings', active: true }, win)
    expect(platform.records.get(tab.id)).toBeUndefined()
    browser.handleCommand(win, 'tab.setZoomFactor', { tabId: tab.id, factor: 2 })
    browser.handleCommand(win, 'tab.setDesktopSite', { tabId: tab.id, on: true })
    expect(browser.state.settings.pageControls.siteZooms).toEqual({})
    expect(browser.state.settings.pageControls.desktopSites).toEqual({})
    expect(platform.records.get(tab.id)).toBeUndefined()
  })
})

describe('zoom memory on the desktop', () => {
  it('remembers a zoom per host and applies it to every tab of the host', () => {
    const { browser, platform, win } = start(memoryIo(), 'desktop')
    const tab = browser.tabs.createTab({ url: 'https://en.wikipedia.org/', active: true }, win)
    const other = browser.tabs.createTab(
      { url: 'https://en.wikipedia.org/wiki/Zen', active: false },
      win
    )
    // Chrome's zoom levels are per host: another subdomain of the same site keeps its own.
    const sibling = browser.tabs.createTab({ url: 'https://de.wikipedia.org/', active: false }, win)
    const elsewhere = browser.tabs.createTab({ url: 'https://example.com/', active: false }, win)

    browser.handleCommand(win, 'tab.setZoom', { tabId: tab.id, delta: 1 })
    expect(browser.state.settings.pageControls.siteZooms).toEqual({ 'en.wikipedia.org': 1.1 })
    expect(last(platform.records.get(tab.id)!.zoom)).toBe(1.1)
    expect(last(platform.records.get(other.id)!.zoom)).toBe(1.1)
    expect(browser.tabs.tab(other.id)!.zoom).toBe(1.1)
    expect(last(platform.records.get(sibling.id)!.zoom)).toBe(1)
    expect(last(platform.records.get(elsewhere.id)!.zoom)).toBe(1)
    expect(zoomChanges(platform)).toEqual([
      { tabId: tab.id, factor: 1.1, siteKey: 'en.wikipedia.org' }
    ])

    // A tab of the host opened later starts at the remembered factor.
    const later = browser.tabs.createTab(
      { url: 'https://en.wikipedia.org/wiki/Tea', active: false },
      win
    )
    expect(last(platform.records.get(later.id)!.zoom)).toBe(1.1)

    // Reset takes the host back to the default zoom and forgets the exception.
    browser.handleCommand(win, 'tab.setZoom', { tabId: other.id, delta: null })
    expect(browser.state.settings.pageControls.siteZooms).toEqual({})
    expect(last(platform.records.get(tab.id)!.zoom)).toBe(1)
    expect(last(platform.records.get(later.id)!.zoom)).toBe(1)
  })

  it('leaves the desktop site and darkening controls to Chromium', () => {
    const { browser, platform, win } = start(memoryIo(), 'desktop')
    const tab = browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    browser.handleCommand(win, 'tab.setZoom', { tabId: tab.id, delta: 1 })
    const record = platform.records.get(tab.id)!
    expect(record.desktop).toEqual([])
    expect(record.darken).toEqual([])
    expect(platform.rules).toEqual([])
  })

  it('darkens sites on a desktop host that can, without the rest of the page controls', () => {
    // Electron's shape: no desktop-site switch or rules of its own, but the DevTools override.
    const { browser, platform, win } = start(memoryIo(), 'desktop', true)
    const tab = browser.tabs.createTab({ url: 'https://github.com/', active: true }, win)
    const record = platform.records.get(tab.id)!
    expect(record.desktop).toEqual([])
    expect(last(record.darken)).toBe(false)
    browser.handleCommand(win, 'settings.update', { pageControls: { darkenSites: true } })
    expect(last(record.darken)).toBe(true)
    browser.handleCommand(win, 'tab.setDarkenSite', { tabId: tab.id, on: false })
    expect(last(record.darken)).toBe(false)
    expect(browser.state.settings.pageControls.darkenSiteExceptions).toEqual({
      'github.com': false
    })
    expect(platform.rules).toEqual([])
  })

  it('takes the darkening off a page that leaves the web for the reader or an error page', () => {
    // The DevTools override outlives a navigation, and zen://reader has a theme of its own (a
    // sepia article came out inverted before the page was undarkened on the way in).
    const { browser, platform, win } = start(memoryIo(), 'desktop', true)
    browser.handleCommand(win, 'settings.update', { pageControls: { darkenSites: true } })
    const tab = browser.tabs.createTab({ url: 'https://example.com/story', active: true }, win)
    const record = platform.records.get(tab.id)!
    expect(last(record.darken)).toBe(true)
    record.navigate('zen://reader?url=https%3A%2F%2Fexample.com%2Fstory')
    expect(last(record.darken)).toBe(false)
    // Back on the web the site's rule applies again.
    record.navigate('https://example.com/next')
    expect(last(record.darken)).toBe(true)
    // A restored reader tab is created undarkened as well.
    const reader = browser.tabs.createTab(
      { url: 'zen://reader?url=https%3A%2F%2Fexample.com%2Fother', active: false },
      win
    )
    expect(platform.records.get(reader.id)!.darken).toEqual([false])
  })

  it("climbs Chrome's presets to 500 percent and down to 25", () => {
    const { browser, platform, win } = start(memoryIo(), 'desktop')
    const tab = browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const record = platform.records.get(tab.id)!
    for (let i = 0; i < 12; i++)
      browser.handleCommand(win, 'tab.setZoom', { tabId: tab.id, delta: 1 })
    expect(last(record.zoom)).toBe(5)
    expect(browser.state.settings.pageControls.siteZooms).toEqual({ 'example.com': 5 })
    for (let i = 0; i < 20; i++)
      browser.handleCommand(win, 'tab.setZoom', { tabId: tab.id, delta: -1 })
    expect(last(record.zoom)).toBe(0.25)
  })

  it('zooms internal pages and files per tab, without remembering them', () => {
    const { browser, platform, win } = start(memoryIo(), 'desktop')
    // A document page (zen://newtab has a view); a chrome page such as zen://settings has none
    // to zoom and is left alone (pages.test.ts).
    const tab = browser.tabs.createTab({ url: 'zen://newtab', active: true }, win)
    const record = platform.records.get(tab.id)!
    browser.handleCommand(win, 'tab.setZoom', { tabId: tab.id, delta: 1 })
    expect(last(record.zoom)).toBe(1.1)
    expect(browser.tabs.tab(tab.id)!.zoom).toBe(1.1)
    expect(browser.state.settings.pageControls.siteZooms).toEqual({})
    expect(zoomChanges(platform)).toEqual([{ tabId: tab.id, factor: 1.1, siteKey: null }])
    browser.handleCommand(win, 'tab.setZoom', { tabId: tab.id, delta: null })
    expect(last(record.zoom)).toBe(1)
  })

  it('reopens a site at its zoom after a relaunch', async () => {
    const io = memoryIo()
    const first = start(io, 'desktop')
    const tab = first.browser.tabs.createTab(
      { url: 'https://example.com/', active: true },
      first.win
    )
    first.browser.handleCommand(first.win, 'tab.setZoomFactor', { tabId: tab.id, factor: 1.5 })
    await new Promise((r) => setImmediate(r))
    await first.browser.state.flush()
    expect(JSON.parse(io.files['state.json']).settings.pageControls.siteZooms).toEqual({
      'example.com': 1.5
    })

    const second = start(io, 'desktop')
    const again = second.browser.tabs.createTab(
      { url: 'https://example.com/about', active: true },
      second.win
    )
    expect(last(second.platform.records.get(again.id)!.zoom)).toBe(1.5)
    expect(second.browser.tabs.tab(again.id)!.zoom).toBe(1.5)
  })
})
