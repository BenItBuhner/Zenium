import { WebContentsView, clipboard, dialog, type WebContents } from 'electron'
import { join } from 'node:path'
import type { Settings, Space, SplitLayout, Tab, TabSection } from '../../shared/types'
import { DEFAULT_CONTAINER_ID } from '../../shared/types'
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
} from '../../shared/url'
import type { Browser } from './browser'
import { describeNetError } from './protocol'

const HTTP_FALLBACK_CODES = new Set([
  -102, -105, -107, -113, -118, -7, -100, -101, -109, -200, -201, -202, -203, -204, -205, -206,
  -207, -208, -210, -211, -212, -213, -324, -501
])

export interface PageFlags {
  glanceEnabled: boolean
  glanceTrigger: 'alt' | 'ctrl' | 'shift'
  /** How plain clicks on third-party links behave on pinned/essential tabs (null = normal tab). */
  thirdParty: 'new-tab' | 'glance' | 'same-tab' | null
}

/**
 * Owns the WebContentsView for every loaded tab and implements Zen's tab behaviours on top of
 * the pure model.
 */
export class TabManager {
  private readonly views = new Map<string, WebContentsView>()
  private readonly byWebContentsId = new Map<number, string>()
  /** Tabs whose current load came from typed input we upgraded to https:// (eligible for http fallback). */
  private readonly httpsUpgraded = new Map<string, string>()
  private readonly pagePreload: string

  constructor(private readonly browser: Browser) {
    this.pagePreload = join(__dirname, '../preload/page.js')
  }

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

  view(tabId: string): WebContentsView | undefined {
    return this.views.get(tabId)
  }

  webContents(tabId: string): WebContents | undefined {
    const view = this.views.get(tabId)
    return view && !view.webContents.isDestroyed() ? view.webContents : undefined
  }

  tabIdForWebContents(wc: WebContents): string | undefined {
    return this.byWebContentsId.get(wc.id)
  }

  allViews(): Iterable<[string, WebContentsView]> {
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

  ensureLoaded(tabId: string): WebContentsView | undefined {
    const tab = this.tab(tabId)
    if (!tab) return undefined
    const existing = this.views.get(tabId)
    if (existing && !existing.webContents.isDestroyed()) return existing
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
    void view.webContents.loadURL(url || BLANK_URL).catch(() => undefined)
    return view
  }

  private createView(tab: Tab): WebContentsView {
    const ses = this.browser.sessions.get(tab.containerId)
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        preload: this.pagePreload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: true,
        safeDialogs: true,
        autoplayPolicy: 'document-user-activation-required',
        backgroundThrottling: true,
        scrollBounce: true,
        enableWebSQL: false
      }
    })
    view.setBackgroundColor(this.backgroundFor(tab.url))
    view.setVisible(false)
    this.views.set(tab.id, view)
    this.byWebContentsId.set(view.webContents.id, tab.id)
    this.wire(tab.id, view)
    this.browser.window.attachView(view)
    if (tab.muted) view.webContents.setAudioMuted(true)
    if (tab.zoom !== 1) view.webContents.setZoomFactor(tab.zoom)
    return view
  }

  private backgroundFor(url: string): string {
    return url.startsWith('zen://') ? '#00000000' : '#ffffff'
  }

  private wire(tabId: string, view: WebContentsView): void {
    const wc = view.webContents
    const state = this.browser.state
    const update = (fn: (tab: Tab) => void, volatile = false): void => {
      const tab = this.tab(tabId)
      if (!tab) return
      fn(tab)
      if (volatile) state.commitVolatile()
      else state.commit()
    }

    wc.on('did-start-loading', () => update((t) => (t.loading = true), true))
    wc.on('did-stop-loading', () =>
      update((t) => {
        t.loading = false
        t.canGoBack = wc.navigationHistory.canGoBack()
        t.canGoForward = wc.navigationHistory.canGoForward()
      })
    )
    wc.on('did-navigate', (_e, url) => this.onNavigated(tabId, wc, url))
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) this.onNavigated(tabId, wc, url)
    })
    wc.on('page-title-updated', (_e, title) =>
      update((t) => {
        t.title = title || titleForUrl(t.url)
        this.browser.history.updateTitle(t.url, t.title)
      })
    )
    wc.on('page-favicon-updated', (_e, favicons) =>
      update((t) => {
        const icon = pickFavicon(favicons)
        if (icon) {
          t.favicon = icon
          this.browser.history.updateFavicon(t.url, icon)
        }
      })
    )
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || wc.isDestroyed()) return
      const upgradedFrom = this.httpsUpgraded.get(tabId)
      if (upgradedFrom && url.startsWith('https://') && HTTP_FALLBACK_CODES.has(code)) {
        this.httpsUpgraded.delete(tabId)
        void wc.loadURL(`http://${upgradedFrom}`).catch(() => undefined)
        return
      }
      this.httpsUpgraded.delete(tabId)
      update((t) => {
        t.errorCode = code
        t.loading = false
      })
      void wc
        .loadURL(errorPageUrl(code, description || describeNetError(code, ''), url))
        .catch(() => undefined)
    })
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return
      const tab = this.tab(tabId)
      if (!tab) return
      const url = tab.url
      this.browser.toast(`"${tab.title}" crashed (${details.reason}).`, 'error')
      void wc
        .loadURL(errorPageUrl(-1, `The page crashed (${details.reason})`, url))
        .catch(() => undefined)
    })
    wc.on('audio-state-changed', (e) => {
      update((t) => (t.audible = e.audible), true)
      this.browser.updateMedia()
    })
    wc.on('media-started-playing', () => this.browser.updateMedia())
    wc.on('media-paused', () => this.browser.updateMedia())
    wc.on('enter-html-full-screen', () => {
      state.window.htmlFullscreenTabId = tabId
      state.commitVolatile()
    })
    wc.on('leave-html-full-screen', () => {
      if (state.window.htmlFullscreenTabId === tabId) state.window.htmlFullscreenTabId = null
      state.commitVolatile()
    })
    wc.on('devtools-opened', () => {
      state.devtoolsOpenFor.add(tabId)
      state.commitVolatile()
    })
    wc.on('devtools-closed', () => {
      state.devtoolsOpenFor.delete(tabId)
      state.commitVolatile()
    })
    wc.on('found-in-page', (_e, result) => {
      if (!result.finalUpdate) return
      state.findResult = {
        tabId,
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches
      }
      state.commitVolatile()
    })
    wc.on('zoom-changed', (_e, direction) => {
      this.adjustZoom(tabId, direction === 'in' ? 1 : -1)
    })
    wc.on('context-menu', (_e, params) => {
      this.browser.menus.showPageContextMenu(tabId, params)
    })
    wc.on('before-input-event', (event, input) => {
      this.browser.keys.handle(event, input, tabId)
    })
    wc.on('update-target-url', (_e, url) => {
      this.browser.emit('status', { text: url })
    })
    wc.on('will-prevent-unload', (event) => {
      const tab = this.tab(tabId)
      const choice = dialog.showMessageBoxSync(this.browser.window.win, {
        type: 'question',
        buttons: ['Leave Page', 'Stay on Page'],
        defaultId: 0,
        cancelId: 1,
        message: `This page is asking you to confirm that you want to leave — ${tab?.title ?? ''}`,
        detail: 'Information you’ve entered may not be saved.',
        noLink: true
      })
      if (choice === 0) event.preventDefault()
    })
    wc.on('dom-ready', () => this.sendPageFlags(tabId))
    wc.on('destroyed', () => {
      this.byWebContentsId.delete(wc.id)
    })
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (!isNavigableUrl(url) && !url.startsWith('mailto:')) return { action: 'deny' }
      if (disposition === 'new-window') {
        // window.open() with features → a real popup so `window.opener` keeps working (OAuth etc.).
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 720,
            height: 640,
            autoHideMenuBar: true,
            webPreferences: { preload: undefined, sandbox: true, contextIsolation: true }
          }
        }
      }
      const parent = this.tab(tabId)
      this.createTab({
        url,
        spaceId: parent?.spaceId ?? undefined,
        containerId: parent?.containerId,
        active: disposition !== 'background-tab',
        afterTabId: parent && !parent.essential ? parent.id : undefined
      })
      return { action: 'deny' }
    })
  }

  private onNavigated(tabId: string, wc: WebContents, url: string): void {
    const tab = this.tab(tabId)
    if (!tab) return
    if (!url.startsWith(ERROR_URL_PREFIX)) {
      tab.errorCode = null
      this.httpsUpgraded.delete(tabId)
    }
    tab.url = url
    tab.title = wc.getTitle() || titleForUrl(url)
    tab.canGoBack = wc.navigationHistory.canGoBack()
    tab.canGoForward = wc.navigationHistory.canGoForward()
    tab.bookmarked = this.browser.bookmarks.has(url)
    tab.zoom = wc.getZoomFactor()
    const view = this.views.get(tabId)
    view?.setBackgroundColor(this.backgroundFor(url))
    this.browser.history.visit(url, tab.title, tab.favicon)
    if (this.browser.state.findResult?.tabId === tabId) this.browser.state.findResult = null
    this.sendPageFlags(tabId)
    this.browser.state.commit()
  }

  sendPageFlags(tabId: string): void {
    const tab = this.tab(tabId)
    const wc = this.webContents(tabId)
    if (!tab || !wc) return
    const flags: PageFlags = {
      glanceEnabled: this.settings.glanceEnabled && !this.browser.state.glance,
      glanceTrigger: this.settings.glanceTrigger,
      thirdParty: tab.pinned || tab.essential ? this.settings.thirdPartyOnPinned : null
    }
    wc.send('zen:page-flags', flags)
  }

  broadcastPageFlags(): void {
    for (const id of this.views.keys()) this.sendPageFlags(id)
  }

  destroyView(tabId: string): void {
    const view = this.views.get(tabId)
    if (!view) return
    this.views.delete(tabId)
    this.httpsUpgraded.delete(tabId)
    this.browser.window.detachView(view)
    if (!view.webContents.isDestroyed()) {
      this.byWebContentsId.delete(view.webContents.id)
      view.webContents.close({ waitForBeforeUnload: false })
    }
    this.browser.state.devtoolsOpenFor.delete(tabId)
  }

  /** Unload a tab's WebContents while keeping it in the sidebar (Zen's "pending" tabs). */
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
    this.browser.window.focusContent()
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
    tab.id = closed.tab.id in m.tabs ? tab.id : closed.tab.id
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
    const view = this.ensureLoaded(tabId)
    if (!view) return
    if (opts.upgradedFrom) this.httpsUpgraded.set(tabId, opts.upgradedFrom)
    else this.httpsUpgraded.delete(tabId)
    view.setBackgroundColor(this.backgroundFor(url))
    void view.webContents.loadURL(url).catch(() => undefined)
    this.browser.state.commit()
  }

  goBack(tabId: string): void {
    const wc = this.webContents(tabId)
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  }

  goForward(tabId: string): void {
    const wc = this.webContents(tabId)
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  }

  reload(tabId: string, skipCache = false): void {
    const tab = this.tab(tabId)
    if (!tab) return
    if (tab.discarded) {
      this.ensureLoaded(tabId)
      this.browser.state.commit()
      return
    }
    const wc = this.webContents(tabId)
    if (!wc) return
    if (tab.url.startsWith(ERROR_URL_PREFIX)) {
      const original = safeParam(tab.url, 'url')
      if (original) {
        this.navigate(tabId, original)
        return
      }
    }
    if (skipCache) wc.reloadIgnoringCache()
    else wc.reload()
  }

  stop(tabId: string): void {
    this.webContents(tabId)?.stop()
  }

  toggleMute(tabId: string): void {
    const tab = this.tab(tabId)
    if (!tab) return
    tab.muted = !tab.muted
    this.webContents(tabId)?.setAudioMuted(tab.muted)
    this.browser.state.commit()
  }

  setZoom(tabId: string, factor: number): void {
    const tab = this.tab(tabId)
    if (!tab) return
    const clamped = Math.min(5, Math.max(0.25, Math.round(factor * 100) / 100))
    tab.zoom = clamped
    this.webContents(tabId)?.setZoomFactor(clamped)
    this.browser.state.commitVolatile()
  }

  adjustZoom(tabId: string, direction: number): void {
    const tab = this.tab(tabId)
    if (!tab) return
    const steps = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]
    const current = this.webContents(tabId)?.getZoomFactor() ?? tab.zoom
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
      removeTabFromSplit(this.model, tabId)
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
    if (target.section !== 'regular' || target.spaceId !== tab.spaceId)
      removeTabFromSplit(this.model, tabId)
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
    const ids = tabIds.filter((id) => {
      const t = this.tab(id)
      return t && !t.essential
    })
    // All members must live in the active space – move them if needed (Zen splits within a space).
    for (const id of ids) {
      const t = this.tab(id)
      if (t && t.spaceId !== space.id)
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
    if (active.essential) return
    const space = this.activeSpace
    const list = space.tabIds.filter((id) => this.tab(id)?.pinned === active.pinned)
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
    this.browser.window.focusContent()
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
    this.browser.tabs.broadcastPageFlags()
  }

  closeGlance(): void {
    const glance = this.browser.state.glance
    if (!glance) return
    this.browser.state.glance = null
    this.destroyView(glance.tabId)
    delete this.model.tabs[glance.tabId]
    this.browser.state.commit()
    this.broadcastPageFlags()
    this.browser.window.focusContent()
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
    if (parent && !parent.essential) this.createSplit([parent.id, tab.id], 'vertical')
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
    clipboard.writeText(markdown ? `[${tab.customTitle ?? tab.title}](${url})` : url)
    this.browser.toast(markdown ? 'Copied URL as Markdown' : 'Copied URL')
  }

  toggleDevtools(tabId: string, mode: 'toggle' | 'inspect' | 'console' = 'toggle'): void {
    const wc = this.webContents(tabId)
    if (!wc) return
    if (mode === 'toggle' && wc.isDevToolsOpened()) {
      wc.closeDevTools()
      return
    }
    wc.openDevTools({ mode: 'detach', activate: true })
    if (mode === 'inspect') wc.inspectElement(0, 0)
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
