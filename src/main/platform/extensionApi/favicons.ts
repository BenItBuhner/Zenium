/**
 * `chrome-extension://<id>/_favicon/?pageUrl=…` served for extensions (`core/extensions/favicon.ts`
 * has the shape). Electron's extension loader knows no such resource: the request never answers,
 * and a page that waits for the image before it draws (OneTab's list) waits forever. Zenium
 * answers it in two steps. The {@link faviconRequestHandler} runs first in the session's request
 * pipeline and sends the request of an extension holding the `favicon` permission to the
 * `_favicon/` route of the served extension origin (`resourceOrigin.ts`); without the permission
 * the request fails, as it does in Chrome. The route asks {@link ExtensionFavicons} for the page's
 * icon: the URL the history and bookmarks models already keep for the page (its own entry, a
 * bookmark of it, else the newest icon of its domain), fetched once per run and served as stored,
 * or the default globe when they know none.
 */
import { net } from 'electron'
import type { BookmarkService } from '../../../core/bookmarks'
import {
  allowImageSource,
  decodeDataUrl,
  isFaviconResource,
  parseFaviconRequest,
  type FaviconImage
} from '../../../core/extensions/favicon'
import type { HistoryService } from '../../../core/history'
import { getDomain } from '../../../shared/url'
import { HANDLER_ORDER, type RequestHandler } from '../webRequest'
import type { ExtensionResourceOrigin, FaviconProvider } from './resourceOrigin'

/** Before the rule engine: an extension's own resource is not a request the engine judges. */
export const FAVICON_HANDLER_ORDER = HANDLER_ORDER.ruleEngine - 50

const FETCH_MS = 5000
const MAX_BYTES = 512 * 1024
const CACHE_MAX = 512

/** The models the icons come from. */
export interface FaviconModels {
  history: Pick<HistoryService, 'faviconFor' | 'faviconsByDomain'>
  bookmarks: Pick<BookmarkService, 'findByUrl'>
}

/** Fetches one remote icon; undefined for anything but an image. */
export type IconFetcher = (url: string) => Promise<FaviconImage | undefined>

const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ico: 'image/x-icon',
  png: 'image/png',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  webp: 'image/webp'
}

/** The type a fetched icon is served as: the response's when it says image, else by its name. */
export function iconType(url: string, contentType: string | null): string {
  const declared = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (declared.startsWith('image/')) return declared
  const path = url.split(/[?#]/)[0]
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return TYPE_BY_EXTENSION[extension] ?? 'image/x-icon'
}

async function electronIconFetcher(url: string): Promise<FaviconImage | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_MS)
  try {
    const response = await net.fetch(url, {
      signal: controller.signal,
      bypassCustomProtocolHandlers: true
    })
    if (!response.ok) return undefined
    const body = new Uint8Array(await response.arrayBuffer())
    if (body.length === 0 || body.length > MAX_BYTES) return undefined
    return { body, type: iconType(url, response.headers.get('content-type')) }
  } finally {
    clearTimeout(timer)
  }
}

/** Page icons from the models that keep them, remote ones fetched once per run. */
export class ExtensionFavicons implements FaviconProvider {
  /** Settled or pending fetches by icon URL; a failure stays (not retried this run). */
  private readonly fetched = new Map<string, Promise<FaviconImage | undefined>>()

  constructor(
    private readonly models: FaviconModels,
    private readonly fetchIcon: IconFetcher = electronIconFetcher
  ) {}

  /** The icon URL the models know for the page, or null. */
  iconUrlFor(pageUrl: string): string | null {
    const own = this.models.history.faviconFor(pageUrl)
    if (own) return own
    const bookmarked = this.models.bookmarks.findByUrl(pageUrl).find((n) => n.favicon)?.favicon
    if (bookmarked) return bookmarked
    const domain = getDomain(pageUrl)
    return (domain && this.models.history.faviconsByDomain().get(domain)) || null
  }

  faviconFor(pageUrl: string): Promise<FaviconImage | undefined> {
    const url = this.iconUrlFor(pageUrl)
    if (!url) return Promise.resolve(undefined)
    if (url.startsWith('data:')) return Promise.resolve(decodeDataUrl(url))
    if (!/^https?:\/\//i.test(url)) return Promise.resolve(undefined)
    let pending = this.fetched.get(url)
    if (!pending) {
      pending = this.fetchIcon(url).catch(() => undefined)
      if (this.fetched.size >= CACHE_MAX) {
        const oldest = this.fetched.keys().next().value
        if (oldest !== undefined) this.fetched.delete(oldest)
      }
      this.fetched.set(url, pending)
    }
    return pending
  }
}

/** The extension whose document `url` is, when it is one. */
function documentExtensionId(url: string): string | undefined {
  const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(url)
  return match?.[1]
}

/**
 * The pipeline handler. Before the request: a `_favicon/` request of an extension that holds
 * the `favicon` permission (`allowed`) is redirected to the served origin's route; one of an
 * extension without it, of no loaded extension, or without a page is cancelled rather than
 * left hanging. On the headers of such an extension's own documents: the served origin is let
 * through the page's `Content-Security-Policy` as an image source, where Chrome's `_favicon/`
 * counts as `'self'`.
 */
export function faviconRequestHandler(
  origin: ExtensionResourceOrigin,
  allowed: (extensionId: string) => boolean
): RequestHandler {
  return {
    id: 'extension-favicon',
    order: FAVICON_HANDLER_ORDER,
    onBeforeRequest(_request, details) {
      const wanted = parseFaviconRequest(details.url)
      if (!wanted) return isFaviconResource(details.url) ? { cancel: true } : undefined
      const target = allowed(wanted.extensionId) ? origin.faviconUrl(wanted) : undefined
      return target ? { redirectURL: target } : { cancel: true }
    },
    onHeadersReceived(request, headers, details) {
      const { type } = request.ctx
      if (type !== 'main_frame' && type !== 'sub_frame') return undefined
      const extensionId = documentExtensionId(details.url)
      if (!extensionId || !allowed(extensionId)) return undefined
      const source = origin.faviconOrigin(extensionId)
      if (!source) return undefined
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() !== 'content-security-policy') continue
        headers[name] = headers[name].map((policy) => allowImageSource(policy, source))
      }
      return undefined
    }
  }
}
