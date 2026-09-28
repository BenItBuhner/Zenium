/**
 * The per-document tracker report behind the blocked-requests counter: which sites the engine
 * stopped requests to, tallied by registrable domain, in the order it first saw them.
 *
 * Pure bookkeeping over `Tab.blockedSites`. Nothing here runs at boot; a record only grows when a
 * host engine reports a block, on the same path (and the same commit beat) as the count itself.
 */
import type { BlockedSite, BlockedSiteCategory } from '../../shared/types'
import { registrableDomain } from './domain'
import { USER_RULE_SET_ID } from './rules'

/**
 * Distinct domains kept per document. The first that many win; requests to later domains still
 * raise the count. Pages with more distinct blocked sites than this are rare enough that a stable
 * list is worth more than a complete one (an eviction policy would reorder the rows as they show).
 */
export const BLOCKED_SITES_CAP = 50

/** The set id a host passes for a frame Safe Browsing refused (no rule set matched). */
export const SAFE_BROWSING_SET_ID = 'safe-browsing'

/** One blocked request's origin as a host engine reports it. */
export interface BlockedRequestSource {
  /** Hostname of the blocked request (`stats.g.doubleclick.net`). */
  host: string
  /**
   * Id of the rule set that matched (`filter-text`, `user`, `ext:…`, `safe-browsing`); absent when
   * the engine did not say. Only its kind survives into the record.
   */
  setId?: string
  /** Requests from `host` this report stands for (Android batches a beat's worth); 1 when absent. */
  count?: number
}

/** The category a matched rule set's id maps to; a filter list or an unknown set reads `tracker`. */
export function blockedSiteCategory(setId: string | undefined): BlockedSiteCategory {
  if (setId === USER_RULE_SET_ID) return 'user'
  if (setId === SAFE_BROWSING_SET_ID) return 'unsafe'
  if (setId !== undefined && setId.startsWith('ext:')) return 'extension'
  return 'tracker'
}

/**
 * Fold `sources` into `sites` in place (creating the array when absent): a known domain's count
 * grows, a new domain is appended while there is room under the cap. Returns the array, or
 * `undefined` when nothing was recorded.
 */
export function recordBlockedSites(
  sites: BlockedSite[] | undefined,
  sources: readonly BlockedRequestSource[]
): BlockedSite[] | undefined {
  let list = sites
  for (const source of sources) {
    const count = source.count ?? 1
    if (count <= 0 || !source.host) continue
    const domain = registrableDomain(source.host)
    if (!domain) continue
    const known = list?.find((site) => site.domain === domain)
    if (known) {
      known.count += count
      continue
    }
    if (list && list.length >= BLOCKED_SITES_CAP) continue
    list ??= []
    list.push({ domain, category: blockedSiteCategory(source.setId), count })
  }
  return list
}
