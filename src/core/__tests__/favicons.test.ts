import { describe, expect, it, vi } from 'vitest'
import { faviconUrl } from '../../shared/favicons'
import {
  PRIVATE_CONTAINER_ID,
  type HostCapabilities,
  type Platform as PlatformOs,
  type Tab
} from '../../shared/types'
import { Browser } from '../browser'
import {
  FAVICONS_INDEX,
  FaviconService,
  decodeDataUrl,
  encodeDataUrl,
  faviconHash,
  imageTypeOf,
  sniffImageType,
  type FaviconBytes
} from '../favicons'
import type {
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'

/*
 * The favicon cache (HB-47, Chrome's Favicons DB): the core keeps a copy of every icon a page
 * reports, keyed by the icon's address and deduplicated by content, one `favicons/<hash>`
 * document per icon through the platform's document I/O, bounded and least-recently-used
 * first; history rows, bookmarks and tabs are drawn from `zen://favicon/<hash>` offline and
 * without a request to every site the user ever visited.
 */

function memoryIo(files: Record<string, string>): StoreIO & { removed: string[] } {
  const removed: string[] = []
  return {
    removed,
    readSync: (name) => files[name] ?? null,
    read: async (name) => files[name] ?? null,
    write: async (name, text) => {
      files[name] = text
    },
    writeSync: (name, text) => {
      files[name] = text
    },
    remove: async (name) => {
      delete files[name]
      removed.push(name)
    }
  }
}

/** A PNG's bytes as the sniffer knows them (its signature), `size` bytes long, `seed` telling them apart. */
function png(seed: number, size = 64): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  for (let i = 8; i < size; i++) bytes[i] = (seed * 31 + i) & 0xff
  return bytes
}

/** An ICO's signature. */
function ico(seed: number, size = 64): Uint8Array {
  const bytes = png(seed, size)
  bytes.set([0x00, 0x00, 0x01, 0x00])
  return bytes
}

const A = 'https://a.example/favicon.ico'
const B = 'https://b.example/favicon.ico'
const C = 'https://c.example/icons/c.png'

function clock(): { now: () => number; tick: () => void } {
  let t = 1_000
  return { now: () => t, tick: () => (t += 1) }
}

function service(
  files: Record<string, string> = {},
  options: ConstructorParameters<typeof FaviconService>[1] = {}
): { store: FaviconService; io: ReturnType<typeof memoryIo>; files: Record<string, string> } {
  const io = memoryIo(files)
  return { store: new FaviconService(io, options), io, files }
}

describe('the image types', () => {
  it('are sniffed from the bytes, the declared type standing only for SVG and AVIF', () => {
    expect(sniffImageType(png(1))).toBe('image/png')
    expect(sniffImageType(ico(1))).toBe('image/x-icon')
    expect(sniffImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif')
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageType(new TextEncoder().encode('<html>'))).toBeNull()
    expect(imageTypeOf(png(1), 'text/plain')).toBe('image/png')
    expect(imageTypeOf(new TextEncoder().encode('<svg/>'), 'image/svg+xml; charset=utf-8')).toBe(
      'image/svg+xml'
    )
    expect(imageTypeOf(new TextEncoder().encode('<html>'), 'text/html')).toBeNull()
  })

  it('round-trip through the data: URL an icon is kept as', () => {
    const icon: FaviconBytes = { bytes: png(7), mime: 'image/png' }
    const text = encodeDataUrl(icon)
    expect(text.startsWith('data:image/png;base64,')).toBe(true)
    const back = decodeDataUrl(text)
    expect(back?.mime).toBe('image/png')
    expect(back && [...back.bytes]).toEqual([...icon.bytes])
    // Not base64, not an image: not kept.
    expect(decodeDataUrl('data:text/plain,hello')).toBeNull()
    expect(decodeDataUrl('data:text/html;base64,PGh0bWw+')).toBeNull()
    expect(decodeDataUrl('https://a.example/favicon.ico')).toBeNull()
  })
})

describe('the favicon store', () => {
  it('keeps an icon under its address as one favicons/<hash> document and resolves it', async () => {
    const { store, files } = service()
    const bytes = png(1)
    const hash = faviconHash(bytes)
    expect(hash).toMatch(/^[0-9a-f]{32}$/)
    expect(store.resolve(A)).toBeNull()
    expect(store.has(A)).toBe(false)

    const address = await store.put(A, { bytes, mime: 'image/png' })
    expect(address).toBe(faviconUrl(hash))
    expect(store.resolve(A)).toBe(address)
    expect(store.has(A)).toBe(true)
    // The content address resolves to itself while the icon is kept.
    expect(store.resolve(address!)).toBe(address)
    expect(store.index()).toEqual([[A, hash]])
    expect(store.size()).toEqual({ entries: 1, bytes: bytes.length })

    // The document is the icon as a data: URL, written before the index listed it.
    expect(files[`favicons/${hash}`]).toBe(encodeDataUrl({ bytes, mime: 'image/png' }))
    const served = await store.document(hash)
    expect(served?.mime).toBe('image/png')
    expect(served && [...served.bytes]).toEqual([...bytes])
    expect(await store.document('0'.repeat(32))).toBeNull()

    // The index is persisted (debounced); flushed, it names the entry and the address.
    store.flushSync()
    const persisted = JSON.parse(files[FAVICONS_INDEX]!) as {
      version: number
      entries: Record<string, { mime: string; bytes: number }>
      urls: Record<string, string>
    }
    expect(persisted.version).toBe(1)
    expect(persisted.entries[hash]).toMatchObject({ mime: 'image/png', bytes: bytes.length })
    expect(persisted.urls).toEqual({ [A]: hash })
  })

  it('takes the type from the bytes when the server misnames them', async () => {
    const { store } = service()
    const address = await store.put(A, { bytes: ico(2), mime: 'text/plain' })
    expect(address).not.toBeNull()
    const hash = faviconHash(ico(2))
    expect((await store.document(hash))?.mime).toBe('image/x-icon')
  })

  it('deduplicates by content: two addresses with the same bytes share one copy', async () => {
    const { store, files } = service()
    const bytes = png(3)
    const first = await store.put(A, { bytes, mime: 'image/png' })
    const second = await store.put(B, { bytes, mime: 'image/png' })
    expect(second).toBe(first)
    expect(store.size()).toEqual({ entries: 1, bytes: bytes.length })
    expect(Object.keys(files).filter((n) => n.startsWith('favicons/'))).toHaveLength(1)
    expect(
      store
        .index()
        .map(([url]) => url)
        .sort()
    ).toEqual([A, B])
  })

  it('skips an icon over the cap, an empty one, and bytes that are no image', async () => {
    const { store, files } = service({}, { maxIconBytes: 100 })
    expect(await store.put(A, { bytes: png(4, 101), mime: 'image/png' })).toBeNull()
    expect(await store.put(A, { bytes: new Uint8Array(0), mime: 'image/png' })).toBeNull()
    expect(
      await store.put(A, { bytes: new TextEncoder().encode('<html>'), mime: 'image/png' })
    ).toBeNull()
    expect(store.size()).toEqual({ entries: 0, bytes: 0 })
    expect(Object.keys(files)).toEqual([])
    // At the cap exactly: kept.
    expect(await store.put(A, { bytes: png(4, 100), mime: 'image/png' })).not.toBeNull()
  })

  it('evicts the least recently used icon past the entry bound, its document and addresses with it', async () => {
    const time = clock()
    const { store, io } = service({}, { maxEntries: 2, now: time.now })
    const changes: Array<{ added: Array<[string, string]>; removed: string[] }> = []
    store.onChange((c) => changes.push(c))

    await store.put(A, { bytes: png(1), mime: 'image/png' })
    time.tick()
    await store.put(B, { bytes: png(2), mime: 'image/png' })
    time.tick()
    // A is used again (a page reported it): B is now the oldest.
    expect(await store.receive(A)).toBe(store.resolve(A))
    time.tick()
    await store.put(C, { bytes: png(3), mime: 'image/png' })

    expect(store.resolve(A)).not.toBeNull()
    expect(store.resolve(B)).toBeNull()
    expect(store.resolve(C)).not.toBeNull()
    expect(store.size().entries).toBe(2)
    expect(io.removed).toEqual([`favicons/${faviconHash(png(2))}`])
    expect(changes.at(-1)).toEqual({ added: [[C, faviconHash(png(3))]], removed: [B] })
  })

  it('evicts past the byte bound too, and serving an icon is a use of it', async () => {
    const time = clock()
    const { store } = service({}, { maxBytes: 150, now: time.now })
    await store.put(A, { bytes: png(1, 64), mime: 'image/png' })
    time.tick()
    await store.put(B, { bytes: png(2, 64), mime: 'image/png' })
    time.tick()
    // The host served A: it is the newer of the two.
    expect(await store.document(faviconHash(png(1, 64)))).not.toBeNull()
    time.tick()
    await store.put(C, { bytes: png(3, 64), mime: 'image/png' })
    expect(store.resolve(A)).not.toBeNull()
    expect(store.resolve(B)).toBeNull()
    expect(store.resolve(C)).not.toBeNull()
    expect(store.size().bytes).toBe(128)
  })

  it('fetches an http(s) icon it lacks once, sharing the fetch between callers, and remembers a refusal', async () => {
    const { store } = service()
    const fetcher = vi.fn(async (url: string): Promise<FaviconBytes | null> =>
      url === A ? { bytes: png(5), mime: 'image/png' } : null
    )
    const [first, second] = await Promise.all([
      store.receive(A, fetcher),
      store.receive(A, fetcher)
    ])
    expect(first).toBe(faviconUrl(faviconHash(png(5))))
    expect(second).toBe(first)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith(A, 16 * 1024)

    // Held now: a report is a use, not a fetch.
    expect(await store.receive(A, fetcher)).toBe(first)
    expect(fetcher).toHaveBeenCalledTimes(1)

    // A refusal is remembered for the session: no second request for the same address.
    expect(await store.receive(B, fetcher)).toBeNull()
    expect(await store.receive(B, fetcher)).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)

    // A fetcher that throws is a refusal too.
    const failing = vi.fn(async (): Promise<FaviconBytes | null> => {
      throw new Error('offline')
    })
    expect(await store.receive(C, failing)).toBeNull()
    expect(failing).toHaveBeenCalledTimes(1)

    // No fetcher (Android's host): nothing is asked, nothing kept.
    expect(await store.receive('https://d.example/favicon.ico')).toBeNull()
  })

  it('keeps a data: icon under its content address alone; the data URL itself is no key', async () => {
    const { store } = service()
    const bytes = png(6)
    const dataUrl = encodeDataUrl({ bytes, mime: 'image/png' })
    const address = await store.receive(dataUrl)
    expect(address).toBe(faviconUrl(faviconHash(bytes)))
    expect(store.resolve(address!)).toBe(address)
    expect(store.index()).toEqual([])
    expect(store.size().entries).toBe(1)
    // A data: URL that is no image is not kept.
    expect(await store.receive('data:text/html;base64,PGh0bWw+')).toBeNull()
  })

  it('is restored from its documents at the next start', async () => {
    const files: Record<string, string> = {}
    const first = service(files).store
    await first.put(A, { bytes: png(1), mime: 'image/png' })
    await first.put(B, { bytes: png(2), mime: 'image/png' })
    first.flushSync()

    const second = service(files).store
    expect(second.size()).toEqual({ entries: 2, bytes: 128 })
    expect(second.resolve(A)).toBe(faviconUrl(faviconHash(png(1))))
    expect(second.resolve(B)).toBe(faviconUrl(faviconHash(png(2))))
    expect((await second.document(faviconHash(png(2))))?.mime).toBe('image/png')
  })

  it('drops an entry whose document has gone when asked to serve it', async () => {
    const { store, files } = service()
    await store.put(A, { bytes: png(1), mime: 'image/png' })
    const hash = faviconHash(png(1))
    delete files[`favicons/${hash}`]
    expect(await store.document(hash)).toBeNull()
    expect(store.resolve(A)).toBeNull()
    expect(store.size()).toEqual({ entries: 0, bytes: 0 })
  })

  it('forgets the icons nothing refers to any more when history is cleared, keeping the referenced', async () => {
    const { store, io } = service()
    const changes: Array<{ added: Array<[string, string]>; removed: string[] }> = []
    await store.put(A, { bytes: png(1), mime: 'image/png' })
    await store.put(B, { bytes: png(2), mime: 'image/png' })
    // C shares B's bytes: one entry, two addresses.
    await store.put(C, { bytes: png(2), mime: 'image/png' })
    const dataAddress = await store.receive(encodeDataUrl({ bytes: png(3), mime: 'image/png' }))
    store.onChange((c) => changes.push(c))

    // A bookmark holds B; an open tab holds the content address; nothing holds A or C.
    store.forget(new Set([B, dataAddress!]))
    expect(store.resolve(A)).toBeNull()
    expect(store.resolve(B)).not.toBeNull()
    expect(store.resolve(C)).toBeNull()
    expect(store.resolve(dataAddress!)).toBe(dataAddress)
    expect(store.size().entries).toBe(2)
    expect(io.removed).toEqual([`favicons/${faviconHash(png(1))}`])
    expect(changes).toEqual([{ added: [], removed: [A, C] }])
  })
})

// ---------------------------------------------------------------------------
// The receive through the browser: a tab's favicon event
// ---------------------------------------------------------------------------

function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

interface Recorded {
  tabId: string
  readonly events: TabViewEvents
  destroyed: boolean
}

interface Fixture {
  browser: Browser
  views: Recorded[]
  files: Record<string, string>
  fetches: string[]
  sent: Array<[string, unknown]>
}

function fixture(os: PlatformOs, icons: Record<string, FaviconBytes> = {}): Fixture {
  const views: Recorded[] = []
  const files: Record<string, string> = {}
  const fetches: string[] = []
  const sent: Array<[string, unknown]> = []
  const capabilities = stub<HostCapabilities>({
    windows: true,
    updates: false,
    agents: false,
    newTabPage: false,
    pageTabs: false
  })
  const platform: Platform = {
    info: { os, version: '0.0.0' },
    capabilities,
    io: memoryIo(files),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          send: (name: string, payload: unknown) => {
            sent.push([name, payload])
          },
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true
        })
    },
    views: stub<TabViewHost>({
      createView: (tab: Tab, events: TabViewEvents) => {
        const record: Recorded = { tabId: tab.id, events, destroyed: false }
        views.push(record)
        let url = tab.url
        const view: Partial<TabView> = {
          isDestroyed: () => record.destroyed,
          isVisible: () => false,
          hasDocument: () => url !== '',
          getURL: () => url,
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          navigationEntries: () => ({ entries: [], index: -1 }),
          loadURL: (u: string) => {
            url = u
          },
          destroy: () => {
            record.destroyed = true
          }
        }
        // The desktop host fetches through the page's own session; Android's leaves it out.
        if (os !== 'android')
          view.fetchFavicon = async (iconUrl: string) => {
            fetches.push(iconUrl)
            return icons[iconUrl] ?? null
          }
        return stub<TabView>(view)
      }
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  return { browser, views, files, fetches, sent }
}

function viewOf(f: Fixture, tab: Tab): Recorded {
  const record = f.views.find((v) => v.tabId === tab.id && !v.destroyed)
  if (!record) throw new Error(`no live view for ${tab.url}`)
  return record
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
}

const PAGE = 'https://a.example/docs'

describe('a page reporting its favicon', () => {
  it("is fetched once through the tab's own session on the desktop and kept; the records keep the address as key", async () => {
    const f = fixture('linux', { [A]: { bytes: png(1), mime: 'image/png' } })
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    viewOf(f, tab).events.onNavigated(PAGE, false)
    viewOf(f, tab).events.onFaviconUpdated([A])
    await settle()

    expect(f.fetches).toEqual([A])
    const address = faviconUrl(faviconHash(png(1)))
    expect(f.browser.favicons.resolve(A)).toBe(address)
    // The tab and history keep the icon's address – what sync exports and Chrome's DB keys by.
    expect(f.browser.tabs.tab(tab.id)!.favicon).toBe(A)
    expect(f.browser.history.recent(5).find((e) => e.url === PAGE)?.favicon).toBe(A)
    // The chrome learned of the copy without a state broadcast carrying the index.
    expect(f.sent.filter(([name]) => name === 'favicons.changed').map(([, p]) => p)).toEqual([
      { added: [[A, faviconHash(png(1))]], removed: [] }
    ])
    expect(f.browser.favicons.index()).toEqual([[A, faviconHash(png(1))]])

    // Reported again (another page of the site): no second fetch.
    viewOf(f, tab).events.onFaviconUpdated([A])
    await settle()
    expect(f.fetches).toEqual([A])
  })

  it("keeps Android's data: icon once and rewrites the tab's and history's records to the content address", async () => {
    const f = fixture('android')
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    viewOf(f, tab).events.onNavigated(PAGE, false)
    const dataUrl = encodeDataUrl({ bytes: png(2), mime: 'image/png' })
    viewOf(f, tab).events.onFaviconUpdated([dataUrl])
    await settle()

    const address = faviconUrl(faviconHash(png(2)))
    expect(f.browser.tabs.tab(tab.id)!.favicon).toBe(address)
    expect(f.browser.history.recent(5).find((e) => e.url === PAGE)?.favicon).toBe(address)
    expect(f.browser.favicons.resolve(address)).toBe(address)
    expect(f.files[`favicons/${faviconHash(png(2))}`]).toBe(dataUrl)
    // history.json holds the address, not the bytes.
    f.browser.flushSync()
    expect(f.files['history.json']).not.toContain('base64')
    expect(f.files['history.json']).toContain(address)
  })

  it('does not fetch an Android http(s) icon: the host has no session fetch, the record keeps the address', async () => {
    const f = fixture('android')
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    viewOf(f, tab).events.onNavigated(PAGE, false)
    viewOf(f, tab).events.onFaviconUpdated([A])
    await settle()
    expect(f.fetches).toEqual([])
    expect(f.browser.favicons.resolve(A)).toBeNull()
    expect(f.browser.tabs.tab(tab.id)!.favicon).toBe(A)
  })

  it('is never kept for a private tab', async () => {
    const f = fixture('linux', { [A]: { bytes: png(1), mime: 'image/png' } })
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab(
      { url: PAGE, active: true, containerId: PRIVATE_CONTAINER_ID },
      win
    )
    viewOf(f, tab).events.onNavigated(PAGE, false)
    viewOf(f, tab).events.onFaviconUpdated([A])
    await settle()
    expect(f.fetches).toEqual([])
    expect(f.browser.favicons.size().entries).toBe(0)
    expect(f.browser.tabs.tab(tab.id)!.favicon).toBe(A)
  })

  it('goes with a history clear unless a bookmark or an open tab still refers to it', async () => {
    const f = fixture('linux', {
      [A]: { bytes: png(1), mime: 'image/png' },
      [B]: { bytes: png(2), mime: 'image/png' }
    })
    const win = f.browser.focusedWindow()
    const a = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    viewOf(f, a).events.onNavigated(PAGE, false)
    viewOf(f, a).events.onFaviconUpdated([A])
    const b = f.browser.tabs.createTab({ url: 'https://b.example/', active: true }, win)
    viewOf(f, b).events.onNavigated('https://b.example/', false)
    viewOf(f, b).events.onFaviconUpdated([B])
    await settle()
    expect(f.browser.favicons.size().entries).toBe(2)

    // B's tab closes; A's stays open.
    f.browser.tabs.closeTab(b.id, true, win)
    f.browser.history.clear()
    expect(f.browser.favicons.resolve(A)).not.toBeNull()
    expect(f.browser.favicons.resolve(B)).toBeNull()
  })
})
