import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebAppService } from '../webapp'
import type { Browser } from '../browser'
import type { PageHostMessage, ShortcutRequest, StoreIO } from '../platform'
import type { ZenWindow } from '../window'
import type { Tab } from '../../shared/types'
import { MIN_VISIT_GAP_MS } from '../../shared/webApp'

const DOCUMENT_URL = 'https://app.example/'
const MANIFEST_URL = 'https://app.example/manifest.webmanifest'
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
  now: { value: number }
}

function harness(options: { pinOk?: boolean } = {}): Harness {
  const events: Harness['events'] = []
  const toasts: string[] = []
  const pageMessages: PageHostMessage[] = []
  const pins: ShortcutRequest[] = []
  const now = { value: 1_700_000_000_000 }
  const win = { id: 'w1', isPrivate: false } as unknown as ZenWindow
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
  const browser = {
    platform: {
      capabilities: { pinShortcuts: true },
      shortcuts: {
        pin: async (request: ShortcutRequest) => {
          pins.push(request)
          return options.pinOk ?? true
        }
      },
      net: { fetchText: async () => ({ ok: false, status: 404, text: '' }) }
    },
    state: {
      model: { spaces: [], localSpaces: {} },
      settings: { colorScheme: 'light' },
      commitVolatile: vi.fn()
    },
    tabs: {
      tab: (id: string) => (id === tab.id ? tab : undefined),
      windowFor: () => win,
      activeTabFor: () => tab,
      isPrivate: () => false,
      view: () => ({ postToPage: (m: PageHostMessage) => pageMessages.push(m) })
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
      { tabId: 't1', name: 'Sketch', url: DOCUMENT_URL }
    ])
    vi.advanceTimersByTime(5000)
    expect(bannerEvents(h)).toEqual([])
    expect(h.service.pinnedFor(DOCUMENT_URL)?.name).toBe('Sketch')
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
