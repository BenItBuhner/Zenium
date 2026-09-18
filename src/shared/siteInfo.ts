/**
 * Site information ("page info"): what the browser knows about the site a tab is on – the
 * connection, its cookies, stored data and the permissions it was granted. The types cross the
 * command boundary to the chrome; the helpers are the pure half of the classification both hosts
 * feed their raw readings through.
 */
import { BLANK_URL, ERROR_URL_PREFIX, READER_URL_PREFIX, getDomain, getHost } from './url'

export type SecurityState = 'secure' | 'insecure' | 'internal' | 'local' | 'unknown'

export interface SiteCertificate {
  /** Who the certificate was issued to (the subject's common or organisation name). */
  subject: string
  issuer: string
  /** Unix milliseconds; null when the host does not expose the dates. */
  validFrom: number | null
  validTo: number | null
  /** TLS version when known (Electron reports it, the WebView does not). */
  protocol: string | null
}

export interface SiteSecurity {
  state: SecurityState
  certificate: SiteCertificate | null
  /** An https page loaded http subresources; null when that could not be checked. */
  mixedContent: boolean | null
}

export interface SiteCookie {
  name: string
  /** Host the cookie is scoped to; a leading dot means its subdomains receive it too. */
  domain: string
  /** Cookie path, or '' when the host cannot tell. */
  path: string
  secure: boolean | null
  httpOnly: boolean | null
  /** Expires with the browsing session (no expiry date); null when unknown. */
  session: boolean | null
  /** Bytes of name plus value. */
  size: number
}

export interface ThirdPartyCookies {
  /** Registrable domain of the embedded site. */
  site: string
  count: number
}

export interface SiteCookies {
  /** Cookies of the site itself: the page's host and its parent domains. */
  items: SiteCookie[]
  /** Cookies of other sites this page embedded content from, where that could be determined. */
  thirdParty: ThirdPartyCookies[]
}

export interface SiteStorage {
  /** Quota-managed storage (IndexedDB, Cache API, …) of the site in bytes; null when unknown. */
  usageBytes: number | null
  quotaBytes: number | null
  /** Origins of the site holding stored data. */
  origins: string[]
  localStorageItems: number | null
  sessionStorageItems: number | null
  serviceWorkers: number | null
}

export interface SitePermission {
  permission: string
  decision: 'allow' | 'deny'
}

export interface SiteInfo {
  tabId: string
  url: string
  host: string
  /** Registrable domain – the "site" cookies and storage are grouped by. */
  site: string
  origin: string
  containerId: string
  security: SiteSecurity
  cookies: SiteCookies
  storage: SiteStorage
  permissions: SitePermission[]
}

export interface SiteDescription {
  /** Scheme without the colon (`https`, `zen`, …). */
  scheme: string
  host: string
  site: string
  origin: string
  /** Path and query of the page (used to read the cookies a page at this address receives). */
  path: string
  state: SecurityState
  /** The address is a web page cookies and storage can be looked up for. */
  web: boolean
}

/** What can be said about an address before asking any host: scheme, host, site and security. */
export function describeSite(url: string): SiteDescription {
  const none = (scheme: string, state: SecurityState): SiteDescription => ({
    scheme,
    host: '',
    site: '',
    origin: '',
    path: '/',
    state,
    web: false
  })
  if (!url || url === BLANK_URL) return none('zen', 'internal')
  if (url.startsWith(ERROR_URL_PREFIX) || url.startsWith(READER_URL_PREFIX)) {
    // Error and Reader View pages stand in for another address; describe that one.
    try {
      const original = new URL(url).searchParams.get('url')
      if (original) return { ...describeSite(original), scheme: 'zen' }
    } catch {
      /* not a URL */
    }
    return none('zen', 'internal')
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return none('', 'unknown')
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (scheme === 'zen' || scheme === 'about' || scheme === 'chrome') return none(scheme, 'internal')
  if (scheme === 'file') return none(scheme, 'local')
  if (scheme !== 'http' && scheme !== 'https') return none(scheme, 'unknown')
  const host = parsed.hostname.toLowerCase()
  const local =
    host === 'localhost' || host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(host)
  return {
    scheme,
    host,
    site: getDomain(url),
    origin: parsed.origin,
    path: `${parsed.pathname || '/'}${parsed.search}`,
    state: scheme === 'https' ? 'secure' : local ? 'local' : 'insecure',
    web: true
  }
}

/**
 * What the address pill's site icon says about the page. `empty`: no page (the pill shows its
 * search glyph); `secure`: https; `insecure`: http on a host other than loopback, shown with
 * Chrome's "Not secure" text; `certificate-error`: an https load Zenium refused because of the
 * certificate, also "Not secure"; `local`: loopback http and `file:` pages; `internal`: Zenium's
 * own pages and error pages that stand in for a page that did not load; `unknown`: other schemes.
 */
export type IndicatorState =
  'empty' | 'secure' | 'insecure' | 'certificate-error' | 'local' | 'internal' | 'unknown'

export interface SecurityIndicator {
  state: IndicatorState
  /** Text drawn before the address (`Not secure`); null when the glyph says it all. */
  label: string | null
  /** The site icon's tooltip. */
  title: string
}

/** Chromium's certificate errors: net error codes -200 … -299 (`ERR_CERT_*`). */
export function isCertificateError(code: number | null | undefined): boolean {
  return typeof code === 'number' && code <= -200 && code >= -299
}

/**
 * Derive the pill's indicator from what the core knows about the tab: its address and the code
 * of a failed load (a certificate the browser refused is a `zen://error` page standing in for an
 * https address). Pure, so the chrome maps state to glyph and nothing more.
 */
export function securityIndicator(url: string, errorCode: number | null): SecurityIndicator {
  if (!url || url === BLANK_URL) return { state: 'empty', label: null, title: 'Site information' }
  const site = describeSite(url)
  if (url.startsWith(ERROR_URL_PREFIX)) {
    if (isCertificateError(errorCode) && site.state === 'secure') {
      return {
        state: 'certificate-error',
        label: 'Not secure',
        title: 'Certificate error · The connection to this site is not secure'
      }
    }
    return { state: 'internal', label: null, title: 'Page could not be loaded' }
  }
  switch (site.state) {
    case 'secure':
      return { state: 'secure', label: null, title: 'Connection is secure · Site information' }
    case 'insecure':
      return {
        state: 'insecure',
        label: 'Not secure',
        title: 'Your connection to this site is not secure · Site information'
      }
    case 'local':
      return {
        state: 'local',
        label: null,
        title: site.scheme === 'file' ? 'Local file' : 'Local site · Site information'
      }
    case 'internal':
      return { state: 'internal', label: null, title: 'Zenium page' }
    default:
      return { state: 'unknown', label: null, title: 'Site information' }
  }
}

/**
 * The host and every parent domain down to the registrable one – the domains whose cookies a
 * page on `host` receives: `mail.google.com` → `mail.google.com`, `google.com`.
 */
export function cookieHosts(host: string): string[] {
  const site = getDomain(`https://${host}/`)
  if (!host || !site) return host ? [host] : []
  const out = [host]
  let current = host
  while (current !== site && current.includes('.')) {
    current = current.slice(current.indexOf('.') + 1)
    if (!current.endsWith(site)) break
    out.push(current)
  }
  return out
}

/** The other sites among `hosts` (a page's subresource hosts), most used first. */
export function otherSites(hosts: Array<{ host: string; count: number }>, site: string): string[] {
  const counts = new Map<string, number>()
  for (const { host, count } of hosts) {
    const domain = getDomain(`https://${host}/`)
    if (!domain || domain === site) continue
    counts.set(domain, (counts.get(domain) ?? 0) + count)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([domain]) => domain)
}

/** Cookies the document can see (`document.cookie`) mark the rest as HttpOnly. */
export function inferHttpOnly(
  cookies: SiteCookie[],
  documentCookieNames: string[] | null
): SiteCookie[] {
  if (documentCookieNames === null) return cookies
  const visible = new Set(documentCookieNames)
  return cookies.map((c) => (c.httpOnly === null ? { ...c, httpOnly: !visible.has(c.name) } : c))
}

/** Human labels for the permission names the browser prompts for. */
export const PERMISSION_LABELS: Record<string, string> = {
  camera: 'Camera',
  microphone: 'Microphone',
  media: 'Camera and microphone',
  geolocation: 'Location',
  notifications: 'Notifications',
  midi: 'MIDI devices',
  'clipboard-read': 'Read the clipboard',
  openExternal: 'Open other apps',
  mediaKeySystem: 'Protected content (DRM)',
  popups: 'Pop-up windows',
  fileSystem: 'Write to files you picked',
  'storage-access': 'Cookies while embedded',
  'top-level-storage-access': 'Cookies for embedded sites',
  'window-management': 'Manage windows on all displays',
  'idle-detection': 'Know when you are active',
  ads: 'Ads and trackers'
}

/**
 * A stored permission may carry a qualifier after a colon (`openExternal:tel`, `storage-access:
 * https://embedder.example`): the label names the permission and keeps the qualifier in brackets.
 */
export function permissionLabel(permission: string): string {
  const colon = permission.indexOf(':')
  const name = colon === -1 ? permission : permission.slice(0, colon)
  const qualifier = colon === -1 ? null : permission.slice(colon + 1)
  const label = PERMISSION_LABELS[name] ?? name
  if (!qualifier) return label
  if (name === 'openExternal') return `Open ${qualifier}: links`
  if (name === 'fileSystem' && qualifier === 'read') return 'View folders you picked'
  return `${label} (${qualifier.replace(/^https:\/\//, '')})`
}

/** `1.2 MB`-style sizes; bytes below a kilobyte read as a plain count. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1')} ${units[unit]}`
}

/** Sum of the sizes of a list of cookies. */
export function cookieBytes(cookies: SiteCookie[]): number {
  return cookies.reduce((sum, c) => sum + c.size, 0)
}

/** Host of a URL, lower-cased; '' when it is not a URL. */
export function hostOf(url: string): string {
  return getHost(url).toLowerCase()
}
