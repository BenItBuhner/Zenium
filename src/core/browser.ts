import type {
  AppWindowInfo,
  BookmarkImportResult,
  BookmarkNode,
  ColorScheme,
  CommandArgs,
  CommandName,
  CommandResult,
  DownloadChangeKind,
  DownloadItem,
  DownloadSettings,
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
  TabSection,
  WindowChrome,
  WindowKind
} from '../shared/types'
import { CONTENT_SETTINGS } from '../shared/contentSettings'
import { BrowserState, type PersistedWindow } from './state'
import { HistoryService } from './history'
import { OmniboxShortcutsService } from './omniboxShortcuts'
import { SessionService } from './session'
import { NewTabService } from './newtab'
import { BookmarkService } from './bookmarks'
import { DownloadService, isQuarantined } from './downloads'
import { resolveDownloadSettings } from '../shared/downloads'
import { PermissionService } from './permissions'
import { PermissionPromptService } from './permissionPrompts'
import { PrivacyService } from './privacy'
import { PopupBlocker } from './popups'
import { ExternalLaunches } from './external'
import { SecurityPromptService } from './security'
import { PageDialogService } from './pageDialogs'
import { WindowPrompts } from './windowPrompts'
import { TabManager, isTabSection } from './tabs'
import { TabDragController, parseDropKey } from './tabDrag'
import { surfaceMounted, ZenWindow } from './window'
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
import { SyncEngine } from './sync/engine'
import { SiteInfoService } from './siteInfo'
import { SiteDataService } from './siteData'
import { TranslateService } from './translate/service'
import { PrintService } from './print'
import { PdfViewerService } from './pdf'
import { PageControls } from './pageControls'
import { SpellcheckService } from './spellcheck'
import { LanguagesService } from './languages'
import { PageFontsService } from './pageFonts'
import { FindMemory } from './find'
import { FullscreenService } from './fullscreen'
import { WebAppService } from './webapp'
import { MediaSessionService } from './mediaSession'
import { ReadAloudService } from './readAloud'
import { WebNotificationService } from './webNotifications'
import { ScreenCaptureService } from './screenCapture'
import { ShareService } from './share'
import { TextFragments } from './textFragments'
import { GeolocationService } from './geolocation'
import { UpdateService } from './updates'
import { ExternalProtocolService } from './externalProtocols'
import { PasswordService } from './credentials/service'
import { AutofillService } from './autofill'
import { addressFormat, countries } from './credentials/address'
import { ConnectivityService } from './connectivity'
import { DefaultBrowserService } from './defaultBrowser'
import { ImportService } from './import/service'
import { BackgroundWork } from './background/work'
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
  nextFolderColor,
  orderedTabsForSpace,
  regularFolderTabs,
  reorderContainer,
  reorderSpace,
  sectionIndexOf,
  tabVisibleIn
} from './model'
import {
  BLANK_URL,
  displayHost,
  displayUrl,
  extensionPageOf,
  getDomain,
  inputToUrl,
  isEmptyTabUrl,
  isWebPageUrl,
  presentedUrl
} from '../shared/url'
import type { VoiceStartOutcome } from '../shared/voice'
import type { QrStartOutcome } from '../shared/qrScan'
import { openAllPrompt, sortedByNameOrder, toggledBookmarksBarMode } from '../shared/bookmarkViews'
import { PageService } from './pages'
import {
  buildSearchUrl,
  isPickableSearchEngine,
  matchKeyword,
  sanitizeSearchEngines
} from '../shared/search'
import { SearchEngineService } from './searchEngines'
import { routeSharedIntent, type SharedIntent } from '../shared/shareTarget'
import { copyConfirmation } from '../shared/clipboard'
import { IMAGE_URL_PREFIX } from '../shared/zenPages'
import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID, sanitizePrivateDevice } from '../shared/types'
import {
  DEFAULT_SETTINGS,
  ONBOARDING_ESSENTIALS,
  sanitizeAutofillSettings,
  sanitizePasswordSettings,
  spaceLabel
} from '../shared/defaults'
import { sanitizeNewTabSettings } from '../shared/newTab'
import { sanitizePhoneBar } from '../shared/phoneBar'
import { PRIVATE_THEME, captionColors, resolveTheme, rgbToHex } from '../shared/theme'
import { newId } from '../shared/ids'
import { sanitizeAppIcon } from '../shared/appIcon'
import { sanitizeUpdateSettings } from '../shared/updates'
import { sanitizePromoState } from '../shared/defaultBrowser'
import { displayModeFor, type DisplayMode } from '../shared/displayMode'
import { sanitizeBlockingSettings } from '../shared/blocking'
import { isShortcutPreset } from '../shared/shortcuts'
import { sanitizePrivacySettings } from '../shared/privacy'
import { sanitizeSpellcheck } from '../shared/spellcheck'
import { sanitizeReaderPreferences } from '../shared/reader'
import { sanitizeFontSettings } from '../shared/fonts'
import { sanitizeLanguages } from '../shared/languages'
import type { ExtensionHost, Governor, PageMessage, Platform, SyncHost } from './platform'
import { JsonStore } from './store/JsonStore'

/**
 * How long a quit waits for the profile's final writes to land. Nothing of the profile is at
 * stake past it: the final documents were written synchronously; a host whose storage stalls
 * must not hold the quit up for good.
 */
const QUIT_SETTLE_TIMEOUT_MS = 3_000

export type DownloadChangeListener = (item: DownloadItem, kind: DownloadChangeKind) => void

type CommandHandlers = {
  [K in CommandName]: (
    args: CommandArgs<K>,
    win: ZenWindow
  ) => CommandResult<K> | Promise<CommandResult<K>>
}

const FOCUS_CHROME_EVENTS = new Set<EventName>([
  'urlbar.toggle',
  'newtab.opened',
  'newtab.shortcutDialog',
  'overlay.open',
  'find.open',
  'zoom.open',
  'mediahub.open',
  'siteInfo.open',
  'extensions.open',
  'reader.preferences',
  'theme.open',
  'space.new',
  'space.edit',
  'tab.startRename',
  'folder.startRename',
  'folder.edit',
  'tab.editPinnedUrl',
  'tab.pickIcon',
  'menu.show',
  'menu.app',
  'tabsearch.open',
  'overview.open',
  'bookmark.star',
  'bookmark.edit',
  'webapp.install',
  'translate.selection',
  'import.open'
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
  /** Typed text → chosen destination memory, the omnibox's shortcuts provider (omnibox-03). */
  readonly omniboxShortcuts: OmniboxShortcutsService
  /**
   * The new tab page on both platforms: `zen://newtab`'s state and the pages preloaded for
   * Ctrl+T (desktop), the shortcuts, the removed hosts and the background image (both).
   */
  readonly newTab: NewTabService
  readonly bookmarks: BookmarkService
  readonly downloads: DownloadService
  private readonly downloadListeners = new Set<DownloadChangeListener>()
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
  /** Internal pages (Settings) as tabs of their own, or as overlays where the host has no page tabs. */
  readonly pages: PageService
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
  /** Per-site cookie exceptions, clear browsing data on exit and the site-data viewer. */
  readonly siteData: SiteDataService
  /** Links that leave the web: the confirm sheet and the remembered per-scheme choices. */
  readonly externalProtocols: ExternalProtocolService
  /** The encrypted credential vault and everything the password manager does with it. */
  readonly passwords: PasswordService
  /** In-page autofill: save / update prompts, the account picker, addresses, cards, passkey records. */
  readonly autofill: AutofillService
  /** The system's browser role: are we the default, and should we be asking to become it. */
  readonly defaultBrowser: DefaultBrowserService
  /** The device's connectivity: the offline banner's state and the error pages that reload themselves. */
  readonly connectivity: ConnectivityService
  /** Chrome's "Import bookmarks and settings": other browsers' profiles and picked files (ID-23). */
  readonly imports: ImportService
  /**
   * The heavy parsing and hashing of the services' downloads (the filter lists, the Safe Browsing
   * feeds), in the host's worker where it has one, and the demo harness's hold on the startup
   * sweeps (`performance.releaseBackgroundWork`).
   */
  readonly background: BackgroundWork
  /** Ad and tracker blocking: the rule engine, its lists and the blocked-request counters. */
  readonly blocking: BlockingService
  /** Safe Browsing, HTTPS-only mode, secure DNS, third-party cookies and the GPC / DNT signals. */
  readonly protection: ProtectionService
  /** Offline page translation: detection, offers, the engine and its models. */
  readonly translate: TranslateService
  /** The print preview (`zen://print`) on hosts whose engine has none of its own. */
  readonly print: PrintService
  /** The inline PDF viewer (`zen://pdf`) on hosts whose engine cannot draw a PDF. */
  readonly pdf: PdfViewerService
  /** Desktop site, dark theme for sites and page zoom, remembered per site (Chrome's page controls). */
  readonly pageControls: PageControls
  readonly spellcheck: SpellcheckService
  /** The preferred languages: the pages' `Accept-Language`, translate's and spellcheck's defaults (CT-41). */
  readonly languages: LanguagesService
  /** The page fonts and the minimum font size in every page view (CT-25). */
  readonly pageFonts: PageFontsService
  /** The theme source last handed to the host (`ThemeHost.setSource`), so a sync merge's change reaches it too. */
  private themeSource: ColorScheme | null = null
  /** The last find-in-page query per tab and profile-wide (what the bar reopens with). */
  readonly find = new FindMemory()
  /** Fullscreen hints (F11, a page's element) and the Esc hold that leaves the window's fullscreen. */
  readonly fullscreen: FullscreenService
  /** Web app manifests, "Add to Home screen" and the ambient install prompt. */
  readonly webApps: WebAppService
  /** The pages' media as the OS controls and the in-app player see it (the Media Session). */
  readonly mediaSession: MediaSessionService
  /** Read aloud: the one session's text, playback and highlight state over the host's speech engine. */
  readonly readAloud: ReadAloudService
  /** Web Notifications of pages on hosts whose engine lacks the API (the page script's polyfill). */
  readonly webNotifications: WebNotificationService
  /** The user's search engines: OpenSearch discovery, the Settings > Search form, the clipboard row's reads. */
  readonly searchEngines: SearchEngineService
  /** The screen-capture picker (MW-19). */
  readonly screenCapture: ScreenCaptureService
  /** The chrome's share sheet (MW-21). */
  readonly shares: ShareService
  /** Links to a highlight: the selection's `#:~:text=` directive, made by the page (SH-11). */
  readonly textFragments: TextFragments
  /** The network location provider behind `navigator.geolocation` where the engine has none (MW-04). */
  readonly geolocation: GeolocationService
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
  /**
   * The session's browser windows are still to open: the run began on an app window alone
   * (`start({ windows: false })`), and they come up the first time a browser window is needed.
   */
  private startupWindowsPending = false

  constructor(readonly platform: Platform) {
    this.state = new BrowserState(
      platform.io,
      platform.info.os,
      platform.capabilities,
      platform.info.version
    )
    this.state.liveWindows = () => this.allWindows()
    // A profile without a preferred languages list starts from the OS's languages (CT-41).
    this.state.systemLocales = platform.info.locales ?? []
    this.state.load()
    const performance = platform.performance
    this.background = new BackgroundWork({
      worker: performance?.createBackgroundWorker?.bind(performance) ?? null,
      hold: performance?.holdBackgroundWork?.bind(performance) ?? null
    })
    if (platform.theme) {
      const theme = platform.theme
      // Pages follow Zenium's appearance (CT-23): the engine's theme source is the setting, so
      // every page's `prefers-color-scheme` reads Light / Dark / the OS with the chrome
      // (`setThemeSource` also takes the engine's reading into `systemDark`).
      this.setThemeSource(this.state.settings.colorScheme)
      theme.onChanged(() => {
        const dark = theme.systemDark()
        if (dark === this.state.systemDark) return
        this.state.systemDark = dark
        this.state.commitVolatile()
      })
    }
    this.history = new HistoryService(platform.io)
    this.omniboxShortcuts = new OmniboxShortcutsService(platform.io)
    // Clearing history clears what the omnibox learned from it (Chromium's ShortcutsBackend
    // follows the history service's deletions).
    this.history.onChange((kind) => {
      if (kind === 'clear') this.omniboxShortcuts.clear()
    })
    this.bookmarks = new BookmarkService(this.state)
    this.downloads = new DownloadService(
      platform.io,
      platform.downloads,
      (item, kind) => {
        this.state.commitVolatile()
        this.emitDownload('download.changed', { item, kind }, item.private)
        for (const listener of this.downloadListeners) listener(item, kind)
      },
      {
        os: platform.info.os,
        settings: () => resolveDownloadSettings(this.state.settings),
        referrerFamiliar: (referrer) => this.history.visitedBeforeToday(referrer),
        onDanger: (item) => this.emitDownload('download.danger', { id: item.id }, item.private),
        onBegin: (item, init) => this.pdf.onDownloadBegin(item, init)
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
    this.pages = new PageService(this)
    this.tabs = new TabManager(this)
    this.tabDrag = new TabDragController(this)
    this.session = new SessionService(this)
    this.history.onChange((kind) => {
      for (const w of this.allWindows()) w.send('history.changed', { kind })
    })
    this.newTab = new NewTabService(this)
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
    this.sync = platform.sync ? new SyncEngine(this, platform.sync) : new NoSync(this)
    this.agents = new AgentService(this)
    this.updates = new UpdateService(
      this,
      platform.createUpdateHost?.(this) ?? new NoUpdateHost(platform)
    )
    this.siteInfo = new SiteInfoService(this)
    this.siteData = new SiteDataService(this)
    this.externalProtocols = new ExternalProtocolService(this)
    this.passwords = new PasswordService(this, platform.passwords)
    this.autofill = new AutofillService(this)
    this.defaultBrowser = new DefaultBrowserService(this)
    this.connectivity = new ConnectivityService(this)
    this.imports = new ImportService(this)
    this.blocking = new BlockingService(this)
    this.protection = new ProtectionService(this)
    this.translate = new TranslateService(this)
    this.spellcheck = new SpellcheckService(this)
    this.languages = new LanguagesService(this)
    this.pageFonts = new PageFontsService(this)
    this.print = new PrintService(this)
    this.pdf = new PdfViewerService(this)
    this.privacy = new PrivacyService(this)
    this.webApps = new WebAppService(this, platform.io)
    this.mediaSession = new MediaSessionService(this)
    this.readAloud = new ReadAloudService(this)
    this.webNotifications = new WebNotificationService(this)
    this.searchEngines = new SearchEngineService(this)
    this.screenCapture = new ScreenCaptureService(this)
    this.shares = new ShareService(this)
    this.textFragments = new TextFragments(this)
    this.geolocation = new GeolocationService(this)
    this.state.extras = (win) => ({
      boosts: this.boosts.all(),
      zappingTabId: this.boosts.zappingTabId(),
      liveFolders: this.liveFolders.all(),
      extensions: this.extensions.list(),
      extensionUpdates: this.extensions.updateCheck(),
      sidePanel: this.extensions.sidePanel(win),
      mods: this.mods.all(),
      sync: this.sync.status(),
      agents: this.agents.list(),
      agentServer: this.agents.serverStatus(),
      updates: this.updates.status(),
      passwords: this.passwords.status(),
      defaultBrowser: this.defaultBrowser.status(),
      network: this.connectivity.status(),
      blockedPopups: this.popups.all(),
      permissionRules: this.permissions.rules(),
      permissionDefaults: this.permissions.defaults(CONTENT_SETTINGS.map((s) => s.id)),
      lastSafetyCheck: this.privacy.lastSafetyCheck(),
      permissionPrompts: this.permissionPrompts.list(),
      securityPrompts: this.security.list(),
      pageDialogs: this.pageDialogs.list(),
      closingTabIds: this.tabs.closingTabIds(),
      screenCaptureRequests: this.screenCapture.list(),
      shareRequests: this.shares.listFor(win),
      crashRestore: this.session.crashRestoreOffer(),
      autofill: this.autofill.uiState(),
      blocking: this.blocking.status(),
      privacy: this.protection.status(),
      siteData: this.siteData.status(),
      translate: this.translate.uiState(),
      spellcheck: this.spellcheck.uiState(),
      readAloud: this.readAloud.uiState(),
      import: this.imports.uiState()
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
    return recent ?? this.openBrowserWindow()
  }

  /**
   * A browser window when none is alive: the session's windows when a run that began on an app
   * window alone (`--app=`) has not opened them yet, else a new synced window.
   */
  private openBrowserWindow(): ZenWindow {
    if (this.startupWindowsPending) {
      const opened = this.openStartupWindows()
      if (opened[0]) return opened[0]
    }
    return this.createWindow({ kind: 'synced' })
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

  /**
   * A web app in a standalone window of its own – `zenium --app=<url>`, what an installed app's
   * launcher runs (MW-23, Chrome's app window): no browser chrome, the app's name and icon on the
   * frame, one page that stays inside the app's scope (a navigation out of it opens in a browser
   * tab, `TabManager.onWillNavigate`). The installed app whose scope holds `url` lends its name,
   * icon and remembered bounds; a URL no app claims opens under its host's name with its origin
   * as the scope. Hosts with one window open the URL as a tab instead. Returns the window, or
   * null when the URL cannot be a page.
   */
  openAppWindow(url: string, opts: { from?: ZenWindow } = {}): ZenWindow | null {
    if (!/^https?:\/\//i.test(url)) return null
    if (!this.state.capabilities.windows) {
      this.openExternalUrl(url)
      return null
    }
    const record = this.webApps.pinnedFor(url)
    const app: AppWindowInfo = record
      ? {
          name: record.name,
          icon: record.icon ?? null,
          scope: record.scope,
          appId: record.id,
          startUrl: record.startUrl
        }
      : {
          name: displayHost(url) || url,
          icon: null,
          scope: new URL(url).origin + '/',
          appId: null,
          startUrl: url
        }
    const win = this.createWindow({
      kind: 'unsynced',
      from: opts.from,
      chrome: 'app',
      app,
      bounds: record?.bounds ?? null,
      empty: true
    })
    this.tabs.createTab({ url, active: true }, win)
    return win
  }

  /**
   * The `display-mode` a page reports (`shared/displayMode`): Chrome's answer for the window
   * holding its live page – `fullscreen` while that window is, `standalone` in an app window,
   * `browser` elsewhere. `browser` for a tab with no page or window yet.
   */
  displayModeFor(tabId: string): DisplayMode {
    const win = this.tabs.ownerOf(tabId) ?? this.tabs.windowsShowing(tabId)[0]
    if (!win?.alive) return 'browser'
    return displayModeFor(win.windowState(), tabId)
  }

  /**
   * A window's pages may answer a different `display-mode` now (it went fullscreen or came back,
   * a page entered or left element fullscreen, a page arrived from another window): tell them,
   * so a page's `matchMedia('(display-mode: …)')` listeners hear the change as they would in Chrome.
   */
  pushDisplayMode(win: ZenWindow): void {
    for (const [tabId, view] of this.tabs.viewsOwnedBy(win))
      view.postToPage?.({ type: 'display-mode', mode: this.displayModeFor(tabId) })
  }

  /**
   * The browser window a page asked for from `win` opens in: `win` itself with the full chrome;
   * from a toolbar-only popup or an app window (one page, no tab strip) the browser window it was
   * opened from, else the browser window used last, else a new one. Chrome opens a popup's
   * chrome://settings and an app window's out-of-scope links in the browser the same way.
   */
  browserWindowFor(win: ZenWindow): ZenWindow {
    if (win.chrome === 'full') return win
    for (let w = win.opener; w; w = w.opener) if (w.alive && w.chrome === 'full') return w
    const full = this.allWindows().filter((w) => w.chrome === 'full' && !w.isClosing)
    const recent = full.sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)[0]
    if (recent) return recent
    if (!this.state.capabilities.windows) return win
    // A private popup keeps its pages private; anything else goes to the browser proper – the
    // session's windows when an app launched on its own (`--app=`) has not opened them yet.
    if (win.isPrivate) return this.createWindow({ kind: 'private', from: win, empty: true })
    return this.openBrowserWindow()
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
    /** The web app of a standalone window (`chrome` `app`): name, icon and scope. */
    app?: AppWindowInfo | null
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
    const app = chrome === 'app' ? (opts.app ?? null) : null
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
      // Toolbar-only popups and app windows have no sidebar or toolbar to hide.
      compact:
        chrome !== 'full'
          ? false
          : (opts.persisted?.compact ??
            from?.compactEnabled ??
            this.state.settings.compactMode.enabled),
      localSpace,
      cascadeFrom: opts.bounds ? undefined : from,
      opener: from,
      app
    })
    this.windows.set(id, win)
    const theme = resolveTheme(win.activeSpace().theme, this.darkScheme())
    win.host = this.platform.windows.create(win, {
      bounds: win.initialBounds,
      displayId: win.initialDisplayId,
      maximized: win.initialMaximized,
      cascadeFrom: win.cascadeFrom,
      title: app ? app.name : win.isPrivate ? 'Zenium (Private Browsing)' : 'Zenium',
      chrome,
      material: win.material,
      backgroundColor: rgbToHex(theme.averageColor),
      captionColors: captionColors(theme),
      app
    })
    this.governor.watchWindow(win)
    if (localSpace && !opts.empty) {
      // Blank / private windows start with an empty tab (the new tab page when it is on) and
      // the URL bar open over it once the chrome is up.
      const url = this.newTab.homeUrl() ?? BLANK_URL
      const tab = this.tabs.createTab({ url, active: true, load: false }, win)
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
    if (this.urlbarOnReady.delete(win.id)) {
      const active = this.tabs.activeTabFor(win)
      setTimeout(() => {
        if (!win.alive) return
        if (active && isEmptyTabUrl(active.url) && this.newTab.enabled)
          this.emit('newtab.opened', { tabId: active.id }, win)
        else this.emit('urlbar.toggle', { mode: 'new-tab' }, win)
      }, 150)
    }
    this.newTab.onChromeReady(win)
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
    // As for Ctrl+T (`openNewTab`): an enabled extension's new-tab override wins (Chrome).
    const override = win.isPrivate ? null : this.extensions.newTabUrl()
    const url = override ?? this.newTab.homeUrl() ?? BLANK_URL
    const tab = this.tabs.createTab({ url, active: true, load: false }, win)
    if (!win.chromeReady) {
      this.urlbarOnReady.add(win.id)
      return
    }
    setTimeout(() => {
      if (!win.alive) return
      if (this.newTab.enabled && isEmptyTabUrl(tab.url))
        this.emit('newtab.opened', { tabId: tab.id }, win)
      else this.emit('urlbar.toggle', { mode: 'new-tab' }, win)
    }, 150)
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
      // Clear browsing data on exit once the quit is agreed, with a budget: what does not
      // finish in time is owed to the next launch (`SiteDataService.runOnExit` writes the
      // marker first). Part of the check, so a second request during the run waits for it
      // rather than asking again; ahead of `shutdown`, so what the run clears from the core's
      // own stores goes into the profile's final write.
      this.quitCheck = this.confirmQuit(from)
        .then(async (agreed) => {
          if (agreed) await this.siteData.runOnExit()
          return agreed
        })
        .finally(() => {
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
    this.newTab.onWindowClosed(win)
    for (const w of this.allWindows()) w.selection.delete(win.localSpace?.id ?? '')
    if (win.isPrivate) this.endPrivateSessionIfOver()
    if (this.allWindows().length === 0) {
      this.governor.stop()
      this.newTab.destroyAll()
      this.tabs.destroyAll()
      this.platform.app.lastWindowClosed()
      return
    }
    if (!this.quitting) this.state.commit()
  }

  /** A private tab closed (hosts with `capabilities.privateTabs`). */
  onPrivateTabClosed(): void {
    this.endPrivateSessionIfOver()
    this.syncPrivateSession()
  }

  /**
   * A private tab opened or closed: the host's presence for the session (Android's "Close all
   * private tabs" notification) follows the count.
   */
  syncPrivateSession(): void {
    this.platform.privateSession?.setOpenTabs(this.tabs.privateTabs().length)
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
   * A browser window for a page from outside (the command line, another app's link): the
   * focused one, or the browser window behind a focused popup or app window – never the app
   * window itself, whose one page is the app's.
   */
  ensureBrowserWindow(): ZenWindow {
    return this.browserWindowFor(this.ensureWindow())
  }

  /**
   * A navigation that turned into a download leaves its tab without a committed document (and
   * without a renderer to route shortcuts through). Like Chrome, close such a tab when it was
   * opened only for the download; otherwise just make sure the keyboard keeps working.
   */
  onDownloadStarted(sourceTabId: string | null): void {
    const win = sourceTabId ? this.tabs.windowFor(sourceTabId) : this.focusedWindow()
    // A PDF the tab navigated to opens in the tab's own viewer once it is down
    // (`PdfViewerService`): as in Chrome Android the tab stays for it, and no Downloads surface
    // comes over the page – the sheet would take the fingers meant for the viewer.
    if (sourceTabId && this.pdf.expects(sourceTabId)) return
    // Firefox shows the downloads panel whenever a download begins; the desktop chrome decides
    // from `download.changed` instead (Chrome-style button, or the bubble when
    // `Settings.downloads.openPanelOnStart` asks for it). A single-window host (Android) keeps
    // the sheet where Downloads is a sheet – the phone layout; a tablet, whose Downloads is a
    // page tab as the desktop's, gets nothing over the page (Chrome opens no tab for a
    // download). Let any tab switch paint first so the sheet can dim a snapshot of the page
    // behind it. A sheet already up stays up with the new row on top (`reveal`: the chrome
    // toggles only a repeat request of the user's).
    if (!this.state.capabilities.windows && !this.pages.opensPageAsTab('downloads', win)) {
      setTimeout(
        () => this.pages.open('downloads', undefined, win, undefined, { reveal: true }),
        200
      )
    }
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

  /**
   * Bring the browser up. `windows: false` leaves the session's browser windows unopened – a run
   * that begins with `--app=<url>` shows the app's window alone, as Chrome does, and opens the
   * browser proper the first time something asks for a browser window.
   */
  start(options: { windows?: boolean } = {}): void {
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
      // A sync merge writes the appearance without `updateSettings`: the pages follow it too.
      this.setThemeSource(this.state.settings.colorScheme)
      // The table is rebuilt (a new array) when the preset or the overrides change, from
      // Settings or from another device: hosts with their own copy get it then.
      if (this.state.shortcuts !== this.syncedShortcuts) this.syncShortcuts()
      // The menu bar (macOS) reflects the front window and the model: enabled states, the
      // compact mode check, recently closed entries, the bookmarks bar.
      this.menus.scheduleApplicationMenu()
      // Open new tab pages follow the model (shortcuts, most visited, theme) live.
      this.newTab.push()
    })
    // Rule sets load synchronously so the first page is protected.
    this.blocking.start()
    // After the blocking store is attached: HTTPS-only mode's set is persisted like the others.
    this.protection.start()
    // A clear on exit the last close left owed runs now, off the boot path.
    this.siteData.start()
    // The pages' languages and fonts reach the host before the first page view is made, so the
    // restored tabs' first requests and layouts carry the settings (CT-41, CT-25).
    this.languages.start()
    this.pageFonts.start()
    // With "restore previous session" off, the last session's tabs are forgotten at once, whether
    // or not a window opens now.
    if (!this.state.settings.restoreSession) this.state.forgetSession()
    if (options.windows === false) this.startupWindowsPending = true
    else this.openStartupWindows()
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
    this.connectivity.start()
    this.translate.start()
    this.spellcheck.start()
    this.syncShortcuts()
    this.pageControls.push()
    this.state.commit()
  }

  /**
   * The session's browser windows: Zen restores every synced window (and the space each one was
   * in). With "restore previous session" off one window starts fresh. Returns the windows opened.
   */
  private openStartupWindows(): ZenWindow[] {
    this.startupWindowsPending = false
    const { restoreSession } = this.state.settings
    const restore =
      restoreSession && this.state.capabilities.windows
        ? this.state.restoredWindows
        : this.state.restoredWindows.slice(0, 1)
    const opened: ZenWindow[] = []
    if (restore.length === 0) opened.push(this.createWindow({ kind: 'synced' }))
    for (const persisted of restore) opened.push(this.createWindow({ kind: 'synced', persisted }))
    if (!restoreSession) {
      this.openFreshTab(opened[0])
    } else if (this.state.uncleanExit && this.state.platform !== 'android') {
      // The last run crashed (or was killed): its pages are offered, not loaded. Android ends
      // most runs by killing the process – that is its normal exit, and the pages just come back.
      this.session.onUncleanStart()
    }
    return opened
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
   * The user asked for a new tab (Ctrl+T, the sidebar button, the menus). As in Chrome, an
   * extension the user opted in that holds the `chrome_url_overrides.newtab` override wins: its
   * page opens as the tab (never in private windows, which extensions do not run in). Otherwise
   * the new tab page opens (`zen://newtab`, preloaded) with the URL bar over it – or, with the
   * page turned off, the URL bar alone in new-tab mode.
   */
  openNewTab(win: ZenWindow = this.focusedWindow()): void {
    const url = win.isPrivate ? null : this.extensions.newTabUrl()
    if (url) {
      this.tabs.createTab({ url, active: true }, win)
      return
    }
    this.newTab.open(win)
  }

  /**
   * Settings › Privacy and Security › Lock private tabs when you leave Zenium (INC-05 / SET-17):
   * the switch, device-local (`state.privateDevice`, never synced, the `newTabDevice` write
   * shape: replaced whole, sanitised). The lock itself is the phone host's and stays in memory;
   * the host reads the switch off the state it is sent.
   */
  private setPrivateLockOnLeave(enabled: boolean): void {
    const { state } = this
    state.privateDevice = sanitizePrivateDevice({ ...state.privateDevice, lockOnLeave: enabled })
    state.commit()
  }

  /**
   * Host-side listeners for the engine's `download.changed` (the desktop shell's taskbar
   * progress and completion notifications); windows get the same event over IPC.
   */
  onDownloadChange(listener: DownloadChangeListener): () => void {
    this.downloadListeners.add(listener)
    return () => this.downloadListeners.delete(listener)
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
    this.readAloud.onPageReady(tabId)
    this.translate.onPageReady(tabId)
    this.autofill.onPageReady(tabId)
  }

  onNavigated(tabId: string, inPage = false): void {
    const tab = this.tabs.tab(tabId)
    if (tab) {
      tab.readerable = false
      this.webApps.onNavigated(tabId, tab.url, inPage)
    }
    // An action popup goes when the page under it navigates; a tab no window shows navigating
    // behind it leaves it open, as Chrome's does (Read Aloud's popup opens its player in a
    // background tab and reads the page through it; the popup closing dropped the reading).
    if (!inPage && this.tabs.windowsShowing(tabId).length > 0) this.extensions.closePopup()
    this.translate.onNavigated(tabId)
    this.autofill.onNavigated(tabId)
    this.fullscreen.onNavigated(tabId)
    this.geolocation.onNavigated(tabId, inPage)
    this.readAloud.onNavigated(tabId, inPage)
    if (!inPage) {
      this.screenCapture.cancelForTab(tabId)
      this.shares.cancelForTab(tabId)
    }
  }

  /**
   * The media list (`UIState.media`): every audible tab, plus – on hosts whose page script
   * reports the Media Session – what its controls show. The session for the OS controls is
   * pushed to the host alongside; a closed tab drops out of both.
   */
  updateMedia(): void {
    const media: MediaState[] = this.mediaSession.refresh()
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
    if (!tab || !this.bookmarkable(tab.url)) return
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
   * What the star and Ctrl+D take: a site, and an internal page whose registry entry keeps the
   * star (`pill.showStar` – Chrome bookmarks chrome://settings); no other `zen://` document.
   */
  bookmarkable(url: string): boolean {
    return !url.startsWith('zen://') || this.pages.pageAt(url)?.pill.showStar === true
  }

  /**
   * The star: bookmark the page into the default folder when it is not bookmarked yet, then let
   * the star dialog rename, refile or remove it. A second press edits the existing bookmark
   * instead of adding another one.
   */
  starTab(tabId: string, win: ZenWindow = this.tabs.windowFor(tabId)): void {
    const tab = this.tabs.tab(tabId)
    if (!tab || !this.bookmarkable(tab.url)) return
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

  /**
   * One new folder with a bookmark per page among `tabIds`, in tab order, and a toast saying so
   * – unless `quiet`, for a caller that toasts the result itself (the phone overview's Bookmark
   * all adds Open to its); with no page to file the toast is the core's either way, since
   * nothing came back for the caller to report.
   */
  createBookmarksFromTabs(
    tabIds: readonly string[],
    title: string,
    parentId: string,
    win: ZenWindow,
    quiet = false
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
    if (quiet) return folder
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
  openBookmark(
    id: string,
    newTab: boolean,
    tabId: string | null,
    win: ZenWindow,
    background = false
  ): void {
    const node = this.bookmarks.get(id)
    if (!node || node.type !== 'url' || !node.url) return
    this.bookmarks.touch(id)
    // Same path as a typed URL so space routing applies; `background` is the new tab behind.
    this.submitUrlbar(node.url, newTab || background, tabId, background, win)
  }

  /** Open every bookmark below the given nodes in new tabs (the first one becomes active). */
  async openBookmarks(ids: readonly string[], win: ZenWindow): Promise<void> {
    const urls = await this.bookmarkUrlsToOpen(ids, win)
    urls.forEach((url, i) => this.tabs.createTab({ url, active: i === 0 }, win))
  }

  /**
   * Bookmarks > Import Bookmarks and Settings… (Chrome's `chrome://settings/importData`): the
   * chrome opens Settings on its Import category with the import dialog up (ID-23). The
   * Netscape-file import of the bookmark manager's own menu stays `importBookmarks`.
   */
  openImportDialog(win: ZenWindow): void {
    this.emit('import.open', undefined, win)
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
    const created = this.tabs.createTab(
      {
        url: this.newTab.homeUrl() ?? BLANK_URL,
        active: true,
        afterTabId: tabId,
        containerId: tab.containerId,
        pinned: tab.pinned,
        folderId: tab.folderId
      },
      win
    )
    if (this.newTab.enabled) {
      this.state.afterBroadcast(() => this.emit('newtab.opened', { tabId: created.id }, win))
    } else {
      this.emit('urlbar.toggle', { mode: 'edit', text: '' }, win)
    }
  }

  /**
   * A new folder – a tab group (tabs-13) – in the space, wearing the next free colour as
   * Chrome's new groups do unless the caller picked one. Unless `rename` is off (a folder made
   * by a gesture), the chrome then shows the folder's editor: the group editor bubble on
   * desktop, the inline rename on the phone.
   */
  createFolder(
    spaceId: string,
    name: string,
    icon: string,
    win?: ZenWindow,
    options: { color?: FolderColor; rename?: boolean } = {}
  ): Folder {
    const color = options.color ?? nextFolderColor(this.state.model, spaceId)
    const folder = createFolder(this.state.model, spaceId, name, icon, color)
    this.state.commit()
    if (options.rename !== false) this.editFolder(folder.id, win)
    return folder
  }

  /**
   * Show the folder's editor in the chrome (`folder.edit`), once the state that holds the folder
   * has gone out: the bubble hangs from the folder's header row and shows the folder's own name
   * and colour, so it must not arrive ahead of them.
   */
  private editFolder(folderId: string, win?: ZenWindow): void {
    this.state.afterBroadcast(() => this.emit('folder.edit', { folderId }, win))
  }

  /** Chrome's "Add tab to new group": a new folder around the tab, its editor open. */
  newFolderWithTab(spaceId: string, tabId: string, win?: ZenWindow): void {
    const folder = createFolder(
      this.state.model,
      spaceId,
      'New Folder',
      '📁',
      nextFolderColor(this.state.model, spaceId)
    )
    this.tabs.moveToFolder(tabId, folder.id)
    this.state.commit()
    this.editFolder(folder.id, win)
  }

  /**
   * Chrome's "New tab in group" (tabs-13): a new tab at the end of the folder – after its last
   * member, in that member's container – active, with the new tab page (or the URL bar) as any
   * new tab. Resolves with the tab's id.
   */
  newTabInFolder(folderId: string, win: ZenWindow = this.focusedWindow()): string {
    const folder = this.state.model.folders[folderId]
    if (!folder) throw new Error('Folder not found')
    // The group's members are its regular ones: a private tab in it lends neither its place
    // nor its container to a tab the group's menu makes.
    const members = regularFolderTabs(this.state.model, folderId)
    const last = members[members.length - 1]
    const created = this.tabs.createTab(
      {
        url: this.newTab.homeUrl() ?? BLANK_URL,
        spaceId: folder.spaceId,
        active: true,
        afterTabId: last?.id,
        containerId: last?.containerId,
        folderId
      },
      win
    )
    if (folder.collapsed) this.updateFolder(folderId, { collapsed: false })
    if (this.newTab.enabled) {
      this.state.afterBroadcast(() => this.emit('newtab.opened', { tabId: created.id }, win))
    } else {
      this.emit('urlbar.toggle', { mode: 'edit', text: '' }, win)
    }
    return created.id
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
    // A private tab in the group was none of its tabs on the surface that deletes it: it is
    // loose now (the model ungrouped it) and stays open, as the group's regular tabs close.
    for (const id of closed) {
      const tab = this.tabs.tab(id)
      if (tab && !this.tabs.isPrivate(tab)) this.tabs.closeTab(id, true)
    }
    this.state.commit()
  }

  /**
   * Chrome's "Close group" where groups are saved (TAB-16): the tabs close, the group stays as a
   * saved one with their pages (`Folder.savedTabs`), listed in the Tab groups pane until it is
   * opened again or deleted.
   */
  closeFolder(folderId: string, win: ZenWindow = this.focusedWindow()): void {
    this.tabs.closeFolderTabs(folderId, win)
  }

  /**
   * "Open" a saved group (TAB-16): its pages come back as tabs of the group, in the order they
   * were kept, at the end of the space's regular tabs – unloaded but for the first, which is
   * made active – and the group is expanded. An open group is expanded and its first member
   * activated instead. Resolves with the tab made active, or null with nothing to open.
   */
  openFolder(folderId: string, win: ZenWindow = this.focusedWindow()): string | null {
    const m = this.state.model
    const folder = m.folders[folderId]
    if (!folder) return null
    const now = Date.now()
    // The group's live members are its regular ones: a private tab in it is not what a regular
    // surface's row opens (`regularFolderTabs`).
    const live = regularFolderTabs(m, folderId)
    if (live.length > 0) {
      folder.collapsed = false
      folder.lastUsedAt = now
      this.tabs.activateTab(live[0].id, win)
      this.state.commit()
      return live[0].id
    }
    const saved = folder.savedTabs ?? []
    if (saved.length === 0) return null
    const space = getSpace(m, folder.spaceId)
    if (!space) return null
    const restored: Tab[] = []
    for (const page of saved) {
      const last = restored[restored.length - 1]
      const tab = this.tabs.createTab(
        {
          url: page.url,
          spaceId: space.id,
          active: false,
          load: false,
          // The first at the end of the space's tabs, as Chrome reopens a saved group; each
          // next one behind the one before, so the group keeps its order.
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
    folder.savedTabs = null
    folder.collapsed = false
    folder.lastUsedAt = now
    this.tabs.activateTab(restored[0].id, win)
    this.state.commit()
    return restored[0].id
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
    // A `zenium://settings/privacy` deep link opens (or reuses) the page's tab, no opener;
    // `fromIntent` travels with it, so back at its landing returns to the app that sent it.
    if (!this.pages.openUrl(url, win, null, { fromIntent: opts.fromIntent })) {
      const routed = win.localSpace ? null : this.routeSpaceFor(url)
      const tab = this.tabs.createTab(
        { url, active: true, spaceId: routed ?? undefined, fromIntent: Boolean(opts.fromIntent) },
        win
      )
      if (routed && routed !== win.activeSpaceId) this.tabs.switchSpace(routed, win, tab.id)
    }
    win.host.show()
    win.host.focus()
  }

  /**
   * The search engine in force: an installed extension's while one holds the default
   * (`chrome_settings_overrides`), else the one picked in Settings, else the first one.
   */
  defaultSearchEngine(): SearchEngine {
    return this.state.defaultSearchEngine()
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
    // A desktop has no share target of the OS's own: the chrome's sheet (copy, QR, email, the
    // system sheet on macOS) stands in for it – once the window's chrome has one up. Until then
    // "share" means what it always did on a desktop without a target: the link goes to the
    // clipboard, and the chrome says so.
    if (this.state.capabilities.shareSheet && surfaceMounted(win, 'share')) {
      this.shares.open(payload, win)
      return
    }
    const text = payload.url ?? payload.imageUrl ?? payload.text
    if (text) this.copyText(text, 'Link copied', win)
  }

  /**
   * Share a tab's page: its title and address, with its favicon as the preview. An internal
   * page shares its user-facing `zenium://` address – the deep link another app or device opens
   * it by; `zen://` never leaves `tab.url`. An extension's page shares its `chrome-extension://`
   * address, whichever form the tab carries (`presentedUrl`).
   */
  shareTab(tabId: string, win: ZenWindow = this.tabs.windowFor(tabId)): void {
    const tab = this.tabs.tab(tabId)
    if (!tab || !(isWebPageUrl(tab.url) || extensionPageOf(tab.url) || this.pages.isPageTab(tab))) {
      this.toast('This page cannot be shared', 'info', win)
      return
    }
    void this.share(
      {
        title: tab.customTitle ?? tab.title,
        url: presentedUrl(tab.url),
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

  /**
   * Voice search (OMN-19): the host's recogniser starts once the microphone is granted. A host
   * without one – or one whose capability is off – answers `unavailable`, which the sheet toasts.
   */
  async startVoiceSearch(): Promise<VoiceStartOutcome> {
    const { voice } = this.platform
    if (!voice || !this.state.capabilities.voiceSearch) return 'unavailable'
    return voice.start()
  }

  /**
   * QR scanning (OMN-22): the host's camera opens once it is granted. A host without a back
   * camera – or one whose capability is off – answers `unavailable`, which the sheet toasts.
   */
  async startQrScan(): Promise<QrStartOutcome> {
    const { qrScan } = this.platform
    if (!qrScan || !this.state.capabilities.qrScan) return 'unavailable'
    return qrScan.start()
  }

  /** The system's screen for which links open in this app (Android's "Open by default"). */
  openAppLinkSettings(win: ZenWindow): void {
    const { shell } = this.platform
    if (this.state.capabilities.appLinkSettings && shell.openAppLinkSettings)
      shell.openAppLinkSettings()
    else this.toast('Link handling is set in the system settings on this device.', 'info', win)
  }

  /** The system's Private DNS screen (Android), where a host without its own secure DNS sends the user. */
  openPrivateDnsSettings(win: ZenWindow): void {
    const { shell } = this.platform
    if (shell.openPrivateDnsSettings) shell.openPrivateDnsSettings()
    else this.toast('Secure DNS is set in the system settings on this device.', 'info', win)
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
    this.background.stop()
    this.translate.stop()
    this.passwords.shutdown()
    // The pages on screen have scrolled since their stacks were last read.
    this.tabs.rememberAllNavigation()
    // A close that skipped the on-exit clear (the OS shutting down, a mobile host's background)
    // leaves it to the next launch; after `requestQuit`'s run this says nothing more.
    this.siteData.noteExiting()
    this.state.markExiting()
    this.flushSync()
    this.state.freeze()
  }

  /** Persist everything now (mobile hosts call this when the app is backgrounded). */
  flushSync(): void {
    this.state.flushSync()
    this.history.flushSync()
    this.omniboxShortcuts.flushSync()
    this.downloads.flushSync()
    this.boosts.flushSync()
    this.liveFolders.flushSync()
    this.extensions.flushSync()
    this.mods.flushSync()
    this.sync.flushSync()
    this.passwords.flushSync()
    this.blocking.flushSync()
    this.translate.flushSync()
    this.print.flushSync()
    this.webApps.flushSync()
    this.permissions.flushSync()
    this.siteData.flushSync()
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
    win: ZenWindow,
    extra: {
      /** Shift+Enter, Ctrl+Shift+Enter, Shift+click: a new window of this window's kind. */
      newWindow?: boolean
      /** What was typed before the pick, for the shortcuts provider (never in private). */
      learn?: { typed: string; title: string; kind?: 'url' | 'search' }
    } = {}
  ): void {
    const text = input.trim()
    if (!text) return
    if (!win.isPrivate && this.extensions.omniboxSubmit(input, newTab, background, win)) return
    const keyword = matchKeyword(text, this.state.searchEngines)
    if (keyword?.kind === 'scope') {
      // `@bookmarks foo` / `@history foo` open the page searching for `foo` (Chrome's scoped
      // `chrome://history/?q=`); `@tabs foo` switches to the tab.
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
      const q = keyword.query.trim()
      this.pages.open(keyword.scope, null, win, tabId ?? null, { query: q ? { q } : undefined })
      return
    }
    const typed = this.typedToUrl(text)
    if (!typed) return
    const { url, upgradedFrom } = typed
    this.learnShortcut(text, url, tabId, win, extra.learn)
    if (extra.newWindow) {
      // Shift+Enter: the destination in a new window of this window's kind (a private window
      // opens another private one), the page here left as it is.
      this.openUrlInWindow(url, win.isPrivate ? 'private' : win.kind, win)
      return
    }
    // `zenium://settings/…`, `zenium://history` typed into the bar: a chrome page opens (or
    // reuses) its own tab – or its overlay, where the layout keeps one – with the current tab as
    // opener, whatever tab the text was typed into, and no tab is spent on it otherwise; a
    // document page loads like any document, in this tab or a new one, unless the window
    // already shows the one it keeps (`routeNavigation`).
    const pageRef = this.pages.parse(url)
    if (pageRef) {
      const page = this.pages.pages[pageRef.id]
      if (page.render === 'chrome') {
        this.pages.open(pageRef.id, pageRef.section, win, tabId ?? null, { query: pageRef.query })
        return
      }
      if (tabId && !newTab && this.pages.routeNavigation(tabId, url)) return
    }
    const routed = win.localSpace ? null : this.routeSpaceFor(url)
    const target = tabId ? this.tabs.tab(tabId) : undefined
    if (
      target &&
      !newTab &&
      !background &&
      routed &&
      routed !== win.activeSpaceId &&
      isEmptyTabUrl(target.url) &&
      !target.pinned &&
      !target.essential
    ) {
      // Typed into an empty tab, but the address belongs to another space: it opens there and
      // the empty tab, which only existed to be typed into, goes.
      const tab = this.tabs.createTab(
        { url, active: true, spaceId: routed, load: false, upgradedFrom },
        win
      )
      this.tabs.switchSpace(routed, win, tab.id)
      this.tabs.closeTab(target.id, true, win)
      return
    }
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
   * The shortcuts provider learns a pick (omnibox-03): what was typed → where it went, never in
   * a private window or for a private tab, never for Zenium's own pages. A search's row shows
   * the query; an address's the page's title, from history when the pick did not carry one.
   */
  private learnShortcut(
    text: string,
    url: string,
    tabId: string | null,
    win: ZenWindow,
    learn: { typed: string; title: string; kind?: 'url' | 'search' } | undefined
  ): void {
    if (!learn || !learn.typed.trim()) return
    if (win.isPrivate) return
    const tab = tabId ? this.state.model.tabs[tabId] : undefined
    if (tab?.containerId === PRIVATE_CONTAINER_ID) return
    if (!/^https?:\/\//i.test(url)) return
    const kind = learn.kind ?? (inputToUrl(text) ? 'url' : 'search')
    const engine =
      kind === 'search'
        ? this.state.searchEngines.find((e) => url.startsWith(e.searchUrl.split('%s')[0] ?? ''))
        : undefined
    const title =
      learn.title ||
      (kind === 'search' ? text : (this.history.titleFor(url) ?? displayUrl(url) ?? url))
    this.omniboxShortcuts.learn(learn.typed, {
      url,
      title,
      kind,
      ...(engine ? { engineId: engine.id } : {})
    })
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
      this.submitUrlbar(buildSearchUrl(this.defaultSearchEngine(), text), false, tabId, false, win)
      return
    }
    this.submitUrlbar(text, false, tabId, false, win)
  }

  /**
   * What typed text loads: a `@keyword query` searches with that engine; an address loads as
   * written (a bare host is upgraded to https:// and remembered for the http fallback); anything
   * else is searched with the default engine. Null for text that loads nothing (a keyword with
   * no query, a `@bookmarks` / `@history` / `@tabs` scope, which `submitUrlbar` acts on itself).
   */
  private typedToUrl(text: string): { url: string; upgradedFrom?: string } | null {
    const keyword = matchKeyword(text, this.state.searchEngines)
    if (keyword?.kind === 'scope') return null
    if (keyword) {
      if (!keyword.query.trim()) return null
      return { url: buildSearchUrl(keyword.engine, keyword.query) }
    }
    // Chrome's legacy `?` prefix: what follows is searched, however much it looks like an address.
    if (text.startsWith('?')) {
      const terms = text.slice(1).trim()
      return terms ? { url: buildSearchUrl(this.defaultSearchEngine(), terms) } : null
    }
    const url = inputToUrl(text)
    if (!url) return { url: buildSearchUrl(this.defaultSearchEngine(), text) }
    const upgradedFrom =
      url.startsWith('https://') && !/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : undefined
    return { url, upgradedFrom }
  }

  /**
   * Addresses or text dropped on the chrome (`drop.open`): links and selections from a page,
   * files from the OS as `file:` URLs. Each input goes where typed text would (`typedToUrl`),
   * to the target `key` names in the `data-drop` grammar:
   *   tab:<tabId>:into             the first input navigates that tab, the rest open after it
   *   tab:<tabId>:before|after     new tabs in that slot of the tab's section
   *   section:<section>:<spaceId>  new tabs at the end of the section (essential | pinned | regular)
   *   folder:<folderId>            new tabs in the folder
   *   space:<spaceId>              new tabs at the end of the space
   * New tabs that land in the window's active space show the first of them and load the rest
   * behind it (Chrome's foreground drop); tabs sent to another space load behind it.
   */
  openDropped(inputs: string[], key: string, win: ZenWindow): void {
    const texts = inputs.map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean)
    const drop = parseDropKey(key)
    if (!texts.length || !drop) return
    const m = this.state.model
    const tabs = this.tabs
    // Where new tabs go: the section and space, the slot to start at, the folder.
    let placement: {
      spaceId: string | undefined
      section: TabSection
      index: number
      folderId: string | null
    } | null = null
    let rest = texts
    switch (drop.kind) {
      case 'tab': {
        const target = tabs.tab(drop.tabId)
        if (!target) return
        const section: TabSection = target.essential
          ? 'essential'
          : target.pinned
            ? 'pinned'
            : 'regular'
        if (drop.position === 'into') {
          // Dropped onto the tab: it takes the first input as its URL bar would, and shows
          // (Chrome selects the tab a drag hovers before the drop lands in it).
          this.submitUrlbar(texts[0], false, target.id, false, win)
          if (tabs.tab(target.id)) tabs.activateTab(target.id, win)
          rest = texts.slice(1)
          placement = {
            spaceId: target.spaceId ?? undefined,
            section,
            index: sectionIndexOf(m, target) + 1,
            folderId: target.folderId
          }
        } else {
          placement = {
            spaceId: target.spaceId ?? undefined,
            section,
            index: sectionIndexOf(m, target) + (drop.position === 'after' ? 1 : 0),
            folderId: target.folderId
          }
        }
        break
      }
      case 'section': {
        if (!isTabSection(drop.section)) return
        if (drop.spaceId && !getSpace(m, drop.spaceId)) return
        placement = {
          spaceId: drop.spaceId || undefined,
          section: drop.section,
          index: Number.MAX_SAFE_INTEGER,
          folderId: null
        }
        break
      }
      case 'folder': {
        const folder = m.folders[drop.folderId]
        if (!folder) return
        placement = {
          spaceId: folder.spaceId,
          section: 'regular',
          index: Number.MAX_SAFE_INTEGER,
          folderId: folder.id
        }
        break
      }
      case 'space': {
        if (!getSpace(m, drop.spaceId)) return
        placement = {
          spaceId: drop.spaceId,
          section: 'regular',
          index: Number.MAX_SAFE_INTEGER,
          folderId: null
        }
        break
      }
      default:
        // A split edge or the bookmarks bar: not a place for an address to open.
        return
    }
    if (!placement || !rest.length) return
    const { spaceId, section, folderId } = placement
    // Blank / private windows create in their own space; the drop is in it whatever it names.
    const space = win.localSpace ?? getSpace(m, spaceId) ?? win.activeSpace()
    const inActiveSpace = section === 'essential' || space.id === win.activeSpaceId
    let index = placement.index
    let first = true
    for (const text of rest) {
      const typed = this.typedToUrl(text)
      if (!typed) continue
      const { url, upgradedFrom } = typed
      if (this.pages.parse(url)) {
        // Zenium's own pages open their tab (or surface) the way the URL bar opens them.
        this.submitUrlbar(url, true, null, !(first && inActiveSpace), win)
        first = false
        continue
      }
      const active = first && inActiveSpace
      const tab = tabs.createTab(
        {
          url,
          spaceId: space.id,
          active,
          pinned: section === 'pinned',
          essential: section === 'essential',
          index,
          folderId: section === 'regular' ? folderId : null,
          load: false,
          upgradedFrom: active ? upgradedFrom : undefined
        },
        win
      )
      if (!active) tabs.navigate(tab.id, url, { upgradedFrom })
      index = sectionIndexOf(m, tab) + 1
      first = false
    }
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
    if (message.type === 'webapp') {
      this.webApps.handleMessage(tabId, message)
      return
    }
    if (message.type === 'opensearch') {
      if (typeof message.url === 'string')
        void this.searchEngines.discover(
          tabId,
          message.url,
          typeof message.title === 'string' ? message.title : ''
        )
      return
    }
    if (message.type === 'share') {
      this.shares.handleMessage(tabId, message.share)
      return
    }
    if (message.type === 'textFragment') {
      this.textFragments.handleMessage(tabId, message)
      return
    }
    if (message.type === 'geolocation') {
      this.geolocation.handleMessage(tabId, message.geolocation)
      return
    }
    if (message.type === 'readAloud') {
      this.readAloud.handleMessage(tabId, message.readAloud)
      return
    }
    if (message.type === 'zap') {
      if (typeof message.selector === 'string') this.boosts.onZapped(tabId, message.selector)
      return
    }
    if (message.type === 'activation') {
      this.popups.activate(tabId)
      return
    }
    if (message.type === 'capture-state') {
      this.tabs.onCaptureState(tabId, message.capture)
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
    if (message.type === 'pdf') {
      if (message.pdf && typeof message.pdf === 'object')
        this.pdf.onReport(tabId, message.pdf, message.token)
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
        // The crash page's Show tabs (ERR-15): the tab switcher, from the sad tab alone.
        if (message.action === 'show-tabs') {
          if (this.tabs.isSadTab(tab))
            this.emit('overview.open', undefined, this.tabs.windowFor(tabId))
          return
        }
        // The certificate interstitial's tab answers first; the other warning pages are the
        // protection service's.
        if (!this.tabs.handleCertificateInterstitial(tabId, message.action, message.url))
          this.protection.handleInterstitial(tabId, message.action, message.url)
      }
      return
    }
    if (message.type === 'media') {
      if (!this.tabs.view(tabId)) return
      // A host whose engine reports audibility itself (Electron's `audio-state-changed`) sends
      // the Media Session report alone; `playing` is the page script's word where it tracks it.
      if (message.playing !== undefined) {
        tab.audible = Boolean(message.playing)
        this.governor.onMedia(tabId, Boolean(message.playing))
      }
      if (message.media) this.mediaSession.onReport(tabId, message.media)
      this.state.commitVolatile()
      this.updateMedia()
      return
    }
    if (message.type === 'notification') {
      if (message.notification) this.webNotifications.handle(tabId, message.notification)
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
            openerTabId: tab.essential ? undefined : tabId,
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
      'privacy.safetyCheck': () => this.privacy.runSafetyCheck(),
      'privacy.setThirdPartyCookiesPrivate': ({ mode }, win) =>
        this.protection.setThirdPartyCookiesPrivate(mode, win),
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
      'autofill.surfaceSize': ({ id, height }) => this.autofill.surfaceSize(id, height),
      'autofill.surfaceFocus': ({ id, focused }) => this.autofill.surfaceFocus(id, focused),
      'autofill.manage': (_args, win) => this.autofill.manage(win),
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
      // Voice search: the host listens (`VoiceHost`); the chrome's sheet acts on the `voice.event`s.
      'voice.start': () => this.startVoiceSearch(),
      'voice.cancel': () => this.platform.voice?.cancel(),
      'voice.openSettings': () => this.platform.voice?.openSettings(),
      // QR scanning (OMN-22): the host's camera scans (`QrScanHost`); the chrome's sheet acts on
      // the `qr.event`s and submits the payload through `urlbar.submit` like typed text.
      'qr.start': () => this.startQrScan(),
      'qr.cancel': () => this.platform.qrScan?.cancel(),
      'qr.layout': (slot) => this.platform.qrScan?.layout(slot),
      'qr.setTorch': ({ on }) => this.platform.qrScan?.setTorch(on),
      'qr.openSettings': () => this.platform.qrScan?.openSettings(),
      'externalProtocol.respond': ({ requestId, allow, always }) =>
        this.externalProtocols.respond(requestId, allow, always),
      'layout.report': (report, win) => win.applyLayout(report),

      'tab.new': (_a, win) => this.openNewTab(win),
      'tab.create': (opts, win) => tabs.createTab(opts, win).id,
      'tab.activate': ({ tabId, keepFocus }, win) =>
        tabs.activateTab(tabId, win, { keepFocus, userSwitch: true }),
      'tab.close': ({ tabId, force, keepFocus }, win) =>
        void tabs.requestClose(tabId, force, win, { keepFocus }),
      'tab.closeMany': ({ tabIds, activate }, win) => void tabs.closeMany(tabIds, win, activate),
      'tab.newPrivate': ({ url }, win) => tabs.newPrivateTab(url, win),
      'tab.closePrivate': (_a, win) => tabs.closePrivateTabs(win),
      'private.setLockOnLeave': ({ enabled }) => this.setPrivateLockOnLeave(enabled),
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
      'tab.selectionContextMenu': ({ tabIds, ...anchor }, win) =>
        this.menus.showSelectionContextMenu(tabIds, win, anchor),
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
      'drop.open': ({ inputs, key }, win) => this.openDropped(inputs, key, win),
      'tab.moveToNewWindow': ({ tabId }, win) => void tabs.moveTabToNewWindow(tabId, null, win),
      'tab.searchCandidates': (_args, win) => tabs.searchCandidates(win),
      'tab.switchTo': ({ tabId }, win) => tabs.switchTo(tabId, win),
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
      'tab.contextMenu': ({ tabId, ...anchor }, win) =>
        this.menus.showTabContextMenu(tabId, win, anchor),
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
      'space.contextMenu': ({ spaceId, ...anchor }, win) =>
        this.menus.showSpaceContextMenu(spaceId, win, anchor),

      'folder.create': ({ spaceId, name, icon, color, rename }, win) =>
        this.createFolder(spaceId, name, icon, win, { color, rename }).id,
      'folder.update': ({ folderId, patch }) => this.updateFolder(folderId, patch),
      'folder.delete': ({ folderId, unpack }) => this.deleteFolder(folderId, unpack),
      'folder.close': ({ folderId }, win) => this.closeFolder(folderId, win),
      'folder.open': ({ folderId }, win) => this.openFolder(folderId, win),
      'folder.contextMenu': ({ folderId, ...anchor }, win) =>
        this.menus.showFolderContextMenu(folderId, win, anchor),
      'folder.newTab': ({ folderId }, win) => this.newTabInFolder(folderId, win),
      'newtab.contextMenu': (anchor, win) => this.menus.showNewTabContextMenu(win, anchor ?? {}),
      'newtab.tileContextMenu': ({ url, title }, win) =>
        this.menus.showTopSiteContextMenu(url, title, win),
      'app.menu': ({ anchor, keyboard, mediaHubFolded }, win) =>
        this.menus.showAppMenu(win, {
          anchor,
          keyboard: Boolean(keyboard),
          mediaHubFolded: Boolean(mediaHubFolded)
        }),
      'focus.content': (_a, win) => win.focusContent(),
      'focus.chrome': (_a, win) => win.focusChrome(),
      haptic: ({ kind }, win) => win.haptic(kind),
      'media.toggle': ({ tabId }) => {
        const view = tabs.view(tabId)
        if (!view) return
        // A page whose script reports its media takes the toggle as a Media Session action (its
        // own handler, or the element that plays); elsewhere the first media element is toggled.
        if (
          this.mediaSession.sessionTab === tabId ||
          this.state.media.some((m) => m.tabId === tabId && m.actions)
        ) {
          this.mediaSession.act(tabId, 'toggle')
          return
        }
        void view
          .executeJavaScript(
            `(() => { const m = [...document.querySelectorAll('video,audio')].find(e => !e.paused) || document.querySelector('video,audio'); if (!m) return false; if (m.paused) { m.play().catch(() => {}); } else { m.pause(); } return true })()`
          )
          .catch(() => undefined)
      },
      'screenCapture.respond': ({ id, sourceId, audio }) =>
        this.screenCapture.respond(id, sourceId, Boolean(audio)),
      'share.respond': ({ id, answer }) => this.shares.respond(id, answer),
      'share.open': ({ tabId, payload }, win) => {
        if (payload) void this.share(payload, win)
        else if (tabId) this.shareTab(tabId, win)
        else {
          const active = tabs.activeTabFor(win)
          if (active) this.shareTab(active.id, win)
        }
      },
      // The preview card's and the long-screenshot editor's actions (SH-07, SH-08): the host's
      // gallery pictures. A host without one never shows the card, so these have nothing to do.
      'screenshot.share': async ({ uri }) => {
        await this.platform.screenshots?.share(uri)
      },
      'screenshot.delete': ({ uri }) => this.platform.screenshots?.delete(uri) ?? false,
      'screenshot.open': async ({ uri }) => {
        await this.platform.screenshots?.open(uri)
      },
      'screenshot.captureLong': ({ tabId }) =>
        this.platform.screenshots?.captureLong(tabId) ?? null,
      'screenshot.saveLong': async ({ id, crop, share }, win) => {
        const saved = (await this.platform.screenshots?.saveLong(id, crop, Boolean(share))) ?? null
        if (!saved) this.toast('Could not save the screenshot', 'error', win)
        return saved
      },
      'screenshot.discardLong': ({ id }) => this.platform.screenshots?.discardLong(id),
      'media.action': ({ tabId, action, seekTime, seekOffset }) =>
        this.mediaSession.act(tabId, action, { seekTime, seekOffset }),
      'media.pictureInPicture': ({ tabId }) => this.mediaSession.enterPictureInPicture(tabId),

      'split.create': ({ tabIds, layout }, win) => tabs.createSplit(tabIds, layout, win),
      'split.toggleLayout': ({ layout }, win) => tabs.toggleSplitLayout(layout, win),
      'split.setLayout': ({ groupId, layout }) => tabs.setSplitLayout(groupId, layout),
      'split.unsplit': ({ groupId, tabId }, win) => tabs.unsplit(groupId, tabId, win),
      'split.removeTab': ({ tabId, focus }, win) => tabs.removeFromSplit(tabId, focus, win),
      'split.resize': ({ groupId, sizes }) => tabs.resizeSplit(groupId, sizes),
      'split.newEmpty': (_a, win) => tabs.newEmptySplit(win),
      'split.addTab': ({ groupId, tabId }) => tabs.addToSplit(groupId, tabId),
      'split.pickTab': ({ paneTabId, tabId }, win) => tabs.pickTabForPane(paneTabId, tabId, win),

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

      'urlbar.suggest': ({ query, tabId, engineId, grouped }, win) =>
        this.suggestions.suggest(query, tabId, win, { engineId, grouped }),
      'urlbar.submit': ({ input, newTab, tabId, background, newWindow, learn }, win) =>
        this.submitUrlbar(input, newTab, tabId, Boolean(background), win, {
          newWindow: Boolean(newWindow),
          learn
        }),
      'urlbar.forgetShortcut': ({ url }) => this.omniboxShortcuts.forgetUrl(url),
      'urlbar.pasteAndGo': ({ tabId }, win) => void this.pasteAndGo(tabId, false, win),
      'urlbar.pasteAndSearch': ({ tabId }, win) => void this.pasteAndGo(tabId, true, win),
      'urlbar.runCommand': ({ action }, win) =>
        this.actions.run(action as AnyAction, { sourceTabId: null, win }),
      'urlbar.cancel': (_a, win) => this.extensions.omniboxCancel(win),
      'urlbar.deleteSuggestion': ({ input }, win) =>
        this.extensions.omniboxDeleteSuggestion(input, win),

      'overlay.snapshot': ({ tabId, fresh }, win) => win.snapshot(tabId, fresh),

      // Tab card pictures are the host's (`ThumbnailHost`); a host without them has none to show.
      'thumbnail.configure': ({ width }) => this.platform.thumbnails?.configure(width),
      'thumbnail.load': ({ tabId, url }) => this.platform.thumbnails?.load(tabId, url) ?? null,
      'thumbnail.drop': ({ tabId, url }) => this.platform.thumbnails?.drop(tabId, url),
      'thumbnail.sweep': ({ keep }) => this.platform.thumbnails?.sweep(keep),

      'site.info': ({ tabId }) => this.siteInfo.info(tabId),
      'siteInfo.snapshot': ({ tabId }) => this.siteInfo.snapshot(tabId),
      'site.clearCookies': ({ tabId }) => this.siteInfo.clearCookies(tabId),
      'site.clearData': ({ tabId }) => this.siteInfo.clearData(tabId),
      'siteData.setDefault': ({ default: value }, win) => this.siteData.setDefault(value, win),
      'siteData.add': ({ list, pattern }) => this.siteData.add(list, pattern),
      'siteData.addSite': ({ list, url }) => this.siteData.addSite(list, url),
      'siteData.remove': ({ pattern }) => this.siteData.remove(pattern),
      'siteData.list': () => this.siteData.list(),
      'siteData.clearSite': ({ origin }) => this.siteData.clearSite(origin),
      'siteData.clearAll': () => this.siteData.clearAll(),
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
      'history.delete': ({ url }) => {
        this.history.delete(url)
        // A page forgotten is not to be recalled by what was typed for it either.
        this.omniboxShortcuts.forgetUrl(url)
      },
      'history.clear': () => this.history.clear(),
      'history.visits': ({ query }) => this.history.visits(query),
      'history.grouped': ({ query }) => this.history.groupedByDay(query),
      'history.topSites': ({ n, excludedHosts }) => this.history.topSites(n, excludedHosts ?? []),
      'history.count': ({ fromMs, toMs }) => this.history.count(fromMs, toMs),
      'history.deleteVisits': ({ ids }) => this.history.deleteVisits(ids),
      'history.deleteUrls': ({ urls }) => this.history.deleteUrls(urls),
      'history.deleteDay': ({ dayKey }) => this.history.deleteDay(dayKey),
      'history.deleteRange': ({ fromMs, toMs }) => this.history.deleteRange(fromMs, toMs),
      'history.open': (_a, win) => {
        this.pages.open('history', undefined, win)
      },

      'page.open': ({ id, section, openerTabId, query }, win) =>
        this.pages.open(id, section, win, openerTabId, { query }),
      'page.navigate': ({ tabId, section, subpage, replace, query }) =>
        this.pages.navigate(tabId, section, replace ?? false, query, subpage),

      'history.contextMenu': ({ visitId, url, ...anchor }, win) =>
        this.menus.showHistoryContextMenu(visitId, url, win, anchor),
      'history.dayMenu': ({ dayKey, count }, win) =>
        this.menus.showHistoryDayMenu(dayKey, count, win),
      'history.foldedDevices': () => this.pages.foldedDeviceIds(),
      'history.foldDevice': ({ deviceId, folded }) => this.pages.foldDevice(deviceId, folded),

      'session.recentlyClosed': () => this.session.summaries(),
      'session.restoreClosed': ({ id, background }, win) =>
        this.session.restoreClosed(id, win, Boolean(background)),
      'session.clearRecentlyClosed': () => this.session.clearRecentlyClosed(),

      'clipboard.writeText': ({ text, sensitive, confirmation }, win) => {
        if (sensitive)
          this.passwords.clipboard.copy(text, state.settings.passwords.clipboardClearSeconds)
        else if (confirmation) this.copyText(text, confirmation, win)
        else platform.clipboard.writeText(text)
      },
      'clipboard.peek': () => this.searchEngines.peekClipboard(),
      'clipboard.read': () => this.searchEngines.readClipboard(),
      'clipboard.markUsed': () => this.searchEngines.markClipboardUsed(),
      'search.addEngine': ({ name, url }, win) => this.searchEngines.add(name, url, win),
      'search.removeEngine': ({ id }, win) => this.searchEngines.remove(id, win),

      'newtab.open': (_a, win) => this.openNewTab(win),
      'newtab.addShortcut': ({ title, url }) => this.newTab.addShortcut(title, url) ?? '',
      'newtab.updateShortcut': ({ id, title, url }) =>
        void this.newTab.updateShortcut(id, title, url),
      'newtab.removeShortcut': ({ id }) => void this.newTab.removeShortcut(id),
      'newtab.reorderShortcuts': ({ ids }) => this.newTab.reorderShortcuts(ids),
      'newtab.pickBackgroundImage': (_a, win) => this.newTab.pickBackgroundImage(win),
      'newtab.clearBackgroundImage': () => this.newTab.clearBackgroundImage(),
      'newtab.backgroundImage': () => this.newTab.backgroundImage(),
      'newtab.setBackgroundImage': ({ dataUrl }) => this.newTab.setBackgroundImage(dataUrl),

      'bookmark.toggle': ({ tabId }, win) => this.toggleBookmark(tabId, win),
      'bookmark.star': ({ tabId }, win) => this.starTab(tabId, win),
      'bookmark.create': ({ parentId, index, title, url, type, favicon }) =>
        this.bookmarks.create({ parentId, index, title, url, type, favicon }),
      'bookmark.update': ({ id, title, url }) => void this.bookmarks.update(id, { title, url }),
      'bookmark.move': ({ ids, parentId, index }) => void this.bookmarks.move(ids, parentId, index),
      'bookmark.remove': ({ ids }) => void this.bookmarks.removeMany(ids),
      'bookmark.open': ({ id, newTab, tabId, background }, win) =>
        this.openBookmark(id, newTab, tabId, win, Boolean(background)),
      'bookmark.openAll': ({ ids }, win) => this.openBookmarks(ids, win),
      'bookmark.openInWindow': ({ ids, private: isPrivate }, win) =>
        this.openBookmarksInWindow(ids, isPrivate, win),
      'bookmark.allTabs': (_a, win) => this.bookmarkTabs(win),
      'bookmark.createFromTabs': ({ tabIds, title, parentId, quiet }, win) =>
        this.createBookmarksFromTabs(tabIds, title, parentId, win, quiet ?? false),
      'bookmark.contextMenu': ({ ids, folderId, x, y, keyboard, surface }, win) =>
        this.menus.showBookmarkContextMenu(
          ids,
          folderId,
          { x, y, keyboard },
          win,
          surface ?? 'manager'
        ),
      'bookmark.menu': ({ x, y }, win) => this.menus.showBookmarksMenu({ x, y }, win),
      'bookmark.toggleBar': (_a, win) => this.toggleBookmarksBar(win),
      'bookmark.cut': ({ ids }) => this.clipBookmarks(ids, 'cut'),
      'bookmark.copy': ({ ids }) => this.clipBookmarks(ids, 'copy'),
      'bookmark.paste': ({ folderId, index }) => this.bookmarks.paste(folderId, index),
      'bookmark.import': (_a, win) => this.importBookmarks(win),
      'bookmark.export': (_a, win) => this.exportBookmarks(win),

      'import.sources': () => this.imports.sources(),
      'import.run': ({ source, kinds }, win) => this.imports.run(source, kinds, win),
      'import.cancel': () => this.imports.cancel(),
      'import.dismiss': () => this.imports.dismiss(),

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
      'download.deleteFile': ({ id }) => this.downloads.deleteFile(id),
      'download.exists': ({ id }) => this.downloads.exists(id),
      'download.chooseDirectory': (_args, win) => this.downloads.chooseDirectory(win),
      'download.directory': () => this.downloads.currentDirectory(),
      'download.openPanel': (_args, win) => {
        this.pages.open('downloads', undefined, win)
      },
      'download.dragOut': ({ id }, win) => {
        // Only a released file has a final path to hand to the OS; a quarantined one still waits.
        const item = this.downloads.item(id)
        if (item && item.state === 'completed' && !isQuarantined(item))
          platform.downloads.startFileDrag?.(item, win)
      },
      'download.openFolder': () => platform.downloads.openDownloadsFolder?.(),
      'download.contextMenu': ({ id, x, y, keyboard }, win) =>
        this.menus.showDownloadContextMenu(id, { x, y, keyboard }, win),

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
      'ui.surface': ({ surface, mounted }, win) => {
        if (mounted) win.surfaces.add(surface)
        else win.surfaces.delete(surface)
      },
      'window.new': (_a, win) => void this.openWindow('synced', win),
      'window.newUnsynced': (_a, win) => void this.openWindow('unsynced', win),
      'window.newPrivate': (_a, win) => void this.openWindow('private', win),
      'window.openUrl': ({ url, kind }, win) => this.openUrlInWindow(url, kind, win),
      'window.moveTabsToSpace': ({ spaceId }, win) => tabs.moveLocalTabsToSpace(win, spaceId),

      'page.screenshot': ({ tabId, fullPage }, win) =>
        this.actions.run(fullPage ? 'page.captureFullPage' : 'page.screenshot', {
          sourceTabId: tabId,
          win
        }),
      'page.print': ({ tabId }, win) => this.actions.run('page.print', { sourceTabId: tabId, win }),
      'page.printPreview': ({ tabId }, win) =>
        this.actions.run('page.printPreview', { sourceTabId: tabId, win }),
      'print.session': ({ tabId }) => this.print.session(tabId),
      'print.preview': ({ tabId, settings, pageCount }) =>
        this.print.preview(tabId, settings, pageCount ?? null),
      'print.run': ({ tabId, settings, pageCount }, win) =>
        this.print.run(tabId, settings, pageCount, win),
      'print.close': ({ tabId }) => this.print.close(tabId),
      'pdf.openWith': ({ tabId }) => this.pdf.openWith(tabId),
      'pdf.share': ({ tabId }) => this.pdf.share(tabId),
      'pdf.state': ({ tabId }) => this.pdf.report(tabId),
      'pdf.command': ({ tabId, command }) => this.pdf.command(tabId, command),
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
      'reader.setPreferences': (patch) => this.reader.setPreferences(patch),

      'readAloud.start': ({ tabId, from }) => this.readAloud.start({ tabId, from }),
      'readAloud.toggle': () => this.readAloud.toggle(),
      'readAloud.pause': () => this.readAloud.pause(),
      'readAloud.resume': () => this.readAloud.resume(),
      'readAloud.stop': () => this.readAloud.stop(),
      'readAloud.next': () => this.readAloud.next(),
      'readAloud.previous': () => this.readAloud.previous(),
      'readAloud.seek': ({ sentenceIndex }) => this.readAloud.seek({ sentenceIndex }),
      'readAloud.setRate': ({ rate }) => this.readAloud.setRate({ rate }),
      'readAloud.setVoice': ({ voiceId, lang }) => this.readAloud.setVoice({ voiceId, lang }),
      'readAloud.setHighlight': ({ mode }) => this.readAloud.setHighlight({ mode }),
      'readAloud.voices': () => this.readAloud.voicesResult(),

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
      'extension.installFromDrop': ({ paths }, win) => this.extensions.installFromDrop(paths, win),
      'extension.remove': ({ id }) => this.extensions.remove(id),
      'extension.setEnabled': ({ id, enabled }, win) =>
        this.extensions.setEnabled(id, enabled, win),
      'extension.setPinned': ({ id, pinned }) => this.extensions.setPinned(id, pinned),
      'extension.setToolbarPinned': ({ id, pinned }) =>
        this.extensions.setToolbarPinned(id, pinned),
      'extension.setAllowFileAccess': ({ id, allow }) =>
        this.extensions.setAllowFileAccess(id, allow),
      'extension.setNewTabOverride': ({ id, enabled }) =>
        this.extensions.setNewTabOverride(id, enabled),
      'extension.toggleSidePanel': ({ id }, win) => this.extensions.toggleSidePanel(id, win),
      'extension.closeSidePanel': (_a, win) => this.extensions.closeSidePanel(win),
      'extension.setAllowPrivate': ({ id, allowed }) =>
        this.extensions.setAllowPrivate(id, allowed),
      'extension.setAllowUserScripts': ({ id, allowed }) =>
        this.extensions.setAllowUserScripts(id, allowed),
      'extension.reload': ({ id }) => this.extensions.reload(id),
      'extension.clearErrors': ({ id }) => this.extensions.clearErrors(id),
      'extension.checkForUpdates': (_a, win) => this.extensions.checkForUpdates(win),
      'extension.update': ({ id }, win) => this.extensions.update(id, win),
      'extension.openOptions': ({ id }, win) => this.extensions.openOptions(id, win),
      'extension.openPopup': ({ id, anchor, bounds, radius }, win) =>
        this.extensions.openPopup(
          id,
          anchor,
          win,
          bounds ? { bounds, radius: radius ?? 12 } : undefined
        ),
      'extension.resizePopup': ({ bounds, visible }) =>
        this.extensions.resizePopup(bounds, visible),
      'extension.closePopup': () => this.extensions.closePopup(),
      'extension.actionContextMenu': ({ id, ...anchor }, win) =>
        this.menus.showExtensionActionMenu(id, win, anchor),
      'extension.actionMenuItems': ({ id }, win) => this.menus.extensionActionMenuItems(id, win),
      'extension.actionMenuClick': ({ id, itemId }) =>
        this.menus.runExtensionActionMenuItem(id, itemId),
      'extension.confirmInstall': ({ requestId, accept }) =>
        this.extensions.respondPrompt(requestId, accept),
      'extension.respondPermissionRequest': ({ requestId, accept }) =>
        this.extensions.respondPrompt(requestId, accept),

      'mod.add': ({ name, css, source }) => this.mods.add(name, css, source ?? null).id,
      'mod.update': ({ id, patch }) => this.mods.update(id, patch),
      'mod.remove': ({ id }) => this.mods.remove(id),
      'mod.importFile': (_a, win) => this.mods.importFile(win),
      'mod.importUrl': ({ url }, win) => this.mods.importUrl(url, win),

      'sync.chooseFolder': (_a, win) => this.sync.chooseFolder(win),
      'sync.setup': (opts, win) => this.sync.setup(opts, win),
      'sync.setScope': (patch) => this.sync.setScope(patch),
      'sync.setDeviceName': ({ name }) => this.sync.setDeviceName(name),
      'sync.setFolder': ({ folder }, win) => this.sync.setFolder(folder, win),
      'sync.now': () => this.sync.syncNow(),
      'sync.confirmMerge': ({ merge }) => this.sync.confirmMerge(merge),
      'sync.disconnect': ({ wipeRemote }) => this.sync.disconnect(wipeRemote),
      'sync.tabsFromDevices': () => this.sync.tabsFromDevices(),
      'sync.sendTab': (opts, win) => this.sync.sendTab(opts, win),

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
      'passwords.leakRespond': ({ id, action }, win) => this.passwords.leakRespond(id, action, win),
      'passwords.import': ({ conflict }, win) => this.passwords.import(conflict, win),
      'passwords.export': ({ passphrase }, win) => this.passwords.export(passphrase, win),
      'blocking.updateLists': ({ id }) => this.blocking.updateLists(id),
      'blocking.setEnabled': ({ enabled }) => this.blocking.setEnabled(enabled),
      'blocking.setSiteException': ({ site, excepted }) =>
        this.blocking.setSiteException(site, excepted),
      'protection.updateFeeds': ({ id }) => this.protection.safeBrowsing.refresh(id),
      'protection.forgetPlaintext': ({ host }) => this.protection.forgetPlaintext(host),
      'protection.checkApiKey': ({ key }) => this.protection.safeBrowsing.checkKey(key),
      'protection.checkResolver': ({ url }) => this.protection.checkResolver(url),
      'protection.openPrivateDnsSettings': (_a, win) => this.openPrivateDnsSettings(win),
      'performance.releaseBackgroundWork': () => this.background.release(),
      'translate.page': ({ tabId, target, source }) =>
        this.translate.translatePage(tabId, { target, source }),
      'translate.revert': ({ tabId }) => this.translate.revert(tabId),
      'translate.dismiss': ({ tabId }) => this.translate.dismiss(tabId),
      'translate.offer': ({ tabId }) => this.translate.offer(tabId),
      'translate.retarget': ({ tabId, source, target }) =>
        this.translate.retarget(tabId, { source, target }),
      'translate.menu': ({ tabId, x, y }, win) =>
        this.menus.showTranslateMenu(
          tabId,
          x !== undefined && y !== undefined ? { x, y } : undefined,
          win
        ),
      'translate.showSelection': ({ tabId, text, x, y }, win) =>
        this.translate.showSelection(
          tabId,
          text,
          x !== undefined && y !== undefined ? { x, y } : null,
          win
        ),
      'translate.selection': ({ tabId, text, target }) =>
        this.translate.translateSelection(tabId, { text, target }),
      'translate.reader': ({ tabId, target, source }) =>
        this.translate.translateReader(tabId, { target, source }),
      'translate.readerShowOriginal': ({ tabId, original }) =>
        this.translate.showReaderOriginal(tabId, original),
      'translate.setPreferences': (patch) => this.translate.setPreferences(patch),
      'translate.setLanguageRule': ({ language, rule }) =>
        this.translate.setLanguageRule(language, rule),
      'translate.setSiteRule': ({ tabId, never }) => this.translate.setSiteRule(tabId, never),
      'translate.downloadModel': ({ from, to }) => this.translate.downloadModel({ from, to }),
      'translate.removeModel': ({ from, to }) => this.translate.removeModel({ from, to }),
      'translate.models': () => this.translate.modelInfo(),
      'translate.engineResponse': (response) => this.translate.onRelayResponse(response),

      'spellcheck.setEnabled': ({ enabled }) => this.spellcheck.setEnabled(enabled),
      'spellcheck.setLanguage': ({ code, on }) => this.spellcheck.setLanguage(code, on),
      'spellcheck.words': () => this.spellcheck.words(),
      'spellcheck.addWord': ({ word }) => this.spellcheck.addWord(word),
      'spellcheck.removeWord': ({ word }) => this.spellcheck.removeWord(word),
      'spellcheck.openKeyboardSettings': () => this.spellcheck.openKeyboardSettings(),
      'webapp.openInstall': ({ tabId }, win) => this.webApps.openInstall(tabId, win),
      'webapp.pin': ({ tabId, title }, win) => this.webApps.pin(tabId, title, win),
      'webapp.cancelInstall': ({ tabId }) => this.webApps.cancelInstall(tabId),
      'webapp.dismissBanner': ({ tabId, reason }) => this.webApps.dismissBanner(tabId, reason),
      'webapp.launch': ({ appId }, win) => this.webApps.launch(appId, win),
      'webapp.uninstall': ({ appId }) => this.webApps.uninstall(appId),

      'onboarding.complete': ({ searchEngineId, colorScheme, essentials }, win) => {
        if (isPickableSearchEngine(state.searchEngines, searchEngineId))
          state.settings.searchEngineId = searchEngineId
        state.settings.colorScheme = colorScheme
        this.setThemeSource(colorScheme)
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
        this.openNewTab(win)
      },

      'defaultBrowser.request': ({ source }) => this.defaultBrowser.request(source),
      'defaultBrowser.dismiss': ({ prompt }) => this.defaultBrowser.dismiss(prompt),
      'defaultBrowser.refresh': () => this.defaultBrowser.refresh()
    }
  }

  updateSettings(patch: Partial<Settings>, win: ZenWindow): void {
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
      autofill: `${JSON.stringify(s.passwords)}${JSON.stringify(s.autofill)}`,
      spellcheck: JSON.stringify(s.spellcheck),
      reader: JSON.stringify(s.reader),
      readAloud: JSON.stringify(s.readAloud),
      fonts: JSON.stringify(s.fonts),
      languages: s.languages.join(',')
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
      } else if (key === 'searchEngines') {
        // The user's engines whole (a Settings row sends the edited list); the default is kept.
        const keep =
          typeof patch.searchEngineId === 'string' ? patch.searchEngineId : s.searchEngineId
        s.searchEngines = sanitizeSearchEngines(value, keep)
      } else if (key === 'privacy' && value && typeof value === 'object') {
        s.privacy = sanitizePrivacySettings({
          ...s.privacy,
          ...(value as Partial<Settings['privacy']>)
        })
      } else if (key === 'spellcheck' && value && typeof value === 'object') {
        s.spellcheck = sanitizeSpellcheck({
          ...s.spellcheck,
          ...(value as Partial<Settings['spellcheck']>)
        })
      } else if (key === 'reader' && value && typeof value === 'object') {
        s.reader = sanitizeReaderPreferences({
          ...s.reader,
          ...(value as Partial<Settings['reader']>)
        })
      } else if (key === 'fonts' && value && typeof value === 'object') {
        // A one-row patch (`size: 20`) keeps the other fonts; every value is brought in range.
        s.fonts = sanitizeFontSettings({ ...s.fonts, ...(value as Partial<Settings['fonts']>) })
      } else if (key === 'languages') {
        // The list whole, canonical and deduplicated; nothing valid leaves the current one
        // standing (Chrome keeps the last language from being removed).
        s.languages = sanitizeLanguages(value, s.languages)
      } else if (key === 'newTab' && value && typeof value === 'object') {
        // A one-section patch (`modules: { greeting: true }`) must not drop the other sections.
        const incoming = value as Partial<Settings['newTab']>
        s.newTab = sanitizeNewTabSettings({
          ...s.newTab,
          ...incoming,
          modules: { ...s.newTab.modules, ...incoming.modules }
        })
      } else if (key === 'downloads' && value && typeof value === 'object') {
        // The block is partial: a one-key patch from a Settings row must not drop the others.
        // `askWhereToSave` keeps living at the top level (the resolver reads it from there).
        const incoming = value as Partial<DownloadSettings>
        const { askWhereToSave, ...rest } = incoming
        s.downloads = { ...s.downloads, ...rest }
        if (typeof askWhereToSave === 'boolean') s.askWhereToSave = askWhereToSave
      } else {
        ;(s as unknown as Record<string, unknown>)[key] = value
      }
    }
    s.sidebarWidth = Math.max(160, Math.min(520, s.sidebarWidth))
    s.splitEdgeZones = s.splitEdgeZones !== false
    s.unloadTimeoutMinutes = sanitizeUnloadTimeout(s.unloadTimeoutMinutes)
    s.essentialsMax = Math.max(1, Math.min(24, Math.round(s.essentialsMax)))
    // A default the profile no longer has an engine for (removed, or named by a peer's build that
    // knows more engines), or an extension's engine (the default only through the extension's
    // `is_default`, as in Chrome), falls back to the shipped default; suggestions keep working.
    if (!isPickableSearchEngine(this.state.searchEngines, s.searchEngineId))
      s.searchEngineId = DEFAULT_SETTINGS.searchEngineId
    if (
      before.glance !== s.glanceEnabled ||
      before.trigger !== s.glanceTrigger ||
      before.thirdParty !== s.thirdPartyOnPinned
    ) {
      this.tabs.broadcastPageFlags()
    }
    if (before.colorScheme !== s.colorScheme) this.setThemeSource(s.colorScheme)
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
    if (before.spellcheck !== JSON.stringify(s.spellcheck)) this.spellcheck.onSettingsChanged()
    if (before.reader !== JSON.stringify(s.reader)) this.reader.onPreferencesChanged()
    if (before.readAloud !== JSON.stringify(s.readAloud)) this.readAloud.onSettingsChanged()
    if (before.fonts !== JSON.stringify(s.fonts)) this.pageFonts.onSettingsChanged()
    if (before.languages !== s.languages.join(',')) this.languages.onSettingsChanged()
    this.state.commit()
  }

  /**
   * Hand the appearance to the host's engine (CT-23): `nativeTheme.themeSource` on the desktop,
   * the app's night mode on Android, so every page's `prefers-color-scheme` follows Zenium's
   * Light / Dark / System. Once per value: the boot, a Settings row and a sync merge all come
   * through here, and the chrome keeps deriving its own theme from the setting (`systemDark`
   * is read for `system` alone), so the engine's answer never feeds back into the choice.
   *
   * The engine's reading (`shouldUseDarkColors`) follows the source it was given – under
   * `dark` it says dark whatever the OS does – so it is re-read here, in the same turn, and
   * the chrome coming back to `system` reads the OS at once rather than the engine's last word
   * (the `updated` event, which would correct it, arrives a turn later).
   */
  private setThemeSource(scheme: ColorScheme): void {
    if (!this.platform.theme || this.themeSource === scheme) return
    this.themeSource = scheme
    this.platform.theme.setSource(scheme)
    this.state.systemDark = this.platform.theme.systemDark()
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

/**
 * The sleeping-tabs timeout in minutes, half a minute to a day in half-minute steps: Edge's
 * ladder starts at 30 seconds, so a half is the smallest value that is stored.
 */
function sanitizeUnloadTimeout(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_SETTINGS.unloadTimeoutMinutes
  return Math.max(0.5, Math.min(24 * 60, Math.round(minutes * 2) / 2))
}
