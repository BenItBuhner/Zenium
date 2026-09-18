/**
 * Chrome's favicon resource for extensions. An extension holding the `favicon` permission loads
 * `chrome-extension://<id>/_favicon/?pageUrl=<url>&size=<px>` and gets the browser's icon for
 * that page, the default globe when the browser has none (the tab managers' and session savers'
 * lists are drawn with it). This module is the pure part: the request's shape and the default.
 */

/** The resource's path, exactly (Chrome matches the path, not a prefix). */
export const FAVICON_PATH = '/_favicon/'

/** Chrome's `size` when the request names none. */
export const DEFAULT_FAVICON_SIZE = 16

/** The largest `size` served (Chrome's favicon service tops out at the same). */
export const MAX_FAVICON_SIZE = 512

export interface FaviconRequest {
  extensionId: string
  /** The page whose icon is wanted, as the extension wrote it (percent-decoded). */
  pageUrl: string
  /** The wanted edge in CSS pixels; Zenium serves the icon as stored and lets the page scale it. */
  size: number
}

/** `url` parsed, when it is at the resource's path of some extension. */
function faviconResourceUrl(url: string): URL | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'chrome-extension:' || parsed.pathname !== FAVICON_PATH) return undefined
  return /^[a-p]{32}$/.test(parsed.hostname) ? parsed : undefined
}

/** Whether `url` is the resource at all, well-formed or not (a malformed request still fails). */
export function isFaviconResource(url: string): boolean {
  return faviconResourceUrl(url) !== undefined
}

/**
 * What `url` asks for, or undefined when it is not a well-formed favicon request of an
 * extension. The query is Chrome's: `pageUrl` (required), `size` (an integer, 16 by default;
 * anything else is 16) and `scaleFactor`, which Zenium reads and ignores.
 */
export function parseFaviconRequest(url: string): FaviconRequest | undefined {
  const parsed = faviconResourceUrl(url)
  if (!parsed) return undefined
  const extensionId = parsed.hostname
  const pageUrl = parsed.searchParams.get('pageUrl')
  if (!pageUrl) return undefined
  const size = Number.parseInt(parsed.searchParams.get('size') ?? '', 10)
  return {
    extensionId,
    pageUrl,
    size:
      Number.isInteger(size) && size > 0 ? Math.min(size, MAX_FAVICON_SIZE) : DEFAULT_FAVICON_SIZE
  }
}

/** The query a favicon request carries on to the route that serves it. */
export function faviconQuery(request: FaviconRequest): string {
  const params = new URLSearchParams({ pageUrl: request.pageUrl, size: String(request.size) })
  return params.toString()
}

/**
 * `policy` (one `Content-Security-Policy` value of an extension page) with `origin` allowed as
 * an image source. Chrome's `_favicon/` is `'self'` to the page; Zenium's lives on its served
 * origin, which a page restricting `img-src` (OneTab: `img-src 'self' data: https://t2.gstatic.com`)
 * would refuse, `*` included (a wildcard matches web schemes only). An `img-src` gets the origin
 * appended (`'none'` gives way to it); a policy restricting only `default-src` gets an `img-src`
 * of that list plus the origin; one restricting neither comes back as it was.
 */
export function allowImageSource(policy: string, origin: string): string {
  const directives = policy
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.length > 0)
  const indexOf = (name: string): number =>
    directives.findIndex((d) => d.split(/\s+/)[0].toLowerCase() === name)
  const img = indexOf('img-src')
  if (img !== -1) {
    directives[img] = withSource(directives[img], origin)
    return directives.join('; ')
  }
  const fallback = indexOf('default-src')
  if (fallback === -1) return policy
  directives.push(withSource(directives[fallback].replace(/^\S+/, 'img-src'), origin))
  return directives.join('; ')
}

function withSource(directive: string, origin: string): string {
  const [name, ...sources] = directive.split(/\s+/)
  if (sources.some((s) => s.toLowerCase() === origin.toLowerCase())) return directive
  const kept = sources.filter((s) => s.toLowerCase() !== "'none'")
  return [name, ...kept, origin].join(' ')
}

/** Chrome's stand-in for a page without an icon: a grey globe. */
export const DEFAULT_FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">' +
  '<g fill="none" stroke="#8a8f98" stroke-width="1.25">' +
  '<circle cx="8" cy="8" r="6.4"/><ellipse cx="8" cy="8" rx="2.6" ry="6.4"/>' +
  '<path d="M1.6 8h12.8M2.6 5h10.8M2.6 11h10.8"/></g></svg>'

export const DEFAULT_FAVICON_TYPE = 'image/svg+xml'

/** An icon's bytes and media type, as a response carries them. */
export interface FaviconImage {
  body: Uint8Array
  type: string
}

/**
 * Decodes a `data:` favicon (base64 or percent-encoded) into its bytes; undefined if malformed.
 * Web platform APIs only: the core runs in the Android WebView as well as in Node.
 */
export function decodeDataUrl(url: string): FaviconImage | undefined {
  const match = /^data:([^,;]*)((?:;[^,]*)*),(.*)$/s.exec(url)
  if (!match) return undefined
  const type = match[1] || 'text/plain'
  const base64 = /;base64/i.test(match[2])
  try {
    const body = base64
      ? Uint8Array.from(atob(match[3].replace(/\s+/g, '')), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(match[3]))
    return body.length > 0 ? { body, type } : undefined
  } catch {
    return undefined
  }
}
