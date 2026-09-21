import type { MatchRange } from '@shared/tabSearch'
import type { SuggestionKind } from '@shared/types'

export type { MatchRange }

/*
 * Where a suggestion row's text is set in the heading weight for what was typed (omnibox-21,
 * Chrome's anatomy). Two rules, one per family of row:
 *
 * - A search row (and an engine's entity row) shows what the engine adds: the typed text reads
 *   plain where it occurs and everything else is emphasised – "wea" → wea|ther|, "food" →
 *   |cat |food – so the eye lands on the completion; a suggestion that does not contain the
 *   typed text at all is emphasised whole (Chrome's `ClassifyMatchInString` on a search match).
 * - Every other row (a URL, a page from history, a bookmark, an open tab, a command, a keyword)
 *   shows where the typed words hit: each word at the start of a word of the title or the host
 *   is emphasised – "git" → |git|hub.com, "let" → GitHub: |Let|'s build – as Chrome's history
 *   rows bold their term matches; a word inside a word is not a hit (Chrome filters term
 *   matches to word starts), and a scheme or `www.` typed ahead of a host is not looked for.
 *
 * Nothing is emphasised on a row that is not a match for typed text: an answer (the answer is
 * the row), the clipboard row (it names a kind), and every row of zero-suggest.
 */

/** Rows whose completion is emphasised rather than the typed part. */
const COMPLETION_KINDS: ReadonlySet<SuggestionKind> = new Set(['search', 'entity'])
/** Rows that carry no emphasis whatever was typed. */
const PLAIN_KINDS: ReadonlySet<SuggestionKind> = new Set(['answer', 'clipboard'])

const isWordStart = (text: string, index: number): boolean =>
  index === 0 || !/[\p{L}\p{N}]/u.test(text[index - 1] ?? '')

/** A typed word as it is looked for in a row: lower-cased, without a scheme, `www.` or `@`. */
function termOf(word: string): string {
  return word
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/^@/, '')
}

/** Ranges sorted by start, overlapping and touching ones merged. */
function merge(ranges: MatchRange[]): MatchRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: MatchRange[] = []
  for (const [start, end] of sorted) {
    const last = out.at(-1)
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else out.push([start, end])
  }
  return out
}

/** The typed words at word starts of `text`, every occurrence, merged. */
function termMatches(text: string, typed: string): MatchRange[] {
  const lower = text.toLowerCase()
  const ranges: MatchRange[] = []
  for (const word of typed.split(/\s+/)) {
    const term = termOf(word)
    if (!term) continue
    for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + 1))
      if (isWordStart(lower, at)) ranges.push([at, at + term.length])
  }
  return merge(ranges)
}

/** Everything of `text` but the first occurrence of the typed text; all of it when absent. */
function completion(text: string, typed: string): MatchRange[] {
  const at = text.toLowerCase().indexOf(typed.toLowerCase())
  if (at === -1) return text ? [[0, text.length]] : []
  const ranges: MatchRange[] = []
  if (at > 0) ranges.push([0, at])
  if (at + typed.length < text.length) ranges.push([at + typed.length, text.length])
  return ranges
}

/**
 * The half-open ranges of `text` – a row's title, or its description line when `slot` says so –
 * set in the heading weight for `typed`, what the user has typed (a keyword mode's terms alone;
 * empty for zero-suggest). A search row's description ("Search with Google") names the engine
 * and is never a completion, so it carries no emphasis.
 */
export function matchRanges(
  kind: SuggestionKind,
  text: string,
  typed: string,
  slot: 'title' | 'description' = 'title'
): MatchRange[] {
  const query = typed.trim()
  if (!query || !text || PLAIN_KINDS.has(kind)) return []
  if (COMPLETION_KINDS.has(kind)) return slot === 'title' ? completion(text, query) : []
  return termMatches(text, query)
}
