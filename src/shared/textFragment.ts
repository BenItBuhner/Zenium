/**
 * Text fragments (SH-11, the URL Fragment Text Directives spec, Chrome's "Copy Link to
 * Highlight"): `#:~:text=[prefix-,]start[,end][,-suffix]` names a passage of a page so that a
 * browser opening the link scrolls to it and highlights it.
 *
 * Two halves, both pure over a linear reading of the document (`linearize`): the generator turns a
 * selection into the shortest directive that finds the selection and nothing before it – the exact
 * text when it is short enough, a `start,end` range when it is long, with prefix and suffix
 * context added a word at a time while an earlier passage also matches (Chrome's
 * `TextFragmentSelectorGenerator`) – and the finder is the spec's matching: case-insensitive, any
 * whitespace run standing for any other, each term whole-word and never across a block boundary,
 * the prefix ending and the suffix beginning right against the passage (whitespace apart).
 */

export interface TextDirective {
  prefix?: string
  textStart: string
  textEnd?: string
  suffix?: string
}

/** The fragment directive delimiter: what follows it in a URL's fragment is not the page's own. */
export const FRAGMENT_DIRECTIVE = ':~:'

/** The exact text is tried first up to this many characters; longer selections become a range (Chrome's cap). */
export const EXACT_TEXT_MAX_CHARS = 300
/** A range's start and end open with this many words and grow while the range is ambiguous. */
const RANGE_MIN_WORDS = 3
/** Context and range terms stop growing here; a selection still ambiguous then has no link. */
const MAX_TERM_WORDS = 10

// --- the URL --------------------------------------------------------------------------------

/** Percent-encode a term as the spec asks: `-`, `,` and `&` cannot be left bare inside a value. */
export function encodeTerm(term: string): string {
  return encodeURIComponent(term).replace(/-/g, '%2D')
}

export function encodeTextDirective(d: TextDirective): string {
  const parts: string[] = []
  if (d.prefix) parts.push(`${encodeTerm(d.prefix)}-`)
  parts.push(encodeTerm(d.textStart))
  if (d.textEnd) parts.push(encodeTerm(d.textEnd))
  if (d.suffix) parts.push(`-${encodeTerm(d.suffix)}`)
  return `text=${parts.join(',')}`
}

/**
 * The `text=` directives of a fragment (`document.location.hash` as the engine left it, or the
 * raw fragment); anything before the `:~:` is the page's own fragment and is ignored, as are
 * directives that are not text ones or that do not parse.
 */
export function parseTextDirectives(fragment: string): TextDirective[] {
  const at = fragment.indexOf(FRAGMENT_DIRECTIVE)
  if (at < 0) return []
  const out: TextDirective[] = []
  for (const directive of fragment.slice(at + FRAGMENT_DIRECTIVE.length).split('&')) {
    if (!directive.startsWith('text=')) continue
    const parsed = parseTextDirective(directive.slice('text='.length))
    if (parsed) out.push(parsed)
  }
  return out
}

function parseTextDirective(value: string): TextDirective | null {
  const parts = value.split(',')
  if (parts.length === 0 || parts.length > 4) return null
  let prefix: string | null | undefined
  let suffix: string | null | undefined
  if (parts.length > 1 && parts[0]!.endsWith('-')) prefix = decode(parts.shift()!.slice(0, -1))
  if (parts.length > 1 && parts[parts.length - 1]!.startsWith('-'))
    suffix = decode(parts.pop()!.slice(1))
  if (parts.length === 0 || parts.length > 2) return null
  const textStart = decode(parts[0]!)
  const textEnd = parts.length === 2 ? decode(parts[1]!) : undefined
  if (textStart === null || textEnd === null || prefix === null || suffix === null) return null
  if (!textStart || textEnd === '' || prefix === '' || suffix === '') return null
  const d: TextDirective = { textStart }
  if (prefix !== undefined) d.prefix = prefix
  if (textEnd !== undefined) d.textEnd = textEnd
  if (suffix !== undefined) d.suffix = suffix
  return d
}

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
}

/**
 * `url` with the text directive as its fragment directive: the page's own fragment stays ahead of
 * the `:~:`, an earlier fragment directive is replaced (as Chrome's `AppendSelectors` does).
 */
export function appendTextDirective(url: string, directive: string): string {
  const hash = url.indexOf('#')
  const base = hash < 0 ? url : url.slice(0, hash)
  let fragment = hash < 0 ? '' : url.slice(hash + 1)
  const at = fragment.indexOf(FRAGMENT_DIRECTIVE)
  if (at >= 0) fragment = fragment.slice(0, at)
  return `${base}#${fragment}${FRAGMENT_DIRECTIVE}${directive}`
}

/** Whether a URL carries a fragment directive at all (the engine strips it from `location.hash` when it handles it). */
export function hasFragmentDirective(url: string): boolean {
  const hash = url.indexOf('#')
  return hash >= 0 && url.indexOf(FRAGMENT_DIRECTIVE, hash) >= 0
}

// --- the linear document ----------------------------------------------------------------------

/**
 * A document read as one string: its text nodes in order, a `\n` at every block boundary (the
 * matching never crosses one), and where each stretch of the string came from, so a match maps
 * back to a DOM range. Only rendered text takes part: scripts, styles and hidden subtrees are
 * skipped, as the spec's "search invisible" rule skips them.
 */
export interface LinearText {
  text: string
  /** Text-node stretches, in order: `[start, end)` of `text` is `node`'s data. */
  segments: { start: number; end: number; node: Text }[]
}

/** The block boundary character inserted between blocks; never a character of the document's text. */
const BLOCK = '\n'

const SKIPPED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'HEAD',
  'TITLE',
  'IFRAME',
  'OBJECT',
  'SVG',
  'CANVAS',
  'TEXTAREA',
  'SELECT'
])

/** Elements that end a run of text whatever their computed display (a cheap stand-in for layout). */
const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'BODY',
  'BR',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL'
])

interface VisibilityCheck {
  checkVisibility?(): boolean
}

function hidden(element: Element): boolean {
  if (SKIPPED_TAGS.has(element.tagName.toUpperCase())) return true
  if (element.hasAttribute('hidden')) return true
  const check = (element as VisibilityCheck).checkVisibility
  if (typeof check === 'function') {
    try {
      return !check.call(element)
    } catch {
      return false
    }
  }
  return false
}

/** Read `root` (a document's body, or an element) into a `LinearText`. */
export function linearize(root: Node): LinearText {
  const segments: LinearText['segments'] = []
  let text = ''
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      const data = (node as Text).data
      if (!data) return
      segments.push({ start: text.length, end: text.length + data.length, node: node as Text })
      text += data
      return
    }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return
    const element = node.nodeType === 1 ? (node as Element) : null
    if (element && hidden(element)) return
    const block = element !== null && BLOCK_TAGS.has(element.tagName)
    if (block && !text.endsWith(BLOCK)) text += BLOCK
    for (let child = node.firstChild; child; child = child.nextSibling) walk(child)
    if (block && !text.endsWith(BLOCK)) text += BLOCK
  }
  walk(root)
  return { text, segments }
}

/** The `[start, end)` of `text` a DOM range covers, or null when the range touches no rendered text. */
export function linearOffsets(linear: LinearText, range: Range): [number, number] | null {
  let start = -1
  let end = -1
  const { startContainer, startOffset, endContainer, endOffset } = range
  for (const seg of linear.segments) {
    const node = seg.node
    if (start < 0) {
      if (node === startContainer) start = seg.start + Math.min(startOffset, seg.end - seg.start)
      else if (startContainer.nodeType !== 3 && range.comparePoint(node, 0) >= 0) start = seg.start
    }
    if (node === endContainer) {
      end = seg.start + Math.min(endOffset, seg.end - seg.start)
      break
    }
    if (endContainer.nodeType !== 3) {
      const relation = range.comparePoint(node, node.data.length)
      if (relation <= 0) end = seg.end
      else break
    }
  }
  if (start < 0 || end < 0 || end <= start) return null
  return [start, end]
}

/** The DOM range covering `[start, end)` of `text`, or null when it lands on no text node. */
export function rangeOf(
  linear: LinearText,
  doc: Document,
  start: number,
  end: number
): Range | null {
  let from: { node: Text; offset: number } | null = null
  let to: { node: Text; offset: number } | null = null
  for (const seg of linear.segments) {
    if (!from && start >= seg.start && start < seg.end)
      from = { node: seg.node, offset: start - seg.start }
    if (end > seg.start && end <= seg.end) {
      to = { node: seg.node, offset: end - seg.start }
      break
    }
  }
  if (!from || !to) return null
  const range = doc.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  return range
}

// --- matching --------------------------------------------------------------------------------

const WORD_CHAR = /[\p{L}\p{N}_]/u
/** Scripts written without spaces: every character is a word of its own for the boundary rule. */
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch) && !UNSPACED.test(ch)
}

function boundaryAt(text: string, index: number): boolean {
  return !isWordChar(text[index - 1]) || !isWordChar(text[index])
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A term as a pattern: its whitespace runs stand for any whitespace, case folded. */
function termPattern(term: string): RegExp {
  const words = normalize(term).split(' ').map(escapeRegExp)
  return new RegExp(words.join('\\s+'), 'giu')
}

/** Collapse whitespace and trim, as terms are compared. */
export function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * The first whole-word occurrence of `term` in `text` at or after `from` that lies within one
 * block, as `[start, end)`; with `anchored`, only an occurrence beginning at `from` itself
 * (whitespace skipped) counts.
 */
export function findTerm(
  text: string,
  term: string,
  from: number,
  anchored = false
): [number, number] | null {
  const re = termPattern(term)
  if (anchored) {
    let at = from
    while (at < text.length && /\s/.test(text[at]!) && text[at] !== BLOCK) at++
    re.lastIndex = at
    const m = re.exec(text)
    if (!m || m.index !== at) return null
    const end = at + m[0].length
    if (m[0].includes(BLOCK) || !boundaryAt(text, at) || !boundaryAt(text, end)) return null
    return [at, end]
  }
  re.lastIndex = from
  for (;;) {
    const m = re.exec(text)
    if (!m) return null
    const start = m.index
    const end = start + m[0].length
    if (!m[0].includes(BLOCK) && boundaryAt(text, start) && boundaryAt(text, end))
      return [start, end]
    re.lastIndex = start + 1
  }
}

/**
 * The spec's match of a directive in `text` at or after `from`: the first passage whose prefix
 * (if any) precedes it in its block with only whitespace between, whose start (and end, for a
 * range) are whole-word terms, and whose suffix (if any) follows it the same way.
 */
export function matchDirective(text: string, d: TextDirective, from = 0): [number, number] | null {
  let cursor = from
  for (;;) {
    let startAt: number
    let prefixEnd = -1
    if (d.prefix) {
      const prefix = findTerm(text, d.prefix, cursor)
      if (!prefix) return null
      prefixEnd = prefix[1]
      startAt = prefixEnd
    } else {
      startAt = cursor
    }
    const start = findTerm(text, d.textStart, startAt, d.prefix !== undefined)
    if (!start) {
      if (d.prefix === undefined) return null
      cursor = prefixEnd + 1
      continue
    }
    let end: [number, number] = start
    if (d.textEnd) {
      const found = findTerm(text, d.textEnd, start[1])
      if (!found) return null
      end = found
    }
    if (d.suffix) {
      const suffix = findTerm(text, d.suffix, end[1], true)
      if (!suffix) {
        cursor = d.prefix ? prefixEnd + 1 : start[0] + 1
        continue
      }
    }
    return [start[0], end[1]]
  }
}

/** Where the directive's first match lands in `doc`, as a DOM range; null when it matches nothing. */
export function findTextDirective(
  doc: Document,
  d: TextDirective,
  linear = linearize(doc.body ?? doc)
): Range | null {
  const hit = matchDirective(linear.text, d)
  return hit ? rangeOf(linear, doc, hit[0], hit[1]) : null
}

// --- generating -------------------------------------------------------------------------------

/** The words of `text` in `[from, to)`, with where each begins and ends. */
function wordsIn(text: string, from: number, to: number): [number, number][] {
  const out: [number, number][] = []
  const re = /\S+/g
  re.lastIndex = from
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) && m.index < to) {
    out.push([m.index, Math.min(m.index + m[0].length, to)])
  }
  return out
}

/** The block `[start, end)` of `text` that contains `index` (blocks are separated by `\n`). */
function blockAround(text: string, index: number): [number, number] {
  let start = text.lastIndexOf(BLOCK, index - 1) + 1
  let end = text.indexOf(BLOCK, index)
  if (end < 0) end = text.length
  if (start > end) start = end
  return [start, end]
}

/**
 * The directive for the passage `[start, end)` of `linear.text`, or null when none singles it out:
 * the exact text when it is at most `EXACT_TEXT_MAX_CHARS` long, else a `start,end` range of a
 * few words at each end; then, while an earlier passage matches too, a word of prefix and a word
 * of suffix from the passage's own blocks per round (and, for a range, a word more at each end),
 * up to `MAX_TERM_WORDS` each.
 */
export function generateDirective(
  linear: LinearText,
  start: number,
  end: number
): TextDirective | null {
  const text = linear.text
  // Trim the passage to its text, then widen it to whole words (a term is matched whole-word).
  while (start < end && /\s/.test(text[start]!)) start++
  while (end > start && /\s/.test(text[end - 1]!)) end--
  if (end <= start) return null
  while (start > 0 && isWordChar(text[start - 1]) && isWordChar(text[start])) start--
  while (end < text.length && isWordChar(text[end - 1]) && isWordChar(text[end])) end++
  const selected = normalize(text.slice(start, end))
  if (!selected) return null

  const [firstBlockStart, firstBlockEnd] = blockAround(text, start)
  const [lastBlockStart, lastBlockEnd] = blockAround(text, end - 1)
  const oneBlock = firstBlockStart === lastBlockStart
  // The exact text cannot name a passage across blocks (no term may span one); a range can.
  const ranged = !oneBlock || selected.length > EXACT_TEXT_MAX_CHARS
  const startWords = wordsIn(text, start, oneBlock ? end : firstBlockEnd)
  const endWords = wordsIn(text, oneBlock ? start : lastBlockStart, end)
  if (startWords.length === 0 || endWords.length === 0) return null
  const before = wordsIn(text, firstBlockStart, start)
  const after = wordsIn(text, end, lastBlockEnd)

  const term = (words: [number, number][], from: number, to: number): string =>
    normalize(text.slice(words[from]![0], words[to - 1]![1]))
  let rangeWords = RANGE_MIN_WORDS
  let contextWords = 0
  for (;;) {
    const d: TextDirective = ranged
      ? {
          textStart: term(startWords, 0, Math.min(rangeWords, startWords.length)),
          textEnd: term(endWords, Math.max(0, endWords.length - rangeWords), endWords.length)
        }
      : { textStart: selected }
    if (contextWords > 0) {
      const p = before.slice(-contextWords)
      const s = after.slice(0, contextWords)
      if (p.length > 0) d.prefix = normalize(text.slice(p[0]![0], p[p.length - 1]![1]))
      if (s.length > 0) d.suffix = normalize(text.slice(s[0]![0], s[s.length - 1]![1]))
    }
    const hit = matchDirective(text, d)
    if (hit && hit[0] === start && hit[1] === end) return d
    // Ambiguous: a range first takes more of the passage into its two terms (Chrome's order),
    // then a word of prefix and of suffix per round; nothing more to add on any side ends it.
    const moreRange =
      ranged &&
      rangeWords < MAX_TERM_WORDS &&
      (rangeWords < startWords.length || rangeWords < endWords.length) &&
      (!oneBlock || 2 * rangeWords < startWords.length)
    const moreContext =
      contextWords < MAX_TERM_WORDS && (before.length > contextWords || after.length > contextWords)
    if (moreRange) rangeWords++
    else if (moreContext) contextWords++
    else return null
  }
}

/**
 * The directive for a DOM selection range – Chrome's Copy Link to Highlight – or null when the
 * selection is empty, spans no rendered text, or cannot be singled out in the page.
 */
export function generateForRange(doc: Document, range: Range): TextDirective | null {
  const root = doc.body ?? doc.documentElement
  if (!root) return null
  const linear = linearize(root)
  const offsets = linearOffsets(linear, range)
  if (!offsets) return null
  return generateDirective(linear, offsets[0], offsets[1])
}

/** The encoded `text=` directive for the document's current selection, or null. */
export function generateForSelection(doc: Document): string | null {
  const selection = doc.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const d = generateForRange(doc, selection.getRangeAt(0))
  return d ? encodeTextDirective(d) : null
}
