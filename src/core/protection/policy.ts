import { hostnameOf, isThirdParty } from '../blocking/domain'
import type { RequestContext } from '../blocking/rules'
import { isNonUniqueHost } from '../../shared/nonUniqueHost'
import { hostInSites, thirdPartyCookiesBlockedIn, type PrivacyFlags } from '../../shared/privacy'
import { cookieVerdict } from '../../shared/siteData'

/**
 * The per-request questions the hosts put to a {@link PrivacyFlags} document. Pure, so the
 * desktop handler and the tests share them; the Kotlin engine mirrors them (`privacy/Privacy.kt`).
 */

/**
 * Whether the request goes without cookies – no `Cookie` sent, no `Set-Cookie` kept – under
 * the whole policy: the per-site lists and the "block all" default first
 * (`cookieVerdict`: a never-site's request always does, a listed site's never does, whatever
 * the context), then the third-party rule for the rest ({@link blocksThirdPartyCookies}). The
 * hosts' header stages ask this per request; the Kotlin twin is `PrivacyFlags.cookiesWithheld`.
 */
export function cookiesWithheld(flags: PrivacyFlags, ctx: RequestContext): boolean {
  switch (cookieVerdict(flags.siteData, ctx.url)) {
    case 'blocked':
      return true
    case 'allowed':
      return false
    case 'default':
      return blocksThirdPartyCookies(flags, ctx)
  }
}

/**
 * Whether the request's cookies are to be withheld: it is a third-party request (its site is
 * not the top document's), the policy blocks third-party cookies in this partition (the global
 * mode, or in a private window the private override: `thirdPartyCookiesBlockedIn`), and
 * neither the request's site nor the document's is on the exception list. Main-frame
 * navigations are never third party.
 */
export function blocksThirdPartyCookies(flags: PrivacyFlags, ctx: RequestContext): boolean {
  if (!thirdPartyCookiesBlockedIn(flags, ctx.isPrivate === true)) return false
  if (ctx.type === 'main_frame') return false
  const document = ctx.documentUrl ?? ctx.initiator
  if (!document) return false
  if (!(ctx.isThirdParty ?? isThirdParty(ctx.url, document))) return false
  if (flags.thirdPartyCookieExceptions.length === 0) return true
  const requestHost = hostnameOf(ctx.url)
  const documentHost = hostnameOf(document)
  if (requestHost && hostInSites(requestHost, flags.thirdPartyCookieExceptions)) return false
  if (documentHost && hostInSites(documentHost, flags.thirdPartyCookieExceptions)) return false
  return true
}

/**
 * Whether HTTPS-only mode leaves an `http://` request of `url` alone: the mode is off, the host
 * is non-unique (`isNonUniqueHost`), or it is on (or under) a site the user allowed over
 * plaintext. The engine's own rule already excludes both; this is for a host that consults the
 * flags ahead of a reloaded rule set.
 */
export function plaintextAllowed(flags: PrivacyFlags, url: string): boolean {
  if (flags.httpsOnly === 'off') return true
  const host = hostnameOf(url)
  return host !== null && (isNonUniqueHost(host) || hostInSites(host, flags.httpsOnlyAllowed))
}

/** The request headers the privacy signals add, by their wire names. */
export function signalHeaders(flags: PrivacyFlags): Record<string, string> {
  const out: Record<string, string> = {}
  if (flags.gpc) out['Sec-GPC'] = '1'
  if (flags.dnt) out['DNT'] = '1'
  return out
}

/**
 * Whether a request is one of the speculative loads Preload pages governs (PS-43), by the header
 * Chromium puts on exactly those and no page can forge (`Sec-` prefix): `Sec-Purpose: prefetch`
 * on `<link rel=prefetch>` and a speculation-rules prefetch, `prefetch;prerender` on the
 * prefetch a prerender starts with. Measured under Electron 44 (Chromium 152): the link prefetch
 * reports `resourceType: other`, the speculation-rules ones `mainFrame` – the type alone tells a
 * prefetch from a beacon or a navigation no better than that, the header does. The legacy
 * `Purpose: prefetch` is read too, though Chromium no longer sends it. Header names as the
 * host passes them, in any case.
 */
export function isPreloadRequest(headers: Readonly<Record<string, string>>): boolean {
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (lower !== 'sec-purpose' && lower !== 'purpose') continue
    if (value.split(';').some((token) => token.trim().toLowerCase() === 'prefetch')) return true
  }
  return false
}
