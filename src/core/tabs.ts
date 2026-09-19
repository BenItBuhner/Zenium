import type {
  CertificateError,
  ClosedTabEntry,
  HistoryTransition,
  NavigationSnapshot,
  Point,
  Settings,
  Space,
  SplitLayout,
  Tab,
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
  getSpace,
  insertTabIntoSpace,
  loadProgressAfter,
  moveTab,
  nextTabAfterClose,
  orderedTabsForSpace,
  pinnedTabs,
  regularTabs,
  removeTabFromLists,
  removeTabFromSplit,
  sectionIndexOf,
  tabVisibleIn,
  type Model
} from './model'
import {
  BLANK_URL,
  ERROR_URL_PREFIX,
  errorPageCertificate,
  errorPageUrl,
  httpsOnlyPageUrl,
  interstitialKindOf,
  isEmptyTabUrl,
  isNavigableUrl,
  safeBrowsingPageUrl,
  titleForUrl
} from '../shared/url'
import { internalPageAliasUrl } from '../shared/internalPages'
import type { Browser } from './browser'
import type { ZenWindow } from './window'
import { describeNetError, HTTP_FALLBACK_CODES, overlayForUrl } from '../shared/zenPages'
import { isCertificateError } from '../shared/siteInfo'
import type { InterstitialAction } from '../shared/interstitial'
import { closedTabEntry, closedWindowEntry } from './session'
import { newId } from '../shared/ids'
import { clampZoom, stepZoom } from '../shared/pageControls'
import { defer, type PageFlags, type TabView, type TabViewEvents } from './platform'
import { safeOrigin } from './permissions'
import { certificateSiteOf } from './security'
import { openedWindowKind, planWindowOpen } from './windowOpen'
import { parseDropKey } from './tabDrag'

export type { PageFlags } from './platform'

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
  /** How the next committed navigation of a tab came about (for the history record). */
  private readonly pendingTransition = new Map<string, HistoryTransition>()

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
        void view.restoreNavigation({ entries: snapshot.entries, index })
      } else {
        // Asked to go somewhere else meanwhile (typed into the pill while unloaded): the new
        // page goes on top of the stack and the forward entries go, as in Chrome.
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
      onStartLoading: () =>
        update((t) => {
          t.loading = true
          t.progress = 0
        }, true),
      onStopLoading: () => {
        this.browser.governor.onLoadFinished(tabId)
        update((t) => {
          const v = view()
          t.loading = false
          t.progress = 1
          t.canGoBack = v?.canGoBack() ?? false
          t.canGoForward = v?.canGoForward() ?? false
        })
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
          this.browser.security.cancelForTab(tabId)
          this.browser.permissionPrompts.cancelForTab(tabId)
          this.browser.permissions.onTabNavigated(tabId, url)
        }
        if (v) this.onNavigated(tabId, v, url, inPage)
      },
      onTitleUpdated: (title) =>
        update((t) => {
          t.title = title || titleForUrl(t.url)
          if (!this.isPrivate(t)) this.browser.history.updateTitle(t.url, t.title)
        }),
      onFaviconUpdated: (favicons) =>
        update((t) => {
          const icon = pickFavicon(favicons)
          if (icon) {
            t.favicon = icon
            if (!this.isPrivate(t)) {
              this.browser.history.updateFavicon(t.url, icon)
              this.browser.bookmarks.updateFavicon(t.url, icon)
            }
          }
        }),
      onFailLoad: (code, description, url, details) => {
        const v = view()
        if (code === -3 || !v) return
        // A link to a download the server refused: the downloads host made the failed row Chrome
        // shows for it ("Failed · No file"), and the tab stays as it was, as with the
        // `ERR_ABORTED` of a download that did start.
        if (this.browser.downloads.takeDeadLink(tabId, url)) return
        this.browser.governor.onLoadFinished(tabId)
        const failed = (certificateError: CertificateError | null = null): void =>
          update((t) => {
            t.errorCode = code
            t.certificateError = certificateError
            t.loading = false
            t.progress = 1
          })
        // The host's request engine refused the navigation on Safe Browsing's word.
        const unsafe = this.browser.protection.safeBrowsing.takePendingBlock(tabId, url)
        if (unsafe) {
          this.httpsUpgraded.delete(tabId)
          failed()
          v.loadURL(safeBrowsingPageUrl(url, unsafe.threat))
          return
        }
        const plaintext = this.httpsUpgraded.get(tabId)
        if (plaintext && url.startsWith('https://') && HTTP_FALLBACK_CODES.has(code)) {
          this.httpsUpgraded.delete(tabId)
          const { protection } = this.browser
          if (protection.httpsOnly !== 'off' && !protection.allowsPlaintext(plaintext)) {
            // HTTPS-only mode asks before loading the page over plaintext.
            failed()
            v.loadURL(httpsOnlyPageUrl(plaintext, code))
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
        const page = errorPageUrl(
          code,
          description || describeNetError(code, ''),
          url,
          certificateError?.certificate
        )
        if (certificateError && v.showErrorPage) this.showInterstitial(tabId, v, url, page)
        else v.loadURL(page)
      },
      onUpgraded: (from, to) => this.noteUpgrade(tabId, from, to),
      onUnsafeNavigation: (url, hit) =>
        this.browser.protection.safeBrowsing.notePendingBlock(tabId, url, hit),
      onCrashed: (reason) => {
        if (reason === 'clean-exit') return
        const tab = this.tab(tabId)
        if (!tab) return
        const title = tab.customTitle ?? tab.title
        const outOfMemory = reason === 'oom' || reason === 'memory-eviction'
        const visible = this.allVisibleTabIds().has(tabId)
        // A V8 heap-cap OOM is reported as `oom` on Windows / Android but as a plain `crashed` on
        // Linux. Either way a page nobody is looking at is better unloaded than replaced by an
        // error page in a fresh renderer: keep the tab, drop the page, reload on activation.
        if (outOfMemory || !visible) {
          const why = outOfMemory ? 'the page ran out of memory' : `the page crashed (${reason})`
          this.browser.governor.record('discard', tabId, why, title)
          this.discard(tabId)
          this.browser.toast(
            outOfMemory
              ? `"${title}" ran out of memory and was unloaded.`
              : `"${title}" crashed and was unloaded.`,
            'error',
            ownerWindow()
          )
          return
        }
        this.browser.toast(`"${title}" crashed (${reason}).`, 'error', ownerWindow())
        view()?.loadURL(errorPageUrl(-1, `The page crashed (${reason})`, tab.url))
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
      },
      onLeaveHtmlFullscreen: () => {
        for (const w of this.browser.allWindows()) {
          if (w.htmlFullscreenTabId === tabId) {
            w.htmlFullscreenTabId = null
            w.relayout()
          }
        }
        state.commitVolatile()
        this.browser.fullscreen.onHtmlFullscreen(tabId, false)
      },
      onDevtoolsOpened: () => {
        state.devtoolsOpenFor.add(tabId)
        state.commitVolatile()
      },
      onDevtoolsClosed: () => {
        state.devtoolsOpenFor.delete(tabId)
        state.commitVolatile()
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
      onTargetUrl: (url) => this.browser.emit('status', { text: url }, ownerWindow()),
      onDomReady: () => {
        this.sendPageFlags(tabId)
        this.browser.onPageReady(tabId)
      },
      onDestroyed: () => this.onViewGone(tabId),
      onUserActivation: () => this.browser.popups.activate(tabId),
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
              : owner
            return this.adoptView(
              view,
              { tabId: newId('tab'), parentTabId: tabId, active: opensWindow || plan.active },
              win
            )
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
    if (!url || tab.url === url) return
    tab.url = url
    tab.title = view.getTitle() || titleForUrl(url)
    this.browser.state.commit()
  }

  isPrivate(tab: Tab): boolean {
    return tab.containerId === PRIVATE_CONTAINER_ID
  }

  private onNavigated(tabId: string, view: TabView, url: string, inPage = false): void {
    const tab = this.tab(tabId)
    if (!tab) return
    if (!url.startsWith(ERROR_URL_PREFIX)) {
      tab.errorCode = null
      this.httpsUpgraded.delete(tabId)
    }
    tab.certificateError = this.certificateErrorOf(tab, url)
    this.followSiteMute(tab, view, tab.url, url)
    tab.url = url
    tab.title = view.getTitle() || titleForUrl(url)
    tab.canGoBack = view.canGoBack()
    tab.canGoForward = view.canGoForward()
    tab.bookmarked = this.browser.bookmarks.has(url)
    this.browser.pageControls.onNavigated(tab, view)
    view.setBackgroundColor(this.backgroundFor(url))
    view.setPopupsAllowed?.(this.browser.popups.siteAllowed(url))
    const transition = this.pendingTransition.get(tabId) ?? 'link'
    this.pendingTransition.delete(tabId)
    if (!this.isPrivate(tab))
      this.browser.history.visit(url, tab.title, tab.favicon, { transition, tabId })
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
    const flags: PageFlags = {
      glanceEnabled: this.settings.glanceEnabled && !owner?.glance,
      glanceTrigger: this.settings.glanceTrigger,
      thirdParty: tab.pinned || tab.essential ? this.settings.thirdPartyOnPinned : null
    }
    view.sendPageFlags(flags)
  }

  broadcastPageFlags(): void {
    for (const id of this.views.keys()) this.sendPageFlags(id)
  }

  /** The pop-up rule of `origin` changed: tell every live page of that site. */
  syncPopupPolicy(origin: string): void {
    for (const [id, view] of this.views) {
      const tab = this.tab(id)
      if (tab && safeOrigin(tab.url) === origin)
        view.setPopupsAllowed?.(this.browser.popups.siteAllowed(tab.url))
    }
  }

  destroyView(tabId: string): void {
    const view = this.views.get(tabId)
    if (!view) return
    this.views.delete(tabId)
    this.httpsUpgraded.delete(tabId)
    this.browser.protection.safeBrowsing.forgetTab(tabId)
    this.browser.externalProtocols.cancelForTab(tabId)
    this.pendingTransition.delete(tabId)
    this.browser.popups.onTabGone(tabId)
    this.browser.security.cancelForTab(tabId)
    this.browser.permissionPrompts.cancelForTab(tabId)
    this.browser.permissions.onTabGone(tabId)
    this.browser.pageDialogs.cancelForTab(tabId)
    this.browser.autofill.onTabGone(tabId)
    this.browser.fullscreen.onTabGone(tabId)
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
    // The page goes, its history stays: the tab picks the stack up again when it is loaded.
    this.rememberNavigation(tabId)
    this.destroyView(tabId)
    tab.discarded = true
    tab.frozen = false
    tab.cpuThrottle = 1
    tab.loading = false
    tab.progress = 0
    tab.audible = false
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
      folderId?: string | null
      load?: boolean
      /** The plain host typed into the URL bar when `url` is its https:// upgrade (http fallback). */
      upgradedFrom?: string
      /** Preset id (hosts that must know the id before the tab exists, e.g. adopted popups). */
      id?: string
      /** The tab whose page opened this one (see `Tab.openerTabId`). */
      openerTabId?: string
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
      muted: this.siteMuted(opts.url ?? BLANK_URL)
    })
    tab.windowId = this.ownerWindowIdFor(tab, space, win)
    m.tabs[tab.id] = tab
    if (tab.essential) {
      if (m.essentialTabIds.length >= this.settings.essentialsMax) {
        tab.essential = false
        tab.pinned = true
        tab.spaceId = space.id
        insertTabIntoSpace(m, space, tab, 0)
      } else {
        m.essentialTabIds.push(tab.id)
      }
    } else {
      let index: number | undefined
      const after = this.tab(opts.afterTabId)
      if (after && after.spaceId === space.id && after.pinned === tab.pinned) {
        index = sectionIndexOf(m, after) + 1
        tab.folderId = tab.folderId ?? after.folderId
      } else if (this.settings.newTabPosition === 'after-current' && !tab.pinned) {
        const current = this.tab(win.selectedTabIn(space))
        if (current && current.spaceId === space.id && !current.pinned)
          index = sectionIndexOf(m, current) + 1
      }
      insertTabIntoSpace(m, space, tab, index)
    }
    tab.bookmarked = this.browser.bookmarks.has(tab.url)
    // Set before the load below so an active tab's single activation load (or a background load)
    // is eligible for the http fallback straight away.
    if (opts.upgradedFrom) this.httpsUpgraded.set(tab.id, `http://${opts.upgradedFrom}`)
    if (opts.active !== false) {
      this.activateTab(tab.id, win)
    } else if (opts.load !== false && tab.url !== BLANK_URL) {
      this.ensureLoaded(tab.id, win, { background: true })
    }
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
    tab.title = view.getTitle() || titleForUrl(tab.url)
    if (tab.muted) view.setMuted(true)
    if (tab.zoom !== 1) view.setZoom(tab.zoom)
    return this.eventsFor(tabId)
  }

  /**
   * The page went away underneath its tab – a popup called `window.close()`, or the host tore
   * the view down on its own. The dead view is dropped without being touched again and the tab
   * closes as if the user had closed it. Views the core destroys itself are already forgotten
   * by the time the host reports them, so this only ever acts on page-initiated closes.
   */
  private onViewGone(tabId: string): void {
    const view = this.views.get(tabId)
    if (!view) return
    const owner = this.owners.get(tabId)
    this.views.delete(tabId)
    this.owners.delete(tabId)
    this.httpsUpgraded.delete(tabId)
    this.pendingTransition.delete(tabId)
    this.browser.externalProtocols.cancelForTab(tabId)
    this.browser.popups.onTabGone(tabId)
    this.browser.security.cancelForTab(tabId)
    this.browser.pageDialogs.cancelForTab(tabId)
    this.browser.governor.onViewDestroyed(tabId, view)
    this.browser.state.devtoolsOpenFor.delete(tabId)
    const tab = this.tab(tabId)
    if (!tab) return
    if (tab.pinned || tab.essential || this.unloadChecks.has(tabId)) {
      // Pinned tabs survive their page: they simply show as unloaded until clicked again. So does
      // a tab whose page went under a window's or the app's unload check – the window may yet stay
      // open (another page's "Stay"), and the tab is then simply unloaded, its stack kept.
      this.discard(tabId)
      return
    }
    this.closeTab(tabId, true, owner)
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
  async requestClose(tabId: string, force = false, win?: ZenWindow): Promise<boolean> {
    if (!(await this.confirmUnload(tabId))) return false
    this.closeTab(tabId, force, win)
    return true
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

  activateTab(tabId: string, win: ZenWindow = this.browser.focusedWindow()): void {
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
    if (previousActive && previousActive.id !== tab.id) previousActive.lastActiveAt = Date.now()
    if (win.glance && win.glance.parentTabId !== tab.id && win.glance.tabId !== tab.id) {
      this.closeGlance(win)
    }
    for (const id of this.visibleTabIds(win)) {
      this.ensureLoaded(id, win)
      this.claim(id, win)
    }
    this.releaseHidden(win)
    this.browser.governor.wakeVisible(win)
    win.findResult = null
    this.browser.state.commit()
    win.focusContent()
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
   * closing (default: reset to the pinned URL, unload and switch to the next tab).
   */
  closeTab(tabId: string, force = false, win?: ZenWindow): void {
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
          if (next) this.activateTab(next, source)
        }
        this.browser.state.commit()
        return
      }
    }
    const space = getSpace(m, tab.spaceId)
    const index = sectionIndexOf(m, tab)
    // The back/forward stack has to be read while the page still exists.
    const closed = this.captureClosed(tab, index, Date.now())
    // Every window that had this tab selected picks a neighbour (Firefox: next, else previous).
    const reselect: Array<{ w: ZenWindow; s: Space; next: string | null }> = []
    for (const w of this.browser.allWindows()) {
      const candidates = tab.essential ? (w.localSpace ? [] : m.spaces) : space ? [space] : []
      for (const s of candidates) {
        if (w.selectedTabIn(s) !== tabId) continue
        reselect.push({
          w,
          s,
          next: nextTabAfterClose(
            m,
            s,
            tabId,
            this.settings.containerSpecificEssentials,
            false,
            w.id
          )
        })
      }
    }
    removeTabFromSplit(m, tabId)
    removeTabFromLists(m, tabId)
    delete m.tabs[tabId]
    this.browser.state.tabNavigation.delete(tabId)
    this.destroyView(tabId)
    this.browser.governor.onTabRemoved(tabId)
    this.browser.pages.onTabRemoved(tabId)
    this.browser.agents.onTabRemoved(tabId)
    this.browser.find.forget(tabId)
    this.browser.webApps.onTabRemoved(tabId)
    this.browser.liveFolders.onTabLeftFolder(tabId, tab.folderId)
    if (closed) this.browser.session.pushTab(closed)
    for (const { w, s, next } of reselect) {
      w.select(s, next)
      if (w.activeSpaceId === s.id && next) this.activateTab(next, w)
      // A toolbar-only popup has no sidebar to open another tab from: like Chrome's, it closes
      // with its last tab (deferred – the close may be arriving from the page going away).
      else if (!next && w.chrome === 'popup') {
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

  closeOthers(tabId: string, win: ZenWindow = this.windowFor(tabId)): void {
    const tab = this.tab(tabId)
    if (!tab || tab.essential) return
    const space = getSpace(this.model, tab.spaceId) ?? win.activeSpace()
    for (const id of [...space.tabIds]) {
      const t = this.tab(id)
      if (t && id !== tabId && !t.pinned && tabVisibleIn(t, win.id)) this.closeTab(id, false, win)
    }
    this.activateTab(tabId, win)
  }

  closeBelow(tabId: string, win?: ZenWindow): void {
    this.closeRelative(tabId, 'below', win)
  }

  closeAbove(tabId: string, win?: ZenWindow): void {
    this.closeRelative(tabId, 'above', win)
  }

  private closeRelative(tabId: string, direction: 'above' | 'below', win?: ZenWindow): void {
    const tab = this.tab(tabId)
    if (!tab || tab.essential) return
    const source = win ?? this.windowFor(tabId)
    const space = getSpace(this.model, tab.spaceId) ?? source.activeSpace()
    const ids = space.tabIds.filter((id) => {
      const t = this.tab(id)
      return t && t.pinned === tab.pinned && tabVisibleIn(t, source.id)
    })
    const idx = ids.indexOf(tabId)
    if (idx === -1) return
    const victims = direction === 'below' ? ids.slice(idx + 1) : ids.slice(0, idx)
    for (const id of victims) this.closeTab(id, true, source)
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
    // An internal page: a chrome page (Settings) lives in a tab of its own, or in its overlay on
    // hosts without page tabs, and the document in this tab stays where it is; a document page
    // the window already shows is focused instead. Otherwise the URL loads here like any other.
    if (this.browser.pages.routeNavigation(tabId, url)) return
    // `zen://history` and friends are chrome surfaces: open them over the page instead. The
    // registry is the one route for internal pages, so an address it holds as a document page
    // (Downloads, once the desktop registers it) loads here and is not an overlay's any more.
    const overlay = this.browser.pages.parse(url) ? null : overlayForUrl(url)
    if (overlay) {
      this.browser.emit('overlay.open', { kind: overlay }, this.windowFor(tabId))
      return
    }
    tab.url = url
    tab.title = titleForUrl(url)
    tab.errorCode = null
    tab.certificateError = null
    if (opts.upgradedFrom) this.httpsUpgraded.set(tabId, `http://${opts.upgradedFrom}`)
    else this.httpsUpgraded.delete(tabId)
    this.pendingTransition.set(tabId, opts.transition ?? 'typed')
    const hadView = this.view(tabId) !== undefined
    this.thawForNavigation(tabId)
    const view = this.ensureLoaded(tabId)
    if (!view) return
    view.setBackgroundColor(this.backgroundFor(url))
    // ensureLoaded() already loads `tab.url` when it has to create the view.
    if (hadView) view.loadURL(url)
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

  toggleMute(tabId: string): void {
    const tab = this.tab(tabId)
    if (!tab) return
    tab.muted = !tab.muted
    this.view(tabId)?.setMuted(tab.muted)
    this.browser.state.commit()
  }

  /** Whether the user chose "Mute Site" for the host of `url`. */
  siteMuted(url: string): boolean {
    const host = domainOf(url)
    return host !== '' && this.settings.mutedHosts.includes(host)
  }

  /**
   * Chrome's "Mute Site": every tab of the host goes quiet (and stays so on later visits) until
   * the site is unmuted again. Tabs that leave the host regain their sound.
   */
  toggleMuteSite(tabId: string): void {
    const tab = this.tab(tabId)
    if (!tab) return
    const host = domainOf(tab.url)
    if (!host) return
    const muted = !this.settings.mutedHosts.includes(host)
    this.settings.mutedHosts = muted
      ? [...this.settings.mutedHosts, host]
      : this.settings.mutedHosts.filter((h) => h !== host)
    for (const t of Object.values(this.model.tabs)) {
      if (domainOf(t.url) !== host || t.muted === muted) continue
      t.muted = muted
      this.view(t.id)?.setMuted(muted)
    }
    this.browser.state.commit()
  }

  /** A navigation crossed a site boundary: pick up or drop the host's mute with it. */
  private followSiteMute(tab: Tab, view: TabView, fromUrl: string, toUrl: string): void {
    const from = domainOf(fromUrl)
    const to = domainOf(toUrl)
    if (from === to) return
    const muted = this.settings.mutedHosts
    if (to && muted.includes(to)) {
      if (!tab.muted) {
        tab.muted = true
        view.setMuted(true)
      }
    } else if (from && muted.includes(from) && tab.muted) {
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
        tab.title = tab.customTitle ?? titleForUrl(tab.url)
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

  duplicate(tabId: string, win: ZenWindow = this.windowFor(tabId)): Tab | undefined {
    const tab = this.tab(tabId)
    if (!tab) return undefined
    return this.createTab(
      {
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

  moveToFolder(tabId: string, folderId: string | null): void {
    const tab = this.tab(tabId)
    if (!tab || tab.essential || tab.pinned) return
    if (folderId && !this.model.folders[folderId]) return
    const previous = tab.folderId
    tab.folderId = folderId
    if (previous && previous !== folderId) this.browser.liveFolders.onTabLeftFolder(tabId, previous)
    this.browser.state.commit()
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
   *   split:<left|right|top|bottom> split with the window's active tab (the content area)
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
        if (!target || target.id === tabId) return false
        const section: TabSection = target.essential
          ? 'essential'
          : target.pinned
            ? 'pinned'
            : 'regular'
        const index = this.indexRelativeTo(target, drop.after, tabId)
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
        if (!active || active.id === tabId) return false
        const { side } = drop
        const layout: SplitLayout = side === 'left' || side === 'right' ? 'vertical' : 'horizontal'
        if (active.splitGroupId) this.addToSplit(active.splitGroupId, tabId)
        else
          this.createSplit(
            side === 'left' || side === 'top' ? [tabId, active.id] : [active.id, tabId],
            layout,
            win
          )
        return true
      }
      case 'bookmark': {
        if (!tab.url || tab.url.startsWith('zen://')) return false
        this.browser.bookmarks.create({
          parentId: drop.folderId,
          index: drop.index ?? undefined,
          title: tab.customTitle ?? tab.title,
          url: tab.url,
          favicon: tab.favicon,
          type: 'url'
        })
        return true
      }
    }
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
   * (Chrome keeps regular and Incognito tabs apart; a toolbar-only popup has no tab strip).
   */
  canMoveToWindow(tab: Tab, target: ZenWindow, source?: ZenWindow): boolean {
    if (!target.alive || target.isClosing || target === source || target.chrome === 'popup')
      return false
    return this.isPrivate(tab) === target.isPrivate
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
    // valid from another window as from this one.
    const dropped = key !== null && !key.startsWith('split:') && this.dropTab(tabId, key, target)
    if (!dropped && !this.dropTab(tabId, fallback, target)) return false
    // "Sync only pinned tabs": an unpinned tab of a synced space belongs to one window.
    const landed = getSpace(this.model, tab.spaceId)
    if (landed && !landed.windowId && !tab.pinned && !tab.essential)
      tab.windowId = this.settings.windowSync === 'pinned' ? target.id : null
    if (key?.startsWith('split:')) this.dropTab(tabId, key, target)
    this.activateTab(tabId, target)
    this.showNeighbour(source, leaving, tabId)
    this.browser.state.commit()
    target.host.focus()
    return true
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
    // Chrome closes a window whose only tab was torn off; a blank window with nothing left does
    // the same here (deferred: the drag that asked for this may still be finishing).
    if (source.localSpace && source.localSpace.tabIds.length === 0 && source.alive) {
      defer(() => {
        if (source.alive) source.host.close()
      })
    }
    this.browser.state.commit()
    return win
  }

  moveActiveTabBy(delta: number, win: ZenWindow): void {
    const tab = this.activeTabFor(win)
    if (!tab || tab.essential) return
    const idx = sectionIndexOf(this.model, tab)
    this.moveTab(
      tab.id,
      {
        spaceId: tab.spaceId ?? undefined,
        section: tab.pinned ? 'pinned' : 'regular',
        index: Math.max(0, idx + delta)
      },
      win
    )
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
    if (next) this.activateTab(next.id, win)
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
    if (target) this.activateTab(target.id, win)
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
      this.browser.emit('urlbar.toggle', { mode: 'edit', text: '' }, win)
      return
    }
    const tab = this.createTab(
      { url: BLANK_URL, active: false, afterTabId: active.id, load: false },
      win
    )
    this.createSplit([active.id, tab.id], 'vertical', win)
    this.activateTab(tab.id, win)
    this.browser.emit('urlbar.toggle', { mode: 'edit', text: '' }, win)
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
    // `zenium://` alias (`zen://` never leaves `tab.url`).
    const url = tab.url.startsWith(ERROR_URL_PREFIX)
      ? (safeParam(tab.url, 'url') ?? tab.url)
      : internalPageAliasUrl(tab.url)
    // The one copy desktop has always confirmed, in its own words.
    this.browser.copyText(
      markdown ? `[${tab.customTitle ?? tab.title}](${url})` : url,
      markdown ? 'Link copied as Markdown' : 'Link copied',
      this.windowFor(tabId),
      markdown ? 'Copied URL as Markdown' : 'Copied URL'
    )
  }

  toggleDevtools(tabId: string, mode: 'toggle' | 'inspect' | 'console' = 'toggle'): void {
    if (!this.browser.state.capabilities.devtools) {
      this.browser.toast('Developer tools are not available on this device.')
      return
    }
    this.view(tabId)?.openDevTools(mode)
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
      } else {
        if (tab) this.rememberNavigation(tabId, view)
        this.destroyView(tabId)
        if (tab) {
          tab.discarded = true
          tab.frozen = false
          tab.cpuThrottle = 1
          tab.loading = false
          tab.progress = 0
          tab.audible = false
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

  /** Discard every loaded, invisible tab whose last activity is older than the unload timeout. */
  unloadInactive(): void {
    if (!this.settings.unloadEnabled) return
    const timeout = this.settings.unloadTimeoutMinutes * 60_000
    const now = Date.now()
    const visible = this.allVisibleTabIds()
    for (const [id] of this.views) {
      const tab = this.tab(id)
      if (!tab || visible.has(id) || tab.audible || tab.loading) continue
      if (now - tab.lastActiveAt < timeout) continue
      if (this.settings.unloadExcludedDomains.some((d) => domainOf(tab.url) === d.toLowerCase()))
        continue
      if (this.browser.state.devtoolsOpenFor.has(id)) continue
      if (this.browser.agents.isDriving(id)) continue
      this.discard(id)
    }
  }

  destroyAll(): void {
    for (const id of [...this.views.keys()]) this.destroyView(id)
  }
}

function pickFavicon(favicons: string[]): string | null {
  const usable = favicons.filter((f) => /^(https?:|data:)/.test(f))
  return usable[0] ?? null
}

function isTabSection(value: string): value is TabSection {
  return value === 'pinned' || value === 'regular' || value === 'essential'
}

function safeParam(url: string, name: string): string | null {
  try {
    return new URL(url).searchParams.get(name)
  } catch {
    return null
  }
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}
