import { describe, expect, it, vi } from 'vitest'
import type { Space, Tab } from '../../../shared/types'
import type { Browser } from '../../../core/browser'
import type { CoveredPage } from '../../../core/tabs'
import type { ZenWindow } from '../../../core/window'
import { captureDenial } from '../../../core/extensions/api/capture'
import { ApiModel } from '../extensionApi/model'
import { TabsApi } from '../extensionApi/tabs'
import { UserScriptsApi } from '../extensionApi/userScripts'
import type { ApiContext, ApiHost } from '../extensionApi/types'
import type { ElectronTabViewHost } from '../views'

/**
 * The reader's cover (reader-30, W8-5) as the extension layer sees it – which is not at all:
 * under Chrome's reading mode overlay the tab never navigated, and so here. The tab's page
 * stays alive beneath the `zen://reader` document; the row says the reader meanwhile (its
 * address, its title, zoom 1) but the Chrome-facing tab is its page throughout – the id
 * (`webContentsOf` → `pageView`), the record's address, title and icon (`coveredPage`), what
 * `captureVisibleTab` captures and checks, and the `sender.tab` a world's message carries.
 * Entering and leaving the reader emits nothing: no `onUpdated`, no `onReplaced`, no
 * `onZoomChange`.
 */

const { FakeBrowserWindow, PAGE_WC_ID, COVER_WC_ID, contents } = vi.hoisted(() => {
  class FakeBrowserWindow {
    focused = true
    destroyed = false
    bounds = { x: 40, y: 40, width: 1280, height: 820 }
    constructor(readonly id: number) {}
    static fromWebContents(): null {
      return null
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return { ...this.bounds }
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    isFocused(): boolean {
      return this.focused && !this.destroyed
    }
    isMinimized(): boolean {
      return false
    }
    isFullScreen(): boolean {
      return false
    }
    isMaximized(): boolean {
      return false
    }
    isAlwaysOnTop(): boolean {
      return false
    }
    on(): this {
      return this
    }
    once(): this {
      return this
    }
  }
  const PAGE_WC_ID = 21
  const COVER_WC_ID = 22
  /** A page's WebContents as the layer reads it: an id, a life, a capture. */
  const webContents = (id: number, url: string): FakeWebContents => ({
    id,
    url,
    captured: 0,
    isDestroyed: () => false,
    isCrashed: () => false,
    getURL(): string {
      return this.url
    },
    async capturePage(): Promise<{ isEmpty(): boolean; toDataURL(): string }> {
      this.captured += 1
      return { isEmpty: () => false, toDataURL: () => `data:image/png;base64,wc${id}` }
    }
  })
  interface FakeWebContents {
    id: number
    url: string
    captured: number
    isDestroyed(): boolean
    isCrashed(): boolean
    getURL(): string
    capturePage(): Promise<{ isEmpty(): boolean; toDataURL(): string }>
  }
  const contents = new Map<number, FakeWebContents>([
    [PAGE_WC_ID, webContents(PAGE_WC_ID, 'https://example.com/story')],
    [COVER_WC_ID, webContents(COVER_WC_ID, 'zen://reader?id=article_1')]
  ])
  return { FakeBrowserWindow, PAGE_WC_ID, COVER_WC_ID, contents }
})

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  webContents: { fromId: (id: number) => contents.get(id) }
}))

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const PAGE_URL = 'https://example.com/story'
const PAGE_TITLE = 'The Story'
const PAGE_ICON = 'https://example.com/icon.png'
const READER_URL = 'zen://reader?id=article_1&url=https%3A%2F%2Fexample.com%2Fstory'
const READER_TITLE = 'Story – Reader View'

interface Broadcast {
  namespace: string
  event: string
  args: unknown[] | null
}

interface World {
  model: ApiModel
  tabs: TabsApi
  userScripts: UserScriptsApi
  ctx: ApiContext
  tab: Tab
  broadcasts: Broadcast[]
  /** `TabManager.cover`: the row flips to the reader, the page stays beneath. */
  enter(): void
  /** `TabManager.uncover`: the row's fields come back from the page. */
  exit(): void
  /** The events one tick of the differ emits for the change between two snapshots. */
  tick(): string[]
}

function world(): World {
  const bw = new FakeBrowserWindow(11)
  const tab = {
    id: 'story',
    url: PAGE_URL,
    title: PAGE_TITLE,
    favicon: PAGE_ICON,
    readerable: true,
    spaceId: 's1',
    windowId: null,
    containerId: 'default',
    pinned: false,
    essential: false,
    discarded: false,
    loading: false,
    audible: false,
    muted: false,
    frozen: false,
    zoom: 1.25,
    lastActiveAt: 1
  } as unknown as Tab
  const space = {
    id: 's1',
    tabIds: ['story'],
    windowId: null,
    containerId: 'default'
  } as unknown as Space
  const state = {
    model: {
      tabs: { story: tab } as Record<string, Tab>,
      spaces: [space],
      localSpaces: {} as Record<string, Space>,
      folders: {},
      essentialTabIds: [] as string[]
    }
  }
  const win = {
    id: 'w1',
    kind: 'synced',
    chrome: 'full',
    isPrivate: false,
    lastFocusedAt: 10,
    localSpace: null,
    glance: null,
    alive: true,
    host: { alive: true, win: bw, isFocused: () => bw.isFocused(), close: () => undefined },
    activeSpace: () => space,
    selectedTabIn: (s: Space) => s.tabIds[0] ?? null
  } as unknown as ZenWindow
  const pageView = {
    webContents: contents.get(PAGE_WC_ID),
    cover: false,
    isDestroyed: () => false,
    view: { getBounds: () => ({ x: 0, y: 80, width: 1280, height: 720 }) }
  }
  const coverView = {
    webContents: contents.get(COVER_WC_ID),
    cover: true,
    isDestroyed: () => false,
    view: { getBounds: () => ({ x: 0, y: 80, width: 1280, height: 720 }) }
  }
  let covered: CoveredPage | undefined
  const browser = {
    allWindows: () => [win],
    state,
    tabs: {
      pageView: (id: string) => (id === 'story' ? pageView : undefined),
      view: (id: string) => (id === 'story' ? (covered ? coverView : pageView) : undefined),
      coveredPage: (id: string) => (id === 'story' ? covered : undefined),
      ownerOf: (id: string) => (id === 'story' ? win : undefined),
      visibleTabIds: () => ['story'],
      activeTabFor: () => tab
    },
    extensions: { list: () => [{ id: EXT, path: '/ext/' + EXT, allowFileAccess: false }] }
  } as unknown as Browser
  // The host routes both of the tab's pages to the tab (`ElectronTabViewHost.track`); the
  // tab's page to `viewForTab` is the page alone.
  const views = {
    viewForTab: (id: string) => (id === 'story' ? pageView : undefined),
    tabIdForWebContents: (wc: { id: number }) =>
      wc.id === PAGE_WC_ID || wc.id === COVER_WC_ID ? 'story' : undefined
  } as unknown as ElectronTabViewHost
  const model = new ApiModel(browser, views)
  const broadcasts: Broadcast[] = []
  const extension = {
    id: EXT,
    path: '/ext/' + EXT,
    manifest: {
      name: 'Probe',
      permissions: ['tabs', 'userScripts'],
      host_permissions: ['<all_urls>']
    },
    sessions: [{}]
  }
  const host = {
    browser,
    model,
    canSeeTab: () => true,
    hostAccess: () => true,
    grants: () => ({ permissions: ['tabs'], origins: ['<all_urls>'] }),
    loaded: (id: string) => (id === EXT ? extension : undefined),
    scheduleTick: () => undefined,
    sessions: { get: () => ({}) },
    store: { userScripts: () => null, setUserScripts: () => undefined },
    broadcast: (namespace: string, event: string, argsFor: (ext: unknown) => unknown[] | null) =>
      broadcasts.push({ namespace, event, args: argsFor(extension) })
  } as unknown as ApiHost
  const ctx = {
    extensionId: EXT,
    extension,
    sender: { kind: 'worker' },
    window: undefined
  } as unknown as ApiContext
  const documents = {
    documentIdOf: () => 'doc-1',
    frameByDocumentId: () => null
  }
  const tabs = new TabsApi(host)
  let last = model.snapshot()
  return {
    model,
    tabs,
    userScripts: new UserScriptsApi(host, documents),
    ctx,
    tab,
    broadcasts,
    enter() {
      covered = {
        url: tab.url,
        title: tab.title,
        favicon: tab.favicon,
        readerable: tab.readerable,
        zoom: tab.zoom
      }
      tab.url = READER_URL
      tab.title = READER_TITLE
      tab.zoom = 1
    },
    exit() {
      if (!covered) return
      tab.url = covered.url
      tab.title = covered.title
      tab.favicon = covered.favicon
      tab.readerable = covered.readerable
      tab.zoom = covered.zoom
      covered = undefined
    },
    tick() {
      const next = model.snapshot()
      const from = broadcasts.length
      tabs.diff(last, next)
      last = next
      return broadcasts.slice(from).map((b) => `${b.namespace}.${b.event}`)
    }
  }
}

/** A page's outermost frame as a user-script world's message names it. */
const mainFrame = {
  url: PAGE_URL,
  origin: 'https://example.com',
  parent: null,
  processId: 5,
  routingId: 1,
  frameTreeNodeId: 100,
  isDestroyed: () => false
}

describe('the reader’s cover and the extension layer (reader-30)', () => {
  it('the Chrome-facing tab is the page throughout: its id does not change on the way in or out, and its record says the page', () => {
    const w = world()
    const id = w.model.chromeTabId(w.tab)
    expect(id).toBe(PAGE_WC_ID)
    w.enter()
    expect(w.tab.url).toBe(READER_URL)
    expect(w.model.chromeTabId(w.tab)).toBe(id)
    expect(w.model.webContentsOf(w.tab)?.id).toBe(PAGE_WC_ID)
    expect(w.model.urlOf(w.tab)).toBe(PAGE_URL)
    expect(w.model.zenTab(PAGE_WC_ID)).toBe(w.tab)
    const record = w.model.chromeTab(w.tab, true)
    expect(record).toMatchObject({
      id: PAGE_WC_ID,
      url: PAGE_URL,
      title: PAGE_TITLE,
      favIconUrl: PAGE_ICON,
      status: 'complete',
      active: true
    })
    // The differ reads the page too: `tabs.get` and `tabs.query` say what `onUpdated` would.
    const got = w.tabs.handlers.get(w.ctx, id) as { url?: string; title?: string }
    expect(got.url).toBe(PAGE_URL)
    expect(got.title).toBe(PAGE_TITLE)
    expect((w.tabs.handlers.query(w.ctx, { url: 'zen://*/*' }) as unknown[]).length).toBe(0)
    expect(
      (w.tabs.handlers.query(w.ctx, { url: 'https://example.com/*' }) as Array<{ id: number }>).map(
        (t) => t.id
      )
    ).toEqual([id])
    w.exit()
    expect(w.model.chromeTabId(w.tab)).toBe(id)
    expect(w.model.chromeTab(w.tab, true)).toMatchObject({ id, url: PAGE_URL, title: PAGE_TITLE })
  })

  it('entering and leaving the reader emits nothing: no onUpdated, no onReplaced, no onZoomChange', () => {
    const w = world()
    expect(w.tick()).toEqual([])
    w.enter()
    // The row changed its address, its title and its zoom; the page beneath changed nothing.
    expect(w.tick()).toEqual([])
    w.exit()
    expect(w.tick()).toEqual([])
    // The reader document's own title changing on the row is no event either; a change of the
    // page beneath the cover is one, the page's own, with the page's address on the record.
    w.enter()
    w.tab.title = 'Story – Reader View, scrolled'
    expect(w.tick()).toEqual([])
    w.tab.audible = true
    expect(w.tick()).toEqual(['tabs.onUpdated'])
    const [id, change, record] = w.broadcasts.at(-1)!.args as [
      number,
      { audible: boolean; url?: string; title?: string },
      { url?: string; title?: string }
    ]
    expect(id).toBe(PAGE_WC_ID)
    expect(change).toEqual({ audible: true })
    expect(record.url).toBe(PAGE_URL)
    expect(record.title).toBe(PAGE_TITLE)
    // No event of any tick spoke of the reader.
    expect(JSON.stringify(w.broadcasts)).not.toContain('zen://reader')
  })

  it('captureVisibleTab captures the page beneath the cover, its address the one the checks read (the reader’s own would be refused)', async () => {
    const w = world()
    w.enter()
    // The row's address is one Chrome refuses to capture; the page's is fine.
    expect(
      captureDenial(w.tab.url, {
        allUrls: true,
        activeTab: false,
        fileAccess: false,
        extensionId: EXT
      })
    ).toBe('Cannot access a zen:// URL')
    const page = contents.get(PAGE_WC_ID)!
    const cover = contents.get(COVER_WC_ID)!
    const before = { page: page.captured, cover: cover.captured }
    const data = await w.tabs.handlers.captureVisibleTab(w.ctx, undefined, { format: 'png' })
    expect(data).toBe(`data:image/png;base64,wc${PAGE_WC_ID}`)
    expect(page.captured).toBe(before.page + 1)
    expect(cover.captured).toBe(before.cover)
  })

  it('a user-script world’s message from the page beneath carries the page as sender.tab, under the tab’s id', () => {
    const w = world()
    w.enter()
    const extension = w.ctx.extension
    const worldSender = (
      w.userScripts as unknown as {
        worldSender(
          wc: unknown,
          frame: unknown,
          extension: unknown
        ): { tab?: Record<string, unknown> }
      }
    ).worldSender.bind(w.userScripts)
    const sender = worldSender(contents.get(PAGE_WC_ID), mainFrame, extension)
    expect(sender.tab).toMatchObject({
      id: PAGE_WC_ID,
      url: PAGE_URL,
      title: PAGE_TITLE,
      favIconUrl: PAGE_ICON
    })
    expect(JSON.stringify(sender)).not.toContain('zen://reader')
  })
})
