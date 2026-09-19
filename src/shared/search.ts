import type { SearchEngine, SearchEngineSource } from './types'

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
  return fillTemplate(engine.searchUrl, query)
}

export function buildSuggestUrl(engine: SearchEngine, query: string): string | null {
  if (!engine.suggestUrl) return null
  return fillTemplate(engine.suggestUrl, query)
}

/** Every `%s` of a template takes the encoded query (an OpenSearch template may repeat it). */
function fillTemplate(template: string, query: string): string {
  return template.split('%s').join(encodeURIComponent(query.trim()))
}

// ---------------------------------------------------------------------------
// The engine list: shipped engines plus the user's (Settings > Search, OpenSearch discovery)
// ---------------------------------------------------------------------------

/** Discovered engines kept, newest visit first (Chrome's "Recently visited" list is short). */
export const MAX_DISCOVERED_ENGINES = 8
/** Engines added by hand: a generous bound, so a synced profile cannot grow without limit. */
export const MAX_CUSTOM_ENGINES = 32
const MAX_ENGINE_NAME = 64
const MAX_ENGINE_URL = 2048
/** A favicon address kept in the settings: a URL, or a small data URL. */
const MAX_FAVICON = 8 * 1024

/**
 * Every engine the profile offers: the shipped ones first, then the user's own in the order they
 * were added, then the discovered ones newest visit first. The user's list never shadows a
 * shipped id.
 */
export function allSearchEngines(user: readonly SearchEngine[] | undefined): SearchEngine[] {
  const shipped = new Set(DEFAULT_SEARCH_ENGINES.map((e) => e.id))
  const own = (user ?? []).filter((e) => !shipped.has(e.id))
  const custom = own.filter((e) => e.source !== 'discovered')
  const discovered = own
    .filter((e) => e.source === 'discovered')
    .sort((a, b) => (b.visitedAt ?? 0) - (a.visitedAt ?? 0))
  return [...DEFAULT_SEARCH_ENGINES, ...custom, ...discovered]
}

/** The engine `id` names, or the profile's default (the shipped default when that is gone too). */
export function engineById(engines: readonly SearchEngine[], id: string): SearchEngine {
  return engines.find((e) => e.id === id) ?? engines[0]
}

/**
 * Why `url` cannot be a search URL template, or null when it can: an `http(s)` address that
 * carries `%s` (Chrome's form takes the same placeholder) where the query goes.
 */
export function searchTemplateProblem(url: string): string | null {
  const t = url.trim()
  if (!t) return 'Enter the search URL'
  if (t.length > MAX_ENGINE_URL) return 'The URL is too long'
  if (!t.includes('%s')) return 'Put %s where the search terms go'
  let parsed: URL
  try {
    parsed = new URL(t.split('%s').join('query'))
  } catch {
    return 'Enter a complete address, like https://example.com/search?q=%s'
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    return 'The URL must start with https:// or http://'
  return null
}

/** The letter the URL bar shows for an engine: the first letter or digit of its name. */
export function engineGlyph(name: string): string {
  const m = /[\p{L}\p{N}]/u.exec(name)
  return (m?.[0] ?? '?').toUpperCase()
}

/**
 * A keyword for a new engine, `@` and its name run together (`@wikipedia`), that no engine in
 * `existing` answers to yet (`@wikipedia2` otherwise).
 */
export function uniqueEngineKeyword(name: string, existing: readonly SearchEngine[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/\s*\(.*\)\s*$/, '')
      .replace(/[^\p{L}\p{N}]+/gu, '') || 'engine'
  const taken = new Set(existing.flatMap(engineKeywords))
  let keyword = `@${base}`
  for (let n = 2; taken.has(keyword); n++) keyword = `@${base}${n}`
  return keyword
}

/** An id no engine in `existing` has, from the engine's name. */
function uniqueEngineId(prefix: string, name: string, existing: readonly SearchEngine[]): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32) || 'engine'
  const ids = new Set(existing.map((e) => e.id))
  let id = `${prefix}:${slug}`
  for (let n = 2; ids.has(id); n++) id = `${prefix}:${slug}-${n}`
  return id
}

/**
 * The engine a Settings > Search form adds: its name and template, a keyword and glyph derived
 * from the name, no suggestions (a hand-typed engine offers no suggest endpoint).
 */
export function customSearchEngine(
  name: string,
  url: string,
  existing: readonly SearchEngine[]
): SearchEngine {
  const cleanName = name.trim().slice(0, MAX_ENGINE_NAME)
  return {
    id: uniqueEngineId('custom', cleanName, existing),
    name: cleanName,
    searchUrl: url.trim(),
    suggestUrl: null,
    keyword: uniqueEngineKeyword(cleanName, existing),
    glyph: engineGlyph(cleanName),
    source: 'custom',
    favicon: null
  }
}

/** The host a template searches at (`www.` dropped), for telling one site's engine from another's. */
export function engineHost(engine: Pick<SearchEngine, 'searchUrl'>): string | null {
  try {
    return new URL(engine.searchUrl.split('%s').join('q')).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/**
 * A profile's `settings.searchEngines` as read from disk or from a peer: every entry a complete
 * engine of the user's (a shipped id is dropped, the shipped list is not stored), the discovered
 * ones capped to the newest `MAX_DISCOVERED_ENGINES`, the hand-added ones to `MAX_CUSTOM_ENGINES`.
 * `keep` (the default engine's id) is never dropped by the caps.
 */
export function sanitizeSearchEngines(raw: unknown, keep?: string): SearchEngine[] {
  if (!Array.isArray(raw)) return []
  const shipped = new Set(DEFAULT_SEARCH_ENGINES.map((e) => e.id))
  const seen = new Set<string>()
  const out: SearchEngine[] = []
  for (const item of raw) {
    const engine = sanitizeSearchEngine(item)
    if (!engine || shipped.has(engine.id) || seen.has(engine.id)) continue
    seen.add(engine.id)
    out.push(engine)
  }
  const custom = out.filter((e) => e.source !== 'discovered')
  const discovered = out
    .filter((e) => e.source === 'discovered')
    .sort((a, b) => (b.visitedAt ?? 0) - (a.visitedAt ?? 0))
  return [...cap(custom, MAX_CUSTOM_ENGINES, keep), ...cap(discovered, MAX_DISCOVERED_ENGINES, keep)]
}

function cap(list: SearchEngine[], max: number, keep: string | undefined): SearchEngine[] {
  if (list.length <= max) return list
  const kept = list.slice(0, max)
  const held = keep ? list.slice(max).find((e) => e.id === keep) : undefined
  if (!held) return kept
  kept.pop()
  kept.push(held)
  return kept
}

function sanitizeSearchEngine(raw: unknown): SearchEngine | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id || r.id.length > 128) return null
  if (typeof r.name !== 'string' || !r.name.trim()) return null
  if (typeof r.searchUrl !== 'string' || searchTemplateProblem(r.searchUrl)) return null
  const source: SearchEngineSource = r.source === 'discovered' ? 'discovered' : 'custom'
  const suggestUrl =
    typeof r.suggestUrl === 'string' && !searchTemplateProblem(r.suggestUrl) ? r.suggestUrl : null
  const name = r.name.trim().slice(0, MAX_ENGINE_NAME)
  const keyword =
    typeof r.keyword === 'string' && /^@\S{1,64}$/.test(r.keyword)
      ? r.keyword.toLowerCase()
      : `@${name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') || 'engine'}`
  const glyph = typeof r.glyph === 'string' && r.glyph.trim() ? r.glyph.trim().slice(0, 2) : engineGlyph(name)
  const favicon = sanitizeFavicon(r.favicon)
  const engine: SearchEngine = {
    id: r.id,
    name,
    searchUrl: r.searchUrl.trim(),
    suggestUrl,
    keyword,
    glyph,
    source,
    favicon
  }
  if (source === 'discovered') {
    engine.visitedAt = typeof r.visitedAt === 'number' && Number.isFinite(r.visitedAt) ? r.visitedAt : 0
  }
  return engine
}

function sanitizeFavicon(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_FAVICON) return null
  if (/^data:image\//i.test(raw)) return raw
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? raw : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// OpenSearch discovery: the description a page links with `<link rel="search">`
// ---------------------------------------------------------------------------

/** What an OpenSearch description says, in the engine model's terms. */
export interface OpenSearchDescription {
  name: string
  /** The `text/html` template, `%s` for `{searchTerms}`. */
  searchUrl: string
  /** The `application/x-suggestions+json` template, when the site offers one. */
  suggestUrl: string | null
  /** The `<Image>` (the 16 px one when several), absolute. */
  favicon: string | null
}

/** Descriptions are small documents; anything bigger is not one worth reading. */
export const MAX_OPENSEARCH_BYTES = 64 * 1024

/**
 * Read an OpenSearch 1.1 description (a small XML document; no DOM parser is assumed, the core
 * runs in Node too) into an engine: the `ShortName`, the GET `text/html` `Url` template with
 * `{searchTerms}` (the required parameter; optional `{…?}` ones are dropped, any other required
 * one disqualifies the template, as Chrome does), the JSON suggestions template if any, and the
 * `Image`. Relative templates and images resolve against `baseUrl`, the description's address.
 * `fallbackName` (the link's title) stands in for a missing `ShortName`. Null for anything that
 * is not a usable description: not OpenSearch, too large, no `http(s)` search template.
 */
export function parseOpenSearchDescription(
  xml: string,
  baseUrl: string,
  fallbackName = ''
): OpenSearchDescription | null {
  if (typeof xml !== 'string' || xml.length > MAX_OPENSEARCH_BYTES) return null
  const doc = xml.replace(/<!--[\s\S]*?-->/g, '')
  if (!/<(?:[\w.-]+:)?OpenSearchDescription[\s>]/i.test(doc)) return null
  let searchUrl: string | null = null
  let suggestUrl: string | null = null
  for (const url of elements(doc, 'Url')) {
    const method = (url.attrs.method ?? 'get').toLowerCase()
    if (method !== 'get') continue
    const type = (url.attrs.type ?? '').toLowerCase().trim()
    const template = openSearchTemplate(url, baseUrl)
    if (!template) continue
    if (type === 'text/html' && !searchUrl) searchUrl = template
    else if (
      (type === 'application/x-suggestions+json' || type === 'application/json') &&
      !suggestUrl
    )
      suggestUrl = template
  }
  if (!searchUrl) return null
  const shortName = textOf(elements(doc, 'ShortName')[0])
  const name = (shortName || fallbackName.trim() || engineHost({ searchUrl }) || '').slice(
    0,
    MAX_ENGINE_NAME
  )
  if (!name) return null
  const images = elements(doc, 'Image')
  const image =
    images.find((i) => i.attrs.width === '16' && i.attrs.height === '16') ?? images[0]
  const favicon = image ? resolveHttp(textOf(image), baseUrl, true) : null
  return { name, searchUrl, suggestUrl, favicon }
}

/**
 * The engine a description makes, remembered as visited now: keyed by the site it searches
 * (`discovered:<host>`), so a later visit updates the same entry.
 */
export function discoveredSearchEngine(
  description: OpenSearchDescription,
  now: number,
  existing: readonly SearchEngine[]
): SearchEngine | null {
  const host = engineHost(description)
  if (!host) return null
  const id = `discovered:${host}`
  const previous = existing.find((e) => e.id === id)
  return {
    id,
    name: description.name,
    searchUrl: description.searchUrl,
    suggestUrl: description.suggestUrl,
    keyword:
      previous?.keyword ??
      uniqueEngineKeyword(
        description.name,
        existing.filter((e) => e.id !== id)
      ),
    glyph: engineGlyph(description.name),
    source: 'discovered',
    favicon: description.favicon,
    visitedAt: now
  }
}

/**
 * `engine` (a discovered one) joins or refreshes the user's list: a site that already has an
 * engine – shipped or added by hand – offers nothing new; otherwise the entry with its id is
 * replaced and the discovered ones are capped to the newest, the default (`keep`) never dropped.
 */
export function rememberDiscoveredEngine(
  user: readonly SearchEngine[],
  engine: SearchEngine,
  keep?: string
): SearchEngine[] {
  const host = engineHost(engine)
  const owned = [...DEFAULT_SEARCH_ENGINES, ...user.filter((e) => e.source !== 'discovered')]
  if (host && owned.some((e) => engineHost(e) === host)) return [...user]
  const rest = user.filter((e) => e.id !== engine.id)
  return sanitizeSearchEngines([...rest, engine], keep)
}

interface XmlElement {
  attrs: Record<string, string>
  inner: string
}

/** Every element with the local name `name` (any namespace prefix), in document order. */
function elements(doc: string, name: string): XmlElement[] {
  const out: Array<XmlElement & { at: number }> = []
  const open = new RegExp(`<(?:[\\w.-]+:)?${name}(\\s[^<>]*?)?(/?)>`, 'gi')
  const close = new RegExp(`</(?:[\\w.-]+:)?${name}\\s*>`, 'gi')
  for (let m = open.exec(doc); m; m = open.exec(doc)) {
    const attrs = attributesOf(m[1] ?? '')
    if (m[2] === '/') {
      out.push({ attrs, inner: '', at: m.index })
      continue
    }
    close.lastIndex = open.lastIndex
    const end = close.exec(doc)
    if (!end) break
    out.push({ attrs, inner: doc.slice(open.lastIndex, end.index), at: m.index })
    open.lastIndex = close.lastIndex
  }
  return out
}

function attributesOf(text: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    attrs[m[1].replace(/^[\w.-]+:/, '').toLowerCase()] = decodeXml(m[2] ?? m[3] ?? '')
  }
  return attrs
}

/** An element's text: CDATA unwrapped, entities decoded, nested tags dropped, trimmed. */
function textOf(el: XmlElement | undefined): string {
  if (!el) return ''
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(el.inner)
  const raw = cdata ? cdata[1] : decodeXml(el.inner.replace(/<[^>]*>/g, ''))
  return raw.replace(/\s+/g, ' ').trim()
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, code: string) => {
    const c = code.toLowerCase()
    if (c === 'amp') return '&'
    if (c === 'lt') return '<'
    if (c === 'gt') return '>'
    if (c === 'quot') return '"'
    if (c === 'apos') return "'"
    const n = c.startsWith('#x') ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10)
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole
  })
}

/**
 * A `Url` element's template as an engine template: `{searchTerms}` becomes `%s`, optional
 * parameters go, `Param` children join the query; null when a required parameter other than the
 * search terms is left, when the terms are missing, or when the result is not `http(s)`.
 */
function openSearchTemplate(url: XmlElement, baseUrl: string): string | null {
  let template = url.attrs.template ?? ''
  const params = elements(url.inner, 'Param')
    .filter((p) => p.attrs.name)
    .map((p) => `${encodeURIComponent(p.attrs.name)}=${p.attrs.value ?? ''}`)
  if (params.length) template += (template.includes('?') ? '&' : '?') + params.join('&')
  if (!template) return null
  // The core's placeholder is `%s`; a literal `%s` in a template is not one Chrome honours either.
  template = template.replace(/\{searchTerms\??\}/gi, '%s')
  template = template.replace(/\{(?:startIndex|startPage|count|language|inputEncoding|outputEncoding)\}/gi, '')
  template = template.replace(/\{[^{}]*\?\}/g, '')
  if (/\{[^{}]*\}/.test(template)) return null
  if (!template.includes('%s')) return null
  const resolved = resolveHttp(template, baseUrl, false)
  return resolved && !searchTemplateProblem(resolved) ? resolved : null
}

/** `value` as an absolute `http(s)` address (or a data image, where allowed), else null. */
function resolveHttp(value: string, baseUrl: string, allowData: boolean): string | null {
  const v = value.trim()
  if (!v || v.length > MAX_ENGINE_URL) return null
  if (allowData && /^data:image\//i.test(v)) return v.length <= MAX_FAVICON ? v : null
  try {
    // `%s` survives `new URL` untouched: it is a valid percent-escape only when a hex pair follows.
    const url = new URL(v, baseUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.href
  } catch {
    return null
  }
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
