import type { NetworkStatus } from '../shared/types'
import { ERROR_URL_PREFIX } from '../shared/url'
import type { Browser } from './browser'

/**
 * How long the host's word must hold before the chrome believes it. A switch from Wi-Fi to
 * mobile data reports the old network lost and the new one validated within a second, and the
 * banner must not flash for it (v2 §9.33); the same window on the way back keeps a network that
 * validates and drops again from reloading every error page for nothing.
 */
export const CONNECTIVITY_DEBOUNCE_MS = 1000

/**
 * The `net::` failures that mean the device itself is offline, when the host's word agreed at
 * the time (`ERR_INTERNET_DISCONNECTED` says so by itself; a name that would not resolve or an
 * address that could not be reached does when nothing else could either): the error page they
 * make reloads itself when connectivity returns (ERR-06, Chrome's behaviour).
 */
export const OFFLINE_ERROR_CODES: ReadonlySet<number> = new Set([-106, -105, -109])
const INTERNET_DISCONNECTED = -106

/** The script the core runs in an error page it is about to reload: the page's own busy state (§9.30). */
export const ERROR_PAGE_RELOADING_SCRIPT = "typeof zenReloading==='function'&&zenReloading()"

/**
 * The device's connectivity, host-neutral half (ERR-06, ERR-07). Debounces the host's raw
 * transitions into the one `NetworkStatus` the chrome renders – the phone shell shows "No
 * internet connection" while `online` is false and "Back online" when it turns true again –
 * and reloads, once each, the error pages that stood for being offline when the device comes
 * back: the tab still showing its offline error page reloads with the page's own busy state;
 * one the user navigated away from, closed or unloaded meanwhile does not, and a page nobody is
 * looking at waits for its turn on screen (Chrome reloads visible tabs only). Hosts without a
 * `ConnectivityHost` are online for good and nothing here moves.
 */
export class ConnectivityService {
  private online = true
  /** The host's last word, undebounced: what a failure is judged against. */
  private raw = true
  private pending: { online: boolean; timer: ReturnType<typeof setTimeout> } | null = null
  /** Tabs whose current error page stands for being offline, by tab id. */
  private readonly armed = new Set<string>()
  private unsubscribe: (() => void) | null = null

  constructor(private readonly browser: Browser) {}

  status(): NetworkStatus {
    return { online: this.online }
  }

  /** Read the host's verdict and follow its changes; nothing without a host. */
  start(): void {
    const host = this.browser.platform.connectivity
    if (!host) return
    this.online = this.raw = host.isOnline()
    this.unsubscribe = host.onChange((online) => this.report(online))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.pending) clearTimeout(this.pending.timer)
    this.pending = null
  }

  /**
   * The host's raw word. A change is believed after `CONNECTIVITY_DEBOUNCE_MS` of holding; a word
   * that goes back to what the chrome shows before then is never heard of.
   */
  report(online: boolean): void {
    this.raw = online
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending = null
    }
    if (online === this.online) return
    this.pending = {
      online,
      timer: setTimeout(() => this.settle(online), CONNECTIVITY_DEBOUNCE_MS)
    }
  }

  private settle(online: boolean): void {
    this.pending = null
    if (online === this.online) return
    this.online = online
    this.browser.state.commit()
    if (online) this.reloadOfflinePages()
  }

  /**
   * A tab's load failed with `code`: when that means offline – by the code's own word, or by
   * the host's at the time – the error page it gets reloads itself once the device is back.
   */
  noteFailure(tabId: string, code: number): void {
    if (code === INTERNET_DISCONNECTED || (!this.raw && OFFLINE_ERROR_CODES.has(code)))
      this.armed.add(tabId)
    else this.armed.delete(tabId)
  }

  /** The tab is gone: nothing to reload. */
  forget(tabId: string): void {
    this.armed.delete(tabId)
  }

  /** The tabs coming on screen: an offline error page that waited for its turn reloads now. */
  onTabsShown(tabIds: Iterable<string>): void {
    if (!this.online) return
    for (const tabId of tabIds) if (this.armed.has(tabId)) this.reloadIfOffline(tabId)
  }

  /** Whether `tabId`'s error page is armed to reload when the device comes back (the tests read it). */
  isArmed(tabId: string): boolean {
    return this.armed.has(tabId)
  }

  private reloadOfflinePages(): void {
    const visible = new Set<string>()
    for (const win of this.browser.allWindows())
      for (const tabId of this.browser.tabs.visibleTabIds(win)) visible.add(tabId)
    for (const tabId of [...this.armed]) {
      if (!this.browser.tabs.tab(tabId)) {
        this.armed.delete(tabId)
        continue
      }
      if (visible.has(tabId)) this.reloadIfOffline(tabId)
    }
  }

  /**
   * Reload `tabId` if it is still showing the offline error page it was armed for, once: the
   * arm goes whatever the outcome, and a page that fails again arms itself again through
   * `noteFailure`. A page the user navigated away from, or one unloaded meanwhile (its next
   * load is its own), is left alone.
   */
  private reloadIfOffline(tabId: string): void {
    this.armed.delete(tabId)
    const tab = this.browser.tabs.tab(tabId)
    if (!tab || tab.discarded || !tab.url.startsWith(ERROR_URL_PREFIX)) return
    if (!OFFLINE_ERROR_CODES.has(errorCodeOf(tab.url))) return
    const view = this.browser.tabs.view(tabId)
    if (!view) return
    // The page's own "Reloading…" first; the navigation replaces it when the page answers.
    void view.executeJavaScript(ERROR_PAGE_RELOADING_SCRIPT).catch(() => undefined)
    this.browser.tabs.reload(tabId)
  }
}

/** The `code` of a `zen://error` URL, NaN for none. */
function errorCodeOf(url: string): number {
  try {
    return Number(new URL(url).searchParams.get('code'))
  } catch {
    return NaN
  }
}
