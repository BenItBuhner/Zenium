import type {
  CertificateError,
  ClosedTabEntry,
  DevtoolsDock,
  HistoryTransition,
  NavigationSnapshot,
  Point,
  Settings,
  Space,
  SplitGroup,
  SplitLayout,
  Tab,
  TabMoveResult,
  TabSearchCandidate,
  TabSection,
  WindowKind
} from '../shared/types'
import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID } from '../shared/types'
import {
  addTabToSplit,
  createSplitGroup,
  createTabRecord,
  dissolveSplitGroup,
  essentialsForSpace,
  folderOpened,
  foldersOf,
  folderTabs,
  getSpace,
  insertTabIntoSpace,
  isSavedFolder,
  loadProgressAfter,
  MAX_SPLIT_TABS,
  moveTab,
  nextTabAfterClose,
  openerGroupIndex,
  orderedTabsForSpace,
  pinnedTabs,
  regularFolderTabs,
  regularTabs,
  removeTabFromLists,
  removeTabFromSplit,
  replaceTabInSplit,
  swapSplitPanes,
  savedGroupTab,
  sectionIndexOf,
  setSplitLinksToRight,
  splitLinksToRight,
  splitPlacement,
  tabVisibleIn,
  type Model,
  type SplitSide
} from './model'
import {
  BLANK_URL,
  ERROR_URL_PREFIX,
  crashPageUrl,
  type CrashPageVariant,
  type ErrorPageAccent,
  errorPageCertificate,
  errorPageUrl,
  extensionPageOf,
  getDomain,
  httpsOnlyPageUrl,
  interstitialKindOf,
  isBlankTabUrl,
  isEmptyTabUrl,
  isNavigableUrl,
  presentedUrl,
  safeBrowsingPageUrl,
  titleForUrl
} from '../shared/url'
import { isWithinScope } from '../shared/webApp'
import { resolveTheme, rgbToHex } from '../shared/theme'
import { PRIVATE_ACCENT } from '../shared/newTabPageScript'
import type { Browser } from './browser'
import type { ZenWindow } from './window'
import {
  BLOCKED_BY_CLIENT_CODE,
  CRASH_ERROR_CODE,
  crashCodeName,
  describeNetError,
  HTTP_FALLBACK_CODES
} from '../shared/zenPages'
import { isCertificateError } from '../shared/siteInfo'
import type { InterstitialAction } from '../shared/interstitial'
import { closedTabEntry, closedWindowEntry } from './session'
import { newId } from '../shared/ids'
import { clampZoom, stepZoom } from '../shared/pageControls'
import type { FaviconFetcher } from './favicons'
import { defer, type PageFlags, type TabView, type TabViewEvents } from './platform'
import { permissionSite, safeOrigin } from './permissions'
import { certificateSiteOf } from './security'
import { openedWindowKind, planWindowOpen } from './windowOpen'
import { parseDropKey } from './tabDrag'
import {
  reportIsLive,
  sameCapture,
  sanitiseCaptureReport,
  tabAlertFor,
  tabCaptureFor,
  type CaptureStateReport
} from '../shared/captureState'

export type { PageFlags } from './platform'

/** Hidden pages kept awake when memory runs low (`unloadForMemoryPressure`): the recent few. */
export const KEEP_UNDER_PRESSURE = 3

/**
 * The favicon a new bookmark takes from the tab it is made from: none from a private tab. A
 * private window bookmarks into the profile's store as Chrome's Incognito does (bookmarks-43),
 * but writes nothing of the visit – the favicon backfill already skips private tabs
 * (`updateFavicon`), and the star, Ctrl+D and a tab dropped on another window's bar must not
 * slip the icon in by the other door.
 */
export function bookmarkFaviconOf(tab: Tab, isPrivate: boolean): string | null {
  return isPrivate ? null : tab.favicon
}

/** Where the keyboard goes after a tab is activated or closed (`tab.activate` / `tab.close`). */
export interface TabFocusOptions {
  /** The keyboard stays in the chrome (the tab strip) instead of moving into the page. */
  keepFocus?: boolean
  /**
   * The user chose this tab themselves (a click, Ctrl+Tab, Ctrl+1–9): switching away from a tab
   * this way ends its opener-return (tabs-30), so a later close of it no longer jumps to its
   * opener. Internal activations (opening a tab, the pick after a close) leave the link standing.
   */
  userSwitch?: boolean
}

/**
 * Owns the live page for every loaded tab and implements Zen's tab behaviours on top of the pure
 * model. Pages are created through the host's `TabViewHost`; everything else is platform neutral.
 *
 * Every tab has at most one live page (Zen's window sync keeps a single process per tab). The
 * page is attached to the window that last selected it – the "owner" – and other windows showing
 * the same tab render a dimmed preview until they are focused.
 */
export class TabManager {
  private readonly views = new Map<string, TabView>()
  private readonly owners = new Map<string, ZenWindow>()
  /**
   * Tabs whose current load is an https:// upgrade – of typed input without a scheme, or of an
   * http:// navigation HTTPS-only mode's rule upgraded – keyed to the plaintext URL to fall back
   * to (or to ask about) when the secure load fails.
   */
  private readonly httpsUpgraded = new Map<string, string>()
  /** Back/forward stacks to replay when a reopened tab's page is created. */
  private readonly pendingNavigation = new Map<string, NavigationSnapshot>()
  /** Tabs under a window's or the app's unload check: a page that goes is unloaded, not closed. */
  private readonly unloadChecks = new Set<string>()
  /**
   * The focus options of a `requestClose` in flight: its unload check closes the page, and a
   * page that does not object is gone at once, so the tab closes through `onViewGone` – with
   * these, so a close from the keyboard in the tab strip keeps the keyboard there.
   */
  private readonly closeIntents = new Map<string, TabFocusOptions>()
  /**
   * Set by `onHostTeardown`: the host is going away with the tabs still open, so a view that
   * goes from here on went with the host, not with its page – never a close. Only a mobile host
   * sets it (Android's `teardown`); the desktop destroys its views itself before they report.
   */
  private hostGone = false
  /** How the next committed navigation of a tab came about (for the history record). */
  private readonly pendingTransition = new Map<string, HistoryTransition>()
  /**
   * What each live page was last told about the left pane's link rule (`PageFlags.
   * linksToSplitPane`), so `syncSplitLinkFlags` writes to a page only when its answer changed.
   */
  private readonly splitLinkFlags = new Map<string, boolean>()

  /**
   * The pane loading a link routed from the pane to its left (split-13), keyed by the loading
   * tab's id with the origin's: while the load runs, the right pane's new document taking the
   * keyboard is Chromium's doing and not the user moving there, so the keyboard is handed back
   * (`handKeyboardBack`). Cleared at the load's `dom-ready`, by the user's own input in the
   * right pane, or with the view.
   */
  private readonly splitLinkLoads = new Map<string, string>()
  /**
   * The server redirects the navigation under way in a tab went through (history-23): `hops`
   * first to last, `to` the address it is bound for now. The hosts report each hop before the
   * commit, which records the hops with the landing as one chain; a navigation that starts
   * elsewhere, fails or loses its tab drops them.
   */
  private readonly pendingRedirects = new Map<string, { hops: string[]; to: string }>()
  /**
   * Tabs whose crash page `onCrashed` has asked the view for and that has not committed yet. A
   * load already in flight when the renderer went (a restored list's current entry, Android)
   * may commit first: that commit is not the page the user is about to see, so it does not
   * clear the crash mark. The next commit of any kind consumes the entry.
   */
  private readonly crashPagePending = new Set<string>()
  /**
   * Tabs whose renderer the user ended from the "Page unresponsive" prompt (tabs-45): the
   * `onCrashed` that follows reads the kill as a page ended for not responding (the crash
   * page's `hung` words, no toast for one unloaded in the background). Consumed by that report.
   */
  private readonly hungExits = new Set<string>()
  /**
   * Tabs whose close, while active, returns to the opener (tabs-30): a tab opened by another
   * (`Tab.openerTabId`) joins this set, and leaves it the moment the user switches away from it,
   * so closing it comes back to its opener only when they never left it – Chrome's rule. A
   * session's own; not persisted.
   */
  private readonly openerReturn = new Set<string>()
  /**
   * Groups whose tabs are closing as one ("Close group", `closeFolderTabs`): the group's saved
   * pages are the whole group's, set before the first close, and the last member's close must
   * not narrow them to itself (the rule for members closed one by one, `closeTab`).
   */
  private readonly closingFolders = new Set<string>()
  /**
   * Where the next close's "Recently closed" entry goes instead of the session's list: set for
   * the span of `archiveTab`, whose close files the entry in the inactive-tabs archive (TAB-20).
   */
  private divertClosed: ((entry: ClosedTabEntry) => void) | null = null
  /**
   * Every frame's live capture report per tab, by the frame's reporter id (tabs-43): the tab's
   * `alert` is the highest any frame asks for, so a call in an iframe lights the row and a
   * frame that stops leaves the others' state standing.
   */
  private readonly captureReports = new Map<string, Map<string, CaptureStateReport>>()

  constructor(private readonly browser: Browser) {}

  // ---------------------------------------------------------------------------
  // Lookup helpers
  // ---------------------------------------------------------------------------

  get model(): Model {
    return this.browser.state.model
  }

  get settings(): Settings {
    return this.browser.state.settings
  }

  tab(tabId: string | null | undefined): Tab | undefined {
    return tabId ? this.model.tabs[tabId] : undefined
  }

  /** The live view of a tab, if it is loaded and not destroyed. */
  view(tabId: string): TabView | undefined {
    const view = this.views.get(tabId)
    return view && !view.isDestroyed() ? view : undefined
  }

  allViews(): Iterable<[string, TabView]> {
    return this.views.entries()
  }

  /** Window currently holding a tab's live page. */
  ownerOf(tabId: string): ZenWindow | undefined {
    return this.owners.get(tabId)
  }

  viewsOwnedBy(win: ZenWindow): Map<string, TabView> {
    const out = new Map<string, TabView>()
    for (const [tabId, owner] of this.owners) {
      const view = this.views.get(tabId)
      if (owner === win && view) out.set(tabId, view)
    }
    return out
  }

  activeSpaceFor(win: ZenWindow): Space {
    return win.activeSpace()
  }

  activeTabFor(win: ZenWindow): Tab | undefined {
    return this.tab(win.selectedTabIn(win.activeSpace()))
  }

  /** The title a window shows for its active tab (the custom name wins), or null when it has none. */
  activeTitleFor(win: ZenWindow): string | null {
    const tab = this.activeTabFor(win)
    if (!tab) return null
    return tab.customTitle ?? tab.title
  }

  /** Tabs currently shown in a window's content area (active tab, or every tab of its split group). */
  visibleTabIds(win: ZenWindow): string[] {
    const active = this.activeTabFor(win)
    if (!active) return []
    if (active.splitGroupId) {
      const group = this.model.splitGroups[active.splitGroupId]
      if (group) return group.tabIds
    }
    return [active.id]
  }

  /** Windows that show a tab in their content area right now. */
  windowsShowing(tabId: string): ZenWindow[] {
    return this.browser.allWindows().filter((w) => this.visibleTabIds(w).includes(tabId))
  }

  /** Best window to act on a tab: its page's owner, else a window showing it, else the focused one. */
  windowFor(tabId: string): ZenWindow {
    return this.owners.get(tabId) ?? this.windowsShowing(tabId)[0] ?? this.browser.focusedWindow()
  }

  /** Union of the tabs visible in any window (plus Glance pages and their parents). */
  allVisibleTabIds(): Set<string> {
    const visible = new Set<string>()
    for (const w of this.browser.allWindows()) {
      for (const id of this.visibleTabIds(w)) visible.add(id)
      if (w.glance) visible.add(w.glance.tabId).add(w.glance.parentTabId)
    }
    return visible
  }

  // ---------------------------------------------------------------------------
  // View lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Make sure a tab has a live page. Visible tabs load right away (evicting a hidden page first
   * when the live-page cap is reached); background loads go through the governor's queue and
   * return `undefined` while they wait for a slot. `win` is the window that will own the page
   * (default: the window showing the tab, else the focused one).
   */
  ensureLoaded(
    tabId: string,
    win?: ZenWindow,
    opts: { background?: boolean } = {}
  ): TabView | undefined {
    const tab = this.tab(tabId)
    if (!tab) return undefined
    const existing = this.view(tabId)
    if (existing) return existing
    if (this.browser.pages.isChromePage(tab)) {
      // A chrome page is drawn by the chrome: there is nothing to load and never a view.
      tab.discarded = false
      return undefined
    }
    if (opts.background) {
      return this.browser.governor.requestLoad(tabId, win?.id) ? this.view(tabId) : undefined
    }
    this.browser.governor.makeRoomFor(tabId)
    return this.load(tabId, win)
  }

  /** Create the page in `win` and start loading it, unconditionally. */
  load(tabId: string, win?: ZenWindow): TabView | undefined {
    const tab = this.tab(tabId)
    if (!tab) return undefined
    const existing = this.view(tabId)
    if (existing) return existing
    if (this.browser.pages.isChromePage(tab)) {
      tab.discarded = false
      return undefined
    }
    const view = this.createView(tab, win ?? this.windowFor(tabId))
    this.browser.governor.trackLoad(tabId)
    // Woken from the sleep `discard` put it into (omnibox-40, Chrome's Memory Saver chip): the
    // number the discard recorded goes to the pill's leaf with the time of the wake. Only a
    // discard of this session leaves a number here (`createTabRecord` restores none), so a tab
    // restored asleep from disk wakes without a leaf – its saving was another session's.
    if (tab.sleepSavedMb) tab.memorySaver = { savedMb: tab.sleepSavedMb, wokeAt: Date.now() }
    tab.discarded = false
    delete tab.sleepSavedMb
    tab.frozen = false
    tab.cpuThrottle = 1
    let url = tab.url
    if (url.startsWith(ERROR_URL_PREFIX)) {
      try {
        url = new URL(url).searchParams.get('url') ?? BLANK_URL
      } catch {
        url = BLANK_URL
      }
      tab.url = url
    }
    const snapshot =
      this.pendingNavigation.get(tabId) ?? this.browser.state.tabNavigation.get(tabId)
    if (snapshot && snapshot.entries.length > 0) {
      // A reopened, restored or unloaded tab: give it its back/forward stack (and, through the
      // entries' page state, its scroll position) back instead of a bare load.
      this.pendingNavigation.delete(tabId)
      const index = Math.min(Math.max(snapshot.index, 0), snapshot.entries.length - 1)
      if (url === '' || url === BLANK_URL || url === snapshot.entries[index].url) {
        this.pendingTransition.set(tabId, 'restored')
        // The host's own serialisation of the stack rides along: the list is the one it describes.
        // After a relaunch it is not in memory but in the tab's `navigation/` document, which
        // hands it over for this very list only.
        const whole: NavigationSnapshot = { entries: snapshot.entries, index }
        const hostState =
          snapshot.hostState ?? this.browser.state.navigationState.hostStateFor(tabId, whole)
        if (hostState !== undefined) whole.hostState = hostState
        void view.restoreNavigation(whole)
      } else {
        // Asked to go somewhere else meanwhile (typed into the pill while unloaded): the new
        // page goes on top of the stack and the forward entries go, as in Chrome (the host's
        // serialisation described the old list and stays behind).
        void view.restoreNavigation({
          entries: [...snapshot.entries.slice(0, index + 1), { url, title: tab.title }],
          index: index + 1
        })
      }
      return view
    }
    view.loadURL(url || BLANK_URL)
    return view
  }

  /** Replay `snapshot` the next time the tab's page is created (reopened tabs and windows). */
  setPendingNavigation(tabId: string, snapshot: NavigationSnapshot): void {
    this.pendingNavigation.set(tabId, snapshot)
  }

  /** The tab's back/forward stack (URLs and titles) with the current entry marked. */
  navigationEntries(tabId: string): NavigationSnapshot {
    const view = this.view(tabId)
    if (view) return view.navigationEntries()
    const pending = this.pendingNavigation.get(tabId) ?? this.browser.state.tabNavigation.get(tabId)
    if (pending) return pending
    const tab = this.tab(tabId)
    return tab
      ? { entries: [{ url: tab.url, title: tab.title }], index: 0 }
      : { entries: [], index: -1 }
  }

  /**
   * Record the tab's back/forward stack in the profile (`BrowserState.tabNavigation`), so the
   * tab comes back with it – and with each entry's page state, its scroll position – after an
   * unload, a relaunch or a crash. Private tabs leave nothing behind.
   */
  rememberNavigation(tabId: string, view: TabView | undefined = this.view(tabId)): void {
    const tab = this.tab(tabId)
    if (!tab || !view || view.isDestroyed() || this.isPrivate(tab)) return
    // A host without a stack to report (a page still blank) leaves the record alone.
    const snapshot: NavigationSnapshot | null = view.navigationEntries() ?? null
    if (!snapshot || snapshot.entries.length === 0) return
    this.browser.state.tabNavigation.set(tabId, snapshot)
    // The stack's host-state blob has a document of its own; it is brought up to date on a timer.
    this.browser.state.navigationState.touch(tabId)
  }

  /** The stacks of every loaded page, read once more before the pages go (a graceful quit). */
  rememberAllNavigation(): void {
    for (const [tabId, view] of this.views) this.rememberNavigation(tabId, view)
  }

  /** Jump to an entry of the back/forward stack (the long-press list on the back button). */
  goToIndex(tabId: string, index: number): void {
    const view = this.view(tabId)
    if (!view) {
      const tab = this.tab(tabId)
      if (!tab) return
      const pending = this.pendingNavigation.get(tabId)
      if (pending && index >= 0 && index < pending.entries.length) {
        this.pendingNavigation.set(tabId, { ...pending, index })
        tab.url = pending.entries[index].url
      }
      this.ensureLoaded(tabId)
      return
    }
    this.thawForNavigation(tabId)
    view.goToIndex(index)
  }

  loadedCount(): number {
    let n = 0
    for (const view of this.views.values()) if (!view.isDestroyed()) n += 1
    return n
  }

  /**
   * Re-assert a view's visibility. Freezing a page marks it hidden; after thawing a page that is
   * on screen, Chromium only resumes painting once it is told the page is shown.
   */
  refreshVisibility(tabId: string): void {
    const view = this.view(tabId)
    if (!view || !view.isVisible()) return
    view.setVisible(false)
    view.setVisible(true)
  }

  /**
   * Move a tab's live page into `win` (Zen: the focused window shows the page, the others a
   * dimmed preview). Returns true when the owner changed.
   */
  claim(tabId: string, win: ZenWindow): boolean {
    const view = this.view(tabId)
    if (!view) return false
    const owner = this.owners.get(tabId)
    if (owner === win) return false
    if (owner) view.detach()
    this.owners.set(tabId, win)
    // Hidden until the window's layout positions it, so it never flashes at stale bounds.
    view.setVisible(false)
    view.attachTo(win.host)
    // Another window may mean another `display-mode` (an app window's page moving to a browser window).
    view.postToPage?.({ type: 'display-mode', mode: this.browser.displayModeFor(tabId) })
    win.relayout()
    return true
  }

  /** Make sure every tab visible in `win` is loaded and its page attached to `win`. */
  claimVisible(win: ZenWindow): void {
    let moved = false
    for (const id of this.visibleTabIds(win)) {
      this.ensureLoaded(id, win)
      if (this.claim(id, win)) moved = true
    }
    if (win.glance) {
      this.ensureLoaded(win.glance.tabId, win)
      if (this.claim(win.glance.tabId, win)) moved = true
    }
    if (this.releaseHidden(win)) moved = true
    this.browser.governor.wakeVisible(win)
    if (moved) this.browser.state.commitVolatile()
  }

  /**
   * Pages `win` owns but no longer shows go to a window that does show them, so a preview only
   * ever appears while two windows display the same tab at the same time.
   */
  private releaseHidden(win: ZenWindow): boolean {
    const visible = new Set(this.visibleTabIds(win))
    if (win.glance) visible.add(win.glance.tabId)
    let moved = false
    for (const [tabId] of this.viewsOwnedBy(win)) {
      if (visible.has(tabId)) continue
      const other = this.windowsShowing(tabId).find((w) => w !== win)
      if (other && this.claim(tabId, other)) moved = true
    }
    return moved
  }

  private createView(tab: Tab, win: ZenWindow): TabView {
    const view = this.browser.platform.views.createView(tab, this.eventsFor(tab.id), win.host)
    view.setBackgroundColor(this.backgroundFor(tab.url))
    view.setVisible(false)
    this.views.set(tab.id, view)
    this.owners.set(tab.id, win)
    if (this.siteMuted(tab.url)) tab.muted = true
    if (tab.muted) view.setMuted(true)
    this.browser.pageControls.onViewCreated(tab, view)
    this.browser.governor.onViewCreated(tab.id, view)
    win.relayout()
    return view
  }

  private backgroundFor(url: string): string {
    return url.startsWith('zen://') ? '#00000000' : '#ffffff'
  }

  private eventsFor(tabId: string): TabViewEvents {
    const state = this.browser.state
    const update = (fn: (tab: Tab) => void, volatile = false): void => {
      const tab = this.tab(tabId)
      if (!tab) return
      fn(tab)
      if (volatile) state.commitVolatile()
      else state.commit()
    }
    const view = (): TabView | undefined => this.view(tabId)
    const ownerWindow = (): ZenWindow => this.windowFor(tabId)

    return {
      // The throbber's two phases (tabs-41, Chrome's): "waiting" from the start of a load until
      // its document commits (the server's first response), "loading" from there to the stop.
      onStartLoading: () =>
        update((t) => {
          t.loading = true
          t.waiting = true
          t.progress = 0
        }, true),
      onStartNavigation: (url, sameDocument) => {
        // A navigation bound elsewhere than the redirect chain's latest target is a new one:
        // the hops kept so far belonged to a load that never committed.
        if (!sameDocument && this.pendingRedirects.get(tabId)?.to !== url)
          this.pendingRedirects.delete(tabId)
        update((t) => {
          if (sameDocument) {
            // A pushState / hash change is no load to the row, although Chromium toggles the
            // frame's loading state around it: no throbber (Chrome's rule).
            t.loading = false
            t.waiting = false
          } else {
            // A further navigation inside a load (a redirecting script, a second click) waits for
            // its own response again.
            t.loading = true
            t.waiting = true
          }
        }, true)
      },
      onRedirected: (fromUrl, toUrl) => {
        const pending = this.pendingRedirects.get(tabId)
        const hops = pending?.to === fromUrl ? pending.hops : []
        if (hops[hops.length - 1] !== fromUrl) hops.push(fromUrl)
        this.pendingRedirects.set(tabId, { hops, to: toUrl })
      },
      onStopLoading: () => {
        this.browser.governor.onLoadFinished(tabId)
        let finished = false
        update((t) => {
          const v = view()
          finished = t.loading
          t.loading = false
          t.waiting = false
          t.progress = 1
          t.canGoBack = v?.canGoBack() ?? false
          t.canGoForward = v?.canGoForward() ?? false
        })
        // A load the model saw start has finished: the window hears it as a fact of its own once
        // the broadcast with `loading` off has gone out (A11Y-02's "<name> loaded" on the phone).
        // A start and its stop in one tick coalesce into one broadcast that never shows
        // `loading` on, so the finish cannot be read off the snapshots; a stop that ends no load
        // (a same-document navigation's toggle) says nothing.
        if (finished) {
          state.afterBroadcast(() => this.browser.emit('tab.loaded', { tabId }, ownerWindow()))
        }
      },
      onProgress: (progress) =>
        update((t) => {
          t.progress = loadProgressAfter(t, progress)
        }, true),
      onNavigated: (url, inPage) => {
        if (!inPage) this.browser.blocking.onNavigated(tabId)
        const v = view()
        this.browser.popups.onNavigated(tabId, inPage)
        // A new document supersedes whatever challenge the previous request was waiting on,
        // and whatever permission question the previous page asked.
        if (!inPage) {
          // The document committed: the first byte is in, the throbber turns to its loading
          // phase (tabs-41). A renderer that commits a document answers: a hang's mark goes,
          // and so does a pending word that the user ended it – the kill never came.
          this.hungExits.delete(tabId)
          update((t) => {
            t.waiting = false
            if (t.unresponsive) delete t.unresponsive
          }, true)
          this.browser.security.cancelForTab(tabId)
          this.browser.permissionPrompts.cancelForTab(tabId)
          this.browser.devices.cancelForTab(tabId)
          this.browser.permissions.onTabNavigated(tabId, url)
          // Whatever the PDF viewer reported was about the document before this one.
          this.browser.pdf.onNavigated(tabId)
          // The old document's frames took their camera and PiP with them (their own
          // all-clear may not have crossed before the renderer went).
          this.clearCaptureState(tabId)
        }
        if (v) this.onNavigated(tabId, v, url, inPage)
      },
      onWillNavigate: (url) => this.onWillNavigate(tabId, url),
      onTitleUpdated: (title) =>
        update((t) => {
          // The sad tab keeps the crashed page's title beside its favicon, as Chrome's does.
          if (this.isSadTab(t)) return
          const next = title || this.titleFor(t.url)
          // A pinned tab's page changing its title while nobody is looking at it – a mail
          // count, a new message – asks for attention (tabs-11, Chrome's dot on a pinned tab):
          // the row's favicon wears the dot until the tab is activated. A pinned row shows no
          // title, so the change would otherwise pass unseen; a regular row's title is its own
          // telling.
          if ((t.pinned || t.essential) && next !== t.title && !this.allVisibleTabIds().has(tabId))
            t.attention = true
          t.title = next
          if (!this.isPrivate(t)) this.browser.history.updateTitle(t.url, t.title)
        }),
      onFaviconUpdated: (favicons) =>
        update((t) => {
          const icon = pickFavicon(favicons)
          if (!icon) return
          const inline = icon.startsWith('data:')
          // An `http(s)` icon is the records' key: the tab, history and the bookmarks take the
          // address now and the cache fetches its bytes behind it (`FaviconService.receive`).
          // An inline `data:` icon (the Android WebView's decoded PNG) is the bytes themselves:
          // the tab shows it at once, and the records take the cache's content address once
          // the icon is kept, never the kilobytes of the data URL.
          t.favicon = icon
          if (this.isPrivate(t)) return
          const pageUrl = t.url
          if (!inline) {
            this.browser.history.updateFavicon(pageUrl, icon)
            this.browser.bookmarks.updateFavicon(pageUrl, icon)
          }
          const v = view()
          const fetcher: FaviconFetcher | null = v?.fetchFavicon
            ? (url, maxBytes) => v.fetchFavicon!(url, maxBytes)
            : null
          void this.browser.favicons.receive(icon, fetcher).then((cached) => {
            if (!cached || !inline) return
            this.browser.history.updateFavicon(pageUrl, cached)
            this.browser.bookmarks.updateFavicon(pageUrl, cached)
            update((tab) => {
              if (tab.favicon === icon) tab.favicon = cached
            })
          })
        }),
      onFailLoad: (code, description, url, details) => {
        const v = view()
        if (code === -3 || !v) return
        // The navigation ended without a commit: its redirect hops go with it.
        this.pendingRedirects.delete(tabId)
        // A link to a download the server refused: the downloads host made the failed row Chrome
        // shows for it ("Failed · No file") and stopped the navigation, which then ends with the
        // `ERR_ABORTED` above like a download that did start; a host whose stop came too late
        // reports the refusal itself, and the tab stays as it was either way.
        if (this.browser.downloads.takeDeadLink(tabId, url)) return
        this.browser.governor.onLoadFinished(tabId)
        const failed = (certificateError: CertificateError | null = null): void =>
          update((t) => {
            t.errorCode = code
            t.certificateError = certificateError
            t.loading = false
            t.waiting = false
            t.progress = 1
          })
        // The host's request engine refused the navigation on Safe Browsing's word.
        const unsafe = this.browser.protection.safeBrowsing.takePendingBlock(tabId, url)
        if (unsafe) {
          this.httpsUpgraded.delete(tabId)
          failed()
          v.loadURL(safeBrowsingPageUrl(url, unsafe.threat, this.errorPageAccent(tabId)))
          return
        }
        // The host's request engine held the navigation on the lookalike verdict (PS-18): the
        // question page, before anything of the address was fetched.
        const lookalike = this.browser.protection.takePendingLookalike(tabId, url)
        if (lookalike) {
          this.httpsUpgraded.delete(tabId)
          failed()
          v.loadURL(this.browser.protection.lookalikePage(tabId, url, lookalike))
          return
        }
        const plaintext = this.httpsUpgraded.get(tabId)
        if (plaintext && url.startsWith('https://') && HTTP_FALLBACK_CODES.has(code)) {
          this.httpsUpgraded.delete(tabId)
          const { protection } = this.browser
          if (protection.httpsOnly !== 'off' && !protection.allowsPlaintext(plaintext)) {
            // HTTPS-only mode asks before loading the page over plaintext.
            failed()
            v.loadURL(httpsOnlyPageUrl(plaintext, code, this.errorPageAccent(tabId)))
            return
          }
          v.loadURL(plaintext)
          return
        }
        this.httpsUpgraded.delete(tabId)
        // A certificate that failed verification on an https address: the page is the
        // interstitial, with the refused certificate and the offer to proceed past it.
        const certificateError: CertificateError | null =
          isCertificateError(code) && certificateSiteOf(url)
            ? { code, url, certificate: details?.certificate ?? null, bypassed: false }
            : null
        failed(certificateError)
        // An error page that stands for being offline reloads itself when the device is back.
        this.browser.connectivity.noteFailure(tabId, code)
        const page = errorPageUrl(
          code,
          description || describeNetError(code, ''),
          url,
          certificateError?.certificate,
          this.errorPageAccent(tabId)
        )
        if (certificateError && v.showErrorPage) this.showInterstitial(tabId, v, url, page)
        else v.loadURL(page)
      },
      onUpgraded: (from, to) => this.noteUpgrade(tabId, from, to),
      onUnsafeNavigation: (url, hit) =>
        this.browser.protection.safeBrowsing.notePendingBlock(tabId, url, hit),
      onLookalikeNavigation: (url, verdict) =>
        this.browser.protection.notePendingLookalike(tabId, url, verdict),
      // The page stopped answering (tabs-45, Chrome's "Page unresponsive"): the row is marked
      // and the chrome asks whether to wait or exit the page; the mark goes when the page answers
      // again, when the user waits (`waitUnresponsive` – the next report asks again), when a
      // navigation commits, or with the renderer. The session's own, never written to disk.
      onUnresponsive: () =>
        update((t) => {
          t.unresponsive = true
        }, true),
      onResponsive: () =>
        update((t) => {
          if (t.unresponsive) delete t.unresponsive
        }, true),
      onCrashed: (reason, exitCode, details) => {
        if (reason === 'clean-exit') return
        const tab = this.tab(tabId)
        if (!tab) return
        // The renderer took every frame's capture with it.
        this.clearCaptureState(tabId)
        // The user ended the renderer from the "Page unresponsive" prompt (`exitUnresponsive`):
        // the host reports the kill as `killed` or `crashed`, and the crash page's words are
        // those for a page ended for not responding (ERR-15's `hung`). The prompt's mark goes
        // with the renderer.
        const hungExit = this.hungExits.delete(tabId)
        if (tab.unresponsive) delete tab.unresponsive
        const title = tab.customTitle ?? tab.title
        const outOfMemory = reason === 'oom' || reason === 'memory-eviction'
        // The OS took the memory back from a page in front of the user (Android's
        // `!didCrash()` with the renderer at importance): not the page's own heap running out,
        // so the sad tab says so and offers the page again rather than unloading it.
        const memoryKill = reason === 'oom-kill'
        // The user ended the renderer from the task manager (End process): the same unload for a
        // page out of sight, but the toast says what they did, not that the page crashed.
        const ended = reason === 'ended'
        const visible = this.allVisibleTabIds().has(tabId)
        // A V8 heap-cap OOM is reported as `oom` on Windows / Android but as a plain `crashed` on
        // Linux. Either way a page nobody is looking at is better unloaded than replaced by an
        // error page in a fresh renderer: keep the tab, drop the page, reload on activation.
        if (outOfMemory || !visible) {
          const memory = outOfMemory || memoryKill
          const why = memory
            ? 'the page ran out of memory'
            : ended
              ? 'the user ended the page’s process'
              : hungExit
                ? 'the page was ended for not responding'
                : `the page crashed (${reason})`
          this.browser.governor.record('discard', tabId, why, title)
          this.discard(tabId)
          // A page the user ended from the unresponsive prompt needs no word of it: the prompt was
          // the word. One ended from the task manager says what they did, not that it crashed.
          if (!hungExit)
            this.browser.toast(
              memory
                ? `"${title}" ran out of memory and was unloaded.`
                : ended
                  ? `"${title}" was ended and unloaded.`
                  : `"${title}" crashed and was unloaded.`,
              ended ? 'info' : 'error',
              ownerWindow()
            )
          return
        }
        // A crash in front of the user is the sad tab (tabs-44): the crash page, for the page
        // the tab was showing, says what happened (no toast doubles it), and `errorCode` marks
        // the row – the crashed favicon – until the next navigation clears it. The address stays
        // the page's own: the error page shows the URL it stands in for. The page's words follow
        // the way the renderer went (ERR-15): a crash, the OS freeing memory, a page the user
        // ended for not responding; a second time within the minute suggests closing other tabs.
        const target = this.errorPageTarget(tabId) ?? tab.url
        const code = crashCodeName(reason, exitCode, this.browser.platform.info.os)
        const variant: CrashPageVariant = memoryKill
          ? 'memory'
          : reason === 'hung' || hungExit
            ? 'hung'
            : 'crash'
        update((t) => {
          t.errorCode = CRASH_ERROR_CODE
          t.certificateError = null
          t.loading = false
          t.waiting = false
          t.progress = 1
        })
        const crashed = view()
        if (!crashed) return
        this.crashPagePending.add(tabId)
        crashed.loadURL(
          crashPageUrl(code, target, {
            variant,
            repeat: details?.repeat === true,
            accent: this.errorPageAccent(tabId)
          })
        )
      },
      onAudioStateChanged: (audible) => {
        update((t) => (t.audible = audible), true)
        this.browser.updateMedia()
      },
      onMediaStateChanged: (playing) => {
        this.browser.governor.onMedia(tabId, playing)
        this.browser.updateMedia()
      },
      onRequestsBlocked: (count) => this.browser.blocking.recordBlocked(tabId, count),
      onEnterHtmlFullscreen: () => {
        const win = ownerWindow()
        // Zen: going fullscreen inside a Glance page expands it into a real tab first.
        if (win.glance?.tabId === tabId) this.expandGlance(win)
        win.htmlFullscreenTabId = tabId
        state.commitVolatile()
        win.relayout()
        this.browser.fullscreen.onHtmlFullscreen(tabId, true)
        this.browser.pushDisplayMode(win)
      },
      onLeaveHtmlFullscreen: () => this.leaveHtmlFullscreen(tabId),
      // The toolbox is up: the tab notes where it stands (`Tab.devtools`, §9.29) – the dock the
      // host opened it at, or the setting's where the host cannot say – so the frame's radius
      // and the page's cover follow the toolbox in the tab in front, not the one setting.
      onDevtoolsOpened: (dock) => {
        state.devtoolsOpenFor.add(tabId)
        const tab = this.tab(tabId)
        if (tab) tab.devtools = { dock: dock ?? state.settings.devtoolsDock }
        state.commitVolatile()
      },
      onDevtoolsClosed: () => {
        state.devtoolsOpenFor.delete(tabId)
        const tab = this.tab(tabId)
        if (tab) tab.devtools = null
        state.commitVolatile()
      },
      // The toolbox's own dock buttons (and the read-back of a move the menu asked for): this
      // tab's toolbox has moved, and the choice is remembered like the menu's (§9.29), for the
      // next opening; the other open toolboxes stand where they are, as Chrome's do.
      onDevtoolsDockChanged: (dock) => {
        const tab = this.tab(tabId)
        if (tab && state.devtoolsOpenFor.has(tabId)) {
          tab.devtools = { dock }
          state.commitVolatile()
        }
        this.setDevtoolsDock(dock, ownerWindow(), { move: false })
      },
      onFoundInPage: (result) => {
        if (!result.finalUpdate) return
        const win = ownerWindow()
        win.findResult = {
          tabId,
          activeMatchOrdinal: result.activeMatchOrdinal,
          matches: result.matches
        }
        state.commitVolatile()
      },
      onZoomChanged: (direction) => this.adjustZoom(tabId, direction === 'in' ? 1 : -1),
      onContextMenu: (params) =>
        this.browser.menus.showPageContextMenu(tabId, params, ownerWindow()),
      onKey: (input) => this.browser.keys.handle(input, tabId, ownerWindow()),
      onFocused: () => {
        // A routed link's load grabbing the keyboard for the right pane is not the user moving
        // there: the keyboard goes back to the left pane and nothing is activated (split-13).
        if (this.handKeyboardBack(tabId)) return
        this.activatePaneOf(tabId)
        this.browser.emit('focus.page', { tabId }, ownerWindow())
      },
      onTargetUrl: (url) => this.browser.emit('status', { text: url }, ownerWindow()),
      onDomReady: () => {
        this.splitLinkLoads.delete(tabId)
        this.sendPageFlags(tabId)
        this.browser.onPageReady(tabId)
      },
      onDestroyed: () => this.onViewGone(tabId),
      onUserActivation: () => {
        // The user's own press or key in the pane: theirs to activate, mid-load or not.
        this.splitLinkLoads.delete(tabId)
        this.activatePaneOf(tabId)
        this.browser.popups.activate(tabId)
      },
      onOpenWindow: (url, disposition, userGesture, features = '') => {
        const plan = planWindowOpen(url, disposition, features)
        if (plan.action === 'deny') return null
        const parent = this.tab(tabId)
        // No gesture, no window: the URL bar lists what was blocked.
        if (this.browser.popups.decide(tabId, parent?.url ?? '', url, userGesture) === 'blocked')
          return null
        const owner = ownerWindow()
        // Sized window.open → toolbar-only chrome at that size; Shift+click / unsized
        // new-window → a full Zenium window; everything else a tab next to the opener.
        const opensWindow = plan.action === 'window' && this.browser.state.capabilities.windows
        // An app window holds the app's one page: a tab it opens goes to the browser window
        // behind it (Chrome opens an installed app's `target=_blank` links in the browser).
        const fromApp = owner.chrome === 'app'
        return {
          action: opensWindow ? 'window' : 'tab',
          url,
          adopt: (view) => {
            const win = opensWindow
              ? this.browser.createWindow({
                  kind: openedWindowKind(owner.kind, plan.chrome),
                  from: owner,
                  chrome: plan.chrome,
                  bounds: plan.bounds,
                  empty: true
                })
              : fromApp
                ? this.browser.browserWindowFor(owner)
                : owner
            const adopted = this.adoptView(
              view,
              {
                tabId: newId('tab'),
                // The opener's tab is not in the browser window: no opener to sit next to.
                parentTabId: fromApp && !opensWindow ? null : tabId,
                active: opensWindow || fromApp || plan.active
              },
              win
            )
            if (fromApp && !opensWindow) {
              win.host.show()
              win.host.focus()
            }
            return adopted
          }
        }
      },
      onPageMessage: (message) => this.browser.handlePageMessage(tabId, message),
      onDialog: (request) => this.browser.pageDialogs.ask(tabId, request),
      onLeaveSite: async (reload) => {
        const leave = await this.browser.pageDialogs.confirmLeave(tabId, reload)
        if (!leave) this.stayedOnPage(tabId)
        return leave
      },
      onNewTabAction: (action) => this.browser.newTab.handleAction(tabId, action)
    }
  }

  /**
   * The user chose to stay on a page that objected to leaving. `navigate` writes the destination
   * into the tab as soon as it is asked for (the pill shows where the tab is going, as Chrome's
   * omnibox does); with the navigation refused, the tab goes back to the page that is still
   * there.
   */
  private stayedOnPage(tabId: string): void {
    const tab = this.tab(tabId)
    const view = this.view(tabId)
    if (!tab || !view || view.isDestroyed()) return
    const url = view.getURL()
    this.pendingTransition.delete(tabId)
    this.pendingRedirects.delete(tabId)
    if (!url || tab.url === url) return
    tab.url = url
    tab.title = view.getTitle() || this.titleFor(url)
    this.browser.state.commit()
  }

  isPrivate(tab: Tab): boolean {
    return tab.containerId === PRIVATE_CONTAINER_ID
  }

  /**
   * The accent an error document the tab loads inlines beside its token block (design language
   * v2 §9.11): the tab's space theme resolved for each scheme, as the chrome sets `--zen-accent`
   * on the window – or the private window's own accent, the one its new tab page takes – so the
   * page's primary (the repeat-crash Reload, an interstitial's Back to safety) is the accent the
   * window shows and not the unresolved variable.
   */
  errorPageAccent(tabId: string): ErrorPageAccent {
    const tab = this.tab(tabId)
    if (tab && this.isPrivate(tab)) return { light: PRIVATE_ACCENT, dark: PRIVATE_ACCENT }
    const theme = (tab && getSpace(this.model, tab.spaceId)?.theme) ?? null
    return {
      light: rgbToHex(resolveTheme(theme, false).accent),
      dark: rgbToHex(resolveTheme(theme, true).accent)
    }
  }

  /**
   * The title a page has until – or unless – its document reports one: `titleForUrl`'s, except
   * that a page of an installed extension is named after the extension rather than its id (v2
   * §10.1 applied to extension pages), in either form the address takes.
   */
  private titleFor(url: string): string {
    const page = extensionPageOf(url)
    if (page) {
      const name = this.browser.extensions
        .list()
        .find((e) => e.id === page.id)
        ?.name.trim()
      if (name) return name
    }
    return titleForUrl(url)
  }

  /**
   * A page is navigating itself to `url` (`TabViewEvents.onWillNavigate`). In an app window the
   * page is the app's: a navigation out of the app's scope opens in a tab of the browser window
   * behind the app instead, and the app window keeps its page (MW-23; Chrome's app windows keep
   * to their app). Returns true when the host must cancel the navigation.
   */
  onWillNavigate(tabId: string, url: string): boolean {
    const tab = this.tab(tabId)
    if (!tab) return false
    const win = this.ownerOf(tabId)
    const app = win?.app
    if (!win || !app || win.chrome !== 'app') return false
    if (isWithinScope(url, app.scope) || !/^https?:\/\//i.test(url)) return false
    const target = this.browser.browserWindowFor(win)
    this.createTab({ url, active: true }, target)
    target.host.show()
    target.host.focus()
    return true
  }

  /**
   * The redirect hops the navigation that just committed at `url` went through, taken off the
   * tab; nothing when the hops were bound elsewhere (that navigation never committed).
   */
  private takeRedirects(tabId: string, url: string): string[] | undefined {
    const pending = this.pendingRedirects.get(tabId)
    if (!pending) return undefined
    this.pendingRedirects.delete(tabId)
    return pending.to === url && pending.hops.length > 0 ? pending.hops : undefined
  }

  private onNavigated(tabId: string, view: TabView, url: string, inPage = false): void {
    const tab = this.tab(tabId)
    if (!tab) return
    // The crash page committing is the crash mark, whatever committed between the renderer's
    // end and it (a restored entry's load that got there first cleared the mark: the sad tab
    // – the crashed favicon, Show tabs – reads from the mark, so it is set again here). A
    // commit that lands while the crash page is still on its way leaves the mark alone.
    const crashPagePending = this.crashPagePending.delete(tabId)
    if (isCrashPageUrl(url)) {
      tab.errorCode = CRASH_ERROR_CODE
    } else if (!url.startsWith(ERROR_URL_PREFIX)) {
      if (!crashPagePending) tab.errorCode = null
      this.httpsUpgraded.delete(tabId)
    }
    tab.certificateError = this.certificateErrorOf(tab, url)
    this.followSiteMute(tab, view, tab.url, url)
    tab.url = url
    // The crash page's own title is the site; the sad tab keeps the crashed page's (Chrome's
    // strip does), so the row reads as the page it was until the next load – through a commit
    // the crash page is about to supersede as well.
    if (!this.isSadTab(tab) && !crashPagePending) tab.title = view.getTitle() || this.titleFor(url)
    tab.canGoBack = view.canGoBack()
    tab.canGoForward = view.canGoForward()
    tab.bookmarked = this.browser.bookmarks.has(url)
    this.browser.pageControls.onNavigated(tab, view)
    view.setBackgroundColor(this.backgroundFor(url))
    view.setPopupsAllowed?.(this.browser.popups.siteAllowed(url))
    const transition = this.pendingTransition.get(tabId) ?? 'link'
    this.pendingTransition.delete(tabId)
    const redirectedFrom = inPage ? undefined : this.takeRedirects(tabId, url)
    if (!this.isPrivate(tab))
      this.browser.history.visit(url, tab.title, tab.favicon, {
        transition,
        tabId,
        ...(redirectedFrom ? { redirectedFrom } : {})
      })
    for (const w of this.browser.allWindows())
      if (w.findResult?.tabId === tabId) w.findResult = null
    this.rememberNavigation(tabId, view)
    this.sendPageFlags(tabId)
    this.browser.onNavigated(tabId, inPage)
    this.browser.protection.onNavigated(tabId, url)
    this.browser.state.commit()
  }

  /**
   * The host's request engine upgraded a main-frame navigation of `tabId` from `from` (http) to
   * `to` (HTTPS-only mode): should `to` fail, the tab falls back to – or asks about – `from`.
   */
  noteUpgrade(tabId: string, from: string, to: string): void {
    if (!this.tab(tabId) || !/^http:\/\//i.test(from) || !/^https:\/\//i.test(to)) return
    this.httpsUpgraded.set(tabId, from)
  }

  /**
   * The tab shows the crash page for a page whose renderer went away in front of the user
   * (tabs-44): `errorCode` is the crash code and the address the `zen://error` document. The
   * row wears the crashed favicon and keeps the page's title until the next load clears both.
   */
  isSadTab(tab: Tab): boolean {
    return tab.errorCode === CRASH_ERROR_CODE && tab.url.startsWith(ERROR_URL_PREFIX)
  }

  /**
   * The page an error page (or interstitial) of `tabId` stands in for, or null off one. The
   * certificate interstitial a host writes into the failed entry itself (`showInterstitial`)
   * stands in for the tab's own address.
   */
  errorPageTarget(tabId: string): string | null {
    const tab = this.tab(tabId)
    if (!tab) return null
    if (this.showingCertificateInterstitial(tab) && !tab.url.startsWith(ERROR_URL_PREFIX))
      return tab.url
    if (!tab.url.startsWith(ERROR_URL_PREFIX)) return null
    return safeParam(tab.url, 'url')
  }

  /**
   * The URLs history may hold for the page an error page of `tabId` stands in for: the page
   * itself and, under HTTPS-only mode's question, the upgrade whose failure raised it. The
   * engine's upgrade is a scheme swap (see `upgradeScheme`), so the entry the failed load left
   * behind is the `https://` twin of the `http://` page the user asked for.
   */
  private errorPageTargets(tabId: string): ReadonlySet<string> {
    const failed = this.errorPageTarget(tabId)
    if (failed === null) return new Set()
    const targets = new Set([failed])
    const tab = this.tab(tabId)
    if (tab && interstitialKindOf(tab.url) === 'https-only' && /^http:\/\//i.test(failed)) {
      targets.add(`https://${failed.slice(7)}`)
    }
    return targets
  }

  /**
   * "Back to safety": leave an error page for the last entry of the tab's history that is not
   * the failed page itself (nor another error page), or for a blank tab when there is none. A
   * host whose snapshot is the current entry alone (Android) goes back one step when it can:
   * the refused navigation never committed there, so the step lands on the page before it.
   */
  leaveErrorPage(tabId: string): void {
    const view = this.view(tabId)
    if (!view) return
    const failed = this.errorPageTargets(tabId)
    const { entries, index } = view.navigationEntries()
    for (let i = index - 1; i >= 0; i--) {
      const url = entries[i]?.url
      if (!url || failed.has(url) || url.startsWith(ERROR_URL_PREFIX)) continue
      this.thawForNavigation(tabId)
      view.goToIndex(i)
      return
    }
    if (entries.length <= 1 && view.canGoBack()) {
      this.thawForNavigation(tabId)
      view.goBack()
      return
    }
    this.navigate(tabId, BLANK_URL)
  }

  /**
   * The certificate error of the document that just committed. A `zen://error` page carries the
   * failure in its URL, so an interstitial reached again through history is actionable again. An
   * https page of a site the session has an exception for was loaded over the excepted
   * certificate (the host asks the core on every handshake, and that was the answer): it shows,
   * `bypassed`, and reports as not secure, as in Chrome. Null for every other document.
   */
  private certificateErrorOf(tab: Tab, url: string): CertificateError | null {
    if (url.startsWith(ERROR_URL_PREFIX)) {
      const params = new URL(url).searchParams
      const code = Number(params.get('code') ?? 0)
      const target = params.get('url') ?? ''
      if (!isCertificateError(code) || !certificateSiteOf(target)) return null
      return { code, url: target, certificate: errorPageCertificate(params), bypassed: false }
    }
    const exception = this.browser.security.certificateExceptions.exceptionFor(tab.containerId, url)
    return exception
      ? { code: exception.code, url, certificate: exception.certificate, bypassed: true }
      : null
  }

  /** The tab shows the certificate interstitial (not yet proceeded past). */
  private showingCertificateInterstitial(tab: Tab): boolean {
    return !!tab.certificateError && !tab.certificateError.bypassed
  }

  /**
   * The certificate interstitial in place of the document the failed load left behind (hosts with
   * `showErrorPage`). Like Chrome's, it lives in the failed entry: the tab's address is the failed
   * one, back leads to the page before it, and nothing of it reaches history.
   */
  private showInterstitial(tabId: string, view: TabView, url: string, page: string): void {
    const tab = this.tab(tabId)
    if (!tab || !view.showErrorPage) return
    tab.url = url
    tab.title = titleForUrl(url)
    tab.canGoBack = view.canGoBack()
    tab.canGoForward = view.canGoForward()
    tab.bookmarked = this.browser.bookmarks.has(url)
    this.pendingTransition.delete(tabId)
    this.pendingRedirects.delete(tabId)
    for (const w of this.browser.allWindows())
      if (w.findResult?.tabId === tabId) w.findResult = null
    view.setBackgroundColor(this.backgroundFor(page))
    view.showErrorPage(page)
    this.browser.state.commit()
  }

  /**
   * Whether a request of the tab may go ahead over a certificate that failed verification: only
   * when the user proceeded past the interstitial for the site and this certificate earlier in
   * the session (`CertificateExceptions`). Pages that are not tabs never may.
   */
  certificateAllowed(tabId: string, url: string, fingerprint: string): boolean {
    const tab = this.tab(tabId)
    return (
      !!tab &&
      this.browser.security.certificateExceptions.isAllowed(tab.containerId, url, fingerprint)
    )
  }

  /**
   * A button of the certificate interstitial was pressed (the page script relays it): true when
   * the tab is showing that interstitial for `url` and the press was acted on, false for the
   * other warning pages (the protection service's). Proceed remembers the certificate for the
   * session – per site and certificate, until the browser quits or the private session ends, as
   * Chrome does – and asks for the address again; Back to safety leaves the page (`leaveErrorPage`).
   */
  handleCertificateInterstitial(tabId: string, action: InterstitialAction, url: string): boolean {
    const tab = this.tab(tabId)
    const view = this.view(tabId)
    const error = tab?.certificateError
    if (!tab || !view || !error || error.bypassed || error.url !== url) return false
    if (action === 'back') {
      this.leaveErrorPage(tabId)
      return true
    }
    if (action !== 'proceed') return true
    const certificate = error.certificate
    if (!certificate?.fingerprint) return true
    const exceptions = this.browser.security.certificateExceptions
    if (!exceptions.allow(tab.containerId, error.url, error.code, certificate)) return true
    // Engines that decide on their own side hear of the exception before the address is asked for.
    const mirrored =
      this.browser.platform.sessions.allowCertificate?.(
        tab.containerId,
        error.url,
        certificate.fingerprint
      ) ?? Promise.resolve()
    void mirrored
      .catch(() => undefined)
      .then(() => {
        if (this.view(tabId) === view && !view.isDestroyed())
          this.navigate(tabId, error.url, { transition: 'reload' })
      })
    return true
  }

  sendPageFlags(tabId: string): void {
    const tab = this.tab(tabId)
    const view = this.view(tabId)
    if (!tab || !view) return
    const owner = this.owners.get(tabId)
    const linksToSplitPane = this.linksToSplitPane(tab)
    const flags: PageFlags = {
      glanceEnabled: this.settings.glanceEnabled && !owner?.glance,
      glanceTrigger: this.settings.glanceTrigger,
      thirdParty: tab.pinned || tab.essential ? this.settings.thirdPartyOnPinned : null,
      linksToSplitPane
    }
    this.splitLinkFlags.set(tabId, linksToSplitPane)
    view.sendPageFlags(flags)
  }

  broadcastPageFlags(): void {
    for (const id of this.views.keys()) this.sendPageFlags(id)
  }

  /**
   * Whether links clicked in `tab`'s page go to the pane to its right (split-13): the tab's split
   * carries the rule (`SplitGroup.linksToRight`, this split's own – v2 §9.35) and the tab is the
   * first pane of a side-by-side split – vertical, or the grid, whose second pane is the top
   * right; a stacked split has no left and right.
   */
  linksToSplitPane(tab: Tab): boolean {
    if (!tab.splitGroupId) return false
    const group = this.model.splitGroups[tab.splitGroupId]
    return Boolean(
      group &&
      splitLinksToRight(group) &&
      group.layout !== 'horizontal' &&
      group.tabIds.length >= 2 &&
      group.tabIds[0] === tab.id
    )
  }

  /**
   * The pane header's ⋯ menu wrote this split's link rule (split-13): the one home of the switch,
   * kept with the split; the commit re-syncs the left pane's flag (`syncSplitLinkFlags`).
   */
  setSplitLinksToRight(groupId: string, on: boolean): void {
    if (setSplitLinksToRight(this.model, groupId, on)) this.browser.state.commit()
  }

  /**
   * The left pane's link rule is the split's, not the page's: a swap, a pane joining or leaving,
   * the layout turning, the split dissolving or the rule written from the pane's menu change
   * what a page's flag should say. After every commit the live pages' flags are checked against
   * the model and the ones whose answer changed are re-sent (a page whose flag holds is not
   * written to; a page that has not had its flags yet gets them at its `dom-ready`, as every
   * page does).
   */
  syncSplitLinkFlags(): void {
    for (const [id, sent] of this.splitLinkFlags) {
      const tab = this.tab(id)
      if (!tab || !this.views.has(id)) {
        this.splitLinkFlags.delete(id)
        continue
      }
      if (this.linksToSplitPane(tab) !== sent) this.sendPageFlags(id)
    }
  }

  /**
   * A link clicked in the left pane of a split with the rule on (split-13, Edge's "Open links
   * from the left pane in the right pane"): the pane to its right loads it, the left pane stays
   * where it is and stays the active pane (v2 §9.35) – the reader stays where they read, as a
   * list drives a detail pane and keeps the focus; the pill keeps the left's address and the
   * outline does not move. The right pane's load takes no focus: Chromium hands a new document
   * the keyboard as it commits (twice on the desktop host, both before `dom-ready`), so the load
   * is noted here and `handKeyboardBack` returns the keyboard to the left pane on each grab
   * until the document is ready. The page prevented the click's own navigation on the flag's
   * word, so when the flag no longer holds by the time the message lands (the split dissolved,
   * the rule turned off) the link loads where it was clicked, and is never lost.
   */
  openInSplitPane(fromTabId: string, url: string): void {
    const tab = this.tab(fromTabId)
    if (!tab) return
    const group = tab.splitGroupId ? this.model.splitGroups[tab.splitGroupId] : undefined
    const target = this.linksToSplitPane(tab) && group ? group.tabIds[1] : undefined
    if (target !== undefined) this.splitLinkLoads.set(target, fromTabId)
    this.navigate(target ?? fromTabId, url, { transition: 'link' })
  }

  /**
   * `tabId`'s page took the keyboard while it loads a link routed from the pane to its left
   * (`splitLinkLoads`): the grab is the load's, not the user's, so the keyboard goes back to the
   * left pane – deferred, since a `focus()` asked for inside the grab's own event leaves the
   * keyboard where Chromium put it (measured on the desktop host: a tick later it moves) – and
   * true says the caller activates nothing. False, and the note dropped, once the two are no
   * longer panes of one split or the left pane is not the active tab any more (the user
   * activated the right pane themselves through its header): then the grab is an ordinary one.
   */
  private handKeyboardBack(tabId: string): boolean {
    const origin = this.splitLinkLoads.get(tabId)
    if (origin === undefined) return false
    const win = this.windowFor(tabId)
    if (!this.splitLinkHolds(tabId, origin, win)) {
      this.splitLinkLoads.delete(tabId)
      return false
    }
    defer(() => {
      const view = this.view(origin)
      if (view && !view.isDestroyed() && this.splitLinkHolds(tabId, origin, win)) view.focus()
    })
    return true
  }

  /** Whether `origin` (the left pane) and `tabId` are still panes of one split with `origin` the window's active tab. */
  private splitLinkHolds(tabId: string, origin: string, win: ZenWindow): boolean {
    const tab = this.tab(tabId)
    const from = this.tab(origin)
    return Boolean(
      tab &&
      from &&
      tab.splitGroupId &&
      tab.splitGroupId === from.splitGroupId &&
      this.views.has(origin) &&
      this.activeTabFor(win)?.id === origin
    )
  }

  /** The pop-up rule of `origin` changed: tell every live page of that site. */
  syncPopupPolicy(origin: string): void {
    for (const [id, view] of this.views) {
      const tab = this.tab(id)
      if (tab && safeOrigin(tab.url) === origin)
        view.setPopupsAllowed?.(this.browser.popups.siteAllowed(tab.url))
    }
  }

  /**
   * A frame's `capture-state` report (tabs-43): kept by the frame's id while something is live,
   * dropped when nothing is; the tab's `alert` is folded from all of them with Chrome's priority
   * (recording > capturing > picture-in-picture) and the row repaints when it changes. The
   * kinds behind it (`capture`: camera, microphone, display; omnibox-38) are folded from the same
   * reports for the URL pill's site-information slot, whose glyph says which.
   */
  onCaptureState(tabId: string, raw: unknown): void {
    const tab = this.tab(tabId)
    const report = sanitiseCaptureReport(raw)
    if (!tab || !report || !this.views.has(tabId)) return
    let frames = this.captureReports.get(tabId)
    if (reportIsLive(report)) {
      if (!frames) {
        frames = new Map()
        this.captureReports.set(tabId, frames)
      }
      frames.set(report.id, report)
    } else if (frames) {
      frames.delete(report.id)
      if (frames.size === 0) this.captureReports.delete(tabId)
    }
    this.refreshAlert(tabId)
  }

  /** Forget every frame's capture report of a tab (its document, renderer or page is gone). */
  private clearCaptureState(tabId: string): void {
    if (!this.captureReports.delete(tabId)) return
    this.refreshAlert(tabId)
  }

  private refreshAlert(tabId: string): void {
    const tab = this.tab(tabId)
    if (!tab) return
    const reports = [...(this.captureReports.get(tabId)?.values() ?? [])]
    const alert = tabAlertFor(reports)
    const capture = tabCaptureFor(reports)
    if ((tab.alert ?? null) === alert && sameCapture(tab.capture, capture)) return
    tab.alert = alert
    tab.capture = capture
    this.browser.state.commitVolatile()
  }

  /**
   * `tabId`'s page left HTML fullscreen – its element's exit, or the page gone while in it:
   * every window it covered lays its chrome out again and its pages hear the display mode.
   */
  private leaveHtmlFullscreen(tabId: string): void {
    for (const w of this.browser.allWindows()) {
      if (w.htmlFullscreenTabId === tabId) {
        w.htmlFullscreenTabId = null
        w.relayout()
        this.browser.pushDisplayMode(w)
      }
    }
    this.browser.state.commitVolatile()
    this.browser.fullscreen.onHtmlFullscreen(tabId, false)
  }

  destroyView(tabId: string): void {
    const view = this.views.get(tabId)
    if (!view) return
    this.views.delete(tabId)
    // The page goes with its element in fullscreen (a close from the core or the host, a
    // discard): the windows it covered come back now. The host's own leave on the tear-down, if
    // it sends one, reaches a view the core has dropped and is not heard.
    if (this.browser.allWindows().some((w) => w.htmlFullscreenTabId === tabId))
      this.leaveHtmlFullscreen(tabId)
    this.httpsUpgraded.delete(tabId)
    this.clearCaptureState(tabId)
    this.browser.connectivity.forget(tabId)
    this.browser.protection.safeBrowsing.forgetTab(tabId)
    this.browser.externalProtocols.cancelForTab(tabId)
    this.pendingTransition.delete(tabId)
    this.pendingRedirects.delete(tabId)
    this.crashPagePending.delete(tabId)
    this.browser.popups.onTabGone(tabId)
    this.browser.security.cancelForTab(tabId)
    this.browser.permissionPrompts.cancelForTab(tabId)
    this.browser.devices.cancelForTab(tabId)
    this.browser.permissions.onTabGone(tabId)
    this.browser.pageDialogs.cancelForTab(tabId)
    this.browser.autofill.onTabGone(tabId)
    this.browser.fullscreen.onTabGone(tabId)
    this.browser.screenCapture.cancelForTab(tabId)
    this.browser.shares.cancelForTab(tabId)
    this.browser.textFragments.cancelForTab(tabId)
    this.browser.geolocation.onTabGone(tabId)
    this.browser.readAloud.onTabGone(tabId)
    this.browser.webNotifications.onTabGone(tabId)
    if (this.owners.has(tabId)) view.detach()
    this.owners.delete(tabId)
    if (!view.isDestroyed()) {
      // A frozen page never processes its close message; wake it so the renderer exits cleanly.
      if (this.tab(tabId)?.frozen) void this.browser.governor.thaw(tabId, true)
      this.browser.governor.onViewDestroyed(tabId, view)
      view.destroy()
    } else {
      this.browser.governor.onViewDestroyed(tabId, view)
    }
    this.browser.state.devtoolsOpenFor.delete(tabId)
  }

  /** Unload a tab's page while keeping it in the sidebar (Zen's "pending" tabs). */
  discard(tabId: string): void {
    const tab = this.tab(tabId)
    // A chrome page tab holds no page: there is nothing to unload and it never reads as pending.
    if (!tab || this.browser.pages.isChromePage(tab)) return
    // What the page held, for the sleeping row's "memory saved" line; read while it still runs.
    const saved = this.view(tabId) ? this.browser.governor.memoryOf?.(tabId) : null
    if (saved !== null && saved !== undefined && saved > 0) tab.sleepSavedMb = Math.round(saved)
    else delete tab.sleepSavedMb
    // Asleep again: the last wake's leaf is over (`load` writes the next one).
    delete tab.memorySaver
    // The page goes, its history stays: the tab picks the stack up again when it is loaded.
    this.rememberNavigation(tabId)
    this.destroyView(tabId)
    tab.discarded = true
    tab.frozen = false
    tab.cpuThrottle = 1
    tab.loading = false
    tab.waiting = false
    // A sleeping page has no renderer to be hung (tabs-45): the prompt's mark goes with it, and
    // any pending word that the user ended it.
    if (tab.unresponsive) delete tab.unresponsive
    this.hungExits.delete(tabId)
    tab.progress = 0
    tab.audible = false
    // The toolbox went with the page (the host sends no close for a view it destroyed).
    tab.devtools = null
    tab.canGoBack = false
    tab.canGoForward = false
    this.browser.updateMedia()
    this.browser.state.commit()
  }

  /**
   * A frozen page cannot navigate; wake it before touching its history or URL. A page waiting in
   * one of its own dialogs cannot either: like Chrome, the navigation dismisses the dialog.
   */
  private thawForNavigation(tabId: string): void {
    this.browser.pageDialogs.cancelForTab(tabId)
    const tab = this.tab(tabId)
    if (!tab || !this.view(tabId) || !tab.frozen) return
    void this.browser.governor.thaw(tabId)
    tab.frozen = false
  }

  // ---------------------------------------------------------------------------
  // Creating / activating / closing
  // ---------------------------------------------------------------------------

  createTab(
    opts: {
      url?: string
      spaceId?: string
      active?: boolean
      containerId?: string
      pinned?: boolean
      essential?: boolean
      afterTabId?: string
      /**
       * The slot within the tab's section (essential, pinned or regular of its space) to take,
       * clamped to the section; it wins over `afterTabId` and the new-tab position setting.
       */
      index?: number
      folderId?: string | null
      /**
       * Whether the tab joins its `afterTabId`'s group when none is named (the default: a tab
       * opened from a member sits in the member's group). `false` keeps it out of the group –
       * Android's "Open in new tab" beside "Open in new tab in group" (TAB-15).
       */
      joinGroup?: boolean
      load?: boolean
      /** The plain host typed into the URL bar when `url` is its https:// upgrade (http fallback). */
      upgradedFrom?: string
      /** Preset id (hosts that must know the id before the tab exists, e.g. adopted popups). */
      id?: string
      /** The tab whose page opened this one (see `Tab.openerTabId`). */
      openerTabId?: string
      /**
       * Whether the opener opened this tab in the background, for its placement (tabs-30): a
       * background open joins the opener's group, a foreground one sits right after the opener.
       * Defaults to `active === false`; `adoptView` states it, activating only once the view hangs.
       */
      background?: boolean
      /** Opened by another app's intent (see `Tab.fromIntent`). */
      fromIntent?: boolean
    },
    win: ZenWindow = this.browser.focusedWindow()
  ): Tab {
    const m = this.model
    let space = (opts.spaceId ? getSpace(m, opts.spaceId) : undefined) ?? win.activeSpace()
    // Blank / private windows only ever create tabs in their own space.
    if (win.localSpace && space.id !== win.localSpace.id) space = win.localSpace
    const essential = Boolean(opts.essential) && !space.windowId
    const containerId = win.isPrivate
      ? PRIVATE_CONTAINER_ID
      : (opts.containerId ?? space.containerId ?? DEFAULT_CONTAINER_ID)
    const tab = createTabRecord({
      id: opts.id && !m.tabs[opts.id] ? opts.id : undefined,
      spaceId: essential ? null : space.id,
      containerId,
      url: opts.url ?? BLANK_URL,
      pinned: Boolean(opts.pinned) && !essential,
      essential,
      folderId: opts.folderId ?? null,
      openerTabId: opts.openerTabId && m.tabs[opts.openerTabId] ? opts.openerTabId : null,
      fromIntent: Boolean(opts.fromIntent),
      muted: this.siteMuted(opts.url ?? BLANK_URL),
      title: this.titleFor(opts.url ?? BLANK_URL)
    })
    tab.windowId = this.ownerWindowIdFor(tab, space, win)
    m.tabs[tab.id] = tab
    if (tab.essential) {
      if (m.essentialTabIds.length >= this.settings.essentialsMax) {
        tab.essential = false
        tab.pinned = true
        tab.spaceId = space.id
        insertTabIntoSpace(m, space, tab, 0)
      } else if (opts.index !== undefined) {
        const at = Math.max(0, Math.min(opts.index, m.essentialTabIds.length))
        m.essentialTabIds.splice(at, 0, tab.id)
      } else {
        m.essentialTabIds.push(tab.id)
      }
    } else {
      let index: number | undefined = opts.index
      const after = this.tab(opts.afterTabId)
      const placed = index !== undefined
      if (!placed && after && after.spaceId === space.id && after.pinned === tab.pinned) {
        // A background tab opened by `after` lands after `after`'s opener group, so consecutive
        // background opens from one page keep their order (tabs-30); a foreground open sits right
        // after its opener, as Chrome places it, and so does any other after-tab.
        const background = opts.background ?? opts.active === false
        const grouped =
          background && tab.openerTabId === after.id
            ? openerGroupIndex(m, space, tab, after.id)
            : null
        index = grouped ?? sectionIndexOf(m, after) + 1
        if (opts.joinGroup !== false) tab.folderId = tab.folderId ?? after.folderId
      } else if (!placed && this.settings.newTabPosition === 'after-current' && !tab.pinned) {
        const current = this.tab(win.selectedTabIn(space))
        if (current && current.spaceId === space.id && !current.pinned)
          index = sectionIndexOf(m, current) + 1
      }
      insertTabIntoSpace(m, space, tab, index)
    }
    // Made in a group: the group is open, and used now (TAB-16). The user's joins into a SAVED
    // group bring its pages back first (`restoreSavedFolder`: New Tab in Folder, a move or a
    // drop into it) and reach here with the group open; a tab made in one by any other path – a
    // live folder's refresh repopulating it – takes it as open, the pages it kept let go. A
    // private tab is no member of it for the regular profile: it leaves the group as it was.
    if (!this.isPrivate(tab)) folderOpened(m, tab.folderId, tab.createdAt)
    tab.bookmarked = this.browser.bookmarks.has(tab.url)
    // Opened by another tab: closing it while active returns to the opener until the user
    // switches away from it (tabs-30).
    if (tab.openerTabId) this.openerReturn.add(tab.id)
    // Set before the load below so an active tab's single activation load (or a background load)
    // is eligible for the http fallback straight away.
    if (opts.upgradedFrom) this.httpsUpgraded.set(tab.id, `http://${opts.upgradedFrom}`)
    if (opts.active !== false) {
      this.activateTab(tab.id, win)
    } else if (opts.load !== false && tab.url !== BLANK_URL) {
      this.ensureLoaded(tab.id, win, { background: true })
    }
    if (this.isPrivate(tab)) this.browser.syncPrivateSession()
    this.browser.state.commit()
    return tab
  }

  /**
   * Adopt a view the host created for a page's `window.open` as a new tab in `win` (Android
   * hands us the WebView; Electron the opener-linked page Chromium made, or a fresh one for a
   * link's new window). The caller picks the tab id up front so the view can already be
   * addressed by it. The tab sits next to its opener in the opener's space and container.
   */
  adoptView(
    view: TabView,
    opts: { tabId: string; parentTabId: string | null; active: boolean },
    win: ZenWindow = this.browser.focusedWindow()
  ): { tab: Tab; events: TabViewEvents } {
    const parent = this.tab(opts.parentTabId)
    const tab = this.createTab(
      {
        id: opts.tabId,
        url: BLANK_URL,
        spaceId: parent?.spaceId ?? undefined,
        containerId: parent?.containerId,
        active: false,
        background: !opts.active,
        afterTabId: parent && !parent.essential ? parent.id : undefined,
        load: false,
        openerTabId: parent?.id
      },
      win
    )
    view.setBackgroundColor(this.backgroundFor(tab.url))
    // Hidden until the window's layout positions it, so it never flashes at stale bounds.
    view.setVisible(false)
    view.attachTo(win.host)
    this.views.set(tab.id, view)
    this.owners.set(tab.id, win)
    this.browser.governor.onViewCreated(tab.id, view)
    this.browser.governor.trackLoad(tab.id)
    tab.discarded = false
    delete tab.sleepSavedMb
    if (opts.active) this.activateTab(tab.id, win)
    if (this.isPrivate(tab)) this.browser.syncPrivateSession()
    this.browser.state.commit()
    win.relayout()
    return { tab, events: this.eventsFor(tab.id) }
  }

  /**
   * Give a tab without a page a live view that already exists (a new tab page preloaded off
   * screen under a placeholder id). The view already hangs in `win`; from now on its host events
   * must reach the returned sink. Undefined when the tab is unknown or already has a page.
   */
  attachView(view: TabView, tabId: string, win: ZenWindow): TabViewEvents | undefined {
    const tab = this.tab(tabId)
    if (!tab || this.view(tabId) || view.isDestroyed()) return undefined
    this.browser.platform.views.retargetView?.(view, tabId)
    view.attachTo(win.host)
    view.setBackgroundColor(this.backgroundFor(tab.url))
    view.setVisible(false)
    this.views.set(tabId, view)
    this.owners.set(tabId, win)
    this.browser.governor.onViewCreated(tabId, view)
    tab.discarded = false
    tab.frozen = false
    tab.cpuThrottle = 1
    tab.loading = false
    tab.waiting = false
    tab.title = view.getTitle() || this.titleFor(tab.url)
    if (tab.muted) view.setMuted(true)
    if (tab.zoom !== 1) view.setZoom(tab.zoom)
    return this.eventsFor(tabId)
  }

  /**
   * The page went away underneath its tab – a popup called `window.close()`, or the host tore
   * the view down on its own. The dead view is dropped without being touched again and the tab
   * closes as if the user had closed it. Views the core destroys itself are already forgotten
   * by the time the host reports them, so this only ever acts on page-initiated closes – and,
   * once the host itself is going (`onHostTeardown`), on nothing: its views die with it, and the
   * tabs stay for the core that boots next.
   */
  private onViewGone(tabId: string): void {
    const view = this.views.get(tabId)
    if (!view) return
    const owner = this.owners.get(tabId)
    this.views.delete(tabId)
    this.owners.delete(tabId)
    this.httpsUpgraded.delete(tabId)
    this.pendingTransition.delete(tabId)
    this.splitLinkFlags.delete(tabId)
    this.splitLinkLoads.delete(tabId)
    this.pendingRedirects.delete(tabId)
    this.crashPagePending.delete(tabId)
    this.browser.externalProtocols.cancelForTab(tabId)
    this.browser.popups.onTabGone(tabId)
    this.browser.security.cancelForTab(tabId)
    this.browser.devices.cancelForTab(tabId)
    this.browser.pageDialogs.cancelForTab(tabId)
    this.browser.webNotifications.onTabGone(tabId)
    this.browser.governor.onViewDestroyed(tabId, view)
    this.browser.state.devtoolsOpenFor.delete(tabId)
    if (this.hostGone) return
    const tab = this.tab(tabId)
    if (!tab) return
    if (tab.pinned || tab.essential || this.unloadChecks.has(tabId)) {
      // Pinned tabs survive their page: they simply show as unloaded until clicked again. So does
      // a tab whose page went under a window's or the app's unload check – the window may yet stay
      // open (another page's "Stay"), and the tab is then simply unloaded, its stack kept.
      this.discard(tabId)
      return
    }
    this.closeTab(tabId, true, owner, this.closeIntents.get(tabId) ?? {})
  }

  // ---------------------------------------------------------------------------
  // beforeunload
  // ---------------------------------------------------------------------------

  /**
   * Whether the page of `tabId` may be unloaded: its `beforeunload` handlers run and, when one
   * objects, the chrome asks "Leave site?". Resolves true when the page may go – or is gone by
   * then: a page that does not object is closed by the check itself, and its tab with it (with
   * `keepTab`, the tab stays and shows as unloaded, for checks that may not end in a close).
   * Its back/forward stack is kept for a reload or "Recently closed" either way.
   */
  async confirmUnload(tabId: string, keepTab = false): Promise<boolean> {
    const view = this.view(tabId)
    const tab = this.tab(tabId)
    if (!view || !tab || !view.confirmUnload || view.isDestroyed()) return true
    // A page waiting in one of its own dialogs cannot run its handlers; the close dismisses it.
    this.browser.pageDialogs.cancelForTab(tabId)
    this.pendingNavigation.set(tabId, view.navigationEntries())
    this.rememberNavigation(tabId, view)
    if (keepTab) this.unloadChecks.add(tabId)
    try {
      // A frozen page cannot run its handlers.
      if (tab.frozen) {
        await this.browser.governor.thaw(tabId, true)
        tab.frozen = false
      }
      // Only an explicit "stay" keeps the page (a host that answers nothing does not object).
      const leave = (await view.confirmUnload()) !== false
      if (!leave && this.view(tabId) === view) this.pendingNavigation.delete(tabId)
      return leave
    } finally {
      this.unloadChecks.delete(tabId)
    }
  }

  /**
   * Close a tab the way the user asks for it (Ctrl+W, the tab's X, the menu): a page whose
   * `beforeunload` handler objects gets to ask "Leave site?" first, and the tab stays when the
   * user says so. Resolves true once the tab is closed.
   */
  async requestClose(
    tabId: string,
    force = false,
    win?: ZenWindow,
    opts: TabFocusOptions = {}
  ): Promise<boolean> {
    // The unload check closes a page that does not object: the tab then goes through
    // `onViewGone`, which reads the options here. The chrome sees the intent as
    // `closingTabIds` for as long as it stands (the overview holds the card's exit on it).
    this.closeIntents.set(tabId, opts)
    this.browser.state.commitVolatile()
    try {
      if (!(await this.confirmUnload(tabId))) return false
      this.closeTab(tabId, force, win, opts)
      return true
    } finally {
      this.closeIntents.delete(tabId)
      this.browser.state.commitVolatile()
    }
  }

  /**
   * The tabs a `requestClose` is in flight for: told to close by the user, their pages' unload
   * checks not yet through – one asking "Leave site?" holds its close for as long as the user
   * takes. Gone from the list as the tab closes, or as its page keeps it.
   */
  closingTabIds(): string[] {
    return [...this.closeIntents.keys()]
  }

  /**
   * Close several tabs as the user asks for them, one at a time in the order given (the loop
   * of the desktop's "Close N Tabs"): a page that objects asks "Leave site?" in its turn – the
   * dialog is tab-modal, so two asked at once would leave one waiting unseen in a background
   * tab – and a "Cancel" keeps that tab alone, the run going on to the next (Chrome keeps only
   * the tab whose question was cancelled). `activate` is the tab to end on, if it is still
   * open by then.
   */
  async closeMany(tabIds: string[], win?: ZenWindow, activate?: string): Promise<void> {
    for (const tabId of tabIds) {
      if (this.tab(tabId)) await this.requestClose(tabId, false, win)
    }
    if (activate && this.tab(activate)) this.activateTab(activate, win)
  }

  /**
   * Pages destroyed when `win` closes: those of its own tabs, and every page it holds when no
   * other synced window remains to take them (`releaseWindow`).
   */
  viewsClosingWith(win: ZenWindow): string[] {
    const others = this.browser
      .allWindows()
      .filter((w) => w !== win && w.kind === 'synced' && w.alive)
    const out: string[] = []
    for (const [tabId, view] of this.viewsOwnedBy(win)) {
      if (view.isDestroyed()) continue
      const tab = this.tab(tabId)
      if (!tab || tab.windowId === win.id || others.length === 0) out.push(tabId)
    }
    return out
  }

  /**
   * How many tabs close with `win`, as the user sees it: the tabs of a blank or private window,
   * a synced window's own tabs, or every tab when it is the last synced window (they come back
   * with the next session, but the window they are in closes).
   */
  closingTabCount(win: ZenWindow): number {
    const m = this.model
    const glance = win.glance?.tabId
    if (win.localSpace) return win.localSpace.tabIds.filter((id) => m.tabs[id]).length
    const others = this.browser
      .allWindows()
      .filter((w) => w !== win && w.kind === 'synced' && w.alive)
    let n = 0
    for (const tab of Object.values(m.tabs)) {
      if (tab.id === glance || (tab.spaceId && m.localSpaces[tab.spaceId])) continue
      if (others.length === 0 || tab.windowId === win.id) n += 1
    }
    return n
  }

  /** How many tabs close when the app quits: every tab of every window (Glance previews aside). */
  openTabCount(): number {
    const glances = new Set(
      this.browser
        .allWindows()
        .map((w) => w.glance?.tabId)
        .filter((id): id is string => Boolean(id))
    )
    return Object.keys(this.model.tabs).filter((id) => !glances.has(id)).length
  }

  /** Which window a tab belongs to under the current window-sync mode (null = shared). */
  ownerWindowIdFor(tab: Tab, space: Space, win: ZenWindow): string | null {
    if (space.windowId) return space.windowId
    if (tab.pinned || tab.essential) return null
    return this.settings.windowSync === 'pinned' ? win.id : null
  }

  /** Re-apply window ownership after pin state changes (pinned tabs are always shared). */
  private refreshOwnership(tab: Tab, win: ZenWindow): void {
    const space = getSpace(this.model, tab.spaceId)
    if (space?.windowId) {
      tab.windowId = space.windowId
      return
    }
    if (tab.pinned || tab.essential) tab.windowId = null
    else if (this.settings.windowSync === 'pinned' && tab.windowId === null) tab.windowId = win.id
    else if (this.settings.windowSync !== 'pinned') tab.windowId = null
  }

  /**
   * Make `tabId` the active tab of its space. The page then takes the keyboard, unless
   * `keepFocus`: activated from the keyboard in the tab strip, the strip keeps it (Chrome's
   * pane focus stays on the strip until Escape).
   */
  activateTab(
    tabId: string,
    win: ZenWindow = this.browser.focusedWindow(),
    opts: TabFocusOptions = {}
  ): void {
    const m = this.model
    const tab = this.tab(tabId)
    if (!tab || !tabVisibleIn(tab, win.id)) return
    let space = win.activeSpace()
    if (win.localSpace) {
      if (!win.localSpace.tabIds.includes(tabId)) return
    } else {
      if (tab.spaceId && m.localSpaces[tab.spaceId]) return
      if (tab.essential) {
        // Essentials live in every space; with container-specific essentials we may have to switch.
        if (this.settings.containerSpecificEssentials && tab.containerId !== space.containerId) {
          const target = m.spaces.find((s) => s.containerId === tab.containerId)
          if (target) space = target
        }
      } else if (tab.spaceId && tab.spaceId !== space.id) {
        space = getSpace(m, tab.spaceId) ?? space
      }
      if (tab.splitGroupId) {
        // A split view belongs to one space; follow it there (matters for essentials).
        const group = m.splitGroups[tab.splitGroupId]
        if (group && group.spaceId !== space.id) space = getSpace(m, group.spaceId) ?? space
      }
      if (win.activeSpaceId !== space.id) {
        this.switchSpace(space.id, win, tabId)
        return
      }
    }
    const previousActive = this.tab(win.selectedTabIn(space))
    win.select(space, tab.id)
    tab.lastActiveAt = Date.now()
    // In front now: whatever its page changed in the background has been seen (tabs-11).
    if (tab.attention) delete tab.attention
    // A member in view is the group in use: the Tab groups pane's "last used" (TAB-16). A
    // private member's viewing leaves no trace on the regular profile's group.
    if (tab.folderId && m.folders[tab.folderId] && !this.isPrivate(tab))
      m.folders[tab.folderId].lastUsedAt = tab.lastActiveAt
    if (previousActive && previousActive.id !== tab.id) {
      previousActive.lastActiveAt = Date.now()
      // The user left the previous tab of their own accord: its close no longer returns to its
      // opener (tabs-30). Its own activation may still return to it.
      if (opts.userSwitch) this.openerReturn.delete(previousActive.id)
    }
    if (win.glance && win.glance.parentTabId !== tab.id && win.glance.tabId !== tab.id) {
      this.closeGlance(win)
    }
    for (const id of this.visibleTabIds(win)) {
      this.ensureLoaded(id, win)
      this.claim(id, win)
    }
    this.releaseHidden(win)
    this.browser.governor.wakeVisible(win)
    // An offline error page that came back online while hidden reloads on its turn on screen.
    this.browser.connectivity.onTabsShown(this.visibleTabIds(win))
    win.findResult = null
    this.browser.state.commit()
    if (!opts.keepFocus) win.focusContent()
  }

  switchSpace(
    spaceId: string,
    win: ZenWindow = this.browser.focusedWindow(),
    activateTabId?: string
  ): void {
    const m = this.model
    const space = getSpace(m, spaceId)
    if (!space) return
    if (win.localSpace ? space.id !== win.localSpace.id : Boolean(space.windowId)) return
    const fromIndex = m.spaces.findIndex((s) => s.id === win.activeSpaceId)
    const toIndex = m.spaces.findIndex((s) => s.id === spaceId)
    if (win.glance) this.closeGlance(win)
    win.activeSpaceId = spaceId
    if (!win.localSpace) m.activeSpaceId = spaceId
    if (activateTabId && this.tab(activateTabId)) win.select(space, activateTabId)
    const active = this.tab(win.selectedTabIn(space))
    if (!active) {
      // Nothing valid remembered: fall back to the first unpinned tab, then anything visible.
      const list = orderedTabsForSpace(m, space, this.settings.containerSpecificEssentials, win.id)
      const pick = list.find((t) => !t.pinned && !t.essential) ?? list[0]
      win.select(space, pick?.id ?? null)
    } else {
      active.lastActiveAt = Date.now()
    }
    for (const id of this.visibleTabIds(win)) {
      this.ensureLoaded(id, win)
      this.claim(id, win)
    }
    this.releaseHidden(win)
    this.browser.governor.wakeVisible(win)
    win.findResult = null
    this.browser.emit('space.switched', { fromIndex, toIndex }, win)
    this.browser.state.commit()
  }

  /**
   * Close a tab. For pinned/essential tabs Zen applies `pinnedCloseBehavior` instead of really
   * closing (default: reset to the pinned URL, unload and switch to the next tab). `opts` go to
   * the activation of the neighbour that takes the closed tab's place in `win` (`keepFocus`:
   * closed with Delete in the tab strip, the strip keeps the keyboard).
   */
  closeTab(tabId: string, force = false, win?: ZenWindow, opts: TabFocusOptions = {}): void {
    const m = this.model
    const tab = this.tab(tabId)
    if (!tab) return
    for (const w of this.browser.allWindows()) {
      if (w.glance?.tabId === tabId) {
        this.closeGlance(w)
        return
      }
    }
    const source = win ?? this.windowFor(tabId)
    if ((tab.pinned || tab.essential) && !force) {
      const behaviour = this.settings.pinnedCloseBehavior
      if (behaviour !== 'close') {
        const space = source.activeSpace()
        const wasActive = source.selectedTabIn(space) === tabId
        if (behaviour.includes('reset')) this.resetPinned(tabId, false, source)
        if (behaviour.includes('unload')) this.discard(tabId)
        if (behaviour.includes('switch') && wasActive) {
          const next = nextTabAfterClose(
            m,
            space,
            tabId,
            this.settings.containerSpecificEssentials,
            true,
            source.id
          )
          if (next) this.activateTab(next, source, opts)
        }
        this.browser.state.commit()
        return
      }
    }
    const space = getSpace(m, tab.spaceId)
    const index = sectionIndexOf(m, tab)
    // The back/forward stack has to be read while the page still exists.
    const closed = this.captureClosed(tab, index, Date.now())
    // Closing the tab the user never switched away from since it opened returns to its opener
    // (tabs-30) when it is alive and in the same window and space; else the neighbour rule stands.
    const opener = this.openerReturn.has(tabId) ? this.tab(tab.openerTabId ?? undefined) : undefined
    // Every window that had this tab selected picks a neighbour (Firefox: next, else previous).
    const reselect: Array<{ w: ZenWindow; s: Space; next: string | null }> = []
    for (const w of this.browser.allWindows()) {
      const candidates = tab.essential ? (w.localSpace ? [] : m.spaces) : space ? [space] : []
      for (const s of candidates) {
        if (w.selectedTabIn(s) !== tabId) continue
        const neighbour = nextTabAfterClose(
          m,
          s,
          tabId,
          this.settings.containerSpecificEssentials,
          false,
          w.id
        )
        const toOpener =
          opener &&
          opener.id !== tabId &&
          orderedTabsForSpace(m, s, this.settings.containerSpecificEssentials, w.id).some(
            (t) => t.id === opener.id
          )
        reselect.push({ w, s, next: toOpener ? opener.id : neighbour })
      }
    }
    removeTabFromSplit(m, tabId)
    removeTabFromLists(m, tabId)
    delete m.tabs[tabId]
    this.saveFolderOnLastClose(tab, closed?.closedAt ?? Date.now())
    this.openerReturn.delete(tabId)
    this.browser.state.tabNavigation.delete(tabId)
    // Its host-state document stays only while a "Recently closed" entry holds the id.
    this.browser.state.navigationState.touch(tabId)
    this.destroyView(tabId)
    this.browser.governor.onTabRemoved(tabId)
    this.browser.pages.onTabRemoved(tabId)
    this.browser.agents.onTabRemoved(tabId)
    this.browser.find.forget(tabId)
    this.browser.webApps.onTabRemoved(tabId)
    this.browser.print.onTabRemoved(tabId)
    this.browser.pdf.onTabRemoved(tabId)
    this.browser.liveFolders.onTabLeftFolder(tabId, tab.folderId)
    if (closed) {
      if (this.divertClosed) this.divertClosed(closed)
      else this.browser.session.pushTab(closed)
    }
    for (const { w, s, next } of reselect) {
      w.select(s, next)
      if (w.activeSpaceId === s.id && next) this.activateTab(next, w, w === source ? opts : {})
      // A toolbar-only popup or an app window has no sidebar to open another tab from: like
      // Chrome's, it closes with its last tab (deferred – the close may be arriving from the
      // page going away).
      else if (!next && w.chrome !== 'full') {
        defer(() => {
          if (w.alive) w.host.close()
        })
      }
    }
    this.browser.updateMedia()
    if (this.isPrivate(tab)) this.browser.onPrivateTabClosed()
    this.browser.state.commit()
  }

  /**
   * Close `tabId` the way the inactive-tabs pass does (TAB-20): the tab leaves the grid exactly
   * as a close does – document gone, navigation stack kept – but its entry comes back to the
   * caller for the archive instead of joining "Recently closed". Null when the close produced no
   * entry (a never-visited blank tab, a private tab, a pinned tab held by `pinnedCloseBehavior`),
   * in which case the tab is simply closed or left as it was.
   */
  archiveTab(tabId: string, win?: ZenWindow): ClosedTabEntry | null {
    let entry: ClosedTabEntry | null = null
    this.divertClosed = (closed) => {
      entry = closed
    }
    try {
      this.closeTab(tabId, false, win)
    } finally {
      this.divertClosed = null
    }
    return entry
  }

  /**
   * Private browsing as a tab of this window (`capabilities.privateTabs`, hosts without private
   * windows): the tab lives in the in-memory private container – no history, no persisted
   * downloads, never restored – and the private session is wiped when the last one closes.
   * Resolves with the tab id, or null on hosts that offer private windows instead.
   */
  newPrivateTab(
    url: string | undefined,
    win: ZenWindow = this.browser.focusedWindow()
  ): string | null {
    if (!this.browser.state.capabilities.privateTabs) return null
    return this.createTab({ url, active: true, containerId: PRIVATE_CONTAINER_ID }, win).id
  }

  /**
   * The group's last live member has closed (TAB-16): the group stays as a saved one holding
   * that page – Chrome's saved group mirrors its live tabs, so members closed one by one leave
   * it before, and the last one is what the group keeps. A group closing as one
   * (`closeFolderTabs`) has its pages set already, the whole group's; a private member leaves
   * nothing behind – no page, no last use – as it leaves no recently closed entry, and the
   * group's live members are its regular ones (`regularFolderTabs`). A saved group folds shut:
   * the desktop sidebar lists a saved group's pages under its header only when it is unfolded
   * (collapsed by default, Chrome's saved-group chip), and the tab that brings it back to life
   * unfolds it again (`folderOpened` – Open Folder, a reopened closed tab, a move into it).
   */
  private saveFolderOnLastClose(tab: Tab, closedAt: number): void {
    const folderId = tab.folderId
    if (!folderId || this.closingFolders.has(folderId) || this.isPrivate(tab)) return
    const folder = this.model.folders[folderId]
    if (!folder || regularFolderTabs(this.model, folderId).length > 0) return
    folder.savedTabs = [savedGroupTab(tab)]
    folder.lastUsedAt = closedAt
    folder.collapsed = true
  }

  /**
   * Chrome's "Close group" (TAB-16): the group's tabs close – each to the recently closed list,
   * so the close has its undo – and the group stays as a saved one holding all their pages, in
   * the group's order. A group with no live member is left as it is. Private members close but
   * are not kept (a private page is never filed).
   */
  closeFolderTabs(folderId: string, win: ZenWindow = this.browser.focusedWindow()): void {
    const m = this.model
    const folder = m.folders[folderId]
    if (!folder) return
    // The group's tabs are its regular members: a private tab in it is none of the group's on
    // the surface that closes it, and stays, as it was never counted.
    const members = regularFolderTabs(m, folderId)
    if (members.length === 0) return
    folder.savedTabs = members.map(savedGroupTab)
    folder.lastUsedAt = Date.now()
    folder.collapsed = true
    this.closingFolders.add(folderId)
    try {
      for (const t of members) this.closeTab(t.id, true, win)
    } finally {
      this.closingFolders.delete(folderId)
    }
    this.browser.state.commit()
  }

  /** Every private tab (the private-session count in the chrome). */
  privateTabs(): Tab[] {
    return Object.values(this.model.tabs).filter((tab) => this.isPrivate(tab))
  }

  /** Close every private tab, which ends the private session. */
  closePrivateTabs(win: ZenWindow = this.browser.focusedWindow()): void {
    for (const tab of this.privateTabs()) this.closeTab(tab.id, true, win)
  }

  /**
   * What "Recently Closed" remembers about a tab that is going away. Private tabs and tabs that
   * never left the blank page or the new tab page are not worth keeping (Firefox skips those too).
   */
  private captureClosed(tab: Tab, index: number, closedAt: number): ClosedTabEntry | null {
    if (this.isPrivate(tab)) return null
    const view = this.view(tab.id)
    const navigation = view
      ? view.navigationEntries()
      : (this.pendingNavigation.get(tab.id) ?? null)
    const visited = navigation?.entries.some((e) => !isEmptyTabUrl(e.url)) ?? false
    if (isEmptyTabUrl(tab.url) && !visited) return null
    return closedTabEntry(
      tab,
      { spaceId: tab.spaceId, folderId: tab.folderId, index, windowId: tab.windowId },
      navigation && navigation.entries.length > 0 ? navigation : null,
      closedAt
    )
  }

  /** Ctrl+Shift+T: bring back the newest recently closed tab or window. */
  reopenClosed(win: ZenWindow = this.browser.focusedWindow()): void {
    this.browser.session.reopenClosed(win)
  }

  /**
   * What Close Tabs Above / Below / Other Tabs would close from this row (tabs-25, BUG-013): the
   * space's regular tabs shown in the window, in the strip's order. Pinned and Essentials tabs
   * are exempt from all three (Chrome exempts pinned tabs from "Close other tabs"), so from a
   * pinned or essential row every regular tab lies below and none above. The menu greys an
   * item this leaves empty.
   */
  closeScope(tabId: string, which: 'above' | 'below' | 'others', win?: ZenWindow): string[] {
    const tab = this.tab(tabId)
    if (!tab) return []
    const source = win ?? this.windowFor(tabId)
    const space = getSpace(this.model, tab.spaceId) ?? source.activeSpace()
    const regular = space.tabIds.filter((id) => {
      const t = this.tab(id)
      return t && !t.pinned && !t.essential && tabVisibleIn(t, source.id)
    })
    if (which === 'others') return regular.filter((id) => id !== tabId)
    const idx = regular.indexOf(tabId)
    if (idx === -1) return tab.pinned || tab.essential ? (which === 'below' ? regular : []) : []
    return which === 'below' ? regular.slice(idx + 1) : regular.slice(0, idx)
  }

  closeOthers(tabId: string, win: ZenWindow = this.windowFor(tabId)): void {
    const victims = this.closeScope(tabId, 'others', win)
    if (victims.length === 0) return
    for (const id of victims) this.closeTab(id, false, win)
    this.activateTab(tabId, win)
  }

  closeBelow(tabId: string, win?: ZenWindow): void {
    this.closeRelative(tabId, 'below', win)
  }

  closeAbove(tabId: string, win?: ZenWindow): void {
    this.closeRelative(tabId, 'above', win)
  }

  private closeRelative(tabId: string, direction: 'above' | 'below', win?: ZenWindow): void {
    const source = win ?? this.windowFor(tabId)
    for (const id of this.closeScope(tabId, direction, source)) this.closeTab(id, false, source)
  }

  /** Zen's "Clear tabs" button / Ctrl+Shift+K: close every unpinned tab in the space. */
  closeUnpinned(spaceId?: string, win: ZenWindow = this.browser.focusedWindow()): void {
    const space = (spaceId ? getSpace(this.model, spaceId) : undefined) ?? win.activeSpace()
    for (const id of [...space.tabIds]) {
      const t = this.tab(id)
      if (t && !t.pinned && tabVisibleIn(t, win.id)) this.closeTab(id, false, win)
    }
    this.browser.state.commit()
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  navigate(
    tabId: string,
    url: string,
    opts: { upgradedFrom?: string; transition?: HistoryTransition } = {}
  ): void {
    const tab = this.tab(tabId)
    if (!tab || !isNavigableUrl(url)) return
    // An internal page: a chrome page (Settings, History, Bookmarks, Downloads) lives in a tab
    // of its own, or in its overlay where the host or the layout keeps one, and the document in
    // this tab stays where it is; a document page the window already shows is focused instead.
    // Otherwise the URL loads here like any other.
    if (this.browser.pages.routeNavigation(tabId, url)) return
    tab.url = url
    tab.title = this.titleFor(url)
    tab.errorCode = null
    tab.certificateError = null
    if (opts.upgradedFrom) this.httpsUpgraded.set(tabId, `http://${opts.upgradedFrom}`)
    else this.httpsUpgraded.delete(tabId)
    this.pendingTransition.set(tabId, opts.transition ?? 'typed')
    // A host whose request engine cannot hold a navigation on the core's lookalike verdict
    // (Android): the address the browser was asked for is checked here, before its request –
    // the question page loads in its place (PS-18). Hosts with the hold leave it to their engine.
    const lookalike = this.browser.state.capabilities.lookalikeHolds
      ? null
      : this.browser.protection.checkLookalike(url)
    if (lookalike) {
      tab.url = this.browser.protection.lookalikePage(tabId, url, lookalike)
      tab.errorCode = BLOCKED_BY_CLIENT_CODE
    }
    const hadView = this.view(tabId) !== undefined
    this.thawForNavigation(tabId)
    const view = this.ensureLoaded(tabId)
    if (!view) return
    view.setBackgroundColor(this.backgroundFor(tab.url))
    // ensureLoaded() already loads `tab.url` when it has to create the view.
    if (hadView) view.loadURL(tab.url)
    this.browser.state.commit()
  }

  goBack(tabId: string): void {
    // A chrome page's history is its sections; at the first one the tab stays, and the chrome's
    // root-back rule (renderer `back.ts`) says what a back does then.
    if (this.browser.pages.isChromePage(this.tab(tabId))) {
      this.browser.pages.popSection(tabId)
      return
    }
    const view = this.view(tabId)
    if (!view?.canGoBack()) return
    this.thawForNavigation(tabId)
    view.goBack()
  }

  goForward(tabId: string): void {
    if (this.browser.pages.isChromePage(this.tab(tabId))) {
      this.browser.pages.forward(tabId)
      return
    }
    const view = this.view(tabId)
    if (!view?.canGoForward()) return
    this.thawForNavigation(tabId)
    view.goForward()
  }

  /**
   * Chrome's middle-click / Ctrl+click (⌘+click on macOS) on Back or Forward, and its Ctrl+click
   * on a row of the back/forward stack menu (shortcuts-menus-93): the entry at `index` of the
   * tab's stack opens in a new background tab right after this one – a fresh load of that URL
   * in the tab's container and space (a new navigation, not the entry's page state) – while this
   * tab and its stack stay where they are. Nothing for an index the stack has not got, and
   * nothing for a chrome page, whose "stack" is its sections. Returns the tab opened.
   */
  openNavigationEntryInNewTab(
    tabId: string,
    index: number,
    win: ZenWindow = this.windowFor(tabId)
  ): Tab | undefined {
    const tab = this.tab(tabId)
    if (!tab || this.browser.pages.isChromePage(tab)) return undefined
    const entry = this.navigationEntries(tabId).entries[index]
    if (!entry || !isNavigableUrl(entry.url)) return undefined
    return this.createTab(
      {
        url: entry.url,
        spaceId: tab.spaceId ?? undefined,
        containerId: tab.containerId,
        active: false,
        afterTabId: tab.essential ? undefined : tab.id,
        openerTabId: tab.id
      },
      win
    )
  }

  /**
   * The step Back (`-1`) or Forward (`1`) would take, opened in a new background tab instead
   * (`openNavigationEntryInNewTab`): nothing when the stack has no entry that way.
   */
  openNavigationStepInNewTab(
    tabId: string,
    step: -1 | 1,
    win: ZenWindow = this.windowFor(tabId)
  ): Tab | undefined {
    const { index } = this.navigationEntries(tabId)
    if (index < 0) return undefined
    return this.openNavigationEntryInNewTab(tabId, index + step, win)
  }

  reload(tabId: string, skipCache = false): void {
    const tab = this.tab(tabId)
    if (!tab) return
    if (tab.discarded) {
      this.ensureLoaded(tabId)
      this.browser.state.commit()
      return
    }
    const view = this.view(tabId)
    if (!view) return
    this.thawForNavigation(tabId)
    if (tab.url.startsWith(ERROR_URL_PREFIX)) {
      const original = safeParam(tab.url, 'url')
      if (original) {
        this.navigate(tabId, original, { transition: 'reload' })
        return
      }
    }
    this.pendingTransition.set(tabId, 'reload')
    view.reload(skipCache)
  }

  stop(tabId: string): void {
    this.view(tabId)?.stop()
  }

  /**
   * The "Page unresponsive" prompt's Exit page (tabs-45): end the renderer of every page listed
   * – they share it, so the first kill takes them all, and a host asked again for a renderer
   * that is gone does nothing – and read the reports that follow as pages ended for not
   * responding (`hungExits`). A host without `endRenderer` cannot; the mark is dropped so the
   * prompt goes.
   */
  exitUnresponsive(tabIds: readonly string[]): void {
    let changed = false
    for (const tabId of tabIds) {
      const tab = this.tab(tabId)
      if (!tab?.unresponsive) continue
      const view = this.view(tabId)
      if (view?.endRenderer) {
        this.hungExits.add(tabId)
        view.endRenderer()
      } else {
        delete tab.unresponsive
        changed = true
      }
    }
    if (changed) this.browser.state.commitVolatile()
  }

  /**
   * The prompt's Wait: the mark goes and the prompt with it; the host's hang monitor reports the
   * page again should it stay unresponsive, and the chrome asks again (Chrome's dialog returns
   * the same way).
   */
  waitUnresponsive(tabIds: readonly string[]): void {
    let changed = false
    for (const tabId of tabIds) {
      const tab = this.tab(tabId)
      if (!tab?.unresponsive) continue
      delete tab.unresponsive
      changed = true
    }
    if (changed) this.browser.state.commitVolatile()
  }

  toggleMute(tabId: string): void {
    const tab = this.tab(tabId)
    if (!tab) return
    tab.muted = !tab.muted
    this.view(tabId)?.setMuted(tab.muted)
    this.browser.state.commit()
  }

  /**
   * Whether the site of `url` is muted: its `sound` content setting resolves to block (the one
   * source of "Mute Site", Settings › Site settings › Sound and the site-information row alike).
   * Pages without a site (`zen://`, `about:blank`) are never muted by a setting, as Chrome's
   * internal pages are allowed every content whatever the default.
   */
  siteMuted(url: string): boolean {
    return permissionSite(url) !== null && this.browser.permissions.resolve('sound', url) === 'deny'
  }

  /**
   * Chrome's "Mute Site": every tab of the site goes quiet (and stays so on later visits) until
   * the site is unmuted again. Tabs that leave the site regain their sound. Writes the site's
   * `sound` setting – as Chrome, an exception equal to the default is cleared rather than kept –
   * and `followSoundSetting` mutes the tabs when the change lands.
   */
  toggleMuteSite(tabId: string): void {
    const tab = this.tab(tabId)
    if (!tab) return
    const site = permissionSite(tab.url)
    if (!site) return
    const wanted: 'allow' | 'deny' = this.siteMuted(tab.url) ? 'allow' : 'deny'
    const permissions = this.browser.permissions
    permissions.set('sound', site, wanted === permissions.effectiveDefault('sound') ? null : wanted)
  }

  /**
   * A `sound` decision changed (Mute Site, a Settings row, a reset): every tab of the site – of
   * every site, for the default – takes the setting's answer, as Chrome mutes and unmutes on the
   * spot. Wired by the browser once the permission store exists.
   */
  followSoundSetting(origin: string | null): void {
    let changed = false
    for (const t of Object.values(this.model.tabs)) {
      if (origin !== null && permissionSite(t.url) !== origin) continue
      const muted = this.siteMuted(t.url)
      if (t.muted === muted) continue
      t.muted = muted
      this.view(t.id)?.setMuted(muted)
      changed = true
    }
    if (changed) this.browser.state.commit()
  }

  /**
   * Before the `sound` setting was the source, "Mute Site" kept bare hosts (`www.` stripped) in
   * `settings.mutedHosts`. Each host becomes a `sound` block for the origins the old rule
   * covered (`soundSitesOfMutedHost`) and the list is emptied; a profile that carries hosts
   * again later (an older device syncing them in) is migrated the same way.
   */
  migrateMutedHosts(): void {
    const hosts = this.settings.mutedHosts
    if (hosts.length === 0) return
    for (const host of hosts)
      for (const origin of soundSitesOfMutedHost(host))
        this.browser.permissions.set('sound', origin, 'deny')
    this.settings.mutedHosts = []
    this.browser.state.commit()
  }

  /** A navigation crossed a site boundary: pick up or drop the site's mute with it. */
  private followSiteMute(tab: Tab, view: TabView, fromUrl: string, toUrl: string): void {
    if (permissionSite(fromUrl) === permissionSite(toUrl)) return
    if (this.siteMuted(toUrl)) {
      if (!tab.muted) {
        tab.muted = true
        view.setMuted(true)
      }
    } else if (this.siteMuted(fromUrl) && tab.muted) {
      tab.muted = false
      view.setMuted(false)
    }
  }

  /**
   * Zoom a tab's page to an exact factor. A web page's factor is its site's, remembered in the
   * settings and applied to every tab of the site (Chrome's per-host zoom); any other page
   * (internal document pages, files) zooms on its own on the desktop, the tab keeping the factor,
   * and not at all under the full page controls (the sheet is about sites). A chrome page
   * (Settings) has no page view to zoom: the factor stays 1 and the chip has nothing to show.
   */
  setZoom(tabId: string, factor: number): void {
    const tab = this.tab(tabId)
    if (!tab || this.browser.pages.isChromePage(tab)) return
    if (this.browser.pageControls.remembersZoom(tab)) {
      this.browser.pageControls.setZoomFactor(tabId, factor)
      return
    }
    if (this.browser.pageControls.enabled) return
    tab.zoom = clampZoom(factor)
    this.view(tabId)?.setZoom(tab.zoom)
    this.browser.state.commitVolatile()
    this.browser.emit(
      'zoom.changed',
      { tabId, factor: tab.zoom, siteKey: null },
      this.windowFor(tabId)
    )
  }

  /** Zoom In / Zoom Out: one step along the host's ladder (Chrome's presets on the desktop). */
  adjustZoom(tabId: string, direction: number): void {
    const tab = this.tab(tabId)
    if (!tab || this.browser.pages.isChromePage(tab)) return
    if (this.browser.pageControls.remembersZoom(tab)) {
      this.browser.pageControls.adjustZoom(tabId, direction)
      return
    }
    if (this.browser.pageControls.enabled) return
    const current = this.view(tabId)?.getZoom() ?? tab.zoom
    this.setZoom(tabId, stepZoom(current, direction, this.browser.pageControls.zoomLevels))
  }

  /** Ctrl+0: back to the default zoom (the site's exception goes away); other pages to 100 percent. */
  resetZoom(tabId: string): void {
    const tab = this.tab(tabId)
    if (!tab) return
    if (this.browser.pageControls.remembersZoom(tab)) this.browser.pageControls.resetZoom(tabId)
    else this.setZoom(tabId, 1)
  }

  // ---------------------------------------------------------------------------
  // Pinned tabs & essentials
  // ---------------------------------------------------------------------------

  togglePin(tabId: string, win: ZenWindow = this.windowFor(tabId)): void {
    const tab = this.tab(tabId)
    if (!tab) return
    if (win.localSpace && tab.essential) return
    if (tab.essential) {
      // Zen: unpinning an essential turns it into a regular tab of the current space.
      moveTab(
        this.model,
        tab,
        { spaceId: win.activeSpace().id, section: 'regular', index: 0 },
        this.settings.essentialsMax
      )
    } else {
      const section: TabSection = tab.pinned ? 'regular' : 'pinned'
      const index = tab.pinned ? 0 : Number.MAX_SAFE_INTEGER
      moveTab(
        this.model,
        tab,
        { spaceId: tab.spaceId ?? undefined, section, index },
        this.settings.essentialsMax
      )
    }
    this.refreshOwnership(tab, win)
    this.sendPageFlags(tabId)
    this.browser.state.commit()
  }

  toggleEssential(tabId: string, win: ZenWindow = this.windowFor(tabId)): void {
    const tab = this.tab(tabId)
    if (!tab || win.localSpace) return
    if (tab.essential) {
      moveTab(
        this.model,
        tab,
        { spaceId: win.activeSpace().id, section: 'pinned', index: Number.MAX_SAFE_INTEGER },
        this.settings.essentialsMax
      )
    } else {
      if (this.model.essentialTabIds.length >= this.settings.essentialsMax) {
        this.browser.toast(
          `You can have at most ${this.settings.essentialsMax} Essentials.`,
          'info',
          win
        )
        return
      }
      moveTab(
        this.model,
        tab,
        { section: 'essential', index: Number.MAX_SAFE_INTEGER },
        this.settings.essentialsMax
      )
      const space = win.activeSpace()
      if (!win.selectedTabIn(space)) win.select(space, tabId)
    }
    this.refreshOwnership(tab, win)
    this.sendPageFlags(tabId)
    this.browser.state.commit()
  }

  resetPinned(tabId: string, activate = true, win: ZenWindow = this.windowFor(tabId)): void {
    const tab = this.tab(tabId)
    if (!tab || !(tab.pinned || tab.essential) || !tab.pinnedUrl) return
    if (tab.url !== tab.pinnedUrl) {
      if (tab.discarded) {
        tab.url = tab.pinnedUrl
        tab.title = tab.customTitle ?? this.titleFor(tab.url)
      } else {
        this.navigate(tabId, tab.pinnedUrl)
      }
    }
    if (activate) this.activateTab(tabId, win)
    this.browser.state.commit()
  }

  editPinnedUrl(tabId: string, url: string): void {
    const tab = this.tab(tabId)
    if (!tab || !(tab.pinned || tab.essential) || !isNavigableUrl(url)) return
    tab.pinnedUrl = url
    this.browser.state.commit()
  }

  rename(tabId: string, title: string | null): void {
    const tab = this.tab(tabId)
    if (!tab) return
    tab.customTitle = title?.trim() ? title.trim() : null
    this.browser.state.commit()
  }

  setIcon(tabId: string, icon: string | null): void {
    const tab = this.tab(tabId)
    if (!tab) return
    tab.customIcon = icon?.trim() ? icon.trim().slice(0, 8) : null
    this.browser.state.commit()
  }

  /**
   * The tab another page now comes from (`Tab.openerTabId`): a singleton page tab re-focused
   * from a second site remembers that site, not the one it was first opened from. A closed or
   * unknown opener is no opener; a tab is never its own.
   */
  setOpener(tabId: string, openerTabId: string | null): void {
    const tab = this.tab(tabId)
    if (!tab) return
    const opener = openerTabId && openerTabId !== tabId ? this.tab(openerTabId) : undefined
    const next = opener?.id ?? null
    if (tab.openerTabId === next) return
    tab.openerTabId = next
    this.browser.state.commit()
  }

  /**
   * Chrome's Duplicate (tabs-22): a copy right after the tab, in its container and folder, with
   * its back/forward stack – and, through the entries' page state, its scroll position – not a
   * bare load of the current URL. The stack is queued for the copy's page, which replays it
   * when it is created (`createView`), as a reopened tab's is. An unloaded tab gives what it
   * remembers of its stack; one with nothing remembered gets a plain load of its URL.
   */
  duplicate(tabId: string, win: ZenWindow = this.windowFor(tabId)): Tab | undefined {
    const tab = this.tab(tabId)
    if (!tab) return undefined
    const id = newId('tab')
    const view = this.view(tabId)
    const history = view
      ? view.navigationEntries()
      : (this.pendingNavigation.get(tabId) ?? this.browser.state.tabNavigation.get(tabId))
    if (history && history.entries.length > 0) this.pendingNavigation.set(id, history)
    return this.createTab(
      {
        id,
        url: tab.url,
        spaceId: win.activeSpace().id,
        containerId: tab.containerId,
        active: true,
        afterTabId: tab.essential ? undefined : tab.id
      },
      win
    )
  }

  moveTab(
    tabId: string,
    target: { spaceId?: string; section: TabSection; index: number },
    win: ZenWindow = this.windowFor(tabId)
  ): void {
    const tab = this.tab(tabId)
    if (!tab) return
    const before = { pinned: tab.pinned, essential: tab.essential, spaceId: tab.spaceId }
    const targetSpaceId = target.spaceId ?? tab.spaceId ?? win.activeSpace().id
    const targetSpace = getSpace(this.model, targetSpaceId)
    if (!targetSpace) return
    // Blank / private windows have no Essentials.
    if (target.section === 'essential' && targetSpace.windowId) return
    const leavesSpace = target.section !== 'essential' && tab.spaceId !== targetSpace.id
    if (leavesSpace) removeTabFromSplit(this.model, tabId)
    const previousSpace = getSpace(this.model, tab.spaceId)
    const previousFolder = tab.folderId
    const wasSelectedIn = this.browser
      .allWindows()
      .filter((w) => previousSpace && w.selectedTabIn(previousSpace) === tabId)
    moveTab(this.model, tab, { ...target, spaceId: targetSpace.id }, this.settings.essentialsMax)
    if (previousFolder && tab.folderId !== previousFolder)
      this.browser.liveFolders.onTabLeftFolder(tabId, previousFolder)
    if (
      !tab.pinned &&
      !tab.essential &&
      !targetSpace.windowId &&
      this.settings.windowSync === 'pinned'
    )
      tab.windowId = tab.windowId ?? win.id
    if (previousSpace && tab.spaceId !== previousSpace.id) {
      for (const w of wasSelectedIn) {
        const next =
          nextTabAfterClose(
            this.model,
            previousSpace,
            tabId,
            this.settings.containerSpecificEssentials,
            false,
            w.id
          ) ?? null
        w.select(previousSpace, next)
        if (w.activeSpaceId === previousSpace.id && next) this.activateTab(next, w)
      }
    }
    if (
      !targetSpace.windowId &&
      targetSpace.id !== win.activeSpaceId &&
      tab.spaceId === targetSpace.id
    ) {
      if (!targetSpace.activeTabId) targetSpace.activeTabId = tabId
    }
    if (before.pinned !== tab.pinned || before.essential !== tab.essential)
      this.sendPageFlags(tabId)
    this.browser.state.commit()
  }

  /**
   * A tab joins a folder – a drop on its header, the tab menu's Move to Folder, an extension's
   * `tabs.group` – or leaves one (`null`). A regular tab joining a SAVED group opens it first:
   * the pages it kept come back as its tabs, as Open Folder brings them, and the tab takes its
   * place behind them (open-then-add: the join loses nothing the group kept); joining an open
   * group it keeps its slot. Either way the group is unfolded and used now. A private tab is no
   * member of the group for the regular profile and leaves it as it was.
   */
  moveToFolder(tabId: string, folderId: string | null): void {
    const tab = this.tab(tabId)
    if (!tab || tab.essential || tab.pinned) return
    if (folderId && !this.model.folders[folderId]) return
    const previous = tab.folderId
    const joining = folderId !== null && folderId !== previous && !this.isPrivate(tab)
    const restored = joining ? this.restoreSavedFolder(folderId, this.windowFor(tabId)) : []
    tab.folderId = folderId
    if (previous && previous !== folderId) this.browser.liveFolders.onTabLeftFolder(tabId, previous)
    if (joining) {
      const last = restored[restored.length - 1]
      const space = last ? getSpace(this.model, tab.spaceId) : undefined
      if (last && space && space.id === last.spaceId) {
        // Behind the pages that came back: the slot after the last of them, in the space's
        // regular run without the joiner (the move lifts it out before it lands).
        const others = regularTabs(this.model, space).filter((t) => t.id !== tabId)
        moveTab(
          this.model,
          tab,
          { spaceId: space.id, section: 'regular', index: others.indexOf(last) + 1 },
          this.settings.essentialsMax
        )
      }
      folderOpened(this.model, folderId, Date.now())
    }
    this.browser.state.commit()
  }

  /**
   * A SAVED group's pages back as its tabs (TAB-16): in the order they were kept, at the end of
   * the space's regular tabs – the first there, each next behind the one before – unloaded, none
   * made active (Open Folder activates the first; a join adds its tab behind them), the group
   * unfolded and used now. The pages are let go before the first is made, so its own join finds
   * nothing left to bring back. Returns the tabs in order: none for a group that is not saved
   * (open, empty, gone) or whose space is.
   */
  restoreSavedFolder(folderId: string, win: ZenWindow = this.browser.focusedWindow()): Tab[] {
    const m = this.model
    const folder = m.folders[folderId]
    if (!folder || !isSavedFolder(m, folder)) return []
    const space = getSpace(m, folder.spaceId)
    if (!space) return []
    const pages = folder.savedTabs ?? []
    folder.savedTabs = null
    const restored: Tab[] = []
    for (const page of pages) {
      const last = restored[restored.length - 1]
      const tab = this.createTab(
        {
          url: page.url,
          spaceId: space.id,
          active: false,
          load: false,
          index: last ? undefined : Number.MAX_SAFE_INTEGER,
          afterTabId: last?.id,
          containerId: space.containerId,
          folderId
        },
        win
      )
      // The row and the card read as the page did until it loads again.
      tab.title = page.title || tab.title
      tab.favicon = page.favicon ?? null
      restored.push(tab)
    }
    folderOpened(m, folderId, Date.now())
    return restored
  }

  // ---------------------------------------------------------------------------
  // Drag and drop, moving between windows
  // ---------------------------------------------------------------------------

  /**
   * Resolve a sidebar drop in `win`. `key` is the `data-drop` of the target the pointer let go
   * over:
   *   tab:<tabId>:before|after      insert relative to another tab (its section)
   *   section:<section>:<spaceId>   append to a section (pinned | regular | essential)
   *   folder:<folderId>             move into a folder
   *   space:<spaceId>               move to another space
   *   split:<left|right|top|bottom> split with the window's active tab, or join its split on that
   *                                 side (the content area's edges)
   *   pane:<tabId>                  take over the split pane showing that tab (the tab stays open)
   *   bookmark:<folderId>:<index>   file the page on the bookmarks bar (the tab stays put)
   * Returns false when the key names nothing the tab can be dropped on.
   */
  dropTab(tabId: string, key: string, win: ZenWindow = this.windowFor(tabId)): boolean {
    const m = this.model
    const tab = this.tab(tabId)
    const drop = parseDropKey(key)
    if (!tab || !drop) return false
    switch (drop.kind) {
      case 'tab': {
        const target = this.tab(drop.tabId)
        // A tab lands beside another, never in it (that position is for a dropped address).
        if (!target || target.id === tabId || drop.position === 'into') return false
        const section: TabSection = target.essential
          ? 'essential'
          : target.pinned
            ? 'pinned'
            : 'regular'
        const index = this.indexRelativeTo(target, drop.position === 'after', tabId)
        this.moveTab(
          tabId,
          {
            spaceId: section === 'essential' ? undefined : (target.spaceId ?? win.activeSpace().id),
            section,
            index
          },
          win
        )
        if (section === 'regular' && target.folderId !== tab.folderId)
          this.moveToFolder(tabId, target.folderId)
        // Beside a pane of its own split the tab stays in it (the strip draws the split as one
        // row, so that slot is the row's own); anywhere else it leaves the split.
        if (target.splitGroupId !== tab.splitGroupId) this.leaveSplitOnDrop(tab)
        return true
      }
      case 'section': {
        const { section, spaceId } = drop
        if (!isTabSection(section)) return false
        if (spaceId && !getSpace(m, spaceId)) return false
        this.moveTab(
          tabId,
          { spaceId: spaceId || undefined, section, index: Number.MAX_SAFE_INTEGER },
          win
        )
        if (section === 'regular' && tab.folderId) this.moveToFolder(tabId, null)
        this.leaveSplitOnDrop(tab)
        return true
      }
      case 'folder': {
        const folder = m.folders[drop.folderId]
        if (!folder) return false
        if (tab.spaceId !== folder.spaceId || tab.pinned || tab.essential) {
          this.moveTab(
            tabId,
            { spaceId: folder.spaceId, section: 'regular', index: Number.MAX_SAFE_INTEGER },
            win
          )
        }
        this.moveToFolder(tabId, folder.id)
        this.leaveSplitOnDrop(tab)
        return true
      }
      case 'space': {
        if (tab.essential || !getSpace(m, drop.spaceId)) return false
        this.moveTab(
          tabId,
          {
            spaceId: drop.spaceId,
            section: tab.pinned ? 'pinned' : 'regular',
            index: Number.MAX_SAFE_INTEGER
          },
          win
        )
        return true
      }
      case 'split': {
        const active = this.activeTabFor(win)
        if (!active) return false
        const { side } = drop
        const group = active.splitGroupId ? m.splitGroups[active.splitGroupId] : null
        if (group) return this.joinSplitAt(group.id, tabId, side, win)
        if (active.id === tabId) return false
        const layout: SplitLayout = side === 'left' || side === 'right' ? 'vertical' : 'horizontal'
        this.createSplit(
          side === 'left' || side === 'top' ? [tabId, active.id] : [active.id, tabId],
          layout,
          win
        )
        return true
      }
      case 'pane': {
        const shown = this.tab(drop.tabId)
        const group = shown?.splitGroupId ? m.splitGroups[shown.splitGroupId] : null
        if (!shown || !group || shown.id === tabId) return false
        if (!this.browser.pages.splittable(tab) || !this.joinable(tab, group.spaceId, win))
          return false
        this.bringIntoSpace(tab, group.spaceId)
        if (!replaceTabInSplit(m, group.id, shown.id, tabId)) return false
        this.activateTab(tabId, win)
        return true
      }
      case 'bookmark': {
        if (!tab.url || tab.url.startsWith('zen://')) return false
        this.browser.bookmarks.create({
          parentId: drop.folderId,
          index: drop.index ?? undefined,
          title: tab.customTitle ?? tab.title,
          url: tab.url,
          favicon: bookmarkFaviconOf(tab, this.isPrivate(tab)),
          type: 'url'
        })
        return true
      }
    }
  }

  /**
   * A pane dropped in the strip – beside a tab of another split or of none, on a section, into
   * a folder – leaves its split and stays where it landed (design language v2 §9.35: the strip
   * draws a split as one row, Zen's split-view group, and a tab dragged out of that row is out of
   * the split, as a tab dragged out of Zen's group is). The split goes on without it; with one
   * pane left it dissolves. A drop on the content area (an edge, a pane) is the way in.
   */
  private leaveSplitOnDrop(tab: Tab): void {
    if (!tab.splitGroupId) return
    removeTabFromSplit(this.model, tab.id)
    this.browser.state.commit()
  }

  /** Index within the target's section once the dragged tab is taken out of that list. */
  private indexRelativeTo(target: Tab, after: boolean, draggedId: string): number {
    const m = this.model
    let ids: string[]
    if (target.essential) {
      ids = m.essentialTabIds
    } else {
      const space = getSpace(m, target.spaceId)
      if (!space) return Number.MAX_SAFE_INTEGER
      ids = (target.pinned ? pinnedTabs(m, space) : regularTabs(m, space)).map((t) => t.id)
    }
    const idx = ids.filter((id) => id !== draggedId).indexOf(target.id)
    if (idx === -1) return Number.MAX_SAFE_INTEGER
    return after ? idx + 1 : idx
  }

  /**
   * Whether a tab may move into `target` from `source`: another full window of the same privacy
   * (Chrome keeps regular and Incognito tabs apart; a toolbar-only popup and an app window have
   * no tab strip).
   */
  canMoveToWindow(tab: Tab, target: ZenWindow, source?: ZenWindow): boolean {
    if (!target.alive || target.isClosing || target === source || target.chrome !== 'full')
      return false
    return this.isPrivate(tab) === target.isPrivate
  }

  // ---------------------------------------------------------------------------
  // Tab search (tabs-17)
  // ---------------------------------------------------------------------------

  /**
   * The window that shows a tab, or could: the one whose own space holds a local tab (a blank
   * or private window's), else `win` itself for a tab shared with every synced window. Null for
   * a tab `win` may not reach – another privacy, a local space of a window that is gone.
   */
  windowShowing(tab: Tab, win: ZenWindow): ZenWindow | null {
    const m = this.model
    const full = (w: ZenWindow): boolean => w.alive && !w.isClosing && w.chrome !== 'popup'
    if (tab.spaceId && m.localSpaces[tab.spaceId]) {
      return (
        this.browser.allWindows().find((w) => full(w) && w.localSpace?.id === tab.spaceId) ?? null
      )
    }
    // A tab shared by the synced windows, or local to one of them ("sync only pinned tabs").
    if (!win.localSpace && tabVisibleIn(tab, win.id)) return win
    return (
      this.browser
        .allWindows()
        .filter((w) => full(w) && !w.localSpace && tabVisibleIn(tab, w.id))
        .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)[0] ?? null
    )
  }

  /**
   * What `win`'s tab search lists (tabs-17): every tab it can switch to itself plus the tabs of
   * every other window of the same privacy (Chrome keeps regular and Incognito tab search apart),
   * each of those named after its window. Glance pages have no row of their own.
   */
  searchCandidates(win: ZenWindow): TabSearchCandidate[] {
    const m = this.model
    const out: TabSearchCandidate[] = []
    const glances = new Set(
      this.browser
        .allWindows()
        .map((w) => w.glance?.tabId)
        .filter((id): id is string => Boolean(id))
    )
    for (const tab of Object.values(m.tabs)) {
      if (glances.has(tab.id)) continue
      if (this.isPrivate(tab) !== win.isPrivate) continue
      const shown = this.windowShowing(tab, win)
      if (!shown) {
        // A tab of another window's model this one cannot show (a blank window's under
        // "sync only pinned tabs" without a window of its own, a closed window's space).
        continue
      }
      const other = shown !== win
      out.push({
        id: tab.id,
        title: tab.customTitle ?? tab.title,
        url: tab.url,
        favicon: tab.favicon,
        customIcon: tab.customIcon,
        containerId: tab.containerId,
        windowLabel: other ? this.browser.menus.windowLabel(shown) : null,
        active: this.activeTabFor(shown)?.id === tab.id,
        audible: tab.audible,
        muted: tab.muted,
        loading: tab.loading,
        discarded: tab.discarded,
        lastActiveAt: tab.lastActiveAt
      })
    }
    return out.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  /**
   * Switch to a tab from tab search: in `win` when it can show it, else in the window that can,
   * which comes to the front. Nothing for a tab `win` may not reach.
   */
  switchTo(tabId: string, win: ZenWindow): void {
    const tab = this.tab(tabId)
    if (!tab || this.isPrivate(tab) !== win.isPrivate) return
    const target = this.windowShowing(tab, win)
    if (!target) return
    this.activateTab(tabId, target)
    if (target !== win) target.host.focus()
  }

  /** Other windows a tab could be moved to, most recently focused first (the tab menu). */
  windowsForMove(tabId: string, source: ZenWindow): ZenWindow[] {
    const tab = this.tab(tabId)
    if (!tab) return []
    return this.browser
      .allWindows()
      .filter((w) => this.canMoveToWindow(tab, w, source))
      .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)
  }

  /**
   * Move a tab into another window and show it there. `key` is the drop target under the
   * pointer in that window (see `dropTab`), null when it was let go anywhere else in the window:
   * the tab then goes to the end of the window's current space. Under "sync all tabs" a synced
   * window already lists the shared tab, so the move is a reorder plus showing it there; under
   * "sync only pinned tabs" the tab changes hands; blank and private windows take it into their
   * own space. The source window moves on to a neighbour when it was showing the tab.
   */
  moveTabToWindow(
    tabId: string,
    target: ZenWindow,
    key: string | null = null,
    source: ZenWindow = this.windowFor(tabId)
  ): boolean {
    const tab = this.tab(tabId)
    if (!tab || target === source) return false
    if (!this.canMoveToWindow(tab, target, source)) {
      this.browser.toast(
        this.isPrivate(tab) !== target.isPrivate
          ? 'Tabs cannot move between private and regular windows.'
          : 'This tab cannot be moved there.',
        'info',
        source
      )
      return false
    }
    // The bookmarks bar of the other window files the page; the tab itself stays where it is.
    if (key?.startsWith('bookmark:')) return this.dropTab(tabId, key, target)
    const leaving = this.leaving(tab, source)
    // Where it lands when the pointer was not over a tab slot: the end of the window's space,
    // keeping the section (an essential has no place in a blank window and becomes pinned there).
    const targetSpace = target.activeSpace()
    const section: TabSection = tab.essential
      ? targetSpace.windowId
        ? 'pinned'
        : 'essential'
      : tab.pinned
        ? 'pinned'
        : 'regular'
    const fallback = `section:${section}:${section === 'essential' ? '' : targetSpace.id}`
    // A remote drop key names slots of the target window; a tab slot of a shared list is as
    // valid from another window as from this one. The content area's targets (a split edge, a
    // pane) take the tab once it is in the window.
    const content = key !== null && (key.startsWith('split:') || key.startsWith('pane:'))
    const dropped = key !== null && !content && this.dropTab(tabId, key, target)
    if (!dropped && !this.dropTab(tabId, fallback, target)) return false
    // "Sync only pinned tabs": an unpinned tab of a synced space belongs to one window.
    const landed = getSpace(this.model, tab.spaceId)
    if (landed && !landed.windowId && !tab.pinned && !tab.essential)
      tab.windowId = this.settings.windowSync === 'pinned' ? target.id : null
    if (content && key) this.dropTab(tabId, key, target)
    this.activateTab(tabId, target)
    this.showNeighbour(source, leaving, tabId)
    this.closeIfEmptied(source)
    this.browser.state.commit()
    target.host.focus()
    return true
  }

  /**
   * Chrome closes a window whose only tab went to another window – torn off, dropped into
   * another window, or sent there from the tab menu. A blank or private window with nothing
   * left does the same here (deferred: the drag that asked for the move may still be
   * finishing). A synced window keeps its spaces and stays.
   */
  private closeIfEmptied(source: ZenWindow): void {
    if (!source.localSpace || source.localSpace.tabIds.length > 0 || !source.alive) return
    defer(() => {
      if (source.alive) source.host.close()
    })
  }

  /**
   * What a window shows once one of its tabs goes to another window: the space it was selected
   * in and the neighbour to select instead (Firefox: the next tab, else the previous one), or
   * null when the window was not showing the tab.
   */
  private leaving(tab: Tab, source: ZenWindow): { space: Space; next: string | null } | null {
    const space = tab.essential ? source.activeSpace() : getSpace(this.model, tab.spaceId)
    if (!space || source.selectedTabIn(space) !== tab.id) return null
    return {
      space,
      next: nextTabAfterClose(
        this.model,
        space,
        tab.id,
        this.settings.containerSpecificEssentials,
        false,
        source.id
      )
    }
  }

  /** Apply `leaving` unless the move itself already picked another tab for the window. */
  private showNeighbour(
    source: ZenWindow,
    leaving: { space: Space; next: string | null } | null,
    tabId: string
  ): void {
    if (!leaving || !source.alive) return
    const { space, next } = leaving
    const current = source.selectedTabIn(space)
    if (current !== null && current !== tabId) return
    source.select(space, next)
    if (source.activeSpaceId !== space.id) return
    if (next) this.activateTab(next, source)
    else {
      this.releaseHidden(source)
      source.relayout()
    }
  }

  /**
   * Tear a tab off into a window of its own at `at` (screen point, the drop position), sized
   * like the window it came from. Which kind of window depends on where the tab lives: a tab of
   * a blank or private window gets another such window; under "sync only pinned tabs" an
   * unpinned tab gets a synced window that owns it; every other tab (shared across synced
   * windows) gets a blank window, the one kind that can hold it alone.
   */
  moveTabToNewWindow(
    tabId: string,
    at: Point | null = null,
    source: ZenWindow = this.windowFor(tabId)
  ): ZenWindow | null {
    const tab = this.tab(tabId)
    if (!tab) return null
    if (!this.browser.state.capabilities.windows) {
      this.browser.toast('Multiple windows are not available on this device.', 'info', source)
      return null
    }
    const leaving = this.leaving(tab, source)
    const from = getSpace(this.model, tab.spaceId)
    const ownsAlone =
      !tab.pinned && !tab.essential && !source.localSpace && this.settings.windowSync === 'pinned'
    const kind: WindowKind = source.isPrivate ? 'private' : ownsAlone ? 'synced' : 'unsynced'
    const size = source.bounds ?? source.host.normalBounds()
    const bounds =
      at && size
        ? {
            x: Math.round(at.x - Math.min(160, size.width / 4)),
            y: Math.round(at.y - 24),
            width: size.width,
            height: size.height
          }
        : null
    const win = this.browser.createWindow({ kind, from: source, bounds, empty: true })
    if (win.localSpace) {
      this.moveTab(
        tabId,
        {
          spaceId: win.localSpace.id,
          section: tab.pinned || tab.essential ? 'pinned' : 'regular',
          index: Number.MAX_SAFE_INTEGER
        },
        win
      )
    } else {
      tab.windowId = win.id
      if (from) win.activeSpaceId = from.id
    }
    this.activateTab(tabId, win)
    this.showNeighbour(source, leaving, tabId)
    this.closeIfEmptied(source)
    this.browser.state.commit()
    return win
  }

  /**
   * The folder menu's "Move Folder to New Window" (context-menus-107; Chrome's "Move group to
   * new window"): the folder's tabs go to a window of their own beside this one, the folder
   * with them – its name, colour and fold. Which kind of window is the tab's rule
   * (`moveTabToNewWindow`): a folder of a private window gets another private window; under
   * "sync only pinned tabs" a folder of unpinned members gets a synced window that owns them,
   * the folder staying in its space; every other folder – its tabs shared across synced windows
   * – gets a blank window, the one kind that can hold them alone, and follows them into its
   * space (the window's own, so the folder is that window's until it closes). A SAVED folder
   * opens first – its pages back as its tabs – and goes whole; a member's split view is left
   * behind (a split lives in one space of one window). Every window showing a member moves on
   * past the folder (Firefox's rule over the folder as one: the next tab beyond it, else the one
   * before it); the new window shows the member the source was showing, else the first. Returns
   * the new window, or null with nothing to move (an empty folder, none) or no windows on this
   * host.
   */
  moveFolderToNewWindow(
    folderId: string,
    source: ZenWindow = this.browser.focusedWindow()
  ): ZenWindow | null {
    const m = this.model
    const folder = m.folders[folderId]
    if (!folder) return null
    if (!this.browser.state.capabilities.windows) {
      this.browser.toast('Multiple windows are not available on this device.', 'info', source)
      return null
    }
    this.restoreSavedFolder(folderId, source)
    const members = folderTabs(m, folderId)
    const from = getSpace(m, folder.spaceId)
    if (members.length === 0 || !from) return null
    const member = (tabId: string | null): tabId is string =>
      tabId !== null && members.some((t) => t.id === tabId)
    const outside = (t: Tab): boolean => t.folderId !== folderId
    const showing = this.browser
      .allWindows()
      .map((w) => ({ w, selected: w.selectedTabIn(from) }))
      .filter((s): s is { w: ZenWindow; selected: string } => member(s.selected))
      .map(({ w, selected }) => {
        const ordered = orderedTabsForSpace(
          m,
          from,
          this.settings.containerSpecificEssentials,
          w.id
        )
        const at = ordered.findIndex((t) => t.id === selected)
        const next =
          ordered.slice(at + 1).find(outside) ??
          ordered.slice(0, Math.max(0, at)).reverse().find(outside) ??
          null
        return { w, selected, next: next?.id ?? null }
      })
    const shown = showing.find((s) => s.w === source)?.selected ?? members[0].id
    const ownsAlone =
      !from.windowId && this.settings.windowSync === 'pinned' && members.every((t) => !t.pinned)
    const kind: WindowKind = source.isPrivate ? 'private' : ownsAlone ? 'synced' : 'unsynced'
    const win = this.browser.createWindow({ kind, from: source, bounds: null, empty: true })
    for (const tab of members) removeTabFromSplit(m, tab.id)
    if (win.localSpace) {
      const space = win.localSpace
      for (const tab of members) {
        // The model's move (not the manager's): the folder is not left, it comes along.
        moveTab(
          m,
          tab,
          {
            spaceId: space.id,
            section: tab.pinned ? 'pinned' : 'regular',
            index: Number.MAX_SAFE_INTEGER
          },
          this.settings.essentialsMax
        )
        tab.folderId = folderId
      }
      folder.spaceId = space.id
    } else {
      for (const tab of members) tab.windowId = win.id
      win.activeSpaceId = from.id
    }
    this.activateTab(shown, win)
    for (const s of showing) this.showNeighbour(s.w, { space: from, next: s.next }, s.selected)
    this.closeIfEmptied(source)
    this.browser.state.commit()
    return win
  }

  /**
   * Move a tab one row along the strip as the keyboard does (tabs-34: Ctrl+Shift+PgUp / PgDn,
   * `tab.moveBackward` / `tab.moveForward`), `direction` being the way: past the row before it
   * or the row after it, in the order `win`'s strip draws them – the pinned rows; each group's
   * rows, group by group; the loose rows – and as a drag past that row would land it (`dropTab`):
   * beside a row of its own run it swaps places with it; at the edge of a group the next row is
   * another run's, and the tab crosses the boundary one row at a time – into the group beside it
   * at its near end, or out of its own to the row beside it – taking that row's group
   * (`moveToFolder`, which unfolds a collapsed group as a drop into it does) or losing its own.
   * At the strip's ends – the first pinned row, the last loose row – nothing moves. A pinned tab
   * stays among the pinned rows, as Chrome keeps its pinned tabs; Essentials tiles are no rows of
   * the strip and are not moved. A pane of a split is one segment of the split's row (§9.35):
   * moved, it passes the row beside the split's and leaves the split, as a segment dragged out
   * of the row does. Returns where the tab now stands – its place among the tabs of the run it
   * is in – or null when nothing moved.
   */
  moveTabBy(
    tabId: string,
    direction: -1 | 1,
    win: ZenWindow = this.windowFor(tabId)
  ): TabMoveResult | null {
    const m = this.model
    const tab = this.tab(tabId)
    if (!tab || tab.essential) return null
    const space = getSpace(m, tab.spaceId)
    if (!space) return null
    const groupOf = (t: Tab): string | null => this.groupIdOf(t)
    const run = tab.pinned ? pinnedTabs(m, space, win.id) : this.drawnRegular(space, win.id)
    const rows = this.rowsOf(run)
    const from = groupOf(tab)
    const at = rows.findIndex(
      (row) =>
        row.id === tabId ||
        (Boolean(tab.splitGroupId) &&
          row.splitGroupId === tab.splitGroupId &&
          groupOf(row) === from)
    )
    const neighbour = at === -1 ? undefined : rows[at + direction]
    if (!neighbour) return null
    const to = groupOf(neighbour)
    // Past a row of its own run: the far side of it. At a run's edge the next row is another
    // run's: the near side of it – one row over the boundary, not two.
    const after = from === to ? direction > 0 : direction < 0
    this.moveTab(
      tabId,
      {
        spaceId: space.id,
        section: tab.pinned ? 'pinned' : 'regular',
        index: this.indexRelativeTo(neighbour, after, tabId)
      },
      win
    )
    if (!tab.pinned && to !== (tab.folderId ?? null)) this.moveToFolder(tabId, to)
    if (neighbour.splitGroupId !== tab.splitGroupId) this.leaveSplitOnDrop(tab)
    const landed = tab.pinned
      ? pinnedTabs(m, space, win.id)
      : regularTabs(m, space, win.id).filter((t) => groupOf(t) === to)
    const group = (id: string | null): TabMoveResult['from'] =>
      id && m.folders[id] ? { folderId: id, name: m.folders[id].name } : null
    return {
      tabId,
      position: landed.findIndex((t) => t.id === tabId) + 1,
      count: landed.length,
      from: group(from),
      to: group(to),
      focused: false
    }
  }

  /**
   * A space's regular tabs in the order `win`'s strip draws them: each group's tabs in the
   * groups' order (`foldersOf`), then the loose ones – the renderer's `tabOrderOf` without the
   * Essentials and the pinned rows.
   */
  private drawnRegular(space: Space, windowId: string): Tab[] {
    const m = this.model
    const regular = regularTabs(m, space, windowId)
    const grouped = foldersOf(m, space.id).flatMap((f) =>
      regular.filter((t) => t.folderId === f.id)
    )
    const loose = regular.filter((t) => !t.folderId || !m.folders[t.folderId])
    return [...grouped, ...loose]
  }

  /** The group (folder) a regular tab's row is drawn under, if it still exists; null for a loose or pinned tab. */
  private groupIdOf(tab: Tab): string | null {
    return !tab.pinned && tab.folderId && this.model.folders[tab.folderId] ? tab.folderId : null
  }

  /**
   * A run's rows as the strip draws them (`stripRows` in the renderer, list by list): a split
   * group's panes in one list – the pinned rows, one group's rows, the loose rows – fold into
   * one row where the first of them stands, named here by that pane; a pane whose split has no
   * other pane in its list is a row of its own.
   */
  private rowsOf(run: Tab[]): Tab[] {
    const m = this.model
    const rows: Tab[] = []
    const folded = new Set<string>()
    for (const tab of run) {
      const group = tab.splitGroupId ? m.splitGroups[tab.splitGroupId] : undefined
      const list = this.groupIdOf(tab)
      const panes = group
        ? run.filter((t) => t.splitGroupId === group.id && this.groupIdOf(t) === list)
        : []
      if (group && panes.length > 1) {
        const key = `${group.id}:${list ?? ''}`
        if (folded.has(key)) continue
        folded.add(key)
      }
      rows.push(tab)
    }
    return rows
  }

  moveActiveTabToEdge(edge: 'start' | 'end', win: ZenWindow): void {
    const tab = this.activeTabFor(win)
    if (!tab || tab.essential) return
    this.moveTab(
      tab.id,
      {
        spaceId: tab.spaceId ?? undefined,
        section: tab.pinned ? 'pinned' : 'regular',
        index: edge === 'start' ? 0 : Number.MAX_SAFE_INTEGER
      },
      win
    )
  }

  /** Blank windows: move every local tab back into a real space (Zen's "Move to…" button). */
  moveLocalTabsToSpace(win: ZenWindow, spaceId: string): void {
    const local = win.localSpace
    const target = getSpace(this.model, spaceId)
    if (!local || !target || target.windowId) return
    for (const id of [...local.tabIds]) {
      const tab = this.tab(id)
      if (!tab) continue
      if (win.isPrivate) tab.containerId = target.containerId
      this.moveTab(
        id,
        { spaceId, section: tab.pinned ? 'pinned' : 'regular', index: Number.MAX_SAFE_INTEGER },
        win
      )
      // The page is bound to the private session; reload it in the target container.
      if (win.isPrivate) this.discard(id)
    }
    this.browser.state.commit()
  }

  // ---------------------------------------------------------------------------
  // Cycling
  // ---------------------------------------------------------------------------

  cycleTab(delta: number, win: ZenWindow): void {
    const space = win.activeSpace()
    let ordered = orderedTabsForSpace(
      this.model,
      space,
      this.settings.containerSpecificEssentials,
      win.id
    )
    const active = this.activeTabFor(win)
    if (this.settings.ctrlTabCyclesWithinSection && active) {
      ordered = ordered.filter(
        (t) => (t.essential || t.pinned) === (active.essential || active.pinned)
      )
    }
    if (ordered.length === 0) return
    const idx = active ? ordered.findIndex((t) => t.id === active.id) : -1
    const n = ordered.length
    const next = ordered[(((idx + delta) % n) + n) % n]
    if (next) this.activateTab(next.id, win, { userSwitch: true })
  }

  selectTabByIndex(index: number, win: ZenWindow): void {
    const space = win.activeSpace()
    const ordered = orderedTabsForSpace(
      this.model,
      space,
      this.settings.containerSpecificEssentials,
      win.id
    )
    const target = index === -1 ? ordered[ordered.length - 1] : ordered[index]
    if (target) this.activateTab(target.id, win, { userSwitch: true })
  }

  // ---------------------------------------------------------------------------
  // Split view
  // ---------------------------------------------------------------------------

  createSplit(
    tabIds: string[],
    layout: SplitLayout,
    win: ZenWindow = this.browser.focusedWindow()
  ): void {
    const m = this.model
    const space = win.activeSpace()
    const ids = tabIds.filter((id) => {
      const t = this.tab(id)
      return (
        t &&
        // A page tab joins a split as its registry entry allows (a chrome page does not, yet).
        this.browser.pages.splittable(t) &&
        tabVisibleIn(t, win.id) &&
        (!t.spaceId || !m.localSpaces[t.spaceId] || t.spaceId === space.id)
      )
    })
    // Space tabs must live in the active space – move them if needed (Zen splits within a space).
    // Essentials are visible in every space and can join as they are.
    for (const id of ids) {
      const t = this.tab(id)
      if (t && !t.essential && t.spaceId !== space.id)
        moveTab(
          m,
          t,
          {
            spaceId: space.id,
            section: t.pinned ? 'pinned' : 'regular',
            index: Number.MAX_SAFE_INTEGER
          },
          this.settings.essentialsMax
        )
    }
    const group = createSplitGroup(m, space.id, ids, layout)
    if (!group) return
    const active = this.activeTabFor(win)
    this.activateTab(active && group.tabIds.includes(active.id) ? active.id : group.tabIds[0], win)
  }

  /** Ctrl+Alt+G/V/H: toggle the layout of the active split, or split the active tab with the one below it. */
  toggleSplitLayout(layout: SplitLayout, win: ZenWindow): void {
    const active = this.activeTabFor(win)
    if (!active) return
    if (active.splitGroupId) {
      const group = this.model.splitGroups[active.splitGroupId]
      if (!group) return
      if (group.layout === layout) {
        dissolveSplitGroup(this.model, group.id)
      } else {
        group.layout = layout
      }
      this.browser.state.commit()
      return
    }
    const space = win.activeSpace()
    const list = orderedTabsForSpace(
      this.model,
      space,
      this.settings.containerSpecificEssentials,
      win.id
    ).map((t) => t.id)
    const idx = list.indexOf(active.id)
    const below = list[idx + 1] ?? list[idx - 1]
    if (!below) {
      this.browser.toast('Open another tab to create a split view.', 'info', win)
      return
    }
    this.createSplit([active.id, below], layout, win)
  }

  /** Zen 1.19: Alt+click a tab to split it with the active one; Alt+click a merged tab to separate it. */
  altClick(tabId: string, win: ZenWindow): void {
    const tab = this.tab(tabId)
    const active = this.activeTabFor(win)
    if (!tab || !active) return
    if (tab.splitGroupId && tab.splitGroupId === active.splitGroupId) {
      this.removeFromSplit(tabId, false, win)
      return
    }
    if (tab.id === active.id) return
    if (active.splitGroupId) this.addToSplit(active.splitGroupId, tabId)
    else this.createSplit([active.id, tabId], 'vertical', win)
  }

  setSplitLayout(groupId: string, layout: SplitLayout): void {
    const group = this.model.splitGroups[groupId]
    if (!group) return
    group.layout = layout
    this.browser.state.commit()
  }

  /**
   * The user is in a pane of the shown split other than the active one – its page's view took
   * the keyboard, or a press or a key landed in it (`isActivatingInput`: a scroll or a hover
   * never does, as in Chromium's activation model): that pane's tab becomes the active tab, so
   * the toolbar – back / forward / reload, the address pill, zoom, find – acts on the pane the
   * user is in and its header takes the accent bar (split-06; Chrome activates the view on a
   * click, Edge the pane). Only the panes of the split on screen trade the active state this
   * way: a page's view focused anywhere else (a Glance, a window this tab is not active in)
   * changes nothing.
   */
  private activatePaneOf(tabId: string): void {
    const tab = this.tab(tabId)
    if (!tab?.splitGroupId) return
    const win = this.windowFor(tabId)
    const active = this.activeTabFor(win)
    if (!active || active.id === tabId || active.splitGroupId !== tab.splitGroupId) return
    this.activateTab(tabId, win)
  }

  /**
   * Ctrl+Alt+Shift+Right / Left: the active state moves to the next / previous pane of the
   * shown split, in the split's order and around its end. Outside a split the chord does nothing
   * (no toast: the cycle-tab chords are the tab strip's).
   */
  cyclePane(delta: 1 | -1, win: ZenWindow): void {
    const active = this.activeTabFor(win)
    const group = active?.splitGroupId ? this.model.splitGroups[active.splitGroupId] : undefined
    if (!active || !group) return
    const n = group.tabIds.length
    const idx = group.tabIds.indexOf(active.id)
    const next = group.tabIds[(((idx + delta) % n) + n) % n]
    if (next && next !== active.id) this.activateTab(next, win)
  }

  /**
   * Swap Panes (split-07; Chrome's "Reverse position", Edge's "Swap" in the pane's More options):
   * the pane of `tabId` – the active pane when none is named – trades places with the pane after
   * it in the split's order, the last pane with the one before it, so a two-pane split reverses
   * and in a grid a pane steps along the reading order. Each tab keeps its size
   * (`swapSplitPanes`). The active pane stays the active tab wherever it lands; outside a split
   * the command does nothing (the row is not offered there).
   */
  swapPanes(tabId: string | undefined, win: ZenWindow = this.browser.focusedWindow()): void {
    const tab = tabId === undefined ? this.activeTabFor(win) : this.tab(tabId)
    const group = tab?.splitGroupId ? this.model.splitGroups[tab.splitGroupId] : undefined
    if (!tab || !group) return
    const at = group.tabIds.indexOf(tab.id)
    const other = at === group.tabIds.length - 1 ? at - 1 : at + 1
    if (swapSplitPanes(this.model, group.id, at, other)) this.browser.state.commit()
  }

  unsplit(groupId?: string, tabId?: string, win: ZenWindow = this.browser.focusedWindow()): void {
    let id = groupId
    if (!id) {
      const tab = this.tab(tabId) ?? this.activeTabFor(win)
      id = tab?.splitGroupId ?? undefined
    }
    if (!id) return
    dissolveSplitGroup(this.model, id)
    this.browser.state.commit()
    win.focusContent()
  }

  removeFromSplit(tabId: string, focus: boolean, win: ZenWindow = this.windowFor(tabId)): void {
    const tab = this.tab(tabId)
    if (!tab?.splitGroupId) return
    const group = this.model.splitGroups[tab.splitGroupId]
    removeTabFromSplit(this.model, tabId)
    if (focus) this.activateTab(tabId, win)
    else if (group?.tabIds[0] && win.selectedTabIn(win.activeSpace()) === tabId)
      this.activateTab(group.tabIds[0], win)
    this.browser.state.commit()
  }

  resizeSplit(groupId: string, sizes: number[]): void {
    const group = this.model.splitGroups[groupId]
    if (!group || sizes.length !== group.tabIds.length) return
    const total = sizes.reduce((a, b) => a + b, 0)
    if (total <= 0) return
    group.sizes = sizes.map((s) => Math.max(0.1, s / total))
    this.browser.state.commit()
  }

  newEmptySplit(win: ZenWindow): void {
    const active = this.activeTabFor(win)
    if (!active || active.essential) {
      this.createTab({ url: BLANK_URL, active: true }, win)
      return
    }
    if (active.splitGroupId) {
      const group = this.model.splitGroups[active.splitGroupId]
      if (group && group.tabIds.length >= 4) {
        this.browser.toast('Split views can hold up to 4 tabs.', 'info', win)
        return
      }
      const tab = this.createTab(
        { url: BLANK_URL, active: false, afterTabId: active.id, load: false },
        win
      )
      if (group) addTabToSplit(this.model, group.id, tab.id)
      this.activateTab(tab.id, win)
      this.openEmptyPaneField(win)
      return
    }
    const tab = this.createTab(
      { url: BLANK_URL, active: false, afterTabId: active.id, load: false },
      win
    )
    this.createSplit([active.id, tab.id], 'vertical', win)
    this.activateTab(tab.id, win)
    this.openEmptyPaneField(win)
  }

  /**
   * The URL bar for the empty pane just made (split-04): once the window holds the split, so the
   * bar opens as the pane's own field, floating in the pane beside the live page, and not over
   * the whole frame (BUG-040: the split was there but hidden under the bar until the first
   * address was typed).
   */
  private openEmptyPaneField(win: ZenWindow): void {
    this.browser.state.afterBroadcast(() =>
      this.browser.emit('urlbar.toggle', { mode: 'edit', text: '' }, win)
    )
  }

  /**
   * Whether a link in `tab`'s page has a pane to open in ("Open Link in Split View",
   * context-menus-24): the tab's page can be split – a chrome page cannot – and the split it is
   * in, if any, has room for the link's tab.
   */
  canSplitLink(tab: Tab): boolean {
    if (!this.browser.pages.splittable(tab)) return false
    const group = tab.splitGroupId ? this.model.splitGroups[tab.splitGroupId] : undefined
    return !group || group.tabIds.length < MAX_SPLIT_TABS
  }

  /**
   * The split shown in `win` when `tab` may join it as a pane ("Add Tab to Split View",
   * context-menus-92), else null: the active tab is in a split with room, the tab is not one of
   * its panes, its page can be split and it may join a split of that space (`joinable`).
   */
  shownSplitFor(tab: Tab, win: ZenWindow): SplitGroup | null {
    const active = this.activeTabFor(win)
    const group = active?.splitGroupId ? this.model.splitGroups[active.splitGroupId] : undefined
    if (!group || group.tabIds.includes(tab.id) || group.tabIds.length >= MAX_SPLIT_TABS)
      return null
    if (!this.browser.pages.splittable(tab) || !this.joinable(tab, group.spaceId, win)) return null
    return group
  }

  /**
   * Add Tab to Split View (context-menus-92, Vivaldi's row): the tab joins the split shown in
   * `win` as its last pane – moving into the split's space first, as a dropped tab does – and
   * is shown, the pane the user asked for. False when there is no split it may join.
   */
  addToShownSplit(tabId: string, win: ZenWindow): boolean {
    const tab = this.tab(tabId)
    const group = tab ? this.shownSplitFor(tab, win) : null
    if (!tab || !group) return false
    this.bringIntoSpace(tab, group.spaceId)
    if (!addTabToSplit(this.model, group.id, tab.id)) return false
    this.ensureLoaded(tab.id, win)
    this.claim(tab.id, win)
    this.activateTab(tab.id, win)
    this.browser.state.commit()
    return true
  }

  addToSplit(groupId: string, tabId: string): void {
    if (!this.browser.pages.splittable(this.tab(tabId))) return
    if (addTabToSplit(this.model, groupId, tabId)) {
      const group = this.model.splitGroups[groupId]
      const win = group
        ? this.browser.allWindows().find((w) => w.activeSpaceId === group.spaceId)
        : undefined
      this.ensureLoaded(tabId, win)
      if (win) this.claim(tabId, win)
      this.browser.state.commit()
    }
  }

  /**
   * "Choose a tab" in an empty pane (split-04, Edge's picker in the empty right pane): `tabId`
   * takes the pane over from the blank tab shown there – as a tab dropped on the pane does
   * (`replaceTabInSplit`, the tab moving into the split's space) – and is shown; the blank tab
   * was the pane's placeholder, nothing the user made, so it closes rather than staying behind
   * in the strip (an unvisited blank tab leaves no "Recently closed" entry). Only a blank tab of
   * a split is a pane to fill: the picker is offered nowhere else.
   */
  pickTabForPane(paneTabId: string, tabId: string, win: ZenWindow): boolean {
    const m = this.model
    const pane = this.tab(paneTabId)
    const tab = this.tab(tabId)
    const group = pane?.splitGroupId ? m.splitGroups[pane.splitGroupId] : null
    if (!pane || !tab || !group || !isBlankTabUrl(pane.url) || pane.id === tabId) return false
    if (group.tabIds.includes(tabId)) return false
    if (!this.browser.pages.splittable(tab) || !this.joinable(tab, group.spaceId, win)) return false
    this.bringIntoSpace(tab, group.spaceId)
    if (!replaceTabInSplit(m, group.id, pane.id, tabId)) return false
    this.activateTab(tabId, win)
    this.closeTab(pane.id, true, win)
    return true
  }

  /**
   * A tab dropped on one edge of the content area joins the split shown there, as a pane on
   * that side (`splitPlacement`: beside the others along the layout's axis, or spanning the edge
   * with the layout turned to the drop's axis); a pane of the split dropped on an edge moves to
   * that side. The dropped tab is shown. A full split says so and takes nothing.
   */
  private joinSplitAt(groupId: string, tabId: string, side: SplitSide, win: ZenWindow): boolean {
    const m = this.model
    const group = m.splitGroups[groupId]
    const tab = this.tab(tabId)
    if (!group || !tab) return false
    if (group.tabIds.includes(tabId)) {
      const { layout, index } = splitPlacement(group.layout, side, group.tabIds.length)
      group.tabIds = group.tabIds.filter((id) => id !== tabId)
      group.tabIds.splice(Math.min(index, group.tabIds.length), 0, tabId)
      group.layout = layout
      this.activateTab(tabId, win)
      return true
    }
    if (!this.browser.pages.splittable(tab) || !this.joinable(tab, group.spaceId, win)) return false
    if (group.tabIds.length >= MAX_SPLIT_TABS) {
      this.browser.toast(`Split views can hold up to ${MAX_SPLIT_TABS} tabs.`, 'info', win)
      return false
    }
    const { layout, index } = splitPlacement(group.layout, side, group.tabIds.length)
    this.bringIntoSpace(tab, group.spaceId)
    if (!addTabToSplit(m, groupId, tabId, index)) return false
    group.layout = layout
    this.activateTab(tabId, win)
    return true
  }

  /**
   * Whether a tab may join a split of `spaceId` shown in `win`: it is visible there, and it is
   * not held by another window's own (blank or private) space.
   */
  private joinable(tab: Tab, spaceId: string, win: ZenWindow): boolean {
    return (
      tabVisibleIn(tab, win.id) &&
      (!tab.spaceId || !this.model.localSpaces[tab.spaceId] || tab.spaceId === spaceId)
    )
  }

  /** A split lives in one space: a space tab from elsewhere moves in first (an essential is at home everywhere). */
  private bringIntoSpace(tab: Tab, spaceId: string): void {
    if (tab.essential || tab.spaceId === spaceId) return
    moveTab(
      this.model,
      tab,
      { spaceId, section: tab.pinned ? 'pinned' : 'regular', index: Number.MAX_SAFE_INTEGER },
      this.settings.essentialsMax
    )
  }

  // ---------------------------------------------------------------------------
  // Glance
  // ---------------------------------------------------------------------------

  openGlance(
    url: string,
    parentTabId: string,
    originX: number,
    originY: number,
    win: ZenWindow = this.windowFor(parentTabId)
  ): void {
    if (!isNavigableUrl(url) || win.glance) return
    const parent = this.tab(parentTabId) ?? this.activeTabFor(win)
    if (!parent) return
    const space = win.activeSpace()
    const tab = createTabRecord({
      spaceId: space.id,
      containerId: win.isPrivate ? PRIVATE_CONTAINER_ID : parent.containerId,
      url,
      windowId: win.id
    })
    this.model.tabs[tab.id] = tab
    win.glance = { tabId: tab.id, parentTabId: parent.id, originX, originY }
    this.ensureLoaded(tab.id, win)
    this.browser.state.commitVolatile()
    this.broadcastPageFlags()
  }

  closeGlance(win: ZenWindow): void {
    const glance = win.glance
    if (!glance) return
    win.glance = null
    this.destroyView(glance.tabId)
    delete this.model.tabs[glance.tabId]
    this.browser.governor.onTabRemoved(glance.tabId)
    this.browser.state.commit()
    this.broadcastPageFlags()
    win.focusContent()
  }

  /** Move the glance page into a real tab right after its parent. */
  expandGlance(win: ZenWindow): void {
    const glance = win.glance
    if (!glance) return
    const tab = this.tab(glance.tabId)
    const parent = this.tab(glance.parentTabId)
    win.glance = null
    if (!tab) return
    const space = win.activeSpace()
    const index =
      parent && !parent.essential && parent.spaceId === space.id
        ? sectionIndexOf(this.model, parent) + 1
        : undefined
    tab.pinned = false
    insertTabIntoSpace(this.model, space, tab, parent?.pinned ? undefined : index)
    tab.windowId = this.ownerWindowIdFor(tab, space, win)
    this.activateTab(tab.id, win)
    this.broadcastPageFlags()
  }

  splitGlance(win: ZenWindow): void {
    const glance = win.glance
    if (!glance) return
    const tab = this.tab(glance.tabId)
    const parent = this.tab(glance.parentTabId)
    win.glance = null
    if (!tab) return
    const space = win.activeSpace()
    insertTabIntoSpace(
      this.model,
      space,
      tab,
      parent && !parent.essential ? sectionIndexOf(this.model, parent) + 1 : undefined
    )
    tab.windowId = this.ownerWindowIdFor(tab, space, win)
    if (parent) this.createSplit([parent.id, tab.id], 'vertical', win)
    else this.activateTab(tab.id, win)
    this.broadcastPageFlags()
  }

  // ---------------------------------------------------------------------------
  // Misc page operations
  // ---------------------------------------------------------------------------

  copyUrl(tabId: string, markdown = false): void {
    const tab = this.tab(tabId)
    if (!tab) return
    // An error page copies the address it stands in for; an internal page its user-facing
    // `zenium://` alias (`zen://` never leaves `tab.url`); an extension page its
    // `chrome-extension://` address, never the Android runtime's emulated origin.
    const url = tab.url.startsWith(ERROR_URL_PREFIX)
      ? (safeParam(tab.url, 'url') ?? tab.url)
      : presentedUrl(tab.url)
    // The one copy desktop has always confirmed, in its own words.
    this.browser.copyText(
      markdown ? `[${tab.customTitle ?? tab.title}](${url})` : url,
      markdown ? 'Link copied as Markdown' : 'Link copied',
      this.windowFor(tabId),
      markdown ? 'Copied URL as Markdown' : 'Copied URL'
    )
  }

  /**
   * The developer tools open at the remembered dock (`settings.devtoolsDock`; §9.29) – the
   * default for every opening; where this tab's toolbox then stands is the tab's own
   * (`Tab.devtools`, from the host's `onDevtoolsOpened`).
   */
  toggleDevtools(tabId: string, mode: 'toggle' | 'inspect' | 'console' = 'toggle'): void {
    if (!this.browser.state.capabilities.devtools) {
      this.browser.toast('Developer tools are not available on this device.')
      return
    }
    this.view(tabId)?.openDevTools(mode, this.browser.state.settings.devtoolsDock)
  }

  /**
   * Where the developer tools stand (design language v2 §9.29: "bottom or right, the user's last
   * choice remembered, undocked on offer"). The choice is kept in the settings for every later
   * opening; from the app menu's rows (`move`, the default) every open toolbox moves to it as
   * well, where the host can move one (`TabView.setDevtoolsDock`), and each such tab's own
   * reading (`Tab.devtools`) takes the dock at once – the frame follows the click, and the
   * host's read-back confirms it. A choice read back from a toolbox's own buttons
   * (`onDevtoolsDockChanged`) is remembered alone: that toolbox has moved itself, and the
   * others stand as Chrome's do until they are next opened.
   */
  setDevtoolsDock(dock: DevtoolsDock, win: ZenWindow, options: { move?: boolean } = {}): void {
    const state = this.browser.state
    if (!state.capabilities.devtools) return
    if (state.settings.devtoolsDock !== dock)
      this.browser.updateSettings({ devtoolsDock: dock }, win)
    if (options.move === false) return
    let moved = false
    for (const tabId of state.devtoolsOpenFor) {
      const view = this.view(tabId)
      if (!view?.setDevtoolsDock) continue
      view.setDevtoolsDock(dock)
      const tab = this.tab(tabId)
      if (tab && tab.devtools?.dock !== dock) {
        tab.devtools = { dock }
        moved = true
      }
    }
    if (moved) state.commitVolatile()
  }

  unloadSpace(spaceId: string): void {
    const space = getSpace(this.model, spaceId)
    if (!space) return
    const visible = this.allVisibleTabIds()
    for (const id of space.tabIds) if (!visible.has(id) && this.views.has(id)) this.discard(id)
    const shownSomewhere = this.browser.allWindows().some((w) => w.activeSpaceId === spaceId)
    if (!shownSomewhere) {
      for (const t of essentialsForSpace(this.model, space, true))
        if (this.views.has(t.id) && !visible.has(t.id)) this.discard(t.id)
    }
  }

  /**
   * A window is closing: hand its pages to another synced window (they stay loaded), drop the
   * temporary tabs of blank / private windows, and – unless the app is quitting – close the tabs
   * that were local to this window.
   */
  releaseWindow(win: ZenWindow, quitting: boolean): void {
    const m = this.model
    if (win.glance) this.closeGlance(win)
    const others = this.browser
      .allWindows()
      .filter((w) => w !== win && w.kind === 'synced' && w.alive)
    // Tabs that go away with the window; remembered as one "Recently Closed" window entry. Their
    // back/forward stacks must be read before the pages below are destroyed.
    const leaving: Tab[] = win.localSpace
      ? win.localSpace.tabIds.map((id) => this.tab(id)).filter((t): t is Tab => Boolean(t))
      : quitting || others.length === 0
        ? []
        : Object.values(m.tabs).filter((t) => t.windowId === win.id)
    const now = Date.now()
    const closedTabs: ClosedTabEntry[] = []
    for (const tab of leaving) {
      const entry = this.captureClosed(tab, sectionIndexOf(m, tab), now)
      if (entry) closedTabs.push(entry)
    }
    const activeTabId = win.selectedTabIn(win.activeSpace())
    for (const [tabId, view] of this.viewsOwnedBy(win)) {
      const tab = this.tab(tabId)
      const local = !tab || tab.windowId === win.id
      if (!local && others.length > 0 && !view.isDestroyed()) {
        view.detach()
        view.setVisible(false)
        this.owners.set(tabId, others[0])
        view.attachTo(others[0].host)
        others[0].relayout()
        view.postToPage?.({ type: 'display-mode', mode: this.browser.displayModeFor(tabId) })
      } else {
        if (tab) this.rememberNavigation(tabId, view)
        this.destroyView(tabId)
        if (tab) {
          tab.discarded = true
          tab.frozen = false
          tab.cpuThrottle = 1
          tab.loading = false
          tab.waiting = false
          tab.progress = 0
          tab.audible = false
          tab.devtools = null
        }
      }
    }
    if (win.localSpace) {
      for (const id of [...win.localSpace.tabIds]) {
        if (!this.tab(id)) continue
        removeTabFromSplit(m, id)
        removeTabFromLists(m, id)
        delete m.tabs[id]
      }
      // A folder in the window's own space – moved here with its tabs (`moveFolderToNewWindow`)
      // – is no window's once this one closes: it goes with the space, its saved pages with it.
      for (const folder of Object.values(m.folders))
        if (folder.spaceId === win.localSpace.id) {
          this.browser.liveFolders.onFolderDeleted(folder.id)
          delete m.folders[folder.id]
        }
      delete m.localSpaces[win.localSpace.id]
    } else if (!quitting) {
      for (const tab of Object.values(m.tabs)) {
        if (tab.windowId !== win.id) continue
        if (others.length === 0) {
          // Last window: keep the tabs so the session restores them.
          tab.windowId = null
          continue
        }
        removeTabFromSplit(m, tab.id)
        removeTabFromLists(m, tab.id)
        delete m.tabs[tab.id]
      }
    }
    for (const t of closedTabs) this.pendingNavigation.delete(t.tab.id)
    if (closedTabs.length > 0)
      this.browser.session.pushWindow(
        closedWindowEntry(win.kind, win.bounds, activeTabId, closedTabs, now)
      )
    this.browser.updateMedia()
  }

  /**
   * Sleeping tabs (Edge's; Chrome's Memory Saver): discard every loaded, invisible tab whose last
   * activity is older than the timeout. Pages that are heard, still loading, open in DevTools,
   * driven by an agent or on the "never put to sleep" list stay. The host's governor calls this
   * on its cadence (`NoopGovernor` every half minute, so the shortest timeout is honoured).
   */
  unloadInactive(): void {
    if (!this.settings.unloadEnabled) return
    const timeout = this.settings.unloadTimeoutMinutes * 60_000
    const now = Date.now()
    for (const tab of this.sleepCandidates(true)) {
      if (now - tab.lastActiveAt < timeout) continue
      this.discard(tab.id)
    }
  }

  /**
   * The system is short of memory (Android's `onTrimMemory`): put hidden pages to sleep ahead of
   * their timeout rather than have the whole process killed, and the sooner the more pressing.
   * `low` (the device is running low; the process is not yet killable) sleeps the hidden pages
   * idle longest and keeps the `KEEP_UNDER_PRESSURE` most recent ones, so the next switch is
   * still quick, and honours the never-sleep list; `critical` (the process is about to be
   * killed) sleeps every hidden page but the ones being heard – a killed process loses the
   * never-sleep sites too, and their pages come back on focus like any other. Independent of
   * the timer's switch: pressure is not a preference.
   */
  unloadForMemoryPressure(level: 'low' | 'critical'): void {
    const candidates = this.sleepCandidates(level === 'low').sort(
      (a, b) => a.lastActiveAt - b.lastActiveAt
    )
    const keep = level === 'low' ? KEEP_UNDER_PRESSURE : 0
    const sleeping =
      keep > 0 ? candidates.slice(0, Math.max(0, candidates.length - keep)) : candidates
    for (const tab of sleeping) this.discard(tab.id)
  }

  /**
   * The loaded pages that may be put to sleep right now: not shown in any window, not playing
   * audio, not loading, not open in DevTools, not driven by an agent and – when `honourList` –
   * not on the never-sleep list. An entry matches a page by its host, `www.` aside (the phone's
   * Add sheet writes a host), or by the site's registrable domain (`getDomain`, the form the
   * desktop's Add current site and the pill's Never unload this site write: `google.com` for a
   * page of `mail.google.com`, so every page of the site stays loaded).
   */
  private sleepCandidates(honourList: boolean): Tab[] {
    const visible = this.allVisibleTabIds()
    const excluded = this.settings.unloadExcludedDomains.map((d) => d.toLowerCase())
    const out: Tab[] = []
    for (const [id] of this.views) {
      const tab = this.tab(id)
      if (!tab || visible.has(id) || tab.audible || tab.loading) continue
      if (honourList && neverUnloaded(tab.url, excluded)) continue
      if (this.browser.state.devtoolsOpenFor.has(id)) continue
      if (this.browser.agents.isDriving(id)) continue
      out.push(tab)
    }
    return out
  }

  destroyAll(): void {
    for (const id of [...this.views.keys()]) this.destroyView(id)
  }

  /**
   * The host is tearing itself down with the tabs still open – Android's Activity destroyed
   * under a relaunch or a configuration change, the process and this core living on for a
   * moment. Its views go with it, silently or not: a `destroyed` that still arrives is not a
   * page close (`onViewGone`), and no tab leaves the model. Nothing is destroyed from here –
   * the host has already dropped its views, and a dead host hears no `view.destroy`.
   */
  onHostTeardown(): void {
    this.hostGone = true
  }
}

function pickFavicon(favicons: string[]): string | null {
  const usable = favicons.filter((f) => /^(https?:|data:)/.test(f))
  return usable[0] ?? null
}

export function isTabSection(value: string): value is TabSection {
  return value === 'pinned' || value === 'regular' || value === 'essential'
}

function safeParam(url: string, name: string): string | null {
  try {
    return new URL(url).searchParams.get(name)
  } catch {
    return null
  }
}

/** Whether `url` is the crash page (`zen://error?code=-1`, `crashPageUrl`), whichever variant. */
function isCrashPageUrl(url: string): boolean {
  return url.startsWith(ERROR_URL_PREFIX) && safeParam(url, 'code') === String(CRASH_ERROR_CODE)
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * Whether the never-sleep list (`settings.unloadExcludedDomains`, lower-cased) names the page
 * at `url`: by its host with `www.` aside, or by its registrable domain – the two forms the
 * list's writers use (`sleepCandidates`).
 */
export function neverUnloaded(url: string, excluded: readonly string[]): boolean {
  if (excluded.length === 0) return false
  const host = domainOf(url)
  if (!host) return false
  const site = getDomain(url)
  return excluded.some((d) => d === host || (site !== '' && d === site))
}

/**
 * The origins a pre-migration "Mute Site" host stood for: the old rule matched the hostname with
 * `www.` stripped, so a site name covers its https origin and its `www.` one; an address or a
 * single-label name (`localhost`, a LAN box) has no `www.` and is as likely plain http.
 */
export function soundSitesOfMutedHost(host: string): string[] {
  const name = host.trim().toLowerCase()
  if (!name || /[\s/|]/.test(name)) return []
  const address = /^[\d.]+$/.test(name) || name.includes(':') || !name.includes('.')
  if (address) return [`https://${name}`, `http://${name}`]
  return [`https://${name}`, `https://www.${name}`]
}
