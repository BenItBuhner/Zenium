/**
 * URL helpers shared by main and renderer. No Electron / DOM dependencies.
 */
import type { CertificateDetails } from './types'
import { extensionIdOfUrl, presentExtensionUrl } from '../core/extensions/runtime/extensionUrls'
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
/** The History page: an internal page that opens as a tab (see `shared/internalPages.ts`). */
export const HISTORY_URL = 'zen://history'
/** The Settings page: an internal page that opens as a tab (see `shared/internalPages.ts`). */
export const SETTINGS_URL = 'zen://settings'
/** The bookmarks manager: an internal page that opens as a tab (see `shared/internalPages.ts`). */
export const BOOKMARKS_URL = 'zen://bookmarks'
/** The Downloads page: an internal page that opens as a tab (see `shared/internalPages.ts`). */
export const DOWNLOADS_URL = 'zen://downloads'
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
  bookmarks: BOOKMARKS_URL,
  downloads: DOWNLOADS_URL
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

/**
 * What stands in for the name of an extension the chrome does not know (removed while its
 * page's tab stayed open, or not listed yet) where the pill shows a host and a title falls back
 * to one: never the raw id (v2 §10.1 applied to extension pages).
 */
export const UNKNOWN_EXTENSION_PAGE_LABEL = 'Extension page'

export interface ExtensionPage {
  /** The extension's id (32 letters a–p, as Chrome forms them). */
  id: string
  /** The page's address as the user sees it: `chrome-extension://<id>/<path>`, query and all. */
  url: string
}

/**
 * The extension page an address shows, in either spelling it takes: Chrome's
 * `chrome-extension://<id>/<path>` (what the desktop loads and what the Android runtime shows
 * its extensions), or the Android runtime's served origin `https://<id>.ext.zenium.invalid/…`
 * (WebView refuses the scheme, so a tab loads the page from there; the runtime's
 * `extensionUrls.ts` owns the mapping). The chrome shows the first form everywhere and the
 * second never – it is an implementation detail of the runtime, not an address (v2 §10.1
 * applied to extension pages). Null for anything else.
 */
export function extensionPageOf(url: string): ExtensionPage | null {
  if (!url || !url.includes('://')) return null
  const id = extensionIdOfUrl(url)
  return id ? { id, url: presentExtensionUrl(url) } : null
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

/**
 * The blank page alone (`zen://blank`, with or without the slash a load adds): the tab an empty
 * split pane holds until an address is typed into it or a tab is chosen for it (split-04).
 */
export function isBlankTabUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && url.replace(/\/$/, '') === BLANK_URL
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
 * ("Settings"), as Chrome's omnibox names its own pages. An extension page has no site: the
 * extension's name stands where the host would (the chrome puts it there when it knows the
 * extension, `lib/extensions/pages.ts`) and "Extension page" otherwise – never the id, and never
 * the runtime's served origin. Other schemes (`file:`) have no site to show and fall back to
 * `displayUrl`.
 */
export function displayHost(url: string): string {
  if (!url || url === BLANK_URL) return ''
  const pageTitle = internalPageTitle(url)
  if (pageTitle !== null) return pageTitle
  if (extensionPageOf(url)) return UNKNOWN_EXTENSION_PAGE_LABEL
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

/**
 * What the desktop pill reads for a tab at rest, given `shown` – its address as `displayUrl` or
 * `fullUrl` renders it – and whether that address fits the pill's field. An address that fits is
 * shown whole, section and all (`zenium://settings/privacy`); one that does not is the internal
 * page's title ("Settings") where the tab is one of Zenium's own pages, as the phone pill names
 * them (v2 §10.1) – a `zenium://` address is not worth reading, "ze…" says nothing, and the
 * title is what the tab row says too – switching back to the address the moment it fits. A
 * site's pill never shows its title: no browser's address bar does, and at the 240 sidebar's 80
 * px content box a title truncates as badly as an address ("Coffee – …" for "en.wikip…"). It
 * keeps its address, trimmed as Zen trims it (`displayUrl`: the scheme and `www.` off, the host
 * first, then the path) and truncated from the end at any width (§9.29: the address truncates
 * first, to a floor of 56 px, and only then do chips hide; below the floor the address stays,
 * as Zen's and Firefox's sidebar bars keep theirs). The URL bar's field keeps the whole address
 * while editing, whatever the pill shows.
 */
export function pillText(url: string, shown: string, fits: boolean): string {
  if (fits || !shown) return shown
  return internalPageTitle(url) ?? shown
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
  // An extension's page is named after the extension where the core knows it (`tabs.titleFor`);
  // here, without the list, it is an extension page and never the id.
  if (extensionPageOf(url)) return UNKNOWN_EXTENSION_PAGE_LABEL
  const host = getHost(url)
  return host ? host.replace(/^www\./, '') : url
}

/**
 * The active theme's accent, `#rrggbb` per colour scheme, that an error document inlines
 * beside the token block it cuts from the chrome's stylesheet (design language v2 §9.11): the
 * `zen://` document cannot read the window's live `--zen-accent`, so a primary drawn from
 * `--v2-accent` without it is the unresolved variable's black or white. The core, which knows
 * the tab's space and whether the window is private, writes it into the page's URL when it
 * builds one (`accent` / `accentDark`, the hex without its `#`), and every builder of the
 * document reads it back (`errorPageAccentOf`).
 */
export interface ErrorPageAccent {
  light: string
  dark: string
}

function setAccent(params: URLSearchParams, accent: ErrorPageAccent | undefined): void {
  if (!accent) return
  params.set('accent', accent.light.replace(/^#/, ''))
  params.set('accentDark', accent.dark.replace(/^#/, ''))
}

/** The accent an error page's URL carries (`setAccent`), or null when it carries none or not a colour. */
export function errorPageAccentOf(params: URLSearchParams): ErrorPageAccent | null {
  const hex = (value: string | null): string | null =>
    value && /^[0-9a-f]{6}$/i.test(value) ? `#${value.toLowerCase()}` : null
  const light = hex(params.get('accent'))
  const dark = hex(params.get('accentDark'))
  return light && dark ? { light, dark } : null
}

/**
 * The `zen://error` page for a failed load of `url`; a certificate failure carries the refused
 * certificate along, so the page can show it and offer to proceed (`errorPageCertificate`).
 */
export function errorPageUrl(
  code: number,
  description: string,
  url: string,
  certificate?: CertificateDetails | null,
  accent?: ErrorPageAccent
): string {
  const params = new URLSearchParams({ code: String(code), description, url })
  if (certificate) params.set('certificate', JSON.stringify(certificate))
  setAccent(params, accent)
  return `${ERROR_URL_PREFIX}?${params.toString()}`
}

/**
 * What the crash page (`zen://error?code=-1`) says besides that the page is gone (ERR-15):
 * `crash`, the renderer crashed ("Something went wrong"); `memory`, the OS killed it to free
 * memory while the page was in front; `hung`, the user ended an unresponsive page. A `repeat`
 * within the minute adds the suggestion to close other tabs and the way to the tab switcher.
 */
export type CrashPageVariant = 'crash' | 'memory' | 'hung'

export interface CrashPageOptions {
  variant?: CrashPageVariant
  repeat?: boolean
  /** The theme's accent for the page's primary (the repeat variant's Reload), §9.11. */
  accent?: ErrorPageAccent
}

/**
 * The crash page for `url`, the page whose renderer went away: `codeName` is Chrome's name
 * for the way it ended (`crashCodeName`), printed on the page's code line.
 */
export function crashPageUrl(
  codeName: string,
  url: string,
  options: CrashPageOptions = {}
): string {
  const params = new URLSearchParams({ code: '-1', description: codeName, url })
  if (options.variant && options.variant !== 'crash') params.set('variant', options.variant)
  if (options.repeat) params.set('repeat', '1')
  setAccent(params, options.accent)
  return `${ERROR_URL_PREFIX}?${params.toString()}`
}

/** The crash page's variant and repeat flag out of its URL's parameters (the accent: `errorPageAccentOf`). */
export function crashPageOptionsOf(
  params: URLSearchParams
): Required<Pick<CrashPageOptions, 'variant' | 'repeat'>> {
  const variant = params.get('variant')
  return {
    variant: variant === 'memory' || variant === 'hung' ? variant : 'crash',
    repeat: params.get('repeat') === '1'
  }
}

/**
 * The interstitials Zenium puts in front of a page: Safe Browsing's warning and HTTPS-only
 * mode's plaintext question. Both are error pages (`zen://error` with a `kind`), so the URL bar,
 * reload and copy treat them like any other page that stands in for `url`.
 */
export type InterstitialKind = 'safebrowsing' | 'https-only'

export function safeBrowsingPageUrl(url: string, threat: string, accent?: ErrorPageAccent): string {
  const params = new URLSearchParams({
    code: String(-20),
    description: 'ERR_BLOCKED_BY_CLIENT',
    url,
    kind: 'safebrowsing',
    threat
  })
  setAccent(params, accent)
  return `${ERROR_URL_PREFIX}?${params.toString()}`
}

export function httpsOnlyPageUrl(httpUrl: string, code: number, accent?: ErrorPageAccent): string {
  const params = new URLSearchParams({
    code: String(code),
    description: 'HTTPS_ONLY_FALLBACK',
    url: httpUrl,
    kind: 'https-only'
  })
  setAccent(params, accent)
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
