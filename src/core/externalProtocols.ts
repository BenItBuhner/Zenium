import type { ExternalProtocolRequest } from '../shared/types'
import { classifyExternalUrl, intentFallbackUrl, intentPackage } from '../shared/externalProtocols'
import { getHost } from '../shared/url'
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
  request: HostExternalRequest
  scheme: string
  canRemember: boolean
  win: ZenWindow
}

/**
 * Links that leave the web (`mailto:`, `tel:`, `intent://`, a site's own app): the host holds
 * the navigation, the core decides. A scheme the user chose "Always allow" for opens without a
 * question when a tap started it; everything else goes through the confirm sheet in the chrome
 * (`externalProtocol.request` → `externalProtocol.respond`). Schemes that reach into the browser
 * or the device never leave, and an `intent://` nobody can open falls back to its web address.
 */
export class ExternalProtocolService {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly browser: Browser) {}

  request(request: HostExternalRequest, win: ZenWindow = this.browser.focusedWindow()): void {
    const { url } = request
    const cls = classifyExternalUrl(url)
    if (cls.kind === 'blocked') {
      this.answer(request.requestId, false)
      return
    }
    if (request.handler === 'none') {
      this.answer(request.requestId, false)
      this.noHandler(request, win)
      return
    }
    // A verified App Link never gets here (the host opens the app); this is a site's app the host
    // could name but not vouch for, so it asks – and does not remember, the answer is per site.
    const scheme = cls.scheme
    const canRemember = cls.kind === 'external' && cls.canRemember
    const remembered = Boolean(this.browser.state.settings.externalProtocols[scheme])
    // A remembered scheme still needs a tap behind it: a page must not dial on load.
    if (remembered && request.userGesture) {
      this.answer(request.requestId, true)
      return
    }
    // One question per tab: a newer request from the same page takes the sheet over.
    for (const [id, p] of this.pending) {
      if (p.request.tabId !== request.tabId) continue
      if (!request.userGesture) {
        // A script firing without a tap does not get to replace the question the user is reading.
        this.answer(request.requestId, false)
        return
      }
      this.pending.delete(id)
      this.answer(id, false)
      this.browser.emit('externalProtocol.cancel', { requestId: id }, p.win)
    }
    this.pending.set(request.requestId, { request, scheme, canRemember, win })
    const payload: ExternalProtocolRequest = {
      requestId: request.requestId,
      url,
      scheme,
      appName: request.appName,
      site: this.siteOf(request.tabId),
      canRemember
    }
    this.browser.emit('externalProtocol.request', payload, win)
  }

  /** The sheet's answer (or its dismissal, which is a "not now"). */
  respond(requestId: string, allow: boolean, always: boolean): void {
    const p = this.pending.get(requestId)
    if (!p) return
    this.pending.delete(requestId)
    if (allow && always && p.canRemember) {
      const { settings } = this.browser.state
      settings.externalProtocols = { ...settings.externalProtocols, [p.scheme]: true }
      this.browser.state.commit()
    }
    this.answer(requestId, allow)
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
      if (p.request.tabId !== tabId) continue
      this.pending.delete(id)
      this.answer(id, false)
      this.browser.emit('externalProtocol.cancel', { requestId: id }, p.win)
    }
  }

  private answer(requestId: string, allow: boolean): void {
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

  private siteOf(tabId: string | null): string {
    const tab = tabId ? this.browser.tabs.tab(tabId) : undefined
    return tab ? getHost(tab.url) : ''
  }
}
