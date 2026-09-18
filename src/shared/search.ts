import type { SearchEngine } from './types'

/**
 * Zen ships Google, DuckDuckGo and Wikipedia by default and lets you pick Google, DuckDuckGo or
 * Ecosia during onboarding. Bing is included so users have a familiar fallback.
 *
 * Google is queried as `client=chrome`: that keyless variant of the same endpoint carries
 * `google:suggestrelevance` and `google:suggesttype` (QUERY, NAVIGATION with the page title,
 * CALCULATOR with the answer), which the `client=firefox` payload drops.
 */
export const DEFAULT_SEARCH_ENGINES: SearchEngine[] = [
  {
    id: 'google',
    name: 'Google',
    searchUrl: 'https://www.google.com/search?q=%s',
    suggestUrl: 'https://suggestqueries.google.com/complete/search?client=chrome&q=%s',
    keyword: '@google',
    glyph: 'G'
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    searchUrl: 'https://duckduckgo.com/?q=%s',
    suggestUrl: 'https://duckduckgo.com/ac/?type=list&q=%s',
    keyword: '@ddg',
    glyph: 'D'
  },
  {
    id: 'ecosia',
    name: 'Ecosia',
    searchUrl: 'https://www.ecosia.org/search?q=%s',
    suggestUrl: 'https://ac.ecosia.org/?q=%s',
    keyword: '@ecosia',
    glyph: 'E'
  },
  {
    id: 'bing',
    name: 'Bing',
    searchUrl: 'https://www.bing.com/search?q=%s',
    suggestUrl: 'https://api.bing.com/osjson.aspx?query=%s',
    keyword: '@bing',
    glyph: 'B'
  },
  {
    id: 'wikipedia',
    name: 'Wikipedia (en)',
    searchUrl: 'https://en.wikipedia.org/w/index.php?search=%s',
    suggestUrl: 'https://en.wikipedia.org/w/api.php?action=opensearch&format=json&search=%s',
    keyword: '@wikipedia',
    glyph: 'W'
  }
]

export function buildSearchUrl(engine: SearchEngine, query: string): string {
  return engine.searchUrl.replace('%s', encodeURIComponent(query.trim()))
}

export function buildSuggestUrl(engine: SearchEngine, query: string): string | null {
  if (!engine.suggestUrl) return null
  return engine.suggestUrl.replace('%s', encodeURIComponent(query.trim()))
}

/**
 * Parse a suggestion response. All supported engines either return the OpenSearch JSON shape
 * `[query, [suggestions...]]` or (Ecosia) `{ suggestions: [...] }`.
 */
export function parseSuggestResponse(body: unknown): string[] {
  if (Array.isArray(body)) {
    const list = body[1]
    if (Array.isArray(list)) {
      return list.filter((s): s is string => typeof s === 'string')
    }
    return []
  }
  if (body && typeof body === 'object' && 'suggestions' in body) {
    const list = (body as { suggestions: unknown }).suggestions
    if (Array.isArray(list)) {
      return list
        .map((s) => (typeof s === 'string' ? s : (s as { value?: string })?.value))
        .filter((s): s is string => typeof s === 'string')
    }
  }
  return []
}

/** What a remote suggestion is, after Chromium's `google:suggesttype` vocabulary. */
export type RemoteSuggestionType = 'query' | 'navigation' | 'calculator'

export interface RemoteSuggestion {
  /** The suggested query, or the URL of a navigation suggestion, or the calculator's answer. */
  text: string
  type: RemoteSuggestionType
  /** A navigation suggestion's page title (the `descriptions` array); '' when absent. */
  description: string
  /**
   * Chromium's relevance for the row (QUERY rows are usually 550–700, CALCULATOR about 1250).
   * Engines whose payload has no relevance get a descending default from `DEFAULT_RELEVANCE`.
   */
  relevance: number
}

export interface SuggestPayload {
  suggestions: RemoteSuggestion[]
  /**
   * How the engine ranks the verbatim query (Google sends 1300); a suggestion above it may be
   * inlined as the default match. Null when the payload carries no ranking.
   */
  verbatimRelevance: number | null
}

/** First row's relevance for engines that rank nothing; each later row scores one less. */
export const DEFAULT_RELEVANCE = 600

function isNumberArray(x: unknown): x is number[] {
  return Array.isArray(x) && x.every((n) => typeof n === 'number')
}

/**
 * The typed reading of a suggestion response. Google's `client=chrome` payload is
 * `[query, [texts], [descriptions], [], { google:suggesttype, google:suggestrelevance,
 * google:verbatimrelevance }]`; every other engine is read as plain QUERY rows.
 */
export function parseSuggestPayload(body: unknown): SuggestPayload {
  const texts = parseSuggestResponse(body)
  let types: unknown[] = []
  let relevances: number[] = []
  let descriptions: unknown[] = []
  let verbatimRelevance: number | null = null
  if (Array.isArray(body)) {
    if (Array.isArray(body[2])) descriptions = body[2]
    const meta = body[4]
    if (meta && typeof meta === 'object') {
      const m = meta as Record<string, unknown>
      if (Array.isArray(m['google:suggesttype'])) types = m['google:suggesttype']
      if (isNumberArray(m['google:suggestrelevance'])) relevances = m['google:suggestrelevance']
      if (typeof m['google:verbatimrelevance'] === 'number')
        verbatimRelevance = m['google:verbatimrelevance']
    }
  }
  const suggestions: RemoteSuggestion[] = []
  // `parseSuggestResponse` drops non-string rows, so the arrays are walked in step here.
  const raw = Array.isArray(body) && Array.isArray(body[1]) ? (body[1] as unknown[]) : texts
  let outIndex = 0
  raw.forEach((row, i) => {
    if (typeof row !== 'string' || !row) return
    const t = typeof types[i] === 'string' ? (types[i] as string).toUpperCase() : 'QUERY'
    const type: RemoteSuggestionType =
      t === 'NAVIGATION' ? 'navigation' : t === 'CALCULATOR' ? 'calculator' : 'query'
    const description = typeof descriptions[i] === 'string' ? (descriptions[i] as string) : ''
    const relevance =
      typeof relevances[i] === 'number' ? relevances[i] : DEFAULT_RELEVANCE - outIndex
    suggestions.push({ text: row, type, description, relevance })
    outIndex += 1
  })
  return { suggestions, verbatimRelevance }
}

// ---------------------------------------------------------------------------
// Keyword mode: `@engine`, `@bookmarks`, `@history`, `@tabs`
// ---------------------------------------------------------------------------

/** Chrome's built-in site-search scopes, which search Zenium's own data instead of the web. */
export type SearchScope = 'bookmarks' | 'history' | 'tabs'

export const SEARCH_SCOPES: Array<{ scope: SearchScope; keyword: string; label: string }> = [
  { scope: 'bookmarks', keyword: '@bookmarks', label: 'Search bookmarks' },
  { scope: 'history', keyword: '@history', label: 'Search history' },
  { scope: 'tabs', keyword: '@tabs', label: 'Search tabs' }
]

/** `keyword` is the word as typed (`@duckduckgo` selects DuckDuckGo as well as `@ddg`). */
export type KeywordMatch =
  | { kind: 'engine'; engine: SearchEngine; keyword: string; query: string }
  | { kind: 'scope'; scope: SearchScope; keyword: string; query: string }

/** The keywords that select `engine`: its configured `@keyword`, `@id` and `@name` (no spaces). */
export function engineKeywords(engine: SearchEngine): string[] {
  const out = new Set<string>([engine.keyword.toLowerCase()])
  out.add(`@${engine.id.toLowerCase()}`)
  const name = engine.name
    .toLowerCase()
    .replace(/\s*\(.*\)\s*$/, '')
    .replace(/\s+/g, '')
  if (name) out.add(`@${name}`)
  return [...out]
}

/**
 * A keyword alone (`@ddg`, `@bookmarks`), as typed before the Space or Tab that enters keyword
 * mode: the match it would select, or null. Case-insensitive.
 */
export function matchKeywordWord(word: string, engines: SearchEngine[]): KeywordMatch | null {
  const w = word.trim().toLowerCase()
  if (!w.startsWith('@') || w.length < 2) return null
  for (const s of SEARCH_SCOPES) {
    if (s.keyword === w) return { kind: 'scope', scope: s.scope, keyword: s.keyword, query: '' }
  }
  for (const engine of engines) {
    if (engineKeywords(engine).includes(w)) return { kind: 'engine', engine, keyword: w, query: '' }
  }
  return null
}

/**
 * Detect a `@keyword query` prefix (the keyword, a space, then what to search): an engine
 * keyword or one of the built-in scopes. Returns the match with the remaining query, or null.
 * `@ddg` alone (no space yet) is not a match: the user may still be typing the word.
 */
export function matchKeyword(input: string, engines: SearchEngine[]): KeywordMatch | null {
  const trimmed = input.trimStart()
  const space = trimmed.search(/\s/)
  if (space === -1) return null
  const hit = matchKeywordWord(trimmed.slice(0, space), engines)
  if (!hit) return null
  return { ...hit, query: trimmed.slice(space + 1) }
}

/**
 * Detect a `@keyword query` or `keyword query` prefix that selects a specific engine.
 * Returns the engine and the remaining query, or `null`. Scopes (`@tabs`) are not engines.
 */
export function matchEngineKeyword(
  input: string,
  engines: SearchEngine[]
): { engine: SearchEngine; query: string } | null {
  const hit = matchKeyword(input, engines)
  if (!hit || hit.kind !== 'engine') return null
  return { engine: hit.engine, query: hit.query }
}

/**
 * Chrome's Ctrl+Enter: a single word becomes `www.<word>.com`. Text with a scheme, a dot, a
 * space or a port is left alone, so `example.org` and `localhost:3000` still go where typed.
 */
export function completeWwwCom(text: string): string {
  const t = text.trim()
  // Chrome's fixup with the desired TLD `com`: only a host with no dot gets `www.` and `.com`;
  // a path, query or fragment after it stays. Anything with a dot, scheme, port or space is
  // left as typed.
  const m = /^([a-z0-9-]+)([/?#].*)?$/i.exec(t)
  if (!m) return t
  return `www.${m[1]}.com${m[2] ?? ''}`
}
