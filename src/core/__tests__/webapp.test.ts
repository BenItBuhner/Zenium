import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebAppService } from '../webapp'
import type { Browser } from '../browser'
import type { PageHostMessage, ShortcutRequest, StoreIO } from '../platform'
import type { ZenWindow } from '../window'
import type { Tab } from '../../shared/types'
import { MIN_VISIT_GAP_MS } from '../../shared/webApp'

const DOCUMENT_URL = 'https://app.example/'
const MANIFEST_URL = 'https://app.example/manifest.webmanifest'
/** Without a manifest `id` the app's id is its start URL. */
const MANIFEST_ID = DOCUMENT_URL
const MANIFEST = {
  name: 'Sketch Studio',
  short_name: 'Sketch',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' }]
}

interface Harness {
  browser: Browser
  service: WebAppService
  tab: Tab
  win: ZenWindow
  events: Array<{ name: string; payload: unknown }>
  toasts: string[]
  pageMessages: PageHostMessage[]
  pins: ShortcutRequest[]
  unpins: string[]
  /** Windows `openAppWindow` made, with the URL each opened at. */
  appWindows: Array<{ url: string; win: ZenWindow; shown: number }>
  /** Tabs the core closed (the installing tab moving into the app window). */
  closedTabs: string[]
  createdTabs: Array<{ url: string }>
  navigations: Array<{ tabId: string; url: string }>
  now: { value: number }
}

function harness(
  options: { pinOk?: boolean; desktop?: boolean; installSurface?: boolean } = {}
): Harness {
  const events: Harness['events'] = []
  const toasts: string[] = []
  const pageMessages: PageHostMessage[] = []
  const pins: ShortcutRequest[] = []
  const unpins: string[] = []
  const appWindows: Harness['appWindows'] = []
  const closedTabs: string[] = []
  const createdTabs: Array<{ url: string }> = []
  const navigations: Array<{ tabId: string; url: string }> = []
  const now = { value: 1_700_000_000_000 }
  // The window's chrome has an install surface up (the phone's sheet, the desktop's dialog to
  // come) unless a test says otherwise (`ui.surface`).
  const win = {
    id: 'w1',
    isPrivate: false,
    chrome: 'full',
    app: null,
    surfaces: new Set(options.installSurface === false ? [] : ['install'])
  } as unknown as ZenWindow
  const tab = {
    id: 't1',
    url: DOCUMENT_URL,
    title: 'Sketch',
    favicon: null,
    spaceId: 'space',
    webApp: null
  } as unknown as Tab
  const files = new Map<string, string>()
  const io: StoreIO = {
    readSync: (name) => files.get(name) ?? null,
    write: async (name, text) => {
      files.set(name, text)
    },
    writeSync: (name, text) => {
      files.set(name, text)
    }
  } as unknown as StoreIO
  const windows: ZenWindow[] = [win]
  const browser = {
    platform: {
      capabilities: { pinShortcuts: true },
      shortcuts: {
        pin: async (request: ShortcutRequest) => {
          pins.push(request)
          return options.pinOk ?? true
        },
        unpin: async (id: string) => {
          unpins.push(id)
        }
      },
      net: { fetchText: async () => ({ ok: false, status: 404, text: '' }) }
    },
    state: {
      model: { spaces: [], localSpaces: {} },
      settings: { colorScheme: 'light' },
      capabilities: { windows: options.desktop ?? false },
      commitVolatile: vi.fn()
    },
    tabs: {
      tab: (id: string) => (id === tab.id ? tab : undefined),
      windowFor: () => win,
      activeTabFor: () => tab,
      isPrivate: () => false,
      view: () => ({ postToPage: (m: PageHostMessage) => pageMessages.push(m) }),
      closeTab: (id: string) => {
        closedTabs.push(id)
      },
      createTab: (init: { url: string }) => {
        createdTabs.push({ url: init.url })
      },
      navigate: (tabId: string, url: string) => {
        navigations.push({ tabId, url })
      }
    },
    allWindows: () => windows,
    openAppWindow: (url: string) => {
      const record = service.pinnedFor(url)
      const appWin = {
        id: `app${appWindows.length + 1}`,
        isPrivate: false,
        chrome: 'app',
        isClosing: false,
        closeApproved: false,
        app: record
          ? {
              name: record.name,
              icon: record.icon ?? null,
              scope: record.scope,
              appId: record.id,
              startUrl: record.startUrl
            }
          : null,
        host: {
          show: () => {
            entry.shown++
          },
          focus: () => {},
          close: () => {
            appWin.isClosing = true
          }
        }
      }
      const entry = { url, win: appWin as unknown as ZenWindow, shown: 0 }
      appWindows.push(entry)
      windows.push(appWin as unknown as ZenWindow)
      return appWin
    },
    emit: (name: string, payload: unknown) => {
      events.push({ name, payload })
    },
    toast: (message: string) => {
      toasts.push(message)
    }
  }
  const service = new WebAppService(browser as unknown as Browser, io, { now: () => now.value })
  return {
    browser: browser as unknown as Browser,
    service,
    tab,
    win,
    events,
    toasts,
    pageMessages,
    pins,
    unpins,
    appWindows,
    closedTabs,
    createdTabs,
    navigations,
    now
  }
}

/** Post the manifest as the page script would (`webapp: 'manifest'` with the parsed JSON). */
function postManifest(h: Harness): void {
  h.service.handleMessage(h.tab.id, {
    type: 'webapp',
    webapp: 'manifest',
    manifestUrl: MANIFEST_URL,
    manifest: MANIFEST
  })
}

/** A second visit, far enough from the first for the engagement counter to count it. */
function revisit(h: Harness): void {
  h.now.value += MIN_VISIT_GAP_MS + 1000
  postManifest(h)
}

const bannerEvents = (h: Harness): unknown[] =>
  h.events.filter((e) => e.name === 'webapp.banner').map((e) => e.payload)

describe('WebAppService', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps the manifest on the tab and tells the page it is installable', () => {
    const h = harness()
    postManifest(h)
    expect(h.tab.webApp?.name).toBe('Sketch Studio')
    expect(h.pageMessages).toEqual([{ type: 'webapp', action: 'installable' }])
  })

  it('raises the ambient banner on the second visit, after the deferral grace', () => {
    const h = harness()
    postManifest(h)
    vi.advanceTimersByTime(5000)
    expect(bannerEvents(h)).toEqual([])
    revisit(h)
    expect(bannerEvents(h)).toEqual([])
    vi.advanceTimersByTime(1500)
    expect(bannerEvents(h)).toEqual([
      {
        tabId: 't1',
        name: 'Sketch',
        origin: 'app.example',
        icon: 'https://app.example/icon-192.png',
        tint: expect.any(String)
      }
    ])
  })

  it('holds the banner back when a site cancels beforeinstallprompt to run its own', () => {
    const h = harness()
    postManifest(h)
    revisit(h)
    h.service.handleMessage(h.tab.id, { type: 'webapp', webapp: 'deferred' })
    vi.advanceTimersByTime(5000)
    expect(bannerEvents(h)).toEqual([])
  })

  it('does not put a banner behind an install sheet the user opened meanwhile', () => {
    const h = harness()
    postManifest(h)
    revisit(h)
    h.service.openInstall(h.tab.id, h.win)
    expect(h.events.some((e) => e.name === 'webapp.install')).toBe(true)
    // An in-scope navigation while the sheet is up posts the manifest again.
    postManifest(h)
    vi.advanceTimersByTime(5000)
    expect(bannerEvents(h)).toEqual([])
  })

  it('offers the banner again once the sheet was cancelled and the app comes back later', () => {
    const h = harness()
    postManifest(h)
    revisit(h)
    h.service.openInstall(h.tab.id, h.win)
    h.service.cancelInstall(h.tab.id)
    vi.advanceTimersByTime(5000)
    expect(bannerEvents(h)).toEqual([])
    // A day later the prompt interval has passed and the install sheet is long gone.
    h.now.value += 25 * 60 * 60 * 1000
    postManifest(h)
    vi.advanceTimersByTime(1500)
    expect(bannerEvents(h)).toHaveLength(1)
  })

  it('does not advertise an app that was pinned while the banner was pending', async () => {
    const h = harness()
    postManifest(h)
    revisit(h)
    await h.service.pin(h.tab.id, 'Sketch', h.win)
    expect(h.pins).toHaveLength(1)
    h.service.onPinned(h.pins[0].id)
    // The chrome toasts it with an Open action (NOT-20); the core raises no plain toast.
    expect(h.toasts).toEqual([])
    expect(h.events.filter((e) => e.name === 'webapp.pinned').map((e) => e.payload)).toEqual([
      { tabId: 't1', name: 'Sketch', url: DOCUMENT_URL, surface: 'homeScreen', appId: MANIFEST_ID }
    ])
    vi.advanceTimersByTime(5000)
    expect(bannerEvents(h)).toEqual([])
    expect(h.service.pinnedFor(DOCUMENT_URL)?.name).toBe('Sketch')
    // A one-window host leaves the page where it is: the launcher owns the tile.
    expect(h.appWindows).toEqual([])
    expect(h.closedTabs).toEqual([])
  })

  it('opens the installing tab in an app window of its own on desktop and keeps the icon', async () => {
    const h = harness({ desktop: true })
    postManifest(h)
    h.service.openInstall(h.tab.id, h.win)
    const prompt = h.events.find((e) => e.name === 'webapp.install')?.payload as {
      surface: string
    }
    expect(prompt.surface).toBe('desktop')
    await h.service.pin(h.tab.id, 'Sketch', h.win)
    h.service.onPinned(h.pins[0].id, { icon: 'file:///icons/sketch.png' })
    expect(h.events.filter((e) => e.name === 'webapp.pinned').map((e) => e.payload)).toEqual([
      { tabId: 't1', name: 'Sketch', url: DOCUMENT_URL, surface: 'desktop', appId: MANIFEST_ID }
    ])
    const record = h.service.pinnedById(MANIFEST_ID)
    expect(record?.icon).toBe('file:///icons/sketch.png')
    // Chrome moves the page into the new app window: it opens at the tab's URL and the tab closes.
    expect(h.appWindows.map((w) => w.url)).toEqual([DOCUMENT_URL])
    expect(h.appWindows[0].shown).toBe(1)
    expect(h.closedTabs).toEqual(['t1'])
  })

  it('opens the app at its start URL when the installing tab has meanwhile left it', async () => {
    const h = harness({ desktop: true })
    postManifest(h)
    await h.service.pin(h.tab.id, 'Sketch', h.win)
    h.tab.url = 'https://elsewhere.example/'
    h.service.onPinned(h.pins[0].id)
    expect(h.appWindows.map((w) => w.url)).toEqual([DOCUMENT_URL])
    expect(h.closedTabs).toEqual([])
  })

  it('launches an installed app in its window once and brings it forward after', async () => {
    const h = harness({ desktop: true })
    postManifest(h)
    await h.service.pin(h.tab.id, 'Sketch', h.win)
    h.tab.url = 'https://elsewhere.example/'
    h.service.onPinned(h.pins[0].id)
    expect(h.appWindows).toHaveLength(1)
    h.service.launch(MANIFEST_ID, h.win)
    expect(h.appWindows).toHaveLength(1)
    expect(h.appWindows[0].shown).toBe(2)
    ;(h.appWindows[0].win as { isClosing: boolean }).isClosing = true
    h.service.launch(MANIFEST_ID, h.win)
    expect(h.appWindows).toHaveLength(2)
    expect(h.appWindows[1].url).toBe(DOCUMENT_URL)
    h.service.launch('not-an-app', h.win)
    expect(h.appWindows).toHaveLength(2)
  })

  it('launches an installed app as a tab on a one-window host', async () => {
    const h = harness()
    postManifest(h)
    await h.service.pin(h.tab.id, 'Sketch', h.win)
    h.service.onPinned(h.pins[0].id)
    // Inside the app already: the tab goes to the start URL rather than a second tab opening.
    h.tab.url = 'https://app.example/deep/page'
    h.service.launch(MANIFEST_ID, h.win)
    expect(h.navigations).toEqual([{ tabId: 't1', url: DOCUMENT_URL }])
    h.tab.url = 'https://elsewhere.example/'
    h.service.launch(MANIFEST_ID, h.win)
    expect(h.createdTabs).toEqual([{ url: DOCUMENT_URL }])
    expect(h.appWindows).toEqual([])
  })

  it('remembers where the app window stood and reopens it there', async () => {
    const h = harness({ desktop: true })
    postManifest(h)
    await h.service.pin(h.tab.id, 'Sketch', h.win)
    h.tab.url = 'https://elsewhere.example/'
    h.service.onPinned(h.pins[0].id)
    h.service.rememberBounds(MANIFEST_ID, { x: 10, y: 20, width: 800, height: 600 })
    expect(h.service.pinnedById(MANIFEST_ID)?.bounds).toEqual({
      x: 10,
      y: 20,
      width: 800,
      height: 600
    })
    h.service.rememberBounds('not-an-app', { x: 0, y: 0, width: 1, height: 1 })
    h.service.rememberBounds(MANIFEST_ID, null)
    expect(h.service.pinnedById(MANIFEST_ID)?.bounds?.width).toBe(800)
  })

  it('uninstalls: removes the launcher and the record, and closes the app windows', async () => {
    const h = harness({ desktop: true })
    postManifest(h)
    await h.service.pin(h.tab.id, 'Sketch', h.win)
    h.service.onPinned(h.pins[0].id)
    expect(h.appWindows).toHaveLength(1)
    await h.service.uninstall(MANIFEST_ID)
    expect(h.unpins).toEqual([MANIFEST_ID])
    expect(h.service.pinnedById(MANIFEST_ID)).toBeNull()
    expect(h.service.pinnedFor(DOCUMENT_URL)).toBeNull()
    expect(h.appWindows[0].win.isClosing).toBe(true)
    expect(h.appWindows[0].win.closeApproved).toBe(true)
    await h.service.uninstall(MANIFEST_ID)
    expect(h.unpins).toEqual([MANIFEST_ID])
  })

  it('swiping the banner away starts the cooldown; a timeout does not', () => {
    const h = harness()
    postManifest(h)
    revisit(h)
    vi.advanceTimersByTime(1500)
    expect(bannerEvents(h)).toHaveLength(1)
    h.service.dismissBanner(h.tab.id, 'swipe')
    // Two days on: still inside the fourteen-day cooldown.
    h.now.value += 2 * 24 * 60 * 60 * 1000
    postManifest(h)
    vi.advanceTimersByTime(1500)
    expect(bannerEvents(h)).toHaveLength(1)
  })

  it('settles a site prompt as dismissed at once, showing nothing, while the window has no install surface up', () => {
    const h = harness({ desktop: true, installSurface: false })
    postManifest(h)
    h.service.handleMessage(h.tab.id, { type: 'webapp', webapp: 'prompt' })
    // Chrome's answer for a dialog closed unanswered; no sheet is asked of the chrome.
    expect(h.pageMessages.at(-1)).toEqual({
      type: 'webapp',
      action: 'result',
      outcome: 'dismissed'
    })
    expect(h.events.filter((e) => e.name === 'webapp.install')).toEqual([])
    // The menu's way in is the same: nothing shows.
    h.service.openInstall(h.tab.id, h.win)
    expect(h.events.filter((e) => e.name === 'webapp.install')).toEqual([])
    // The surface mounting (`ui.surface`) lets the prompt through to it.
    h.win.surfaces.add('install')
    h.service.openInstall(h.tab.id, h.win)
    expect(h.events.filter((e) => e.name === 'webapp.install')).toHaveLength(1)
  })

  it('reports a failed pin and settles a site prompt as dismissed', async () => {
    const h = harness({ pinOk: false })
    postManifest(h)
    h.service.handleMessage(h.tab.id, { type: 'webapp', webapp: 'prompt' })
    await h.service.pin(h.tab.id, 'Sketch', h.win)
    expect(h.toasts).toEqual(["Couldn't add to Home screen"])
    expect(h.pageMessages.at(-1)).toEqual({
      type: 'webapp',
      action: 'result',
      outcome: 'dismissed'
    })
  })
})
