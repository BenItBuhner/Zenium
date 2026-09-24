import { protocol, type CustomScheme, type Session } from 'electron'
import { CHROMIUM_LICENCES_HOST } from '../../shared/licences'
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
 * Serve `zen://newtab`, `zen://blank`, `zen://error` and `zen://reader` (articles come from the
 * core), plus the new tab page's background image and Chromium's credits document
 * (`zen://chromium-licences`, `./licences.ts`).
 */
export function installZenProtocol(
  ses: Session,
  reader: ReaderPageLookup,
  background?: BackgroundImageResponder,
  chromiumLicences?: ChromiumLicencesResponder
): void {
  if (ses.protocol.isProtocolHandled(ZEN_SCHEME)) return
  ses.protocol.handle(ZEN_SCHEME, (request) => {
    const host = hostOf(request.url)
    if (background && host === NEW_TAB_BACKGROUND_HOST) return background()
    if (chromiumLicences && host === CHROMIUM_LICENCES_HOST) return chromiumLicences()
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
