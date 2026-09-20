import type { ClosedEntrySummary, TabSearchCandidate } from './types'
import { displayHost, displayUrl } from './url'

/*
 * Matching and ranking for the tab search popover (tabs-17; Chrome's Ctrl+Shift+A). Pure and
 * shared so the desktop chrome and its unit tests run the same code the phone could.
 */

/** A half-open `[start, end)` range of the matched text, for highlighting. */
export type MatchRange = [number, number]

export interface FieldMatch {
  score: number
  ranges: MatchRange[]
}

export interface RankedTab {
  tab: TabSearchCandidate
  score: number
  /** Where the query matched in the title and in the host line (empty when it did not). */
  title: MatchRange[]
  host: MatchRange[]
}

export interface RankedClosed {
  entry: ClosedEntrySummary
  score: number
  title: MatchRange[]
  host: MatchRange[]
}

/** Recently closed entries the popover lists when nothing is typed (Chrome shows a handful). */
export const RECENTLY_CLOSED_LIMIT = 8

const isWordStart = (text: string, index: number): boolean =>
  index === 0 || !/[\p{L}\p{N}]/u.test(text[index - 1] ?? '')

/**
 * How well `query` matches `text`, case-insensitively. A contiguous match scores highest – more
 * so at the start of a word, most at the start of the text – and a query whose characters appear
 * in order but apart (`gh` in "GitHub") still matches, each character worth less the further it
 * sits from the previous one. Null when a character of the query is missing. Scores are
 * comparable across fields: a contiguous match of the whole query in a short title outranks a
 * scattered one in a long URL.
 */
export function matchField(text: string, query: string): FieldMatch | null {
  const q = query.trim().toLowerCase()
  if (!q) return { score: 0, ranges: [] }
  const t = text.toLowerCase()
  const at = t.indexOf(q)
  if (at !== -1) {
    // Prefer the leftmost word-start occurrence when there is one.
    let start = at
    for (let i = at; i !== -1; i = t.indexOf(q, i + 1)) {
      if (isWordStart(t, i)) {
        start = i
        break
      }
    }
    let score = 100
    if (start === 0) score += 40
    else if (isWordStart(t, start)) score += 25
    if (q.length === t.length) score += 20
    // A shorter text is a closer match for the same substring.
    score += Math.max(0, 20 - Math.floor(t.length / 8))
    return { score, ranges: [[start, start + q.length]] }
  }
  // Scattered: every character in order, greedy from the left, favouring word starts; when
  // reaching for word starts skips past a character the rest of the query needed, the plain
  // left-to-right pass decides.
  return scattered(t, q, true) ?? scattered(t, q, false)
}

function scattered(t: string, q: string, preferWordStarts: boolean): FieldMatch | null {
  const ranges: MatchRange[] = []
  let score = 0
  let cursor = 0
  let previousEnd = -1
  for (const ch of q) {
    if (/\s/.test(ch)) continue
    let index = t.indexOf(ch, cursor)
    if (index === -1) return null
    if (preferWordStarts && !isWordStart(t, index)) {
      // A word-start occurrence not too far on reads better than the first letter found.
      for (
        let i = t.indexOf(ch, index + 1);
        i !== -1 && i - cursor <= 24;
        i = t.indexOf(ch, i + 1)
      ) {
        if (isWordStart(t, i)) {
          index = i
          break
        }
      }
    }
    const consecutive = index === previousEnd
    score += consecutive ? 12 : isWordStart(t, index) ? 8 : 3
    score -= Math.min(6, Math.max(0, index - Math.max(previousEnd, 0)) / 4)
    const last = ranges.at(-1)
    if (last && last[1] === index) last[1] = index + 1
    else ranges.push([index, index + 1])
    previousEnd = index + 1
    cursor = index + 1
  }
  // Scattered matches never reach a contiguous one, and cannot be negative.
  return { score: Math.max(1, Math.min(90, Math.round(score))), ranges }
}

/** The host line of a row: the site, an internal page's name, never a `zen://` address. */
export function searchHost(url: string): string {
  return displayHost(url)
}

/**
 * Match a tab against the query over its title and its address – the host line the row shows
 * and the full address without its scheme, so a path or query string can be typed too. The
 * best field wins, the title counting a little more than the address (Chrome weights titles
 * higher than hostnames).
 */
export function scoreTab(
  tab: { title: string; url: string },
  query: string
): { score: number; title: MatchRange[]; host: MatchRange[] } | null {
  const title = matchField(tab.title, query)
  const host = matchField(searchHost(tab.url), query)
  const address = matchField(displayUrl(tab.url), query)
  if (!title && !host && !address) return null
  const titleScore = title ? title.score * 1.1 : -1
  const hostScore = host ? host.score : -1
  const addressScore = address ? address.score * 0.8 : -1
  const score = Math.max(titleScore, hostScore, addressScore)
  return {
    score,
    title: title?.ranges ?? [],
    // The address ranges are not shown (the row shows the host line), only the host's.
    host: host?.ranges ?? []
  }
}

/**
 * The open tabs in the order the popover lists them. With nothing typed: most recently active
 * first, the tab the window shows right now last – Enter then goes to the previous tab, as it
 * does in Chrome. With a query: every tab it matches, best match first, recency breaking ties.
 */
export function rankTabs(tabs: TabSearchCandidate[], query: string): RankedTab[] {
  const q = query.trim()
  if (!q) {
    const byRecency = [...tabs].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    const current = byRecency.filter((t) => t.active && !t.windowLabel)
    const rest = byRecency.filter((t) => !(t.active && !t.windowLabel))
    return [...rest, ...current].map((tab) => ({ tab, score: 0, title: [], host: [] }))
  }
  const out: RankedTab[] = []
  for (const tab of tabs) {
    const match = scoreTab(tab, q)
    if (match) out.push({ tab, ...match })
  }
  return out.sort((a, b) => b.score - a.score || b.tab.lastActiveAt - a.tab.lastActiveAt)
}

/** Recently closed entries for the popover: all of the newest few, or the ones a query matches. */
export function rankClosed(entries: ClosedEntrySummary[], query: string): RankedClosed[] {
  const q = query.trim()
  if (!q) {
    return entries
      .slice(0, RECENTLY_CLOSED_LIMIT)
      .map((entry) => ({ entry, score: 0, title: [], host: [] }))
  }
  const out: RankedClosed[] = []
  for (const entry of entries) {
    const match = scoreTab({ title: entry.title, url: entry.url ?? '' }, q)
    if (match) out.push({ entry, ...match })
  }
  return out.sort((a, b) => b.score - a.score || b.entry.closedAt - a.entry.closedAt)
}

/** The tabs playing (or muted while they would play) sound: Chrome's "Audio and video" section. */
export function mediaTabs(ranked: RankedTab[]): RankedTab[] {
  return ranked.filter((r) => r.tab.audible || r.tab.muted)
}
