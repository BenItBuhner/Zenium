import type { SearchEngine } from './types'

/**
 * Zen ships Google, DuckDuckGo and Wikipedia by default and lets you pick Google, DuckDuckGo or
 * Ecosia during onboarding. Bing is included so users have a familiar fallback.
 */
export const DEFAULT_SEARCH_ENGINES: SearchEngine[] = [
  {
    id: 'google',
    name: 'Google',
    searchUrl: 'https://www.google.com/search?q=%s',
    suggestUrl: 'https://suggestqueries.google.com/complete/search?client=firefox&q=%s',
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

/**
 * Detect a `@keyword query` or `keyword query` prefix that selects a specific engine.
 * Returns the engine and the remaining query, or `null`.
 */
export function matchEngineKeyword(
  input: string,
  engines: SearchEngine[]
): { engine: SearchEngine; query: string } | null {
  const trimmed = input.trimStart()
  const space = trimmed.indexOf(' ')
  if (space === -1) return null
  const word = trimmed.slice(0, space).toLowerCase()
  const engine = engines.find((e) => e.keyword.toLowerCase() === word)
  if (!engine) return null
  return { engine, query: trimmed.slice(space + 1) }
}
