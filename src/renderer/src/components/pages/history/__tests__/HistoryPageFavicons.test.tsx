// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryDayGroup, Tab, UIState } from '@shared/types'
import { dayKeyOf } from '@shared/dayKey'

/*
 * The History page's favicons come from the core's favicon cache (HB-47): a row whose icon the
 * cache holds draws `zen://favicon/<hash>` – no request to the site, and the icon offline; a
 * row for a closed page whose icon is not cached draws the globe and makes no request at all;
 * a row for a page whose site is open in a tab may still show the live icon, as before. The
 * resolve is a lookup in the index the chrome already holds (`favicons.index` once, then the
 * core's `favicons.changed` deltas): no hop to the core per row.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.now()
const TODAY = dayKeyOf(NOW)
const HASH = '0123456789abcdef0123456789abcdef'
const CACHED_ICON = 'https://cached.example/favicon.ico'
const CLOSED_ICON = 'https://closed.example/favicon.ico'
const OPEN_ICON = 'https://open.example/favicon.ico'

const GROUPS: HistoryDayGroup[] = [
  {
    dayKey: TODAY,
    visits: [
      {
        id: 'cached',
        url: 'https://cached.example/docs',
        title: 'Cached docs',
        favicon: CACHED_ICON,
        visitTime: NOW - 60_000,
        transition: 'link'
      },
      {
        id: 'closed',
        url: 'https://closed.example/story',
        title: 'A closed page',
        favicon: CLOSED_ICON,
        visitTime: NOW - 120_000,
        transition: 'typed'
      },
      {
        id: 'open',
        url: 'https://www.open.example/article',
        title: 'An open page',
        favicon: OPEN_ICON,
        visitTime: NOW - 180_000,
        transition: 'link'
      }
    ]
  }
]

/** What the core's cache holds, as `favicons.index` answers it. */
let index: Array<[string, string]> = [[CACHED_ICON, HASH]]
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) => {
  if (name === 'history.grouped') return GROUPS
  if (name === 'session.recentlyClosed') return []
  if (name === 'sync.tabsFromDevices') return []
  if (name === 'history.foldedDevices') return []
  if (name === 'history.hiddenDevices') return []
  if (name === 'favicons.index') return index
  return null
})
const listeners = new Map<string, Set<(payload: unknown) => void>>()
Object.assign(window, {
  zen: {
    invoke,
    on: (name: string, fn: (payload: unknown) => void) => {
      const set = listeners.get(name) ?? new Set()
      set.add(fn)
      listeners.set(name, set)
      return () => set.delete(fn)
    }
  }
})
function emit(name: string, payload: unknown): void {
  for (const fn of listeners.get(name) ?? []) fn(payload)
}

const { HistoryPage } = await import('../HistoryPage')
const { faviconStore, startFaviconSync } = await import('@renderer/lib/favicons')
const { browserStore } = await import('@renderer/lib/browserStore')

/**
 * The state the page and the favicon slots read: the platform, and the tabs open in this window.
 * The chrome's back-state listener (`lib/back.ts`, wired as the page's prompt loads the portals)
 * reads the active tab of whatever `browserStore` holds: one space with no active tab.
 */
function state(platform: 'linux' | 'android', openUrls: string[] = []): UIState {
  return {
    platform,
    spaces: [{ id: 'space', activeTabId: null, tabIds: [] }],
    activeSpaceId: 'space',
    capabilities: { sync: true },
    sync: {
      enabled: false,
      folder: null,
      folderName: null,
      folderLost: false,
      deviceId: 'this',
      deviceName: 'This laptop',
      scope: { openTabs: false },
      lastSyncAt: null,
      lastError: null,
      syncing: false,
      devices: [],
      pendingMerge: false,
      remoteTabsVersion: 0
    },
    tabs: Object.fromEntries(openUrls.map((url, i) => [`t${i}`, { id: `t${i}`, url }]))
  } as unknown as UIState
}

function tab(): Tab {
  return {
    id: 'history',
    spaceId: 'space',
    containerId: 'default',
    url: 'zen://history',
    title: 'History',
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: false,
    discarded: false,
    frozen: false,
    cpuThrottle: 1,
    zoom: 1,
    splitGroupId: null,
    createdAt: 0,
    lastActiveAt: 0,
    errorCode: null,
    bookmarked: false,
    readerable: false,
    blockedCount: 0,
    openerTabId: null
  } as Tab
}

let root: Root | null = null
let mount: HTMLElement | null = null

async function mountPage(s: UIState): Promise<HTMLElement> {
  browserStore.set({ state: s })
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  await act(async () => root!.render(createElement(HistoryPage, { state: s, tab: tab() })))
  await flush()
  return mount
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

/** The favicon `<img>` of the visit row `id`, or null when the row draws its glyph. */
function rowImg(el: HTMLElement, id: string): HTMLImageElement | null {
  return el.querySelector<HTMLImageElement>(`[data-visit-id="${id}"] .zen-page-row-lead img`)
}

function rowGlyph(el: HTMLElement, id: string): Element | null {
  return el.querySelector(`[data-visit-id="${id}"] .zen-page-row-lead svg`)
}

beforeEach(async () => {
  index = [[CACHED_ICON, HASH]]
  invoke.mockClear()
  faviconStore.set({ index: new Map() })
  // The chrome starts the sync once per document (`main.tsx`); each test is a fresh start.
  ;(globalThis as { __zenFaviconSyncStarted?: boolean }).__zenFaviconSyncStarted = false
  startFaviconSync()
  await flush()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  browserStore.set({ state: null })
})

describe('the History page draws its favicons from the cache', () => {
  it('asks the core for the index once at start, never per row', async () => {
    const el = await mountPage(state('linux'))
    expect(invoke.mock.calls.filter((c) => c[0] === 'favicons.index')).toHaveLength(1)
    expect(el.querySelectorAll('[data-visit-id]')).toHaveLength(3)
    // No command of the favicon family is sent while the rows render.
    const faviconCommands = invoke.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].startsWith('favicons.')
    )
    expect(faviconCommands).toHaveLength(1)
  })

  it('shows a cached icon from the core\'s copy: no <img src="https://…"> for it', async () => {
    const el = await mountPage(state('linux'))
    const img = rowImg(el, 'cached')
    expect(img?.getAttribute('src')).toBe(`zen://favicon/${HASH}`)
    expect(el.querySelectorAll(`img[src="${CACHED_ICON}"]`)).toHaveLength(0)
  })

  it('draws the globe, and makes no request, for an uncached icon of a page that is not open', async () => {
    const el = await mountPage(state('linux', ['https://elsewhere.example/']))
    expect(rowImg(el, 'closed')).toBeNull()
    expect(rowGlyph(el, 'closed')).not.toBeNull()
    expect(el.querySelectorAll('img[src^="https://"]')).toHaveLength(0)
    expect(el.querySelectorAll('img[src^="http://"]')).toHaveLength(0)
  })

  it('keeps the live icon for a page whose site is open in a tab (www. aside)', async () => {
    const el = await mountPage(state('linux', ['https://open.example/home']))
    expect(rowImg(el, 'open')?.getAttribute('src')).toBe(OPEN_ICON)
    // The closed page's row is still the globe: only its own site's tab would let it load live.
    expect(rowImg(el, 'closed')).toBeNull()
  })

  it("flips a row to the cached copy when the core's delta says the icon is now kept", async () => {
    const el = await mountPage(state('linux'))
    expect(rowImg(el, 'closed')).toBeNull()
    await act(async () => {
      emit('favicons.changed', {
        added: [[CLOSED_ICON, 'fedcba9876543210fedcba9876543210']],
        removed: []
      })
    })
    expect(rowImg(el, 'closed')?.getAttribute('src')).toBe(
      'zen://favicon/fedcba9876543210fedcba9876543210'
    )
    // And back to the globe when it is evicted.
    await act(async () => {
      emit('favicons.changed', { added: [], removed: [CLOSED_ICON] })
    })
    expect(rowImg(el, 'closed')).toBeNull()
  })

  it("serves the cached copy from the app origin's /zen-favicon/ path on Android", async () => {
    const el = await mountPage(state('android'))
    expect(rowImg(el, 'cached')?.getAttribute('src')).toBe(
      `https://appassets.androidplatform.net/zen-favicon/${HASH}`
    )
  })

  it('draws a record that already holds the content address (an Android data: icon kept) the same way', async () => {
    index = []
    GROUPS[0]!.visits[1]!.favicon = `zen://favicon/${HASH}`
    try {
      const el = await mountPage(state('android'))
      expect(rowImg(el, 'closed')?.getAttribute('src')).toBe(
        `https://appassets.androidplatform.net/zen-favicon/${HASH}`
      )
    } finally {
      GROUPS[0]!.visits[1]!.favicon = CLOSED_ICON
    }
  })

  it("the desktop chrome document's CSP lets an <img> load zen://favicon/<hash> (img-src zen:)", () => {
    // Without `zen:` in `img-src` every cached icon is refused by the document itself and the
    // rows all fall to the glyph – what the real-build probe of pass 7 first found.
    const html = readFileSync(resolve(process.cwd(), 'src/renderer/index.html'), 'utf8')
    const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)
    const imgSrc = meta?.[1]
      .split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('img-src '))
    expect(imgSrc?.split(/\s+/)).toContain('zen:')
  })
})
