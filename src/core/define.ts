import type { DefineDefinition, DefineEntry, DefineLookup, DefineResult } from '../shared/types'
import type { Browser } from './browser'

/**
 * Define (CT-39): a word's definition from Wiktionary, for the mini menu's Define chip and the
 * phone's selection toolbar item.
 *
 * Edge's mini menu defines through Microsoft's dictionary; Zenium has no dictionary of its own
 * and asks Wiktionary's REST definition endpoint (`/api/rest_v1/page/definition/{term}`, the
 * mobile content service's; free, no key) – **English Wiktionary's alone**: the endpoint is not
 * served for the other languages' Wiktionaries (`de.wiktionary.org` answers 501), and English
 * Wiktionary's pages define words of every language, each page's answer keyed by the language
 * code of its sections (`foam` → `en` and `es`). The reader's language picks the section, and
 * English stands in when the page has none for it. Wiktionary's text is CC BY-SA 4.0
 * (https://en.wiktionary.org/wiki/Wiktionary:Copyrights): the answer carries the attribution
 * every surface shows – the source, the licence and the term's page.
 *
 * The request goes through the host's network stack (`platform.net.fetchText`: OkHttp on the
 * phone, Electron's `net` on the desktop) with `Accept-Language` and an `Api-User-Agent`, as
 * Wikimedia asks of API clients. One answer is kept for a day (`DEFINE_CACHE_TTL_MS`) per term
 * and language; only what Wiktionary said (a definition, or that there is none) is remembered,
 * never a network failure. Sizes are capped at every level so a page like `run` (135 senses,
 * 77 KB) reaches the chrome as a handful of lines.
 */

export const WIKTIONARY_DEFINITION_ENDPOINT =
  'https://en.wiktionary.org/api/rest_v1/page/definition/'
export const WIKTIONARY_PAGE_BASE = 'https://en.wiktionary.org/wiki/'
export const DEFINE_CACHE_TTL_MS = 24 * 60 * 60 * 1000
/** Wikimedia's API guidance: an `Api-User-Agent` naming the client for browser-borne requests. */
export const DEFINE_API_USER_AGENT = 'Zenium (https://github.com/BenItBuhner/Zenium)'
export const DEFINE_FETCH_TIMEOUT_MS = 8000
/** The most body bytes read: the largest pages (`run`, `set`) are under 100 KB. */
export const DEFINE_MAX_BYTES = 512 * 1024
/** A term is one to three words and no longer than this. */
export const DEFINE_MAX_TERM_WORDS = 3
export const DEFINE_MAX_TERM_CHARS = 80
export const DEFINE_MAX_ENTRIES = 6
export const DEFINE_MAX_DEFINITIONS = 8
export const DEFINE_MAX_EXAMPLES = 2
export const DEFINE_MAX_TEXT_CHARS = 400
/** How many answers the cache holds before the oldest goes. */
export const DEFINE_CACHE_MAX_ENTRIES = 200

/** The term as it is looked up and cached: whitespace folded, trimmed. */
export function normalizeTerm(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Whether selected text is a term to define: one to three words with a letter in them, no
 * longer than `DEFINE_MAX_TERM_CHARS`, and not an address, a path or a mention (`/`, `:`, `@`,
 * `#` inside it), which a dictionary has nothing for.
 */
export function isDefinableTerm(text: string): boolean {
  const term = normalizeTerm(text)
  if (!term || term.length > DEFINE_MAX_TERM_CHARS) return false
  if (/[/\\:@#<>|{}[\]]/.test(term)) return false
  if (!/\p{L}/u.test(term)) return false
  return term.split(' ').length <= DEFINE_MAX_TERM_WORDS
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d'
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * Wiktionary's definition HTML as plain text: tags gone (`<a>` links, `<i>`, the empty
 * `<span>`s its label templates leave), entities decoded, whitespace folded, cut at `max`.
 */
export function stripHtml(html: string, max = DEFINE_MAX_TEXT_CHARS): string {
  const text = decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}\u2026` : text
}

/** The term's page on English Wiktionary (spaces are underscores in a title). */
export function wiktionaryPageUrl(term: string): string {
  return WIKTIONARY_PAGE_BASE + encodeURIComponent(normalizeTerm(term).replace(/ /g, '_'))
}

/** The language code the reader's first preferred tag names (`en-US` → `en`); `en` for none. */
export function definitionLanguageOf(tag: string | undefined): string {
  const code = (tag ?? '').split('-')[0].trim().toLowerCase()
  return /^[a-z]{2,3}$/.test(code) ? code : 'en'
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function parseDefinition(raw: unknown): DefineDefinition | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const text = stripHtml(stringField(record, 'definition'))
  if (!text) return null
  const examples: string[] = []
  const listed = record.examples
  if (Array.isArray(listed)) {
    for (const example of listed) {
      if (examples.length >= DEFINE_MAX_EXAMPLES) break
      if (typeof example !== 'string') continue
      const plain = stripHtml(example)
      if (plain) examples.push(plain)
    }
  }
  return { text, examples }
}

function parseEntry(raw: unknown): DefineEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const senses = record.definitions
  if (!Array.isArray(senses)) return null
  const definitions: DefineDefinition[] = []
  for (const sense of senses) {
    if (definitions.length >= DEFINE_MAX_DEFINITIONS) break
    const parsed = parseDefinition(sense)
    if (parsed) definitions.push(parsed)
  }
  if (definitions.length === 0) return null
  return {
    partOfSpeech: stripHtml(stringField(record, 'partOfSpeech'), 40),
    language: stripHtml(stringField(record, 'language'), 40),
    definitions
  }
}

/**
 * The endpoint's JSON (an object keyed by language code, each a list of entries with a part of
 * speech and its senses) as a `DefineResult` for `lang`: that section when the page has one,
 * English's else, the first section failing both. Null when the text is not that JSON, or the
 * page has no sense with any text left once its HTML is stripped.
 */
export function parseDefinitionResponse(
  text: string,
  term: string,
  lang: string
): DefineResult | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const sections = json as Record<string, unknown>
  const candidates = [lang, 'en', ...Object.keys(sections)]
  for (const code of candidates) {
    const raw = sections[code]
    if (!Array.isArray(raw)) continue
    const entries: DefineEntry[] = []
    for (const entry of raw) {
      if (entries.length >= DEFINE_MAX_ENTRIES) break
      const parsed = parseEntry(entry)
      if (parsed) entries.push(parsed)
    }
    if (entries.length === 0) continue
    const normalized = normalizeTerm(term)
    return {
      term: normalized,
      lang: code,
      entries,
      attribution: {
        source: 'Wiktionary',
        licence: 'CC BY-SA 4.0',
        url: wiktionaryPageUrl(normalized)
      }
    }
  }
  return null
}

interface CacheEntry {
  at: number
  value: DefineLookup
}

export class DefineService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly now: () => number

  constructor(
    private readonly browser: Browser,
    options: { now?: () => number } = {}
  ) {
    this.now = options.now ?? Date.now
  }

  /** The language whose section is shown by default: the reader's first preferred language. */
  language(): string {
    return definitionLanguageOf(this.browser.languages.list[0])
  }

  /**
   * `define.lookup`: Wiktionary's definition of `term` in `lang`'s section (the reader's
   * language by default), or a typed refusal. The network is asked once a day per term and
   * language; a failure to reach it is not remembered.
   */
  async lookup(term: string, lang?: string): Promise<DefineLookup> {
    const normalized = normalizeTerm(term)
    if (!isDefinableTerm(normalized)) return { ok: false, reason: 'invalid-term' }
    const code = definitionLanguageOf(lang ?? this.language())
    const key = `${code}\n${normalized}`
    const cached = this.cache.get(key)
    if (cached && this.now() - cached.at < DEFINE_CACHE_TTL_MS) return cached.value
    this.cache.delete(key)
    const answer = await this.fetch(normalized, code)
    if (answer.ok || answer.reason === 'not-found') this.remember(key, answer)
    return answer
  }

  private remember(key: string, value: DefineLookup): void {
    this.cache.set(key, { at: this.now(), value })
    while (this.cache.size > DEFINE_CACHE_MAX_ENTRIES)
      this.cache.delete(this.cache.keys().next().value!)
  }

  private async fetch(term: string, lang: string): Promise<DefineLookup> {
    let res: Awaited<ReturnType<Browser['platform']['net']['fetchText']>>
    try {
      res = await this.browser.platform.net.fetchText(
        WIKTIONARY_DEFINITION_ENDPOINT + encodeURIComponent(term),
        {
          headers: {
            Accept: 'application/json',
            'Accept-Language': this.browser.languages.acceptLanguage() || lang,
            'Api-User-Agent': DEFINE_API_USER_AGENT
          },
          timeoutMs: DEFINE_FETCH_TIMEOUT_MS,
          maxBytes: DEFINE_MAX_BYTES
        }
      )
    } catch {
      return { ok: false, reason: 'offline' }
    }
    if (res.status === 404) return { ok: false, reason: 'not-found' }
    if (!res.ok) return { ok: false, reason: res.status === 0 ? 'offline' : 'unavailable' }
    const result = parseDefinitionResponse(res.text, term, lang)
    if (!result) return { ok: false, reason: 'malformed' }
    return { ok: true, result }
  }
}
