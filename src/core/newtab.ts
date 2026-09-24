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
  DevtoolsDock,
  NewTabDeviceState,
  NewTabHideableSection,
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
import { privateThirdPartyCookieStatus, type SafeBrowsingHit } from '../shared/privacy'
import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID } from '../shared/types'
import { BLANK_URL, NEW_TAB_URL, inputToUrl, isNewTabUrl } from '../shared/url'
import { makeTheme, resolveTheme, themeCssVariables, unfollowedTheme } from '../shared/theme'
import { engineFieldFavicon } from '../shared/search'
import { newId } from '../shared/ids'
import {
  DEFAULT_NEW_TAB_SETTINGS,
  MAX_NEW_TAB_SHORTCUTS,
  emptyNewTabDevice,
  hideSite,
  newTabBackground,
  newTabSections,
  newTabShortcutsMode,
  pinShortcut,
  removeSite,
  sanitizeNewTabDevice,
  sanitizeNewTabSettings,
  setNewTabSection,
  siteHost,
  toggleNewTabModule,
  unhideSite,
  unpinShortcut
} from '../shared/newTab'
import { createTabRecord, getSpace } from './model'
import type { Browser } from './browser'
import type { ZenWindow } from './window'

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
  onStartNavigation(url: string, sameDocument: boolean): void {
    this.target?.onStartNavigation?.(url, sameDocument)
  }
  onNavigated(url: string, inPage: boolean): void {
    this.target?.onNavigated(url, inPage)
  }
  onWillNavigate(url: string): boolean {
    return this.target?.onWillNavigate(url) ?? false
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
  onCrashed(reason: CrashReason, exitCode?: number): void {
    if (this.target) this.target.onCrashed(reason, exitCode)
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
  onDevtoolsOpened(dock?: DevtoolsDock): void {
    this.target?.onDevtoolsOpened(dock)
  }
  onDevtoolsClosed(): void {
    this.target?.onDevtoolsClosed()
  }
  onDevtoolsDockChanged(dock: DevtoolsDock): void {
    this.target?.onDevtoolsDockChanged?.(dock)
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
  onFocused(): void {
    this.target?.onFocused?.()
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

/** Whether two settings documents say the same thing (the Undo of a hidden section reads it). */
function sameNewTabSettings(a: NewTabSettings, b: NewTabSettings): boolean {
  if (a.enabled !== b.enabled || a.mode !== b.mode) return false
  if (a.preset !== b.preset || a.background !== b.background) return false
  const keys = new Set([...Object.keys(a.modules), ...Object.keys(b.modules)]) as Set<
    keyof NewTabSettings['modules']
  >
  for (const key of keys) if (a.modules[key] !== b.modules[key]) return false
  return true
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
  return { title: trimmed || siteHost(canonical) || canonical, url: canonical }
}

/**
 * The new tab page's service on both platforms, over the one model (`shared/newTab.ts`): the
 * user's shortcuts and removed hosts (`BrowserState.newTabDevice`, device-local) and the
 * background image behind the host's `NewTabBackgroundHost`, for the phone's page – which the
 * chrome draws from the state – as much as for the desktop's.
 *
 * On the desktop the page is `zen://newtab` in a real tab, its state (theme, settings,
 * shortcuts, most visited) pushed into the page, the actions the page sends back, and one page
 * preloaded off screen per window so Ctrl+T shows it in the same frame. The page is its own
 * document; the browser never reaches into it. Everything the page shows arrives as one
 * `NewTabPageState` (synchronously before its first paint, then pushed after each state commit
 * that changed it) and everything the page wants is a `NewTabPageAction`.
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
      return {
        image: Boolean(host?.current()),
        canPick: Boolean(host?.pick),
        accent: this.imageAccent()
      }
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

  private get device(): NewTabDeviceState {
    return this.browser.state.newTabDevice
  }

  /**
   * The one write path of the device-local sets: the next document is sanitised (the caps, the
   * host normalisation, one tile per address) and replaces the current one whole, so nothing
   * else holds a reference that a mutation could leave stale.
   */
  private updateDevice(mutate: (device: NewTabDeviceState) => NewTabDeviceState): void {
    const { state } = this.browser
    state.newTabDevice = sanitizeNewTabDevice(mutate(state.newTabDevice))
    // A change after "Restore default shortcuts" is the user's; the restore's Undo would undo it.
    this.restoredFrom = null
    state.commit()
  }

  /** What "Restore default shortcuts" replaced, for its Undo; null once anything else changed. */
  private restoredFrom: {
    shortcuts: NewTabShortcut[]
    hiddenHosts: string[]
    mode: NewTabSettings['mode']
  } | null = null

  /** The one write path of the settings from this service: sanitised on every write. */
  private setSettings(patch: Partial<NewTabSettings>): void {
    const { state } = this.browser
    state.settings.newTab = sanitizeNewTabSettings({ ...state.settings.newTab, ...patch })
    state.commit()
  }

  /**
   * An image the user just picked is meant to be seen: the source becomes the image and, on a
   * layout without a wallpaper, the wallpaper section comes on (the `custom` preset seeded from
   * the layout the user is leaving, as the phone's sheet did).
   */
  private showImage(): void {
    const settings = this.settings
    const shown = newTabSections(settings).wallpaper
    this.setSettings({
      ...(shown ? settings : toggleNewTabModule(settings, 'wallpaper', true)),
      background: 'image'
    })
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

  /**
   * Where a Home control goes (Settings › Homepage, SET-36 / NTP-30): the user's page, or the
   * new tab page – the served page where it is on, the blank tab the phone's chrome draws its
   * page over elsewhere; a "Specific page" homepage with no address yet opens that too. Null
   * with the homepage off: the Home controls hide and nothing runs.
   */
  homepageUrl(): string | null {
    const { homepage } = this.browser.state.settings
    if (homepage.mode === 'off') return null
    if (homepage.mode === 'url' && homepage.url) return homepage.url
    return this.homeUrl() ?? BLANK_URL
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

  /**
   * The settings resolved for a page: the preset's sections (`newTabSections`, never `modules`
   * directly), the grid's mode – `hidden` while the shortcuts section is off – and what to paint.
   * A private page also carries its "Block third-party cookies" switch's position and lock.
   */
  private build(theme: SpaceTheme | null, isPrivate: boolean): NewTabPageState {
    const settings = this.settings
    const sections = newTabSections(settings)
    const shortcutsMode = newTabShortcutsMode(settings)
    const host = this.browser.platform.newTabBackground
    const backgroundImage = host?.current() ?? null
    const background = newTabBackground(settings)
    // A private window's page has no tiles: neither what was browsed elsewhere nor the user's
    // own shortcuts – its explainer stands where the grid would (design language v2 §9.29).
    const shortcuts = !isPrivate && shortcutsMode !== 'hidden' ? this.shortcuts() : []
    const state: NewTabPageState = {
      light: this.variant(theme, false),
      dark: this.variant(theme, true),
      colorScheme: this.browser.state.settings.colorScheme,
      isPrivate,
      shortcutsMode,
      // An image source with no image on this device paints the space gradient, never a blank.
      background: background === 'image' && !backgroundImage ? 'space' : background,
      greeting: sections.greeting,
      shortcuts,
      topSites: shortcutsMode === 'most-visited' && !isPrivate ? this.topSites(shortcuts) : [],
      backgroundImage,
      canPickImage: Boolean(host?.pick),
      // The field leads with the engine's favicon (v2 §6), the pill's source: the extension's
      // engine while one holds the default, else the user's pick. A settings commit re-pushes
      // the page, so a new default engine changes the glyph on a live page.
      engineFavicon: engineFieldFavicon(this.browser.state.defaultSearchEngine())
    }
    // The same answer `ProtectionService.status()` gives the chrome (`PrivacyStatus`), read from
    // the settings it is computed from: a settings commit re-pushes the page, so a global-mode
    // change in Settings locks or unlocks the switch on a live private page at once.
    if (isPrivate)
      state.privateThirdPartyCookies = privateThirdPartyCookieStatus(
        this.browser.state.settings.privacy
      )
    return state
  }

  private variant(theme: SpaceTheme | null, dark: boolean): NewTabThemeVariant {
    const resolved = resolveTheme(theme, dark)
    return { vars: themeCssVariables(resolved), isDark: resolved.isDark }
  }

  /**
   * The most visited sites that fill the grid after the shortcuts: other hosts only (a shortcut
   * fronts the grid in place of its host's tile), none the user removed.
   */
  private topSites(shortcuts: readonly NewTabShortcut[]): TopSite[] {
    const n = MAX_NEW_TAB_SHORTCUTS - shortcuts.length
    if (n <= 0) return []
    const excluded = [
      ...this.device.hiddenHosts,
      ...shortcuts.map((s) => siteHost(s.url)).filter((host) => host !== '')
    ]
    const key = `${this.historyVersion}|${n}|${excluded.join(',')}`
    if (this.topSitesCache?.key === key) return this.topSitesCache.sites
    const sites = this.browser.history.topSites(n, excluded)
    this.topSitesCache = { key, sites }
    return sites
  }

  /** The user's shortcuts with the favicons history knows. */
  private shortcuts(): NewTabPageShortcut[] {
    const list = this.device.shortcuts.slice(0, MAX_NEW_TAB_SHORTCUTS)
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
          Number.isFinite(action.index) ? action.index : this.device.shortcuts.length
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
      case 'undo-restore-default-shortcuts':
        this.undoRestoreDefaultShortcuts()
        return
      case 'show-section':
        if (action.section === 'greeting' || action.section === 'shortcuts')
          this.showSection(action.section)
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
      case 'set-private-third-party-cookies':
        // Only a private page has the switch. On writes `block`, off writes `allow` – never
        // `default`, so the choice survives a later change of the global mode. The same path as
        // the `privacy.setThirdPartyCookiesPrivate` command: the sanitiser, the flags push to
        // the hosts and the commit happen there, and the commit re-pushes this page's state. A
        // write while `locked` is not refused: the engine stores it for when the lock lifts.
        if (tab.containerId !== PRIVATE_CONTAINER_ID || typeof action.blocked !== 'boolean') return
        this.browser.protection.setThirdPartyCookiesPrivate(action.blocked ? 'block' : 'allow', win)
        return
    }
  }

  /**
   * The chrome's add (`id` null) or edit shortcut dialog over the page (design language v2
   * §9.23, through the content frame's dialog host). Nothing opens for a tile that is gone or
   * for an add on a full grid.
   */
  openShortcutDialog(tabId: string, id: string | null, win: ZenWindow): void {
    const list = this.device.shortcuts
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

  /**
   * The page menu's "Hide Greeting" / "Hide Shortcuts" (NTP-18): the section off through the one
   * model (`setNewTabSection`, as Settings' switch writes it – so a named layout becomes Custom
   * with that section off), the commit's push taking it off every page, and this page's toast
   * raised with Undo (v2 §9.33: 8 s; §10.5: a reversible action asks nothing). What the
   * settings were is kept for the Undo, which puts them back whole – the layout's name
   * included – while nothing else has changed them since; otherwise it turns the section on.
   */
  hideSection(tabId: string, section: NewTabHideableSection): void {
    const before = this.settings
    const after = setNewTabSection(before, section, false)
    if (after === before) return
    this.setSettings(after)
    this.hidden = { section, before, after: this.settings }
    this.browser.tabs.view(tabId)?.sendNewTabCommand?.({ type: 'section-hidden', section })
  }

  /** The Undo of `hideSection` (`show-section`): the section back, as it was when it went. */
  showSection(section: NewTabHideableSection): void {
    const hidden = this.hidden
    this.hidden = null
    const current = this.settings
    if (hidden?.section === section && sameNewTabSettings(current, hidden.after))
      this.setSettings(hidden.before)
    else this.setSettings(setNewTabSection(current, section, true))
  }

  /** The last `hideSection`, for its Undo. */
  private hidden: {
    section: NewTabHideableSection
    before: NewTabSettings
    after: NewTabSettings
  } | null = null

  /** Whether a tile id names one of the user's shortcuts (the chrome's tile menu offers Edit). */
  isShortcut(id: string): boolean {
    return this.device.shortcuts.some((s) => s.id === id)
  }

  // ---------------------------------------------------------------------------
  // Shortcuts (the desktop's grid and the phone's pins: one list)
  // ---------------------------------------------------------------------------

  /**
   * Add a tile; null when the address is not a web address or the grid is full. A site that
   * already has a tile is not added twice: its tile's id comes back.
   */
  addShortcut(title: string, url: string): string | null {
    const input = normalizeShortcutInput(title, url)
    if (!input) return null
    const existing = this.device.shortcuts.find((s) => s.url === input.url)
    if (existing) return existing.id
    if (this.device.shortcuts.length >= MAX_NEW_TAB_SHORTCUTS) return null
    const shortcut: NewTabShortcut = { id: newId('shortcut'), ...input }
    this.updateDevice((d) => pinShortcut(d, shortcut))
    return shortcut.id
  }

  /** Edit a tile; false when it is gone, the address is not one, or another tile has it. */
  updateShortcut(id: string, title: string, url: string): boolean {
    const input = normalizeShortcutInput(title, url)
    const list = this.device.shortcuts
    const shortcut = list.find((s) => s.id === id)
    if (!input || !shortcut) return false
    if (list.some((s) => s.id !== id && s.url === input.url)) return false
    this.updateDevice((d) => ({
      ...d,
      shortcuts: d.shortcuts.map((s) => (s.id === id ? { id, ...input } : s))
    }))
    return true
  }

  /** Remove a tile; the page keeps what it needs for Undo (`restore-shortcut`). */
  removeShortcut(id: string): { shortcut: NewTabShortcut; index: number } | undefined {
    const list = this.device.shortcuts
    const index = list.findIndex((s) => s.id === id)
    if (index < 0) return undefined
    const shortcut = list[index]
    this.updateDevice((d) => unpinShortcut(d, shortcut.url))
    return { shortcut, index }
  }

  /** Undo of a removal: the tile comes back where it was (or at the end). */
  restoreShortcut(shortcut: NewTabShortcut, index: number): boolean {
    const input = normalizeShortcutInput(shortcut.title, shortcut.url)
    const list = this.device.shortcuts
    if (!input || !shortcut.id) return false
    if (list.some((s) => s.id === shortcut.id || s.url === input.url)) return false
    if (list.length >= MAX_NEW_TAB_SHORTCUTS) return false
    const at = Math.max(0, Math.min(list.length, Math.round(index)))
    this.updateDevice((d) => ({
      ...d,
      shortcuts: [
        ...d.shortcuts.slice(0, at),
        { id: shortcut.id, ...input },
        ...d.shortcuts.slice(at)
      ]
    }))
    return true
  }

  /** New grid order; ids that are not shortcuts are ignored, missing ones keep their order. */
  reorderShortcuts(ids: string[]): void {
    const list = this.device.shortcuts
    const byId = new Map(list.map((s) => [s.id, s]))
    const next: NewTabShortcut[] = []
    for (const id of ids) {
      const shortcut = byId.get(id)
      if (shortcut && !next.includes(shortcut)) next.push(shortcut)
    }
    for (const shortcut of list) if (!next.includes(shortcut)) next.push(shortcut)
    if (next.every((s, i) => s === list[i])) return
    this.updateDevice((d) => ({ ...d, shortcuts: next }))
  }

  /**
   * Whether the grid is anything but a fresh profile's – a pinned shortcut, a removed site or a
   * mode other than the default – so the page menu's "Restore Default Shortcuts" has work to do
   * (the row is greyed otherwise).
   */
  canRestoreDefaultShortcuts(): boolean {
    const device = this.device
    return (
      device.shortcuts.length > 0 ||
      device.hiddenHosts.length > 0 ||
      this.settings.mode !== DEFAULT_NEW_TAB_SETTINGS.mode
    )
  }

  /**
   * The page menu's "Restore Default Shortcuts" (NTP-22; Chrome's is a second link on the
   * removal toast, which §9.33 gives one action): the grid restored through the one model – the
   * commit's push redraws every page – and this page's toast raised ("Default shortcuts
   * restored") with Undo alone, as `hideSection` raises its own. Nothing is raised when the
   * grid was the default already.
   */
  restoreDefaultShortcutsFromPage(tabId: string): void {
    if (!this.restoreDefaultShortcuts()) return
    this.browser.tabs.view(tabId)?.sendNewTabCommand?.({ type: 'defaults-restored' })
  }

  /**
   * The grid as a fresh profile has it – the most visited mode, no pinned shortcuts, no removed
   * sites. Not a confirmation but an Undo (v2 §10.5, §9.33): what the three were is kept for
   * `undoRestoreDefaultShortcuts` until the next change to any of them. False when the grid is
   * the default already.
   */
  restoreDefaultShortcuts(): boolean {
    if (!this.canRestoreDefaultShortcuts()) return false
    const device = this.device
    const mode = this.settings.mode
    this.updateDevice((d) => ({ ...d, shortcuts: [], hiddenHosts: [] }))
    if (mode !== DEFAULT_NEW_TAB_SETTINGS.mode)
      this.setSettings({ mode: DEFAULT_NEW_TAB_SETTINGS.mode })
    // After the writes: a device write forgets the snapshot, since a later change is not undone.
    this.restoredFrom = { shortcuts: device.shortcuts, hiddenHosts: device.hiddenHosts, mode }
    return true
  }

  /** Undo of the restore: the pins, the removed sites and the mode as they were. */
  undoRestoreDefaultShortcuts(): boolean {
    const from = this.restoredFrom
    if (!from) return false
    this.restoredFrom = null
    this.updateDevice((d) => ({ ...d, shortcuts: from.shortcuts, hiddenHosts: from.hiddenHosts }))
    if (from.mode !== this.settings.mode) this.setSettings({ mode: from.mode })
    return true
  }

  /**
   * Settings' "Reset to default" for the background alone (NTP-12): the space gradient, and the
   * device's picked image let go – a single row's reset, so nothing is asked (§10.5).
   */
  async resetBackground(): Promise<void> {
    const host = this.browser.platform.newTabBackground
    if (host?.current()) await host.clear()
    if (this.settings.background !== DEFAULT_NEW_TAB_SETTINGS.background)
      this.setSettings({ background: DEFAULT_NEW_TAB_SETTINGS.background })
    else this.browser.state.commit()
  }

  /**
   * The whole page back to its defaults (NTP-22; the row's §9.23 confirmation stands before
   * this): the layout preset and its sections, the shortcuts mode, the background and the
   * greeting as `DEFAULT_NEW_TAB_SETTINGS` has them, the pinned shortcuts and removed sites
   * cleared, the picked image let go. `enabled` – whether a new tab opens the page at all – is
   * not the page's content and stays.
   */
  async reset(): Promise<void> {
    const host = this.browser.platform.newTabBackground
    if (host?.current()) await host.clear()
    this.restoredFrom = null
    this.browser.state.newTabDevice = emptyNewTabDevice()
    this.setSettings({ ...DEFAULT_NEW_TAB_SETTINGS, enabled: this.settings.enabled })
  }

  /**
   * The phone's tile menu: pin a site (a shortcut at the end of the grid, its host back among
   * the most visited if it was removed), unpin it, or take it off the page altogether.
   */
  pin(url: string, title: string): void {
    const input = normalizeShortcutInput(title, url)
    if (!input) return
    this.updateDevice((d) => pinShortcut(d, { id: newId('shortcut'), ...input }))
  }

  unpin(url: string): void {
    this.updateDevice((d) => unpinShortcut(d, url))
  }

  remove(url: string): void {
    this.updateDevice((d) => removeSite(d, url))
  }

  // ---------------------------------------------------------------------------
  // Most visited
  // ---------------------------------------------------------------------------

  /** Remove a most-visited tile: its host stays off the grid until undone. */
  hideSite(url: string): void {
    if (!siteHost(url)) return
    this.updateDevice((d) => hideSite(d, url))
  }

  unhideSite(url: string): void {
    if (!this.device.hiddenHosts.includes(siteHost(url))) return
    this.updateDevice((d) => unhideSite(d, url))
  }

  // ---------------------------------------------------------------------------
  // Background image
  // ---------------------------------------------------------------------------

  /** Let the user pick an image with the host's dialog; on success the background switches to it. */
  async pickBackgroundImage(win: ZenWindow): Promise<boolean> {
    const host = this.browser.platform.newTabBackground
    if (!host?.pick) return false
    const picked = await host.pick(win)
    // The picker took the chrome's focus; give it back so the next click is not dropped.
    win.focusChrome()
    if (!picked) return false
    this.followPicture()
    this.showImage()
    return true
  }

  async clearBackgroundImage(): Promise<void> {
    const host = this.browser.platform.newTabBackground
    if (!host) return
    await host.clear()
    if (this.settings.background === 'image') this.setSettings({ background: 'space' })
    else this.browser.state.commit()
  }

  /** The image's address for a chrome that paints the page itself (the phone's: a data URL). */
  backgroundImage(): string | null {
    return this.browser.platform.newTabBackground?.current() ?? null
  }

  /** The colour read from the image at `url` (`accent` null when the host could not read one). */
  private accentCache: { url: string; accent: string | null } | null = null
  /** The image address whose colour is being read. */
  private accentPending: string | null = null
  /** The address of a picture just picked, whose colour the following spaces take once read. */
  private followUrl: string | null = null

  /**
   * The colour the background picture suggests for the accent (NTP-14; `UIState.newTabBackground
   * .accent`): read once per image through the host's decoder, asynchronously – the first ask
   * returns null and starts the read, whose end commits the state so the chrome hears the
   * answer; an image that changed under a read drops it. Null with no image, or on a host that
   * has no decoder.
   */
  private imageAccent(): string | null {
    const host = this.browser.platform.newTabBackground
    const url = host?.current() ?? null
    if (!url || !host?.accent) return null
    if (this.accentCache?.url === url) return this.accentCache.accent
    if (this.accentPending !== url) {
      this.accentPending = url
      const settle = (accent: string | null): void => {
        if (this.accentPending !== url) return
        this.accentPending = null
        this.accentCache = { url, accent }
        if (this.followUrl === url) {
          this.followUrl = null
          this.recolourFollowing(accent)
        }
        this.browser.state.commit()
      }
      void host.accent().then(settle, () => settle(null))
    }
    return null
  }

  /**
   * Settings' "Use the picture's colour" switch (NTP-14). On: the window's active space takes the
   * picture's colour as its theme's primary through `makeTheme` – the same seed the theme
   * picker's swatch would give it – with the theme's other settings (opacity, texture, algorithm,
   * angle) kept, so the window, the sidebar and the page agree on the colour; and the theme is
   * marked as following the picture (`SpaceTheme.fromImage`), so each new picture picked while
   * the switch stays on recolours it the same way. Off: the following ends and the colours stay –
   * they are the space's now; the theme editor is where another comes from. The user's choice,
   * never made for them: a picked wallpaper does not recolour a space the user themed. False when
   * nothing changed: while the colour is not known, in a private window, whose look is one theme
   * by rule (v2 §9.19), or off already.
   */
  useImageColor(on: boolean, win: ZenWindow): boolean {
    if (win.isPrivate) return false
    const space = win.activeSpace()
    if (!on) {
      if (space.theme?.fromImage !== true) return false
      space.theme = unfollowedTheme(space.theme)
      this.browser.state.commit()
      return true
    }
    const accent = this.imageAccent()
    if (!accent) return false
    space.theme = followingTheme(space.theme, accent)
    this.browser.state.commit()
    return true
  }

  /**
   * A picture was just picked on this device: the spaces following the picture take its colour –
   * at once when it is known, else when its read ends (`imageAccent`'s settle; the read starts
   * here, not at the chrome's next look at the state, which a second picture over a first would
   * not bring). Only a pick follows, not the read of the picture found at boot: pictures are
   * each device's own, and two devices recolouring one synced space from two pictures would
   * never settle.
   */
  private followPicture(): void {
    const url = this.browser.platform.newTabBackground?.current() ?? null
    if (!url) return
    if (this.accentCache?.url === url) {
      this.recolourFollowing(this.accentCache.accent)
      this.browser.state.commit()
      return
    }
    this.followUrl = url
    this.imageAccent()
    // No decoder on this host: nothing will ever be read.
    if (this.accentPending !== url) this.followUrl = null
  }

  /** Every space following the picture takes `accent` as its primary; none without a colour. */
  private recolourFollowing(accent: string | null): void {
    if (!accent) return
    for (const space of this.browser.state.model.spaces) {
      if (space.theme?.fromImage === true) space.theme = followingTheme(space.theme, accent)
    }
  }

  /**
   * Keep an image the chrome read itself (the phone's file chooser), or with null let it go;
   * the background source follows – shown, for a pick; the space colours after a removal.
   */
  async setBackgroundImage(dataUrl: string | null): Promise<void> {
    const host = this.browser.platform.newTabBackground
    if (!host?.set) throw new Error('This device cannot keep a background image')
    await host.set(dataUrl)
    if (dataUrl) {
      this.followPicture()
      this.showImage()
    } else if (this.settings.background === 'image') this.setSettings({ background: 'space' })
    else this.browser.state.commit()
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

/**
 * `theme` recoloured from the picture's `accent` and marked as following it: the seed's colours
 * with the theme's other settings kept; a space with no theme yet takes the seed whole.
 */
function followingTheme(theme: SpaceTheme | null, accent: string): SpaceTheme {
  const seeded = makeTheme(accent)
  return theme
    ? { ...theme, colors: seeded.colors, monochrome: false, fromImage: true }
    : { ...seeded, fromImage: true }
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
