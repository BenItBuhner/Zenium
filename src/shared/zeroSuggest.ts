import type { HistoryEntry, SearchEngine } from './types'
import { isActiveSearchEngine, searchTermsFromUrl } from './search'

/** The "Recent searches" section of zero-suggest (omnibox-20). */
export const RECENT_SEARCHES_GROUP = 'Recent searches'
/** The recent pages' section of the phone card's zero-suggest (OMN-18; Chrome's heading). */
export const RECENTLY_VISITED_GROUP = 'Recently visited'
/**
 * Zero-suggest's most-visited row (OMN-04; Chrome for Android's `GROUP_MOBILE_MOST_VISITED`): the
 * core lists the tiles as address rows of this group, and the phone sheet and the tablet popup
 * draw the group as one horizontal row of tiles instead of rows.
 */
export const MOST_VISITED_GROUP = 'Most visited'

/**
 * How far back in the history a search is still a "recent search" (OMN-04): the searches among
 * the last this many pages visited. Chrome's local recent searches rank every search term the
 * history holds; Zenium's are recency-ordered, so a window keeps the list to what is recent and
 * bounds the scan. The forget path scans the same window: what the row was derived from is what
 * removing it deletes.
 */
export const RECENT_SEARCH_SCAN = 1000

/** A search the history remembers: the results page's visit, read back through the engine's template. */
export interface HistorySearch {
  /** The terms as the page's address carries them (trimmed). */
  terms: string
  /** The engine whose results page it was; the default engine first when two templates fit. */
  engine: SearchEngine
  /** The most recent results page's address for these terms. */
  url: string
  /** When that page was last visited. */
  lastVisit: number
}

/**
 * The engines whose results pages are read: the default engine first – a page that fits two
 * templates is the default engine's – then the other active ones; an inactive engine is offered
 * nowhere (settings-43) and its pages are plain pages.
 */
export function searchEnginesInOrder(
  engines: readonly SearchEngine[],
  defaultEngine: SearchEngine
): SearchEngine[] {
  return [defaultEngine, ...engines.filter((e) => e !== defaultEngine && isActiveSearchEngine(e))]
}

/**
 * The searches among `entries` (most recent first, as `history.recent` lists them), one per
 * terms – the same terms searched twice, or on two engines, are one search, the most recent
 * visit's – most recent first. A page that is no engine's results page is not a search; a
 * results page without terms is not one either.
 */
export function searchesInHistory(
  entries: readonly Pick<HistoryEntry, 'url' | 'lastVisit'>[],
  engines: readonly SearchEngine[]
): HistorySearch[] {
  const byTerms = new Map<string, HistorySearch>()
  for (const entry of entries) {
    const found = searchOf(entry.url, engines)
    if (!found) continue
    const key = found.terms.toLowerCase()
    const seen = byTerms.get(key)
    if (seen && seen.lastVisit >= entry.lastVisit) continue
    byTerms.set(key, { ...found, url: entry.url, lastVisit: entry.lastVisit })
  }
  return [...byTerms.values()].sort((a, b) => b.lastVisit - a.lastVisit)
}

/**
 * The results pages among `entries` that are the search for `terms` (case aside) on any of
 * `engines`: what forgetting the recent search deletes from the history (Chrome deletes the
 * search's URLs with its term, `LocalHistoryZeroSuggestProvider::DeleteMatch`), so the history
 * does not offer the search again.
 */
export function searchVisitUrls(
  entries: readonly Pick<HistoryEntry, 'url'>[],
  engines: readonly SearchEngine[],
  terms: string
): string[] {
  const key = terms.trim().toLowerCase()
  if (!key) return []
  const urls: string[] = []
  for (const entry of entries) {
    const found = searchOf(entry.url, engines)
    if (found && found.terms.toLowerCase() === key) urls.push(entry.url)
  }
  return urls
}

function searchOf(
  url: string,
  engines: readonly SearchEngine[]
): { terms: string; engine: SearchEngine } | null {
  // An address that is no site's (`zen://`, a file) is no engine's results page: the templates
  // are read for the web's pages alone.
  if (!/^https?:/i.test(url)) return null
  for (const engine of engines) {
    const terms = searchTermsFromUrl(engine, url)
    if (terms !== null) return { terms, engine }
  }
  return null
}
