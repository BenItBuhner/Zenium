/**
 * Word-prefix matching of a typed query against a page's title and address – Chrome's rule for
 * its history page (`query_parser` with `ALWAYS_PREFIX_SEARCH`, history-03) and for its history
 * providers in the omnibox (HistoryQuick's word index, omnibox-02): every term of the query must
 * start a word somewhere in the title or the URL; nothing matches inside a word ("docs" finds
 * "Team docs" and "example.com/docs/intro", not "Googledocs"). A word starts at the text's start
 * or after any character that is not a letter or a digit – a space, punctuation, `/`, `.`, `-`,
 * `_` – in every script (`\p{L}`, `\p{N}`); camelCase is one word. No operators, no phrases:
 * the query is split at whitespace and each piece is a term. Case is folded and the text
 * normalised (NFC) so "Ü" finds "über" and a decomposed "é" finds a composed one. The URL is
 * matched without its scheme and a leading `www.` and with its percent-escapes decoded, as
 * Chrome cleans a URL for matching, so "https" or "www" find nothing and "café" finds
 * `/caf%C3%A9`. The core's history search and the pages that filter what the core does not
 * (the History page's other-device rows) read this one rule.
 */

/** Whitespace-separated terms of a query, folded as `matchesAtWordStart` folds its text. */
export function queryTerms(text: string | undefined): string[] {
  return foldForMatch(text ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

/** The text as it is compared: lower-cased, NFC. Idempotent, so folding twice costs nothing. */
export function foldForMatch(text: string): string {
  return text.normalize('NFC').toLowerCase()
}

/**
 * The address as the matcher reads it: scheme and `www.` off (Chrome's `CleanUpUrlForMatching`),
 * percent-escapes decoded where they decode.
 */
export function matchableUrl(url: string): string {
  const bare = url.replace(/^https?:\/\/(www\.)?/i, '')
  try {
    return decodeURIComponent(bare)
  } catch {
    return bare
  }
}

const WORD_CHAR = /[\p{L}\p{N}]/u

/**
 * Does `term` occur in `hay` at the start of a word – the start of the text, or after a
 * character that is not a letter or digit? Both are folded here; `termAtWordStart` is the same
 * test over text already folded (a search folds each page once and tries every term against it).
 */
export function matchesAtWordStart(hay: string, term: string): boolean {
  return termAtWordStart(foldForMatch(hay), foldForMatch(term))
}

/** `matchesAtWordStart` over folded text and a folded term. An empty term matches nothing. */
export function termAtWordStart(hay: string, term: string): boolean {
  if (!term) return false
  let from = 0
  for (;;) {
    const at = hay.indexOf(term, from)
    if (at === -1) return false
    if (at === 0 || !WORD_CHAR.test(hay[at - 1] ?? '')) return true
    from = at + 1
  }
}

/** A page's title and address folded once, for several terms. */
export interface MatchableText {
  title: string
  url: string
}

export function matchableText(title: string, url: string): MatchableText {
  return { title: foldForMatch(title), url: foldForMatch(matchableUrl(url)) }
}

/** How many of `terms` start a word in the title (the omnibox ranks title hits over URL hits). */
export function countTitleHits(text: MatchableText, terms: readonly string[]): number {
  let n = 0
  for (const t of terms) if (termAtWordStart(text.title, t)) n += 1
  return n
}

/** Every term at the start of a word in the title or the address. No terms match everything. */
export function matchesEveryTerm(text: MatchableText, terms: readonly string[]): boolean {
  return terms.every((t) => termAtWordStart(text.title, t) || termAtWordStart(text.url, t))
}

/** `matchesEveryTerm` for one page and a query's terms (`queryTerms`). */
export function matchesAllTerms(title: string, url: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return true
  return matchesEveryTerm(matchableText(title, url), terms)
}
