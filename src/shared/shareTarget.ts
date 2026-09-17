/**
 * Zenium as a share target: what another app handed over through `ACTION_SEND` or
 * `ACTION_WEB_SEARCH`, and where it goes. Pure routing, so the host only has to describe the
 * intent; the browser core resolves the search engine.
 */

export interface SharedIntent {
  /** `send` for `ACTION_SEND`, `search` for `ACTION_WEB_SEARCH`. */
  kind: 'send' | 'search'
  /** `EXTRA_TEXT`, or the query of a web search. */
  text?: string | null
  /** `EXTRA_SUBJECT` (mail apps and some readers send the title here). */
  subject?: string | null
  /** The MIME type the sender declared (`text/plain`, `image/jpeg`, …). */
  mimeType?: string | null
  /** The shared image as a `data:` URL, when the sender attached one the host could read. */
  imageDataUrl?: string | null
}

export type SharedRoute =
  /** Open the URL in a tab. */
  | { kind: 'url'; url: string }
  /** Search for the text with the user's engine. */
  | { kind: 'search'; query: string }
  /** Show the shared image in a tab. */
  | { kind: 'image'; dataUrl: string }
  /** Nothing usable was shared. */
  | { kind: 'none' }

/** A URL anywhere in shared text: with a scheme, or a `www.` host (what Twitter and mail apps send). */
const URL_IN_TEXT_RE =
  /(?:https?:\/\/[^\s<>"']+|\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#][^\s<>"']*)?)/i

/** Trailing punctuation a sentence leaves stuck to a pasted URL (brackets are handled below). */
const TRAILING_PUNCTUATION_RE = /[.,;:!?\]}>'"]+$/

const count = (s: string, ch: string): number => s.split(ch).length - 1

/** The first URL in `text`, normalised to an `http(s)` address, or null. */
export function extractUrl(text: string): string | null {
  const match = URL_IN_TEXT_RE.exec(text)
  if (!match) return null
  let url = match[0]
  // Peel the sentence's punctuation off the end. A closing bracket only belongs to the URL when
  // it opened inside it (Wikipedia's "(band)"); an unbalanced one closes the sentence's "(…)".
  for (;;) {
    const stripped = url.replace(TRAILING_PUNCTUATION_RE, '')
    if (stripped.endsWith(')') && count(stripped, '(') < count(stripped, ')')) {
      url = stripped.slice(0, -1)
      continue
    }
    url = stripped
    break
  }
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  try {
    return new URL(url).href
  } catch {
    return null
  }
}

/**
 * Where a shared intent goes: an image opens as a page of its own, text that carries a URL opens
 * that URL (the first one – a share from Twitter or a mail app is "title + link"), and any other
 * text – or a web search – is a query for the user's engine. The subject stands in for empty text.
 */
export function routeSharedIntent(intent: SharedIntent): SharedRoute {
  const text = (intent.text ?? '').trim()
  const subject = (intent.subject ?? '').trim()
  if (intent.kind === 'search') return text ? { kind: 'search', query: text } : { kind: 'none' }
  if (intent.mimeType?.toLowerCase().startsWith('image/')) {
    if (intent.imageDataUrl) return { kind: 'image', dataUrl: intent.imageDataUrl }
    // An image the host could not read: the text that came with it may still be a link.
    if (!text && !subject) return { kind: 'none' }
  }
  const url = extractUrl(text) ?? extractUrl(subject)
  if (url) return { kind: 'url', url }
  const query = text || subject
  return query ? { kind: 'search', query } : { kind: 'none' }
}
