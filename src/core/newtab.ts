import type {
  CrashReason,
  FindResultInfo,
  KeyEventInput,
  LoadDetails,
  PageContextParams,
  PageDialogRequest,
  PageMessage,
  TabView,
  TabViewEvents,
  WindowOpenDisposition,
  WindowOpenTicket
} from './platform'
import type {
  NewTabPageAction,
  NewTabPageShortcut,
  NewTabPageState,
  NewTabSettings,
  NewTabShortcut,
  NewTabThemeVariant,
  PageDialogResponse,
  SpaceTheme,
  Tab,
  TopSite
} from '../shared/types'
import type { SafeBrowsingHit } from '../shared/privacy'
import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID } from '../shared/types'
import { NEW_TAB_URL, getHost, inputToUrl, isNewTabUrl } from '../shared/url'
import { resolveTheme, themeCssVariables } from '../shared/theme'
import { newId } from '../shared/ids'
import { MAX_NEW_TAB_SHORTCUTS } from '../shared/defaults'
import { createTabRecord, getSpace } from './model'
import type { Browser } from './browser'
import type { ZenWindow } from './window'

/** `www.` and case do not make a different site (matches `topSites` in history). */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '')
}

/** The grid shows at most this many tiles, whichever source fills it (shared with the chrome). */
export { MAX_NEW_TAB_SHORTCUTS }

/** Placeholder tab ids of pages preloaded off screen (never part of the model). */
const PRELOAD_ID_PREFIX = 'newtab_preload'

/** How long after the chrome is ready a window starts preloading its next new tab page. */
const PRELOAD_DELAY_MS = 700

interface Preload {
  win: ZenWindow
  view: TabView
  events: ForwardingEvents
  placeholder: Tab
  containerId: string
}

/**
 * Host events of a page that exists before its tab does. Until the page is adopted by a real tab
 * nothing listens (a crash or load failure just drops the preload); afterwards every event goes
 * to the tab's own sink as if the view had been created for it.
 */
export class ForwardingEvents implements TabViewEvents {
  target: TabViewEvents | null = null

  constructor(private readonly gone: () => void) {}

  onStartLoading(): void {
    this.target?.onStartLoading()
  }
  onStopLoading(): void {
    this.target?.onStopLoading()
  }
  onProgress(progress: number): void {
    this.target?.onProgress(progress)
  }
  onNavigated(url: string, inPage: boolean): void {
    this.target?.onNavigated(url, inPage)
  }
  onTitleUpdated(title: string): void {
    this.target?.onTitleUpdated(title)
  }
  onFaviconUpdated(favicons: string[]): void {
    this.target?.onFaviconUpdated(favicons)
  }
  onFailLoad(code: number, description: string, url: string, details?: LoadDetails): void {
    if (this.target) this.target.onFailLoad(code, description, url, details)
    else if (code !== -3) this.gone()
  }
  onUpgraded(from: string, to: string): void {
    this.target?.onUpgraded(from, to)
  }
  onUnsafeNavigation(url: string, hit: SafeBrowsingHit): void {
    this.target?.onUnsafeNavigation(url, hit)
  }
  onCrashed(reason: CrashReason): void {
    if (this.target) this.target.onCrashed(reason)
    else if (reason !== 'clean-exit') this.gone()
  }
  onAudioStateChanged(audible: boolean): void {
    this.target?.onAudioStateChanged(audible)
  }
  onMediaStateChanged(playing: boolean): void {
    this.target?.onMediaStateChanged(playing)
  }
  onRequestsBlocked(count: number): void {
    this.target?.onRequestsBlocked(count)
  }
  onEnterHtmlFullscreen(): void {
    this.target?.onEnterHtmlFullscreen()
  }
  onLeaveHtmlFullscreen(): void {
    this.target?.onLeaveHtmlFullscreen()
  }
  onDevtoolsOpened(): void {
    this.target?.onDevtoolsOpened()
  }
  onDevtoolsClosed(): void {
    this.target?.onDevtoolsClosed()
  }
  onFoundInPage(result: FindResultInfo): void {
    this.target?.onFoundInPage(result)
  }
  onZoomChanged(direction: 'in' | 'out'): void {
    this.target?.onZoomChanged(direction)
  }
  onContextMenu(params: PageContextParams): void {
    this.target?.onContextMenu(params)
  }
  onKey(input: KeyEventInput): boolean {
    return this.target?.onKey(input) ?? false
  }
  onTargetUrl(url: string): void {
    this.target?.onTargetUrl(url)
  }
  onDomReady(): void {
    this.target?.onDomReady()
  }
  onDestroyed(): void {
    if (this.target) this.target.onDestroyed()
    else this.gone()
  }
  onOpenWindow(
    url: string,
    disposition: WindowOpenDisposition,
    userGesture: boolean | null,
    features?: string
  ): WindowOpenTicket | null {
    return this.target?.onOpenWindow(url, disposition, userGesture, features) ?? null
  }
  onUserActivation(): void {
    this.target?.onUserActivation()
  }
  onPageMessage(message: PageMessage): void {
    this.target?.onPageMessage(message)
  }
  onDialog(request: PageDialogRequest): Promise<PageDialogResponse> {
    // A page nobody holds yet has no chrome to ask: the dialog is dismissed for it.
    return this.target?.onDialog(request) ?? Promise.resolve({ accepted: false, value: null })
  }
  onLeaveSite(reload: boolean): Promise<boolean> {
    return this.target?.onLeaveSite(reload) ?? Promise.resolve(true)
  }
  onNewTabAction(action: NewTabPageAction): void {
    this.target?.onNewTabAction(action)
  }
}

/** Title and address a shortcut is stored with; null when the address is not one. */
export function normalizeShortcutInput(
  title: string,
  url: string
): { title: string; url: string } | null {
  const address = inputToUrl(url)
  if (!address || !/^https?:\/\//i.test(address)) return null
  let canonical: string
  try {
    canonical = new URL(address).href
  } catch {
    return null
  }
  const trimmed = title.trim()
  return { title: trimmed || normalizeHost(getHost(canonical)) || canonical, url: canonical }
}

/**
 * The new tab page: `zen://newtab` in a real tab, its state (theme, settings, shortcuts, most
 * visited) pushed into the page, the actions the page sends back, and one page preloaded off
 * screen per window so Ctrl+T shows it in the same frame.
 *
 * The page is its own document; the browser never reaches into it. Everything the page shows
 * arrives as one `NewTabPageState` (synchronously before its first paint, then pushed after each
 * state commit that changed it) and everything the page wants is a `NewTabPageAction`.
 */
export class NewTabService {
  private readonly preloads = new Map<string, Preload>()
  /** Windows whose chrome has been up long enough to afford a preload. */
  private readonly ready = new Set<string>()
  private readonly lastPushed = new Map<string, string>()
  private topSitesCache: { key: string; sites: TopSite[] } | null = null
  private shortcutsCache: { key: string; favicons: Map<string, string | null> } | null = null
  private historyVersion = 0

  constructor(private readonly browser: Browser) {
    browser.state.newTabBackgroundFor = () => {
      const host = browser.platform.newTabBackground
      return { image: Boolean(host?.current()), canPick: Boolean(host) }
    }
    browser.history.onChange(() => {
      this.historyVersion += 1
      this.push()
    })
  }

  /** The page is on (setting) and the host can render it (capability). */
  get enabled(): boolean {
    return this.browser.state.capabilities.newTabPage && this.settings.enabled
  }

  private get settings(): NewTabSettings {
    return this.browser.state.settings.newTab
  }

  // ---------------------------------------------------------------------------
  // Opening
  // ---------------------------------------------------------------------------

  /**
   * Ctrl+T, the sidebar's New Tab button, a double-click on empty sidebar: a new active tab at
   * `zen://newtab` with the URL bar opening over it in new-tab mode (typing navigates the tab).
   * With the page turned off, the URL bar alone opens, as before the page existed.
   */
  open(win: ZenWindow): void {
    if (!this.enabled) {
      this.browser.emit('urlbar.toggle', { mode: 'new-tab' }, win)
      return
    }
    const tabs = this.browser.tabs
    const containerId = this.containerFor(win)
    const preload = this.takePreload(win, containerId)
    const tab = tabs.createTab({ url: NEW_TAB_URL, active: false, load: false }, win)
    if (preload) {
      const events = tabs.attachView(preload.view, tab.id, win)
      if (events) preload.events.target = events
      else preload.view.destroy()
    }
    tabs.activateTab(tab.id, win)
    // The chrome must hold the tab (and see it active) before it hears about it.
    this.browser.state.afterBroadcast(() =>
      this.browser.emit('newtab.opened', { tabId: tab.id }, win)
    )
    this.sync()
  }

  /** Where `nav.home` and fresh blank / private windows go with the page on. */
  homeUrl(): string | null {
    return this.enabled ? NEW_TAB_URL : null
  }

  /** The new tab pages a window shows: the tab records are theirs, so are the state pushes. */
  private containerFor(win: ZenWindow): string {
    if (win.isPrivate) return PRIVATE_CONTAINER_ID
    return win.activeSpace().containerId ?? DEFAULT_CONTAINER_ID
  }

  // ---------------------------------------------------------------------------
  // State for the page
  // ---------------------------------------------------------------------------

  /** Everything the page renders, for a real tab or a preloaded placeholder; null for others. */
  stateFor(tabId: string): NewTabPageState | null {
    const tab = this.browser.tabs.tab(tabId)
    if (tab) {
      if (!isNewTabUrl(tab.url)) return null
      const win = this.browser.tabs.windowFor(tabId)
      const space = getSpace(this.browser.state.model, tab.spaceId) ?? win.activeSpace()
      return this.build(space.theme, tab.containerId === PRIVATE_CONTAINER_ID)
    }
    for (const preload of this.preloads.values()) {
      if (preload.placeholder.id !== tabId) continue
      return this.build(preload.win.activeSpace().theme, preload.win.isPrivate)
    }
    return null
  }

  private build(theme: SpaceTheme | null, isPrivate: boolean): NewTabPageState {
    const settings = this.settings
    const background = this.browser.platform.newTabBackground
    return {
      light: this.variant(theme, false),
      dark: this.variant(theme, true),
      colorScheme: this.browser.state.settings.colorScheme,
      isPrivate,
      shortcutsMode: settings.shortcuts,
      background: settings.background,
      greeting: settings.greeting,
      // A private window's page has no tiles: neither what was browsed elsewhere nor the user's
      // own shortcuts – its explainer stands where the grid would (design language v2 §9.29).
      shortcuts: !isPrivate && settings.shortcuts === 'custom' ? this.shortcuts() : [],
      topSites: !isPrivate && settings.shortcuts === 'most-visited' ? this.topSites() : [],
      backgroundImage: background?.current() ?? null,
      canPickImage: Boolean(background)
    }
  }

  private variant(theme: SpaceTheme | null, dark: boolean): NewTabThemeVariant {
    const resolved = resolveTheme(theme, dark)
    return { vars: themeCssVariables(resolved), isDark: resolved.isDark }
  }

  private topSites(): TopSite[] {
    const hidden = this.browser.state.newTabHiddenHosts
    const key = `${this.historyVersion}|${hidden.join(',')}`
    if (this.topSitesCache?.key === key) return this.topSitesCache.sites
    const sites = this.browser.history.topSites(MAX_NEW_TAB_SHORTCUTS, hidden)
    this.topSitesCache = { key, sites }
    return sites
  }

  /** The custom tiles with the favicons history knows. */
  private shortcuts(): NewTabPageShortcut[] {
    const list = this.browser.state.newTabShortcuts.slice(0, MAX_NEW_TAB_SHORTCUTS)
    const key = `${this.historyVersion}|${list.map((s) => s.url).join('\n')}`
    if (this.shortcutsCache?.key === key) {
      const favicons = this.shortcutsCache.favicons
      return list.map((s) => ({ ...s, favicon: favicons.get(s.url) ?? null }))
    }
    const favicons = new Map<string, string | null>()
    for (const s of list) favicons.set(s.url, this.browser.history.siteFaviconFor(s.url))
    this.shortcutsCache = { key, favicons }
    return list.map((s) => ({ ...s, favicon: favicons.get(s.url) ?? null }))
  }

  /**
   * After every state commit (and every history change): hand each live new tab page – real tabs
   * and preloads alike – its state when it differs from the last one it got, and keep the
   * preloads in step with the windows.
   */
  push(): void {
    const live = new Set<string>()
    for (const [tabId, view] of this.browser.tabs.allViews()) {
      const tab = this.browser.tabs.tab(tabId)
      if (!tab || !isNewTabUrl(tab.url) || view.isDestroyed()) continue
      live.add(tabId)
      this.pushTo(tabId, view, false)
    }
    for (const preload of this.preloads.values()) {
      live.add(preload.placeholder.id)
      this.pushTo(preload.placeholder.id, preload.view, false)
    }
    for (const id of [...this.lastPushed.keys()]) if (!live.has(id)) this.lastPushed.delete(id)
    this.sync()
  }

  private pushTo(tabId: string, view: TabView, force: boolean): void {
    if (!view.sendNewTabState) return
    const state = this.stateFor(tabId)
    if (!state) return
    const json = JSON.stringify(state)
    if (!force && this.lastPushed.get(tabId) === json) return
    this.lastPushed.set(tabId, json)
    view.sendNewTabState(state)
  }

  // ---------------------------------------------------------------------------
  // Actions from the page
  // ---------------------------------------------------------------------------

  /** Something the page asked for. Only a tab that is showing the page is heard. */
  handleAction(tabId: string, action: NewTabPageAction): void {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab || !isNewTabUrl(tab.url)) return
    const win = this.browser.tabs.windowFor(tabId)
    switch (action.type) {
      case 'ready': {
        const view = this.browser.tabs.view(tabId)
        if (view) this.pushTo(tabId, view, true)
        return
      }
      case 'search':
        // Empty text: the search box was clicked – the omnibox opens with nothing typed yet.
        if (typeof action.text === 'string' && action.text.length < 200)
          this.browser.emit('newtab.opened', { tabId, text: action.text }, win)
        return
      case 'add-shortcut':
        if (this.addShortcut(action.title, action.url) === null)
          this.browser.toast('That is not a web address.', 'error', win)
        return
      case 'update-shortcut':
        this.updateShortcut(action.id, action.title, action.url)
        return
      case 'remove-shortcut':
        this.removeShortcut(action.id)
        return
      case 'restore-shortcut':
        this.restoreShortcut(
          { id: action.id, title: action.title, url: action.url },
          Number.isFinite(action.index) ? action.index : this.browser.state.newTabShortcuts.length
        )
        return
      case 'reorder-shortcuts':
        this.reorderShortcuts(action.ids)
        return
      case 'hide-site':
        this.hideSite(action.url)
        return
      case 'unhide-site':
        this.unhideSite(action.url)
        return
      case 'edit-shortcut':
        this.openShortcutDialog(tabId, action.id, win)
        return
      case 'tile-menu':
        if (typeof action.x !== 'number' || typeof action.y !== 'number') return
        this.browser.menus.showNewTabTileMenu(tabId, action, win)
        return
      case 'customize':
        // The one route for internal pages (`PageService`): the Settings tab at its New Tab
        // section on a page-tab host, opened by this tab; the overlay where pages are overlays.
        this.browser.pages.open('settings', 'newtab', win, tabId)
        return
    }
  }

  /**
   * The chrome's add (`id` null) or edit shortcut dialog over the page (design language v2
   * §9.23, through the content frame's dialog host). Nothing opens for a tile that is gone or
   * for an add on a full grid.
   */
  openShortcutDialog(tabId: string, id: string | null, win: ZenWindow): void {
    const list = this.browser.state.newTabShortcuts
    const shortcut = id ? list.find((s) => s.id === id) : undefined
    if (id ? !shortcut : list.length >= MAX_NEW_TAB_SHORTCUTS) return
    this.browser.emit(
      'newtab.shortcutDialog',
      { tabId, id: shortcut?.id ?? null, title: shortcut?.title ?? '', url: shortcut?.url ?? '' },
      win
    )
  }

  /** The page removes the tile itself (and offers Undo), as it does for the Delete key. */
  removeTileFromPage(tabId: string, id: string): void {
    this.browser.tabs.view(tabId)?.sendNewTabCommand?.({ type: 'remove-tile', id })
  }

  private updateSettings(patch: Partial<NewTabSettings>, win: ZenWindow): void {
    this.browser.updateSettings({ newTab: { ...this.settings, ...patch } }, win)
  }

  // ---------------------------------------------------------------------------
  // My shortcuts
  // ---------------------------------------------------------------------------

  /** Add a tile; null when the address is not a web address or the grid is full. */
  addShortcut(title: string, url: string): string | null {
    const input = normalizeShortcutInput(title, url)
    if (!input) return null
    const list = this.browser.state.newTabShortcuts
    if (list.length >= MAX_NEW_TAB_SHORTCUTS) return null
    const shortcut: NewTabShortcut = { id: newId('shortcut'), ...input }
    list.push(shortcut)
    this.browser.state.commit()
    return shortcut.id
  }

  updateShortcut(id: string, title: string, url: string): boolean {
    const input = normalizeShortcutInput(title, url)
    const shortcut = this.browser.state.newTabShortcuts.find((s) => s.id === id)
    if (!input || !shortcut) return false
    shortcut.title = input.title
    shortcut.url = input.url
    this.browser.state.commit()
    return true
  }

  /** Remove a tile; the page keeps what it needs for Undo (`restore-shortcut`). */
  removeShortcut(id: string): { shortcut: NewTabShortcut; index: number } | undefined {
    const list = this.browser.state.newTabShortcuts
    const index = list.findIndex((s) => s.id === id)
    if (index < 0) return undefined
    const [shortcut] = list.splice(index, 1)
    this.browser.state.commit()
    return { shortcut, index }
  }

  /** Undo of a removal: the tile comes back where it was (or at the end). */
  restoreShortcut(shortcut: NewTabShortcut, index: number): boolean {
    const input = normalizeShortcutInput(shortcut.title, shortcut.url)
    const list = this.browser.state.newTabShortcuts
    if (!input || !shortcut.id || list.some((s) => s.id === shortcut.id)) return false
    if (list.length >= MAX_NEW_TAB_SHORTCUTS) return false
    const at = Math.max(0, Math.min(list.length, Math.round(index)))
    list.splice(at, 0, { id: shortcut.id, ...input })
    this.browser.state.commit()
    return true
  }

  /** New grid order; ids that are not shortcuts are ignored, missing ones keep their order. */
  reorderShortcuts(ids: string[]): void {
    const list = this.browser.state.newTabShortcuts
    const byId = new Map(list.map((s) => [s.id, s]))
    const next: NewTabShortcut[] = []
    for (const id of ids) {
      const shortcut = byId.get(id)
      if (shortcut && !next.includes(shortcut)) next.push(shortcut)
    }
    for (const shortcut of list) if (!next.includes(shortcut)) next.push(shortcut)
    if (next.every((s, i) => s === list[i])) return
    this.browser.state.newTabShortcuts = next
    this.browser.state.commit()
  }

  // ---------------------------------------------------------------------------
  // Most visited
  // ---------------------------------------------------------------------------

  /** Remove a most-visited tile: its host stays off the grid until undone. */
  hideSite(url: string): void {
    const host = normalizeHost(getHost(url))
    if (!host) return
    const hidden = this.browser.state.newTabHiddenHosts
    if (hidden.includes(host)) return
    hidden.push(host)
    this.browser.state.commit()
  }

  unhideSite(url: string): void {
    const host = normalizeHost(getHost(url))
    const hidden = this.browser.state.newTabHiddenHosts
    const index = hidden.indexOf(host)
    if (index < 0) return
    hidden.splice(index, 1)
    this.browser.state.commit()
  }

  // ---------------------------------------------------------------------------
  // Background image
  // ---------------------------------------------------------------------------

  /** Let the user pick an image; on success the background switches to it. */
  async pickBackgroundImage(win: ZenWindow): Promise<boolean> {
    const host = this.browser.platform.newTabBackground
    if (!host) return false
    const picked = await host.pick(win)
    // The picker took the chrome's focus; give it back so the next click is not dropped.
    win.focusChrome()
    if (!picked) return false
    this.updateSettings({ background: 'image' }, win)
    return true
  }

  async clearBackgroundImage(): Promise<void> {
    const host = this.browser.platform.newTabBackground
    if (!host) return
    await host.clear()
    if (this.settings.background === 'image') {
      this.browser.state.settings.newTab = { ...this.settings, background: 'space' }
    }
    this.browser.state.commit()
  }

  // ---------------------------------------------------------------------------
  // Preloading
  // ---------------------------------------------------------------------------

  /** The chrome of `win` is up: a little later, preload its first new tab page. */
  onChromeReady(win: ZenWindow): void {
    setTimeout(() => {
      if (!win.alive || win.isClosing) return
      this.ready.add(win.id)
      this.sync()
    }, PRELOAD_DELAY_MS)
  }

  onWindowClosed(win: ZenWindow): void {
    this.ready.delete(win.id)
    this.dropPreload(win.id)
  }

  /** Every window that is ready holds one preloaded page for its current container; none when off. */
  sync(): void {
    if (!this.enabled) {
      for (const id of [...this.preloads.keys()]) this.dropPreload(id)
      return
    }
    const alive = new Set<string>()
    for (const win of this.browser.allWindows()) {
      alive.add(win.id)
      if (!this.ready.has(win.id) || win.isClosing) continue
      const current = this.preloads.get(win.id)
      const containerId = this.containerFor(win)
      if (current && !current.view.isDestroyed() && current.containerId === containerId) continue
      if (current) this.dropPreload(win.id)
      this.preload(win, containerId)
    }
    for (const id of [...this.preloads.keys()]) if (!alive.has(id)) this.dropPreload(id)
  }

  /** Whether `tabId` names a page preloaded for a window (hosts route its messages here). */
  isPreloadId(tabId: string): boolean {
    return tabId.startsWith(PRELOAD_ID_PREFIX)
  }

  private preload(win: ZenWindow, containerId: string): void {
    const views = this.browser.platform.views
    if (!views.retargetView || !win.alive) return
    const placeholder = createTabRecord({
      id: newId(PRELOAD_ID_PREFIX),
      spaceId: null,
      containerId,
      url: NEW_TAB_URL
    })
    const events = new ForwardingEvents(() => {
      this.dropPreload(win.id, placeholder.id)
      // Replace it (unless the window is going away with it).
      if (win.alive && !win.isClosing) this.sync()
    })
    let view: TabView
    try {
      view = views.createView(placeholder, events, win.host)
    } catch {
      return
    }
    // The page loads off the window and joins it only when adopted (`TabManager.attachView`): a
    // document committing in a child view takes the window's keyboard focus even while hidden,
    // which would swallow shortcuts and the typing that follows Ctrl+T. Loading detached is as
    // fast, and showing a loaded view moves no focus.
    view.detach()
    view.setBackgroundColor('#00000000')
    view.setVisible(false)
    view.setBounds(win.contentRect() ?? fallbackRect(win))
    this.preloads.set(win.id, { win, view, events, placeholder, containerId })
    view.loadURL(NEW_TAB_URL)
    // The page fetches its state synchronously as it starts; this keeps the pushed copy in step.
    this.pushTo(placeholder.id, view, false)
  }

  private takePreload(win: ZenWindow, containerId: string): Preload | null {
    const preload = this.preloads.get(win.id)
    if (!preload) return null
    this.preloads.delete(win.id)
    this.lastPushed.delete(preload.placeholder.id)
    if (preload.view.isDestroyed() || preload.containerId !== containerId) {
      if (!preload.view.isDestroyed()) preload.view.destroy()
      return null
    }
    return preload
  }

  private dropPreload(windowId: string, placeholderId?: string): void {
    const preload = this.preloads.get(windowId)
    if (!preload || (placeholderId && preload.placeholder.id !== placeholderId)) return
    this.preloads.delete(windowId)
    this.lastPushed.delete(preload.placeholder.id)
    if (!preload.view.isDestroyed()) preload.view.destroy()
  }

  /** Every preloaded page goes (quit, or the last window closed). */
  destroyAll(): void {
    for (const id of [...this.preloads.keys()]) this.dropPreload(id)
  }
}

/** Before the first layout: roughly the page area of a window with the sidebar open. */
function fallbackRect(win: ZenWindow): { x: number; y: number; width: number; height: number } {
  const size = win.alive ? win.host.contentSize() : { width: 1200, height: 800 }
  const sidebar = 260
  return {
    x: sidebar,
    y: 8,
    width: Math.max(320, size.width - sidebar - 8),
    height: Math.max(240, size.height - 16)
  }
}
