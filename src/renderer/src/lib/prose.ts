/**
 * The small reading of the release notes' markdown the What's new page draws (SET-54): the
 * notes are the repository's own text (`shared/updates.ts` `releaseHighlights`, the `##
 * Highlights` section of a release's body) and the page shows them as chrome, not as a
 * document, so nothing here is HTML – the text is read into blocks and spans and the page
 * renders each as its own element. What the release notes use is what is read: `##` and `###`
 * headings, `-` / `*` bullets and `1.` numbers (one level), paragraphs of adjacent lines, a
 * fenced block kept verbatim; inline `**bold**`, `` `code` ``, `[text](url)` links and bare
 * `https://` addresses. Anything else is text as written. A link is a link only on `http(s):`,
 * so no other scheme rides the notes into the chrome.
 */

export type ProseSpan =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string }

export type ProseBlock =
  | { kind: 'heading'; level: 2 | 3; spans: ProseSpan[] }
  | { kind: 'paragraph'; spans: ProseSpan[] }
  | { kind: 'list'; ordered: boolean; items: ProseSpan[][] }
  | { kind: 'code'; text: string }

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/
const NUMBERED = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/
const FENCE = /^\s{0,3}(```|~~~)/

/** The blocks of a markdown text, in order; an empty text is no blocks. */
export function parseProse(text: string): ProseBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ProseBlock[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let fence: { marker: string; lines: string[] } | null = null

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', spans: parseSpans(paragraph.join(' ')) })
    paragraph = []
  }
  const flushList = (): void => {
    if (!list) return
    blocks.push({
      kind: 'list',
      ordered: list.ordered,
      items: list.items.map((item) => parseSpans(item))
    })
    list = null
  }

  for (const raw of lines) {
    if (fence) {
      if (raw.trim().startsWith(fence.marker)) {
        blocks.push({ kind: 'code', text: fence.lines.join('\n') })
        fence = null
      } else fence.lines.push(raw)
      continue
    }
    const line = raw.trimEnd()
    const opening = FENCE.exec(line)
    if (opening) {
      flushParagraph()
      flushList()
      fence = { marker: opening[1]!, lines: [] }
      continue
    }
    if (line.trim() === '') {
      flushParagraph()
      flushList()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      const level: 2 | 3 = heading[1]!.length <= 2 ? 2 : 3
      blocks.push({ kind: 'heading', level, spans: parseSpans(heading[2]!) })
      continue
    }
    const bullet = BULLET.exec(line)
    const numbered = bullet ? null : NUMBERED.exec(line)
    const item = bullet ?? numbered
    if (item) {
      flushParagraph()
      const ordered = numbered !== null
      if (list && list.ordered !== ordered) flushList()
      if (!list) list = { ordered, items: [] }
      list.items.push(item[1]!)
      continue
    }
    if (list && /^\s{2,}/.test(raw)) {
      // A bullet's continuation line, indented under it: the same item goes on.
      const open = list.items.pop() ?? ''
      list.items.push(`${open} ${line.trim()}`)
      continue
    }
    flushList()
    paragraph.push(line.trim())
  }
  if (fence) blocks.push({ kind: 'code', text: fence.lines.join('\n') })
  flushParagraph()
  flushList()
  return blocks
}

const INLINE =
  /(\*\*([^*]+?)\*\*)|(`([^`]+?)`)|(\[([^\]]+?)\]\(([^)\s]+?)\))|(https?:\/\/[^\s<>()[\]]+)/g

/** The spans of one line of markdown: text, bold, code and links, in order. */
export function parseSpans(text: string): ProseSpan[] {
  const spans: ProseSpan[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0
    if (start > last) spans.push({ kind: 'text', text: text.slice(last, start) })
    if (match[2] !== undefined) spans.push({ kind: 'bold', text: match[2] })
    else if (match[4] !== undefined) spans.push({ kind: 'code', text: match[4] })
    else if (match[6] !== undefined && match[7] !== undefined) {
      spans.push(linkSpan(match[6], match[7]))
    } else if (match[8] !== undefined) {
      // A bare address: a trailing full stop or comma is the sentence's, not the link's.
      const trailing = /[.,;:!?]+$/.exec(match[8])
      const href = trailing ? match[8].slice(0, -trailing[0].length) : match[8]
      spans.push(linkSpan(href, href))
      if (trailing) spans.push({ kind: 'text', text: trailing[0] })
    }
    last = start + match[0].length
  }
  if (last < text.length) spans.push({ kind: 'text', text: text.slice(last) })
  return spans
}

function linkSpan(text: string, href: string): ProseSpan {
  return /^https?:\/\//i.test(href) ? { kind: 'link', text, href } : { kind: 'text', text }
}

/** The text of the spans alone, the markup gone (a heading's accessible name, a test's read). */
export function spansText(spans: readonly ProseSpan[]): string {
  return spans.map((s) => s.text).join('')
}
