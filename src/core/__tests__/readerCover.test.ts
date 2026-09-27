import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
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
import { READER_URL_PREFIX } from '../reader'
import { COVER_SETTLE_MS } from '../tabs'
import type { ZenWindow } from '../window'
import { closeBootTabs } from './bootTab'

/**
 * The reader's exit as Chrome's immersive reading mode has it (reader-30, W8-5): the
 * `zen://reader` document is a cover over the tab's own page, which stays alive beneath it, so
 * leaving the reader is no navigation at all – the page's scroll, form state and history stand
 * as they were, no load, no history entry.
 */

function memoryIo(files: Record<string, string> = {}): StoreIO {
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

function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

/** A live page of the fake host: what it was asked, its address, and the events it may fire. */
interface FakeView {
  view: TabView
  events: TabViewEvents
  calls: string[]
  /** The address the page reports (`getURL`); a `loadURL` moves it, a test may too. */
  url: string
  visible: boolean
  destroyed: boolean
}

function fakeView(url: string, events: TabViewEvents): FakeView {
  const record: FakeView = {
    view: stub<TabView>(),
    events,
    calls: [],
    url,
    visible: false,
    destroyed: false
  }
  const log = (name: string, ...args: unknown[]): void =>
    void record.calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(',')})`)
  record.view = stub<TabView>({
    loadURL: (next) => {
      log('loadURL', next)
      record.url = next
    },
    getURL: () => record.url,
    getTitle: () => '',
    canGoBack: () => false,
    canGoForward: () => false,
    goBack: () => log('goBack'),
    goForward: () => log('goForward'),
    reload: (ignoreCache) => log('reload', ignoreCache),
    stop: () => log('stop'),
    navigationEntries: () => ({ entries: [{ url: record.url, title: '' }], index: 0 }),
    hasDocument: () => true,
    isCurrentlyAudible: () => false,
    getZoom: () => 1,
    setZoom: (factor) => log('setZoom', factor),
    executeJavaScript: (code) => {
      log('executeJavaScript', code.slice(0, 40))
      return Promise.resolve(undefined)
    },
    isVisible: () => record.visible,
    setVisible: (visible) => {
      log('setVisible', visible)
      record.visible = visible
    },
    isFocused: () => false,
    focus: () => log('focus'),
    isDestroyed: () => record.destroyed,
    destroy: () => {
      log('destroy')
      record.destroyed = true
    },
    setBounds: (rect) => log('setBounds', rect),
    setBackgroundColor: () => undefined
  })
  return record
}

interface Host {
  platform: Platform
  /** The tab's own page, by tab id. */
  pages: Map<string, FakeView>
  /** The reader's cover, by tab id, while one was ever made (the last). */
  covers: Map<string, FakeView>
}

/** A desktop host with a cover to give (`withCover`), or one page per tab id like the phone's. */
function fakeHost(withCover: boolean): Host {
  const pages = new Map<string, FakeView>()
  const covers = new Map<string, FakeView>()
  const windowHost = (): WindowHost =>
    stub<WindowHost>({
      alive: true,
      contentSize: () => ({ width: 1280, height: 800 }),
      normalBounds: () => null,
      isFullScreen: () => false,
      isMaximized: () => false,
      isFocused: () => true,
      isVisible: () => true
    })
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities: stub<HostCapabilities>({ windows: true, updates: false, agents: false }),
    io: memoryIo(),
    windows: { create: () => windowHost() },
    views: stub<TabViewHost>({
      createView: (tab, events) => {
        const page = fakeView(tab.url, events)
        pages.set(tab.id, page)
        return page.view
      },
      createCover: withCover
        ? (tab, events) => {
            const cover = fakeView('', events)
            covers.set(tab.id, cover)
            return cover.view
          }
        : undefined
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
  return { platform, pages, covers }
}

const PAGE_URL = 'https://example.com/story'
const RECT = { x: 0, y: 80, width: 1280, height: 720 }

interface Scene {
  browser: Browser
  win: ZenWindow
  host: Host
  tabId: string
  page: FakeView
}

/** A browser with one web tab shown at `RECT`, its page committed and visible. */
function scene(withCover = true): Scene {
  const host = fakeHost(withCover)
  const browser = new Browser(host.platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  closeBootTabs(browser)
  const tab = browser.tabs.createTab({ url: PAGE_URL, active: true }, win)
  const page = host.pages.get(tab.id)!
  page.events.onNavigated(PAGE_URL, false)
  page.events.onDomReady()
  browser.handleCommand(win, 'layout.report', {
    placements: [{ tabId: tab.id, rect: RECT, radius: 0 }],
    glance: null,
    contentHidden: false
  })
  page.calls.length = 0
  return { browser, win, host, tabId: tab.id, page }
}

const ARTICLE = { title: 'Story', content: '<p>Once upon a time.</p>', length: 18 }

/** Open the reader on the scene's tab and let its document come up. */
function enterReader(s: Scene): FakeView {
  s.browser.reader.open(s.tabId, ARTICLE)
  const cover = s.host.covers.get(s.tabId)!
  cover.events.onNavigated(cover.url, false)
  cover.events.onDomReady()
  return cover
}

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, COVER_SETTLE_MS + 20))

describe('the reader as a cover over the page (reader-30)', () => {
  it('enters over the page: the reader document is a second view at the tab’s place, the page beneath is never navigated', async () => {
    const s = scene()
    const cover = enterReader(s)
    const tab = s.browser.tabs.tab(s.tabId)!
    expect(tab.url.startsWith(`${READER_URL_PREFIX}?id=`)).toBe(true)
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(true)
    // The cover took the reader address; the page heard nothing of it – no load, no stack.
    expect(cover.calls.some((c) => c.startsWith('loadURL("zen://reader?id='))).toBe(true)
    expect(s.page.calls.filter((c) => /^(loadURL|goBack|goForward|reload|stop)\(/.test(c))).toEqual(
      []
    )
    expect(s.page.url).toBe(PAGE_URL)
    // The document in front is the cover; the tab's navigation is the page.
    expect(s.browser.tabs.view(s.tabId)).toBe(cover.view)
    expect(s.browser.tabs.pageView(s.tabId)).toBe(s.page.view)
    expect(s.browser.tabs.viewsOwnedBy(s.win).get(s.tabId)).toBe(cover.view)
    // The cover was laid out where the page stands and shown; the page hides a frame later,
    // once the cover has painted, so that nothing of it shows under a resize.
    expect(cover.calls).toContain(`setBounds(${JSON.stringify(RECT)})`)
    expect(cover.calls).toContain('setVisible(true)')
    expect(s.page.visible).toBe(true)
    await settle()
    expect(s.page.visible).toBe(false)
    // The reader's own navigation is no history: the page's visit is the only one.
    expect(s.browser.history.recent(10).map((e) => e.url)).toEqual([PAGE_URL])
    // The reader document zooms on its own; the site's factor comes back with the page.
    expect(tab.zoom).toBe(1)
  })

  it('exits by uncovering: the page shows again as it was, no load, no history entry, the cover goes a frame later', async () => {
    const s = scene()
    const tab = s.browser.tabs.tab(s.tabId)!
    tab.title = 'The Story'
    tab.favicon = 'https://example.com/icon.png'
    tab.readerable = true
    const cover = enterReader(s)
    await settle()
    s.page.calls.length = 0
    s.browser.reader.toggle(s.tabId, s.win)
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(false)
    expect(tab.url).toBe(PAGE_URL)
    expect(tab.title).toBe('The Story')
    expect(tab.favicon).toBe('https://example.com/icon.png')
    expect(tab.readerable).toBe(true)
    // The page: shown again at its place, untouched otherwise – no load, no back, no reload.
    expect(s.page.calls.filter((c) => /^(loadURL|goBack|goForward|reload)\(/.test(c))).toEqual([])
    expect(s.page.calls).toContain('setVisible(true)')
    expect(s.page.calls).toContain(`setBounds(${JSON.stringify(RECT)})`)
    expect(s.browser.tabs.view(s.tabId)).toBe(s.page.view)
    expect(s.browser.tabs.viewsOwnedBy(s.win).get(s.tabId)).toBe(s.page.view)
    // The cover stands a frame more over the page's first paint, then goes; the keyboard to the page.
    expect(cover.destroyed).toBe(false)
    await settle()
    expect(cover.destroyed).toBe(true)
    expect(s.page.calls).toContain('focus()')
    expect(s.browser.history.recent(10).map((e) => e.url)).toEqual([PAGE_URL])
    // Nothing more to uncover.
    expect(s.browser.tabs.uncover(s.tabId)).toBe(false)
  })

  it('every exit is the one exit: the toggle command, the shortcut and the reader’s own close all uncover', () => {
    const s = scene()
    enterReader(s)
    s.browser.handleCommand(s.win, 'reader.toggle', { tabId: s.tabId })
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(false)
    expect(s.browser.tabs.tab(s.tabId)!.url).toBe(PAGE_URL)
    enterReader(s)
    // The shortcut (Ctrl+Alt+R) from the reader document's own keyboard.
    s.browser.actions.run('page.readerMode', { sourceTabId: s.tabId, win: s.win })
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(false)
    expect(s.browser.tabs.tab(s.tabId)!.url).toBe(PAGE_URL)
    expect(s.page.calls.filter((c) => c.startsWith('loadURL('))).toEqual([])
  })

  it('a navigation committed beneath the cover closes the reader on the page’s new address (Chrome’s PrimaryPageChanged)', async () => {
    const s = scene()
    const cover = enterReader(s)
    await settle()
    expect(s.page.visible).toBe(false)
    s.page.url = 'https://example.com/next'
    s.page.events.onNavigated('https://example.com/next', false)
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(false)
    expect(s.browser.tabs.tab(s.tabId)!.url).toBe('https://example.com/next')
    expect(s.browser.tabs.view(s.tabId)).toBe(s.page.view)
    // The page shows at once; the cover goes once the page has had its frame.
    expect(s.page.visible).toBe(true)
    await settle()
    expect(cover.destroyed).toBe(true)
  })

  it('a move within the page’s document beneath keeps the cover and is where the exit lands', () => {
    const s = scene()
    enterReader(s)
    s.page.url = `${PAGE_URL}#chapter-2`
    s.page.events.onNavigated(`${PAGE_URL}#chapter-2`, true)
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(true)
    expect(s.browser.tabs.tab(s.tabId)!.url.startsWith(READER_URL_PREFIX)).toBe(true)
    s.browser.reader.toggle(s.tabId, s.win)
    expect(s.browser.tabs.tab(s.tabId)!.url).toBe(`${PAGE_URL}#chapter-2`)
  })

  it('a link followed in the reader loads in the page beneath, whose commit closes the reader', () => {
    const s = scene()
    const cover = enterReader(s)
    expect(cover.events.onWillNavigate('https://example.com/linked')).toBe(true)
    expect(s.page.calls.some((c) => c.startsWith('loadURL("https://example.com/linked"'))).toBe(
      true
    )
    expect(cover.calls.filter((c) => c.startsWith('loadURL("https://'))).toEqual([])
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(true)
    s.page.events.onNavigated('https://example.com/linked', false)
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(false)
    expect(s.browser.tabs.tab(s.tabId)!.url).toBe('https://example.com/linked')
  })

  it('the cover’s own loading, favicon and commit never speak for the tab', () => {
    const s = scene()
    const tab = s.browser.tabs.tab(s.tabId)!
    const cover = enterReader(s)
    cover.events.onStartLoading()
    expect(tab.loading).toBe(false)
    cover.events.onFaviconUpdated(['https://example.com/reader.png'])
    expect(tab.favicon).toBe(null)
    cover.events.onStopLoading()
    expect(s.browser.history.recent(10).map((e) => e.url)).toEqual([PAGE_URL])
  })

  it('a reader document that fails to load or crashes takes the cover down at once', () => {
    const s = scene()
    let cover = enterReader(s)
    cover.events.onFailLoad(-3, 'aborted', cover.url)
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(true)
    cover.events.onFailLoad(-105, 'name not resolved', cover.url)
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(false)
    expect(cover.destroyed).toBe(true)
    expect(s.browser.tabs.tab(s.tabId)!.url).toBe(PAGE_URL)
    cover = enterReader(s)
    cover.events.onCrashed('crashed')
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(false)
    expect(cover.destroyed).toBe(true)
    // The host tearing the cover down on its own shows the page again too.
    cover = enterReader(s)
    cover.destroyed = true
    cover.events.onDestroyed()
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(false)
    expect(s.browser.tabs.tab(s.tabId)!.url).toBe(PAGE_URL)
  })

  it('closing the tab with the cover up destroys the cover with the page', () => {
    const s = scene()
    const cover = enterReader(s)
    s.browser.tabs.closeTab(s.tabId)
    expect(cover.destroyed).toBe(true)
    expect(s.page.destroyed).toBe(true)
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(false)
  })

  it('a host with one page per tab (the phone) has no cover: the reader loads as a navigation and leaves by one', () => {
    const s = scene(false)
    s.browser.reader.open(s.tabId, ARTICLE)
    const tab = s.browser.tabs.tab(s.tabId)!
    expect(tab.url.startsWith(`${READER_URL_PREFIX}?id=`)).toBe(true)
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(false)
    expect(s.host.covers.size).toBe(0)
    expect(s.page.calls.some((c) => c.startsWith('loadURL("zen://reader?id='))).toBe(true)
    s.browser.reader.toggle(s.tabId, s.win)
    expect(s.page.calls.some((c) => c === `loadURL(${JSON.stringify(PAGE_URL)})`)).toBe(true)
  })
})

/**
 * Whether the page reads as an article (`tab.readerable`, the Reader View chip) is the
 * document's answer, given at its dom-ready: a move within the same document keeps it, a new
 * document starts without one until it answers – Chrome keeps a page's distillability across
 * same-document navigations. The same `Browser.onNavigated` serves the phone's host.
 */
describe('readerability across the page’s navigations', () => {
  it('an in-page navigation keeps the answer, a committed one clears it until the next dom-ready', () => {
    for (const withCover of [true, false]) {
      const s = scene(withCover)
      const tab = s.browser.tabs.tab(s.tabId)!
      tab.readerable = true
      // A `pushState` and a hash change: the same document, moved within.
      s.page.events.onNavigated(`${PAGE_URL}/chapter-2`, true)
      expect(tab.readerable).toBe(true)
      s.page.events.onNavigated(`${PAGE_URL}/chapter-2#notes`, true)
      expect(tab.readerable).toBe(true)
      // A new document commits: nothing is known of it yet.
      s.page.events.onNavigated('https://example.com/elsewhere', false)
      expect(tab.readerable).toBe(false)
    }
  })
})
