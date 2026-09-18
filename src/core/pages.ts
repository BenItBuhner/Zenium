/**
 * Internal pages as tabs (`shared/internalPages.ts`): opening Settings in a tab of its own,
 * reusing the one already open in the space, moving between its sections, and the back
 * behaviour a page tab has instead of a document's history.
 *
 * A page tab never has a page view: the chrome draws the page inside the content area and the
 * `TabManager` skips view creation for it, so no favicon is fetched, nothing is recorded in
 * history and nothing is snapshotted. Its "history" is the list of sections visited, kept here
 * per tab and mirrored into `tab.canGoBack` / `canGoForward` so the toolbar's buttons and the
 * system back gesture read it like a document's.
 *
 * Hosts without `capabilities.pageTabs` (the desktop today) get the page's overlay from the same
 * entry point, so every caller – menus, commands, typed URLs, deep links – goes through
 * {@link PageService.open} and the platform decides the presentation.
 */
import type { ZenWindow } from './window'
import type { Browser } from './browser'
import type { InternalPageId, InternalPageRef } from '../shared/internalPages'
import {
  internalPageUrl,
  isInternalPageUrl,
  parseInternalPageUrl,
  sameInternalPage
} from '../shared/internalPages'
import type { OverlayKind, PageBackOutcome, Tab } from '../shared/types'
import { titleForUrl } from '../shared/url'
import { orderedTabsForSpace, tabVisibleIn } from './model'

/** The section addresses a page tab visited, and which one it shows. */
interface PageHistory {
  entries: string[]
  index: number
}

/** The overlay a page falls back to on hosts that draw pages above the tab. */
const PAGE_OVERLAYS: Record<InternalPageId, OverlayKind> = {
  settings: 'settings'
}

/**
 * The history a page tab starts with: a section (a deep link, a restored tab) has the landing
 * page beneath it, so the header's chevron and the system back land there first (v2 §10.2); the
 * landing page itself is the whole history.
 */
function initialHistory(url: string): PageHistory {
  const ref = parseInternalPageUrl(url)
  if (!ref || ref.section === null) return { entries: [url], index: 0 }
  return { entries: [internalPageUrl({ id: ref.id, section: null }), url], index: 1 }
}

export class PageService {
  private readonly histories = new Map<string, PageHistory>()

  constructor(private readonly browser: Browser) {}

  /** Whether this host opens pages as tabs (else as overlays). */
  get asTabs(): boolean {
    return this.browser.platform.capabilities.pageTabs
  }

  /** Whether `tab` is an internal page tab (drawn by the chrome, no page view). */
  isPageTab(tab: Tab | undefined): boolean {
    return tab !== undefined && isInternalPageUrl(tab.url)
  }

  /**
   * Open a page. With page tabs: the window's tab of the same page is focused – one per window,
   * as Firefox's `switchToTabHavingURI` keeps one about:preferences (v2 §10.1), switching space
   * when it lives in another – and moved to `section` when one is given (`undefined` keeps it
   * where it is, `null` is the landing page); otherwise a new tab opens next to its opener, which
   * it remembers for back. Without page tabs the page's overlay opens. Returns the tab id, or
   * null for an overlay.
   */
  open(
    id: InternalPageId,
    section: string | null | undefined,
    win: ZenWindow = this.browser.focusedWindow(),
    openerTabId?: string | null
  ): string | null {
    if (!this.asTabs) {
      this.browser.emit(
        'overlay.open',
        { kind: PAGE_OVERLAYS[id], section: section ?? undefined },
        win
      )
      return null
    }
    const tabs = this.browser.tabs
    const existing = this.findInWindow(id, win)
    if (existing) {
      if (section !== undefined) this.navigate(existing.id, section)
      tabs.activateTab(existing.id, win)
      return existing.id
    }
    const opener =
      openerTabId === undefined ? tabs.activeTabFor(win) : tabs.tab(openerTabId ?? undefined)
    const url = internalPageUrl({ id, section: section ?? null })
    const tab = tabs.createTab(
      {
        url,
        active: true,
        afterTabId: opener && !opener.essential ? opener.id : undefined,
        containerId: opener?.containerId
      },
      win
    )
    tab.openerTabId = opener && opener.id !== tab.id ? opener.id : null
    const history = initialHistory(url)
    this.histories.set(tab.id, history)
    this.apply(tab, history)
    this.browser.state.commit()
    return tab.id
  }

  /** Open the page a `zen://` / `zenium://` address names; false when it is not a page. */
  openUrl(url: string, win: ZenWindow, openerTabId?: string | null): boolean {
    const ref = parseInternalPageUrl(url)
    if (!ref) return false
    this.open(ref.id, ref.section, win, openerTabId)
    return true
  }

  /**
   * A navigation aimed at `tabId` turned out to be a page address: the tab moves to that section
   * when it already shows the page, else the page opens in its own tab with `tabId` as opener
   * (Chrome Android leaves the current tab alone when `chrome://settings` is typed into it).
   */
  navigateTabTo(tabId: string, ref: InternalPageRef): void {
    const tab = this.browser.tabs.tab(tabId)
    if (tab && sameInternalPage(tab.url, internalPageUrl(ref))) {
      this.navigate(tabId, ref.section)
      this.browser.tabs.activateTab(tabId, this.browser.tabs.windowFor(tabId))
      return
    }
    this.open(ref.id, ref.section, tab ? this.browser.tabs.windowFor(tabId) : undefined, tabId)
  }

  /** Move a page tab to a section of its page; a new history entry (no-op when already there). */
  navigate(tabId: string, section: string | null): void {
    const tab = this.browser.tabs.tab(tabId)
    const ref = tab ? parseInternalPageUrl(tab.url) : null
    if (!tab || !ref) return
    const url = internalPageUrl({ id: ref.id, section })
    if (url === tab.url) return
    const history = this.historyOf(tab)
    history.entries = [...history.entries.slice(0, history.index + 1), url]
    history.index = history.entries.length - 1
    this.apply(tab, history)
    this.browser.state.commit()
  }

  /**
   * System back inside a page tab: the previous section when there is one; else the opener –
   * closing the page tab, as Chrome closes a tab whose history is used up (a pinned page tab
   * is kept and only left); else the most recently used other tab of the space.
   */
  back(tabId: string, win: ZenWindow = this.browser.tabs.windowFor(tabId)): PageBackOutcome {
    const tabs = this.browser.tabs
    const tab = tabs.tab(tabId)
    if (!tab || !this.isPageTab(tab)) return 'none'
    const history = this.historyOf(tab)
    if (history.index > 0) {
      history.index -= 1
      this.apply(tab, history)
      this.browser.state.commit()
      return 'popped'
    }
    const opener = tab.openerTabId ? tabs.tab(tab.openerTabId) : undefined
    const target = opener && this.reachable(opener, win) ? opener : this.mostRecentOther(tab, win)
    if (!target) return 'none'
    tabs.activateTab(target.id, win)
    if (opener && target === opener && !tab.pinned && !tab.essential) {
      tabs.closeTab(tab.id, false, win)
      return 'closed'
    }
    return 'switched'
  }

  /** The toolbar's forward button on a page tab: the section left by a back. */
  forward(tabId: string): boolean {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab || !this.isPageTab(tab)) return false
    const history = this.historyOf(tab)
    if (history.index >= history.entries.length - 1) return false
    history.index += 1
    this.apply(tab, history)
    this.browser.state.commit()
    return true
  }

  /** Step back one section (the toolbar's back button); false when the tab is at its start. */
  popSection(tabId: string): boolean {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab || !this.isPageTab(tab)) return false
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
    for (const tab of Object.values(this.browser.state.model.tabs)) {
      if (tab.openerTabId === tabId) tab.openerTabId = null
    }
  }

  /**
   * The page tab of `id` this window can show, if one is open: the current space's when it has
   * one, else the one in any other space of the window (a blank or private window only has its
   * own tabs to look through).
   */
  findInWindow(id: InternalPageId, win: ZenWindow): Tab | undefined {
    const url = internalPageUrl({ id, section: null })
    const isPage = (t: Tab): boolean => sameInternalPage(t.url, url)
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

  /** A tab this window can switch to without leaving its space (an Essential counts). */
  private reachable(tab: Tab, win: ZenWindow): boolean {
    return this.tabsInSpace(win).some((t) => t.id === tab.id)
  }

  private mostRecentOther(tab: Tab, win: ZenWindow): Tab | undefined {
    return this.tabsInSpace(win)
      .filter((t) => t.id !== tab.id)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]
  }

  /** The tab's section history; a restored tab gets a fresh one from its URL. */
  private historyOf(tab: Tab): PageHistory {
    let history = this.histories.get(tab.id)
    if (!history) {
      history = initialHistory(tab.url)
      this.histories.set(tab.id, history)
    }
    return history
  }

  private apply(tab: Tab, history: PageHistory): void {
    tab.url = history.entries[history.index]
    tab.title = titleForUrl(tab.url)
    tab.canGoBack = history.index > 0
    tab.canGoForward = history.index < history.entries.length - 1
    tab.errorCode = null
    this.browser.tabs.windowFor(tab.id).updateTitle()
  }
}
