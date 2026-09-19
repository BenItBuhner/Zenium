/**
 * URL helpers shared by main and renderer. No Electron / DOM dependencies.
 */
import type { CertificateDetails } from './types'
import { EXTENSION_ORIGIN_SUFFIX, parseExtensionUrl } from '../core/extensions/runtime/plan'
import {
  INTERNAL_ALIAS_SCHEME,
  internalPageAliasUrl,
  internalPageTitle,
  internalPageUrl,
  parseInternalPageUrl
} from './internalPages'

export const BLANK_URL = 'zen://blank'
/** The new tab page (`zen://newtab`), a document served like `zen://blank`. */
export const NEW_TAB_URL = 'zen://newtab'
export const ERROR_URL_PREFIX = 'zen://error'
export const READER_URL_PREFIX = 'zen://reader'
/** The history page: a chrome surface, not a document (see `overlayForUrl` in zenPages). */
export const HISTORY_URL = 'zen://history'
/** The Settings page: an internal page that opens as a tab (see `shared/internalPages.ts`). */
export const SETTINGS_URL = 'zen://settings'
/** The bookmark manager: typed or linked, it opens the manager instead of navigating (zenPages). */
export const BOOKMARKS_URL = 'zen://bookmarks'
/** The addresses of an empty tab (Zen's blank page and the aliases that resolve to it). */
const NEW_TAB_URLS = new Set([BLANK_URL, NEW_TAB_URL, 'about:newtab', 'about:blank', ''])

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/
const HOST_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?([/?#].*)?$/i
const LOCALHOST_RE = /^localhost(:\d{1,5})?([/?#].*)?$/i

const KNOWN_SCHEMES = [
  'http',
  'https',
  'file',
  'zen',
  INTERNAL_ALIAS_SCHEME,
  'about',
  'ftp',
  'data',
  'view-source',
  'chrome',
  'chrome-extension'
]

/**
 * The internal pages a user may type by another browser's name: `chrome://settings`,
 * `about:preferences`, `zenium://newtab`. Each resolves to the canonical `zen://` address.
 */
const INTERNAL_PAGE_ALIASES: Record<string, string> = {
  blank: BLANK_URL,
  newtab: NEW_TAB_URL,
  home: NEW_TAB_URL,
  preferences: SETTINGS_URL,
  settings: SETTINGS_URL,
  history: HISTORY_URL,
  bookmarks: BOOKMARKS_URL
}
/** `host:port[/path]` – looks like a scheme but is a bare host with a port (dev servers). */
const HOST_PORT_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*:\d{1,5}([/?#].*)?$/i

/** True when the input starts with a real, recognised URL scheme. */
export function hasScheme(input: string): boolean {
  if (!SCHEME_RE.test(input)) return false
  const scheme = input.slice(0, input.indexOf(':')).toLowerCase()
  return KNOWN_SCHEMES.includes(scheme)
}

export function isInternalUrl(url: string): boolean {
  return url.startsWith('zen://') || url.startsWith('about:') || url.startsWith('chrome://')
}

/** Chrome's scheme for an extension's own pages, popups and resources. */
export const EXTENSION_SCHEME = 'chrome-extension'
const EXTENSION_ID_RE = /^[a-p]{32}$/

export interface ExtensionPage {
  /** The extension's id (32 letters a–p, as Chrome forms them). */
  id: string
  /** The page's address as the user sees it: `chrome-extension://<id>/<path>`, query and all. */
  url: string
}

/**
 * The extension page an address shows, in either form it takes: Chrome's
 * `chrome-extension://<id>/<path>` (what the desktop loads and what the Android runtime shows
 * its extensions), or the Android runtime's emulated origin `https://<id>.ext.zenium.invalid/…`
 * (`extensionUrl` in the runtime's plan module: WebView refuses the scheme, so a tab loads the
 * page from there). The chrome shows the first form everywhere and the second never – it is an
 * implementation detail of the runtime, not an address (v2 §10.1 applied to extension pages).
 * Null for anything else.
 */
export function extensionPageOf(url: string): ExtensionPage | null {
  if (!url || !url.includes('://')) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol === `${EXTENSION_SCHEME}:`) {
    return EXTENSION_ID_RE.test(parsed.hostname) ? { id: parsed.hostname, url } : null
  }
  if (!parseExtensionUrl(url)) return null
  const id = parsed.hostname.slice(0, -EXTENSION_ORIGIN_SUFFIX.length)
  return {
    id,
    url: `${EXTENSION_SCHEME}://${id}${parsed.pathname}${parsed.search}${parsed.hash}`
  }
}

/**
 * A page of the web (`http:` / `https:`) as the chrome's site chips understand it: the lock,
 * the tracker shield, Reader View, translation and Boosts are for these and not for an
 * extension page, which the Android runtime happens to serve from an https origin.
 */
export function isWebPageUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && extensionPageOf(url) === null
}

/**
 * The address as the user sees it wherever a URL is shown, typed, copied or shared: an internal
 * page's `zenium://` alias (`zen://` never leaves `tab.url`, v2 §10.1), an extension page's
 * `chrome-extension://<id>/<path>` whichever form the tab carries, any other URL as it is.
 */
export function presentedUrl(url: string): string {
  return extensionPageOf(url)?.url ?? internalPageAliasUrl(url)
}

/**
 * The blank page or the new tab page: a tab that shows nothing of its own yet (where Edge shows
 * the favorites bar even when it is hidden elsewhere). Once the blank page has loaded, Chromium
 * reports it as `zen://blank/`: the slash does not count.
 */
export function isEmptyTabUrl(url: string | null | undefined): boolean {
  return (
    url === null ||
    url === undefined ||
    NEW_TAB_URLS.has(url.replace(/\/$/, '')) ||
    isNewTabUrl(url)
  )
}

/** `zen://newtab` with or without a trailing slash or query (Chromium normalises the former). */
export function isNewTabUrl(url: string): boolean {
  return (
    url === NEW_TAB_URL || url.startsWith(`${NEW_TAB_URL}/`) || url.startsWith(`${NEW_TAB_URL}?`)
  )
}

/** Heuristic used by the URL bar: does the user most likely mean a URL rather than a search? */
export function isProbablyUrl(raw: string): boolean {
  const input = raw.trim()
  if (!input || /\s/.test(input)) {
    // "example.com foo" is a search; "http://a b" is not a url either.
    return false
  }
  if (hasScheme(input)) return true
  if (LOCALHOST_RE.test(input)) return true
  if (IPV4_RE.test(input)) return true
  if (HOST_PORT_RE.test(input)) return true
  if (SCHEME_RE.test(input)) {
    // "foo:bar" with an unknown scheme is a search ("javascript:" etc. are blocked elsewhere).
    return false
  }
  if (HOST_RE.test(input)) {
    const tld =
      input
        .split(/[/?#:]/)[0]
        .split('.')
        .pop() ?? ''
    // Reject "1.5" style numbers and obviously invalid TLDs.
    return /^[a-z]{2,}$/i.test(tld) || /^xn--/i.test(tld)
  }
  return false
}

/** Turn typed input into a navigable URL, or `null` if it should be searched instead. */
export function inputToUrl(raw: string): string | null {
  const input = raw.trim()
  if (!isProbablyUrl(input)) return null
  if (hasScheme(input)) {
    const scheme = input.slice(0, input.indexOf(':')).toLowerCase()
    if (scheme === 'about') {
      const rest = input.slice('about:'.length).toLowerCase()
      return INTERNAL_PAGE_ALIASES[rest] ?? BLANK_URL
    }
    // Internal pages are stored under `zen://`. `zenium://` is the name users see for it, and
    // `chrome://settings` and its siblings are the pages a Chrome user types from habit: a
    // registered page resolves to its canonical address, section and all
    // (`zenium://settings/privacy`, `chrome://settings/privacy`); a page known by an alias by
    // that name (`zenium://newtab`, `chrome://history`); any other zenium:// address is the
    // zen:// one, and other chrome:// addresses stay what they are (Chromium answers them).
    const page = parseInternalPageUrl(input)
    if (page) return internalPageUrl(page)
    if (scheme === INTERNAL_ALIAS_SCHEME || scheme === 'chrome') {
      const rest = input.slice(`${scheme}://`.length)
      const name = rest.split(/[/?#]/, 1)[0].toLowerCase()
      const alias = INTERNAL_PAGE_ALIASES[name]
      if (alias) {
        const aliased = parseInternalPageUrl(`${alias}${rest.slice(name.length)}`)
        return aliased ? internalPageUrl(aliased) : alias
      }
      if (scheme === INTERNAL_ALIAS_SCHEME) return `zen://${rest}`
    }
    return input
  }
  // Local dev servers and IPs are almost always plain http.
  if (LOCALHOST_RE.test(input) || IPV4_RE.test(input) || HOST_PORT_RE.test(input)) {
    return `http://${input}`
  }
  return `https://${input}`
}

/** Strip the scheme and `www.` for display, like Firefox's `browser.urlbar.trimHttps`. */
export function displayUrl(url: string): string {
  if (isEmptyTabUrl(url)) return ''
  // Error and Reader View pages show the address of the page they stand in for (like Firefox).
  if (url.startsWith(ERROR_URL_PREFIX) || url.startsWith(READER_URL_PREFIX)) {
    try {
      const original = new URL(url).searchParams.get('url')
      return original ? displayUrl(original) : ''
    } catch {
      return ''
    }
  }
  // Internal pages show their user-facing alias (`zenium://settings/privacy`); an extension
  // page its `chrome-extension://` address in full, as Chrome's omnibox shows it.
  if (parseInternalPageUrl(url)) return internalPageAliasUrl(url)
  const extension = extensionPageOf(url)
  if (extension) return extension.url
  let out = url
  if (out.startsWith('https://')) out = out.slice('https://'.length)
  else if (out.startsWith('http://')) out = out.slice('http://'.length)
  if (out.startsWith('www.')) out = out.slice(4)
  if (out.endsWith('/') && !out.slice(0, -1).includes('/')) out = out.slice(0, -1)
  try {
    return decodeURI(out)
  } catch {
    return out
  }
}

/**
 * The address in full, as Chrome's "Always show full URLs" shows it and as a copy yields it:
 * scheme and `www.` kept, error and Reader View pages replaced by the address they stand in for,
 * an internal page as its user-facing `zenium://` alias (`zen://` never leaves `tab.url`), an
 * extension page as `chrome-extension://<id>/<path>` (`presentedUrl`).
 */
export function fullUrl(url: string): string {
  // An empty tab (the blank page, the new tab page) has no address to show: `zen://newtab` is
  // canonical inside and never appears in the UI, as Chrome's omnibox is empty on its NTP.
  if (isEmptyTabUrl(url)) return ''
  if (url.startsWith(ERROR_URL_PREFIX) || url.startsWith(READER_URL_PREFIX)) {
    try {
      return new URL(url).searchParams.get('url') ?? ''
    } catch {
      return ''
    }
  }
  return presentedUrl(url)
}

/**
 * Split a displayed address into the site, drawn in full ink, and everything after it (path,
 * query, fragment), which the address pill deemphasises as Chrome dims all but the host. A scheme
 * left in the text (`zen://settings`, `file:///tmp/a`, a full URL) is part of the site.
 */
export function addressParts(shown: string): { site: string; rest: string } {
  const schemeEnd = shown.indexOf('://')
  const start = schemeEnd === -1 ? 0 : schemeEnd + 3
  const cut = shown.slice(start).search(/[/?#]/)
  if (cut === -1) return { site: shown, rest: '' }
  return { site: shown.slice(0, start + cut), rest: shown.slice(start + cut) }
}

export function getHost(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname
  } catch {
    return ''
  }
}

/**
 * The address as a phone's URL pill shows it: the site alone, like Chrome's steady-state
 * omnibox, so a long path or query can never push the domain out of the pill. `www.` is trimmed
 * as in `displayUrl`; a non-default port stays (a dev server is told apart by it); error and
 * Reader View pages show the site they stand in for. An internal page shows its title
 * ("Settings"), as Chrome's omnibox names its own pages. An extension page has no site: its
 * extension's id stands where the host would (the chrome puts the extension's name there when
 * it knows it, `lib/extensions/pages.ts`), and the runtime's emulated origin never shows. Other
 * schemes (`file:`) have no site to show and fall back to `displayUrl`.
 */
export function displayHost(url: string): string {
  if (!url || url === BLANK_URL) return ''
  const pageTitle = internalPageTitle(url)
  if (pageTitle !== null) return pageTitle
  const extension = extensionPageOf(url)
  if (extension) return extension.id
  if (url.startsWith(ERROR_URL_PREFIX) || url.startsWith(READER_URL_PREFIX)) {
    try {
      const original = new URL(url).searchParams.get('url')
      return original ? displayHost(original) : ''
    } catch {
      return ''
    }
  }
  if (!/^https?:\/\//i.test(url)) return displayUrl(url)
  try {
    const host = new URL(url).host
    const site = host.startsWith('www.') ? host.slice(4) : host
    return site || displayUrl(url)
  } catch {
    return displayUrl(url)
  }
}

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go'])

/** Approximate registrable domain (eTLD+1) – good enough for "same site" checks. */
export function getDomain(url: string): string {
  const host = getHost(url).toLowerCase()
  if (!host) return ''
  if (IPV4_RE.test(host) || host === 'localhost') return host
  const labels = host.split('.')
  if (labels.length <= 2) return host
  const tld = labels[labels.length - 1]
  const sld = labels[labels.length - 2]
  if (tld.length === 2 && SECOND_LEVEL.has(sld) && labels.length >= 3) {
    return labels.slice(-3).join('.')
  }
  return labels.slice(-2).join('.')
}

export function isSameSite(a: string, b: string): boolean {
  const da = getDomain(a)
  const db = getDomain(b)
  return da !== '' && da === db
}

/**
 * A friendly title for pages without one: the host. An extension page's is its extension's id
 * here – the core names the tab after the extension instead (`Tabs.titleFor`); this is the
 * fallback for an extension nothing knows any more, and never the runtime's emulated host.
 */
export function titleForUrl(url: string): string {
  if (isEmptyTabUrl(url)) return 'New Tab'
  if (url.startsWith(ERROR_URL_PREFIX)) return 'Problem loading page'
  const pageTitle = internalPageTitle(url)
  if (pageTitle !== null) return pageTitle
  const extension = extensionPageOf(url)
  if (extension) return extension.id
  const host = getHost(url)
  return host ? host.replace(/^www\./, '') : url
}

/**
 * The `zen://error` page for a failed load of `url`; a certificate failure carries the refused
 * certificate along, so the page can show it and offer to proceed (`errorPageCertificate`).
 */
export function errorPageUrl(
  code: number,
  description: string,
  url: string,
  certificate?: CertificateDetails | null
): string {
  const params = new URLSearchParams({ code: String(code), description, url })
  if (certificate) params.set('certificate', JSON.stringify(certificate))
  return `${ERROR_URL_PREFIX}?${params.toString()}`
}

/**
 * The interstitials Zenium puts in front of a page: Safe Browsing's warning and HTTPS-only
 * mode's plaintext question. Both are error pages (`zen://error` with a `kind`), so the URL bar,
 * reload and copy treat them like any other page that stands in for `url`.
 */
export type InterstitialKind = 'safebrowsing' | 'https-only'

export function safeBrowsingPageUrl(url: string, threat: string): string {
  const params = new URLSearchParams({
    code: String(-20),
    description: 'ERR_BLOCKED_BY_CLIENT',
    url,
    kind: 'safebrowsing',
    threat
  })
  return `${ERROR_URL_PREFIX}?${params.toString()}`
}

export function httpsOnlyPageUrl(httpUrl: string, code: number): string {
  const params = new URLSearchParams({
    code: String(code),
    description: 'HTTPS_ONLY_FALLBACK',
    url: httpUrl,
    kind: 'https-only'
  })
  return `${ERROR_URL_PREFIX}?${params.toString()}`
}

/** Which interstitial an error-page URL is, or null for a plain error page (or any other URL). */
export function interstitialKindOf(url: string): InterstitialKind | null {
  if (!url.startsWith(ERROR_URL_PREFIX)) return null
  try {
    const kind = new URL(url).searchParams.get('kind')
    return kind === 'safebrowsing' || kind === 'https-only' ? kind : null
  } catch {
    return null
  }
}

/** The certificate an error page URL carries (`errorPageUrl`), or null when it has none or it is malformed. */
export function errorPageCertificate(params: URLSearchParams): CertificateDetails | null {
  const raw = params.get('certificate')
  if (!raw) return null
  try {
    return certificateDetailsFrom(JSON.parse(raw))
  } catch {
    return null
  }
}

/**
 * A host's (or an error page URL's) description of a refused certificate, checked field by field:
 * missing or mistyped fields read as unknown ('' and 0), so a certificate the host could only
 * partly describe still shows; null when `value` is no object at all.
 */
export function certificateDetailsFrom(value: unknown): CertificateDetails | null {
  if (!value || typeof value !== 'object') return null
  const c = value as Record<string, unknown>
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')
  const time = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    subjectName: text(c.subjectName),
    issuerName: text(c.issuerName),
    validStart: time(c.validStart),
    validExpiry: time(c.validExpiry),
    fingerprint: text(c.fingerprint)
  }
}

/** Prevent navigation to schemes that would be dangerous or meaningless in a tab. */
export function isNavigableUrl(url: string): boolean {
  if (!url) return false
  const scheme = url.slice(0, url.indexOf(':')).toLowerCase()
  return [
    'http',
    'https',
    'file',
    'zen',
    'view-source',
    'data',
    'blob',
    'ftp',
    'chrome-extension'
  ].includes(scheme)
}
