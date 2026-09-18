import { protocol, type Session } from 'electron'
import { ZEN_SCHEME, zenPageHtml, type ReaderPageLookup } from '../../shared/zenPages'
import { EXTENSION_RESOURCE_SCHEME_PRIVILEGES } from './extensionApi/resourceOrigin'
import { NEW_TAB_BACKGROUND_HOST } from './newTabBackground'

export { ZEN_SCHEME, describeNetError } from '../../shared/zenPages'

/**
 * Must run before `app.ready` (and only once): lets `zen://` behave like a normal secure origin,
 * and `zen-extension://` (extensions' `use_dynamic_url` resources) like one pages may fetch from.
 */
export function registerZenScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ZEN_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false }
    },
    EXTENSION_RESOURCE_SCHEME_PRIVILEGES
  ])
}

/** Bytes of `zen://newtab-background` (the new tab page's custom image), or a 404 response. */
export type BackgroundImageResponder = () => Promise<Response>

/**
 * Serve `zen://newtab`, `zen://blank`, `zen://error` and `zen://reader` (articles come from the
 * core), plus the new tab page's background image.
 */
export function installZenProtocol(
  ses: Session,
  reader: ReaderPageLookup,
  background?: BackgroundImageResponder
): void {
  if (ses.protocol.isProtocolHandled(ZEN_SCHEME)) return
  ses.protocol.handle(ZEN_SCHEME, (request) => {
    if (background && hostOf(request.url) === NEW_TAB_BACKGROUND_HOST) return background()
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
    return new Response(zenPageHtml(request.url, reader), { headers })
  })
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}
