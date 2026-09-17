import type { TopSite } from '@shared/types'
import { cmd } from './api'

/**
 * Seam between the phone chrome and the history model the desktop program owns (contract v0 in
 * the project store, `internal/desktop-parity/history-interface.md`): the most visited sites
 * come from `history.topSites { n, excludedHosts } -> TopSite[]`, folded by host and ranked by
 * frecency in the core. The tiles read them through here and nowhere else.
 */

export type { TopSite }

/**
 * The most visited sites, `n` at most, without the hosts the user removed. A failed call (logged
 * by `cmd`) reads as no sites, so the page shows its empty state rather than nothing.
 */
export async function topSites(
  n: number,
  excludedHosts: readonly string[] = []
): Promise<TopSite[]> {
  return cmd('history.topSites', {
    n,
    excludedHosts: excludedHosts.length ? [...excludedHosts] : undefined
  }).catch(() => [])
}
