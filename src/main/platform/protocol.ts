import { protocol, type Session } from 'electron'
import { ZEN_SCHEME, zenPageHtml } from '../../shared/zenPages'

export { ZEN_SCHEME, describeNetError } from '../../shared/zenPages'

/** Must run before `app.ready`: lets `zen://` behave like a normal secure origin. */
export function registerZenScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ZEN_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false }
    }
  ])
}

export function installZenProtocol(ses: Session): void {
  if (ses.protocol.isProtocolHandled(ZEN_SCHEME)) return
  ses.protocol.handle(ZEN_SCHEME, (request) => {
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
    return new Response(zenPageHtml(request.url), { headers })
  })
}
