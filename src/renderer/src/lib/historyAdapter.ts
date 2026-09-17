import type { HistoryEntry } from '@shared/types'
import { getHost } from '@shared/url'
import { cmd } from './api'

/**
 * Seam between the phone chrome and the history model the desktop program owns (contract v0 in
 * the project store, `internal/desktop-parity/history-interface.md`): the most visited sites
 * come from `history.topSites { n, excludedHosts } -> TopSite[]`. Until that command is on
 * `main` the call fails as unknown, and the sites are ranked here from what `history.recent`
 * gives today. When the contract lands, `TopSite` moves to the shared types, `topSites()`
 * becomes the one `cmd('history.topSites', …)` call, and the fallback below goes with this file.
 */

/** Contract v0's shape, so the tiles need no change when the real command arrives. */
export interface TopSite {
  url: string
  title: string
  favicon: string | null
  score: number
}

/** The contract's command, called by name because `Commands` does not declare it yet. */
const TOP_SITES_COMMAND = 'history.topSites'

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

function isTopSite(value: unknown): value is TopSite {
  if (!value || typeof value !== 'object') return false
  const site = value as Record<string, unknown>
  return (
    typeof site.url === 'string' &&
    typeof site.title === 'string' &&
    (site.favicon === null || typeof site.favicon === 'string') &&
    typeof site.score === 'number'
  )
}

/** The result of `history.topSites` when it is the contract's, or null for anything else. */
export function parseTopSites(value: unknown): TopSite[] | null {
  return Array.isArray(value) && value.every(isTopSite) ? value : null
}

/** Whether a failed call means the core does not know the command (rather than a real error). */
export function isUnknownCommandError(error: unknown, name: string): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /unknown command/i.test(message) && message.includes(name)
}

type LooseInvoke = (name: string, args: unknown) => Promise<unknown>

/**
 * Whether the core behind this chrome answers `history.topSites`. Unknown until the first call;
 * once the command has failed as unknown the fallback is used for the rest of the session, so
 * the console does not fill with the same rejection on every new tab page.
 */
let contractAvailable: boolean | null = null

async function contractTopSites(
  n: number,
  excludedHosts: readonly string[]
): Promise<TopSite[] | null> {
  if (contractAvailable === false) return null
  // `cmd` is typed against `Commands`, which does not declare the contract yet, and it logs every
  // rejection; the probe goes to the bridge directly and stays quiet when the command is unknown.
  const invoke = window.zen.invoke as unknown as LooseInvoke
  try {
    const result = await invoke(TOP_SITES_COMMAND, {
      n,
      excludedHosts: excludedHosts.length ? [...excludedHosts] : undefined
    })
    const sites = parseTopSites(result)
    if (sites) contractAvailable = true
    return sites
  } catch (error) {
    if (isUnknownCommandError(error, TOP_SITES_COMMAND)) {
      contractAvailable = false
      return null
    }
    console.error(`[zen] command ${TOP_SITES_COMMAND} failed`, error)
    return null
  }
}

/**
 * The most visited sites, `n` at most, without the hosts the user removed: the contract's
 * answer when the core has it, otherwise ranked here from the recent aggregates.
 */
export async function topSites(
  n: number,
  excludedHosts: readonly string[] = []
): Promise<TopSite[]> {
  const fromContract = await contractTopSites(n, excludedHosts)
  if (fromContract) return fromContract.slice(0, Math.max(0, n))
  const entries = await cmd('history.recent', { limit: RECENT_LIMIT }).catch(() => [])
  return rankTopSites(entries, { now: Date.now(), n, excludedHosts })
}
