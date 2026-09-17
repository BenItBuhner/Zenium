import type { ExternalProtocolRequest } from '../shared/types'
import {
  classifyExternalUrl,
  externalPermission,
  intentFallbackUrl,
  intentPackage
} from '../shared/externalProtocols'
import { getHost } from '../shared/url'
import { newId } from '../shared/ids'
import type { Browser } from './browser'
import type { ZenWindow } from './window'

/** What the host knows about a navigation that would leave the browser. */
export interface HostExternalRequest {
  requestId: string
  /** The tab whose page asked; null for the chrome itself. */
  tabId: string | null
  url: string
  /** Name of the app that would open the link, when the host could tell. */
  appName: string | null
  /**
   * `none` when the host is sure no app can open it, `known` when it found one, `unknown` when
   * it cannot see the apps for the scheme (Android's package visibility): the launch decides.
   */
  handler: 'known' | 'none' | 'unknown'
  /** The navigation came from a user gesture (a tap), not from a script or a redirect alone. */
  userGesture: boolean
}

interface Pending {
  requestId: string
  win: ZenWindow
  tabId: string | null
  url: string
  scheme: string
  initiatorUrl: string
  canRemember: boolean
  appName: string | null
  /** Host-callback style (Android): answer the held navigation. */
  hostRequest: HostExternalRequest | null
  resolve: ((allow: boolean) => void) | null
}

/**
 * Links that leave the web (`mailto:`, `tel:`, `intent://`, `magnet:`, a custom scheme). The host
 * holds the navigation (Android) or intercepts it (desktop); the core decides. A remembered
 * "Always allow" opens without a question: Android stores the scheme in
 * `settings.externalProtocols`, desktop stores `<origin>|external:<scheme>` through
 * PermissionService (private windows never persist). Everything else goes through the chrome
 * (`externalProtocol.request` → `externalProtocol.respond`).
 */
export class ExternalProtocolService {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly browser: Browser) {}

  request(request: HostExternalRequest, win: ZenWindow = this.browser.focusedWindow()): void {
    const { url } = request
    const cls = classifyExternalUrl(url)
    if (cls.kind === 'blocked') {
      this.answerHost(request.requestId, false)
      return
    }
    if (request.handler === 'none') {
      this.answerHost(request.requestId, false)
      this.noHandler(request, win)
      return
    }
    const scheme = cls.scheme
    const initiatorUrl = this.initiatorOf(request.tabId)
    const schemeAllows = cls.kind === 'external' && cls.canRemember
    const canRemember = this.rememberAllowed(request.tabId, schemeAllows, false)
    if (this.alreadyAllowed(scheme, initiatorUrl, request.tabId) && request.userGesture) {
      this.answerHost(request.requestId, true)
      return
    }
    if (!request.userGesture && this.hasPendingFor(request.tabId)) {
      this.answerHost(request.requestId, false)
      return
    }
    this.replacePendingFor(request.tabId, request.userGesture)
    this.enqueue({
      requestId: request.requestId,
      win,
      tabId: request.tabId,
      url,
      scheme,
      initiatorUrl,
      canRemember,
      appName: request.appName,
      hostRequest: request,
      resolve: null
    })
  }

  /**
   * Decide whether `url`, requested by the page at `initiatorUrl` in `tabId`, may be handed to
   * the OS. Resolves once the user answered (or straight away for a remembered "Always allow").
   * Like Chrome, a tab gets one dialog at a time: requests arriving while it is open are declined.
   */
  ask(url: string, initiatorUrl: string, tabId: string | null): Promise<boolean> {
    const cls = classifyExternalUrl(url)
    if (cls.kind !== 'external') return Promise.resolve(false)
    if (tabId && this.hasPendingFor(tabId)) return Promise.resolve(false)
    const scheme = cls.scheme
    const canRemember = this.rememberAllowed(tabId, cls.canRemember, true)
    if (this.alreadyAllowed(scheme, initiatorUrl, tabId)) return Promise.resolve(true)
    const win = tabId ? this.browser.tabs.windowFor(tabId) : this.browser.focusedWindow()
    const requestId = newId('ext')
    return new Promise<boolean>((resolve) => {
      this.enqueue({
        requestId,
        win,
        tabId,
        url,
        scheme,
        initiatorUrl,
        canRemember,
        appName: null,
        hostRequest: null,
        resolve
      })
    })
  }

  /** Decide and, when allowed, launch: for callers that are not inside a host callback. */
  async open(url: string, initiatorUrl: string, tabId: string | null): Promise<void> {
    if (await this.ask(url, initiatorUrl, tabId)) this.browser.platform.shell.openExternal(url)
  }

  /** The sheet's answer (or its dismissal, which is a "not now"). */
  respond(requestId: string, allow: boolean, always: boolean): void {
    const p = this.pending.get(requestId)
    if (!p) return
    this.pending.delete(requestId)
    if (allow && always && p.canRemember) this.persist(p)
    if (p.hostRequest) this.answerHost(requestId, allow)
    p.resolve?.(allow)
  }

  /** Settings: stop opening a scheme without asking. */
  forget(scheme: string): void {
    const { settings } = this.browser.state
    if (!(scheme in settings.externalProtocols)) return
    const next = { ...settings.externalProtocols }
    delete next[scheme]
    settings.externalProtocols = next
    this.browser.state.commit()
  }

  /** The tab that asked closed: take its question down. */
  cancelForTab(tabId: string): void {
    for (const [id, p] of this.pending) {
      if (p.tabId !== tabId) continue
      this.pending.delete(id)
      if (p.hostRequest) this.answerHost(id, false)
      if (p.win.alive) p.win.send('externalProtocol.cancel', { requestId: id })
      p.resolve?.(false)
    }
  }

  private enqueue(p: Pending): void {
    this.pending.set(p.requestId, p)
    const payload: ExternalProtocolRequest = {
      requestId: p.requestId,
      url: p.url,
      scheme: p.scheme,
      appName: p.appName,
      site: getHost(p.initiatorUrl) || this.siteOf(p.tabId),
      tabId: p.tabId,
      canRemember: p.canRemember
    }
    this.browser.emit('externalProtocol.request', payload, p.win)
  }

  private persist(p: Pending): void {
    this.browser.permissions.remember(externalPermission(p.scheme), p.initiatorUrl, 'allow')
    // Android remembers at scheme level; desktop origin keys live in permissions.json only.
    if (p.hostRequest) {
      const { settings } = this.browser.state
      settings.externalProtocols = { ...settings.externalProtocols, [p.scheme]: true }
      this.browser.state.commit()
    }
  }

  private alreadyAllowed(scheme: string, initiatorUrl: string, tabId: string | null): boolean {
    const tab = this.browser.tabs.tab(tabId)
    if (tab && this.browser.tabs.isPrivate(tab)) return false
    if (this.browser.permissions.stored(externalPermission(scheme), initiatorUrl) === 'allow')
      return true
    return Boolean(this.browser.state.settings.externalProtocols[scheme])
  }

  /**
   * `originScoped` (desktop): "Always allow" needs a real tab and a host, and never a private
   * window. Android still offers it for the scheme even when the page's host is empty.
   */
  private rememberAllowed(
    tabId: string | null,
    schemeAllows: boolean,
    originScoped: boolean
  ): boolean {
    if (!schemeAllows) return false
    const tab = this.browser.tabs.tab(tabId)
    if (tab && this.browser.tabs.isPrivate(tab)) return false
    if (!originScoped) return true
    return tab !== undefined && getHost(tab.url) !== ''
  }

  private initiatorOf(tabId: string | null): string {
    const tab = tabId ? this.browser.tabs.tab(tabId) : undefined
    return tab?.url ?? ''
  }

  private siteOf(tabId: string | null): string {
    return getHost(this.initiatorOf(tabId))
  }

  private hasPendingFor(tabId: string | null): boolean {
    if (!tabId) return false
    for (const entry of this.pending.values()) if (entry.tabId === tabId) return true
    return false
  }

  private replacePendingFor(tabId: string | null, userGesture: boolean): void {
    if (!tabId) return
    for (const [id, p] of this.pending) {
      if (p.tabId !== tabId) continue
      if (!userGesture) return
      this.pending.delete(id)
      if (p.hostRequest) this.answerHost(id, false)
      this.browser.emit('externalProtocol.cancel', { requestId: id }, p.win)
      p.resolve?.(false)
    }
  }

  private answerHost(requestId: string, allow: boolean): void {
    this.browser.platform.externalProtocols?.respond(requestId, allow)
  }

  /**
   * Nothing on the device opens the link. An `intent://` names what should: its web fallback
   * loads in the tab, or the store listing of the app it wants (Chrome does the same); anything
   * else is a toast.
   */
  private noHandler(request: HostExternalRequest, win: ZenWindow): void {
    const fallback = intentFallbackUrl(request.url)
    const pkg = fallback ? null : intentPackage(request.url)
    const target =
      fallback ??
      (pkg ? `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}` : null)
    if (target) {
      const tab = request.tabId ? this.browser.tabs.tab(request.tabId) : undefined
      if (tab) this.browser.tabs.navigate(tab.id, target)
      else this.browser.openExternalUrl(target, win)
      return
    }
    this.browser.toast('No app can open this link', 'info', win)
  }
}
