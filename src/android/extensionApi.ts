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
import type { EngineContextKind } from '@core/extensions/api/engine'
import type { LocaleMessages } from '@core/extensions/api/i18n'
import { globToRegExp, matchesAnyPattern } from '@core/extensions/api/matchPattern'
import type { ExtensionRecord } from '@core/extensions/registry'
import type { RunAt, RuntimeManifest, ScriptWorld } from '@core/extensions/runtime/manifest'
import { extensionUrl, type RegisteredContentScript } from '@core/extensions/runtime/plan'
import type { Endpoint, MessageRouter } from '@core/extensions/runtime/router'
import { ActiveTabGrants } from './extensionActiveTab'
import { AndroidContextMenus } from './extensionContextMenus'
import { AndroidCookies, type JarReading } from './extensionCookies'
import type { AndroidDeclarativeNetRequest } from './extensionDnr'
import type { AndroidIdentity } from './extensionIdentity'
import { AndroidNotifications, type ShownNotification } from './extensionNotifications'

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
 * blocking engine).
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
  /** Raise `chrome.<ns>.<name>` in every endpoint of one extension that listens for it. */
  emit(extensionId: string, ns: string, name: string, args: unknown[]): void
  /** Deliver `chrome.<ns>.<name>` to one endpoint, listener or not (a `contextMenus` `onclick` holder). */
  emitTo(endpointId: string, ns: string, name: string, args: unknown[]): void
  /** The extension's toolbar icon as a `data:` URL, when the store has read it. */
  icon(id: string): string | null
  readFile(id: string, path: string): Promise<string | null>
  exec(request: ExecRequest): Promise<unknown>
  /** The cookies a request to `url` from the container's jar would carry (`chrome.cookies`). */
  readCookies(containerId: string, url: string): Promise<JarReading>
  /** Store a `Set-Cookie` line against `url` in the container's jar; false when it was refused. */
  writeCookie(containerId: string, url: string, setCookie: string): Promise<boolean>
  /** The optional host permissions an extension holds right now (`permissions.request` / `remove`); Kotlin's CORS proxy reads them. */
  hostsGranted(id: string, hosts: string[]): void
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
  openPopup(id: string): void
  openOptions(id: string): void
  /** `runtime.reload()` and `management.uninstallSelf()`: the store re-reads or removes the extension. */
  reload(id: string): Promise<void>
  uninstall(id: string): Promise<void>
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
      url: tab.url,
      pendingUrl: tab.loading ? tab.url : undefined,
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
}

export class ExtensionApi {
  readonly tabs: TabIds
  readonly contextMenus: AndroidContextMenus
  readonly activeTab: ActiveTabGrants
  readonly cookies: AndroidCookies
  readonly notifications: AndroidNotifications
  private readonly actions = new Map<string, ActionRecord>()
  /** Optional host permissions granted this session, per extension (Chrome persists them; W2-3 may). */
  private readonly grantedHosts = new Map<string, Set<string>>()
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
      grantActiveTab: (id, tab) => this.activeTab.grant(id, tab)
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
  }

  /** The extension is going away: drop what this layer remembers about it. */
  forget(id: string): void {
    this.actions.delete(id)
    this.contextMenus.forget(id)
    this.activeTab.forget(id)
    this.grantedHosts.delete(id)
    this.captureQuota.forget(id)
    this.notifications.forget(id)
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
        return this.runtimeCall(ext, method)
      case 'declarativeNetRequest':
        return this.host.dnr.call(ext, method, args)
      case 'notifications':
        return this.notifications.call(ext, method, args)
      case 'contextMenus':
        return this.contextMenus.call(ext, endpoint.id, method, args)
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
      case 'extension':
        // The store's record carries both toggles (the runtime scopes tabs, events and rules by them).
        if (method === 'isAllowedFileSchemeAccess') return ext.record.allowFileAccess === true
        if (method === 'isAllowedIncognitoAccess') return ext.record.allowPrivate === true
        break
      case 'offscreen':
        if (method === 'hasDocument') return false
        if (method === 'closeDocument') return undefined
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
              if (!matchesAnyPattern(tab.url, patterns)) return false
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
        // Extension pages have no tab of their own; content scripts get theirs.
        if (endpoint.context === 'content' && endpoint.tabId) {
          const tab = tabs.tab(endpoint.tabId)
          return tab ? ids.chromeTab(tab) : undefined
        }
        return undefined
      }
      case 'create': {
        const props = asRecord(args[0])
        const tab = tabs.createTab(
          {
            url: typeof props.url === 'string' ? props.url : undefined,
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
        if (typeof props.url === 'string') tabs.navigate(target.id, props.url)
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
    }
    throw new Error(`chrome.tabs.${method} ${NOT_IMPLEMENTED}`)
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
    if (windowId !== undefined && windowId !== null && windowId !== -2 && windowId !== 1) {
      if (asNumber(windowId) === null || !Number.isInteger(windowId))
        throw new Error('Invalid window id')
      throw new Error(`No window with id: ${windowId}.`)
    }
    const tab = this.tabs.activeTabFor(ext)
    if (!tab || tab.discarded) throw new Error('Failed to capture tab: view is invisible')
    const denial = captureDenial(tab.url, {
      allUrls: coversAllUrls(this.hostPatterns(ext)),
      activeTab: this.activeTab.allowsUrl(ext.record.id, tab.url),
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
    const code =
      typeof details.code === 'string'
        ? details.code
        : await this.host.readFile(id, String(details.file ?? ''))
    const frames = this.targetFrames(ext, target, details)
    if (kind === 'js') {
      const results = await this.injectFrames(frames, (frameId) =>
        this.host.exec({
          extensionId: id,
          tabId: target.id,
          frameId,
          kind: 'js',
          payload: { world: 'ISOLATED' },
          code: code ?? '',
          funcSource: null,
          args: null
        })
      )
      return results.map((r) => r.value)
    }
    const cssId = typeof details.file === 'string' ? details.file : (code ?? '')
    await this.injectFrames(frames, (frameId) =>
      this.host.exec({
        extensionId: id,
        tabId: target.id,
        frameId,
        kind: 'css',
        payload: { id: cssId, code: code ?? '' },
        code: null,
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
          this.host.browser.tabs.createTab({ url, active: true }, this.host.window())
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
        return colorArray(state.badgeBackgroundColor)
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
        this.host.openPopup(id)
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
        let code: string | null = null
        let funcSource: string | null = null
        let funcArgs: unknown[] | null = null
        if (typeof injection.funcSource === 'string') {
          funcSource = injection.funcSource
          funcArgs = Array.isArray(injection.args) ? injection.args : []
        } else {
          const sources: string[] = []
          for (const file of asStringArray(injection.files)) {
            const text = await this.host.readFile(id, file)
            if (text === null) throw new Error(`Could not load file: '${file}'.`)
            sources.push(text)
          }
          code = sources.join('\n;\n')
        }
        const results = await this.injectFrames(frames, (frameId) =>
          this.host.exec({
            extensionId: id,
            tabId: tab.id,
            frameId,
            kind: 'js',
            payload: { world },
            code,
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
   * `chrome`); `js` entries are `{ file }` / `{ code }` objects, only files are injected here.
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
      const js = Array.isArray(script.js) ? script.js.map((j) => asRecord(j).file) : []
      return {
        ...script,
        js: asStringArray(js),
        world: script.world === 'MAIN' ? 'MAIN' : 'USER_SCRIPT'
      }
    }
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
          .map((s) => ({ ...registeredToChrome(s), js: s.js.map((file) => ({ file })) }))
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
    }
    throw new Error(`chrome.userScripts.${method} ${NOT_IMPLEMENTED}`)
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

  private async runtimeCall(ext: AttachedExtension, method: string): Promise<unknown> {
    const id = ext.record.id
    switch (method) {
      case 'openOptionsPage':
        if (!ext.manifest.options) throw new Error('Could not create an options page.')
        this.host.openOptions(id)
        return undefined
      case 'reload':
        await this.host.reload(id)
        return undefined
      case 'getContexts':
        return this.host.router.of(id).map((e) => ({
          contextId: e.id,
          contextType: contextTypeOf(e.context),
          documentId: e.id,
          documentOrigin: e.url ? safeOrigin(e.url) : '',
          documentUrl: e.url,
          frameId: e.frameId,
          incognito: false,
          tabId: e.tabId ? this.tabs.chromeIdFor(e.tabId) : -1,
          windowId: 1
        }))
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
          url: tab.url,
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

  private permissionsCall(ext: AttachedExtension, method: string, args: unknown[]): unknown {
    const { manifest } = ext
    const id = ext.record.id
    const wanted = asRecord(args[0])
    const permissions = asStringArray(wanted.permissions)
    const origins = asStringArray(wanted.origins)
    const granted = this.grantedHosts.get(id) ?? new Set<string>()
    const hosts = (): string[] => [...manifest.hostPermissions, ...granted]
    const has = (): boolean =>
      permissions.every((p) => manifest.permissions.includes(p)) &&
      origins.every((o) => hosts().includes(o) || manifest.hostPermissions.includes('<all_urls>'))
    switch (method) {
      case 'contains':
        return has()
      case 'getAll':
        return { permissions: manifest.permissions, origins: hosts() }
      case 'request': {
        // Optional permissions declared in the manifest are granted without a prompt (the prompt
        // is the UI worker's); what is not declared is refused, as in Chrome.
        const allowed =
          permissions.every(
            (p) => manifest.permissions.includes(p) || manifest.optionalPermissions.includes(p)
          ) &&
          origins.every(
            (o) =>
              manifest.hostPermissions.includes(o) || manifest.optionalHostPermissions.includes(o)
          )
        if (!allowed) return false
        const added = origins.filter(
          (o) => !manifest.hostPermissions.includes(o) && !granted.has(o)
        )
        if (added.length > 0) {
          for (const o of added) granted.add(o)
          this.grantedHosts.set(id, granted)
          this.host.hostsGranted(id, [...granted])
        }
        return true
      }
      case 'remove': {
        // Required permissions cannot be removed; optional ones granted here can.
        if (origins.some((o) => manifest.hostPermissions.includes(o))) return false
        const removed = origins.filter((o) => granted.delete(o))
        if (removed.length > 0) this.host.hostsGranted(id, [...granted])
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

function colorString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length >= 3) {
    const [r, g, b, a] = value.map(Number)
    return `rgba(${r}, ${g}, ${b}, ${a === undefined ? 1 : a / 255})`
  }
  return null
}

function colorArray(value: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value)
  if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16), 255]
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value)
  if (rgba) {
    const [r, g, b, a] = rgba[1].split(',').map((s) => Number(s.trim()))
    return [r || 0, g || 0, b || 0, a === undefined ? 255 : Math.round(a * 255)]
  }
  return [0, 0, 0, 255]
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

export function contextTypeOf(context: EngineContextKind): string {
  switch (context) {
    case 'background':
      return 'BACKGROUND'
    case 'popup':
      return 'POPUP'
    case 'offscreen':
      return 'OFFSCREEN_DOCUMENT'
    default:
      return 'TAB'
  }
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
