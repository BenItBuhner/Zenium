import type { Suggestion } from '../../../shared/types'

/**
 * `chrome.omnibox`, the pure part: the result shapes, the keyword match that puts the URL bar in
 * an extension's hands, Chrome's description markup turned into plain text, and the rows the
 * URL bar shows for what the extension suggested.
 *
 * An extension declares one keyword in its manifest (`omnibox.keyword`). Input that starts with
 * that keyword and whitespace belongs to the extension: `onInputStarted` once, `onInputChanged`
 * per change with a `suggest` callback, then `onInputEntered` or `onInputCancelled`.
 */

export interface SuggestResult {
  content: string
  description: string
  deletable?: boolean
}

export interface DefaultSuggestResult {
  description: string
}

export type OnInputEnteredDisposition = 'currentTab' | 'newForegroundTab' | 'newBackgroundTab'

export interface KeywordMatch {
  extensionId: string
  keyword: string
  /** What the user typed after the keyword. */
  text: string
}

export const ERROR_INVALID_SUGGESTION = 'Invalid suggestion'
export const ERROR_INVALID_DEFAULT = 'Invalid default suggestion'
/** Chrome's ceiling on the rows one `suggest` call may add. */
export const MAX_SUGGESTIONS = 6

export class OmniboxError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeDefaultSuggestion(raw: unknown): DefaultSuggestResult {
  if (!isRecord(raw) || typeof raw.description !== 'string') {
    throw new OmniboxError(ERROR_INVALID_DEFAULT)
  }
  return { description: raw.description }
}

export function normalizeSuggestResults(raw: unknown): SuggestResult[] {
  if (!Array.isArray(raw)) throw new OmniboxError(ERROR_INVALID_SUGGESTION)
  return raw.slice(0, MAX_SUGGESTIONS).map((item) => {
    if (
      !isRecord(item) ||
      typeof item.content !== 'string' ||
      typeof item.description !== 'string'
    ) {
      throw new OmniboxError(ERROR_INVALID_SUGGESTION)
    }
    if (item.deletable !== undefined && typeof item.deletable !== 'boolean') {
      throw new OmniboxError(ERROR_INVALID_SUGGESTION)
    }
    const result: SuggestResult = { content: item.content, description: item.description }
    if (item.deletable) result.deletable = true
    return result
  })
}

/**
 * Chrome's description markup (`<url>`, `<match>`, `<dim>`, nested at will, with XML entities)
 * as plain text: the URL bar shows rows without styling. Chrome parses the description as XML and
 * walks into elements it does not know, keeping their text, so every tag goes and the text stays.
 */
export function plainDescription(markup: string): string {
  return markup
    .replace(/<\/?[a-z_][^<>]*>/gi, '')
    .replace(
      /&(lt|gt|amp|quot|apos|#(\d+)|#x([0-9a-f]+));/gi,
      (whole, name: string, dec?: string, hex?: string) => {
        switch (name.toLowerCase()) {
          case 'lt':
            return '<'
          case 'gt':
            return '>'
          case 'amp':
            return '&'
          case 'quot':
            return '"'
          case 'apos':
            return "'"
        }
        const code = dec ? Number.parseInt(dec, 10) : hex ? Number.parseInt(hex, 16) : NaN
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole
      }
    )
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Whether the input is in an extension's keyword mode: the keyword, whitespace, then the text
 * (possibly empty). Chrome enters keyword mode on the space after the keyword; a bare keyword
 * with nothing after it is still an ordinary search.
 */
export function matchKeyword(
  input: string,
  keywords: Iterable<{ extensionId: string; keyword: string }>
): KeywordMatch | null {
  const trimmed = input.replace(/^\s+/, '')
  for (const { extensionId, keyword } of keywords) {
    if (!keyword) continue
    if (trimmed.length <= keyword.length) continue
    if (!trimmed.startsWith(keyword)) continue
    const after = trimmed.slice(keyword.length)
    if (!/^\s/.test(after)) continue
    return { extensionId, keyword, text: after.replace(/^\s+/, '') }
  }
  return null
}

/** The first row in keyword mode: the extension's default suggestion with `%s` filled in. */
export function defaultDescription(
  extensionName: string,
  suggestion: DefaultSuggestResult | null,
  text: string
): string {
  if (suggestion) return plainDescription(suggestion.description.split('%s').join(text))
  return text ? `Run ${extensionName} command: ${text}` : `Run ${extensionName} command`
}

export interface OmniboxRowSource {
  extensionId: string
  extensionName: string
  keyword: string
  icon: string | null
}

/** The row the URL bar shows for the keyword itself (Enter runs `onInputEntered` with `text`). */
export function defaultRow(
  source: OmniboxRowSource,
  suggestion: DefaultSuggestResult | null,
  text: string
): Suggestion {
  return {
    id: `omnibox:${source.extensionId}:`,
    kind: 'omnibox',
    title: defaultDescription(source.extensionName, suggestion, text),
    subtitle: source.extensionName,
    url: null,
    favicon: source.icon,
    targetId: source.extensionId,
    fill: `${source.keyword} ${text}`
  }
}

/** One row per result the extension suggested; picking it enters that result's `content`. */
export function suggestionRows(source: OmniboxRowSource, results: SuggestResult[]): Suggestion[] {
  const rows: Suggestion[] = []
  const seen = new Set<string>()
  for (const result of results) {
    if (seen.has(result.content)) continue
    seen.add(result.content)
    const row: Suggestion = {
      id: `omnibox:${source.extensionId}:${result.content}`,
      kind: 'omnibox',
      title: plainDescription(result.description) || result.content,
      subtitle: source.extensionName,
      url: null,
      favicon: source.icon,
      targetId: source.extensionId,
      fill: `${source.keyword} ${result.content}`
    }
    if (result.deletable) row.deletable = true
    rows.push(row)
  }
  return rows
}

/** How the user asked for the entered input to open, as Chrome names it. */
export function dispositionFor(newTab: boolean, background: boolean): OnInputEnteredDisposition {
  if (background) return 'newBackgroundTab'
  return newTab ? 'newForegroundTab' : 'currentTab'
}
