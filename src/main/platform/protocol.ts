import { protocol, type CustomScheme, type Session } from 'electron'
import { faviconHashOf } from '../../shared/favicons'
import { CHROMIUM_LICENCES_HOST } from '../../shared/licences'
import type { ColorScheme } from '../../shared/types'
import { ZEN_SCHEME, zenPageHtml, type ReaderPageLookup } from '../../shared/zenPages'
import { EXTENSION_RESOURCE_SCHEME_PRIVILEGES } from './extensionApi/resourceOrigin'
import type { ChromiumLicencesResponder } from './licences'
import { NEW_TAB_BACKGROUND_HOST } from './newTabBackground'

export { ZEN_SCHEME, describeNetError } from '../../shared/zenPages'

/** Chrome's scheme of extension pages and resources. */
export const CHROME_EXTENSION_SCHEME = 'chrome-extension'

/**
 * The schemes Zenium registers as privileged: `zen://` as a normal secure origin,
 * `zen-extension://` (extensions' `use_dynamic_url` resources) as one pages may fetch from, and
 * `chrome-extension://` as standard once more. The engine registers that one itself, but grants
 * the sandboxed file system (`webkitRequestFileSystem`, which Chrome gives every extension page;
 * GoFullPage keeps its captures there) only to http, https and the standard schemes named in
 * this call, so naming it here is what lets extension pages open one.
 */
export function privilegedSchemes(): CustomScheme[] {
  return [
    {
      scheme: ZEN_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false }
    },
    EXTENSION_RESOURCE_SCHEME_PRIVILEGES,
    { scheme: CHROME_EXTENSION_SCHEME, privileges: { standard: true } }
  ]
}

/** Must run before `app.ready`, and only once. */
export function registerZenScheme(): void {
  protocol.registerSchemesAsPrivileged(privilegedSchemes())
}

/** Bytes of `zen://newtab-background` (the new tab page's custom image), or a 404 response. */
export type BackgroundImageResponder = () => Promise<Response>

/**
 * The favicon cache's copy of the icon named `hash` (`core/favicons.ts` `document`), or null
 * when the cache has none: what `zen://favicon/<hash>` serves (HB-47).
 */
export type FaviconResponder = (
  hash: string
) => Promise<{ bytes: Uint8Array; mime: string } | null>

/** `zen://favicon/<hash>`'s host. */
export const FAVICON_HOST = 'favicon'

/**
 * Serve `zen://newtab`, `zen://blank`, `zen://error` and `zen://reader` (articles come from the
 * core), plus the new tab page's background image, the favicon cache's icons
 * (`zen://favicon/<hash>`) and Chromium's credits document (`zen://chromium-licences`,
 * `./licences.ts`). `colorScheme` is the Appearance setting as it stands when a page is served:
 * the documents that paint a theme of their own take it from there rather than from the engine
 * (`errorPageAttributesScript`).
 */
export function installZenProtocol(
  ses: Session,
  reader: ReaderPageLookup,
  background?: BackgroundImageResponder,
  chromiumLicences?: ChromiumLicencesResponder,
  colorScheme: () => ColorScheme = () => 'system',
  favicon?: FaviconResponder
): void {
  if (ses.protocol.isProtocolHandled(ZEN_SCHEME)) return
  ses.protocol.handle(ZEN_SCHEME, (request) => {
    const host = hostOf(request.url)
    if (background && host === NEW_TAB_BACKGROUND_HOST) return background()
    if (chromiumLicences && host === CHROMIUM_LICENCES_HOST) return chromiumLicences()
    if (favicon && host === FAVICON_HOST) return faviconResponse(request.url, favicon)
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
    return new Response(zenPageHtml(request.url, reader, undefined, undefined, colorScheme()), {
      headers
    })
  })
}

/**
 * The chrome's own session (Electron's default session, where the windows' documents live)
 * serves the favicon cache alone under `zen://`: the sidebar, the history page and the bookmarks
 * draw their icons from `zen://favicon/<hash>` there; every other `zen://` address is a page's
 * and lives in the container sessions (`installZenProtocol`).
 */
export function installFaviconProtocol(ses: Session, favicon: FaviconResponder): void {
  if (ses.protocol.isProtocolHandled(ZEN_SCHEME)) return
  ses.protocol.handle(ZEN_SCHEME, (request) =>
    hostOf(request.url) === FAVICON_HOST
      ? faviconResponse(request.url, favicon)
      : new Response(null, { status: 404 })
  )
}

/**
 * `zen://favicon/<hash>`: the icon's bytes under their type, cacheable for good – the address
 * is the content's, so the copy never goes stale – or 404 when the cache has no such icon (the
 * chrome's `<img>` falls back to its glyph).
 */
export async function faviconResponse(url: string, favicon: FaviconResponder): Promise<Response> {
  const hash = faviconHashOf(url)
  const icon = hash ? await favicon(hash) : null
  if (!icon) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })
  return new Response(icon.bytes as BodyInit, {
    headers: {
      'content-type': icon.mime,
      'content-length': String(icon.bytes.length),
      'cache-control': 'public, max-age=31536000, immutable'
    }
  })
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}
