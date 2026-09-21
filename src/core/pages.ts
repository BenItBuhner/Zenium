/**
 * Internal pages as tabs (`shared/internalPages.ts`): opening a page in a tab of its own,
 * reusing the one the window already has, and moving between its sections – one route for
 * every page the browser provides, whichever way the page is drawn.
 *
 * A chrome page (`render: 'chrome'`, Settings) never has a page view: the chrome draws the page
 * inside the content area and the `TabManager` skips view creation for it, so no favicon is
 * fetched, nothing is recorded in history and nothing is snapshotted. Its "history" is the list
 * of sections visited, kept here per tab and mirrored into `tab.canGoBack` / `canGoForward`, so
 * the toolbar's buttons, the `tab.back` / `tab.forward` commands and the system back gesture
 * read it like a document's – and at the first entry the chrome's one root-back rule
 * (`rootBackAction` in the renderer's `back.ts`) applies to a page tab as to any other: back to
 * its opener, to the tab before it, or to the app that sent the deep link.
 *
 * A document page (`render: 'document'`, the new tab page once the desktop registers it) is a
 * document the core serves into an ordinary page view: the view loads it, keeps its history,
 * favicon and snapshot, and `tab.back` is the view's. Only opening, reuse, deep links and typed
 * addresses come through here.
 *
 * Hosts without `capabilities.pageTabs` cannot draw chrome into the content frame, and a page
 * may name the layouts it is a tab in (`layouts`: History, Bookmarks and Downloads are tabs on
 * the desktop and the tablet, the phone's panels and sheets otherwise); anywhere else a chrome
 * page opens as its `overlay` from the same entry point: every caller – menus, commands, typed
 * URLs, deep links – goes through {@link PageService.open} and the platform and layout decide
 * the presentation (`pageOpensAsTab`). Document pages are tabs on every host.
 *
 * A page tab is never private, as Chrome keeps chrome:// pages out of Incognito: asked from a
 * private window it opens in a regular window ({@link PageService.tabWindowFor}), asked from a
 * private tab it takes the default container – the private window or tab is left as it was, so
 * the private session still ends when the last of them closes.
 */
import type { ZenWindow } from './window'
import type { Browser } from './browser'
import type {
  InternalPageDefinition,
  InternalPageQuery,
  InternalPageRef,
  InternalPageRegistry
} from '../shared/internalPages'
import {
  INTERNAL_PAGES,
  internalPageOf,
  internalPageUrl,
  pageOpensAsTab,
  parseInternalPageUrl,
  sameInternalPage
} from '../shared/internalPages'
import { DEFAULT_CONTAINER_ID, type Tab } from '../shared/types'
import { titleForUrl } from '../shared/url'
import { orderedTabsForSpace, tabVisibleIn } from './model'

/** The section addresses a chrome page tab visited, and which one it shows. */
interface PageHistory {
  entries: string[]
  index: number
}

/**
 * The history a chrome page tab starts with: a section (a deep link, a restored tab) has the
 * landing page beneath it, so the header's chevron and the system back land there first (v2
 * §10.2); the landing page itself is the whole history.
 */
function initialHistory(url: string, pages: InternalPageRegistry): PageHistory {
  const ref = parseInternalPageUrl(url, pages)
  if (!ref || ref.section === null) return { entries: [url], index: 0 }
  return { entries: [internalPageUrl({ id: ref.id, section: null }), url], index: 1 }
}

export class PageService {
  private readonly histories = new Map<string, PageHistory>()

  constructor(
    private readonly browser: Browser,
    /** The pages this service routes; the registry by default, another for a page on trial. */
    readonly pages: InternalPageRegistry = INTERNAL_PAGES
  ) {}

  /** Whether this host can hold a chrome page in a tab at all (else every one opens its overlay). */
  get asTabs(): boolean {
    return this.browser.platform.capabilities.pageTabs
  }

  /**
   * Whether `page` is a tab when asked from `win`: the host has page tabs and the layout the
   * asking window's chrome shows (its host window's, for a popup) is one the page is a tab in
   * (`layouts`; `pageOpensAsTab`). Otherwise the page opens as its overlay – the phone's
   * history panel, bookmarks panel and downloads sheet.
   */
  opensAsTab(page: InternalPageDefinition, win: ZenWindow): boolean {
    return pageOpensAsTab(
      page,
      this.browser.platform.capabilities,
      this.hostWindowFor(win).formFactor
    )
  }

  /** {@link opensAsTab} by page id; false for a page this host has not got. */
  opensPageAsTab(id: string, win: ZenWindow): boolean {
    const page = Object.prototype.hasOwnProperty.call(this.pages, id) ? this.pages[id] : undefined
    return page !== undefined && this.available(page) && this.opensAsTab(page, win)
  }

  /** The page a `zen://` / `zenium://` address names, when it is one this service routes. */
  parse(url: string): InternalPageRef | null {
    return parseInternalPageUrl(url, this.pages)
  }

  /**
   * The page definition an address names, if it is one this service routes: registered, and
   * one this host can show (`requires`) – on a host without the print preview, `zen://print`
   * is no page at all and loads as a document would.
   */
  pageAt(url: string): InternalPageDefinition | null {
    const page = internalPageOf(url, this.pages)
    return page && this.available(page) ? page : null
  }

  /** Whether this host has what the page needs. */
  available(page: InternalPageDefinition): boolean {
    return !page.requires || Boolean(this.browser.platform.capabilities[page.requires])
  }

  /** The page definition behind a tab, if the tab shows an internal page. */
  pageOf(tab: Tab | undefined): InternalPageDefinition | null {
    return tab ? this.pageAt(tab.url) : null
  }

  /** Whether `tab` is an internal page tab of either kind. */
  isPageTab(tab: Tab | undefined): boolean {
    return this.pageOf(tab) !== null
  }

  /**
   * Whether `tab` is a page the chrome draws: no page view, so nothing that would load, unload,
   * snapshot or navigate a view applies to it.
   */
  isChromePage(tab: Tab | undefined): boolean {
    return this.pageOf(tab)?.render === 'chrome'
  }

  /**
   * Whether `tab` may share the content area in a split view: a site always, a page as its
   * registry entry says (`splittable`) – a chrome page fills the area itself until the chrome
   * draws one page per pane.
   */
  splittable(tab: Tab | undefined): boolean {
    return this.pageOf(tab)?.splittable ?? true
  }

  /**
   * The window a page opens in when asked from `win`: `win` itself with the full chrome; from a
   * toolbar-only popup (a page's sized `window.open`) or an app window the browser window behind
   * it – the full window it came from, else the full window used last, else a new one
   * (`Browser.browserWindowFor`). Neither has a sidebar or strip to hold a second tab, and
   * Chrome opens chrome://settings from a popup in its opener as well. A private window is a
   * host like any other here – a page's overlay stays over the private window that asked – and
   * only a page *tab* leaves it ({@link tabWindowFor}).
   */
  hostWindowFor(win: ZenWindow): ZenWindow {
    return this.browser.browserWindowFor(win)
  }

  /**
   * The window a page *tab* opens in when asked from `win`: its host window
   * ({@link hostWindowFor}) when that is a regular window; from a private window – or a popup
   * whose openers are private, a private page's sized `window.open` – the regular full window
   * used last, as Chrome opens Settings asked from an Incognito window in a regular window. An
   * internal page never lives in the private container, so the private window holds no tab of
   * it and its session still ends when the window closes. Null when no regular window is alive
   * ({@link open} makes one). A host with one window has no private window: there a private
   * *tab* asks, and the container rule in {@link open} applies instead.
   */
  tabWindowFor(win: ZenWindow): ZenWindow | null {
    const host = this.hostWindowFor(win)
    if (!host.isPrivate) return host
    // A regular window with the full chrome: a popup or an app window has no strip for the tab.
    const regular = this.browser.allWindows().filter((w) => !w.isPrivate && w.chrome === 'full')
    return regular.sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)[0] ?? null
  }

  /**
   * Open a page. A `singleton` page that the window already has is focused – one per window, as
   * Firefox's `switchToTabHavingURI` keeps one about:preferences (v2 §10.1), switching space
   * when it lives in another – and moved to `section` when one is given (`undefined` keeps it
   * where it is, `null` is the landing page); otherwise a new tab opens next to its opener,
   * which it remembers for back (`Tab.openerTabId`; `fromIntent` marks a deep link another app
   * sent, `Tab.fromIntent`). Asked from a popup window the page opens in the popup's opener
   * ({@link hostWindowFor}), and asked from a private window in the regular window used last,
   * or a new one when none is open ({@link tabWindowFor}) – brought to the front either way,
   * with no opener tab (the asking window's tab is not in that window), the asking window left
   * as it was. A page tab never takes the private container: from a private tab (a host with
   * private tabs in its one window) it opens as a regular-container tab that still remembers
   * the private tab as its opener. A chrome page on a host without page tabs, or on a layout
   * the page is not a tab in ({@link opensAsTab}), opens as its overlay, over the asking window
   * (or a popup's opener) – private or not. `query` is the page's own parameters
   * (`InternalPageQuery`: History's `q`, the manager's `folder`); given with a reused tab it
   * moves the tab there, as a section does. Returns the tab id; null for an overlay or an
   * unregistered page.
   */
  open(
    id: string,
    section: string | null | undefined,
    win: ZenWindow = this.browser.focusedWindow(),
    openerTabId?: string | null,
    opts: { fromIntent?: boolean; query?: InternalPageQuery } = {}
  ): string | null {
    const page = Object.prototype.hasOwnProperty.call(this.pages, id) ? this.pages[id] : undefined
    if (!page || !this.available(page)) return null
    const asked = win
    if (!this.opensAsTab(page, asked)) {
      win = this.hostWindowFor(asked)
      if (page.overlay) {
        // The overlay's contract predates the query: the manager's `folder` is the overlay's
        // `folderId` (the phone's bookmarks panel opens on it); the rest has no overlay reading.
        this.browser.emit(
          'overlay.open',
          { kind: page.overlay, section: section ?? undefined, folderId: opts.query?.folder },
          win
        )
        // An overlay sent to another window is brought to the front there.
        if (win !== asked && win.alive) win.host.focus()
      }
      return null
    }
    // A page tab: in a regular window – the popup's opener, the private window's regular
    // neighbour, or a new regular window when none is open (what Ctrl+N makes from `asked`).
    win = this.tabWindowFor(asked) ?? this.browser.createWindow({ kind: 'synced', from: asked })
    const rerouted = win !== asked
    if (rerouted) openerTabId = null
    // A page sent to another window is brought to the front there.
    const raise = (): void => {
      if (rerouted && win.alive) win.host.focus()
    }
    const tabs = this.browser.tabs
    const opener =
      openerTabId === undefined ? tabs.activeTabFor(win) : tabs.tab(openerTabId ?? undefined)
    const existing = page.singleton ? this.findInWindow(page, win) : undefined
    if (existing) {
      // A section moves the tab there; a query alone moves it within the section it shows.
      if (section !== undefined || opts.query !== undefined) {
        const shown = this.parse(existing.url)?.section ?? null
        this.navigate(existing.id, section === undefined ? shown : section, false, opts.query)
      }
      // Re-focused rather than opened: the page now comes from this opener (the rows that read
      // "the page you came from", the root back rule), not the one it was first opened from; a
      // request from the page tab itself leaves its opener as it is.
      if (opener?.id !== existing.id) tabs.setOpener(existing.id, opener?.id ?? null)
      tabs.activateTab(existing.id, win)
      raise()
      return existing.id
    }
    const url = internalPageUrl({ id: page.id, section: section ?? null, query: opts.query })
    const tab = tabs.createTab(
      {
        url,
        active: true,
        afterTabId: opener && !opener.essential ? opener.id : undefined,
        // Never the private container (Chrome keeps chrome:// pages out of Incognito): from a
        // private tab the page is a regular-container tab, the private tab left as it is.
        containerId: opener && tabs.isPrivate(opener) ? DEFAULT_CONTAINER_ID : opener?.containerId,
        openerTabId: opener?.id,
        fromIntent: Boolean(opts.fromIntent)
      },
      win
    )
    raise()
    if (page.render === 'chrome') {
      const history = initialHistory(url, this.pages)
      this.histories.set(tab.id, history)
      this.apply(tab, history)
    } else {
      // The page's title until its document reports one, as `titleForUrl` gives a registered page.
      tab.title = page.title
    }
    this.browser.state.commit()
    return tab.id
  }

  /** Open the page a `zen://` / `zenium://` address names; false when it is not a page. */
  openUrl(
    url: string,
    win: ZenWindow,
    openerTabId?: string | null,
    opts: { fromIntent?: boolean } = {}
  ): boolean {
    const ref = this.parse(url)
    if (!ref) return false
    this.open(ref.id, ref.section, win, openerTabId, { ...opts, query: ref.query })
    return true
  }

  /**
   * A navigation the `TabManager` was asked to make in `tabId`. True when the page service took
   * it: the URL names a chrome page – the tab moves to that section when it already shows the
   * page, else the page opens in its own tab with `tabId` as opener (Chrome Android leaves the
   * current tab alone when `chrome://settings` is typed into it; from a private window that tab
   * is in a regular window, {@link open}) – or a `singleton` document page that another tab of
   * the window already shows, which is focused and navigated instead. False when the tab should
   * simply load the URL: a site, a document, or a document page that belongs in this tab.
   */
  routeNavigation(tabId: string, url: string): boolean {
    const ref = this.parse(url)
    if (!ref) return false
    const page = this.pages[ref.id]
    // A page this host cannot show loads as a document would (its blank page).
    if (!this.available(page)) return false
    const tabs = this.browser.tabs
    const tab = tabs.tab(tabId)
    if (page.render === 'chrome') {
      if (tab && sameInternalPage(tab.url, url, this.pages)) {
        this.navigate(tabId, ref.section, false, ref.query)
        tabs.activateTab(tabId, tabs.windowFor(tabId))
        return true
      }
      this.open(ref.id, ref.section, tab ? tabs.windowFor(tabId) : undefined, tabId, {
        query: ref.query
      })
      return true
    }
    if (!page.singleton || !tab) return false
    const win = tabs.windowFor(tabId)
    const existing = this.findInWindow(page, win)
    if (!existing || existing.id === tabId) return false
    tabs.navigate(existing.id, internalPageUrl(ref))
    tabs.activateTab(existing.id, win)
    return true
  }

  /**
   * Move a page tab to a section of its page, with the page's `query` when it has one (a section
   * without a query drops the one shown: the address is the section's). A chrome page records a
   * new history entry, or with `replace` rewrites the current one (the two-pane layout's nav, v2
   * §10.5); a move to the address already shown records nothing. A document page loads the
   * section's address in its view, whose own history takes it from there.
   */
  navigate(
    tabId: string,
    section: string | null,
    replace = false,
    query?: InternalPageQuery
  ): void {
    const tab = this.browser.tabs.tab(tabId)
    const page = this.pageOf(tab)
    const ref = tab ? this.parse(tab.url) : null
    if (!tab || !page || !ref) return
    const url = internalPageUrl({ id: ref.id, section, query })
    if (page.render === 'document') {
      if (url !== tab.url) this.browser.tabs.navigate(tabId, url)
      return
    }
    if (url === tab.url) return
    const history = this.historyOf(tab)
    if (replace) {
      history.entries[history.index] = url
    } else {
      history.entries = [...history.entries.slice(0, history.index + 1), url]
      history.index = history.entries.length - 1
    }
    this.apply(tab, history)
    this.browser.state.commit()
  }

  /** The toolbar's forward button on a chrome page tab: the section left by a back. */
  forward(tabId: string): boolean {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab || !this.isChromePage(tab)) return false
    const history = this.historyOf(tab)
    if (history.index >= history.entries.length - 1) return false
    history.index += 1
    this.apply(tab, history)
    this.browser.state.commit()
    return true
  }

  /**
   * Step a chrome page tab back one section (`tab.back`, the toolbar's and the system's back);
   * false when the tab is at its first entry – then the tab stays and the chrome's root-back
   * rule decides what a back does next.
   */
  popSection(tabId: string): boolean {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab || !this.isChromePage(tab)) return false
    const history = this.historyOf(tab)
    if (history.index <= 0) return false
    history.index -= 1
    this.apply(tab, history)
    this.browser.state.commit()
    return true
  }

  /** The tab is gone: forget its section history. */
  onTabRemoved(tabId: string): void {
    this.histories.delete(tabId)
  }

  /**
   * The tab of `page` this window can show, if one is open: the current space's when it has one,
   * else the one in any other space of the window (a blank or private window only has its own
   * tabs to look through).
   */
  findInWindow(page: InternalPageDefinition, win: ZenWindow): Tab | undefined {
    const url = internalPageUrl({ id: page.id, section: null })
    const isPage = (t: Tab): boolean => sameInternalPage(t.url, url, this.pages)
    const inSpace = this.tabsInSpace(win).find(isPage)
    if (inSpace || win.localSpace) return inSpace
    const m = this.browser.state.model
    return Object.values(m.tabs).find(
      (t) =>
        isPage(t) &&
        tabVisibleIn(t, win.id) &&
        t.spaceId !== null &&
        m.spaces.some((s) => s.id === t.spaceId)
    )
  }

  private tabsInSpace(win: ZenWindow): Tab[] {
    const m = this.browser.state.model
    const space = win.activeSpace()
    return orderedTabsForSpace(
      m,
      space,
      this.browser.state.settings.containerSpecificEssentials,
      win.id
    )
  }

  /** The tab's section history; a restored tab gets a fresh one from its URL. */
  private historyOf(tab: Tab): PageHistory {
    let history = this.histories.get(tab.id)
    if (!history) {
      history = initialHistory(tab.url, this.pages)
      this.histories.set(tab.id, history)
    }
    return history
  }

  private apply(tab: Tab, history: PageHistory): void {
    tab.url = history.entries[history.index]
    tab.title = this.pageOf(tab)?.title ?? titleForUrl(tab.url)
    tab.canGoBack = history.index > 0
    tab.canGoForward = history.index < history.entries.length - 1
    tab.errorCode = null
    // A section is its own address, so the star follows it as on a site's navigation.
    tab.bookmarked = this.browser.bookmarks.has(tab.url)
    this.browser.tabs.windowFor(tab.id).updateTitle()
  }
}
