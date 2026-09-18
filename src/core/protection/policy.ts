import { hostnameOf, isThirdParty } from '../blocking/domain'
import type { RequestContext } from '../blocking/rules'
import { isNonUniqueHost } from '../../shared/nonUniqueHost'
import { hostInSites, type PrivacyFlags } from '../../shared/privacy'

/**
 * The per-request questions the hosts put to a {@link PrivacyFlags} document. Pure, so the
 * desktop handler and the tests share them; the Kotlin engine mirrors them (`privacy/Privacy.kt`).
 */

/**
 * Whether the request's cookies are to be withheld: it is a third-party request (its site is
 * not the top document's), the mode blocks third-party cookies in this partition, and neither
 * the request's site nor the document's is on the exception list. Main-frame navigations are
 * never third party.
 */
export function blocksThirdPartyCookies(flags: PrivacyFlags, ctx: RequestContext): boolean {
  if (flags.thirdPartyCookies === 'allow') return false
  if (flags.thirdPartyCookies === 'block-private' && !ctx.isPrivate) return false
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
