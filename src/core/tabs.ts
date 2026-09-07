import type { Settings, Space, SplitLayout, Tab, TabSection } from '../shared/types'
import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID } from '../shared/types'
import {
  addTabToSplit,
  createSplitGroup,
  createTabRecord,
  dissolveSplitGroup,
  essentialsForSpace,
  getSpace,
  insertTabIntoSpace,
  moveTab,
  nextTabAfterClose,
  orderedTabsForSpace,
  removeTabFromLists,
  removeTabFromSplit,
  sectionIndexOf,
  tabVisibleIn,
  type Model
} from './model'
import {
  BLANK_URL,
  ERROR_URL_PREFIX,
  errorPageUrl,
  isNavigableUrl,
  titleForUrl
} from '../shared/url'
import type { Browser } from './browser'
import type { ZenWindow } from './window'
import { describeNetError, HTTP_FALLBACK_CODES } from '../shared/zenPages'
import { newId } from '../shared/ids'
import type { PageFlags, TabView, TabViewEvents } from './platform'

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
  /** Tabs whose current load came from typed input we upgraded to https:// (eligible for http fallback). */
  private readonly httpsUpgraded = new Map<string, string>()

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
    const view = this.createView(tab, win ?? this.windowFor(tabId))
    this.browser.governor.trackLoad(tabId)
    tab.discarded = false
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
    view.loadURL(url || BLANK_URL)
    return view
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
    if (tab.muted) view.setMuted(true)
    if (tab.zoom !== 1) view.setZoom(tab.zoom)
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
      onStartLoading: () => update((t) => (t.loading = true), true),
      onStopLoading: () => {
        this.browser.governor.onLoadFinished(tabId)
        update((t) => {
          const v = view()
          t.loading = false
          t.canGoBack = v?.canGoBack() ?? false
          t.canGoForward = v?.canGoForward() ?? false
        })
      },
      onNavigated: (url) => {
        const v = view()
        if (v) this.onNavigated(tabId, v, url)
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
            if (!this.isPrivate(t)) this.browser.history.updateFavicon(t.url, icon)
          }
        }),
      onFailLoad: (code, description, url) => {
        const v = view()
        if (code === -3 || !v) return
        this.browser.governor.onLoadFinished(tabId)
        const upgradedFrom = this.httpsUpgraded.get(tabId)
        if (upgradedFrom && url.startsWith('https://') && HTTP_FALLBACK_CODES.has(code)) {
          this.httpsUpgraded.delete(tabId)
          v.loadURL(`http://${upgradedFrom}`)
          return
        }
        this.httpsUpgraded.delete(tabId)
        update((t) => {
          t.errorCode = code
          t.loading = false
        })
        v.loadURL(errorPageUrl(code, description || describeNetError(code, ''), url))
      },
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
      onEnterHtmlFullscreen: () => {
        const win = ownerWindow()
        // Zen: going fullscreen inside a Glance page expands it into a real tab first.
        if (win.glance?.tabId === tabId) this.expandGlance(win)
        win.htmlFullscreenTabId = tabId
        state.commitVolatile()
        win.relayout()
      },
      onLeaveHtmlFullscreen: () => {
        for (const w of this.browser.allWindows()) {
          if (w.htmlFullscreenTabId === tabId) {
            w.htmlFullscreenTabId = null
            w.relayout()
          }
        }
        state.commitVolatile()
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
      onDestroyed: () => undefined,
      onOpenWindow: (url, disposition) => {
        if (!isNavigableUrl(url) && !url.startsWith('mailto:')) return 'deny'
        // window.open() with features → a real popup so `window.opener` keeps working (OAuth etc.).
        if (disposition === 'new-window') return 'popup'
        const parent = this.tab(tabId)
        this.createTab(
          {
            url,
            spaceId: parent?.spaceId ?? undefined,
            containerId: parent?.containerId,
            active: disposition !== 'background-tab',
            afterTabId: parent && !parent.essential ? parent.id : undefined
          },
          ownerWindow()
        )
        return 'tab'
      },
      onPageMessage: (message) => this.browser.handlePageMessage(tabId, message)
    }
  }

  isPrivate(tab: Tab): boolean {
    return tab.containerId === PRIVATE_CONTAINER_ID
  }

  private onNavigated(tabId: string, view: TabView, url: string): void {
    const tab = this.tab(tabId)
    if (!tab) return
    if (!url.startsWith(ERROR_URL_PREFIX)) {
      tab.errorCode = null
      this.httpsUpgraded.delete(tabId)
    }
    tab.url = url
    tab.title = view.getTitle() || titleForUrl(url)
    tab.canGoBack = view.canGoBack()
    tab.canGoForward = view.canGoForward()
    tab.bookmarked = this.browser.bookmarks.has(url)
    tab.zoom = view.getZoom()
    view.setBackgroundColor(this.backgroundFor(url))
    if (!this.isPrivate(tab)) this.browser.history.visit(url, tab.title, tab.favicon)
    for (const w of this.browser.allWindows())
      if (w.findResult?.tabId === tabId) w.findResult = null
    this.sendPageFlags(tabId)
    this.browser.onNavigated(tabId)
    this.browser.state.commit()
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

  destroyView(tabId: string): void {
    const view = this.views.get(tabId)
    if (!view) return
    this.views.delete(tabId)
    this.httpsUpgraded.delete(tabId)
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
    if (!tab) return
    this.destroyView(tabId)
    tab.discarded = true
    tab.frozen = false
    tab.cpuThrottle = 1
    tab.loading = false
    tab.audible = false
    tab.canGoBack = false
    tab.canGoForward = false
    this.browser.updateMedia()
    this.browser.state.commit()
  }

  /** A frozen page cannot navigate; wake it before touching its history or URL. */
  private thawForNavigation(tabId: string): void {
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
      /** Preset id (hosts that must know the id before the tab exists, e.g. adopted popups). */
      id?: string
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
      folderId: opts.folderId ?? null
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
    if (opts.active !== false) {
      this.activateTab(tab.id, win)
    } else if (opts.load !== false && tab.url !== BLANK_URL) {
      this.ensureLoaded(tab.id, win, { background: true })
    }
    this.browser.state.commit()
    return tab
  }

  /**
   * Adopt a view the host created for a `window.open` popup that should become a tab (Android
   * hands us the WebView; Electron denies and creates a tab through `onOpenWindow` instead).
   * The caller picks the tab id up front so the view can already be addressed by it.
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
        load: false
      },
      win
    )
    view.setBackgroundColor(this.backgroundFor(tab.url))
    view.setVisible(false)
    this.views.set(tab.id, view)
    this.owners.set(tab.id, win)
    this.browser.governor.onViewCreated(tab.id, view)
    tab.discarded = false
    if (opts.active) this.activateTab(tab.id, win)
    this.browser.state.commit()
    win.relayout()
    return { tab, events: this.eventsFor(tab.id) }
  }

  /** Which window a tab belongs to under the current window-sync mode (null = shared). */
  private ownerWindowIdFor(tab: Tab, space: Space, win: ZenWindow): string | null {
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
    this.destroyView(tabId)
    this.browser.governor.onTabRemoved(tabId)
    this.browser.liveFolders.onTabLeftFolder(tabId, tab.folderId)
    if (!this.isPrivate(tab)) {
      this.browser.state.recentlyClosed.unshift({
        tab: { ...tab, splitGroupId: null, discarded: true },
        spaceId: tab.spaceId,
        index,
        closedAt: Date.now()
      })
      if (this.browser.state.recentlyClosed.length > 25)
        this.browser.state.recentlyClosed.length = 25
    }
    for (const { w, s, next } of reselect) {
      w.select(s, next)
      if (w.activeSpaceId === s.id && next) this.activateTab(next, w)
    }
    this.browser.updateMedia()
    this.browser.state.commit()
  }

  reopenClosed(win: ZenWindow = this.browser.focusedWindow()): void {
    const closed = this.browser.state.recentlyClosed.shift()
    if (!closed) return
    const m = this.model
    let space = (closed.spaceId ? getSpace(m, closed.spaceId) : undefined) ?? win.activeSpace()
    if (win.localSpace) space = win.localSpace
    const tab = createTabRecord({
      ...closed.tab,
      spaceId: closed.tab.essential && !space.windowId ? null : space.id,
      containerId: win.isPrivate ? PRIVATE_CONTAINER_ID : closed.tab.containerId,
      discarded: true
    })
    if (m.tabs[tab.id]) tab.id = newId('tab')
    m.tabs[tab.id] = tab
    if (
      tab.essential &&
      !space.windowId &&
      m.essentialTabIds.length < this.settings.essentialsMax
    ) {
      m.essentialTabIds.splice(Math.min(closed.index, m.essentialTabIds.length), 0, tab.id)
      tab.windowId = null
    } else {
      tab.essential = false
      insertTabIntoSpace(m, space, tab, closed.index)
      tab.windowId = this.ownerWindowIdFor(tab, space, win)
    }
    this.activateTab(tab.id, win)
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

  navigate(tabId: string, url: string, opts: { upgradedFrom?: string } = {}): void {
    const tab = this.tab(tabId)
    if (!tab || !isNavigableUrl(url)) return
    tab.url = url
    tab.title = titleForUrl(url)
    tab.errorCode = null
    if (opts.upgradedFrom) this.httpsUpgraded.set(tabId, opts.upgradedFrom)
    else this.httpsUpgraded.delete(tabId)
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
    const view = this.view(tabId)
    if (!view?.canGoBack()) return
    this.thawForNavigation(tabId)
    view.goBack()
  }

  goForward(tabId: string): void {
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
        this.navigate(tabId, original)
        return
      }
    }
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

  setZoom(tabId: string, factor: number): void {
    const tab = this.tab(tabId)
    if (!tab) return
    const clamped = Math.min(5, Math.max(0.25, Math.round(factor * 100) / 100))
    tab.zoom = clamped
    this.view(tabId)?.setZoom(clamped)
    this.browser.state.commitVolatile()
  }

  adjustZoom(tabId: string, direction: number): void {
    const tab = this.tab(tabId)
    if (!tab) return
    // Zen 1.21: finer zoom steps than Firefox's classic table.
    const steps = [0.3, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.2, 1.33, 1.5, 1.7, 2, 2.4, 3, 4, 5]
    const current = this.view(tabId)?.getZoom() ?? tab.zoom
    let idx = steps.findIndex((s) => Math.abs(s - current) < 0.01)
    if (idx === -1) idx = steps.findIndex((s) => s > current) - (direction > 0 ? 1 : 0)
    const next = steps[Math.min(steps.length - 1, Math.max(0, idx + direction))]
    this.setZoom(tabId, next)
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
    const url = tab.url.startsWith(ERROR_URL_PREFIX)
      ? (safeParam(tab.url, 'url') ?? tab.url)
      : tab.url
    this.browser.platform.clipboard.writeText(
      markdown ? `[${tab.customTitle ?? tab.title}](${url})` : url
    )
    this.browser.toast(
      markdown ? 'Copied URL as Markdown' : 'Copied URL',
      'info',
      this.windowFor(tabId)
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
        this.destroyView(tabId)
        if (tab) {
          tab.discarded = true
          tab.frozen = false
          tab.cpuThrottle = 1
          tab.loading = false
          tab.audible = false
        }
      }
    }
    if (win.localSpace) {
      for (const id of [...win.localSpace.tabIds]) {
        const tab = this.tab(id)
        if (!tab) continue
        removeTabFromSplit(m, id)
        removeTabFromLists(m, id)
        delete m.tabs[id]
        if (!win.isPrivate) {
          this.browser.state.recentlyClosed.unshift({
            tab: { ...tab, splitGroupId: null, discarded: true, windowId: null },
            spaceId: null,
            index: 0,
            closedAt: Date.now()
          })
        }
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
        const index = sectionIndexOf(m, tab)
        removeTabFromSplit(m, tab.id)
        removeTabFromLists(m, tab.id)
        delete m.tabs[tab.id]
        this.browser.state.recentlyClosed.unshift({
          tab: { ...tab, splitGroupId: null, discarded: true, windowId: null },
          spaceId: tab.spaceId,
          index,
          closedAt: Date.now()
        })
      }
    }
    if (this.browser.state.recentlyClosed.length > 25) this.browser.state.recentlyClosed.length = 25
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
