import type { HistoryEntry } from '@shared/types'
import { getHost } from '@shared/url'
import { cmd } from './api'

/**
 * Seam between the phone chrome and the history model the desktop program owns (contract v0:
 * `history.topSites { n, excludedHosts } -> TopSite[]`). The command is not on `main` yet, so
 * the most visited sites are ranked here from what `history.recent` gives today. When the
 * contract lands, `topSites()` becomes one `cmd('history.topSites', …)` call and the ranking
 * below goes with this file.
 */

/** Contract v0's shape, so the tiles need no change when the real command arrives. */
export interface TopSite {
  url: string
  title: string
  favicon: string | null
  score: number
}

/** How many aggregates the fallback pulls to rank from; a profile rarely has more visited sites. */
const RECENT_LIMIT = 400

const DAY = 24 * 60 * 60 * 1000

/**
 * Firefox's frecency in miniature: the visit count weighted by how recently the site was last
 * seen. Only the per-URL aggregate exists today, so one weight stands for all of a URL's visits.
 */
export function scoreFrecency(
  entry: Pick<HistoryEntry, 'visitCount' | 'lastVisit'>,
  now: number
): number {
  const age = Math.max(0, now - entry.lastVisit)
  const weight =
    age <= 4 * DAY ? 100 : age <= 14 * DAY ? 70 : age <= 31 * DAY ? 50 : age <= 90 * DAY ? 30 : 10
  return Math.max(1, entry.visitCount) * weight
}

/** Only web pages make a tile: internal, error, data and view-source URLs are never shown. */
export function isTopSiteCandidate(url: string): boolean {
  return /^https?:\/\/[^/]+/i.test(url) && getHost(url) !== ''
}

/** Host without `www.`, lower-cased: the identity a tile stands for. */
export function topSiteHost(url: string): string {
  return getHost(url)
    .toLowerCase()
    .replace(/^www\./, '')
}

/**
 * Rank history aggregates into at most `n` sites, one per host: a host's score is the sum over
 * its pages, and the page that represents it is its best-scoring one (the shorter URL on a tie,
 * which favours a site's front page). Hosts in `excludedHosts` are skipped.
 */
export function rankTopSites(
  entries: readonly HistoryEntry[],
  opts: { now: number; n: number; excludedHosts?: readonly string[] }
): TopSite[] {
  const excluded = new Set((opts.excludedHosts ?? []).map((h) => h.toLowerCase()))
  const byHost = new Map<string, { best: HistoryEntry; bestScore: number; total: number }>()
  for (const entry of entries) {
    if (!entry || typeof entry.url !== 'string' || !isTopSiteCandidate(entry.url)) continue
    const host = topSiteHost(entry.url)
    if (!host || excluded.has(host)) continue
    const score = scoreFrecency(entry, opts.now)
    const current = byHost.get(host)
    if (!current) {
      byHost.set(host, { best: entry, bestScore: score, total: score })
      continue
    }
    current.total += score
    if (
      score > current.bestScore ||
      (score === current.bestScore && entry.url.length < current.best.url.length)
    ) {
      current.best = entry
      current.bestScore = score
    }
  }
  return [...byHost.values()]
    .sort((a, b) => b.total - a.total || b.best.lastVisit - a.best.lastVisit)
    .slice(0, Math.max(0, opts.n))
    .map(({ best, total }) => ({
      url: best.url,
      title: best.title,
      favicon: best.favicon ?? null,
      score: total
    }))
}

/** The most visited sites, `n` at most, without the hosts the user removed. */
export async function topSites(
  n: number,
  excludedHosts: readonly string[] = []
): Promise<TopSite[]> {
  const entries = await cmd('history.recent', { limit: RECENT_LIMIT }).catch(() => [])
  return rankTopSites(entries, { now: Date.now(), n, excludedHosts })
}
