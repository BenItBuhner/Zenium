import type { HistoryEntry, SearchEngine } from './types'
import { isActiveSearchEngine } from './search'

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
  const templates = resultsTemplates(engines)
  const byTerms = new Map<string, HistorySearch>()
  for (const entry of entries) {
    const found = searchOf(entry.url, templates)
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
  const templates = resultsTemplates(engines)
  const urls: string[] = []
  for (const entry of entries) {
    const found = searchOf(entry.url, templates)
    if (found && found.terms.toLowerCase() === key) urls.push(entry.url)
  }
  return urls
}

/** What `searchTermsFromUrl` reads `%s` as, to find the template's terms parameter. */
const TERMS_MARKER = 'zen-search-terms-marker'

/**
 * An engine's results-page template as `searchTermsFromUrl` reads it, parsed once for a scan:
 * the page is one of the engine's results pages when it is at this host (`www.` aside) and
 * path and carries `param` with terms in it.
 */
interface ResultsTemplate {
  engine: SearchEngine
  host: string
  pathname: string
  param: string
}

/** The engines' templates parsed once, in the engines' order, with the hosts they search at. */
interface ResultsTemplates {
  list: ResultsTemplate[]
  hosts: ReadonlySet<string>
}

/**
 * The templates of `engines`, each read once (a scan is up to `RECENT_SEARCH_SCAN` pages; read
 * per page, as `searchTermsFromUrl` reads it, a template would be parsed that many times over).
 * An engine whose template does not parse, or puts `%s` in its path rather than a query
 * parameter, has no page read back – as `searchTermsFromUrl` reads none of its pages – and is
 * left out.
 */
function resultsTemplates(engines: readonly SearchEngine[]): ResultsTemplates {
  const list: ResultsTemplate[] = []
  const hosts = new Set<string>()
  for (const engine of engines) {
    let template: URL
    try {
      template = new URL(engine.searchUrl.split('%s').join(TERMS_MARKER))
    } catch {
      continue
    }
    let param: string | null = null
    for (const [key, value] of template.searchParams) {
      if (value === TERMS_MARKER) {
        param = key
        break
      }
    }
    if (param === null) continue
    const host = template.hostname.replace(/^www\./, '')
    list.push({ engine, host, pathname: template.pathname, param })
    hosts.add(host)
  }
  return { list, hosts }
}

/**
 * A plain `http(s)` address's authority, read off the string: an optional userinfo up to `@`,
 * then the host in letters, digits, dots and hyphens, ending at the port, the path, the query,
 * the fragment or the string's end. Anything else in the way (a bracketed IPv6 host, a percent
 * sign, a non-ASCII letter, a backslash, whitespace) is left to the URL parser.
 */
const PLAIN_AUTHORITY = /^https?:\/\/(?:[^/?#@\\]*@)?([a-z0-9.-]+)(?=[/?#:]|$)/i

/**
 * The host of `url` as the URL parser would report it (`www.` aside, lower-cased), read cheaply
 * off the string when that is certain – a plain ASCII host whose last label is not a number
 * (the parser normalises a numeric one into an IPv4 address) – or null when the parser has to
 * say. A page on no engine's host is skipped on this alone, unparsed; a page the parser might
 * yet place on an engine's host is never skipped here.
 */
function plainHost(url: string): string | null {
  const match = PLAIN_AUTHORITY.exec(url)
  if (!match) return null
  const host = match[1]!.toLowerCase()
  const last = host.slice(host.lastIndexOf('.') + 1)
  if (last === '' || /^(0x[0-9a-f]*|[0-9]+)$/.test(last)) return null
  return host.replace(/^www\./, '')
}

/**
 * The search `url` is, on the first of the templates that reads it – what `searchTermsFromUrl`
 * answers for each engine in order, with the page parsed once rather than once per engine, and
 * not at all when its host is plainly no engine's.
 */
function searchOf(
  url: string,
  templates: ResultsTemplates
): { terms: string; engine: SearchEngine } | null {
  // An address that is no site's (`zen://`, a file) is no engine's results page: the templates
  // are read for the web's pages alone.
  if (!/^https?:/i.test(url)) return null
  const plain = plainHost(url)
  if (plain !== null && !templates.hosts.has(plain)) return null
  let page: URL
  try {
    page = new URL(url)
  } catch {
    return null
  }
  const host = page.hostname.replace(/^www\./, '')
  for (const template of templates.list) {
    if (template.host !== host || template.pathname !== page.pathname) continue
    const terms = page.searchParams.get(template.param)?.trim()
    if (terms) return { terms, engine: template.engine }
  }
  return null
}
