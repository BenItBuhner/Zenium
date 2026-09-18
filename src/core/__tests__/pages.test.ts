import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { INTERNAL_PAGES, type InternalPageRegistry } from '../../shared/internalPages'
import { Browser } from '../browser'
import type { ZenWindow } from '../window'
import type {
  ClipboardHost,
  Platform,
  ShellHost,
  StoreIO,
  TabView,
  TabViewHost,
  WindowHost
} from '../platform'
import { createSpace, createTabRecord } from '../model'
import { PageService } from '../pages'

function memoryIo(initial: string | null = null): StoreIO {
  const files: Record<string, string> = {}
  return {
    readSync: (name) => files[name] ?? initial,
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

interface Sent {
  name: string
  payload: unknown
  /** The window whose chrome received it. */
  winId: string
}

interface Fixture {
  browser: Browser
  win: ZenWindow
  /** Tab ids a page view was created for, in order. */
  viewsFor: string[]
  /** URLs loaded into page views, in order. */
  loaded: string[]
  /** Events the core sent the chrome. */
  sent: Sent[]
  /** `host.focus()` calls per window id (a window brought to the front). */
  raised: Map<string, number>
  /** Text put on the clipboard, in order. */
  copied: string[]
  /** URLs handed to the system share sheet, in order. */
  shared: string[]
}

function fixture(
  opts: {
    pageTabs?: boolean
    /** A host with several windows (the desktop); one window (Android) by default. */
    windows?: boolean
    profile?: unknown
    pages?: InternalPageRegistry
  } = {}
): Fixture {
  const viewsFor: string[] = []
  const loaded: string[] = []
  const sent: Sent[] = []
  const raised = new Map<string, number>()
  const copied: string[] = []
  const shared: string[] = []
  const capabilities = stub<HostCapabilities>({
    windows: opts.windows ?? false,
    updates: false,
    agents: false,
    pageTabs: opts.pageTabs ?? true
  })
  const platform: Platform = {
    info: { os: 'android' as PlatformOs, version: '0.0.0' },
    capabilities,
    io: memoryIo(opts.profile === undefined ? null : JSON.stringify(opts.profile)),
    windows: {
      create: (win: ZenWindow) => {
        let alive = true
        return stub<WindowHost>({
          get alive() {
            return alive
          },
          contentSize: () => ({ width: 412, height: 915 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          focus: () => {
            raised.set(win.id, (raised.get(win.id) ?? 0) + 1)
          },
          close: () => {
            alive = false
          },
          send: (name: string, payload: unknown) => {
            sent.push({ name, payload, winId: win.id })
          }
        })
      }
    },
    views: stub<TabViewHost>({
      createView: (tab: Tab) => {
        viewsFor.push(tab.id)
        let url = ''
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          hasDocument: () => url !== '',
          getURL: () => url,
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          loadURL: (u: string) => {
            url = u
            loaded.push(u)
          }
        })
      }
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub<ClipboardHost>({
      writeText: (text: string) => {
        copied.push(text)
      }
    }),
    shell: stub<ShellHost>({
      share: async (payload: { url?: string }) => {
        shared.push(payload.url ?? '')
      }
    }),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  // A registry on trial (a document page before the desktop registers it) replaces the service.
  if (opts.pages) {
    ;(browser as { pages: PageService }).pages = new PageService(browser, opts.pages)
  }
  browser.state.settings.onboardingDone = true
  browser.start()
  const win = browser.focusedWindow()
  return { browser, win, viewsFor, loaded, sent, raised, copied, shared }
}

function activeTab(f: Fixture): Tab | undefined {
  return f.browser.tabs.activeTabFor(f.win)
}

function spaceUrls(f: Fixture): string[] {
  return f.win.activeSpace().tabIds.map((id) => f.browser.tabs.tab(id)?.url ?? '?')
}

function openSite(f: Fixture, url: string): Tab {
  return f.browser.tabs.createTab({ url, active: true }, f.win)
}

function openPage(f: Fixture, section?: string | null, openerTabId?: string | null): string | null {
  return f.browser.handleCommand(f.win, 'page.open', {
    id: 'settings',
    section,
    openerTabId
  }) as string | null
}

/** The tab's back – the toolbar's, the bottom bar's and the system's are all `tab.back`. */
function back(f: Fixture, tabId: string): void {
  f.browser.handleCommand(f.win, 'tab.back', { tabId })
}

describe('opening Settings as a tab', () => {
  it('creates an active zen://settings tab next to its opener, without a page view', () => {
    const f = fixture()
    const site = openSite(f, 'https://a.test/')
    const viewsBefore = f.viewsFor.length
    const id = openPage(f)
    const tab = f.browser.tabs.tab(id ?? undefined)
    expect(tab).toBeDefined()
    expect(tab?.url).toBe('zen://settings')
    expect(tab?.title).toBe('Settings')
    expect(tab?.favicon).toBeNull()
    expect(tab?.discarded).toBe(false)
    expect(tab?.openerTabId).toBe(site.id)
    expect(activeTab(f)?.id).toBe(id)
    expect(f.viewsFor.length).toBe(viewsBefore)
    expect(spaceUrls(f).indexOf('zen://settings')).toBe(spaceUrls(f).indexOf('https://a.test/') + 1)
  })

  it('opens straight into a section, still called Settings, with the landing page beneath it', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f, 'privacy') ?? ''
    const tab = f.browser.tabs.tab(id)
    expect(tab?.url).toBe('zen://settings/privacy')
    expect(tab?.title).toBe('Settings')
    // v2 §10.2: a link into a section has the landing beneath it in history.
    expect(tab?.canGoBack).toBe(true)
    back(f, id)
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://settings')
    expect(f.browser.tabs.tab(id)?.canGoBack).toBe(false)
  })

  it('reuses the Settings tab already open in the space and moves it to the section', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const first = openPage(f, 'look')
    openSite(f, 'https://b.test/')
    const again = openPage(f, 'privacy')
    expect(again).toBe(first)
    expect(spaceUrls(f).filter((u) => u.startsWith('zen://settings'))).toHaveLength(1)
    expect(activeTab(f)?.id).toBe(first)
    expect(activeTab(f)?.url).toBe('zen://settings/privacy')
    // The reuse remembered where it came from: back goes to Look and Feel.
    expect(activeTab(f)?.canGoBack).toBe(true)
  })

  it('reuses without moving when no section is asked for, and lands when null is', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f, 'look')
    openSite(f, 'https://b.test/')
    openPage(f, undefined)
    expect(activeTab(f)?.id).toBe(id)
    expect(activeTab(f)?.url).toBe('zen://settings/look')
    openPage(f, null)
    expect(activeTab(f)?.url).toBe('zen://settings')
  })

  it('keeps one Settings tab per window: opening from another space switches to it (v2 §10.1)', () => {
    const f = fixture()
    const home = f.win.activeSpaceId
    openSite(f, 'https://a.test/')
    const first = openPage(f)
    const other = createSpace('Other', '')
    f.browser.state.model.spaces.push(other)
    f.browser.tabs.switchSpace(other.id, f.win)
    openSite(f, 'https://b.test/')
    const again = openPage(f, 'privacy')
    expect(again).toBe(first)
    expect(f.win.activeSpaceId).toBe(home)
    expect(activeTab(f)?.id).toBe(first)
    expect(activeTab(f)?.url).toBe('zen://settings/privacy')
    expect(
      Object.values(f.browser.state.model.tabs).filter((t) => t.url.startsWith('zen://settings'))
    ).toHaveLength(1)
  })

  it('falls back to the settings overlay on a host without page tabs (the desktop)', () => {
    const f = fixture({ pageTabs: false })
    openSite(f, 'https://a.test/')
    const before = spaceUrls(f)
    const result = openPage(f, 'resources')
    expect(result).toBeNull()
    expect(spaceUrls(f)).toEqual(before)
    expect(f.sent.filter((s) => s.name === 'overlay.open').pop()?.payload).toEqual({
      kind: 'settings',
      section: 'resources'
    })
  })
})

describe('typed and external page addresses', () => {
  it('opens the page tab from the URL bar with the current tab as opener, leaving it alone', () => {
    const f = fixture()
    const site = openSite(f, 'https://a.test/')
    f.browser.handleCommand(f.win, 'urlbar.submit', {
      input: 'zenium://settings/look',
      newTab: false,
      tabId: site.id,
      background: false
    })
    const tab = activeTab(f)
    expect(tab?.url).toBe('zen://settings/look')
    expect(tab?.openerTabId).toBe(site.id)
    expect(f.browser.tabs.tab(site.id)?.url).toBe('https://a.test/')
  })

  it('moves the Settings tab itself when the address is typed into it', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f)
    f.browser.handleCommand(f.win, 'urlbar.submit', {
      input: 'zenium://settings/about',
      newTab: false,
      tabId: id,
      background: false
    })
    expect(spaceUrls(f).filter((u) => u.startsWith('zen://settings'))).toHaveLength(1)
    expect(activeTab(f)?.url).toBe('zen://settings/about')
  })

  it('opens a deep link from outside the app without an opener, marked as the intent’s', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    f.browser.openExternalUrl('zenium://settings/privacy', f.win, { fromIntent: true })
    const tab = activeTab(f)
    expect(tab?.url).toBe('zen://settings/privacy')
    expect(tab?.openerTabId).toBeNull()
    // The chrome's root-back rule reads this: back at the landing returns to the app that sent it.
    expect(tab?.fromIntent).toBe(true)
    // A second deep link reuses the tab.
    f.browser.openExternalUrl('zenium://settings/look', f.win, { fromIntent: true })
    expect(spaceUrls(f).filter((u) => u.startsWith('zen://settings'))).toHaveLength(1)
    expect(activeTab(f)?.url).toBe('zen://settings/look')
  })

  it('does not mark a page the browser opens on its own behalf as another app’s', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    f.browser.openExternalUrl('zenium://settings', f.win)
    expect(activeTab(f)?.fromIntent).toBe(false)
  })
})

describe('moving between sections', () => {
  it('keeps a history the toolbar reads like a document history', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f) ?? ''
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'look' })
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'privacy' })
    const tab = (): Tab | undefined => f.browser.tabs.tab(id)
    expect(tab()?.url).toBe('zen://settings/privacy')
    expect(tab()?.canGoBack).toBe(true)
    expect(tab()?.canGoForward).toBe(false)
    f.browser.tabs.goBack(id)
    expect(tab()?.url).toBe('zen://settings/look')
    expect(tab()?.canGoForward).toBe(true)
    f.browser.tabs.goBack(id)
    expect(tab()?.url).toBe('zen://settings')
    expect(tab()?.title).toBe('Settings')
    expect(tab()?.canGoBack).toBe(false)
    f.browser.tabs.goForward(id)
    expect(tab()?.url).toBe('zen://settings/look')
    // A new section from the middle drops the forward entries.
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'about' })
    expect(tab()?.canGoForward).toBe(false)
    f.browser.tabs.goBack(id)
    expect(tab()?.url).toBe('zen://settings/look')
  })

  it('does not record a move to the section already shown', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f) ?? ''
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'look' })
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'look' })
    f.browser.tabs.goBack(id)
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://settings')
    expect(f.browser.tabs.tab(id)?.canGoBack).toBe(false)
  })

  it('replaces the entry shown instead of pushing one when asked (the two-pane nav, v2 §10.5)', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f, 'look') ?? ''
    const tab = (): Tab | undefined => f.browser.tabs.tab(id)
    // A deep link keeps the landing beneath the section; the sidebar's picks swap the section.
    expect(tab()?.canGoBack).toBe(true)
    f.browser.handleCommand(f.win, 'page.navigate', {
      tabId: id,
      section: 'privacy',
      replace: true
    })
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'about', replace: true })
    expect(tab()?.url).toBe('zen://settings/about')
    expect(tab()?.title).toBe('Settings')
    expect(tab()?.canGoForward).toBe(false)
    f.browser.tabs.goBack(id)
    expect(tab()?.url).toBe('zen://settings')
    expect(tab()?.canGoBack).toBe(false)
    // Replacing from the middle of a history keeps the entries after it.
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'tabs', replace: true })
    expect(tab()?.url).toBe('zen://settings/tabs')
    expect(tab()?.canGoForward).toBe(true)
    f.browser.tabs.goForward(id)
    expect(tab()?.url).toBe('zen://settings/about')
  })
})

describe('back inside Settings (the tab’s history)', () => {
  it('steps back through the sections; at the landing the tab stays for the chrome’s root rule', () => {
    const f = fixture()
    const site = openSite(f, 'https://a.test/')
    const id = openPage(f) ?? ''
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'privacy' })
    expect(f.browser.tabs.tab(id)?.canGoBack).toBe(true)
    back(f, id)
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://settings')
    expect(f.browser.tabs.tab(id)?.canGoBack).toBe(false)
    // Nothing beneath the landing: the tab is left as it is, and the chrome's one root-back rule
    // (`rootBackAction`, renderer back.ts) decides from what the tab remembers – here the
    // opener it closes back to.
    back(f, id)
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://settings')
    expect(activeTab(f)?.id).toBe(id)
    expect(f.browser.tabs.tab(id)?.openerTabId).toBe(site.id)
    expect(f.browser.tabs.tab(id)?.fromIntent).toBe(false)
  })

  it('remembers the opener as an id the chrome checks is still open', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const b = openSite(f, 'https://b.test/')
    const id = openPage(f) ?? ''
    expect(f.browser.tabs.tab(id)?.openerTabId).toBe(b.id)
    f.browser.tabs.closeTab(b.id, false, f.win)
    // A dangling opener is no opener: the root rule falls through to the previous tab.
    expect(f.browser.tabs.tab(id)?.openerTabId).toBe(b.id)
    expect(f.browser.tabs.tab(b.id)).toBeUndefined()
  })

  it('forgets a closed page tab’s history and starts a reopened one afresh', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f) ?? ''
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'privacy' })
    f.browser.tabs.closeTab(id, false, f.win)
    const again = openPage(f) ?? ''
    expect(again).not.toBe(id)
    expect(f.browser.tabs.tab(again)?.url).toBe('zen://settings')
    expect(f.browser.tabs.tab(again)?.canGoBack).toBe(false)
  })
})

describe('registry attributes the core reads', () => {
  it('keeps a page out of splits while its entry says splittable: false (Settings)', () => {
    const f = fixture()
    const a = openSite(f, 'https://a.test/')
    const b = openSite(f, 'https://b.test/')
    const id = openPage(f) ?? ''
    f.browser.tabs.createSplit([a.id, id], 'vertical', f.win)
    // Settings was filtered out; one tab left is no split.
    expect(f.browser.tabs.tab(id)?.splitGroupId).toBeNull()
    expect(f.browser.tabs.tab(a.id)?.splitGroupId).toBeNull()
    f.browser.tabs.createSplit([a.id, b.id], 'vertical', f.win)
    const group = f.browser.tabs.tab(a.id)?.splitGroupId ?? ''
    expect(group).not.toBe('')
    f.browser.tabs.addToSplit(group, id)
    expect(f.browser.tabs.tab(id)?.splitGroupId).toBeNull()
    expect(f.browser.state.model.splitGroups[group]?.tabIds).toEqual([a.id, b.id])
  })

  it('lets a page whose entry allows it share a split (a document page)', () => {
    const f = fixture({ pages: TRIAL })
    const a = openSite(f, 'https://a.test/')
    const id = f.browser.handleCommand(f.win, 'page.open', { id: 'downloads' }) as string
    f.browser.tabs.createSplit([a.id, id], 'vertical', f.win)
    const group = f.browser.tabs.tab(a.id)?.splitGroupId
    expect(group).toBeTruthy()
    expect(f.browser.tabs.tab(id)?.splitGroupId).toBe(group)
  })

  it('keeps the star on a page whose entry shows it, and off every other zen:// document', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f, 'privacy') ?? ''
    expect(f.browser.bookmarkable('zen://settings/privacy')).toBe(true)
    expect(f.browser.bookmarkable('https://a.test/')).toBe(true)
    expect(f.browser.bookmarkable('zen://history')).toBe(false)
    expect(f.browser.bookmarkable('zen://blank')).toBe(false)
    f.browser.toggleBookmark(id, f.win)
    expect(f.browser.bookmarks.has('zen://settings/privacy')).toBe(true)
    expect(f.browser.tabs.tab(id)?.bookmarked).toBe(true)
    // A section is its own address: the star follows the tab's history like a site's.
    back(f, id)
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://settings')
    expect(f.browser.tabs.tab(id)?.bookmarked).toBe(false)
    f.browser.tabs.goForward(id)
    expect(f.browser.tabs.tab(id)?.bookmarked).toBe(true)
  })

  it('does not star a page whose entry hides it', () => {
    const f = fixture({ pages: TRIAL })
    openSite(f, 'https://a.test/')
    const id = f.browser.handleCommand(f.win, 'page.open', { id: 'welcome' }) as string
    expect(f.browser.bookmarkable('zen://welcome')).toBe(false)
    f.browser.toggleBookmark(id, f.win)
    expect(f.browser.bookmarks.has('zen://welcome')).toBe(false)
  })

  it('leaves zoom alone on a chrome page: no view to zoom, so the factor stays 1 and no chip shows', () => {
    const f = fixture()
    const id = openPage(f) ?? ''
    f.sent.length = 0
    f.browser.handleCommand(f.win, 'tab.setZoom', { tabId: id, delta: 1 })
    f.browser.handleCommand(f.win, 'tab.setZoomFactor', { tabId: id, factor: 1.5 })
    f.browser.handleCommand(f.win, 'tab.setZoom', { tabId: id, delta: null })
    expect(f.browser.tabs.tab(id)?.zoom).toBe(1)
    expect(f.sent.some((s) => s.name === 'zoom.changed')).toBe(false)
    expect(f.browser.state.settings.pageControls.siteZooms).toEqual({})
  })
})

describe('the address the user gets (zen:// never leaves tab.url)', () => {
  it('copies the zenium:// alias, plain and as Markdown', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f, 'privacy') ?? ''
    f.browser.handleCommand(f.win, 'tab.copyUrl', { tabId: id, markdown: false })
    f.browser.handleCommand(f.win, 'tab.copyUrl', { tabId: id, markdown: true })
    expect(f.copied).toEqual(['zenium://settings/privacy', '[Settings](zenium://settings/privacy)'])
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://settings/privacy')
  })

  it('shares the alias – the deep link another app opens the page by', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f, 'look') ?? ''
    f.browser.shareTab(id, f.win)
    expect(f.shared).toEqual(['zenium://settings/look'])
    // Other zen:// documents still have nothing to share.
    const blank = f.browser.tabs.createTab({ url: 'zen://blank', active: true }, f.win)
    f.browser.shareTab(blank.id, f.win)
    expect(f.shared).toEqual(['zenium://settings/look'])
  })
})

describe('a page asked for from a popup window (core rule)', () => {
  /** A page's sized `window.open` on a desktop-shaped host: a toolbar-only window off `f.win`. */
  function popupOff(f: Fixture, from: ZenWindow = f.win): ZenWindow {
    return f.browser.createWindow({
      kind: 'unsynced',
      from,
      chrome: 'popup',
      bounds: { x: 80, y: 80, width: 500, height: 400 },
      empty: true
    })
  }

  it('opens the page in the popup’s opener, brought to the front, and never in the popup', () => {
    const f = fixture({ windows: true })
    openSite(f, 'https://a.test/')
    const popup = popupOff(f)
    const inPopup = f.browser.tabs.createTab({ url: 'https://popup.test/', active: true }, popup)
    const id = f.browser.handleCommand(popup, 'page.open', { id: 'settings', section: 'privacy' })
    const tab = f.browser.tabs.tab(typeof id === 'string' ? id : undefined)
    expect(tab?.url).toBe('zen://settings/privacy')
    // In the opener's space, active there; the popup's own tab is not in that window.
    expect(spaceUrls(f)).toContain('zen://settings/privacy')
    expect(activeTab(f)?.id).toBe(id)
    expect(tab?.openerTabId).toBeNull()
    expect(popup.localSpace?.tabIds).toEqual([inPopup.id])
    expect(f.raised.get(f.win.id)).toBe(1)
    // The window that asked is the one a chrome page's overlay fallback would go to as well.
    expect(f.browser.pages.hostWindowFor(popup)).toBe(f.win)
    expect(f.browser.pages.hostWindowFor(f.win)).toBe(f.win)
  })

  it('reuses the opener’s Settings tab from the popup as it would from the opener', () => {
    const f = fixture({ windows: true })
    openSite(f, 'https://a.test/')
    const first = openPage(f, 'look')
    const popup = popupOff(f)
    f.browser.tabs.createTab({ url: 'https://popup.test/', active: true }, popup)
    const again = f.browser.handleCommand(popup, 'page.open', { id: 'settings', section: 'about' })
    expect(again).toBe(first)
    expect(f.browser.tabs.tab(first ?? undefined)?.url).toBe('zen://settings/about')
    expect(spaceUrls(f).filter((u) => u.startsWith('zen://settings'))).toHaveLength(1)
  })

  it('walks a popup’s popup up to the full window, else takes the full window used last', () => {
    const f = fixture({ windows: true })
    openSite(f, 'https://a.test/')
    const popup = popupOff(f)
    const nested = popupOff(f, popup)
    expect(f.browser.pages.hostWindowFor(nested)).toBe(f.win)
    // The opener closed: the last full window used stands in.
    const other = f.browser.createWindow({ kind: 'synced', from: f.win })
    other.onFocused()
    f.win.host.close()
    f.browser.onWindowClosed(f.win)
    expect(f.browser.pages.hostWindowFor(popup)).toBe(other)
  })

  it('sends a chrome page’s overlay to the opener on a host without page tabs', () => {
    const f = fixture({ windows: true, pageTabs: false })
    openSite(f, 'https://a.test/')
    const popup = popupOff(f)
    f.browser.tabs.createTab({ url: 'https://popup.test/', active: true }, popup)
    f.sent.length = 0
    const result = f.browser.handleCommand(popup, 'page.open', { id: 'settings' })
    expect(result).toBeNull()
    const overlays = f.sent.filter((s) => s.name === 'overlay.open')
    expect(overlays).toHaveLength(1)
    expect(overlays[0].winId).toBe(f.win.id)
    expect(f.raised.get(f.win.id)).toBe(1)
  })
})

describe('a chrome page tab has no view to attach (the guarantee for moves and tear-off)', () => {
  it('is whole without one: load, claim and claimVisible leave it as it is', () => {
    const f = fixture()
    openSite(f, 'https://a.test/')
    const id = openPage(f, 'look') ?? ''
    const tabs = f.browser.tabs
    expect(tabs.view(id)).toBeUndefined()
    expect(tabs.ensureLoaded(id, f.win)).toBeUndefined()
    expect(tabs.load(id, f.win)).toBeUndefined()
    expect(tabs.claim(id, f.win)).toBe(false)
    tabs.claimVisible(f.win)
    expect(tabs.ownerOf(id)).toBeUndefined()
    expect(f.viewsFor).not.toContain(id)
    // Shown all the same: the window resolves through what it shows, not through a view owner.
    expect(tabs.visibleTabIds(f.win)).toEqual([id])
    expect(tabs.windowFor(id)).toBe(f.win)
    expect(tabs.tab(id)?.discarded).toBe(false)
    expect(tabs.tab(id)?.loading).toBe(false)
    expect(tabs.tab(id)?.canGoBack).toBe(true)
  })

  it('moves into another window and shows there view-less, its section history intact', () => {
    const f = fixture({ windows: true })
    openSite(f, 'https://a.test/')
    const id = openPage(f, 'look') ?? ''
    const blank = f.browser.createWindow({ kind: 'unsynced', from: f.win })
    const local = blank.localSpace
    if (!local) throw new Error('a blank window has a local space')
    f.browser.handleCommand(blank, 'tab.moveToSpace', { tabId: id, spaceId: local.id })
    f.browser.tabs.activateTab(id, blank)
    f.browser.tabs.claimVisible(blank)
    expect(f.browser.tabs.tab(id)?.spaceId).toBe(local.id)
    expect(f.browser.tabs.visibleTabIds(blank)).toEqual([id])
    expect(f.browser.tabs.windowFor(id)).toBe(blank)
    expect(f.viewsFor).not.toContain(id)
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://settings/look')
    expect(f.browser.tabs.tab(id)?.canGoBack).toBe(true)
    back(f, id)
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://settings')
    // One per window: the window it left has none now, so opening there makes a new tab.
    const again = openPage(f)
    expect(again).not.toBe(id)
    expect(spaceUrls(f).filter((u) => u.startsWith('zen://settings'))).toHaveLength(1)
  })

  it('outlives the window that showed it when another window remains, and shows there', () => {
    const f = fixture({ windows: true })
    openSite(f, 'https://a.test/')
    const id = openPage(f, 'privacy') ?? ''
    const other = f.browser.createWindow({ kind: 'synced', from: f.win })
    f.win.onClosing()
    f.win.host.close()
    f.win.onClosed()
    expect(f.browser.allWindows()).toEqual([other])
    expect(f.browser.tabs.tab(id)).toBeDefined()
    expect(f.browser.tabs.tab(id)?.discarded).toBe(false)
    f.browser.tabs.activateTab(id, other)
    f.browser.tabs.claimVisible(other)
    expect(f.browser.tabs.visibleTabIds(other)).toEqual([id])
    expect(f.viewsFor).not.toContain(id)
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://settings/privacy')
  })
})

describe('a restored session', () => {
  it('brings the Settings tab back on its section, loaded and without an opener', () => {
    const space = createSpace('Work', '')
    const site = createTabRecord({
      spaceId: space.id,
      containerId: 'default',
      url: 'https://a.test/'
    })
    const settings = createTabRecord({
      spaceId: space.id,
      containerId: 'default',
      url: 'zen://settings/privacy',
      openerTabId: site.id
    })
    space.tabIds = [site.id, settings.id]
    space.activeTabId = settings.id
    const f = fixture({
      profile: {
        version: 2,
        spaces: [space],
        tabs: [site, settings],
        essentialTabIds: [],
        activeSpaceId: space.id,
        settings: { onboardingDone: true }
      }
    })
    const restored = f.browser.tabs.tab(settings.id)
    expect(restored?.url).toBe('zen://settings/privacy')
    expect(restored?.title).toBe('Settings')
    expect(restored?.discarded).toBe(false)
    // Opener relationships are a session's own (Chrome forgets them too), and a restored tab
    // was restored by us, not sent by an app.
    expect(restored?.openerTabId).toBeNull()
    expect(restored?.fromIntent).toBe(false)
    expect(f.viewsFor).not.toContain(settings.id)
    // Its history starts afresh from the URL: the landing beneath the section.
    expect(restored?.canGoBack).toBe(true)
    back(f, settings.id)
    expect(f.browser.tabs.tab(settings.id)?.url).toBe('zen://settings')
    expect(f.browser.tabs.tab(settings.id)?.canGoBack).toBe(false)
    expect(f.browser.tabs.tab(site.id)).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Document pages: the same route with a page view (the new tab page, once the desktop
// registers it). Tried here with a registry the desktop's entries would look like.
// ---------------------------------------------------------------------------

// `welcome` stands in for the new tab page: `zen://newtab` is an alias `inputToUrl` folds into
// `zen://blank` today, and the shared normaliser only knows the pages in the real registry.
const TRIAL: InternalPageRegistry = {
  ...INTERNAL_PAGES,
  welcome: {
    id: 'welcome',
    title: 'Welcome',
    render: 'document',
    singleton: false,
    pill: { showStar: false },
    splittable: true,
    sections: []
  },
  downloads: {
    id: 'downloads',
    title: 'Downloads',
    render: 'document',
    singleton: true,
    glyph: 'download',
    pill: { showStar: true },
    splittable: true,
    sections: [{ id: 'active', label: 'Active', keywords: [] }]
  }
}

describe('a document page on the same route', () => {
  it('opens in a tab with a page view every time (singleton: false), an opener remembered', () => {
    const f = fixture({ pages: TRIAL })
    const site = openSite(f, 'https://a.test/')
    const first = f.browser.handleCommand(f.win, 'page.open', { id: 'welcome' }) as string
    const second = f.browser.handleCommand(f.win, 'page.open', { id: 'welcome' }) as string
    expect(first).not.toBe(second)
    expect(f.browser.tabs.tab(first)?.url).toBe('zen://welcome')
    // The page's title until the document reports its own.
    expect(f.browser.tabs.tab(first)?.title).toBe('Welcome')
    expect(f.browser.tabs.tab(first)?.openerTabId).toBe(site.id)
    // Its page is a document: the view loads it, and the view's history is the tab's.
    expect(f.viewsFor).toContain(first)
    expect(f.loaded).toContain('zen://welcome')
    expect(spaceUrls(f).filter((u) => u === 'zen://welcome')).toHaveLength(2)
  })

  it('is a tab on a host without page tabs too: only chrome pages fall back to an overlay', () => {
    const f = fixture({ pages: TRIAL, pageTabs: false })
    openSite(f, 'https://a.test/')
    const id = f.browser.handleCommand(f.win, 'page.open', { id: 'downloads' })
    expect(typeof id).toBe('string')
    expect(activeTab(f)?.url).toBe('zen://downloads')
    expect(f.sent.filter((s) => s.name === 'overlay.open')).toHaveLength(0)
  })

  it('keeps one per window when asked, focusing it from a typed address in another tab', () => {
    const f = fixture({ pages: TRIAL })
    const site = openSite(f, 'https://a.test/')
    const id = f.browser.handleCommand(f.win, 'page.open', { id: 'downloads' }) as string
    f.browser.tabs.activateTab(site.id, f.win)
    // (The canonical form: `inputToUrl` only knows the alias for pages in the real registry.)
    f.browser.handleCommand(f.win, 'urlbar.submit', {
      input: 'zen://downloads/active',
      newTab: false,
      tabId: site.id,
      background: false
    })
    expect(activeTab(f)?.id).toBe(id)
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://downloads/active')
    expect(f.browser.tabs.tab(site.id)?.url).toBe('https://a.test/')
    expect(spaceUrls(f).filter((u) => u.startsWith('zen://downloads'))).toHaveLength(1)
    // Loaded by the view, as a document: no section history of the service's own.
    expect(f.loaded).toContain('zen://downloads/active')
    expect(f.browser.tabs.tab(id)?.canGoBack).toBe(false)
  })

  it('loads a typed address for a page with no tab to reuse in the tab it was typed into', () => {
    const f = fixture({ pages: TRIAL })
    const site = openSite(f, 'https://a.test/')
    f.browser.handleCommand(f.win, 'urlbar.submit', {
      input: 'zen://welcome',
      newTab: false,
      tabId: site.id,
      background: false
    })
    expect(activeTab(f)?.id).toBe(site.id)
    expect(f.browser.tabs.tab(site.id)?.url).toBe('zen://welcome')
  })

  it('navigates a document page to a section through its view', () => {
    const f = fixture({ pages: TRIAL })
    openSite(f, 'https://a.test/')
    const id = f.browser.handleCommand(f.win, 'page.open', { id: 'downloads' }) as string
    f.browser.handleCommand(f.win, 'page.navigate', { tabId: id, section: 'active' })
    expect(f.browser.tabs.tab(id)?.url).toBe('zen://downloads/active')
    expect(f.loaded.at(-1)).toBe('zen://downloads/active')
  })
})
