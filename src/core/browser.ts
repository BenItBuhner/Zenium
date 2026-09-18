import type {
  BookmarkImportResult,
  BookmarkNode,
  CommandArgs,
  CommandName,
  CommandResult,
  EventName,
  Events,
  Folder,
  FolderColor,
  KeyBinding,
  MediaState,
  Rect,
  SearchEngine,
  Settings,
  ShareAction,
  SharePayload,
  Shortcut,
  Space,
  Tab,
  WindowChrome,
  WindowKind
} from '../shared/types'
import { CONTENT_SETTINGS } from '../shared/contentSettings'
import { BrowserState, type PersistedWindow } from './state'
import { HistoryService } from './history'
import { SessionService } from './session'
import { BookmarkService } from './bookmarks'
import { DownloadService } from './downloads'
import { resolveDownloadSettings } from '../shared/downloads'
import { PermissionService } from './permissions'
import { PermissionPromptService } from './permissionPrompts'
import { PrivacyService } from './privacy'
import { PopupBlocker } from './popups'
import { ExternalLaunches } from './external'
import { SecurityPromptService } from './security'
import { PageDialogService } from './pageDialogs'
import { WindowPrompts } from './windowPrompts'
import { TabManager } from './tabs'
import { TabDragController } from './tabDrag'
import { ZenWindow } from './window'
import { Actions, type AnyAction } from './actions'
import { KeyboardHandler } from './keys'
import { Menus } from './menus'
import { SuggestionService } from './suggestions'
import { sanitizeResourceSettings } from './resources/switches'
import { AgentService } from './agent/service'
import { sanitizeAgentSettings } from './agent/settings'
import { BoostService } from './boosts'
import { ReaderService } from './reader'
import { LiveFolderService } from './livefolders'
import { ModService } from './mods'
import { SiteInfoService } from './siteInfo'
import { TranslateService } from './translate/service'
import { PageControls } from './pageControls'
import { FindMemory } from './find'
import { FullscreenService } from './fullscreen'
import { UpdateService } from './updates'
import { ExternalProtocolService } from './externalProtocols'
import { PasswordService } from './credentials/service'
import { AutofillService } from './autofill'
import { addressFormat, countries } from './credentials/address'
import { DefaultBrowserService } from './defaultBrowser'
import { BlockingService } from './blocking/service'
import { ProtectionService } from './protection/service'
import { NoExtensions, NoSync, NoUpdateHost, NoopGovernor } from './hostDefaults'
import {
  activeSpace,
  createFolder,
  createLocalSpace,
  createSpace,
  cycleSpace,
  deleteFolder,
  getSpace,
  orderedTabsForSpace,
  reorderContainer,
  reorderSpace,
  tabVisibleIn
} from './model'
import { getDomain, inputToUrl } from '../shared/url'
import { overlayForUrl } from '../shared/zenPages'
import { openAllPrompt, sortedByNameOrder, toggledBookmarksBarMode } from '../shared/bookmarkViews'
import { buildSearchUrl, matchKeyword } from '../shared/search'
import { routeSharedIntent, type SharedIntent } from '../shared/shareTarget'
import { copyConfirmation } from '../shared/clipboard'
import { IMAGE_URL_PREFIX } from '../shared/zenPages'
import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID } from '../shared/types'
import {
  ONBOARDING_ESSENTIALS,
  sanitizeAutofillSettings,
  sanitizePasswordSettings,
  spaceLabel
} from '../shared/defaults'
import { sanitizePhoneBar } from '../shared/phoneBar'
import { PRIVATE_THEME, captionColors, resolveTheme, rgbToHex } from '../shared/theme'
import { newId } from '../shared/ids'
import { sanitizeAppIcon } from '../shared/appIcon'
import { sanitizeUpdateSettings } from '../shared/updates'
import { sanitizePromoState } from '../shared/defaultBrowser'
import { sanitizeBlockingSettings } from '../shared/blocking'
import { isShortcutPreset } from '../shared/shortcuts'
import { sanitizePrivacySettings } from '../shared/privacy'
import type { ExtensionHost, Governor, PageMessage, Platform, SyncHost } from './platform'
import { JsonStore } from './store/JsonStore'

/**
 * How long a quit waits for the profile's final writes to land. Nothing of the profile is at
 * stake past it: the final documents were written synchronously; a host whose storage stalls
 * must not hold the quit up for good.
 */
const QUIT_SETTLE_TIMEOUT_MS = 3_000

type CommandHandlers = {
  [K in CommandName]: (
    args: CommandArgs<K>,
    win: ZenWindow
  ) => CommandResult<K> | Promise<CommandResult<K>>
}

const FOCUS_CHROME_EVENTS = new Set<EventName>([
  'urlbar.toggle',
  'overlay.open',
  'find.open',
  'theme.open',
  'space.new',
  'space.edit',
  'tab.startRename',
  'folder.startRename',
  'tab.editPinnedUrl',
  'tab.pickIcon',
  'menu.show',
  'menu.app',
  'bookmark.star',
  'bookmark.edit'
])

/**
 * The browser: wires every service together and implements the command surface the chrome talks
 * to. Owns every window; the tab model is shared between them (Zen's window sync).
 *
 * Platform neutral – hosts plug in through `Platform` and call `handleCommand(win, …)` for the
 * chrome's commands, `handlePageMessage` for page-script messages and `keys.handle` for keys.
 */
export class Browser {
  readonly state: BrowserState
  readonly history: HistoryService
  readonly bookmarks: BookmarkService
  readonly downloads: DownloadService
  readonly permissions: PermissionService
  /** The permission prompts the chrome shows, queued per tab. */
  readonly permissionPrompts: PermissionPromptService
  /** Clear browsing data and Safety check. */
  readonly privacy: PrivacyService
  /** Pop-up blocking: user activation per tab and what was blocked. */
  readonly popups: PopupBlocker
  /** Links that leave for another application (hosts whose engine does not gate them itself). */
  readonly external: ExternalLaunches
  /** HTTP authentication and client-certificate prompts. */
  readonly security: SecurityPromptService
  /** `alert` / `confirm` / `prompt` and "Leave site?" dialogs of pages, shown by the chrome. */
  readonly pageDialogs: PageDialogService
  /** Window-modal questions ("Close N tabs?", "Quit Zenium?"), shown by a window's chrome. */
  readonly windowPrompts: WindowPrompts
  readonly tabs: TabManager
  /** A sidebar tab drag in flight, followed across windows (drops into them, tear-offs). */
  readonly tabDrag: TabDragController
  /** Recently closed tabs and windows (Ctrl+Shift+T, the app menu's submenu, the history page). */
  readonly session: SessionService
  readonly actions: Actions
  readonly keys: KeyboardHandler
  readonly menus: Menus
  readonly suggestions: SuggestionService
  readonly boosts: BoostService
  readonly reader: ReaderService
  readonly liveFolders: LiveFolderService
  readonly extensions: ExtensionHost
  readonly mods: ModService
  readonly sync: SyncHost
  readonly governor: Governor
  /** The MCP server AI agents connect to. */
  readonly agents: AgentService
  /** Release checks against GitHub and the download / install flow. */
  readonly updates: UpdateService
  /** Connection, cookies, storage and permissions of a tab's site (the site-information sheet). */
  readonly siteInfo: SiteInfoService
  /** Links that leave the web: the confirm sheet and the remembered per-scheme choices. */
  readonly externalProtocols: ExternalProtocolService
  /** The encrypted credential vault and everything the password manager does with it. */
  readonly passwords: PasswordService
  /** In-page autofill: save / update prompts, the account picker, addresses, cards, passkey records. */
  readonly autofill: AutofillService
  /** The system's browser role: are we the default, and should we be asking to become it. */
  readonly defaultBrowser: DefaultBrowserService
  /** Ad and tracker blocking: the rule engine, its lists and the blocked-request counters. */
  readonly blocking: BlockingService
  /** Safe Browsing, HTTPS-only mode, secure DNS, third-party cookies and the GPC / DNT signals. */
  readonly protection: ProtectionService
  /** Offline page translation: detection, offers, the engine and its models. */
  readonly translate: TranslateService
  /** Desktop site, dark theme for sites and page zoom, remembered per site (Chrome's page controls). */
  readonly pageControls: PageControls
  /** The last find-in-page query per tab and profile-wide (what the bar reopens with). */
  readonly find = new FindMemory()
  /** Fullscreen hints (F11, a page's element) and the Esc hold that leaves the window's fullscreen. */
  readonly fullscreen: FullscreenService
  readonly windows = new Map<string, ZenWindow>()
  /** Set by `shutdown()`: the app is going away, windows close without further questions. */
  quitting = false
  private readonly handlers: CommandHandlers
  /** Close checks in flight per window, so a second request joins the first instead of asking twice. */
  private readonly closeChecks = new Map<string, Promise<boolean>>()
  private quitCheck: Promise<boolean> | null = null
  /** Images shared into the browser, shown by `zen://image?id=…` while the app runs. */
  private readonly sharedImages = new Map<string, string>()
  /** Windows whose chrome should come up with the URL bar open (fresh windows with a blank tab). */
  private readonly urlbarOnReady = new Set<string>()
  /** The shortcut table last handed to the host (`syncShortcuts`). */
  private syncedShortcuts: Shortcut[] | null = null

  constructor(readonly platform: Platform) {
    this.state = new BrowserState(
      platform.io,
      platform.info.os,
      platform.capabilities,
      platform.info.version
    )
    this.state.liveWindows = () => this.allWindows()
    this.state.load()
    if (platform.theme) {
      const theme = platform.theme
      theme.setSource(this.state.settings.colorScheme)
      this.state.systemDark = theme.systemDark()
      theme.onChanged(() => {
        const dark = theme.systemDark()
        if (dark === this.state.systemDark) return
        this.state.systemDark = dark
        this.state.commitVolatile()
      })
    }
    this.history = new HistoryService(platform.io)
    this.bookmarks = new BookmarkService(this.state)
    this.downloads = new DownloadService(
      platform.io,
      platform.downloads,
      (item, kind) => {
        this.state.commitVolatile()
        this.emitDownload('download.changed', { item, kind }, item.private)
      },
      {
        os: platform.info.os,
        settings: () => resolveDownloadSettings(this.state.settings),
        referrerFamiliar: (referrer) => this.history.visitedBeforeToday(referrer),
        onDanger: (item) => this.emitDownload('download.danger', { id: item.id }, item.private)
      }
    )
    this.state.downloadsFor = (win) => ({
      downloads: this.downloads.visibleTo(win.isPrivate),
      downloadsProgress: this.downloads.aggregateProgress(win.isPrivate ? {} : { private: false })
    })
    this.permissionPrompts = new PermissionPromptService(() => this.state.commitVolatile())
    this.permissions = new PermissionService(
      platform.io,
      platform.permissionPrompts ?? this.permissionPrompts
    )
    this.permissions.subscribe(() => this.state.commitVolatile())
    this.popups = new PopupBlocker(this)
    this.external = new ExternalLaunches(this)
    this.security = new SecurityPromptService(this)
    this.pageDialogs = new PageDialogService(this)
    this.windowPrompts = new WindowPrompts(this)
    this.pageControls = new PageControls(this)
    this.fullscreen = new FullscreenService(this)
    this.tabs = new TabManager(this)
    this.tabDrag = new TabDragController(this)
    this.session = new SessionService(this)
    this.history.onChange((kind) => {
      for (const w of this.allWindows()) w.send('history.changed', { kind })
    })
    this.governor = platform.createGovernor?.(this) ?? new NoopGovernor(this)
    this.actions = new Actions(this)
    this.keys = new KeyboardHandler(this)
    this.menus = new Menus(this)
    this.suggestions = new SuggestionService(this)
    this.boosts = new BoostService(this)
    this.reader = new ReaderService(this)
    this.liveFolders = new LiveFolderService(this)
    this.extensions = platform.createExtensions?.(this) ?? new NoExtensions(this)
    this.mods = new ModService(this)
    this.sync = platform.createSync?.(this) ?? new NoSync(this)
    this.agents = new AgentService(this)
    this.updates = new UpdateService(
      this,
      platform.createUpdateHost?.(this) ?? new NoUpdateHost(platform)
    )
    this.siteInfo = new SiteInfoService(this)
    this.externalProtocols = new ExternalProtocolService(this)
    this.passwords = new PasswordService(this, platform.passwords)
    this.autofill = new AutofillService(this)
    this.defaultBrowser = new DefaultBrowserService(this)
    this.blocking = new BlockingService(this)
    this.protection = new ProtectionService(this)
    this.translate = new TranslateService(this)
    this.privacy = new PrivacyService(this)
    this.state.extras = (win) => ({
      boosts: this.boosts.all(),
      zappingTabId: this.boosts.zappingTabId(),
      liveFolders: this.liveFolders.all(),
      extensions: this.extensions.list(),
      sidePanel: this.extensions.sidePanel(win),
      mods: this.mods.all(),
      sync: this.sync.status(),
      agents: this.agents.list(),
      agentServer: this.agents.serverStatus(),
      updates: this.updates.status(),
      passwords: this.passwords.status(),
      defaultBrowser: this.defaultBrowser.status(),
      blockedPopups: this.popups.all(),
      permissionRules: this.permissions.rules(),
      permissionPrompts: this.permissionPrompts.list(),
      securityPrompts: this.security.list(),
      pageDialogs: this.pageDialogs.list(),
      crashRestore: this.session.crashRestoreOffer(),
      autofill: this.autofill.uiState(),
      blocking: this.blocking.status(),
      privacy: this.protection.status(),
      translate: this.translate.uiState()
    })
    this.handlers = this.commandHandlers()
  }

  // ---------------------------------------------------------------------------
  // Windows
  // ---------------------------------------------------------------------------

  allWindows(): ZenWindow[] {
    return [...this.windows.values()].filter((w) => w.alive)
  }

  /** The window the user is interacting with (creates one when none is open, e.g. on macOS). */
  focusedWindow(): ZenWindow {
    const alive = this.allWindows()
    const focused = alive.find((w) => w.host.isFocused())
    if (focused) return focused
    const recent = [...alive].sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)[0]
    return recent ?? this.createWindow({ kind: 'synced' })
  }

  /** User-facing "new window" (capability gated – Android has exactly one window). */
  openWindow(kind: WindowKind, from?: ZenWindow): ZenWindow | null {
    if (!this.state.capabilities.windows) {
      this.toast('Multiple windows are not available on this device.', 'info', from)
      return null
    }
    return this.createWindow({ kind, from })
  }

  /** "Open in New Window" / "Open in New Private Window": a window of `kind` showing `url`. */
  openUrlInWindow(url: string, kind: WindowKind, from?: ZenWindow): void {
    if (!this.state.capabilities.windows) {
      // One window only: the next best thing is a new tab.
      this.tabs.createTab({ url, active: true }, from)
      return
    }
    const win = this.createWindow({ kind, from, empty: true })
    this.tabs.createTab({ url, active: true }, win)
  }

  createWindow(opts: {
    kind: WindowKind
    from?: ZenWindow
    persisted?: PersistedWindow
    /** Toolbar-only chrome for a page's sized popup (default: the full sidebar chrome). */
    chrome?: WindowChrome
    /**
     * Where to place the window: where a popup asked to be, or where a reopened window was; full
     * windows without bounds cascade from `from`.
     */
    bounds?: Rect | null
    /**
     * Start without the starter tab of blank / private windows (the caller adds the tabs, or
     * adopts a page right away).
     */
    empty?: boolean
  }): ZenWindow {
    const m = this.state.model
    const id = opts.persisted?.id ?? newId('window')
    const from = opts.from
    let localSpace: Space | null = null
    let activeSpaceId: string
    if (opts.kind === 'synced') {
      const fromSpace = from && !from.localSpace ? from.activeSpaceId : undefined
      activeSpaceId = opts.persisted?.activeSpaceId ?? fromSpace ?? m.activeSpaceId
      if (!getSpace(m, activeSpaceId)) activeSpaceId = activeSpace(m).id
    } else {
      // Zen: a blank window inherits the container (and look) of the space it was opened from.
      const origin = from && !from.localSpace ? from.activeSpace() : activeSpace(m)
      const isPrivate = opts.kind === 'private'
      localSpace = createLocalSpace(
        id,
        isPrivate ? 'Private' : 'Blank Window',
        isPrivate ? '🕶️' : '',
        isPrivate ? PRIVATE_CONTAINER_ID : origin.containerId,
        isPrivate ? PRIVATE_THEME : origin.theme
      )
      m.localSpaces[localSpace.id] = localSpace
      activeSpaceId = localSpace.id
    }
    const chrome = opts.chrome ?? 'full'
    const win = new ZenWindow(this, {
      id,
      kind: opts.kind,
      chrome,
      material: this.state.capabilities.windowMaterial
        ? this.state.settings.windowMaterial
        : 'none',
      bounds: opts.persisted?.bounds ?? opts.bounds ?? null,
      displayId: opts.persisted?.displayId ?? null,
      maximized: opts.persisted?.maximized ?? false,
      activeSpaceId,
      selection: opts.persisted?.selection ?? {},
      compact:
        chrome === 'popup'
          ? false
          : (opts.persisted?.compact ??
            from?.compactEnabled ??
            this.state.settings.compactMode.enabled),
      localSpace,
      cascadeFrom: opts.bounds ? undefined : from
    })
    this.windows.set(id, win)
    const theme = resolveTheme(win.activeSpace().theme, this.darkScheme())
    win.host = this.platform.windows.create(win, {
      bounds: win.initialBounds,
      displayId: win.initialDisplayId,
      maximized: win.initialMaximized,
      cascadeFrom: win.cascadeFrom,
      title: win.isPrivate ? 'Zenium (Private Browsing)' : 'Zenium',
      chrome,
      material: win.material,
      backgroundColor: rgbToHex(theme.averageColor),
      captionColors: captionColors(theme)
    })
    this.governor.watchWindow(win)
    if (localSpace && !opts.empty) {
      // Blank / private windows start with an empty tab and the URL bar open.
      const tab = this.tabs.createTab({ active: true, load: false }, win)
      win.select(localSpace, tab.id)
      this.urlbarOnReady.add(win.id)
    }
    this.state.commit()
    return win
  }

  /** Native caption buttons follow the theme of the space each window shows. */
  private syncCaptionColors(): void {
    const dark = this.darkScheme()
    for (const win of this.allWindows()) {
      if (!win.host.setCaptionColors) continue
      win.host.setCaptionColors(captionColors(resolveTheme(win.activeSpace().theme, dark)))
    }
  }

  /** Whether the chrome renders dark: the Appearance setting, or the OS scheme when it follows it. */
  darkScheme(): boolean {
    const scheme = this.state.settings.colorScheme
    if (scheme === 'system') return this.state.systemDark ?? false
    return scheme === 'dark'
  }

  /** The chrome of `win` finished loading for the first time. */
  onChromeReady(win: ZenWindow): void {
    if (this.state.settings.onboardingDone && !this.session.holdsPages())
      this.tabs.claimVisible(win)
    if (this.urlbarOnReady.delete(win.id))
      setTimeout(() => this.emit('urlbar.toggle', { mode: 'new-tab' }, win), 150)
    // Whatever loading the profile changed under the user is said once, in the first window.
    const notices = this.state.migrationNotices.splice(0)
    if (notices.length)
      setTimeout(() => notices.forEach((message) => this.toast(message, 'info', win)), 600)
  }

  onWindowFocused(win: ZenWindow): void {
    if (this.state.settings.onboardingDone && !this.session.holdsPages())
      this.tabs.claimVisible(win)
    this.defaultBrowser.onForeground()
  }

  /**
   * `win` comes up on a fresh empty tab with the URL bar open – how a session that starts over
   * begins ("restore previous session" off, or the last session's pages declined after a crash).
   */
  openFreshTab(win: ZenWindow): void {
    this.tabs.createTab({ active: true, load: false }, win)
    if (win.chromeReady) setTimeout(() => this.emit('urlbar.toggle', { mode: 'new-tab' }, win), 150)
    else this.urlbarOnReady.add(win.id)
  }

  onWindowClosing(win: ZenWindow): void {
    this.windowPrompts.cancelForWindow(win)
    this.tabs.releaseWindow(win, this.quitting)
  }

  // ---------------------------------------------------------------------------
  // Closing windows and quitting, the way the user asks for it
  // ---------------------------------------------------------------------------

  /**
   * Close a window as the user asked (Ctrl+Shift+W, the caption button, the menu): first the
   * warning about its tabs (when more than one closes and the setting is on), then every page
   * whose `beforeunload` objects gets to ask "Leave site?", one after the other. The window
   * closes once everything agreed; resolves true then. Hosts route their native close request
   * here and close for real only once `win.closeApproved` is set.
   */
  async requestWindowClose(win: ZenWindow): Promise<boolean> {
    if (!win.alive || win.isClosing) return false
    if (win.closeApproved || this.quitting) {
      win.closeApproved = true
      win.host.close()
      return true
    }
    let check = this.closeChecks.get(win.id)
    if (!check) {
      check = this.confirmWindowClose(win).finally(() => this.closeChecks.delete(win.id))
      this.closeChecks.set(win.id, check)
    }
    if (!(await check) || !win.alive) return false
    win.closeApproved = true
    win.host.close()
    return true
  }

  private async confirmWindowClose(win: ZenWindow): Promise<boolean> {
    const count = this.tabs.closingTabCount(win)
    if (this.state.settings.warnOnCloseWindow && count > 1) {
      if (!(await this.windowPrompts.ask(win, 'close-tabs', count))) return false
    }
    if (this.quitting) return true
    return this.confirmUnloadAll(this.tabs.viewsClosingWith(win), [win])
  }

  /**
   * Quit as the user asked (Ctrl+Q, the app menu, the Dock): the warning about the open tabs
   * (the window setting applies – closing the last window is quitting), then every objecting
   * page's "Leave site?". The app quits once everything agreed. Hosts route their own quit
   * requests here and quit for real only once `quitting` is set (`shutdown`).
   */
  async requestQuit(from?: ZenWindow): Promise<boolean> {
    if (this.quitting) return true
    if (!this.quitCheck) {
      this.quitCheck = this.confirmQuit(from).finally(() => {
        this.quitCheck = null
      })
    }
    if (!(await this.quitCheck)) return false
    // Every request that waited on the same check quits once.
    if (this.quitting) return true
    this.shutdown()
    await this.settled()
    this.platform.app.quit()
    return true
  }

  /** Whether a document of the profile is still being written (`settled` waits for it). */
  get writing(): boolean {
    return JsonStore.busy
  }

  /**
   * Resolves once the profile's final writes have landed – `shutdown` wrote synchronously, but a
   * debounced write that had already started lands after it and is followed by a repeat of the
   * final document (`JsonStore.flushSync`); the process must not go away before that repeat has.
   * Bounded, so a stalled disk cannot keep the app from quitting.
   */
  settled(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, QUIT_SETTLE_TIMEOUT_MS)
      void JsonStore.idle().then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private async confirmQuit(from?: ZenWindow): Promise<boolean> {
    const windows = this.allWindows()
    if (windows.length === 0) return true
    const win = from?.alive ? from : this.focusedWindow()
    const count = this.tabs.openTabCount()
    if (this.state.settings.warnOnCloseWindow && count > 1) {
      if (!(await this.windowPrompts.ask(win, 'quit', count))) return false
    }
    if (this.quitting) return true
    const tabIds = windows.flatMap((w) => [...this.tabs.viewsOwnedBy(w).keys()])
    return this.confirmUnloadAll(tabIds, windows)
  }

  /**
   * Whether every page of `tabIds` may be unloaded: each one that objects asks "Leave site?" in
   * turn (Chrome's order). The first "Stay" ends it – the pages that went by then stay unloaded
   * in their tabs, and the ones on screen come back.
   */
  private async confirmUnloadAll(tabIds: string[], windows: ZenWindow[]): Promise<boolean> {
    for (const tabId of tabIds) {
      if (this.quitting) return true
      if (await this.tabs.confirmUnload(tabId, true)) continue
      for (const win of windows) if (win.alive) this.tabs.claimVisible(win)
      return false
    }
    return true
  }

  onWindowClosed(win: ZenWindow): void {
    this.windows.delete(win.id)
    this.tabDrag.onWindowClosed(win)
    this.fullscreen.onWindowClosed(win)
    for (const w of this.allWindows()) w.selection.delete(win.localSpace?.id ?? '')
    if (win.isPrivate) this.endPrivateSessionIfOver()
    if (this.allWindows().length === 0) {
      this.governor.stop()
      this.tabs.destroyAll()
      this.platform.app.lastWindowClosed()
      return
    }
    if (!this.quitting) this.state.commit()
  }

  /** A private tab closed (hosts with `capabilities.privateTabs`). */
  onPrivateTabClosed(): void {
    this.endPrivateSessionIfOver()
  }

  /**
   * The private session ends – private transfers stop, the engine's private partition is wiped –
   * once no private window and no private tab is left.
   */
  private endPrivateSessionIfOver(): void {
    if (this.allWindows().some((w) => w.isPrivate)) return
    if (this.tabs.privateTabs().length > 0) return
    this.downloads.endPrivateSession()
    // Certificates proceeded past in private windows are forgotten with the session, as in Chrome.
    this.security.certificateExceptions.forgetContainer(PRIVATE_CONTAINER_ID)
    void this.platform.sessions.clearPrivate()
  }

  /** Something (dock, launcher, intent) asked for a window while none is open. */
  ensureWindow(): ZenWindow {
    if (this.allWindows().length === 0) this.governor.start()
    return this.focusedWindow()
  }

  /**
   * A navigation that turned into a download leaves its tab without a committed document (and
   * without a renderer to route shortcuts through). Like Chrome, close such a tab when it was
   * opened only for the download; otherwise just make sure the keyboard keeps working.
   */
  onDownloadStarted(sourceTabId: string | null): void {
    // Firefox shows the downloads panel whenever a download begins; Chrome only animates its
    // toolbar button. The setting decides. Let any tab switch paint first so the panel can dim a
    // snapshot of the page behind it.
    const win = sourceTabId ? this.tabs.windowFor(sourceTabId) : this.focusedWindow()
    if (resolveDownloadSettings(this.state.settings).openPanelOnStart)
      setTimeout(() => this.emit('overlay.open', { kind: 'downloads' }, win), 200)
    const tab = this.tabs.tab(sourceTabId)
    const view = sourceTabId ? this.tabs.view(sourceTabId) : undefined
    if (!tab || !view) return
    if (view.hasDocument()) return
    if (!tab.pinned && !tab.essential && !view.canGoBack()) {
      this.tabs.closeTab(tab.id)
    } else {
      win.focusChrome()
    }
  }

  start(): void {
    if (this.state.settings.pinnedResetOnStartup) {
      for (const tab of Object.values(this.state.model.tabs)) {
        if ((tab.pinned || tab.essential) && tab.pinnedUrl) tab.url = tab.pinnedUrl
      }
    }
    this.state.subscribe(() => {
      for (const win of this.allWindows()) {
        win.send('state', this.state.snapshot(win))
        win.updateTitle()
      }
      this.syncCaptionColors()
      // The table is rebuilt (a new array) when the preset or the overrides change, from
      // Settings or from another device: hosts with their own copy get it then.
      if (this.state.shortcuts !== this.syncedShortcuts) this.syncShortcuts()
      // The menu bar (macOS) reflects the front window and the model: enabled states, the
      // compact mode check, recently closed entries, the bookmarks bar.
      this.menus.scheduleApplicationMenu()
    })
    // Rule sets load synchronously so the first page is protected.
    this.blocking.start()
    // After the blocking store is attached: HTTPS-only mode's set is persisted like the others.
    this.protection.start()
    // Zen restores every synced window (and the space each one was in). With "restore previous
    // session" off, the last session's tabs are forgotten and one window starts fresh.
    const { restoreSession } = this.state.settings
    if (!restoreSession) this.state.forgetSession()
    const restore =
      restoreSession && this.state.capabilities.windows
        ? this.state.restoredWindows
        : this.state.restoredWindows.slice(0, 1)
    if (restore.length === 0) this.createWindow({ kind: 'synced' })
    for (const persisted of restore) this.createWindow({ kind: 'synced', persisted })
    if (!restoreSession) {
      const win = this.allWindows()[0]
      if (win) this.openFreshTab(win)
    } else if (this.state.uncleanExit && this.state.platform !== 'android') {
      // The last run crashed (or was killed): its pages are offered, not loaded. Android ends
      // most runs by killing the process – that is its normal exit, and the pages just come back.
      this.session.onUncleanStart()
    }
    // The host may have come up under another icon (a fresh install with a restored profile,
    // a launcher alias flipped back by an update); the persisted choice wins.
    this.platform.app.setAppIcon?.(this.state.settings.appIcon)
    this.governor.start()
    this.liveFolders.start()
    void this.extensions.start()
    this.sync.start()
    this.agents.start()
    this.updates.start()
    this.passwords.start()
    this.autofill.start()
    this.defaultBrowser.start()
    this.translate.start()
    this.syncShortcuts()
    this.pageControls.push()
    this.state.commit()
  }

  // ---------------------------------------------------------------------------
  // Helpers used across services
  // ---------------------------------------------------------------------------

  emit<K extends EventName>(
    name: K,
    payload: Events[K],
    win: ZenWindow = this.focusedWindow()
  ): void {
    // Events that open chrome UI need keyboard focus in the chrome, not in the page.
    if (FOCUS_CHROME_EVENTS.has(name)) win.focusChrome()
    win.send(name, payload)
  }

  toast(message: string, kind: 'info' | 'error' = 'info', win?: ZenWindow): void {
    this.emit('toast', { message, kind }, win)
  }

  /**
   * The user asked for a new tab (Ctrl+T, the sidebar button, the menus). Zenium has no new-tab
   * page: the URL bar opens in new-tab mode, unless an extension the user opted in holds the
   * `chrome_url_overrides.newtab` override, in which case its page opens as the tab (never in
   * private windows, which extensions do not run in).
   */
  openNewTab(win: ZenWindow = this.focusedWindow()): void {
    const url = win.isPrivate ? null : this.extensions.newTabUrl()
    if (url) {
      this.tabs.createTab({ url, active: true }, win)
      return
    }
    this.emit('urlbar.toggle', { mode: 'new-tab' }, win)
  }

  /** Download events go to every window; private downloads only to private windows. */
  private emitDownload<K extends 'download.changed' | 'download.danger'>(
    name: K,
    payload: Events[K],
    isPrivate: boolean
  ): void {
    for (const win of this.allWindows()) {
      if (isPrivate && !win.isPrivate) continue
      win.send(name, payload)
    }
  }

  /** A page's DOM is ready: inject its Boost and check whether Reader View applies. */
  onPageReady(tabId: string): void {
    this.boosts.apply(tabId)
    void this.reader.detect(tabId)
    this.translate.onPageReady(tabId)
    this.autofill.onPageReady(tabId)
  }

  onNavigated(tabId: string): void {
    const tab = this.tabs.tab(tabId)
    if (tab) tab.readerable = false
    this.extensions.closePopup()
    this.translate.onNavigated(tabId)
    this.autofill.onNavigated(tabId)
    this.fullscreen.onNavigated(tabId)
  }

  updateMedia(): void {
    const media: MediaState[] = []
    for (const [tabId, view] of this.tabs.allViews()) {
      if (!view.isDestroyed() && view.isCurrentlyAudible()) media.push({ tabId, playing: true })
    }
    const before = JSON.stringify(this.state.media)
    this.state.media = media
    if (before !== JSON.stringify(media)) this.state.commitVolatile()
  }

  /** Zen: compact mode is per window; the last toggle is remembered for the next start. */
  toggleCompactMode(win: ZenWindow): void {
    win.compactEnabled = !win.compactEnabled
    win.compactSidebarPersistent = false
    win.compactSidebarRevealed = false
    this.state.settings.compactMode.enabled = win.compactEnabled
    this.state.commit()
  }

  setCompactMode(win: ZenWindow, enabled: boolean): void {
    win.compactEnabled = enabled
    if (!enabled) {
      win.compactSidebarPersistent = false
      win.compactSidebarRevealed = false
    }
    this.state.settings.compactMode.enabled = enabled
    this.state.commit()
  }

  toggleCompactSidebarPersistent(win: ZenWindow): void {
    if (!win.compactEnabled) {
      win.compactEnabled = true
      win.compactSidebarPersistent = true
      this.state.settings.compactMode.enabled = true
    } else {
      win.compactSidebarPersistent = !win.compactSidebarPersistent
    }
    win.compactSidebarRevealed = win.compactSidebarPersistent
    this.state.commit()
  }

  toggleFullscreen(win: ZenWindow): void {
    win.host.setFullScreen(!win.host.isFullScreen())
  }

  /** Ctrl+D without a star dialog: add to the default folder, or remove every copy again. */
  toggleBookmark(tabId: string, win: ZenWindow = this.tabs.windowFor(tabId)): void {
    const tab = this.tabs.tab(tabId)
    if (!tab || tab.url.startsWith('zen://')) return
    if (this.bookmarks.has(tab.url)) {
      this.bookmarks.removeByUrl(tab.url)
      this.toast('Bookmark removed', 'info', win)
      return
    }
    const node = this.bookmarks.create({
      title: tab.customTitle ?? tab.title,
      url: tab.url,
      favicon: tab.favicon
    })
    if (node) this.toast(`Bookmark added to ${this.bookmarks.pathLabel(node.id)}`, 'info', win)
  }

  /**
   * The star: bookmark the page into the default folder when it is not bookmarked yet, then let
   * the star dialog rename, refile or remove it. A second press edits the existing bookmark
   * instead of adding another one.
   */
  starTab(tabId: string, win: ZenWindow = this.tabs.windowFor(tabId)): void {
    const tab = this.tabs.tab(tabId)
    if (!tab || tab.url.startsWith('zen://')) return
    let node: BookmarkNode | null = this.bookmarks.findByUrl(tab.url)[0] ?? null
    const created = !node
    if (!node) {
      node = this.bookmarks.create({
        title: tab.customTitle ?? tab.title,
        url: tab.url,
        favicon: tab.favicon
      })
    }
    if (!node) return
    // The dialog reads the node from the window's state; a new node must get there first.
    const payload = { tabId, nodeId: node.id, created }
    this.state.afterBroadcast(() => this.emit('bookmark.star', payload, win))
  }

  /**
   * "Bookmark all tabs": Chrome asks for the new folder's name and place first. The dialog comes
   * back through `createBookmarksFromTabs`. The window's current space, or the given tabs.
   */
  bookmarkTabs(win: ZenWindow, tabIds?: readonly string[]): void {
    const space = win.activeSpace()
    const list = tabIds
      ? tabIds.map((id) => this.tabs.tab(id)).filter((t): t is Tab => Boolean(t))
      : orderedTabsForSpace(
          this.state.model,
          space,
          this.state.settings.containerSpecificEssentials,
          win.id
        )
    const pages = list.filter((t) => t.url && !t.url.startsWith('zen://'))
    if (pages.length === 0) {
      this.toast('There are no pages to bookmark.', 'info', win)
      return
    }
    // A whole space is offered under the space's name (the engine's default); picked tabs count.
    const defaultTitle = tabIds ? `${pages.length} tabs` : spaceLabel(space)
    this.emit('bookmark.allTabs', { tabIds: pages.map((t) => t.id), defaultTitle }, win)
  }

  createBookmarksFromTabs(
    tabIds: readonly string[],
    title: string,
    parentId: string,
    win: ZenWindow
  ): BookmarkNode | null {
    const list = tabIds.map((id) => this.tabs.tab(id)).filter((t): t is Tab => Boolean(t))
    const folder = this.bookmarks.bookmarkTabs(
      list,
      title.trim() || `${list.length} tabs`,
      parentId
    )
    if (!folder) {
      this.toast('There are no pages to bookmark.', 'info', win)
      return null
    }
    const count = this.bookmarks.getChildren(folder.id).length
    this.toast(
      `Bookmarked ${count} ${count === 1 ? 'tab' : 'tabs'} in “${folder.title}”`,
      'info',
      win
    )
    return folder
  }

  /** Ctrl+Shift+B, the bar's own menu, the app menu: show the bar for good or hide it for good. */
  toggleBookmarksBar(win: ZenWindow): void {
    const tab = this.tabs.activeTabFor(win)
    const mode = toggledBookmarksBarMode(this.state.settings.bookmarksBar, tab?.url ?? null)
    this.setBookmarksBarMode(mode, win)
  }

  setBookmarksBarMode(mode: Settings['bookmarksBar'], win: ZenWindow): void {
    this.updateSettings({ bookmarksBar: mode }, win)
  }

  /**
   * Cut or copy bookmarks: the app's clipboard takes the nodes, the host clipboard the pages'
   * addresses as text (Chrome), one per line, so they paste into any text field.
   */
  clipBookmarks(ids: readonly string[], mode: 'cut' | 'copy'): void {
    if (mode === 'cut') this.bookmarks.cut(ids)
    else this.bookmarks.copy(ids)
    const urls = ids
      .map((id) => this.bookmarks.get(id))
      .filter((n): n is BookmarkNode => n?.type === 'url' && Boolean(n.url))
      .map((n) => n.url ?? '')
    if (urls.length) this.platform.clipboard.writeText(urls.join('\n'))
  }

  /** The bar folder menu's "Sort by name": folders first, then bookmarks, A to Z, in one move. */
  sortBookmarkFolder(folderId: string): boolean {
    const order = sortedByNameOrder(this.bookmarks.tree, folderId)
    return order ? this.bookmarks.move(order, folderId, 0) : false
  }

  /** Open the bookmarks below the given nodes in a new window (private when asked). */
  async openBookmarksInWindow(
    ids: readonly string[],
    isPrivate: boolean,
    win: ZenWindow
  ): Promise<void> {
    const urls = await this.bookmarkUrlsToOpen(ids, win)
    if (urls.length === 0) return
    const target = this.openWindow(isPrivate ? 'private' : 'synced', win)
    if (!target) return
    urls.forEach((url, i) => this.tabs.createTab({ url, active: i === 0 }, target))
  }

  /**
   * The pages below the given nodes, each once; 15 or more ask first (Chrome), and only pages
   * that do open count as used.
   */
  private async bookmarkUrlsToOpen(ids: readonly string[], win: ZenWindow): Promise<string[]> {
    const seen = new Set<string>()
    const nodes: BookmarkNode[] = []
    for (const id of ids) {
      for (const node of this.bookmarks.tree.urlsUnder(id)) {
        if (!node.url || seen.has(node.id)) continue
        seen.add(node.id)
        nodes.push(node)
      }
    }
    const prompt = openAllPrompt(nodes.length)
    if (prompt && !(await this.platform.dialogs.confirm(prompt, win))) return []
    nodes.forEach((node) => this.bookmarks.touch(node.id))
    return nodes.map((node) => node.url ?? '')
  }

  /** Open a bookmark in the given tab (or a new one) and remember that it was used. */
  openBookmark(id: string, newTab: boolean, tabId: string | null, win: ZenWindow): void {
    const node = this.bookmarks.get(id)
    if (!node || node.type !== 'url' || !node.url) return
    this.bookmarks.touch(id)
    // Same path as a typed URL so space routing applies.
    this.submitUrlbar(node.url, newTab, tabId, false, win)
  }

  /** Open every bookmark below the given nodes in new tabs (the first one becomes active). */
  async openBookmarks(ids: readonly string[], win: ZenWindow): Promise<void> {
    const urls = await this.bookmarkUrlsToOpen(ids, win)
    urls.forEach((url, i) => this.tabs.createTab({ url, active: i === 0 }, win))
  }

  async importBookmarks(win: ZenWindow): Promise<BookmarkImportResult | null> {
    const files = await this.platform.dialogs.pickTextFiles(
      { title: 'Import bookmarks', extensions: ['html', 'htm'] },
      win
    )
    // The picker was opened from the chrome and took its focus; without it back, the next
    // click-opened popup menu on Linux is dropped by the host until something else refocuses.
    win.focusChrome()
    let total: BookmarkImportResult | null = null
    for (const file of files) {
      const result = this.bookmarks.importHtml(file.text)
      if (!result) continue
      total = total
        ? {
            bookmarks: total.bookmarks + result.bookmarks,
            folders: total.folders + result.folders,
            folderId: result.folderId
          }
        : result
    }
    if (files.length && !total) {
      this.toast('No bookmarks were found in that file.', 'error', win)
    } else if (total) {
      const n = total.bookmarks
      this.toast(`Imported ${n} ${n === 1 ? 'bookmark' : 'bookmarks'}`, 'info', win)
    }
    return total
  }

  async exportBookmarks(win: ZenWindow): Promise<boolean> {
    const stamp = new Date().toISOString().slice(0, 10)
    const saved = await this.platform.dialogs.saveTextFile(
      {
        title: 'Export bookmarks',
        defaultName: `zenium_bookmarks_${stamp}.html`,
        extensions: ['html'],
        mimeType: 'text/html',
        text: this.bookmarks.exportHtml(`Zenium ${this.state.version}`)
      },
      win
    )
    win.focusChrome()
    if (saved) this.toast('Bookmarks exported', 'info', win)
    return saved
  }

  newTabAfter(tabId: string, win: ZenWindow = this.tabs.windowFor(tabId)): void {
    const tab = this.tabs.tab(tabId)
    if (!tab) return
    this.tabs.createTab(
      {
        active: true,
        afterTabId: tabId,
        containerId: tab.containerId,
        pinned: tab.pinned,
        folderId: tab.folderId
      },
      win
    )
    this.emit('urlbar.toggle', { mode: 'edit', text: '' }, win)
  }

  createFolder(
    spaceId: string,
    name: string,
    icon: string,
    win?: ZenWindow,
    options: { color?: FolderColor; rename?: boolean } = {}
  ): Folder {
    const folder = createFolder(this.state.model, spaceId, name, icon, options.color)
    this.state.commit()
    if (options.rename !== false) this.emit('folder.startRename', { folderId: folder.id }, win)
    return folder
  }

  newFolderWithTab(spaceId: string, tabId: string, win?: ZenWindow): void {
    const folder = createFolder(this.state.model, spaceId, 'New Folder', '📁')
    this.tabs.moveToFolder(tabId, folder.id)
    this.state.commit()
    this.emit('folder.startRename', { folderId: folder.id }, win)
  }

  updateFolder(
    folderId: string,
    patch: Partial<Pick<Folder, 'name' | 'icon' | 'collapsed' | 'color'>>
  ): void {
    const folder = this.state.model.folders[folderId]
    if (!folder) return
    Object.assign(folder, patch)
    if (patch.name !== undefined && !patch.name.trim()) folder.name = 'Folder'
    this.state.commit()
  }

  deleteFolder(folderId: string, unpack: boolean): void {
    this.liveFolders.onFolderDeleted(folderId)
    const closed = deleteFolder(this.state.model, folderId, unpack)
    for (const id of closed) this.tabs.closeTab(id, true)
    this.state.commit()
  }

  /** Delete a space without asking (sync applied a deletion made elsewhere). */
  removeSpace(spaceId: string): void {
    const m = this.state.model
    const space = getSpace(m, spaceId)
    if (!space || space.windowId || m.spaces.length <= 1) return
    for (const id of [...space.tabIds]) this.tabs.closeTab(id, true)
    for (const folder of Object.values(m.folders))
      if (folder.spaceId === spaceId) {
        this.liveFolders.onFolderDeleted(folder.id)
        delete m.folders[folder.id]
      }
    const idx = m.spaces.indexOf(space)
    m.spaces.splice(idx, 1)
    const fallback = m.spaces[Math.max(0, idx - 1)].id
    if (m.activeSpaceId === spaceId) m.activeSpaceId = fallback
    for (const w of this.allWindows()) {
      w.selection.delete(spaceId)
      if (w.activeSpaceId === spaceId) this.tabs.switchSpace(fallback, w)
    }
  }

  reorderSpace(spaceId: string, index: number): void {
    reorderSpace(this.state.model, spaceId, index)
    this.state.commit()
  }

  unloadOtherSpaces(win: ZenWindow): void {
    for (const space of this.state.model.spaces) {
      if (space.id !== win.activeSpaceId) this.tabs.unloadSpace(space.id)
    }
  }

  async deleteSpace(spaceId: string, win: ZenWindow): Promise<void> {
    const m = this.state.model
    const space = getSpace(m, spaceId)
    if (!space || space.windowId || m.spaces.length <= 1) return
    const count = space.tabIds.length
    if (count > 0) {
      const ok = await this.platform.dialogs.confirm(
        {
          message: `Delete “${space.name}”?`,
          detail: `${count} tab${count === 1 ? '' : 's'} in this space will be closed. Essentials are kept.`,
          okLabel: 'Delete Space',
          cancelLabel: 'Cancel',
          danger: true
        },
        win
      )
      if (!ok) return
      // The space may have gone away while the dialog was up.
      if (!getSpace(m, spaceId) || m.spaces.length <= 1) return
    }
    this.removeSpace(spaceId)
    this.state.commit()
  }

  /** Space Routing: pick the space configured for a URL's domain, if any. */
  routeSpaceFor(url: string): string | null {
    const routing = this.state.settings.spaceRouting
    try {
      const host = new URL(url).hostname.replace(/^www\./, '')
      for (const [domain, spaceId] of Object.entries(routing)) {
        if (host === domain || host.endsWith(`.${domain}`))
          return getSpace(this.state.model, spaceId) ? spaceId : null
      }
    } catch {
      return null
    }
    return null
  }

  /** Zen 1.21: "Add Route for Domain" – route a tab's domain to a space. */
  addRouteForTab(tabId: string, spaceId: string): void {
    const tab = this.tabs.tab(tabId)
    const space = getSpace(this.state.model, spaceId)
    if (!tab || !space || space.windowId) return
    const domain = getDomain(tab.url)
    if (!domain) return
    this.state.settings.spaceRouting = { ...this.state.settings.spaceRouting, [domain]: spaceId }
    this.state.commit()
    this.toast(`${domain} now opens in ${space.name}`, 'info', this.tabs.windowFor(tabId))
  }

  /**
   * Bring a tab in front of the user: its window comes forward and shows it (a page's
   * `window.focus()` with a gesture in hand – the click on one of its notifications – lands here,
   * as it does in Chrome).
   */
  revealTab(tabId: string): void {
    if (!this.tabs.tab(tabId)) return
    const win = this.tabs.windowFor(tabId)
    this.tabs.activateTab(tabId, win)
    win.host.show()
    win.host.focus()
  }

  /**
   * Open a URL from outside the browser (command line, Android intent, share sheet, a page of
   * ours such as the release notes). `fromIntent` marks a tab another app sent (Android's view
   * and share intents): mobile system back at its first page returns to that app; it is not set
   * for URLs the browser opens on its own behalf.
   */
  openExternalUrl(
    url: string,
    win: ZenWindow = this.ensureWindow(),
    opts: { fromIntent?: boolean } = {}
  ): void {
    const routed = win.localSpace ? null : this.routeSpaceFor(url)
    const tab = this.tabs.createTab(
      { url, active: true, spaceId: routed ?? undefined, fromIntent: Boolean(opts.fromIntent) },
      win
    )
    if (routed && routed !== win.activeSpaceId) this.tabs.switchSpace(routed, win, tab.id)
    win.host.show()
    win.host.focus()
  }

  /** The user's search engine (the one picked in Settings, or the first one). */
  defaultSearchEngine(): SearchEngine {
    const engines = this.state.searchEngines
    return engines.find((e) => e.id === this.state.settings.searchEngineId) ?? engines[0]
  }

  /**
   * Zenium as a share target: what another app sent (`ACTION_SEND`, `ACTION_WEB_SEARCH`). A URL
   * opens in a tab, text is a search with the user's engine, an image opens as a page of its own.
   */
  openSharedIntent(intent: SharedIntent, win: ZenWindow = this.ensureWindow()): void {
    const route = routeSharedIntent(intent)
    const sent = { fromIntent: true }
    switch (route.kind) {
      case 'url':
        this.openExternalUrl(route.url, win, sent)
        return
      case 'search':
        this.openExternalUrl(buildSearchUrl(this.defaultSearchEngine(), route.query), win, sent)
        return
      case 'image': {
        // The bytes stay in memory and the tab keeps a short address, not megabytes of data URL.
        const id = newId('image')
        this.sharedImages.set(id, route.dataUrl)
        this.openExternalUrl(`${IMAGE_URL_PREFIX}?id=${id}`, win, sent)
        return
      }
      case 'none':
        this.toast('Nothing to open in the shared content', 'info', win)
        win.host.show()
        win.host.focus()
    }
  }

  /** The image behind a `zen://image?id=…` page, or null once the app restarted. */
  sharedImage(id: string): string | null {
    return this.sharedImages.get(id) ?? null
  }

  /**
   * Put text on the clipboard and say so where the chrome is the one to say it (Android below
   * 13; see `copyConfirmation`). Desktop stays as it was: silent, or `desktopConfirmation` where
   * it always had a toast of its own.
   */
  copyText(
    text: string,
    confirmation: string,
    win?: ZenWindow,
    desktopConfirmation: string | null = null
  ): void {
    this.platform.clipboard.writeText(text)
    const toast = copyConfirmation(
      this.state.platform,
      this.state.capabilities,
      confirmation,
      desktopConfirmation
    )
    if (toast) this.toast(toast, 'info', win)
  }

  /**
   * Share through the system sheet; a host without one copies the link and says so, which is
   * what "share" can mean on a desktop without a share target.
   */
  async share(payload: SharePayload, win: ZenWindow = this.focusedWindow()): Promise<void> {
    const { shell } = this.platform
    if (this.state.capabilities.share && shell.share) {
      try {
        await shell.share(payload)
      } catch (error) {
        this.toast(`Could not share: ${(error as Error).message}`, 'error', win)
      }
      return
    }
    const text = payload.url ?? payload.imageUrl ?? payload.text
    if (text) this.copyText(text, 'Link copied', win)
  }

  /** Share a tab's page: its title and address, with its favicon as the preview. */
  shareTab(tabId: string, win: ZenWindow = this.tabs.windowFor(tabId)): void {
    const tab = this.tabs.tab(tabId)
    if (!tab || !/^https?:/i.test(tab.url)) {
      this.toast('This page cannot be shared', 'info', win)
      return
    }
    void this.share(
      {
        title: tab.customTitle ?? tab.title,
        url: tab.url,
        tabId,
        favicon: tab.favicon ?? undefined
      },
      win
    )
  }

  /**
   * The browser's own row in the system share sheet (Android 14: Copy link, Screenshot, Print):
   * the host reports the tap once the sheet has closed; the tab the share started from does it.
   */
  onShareAction(action: ShareAction, win: ZenWindow): void {
    if (action.kind === 'copy') {
      this.copyText(action.url, 'Link copied', win)
      return
    }
    const tab = action.tabId ? this.tabs.tab(action.tabId) : undefined
    if (!tab) {
      this.toast('The page is no longer open', 'info', win)
      return
    }
    this.actions.run(action.kind === 'print' ? 'page.print' : 'page.screenshot', {
      sourceTabId: tab.id,
      win
    })
  }

  /** The system's screen for which links open in this app (Android's "Open by default"). */
  openAppLinkSettings(win: ZenWindow): void {
    const { shell } = this.platform
    if (this.state.capabilities.appLinkSettings && shell.openAppLinkSettings)
      shell.openAppLinkSettings()
    else this.toast('Link handling is set in the system settings on this device.', 'info', win)
  }

  /**
   * The app is going away for good (every check passed, or the system is shutting down): stop
   * the services, write the profile one last time – with the clean-exit marker – and freeze it.
   * Windows closing after this ask nothing and write nothing.
   */
  shutdown(): void {
    if (this.quitting) return
    this.quitting = true
    void this.agents.stop()
    this.updates.stop()
    this.downloads.shutdown()
    this.protection.stop()
    this.blocking.stop()
    this.translate.stop()
    this.passwords.shutdown()
    // The pages on screen have scrolled since their stacks were last read.
    this.tabs.rememberAllNavigation()
    this.state.markExiting()
    this.flushSync()
    this.state.freeze()
  }

  /** Persist everything now (mobile hosts call this when the app is backgrounded). */
  flushSync(): void {
    this.state.flushSync()
    this.history.flushSync()
    this.downloads.flushSync()
    this.boosts.flushSync()
    this.liveFolders.flushSync()
    this.extensions.flushSync()
    this.mods.flushSync()
    this.sync.flushSync()
    this.passwords.flushSync()
    this.blocking.flushSync()
    this.translate.flushSync()
  }

  private syncShortcuts(): void {
    const table = this.state.shortcuts
    this.syncedShortcuts = table
    const bindings: KeyBinding[] = []
    for (const s of table) {
      if (s.binding) bindings.push(s.binding)
      bindings.push(...s.extraBindings)
    }
    this.platform.views.setShortcuts?.(bindings)
    // The menu bar shows the chords: it changes with the table.
    this.menus.syncApplicationMenu()
  }

  // ---------------------------------------------------------------------------
  // URL bar submission
  // ---------------------------------------------------------------------------

  private submitUrlbar(
    input: string,
    newTab: boolean,
    tabId: string | null,
    background: boolean,
    win: ZenWindow
  ): void {
    const text = input.trim()
    if (!text) return
    if (!win.isPrivate && this.extensions.omniboxSubmit(input, newTab, background, win)) return
    const engines = this.state.searchEngines
    const keyword = matchKeyword(text, engines)
    let url: string | null = null
    let upgradedFrom: string | undefined
    if (keyword?.kind === 'scope') {
      // `@bookmarks foo` / `@history foo` open the manager; `@tabs foo` switches to the tab.
      if (keyword.scope === 'tabs') {
        const q = keyword.query.trim().toLowerCase()
        const hit = Object.values(this.state.model.tabs).find(
          (t) =>
            tabVisibleIn(t, win.id) &&
            (!q || `${t.customTitle ?? ''} ${t.title} ${t.url}`.toLowerCase().includes(q))
        )
        if (hit) this.tabs.activateTab(hit.id, win)
        return
      }
      this.emit('overlay.open', { kind: keyword.scope }, win)
      return
    }
    if (keyword) {
      if (!keyword.query.trim()) return
      url = buildSearchUrl(keyword.engine, keyword.query)
    } else {
      url = inputToUrl(text)
      if (url && url.startsWith('https://') && !/^[a-z][a-z0-9+.-]*:/i.test(text))
        upgradedFrom = text
      if (!url) {
        const engine =
          engines.find((e) => e.id === this.state.settings.searchEngineId) ?? engines[0]
        url = buildSearchUrl(engine, text)
      }
    }
    if (!url) return
    const overlay = overlayForUrl(url)
    if (overlay) {
      // `zen://history` / `zen://settings` open their chrome surface; no tab is spent on them.
      this.emit('overlay.open', { kind: overlay }, win)
      return
    }
    const routed = win.localSpace ? null : this.routeSpaceFor(url)
    const target = tabId ? this.tabs.tab(tabId) : undefined
    if (newTab || !target) {
      // An active tab is loaded once by `activateTab`; a background tab is loaded by `navigate`
      // below. Loading here *and* navigating (the old flow) started the page twice, which raced
      // the tab view's blank initial document into running its sandbox preload before the real
      // navigation committed – the two startup console errors (WIN-009).
      const tab = this.tabs.createTab(
        {
          url,
          active: !background,
          spaceId: routed ?? undefined,
          load: false,
          upgradedFrom: background ? undefined : upgradedFrom
        },
        win
      )
      if (routed && routed !== win.activeSpaceId && !background)
        this.tabs.switchSpace(routed, win, tab.id)
      if (background) this.tabs.navigate(tab.id, url, { upgradedFrom })
      return
    }
    this.tabs.navigate(target.id, url, { upgradedFrom })
  }

  /**
   * Chrome's "Paste and go" / "Paste and search" (URL-bar context menu, `urlbar.pasteAndGo` and
   * `urlbar.pasteAndSearch`): the clipboard's text goes where typed text would, or is searched
   * with the default engine whatever it looks like. Nothing happens for an empty clipboard.
   */
  async pasteAndGo(tabId: string | null, alwaysSearch: boolean, win: ZenWindow): Promise<void> {
    const read = this.platform.clipboard.readText
    if (!read) return
    const text = (await read.call(this.platform.clipboard)).trim().replace(/\s+/g, ' ')
    if (!text) return
    if (alwaysSearch) {
      const engines = this.state.searchEngines
      const engine = engines.find((e) => e.id === this.state.settings.searchEngineId) ?? engines[0]
      this.submitUrlbar(buildSearchUrl(engine, text), false, tabId, false, win)
      return
    }
    this.submitUrlbar(text, false, tabId, false, win)
  }

  // ---------------------------------------------------------------------------
  // Command surface
  // ---------------------------------------------------------------------------

  /** Run a chrome command for `win`. Unknown names throw so misuse surfaces during development. */
  handleCommand(win: ZenWindow, name: string, args: unknown): unknown {
    const handler = (this.handlers as Record<string, (a: unknown, w: ZenWindow) => unknown>)[name]
    if (!handler) throw new Error(`Unknown command: ${name}`)
    return handler(args, win)
  }

  /** A page script asked for something (Glance, third-party link routing, media state, zap). */
  handlePageMessage(tabId: string, message: PageMessage): void {
    const tab = this.tabs.tab(tabId)
    if (!tab || !message || typeof message.type !== 'string') return
    if (message.type === 'zap') {
      if (typeof message.selector === 'string') this.boosts.onZapped(tabId, message.selector)
      return
    }
    if (message.type === 'activation') {
      this.popups.activate(tabId)
      return
    }
    if (message.type === 'popup-blocked') {
      if (typeof message.url === 'string') this.popups.record(tabId, message.url)
      return
    }
    if (message.type === 'focus') {
      this.revealTab(tabId)
      return
    }
    if (message.type === 'forms') {
      if (
        message.forms &&
        typeof message.forms === 'object' &&
        typeof message.forms.type === 'string'
      )
        this.autofill.handleEvent(tabId, message.forms)
      return
    }
    if (message.type === 'interstitial') {
      if (typeof message.action === 'string' && typeof message.url === 'string') {
        // The certificate interstitial's tab answers first; the other warning pages are the
        // protection service's.
        if (!this.tabs.handleCertificateInterstitial(tabId, message.action, message.url))
          this.protection.handleInterstitial(tabId, message.action, message.url)
      }
      return
    }
    if (message.type === 'media') {
      if (!this.tabs.view(tabId)) return
      tab.audible = Boolean(message.playing)
      this.governor.onMedia(tabId, Boolean(message.playing))
      this.state.commitVolatile()
      this.updateMedia()
      return
    }
    if (typeof message.url !== 'string' || !/^https?:\/\//i.test(message.url)) return
    const win = this.tabs.windowFor(tabId)
    switch (message.type) {
      case 'glance':
        this.tabs.openGlance(
          message.url,
          tabId,
          clamp01(message.x ?? 0.5),
          clamp01(message.y ?? 0.5),
          win
        )
        return
      case 'open-tab': {
        const routed = win.localSpace ? null : this.routeSpaceFor(message.url)
        this.tabs.createTab(
          {
            url: message.url,
            active: !message.background,
            afterTabId: tab.essential ? undefined : tabId,
            containerId: tab.containerId,
            spaceId: routed ?? undefined
          },
          win
        )
        return
      }
      case 'navigate':
        this.tabs.navigate(tabId, message.url)
        return
    }
  }

  private commandHandlers(): CommandHandlers {
    const { tabs, state, platform } = this
    return {
      'app.getState': (_a, win) => state.snapshot(win),
      'app.listSpaces': () =>
        state.model.spaces.map((s) => ({ id: s.id, name: s.name, icon: s.icon })),
      'popups.open': ({ tabId, url }) => this.popups.open(tabId, url),
      'popups.dismiss': ({ tabId }) => this.popups.dismiss(tabId),
      'popups.setSiteAllowed': ({ tabId, allow }) => this.popups.setSiteAllowed(tabId, allow),
      'permissions.forget': ({ origin, permission }) =>
        this.permissions.forgetRule(origin, permission),
      'permissions.reset': () => this.permissions.reset(),
      'permissions.respond': ({ id, answer }) => this.permissionPrompts.respond(id, answer),
      'permissions.setDefault': ({ permission, decision }) =>
        this.permissions.chooseDefault(permission, decision),
      'permissions.defaults': () =>
        this.permissions.defaults(CONTENT_SETTINGS.map((setting) => setting.id)),
      'permissions.listForPermission': ({ permission }) =>
        this.permissions.listForPermission(permission),
      'permissions.set': ({ origin, permission, decision }) =>
        this.permissions.set(permission, origin, decision),
      'permissions.resetOrigin': ({ origin }) => this.permissions.resetOrigin(origin),
      'privacy.clearBrowsingData': ({ range, types, passphrase }, win) =>
        this.privacy.clearBrowsingData(range, types, passphrase, win),
      'privacy.clearBrowsingDataCounts': ({ range }) => this.privacy.counts(range),
      'privacy.safetyCheck': () => this.privacy.safetyCheck(),
      'security.respond': ({ id, response }) => this.security.respond(id, response),
      'pageDialog.respond': ({ id, response }) => this.pageDialogs.respond(id, response),
      'window.respondPrompt': ({ id, accepted }) => this.windowPrompts.respond(id, accepted),
      'session.crashRestore': ({ restore }) => this.session.crashRestore(restore),
      'security.forgetSession': () => {
        this.security.forgetSession()
        void platform.sessions.clearAuthCache?.()
      },
      'autofill.respond': ({ id, response }) => this.autofill.respond(id, response),
      'autofill.pick': ({ id, itemId, passphrase }, win) =>
        this.autofill.pick(id, itemId, passphrase, win),
      'autofill.listAddresses': () => this.autofill.listAddresses(),
      'autofill.addAddress': ({ address }) => this.autofill.addAddress(address),
      'autofill.updateAddress': ({ id, patch }) => this.autofill.updateAddress(id, patch),
      'autofill.removeAddress': ({ id }) => this.autofill.removeAddress(id),
      'autofill.addressFormat': ({ country }) => addressFormat(country),
      'autofill.countries': () => countries(),
      'autofill.listCards': () => this.autofill.listCards(),
      'autofill.addCard': ({ card }) => this.autofill.addCard(card),
      'autofill.updateCard': ({ id, patch }) => this.autofill.updateCard(id, patch),
      'autofill.removeCard': ({ id }) => this.autofill.removeCard(id),
      'autofill.revealCard': ({ id, passphrase }, win) =>
        this.autofill.revealCard(id, passphrase, win),
      'autofill.copyCardNumber': ({ id, passphrase }, win) =>
        this.autofill.copyCardNumber(id, passphrase, win),
      'autofill.listPasskeys': () => this.autofill.listPasskeys(),
      'autofill.removePasskey': ({ id }) => this.autofill.removePasskey(id),
      'app.openExternal': ({ url }) => {
        if (/^(https?|mailto):/.test(url)) platform.shell.openExternal(url)
      },
      'app.quit': () => void this.requestQuit(),
      'app.share': (payload, win) => this.share(payload, win),
      'app.openAppLinkSettings': (_a, win) => this.openAppLinkSettings(win),
      'externalProtocol.respond': ({ requestId, allow, always }) =>
        this.externalProtocols.respond(requestId, allow, always),
      'layout.report': (report, win) => win.applyLayout(report),

      'tab.new': (_a, win) => this.openNewTab(win),
      'tab.create': (opts, win) => tabs.createTab(opts, win).id,
      'tab.activate': ({ tabId }, win) => tabs.activateTab(tabId, win),
      'tab.close': ({ tabId, force }, win) => void tabs.requestClose(tabId, force, win),
      'tab.newPrivate': ({ url }, win) => tabs.newPrivateTab(url, win),
      'tab.closePrivate': (_a, win) => tabs.closePrivateTabs(win),
      'tab.closeOthers': ({ tabId }, win) => tabs.closeOthers(tabId, win),
      'tab.closeBelow': ({ tabId }, win) => tabs.closeBelow(tabId, win),
      'tab.closeAbove': ({ tabId }, win) => tabs.closeAbove(tabId, win),
      'tab.navigate': ({ tabId, input }, win) => this.submitUrlbar(input, false, tabId, false, win),
      'tab.back': ({ tabId }) => tabs.goBack(tabId),
      'tab.forward': ({ tabId }) => tabs.goForward(tabId),
      'tab.reload': ({ tabId, skipCache }) => tabs.reload(tabId, skipCache),
      'tab.stop': ({ tabId }) => tabs.stop(tabId),
      'tab.toggleMute': ({ tabId }) => tabs.toggleMute(tabId),
      'tab.toggleMuteSite': ({ tabId }) => tabs.toggleMuteSite(tabId),
      'tab.togglePin': ({ tabId }, win) => tabs.togglePin(tabId, win),
      'tab.toggleEssential': ({ tabId }, win) => tabs.toggleEssential(tabId, win),
      'tab.resetPinned': ({ tabId }, win) => tabs.resetPinned(tabId, true, win),
      'tab.editPinnedUrl': ({ tabId, url }) => tabs.editPinnedUrl(tabId, url),
      'tab.rename': ({ tabId, title }) => tabs.rename(tabId, title),
      'tab.setIcon': ({ tabId, icon }) => tabs.setIcon(tabId, icon),
      'tab.addRoute': ({ tabId, spaceId }) => this.addRouteForTab(tabId, spaceId),
      'tab.altClick': ({ tabId }, win) => tabs.altClick(tabId, win),
      'tab.selectionContextMenu': ({ tabIds }, win) =>
        this.menus.showSelectionContextMenu(tabIds, win),
      'tab.duplicate': ({ tabId }, win) => void tabs.duplicate(tabId, win),
      'tab.unload': ({ tabId }) => tabs.discard(tabId),
      'tab.freeze': ({ tabId }) => this.governor.freezeTab(tabId),
      'tab.wake': ({ tabId }) => this.governor.wakeTab(tabId),
      'tab.move': ({ tabId, spaceId, section, index }, win) =>
        tabs.moveTab(tabId, { spaceId, section, index }, win),
      'tab.moveToSpace': ({ tabId, spaceId }, win) => {
        const tab = tabs.tab(tabId)
        if (tab)
          tabs.moveTab(
            tabId,
            {
              spaceId,
              section: tab.pinned ? 'pinned' : 'regular',
              index: Number.MAX_SAFE_INTEGER
            },
            win
          )
      },
      'tab.moveToFolder': ({ tabId, folderId }) => tabs.moveToFolder(tabId, folderId),
      'tab.drop': ({ tabId, key }, win) => void tabs.dropTab(tabId, key, win),
      'tab.dragStart': ({ tabId }, win) => this.tabDrag.start(tabId, win),
      'tab.dragMove': ({ tabId, x, y, inSidebar }, win) =>
        this.tabDrag.move(tabId, x, y, inSidebar, win),
      'tab.dragTarget': ({ tabId, key }, win) => this.tabDrag.setTarget(tabId, key, win),
      'tab.dragEnd': ({ tabId, x, y, outcome }, win) => this.tabDrag.end(tabId, x, y, outcome, win),
      'tab.moveToNewWindow': ({ tabId }, win) => void tabs.moveTabToNewWindow(tabId, null, win),
      'tab.reopenClosed': (_a, win) => this.session.reopenClosed(win),
      'tab.navigationEntries': ({ tabId }) => tabs.navigationEntries(tabId),
      'tab.goToIndex': ({ tabId, index }) => tabs.goToIndex(tabId, index),
      'tab.navigationMenu': ({ tabId }, win) => this.menus.showNavigationMenu(tabId, win),
      'tab.setZoom': ({ tabId, delta }) =>
        delta === null ? tabs.resetZoom(tabId) : tabs.adjustZoom(tabId, delta),
      'tab.setZoomFactor': ({ tabId, factor }) => tabs.setZoom(tabId, factor),
      'tab.setDesktopSite': ({ tabId, on }) => this.pageControls.setDesktopSite(tabId, on),
      'tab.setDarkenSite': ({ tabId, on }) => this.pageControls.setDarkenSite(tabId, on),
      'pageControls.forgetSite': ({ kind, domain }) => this.pageControls.forgetSite(kind, domain),
      'tab.contextMenu': ({ tabId }, win) => this.menus.showTabContextMenu(tabId, win),
      'tab.toggleDevtools': ({ tabId }) => tabs.toggleDevtools(tabId),
      'tab.copyUrl': ({ tabId, markdown }) => tabs.copyUrl(tabId, markdown),

      'space.create': ({ name, icon, containerId, theme }, win) => {
        const space = createSpace(
          name.trim() || 'New Space',
          icon,
          state.model.containers.some((c) => c.id === containerId)
            ? containerId
            : DEFAULT_CONTAINER_ID
        )
        space.theme = theme
        state.model.spaces.push(space)
        if (!win.localSpace) tabs.switchSpace(space.id, win)
        state.commit()
        return space.id
      },
      'space.update': ({ spaceId, patch }) => {
        const space = getSpace(state.model, spaceId)
        if (!space) return
        if (patch.name !== undefined) space.name = patch.name.trim() || space.name
        if (patch.icon !== undefined) space.icon = patch.icon
        if (patch.theme !== undefined) space.theme = patch.theme
        if (
          patch.containerId !== undefined &&
          !space.windowId &&
          state.model.containers.some((c) => c.id === patch.containerId)
        ) {
          space.containerId = patch.containerId
        }
        state.commit()
      },
      'space.delete': ({ spaceId }, win) => this.deleteSpace(spaceId, win),
      'space.activate': ({ spaceId }, win) => tabs.switchSpace(spaceId, win),
      'space.next': (_a, win) => this.actions.run('space.next', { sourceTabId: null, win }),
      'space.prev': (_a, win) => this.actions.run('space.prev', { sourceTabId: null, win }),
      'space.reorder': ({ spaceId, index }) => this.reorderSpace(spaceId, index),
      'space.unload': ({ spaceId }) => tabs.unloadSpace(spaceId),
      'space.unloadOthers': (_a, win) => this.unloadOtherSpaces(win),
      'space.togglePinnedCollapsed': ({ spaceId }) => {
        const space = getSpace(state.model, spaceId)
        if (!space) return
        space.pinnedCollapsed = !space.pinnedCollapsed
        state.commit()
      },
      'space.closeUnpinned': ({ spaceId }, win) => tabs.closeUnpinned(spaceId, win),
      'space.contextMenu': ({ spaceId }, win) => this.menus.showSpaceContextMenu(spaceId, win),

      'folder.create': ({ spaceId, name, icon, color, rename }, win) =>
        this.createFolder(spaceId, name, icon, win, { color, rename }).id,
      'folder.update': ({ folderId, patch }) => this.updateFolder(folderId, patch),
      'folder.delete': ({ folderId, unpack }) => this.deleteFolder(folderId, unpack),
      'folder.contextMenu': ({ folderId }, win) => this.menus.showFolderContextMenu(folderId, win),
      'newtab.contextMenu': (_a, win) => this.menus.showNewTabContextMenu(win),
      'app.menu': ({ anchor, keyboard }, win) =>
        this.menus.showAppMenu(win, { anchor, keyboard: Boolean(keyboard) }),
      'focus.content': (_a, win) => win.focusContent(),
      'focus.chrome': (_a, win) => win.focusChrome(),
      haptic: ({ kind }, win) => win.haptic(kind),
      'media.toggle': ({ tabId }) => {
        const view = tabs.view(tabId)
        if (!view) return
        void view
          .executeJavaScript(
            `(() => { const m = [...document.querySelectorAll('video,audio')].find(e => !e.paused) || document.querySelector('video,audio'); if (!m) return false; if (m.paused) { m.play().catch(() => {}); } else { m.pause(); } return true })()`
          )
          .catch(() => undefined)
      },

      'split.create': ({ tabIds, layout }, win) => tabs.createSplit(tabIds, layout, win),
      'split.toggleLayout': ({ layout }, win) => tabs.toggleSplitLayout(layout, win),
      'split.setLayout': ({ groupId, layout }) => tabs.setSplitLayout(groupId, layout),
      'split.unsplit': ({ groupId, tabId }, win) => tabs.unsplit(groupId, tabId, win),
      'split.removeTab': ({ tabId, focus }, win) => tabs.removeFromSplit(tabId, focus, win),
      'split.resize': ({ groupId, sizes }) => tabs.resizeSplit(groupId, sizes),
      'split.newEmpty': (_a, win) => tabs.newEmptySplit(win),
      'split.addTab': ({ groupId, tabId }) => tabs.addToSplit(groupId, tabId),

      'glance.open': ({ url, parentTabId, originX, originY }, win) =>
        tabs.openGlance(url, parentTabId, originX, originY, win),
      'glance.close': (_a, win) => tabs.closeGlance(win),
      'glance.expand': (_a, win) => tabs.expandGlance(win),
      'glance.split': (_a, win) => tabs.splitGlance(win),

      'compact.toggle': (_a, win) => this.toggleCompactMode(win),
      'compact.setRevealed': ({ revealed, edge }, win) => {
        if (edge === 'toolbar') {
          // Main's cursor tracking alone reads it; nothing in the snapshot changes.
          win.compactToolbarRevealed = revealed
          return
        }
        if (win.compactSidebarRevealed === revealed) return
        win.compactSidebarRevealed = revealed
        state.commitVolatile()
      },
      'compact.toggleSidebarPersistent': (_a, win) => this.toggleCompactSidebarPersistent(win),
      'compact.setOptions': (patch) => {
        Object.assign(state.settings.compactMode, patch)
        state.commit()
      },

      'urlbar.suggest': ({ query, tabId }, win) => this.suggestions.suggest(query, tabId, win),
      'urlbar.submit': ({ input, newTab, tabId, background }, win) =>
        this.submitUrlbar(input, newTab, tabId, Boolean(background), win),
      'urlbar.pasteAndGo': ({ tabId }, win) => void this.pasteAndGo(tabId, false, win),
      'urlbar.pasteAndSearch': ({ tabId }, win) => void this.pasteAndGo(tabId, true, win),
      'urlbar.runCommand': ({ action }, win) =>
        this.actions.run(action as AnyAction, { sourceTabId: null, win }),
      'urlbar.cancel': (_a, win) => this.extensions.omniboxCancel(win),
      'urlbar.deleteSuggestion': ({ input }, win) =>
        this.extensions.omniboxDeleteSuggestion(input, win),

      'overlay.snapshot': ({ tabId, fresh }, win) => win.snapshot(tabId, fresh),

      'site.info': ({ tabId }) => this.siteInfo.info(tabId),
      'siteInfo.snapshot': ({ tabId }) => this.siteInfo.snapshot(tabId),
      'site.clearCookies': ({ tabId }) => this.siteInfo.clearCookies(tabId),
      'site.clearData': ({ tabId }) => this.siteInfo.clearData(tabId),
      'site.resetPermissions': ({ tabId, permission }) =>
        this.siteInfo.resetPermissions(tabId, permission),

      'resources.snapshot': () => this.governor.sample(),
      'resources.trim': () => this.governor.trim(),
      'resources.relaunch': () => this.governor.relaunch(),

      'settings.update': (patch, win) => this.updateSettings(patch, win),
      'shortcuts.update': ({ id, binding }) => {
        state.setShortcutOverride(id, binding)
        this.syncShortcuts()
        state.commit()
      },
      'shortcuts.reset': () => {
        state.resetShortcuts()
        this.syncShortcuts()
        state.commit()
      },
      'shortcuts.recording': ({ recording }, win) => {
        win.recordingShortcut = recording
      },
      'sidebar.setWidth': ({ width }) => {
        state.settings.sidebarWidth = Math.max(160, Math.min(520, Math.round(width)))
        state.commit()
      },
      'sidebar.toggleExpanded': () => {
        state.settings.sidebarExpanded = !state.settings.sidebarExpanded
        state.commit()
      },

      'history.search': ({ query, limit }) => this.history.search(query, limit),
      'history.recent': ({ limit }) => this.history.recent(limit),
      'history.delete': ({ url }) => this.history.delete(url),
      'history.clear': () => this.history.clear(),
      'history.visits': ({ query }) => this.history.visits(query),
      'history.grouped': ({ query }) => this.history.groupedByDay(query),
      'history.topSites': ({ n, excludedHosts }) => this.history.topSites(n, excludedHosts ?? []),
      'history.count': ({ fromMs, toMs }) => this.history.count(fromMs, toMs),
      'history.deleteVisits': ({ ids }) => this.history.deleteVisits(ids),
      'history.deleteUrls': ({ urls }) => this.history.deleteUrls(urls),
      'history.deleteDay': ({ dayKey }) => this.history.deleteDay(dayKey),
      'history.deleteRange': ({ fromMs, toMs }) => this.history.deleteRange(fromMs, toMs),
      'history.open': (_a, win) => this.emit('overlay.open', { kind: 'history' }, win),
      'history.contextMenu': ({ visitId, url }, win) =>
        this.menus.showHistoryContextMenu(visitId, url, win),
      'history.dayMenu': ({ dayKey, count }, win) =>
        this.menus.showHistoryDayMenu(dayKey, count, win),

      'session.recentlyClosed': () => this.session.summaries(),
      'session.restoreClosed': ({ id }, win) => this.session.restoreClosed(id, win),
      'session.clearRecentlyClosed': () => this.session.clearRecentlyClosed(),

      'clipboard.writeText': ({ text, sensitive }) => {
        if (sensitive)
          this.passwords.clipboard.copy(text, state.settings.passwords.clipboardClearSeconds)
        else platform.clipboard.writeText(text)
      },

      'bookmark.toggle': ({ tabId }, win) => this.toggleBookmark(tabId, win),
      'bookmark.star': ({ tabId }, win) => this.starTab(tabId, win),
      'bookmark.create': ({ parentId, index, title, url, type, favicon }) =>
        this.bookmarks.create({ parentId, index, title, url, type, favicon }),
      'bookmark.update': ({ id, title, url }) => void this.bookmarks.update(id, { title, url }),
      'bookmark.move': ({ ids, parentId, index }) => void this.bookmarks.move(ids, parentId, index),
      'bookmark.remove': ({ ids }) => void this.bookmarks.removeMany(ids),
      'bookmark.open': ({ id, newTab, tabId }, win) => this.openBookmark(id, newTab, tabId, win),
      'bookmark.openAll': ({ ids }, win) => this.openBookmarks(ids, win),
      'bookmark.openInWindow': ({ ids, private: isPrivate }, win) =>
        this.openBookmarksInWindow(ids, isPrivate, win),
      'bookmark.allTabs': (_a, win) => this.bookmarkTabs(win),
      'bookmark.createFromTabs': ({ tabIds, title, parentId }, win) =>
        this.createBookmarksFromTabs(tabIds, title, parentId, win),
      'bookmark.contextMenu': ({ ids, folderId, x, y, surface }, win) =>
        this.menus.showBookmarkContextMenu(ids, folderId, { x, y }, win, surface ?? 'manager'),
      'bookmark.menu': ({ x, y }, win) => this.menus.showBookmarksMenu({ x, y }, win),
      'bookmark.toggleBar': (_a, win) => this.toggleBookmarksBar(win),
      'bookmark.cut': ({ ids }) => this.clipBookmarks(ids, 'cut'),
      'bookmark.copy': ({ ids }) => this.clipBookmarks(ids, 'copy'),
      'bookmark.paste': ({ folderId, index }) => this.bookmarks.paste(folderId, index),
      'bookmark.import': (_a, win) => this.importBookmarks(win),
      'bookmark.export': (_a, win) => this.exportBookmarks(win),

      'download.pause': ({ id }) => this.downloads.pause(id),
      'download.resume': ({ id }) => this.downloads.resume(id),
      'download.cancel': ({ id }) => this.downloads.cancel(id),
      'download.showInFolder': ({ id }) => this.downloads.showInFolder(id),
      'download.open': ({ id }) => this.downloads.open(id),
      'download.remove': ({ id }) => this.downloads.remove(id),
      'download.removeCompleted': () => this.downloads.removeCompleted(),
      'download.clearCompleted': () => this.downloads.removeCompleted(),
      'download.retry': ({ id }) => this.downloads.retry(id),
      'download.acceptDanger': ({ id }) => this.downloads.acceptDanger(id),
      'download.discard': ({ id }) => this.downloads.discard(id),
      'download.setOpenWhenDone': ({ id, on }) => this.downloads.setOpenWhenDone(id, on),
      'download.chooseDirectory': (_args, win) => this.downloads.chooseDirectory(win),
      'download.openPanel': (_args, win) => this.emit('overlay.open', { kind: 'downloads' }, win),

      'find.start': ({ tabId, text, forward, newSession }, win) => {
        const view = tabs.view(tabId)
        if (!view) return
        if (!text) {
          view.stopFind('clearSelection')
          win.findResult = null
          state.commitVolatile()
          return
        }
        this.find.remember(tabId, text)
        view.findInPage(text, forward, newSession)
      },
      'find.stop': ({ tabId, keepSelection }, win) => {
        tabs.view(tabId)?.stopFind(keepSelection ? 'keepSelection' : 'clearSelection')
        win.findResult = null
        state.commitVolatile()
      },

      'container.create': ({ name, color, icon }) => {
        const id = newId('container')
        state.model.containers.push({ id, name: name.trim() || 'Container', color, icon })
        state.commit()
        return id
      },
      'container.update': ({ id, patch }) => {
        const c = state.model.containers.find((x) => x.id === id)
        if (!c || id === DEFAULT_CONTAINER_ID) return
        Object.assign(c, patch)
        state.commit()
      },
      'container.delete': ({ id }) => {
        if (id === DEFAULT_CONTAINER_ID) return
        state.model.containers = state.model.containers.filter((c) => c.id !== id)
        for (const space of state.model.spaces)
          if (space.containerId === id) space.containerId = DEFAULT_CONTAINER_ID
        for (const tab of Object.values(state.model.tabs))
          if (tab.containerId === id) tab.containerId = DEFAULT_CONTAINER_ID
        void platform.sessions.clearContainerData(id)
        this.security.certificateExceptions.forgetContainer(id)
        state.commit()
      },
      'container.reorder': ({ id, index }) => {
        reorderContainer(state.model, id, index)
        state.commit()
      },

      'window.minimize': (_a, win) => win.host.minimize(),
      'window.toggleMaximize': (_a, win) =>
        win.host.isMaximized() ? win.host.unmaximize() : win.host.maximize(),
      'window.close': (_a, win) => void this.requestWindowClose(win),
      'window.toggleFullscreen': (_a, win) => this.toggleFullscreen(win),
      'window.fullscreenInset': ({ bottom }, win) => win.setFullscreenInset(bottom),
      'window.formFactor': ({ formFactor }, win) => {
        win.formFactor = formFactor
      },
      'window.new': (_a, win) => void this.openWindow('synced', win),
      'window.newUnsynced': (_a, win) => void this.openWindow('unsynced', win),
      'window.newPrivate': (_a, win) => void this.openWindow('private', win),
      'window.openUrl': ({ url, kind }, win) => this.openUrlInWindow(url, kind, win),
      'window.moveTabsToSpace': ({ spaceId }, win) => tabs.moveLocalTabsToSpace(win, spaceId),

      'page.screenshot': ({ tabId }, win) =>
        this.actions.run('page.screenshot', { sourceTabId: tabId, win }),
      'page.print': ({ tabId }, win) => this.actions.run('page.print', { sourceTabId: tabId, win }),
      'page.savePage': ({ tabId }, win) =>
        this.actions.run('page.savePage', { sourceTabId: tabId, win }),
      'page.viewSource': ({ tabId }, win) =>
        this.actions.run('page.viewSource', { sourceTabId: tabId, win }),
      'page.contextMenu': ({ tabId, linkURL, srcURL, x, y }, win) =>
        this.menus.showPageContextMenu(
          tabId,
          {
            x,
            y,
            linkURL,
            srcURL,
            mediaType: srcURL ? 'image' : 'none',
            selectionText: '',
            isEditable: false,
            misspelledWord: '',
            dictionarySuggestions: [],
            editFlags: {
              canUndo: false,
              canRedo: false,
              canCut: false,
              canCopy: false,
              canPaste: false,
              canDelete: false,
              canSelectAll: false
            }
          },
          win
        ),

      'menu.click': ({ menuId, itemId }) => platform.menus.activate?.(menuId, itemId),
      'menu.close': ({ menuId }) => platform.menus.dismiss?.(menuId),

      'boost.update': ({ domain, patch }) => this.boosts.update(domain, patch),
      'boost.remove': ({ domain }) => this.boosts.remove(domain),
      'boost.startZap': ({ tabId }) => this.boosts.startZap(tabId),
      'boost.stopZap': ({ tabId }) => this.boosts.stopZap(tabId),

      'reader.toggle': ({ tabId }, win) => this.reader.toggle(tabId, win),

      'liveFolder.save': ({ folderId, name, config }, win) => {
        let id = folderId
        if (!id || !state.model.folders[id]) {
          const space = win.activeSpace()
          if (space.windowId) return ''
          const folder = createFolder(state.model, space.id, name.trim() || 'Live Folder', '📡')
          id = folder.id
        } else if (name.trim()) {
          state.model.folders[id].name = name.trim()
        }
        this.liveFolders.save(id, config)
        state.commit()
        return id
      },
      'liveFolder.refresh': ({ folderId }) => void this.liveFolders.refresh(folderId, true),
      'liveFolder.remove': ({ folderId }) => this.liveFolders.remove(folderId),

      'extension.add': (_a, win) => this.extensions.addFromDialog(win),
      'extension.installFromFile': (_a, win) => this.extensions.installFromFileDialog(win),
      'extension.installFromStore': ({ ref, store }, win) =>
        this.extensions.installFromStore(ref, store ?? null, win),
      'extension.remove': ({ id }) => this.extensions.remove(id),
      'extension.setEnabled': ({ id, enabled }, win) =>
        this.extensions.setEnabled(id, enabled, win),
      'extension.setPinned': ({ id, pinned }) => this.extensions.setPinned(id, pinned),
      'extension.setNewTabOverride': ({ id, enabled }) =>
        this.extensions.setNewTabOverride(id, enabled),
      'extension.toggleSidePanel': ({ id }, win) => this.extensions.toggleSidePanel(id, win),
      'extension.closeSidePanel': (_a, win) => this.extensions.closeSidePanel(win),
      'extension.setAllowPrivate': ({ id, allowed }) =>
        this.extensions.setAllowPrivate(id, allowed),
      'extension.setAllowUserScripts': ({ id, allowed }) =>
        this.extensions.setAllowUserScripts(id, allowed),
      'extension.reload': ({ id }) => this.extensions.reload(id),
      'extension.checkForUpdates': (_a, win) => this.extensions.checkForUpdates(win),
      'extension.update': ({ id }, win) => this.extensions.update(id, win),
      'extension.openOptions': ({ id }, win) => this.extensions.openOptions(id, win),
      'extension.openPopup': ({ id, anchor }, win) => this.extensions.openPopup(id, anchor, win),
      'extension.closePopup': () => this.extensions.closePopup(),
      'extension.actionContextMenu': ({ id, x, y }, win) =>
        this.menus.showExtensionActionMenu(
          id,
          win,
          x !== undefined && y !== undefined ? { x, y } : undefined
        ),

      'mod.add': ({ name, css, source }) => this.mods.add(name, css, source ?? null).id,
      'mod.update': ({ id, patch }) => this.mods.update(id, patch),
      'mod.remove': ({ id }) => this.mods.remove(id),
      'mod.importFile': (_a, win) => this.mods.importFile(win),
      'mod.importUrl': ({ url }, win) => this.mods.importUrl(url, win),

      'sync.chooseFolder': (_a, win) => this.sync.chooseFolder(win),
      'sync.setup': (opts, win) => this.sync.setup(opts, win),
      'sync.setScope': (patch) => this.sync.setScope(patch),
      'sync.setDeviceName': ({ name }) => this.sync.setDeviceName(name),
      'sync.now': () => this.sync.syncNow(),
      'sync.confirmMerge': ({ merge }) => this.sync.confirmMerge(merge),
      'sync.disconnect': ({ wipeRemote }) => this.sync.disconnect(wipeRemote),

      'agent.disconnect': ({ id }) => this.agents.disconnect(id),
      'agent.setMode': ({ id, mode }) => this.agents.setMode(id, mode),
      'agent.releaseTab': ({ tabId }) => this.agents.releaseTab(tabId),
      'agent.forget': ({ name }) => this.agents.forget(name),
      'agent.regenerateToken': () => this.agents.regenerateToken(),

      'updates.check': () => this.updates.check({ manual: true }),
      'updates.download': () => this.updates.download(),
      'updates.install': () => this.updates.install(),
      'updates.cancel': () => this.updates.cancel(),
      'updates.openRelease': (_a, win) => this.updates.openRelease(win),

      'passwords.unlock': ({ passphrase }) => this.passwords.unlock(passphrase),
      'passwords.lock': () => this.passwords.lock(),
      'passwords.reset': () => this.passwords.reset(),
      'passwords.setPassphrase': ({ passphrase, current }, win) =>
        this.passwords.setPassphrase(passphrase, current, win),
      'passwords.list': ({ query }) => this.passwords.list(query),
      'passwords.reveal': ({ id, passphrase }, win) => this.passwords.reveal(id, passphrase, win),
      'passwords.copy': ({ id, field, passphrase }, win) =>
        this.passwords.copy(id, field, passphrase, win),
      'passwords.add': (input) => this.passwords.add(input),
      'passwords.update': ({ id, patch }) => this.passwords.update(id, patch),
      'passwords.remove': ({ id }, win) => this.passwords.remove(id, win),
      'passwords.restore': ({ id }) => this.passwords.restore(id),
      'passwords.neverSaveAdd': ({ domain }) => this.passwords.neverSaveAdd(domain),
      'passwords.neverSaveRemove': ({ domain }) => this.passwords.neverSaveRemove(domain),
      'passwords.generate': ({ options, domain }) => this.passwords.generate(options, domain),
      'passwords.checkupRun': () => this.passwords.runCheckup(),
      'passwords.checkupCancel': () => this.passwords.cancelCheckup(),
      'passwords.import': ({ conflict }, win) => this.passwords.import(conflict, win),
      'passwords.export': ({ passphrase }, win) => this.passwords.export(passphrase, win),
      'blocking.updateLists': ({ id }) => this.blocking.updateLists(id),
      'blocking.setEnabled': ({ enabled }) => this.blocking.setEnabled(enabled),
      'blocking.setSiteException': ({ site, excepted }) =>
        this.blocking.setSiteException(site, excepted),
      'translate.page': ({ tabId, target, source }) =>
        this.translate.translatePage(tabId, { target, source }),
      'translate.revert': ({ tabId }) => this.translate.revert(tabId),
      'translate.dismiss': ({ tabId }) => this.translate.dismiss(tabId),
      'translate.selection': ({ tabId, text, target }) =>
        this.translate.translateSelection(tabId, { text, target }),
      'translate.setPreferences': (patch) => this.translate.setPreferences(patch),
      'translate.setLanguageRule': ({ language, rule }) =>
        this.translate.setLanguageRule(language, rule),
      'translate.setSiteRule': ({ tabId, never }) => this.translate.setSiteRule(tabId, never),
      'translate.downloadModel': ({ from, to }) => this.translate.downloadModel({ from, to }),
      'translate.removeModel': ({ from, to }) => this.translate.removeModel({ from, to }),
      'translate.engineResponse': (response) => this.translate.onRelayResponse(response),

      'onboarding.complete': ({ searchEngineId, colorScheme, essentials }, win) => {
        if (state.searchEngines.some((e) => e.id === searchEngineId))
          state.settings.searchEngineId = searchEngineId
        state.settings.colorScheme = colorScheme
        this.platform.theme?.setSource(colorScheme)
        state.settings.onboardingDone = true
        for (const url of essentials) {
          const known = ONBOARDING_ESSENTIALS.find((e) => e.url === url)
          if (!known) continue
          // Essentials chosen during onboarding stay unloaded until clicked (privacy).
          const tab = tabs.createTab(
            {
              url: known.url,
              essential: true,
              active: false,
              load: false
            },
            win
          )
          tab.title = known.title
        }
        this.defaultBrowser.onOnboardingDone()
        state.commit()
        this.emit('urlbar.toggle', { mode: 'new-tab' }, win)
      },

      'defaultBrowser.request': ({ source }) => this.defaultBrowser.request(source),
      'defaultBrowser.dismiss': ({ prompt }) => this.defaultBrowser.dismiss(prompt),
      'defaultBrowser.refresh': () => this.defaultBrowser.refresh()
    }
  }

  private updateSettings(patch: Partial<Settings>, win: ZenWindow): void {
    const s = this.state.settings
    const before = {
      glance: s.glanceEnabled,
      trigger: s.glanceTrigger,
      thirdParty: s.thirdPartyOnPinned,
      appIcon: s.appIcon,
      colorScheme: s.colorScheme,
      windowSync: s.windowSync,
      resources: JSON.stringify(s.resources),
      unload: `${s.unloadEnabled}:${s.unloadTimeoutMinutes}:${s.unloadExcludedDomains.join(',')}`,
      agents: JSON.stringify(s.agents),
      updates: JSON.stringify(s.updates),
      blocking: s.blocking,
      privacy: JSON.stringify(s.privacy),
      autofill: `${JSON.stringify(s.passwords)}${JSON.stringify(s.autofill)}`
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      if (key === 'compactMode' && value && typeof value === 'object') {
        const cm = value as Partial<Settings['compactMode']>
        if (cm.enabled !== undefined && cm.enabled !== win.compactEnabled)
          this.setCompactMode(win, cm.enabled)
        Object.assign(s.compactMode, cm)
      } else if (key === 'resources' && value && typeof value === 'object') {
        const incoming = value as Partial<Settings['resources']>
        s.resources = sanitizeResourceSettings({
          ...s.resources,
          ...incoming,
          process: { ...s.resources.process, ...(incoming.process ?? {}) }
        })
      } else if (key === 'agents' && value && typeof value === 'object') {
        s.agents = sanitizeAgentSettings({ ...s.agents, ...(value as Partial<Settings['agents']>) })
      } else if (key === 'updates' && value && typeof value === 'object') {
        s.updates = sanitizeUpdateSettings({
          ...s.updates,
          ...(value as Partial<Settings['updates']>)
        })
      } else if (key === 'appIcon') {
        s.appIcon = sanitizeAppIcon(value)
      } else if (key === 'phoneBar') {
        s.phoneBar = sanitizePhoneBar(value)
      } else if (key === 'passwords' && value && typeof value === 'object') {
        s.passwords = sanitizePasswordSettings({
          ...s.passwords,
          ...(value as Partial<Settings['passwords']>)
        })
      } else if (key === 'autofill' && value && typeof value === 'object') {
        s.autofill = sanitizeAutofillSettings({
          ...s.autofill,
          ...(value as Partial<Settings['autofill']>)
        })
      } else if (key === 'defaultBrowserPromo' && value && typeof value === 'object') {
        s.defaultBrowserPromo = sanitizePromoState({
          ...s.defaultBrowserPromo,
          ...(value as Partial<Settings['defaultBrowserPromo']>)
        })
      } else if (key === 'blocking' && value && typeof value === 'object') {
        s.blocking = sanitizeBlockingSettings({
          ...s.blocking,
          ...(value as Partial<Settings['blocking']>)
        })
      } else if (key === 'pageControls' && value && typeof value === 'object') {
        this.pageControls.update(value as Partial<Settings['pageControls']>)
      } else if (key === 'shortcutPreset') {
        if (isShortcutPreset(value)) s.shortcutPreset = value
      } else if (key === 'privacy' && value && typeof value === 'object') {
        s.privacy = sanitizePrivacySettings({
          ...s.privacy,
          ...(value as Partial<Settings['privacy']>)
        })
      } else {
        ;(s as unknown as Record<string, unknown>)[key] = value
      }
    }
    s.sidebarWidth = Math.max(160, Math.min(520, s.sidebarWidth))
    s.unloadTimeoutMinutes = Math.max(1, Math.min(24 * 60, Math.round(s.unloadTimeoutMinutes)))
    s.essentialsMax = Math.max(1, Math.min(24, Math.round(s.essentialsMax)))
    if (
      before.glance !== s.glanceEnabled ||
      before.trigger !== s.glanceTrigger ||
      before.thirdParty !== s.thirdPartyOnPinned
    ) {
      this.tabs.broadcastPageFlags()
    }
    if (before.colorScheme !== s.colorScheme) this.platform.theme?.setSource(s.colorScheme)
    if (before.windowSync !== s.windowSync) {
      // Leaving "pinned only" shares every tab again; entering it keeps existing tabs shared.
      if (s.windowSync !== 'pinned')
        for (const tab of Object.values(this.state.model.tabs))
          if (tab.spaceId && !this.state.model.localSpaces[tab.spaceId]) tab.windowId = null
    }
    if (
      before.resources !== JSON.stringify(s.resources) ||
      before.unload !==
        `${s.unloadEnabled}:${s.unloadTimeoutMinutes}:${s.unloadExcludedDomains.join(',')}`
    ) {
      this.governor.onSettingsChanged()
    }
    if (before.agents !== JSON.stringify(s.agents)) this.agents.onSettingsChanged()
    if (before.updates !== JSON.stringify(s.updates)) this.updates.onSettingsChanged()
    if (before.appIcon !== s.appIcon) this.platform.app.setAppIcon?.(s.appIcon)
    if (before.blocking !== s.blocking) this.blocking.onSettingsChanged()
    if (before.privacy !== JSON.stringify(s.privacy)) this.protection.onSettingsChanged()
    if (before.autofill !== `${JSON.stringify(s.passwords)}${JSON.stringify(s.autofill)}`)
      this.autofill.onSettingsChanged()
    this.state.commit()
  }

  /** Cycle spaces relative to a window's current one. */
  cycleSpaceIn(win: ZenWindow, delta: number): void {
    if (win.localSpace) return
    this.tabs.switchSpace(cycleSpace(this.state.model, delta, win.activeSpaceId).id, win)
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5))
}
