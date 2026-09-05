/**
 * URL helpers shared by main and renderer. No Electron / DOM dependencies.
 */

export const BLANK_URL = 'zen://blank'
export const ERROR_URL_PREFIX = 'zen://error'

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/
const HOST_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?([/?#].*)?$/i
const LOCALHOST_RE = /^localhost(:\d{1,5})?([/?#].*)?$/i

export function hasScheme(input: string): boolean {
  return SCHEME_RE.test(input)
}

export function isInternalUrl(url: string): boolean {
  return url.startsWith('zen://') || url.startsWith('about:') || url.startsWith('chrome://')
}

/** Heuristic used by the URL bar: does the user most likely mean a URL rather than a search? */
export function isProbablyUrl(raw: string): boolean {
  const input = raw.trim()
  if (!input || /\s/.test(input)) {
    // "example.com foo" is a search; "http://a b" is not a url either.
    return false
  }
  if (hasScheme(input)) {
    // "foo:bar" could be a search ("javascript:" etc. are blocked elsewhere).
    const scheme = input.slice(0, input.indexOf(':')).toLowerCase()
    return [
      'http',
      'https',
      'file',
      'zen',
      'about',
      'ftp',
      'data',
      'view-source',
      'chrome'
    ].includes(scheme)
  }
  if (LOCALHOST_RE.test(input)) return true
  if (IPV4_RE.test(input)) return true
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
      if (rest === 'preferences' || rest === 'settings') return 'zen://settings'
      return BLANK_URL
    }
    return input
  }
  return `https://${input}`
}

/** Strip the scheme and `www.` for display, like Firefox's `browser.urlbar.trimHttps`. */
export function displayUrl(url: string): string {
  if (!url || url === BLANK_URL) return ''
  if (url.startsWith(ERROR_URL_PREFIX)) {
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

export function getHost(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname
  } catch {
    return ''
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

/** Prevent navigation to schemes that would be dangerous or meaningless in a tab. */
export function isNavigableUrl(url: string): boolean {
  if (!url) return false
  const scheme = url.slice(0, url.indexOf(':')).toLowerCase()
  return ['http', 'https', 'file', 'zen', 'view-source', 'data', 'blob', 'ftp'].includes(scheme)
}
