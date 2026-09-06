import type { Settings, Space, SplitLayout, Tab, TabSection } from '../shared/types'
import { DEFAULT_CONTAINER_ID } from '../shared/types'
import {
  activeSpace,
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
  type Model
} from './model'
import {
  BLANK_URL,
  ERROR_URL_PREFIX,
  errorPageUrl,
  getDomain,
  isNavigableUrl,
  titleForUrl
} from '../shared/url'
import type { Browser } from './browser'
import { describeNetError, HTTP_FALLBACK_CODES } from '../shared/zenPages'
import { newId } from '../shared/ids'
import type { PageFlags, TabView, TabViewEvents } from './platform'

export type { PageFlags } from './platform'

/**
 * Owns the live view for every loaded tab and implements Zen's tab behaviours on top of the pure
 * model. Views are created through the host's `TabViewHost`; everything else is platform neutral.
 */
export class TabManager {
  private readonly views = new Map<string, TabView>()
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

  get activeSpace(): Space {
    return activeSpace(this.model)
  }

  get activeTab(): Tab | undefined {
    const space = this.activeSpace
    return this.tab(space.activeTabId)
  }

  /** Tabs currently shown in the content area (active tab, or every tab of its split group). */
  visibleTabIds(): string[] {
    const active = this.activeTab
    if (!active) return []
    if (active.splitGroupId) {
      const group = this.model.splitGroups[active.splitGroupId]
      if (group) return group.tabIds
    }
    return [active.id]
  }

  // ---------------------------------------------------------------------------
  // View lifecycle
  // ---------------------------------------------------------------------------

  ensureLoaded(tabId: string): TabView | undefined {
    const tab = this.tab(tabId)
    if (!tab) return undefined
    const existing = this.views.get(tabId)
    if (existing && !existing.isDestroyed()) return existing
    const view = this.createView(tab)
    tab.discarded = false
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

  private createView(tab: Tab): TabView {
    const view = this.browser.platform.views.createView(tab, this.eventsFor(tab.id))
    view.setBackgroundColor(this.backgroundFor(tab.url))
    view.setVisible(false)
    this.views.set(tab.id, view)
    if (tab.muted) view.setMuted(true)
    if (tab.zoom !== 1) view.setZoom(tab.zoom)
    this.browser.viewport.relayout()
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

    return {
      onStartLoading: () => update((t) => (t.loading = true), true),
      onStopLoading: () =>
        update((t) => {
          const v = view()
          t.loading = false
          t.canGoBack = v?.canGoBack() ?? false
          t.canGoForward = v?.canGoForward() ?? false
        }),
      onNavigated: (url) => {
        const v = view()
        if (v) this.onNavigated(tabId, v, url)
      },
      onTitleUpdated: (title) =>
        update((t) => {
          t.title = title || titleForUrl(t.url)
          this.browser.history.updateTitle(t.url, t.title)
        }),
      onFaviconUpdated: (favicons) =>
        update((t) => {
          const icon = pickFavicon(favicons)
          if (icon) {
            t.favicon = icon
            this.browser.history.updateFavicon(t.url, icon)
          }
        }),
      onFailLoad: (code, description, url) => {
        const v = view()
        if (code === -3 || !v) return
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
        const v = view()
        if (!tab || !v) return
        this.browser.toast(`"${tab.title}" crashed (${reason}).`, 'error')
        v.loadURL(errorPageUrl(-1, `The page crashed (${reason})`, tab.url))
      },
      onAudioStateChanged: (audible) => {
        update((t) => (t.audible = audible), true)
        this.browser.updateMedia()
      },
      onMediaStateChanged: () => this.browser.updateMedia(),
      onEnterHtmlFullscreen: () => {
        state.window.htmlFullscreenTabId = tabId
        state.commitVolatile()
        this.browser.viewport.relayout()
      },
      onLeaveHtmlFullscreen: () => {
        if (state.window.htmlFullscreenTabId === tabId) state.window.htmlFullscreenTabId = null
        state.commitVolatile()
        this.browser.viewport.relayout()
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
        state.findResult = {
          tabId,
          activeMatchOrdinal: result.activeMatchOrdinal,
          matches: result.matches
        }
        state.commitVolatile()
      },
      onZoomChanged: (direction) => this.adjustZoom(tabId, direction === 'in' ? 1 : -1),
      onContextMenu: (params) => this.browser.menus.showPageContextMenu(tabId, params),
      onKey: (input) => this.browser.keys.handle(input, tabId),
      onTargetUrl: (url) => this.browser.emit('status', { text: url }),
      onDomReady: () => this.sendPageFlags(tabId),
      onDestroyed: () => undefined,
      onOpenWindow: (url, disposition) => {
        if (!isNavigableUrl(url) && !url.startsWith('mailto:')) return 'deny'
        // window.open() with features → a real popup so `window.opener` keeps working (OAuth etc.).
        if (disposition === 'new-window') return 'popup'
        const parent = this.tab(tabId)
        this.createTab({
          url,
          spaceId: parent?.spaceId ?? undefined,
          containerId: parent?.containerId,
          active: disposition !== 'background-tab',
          afterTabId: parent && !parent.essential ? parent.id : undefined
        })
        return 'tab'
      },
      onPageMessage: (message) => this.browser.handlePageMessage(tabId, message)
    }
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
    this.browser.history.visit(url, tab.title, tab.favicon)
    if (this.browser.state.findResult?.tabId === tabId) this.browser.state.findResult = null
    this.sendPageFlags(tabId)
    this.browser.state.commit()
  }

  sendPageFlags(tabId: string): void {
    const tab = this.tab(tabId)
    const view = this.view(tabId)
    if (!tab || !view) return
    const flags: PageFlags = {
      glanceEnabled: this.settings.glanceEnabled && !this.browser.state.glance,
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
    if (!view.isDestroyed()) view.destroy()
    this.browser.state.devtoolsOpenFor.delete(tabId)
  }

  /** Unload a tab's view while keeping it in the sidebar (Zen's "pending" tabs). */
  discard(tabId: string): void {
    const tab = this.tab(tabId)
    if (!tab) return
    this.destroyView(tabId)
    tab.discarded = true
    tab.loading = false
    tab.audible = false
    tab.canGoBack = false
    tab.canGoForward = false
    this.browser.updateMedia()
    this.browser.state.commit()
  }

  // ---------------------------------------------------------------------------
  // Creating / activating / closing
  // ---------------------------------------------------------------------------

  createTab(opts: {
    url?: string
    spaceId?: string
    active?: boolean
    containerId?: string
    pinned?: boolean
    essential?: boolean
    afterTabId?: string
    folderId?: string | null
    load?: boolean
  }): Tab {
    const m = this.model
    const space = (opts.spaceId ? getSpace(m, opts.spaceId) : undefined) ?? this.activeSpace
    const containerId = opts.containerId ?? space.containerId ?? DEFAULT_CONTAINER_ID
    const tab = createTabRecord({
      spaceId: opts.essential ? null : space.id,
      containerId,
      url: opts.url ?? BLANK_URL,
      pinned: Boolean(opts.pinned) && !opts.essential,
      essential: Boolean(opts.essential),
      folderId: opts.folderId ?? null
    })
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
        const current = this.tab(space.activeTabId)
        if (current && current.spaceId === space.id && !current.pinned)
          index = sectionIndexOf(m, current) + 1
      }
      insertTabIntoSpace(m, space, tab, index)
    }
    tab.bookmarked = this.browser.bookmarks.has(tab.url)
    if (opts.active !== false) {
      this.activateTab(tab.id)
    } else if (opts.load !== false && tab.url !== BLANK_URL) {
      this.ensureLoaded(tab.id)
    }
    this.browser.state.commit()
    return tab
  }

  /**
   * Adopt a view the host created for a `window.open` popup that should become a tab (Android
   * hands us the WebView; Electron denies and creates a tab through `onOpenWindow` instead).
   */
  adoptView(view: TabView, opts: { parentTabId: string | null; active: boolean }): Tab {
    const parent = this.tab(opts.parentTabId)
    const tab = this.createTab({
      url: BLANK_URL,
      spaceId: parent?.spaceId ?? undefined,
      containerId: parent?.containerId,
      active: false,
      afterTabId: parent && !parent.essential ? parent.id : undefined,
      load: false
    })
    view.setBackgroundColor(this.backgroundFor(tab.url))
    view.setVisible(false)
    this.views.set(tab.id, view)
    tab.discarded = false
    if (opts.active) this.activateTab(tab.id)
    this.browser.state.commit()
    this.browser.viewport.relayout()
    return tab
  }

  /** Wire events for a view created by the host (see `adoptView`). */
  eventsForAdopted(tabId: string): TabViewEvents {
    return this.eventsFor(tabId)
  }

  activateTab(tabId: string): void {
    const m = this.model
    const tab = this.tab(tabId)
    if (!tab) return
    let space = this.activeSpace
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
    const previousActive = this.tab(space.activeTabId)
    if (m.activeSpaceId !== space.id) {
      this.switchSpace(space.id, tabId)
      return
    }
    space.activeTabId = tab.id
    tab.lastActiveAt = Date.now()
    if (previousActive && previousActive.id !== tab.id) previousActive.lastActiveAt = Date.now()
    if (
      this.browser.state.glance &&
      this.browser.state.glance.parentTabId !== tab.id &&
      this.browser.state.glance.tabId !== tab.id
    ) {
      this.closeGlance()
    }
    for (const id of this.visibleTabIds()) this.ensureLoaded(id)
    this.browser.state.findResult = null
    this.browser.state.commit()
    this.browser.viewport.focusContent()
  }

  switchSpace(spaceId: string, activateTabId?: string): void {
    const m = this.model
    const space = getSpace(m, spaceId)
    if (!space) return
    const fromIndex = m.spaces.findIndex((s) => s.id === m.activeSpaceId)
    const toIndex = m.spaces.findIndex((s) => s.id === spaceId)
    if (this.browser.state.glance) this.closeGlance()
    m.activeSpaceId = spaceId
    if (activateTabId && this.tab(activateTabId)) space.activeTabId = activateTabId
    if (space.activeTabId && !this.tab(space.activeTabId)) space.activeTabId = null
    const active = this.tab(space.activeTabId)
    if (active) active.lastActiveAt = Date.now()
    for (const id of this.visibleTabIds()) this.ensureLoaded(id)
    this.browser.state.findResult = null
    this.browser.emit('space.switched', { fromIndex, toIndex })
    this.browser.state.commit()
  }

  /**
   * Close a tab. For pinned/essential tabs Zen applies `pinnedCloseBehavior` instead of really
   * closing (default: reset to the pinned URL, unload and switch to the next tab).
   */
  closeTab(tabId: string, force = false): void {
    const m = this.model
    const tab = this.tab(tabId)
    if (!tab) return
    if (this.browser.state.glance?.tabId === tabId) {
      this.closeGlance()
      return
    }
    if ((tab.pinned || tab.essential) && !force) {
      const behaviour = this.settings.pinnedCloseBehavior
      if (behaviour !== 'close') {
        const space = this.activeSpace
        const wasActive = space.activeTabId === tabId
        if (behaviour.includes('reset')) this.resetPinned(tabId, false)
        if (behaviour.includes('unload')) this.discard(tabId)
        if (behaviour.includes('switch') && wasActive) {
          const next = nextTabAfterClose(
            m,
            space,
            tabId,
            this.settings.containerSpecificEssentials,
            true
          )
          if (next) this.activateTab(next)
        }
        this.browser.state.commit()
        return
      }
    }
    const space = tab.spaceId ? getSpace(m, tab.spaceId) : this.activeSpace
    const wasActive = space?.activeTabId === tabId || this.activeSpace.activeTabId === tabId
    const index = sectionIndexOf(m, tab)
    let next: string | null = null
    if (wasActive && space)
      next = nextTabAfterClose(m, space, tabId, this.settings.containerSpecificEssentials)
    removeTabFromSplit(m, tabId)
    removeTabFromLists(m, tabId)
    delete m.tabs[tabId]
    this.destroyView(tabId)
    this.browser.state.recentlyClosed.unshift({
      tab: { ...tab, splitGroupId: null, discarded: true },
      spaceId: tab.spaceId,
      index,
      closedAt: Date.now()
    })
    if (this.browser.state.recentlyClosed.length > 25) this.browser.state.recentlyClosed.length = 25
    if (wasActive && space) {
      if (next) {
        space.activeTabId = next
        if (space.id === m.activeSpaceId) this.activateTab(next)
      } else {
        space.activeTabId = null
      }
    }
    this.browser.updateMedia()
    this.browser.state.commit()
  }

  reopenClosed(): void {
    const closed = this.browser.state.recentlyClosed.shift()
    if (!closed) return
    const m = this.model
    const space = (closed.spaceId ? getSpace(m, closed.spaceId) : undefined) ?? this.activeSpace
    const tab = createTabRecord({
      ...closed.tab,
      spaceId: closed.tab.essential ? null : space.id,
      discarded: true
    })
    if (m.tabs[tab.id]) tab.id = newId('tab')
    m.tabs[tab.id] = tab
    if (tab.essential && m.essentialTabIds.length < this.settings.essentialsMax) {
      m.essentialTabIds.splice(Math.min(closed.index, m.essentialTabIds.length), 0, tab.id)
    } else {
      tab.essential = false
      insertTabIntoSpace(m, space, tab, closed.index)
    }
    this.activateTab(tab.id)
  }

  closeOthers(tabId: string): void {
    const tab = this.tab(tabId)
    if (!tab || tab.essential) return
    const space = this.activeSpace
    for (const id of [...space.tabIds]) {
      const t = this.tab(id)
      if (t && id !== tabId && !t.pinned) this.closeTab(id)
    }
    this.activateTab(tabId)
  }

  closeBelow(tabId: string): void {
    this.closeRelative(tabId, 'below')
  }

  closeAbove(tabId: string): void {
    this.closeRelative(tabId, 'above')
  }

  private closeRelative(tabId: string, direction: 'above' | 'below'): void {
    const tab = this.tab(tabId)
    if (!tab || tab.essential) return
    const space = this.activeSpace
    const ids = space.tabIds.filter((id) => this.tab(id)?.pinned === tab.pinned)
    const idx = ids.indexOf(tabId)
    if (idx === -1) return
    const victims = direction === 'below' ? ids.slice(idx + 1) : ids.slice(0, idx)
    for (const id of victims) this.closeTab(id, true)
  }

  /** Zen's "Clear tabs" button / Ctrl+Shift+K: close every unpinned tab in the space. */
  closeUnpinned(spaceId?: string): void {
    const space = (spaceId ? getSpace(this.model, spaceId) : undefined) ?? this.activeSpace
    for (const id of [...space.tabIds]) {
      const t = this.tab(id)
      if (t && !t.pinned) this.closeTab(id)
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
    const view = this.ensureLoaded(tabId)
    if (!view) return
    view.setBackgroundColor(this.backgroundFor(url))
    // ensureLoaded() already loads `tab.url` when it has to create the view.
    if (hadView) view.loadURL(url)
    this.browser.state.commit()
  }

  goBack(tabId: string): void {
    const view = this.view(tabId)
    if (view?.canGoBack()) view.goBack()
  }

  goForward(tabId: string): void {
    const view = this.view(tabId)
    if (view?.canGoForward()) view.goForward()
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
    const steps = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]
    const current = this.view(tabId)?.getZoom() ?? tab.zoom
    let idx = steps.findIndex((s) => Math.abs(s - current) < 0.01)
    if (idx === -1) idx = steps.findIndex((s) => s > current) - (direction > 0 ? 1 : 0)
    const next = steps[Math.min(steps.length - 1, Math.max(0, idx + direction))]
    this.setZoom(tabId, next)
  }

  // ---------------------------------------------------------------------------
  // Pinned tabs & essentials
  // ---------------------------------------------------------------------------

  togglePin(tabId: string): void {
    const tab = this.tab(tabId)
    if (!tab) return
    if (tab.essential) {
      // Zen: unpinning an essential turns it into a regular tab of the current space.
      moveTab(this.model, tab, { section: 'regular', index: 0 }, this.settings.essentialsMax)
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
    this.sendPageFlags(tabId)
    this.browser.state.commit()
  }

  toggleEssential(tabId: string): void {
    const tab = this.tab(tabId)
    if (!tab) return
    if (tab.essential) {
      moveTab(
        this.model,
        tab,
        { section: 'pinned', index: Number.MAX_SAFE_INTEGER },
        this.settings.essentialsMax
      )
    } else {
      if (this.model.essentialTabIds.length >= this.settings.essentialsMax) {
        this.browser.toast(`You can have at most ${this.settings.essentialsMax} Essentials.`)
        return
      }
      moveTab(
        this.model,
        tab,
        { section: 'essential', index: Number.MAX_SAFE_INTEGER },
        this.settings.essentialsMax
      )
      const space = this.activeSpace
      if (space.activeTabId === tabId || !space.activeTabId) space.activeTabId = tabId
    }
    this.sendPageFlags(tabId)
    this.browser.state.commit()
  }

  resetPinned(tabId: string, activate = true): void {
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
    if (activate) this.activateTab(tabId)
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

  duplicate(tabId: string): Tab | undefined {
    const tab = this.tab(tabId)
    if (!tab) return undefined
    return this.createTab({
      url: tab.url,
      spaceId: this.activeSpace.id,
      containerId: tab.containerId,
      active: true,
      afterTabId: tab.essential ? undefined : tab.id
    })
  }

  moveTab(tabId: string, target: { spaceId?: string; section: TabSection; index: number }): void {
    const tab = this.tab(tabId)
    if (!tab) return
    const before = { pinned: tab.pinned, essential: tab.essential, spaceId: tab.spaceId }
    const targetSpaceId = target.spaceId ?? this.model.activeSpaceId
    const leavesSpace = target.section !== 'essential' && tab.spaceId !== targetSpaceId
    if (leavesSpace) removeTabFromSplit(this.model, tabId)
    const previousSpace = tab.spaceId ? getSpace(this.model, tab.spaceId) : undefined
    const wasActiveInPrevious = previousSpace?.activeTabId === tabId
    moveTab(this.model, tab, target, this.settings.essentialsMax)
    if (previousSpace && wasActiveInPrevious && tab.spaceId !== previousSpace.id) {
      previousSpace.activeTabId =
        nextTabAfterClose(
          this.model,
          previousSpace,
          tabId,
          this.settings.containerSpecificEssentials
        ) ?? null
    }
    if (
      target.spaceId &&
      target.spaceId !== this.model.activeSpaceId &&
      tab.spaceId === target.spaceId
    ) {
      const space = getSpace(this.model, target.spaceId)
      if (space && !space.activeTabId) space.activeTabId = tabId
    }
    if (before.pinned !== tab.pinned || before.essential !== tab.essential)
      this.sendPageFlags(tabId)
    this.browser.state.commit()
  }

  moveToFolder(tabId: string, folderId: string | null): void {
    const tab = this.tab(tabId)
    if (!tab || tab.essential || tab.pinned) return
    if (folderId && !this.model.folders[folderId]) return
    tab.folderId = folderId
    this.browser.state.commit()
  }

  moveActiveTabBy(delta: number): void {
    const tab = this.activeTab
    if (!tab || tab.essential) return
    const idx = sectionIndexOf(this.model, tab)
    this.moveTab(tab.id, {
      spaceId: tab.spaceId ?? undefined,
      section: tab.pinned ? 'pinned' : 'regular',
      index: Math.max(0, idx + delta)
    })
  }

  moveActiveTabToEdge(edge: 'start' | 'end'): void {
    const tab = this.activeTab
    if (!tab || tab.essential) return
    this.moveTab(tab.id, {
      spaceId: tab.spaceId ?? undefined,
      section: tab.pinned ? 'pinned' : 'regular',
      index: edge === 'start' ? 0 : Number.MAX_SAFE_INTEGER
    })
  }

  // ---------------------------------------------------------------------------
  // Cycling
  // ---------------------------------------------------------------------------

  cycleTab(delta: number): void {
    const space = this.activeSpace
    let ordered = orderedTabsForSpace(this.model, space, this.settings.containerSpecificEssentials)
    const active = this.activeTab
    if (this.settings.ctrlTabCyclesWithinSection && active) {
      ordered = ordered.filter(
        (t) => (t.essential || t.pinned) === (active.essential || active.pinned)
      )
    }
    if (ordered.length === 0) return
    const idx = active ? ordered.findIndex((t) => t.id === active.id) : -1
    const n = ordered.length
    const next = ordered[(((idx + delta) % n) + n) % n]
    if (next) this.activateTab(next.id)
  }

  selectTabByIndex(index: number): void {
    const space = this.activeSpace
    const ordered = orderedTabsForSpace(
      this.model,
      space,
      this.settings.containerSpecificEssentials
    )
    const target = index === -1 ? ordered[ordered.length - 1] : ordered[index]
    if (target) this.activateTab(target.id)
  }

  // ---------------------------------------------------------------------------
  // Split view
  // ---------------------------------------------------------------------------

  createSplit(tabIds: string[], layout: SplitLayout): void {
    const m = this.model
    const space = this.activeSpace
    const ids = tabIds.filter((id) => Boolean(this.tab(id)))
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
    const active = this.activeTab
    this.activateTab(active && group.tabIds.includes(active.id) ? active.id : group.tabIds[0])
  }

  /** Ctrl+Alt+G/V/H: toggle the layout of the active split, or split the active tab with the one below it. */
  toggleSplitLayout(layout: SplitLayout): void {
    const active = this.activeTab
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
    const space = this.activeSpace
    const list = orderedTabsForSpace(
      this.model,
      space,
      this.settings.containerSpecificEssentials
    ).map((t) => t.id)
    const idx = list.indexOf(active.id)
    const below = list[idx + 1] ?? list[idx - 1]
    if (!below) {
      this.browser.toast('Open another tab to create a split view.')
      return
    }
    this.createSplit([active.id, below], layout)
  }

  setSplitLayout(groupId: string, layout: SplitLayout): void {
    const group = this.model.splitGroups[groupId]
    if (!group) return
    group.layout = layout
    this.browser.state.commit()
  }

  unsplit(groupId?: string, tabId?: string): void {
    let id = groupId
    if (!id) {
      const tab = this.tab(tabId) ?? this.activeTab
      id = tab?.splitGroupId ?? undefined
    }
    if (!id) return
    dissolveSplitGroup(this.model, id)
    this.browser.state.commit()
    this.browser.viewport.focusContent()
  }

  removeFromSplit(tabId: string, focus: boolean): void {
    const tab = this.tab(tabId)
    if (!tab?.splitGroupId) return
    const group = this.model.splitGroups[tab.splitGroupId]
    removeTabFromSplit(this.model, tabId)
    if (focus) this.activateTab(tabId)
    else if (group?.tabIds[0] && this.activeSpace.activeTabId === tabId)
      this.activateTab(group.tabIds[0])
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

  newEmptySplit(): void {
    const active = this.activeTab
    if (!active || active.essential) {
      this.createTab({ url: BLANK_URL, active: true })
      return
    }
    if (active.splitGroupId) {
      const group = this.model.splitGroups[active.splitGroupId]
      if (group && group.tabIds.length >= 4) {
        this.browser.toast('Split views can hold up to 4 tabs.')
        return
      }
      const tab = this.createTab({
        url: BLANK_URL,
        active: false,
        afterTabId: active.id,
        load: false
      })
      if (group) addTabToSplit(this.model, group.id, tab.id)
      this.activateTab(tab.id)
      this.browser.emit('urlbar.toggle', { mode: 'edit', text: '' })
      return
    }
    const tab = this.createTab({
      url: BLANK_URL,
      active: false,
      afterTabId: active.id,
      load: false
    })
    this.createSplit([active.id, tab.id], 'vertical')
    this.activateTab(tab.id)
    this.browser.emit('urlbar.toggle', { mode: 'edit', text: '' })
  }

  addToSplit(groupId: string, tabId: string): void {
    if (addTabToSplit(this.model, groupId, tabId)) {
      this.ensureLoaded(tabId)
      this.browser.state.commit()
    }
  }

  // ---------------------------------------------------------------------------
  // Glance
  // ---------------------------------------------------------------------------

  openGlance(url: string, parentTabId: string, originX: number, originY: number): void {
    if (!isNavigableUrl(url) || this.browser.state.glance) return
    const parent = this.tab(parentTabId) ?? this.activeTab
    if (!parent) return
    const space = this.activeSpace
    const tab = createTabRecord({ spaceId: space.id, containerId: parent.containerId, url })
    this.model.tabs[tab.id] = tab
    this.browser.state.glance = { tabId: tab.id, parentTabId: parent.id, originX, originY }
    this.ensureLoaded(tab.id)
    this.browser.state.commitVolatile()
    this.broadcastPageFlags()
  }

  closeGlance(): void {
    const glance = this.browser.state.glance
    if (!glance) return
    this.browser.state.glance = null
    this.destroyView(glance.tabId)
    delete this.model.tabs[glance.tabId]
    this.browser.state.commit()
    this.broadcastPageFlags()
    this.browser.viewport.focusContent()
  }

  /** Move the glance page into a real tab right after its parent. */
  expandGlance(): void {
    const glance = this.browser.state.glance
    if (!glance) return
    const tab = this.tab(glance.tabId)
    const parent = this.tab(glance.parentTabId)
    this.browser.state.glance = null
    if (!tab) return
    const space = this.activeSpace
    const index =
      parent && !parent.essential && parent.spaceId === space.id
        ? sectionIndexOf(this.model, parent) + 1
        : undefined
    tab.pinned = false
    insertTabIntoSpace(this.model, space, tab, parent?.pinned ? undefined : index)
    this.activateTab(tab.id)
    this.broadcastPageFlags()
  }

  splitGlance(): void {
    const glance = this.browser.state.glance
    if (!glance) return
    const tab = this.tab(glance.tabId)
    const parent = this.tab(glance.parentTabId)
    this.browser.state.glance = null
    if (!tab) return
    const space = this.activeSpace
    insertTabIntoSpace(
      this.model,
      space,
      tab,
      parent && !parent.essential ? sectionIndexOf(this.model, parent) + 1 : undefined
    )
    if (parent) this.createSplit([parent.id, tab.id], 'vertical')
    else this.activateTab(tab.id)
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
    this.browser.toast(markdown ? 'Copied URL as Markdown' : 'Copied URL')
  }

  toggleDevtools(tabId: string, mode: 'toggle' | 'inspect' | 'console' = 'toggle'): void {
    if (!this.browser.state.capabilities.devtools) {
      this.browser.toast('Developer tools are not available on this device.')
      return
    }
    this.view(tabId)?.openDevTools(mode)
  }

  /** Discard every loaded, invisible tab whose last activity is older than the unload timeout. */
  unloadInactive(): void {
    if (!this.settings.unloadEnabled) return
    const timeout = this.settings.unloadTimeoutMinutes * 60_000
    const now = Date.now()
    const visible = new Set(this.visibleTabIds())
    if (this.browser.state.glance)
      visible.add(this.browser.state.glance.tabId).add(this.browser.state.glance.parentTabId)
    for (const [id] of this.views) {
      const tab = this.tab(id)
      if (!tab || visible.has(id) || tab.audible || tab.loading) continue
      if (now - tab.lastActiveAt < timeout) continue
      if (this.settings.unloadExcludedDomains.some((d) => getDomain(tab.url) === d.toLowerCase()))
        continue
      if (this.browser.state.devtoolsOpenFor.has(id)) continue
      this.discard(id)
    }
  }

  unloadSpace(spaceId: string): void {
    const space = getSpace(this.model, spaceId)
    if (!space) return
    const visible = new Set(spaceId === this.model.activeSpaceId ? this.visibleTabIds() : [])
    for (const id of space.tabIds) if (!visible.has(id) && this.views.has(id)) this.discard(id)
    if (spaceId !== this.model.activeSpaceId) {
      for (const t of essentialsForSpace(this.model, space, true))
        if (this.views.has(t.id) && !visible.has(t.id)) this.discard(t.id)
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
