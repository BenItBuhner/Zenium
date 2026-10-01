import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BANNER_SHOWN_GRACE_MS, WebAppService } from '../webapp'
import type { Browser } from '../browser'
import type { PageHostMessage, ShortcutRequest, StoreIO } from '../platform'
import type { ZenWindow } from '../window'
import type { Tab } from '../../shared/types'
import { MIN_VISIT_GAP_MS, installedMessage, type EngagementRecord } from '../../shared/webApp'
import type { AppBadge } from '../../shared/appBadge'

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
  /** The store's files by name (`webapps.json` holds the engagement records). */
  files: Map<string, string>
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
    surfaces: new Set(options.installSurface === false ? [] : ['install']),
    host: { show: () => {}, focus: () => {} }
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
    now,
    files
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
const bannerHides = (h: Harness): unknown[] =>
  h.events.filter((e) => e.name === 'webapp.bannerHide').map((e) => e.payload)

/** The app's engagement record as the store holds it (`flushSync` writes the pending save). */
function engagement(h: Harness): EngagementRecord {
  h.service.flushSync()
  const doc = JSON.parse(h.files.get('webapps.json') ?? '{}') as {
    engagement?: Record<string, EngagementRecord>
  }
  const record = doc.engagement?.[MANIFEST_ID]
  if (!record) throw new Error('no engagement record for the app')
  return record
}

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

  it('hands the launcher the display mode, scope and colours of an app with a manifest', async () => {
    const h = harness()
    postManifest(h)
    await h.service.pin(h.tab.id, 'Sketch', h.win)
    expect(h.pins).toHaveLength(1)
    // The host's own window (activity) needs these without the page: PWA-07 reads them back.
    expect(h.pins[0]).toMatchObject({
      id: MANIFEST_ID,
      url: DOCUMENT_URL,
      display: 'standalone',
      scope: 'https://app.example/',
      themeColor: null,
      backgroundColor: null
    })
  })

  it('hands the launcher the manifest colours as hex, whatever form the manifest wrote', async () => {
    const h = harness()
    h.service.handleMessage(h.tab.id, {
      type: 'webapp',
      webapp: 'manifest',
      manifestUrl: MANIFEST_URL,
      manifest: {
        ...MANIFEST,
        display: 'minimal-ui',
        theme_color: 'rgb(0, 128, 255)',
        background_color: '#FFF'
      }
    })
    await h.service.pin(h.tab.id, 'Sketch', h.win)
    expect(h.pins[0]).toMatchObject({
      display: 'minimal-ui',
      themeColor: '#0080ff',
      backgroundColor: '#ffffff'
    })
  })

  it('leaves the display mode out of a plain page shortcut', async () => {
    const h = harness()
    await h.service.pin(h.tab.id, 'Sketch', h.win)
    expect(h.pins).toHaveLength(1)
    expect(h.pins[0].display).toBeUndefined()
    expect(h.pins[0].scope).toBeUndefined()
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

  it('hands the launcher the dialog’s "Open as window" as it stands, and no word of it from a caller without the box (the phone sheet, the pill’s popover)', async () => {
    const h = harness({ desktop: true })
    await h.service.pin(h.tab.id, 'Sketch', h.win, false)
    await h.service.pin(h.tab.id, 'Sketch', h.win, true)
    await h.service.pin(h.tab.id, 'Sketch', h.win)
    expect(h.pins.map((p) => p.openAsWindow)).toEqual([false, true, undefined])
    // Absent means absent: Android's bridge forwards the request's own keys to the launcher.
    expect('openAsWindow' in h.pins[2]).toBe(false)
  })

  it('a shortcut made to open a tab ("Open as window" off): the installing tab stays where it is, the record keeps the mode – across a reload – and the app launches as a tab, not a window', async () => {
    const h = harness({ desktop: true })
    postManifest(h)
    await h.service.pin(h.tab.id, 'Sketch', h.win, false)
    h.service.onPinned(h.pins[0].id, { icon: 'file:///icons/sketch.png' })
    expect(h.events.filter((e) => e.name === 'webapp.pinned').map((e) => e.payload)).toEqual([
      { tabId: 't1', name: 'Sketch', url: DOCUMENT_URL, surface: 'desktop', appId: MANIFEST_ID }
    ])
    // Chrome leaves the page in its tab: no app window opens and the tab does not close.
    expect(h.appWindows).toEqual([])
    expect(h.closedTabs).toEqual([])
    expect(h.service.pinnedById(MANIFEST_ID)).toMatchObject({
      icon: 'file:///icons/sketch.png',
      openAsWindow: false
    })
    // "Open <app>" follows the launcher: inside the app the tab goes to the start URL, elsewhere
    // a tab opens; never a window.
    h.tab.url = 'https://app.example/deep/page'
    h.service.launch(MANIFEST_ID, h.win)
    expect(h.navigations).toEqual([{ tabId: 't1', url: DOCUMENT_URL }])
    h.tab.url = 'https://elsewhere.example/'
    h.service.launch(MANIFEST_ID, h.win)
    expect(h.createdTabs).toEqual([{ url: DOCUMENT_URL }])
    expect(h.appWindows).toEqual([])
    // The mode is on the record the store keeps, so a later launch knows it.
    h.service.flushSync()
    const doc = JSON.parse(h.files.get('webapps.json') ?? '{}') as { pinned: unknown[] }
    expect(doc.pinned).toEqual([expect.objectContaining({ id: MANIFEST_ID, openAsWindow: false })])
    const reloaded = new WebAppService(
      h.browser,
      {
        readSync: (name: string) => h.files.get(name) ?? null,
        write: async () => {},
        writeSync: () => {}
      } as unknown as StoreIO,
      { now: () => h.now.value }
    )
    expect(reloaded.pinnedById(MANIFEST_ID)?.openAsWindow).toBe(false)
  })

  it('a share to an app whose shortcut opens a tab goes to a tab too (`launchShare`), not an app window', async () => {
    const h = harness({ desktop: true })
    h.service.handleMessage(h.tab.id, {
      type: 'webapp',
      webapp: 'manifest',
      manifestUrl: MANIFEST_URL,
      manifest: {
        ...MANIFEST,
        share_target: { action: '/share', params: { title: 'title', text: 'text', url: 'url' } }
      }
    })
    await h.service.pin(h.tab.id, 'Sketch', h.win, false)
    h.service.onPinned(h.pins[0].id)
    h.tab.url = 'https://elsewhere.example/'
    const link = 'https://news.example/story?id=7'
    expect(h.service.launchShare(MANIFEST_ID, { title: null, text: null, url: link }, h.win)).toBe(
      true
    )
    expect(h.createdTabs).toEqual([
      { url: `https://app.example/share?url=${encodeURIComponent(link)}` }
    ])
    expect(h.appWindows).toEqual([])
  })

  it('a shortcut made with the box checked opens a window as an install always did, and the record says so; a later pin without the box (the popover) rewrote the launcher on the host’s rule and the record forgets the tab mode', async () => {
    const h = harness({ desktop: true })
    postManifest(h)
    await h.service.pin(h.tab.id, 'Sketch', h.win, true)
    h.service.onPinned(h.pins[0].id)
    expect(h.appWindows.map((w) => w.url)).toEqual([DOCUMENT_URL])
    expect(h.closedTabs).toEqual(['t1'])
    expect(h.service.pinnedById(MANIFEST_ID)?.openAsWindow).toBe(true)

    await h.service.pin(h.tab.id, 'Sketch', h.win, false)
    h.service.onPinned(h.pins[1].id)
    expect(h.service.pinnedById(MANIFEST_ID)?.openAsWindow).toBe(false)
    expect(h.appWindows).toHaveLength(1)

    await h.service.pin(h.tab.id, 'Sketch', h.win)
    h.service.onPinned(h.pins[2].id)
    const record = h.service.pinnedById(MANIFEST_ID)!
    expect('openAsWindow' in record).toBe(false)
    // Without the box the host's rule stands – a window – and the app launches as one: the
    // first open window of the app comes forward.
    expect(h.appWindows).toHaveLength(2)
    h.tab.url = 'https://elsewhere.example/'
    h.service.launch(MANIFEST_ID, h.win)
    expect(h.appWindows).toHaveLength(2)
    expect(h.appWindows.map((w) => w.shown)).toEqual([2, 1])
    expect(h.createdTabs).toEqual([])
  })

  it('a page without a manifest pinned on the desktop is a shortcut, not an install: the core toasts "Shortcut created" itself and sends the chrome no `webapp.pinned`, whichever way the box stood', async () => {
    const h = harness({ desktop: true })
    await h.service.pin(h.tab.id, 'Sketch', h.win, true)
    h.service.onPinned(h.pins[0].id, { icon: 'file:///icons/sketch.png' })
    expect(h.toasts).toEqual(['Shortcut created'])
    expect(h.events.filter((e) => e.name === 'webapp.pinned')).toEqual([])
    // No record to open, no app window, the tab where it was.
    expect(h.service.pinnedFor(DOCUMENT_URL)).toBeNull()
    expect(h.appWindows).toEqual([])
    expect(h.closedTabs).toEqual([])
    // The page still hears the launcher took it, as before.
    expect(h.pageMessages.at(-1)).toEqual({ type: 'webapp', action: 'installed' })
    await h.service.pin(h.tab.id, 'Sketch', h.win, false)
    h.service.onPinned(h.pins[1].id)
    expect(h.toasts).toEqual(['Shortcut created', 'Shortcut created'])
    expect(h.events.filter((e) => e.name === 'webapp.pinned')).toEqual([])
  })

  it('a page with a manifest leaves the toast to the chrome through `webapp.pinned` – "Installed <name>" on the desktop, "Added <name> to Home screen" on the phone, where a plain page reads the same', async () => {
    const desktop = harness({ desktop: true })
    postManifest(desktop)
    await desktop.service.pin(desktop.tab.id, 'Sketch', desktop.win, true)
    desktop.service.onPinned(desktop.pins[0].id)
    expect(desktop.toasts).toEqual([])
    const installed = desktop.events.filter((e) => e.name === 'webapp.pinned')
    expect(installed.map((e) => e.payload)).toEqual([
      { tabId: 't1', name: 'Sketch', url: DOCUMENT_URL, surface: 'desktop', appId: MANIFEST_ID }
    ])
    const [app] = installed.map((e) => e.payload as { surface: 'desktop'; name: string })
    expect(installedMessage(app.surface, app.name)).toBe('Installed Sketch')

    // The phone's words are the launcher's, with or without a manifest; the core toasts nothing.
    const phone = harness()
    await phone.service.pin(phone.tab.id, 'Sketch', phone.win)
    phone.service.onPinned(phone.pins[0].id)
    postManifest(phone)
    await phone.service.pin(phone.tab.id, 'Sketch', phone.win)
    phone.service.onPinned(phone.pins[1].id)
    expect(phone.toasts).toEqual([])
    const added = phone.events
      .filter((e) => e.name === 'webapp.pinned')
      .map((e) => e.payload as { surface: 'homeScreen'; name: string; appId: string | null })
    expect(added.map((p) => p.appId)).toEqual([null, MANIFEST_ID])
    expect(added.map((p) => installedMessage(p.surface, p.name))).toEqual([
      'Added Sketch to Home screen',
      'Added Sketch to Home screen'
    ])
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

  it('lists the installed apps with how many of their windows stand open (`installed`, the snapshot’s `webApps`): the record with its count – one as installing opened the window, none while that window is closing, two with a second launch – and nothing once uninstalled', async () => {
    const h = harness({ desktop: true })
    expect(h.service.installed()).toEqual([])
    postManifest(h)
    await h.service.pin(h.tab.id, 'Sketch', h.win)
    h.tab.url = 'https://elsewhere.example/'
    h.service.onPinned(h.pins[0].id, { icon: 'file:///icons/sketch.png' })
    // Installing on desktop opened the app's window: the record, whole, with the one window.
    expect(h.appWindows).toHaveLength(1)
    const record = h.service.pinnedById(MANIFEST_ID)!
    expect(h.service.installed()).toEqual([{ ...record, windows: 1 }])
    expect(h.service.installed()[0]).toMatchObject({
      id: MANIFEST_ID,
      name: 'Sketch',
      icon: 'file:///icons/sketch.png',
      windows: 1
    })
    // A window on its way out is not counted – what `launch` does not bring forward either –
    // so the launch that opens a second window leaves the count at one, and two stand open once
    // the first is not closing after all.
    const first = h.appWindows[0].win as unknown as { isClosing: boolean }
    first.isClosing = true
    expect(h.service.installed()[0].windows).toBe(0)
    h.service.launch(MANIFEST_ID, h.win)
    expect(h.appWindows).toHaveLength(2)
    expect(h.service.installed()[0].windows).toBe(1)
    first.isClosing = false
    expect(h.service.installed()[0].windows).toBe(2)
    // The count is the snapshot's, not the record's: the stored record carries none.
    expect('windows' in record).toBe(false)
    // Uninstalled: no record, so no entry – the closing windows are no one's.
    await h.service.uninstall(MANIFEST_ID)
    expect(h.service.installed()).toEqual([])
  })

  it('counts no windows on a one-window host, whose apps open as tabs', async () => {
    const h = harness()
    postManifest(h)
    await h.service.pin(h.tab.id, 'Sketch', h.win)
    h.service.onPinned(h.pins[0].id)
    h.tab.url = 'https://elsewhere.example/'
    h.service.launch(MANIFEST_ID, h.win)
    expect(h.createdTabs).toEqual([{ url: DOCUMENT_URL }])
    expect(h.service.installed().map((a) => [a.id, a.windows])).toEqual([[MANIFEST_ID, 0]])
  })

  it('raises the ambient banner on the desktop as on the phone, now that its chrome draws it as the pill’s popover (#740, seed #42): the word stamps, and a window with no word is the grace’s case', () => {
    const h = harness({ desktop: true })
    postManifest(h)
    revisit(h)
    vi.advanceTimersByTime(1500)
    // The desktop's launcher name, the full one.
    expect(bannerEvents(h)).toEqual([
      expect.objectContaining({ tabId: 't1', name: 'Sketch Studio', origin: 'app.example' })
    ])
    expect(engagement(h)).toMatchObject({ visits: 2, promptedAt: null, dismissedAt: null })
    // The chrome's word – the popover opened – stamps the cooldown, as the phone's card does,
    // and the grace running out after it takes nothing back.
    h.service.bannerShown(h.tab.id)
    expect(engagement(h).promptedAt).toBe(h.now.value)
    vi.advanceTimersByTime(BANNER_SHOWN_GRACE_MS + 100)
    expect(bannerHides(h)).toEqual([])
    // A desktop window whose chrome gave no word – nothing drew the offer – is the grace's case
    // as anywhere: the banner withdrawn, the cooldown unspent, the record still counting.
    const quiet = harness({ desktop: true })
    postManifest(quiet)
    revisit(quiet)
    vi.advanceTimersByTime(1200 + BANNER_SHOWN_GRACE_MS)
    expect(bannerEvents(quiet)).toHaveLength(1)
    expect(bannerHides(quiet)).toEqual([{ tabId: 't1' }])
    expect(engagement(quiet)).toMatchObject({ visits: 2, promptedAt: null, dismissedAt: null })
  })

  it('stamps the cooldown on the chrome’s word that the card is drawn, not on the emit; the core runs no clock of its own – the band’s running out, reported by the chrome, records no dismissal and the day’s stamp holds', () => {
    const h = harness()
    postManifest(h)
    revisit(h)
    vi.advanceTimersByTime(1500)
    expect(bannerEvents(h)).toHaveLength(1)
    // Emitted, not yet shown as far as the core knows: nothing stamped.
    expect(engagement(h).promptedAt).toBeNull()
    h.service.bannerShown(h.tab.id)
    const stampedAt = h.now.value
    expect(engagement(h).promptedAt).toBe(stampedAt)
    // The grace running out after the word takes nothing back; a second word stamps nothing more.
    vi.advanceTimersByTime(BANNER_SHOWN_GRACE_MS + 100)
    expect(bannerHides(h)).toEqual([])
    h.now.value += 5000
    h.service.bannerShown(h.tab.id)
    expect(engagement(h).promptedAt).toBe(stampedAt)
    // One offer, one clock (the Design Lead's ruling): the clock is the band's, in the chrome.
    // The core runs none – a minute on with no word, the prompt still stands as far as it knows.
    vi.advanceTimersByTime(60_000)
    expect(bannerHides(h)).toEqual([])
    // The band's clock ran out and the chrome says so: no dismissal is recorded, and the core,
    // which took nothing down itself, emits no take-down...
    h.service.dismissBanner(h.tab.id, 'timeout')
    expect(bannerHides(h)).toEqual([])
    expect(engagement(h).dismissedAt).toBeNull()
    // ...and the stamp keeps the prompt away for the rest of the day.
    postManifest(h)
    vi.advanceTimersByTime(1500)
    expect(bannerEvents(h)).toHaveLength(1)
  })

  it('counts a prompt no chrome drew as undrawn when the grace runs out: no stamp, the banner withdrawn, the record still counting', () => {
    const h = harness()
    postManifest(h)
    revisit(h)
    vi.advanceTimersByTime(1200)
    expect(bannerEvents(h)).toHaveLength(1)
    vi.advanceTimersByTime(BANNER_SHOWN_GRACE_MS - 1)
    expect(bannerHides(h)).toEqual([])
    vi.advanceTimersByTime(1)
    // The chrome hears the take-down, so a surface mounting late never shows the card.
    expect(bannerHides(h)).toEqual([{ tabId: 't1' }])
    expect(engagement(h)).toMatchObject({ visits: 2, promptedAt: null, dismissedAt: null })
    // A late word, or a dismissal report for a card the core has let go of, changes nothing.
    h.service.bannerShown(h.tab.id)
    h.service.dismissBanner(h.tab.id, 'swipe')
    expect(engagement(h)).toMatchObject({ promptedAt: null, dismissedAt: null })
    // Nothing of the banner is left ticking in the core (it runs no clock of its own): a minute
    // on, no second take-down.
    vi.advanceTimersByTime(60_000)
    expect(bannerHides(h)).toHaveLength(1)
    // The engagement record kept counting: the next visit offers the prompt again.
    revisit(h)
    vi.advanceTimersByTime(1500)
    expect(bannerEvents(h)).toHaveLength(2)
    expect(engagement(h).visits).toBe(3)
  })

  it('a tab closing inside the grace leaves no timer and no stamp behind', () => {
    const h = harness()
    postManifest(h)
    revisit(h)
    vi.advanceTimersByTime(1500)
    expect(bannerEvents(h)).toHaveLength(1)
    h.service.onTabRemoved(h.tab.id)
    // The grace's timer went with the tab: it never counts the prompt undrawn.
    vi.advanceTimersByTime(60_000)
    expect(bannerHides(h)).toEqual([])
    h.service.bannerShown(h.tab.id)
    expect(engagement(h).promptedAt).toBeNull()
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

/*
 * The Badging API's core (MW-51): one badge per installed app, from the page script's
 * `webapp: 'badge'` message of a page in the app's own window and inside its scope; the hosts
 * hear each change; the badge is in memory alone and goes with the app's last window and with
 * the record.
 */
describe('WebAppService badges (MW-51)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const count = (value: number): AppBadge => ({ kind: 'count', value })
  const FLAG: AppBadge = { kind: 'flag' }

  interface Badged extends Harness {
    appWin: ZenWindow
    changes: Array<[string, AppBadge | null]>
    post: (badge: unknown) => void
  }

  /** The tab shows in `win` from here on (`tabs.windowFor`). */
  function showIn(h: Harness, win: ZenWindow): void {
    ;(h.browser.tabs as unknown as { windowFor: () => ZenWindow }).windowFor = () => win
  }

  /** An installed app with its window open on the desktop; the tab shows in that window. */
  async function installed(): Promise<Badged> {
    const h = harness({ desktop: true })
    postManifest(h)
    await h.service.pin(h.tab.id, 'Sketch', h.win)
    h.service.onPinned(h.pins[0].id)
    const appWin = h.appWindows[0].win
    showIn(h, appWin)
    h.tab.url = 'https://app.example/inbox'
    const changes: Array<[string, AppBadge | null]> = []
    h.service.onBadgeChange((appId, badge) => changes.push([appId, badge]))
    return {
      ...h,
      appWin,
      changes,
      post: (badge) => h.service.handleMessage(h.tab.id, { type: 'webapp', webapp: 'badge', badge })
    }
  }

  it('keeps the badge an installed app’s page sets and tells the hosts each change once', async () => {
    const h = await installed()
    expect(h.service.badgeOf(MANIFEST_ID)).toBeNull()
    h.post(count(4))
    expect(h.service.badgeOf(MANIFEST_ID)).toEqual(count(4))
    expect([...h.service.badges()]).toEqual([[MANIFEST_ID, count(4)]])
    // The same badge again is nothing; a change is one call.
    h.post(count(4))
    h.post(FLAG)
    h.post(FLAG)
    h.post(null)
    h.post(null)
    expect(h.changes).toEqual([
      [MANIFEST_ID, count(4)],
      [MANIFEST_ID, FLAG],
      [MANIFEST_ID, null]
    ])
    expect(h.service.badges().size).toBe(0)
    // The badge is the hosts' to draw, not the snapshot's: no commit, no event, and the
    // records' document does not carry it (`installed()` lists the records as before).
    const commits = h.browser.state.commitVolatile as unknown as { mockClear: () => void }
    commits.mockClear()
    h.post(count(9))
    expect(h.browser.state.commitVolatile).not.toHaveBeenCalled()
    expect(h.events.filter((e) => e.name.startsWith('webapp.badge'))).toEqual([])
    expect(h.service.installed()[0]).not.toHaveProperty('badge')
  })

  it('takes no badge from a page that is no installed app’s, out of scope, or malformed', async () => {
    const h = await installed()
    // A browser window's tab: the page script sends none, and the core holds the same line.
    showIn(h, h.win)
    h.post(count(2))
    expect(h.changes).toEqual([])
    showIn(h, h.appWin)
    // The app's window showing a page outside the app's scope.
    h.tab.url = 'https://elsewhere.example/'
    h.post(count(2))
    expect(h.changes).toEqual([])
    h.tab.url = 'https://app.example/inbox'
    // Malformed badges are dropped, never guessed at.
    for (const bad of [
      { kind: 'count', value: -1 },
      { kind: 'count', value: 0 },
      { kind: 'count', value: 1.5 },
      { kind: 'count', value: '3' },
      { kind: 'dot' },
      3,
      'flag',
      undefined
    ])
      h.post(bad)
    expect(h.changes).toEqual([])
    // A message for a tab the core does not know.
    h.service.handleMessage('t9', { type: 'webapp', webapp: 'badge', badge: count(1) })
    expect(h.changes).toEqual([])
    // An `--app=<url>` window that is no installed app's (`appId` null).
    const anonymous = { ...h.appWin, app: { ...h.appWin.app!, appId: null } } as ZenWindow
    showIn(h, anonymous)
    h.post(count(2))
    expect(h.changes).toEqual([])
    // ...and the app's own window takes it.
    showIn(h, h.appWin)
    h.post(count(2))
    expect(h.changes).toEqual([[MANIFEST_ID, count(2)]])
  })

  it('clears the badge with the app’s last window, not while another window of the app stands', async () => {
    const h = await installed()
    h.post(count(3))
    // A second window of the app (`launch` brings an open one forward, so the first is
    // "closing" for the moment of the launch, as the windows test does).
    const first = h.appWindows[0].win as unknown as { isClosing: boolean }
    first.isClosing = true
    h.service.launch(MANIFEST_ID, h.win)
    first.isClosing = false
    expect(h.appWindows).toHaveLength(2)
    const windows = h.browser.allWindows()
    const close = (win: ZenWindow): void => {
      // The browser drops the window from its list before the services hear of the close.
      windows.splice(windows.indexOf(win), 1)
      h.service.onWindowClosed(win)
    }
    close(h.appWindows[0].win)
    expect(h.service.badgeOf(MANIFEST_ID)).toEqual(count(3))
    close(h.appWindows[1].win)
    expect(h.service.badgeOf(MANIFEST_ID)).toBeNull()
    expect(h.changes).toEqual([
      [MANIFEST_ID, count(3)],
      [MANIFEST_ID, null]
    ])
    // A browser window closing says nothing; a second close of an app without a badge neither.
    close(h.win)
    h.service.onWindowClosed(h.appWindows[1].win)
    expect(h.changes).toHaveLength(2)
  })

  it('clears the badge with the record on uninstall, and takes none for an app that is not installed', async () => {
    const h = await installed()
    h.post(FLAG)
    await h.service.uninstall(MANIFEST_ID)
    expect(h.service.badgeOf(MANIFEST_ID)).toBeNull()
    expect(h.changes).toEqual([
      [MANIFEST_ID, FLAG],
      [MANIFEST_ID, null]
    ])
    // Its page is still up in the closing window: no badge for a record that is gone.
    h.post(count(1))
    h.service.setBadge('https://other.example/', count(1))
    expect(h.changes).toHaveLength(2)
    expect(h.service.badges().size).toBe(0)
    // Unsubscribed hosts hear nothing more.
    const off = h.service.onBadgeChange(() => {
      throw new Error('should not be called')
    })
    off()
    h.service.setBadge(MANIFEST_ID, null)
  })
})
