import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Tab } from '../../shared/types'
import { BLANK_URL, NEW_TAB_URL } from '../../shared/url'
import { Browser } from '../browser'
import type {
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'

/*
 * A navigation that turns into a download never commits a document: Chromium hands the response
 * to the download system, the frame stays where it was, and the host reports the download
 * (`will-download` → `Browser.onDownloadStarted`). What becomes of the tab depends on what it
 * kept (BUG-030 / downloads-01):
 *
 *  – a tab opened for the download alone (a link's new tab, a fresh tab pointed at the file) has
 *    no document and closes, as Chrome's does;
 *  – the blank page a new tab holds until an address is typed into it is no document of the
 *    user's: the typed address became the download, and the tab closes too – it used to stay
 *    behind, titled with the download's host over an empty page;
 *  – a tab with a document (a page, the new tab page) keeps it, and its row and address go back
 *    to that document from the address that never became the tab's.
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

const ATTACHMENT = 'http://127.0.0.1:8/files/report.zip'
const PAGE = 'https://committed.example/article'

/** The page's side of a tab: what committed, and the navigation that became a download. */
interface Page {
  tabId: string
  events: TabViewEvents
  committed: string
  title: string
  history: number
  focused: number
}

interface Fixture {
  browser: Browser
  pages: Page[]
  chromeFocused: number
}

/**
 * A host whose `loadURL` commits every address but the attachment's: that one is a download –
 * Chromium reports nothing to the frame but the end of its load (ERR_ABORTED is filtered), and
 * the host tells the browser the download began.
 */
function fixture(): Fixture {
  const pages: Page[] = []
  const f: Fixture = { browser: undefined as unknown as Browser, pages, chromeFocused: 0 }
  const platform: Platform = {
    info: { os: 'linux', version: '0.0.0' },
    capabilities: stub<HostCapabilities>({ windows: true, nativeMenus: true }),
    io: memoryIo(),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          focusChrome: () => {
            f.chromeFocused++
          }
        })
    },
    views: stub<TabViewHost>({
      createView: (tab: Tab, events: TabViewEvents) => {
        const page: Page = {
          tabId: tab.id,
          events,
          committed: '',
          title: '',
          history: 0,
          focused: 0
        }
        pages.push(page)
        const commit = (url: string): void => {
          if (page.committed !== '') page.history++
          // Chromium adds the slash to a scheme-only internal address (`zen://blank/`).
          page.committed = /^zen:\/\/[a-z]+$/.test(url) ? `${url}/` : url
          page.title = url === PAGE ? 'The article' : url.startsWith('zen://') ? 'New Tab' : ''
          events.onNavigated(page.committed, false)
          events.onStopLoading()
        }
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => true,
          hasDocument: () => page.committed !== '' && page.committed !== 'about:blank',
          getURL: () => page.committed,
          getTitle: () => page.title,
          canGoBack: () => page.history > 0,
          canGoForward: () => false,
          getZoom: () => 1,
          navigationEntries: () => ({ entries: [], index: -1 }),
          focus: () => {
            page.focused++
          },
          loadURL: (url: string) => {
            events.onStartLoading()
            events.onStartNavigation?.(url, false)
            if (url === ATTACHMENT) {
              // The response is a download: the frame's load ends with nothing committed, and
              // the host reports the download from this tab.
              events.onStopLoading()
              f.browser.onDownloadStarted(tab.id)
              return
            }
            commit(url)
          }
        })
      }
    }),
    menus: { popup: () => undefined },
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    readabilitySource: () => null
  }
  f.browser = new Browser(platform)
  f.browser.state.settings.onboardingDone = true
  f.browser.start()
  return f
}

function tabCount(f: Fixture): number {
  return Object.keys(f.browser.state.model.tabs).length
}

function pageOf(f: Fixture, tabId: string): Page {
  const page = f.pages.find((p) => p.tabId === tabId)
  if (!page) throw new Error(`no page for ${tabId}`)
  return page
}

describe('a navigation that becomes a download', () => {
  it('closes the blank tab whose typed address it was (BUG-030)', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const blank = f.browser.tabs.createTab({ active: true }, win)
    expect(pageOf(f, blank.id).committed).toBe(`${BLANK_URL}/`)
    const before = tabCount(f)

    f.browser.tabs.navigate(blank.id, ATTACHMENT)

    expect(f.browser.tabs.tab(blank.id)).toBeUndefined()
    expect(tabCount(f)).toBe(before - 1)
  })

  it('closes a fresh tab pointed straight at the file, which never had a document', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: ATTACHMENT, active: false }, win)
    expect(pageOf(f, tab.id).committed).toBe('')
    expect(f.browser.tabs.tab(tab.id)).toBeUndefined()
  })

  it('keeps a tab with a page, and gives its row and address back to the page', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    expect(f.browser.tabs.tab(tab.id)?.url).toBe(PAGE)

    f.browser.tabs.navigate(tab.id, ATTACHMENT)

    const kept = f.browser.tabs.tab(tab.id)
    expect(kept).toBeDefined()
    expect(kept?.url).toBe(PAGE)
    expect(kept?.title).toBe('The article')
    expect(kept?.loading).toBe(false)
  })

  it('keeps the new tab page as Chrome keeps its, the address back to it', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const tab = f.browser.tabs.createTab({ url: NEW_TAB_URL, active: true }, win)
    f.browser.tabs.navigate(tab.id, ATTACHMENT)
    const kept = f.browser.tabs.tab(tab.id)
    expect(kept).toBeDefined()
    expect(kept?.url).toBe(`${NEW_TAB_URL}/`)
  })

  it('keeps a pinned blank tab and a blank tab with a past, the keyboard back with the chrome', () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    const pinned = f.browser.tabs.createTab({ active: true, pinned: true }, win)
    f.browser.tabs.navigate(pinned.id, ATTACHMENT)
    expect(f.browser.tabs.tab(pinned.id)).toBeDefined()
    expect(f.chromeFocused).toBe(1)

    // A page that went back to the blank page (history behind it) is not a tab opened for the
    // download: it stays.
    const back = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
    const page = pageOf(f, back.id)
    page.history = 1
    page.committed = `${BLANK_URL}/`
    f.browser.tabs.navigate(back.id, ATTACHMENT)
    expect(f.browser.tabs.tab(back.id)).toBeDefined()
    expect(f.chromeFocused).toBe(2)
  })

  it('does nothing for a download the browser cannot place in a tab', () => {
    const f = fixture()
    const before = tabCount(f)
    f.browser.onDownloadStarted(null)
    f.browser.onDownloadStarted('tab_gone')
    expect(tabCount(f)).toBe(before)
  })
})
