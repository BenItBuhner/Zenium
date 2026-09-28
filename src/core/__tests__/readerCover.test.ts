import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  HostCapabilities,
  NavigationSnapshot,
  Platform as PlatformOs,
  Tab
} from '../../shared/types'
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
import { COVER_REPORT_CEILING_MS } from '../tabs'
import type { ZenWindow } from '../window'
import { closeBootTabs } from './bootTab'

/**
 * The reader's exit as Chrome's immersive reading mode has it (reader-30, W8-5): the
 * `zen://reader` document is a cover over the tab's own page, which stays alive beneath it, so
 * leaving the reader is no navigation at all – the page's scroll, form state and history stand
 * as they were, no load, no history entry. The swap between the two falls on the paint
 * handshake (design language v2 §11): the page hides on the cover's word that its first frame
 * is drawn, the cover goes on the page's, and a clock stands only as the failure ceiling for a
 * document that never reports (`COVER_REPORT_CEILING_MS`).
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
  /**
   * Every ask for the document's word that a frame is drawn (`frameDrawn`), unanswered: a test
   * answers one (`drawn`) or lets it stand (a document that never reports).
   */
  frames: Array<{ resolve: (t: number) => void; reject: (reason: Error) => void }>
  /** Every stack the page was told to replay (`restoreNavigation`), in order. */
  restored: NavigationSnapshot[]
}

function fakeView(url: string, events: TabViewEvents, reports = true): FakeView {
  const record: FakeView = {
    view: stub<TabView>(),
    events,
    calls: [],
    url,
    visible: false,
    destroyed: false,
    frames: [],
    restored: []
  }
  const log = (name: string, ...args: unknown[]): void =>
    void record.calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(',')})`)
  record.view = stub<TabView>({
    // A host with no way to ask leaves `frameDrawn` out (the stub would otherwise answer for it).
    frameDrawn: reports
      ? () => {
          log('frameDrawn')
          return new Promise<number>((resolve, reject) => record.frames.push({ resolve, reject }))
        }
      : undefined,
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
    restoreNavigation: (snapshot) => {
      log('restoreNavigation', snapshot.index)
      record.restored.push(snapshot)
      record.url = snapshot.entries[snapshot.index]?.url ?? record.url
      return Promise.resolve()
    },
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
    bringToFront: () => log('bringToFront'),
    isDestroyed: () => record.destroyed,
    // As the engine: a page destroyed says so to its events (`ElectronTabView.wire`).
    destroy: () => {
      log('destroy')
      record.destroyed = true
      record.events.onDestroyed()
    },
    postToPage: (message) => log('postToPage', message),
    setMuted: (muted) => log('setMuted', muted),
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

/**
 * A desktop host with a cover to give (`withCover`), or one page per tab id like the phone's;
 * its views answer for their frames (`frameDrawn`) unless `reports` is off – a host with no way
 * to ask, whose swaps fall on the ceiling alone.
 */
function fakeHost(withCover: boolean, reports = true): Host {
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
        const page = fakeView(tab.url, events, reports)
        pages.set(tab.id, page)
        return page.view
      },
      createCover: withCover
        ? (tab, events) => {
            const cover = fakeView('', events, reports)
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
function scene(withCover = true, reports = true): Scene {
  const host = fakeHost(withCover, reports)
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

/** The chrome's layout after a switch to `tabId`: its view placed at `RECT`, every other down. */
function showTab(s: Scene, tabId: string): void {
  s.browser.tabs.activateTab(tabId, s.win)
  s.browser.handleCommand(s.win, 'layout.report', {
    placements: [{ tabId, rect: RECT, radius: 0 }],
    glance: null,
    contentHidden: false
  })
}

const OTHER_URL = 'https://example.org/elsewhere'

/** A second tab of the window, committed, its page shown once; the scene's tab back in front. */
function secondTab(s: Scene): { id: string; page: FakeView } {
  const tab = s.browser.tabs.createTab({ url: OTHER_URL, active: true }, s.win)
  const page = s.host.pages.get(tab.id)!
  page.events.onNavigated(OTHER_URL, false)
  page.events.onDomReady()
  showTab(s, tab.id)
  showTab(s, s.tabId)
  s.page.calls.length = 0
  page.calls.length = 0
  return { id: tab.id, page }
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

/** Let the promise reactions of a frame's word land (`afterFrame`'s `then`). */
const landed = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

/**
 * The document's word that its frame is drawn: answer the oldest ask on `v` – the cover's at
 * the entry, the page's at the exit – with its clock, and let the word land.
 */
async function drawn(v: FakeView, at = 16.7): Promise<void> {
  const ask = v.frames.shift()
  if (!ask) throw new Error(`${v.url || 'the cover'} was not asked for its frame`)
  ask.resolve(at)
  await landed()
}

afterEach(() => vi.useRealTimers())

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
    // The cover was laid out where the page stands and shown; at its dom-ready it is asked for
    // its first frame, and the page hides on that word, so that nothing of it shows under a
    // resize – and nothing of the ground shows between the two.
    expect(cover.calls).toContain(`setBounds(${JSON.stringify(RECT)})`)
    expect(cover.calls).toContain('setVisible(true)')
    expect(cover.calls).toContain('frameDrawn()')
    expect(s.page.calls).not.toContain('frameDrawn()')
    expect(s.page.visible).toBe(true)
    await drawn(cover)
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
    await drawn(cover)
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
    // The page, shown, is asked for its frame; the cover stands over it until that word comes,
    // then goes, the keyboard to the page.
    expect(s.page.calls.indexOf('frameDrawn()')).toBeGreaterThan(
      s.page.calls.indexOf('setVisible(true)')
    )
    expect(cover.destroyed).toBe(false)
    await drawn(s.page)
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
    await drawn(cover)
    expect(s.page.visible).toBe(false)
    s.page.url = 'https://example.com/next'
    s.page.events.onNavigated('https://example.com/next', false)
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(false)
    expect(s.browser.tabs.tab(s.tabId)!.url).toBe('https://example.com/next')
    expect(s.browser.tabs.view(s.tabId)).toBe(s.page.view)
    // The page shows at once; the cover goes on the page's word that it has its frame.
    expect(s.page.visible).toBe(true)
    expect(cover.destroyed).toBe(false)
    await drawn(s.page)
    expect(cover.destroyed).toBe(true)
  })

  it('a move within the page’s document beneath keeps the cover and is where the exit lands', () => {
    const s = scene()
    enterReader(s)
    // A committed navigation of the tab all the same: its stamp for Quick Delete's tab half
    // (HB-07's `Tab.lastNavigatedAt`) moves, as Chrome's does on a same-document commit.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_700_000_000_000)
    s.page.url = `${PAGE_URL}#chapter-2`
    s.page.events.onNavigated(`${PAGE_URL}#chapter-2`, true)
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(true)
    expect(s.browser.tabs.tab(s.tabId)!.url.startsWith(READER_URL_PREFIX)).toBe(true)
    expect(s.browser.tabs.tab(s.tabId)!.lastNavigatedAt).toBe(1_700_000_000_000)
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

  it('entered again within the exit’s frame: the old cover’s end takes nothing down, the keyboard is the new cover’s, not the page’s', async () => {
    const s = scene()
    const first = enterReader(s)
    await drawn(first)
    // Out – the page shows and is asked for its frame, the old cover stands over it meanwhile –
    // and straight back in.
    s.browser.reader.toggle(s.tabId, s.win)
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(false)
    expect(first.destroyed).toBe(false)
    expect(s.page.frames).toHaveLength(1)
    const second = enterReader(s)
    expect(second).not.toBe(first)
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(true)
    expect(s.browser.tabs.view(s.tabId)).toBe(second.view)
    expect(second.calls).toContain('focus()')
    s.page.calls.length = 0
    second.calls.length = 0
    // The page's word comes: the old cover is destroyed and says so – the cover that stands is
    // untouched, and the keyboard the exit would have given the page stays the new cover's.
    await drawn(s.page)
    expect(first.destroyed).toBe(true)
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(true)
    expect(s.browser.tabs.view(s.tabId)).toBe(second.view)
    expect(second.destroyed).toBe(false)
    expect(s.page.calls).not.toContain('focus()')
    // The page still shows beneath the new cover until that one's word; then it hides.
    expect(s.page.visible).toBe(true)
    await drawn(second)
    expect(s.page.visible).toBe(false)
    // A late word of the old cover – a failure, a crash, its end again, its frame – says
    // nothing either.
    first.events.onFailLoad(-105, 'name not resolved', first.url)
    first.events.onCrashed('crashed')
    first.events.onDestroyed()
    first.events.onDomReady()
    expect(first.frames).toHaveLength(0)
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(true)
    expect(s.browser.tabs.view(s.tabId)).toBe(second.view)
    expect(second.calls).toEqual([])
    // The new cover's own exit works as the first one's did.
    s.browser.reader.toggle(s.tabId, s.win)
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(false)
    await drawn(s.page)
    expect(second.destroyed).toBe(true)
    expect(s.page.calls).toContain('focus()')
  })

  it('the reader opened on a tab not in front leaves its hidden page as it is: nothing of the two shows until the tab does, and the cover’s handshake ending hides nothing twice (a staged page is not moved)', async () => {
    const s = scene()
    vi.useFakeTimers()
    const other = secondTab(s)
    // The scene's tab goes to the back (its page switched away from, or held on an agent's
    // stage) before the reader opens on it.
    showTab(s, other.id)
    expect(s.page.visible).toBe(false)
    s.page.calls.length = 0
    const cover = enterReader(s)
    expect(cover.visible).toBe(false)
    expect(s.page.calls.filter((c) => c.startsWith('setVisible('))).toEqual([])
    // Hidden, the cover has no frame to report: its ceiling ends the handshake with the page
    // left exactly as it was.
    await vi.advanceTimersByTimeAsync(COVER_REPORT_CEILING_MS)
    expect(s.page.calls.filter((c) => c.startsWith('setVisible('))).toEqual([])
    expect(s.page.visible).toBe(false)
    // The tab comes to the front: the cover alone shows, the page is its now.
    showTab(s, s.tabId)
    expect(cover.visible).toBe(true)
    expect(s.page.visible).toBe(false)
    expect(s.page.calls.filter((c) => c.startsWith('setVisible('))).toEqual([])
  })

  it('in an app window a link out of the app’s scope followed in the reader opens in the browser window behind; the reader stays over the app’s page (MW-23)', () => {
    const s = scene()
    const appWin = s.browser.openAppWindow('https://app.example/dash/')!
    const appTab = s.browser.tabs.activeTabFor(appWin)!
    const appPage = s.host.pages.get(appTab.id)!
    appPage.events.onNavigated('https://app.example/dash/', false)
    appPage.events.onDomReady()
    s.browser.reader.open(appTab.id, ARTICLE)
    const cover = s.host.covers.get(appTab.id)!
    cover.events.onNavigated(cover.url, false)
    cover.events.onDomReady()
    expect(s.browser.tabs.isCovered(appTab.id)).toBe(true)
    const before = Object.keys(s.browser.state.model.tabs).length
    // Within the scope: the app's page beneath loads it (its commit closes the reader).
    expect(cover.events.onWillNavigate('https://app.example/dash/settings')).toBe(true)
    expect(
      appPage.calls.some((c) => c.startsWith('loadURL("https://app.example/dash/settings"'))
    ).toBe(true)
    expect(Object.keys(s.browser.state.model.tabs)).toHaveLength(before)
    // Out of it: a tab of the browser window, the app's page untouched, the reader still up.
    expect(cover.events.onWillNavigate('https://docs.example/help')).toBe(true)
    expect(appPage.calls.some((c) => c.includes('docs.example'))).toBe(false)
    expect(cover.calls.some((c) => c.includes('docs.example'))).toBe(false)
    expect(Object.keys(s.browser.state.model.tabs)).toHaveLength(before + 1)
    expect(s.browser.tabs.activeTabFor(s.win)?.url).toBe('https://docs.example/help')
    expect(s.browser.tabs.isCovered(appTab.id)).toBe(true)
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

  it('a cover the host tore down stands no more from the instant it is destroyed, its end still on its way: isCovered, view, the layout and a re-entry agree, and the late end says nothing of the new cover', () => {
    const s = scene()
    const tab = s.browser.tabs.tab(s.tabId)!
    tab.title = 'The Story'
    const first = enterReader(s)
    first.events.onTitleUpdated('Story – Reader View')
    // The host's teardown: the view reads destroyed before its `destroyed` reaches the core.
    first.destroyed = true
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(false)
    expect(s.browser.tabs.view(s.tabId)).toBe(s.page.view)
    expect(s.browser.tabs.viewsOwnedBy(s.win).get(s.tabId)).toBe(s.page.view)
    for (const views of [s.browser.tabs.viewsOf(s.tabId), s.browser.tabs.allViewsOwnedBy(s.win)]) {
      expect(views).toHaveLength(1)
      expect(views[0]).toBe(s.page.view)
    }
    // The reader entered again in that instant: the torn-down cover is taken down first, so
    // the new cover keeps the page's fields – the row's address and title come back to the
    // page's at its exit, not to the old reader's.
    s.browser.reader.open(s.tabId, ARTICLE)
    const second = s.host.covers.get(s.tabId)!
    expect(second).not.toBe(first)
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(true)
    expect(s.browser.tabs.view(s.tabId)).toBe(second.view)
    expect(s.browser.tabs.coveredPage(s.tabId)).toMatchObject({ url: PAGE_URL, title: 'The Story' })
    // The old cover's end arrives late: nothing of the cover that stands now.
    first.events.onDestroyed()
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(true)
    expect(s.browser.tabs.view(s.tabId)).toBe(second.view)
    s.browser.reader.toggle(s.tabId, s.win)
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(false)
    expect(tab.url).toBe(PAGE_URL)
    expect(tab.title).toBe('The Story')
  })
})

/**
 * The paint handshake (design language v2 §11): the swap falls on the word of the document
 * coming to the front that it has drawn a frame – the cover's at the entry, the page's at the
 * exit – and on nothing else; a clock stands only as the failure ceiling for a document that
 * never reports, set well past any first paint (`COVER_REPORT_CEILING_MS`), since a ceiling
 * inside the paint's own range is the same race under another name.
 */
describe('the paint handshake and its failure ceiling', () => {
  it('the page hides on the cover’s word and nothing else: no clock short of the ceiling moves it, and the word cleared the ceiling', async () => {
    const s = scene()
    vi.useFakeTimers()
    const cover = enterReader(s)
    expect(cover.frames).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(COVER_REPORT_CEILING_MS - 1)
    expect(s.page.visible).toBe(true)
    await drawn(cover, 61.4)
    expect(s.page.visible).toBe(false)
    // The word came first: the ceiling was cleared with it. A page shown again beneath the
    // cover meanwhile (a tab switched away and back) is not hidden a second time by a clock.
    s.page.visible = true
    await vi.advanceTimersByTimeAsync(COVER_REPORT_CEILING_MS * 2)
    expect(s.page.visible).toBe(true)
  })

  it('a cover that never reports hides the page at the ceiling – 500 ms, hundreds past a first paint – and not before; its late word is nothing', async () => {
    expect(COVER_REPORT_CEILING_MS).toBe(500)
    const s = scene()
    vi.useFakeTimers()
    const cover = enterReader(s)
    await vi.advanceTimersByTimeAsync(COVER_REPORT_CEILING_MS - 1)
    expect(s.page.visible).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(s.page.visible).toBe(false)
    // The ceiling spoke; the cover's word after it moves nothing (once only).
    s.page.visible = true
    await drawn(cover)
    expect(s.page.visible).toBe(true)
  })

  it('a word the cover cannot give – its ask rejected, the document gone – is no word: the ceiling stands', async () => {
    const s = scene()
    vi.useFakeTimers()
    const cover = enterReader(s)
    cover.frames.shift()!.reject(new Error('The page is gone'))
    await landed()
    expect(s.page.visible).toBe(true)
    await vi.advanceTimersByTimeAsync(COVER_REPORT_CEILING_MS)
    expect(s.page.visible).toBe(false)
  })

  it('the exit rests on the page’s word: the cover stands until it, or goes at the ceiling for a page that never reports – once', async () => {
    const s = scene()
    const cover = enterReader(s)
    await drawn(cover)
    vi.useFakeTimers()
    s.browser.reader.toggle(s.tabId, s.win)
    expect(s.page.visible).toBe(true)
    expect(s.page.frames).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(COVER_REPORT_CEILING_MS - 1)
    expect(cover.destroyed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(cover.destroyed).toBe(true)
    expect(s.page.calls.filter((c) => c === 'focus()')).toHaveLength(1)
    // The page's late word finishes nothing twice: the keyboard is not given again.
    await drawn(s.page)
    expect(s.page.calls.filter((c) => c === 'focus()')).toHaveLength(1)
  })

  it('a host whose views have no word to give (no frameDrawn) swaps on the ceiling alone, at the entry and at the exit', async () => {
    const s = scene(true, false)
    vi.useFakeTimers()
    const cover = enterReader(s)
    expect(cover.calls).not.toContain('frameDrawn()')
    expect(s.page.visible).toBe(true)
    await vi.advanceTimersByTimeAsync(COVER_REPORT_CEILING_MS)
    expect(s.page.visible).toBe(false)
    s.browser.reader.toggle(s.tabId, s.win)
    expect(s.page.calls).not.toContain('frameDrawn()')
    expect(cover.destroyed).toBe(false)
    await vi.advanceTimersByTimeAsync(COVER_REPORT_CEILING_MS)
    expect(cover.destroyed).toBe(true)
  })
})

/**
 * The window lays a tab's views out as one (`TabManager.viewsOf`, `ZenWindow.applyLayout`):
 * the page beneath a cover that has yet to draw its first frame goes where the cover goes, and
 * the cover taken down goes where the page does until the page's word – so that a tab switched
 * away from inside either handshake's window leaves nothing of its own standing at its place,
 * over whatever the layout shows there (a younger view draws over an older one), until the
 * ceiling; and a view that joins the window on top of the rest (a page an agent held on the
 * stage) has the rest raised over it again.
 */
describe('the layout and the handshake’s window', () => {
  /** The tab's views as the layout gets them (`viewsOf`), bottom to top, by name. */
  const laidOut = (s: Scene, cover?: FakeView, tabId = s.tabId): string[] =>
    s.browser.tabs
      .viewsOf(tabId)
      .map((v) => (v === s.page.view ? 'page' : v === cover?.view ? 'cover' : 'other'))

  /** What the layout asked of a view: its place, its showing, its raising, its frame's word. */
  const placed = (v: FakeView): string[] =>
    v.calls.filter((c) => /^(bringToFront|setBounds|setVisible|frameDrawn)\(/.test(c))

  it('a tab switched away from before the cover’s word takes the page beneath down with the cover, on no clock; back before the word, both show again, the page beneath the cover, until it comes', async () => {
    const s = scene()
    vi.useFakeTimers()
    const other = secondTab(s)
    const cover = enterReader(s)
    expect(s.page.visible).toBe(true)
    expect(cover.frames).toHaveLength(1)
    expect(s.browser.tabs.pageAwaitingCover(s.tabId)).toBe(s.page.view)
    expect(laidOut(s, cover)).toEqual(['page', 'cover'])
    s.page.calls.length = 0
    cover.calls.length = 0
    // Away: the layout hides the cover, and the page beneath with it – at once, nothing of the
    // ceiling – and shows the other tab's page alone.
    showTab(s, other.id)
    expect(cover.visible).toBe(false)
    expect(s.page.visible).toBe(false)
    expect(placed(s.page)).toEqual(['setVisible(false)'])
    expect(other.page.visible).toBe(true)
    // Back inside the word's window: the page shows again beneath the cover, at the tab's
    // place, and the cover is raised over it again (it may have joined the window on top).
    s.page.calls.length = 0
    cover.calls.length = 0
    showTab(s, s.tabId)
    expect(cover.visible).toBe(true)
    expect(s.page.visible).toBe(true)
    expect(placed(s.page)).toEqual([`setBounds(${JSON.stringify(RECT)})`, 'setVisible(true)'])
    expect(placed(cover)).toEqual([
      'bringToFront()',
      `setBounds(${JSON.stringify(RECT)})`,
      'setVisible(true)'
    ])
    expect(s.page.calls).not.toContain('bringToFront()')
    // The word comes: the page hides, and is the cover's from then on – no later switch shows
    // it or moves it, and no clock does.
    await drawn(cover)
    expect(s.page.visible).toBe(false)
    expect(s.browser.tabs.pageAwaitingCover(s.tabId)).toBeUndefined()
    expect(laidOut(s, cover)).toEqual(['cover'])
    s.page.calls.length = 0
    showTab(s, other.id)
    expect(cover.visible).toBe(false)
    showTab(s, s.tabId)
    expect(cover.visible).toBe(true)
    expect(s.page.visible).toBe(false)
    expect(placed(s.page)).toEqual([])
    await vi.advanceTimersByTimeAsync(COVER_REPORT_CEILING_MS * 2)
    expect(s.page.visible).toBe(false)
  })

  it('a tab switched away from before the cover’s word and back after its ceiling: the page, hidden with the cover, stays the cover’s – the cover returns alone', async () => {
    const s = scene()
    vi.useFakeTimers()
    const other = secondTab(s)
    const cover = enterReader(s)
    showTab(s, other.id)
    expect(s.page.visible).toBe(false)
    // Hidden, the cover never reports; the ceiling ends the handshake with the page hidden.
    await vi.advanceTimersByTimeAsync(COVER_REPORT_CEILING_MS)
    expect(s.browser.tabs.pageAwaitingCover(s.tabId)).toBeUndefined()
    s.page.calls.length = 0
    showTab(s, s.tabId)
    expect(cover.visible).toBe(true)
    expect(s.page.visible).toBe(false)
    expect(placed(s.page)).toEqual([])
    // The cover's late word moves nothing either.
    await drawn(cover)
    expect(s.page.visible).toBe(false)
  })

  it('at the exit the cover taken down is laid out with the page until the page’s word: raised over the page shown beneath it, so a page that joins the window on top (held on an agent’s stage) never comes up over the cover', async () => {
    const s = scene()
    const cover = enterReader(s)
    await drawn(cover)
    s.page.calls.length = 0
    cover.calls.length = 0
    s.browser.reader.toggle(s.tabId, s.win)
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(false)
    expect(s.browser.tabs.coverLeaving(s.tabId)).toBe(cover.view)
    expect(laidOut(s, cover)).toEqual(['page', 'cover'])
    // The page placed and shown; the cover, placed the same, raised over it, still shown.
    expect(placed(s.page)).toEqual([
      `setBounds(${JSON.stringify(RECT)})`,
      'setVisible(true)',
      'frameDrawn()'
    ])
    expect(placed(cover)).toEqual(['bringToFront()', `setBounds(${JSON.stringify(RECT)})`])
    expect(cover.visible).toBe(true)
    // The page's word: the cover goes, and is nobody's to lay out.
    await drawn(s.page)
    expect(cover.destroyed).toBe(true)
    expect(s.browser.tabs.coverLeaving(s.tabId)).toBeUndefined()
    expect(laidOut(s, cover)).toEqual(['page'])
  })

  it('a tab switched away from inside the exit’s window takes the departing cover down with the page; back before the page’s word, both show, the cover over the page, and the word ends it', async () => {
    const s = scene()
    const other = secondTab(s)
    const cover = enterReader(s)
    await drawn(cover)
    s.browser.reader.toggle(s.tabId, s.win)
    expect(cover.visible).toBe(true)
    expect(s.page.visible).toBe(true)
    // Away: nothing of the tab stands at its place.
    showTab(s, other.id)
    expect(cover.visible).toBe(false)
    expect(s.page.visible).toBe(false)
    expect(other.page.visible).toBe(true)
    // Back: the page beneath, the cover over it.
    s.page.calls.length = 0
    cover.calls.length = 0
    showTab(s, s.tabId)
    expect(s.page.visible).toBe(true)
    expect(cover.visible).toBe(true)
    expect(placed(cover)).toEqual([
      'bringToFront()',
      `setBounds(${JSON.stringify(RECT)})`,
      'setVisible(true)'
    ])
    await drawn(s.page)
    expect(cover.destroyed).toBe(true)
    expect(s.page.visible).toBe(true)
  })

  it('an immediate exit leaves no cover to lay out; a tab without a cover, and every tab on the phone, is one view', () => {
    const s = scene()
    expect(laidOut(s)).toEqual(['page'])
    const cover = enterReader(s)
    cover.events.onCrashed('crashed')
    expect(cover.destroyed).toBe(true)
    expect(s.browser.tabs.coverLeaving(s.tabId)).toBeUndefined()
    expect(laidOut(s, cover)).toEqual(['page'])
    expect(s.browser.tabs.viewsOf('nope')).toEqual([])
    const phone = scene(false)
    phone.browser.reader.open(phone.tabId, ARTICLE)
    expect(laidOut(phone)).toEqual(['page'])
    expect(phone.browser.tabs.pageAwaitingCover(phone.tabId)).toBeUndefined()
    expect(phone.browser.tabs.coverLeaving(phone.tabId)).toBeUndefined()
  })

  it('the window’s every view (allViewsOwnedBy) keeps the page beneath its cover throughout – hidden on the cover’s word it leaves the layout (viewsOwnedBy, viewsOf), not the window – and the departing cover until the page’s word; another window’s pages are not its', async () => {
    const s = scene()
    vi.useFakeTimers()
    const other = secondTab(s)
    const appWin = s.browser.openAppWindow('https://app.example/dash/')!
    const appPage = s.host.pages.get(s.browser.tabs.activeTabFor(appWin)!.id)!
    const cover = enterReader(s)
    const name = (v: TabView): string =>
      v === s.page.view
        ? 'page'
        : v === cover.view
          ? 'cover'
          : v === other.page.view
            ? 'other'
            : v === appPage.view
              ? 'app'
              : '?'
    const every = (): string[] => s.browser.tabs.allViewsOwnedBy(s.win).map(name).sort()
    const laid = (): string[] => [...s.browser.tabs.viewsOwnedBy(s.win).values()].map(name).sort()
    // Before the cover's word: the page is the layout's still, and the window's.
    expect(every()).toEqual(['cover', 'other', 'page'])
    expect(laid()).toEqual(['cover', 'other'])
    // On the word the page hides and leaves the layout; the window keeps it – the popup lifted
    // off it, the window concealed or back, reach it there (the desktop host's two loops).
    await drawn(cover)
    expect(s.page.visible).toBe(false)
    expect(laidOut(s, cover)).toEqual(['cover'])
    expect(laid()).toEqual(['cover', 'other'])
    expect(every()).toEqual(['cover', 'other', 'page'])
    // The exit: the cover taken down stands over the page until the page's word, then goes.
    s.browser.reader.toggle(s.tabId, s.win)
    expect(laidOut(s, cover)).toEqual(['page', 'cover'])
    expect(every()).toEqual(['cover', 'other', 'page'])
    await drawn(s.page)
    expect(cover.destroyed).toBe(true)
    expect(every()).toEqual(['other', 'page'])
    expect(laid()).toEqual(['other', 'page'])
    expect(s.browser.tabs.allViewsOwnedBy(appWin).map(name)).toEqual(['app'])
    // The phone: one view per tab, the same list either way.
    const phone = scene(false)
    phone.browser.reader.open(phone.tabId, ARTICLE)
    const all = phone.browser.tabs.allViewsOwnedBy(phone.win)
    expect(all).toHaveLength(1)
    expect(all[0]).toBe(phone.page.view)
    expect(all[0]).toBe(phone.browser.tabs.viewsOwnedBy(phone.win).get(phone.tabId))
  })
})

/**
 * Beneath the cover the row says the reader (its address, its title, zoom 1) while the tab's
 * page goes on living: whoever speaks of the PAGE rather than the row – the extension layer,
 * the site's sound, the page's answers (notifications, media keys, geolocation) – reads it
 * through `coveredPage` / `pageUrl` / `pageView`, never through the row or `view`.
 */
describe('what speaks of the page beneath the cover', () => {
  const READER_TITLE = 'Story – Reader View'

  it('coveredPage / pageUrl are the page’s address, title and icon while the cover stands, nothing without one', () => {
    const s = scene()
    const tab = s.browser.tabs.tab(s.tabId)!
    tab.title = 'The Story'
    tab.favicon = 'https://example.com/icon.png'
    expect(s.browser.tabs.coveredPage(s.tabId)).toBeUndefined()
    expect(s.browser.tabs.pageUrl(s.tabId)).toBe(PAGE_URL)
    const cover = enterReader(s)
    cover.events.onTitleUpdated(READER_TITLE)
    expect(tab.url.startsWith(READER_URL_PREFIX)).toBe(true)
    expect(tab.title).toBe(READER_TITLE)
    expect(s.browser.tabs.pageUrl(s.tabId)).toBe(PAGE_URL)
    expect(s.browser.tabs.coveredPage(s.tabId)).toMatchObject({
      url: PAGE_URL,
      title: 'The Story',
      favicon: 'https://example.com/icon.png',
      zoom: 1
    })
    // The page's own title and icon change beneath the cover: what speaks of the page follows
    // (and the page's visit keeps its title); the row's title stays the reader's, its icon the
    // site's – the reader document has none of its own, the row wears the page's throughout.
    s.page.events.onTitleUpdated('The Story, retitled')
    s.page.events.onFaviconUpdated(['https://example.com/new.png'])
    expect(tab.title).toBe(READER_TITLE)
    expect(tab.favicon).toBe('https://example.com/new.png')
    expect(s.browser.tabs.coveredPage(s.tabId)).toMatchObject({
      url: PAGE_URL,
      title: 'The Story, retitled',
      favicon: 'https://example.com/new.png'
    })
    expect(s.browser.history.recent(10)).toMatchObject([
      { url: PAGE_URL, title: 'The Story, retitled' }
    ])
    // The exit hands the row what the page says now.
    s.browser.reader.toggle(s.tabId, s.win)
    expect(s.browser.tabs.coveredPage(s.tabId)).toBeUndefined()
    expect(s.browser.tabs.pageUrl(s.tabId)).toBe(PAGE_URL)
    expect(tab.title).toBe('The Story, retitled')
    expect(tab.favicon).toBe('https://example.com/new.png')
    // A tab that is not one has neither.
    expect(s.browser.tabs.coveredPage('nope')).toBeUndefined()
    expect(s.browser.tabs.pageUrl('nope')).toBeUndefined()
  })

  it('a move within the page’s document beneath the cover is the page’s visit – its own title and icon, the row’s reader fields untouched – and the reader stays up', () => {
    const s = scene()
    const tab = s.browser.tabs.tab(s.tabId)!
    tab.title = 'The Story'
    tab.favicon = 'https://example.com/icon.png'
    const cover = enterReader(s)
    cover.events.onTitleUpdated(READER_TITLE)
    const readerUrl = tab.url
    const visitsBefore = s.browser.history.visits({ limit: 10 }).length
    // A `pushState` to the next part, then a hash: two visits of the page, none of the reader.
    for (const moved of [`${PAGE_URL}/part-2`, `${PAGE_URL}/part-2#notes`]) {
      s.page.url = moved
      s.page.events.onNavigated(moved, true)
    }
    const visits = s.browser.history.visits({ limit: 10 })
    expect(visits).toHaveLength(visitsBefore + 2)
    expect(
      visits
        .filter((v) => v.url.startsWith(`${PAGE_URL}/`))
        .map((v) => [v.url, v.title, v.favicon, v.transition, v.tabId])
        .sort()
    ).toEqual([
      [`${PAGE_URL}/part-2#notes`, 'The Story', 'https://example.com/icon.png', 'link', s.tabId],
      [`${PAGE_URL}/part-2`, 'The Story', 'https://example.com/icon.png', 'link', s.tabId]
    ])
    expect(visits.some((v) => v.url.startsWith(READER_URL_PREFIX))).toBe(false)
    // The row is the reader's still; what speaks of the page moved with it.
    expect(s.browser.tabs.isCovered(s.tabId)).toBe(true)
    expect(tab.url).toBe(readerUrl)
    expect(tab.title).toBe(READER_TITLE)
    expect(s.browser.tabs.pageUrl(s.tabId)).toBe(`${PAGE_URL}/part-2#notes`)
    // The exit comes back to where the page is now.
    s.browser.reader.toggle(s.tabId, s.win)
    expect(tab.url).toBe(`${PAGE_URL}/part-2#notes`)
    expect(s.browser.history.visits({ limit: 10 })).toHaveLength(visitsBefore + 2)
  })

  it('the site’s sound is the page’s: Mute Site under the cover mutes the page’s site, and a sound decision reaches the page beneath', () => {
    const s = scene()
    const tab = s.browser.tabs.tab(s.tabId)!
    enterReader(s)
    s.page.calls.length = 0
    // "Mute Site" from the reader's menu names the page's site, not `zen://reader`.
    s.browser.tabs.toggleMuteSite(s.tabId)
    expect(s.browser.permissions.resolve('sound', PAGE_URL)).toBe('deny')
    expect(tab.muted).toBe(true)
    expect(s.page.calls).toContain('setMuted(true)')
    // The decision's follow-up runs over every tab: the covered tab keeps the page's answer
    // (the reader's address is no site; read as the row's, a default would unmute it).
    s.browser.tabs.followSoundSetting(null)
    expect(tab.muted).toBe(true)
    s.browser.tabs.followSoundSetting('https://example.com')
    expect(tab.muted).toBe(true)
    // Unmuted again from under the cover: the page hears it.
    s.browser.tabs.toggleMuteSite(s.tabId)
    expect(s.browser.permissions.resolve('sound', PAGE_URL)).not.toBe('deny')
    expect(tab.muted).toBe(false)
    expect(s.page.calls).toContain('setMuted(false)')
  })

  it('the page’s answers – a notification status, an OS media key – go to the page beneath, never to the reader document', () => {
    const s = scene()
    const cover = enterReader(s)
    s.page.calls.length = 0
    cover.calls.length = 0
    s.browser.webNotifications.handle(s.tabId, { notification: 'query' })
    s.browser.mediaSession.act(s.tabId, 'pause')
    const posted = (v: FakeView): string[] => v.calls.filter((c) => c.startsWith('postToPage('))
    expect(posted(s.page)).toEqual([
      'postToPage({"type":"notification","action":"status","status":"default"})',
      'postToPage({"type":"mediaSession","action":"pause"})'
    ])
    expect(posted(cover)).toEqual([])
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

/**
 * A tab put away on a reader address whose article the service no longer holds – a relaunch
 * with the reader up, on either host – wakes on the page the reader was of, and its stack says
 * where that page was: the desktop's cover was no navigation, so the stack's current entry is
 * the page's own (moved on by a `pushState` beneath the cover, maybe) and the stack is replayed
 * whole; a reader that was a navigation of the tab (the phone's, a session from before the
 * cover) left its own entry on top, and that entry goes rather than the page going on above it
 * – Back never lands on "article gone". A reader whose article the service holds loads as it was.
 */
describe('waking on a reader address whose article is gone', () => {
  const GONE = `${READER_URL_PREFIX}?${new URLSearchParams({ id: 'article_gone', url: PAGE_URL })}`
  const MOVED = `${PAGE_URL}#part-2`

  /** A tab put away on `url` with `snapshot` as its recorded stack, woken. */
  function wake(s: Scene, url: string, snapshot: NavigationSnapshot): { tab: Tab; page: FakeView } {
    const tab = s.browser.tabs.createTab({ url, active: false, load: false }, s.win)
    s.browser.tabs.setPendingNavigation(tab.id, snapshot)
    expect(s.browser.tabs.load(tab.id, s.win)).toBeDefined()
    return { tab, page: s.host.pages.get(tab.id)! }
  }

  it('the desktop’s cover was no navigation: the tab wakes on the stack’s current entry – the page as a pushState beneath the cover left it – and the stack is replayed whole, the host’s serialisation with it', () => {
    const s = scene()
    const entries = [
      { url: OTHER_URL, title: 'Elsewhere' },
      { url: MOVED, title: 'Story', pageState: 'scrolled' }
    ]
    const { tab, page } = wake(s, GONE, { entries, index: 1, hostState: 'the-engine’s-own' })
    expect(tab.url).toBe(MOVED)
    expect(tab.readerable).toBe(false)
    expect(page.restored).toEqual([{ entries, index: 1, hostState: 'the-engine’s-own' }])
    expect(page.calls.filter((c) => c.startsWith('loadURL('))).toEqual([])
  })

  it('a reader that was a navigation of the tab left its entry on top of the page it was of: the entry goes, the page beneath is the current one, forward entries stay, the serialisation of the old list stays behind', () => {
    for (const withCover of [true, false]) {
      const s = scene(withCover)
      const { tab, page } = wake(s, GONE, {
        entries: [
          { url: OTHER_URL, title: 'Elsewhere' },
          { url: PAGE_URL, title: 'Story', pageState: 'scrolled' },
          { url: GONE, title: 'Story' },
          { url: `${PAGE_URL}/next`, title: 'Next' }
        ],
        index: 2,
        hostState: 'the-old-list’s'
      })
      expect(tab.url).toBe(PAGE_URL)
      expect(page.restored).toEqual([
        {
          entries: [
            { url: OTHER_URL, title: 'Elsewhere' },
            { url: PAGE_URL, title: 'Story', pageState: 'scrolled' },
            { url: `${PAGE_URL}/next`, title: 'Next' }
          ],
          index: 1
        }
      ])
      expect(page.calls.filter((c) => c.startsWith('loadURL('))).toEqual([])
    }
  })

  it('a reader entry with another page beneath it is replaced by the page it was of, in its place', () => {
    const s = scene(false)
    const { tab, page } = wake(s, GONE, {
      entries: [
        { url: OTHER_URL, title: 'Elsewhere' },
        { url: GONE, title: 'Story' }
      ],
      index: 1,
      hostState: 'the-old-list’s'
    })
    expect(tab.url).toBe(PAGE_URL)
    expect(page.restored).toEqual([
      {
        entries: [
          { url: OTHER_URL, title: 'Elsewhere' },
          { url: PAGE_URL, title: tab.title }
        ],
        index: 1
      }
    ])
  })

  it('a reader address whose article the service holds – a tab put to sleep within the session – loads as it was, its stack whole', () => {
    const s = scene(false)
    s.browser.reader.open(s.tabId, ARTICLE)
    const readerUrl = s.browser.tabs.tab(s.tabId)!.url
    expect(readerUrl.startsWith(`${READER_URL_PREFIX}?id=`)).toBe(true)
    const entries = [
      { url: PAGE_URL, title: 'Story' },
      { url: readerUrl, title: 'Story' }
    ]
    s.browser.tabs.discard(s.tabId)
    s.browser.tabs.setPendingNavigation(s.tabId, { entries, index: 1, hostState: 'the-list’s' })
    expect(s.browser.tabs.load(s.tabId, s.win)).toBeDefined()
    const page = s.host.pages.get(s.tabId)!
    expect(s.browser.tabs.tab(s.tabId)!.url).toBe(readerUrl)
    expect(page.restored).toEqual([{ entries, index: 1, hostState: 'the-list’s' }])
  })
})
