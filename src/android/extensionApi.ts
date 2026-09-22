import type { BookmarkTreeNode } from '@shared/bookmarks'
import type { ExtensionAction, Tab } from '@shared/types'
import type { Browser } from '@core/browser'
import type { MenuItemTemplate, PageContextParams } from '@core/platform'
import type { ZenWindow } from '@core/window'
import {
  CAPTURE_QUOTA_ERROR,
  CaptureQuota,
  captureDenial,
  coversAllUrls,
  normalizeCaptureOptions
} from '@core/extensions/api/capture'
import { NATIVE_HOST_NOT_FOUND, type EngineContextKind } from '@core/extensions/api/engine'
import type { PersistedMenuItem } from '@core/extensions/api/contextMenus'
import { parseCssColor, type CssRgba } from '@core/extensions/api/cssColor'
import type { ScopedValues } from '@core/extensions/api/privacy'
import type { ProxyConfig } from '@core/extensions/api/proxy'
import type { LocaleMessages } from '@core/extensions/api/i18n'
import { globToRegExp, matchesAnyPattern } from '@core/extensions/api/matchPattern'
import {
  addPermissionSets,
  type ManifestPermissionSets,
  missingPermissions,
  normalizePermissionSet,
  type PermissionSet,
  permissionSetContains,
  requestablePermissions
} from '@core/extensions/api/permissions'
import {
  SYSTEM_DISPLAY_NO_PERMISSION_ERROR,
  SYSTEM_DISPLAY_PERMISSION
} from '@core/extensions/api/systemDisplay'
import {
  answerSystemStorage,
  SYSTEM_STORAGE_NO_PERMISSION_ERROR,
  SYSTEM_STORAGE_PERMISSION
} from '@core/extensions/api/systemStorage'
import { FILE_URL_WITHOUT_ACCESS_ERROR, isFileNavigation } from '@core/extensions/api/tabs'
import { normalizeInjection, type UserScriptInjection } from '@core/extensions/api/userScripts'
import type { ExtensionRecord } from '@core/extensions/registry'
import {
  chromeExtensionOrigin,
  presentExtensionUrl,
  toServedUrl
} from '@core/extensions/runtime/extensionUrls'
import type { RunAt, RuntimeManifest, ScriptWorld } from '@core/extensions/runtime/manifest'
import {
  extensionOrigin,
  extensionUrl,
  type RegisteredContentScript
} from '@core/extensions/runtime/plan'
import type { Endpoint, MessageRouter } from '@core/extensions/runtime/router'
import { ActiveTabGrants } from './extensionActiveTab'
import { AndroidContextMenus } from './extensionContextMenus'
import { AndroidCookies, type JarReading } from './extensionCookies'
import type { AndroidDeclarativeNetRequest } from './extensionDnr'
import type { RequestUpdateCheckAnswer } from './extensionHost'
import type { PersistedGrants } from './extensionRuntime'
import type { AndroidIdentity } from './extensionIdentity'
import { AndroidNotifications, type ShownNotification } from './extensionNotifications'
import { AndroidProxy } from './extensionProxy'
import { AndroidSidePanel } from './extensionSidePanel'
import { answerSystemDisplay, type PhoneScreen } from './extensionSystemDisplay'
import { AndroidTts } from './extensionTts'

/**
 * The `chrome.*` calls the Android runtime answers itself, over the browser core: everything the
 * emulated engine forwards with `call` that is not storage, alarms or messaging (those live in
 * `extensionRuntime.ts`, next to their persistence and their wake policy). One class, one method
 * per namespace, reached through the `ApiHost` seam so it can be driven in tests without Kotlin.
 *
 * Wave 2-1 carries the prototype's coverage: tabs, windows, action, scripting, userScripts,
 * runtime, notifications, contextMenus, webNavigation, cookies, history, bookmarks, permissions,
 * management, commands, idle, offscreen, downloads. W2-2 maps tabs, windows, action, popups,
 * webNavigation, contextMenus, cookies and notifications onto the shared core properly; W2-3
 * routes declarativeNetRequest to `extensionDnr.ts` (the shared translator over the Kotlin
 * blocking engine); compat round 6 adds tts over the device's speech engine (`extensionTts.ts`).
 */

/** An extension the runtime is running: its record, parsed manifest and the locale it uses. */
export interface AttachedExtension {
  record: ExtensionRecord
  manifest: RuntimeManifest
  messages: LocaleMessages | null
}

/** `scripting.executeScript` / `insertCSS` / `tabs.executeScript`, as the host evaluates them. */
export interface ExecRequest {
  extensionId: string
  tabId: string
  /** Chrome's frame id in the tab: 0 for the main frame, else a subframe the extension has scripts in. */
  frameId: number
  kind: 'js' | 'css'
  payload: Record<string, unknown>
  code: string | null
  /**
   * The extension's own script files (extension-relative paths, in order): the host reads them
   * into the script itself, so their text never crosses the bridge (Loom's `content.js` is 13 MB).
   */
  files: string[] | null
  funcSource: string | null
  args: unknown[] | null
}

export interface ApiHost {
  readonly browser: Browser
  readonly router: MessageRouter
  /** `chrome.identity`: the web-auth flows (`extensionIdentity.ts`). */
  readonly identity: AndroidIdentity
  /** `chrome.declarativeNetRequest`: the rule states over the blocking engine (`extensionDnr.ts`). */
  readonly dnr: AndroidDeclarativeNetRequest
  /** The runtime's clock (tests drive it). */
  now(): number
  window(): ZenWindow
  attached(id: string): AttachedExtension | undefined
  allAttached(): AttachedExtension[]
  /** `scripting.registerContentScripts` state; setting it re-plans the extension's units. */
  registered(id: string): RegisteredContentScript[]
  setRegistered(id: string, scripts: RegisteredContentScript[]): Promise<void>
  /** `userScripts.configureWorld`: whether the user-script world gets `runtime.sendMessage`. */
  userScriptMessaging(id: string): boolean
  setUserScriptMessaging(id: string, messaging: boolean): Promise<void>
  /** Raise `chrome.<ns>.<name>` in every endpoint of one extension that listens for it (`only`: in those of them it names). */
  emit(
    extensionId: string,
    ns: string,
    name: string,
    args: unknown[],
    only?: (endpoint: Endpoint) => boolean
  ): void
  /** Deliver `chrome.<ns>.<name>` to one endpoint, listener or not (a `contextMenus` `onclick` holder). */
  emitTo(endpointId: string, ns: string, name: string, args: unknown[]): void
  /** `chrome.contextMenus` items of a lazy-background extension, kept across worker starts and sessions (Chrome's `MenuManager` storage). */
  contextMenuItems(id: string): unknown
  setContextMenuItems(id: string, items: PersistedMenuItem[]): void
  /** The extension's toolbar icon as a `data:` URL, when the store has read it. */
  icon(id: string): string | null
  readFile(id: string, path: string): Promise<string | null>
  /**
   * `i18n.detectLanguage`: the platform's guess at the text's language, in Chrome's shape
   * (`languages` by share of the text; `isReliable` when the guess is a confident one).
   */
  detectTextLanguage(text: string): Promise<DetectedLanguage>
  /** `system.display.getInfo`: the phone's screen as the chrome page sees it (`extensionSystemDisplay.ts`). */
  screen(): PhoneScreen
  /** Hear of the screen turning (its orientation changing); `system.display.onDisplayChanged` follows. */
  onScreenChange(listener: () => void): void
  exec(request: ExecRequest): Promise<unknown>
  /** The cookies a request to `url` from the container's jar would carry (`chrome.cookies`). */
  readCookies(containerId: string, url: string): Promise<JarReading>
  /** Store a `Set-Cookie` line against `url` in the container's jar; false when it was refused. */
  writeCookie(containerId: string, url: string, setCookie: string): Promise<boolean>
  /** The optional host permissions an extension holds right now (`permissions.request` / `remove`); Kotlin's CORS proxy reads them. */
  hostsGranted(id: string, hosts: string[]): void
  /** The optional permissions (API and host) the extension was granted in this or an earlier session. */
  grants(id: string): PersistedGrants | null
  /**
   * The optional grants moved: `grants` is what the extension holds beyond its required
   * permissions, `granted` its whole API permission set (required and granted optional), for
   * the contexts' shims (`__zen.grants`) and the boot of the next context.
   */
  setGrants(id: string, grants: PersistedGrants, granted: string[]): void
  /**
   * `tabs.captureVisibleTab`: the tab's on-screen pixels as a `data:` URL, or null when the view
   * cannot be captured (hidden, not painted yet).
   */
  captureTab(tabId: string, format: 'jpeg' | 'png', quality: number): Promise<string | null>
  /** `chrome.notifications`: show (or replace in place) one system notification of an extension. */
  showNotification(extensionId: string, notification: ShownNotification): void
  /** Take one down without an event. */
  hideNotification(extensionId: string, notificationId: string): void
  /** The extension's notifications and its channel go. */
  forgetNotifications(extensionId: string): void
  /** Whether the app may post notifications right now (`getPermissionLevel`). */
  notificationsAllowed(): Promise<boolean>
  /** The toolbar tap, or `action.openPopup()` from the API (`fromApi`: the popup even where the tap would open the side panel). */
  openPopup(id: string, fromApi?: boolean): void
  openOptions(id: string): void
  /** `chrome.sidePanel`: the panel document in the runtime's sheet (`extensionSidePanel.ts`). */
  showSidePanel(ext: AttachedExtension, url: string): void
  hideSidePanel(): void
  /** `sidePanel.setPanelBehavior({ openPanelOnActionClick })`, kept across sessions. */
  sidePanelOnActionClick(id: string): boolean
  setSidePanelOnActionClick(id: string, on: boolean): void
  /** `chrome.proxy.settings`: an extension's values by scope, kept across sessions (`extensionProxy.ts`). */
  proxyValues(id: string): unknown
  setProxyValues(id: string, values: ScopedValues): void
  /** Apply the resolved configuration to the process's WebViews through `ProxyController` (`system` clears it). */
  applyProxy(config: ProxyConfig): Promise<void>
  /** Whether a private tab is open (Chrome's `incognito_session_only` scope needs one). */
  privateTabOpen(): boolean
  /**
   * `chrome.offscreen`: the extension's one hidden document. `openOffscreen` resolves once the
   * page said hello (Chrome's `createDocument` resolves when the document is created), or
   * rejects when it never does.
   */
  openOffscreen(id: string, url: string): Promise<void>
  closeOffscreen(id: string): void
  hasOffscreen(id: string): boolean
  /**
   * The served URL of an offscreen document whose `createDocument` began and whose page has not
   * said hello yet, or null. Chrome's document exists from the call on, so `runtime.getContexts`
   * lists it before it has loaded (OneNote Web Clipper asks between the two and, told there was
   * none, called `createDocument` again into "Only a single offscreen document may be created").
   */
  offscreenLoading(id: string): string | null
  /** `runtime.reload()` and `management.uninstallSelf()`: the store re-reads or removes the extension. */
  reload(id: string): Promise<void>
  uninstall(id: string): Promise<void>
  /** `runtime.requestUpdateCheck()`: the store's update check for this one extension, Chrome's answer. */
  requestUpdateCheck(id: string): Promise<RequestUpdateCheckAnswer>
  isEnabled(id: string): boolean
}

/**
 * `chrome.action` values; the global ones fall back to the manifest, a tab's to the global ones.
 * An empty string is a value the extension set (no popup, no badge, the name as title); only an
 * omitted value resets to the level below (the desktop's `ActionApi` semantics).
 */
export interface ActionState {
  /** Empty: the toolbar shows the extension's name. */
  title: string
  /** Extension-relative popup path; empty for "no popup" (`onClicked` fires instead). */
  popup: string
  badgeText: string
  badgeBackgroundColor: string
  badgeTextColor: string
  enabled: boolean
}

/** One extension's action: the manifest's values, the global state and the per-tab overrides (`details.tabId`). */
interface ActionRecord {
  defaults: ActionState
  global: ActionState
  perTab: Map<number, Partial<ActionState>>
}

const DEFAULT_BADGE_BACKGROUND = '#5f6368'
const DEFAULT_BADGE_TEXT_COLOR = '#ffffff'

const NOT_IMPLEMENTED = 'is not implemented on Zenium for Android'

/** `tabs.detectLanguage`: the page's declared language, read in the extension's world. */
const DECLARED_LANGUAGE_JS =
  "(function(){var h=document.documentElement;return (h&&h.getAttribute('lang'))||(document.body&&document.body.getAttribute('lang'))||''})()"

/**
 * A BCP 47 tag (`en-US`, `pt_BR`, ` DE `) as the bare lower-case language Chrome's
 * `detectLanguage` answers with; `und` for nothing, or for a value that is no tag.
 */
export function languageCodeOf(declared: unknown): string {
  if (typeof declared !== 'string') return 'und'
  const primary = declared.trim().split(/[-_]/)[0] ?? ''
  return /^[a-zA-Z]{2,3}$/.test(primary) ? primary.toLowerCase() : 'und'
}

/** `i18n.detectLanguage`'s answer, Chrome's shape. */
export interface DetectedLanguage {
  isReliable: boolean
  languages: { language: string; percentage: number }[]
}

/** The leading part of a text the host's classifier reads (`i18n.detectLanguage`). */
export const LANGUAGE_SAMPLE_CHARS = 4096

/**
 * The host's `ext.i18n.detectLanguage` answer as a `DetectedLanguage`: only well-formed entries
 * count, and a guess with no language is not a reliable one.
 */
export function asDetectedLanguage(value: unknown): DetectedLanguage {
  const record = asRecord(value)
  const languages: DetectedLanguage['languages'] = []
  for (const entry of Array.isArray(record.languages) ? record.languages : []) {
    const item = asRecord(entry)
    const percentage = asNumber(item.percentage)
    if (typeof item.language === 'string' && item.language && percentage !== null)
      languages.push({ language: item.language, percentage })
  }
  return { isReliable: record.isReliable === true && languages.length > 0, languages }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * Chrome's integer tab ids over the core's string ids, stable for the session, plus the
 * `tabs.Tab` and `windows.Window` objects extensions see (one window on a phone).
 */
export class TabIds {
  private readonly chromeIds = new Map<string, number>()
  private readonly coreIds = new Map<number, string>()
  private next = 1

  constructor(
    private readonly browser: Browser,
    private readonly windowOf: () => ZenWindow
  ) {}

  chromeIdFor(tabId: string): number {
    let id = this.chromeIds.get(tabId)
    if (id === undefined) {
      id = this.next++
      this.chromeIds.set(tabId, id)
      this.coreIds.set(id, tabId)
    }
    return id
  }

  coreIdFor(chromeTabId: number): string | null {
    return this.coreIds.get(chromeTabId) ?? null
  }

  /** The id the next `tabs.create` will get (what `downloads.download` returns as a stand-in). */
  peekNext(): number {
    return this.next
  }

  /**
   * The URL a tab's address reads as to extensions. The PDF viewer's tab (`zen://pdf?id=…`)
   * reads as the document it shows – the URL its document runs under (`pdfViewerBaseUrl`), as
   * Chrome's PDF tab reads to `tabs`, `webNavigation`, host permissions and content-script
   * matching; any other address is its own.
   */
  urlFor(url: string): string {
    return this.browser.pdf.documentUrl(url) ?? url
  }

  /** The URL `tab` reads as to extensions (`urlFor` of its address). */
  urlOf(tab: Pick<Tab, 'url'>): string {
    return this.urlFor(tab.url)
  }

  chromeTab(tab: Tab): Record<string, unknown> {
    const win = this.windowOf()
    const active = this.browser.tabs.activeTabFor(win)?.id === tab.id
    const space = tab.spaceId
      ? this.browser.tabs.model.spaces.find((s) => s.id === tab.spaceId)
      : undefined
    const index = space ? space.tabIds.indexOf(tab.id) : 0
    const size = win.host.contentSize()
    return {
      id: this.chromeIdFor(tab.id),
      index: index < 0 ? 0 : index,
      windowId: 1,
      groupId: -1,
      openerTabId: undefined,
      active,
      highlighted: active,
      selected: active,
      pinned: tab.pinned || tab.essential,
      audible: tab.audible,
      discarded: tab.discarded,
      autoDiscardable: true,
      frozen: tab.frozen,
      mutedInfo: { muted: tab.muted },
      url: this.urlOf(tab),
      pendingUrl: tab.loading ? this.urlOf(tab) : undefined,
      title: tab.customTitle ?? tab.title,
      favIconUrl: tab.favicon ?? undefined,
      status: tab.loading ? 'loading' : tab.discarded ? 'unloaded' : 'complete',
      incognito: this.browser.tabs.isPrivate(tab),
      width: size.width,
      height: size.height,
      lastAccessed: tab.lastActiveAt
    }
  }

  tabByChromeId(value: unknown): Tab {
    const id = asNumber(value)
    if (id === null) throw new Error('A tab id is required.')
    const coreId = this.coreIds.get(id)
    const tab = coreId ? this.browser.tabs.tab(coreId) : undefined
    if (!tab) throw new Error(`No tab with id: ${id}.`)
    return tab
  }

  /**
   * Chrome keeps incognito tabs from an extension the user did not allow in incognito: they are
   * absent from `tabs.query`, unknown to `tabs.get`, silent in every tab event.
   */
  visibleTo(ext: AttachedExtension, tab: Tab): boolean {
    return ext.record.allowPrivate === true || !this.browser.tabs.isPrivate(tab)
  }

  /** The tabs `ext` may see, in the model's order. */
  visibleTabs(ext: AttachedExtension): Tab[] {
    return Object.values(this.browser.tabs.model.tabs).filter((tab) => this.visibleTo(ext, tab))
  }

  /** `tabByChromeId` as `ext` sees it: a private tab it may not see is "no tab with id". */
  tabFor(ext: AttachedExtension, value: unknown): Tab {
    const tab = this.tabByChromeId(value)
    if (!this.visibleTo(ext, tab)) throw new Error(`No tab with id: ${asNumber(value)}.`)
    return tab
  }

  /** The active tab, unless `ext` may not see it. */
  activeTabFor(ext: AttachedExtension): Tab | undefined {
    const tab = this.browser.tabs.activeTabFor(this.windowOf())
    return tab && this.visibleTo(ext, tab) ? tab : undefined
  }

  chromeWindow(ext: AttachedExtension): Record<string, unknown> {
    const win = this.windowOf()
    const size = win.host.contentSize()
    return {
      id: 1,
      focused: win.host.isFocused(),
      top: 0,
      left: 0,
      width: size.width,
      height: size.height,
      incognito: win.isPrivate,
      type: 'normal',
      state: win.host.isFullScreen() ? 'fullscreen' : 'maximized',
      alwaysOnTop: false,
      tabs: this.visibleTabs(ext).map((t) => this.chromeTab(t))
    }
  }

  /**
   * `tabs.move`: `tab` to Chrome's `index` in its window (`-1`: the end), in one step – the tab
   * leaves its slot and takes `index` in the shorter list, as Chrome's tab strip moves. Chrome
   * constrains the position to the tab's block: a pinned tab stays among the pinned ones at the
   * front, a regular one behind them. The window's order is the tab's space's here (what
   * `chromeTab` reports as `index`); an Essential (no space, `index` 0 to extensions) is
   * reordered among the Essentials. Answers the positions `tabs.onMoved` reports.
   */
  move(tab: Tab, index: number): { fromIndex: number; toIndex: number } {
    const tabs = this.browser.tabs
    const win = this.windowOf()
    if (tab.essential) {
      const list = tabs.model.essentialTabIds
      const fromIndex = Math.max(0, list.indexOf(tab.id))
      tabs.moveTab(tab.id, { section: 'essential', index: index < 0 ? list.length : index }, win)
      return { fromIndex, toIndex: Math.max(0, tabs.model.essentialTabIds.indexOf(tab.id)) }
    }
    const space = tabs.model.spaces.find((s) => s.id === tab.spaceId)
    if (!space) return { fromIndex: 0, toIndex: 0 }
    const fromIndex = Math.max(0, space.tabIds.indexOf(tab.id))
    // The model takes a pinned tab's index as its place in the list and a regular one's as its
    // place behind the pinned block, each clamped to the block (Chrome's constraint).
    const firstRegular = space.tabIds.findIndex((id) => !tabs.model.tabs[id]?.pinned)
    const boundary = firstRegular === -1 ? space.tabIds.length : firstRegular
    const wanted = index < 0 ? space.tabIds.length : index
    tabs.moveTab(
      tab.id,
      {
        section: tab.pinned ? 'pinned' : 'regular',
        index: tab.pinned ? wanted : Math.max(0, wanted - boundary)
      },
      win
    )
    return { fromIndex, toIndex: Math.max(0, space.tabIds.indexOf(tab.id)) }
  }
}

export class ExtensionApi {
  readonly tabs: TabIds
  readonly contextMenus: AndroidContextMenus
  readonly sidePanel: AndroidSidePanel
  /** `chrome.proxy.settings` over the WebView's proxy override (`extensionProxy.ts`). */
  readonly proxy: AndroidProxy
  readonly activeTab: ActiveTabGrants
  readonly cookies: AndroidCookies
  readonly notifications: AndroidNotifications
  /** `chrome.tts` over the device's speech engine, read aloud's (`extensionTts.ts`). */
  readonly tts: AndroidTts
  private readonly actions = new Map<string, ActionRecord>()
  /** Optional host permissions granted, per extension: this session's and the stored ones (`ExtensionApiHost.grants`). */
  private readonly grantedHosts = new Map<string, Set<string>>()
  /** Optional API permissions granted, per extension, the same way; their namespaces exist in the contexts while they are here. */
  private readonly grantedApis = new Map<string, Set<string>>()
  /** Chrome's two `captureVisibleTab` calls per second, per extension. */
  private readonly captureQuota = new CaptureQuota()

  constructor(private readonly host: ApiHost) {
    this.tabs = new TabIds(host.browser, () => host.window())
    this.activeTab = new ActiveTabGrants(
      (id) => host.attached(id)?.manifest.permissions.includes('activeTab') === true
    )
    this.contextMenus = new AndroidContextMenus({
      attached: (id) => host.attached(id),
      allAttached: () => host.allAttached(),
      emit: (id, ns, name, args) => host.emit(id, ns, name, args),
      emitTo: (ep, ns, name, args) => host.emitTo(ep, ns, name, args),
      hasEndpoint: (ep) => host.router.endpoint(ep) !== undefined,
      chromeTab: (tab) => this.tabs.chromeTab(tab),
      visibleTo: (ext, tab) => this.tabs.visibleTo(ext, tab),
      icon: (id) => host.icon(id),
      grantActiveTab: (id, tab) => this.activeTab.grant(id, tab, this.tabs.urlOf(tab)),
      persistedItems: (id) => host.contextMenuItems(id),
      persistItems: (id, items) => host.setContextMenuItems(id, items)
    })
    this.sidePanel = new AndroidSidePanel({
      attached: (id) => host.attached(id),
      tabFor: (ext, value) => this.tabs.tabFor(ext, value),
      chromeIdFor: (tabId) => this.tabs.chromeIdFor(tabId),
      activeTabFor: (ext) => this.tabs.activeTabFor(ext),
      activateTab: (tabId) => host.browser.tabs.activateTab(tabId, host.window()),
      showSheet: (ext, url) => host.showSidePanel(ext, url),
      hideSheet: () => host.hideSidePanel(),
      emit: (id, ns, name, args) => host.emit(id, ns, name, args),
      behavior: (id) => host.sidePanelOnActionClick(id),
      setBehavior: (id, on) => host.setSidePanelOnActionClick(id, on)
    })
    this.proxy = new AndroidProxy({
      attached: (id) => host.attached(id),
      allAttached: () => host.allAttached(),
      allowedInPrivate: (id) => host.attached(id)?.record.allowPrivate === true,
      privateTabOpen: () => host.privateTabOpen(),
      persistedValues: (id) => host.proxyValues(id),
      persistValues: (id, values) => host.setProxyValues(id, values),
      apply: (config) => host.applyProxy(config),
      emit: (id, ns, name, args) => host.emit(id, ns, name, args),
      warn: (message) => console.warn(`[zen] ${message}`)
    })
    this.cookies = new AndroidCookies({
      read: (containerId, url) => host.readCookies(containerId, url),
      write: (containerId, url, setCookie) => host.writeCookie(containerId, url, setCookie),
      hostAccess: (ext, url) => this.hostAccess(ext, url),
      hostPatterns: (ext) => this.hostPatterns(ext),
      allAttached: () => host.allAttached(),
      visibleTabs: (ext) => this.tabs.visibleTabs(ext),
      chromeTabId: (tabId) => this.tabs.chromeIdFor(tabId),
      emit: (id, ns, name, args) => host.emit(id, ns, name, args)
    })
    this.notifications = new AndroidNotifications({
      show: (id, notification) => host.showNotification(id, notification),
      hide: (id, notificationId) => host.hideNotification(id, notificationId),
      forget: (id) => host.forgetNotifications(id),
      allowed: () => host.notificationsAllowed(),
      emit: (id, ns, name, args) => host.emit(id, ns, name, args)
    })
    this.tts = new AndroidTts({
      speech: () => host.browser.platform.speech,
      hasPermission: (id) => host.attached(id)?.manifest.permissions.includes('tts') === true,
      endpointAlive: (endpointId) => host.router.endpoint(endpointId) !== undefined,
      emit: (id, endpointId, args, web) =>
        host.emit(
          id,
          web ? 'speechSynthesis' : 'tts',
          'onEvent',
          args,
          (endpoint) => endpoint.id === endpointId
        ),
      voicesChanged: () => {
        for (const ext of host.allAttached()) {
          if (ext.manifest.permissions.includes('tts'))
            host.emit(ext.record.id, 'tts', 'onVoicesChanged', [])
          host.emit(ext.record.id, 'speechSynthesis', 'onVoicesChanged', [])
        }
      },
      readAloudPlaying: () => host.browser.readAloud.uiState()?.status === 'playing',
      pauseReadAloud: () => host.browser.readAloud.pause()
    })
    // The screen turning is Chrome's `onDisplayChanged`, to the extensions that may hear of it.
    host.onScreenChange(() => {
      for (const ext of host.allAttached())
        if (this.holdsPermission(ext, SYSTEM_DISPLAY_PERMISSION))
          host.emit(ext.record.id, 'system.display', 'onDisplayChanged', [])
    })
  }

  /** Whether the extension declared the permission, as required or as an optional one (granted without a prompt here). */
  private holdsPermission(ext: AttachedExtension, permission: string): boolean {
    return (
      ext.manifest.permissions.includes(permission) ||
      ext.manifest.optionalPermissions.includes(permission)
    )
  }

  /** The extension attached: what this layer restores before its background runs. */
  load(ext: AttachedExtension): void {
    this.contextMenus.load(ext)
    this.sidePanel.load(ext)
    this.proxy.load(ext)
    this.loadGrants(ext)
  }

  /**
   * The optional permissions granted in an earlier session come back (Chrome keeps the granted
   * set in its prefs), less what the manifest no longer offers (an update dropped it); Kotlin's
   * CORS proxy hears the host patterns again.
   */
  private loadGrants(ext: AttachedExtension): void {
    const id = ext.record.id
    const stored = this.host.grants(id)
    const apis = new Set(
      (stored?.permissions ?? []).filter((p) => ext.manifest.optionalPermissions.includes(p))
    )
    const hosts = new Set(
      (stored?.origins ?? []).filter(
        (o) =>
          ext.manifest.optionalHostPermissions.includes(o) ||
          ext.manifest.hostPermissions.includes(o)
      )
    )
    if (apis.size > 0) this.grantedApis.set(id, apis)
    else this.grantedApis.delete(id)
    if (hosts.size > 0) {
      this.grantedHosts.set(id, hosts)
      this.host.hostsGranted(id, [...hosts])
    } else this.grantedHosts.delete(id)
  }

  /** The API permissions the extension holds: the manifest's required ones and the optional ones granted. */
  grantedPermissions(ext: AttachedExtension): string[] {
    const optional = this.grantedApis.get(ext.record.id)
    return optional && optional.size > 0
      ? [...ext.manifest.permissions, ...optional]
      : ext.manifest.permissions
  }

  /** The extension is going away: drop what this layer remembers about it. */
  forget(id: string): void {
    this.actions.delete(id)
    this.contextMenus.forget(id)
    this.sidePanel.forget(id)
    this.proxy.unload(id)
    this.activeTab.forget(id)
    this.grantedHosts.delete(id)
    this.grantedApis.delete(id)
    this.captureQuota.forget(id)
    this.notifications.forget(id)
    this.tts.forget(id)
  }

  /** The host patterns the extension may fetch across origins: its `host_permissions` plus what it was granted. */
  hostPatterns(ext: AttachedExtension): string[] {
    const granted = this.grantedHosts.get(ext.record.id)
    return granted ? [...ext.manifest.hostPermissions, ...granted] : ext.manifest.hostPermissions
  }

  /** Whether the extension may act on `url`: a host permission covering it, or an `activeTab` grant on its tab. */
  hostAccess(ext: AttachedExtension, url: string): boolean {
    return (
      matchesAnyPattern(url, this.hostPatterns(ext)) || this.activeTab.allowsUrl(ext.record.id, url)
    )
  }

  /** An endpoint reported gone: `onclick` handlers it held go with it. */
  endpointGone(endpointId: string): void {
    this.contextMenus.endpointGone(endpointId)
  }

  /** The extension section of a tab's long-press menu. */
  pageContextMenuItems(tab: Tab, params: PageContextParams): MenuItemTemplate[] {
    return this.contextMenus.pageMenuItems(tab, params)
  }

  /** The items an extension adds to its toolbar button's menu. */
  actionContextMenuItems(id: string): MenuItemTemplate[] {
    const ext = this.host.attached(id)
    return this.contextMenus.actionMenuItems(id, ext ? this.tabs.activeTabFor(ext) : undefined)
  }

  /** The extension's global `chrome.action` state (what a call without `tabId` reads and writes). */
  actionFor(id: string): ActionState {
    return this.actionRecord(id).global
  }

  private actionRecord(id: string): ActionRecord {
    let record = this.actions.get(id)
    if (!record) {
      const action = this.host.attached(id)?.manifest.action
      const defaults: ActionState = {
        title: action?.title ?? '',
        popup: (action?.popup ?? '').replace(/^\/+/, ''),
        badgeText: '',
        badgeBackgroundColor: DEFAULT_BADGE_BACKGROUND,
        badgeTextColor: DEFAULT_BADGE_TEXT_COLOR,
        enabled: true
      }
      record = { defaults, global: { ...defaults }, perTab: new Map() }
      this.actions.set(id, record)
    }
    return record
  }

  /** The state a tab sees: its own overrides over the global values (Chrome's `details.tabId`). */
  actionStateFor(id: string, chromeTabId: number | undefined): ActionState {
    const record = this.actionRecord(id)
    const tab = chromeTabId === undefined ? undefined : record.perTab.get(chromeTabId)
    return tab ? { ...record.global, ...tab } : record.global
  }

  private writeAction<K extends keyof ActionState>(
    id: string,
    chromeTabId: number | undefined,
    key: K,
    value: ActionState[K] | null
  ): void {
    const record = this.actionRecord(id)
    if (chromeTabId === undefined) {
      // A cleared global value falls back to the manifest's.
      record.global[key] = value === null ? record.defaults[key] : value
    } else {
      const tab = record.perTab.get(chromeTabId) ?? {}
      if (value === null) delete tab[key]
      else tab[key] = value
      if (Object.keys(tab).length === 0) record.perTab.delete(chromeTabId)
      else record.perTab.set(chromeTabId, tab)
    }
    this.host.browser.state.commitVolatile()
  }

  /**
   * The declarativeNetRequest action count of a tab (`displayActionCountAsBadgeText`): the badge
   * of that tab shows it; an empty text clears the override and the global badge shows again.
   */
  setBadgeTextFor(id: string, chromeTabId: number, text: string): void {
    if (!this.host.attached(id)) return
    this.writeAction(id, chromeTabId, 'badgeText', text || null)
  }

  /** What the toolbar should show for an extension right now: its state for the active tab. */
  toolbarAction(id: string): ExtensionAction | null {
    const ext = this.host.attached(id)
    if (!ext) return null
    const active = this.host.browser.tabs.activeTabFor(this.host.window())
    const state = this.actionStateFor(id, active ? this.tabs.chromeIdFor(active.id) : undefined)
    return {
      badgeText: state.badgeText,
      badgeBackgroundColor:
        state.badgeBackgroundColor === DEFAULT_BADGE_BACKGROUND ? null : state.badgeBackgroundColor,
      badgeTextColor:
        state.badgeTextColor === DEFAULT_BADGE_TEXT_COLOR ? null : state.badgeTextColor,
      title: state.title || ext.manifest.name,
      icon: null,
      popup: state.popup ? extensionUrl(id, state.popup) : null,
      enabled: state.enabled
    }
  }

  /** A tab closed: the overrides extensions set for it go. */
  tabRemoved(chromeTabId: number): void {
    this.sidePanel.tabRemoved(chromeTabId)
    let changed = false
    for (const record of this.actions.values())
      changed = record.perTab.delete(chromeTabId) || changed
    if (changed) this.host.browser.state.commitVolatile()
  }

  async call(
    ext: AttachedExtension,
    endpoint: Endpoint,
    ns: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const id = ext.record.id
    switch (ns) {
      case 'tabs':
        return this.tabsCall(ext, endpoint, method, args)
      case 'windows':
        return this.windowsCall(ext, method, args)
      case 'action':
      case 'browserAction':
      case 'pageAction':
        return this.actionCall(ext, method, args)
      case 'scripting':
        return this.scriptingCall(ext, method, args)
      case 'userScripts':
        return this.userScriptsCall(ext, method, args)
      case 'runtime':
        return this.runtimeCall(ext, method, args)
      case 'declarativeNetRequest':
        return this.host.dnr.call(ext, method, args)
      case 'notifications':
        return this.notifications.call(ext, method, args)
      case 'tts':
        return this.tts.call(id, endpoint.id, method, args)
      case 'speechSynthesis':
        // A page's Web Speech API (extensionSpeechSynthesis.ts): no permission, the same engine.
        return this.tts.call(id, endpoint.id, method, args, true)
      case 'contextMenus':
        return this.contextMenus.call(ext, endpoint.id, method, args)
      case 'sidePanel':
        return this.sidePanel.call(ext, method, args)
      case 'webNavigation':
        return this.webNavigationCall(ext, method, args)
      case 'cookies': {
        const tabId = endpoint.context === 'content' ? endpoint.tabId : null
        const tab = tabId ? (this.host.browser.tabs.tab(tabId) ?? null) : null
        return this.cookies.call(ext, { tab }, method, args)
      }
      case 'identity':
        return this.host.identity.call(id, method, args)
      case 'history':
        return this.historyCall(method, args)
      case 'bookmarks':
        return this.bookmarksCall(method, args)
      case 'permissions':
        return this.permissionsCall(ext, method, args)
      case 'management':
        return this.managementCall(ext, method, args)
      case 'commands':
        if (method === 'getAll')
          return ext.manifest.commands.map((c) => ({
            name: c.name,
            description: c.description,
            shortcut: ''
          }))
        break
      case 'idle':
        if (method === 'queryState') return 'active'
        break
      case 'system.storage':
        // No storage devices to show, as on the desktop (there the engine's own namespace is
        // withheld because it crashes; here there is none to begin with): Chrome's shape, for
        // an extension that declared the permission (a declared optional one is granted by
        // `permissions.request` above without a prompt).
        if (
          !ext.manifest.permissions.includes(SYSTEM_STORAGE_PERMISSION) &&
          !ext.manifest.optionalPermissions.includes(SYSTEM_STORAGE_PERMISSION)
        )
          throw new Error(SYSTEM_STORAGE_NO_PERMISSION_ERROR)
        return answerSystemStorage(method, args)
      case 'system.display':
        // The phone's one screen (`extensionSystemDisplay.ts`), for an extension that declared the
        // permission; Chrome hides the namespace from the others.
        if (!this.holdsPermission(ext, SYSTEM_DISPLAY_PERMISSION))
          throw new Error(SYSTEM_DISPLAY_NO_PERMISSION_ERROR)
        return answerSystemDisplay(method, this.host.screen())
      case 'proxy':
        // `proxy.settings`, a ChromeSetting over the WebView's proxy override (`extensionProxy.ts`).
        return this.proxy.call(ext, method, args)
      case 'extension':
        // The store's record carries both toggles (the runtime scopes tabs, events and rules by them).
        if (method === 'isAllowedFileSchemeAccess') return ext.record.allowFileAccess === true
        if (method === 'isAllowedIncognitoAccess') return ext.record.allowPrivate === true
        break
      case 'offscreen':
        return this.offscreenCall(ext, method, args)
      case 'i18n':
        // getMessage, getUILanguage and getAcceptLanguages are the engine's; the platform's
        // classifier answers detectLanguage.
        if (method === 'detectLanguage')
          return this.host.detectTextLanguage(typeof args[0] === 'string' ? args[0] : '')
        break
      case 'downloads':
        if (method === 'download') {
          const url = String(asRecord(args[0]).url ?? '')
          if (!url) throw new Error('A url is required.')
          this.host.browser.tabs.createTab({ url, active: false }, this.host.window())
          return this.tabs.peekNext()
        }
        break
    }
    throw new Error(`chrome.${ns}.${method} ${NOT_IMPLEMENTED}`)
  }

  /**
   * The URL an API navigation (`tabs.create` / `tabs.update` / `windows.create`) lands on: a
   * path is the extension's own page; a `file://` address needs the extension's file-access
   * switch, as in Chrome, which refuses the call ("Cannot navigate to a file URL without local
   * file access.") instead of opening the file. Without the check the phone opened a tab on
   * the address, where the tab WebView (no file access) shows an error page and the
   * extension (Enable local file links) never learns to ask for the switch.
   */
  private navigationUrl(ext: AttachedExtension, url: string): string {
    const full = tabUrlFrom(ext.record.id, url)
    if (isFileNavigation(full) && ext.record.allowFileAccess !== true)
      throw new Error(FILE_URL_WITHOUT_ACCESS_ERROR)
    return full
  }

  // --- tabs ------------------------------------------------------------------

  private tabsCall(
    ext: AttachedExtension,
    endpoint: Endpoint,
    method: string,
    args: unknown[]
  ): unknown {
    const win = this.host.window()
    const tabs = this.host.browser.tabs
    const ids = this.tabs
    const targetOrActive = (value: unknown): Tab | undefined =>
      asNumber(value) !== null ? ids.tabFor(ext, value) : ids.activeTabFor(ext)
    switch (method) {
      case 'query': {
        const q = asRecord(args[0])
        const active = tabs.activeTabFor(win)?.id
        return ids
          .visibleTabs(ext)
          .filter((tab) => {
            if (q.active !== undefined && (tab.id === active) !== Boolean(q.active)) return false
            if (q.pinned !== undefined && (tab.pinned || tab.essential) !== Boolean(q.pinned))
              return false
            if (q.audible !== undefined && tab.audible !== Boolean(q.audible)) return false
            if (q.discarded !== undefined && tab.discarded !== Boolean(q.discarded)) return false
            if (q.status !== undefined && (tab.loading ? 'loading' : 'complete') !== q.status)
              return false
            if (
              q.title !== undefined &&
              !globToRegExp(String(q.title)).test(tab.customTitle ?? tab.title)
            )
              return false
            if (q.url !== undefined) {
              const patterns = Array.isArray(q.url) ? q.url.map(String) : [String(q.url)]
              // An extension-page tab's URL is Chrome's spelling; a pattern built from
              // `runtime.getURL` (OneTab looks for its own list page that way) is the served one.
              const url = ids.urlOf(tab)
              if (
                !matchesAnyPattern(url, patterns) &&
                !matchesAnyPattern(toServedUrl(url), patterns)
              )
                return false
            }
            if (q.windowId !== undefined && q.windowId !== -2 && q.windowId !== 1) return false
            if (q.currentWindow === false || q.lastFocusedWindow === false) return false
            return true
          })
          .map((tab) => ids.chromeTab(tab))
      }
      case 'get':
        return ids.chromeTab(ids.tabFor(ext, args[0]))
      case 'getCurrent': {
        // A content script's tab, or the tab an extension page is open in (OneTab's list page
        // reads its own id from it); popups, workers and offscreen pages have none.
        if ((endpoint.context === 'content' || endpoint.context === 'page') && endpoint.tabId) {
          const tab = tabs.tab(endpoint.tabId)
          return tab ? ids.chromeTab(tab) : undefined
        }
        return undefined
      }
      case 'create': {
        const props = asRecord(args[0])
        const tab = tabs.createTab(
          {
            url: typeof props.url === 'string' ? this.navigationUrl(ext, props.url) : undefined,
            active: props.active === undefined ? true : Boolean(props.active),
            pinned: Boolean(props.pinned)
          },
          win
        )
        return ids.chromeTab(tab)
      }
      case 'update': {
        const [first, second] = args
        const props = asRecord(second ?? first)
        const target = targetOrActive(first)
        if (!target) throw new Error('No active tab.')
        if (typeof props.url === 'string')
          tabs.navigate(target.id, this.navigationUrl(ext, props.url))
        if (props.active === true) tabs.activateTab(target.id, win)
        if (props.muted !== undefined && Boolean(props.muted) !== target.muted)
          tabs.toggleMute(target.id)
        if (props.pinned !== undefined && Boolean(props.pinned) !== target.pinned)
          tabs.togglePin(target.id, win)
        return ids.chromeTab(tabs.tab(target.id) ?? target)
      }
      case 'remove': {
        const list = Array.isArray(args[0]) ? args[0] : [args[0]]
        for (const id of list) tabs.closeTab(ids.tabFor(ext, id).id, true, win)
        return undefined
      }
      case 'highlight': {
        // Chrome selects the tabs at these indices and makes the first of them active; the phone
        // has one selection, the active tab, so the first index names it (FireShot goes back to
        // the captured tab this way; Chrome's index is the position among the window's tabs).
        const info = asRecord(args[0])
        const indices = (Array.isArray(info.tabs) ? info.tabs : [info.tabs])
          .map((value) => asNumber(value))
          .filter((value): value is number => value !== null && Number.isInteger(value))
        if (indices.length === 0) throw new Error('No highlighted tab')
        const visible = ids.visibleTabs(ext)
        const first = visible[indices[0]]
        if (!first) throw new Error(`No tab at index: ${indices[0]}.`)
        tabs.activateTab(first.id, win)
        return ids.chromeWindow(ext)
      }
      case 'move': {
        // `tabs.move(tabIds, { index, windowId? })`: the phone's one window is the only one a tab
        // can move within (Dualless moves the other tabs into the window it just "created", the
        // same one); each tab of a list takes the next position, as Chrome hands them out.
        const [first, second] = args
        const props = asRecord(second)
        if (props.windowId !== undefined && props.windowId !== null)
          this.requireWindow(props.windowId)
        const index = asNumber(props.index)
        if (index === null)
          throw new Error("Error at parameter 'moveProperties': Missing required property 'index'.")
        if (!Number.isInteger(index) || index < -1)
          throw new Error(
            "Error at parameter 'moveProperties': Error at property 'index': Value must be at least -1."
          )
        const list = Array.isArray(first) ? first : [first]
        const targets = list.map((value) => ids.tabFor(ext, value))
        const moved: Array<Record<string, unknown>> = []
        let at = index
        for (const target of targets) {
          const { fromIndex, toIndex } = ids.move(target, at)
          if (fromIndex !== toIndex) this.tabMoved(target, fromIndex, toIndex)
          moved.push(ids.chromeTab(tabs.tab(target.id) ?? target))
          if (at !== -1) at++
        }
        return Array.isArray(first) ? moved : moved[0]
      }
      case 'reload': {
        const target = targetOrActive(args[0])
        if (target) tabs.reload(target.id, Boolean(asRecord(args[1]).bypassCache))
        return undefined
      }
      case 'duplicate': {
        const copy = tabs.duplicate(ids.tabFor(ext, args[0]).id, win)
        return copy ? ids.chromeTab(copy) : undefined
      }
      case 'getZoom':
        return targetOrActive(args[0])?.zoom ?? 1
      case 'setZoom': {
        const [first, second] = args
        const factor = asNumber(second ?? first) ?? 1
        const target = asNumber(second) !== null ? ids.tabFor(ext, first) : ids.activeTabFor(ext)
        if (target) tabs.setZoom(target.id, factor)
        return undefined
      }
      case 'discard': {
        const target = asNumber(args[0]) !== null ? ids.tabFor(ext, args[0]) : undefined
        if (target) tabs.discard(target.id)
        return target ? ids.chromeTab(tabs.tab(target.id) ?? target) : undefined
      }
      case 'goBack':
        tabs.goBack(targetOrActive(args[0])?.id ?? '')
        return undefined
      case 'goForward':
        tabs.goForward(targetOrActive(args[0])?.id ?? '')
        return undefined
      case 'executeScript':
      case 'insertCSS': {
        // MV2: [tabId | null, details]
        const [tabIdArg, detailsArg] = args
        const target = targetOrActive(tabIdArg)
        if (!target) throw new Error('No active tab.')
        return this.mv2Inject(
          ext,
          target,
          method === 'executeScript' ? 'js' : 'css',
          asRecord(detailsArg)
        )
      }
      case 'captureVisibleTab':
        return this.captureVisibleTab(ext, args[0], args[1])
      case 'detectLanguage': {
        const target = targetOrActive(args[0])
        if (!target) throw new Error('No active tab.')
        return this.detectLanguage(ext, target)
      }
    }
    throw new Error(`chrome.tabs.${method} ${NOT_IMPLEMENTED}`)
  }

  /**
   * A window id an extension passed: the phone's one window is `1`, and `WINDOW_ID_CURRENT`
   * (`-2`) names it too; any other number is a window that does not exist (Chrome's wording),
   * anything else no id at all.
   */
  private requireWindow(windowId: unknown): void {
    if (windowId === -2 || windowId === 1) return
    if (asNumber(windowId) === null || !Number.isInteger(windowId))
      throw new Error('Invalid window id')
    throw new Error(`No window with id: ${windowId}.`)
  }

  /**
   * `tabs.onMoved` to every extension that may see the tab: Chrome raises it once per moved tab,
   * for the window the tab moved within, and only when the position changed.
   */
  private tabMoved(tab: Tab, fromIndex: number, toIndex: number): void {
    const tabId = this.tabs.chromeIdFor(tab.id)
    for (const other of this.host.allAttached()) {
      if (!this.tabs.visibleTo(other, tab)) continue
      this.host.emit(other.record.id, 'tabs', 'onMoved', [
        tabId,
        { windowId: 1, fromIndex, toIndex }
      ])
    }
  }

  /**
   * Chrome runs its language detector over the page's text. The phone has none, so the answer
   * is what the document declares (`<html lang>`, which Blink also fills from a Content-Language
   * header), as the bare language code Chrome returns – `und` when nothing is declared or the
   * page cannot be asked. Ghostery and LanguageTool call this on every page they attach to.
   */
  private async detectLanguage(ext: AttachedExtension, target: Tab): Promise<string> {
    let declared: unknown
    try {
      declared = await this.host.exec({
        extensionId: ext.record.id,
        tabId: target.id,
        frameId: 0,
        kind: 'js',
        payload: { world: 'ISOLATED' },
        code: DECLARED_LANGUAGE_JS,
        files: null,
        funcSource: null,
        args: null
      })
    } catch {
      return 'und'
    }
    return languageCodeOf(declared)
  }

  /**
   * `chrome.offscreen`: one hidden page per extension, on its origin, with the same `chrome` as
   * a popup (Tampermonkey makes its blob URLs in one, Google Translate plays its audio there);
   * Chrome's errors word for word. `reasons` and `justification` are required by Chrome's
   * validator but change nothing here.
   */
  private async offscreenCall(
    ext: AttachedExtension,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const id = ext.record.id
    switch (method) {
      case 'createDocument': {
        const params = asRecord(args[0])
        const url = typeof params.url === 'string' ? params.url.trim() : ''
        if (!url)
          throw new Error(
            "Error at parameter 'parameters': Error at property 'url': Invalid or missing url."
          )
        const reasons = Array.isArray(params.reasons) ? params.reasons : []
        if (reasons.length === 0)
          throw new Error(
            "Error at parameter 'parameters': Error at property 'reasons': Expected at least one reason."
          )
        if (this.host.hasOffscreen(id))
          throw new Error('Only a single offscreen document may be created.')
        await this.host.openOffscreen(id, offscreenUrl(id, url))
        return undefined
      }
      case 'closeDocument':
        if (!this.host.hasOffscreen(id)) throw new Error('No current offscreen document.')
        this.host.closeOffscreen(id)
        return undefined
      case 'hasDocument':
        return this.host.hasOffscreen(id)
    }
    throw new Error(`chrome.offscreen.${method} ${NOT_IMPLEMENTED}`)
  }

  /**
   * Chrome's checks in order: the options, the quota, some host access at all, then what the
   * page is (`captureDenial`); a page that cannot be copied is "view is invisible". The one
   * window is the current one (`WINDOW_ID_CURRENT` or 1); the picture is the active tab's, which
   * the phone shows whole (a popup sheet is its own window and never in the copy).
   */
  private async captureVisibleTab(
    ext: AttachedExtension,
    windowId: unknown,
    options: unknown
  ): Promise<string> {
    const o = normalizeCaptureOptions(options)
    if (!this.captureQuota.take(ext.record.id, this.host.now()))
      throw new Error(CAPTURE_QUOTA_ERROR)
    if (windowId !== undefined && windowId !== null) this.requireWindow(windowId)
    const tab = this.tabs.activeTabFor(ext)
    if (!tab || tab.discarded) throw new Error('Failed to capture tab: view is invisible')
    const tabUrl = this.tabs.urlOf(tab)
    const denial = captureDenial(tabUrl, {
      allUrls: coversAllUrls(this.hostPatterns(ext)),
      activeTab: this.activeTab.allowsUrl(ext.record.id, tabUrl),
      fileAccess: ext.record.allowFileAccess === true,
      extensionId: ext.record.id
    })
    if (denial) throw new Error(denial)
    let image: string | null
    try {
      image = await this.host.captureTab(tab.id, o.format, o.quality)
    } catch {
      throw new Error('Failed to capture tab: unknown error')
    }
    if (!image) throw new Error('Failed to capture tab: view is invisible')
    return image
  }

  /**
   * The frames an injection targets, as Chrome reads `frameIds` / `allFrames` (MV3 `target`) or
   * `frameId` / `allFrames` (MV2 details): the main frame alone by default. `allFrames` adds
   * every subframe of the tab the extension has a content endpoint in (a frame it has no scripts
   * in is beyond the host's reach, as one Chrome would inject into anyway is not). Explicit ids
   * are kept as given; the host rejects an id no frame of the tab carries.
   */
  private targetFrames(
    ext: AttachedExtension,
    tab: Tab,
    target: Record<string, unknown>
  ): { frames: number[]; explicit: boolean } {
    const listed = Array.isArray(target.frameIds)
      ? target.frameIds
      : target.frameId !== undefined
        ? [target.frameId]
        : null
    if (listed !== null) {
      const ids = listed.map((v) => Number(v))
      if (ids.some((v) => !Number.isInteger(v) || v < 0)) throw new Error('Invalid frame id.')
      return { frames: [...new Set(ids)], explicit: true }
    }
    if (target.allFrames !== true) return { frames: [0], explicit: false }
    const frames = new Set<number>([0])
    for (const e of this.host.router.of(ext.record.id, 'content'))
      if (e.tabId === tab.id) frames.add(e.frameId)
    return { frames: [...frames].sort((a, b) => a - b), explicit: false }
  }

  /**
   * One injection per target frame. A subframe swept in by `allFrames` that the host cannot reach
   * (gone, or a WebView without frame injection) is left out, as Chrome leaves out the frames it
   * may not inject into; the main frame and every frame named in `frameIds` fail the call.
   */
  private async injectFrames<T>(
    frames: { frames: number[]; explicit: boolean },
    one: (frameId: number) => Promise<T>
  ): Promise<Array<{ frameId: number; value: T }>> {
    const results: Array<{ frameId: number; value: T }> = []
    for (const frameId of frames.frames) {
      try {
        results.push({ frameId, value: await one(frameId) })
      } catch (error) {
        if (frames.explicit || frameId === 0) throw error
      }
    }
    return results
  }

  /** `tabs.executeScript` / `tabs.insertCSS` (MV2): `{ code }` or `{ file }` into the tab's frames. */
  private async mv2Inject(
    ext: AttachedExtension,
    target: Tab,
    kind: 'js' | 'css',
    details: Record<string, unknown>
  ): Promise<unknown> {
    const id = ext.record.id
    const frames = this.targetFrames(ext, target, details)
    if (kind === 'js') {
      // `{ file }` goes to the host by name; `{ code }` as text.
      const file = typeof details.file === 'string' ? details.file : null
      const results = await this.injectFrames(frames, (frameId) =>
        this.host.exec({
          extensionId: id,
          tabId: target.id,
          frameId,
          kind: 'js',
          payload: { world: 'ISOLATED' },
          code: file === null ? String(details.code ?? '') : null,
          files: file === null ? null : [file],
          funcSource: null,
          args: null
        })
      )
      return results.map((r) => r.value)
    }
    const code =
      typeof details.code === 'string'
        ? details.code
        : await this.host.readFile(id, String(details.file ?? ''))
    const cssId = typeof details.file === 'string' ? details.file : (code ?? '')
    await this.injectFrames(frames, (frameId) =>
      this.host.exec({
        extensionId: id,
        tabId: target.id,
        frameId,
        kind: 'css',
        payload: { id: cssId, code: code ?? '' },
        code: null,
        files: null,
        funcSource: null,
        args: null
      })
    )
    return undefined
  }

  private windowsCall(ext: AttachedExtension, method: string, args: unknown[]): unknown {
    switch (method) {
      case 'get':
      case 'getCurrent':
      case 'getLastFocused':
        return this.tabs.chromeWindow(ext)
      case 'getAll':
        return [this.tabs.chromeWindow(ext)]
      case 'create': {
        const props = asRecord(args[0])
        const url = Array.isArray(props.url) ? props.url[0] : props.url
        if (typeof url === 'string')
          this.host.browser.tabs.createTab(
            { url: this.navigationUrl(ext, url), active: true },
            this.host.window()
          )
        return this.tabs.chromeWindow(ext)
      }
      case 'update':
        return this.tabs.chromeWindow(ext)
    }
    throw new Error(`chrome.windows.${method} ${NOT_IMPLEMENTED}`)
  }

  // --- action / browserAction ------------------------------------------------

  /**
   * `chrome.action` / `browserAction`: a call with `details.tabId` reads or writes that tab's
   * override, one without the global value (Chrome's semantics); `enable` / `disable` take the
   * tab id as their argument. A tab id that names no tab the extension may see is an error.
   */
  private actionCall(ext: AttachedExtension, method: string, args: unknown[]): unknown {
    const id = ext.record.id
    const details = asRecord(args[0])
    const tabIdOf = (value: unknown): number | undefined => {
      if (value === undefined || value === null) return undefined
      if (!Number.isInteger(value)) throw new Error('Invalid tab id')
      this.tabs.tabFor(ext, value)
      return value as number
    }
    const tabId = tabIdOf(details.tabId)
    const state = this.actionStateFor(id, tabId)
    // An omitted value resets the level (a tab's override goes, the global falls back to the
    // manifest); anything else must parse.
    const write = <K extends keyof ActionState>(
      key: K,
      field: string,
      parse: (raw: unknown) => ActionState[K] | null
    ): void => {
      const raw = details[field]
      if (raw === undefined || raw === null) {
        this.writeAction(id, tabId, key, null)
        return
      }
      const value = parse(raw)
      if (value === null) throw new Error(`Invalid value for ${field}.`)
      this.writeAction(id, tabId, key, value)
    }
    const string = (raw: unknown): string | null => (typeof raw === 'string' ? raw : null)
    switch (method) {
      case 'setTitle':
        write('title', 'title', string)
        return undefined
      case 'getTitle':
        return state.title || ext.manifest.name
      case 'setIcon':
        // Toolbar icons stay the manifest's; per-tab imageData / path variants are not drawn yet.
        return undefined
      case 'setPopup': {
        // Chrome takes the extension's own absolute URL or a relative path; '' means no popup.
        if (typeof details.popup !== 'string') throw new Error('Invalid value for popup.')
        const own = extensionUrl(id, '')
        const popup = details.popup.startsWith(own)
          ? details.popup.slice(own.length)
          : details.popup.replace(/^\/+/, '')
        this.writeAction(id, tabId, 'popup', popup)
        return undefined
      }
      case 'getPopup':
        return state.popup ? extensionUrl(id, state.popup) : ''
      case 'setBadgeText':
        write('badgeText', 'text', string)
        return undefined
      case 'getBadgeText':
        return state.badgeText
      case 'setBadgeBackgroundColor':
        write('badgeBackgroundColor', 'color', colorString)
        return undefined
      case 'getBadgeBackgroundColor':
        // Unset, Chrome answers transparent black (the toolbar draws its own default); the
        // desktop answers the same.
        return state.badgeBackgroundColor === DEFAULT_BADGE_BACKGROUND
          ? [0, 0, 0, 0]
          : colorArray(state.badgeBackgroundColor)
      case 'setBadgeTextColor':
        write('badgeTextColor', 'color', colorString)
        return undefined
      case 'getBadgeTextColor':
        return colorArray(state.badgeTextColor)
      case 'enable':
      case 'show':
        this.writeAction(id, tabIdOf(args[0]), 'enabled', true)
        return undefined
      case 'disable':
      case 'hide':
        this.writeAction(id, tabIdOf(args[0]), 'enabled', false)
        return undefined
      case 'isEnabled':
        return state.enabled
      case 'openPopup':
        this.host.openPopup(id, true)
        return undefined
      case 'getUserSettings':
        return { isOnToolbar: true }
    }
    throw new Error(`chrome.action.${method} ${NOT_IMPLEMENTED}`)
  }

  // --- scripting / userScripts -------------------------------------------------

  private async scriptingCall(
    ext: AttachedExtension,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const id = ext.record.id
    const injection = asRecord(args[0])
    const target = asRecord(injection.target)
    const resolveTab = (): Tab => {
      if (target.tabId !== undefined) return this.tabs.tabFor(ext, target.tabId)
      const tab = this.tabs.activeTabFor(ext)
      if (!tab) throw new Error('No active tab.')
      return tab
    }
    switch (method) {
      case 'executeScript': {
        const tab = resolveTab()
        const frames = this.targetFrames(ext, tab, target)
        const world = injection.world === 'MAIN' ? 'MAIN' : 'ISOLATED'
        let files: string[] | null = null
        let funcSource: string | null = null
        let funcArgs: unknown[] | null = null
        if (typeof injection.funcSource === 'string') {
          funcSource = injection.funcSource
          funcArgs = Array.isArray(injection.args) ? injection.args : []
        } else {
          // The host reads the files into the script (a missing one is its `Could not load file` rejection).
          files = asStringArray(injection.files)
        }
        const results = await this.injectFrames(frames, (frameId) =>
          this.host.exec({
            extensionId: id,
            tabId: tab.id,
            frameId,
            kind: 'js',
            payload: { world },
            code: null,
            files,
            funcSource,
            args: funcArgs
          })
        )
        return results.map((r) => ({ frameId: r.frameId, documentId: '', result: r.value }))
      }
      case 'insertCSS':
      case 'removeCSS': {
        const tab = resolveTab()
        const frames = this.targetFrames(ext, tab, target)
        const remove = method === 'removeCSS'
        const sheets: Array<{ id: string; code: string }> = []
        if (typeof injection.css === 'string') {
          sheets.push({ id: injection.css, code: injection.css })
        } else {
          for (const file of asStringArray(injection.files)) {
            const text = remove ? '' : await this.host.readFile(id, file)
            if (!remove && text === null) throw new Error(`Could not load file: '${file}'.`)
            sheets.push({ id: file, code: text ?? '' })
          }
        }
        await this.injectFrames(frames, async (frameId) => {
          for (const sheet of sheets)
            await this.host.exec({
              extensionId: id,
              tabId: tab.id,
              frameId,
              kind: 'css',
              payload: { id: sheet.id, code: sheet.code, remove },
              code: null,
              files: null,
              funcSource: null,
              args: null
            })
        })
        return undefined
      }
      case 'registerContentScripts':
        return this.register(id, args[0], 'ISOLATED', (s) => s.world !== 'USER_SCRIPT')
      case 'getRegisteredContentScripts': {
        const filter = asStringArray(asRecord(args[0]).ids)
        return this.host
          .registered(id)
          .filter((s) => s.world !== 'USER_SCRIPT')
          .filter((s) => filter.length === 0 || filter.includes(s.id))
          .map(registeredToChrome)
      }
      case 'unregisterContentScripts':
        return this.unregister(id, args[0], (s) => s.world !== 'USER_SCRIPT')
      case 'updateContentScripts':
        return this.update(id, args[0], (s) => s.world !== 'USER_SCRIPT')
    }
    throw new Error(`chrome.scripting.${method} ${NOT_IMPLEMENTED}`)
  }

  /**
   * `chrome.userScripts`: registrations live next to the content scripts, in the `USER_SCRIPT`
   * world (their own unit and, with `configureWorld({ messaging: true })`, a messaging-only
   * `chrome`). `js` entries are `{ file }` / `{ code }` objects; a code entry travels in the
   * group's `js` list as an inline script (`inlineScript`), which the host's compiler pastes in
   * place of a file's text. An `update` patch without `js` leaves the scripts as they are.
   */
  private async userScriptsCall(
    ext: AttachedExtension,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const id = ext.record.id
    const isUser = (s: RegisteredContentScript): boolean => s.world === 'USER_SCRIPT'
    const fromUserScript = (raw: unknown): Record<string, unknown> => {
      const script = asRecord(raw)
      if (!Array.isArray(script.js)) return script
      const js: string[] = []
      for (const entry of script.js) {
        const source = asRecord(entry)
        if (typeof source.code === 'string') js.push(inlineScript(source.code))
        else if (typeof source.file === 'string') js.push(source.file)
      }
      return { ...script, js }
    }
    const toUserScript = (s: RegisteredContentScript): Record<string, unknown> => ({
      ...registeredToChrome(s),
      js: s.js.map((entry) => {
        const code = inlineScriptCode(entry)
        return code === null ? { file: entry } : { code }
      })
    })
    switch (method) {
      case 'register':
        return this.register(
          id,
          (Array.isArray(args[0]) ? args[0] : []).map(fromUserScript),
          'USER_SCRIPT',
          isUser
        )
      case 'getScripts': {
        const filter = asStringArray(asRecord(args[0]).ids)
        return this.host
          .registered(id)
          .filter(isUser)
          .filter((s) => filter.length === 0 || filter.includes(s.id))
          .map(toUserScript)
      }
      case 'unregister':
        return this.unregister(id, args[0], isUser)
      case 'update':
        return this.update(id, (Array.isArray(args[0]) ? args[0] : []).map(fromUserScript), isUser)
      case 'configureWorld': {
        const properties = asRecord(args[0])
        await this.host.setUserScriptMessaging(id, properties.messaging === true)
        return undefined
      }
      case 'getWorldConfigurations':
        return [{ messaging: this.host.userScriptMessaging(id) }]
      case 'resetWorldConfiguration':
        await this.host.setUserScriptMessaging(id, false)
        return undefined
      case 'execute':
        return this.executeUserScript(ext, normalizeInjection(args[0]))
      case 'sendMessage':
        // The shared shim's `tabs.sendMessage` asks the host to deliver to the tab's user-script
        // worlds besides the engine's content scripts (`wrapTabsSendMessage`). Here the router
        // already addresses `tabs.sendMessage` to every document of the extension in the tab,
        // the user-script worlds among them, so there is nothing more to deliver: nobody
        // else listened, nobody else answered (OrangeMonkey's worker and popup logged the
        // refusal on every message to a tab, run 35787391495).
        return { handled: false, responded: false }
    }
    throw new Error(`chrome.userScripts.${method} ${NOT_IMPLEMENTED}`)
  }

  /**
   * `userScripts.execute(injection)` (Chrome 135): the sources run in order in the target frames,
   * in the extension's user-script world (the scope its registered scripts share, with that
   * world's `chrome`: messaging only, and only once configured) or in the main world, through the
   * `scripting.executeScript` path; one result per frame, the last source's value, in Chrome's
   * `InjectionResult` shape. A document id names nothing here (the runtime reports none), so a
   * `documentIds` target fails as an unknown document does in Chrome. `injectImmediately` makes
   * no difference: an injection runs as soon as the frame can take it, as `executeScript` does.
   */
  private async executeUserScript(
    ext: AttachedExtension,
    injection: UserScriptInjection
  ): Promise<unknown> {
    const id = ext.record.id
    const tab = this.tabs.tabFor(ext, injection.target.tabId)
    if (injection.target.documentIds) {
      const missing = injection.target.documentIds[0] ?? ''
      throw new Error(`No document with id ${missing} in tab with id ${injection.target.tabId}`)
    }
    const frames = this.targetFrames(ext, tab, {
      frameIds: injection.target.frameIds,
      allFrames: injection.target.allFrames
    })
    const payload = {
      world: injection.world === 'MAIN' ? 'MAIN' : 'USER_SCRIPT',
      messaging: this.host.userScriptMessaging(id)
    }
    const results = await this.injectFrames(frames, async (frameId) => {
      let value: unknown = undefined
      for (const source of injection.js) {
        value = await this.host.exec({
          extensionId: id,
          tabId: tab.id,
          frameId,
          kind: 'js',
          payload,
          code: 'code' in source ? source.code : null,
          files: 'file' in source ? [source.file] : null,
          funcSource: null,
          args: null
        })
      }
      return value
    })
    return results.map((r) => ({ frameId: r.frameId, documentId: '', result: r.value }))
  }

  private async register(
    id: string,
    raw: unknown,
    defaultWorld: ScriptWorld,
    mine: (script: RegisteredContentScript) => boolean
  ): Promise<undefined> {
    const list = [...this.host.registered(id)]
    for (const entry of Array.isArray(raw) ? raw : []) {
      const script = registeredFrom(asRecord(entry), defaultWorld)
      if (!script.id) throw new Error("Script's ID must not be empty")
      if (list.some((s) => mine(s) && s.id === script.id))
        throw new Error(`Duplicate script ID '${script.id}'`)
      list.push(script)
    }
    await this.host.setRegistered(id, list)
    return undefined
  }

  private async unregister(
    id: string,
    raw: unknown,
    mine: (script: RegisteredContentScript) => boolean
  ): Promise<undefined> {
    const filter = asStringArray(asRecord(raw).ids)
    // Chrome: no filter unregisters every script of the API's own kind.
    const keep = this.host
      .registered(id)
      .filter((s) => !mine(s) || (filter.length > 0 && !filter.includes(s.id)))
    await this.host.setRegistered(id, keep)
    return undefined
  }

  private async update(
    id: string,
    raw: unknown,
    mine: (script: RegisteredContentScript) => boolean
  ): Promise<undefined> {
    const list = [...this.host.registered(id)]
    for (const entry of Array.isArray(raw) ? raw : []) {
      const patch = asRecord(entry)
      const index = list.findIndex((s) => mine(s) && s.id === patch.id)
      if (index === -1) throw new Error(`Script with ID '${String(patch.id)}' does not exist`)
      const current = list[index]
      list[index] = registeredFrom({ ...registeredToChrome(current), ...patch }, current.world)
    }
    await this.host.setRegistered(id, list)
    return undefined
  }

  // --- runtime ---------------------------------------------------------------

  private async runtimeCall(
    ext: AttachedExtension,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const id = ext.record.id
    switch (method) {
      case 'openOptionsPage':
        if (!ext.manifest.options) throw new Error('Could not create an options page.')
        this.host.openOptions(id)
        return undefined
      case 'reload':
        await this.host.reload(id)
        return undefined
      // Chrome 109+ hands the callback one `{ status, version }`; the promise form resolves with it.
      case 'requestUpdateCheck':
        return this.host.requestUpdateCheck(id)
      case 'getContexts': {
        // An extension page's URL as Chrome spells it (`extensionUrls.ts`); its origin stays the
        // served one, what `location.origin` answers inside the page, as for a message sender.
        const contexts: ExtensionContext[] = this.host.router.of(id).map((e) => ({
          contextId: e.id,
          contextType: contextTypeOf(e.context),
          documentId: e.id,
          documentOrigin: e.url ? safeOrigin(e.url) : '',
          documentUrl:
            e.url && e.context !== 'content' && e.context !== 'userScript'
              ? presentExtensionUrl(e.url)
              : e.url,
          frameId: e.frameId,
          incognito: false,
          tabId: e.tabId ? this.tabs.chromeIdFor(e.tabId) : -1,
          windowId: 1
        }))
        // An offscreen document still loading is a context already, as Chrome's is.
        const opening = this.host.offscreenLoading(id)
        if (opening !== null && !contexts.some((c) => c.contextType === 'OFFSCREEN_DOCUMENT'))
          contexts.push({
            contextId: `${id}/offscreen`,
            contextType: 'OFFSCREEN_DOCUMENT',
            documentId: `${id}/offscreen`,
            documentOrigin: safeOrigin(opening),
            documentUrl: presentExtensionUrl(opening),
            frameId: 0,
            incognito: false,
            tabId: -1,
            windowId: 1
          })
        return filterContexts(contexts, asRecord(args[0]))
      }
      // No native messaging hosts on the phone: Chrome's answer for a host that does not exist.
      case 'sendNativeMessage':
      case 'connectNative':
        throw new Error(NATIVE_HOST_NOT_FOUND)
    }
    throw new Error(`chrome.runtime.${method} ${NOT_IMPLEMENTED}`)
  }

  // --- notifications / contextMenus / webNavigation ----------------------------

  /**
   * `getFrame` / `getAllFrames`: the main frame from the tab (frame 0, its URL), the sub-frames
   * from the content endpoints the extension has in the tab (the only frames the host can see).
   * A tab the extension may not see (private, not allowed) is no tab, as in Chrome.
   */
  private webNavigationCall(ext: AttachedExtension, method: string, args: unknown[]): unknown {
    const details = asRecord(args[0])
    const id = ext.record.id
    const frames = (tabIdArg: unknown): Array<Record<string, unknown>> | null => {
      const chromeTabId = asNumber(tabIdArg)
      if (chromeTabId === null) throw new Error('Invalid tabId')
      const coreId = this.tabs.coreIdFor(chromeTabId)
      const tab = coreId ? this.host.browser.tabs.tab(coreId) : undefined
      if (!tab || !this.tabs.visibleTo(ext, tab)) return null
      const out: Array<Record<string, unknown>> = [
        {
          tabId: chromeTabId,
          frameId: 0,
          parentFrameId: -1,
          processId: -1,
          url: this.tabs.urlOf(tab),
          documentId: `tab-${chromeTabId}`,
          frameType: 'outermost_frame',
          documentLifecycle: 'active',
          errorOccurred: false
        }
      ]
      for (const e of this.host.router.of(id, 'content')) {
        if (e.tabId !== coreId || e.frameId === 0) continue
        if (out.some((f) => f.frameId === e.frameId)) continue
        out.push({
          tabId: chromeTabId,
          frameId: e.frameId,
          parentFrameId: 0,
          processId: -1,
          url: e.url,
          documentId: e.id.split('.')[0] ?? e.id,
          frameType: 'sub_frame',
          documentLifecycle: 'active',
          errorOccurred: false
        })
      }
      return out
    }
    switch (method) {
      case 'getFrame': {
        const list = frames(details.tabId)
        const frameId = asNumber(details.frameId) ?? 0
        return list?.find((f) => f.frameId === frameId) ?? null
      }
      case 'getAllFrames':
        return frames(details.tabId)
    }
    throw new Error(`chrome.webNavigation.${method} ${NOT_IMPLEMENTED}`)
  }

  // --- history / bookmarks / permissions / management -----------------------

  private historyCall(method: string, args: unknown[]): unknown {
    const history = this.host.browser.history
    const details = asRecord(args[0])
    switch (method) {
      case 'search': {
        const text = String(details.text ?? '')
        const max = asNumber(details.maxResults) ?? 100
        const entries = text ? history.search(text, max) : history.recent(max)
        return entries.map((e, i) => ({
          id: String(i),
          url: e.url,
          title: e.title,
          lastVisitTime: e.lastVisit,
          visitCount: e.visitCount,
          typedCount: 0
        }))
      }
      case 'addUrl':
        history.visit(String(details.url ?? ''), String(details.title ?? ''), null)
        return undefined
      case 'deleteUrl':
        history.delete(String(details.url ?? ''))
        return undefined
      case 'deleteAll':
        history.clear()
        return undefined
    }
    throw new Error(`chrome.history.${method} ${NOT_IMPLEMENTED}`)
  }

  /** Over the core's Chrome-shaped bookmark tree (three roots with fixed ids, `dateAdded`, folders). */
  private bookmarksCall(method: string, args: unknown[]): unknown {
    const bookmarks = this.host.browser.bookmarks
    const node = (b: BookmarkTreeNode): Record<string, unknown> => {
      const out: Record<string, unknown> = {
        id: b.id,
        parentId: b.parentId ?? '0',
        index: b.index,
        title: b.title,
        dateAdded: b.dateAdded
      }
      if (b.type === 'url') out.url = b.url
      else {
        if (b.dateGroupModified !== undefined) out.dateGroupModified = b.dateGroupModified
        if (b.children) out.children = b.children.map(node)
      }
      return out
    }
    const root = (): Record<string, unknown> => ({
      id: '0',
      title: '',
      children: bookmarks.getTree().map(node)
    })
    const ids = (raw: unknown): string[] => (Array.isArray(raw) ? raw : [raw]).map(String)
    switch (method) {
      case 'getTree':
        return [root()]
      case 'getSubTree': {
        const id = String(args[0])
        if (id === '0') return [root()]
        const sub = bookmarks.getSubTree(id)
        if (!sub) throw new Error("Can't find bookmark for id.")
        return [node(sub)]
      }
      case 'getChildren':
        return String(args[0]) === '0'
          ? bookmarks.roots().map(node)
          : bookmarks.getChildren(String(args[0])).map(node)
      case 'getRecent':
        return bookmarks.recent(asNumber(args[0]) ?? 20).map(node)
      case 'get':
        return ids(args[0]).map((id) => {
          const found = bookmarks.get(id)
          if (!found) throw new Error("Can't find bookmark for id.")
          return node(found)
        })
      case 'search': {
        const query = typeof args[0] === 'string' ? args[0] : String(asRecord(args[0]).query ?? '')
        return bookmarks.search(query, 100).map(node)
      }
      case 'create': {
        const props = asRecord(args[0])
        const created = bookmarks.create({
          parentId: typeof props.parentId === 'string' ? props.parentId : undefined,
          index: asNumber(props.index) ?? undefined,
          title: String(props.title ?? props.url ?? ''),
          url: typeof props.url === 'string' ? props.url : undefined,
          type: typeof props.url === 'string' ? 'url' : 'folder'
        })
        if (!created) throw new Error('Could not create bookmark.')
        return node(created)
      }
      case 'update': {
        const changes = asRecord(args[1])
        const updated = bookmarks.update(String(args[0]), {
          title: typeof changes.title === 'string' ? changes.title : undefined,
          url: typeof changes.url === 'string' ? changes.url : undefined
        })
        if (!updated) throw new Error("Can't find bookmark for id.")
        return node(updated)
      }
      case 'move': {
        const destination = asRecord(args[1])
        const current = bookmarks.get(String(args[0]))
        if (!current) throw new Error("Can't find bookmark for id.")
        const parentId =
          typeof destination.parentId === 'string' ? destination.parentId : (current.parentId ?? '')
        if (!bookmarks.move([current.id], parentId, asNumber(destination.index) ?? undefined))
          throw new Error('Could not move bookmark.')
        return node(bookmarks.get(current.id) ?? current)
      }
      case 'remove':
        if (!bookmarks.remove(String(args[0]))) throw new Error("Can't find bookmark for id.")
        return undefined
      case 'removeTree':
        if (!bookmarks.removeTree(String(args[0]))) throw new Error("Can't find bookmark for id.")
        return undefined
    }
    throw new Error(`chrome.bookmarks.${method} ${NOT_IMPLEMENTED}`)
  }

  /**
   * `chrome.permissions`: the granted set is the manifest's required permissions plus the
   * optional ones `request` granted (kept across sessions, as Chrome's prefs keep them). A
   * declared optional permission is granted without a prompt (the prompt is the UI worker's);
   * one the manifest does not offer is refused, as in Chrome. A grant or removal reaches every
   * context of the extension (`ExtensionApiHost.setGrants`: the shims define or delete the
   * namespaces, the next context boots with the set) and fires `onAdded` / `onRemoved`.
   */
  private permissionsCall(ext: AttachedExtension, method: string, args: unknown[]): unknown {
    const { manifest } = ext
    const id = ext.record.id
    const wanted = normalizePermissionSet(args[0] ?? {})
    if (!wanted) throw new Error('Invalid value for argument 1. Property is not an object.')
    const grantedHosts = this.grantedHosts.get(id) ?? new Set<string>()
    const grantedApis = this.grantedApis.get(id) ?? new Set<string>()
    // Host patterns hold by containment, as Chrome's `URLPatternSet` does: an optional
    // `<all_urls>` lets `http://example.com/*` be requested and, granted, answers `contains` for
    // it (the desktop's `permissions.ts` set arithmetic, shared here).
    const sets: ManifestPermissionSets = {
      required: { permissions: [...manifest.permissions], origins: [...manifest.hostPermissions] },
      optional: {
        permissions: [...manifest.optionalPermissions],
        origins: [...manifest.optionalHostPermissions]
      }
    }
    const granted = (): PermissionSet =>
      addPermissionSets(sets.required, {
        permissions: [...grantedApis],
        origins: [...grantedHosts]
      })
    // Kotlin's CORS proxy hears the host patterns only when they moved; the grants and the
    // contexts' shims hear every change.
    const commit = (hostsMoved: boolean): void => {
      if (grantedHosts.size > 0) this.grantedHosts.set(id, grantedHosts)
      else this.grantedHosts.delete(id)
      if (grantedApis.size > 0) this.grantedApis.set(id, grantedApis)
      else this.grantedApis.delete(id)
      if (hostsMoved) this.host.hostsGranted(id, [...grantedHosts])
      this.host.setGrants(
        id,
        { permissions: [...grantedApis], origins: [...grantedHosts] },
        granted().permissions
      )
    }
    switch (method) {
      case 'contains':
        return permissionSetContains(granted(), wanted)
      case 'getAll':
        return granted()
      case 'request': {
        const requestable = requestablePermissions(sets, wanted)
        if (!requestable.ok) throw new Error(requestable.error)
        const missing = missingPermissions(granted(), wanted)
        if (missing.permissions.length === 0 && missing.origins.length === 0) return true
        for (const p of missing.permissions) grantedApis.add(p)
        for (const o of missing.origins) grantedHosts.add(o)
        commit(missing.origins.length > 0)
        this.host.emit(id, 'permissions', 'onAdded', [missing])
        return true
      }
      case 'remove': {
        if (
          wanted.permissions.some((p) => sets.required.permissions.includes(p)) ||
          wanted.origins.some((o) => sets.required.origins.includes(o))
        )
          throw new Error('You cannot remove required permissions.')
        const removedApis = wanted.permissions.filter((p) => grantedApis.delete(p))
        const removedHosts = wanted.origins.filter((o) => grantedHosts.delete(o))
        if (removedApis.length === 0 && removedHosts.length === 0) return true
        commit(removedHosts.length > 0)
        this.host.emit(id, 'permissions', 'onRemoved', [
          { permissions: removedApis, origins: removedHosts }
        ])
        return true
      }
    }
    throw new Error(`chrome.permissions.${method} ${NOT_IMPLEMENTED}`)
  }

  private managementCall(ext: AttachedExtension, method: string, args: unknown[]): unknown {
    const info = (e: AttachedExtension): Record<string, unknown> => ({
      id: e.record.id,
      name: e.manifest.name,
      shortName: e.manifest.name,
      description: e.manifest.description,
      version: e.manifest.version,
      mayDisable: true,
      enabled: this.host.isEnabled(e.record.id),
      isApp: false,
      type: 'extension',
      installType: e.record.source === 'unpacked' ? 'development' : 'normal',
      permissions: e.manifest.permissions,
      hostPermissions: e.manifest.hostPermissions,
      icons: Object.entries(e.manifest.icons).map(([size, path]) => ({
        size: Number(size),
        url: extensionUrl(e.record.id, path)
      }))
    })
    switch (method) {
      case 'getSelf':
        return info(ext)
      case 'getAll':
        return this.host.allAttached().map(info)
      case 'get': {
        const target = this.host.attached(String(args[0]))
        if (!target) throw new Error(`Failed to find extension with id ${String(args[0])}.`)
        return info(target)
      }
      case 'uninstallSelf':
        void this.host.uninstall(ext.record.id)
        return undefined
    }
    throw new Error(`chrome.management.${method} ${NOT_IMPLEMENTED}`)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A badge colour as `setBadgeBackgroundColor` / `setBadgeTextColor` take it: Chrome's
 * `[r, g, b, a]` array (integers 0..255, three or four of them) or any CSS colour string
 * `content::ParseCssColorString` reads (hex, `rgb()` / `rgba()`, `hsl()` / `hsla()`, the named
 * colours, `white` among them), kept as one `rgba()` string the toolbar draws; null for what
 * Chrome refuses ("Invalid value for color.").
 */
function colorString(value: unknown): string | null {
  let rgba: CssRgba | null = null
  if (typeof value === 'string') rgba = parseCssColor(value)
  else if (Array.isArray(value) && (value.length === 3 || value.length === 4)) {
    if (!value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return null
    const [r, g, b, a] = value as number[]
    rgba = [r, g, b, value.length === 4 ? a : 255]
  }
  if (!rgba) return null
  const [r, g, b, a] = rgba
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`
}

/** The stored colour back as Chrome's `ColorArray` (`getBadgeBackgroundColor` / `getBadgeTextColor`). */
function colorArray(value: string): CssRgba {
  return parseCssColor(value) ?? [0, 0, 0, 0]
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/**
 * The URL `tabs.create`, `tabs.update` or `windows.create` names, as Chrome reads it: a
 * fully-qualified URL as it is (Chrome's rule: it "must include a scheme"), anything else a
 * path of the extension's, resolved against its ROOT (`Extension::GetResourceURL`: the
 * extension's origin plus the string, a leading `/` dropped), never against the calling page,
 * wherever the caller sits – Chrome's `ExtensionTabUtil::PrepareURLForNavigation` knows the
 * extension, not the frame – in Chrome's spelling of the extension's origin, which the tab
 * model keeps and the WebView loads as the served one (`ExtensionUrls.toServed`). Awesome
 * Screenshot's worker opens its editor as `tabs.create({ url: 'edit-react.html' })`, which the
 * runtime had loaded as a web URL (`https://edit-react.html`, "Secure connection not
 * available"); FireShot's worker at `scripts/fsServiceWorker.js` opens `fsCaptured.html?id=1`,
 * which resolved against the worker's own directory drew "Webpage not available" for
 * `scripts/fsCaptured.html`. A value no URL parser takes goes through as it was.
 */
export function tabUrlFrom(extensionId: string, url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url
  try {
    return new URL(url.replace(/^\/+/, ''), `${chromeExtensionOrigin(extensionId)}/`).href
  } catch {
    return url
  }
}

/**
 * The page of `offscreen.createDocument({ url })` on the extension's served origin: a path
 * (`offscreen.html`), a `chrome-extension://<id>/...` URL or the served URL itself
 * (`runtime.getURL` answers that here). Another extension's id is not this extension's page.
 */
export function offscreenUrl(id: string, url: string): string {
  const origin = extensionOrigin(id)
  if (url === origin || url.startsWith(origin + '/')) return url
  const scheme = /^chrome-extension:\/\/([a-p]{32})(\/[^#]*)?/.exec(url)
  if (scheme) {
    if (scheme[1] !== id)
      throw new Error(`Invalid URL: "${url}" is not on this extension's origin.`)
    return extensionUrl(id, scheme[2] ?? '/')
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(url))
    throw new Error(`Invalid URL: "${url}" is not on this extension's origin.`)
  return extensionUrl(id, url)
}

export function contextTypeOf(context: EngineContextKind): string {
  switch (context) {
    case 'background':
      return 'BACKGROUND'
    case 'popup':
      return 'POPUP'
    case 'sidePanel':
      return 'SIDE_PANEL'
    case 'offscreen':
      return 'OFFSCREEN_DOCUMENT'
    default:
      return 'TAB'
  }
}

/** One `runtime.getContexts` answer (Chrome's `ExtensionContext`). */
export interface ExtensionContext {
  contextId: string
  contextType: string
  documentId: string
  documentOrigin: string
  documentUrl: string
  frameId: number
  incognito: boolean
  tabId: number
  windowId: number
}

/**
 * `runtime.getContexts(filter)`: every property of Chrome's `ContextFilter` that is given keeps
 * only the contexts whose value is among the listed ones (`incognito` a single boolean); an
 * empty filter keeps them all. Tampermonkey asks for `OFFSCREEN_DOCUMENT` contexts to know
 * whether to create its offscreen document: with the filter ignored it never did.
 */
export function filterContexts(
  contexts: ExtensionContext[],
  filter: Record<string, unknown>
): ExtensionContext[] {
  const listed = (name: string, value: unknown): boolean => {
    const wanted = filter[name]
    if (!Array.isArray(wanted)) return true
    return wanted.some((entry) => entry === value)
  }
  return contexts.filter(
    (context) =>
      listed('contextIds', context.contextId) &&
      listed('contextTypes', context.contextType) &&
      listed('documentIds', context.documentId) &&
      listed('documentOrigins', context.documentOrigin) &&
      listed('documentUrls', context.documentUrl) &&
      listed('frameIds', context.frameId) &&
      listed('tabIds', context.tabId) &&
      listed('windowIds', context.windowId) &&
      (typeof filter.incognito !== 'boolean' || filter.incognito === context.incognito)
  )
}

/**
 * A `userScripts.register` `{ code }` entry in a group's `js` list: the text behind a NUL, a
 * character no extension path carries, so it rides in the same list as the files and keeps its
 * place among them (Chrome runs a registration's entries in order). Kotlin's `UnitCompiler`
 * reads it back (`INLINE_CODE`); `getScripts` reports it as `{ code }` again.
 */
const INLINE_SCRIPT_PREFIX = '\u0000'

export function inlineScript(code: string): string {
  return INLINE_SCRIPT_PREFIX + code
}

/** The code of an inline `js` entry, or null for a file path. */
export function inlineScriptCode(entry: string): string | null {
  return entry.startsWith(INLINE_SCRIPT_PREFIX) ? entry.slice(INLINE_SCRIPT_PREFIX.length) : null
}

/** A `scripting.registerContentScripts` / `userScripts.register` entry, normalised. */
export function registeredFrom(
  raw: Record<string, unknown>,
  defaultWorld: ScriptWorld
): RegisteredContentScript {
  const runAt = raw.runAt
  const world: ScriptWorld =
    raw.world === 'MAIN'
      ? 'MAIN'
      : raw.world === 'USER_SCRIPT' || defaultWorld === 'USER_SCRIPT'
        ? 'USER_SCRIPT'
        : 'ISOLATED'
  return {
    id: String(raw.id ?? ''),
    persistAcrossSessions: raw.persistAcrossSessions !== false,
    matches: asStringArray(raw.matches),
    excludeMatches: asStringArray(raw.excludeMatches),
    includeGlobs: asStringArray(raw.includeGlobs),
    excludeGlobs: asStringArray(raw.excludeGlobs),
    js: asStringArray(raw.js),
    css: asStringArray(raw.css),
    runAt: (runAt === 'document_start' || runAt === 'document_end'
      ? runAt
      : 'document_idle') as RunAt,
    allFrames: Boolean(raw.allFrames),
    matchAboutBlank: Boolean(raw.matchAboutBlank),
    matchOriginAsFallback: Boolean(raw.matchOriginAsFallback),
    world
  }
}

export function registeredToChrome(script: RegisteredContentScript): Record<string, unknown> {
  return {
    id: script.id,
    matches: script.matches,
    excludeMatches: script.excludeMatches,
    js: script.js,
    css: script.css,
    runAt: script.runAt,
    allFrames: script.allFrames,
    matchOriginAsFallback: script.matchOriginAsFallback,
    world: script.world,
    persistAcrossSessions: script.persistAcrossSessions
  }
}
