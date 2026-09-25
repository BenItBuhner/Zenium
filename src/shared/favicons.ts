import type { Platform } from './types'
import { getHost } from './url'

/**
 * The favicon cache's addresses (HB-47, Chrome's Favicons DB): an icon the core has kept is
 * named by its content, `zen://favicon/<hash>` (`core/favicons.ts` keeps the bytes), and the
 * chrome draws history rows, bookmarks and tabs from that copy – offline, and without a request
 * to every site the user ever visited each time the history page opens. This module is the
 * renderer's half: the address forms, and the one rule that decides what an `<img>` shows.
 */

/** The cached icon's scheme and host: `zen://favicon/<hash>`. */
export const FAVICON_URL_PREFIX = 'zen://favicon/'

/**
 * The Android chrome runs on `https://appassets.androidplatform.net` and has no `zen://` handler
 * of its own (its internal pages are documents written into the WebView); the cached icons are
 * served under this path of the app origin instead (`ChromeWebView.kt`, `BootHandoff.favicon`).
 */
export const ANDROID_FAVICON_PATH = '/zen-favicon/'
const ANDROID_APP_ORIGIN = 'https://appassets.androidplatform.net'

/** A content hash as the cache names it: 32 lowercase hex digits (the first 128 bits of SHA-256). */
const HASH = /^[0-9a-f]{32}$/

/** `zen://favicon/<hash>` for a cached icon. */
export function faviconUrl(hash: string): string {
  return `${FAVICON_URL_PREFIX}${hash}`
}

/** The hash a `zen://favicon/<hash>` address names, or null for any other string. */
export function faviconHashOf(url: string | null | undefined): string | null {
  if (!url || !url.startsWith(FAVICON_URL_PREFIX)) return null
  const hash = url.slice(FAVICON_URL_PREFIX.length).split(/[?#]/)[0]
  return HASH.test(hash) ? hash : null
}

/** Whether `url` names a cached icon. */
export function isFaviconUrl(url: string | null | undefined): boolean {
  return faviconHashOf(url) !== null
}

/**
 * The address the chrome's `<img>` loads a cached icon from on `platform`: the `zen://` address
 * itself where the host serves the scheme (Electron's `protocol.handle`), the app origin's
 * `/zen-favicon/<hash>` on Android.
 */
export function hostFaviconUrl(url: string, platform: Platform | null | undefined): string {
  const hash = faviconHashOf(url)
  if (!hash) return url
  return platform === 'android' ? `${ANDROID_APP_ORIGIN}${ANDROID_FAVICON_PATH}${hash}` : url
}

/** What the renderer holds of the cache: which icon addresses it has, and under which hash. */
export type FaviconIndex = ReadonlyMap<string, string>

export interface FaviconSrcOptions {
  /** The cache's index as the chrome holds it (`favicons.index`, then `favicons.changed`). */
  index: FaviconIndex
  platform: Platform | null | undefined
  /**
   * The page the icon stands for, when the slot is a row for a page (a history visit, a
   * bookmark, a back-history entry, an omnibox row): an icon the cache has nothing for is drawn
   * live only while that page's site is open in a tab, and not at all otherwise – a row for a
   * closed page makes no request. Left out for a slot that is no page's (a search engine's mark,
   * a tab's own row, a requester's icon): the live address stands where the cache has nothing,
   * as it always did.
   */
  pageUrl?: string | null
  /** The sites open in this window's tabs, as hosts (`openHosts`). */
  openHosts?: ReadonlySet<string>
}

/**
 * The address an `<img>` shows for `favicon`, or null for the slot's glyph:
 *
 *  - nothing → null;
 *  - an inline `data:` icon, or an address on a scheme that is no site's (an extension's own
 *    icon) → itself, as before (no request to a site is made for it);
 *  - a cached icon's `zen://favicon/<hash>` → the host's address for it;
 *  - an `http(s)` icon the cache holds → the cached copy's address;
 *  - an `http(s)` icon the cache lacks → the live address for a slot that is no page's or whose
 *    page's site is open in a tab, else null.
 */
export function faviconSrc(
  favicon: string | null | undefined,
  options: FaviconSrcOptions
): string | null {
  if (!favicon) return null
  if (isFaviconUrl(favicon)) return hostFaviconUrl(favicon, options.platform)
  if (!/^https?:/i.test(favicon)) return favicon
  const hash = options.index.get(favicon)
  if (hash) return hostFaviconUrl(faviconUrl(hash), options.platform)
  if (options.pageUrl === undefined) return favicon
  const host = siteHost(options.pageUrl)
  return host && options.openHosts?.has(host) ? favicon : null
}

/** The host a page's site is known by in `openHosts`: lowercase, `www.` aside; '' for no host. */
export function siteHost(url: string | null | undefined): string {
  if (!url) return ''
  return getHost(url)
    .toLowerCase()
    .replace(/^www\./, '')
}

/** The hosts of a window's open tabs, for `faviconSrc`'s live fallback. */
export function openHosts(tabs: Iterable<{ url: string }>): Set<string> {
  const out = new Set<string>()
  for (const t of tabs) {
    const host = siteHost(t.url)
    if (host) out.add(host)
  }
  return out
}
