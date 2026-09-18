/**
 * URL helpers shared by main and renderer. No Electron / DOM dependencies.
 */

export const BLANK_URL = 'zen://blank'
export const ERROR_URL_PREFIX = 'zen://error'
export const READER_URL_PREFIX = 'zen://reader'
/** The history page: a chrome surface, not a document (see `overlayForUrl` in zenPages). */
export const HISTORY_URL = 'zen://history'
export const SETTINGS_URL = 'zen://settings'
/** The bookmark manager: typed or linked, it opens the manager instead of navigating (zenPages). */
export const BOOKMARKS_URL = 'zen://bookmarks'
/** The new tab page (Zen's empty tab); a dedicated `zen://newtab` counts once it exists. */
const NEW_TAB_URLS = new Set([BLANK_URL, 'zen://newtab', 'about:newtab', 'about:blank', ''])

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
  'about',
  'ftp',
  'data',
  'view-source',
  'chrome',
  'chrome-extension'
]
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

/**
 * The new tab page, where Edge shows the favorites bar even when it is hidden elsewhere. Once
 * the blank page has loaded, Chromium reports it as `zen://blank/`: the slash does not count.
 */
export function isNewTabUrl(url: string | null | undefined): boolean {
  return url === null || url === undefined || NEW_TAB_URLS.has(url.replace(/\/$/, ''))
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
      const rest = input.slice('about:'.length)
      if (rest === 'blank' || rest === 'newtab' || rest === 'home') return BLANK_URL
      if (rest === 'preferences' || rest === 'settings') return SETTINGS_URL
      if (rest === 'history') return HISTORY_URL
      if (rest === 'bookmarks') return BOOKMARKS_URL
      return BLANK_URL
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
  if (!url || url === BLANK_URL) return ''
  // Error and Reader View pages show the address of the page they stand in for (like Firefox).
  if (url.startsWith(ERROR_URL_PREFIX) || url.startsWith(READER_URL_PREFIX)) {
    try {
      const original = new URL(url).searchParams.get('url')
      return original ? displayUrl(original) : ''
    } catch {
      return ''
    }
  }
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
 * scheme and `www.` kept, error and Reader View pages replaced by the address they stand in for.
 */
export function fullUrl(url: string): string {
  if (!url || url === BLANK_URL) return ''
  if (url.startsWith(ERROR_URL_PREFIX) || url.startsWith(READER_URL_PREFIX)) {
    try {
      return new URL(url).searchParams.get('url') ?? ''
    } catch {
      return ''
    }
  }
  return url
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
 * Reader View pages show the site they stand in for. Other schemes (`file:`, `zen://settings`)
 * have no site to show and fall back to `displayUrl`.
 */
export function displayHost(url: string): string {
  if (!url || url === BLANK_URL) return ''
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

/** A friendly title for pages without one. */
export function titleForUrl(url: string): string {
  if (!url || url === BLANK_URL) return 'New Tab'
  if (url.startsWith(ERROR_URL_PREFIX)) return 'Problem loading page'
  const host = getHost(url)
  return host ? host.replace(/^www\./, '') : url
}

export function errorPageUrl(code: number, description: string, url: string): string {
  const params = new URLSearchParams({ code: String(code), description, url })
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
