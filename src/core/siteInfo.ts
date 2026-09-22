import {
  cookieHosts,
  describeSite,
  hostOf,
  inferHttpOnly,
  otherSites,
  refusedCertificate,
  type SiteCertificate,
  type SiteCookie,
  type SiteInfo,
  type SiteInfoSnapshot,
  type SitePermission,
  type ThirdPartyCookies
} from '../shared/siteInfo'
import type { SiteDataSiteState } from '../shared/siteData'
import type { CertificateError } from '../shared/types'
import type { Browser } from './browser'
import type { SiteStorageReading, TabView } from './platform'

/** What the page itself reports about its state (read with one script, see `PAGE_PROBE`). */
export interface PageProbe {
  /** Names in `document.cookie` (null when the page could not be asked). */
  documentCookies: string[] | null
  /** Hosts the page loaded subresources from, with counts. */
  hosts: Array<{ host: string; count: number }>
  /** Subresources fetched over plain http. */
  httpResources: number
  localStorageItems: number | null
  sessionStorageItems: number | null
  serviceWorkers: number | null
  estimate: { usage: number; quota: number } | null
}

export const EMPTY_PROBE: PageProbe = {
  documentCookies: null,
  hosts: [],
  httpResources: 0,
  localStorageItems: null,
  sessionStorageItems: null,
  serviceWorkers: null,
  estimate: null
}

/**
 * Runs in the page: cookie names the document can see, the hosts of its subresources (with
 * how many came over plain http), Web Storage item counts, service-worker registrations and the
 * origin's storage estimate. Everything is best effort – a sandboxed or opaque origin throws on
 * `localStorage`, which simply leaves that reading unknown. Kept as one arrow expression so both
 * hosts can run it as-is and await the promise it returns.
 */
const PAGE_PROBE = `(() => {
  const out = { documentCookies: null, hosts: [], httpResources: 0, localStorageItems: null, sessionStorageItems: null, serviceWorkers: null, estimate: null };
  try { const raw = document.cookie; out.documentCookies = raw ? raw.split('; ').map((c) => { const i = c.indexOf('='); return i < 0 ? '' : c.slice(0, i) }) : [] } catch (e) {}
  try {
    const counts = {};
    for (const entry of performance.getEntriesByType('resource')) {
      try { const u = new URL(entry.name); if (u.protocol === 'http:') out.httpResources++; counts[u.hostname] = (counts[u.hostname] || 0) + 1 } catch (e) {}
    }
    out.hosts = Object.keys(counts).map((host) => ({ host, count: counts[host] })).sort((a, b) => b.count - a.count).slice(0, 48)
  } catch (e) {}
  try { out.localStorageItems = localStorage.length } catch (e) {}
  try { out.sessionStorageItems = sessionStorage.length } catch (e) {}
  const tasks = [];
  try { if (navigator.storage && navigator.storage.estimate) tasks.push(navigator.storage.estimate().then((e) => { out.estimate = { usage: e.usage || 0, quota: e.quota || 0 } }, () => {})) } catch (e) {}
  try { if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) tasks.push(navigator.serviceWorker.getRegistrations().then((r) => { out.serviceWorkers = r.length }, () => {})) } catch (e) {}
  return Promise.all(tasks).then(() => out, () => out)
})()`

/**
 * Runs in the page before its storage is deleted: the parts a host cannot reach per origin from
 * the outside (Web Storage on Android) and the service workers that would otherwise revive
 * caches. The host clears the rest.
 */
const PAGE_CLEAR = `(() => {
  try { localStorage.clear() } catch (e) {}
  try { sessionStorage.clear() } catch (e) {}
  const tasks = [];
  try { if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) tasks.push(navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister())), () => {})) } catch (e) {}
  try { if (window.caches && caches.keys) tasks.push(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))), () => {})) } catch (e) {}
  try { if (indexedDB.databases) tasks.push(indexedDB.databases().then((dbs) => { for (const db of dbs) if (db.name) indexedDB.deleteDatabase(db.name) }, () => {})) } catch (e) {}
  return Promise.all(tasks).then(() => true, () => true)
})()`

/** Up to this many embedded sites are checked for cookies of their own. */
const THIRD_PARTY_LIMIT = 8
/** A page that never answers the probe (frozen, mid-navigation) must not hold the sheet up. */
const PAGE_SCRIPT_TIMEOUT_MS = 4000

export interface ComposeInput {
  tabId: string
  url: string
  containerId: string
  cookies: SiteCookie[] | null
  thirdParty: ThirdPartyCookies[]
  storage: SiteStorageReading | null
  certificate: SiteCertificate | null
  probe: PageProbe
  permissions: SitePermission[]
  /** The tab's certificate error (interstitial showing, or proceeded past), if any. */
  certificateError?: CertificateError | null
  /** The per-site cookie policy's word for the page; the default where none was asked. */
  siteData?: SiteDataSiteState
}

/** What a page without a site (or a test without a policy) shows for the cookie policy. */
export const DEFAULT_SITE_DATA_STATE: SiteDataSiteState = {
  state: 'default',
  pattern: null,
  addable: null,
  default: 'block-third-party'
}

/** Pure assembly of the readings into what the chrome shows. */
export function composeSiteInfo(input: ComposeInput): SiteInfo {
  const site = describeSite(input.url)
  const cookies = inferHttpOnly(input.cookies ?? [], input.probe.documentCookies)
  const storageOrigins = new Set(input.storage?.origins ?? [])
  const usage = input.storage?.usageBytes ?? input.probe.estimate?.usage ?? null
  const quota = input.storage?.quotaBytes ?? input.probe.estimate?.quota ?? null
  // An https connection over a certificate that failed verification is not secure, whether the
  // interstitial is showing or the user proceeded; the certificate shown is the refused one.
  const certificateError =
    site.state === 'secure' && input.certificateError ? input.certificateError : null
  const mixedContent =
    site.state === 'secure' && !certificateError && input.probe.documentCookies !== null
      ? input.probe.httpResources > 0
      : null
  return {
    tabId: input.tabId,
    url: input.url,
    host: site.host,
    site: site.site,
    origin: site.origin,
    containerId: input.containerId,
    security: {
      state: certificateError ? 'insecure' : site.state,
      certificate: certificateError
        ? refusedCertificate(certificateError)
        : site.state === 'secure'
          ? input.certificate
          : null,
      mixedContent,
      ...(certificateError ? { certificateError } : {})
    },
    cookies: { items: cookies, thirdParty: input.thirdParty },
    storage: {
      usageBytes: usage,
      quotaBytes: quota,
      origins: [...storageOrigins].sort(),
      localStorageItems: input.probe.localStorageItems,
      sessionStorageItems: input.probe.sessionStorageItems,
      serviceWorkers: input.probe.serviceWorkers
    },
    permissions: input.permissions,
    siteData: input.siteData ?? DEFAULT_SITE_DATA_STATE
  }
}

/**
 * Site information for the tab's current page, and the actions of the sheet: clear the site's
 * cookies, clear everything it stored, forget its permissions. Reads go to the host's cookie
 * jar and storage layer (per container) and to the page itself; nothing is cached, every open
 * of the sheet reads afresh.
 */
export class SiteInfoService {
  constructor(private readonly browser: Browser) {}

  async info(tabId: string): Promise<SiteInfo | null> {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab) return null
    const url = tab.url
    const site = describeSite(url)
    const host = this.browser.platform.siteData
    const view = this.browser.tabs.view(tabId)
    const permissions = site.origin
      ? this.browser.permissions.listForOrigin(site.origin)
      : ([] as SitePermission[])
    const certificateError = tab.certificateError ?? null
    const siteData = this.browser.siteData.siteState(site.web ? url : '')
    if (!site.web) {
      return composeSiteInfo({
        tabId,
        url,
        containerId: tab.containerId,
        cookies: null,
        thirdParty: [],
        storage: null,
        certificate: null,
        probe: EMPTY_PROBE,
        permissions,
        certificateError,
        siteData
      })
    }
    const pageUrl = `${site.scheme}://${site.host}${site.path}`
    const [cookies, storage, certificate, probe] = await Promise.all([
      host ? quiet(host.cookies(tab.containerId, pageUrl)) : Promise.resolve(null),
      host ? quiet(host.storage(tab.containerId, site.site)) : Promise.resolve(null),
      // The refused certificate is already known; the engine's reading would be of the error page.
      site.state === 'secure' && !certificateError && view?.certificate
        ? quiet(view.certificate())
        : Promise.resolve(null),
      view && sameDocument(view, url) ? this.probe(view) : Promise.resolve(EMPTY_PROBE)
    ])
    const thirdParty =
      host && probe.hosts.length > 0
        ? await this.thirdPartyCookies(host, tab.containerId, otherSites(probe.hosts, site.site))
        : []
    return composeSiteInfo({
      tabId,
      url,
      containerId: tab.containerId,
      cookies,
      thirdParty,
      storage,
      certificate: certificate ?? null,
      probe,
      permissions,
      certificateError,
      siteData
    })
  }

  /**
   * `info` plus what the desktop popover shows on top: the requests the blocker refused on the
   * page, whether the site is excepted from blocking, and whether the tab is private.
   */
  async snapshot(tabId: string): Promise<SiteInfoSnapshot | null> {
    const info = await this.info(tabId)
    const tab = this.browser.tabs.tab(tabId)
    if (!info || !tab) return null
    const blocking = this.browser.blocking
    return {
      ...info,
      blocking: {
        blockedCount: tab.blockedCount,
        enabled: blocking.enabled,
        excepted: blocking.isExcepted(tab.url),
        available: this.browser.state.capabilities.requestBlocking
      },
      isPrivate: this.browser.tabs.isPrivate(tab)
    }
  }

  /** Remove the cookies of the tab's site; resolves with how many were removed. */
  async clearCookies(tabId: string): Promise<{ removed: number }> {
    const tab = this.browser.tabs.tab(tabId)
    const host = this.browser.platform.siteData
    if (!tab || !host) return { removed: 0 }
    const site = describeSite(tab.url)
    if (!site.web) return { removed: 0 }
    const removed = await host.clearCookies(
      tab.containerId,
      `${site.scheme}://${site.host}${site.path}`
    )
    return { removed }
  }

  /**
   * Remove everything the site stored – cookies, Web Storage, IndexedDB, caches, service
   * workers – and its permissions, then reload the page so it starts from nothing.
   */
  async clearData(tabId: string): Promise<void> {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab) return
    const site = describeSite(tab.url)
    if (!site.web) return
    const host = this.browser.platform.siteData
    const view = this.browser.tabs.view(tabId)
    if (view && sameDocument(view, tab.url))
      await quiet(withTimeout(view.executeJavaScript(PAGE_CLEAR), PAGE_SCRIPT_TIMEOUT_MS))
    if (host) {
      const pageUrl = `${site.scheme}://${site.host}${site.path}`
      const reading = await quiet(host.storage(tab.containerId, site.site))
      const origins = new Set(reading?.origins ?? [])
      for (const h of cookieHosts(site.host)) {
        origins.add(`https://${h}`)
        origins.add(`http://${h}`)
      }
      origins.add(site.origin)
      await quiet(host.clearCookies(tab.containerId, pageUrl))
      await quiet(host.clearStorage(tab.containerId, site.site, [...origins]))
    }
    this.browser.permissions.resetOrigin(site.origin)
    this.browser.tabs.reload(tabId, true)
  }

  /** Forget one (or every) permission decision of the site and reload so live grants end. */
  resetPermissions(tabId: string, permission?: string): void {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab) return
    const site = describeSite(tab.url)
    if (!site.origin) return
    this.browser.permissions.resetOrigin(site.origin, permission)
    this.browser.tabs.reload(tabId)
  }

  private async probe(view: TabView): Promise<PageProbe> {
    const raw = await quiet(withTimeout(view.executeJavaScript(PAGE_PROBE), PAGE_SCRIPT_TIMEOUT_MS))
    return parseProbe(raw)
  }

  private async thirdPartyCookies(
    host: NonNullable<Browser['platform']['siteData']>,
    containerId: string,
    sites: string[]
  ): Promise<ThirdPartyCookies[]> {
    const checks = sites.slice(0, THIRD_PARTY_LIMIT).map(async (site) => {
      const cookies = await quiet(host.cookies(containerId, `https://${site}/`))
      return { site, count: cookies?.length ?? 0 }
    })
    return (await Promise.all(checks)).filter((entry) => entry.count > 0)
  }
}

/** Shape whatever the page answered into a `PageProbe`, defaulting every missing reading. */
export function parseProbe(raw: unknown): PageProbe {
  if (!raw || typeof raw !== 'object') return EMPTY_PROBE
  const r = raw as Record<string, unknown>
  const int = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null
  const hosts = Array.isArray(r.hosts)
    ? r.hosts
        .map((h) => {
          const e = h as { host?: unknown; count?: unknown }
          return { host: hostOf(`https://${String(e.host ?? '')}/`), count: int(e.count) ?? 0 }
        })
        .filter((h) => h.host !== '')
    : []
  const estimate =
    r.estimate && typeof r.estimate === 'object'
      ? {
          usage: int((r.estimate as { usage?: unknown }).usage) ?? 0,
          quota: int((r.estimate as { quota?: unknown }).quota) ?? 0
        }
      : null
  return {
    documentCookies: Array.isArray(r.documentCookies)
      ? r.documentCookies.map((n) => String(n))
      : null,
    hosts,
    httpResources: int(r.httpResources) ?? 0,
    localStorageItems: int(r.localStorageItems),
    sessionStorageItems: int(r.sessionStorageItems),
    serviceWorkers: int(r.serviceWorkers),
    estimate
  }
}

/** The view still shows the page the tab model describes (not an error page or a later URL). */
function sameDocument(view: TabView, url: string): boolean {
  const current = view.getURL()
  return current === url || (current !== '' && hostOf(current) === hostOf(url))
}

/** Best effort: a failing reading leaves its section unknown instead of failing the sheet. */
async function quiet<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise
  } catch {
    return null
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
