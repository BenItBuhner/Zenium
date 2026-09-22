/**
 * The preferred languages (Settings › Languages; Chrome's chrome://settings/languages, CT-41):
 * an ordered list of BCP 47 tags the user reads, most preferred first. Pure functions shared by
 * the core (the setting's shape, its default from the OS locales), the Electron host (the
 * `Accept-Language` every session sends) and the tests, which check Chrome's rules exactly:
 * `net::HttpUtil::ExpandLanguageList` puts each region variant's base language after it, and
 * `GenerateAcceptLanguageHeader` weights the list in descending 0.1 steps down to `q=0.1`.
 */

/** A language tag as `Accept-Language` takes it: `en`, `en-US`, `zh-Hant-TW`, `es-419`. */
const LANGUAGE_TAG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

/** Chrome's list is bounded in practice by its picker; more than this is noise on the wire. */
export const LANGUAGES_MAX = 32

/** What stands when neither the profile nor the OS names a language (Chrome's own fallback). */
export const FALLBACK_LANGUAGES: readonly string[] = ['en-US', 'en']

/**
 * A tag in canonical casing (`en-us` → `en-US`, `zh-hant-tw` → `zh-Hant-TW`, `es-419` stays),
 * with POSIX spellings (`en_US.UTF-8`, `de_DE@euro`) reduced to the tag; null for anything
 * that is not a language tag (`C`, `POSIX`, an empty string).
 */
export function normalizeLanguageTag(raw: string): string | null {
  const tag = raw
    .trim()
    .replace(/_/g, '-')
    .replace(/[.@].*$/, '')
  if (!LANGUAGE_TAG_RE.test(tag)) return null
  const [language, ...rest] = tag.split('-')
  const lower = language.toLowerCase()
  if (lower === 'c' || lower === 'posix') return null
  const parts = rest.map((part) => {
    if (part.length === 4 && /^[A-Za-z]+$/.test(part))
      return part[0].toUpperCase() + part.slice(1).toLowerCase()
    if (part.length === 2 && /^[A-Za-z]+$/.test(part)) return part.toUpperCase()
    return part.toLowerCase()
  })
  return [lower, ...parts].join('-')
}

/** `en` for `en-US`; the tag itself when it has no subtags. */
export function baseLanguage(tag: string): string {
  const dash = tag.indexOf('-')
  return dash > 0 ? tag.slice(0, dash) : tag
}

/**
 * The setting's list from stored, synced or client-sent data: canonical tags, no duplicates
 * (case-insensitively), bounded; `fallback` when nothing valid is left.
 */
export function sanitizeLanguages(raw: unknown, fallback: readonly string[] = []): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string') continue
      const tag = normalizeLanguageTag(item)
      if (!tag || seen.has(tag.toLowerCase())) continue
      seen.add(tag.toLowerCase())
      out.push(tag)
      if (out.length >= LANGUAGES_MAX) break
    }
  }
  return out.length > 0 ? out : [...fallback]
}

/**
 * The list a fresh profile starts with: the OS's languages (the UI locale first, then the
 * system's preferred list) with each region variant followed by its base language, without
 * duplicates – Chrome's fresh `intl.accept_languages` (`en-US,en` for a US English system).
 * English when the OS names no language at all.
 */
export function defaultLanguages(locales: readonly string[]): string[] {
  const list = expandLanguages(sanitizeLanguages(locales))
  return list.length > 0 ? list : [...FALLBACK_LANGUAGES]
}

/**
 * Chrome's expansion of a language list (`net::HttpUtil::ExpandLanguageList`): every language
 * in order, and after the last of a run of one family its base language (`en-US,en-GB,de` →
 * `en-US,en-GB,en,de`), nothing twice. The tags are taken as they come (canonical already).
 */
export function expandLanguages(languages: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (tag: string): void => {
    const key = tag.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(tag)
  }
  for (let i = 0; i < languages.length; i++) {
    const tag = languages[i]
    add(tag)
    const base = baseLanguage(tag)
    const next = languages[i + 1]
    if (next === undefined || baseLanguage(next).toLowerCase() !== base.toLowerCase()) add(base)
  }
  return out
}

/**
 * The `Accept-Language` list for the setting: Chrome's expansion (`expandLanguages`) of the
 * canonical tags, comma-separated, without weights – what Electron's
 * `session.setUserAgent(ua, acceptLanguages)` takes; the network layer adds the weights
 * (`acceptLanguageHeader` says which). Never empty: the fallback list stands for nothing.
 */
export function acceptLanguageList(languages: readonly string[]): string {
  const list = expandLanguages(sanitizeLanguages(languages))
  return (list.length > 0 ? list : FALLBACK_LANGUAGES).join(',')
}

/** One string per list, for change detection (`en-US,en,de`). */
export function languagesKey(languages: readonly string[]): string {
  return languages.join(',')
}

/**
 * The header value Chromium sends for a list (`net::HttpUtil::GenerateAcceptLanguageHeader`):
 * the first language unweighted, then `;q=0.9`, `;q=0.8`, … down to `;q=0.1`, which every
 * further language repeats – `en-US,en;q=0.9,de;q=0.8`.
 */
export function acceptLanguageHeader(languages: readonly string[]): string {
  return acceptLanguageList(languages)
    .split(',')
    .map((tag, index) => (index === 0 ? tag : `${tag};q=0.${Math.max(1, 10 - index)}`))
    .join(',')
}
