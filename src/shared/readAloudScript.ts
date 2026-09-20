import {
  BlockCollector,
  READ_ALOUD_SENTENCE_HIGHLIGHT,
  READ_ALOUD_SKIP_TAGS,
  READ_ALOUD_WORD_HIGHLIGHT,
  collapseWhitespace,
  normalizeLanguageTag,
  toReadAloudBlock,
  type BlockPiece,
  type CollectedBlock,
  type ReadAloudBlockPosition,
  type ReadAloudExtractRequest,
  type ReadAloudExtractedBlock,
  type ReadAloudExtraction,
  type ReadAloudHighlightMessage,
  type ReadAloudHostMessage
} from './readAloud'

/**
 * The page's half of read aloud (`shared/readAloud.ts` has the model): `readAloud.extract`
 * walks the document into blocks – the same walk the core does over the reader article's HTML,
 * so the two agree on every block – and answers with each block's text and where it is;
 * `readAloud.highlight` paints the sentence and the word being spoken through the CSS Custom
 * Highlight API (`::highlight(zenium-read-sentence)` / `::highlight(zenium-read-word)`) over
 * Ranges built from the block's position and the offsets, and scrolls the sentence into view
 * when it is off screen. The `zen://reader` document is painted by the same code: its
 * `<article>` walked by the same rules names the core's blocks (`b<index>`).
 */

/** Elements whose content is the page's furniture rather than its text (the heuristic without Readability). */
const FURNITURE_TAGS: ReadonlySet<string> = new Set(['nav', 'footer', 'aside', 'header', 'menu'])
const FURNITURE_ROLES: ReadonlySet<string> = new Set([
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'menu',
  'menubar',
  'toolbar',
  'search',
  'dialog',
  'alertdialog'
])

/** When Readability's blocks cover less of the page than this, the heuristic walk stands in. */
const MIN_READABILITY_COVERAGE = 0.5

/**
 * A block as the collector gathered it from the DOM, with its text nodes; `offset` says how many
 * characters of the run's collapsed text precede this block's (a selection's first block starts
 * mid-run), 0 or absent otherwise.
 */
export type DomBlock = CollectedBlock<Element, Text> & { offset?: number }

export interface ReadAloudScriptTransport {
  send(message: { type: 'readAloud'; readAloud: ReadAloudExtraction }): void
  onReadAloud(listener: (message: ReadAloudHostMessage) => void): void
}

/** Install the page's half: answers `extract` requests and paints `highlight` messages. */
export function installReadAloud(transport: ReadAloudScriptTransport): void {
  transport.onReadAloud((message) => {
    if (!message || message.type !== 'readAloud') return
    if (message.action === 'extract') {
      transport.send({ type: 'readAloud', readAloud: extract(document, message) })
      return
    }
    if (message.action === 'highlight') paintHighlight(document, message)
  })
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * `readAloud.extract`: the document's text as blocks with their positions. The reader document
 * answers from its `<article>`, walked by the rules the core walks the article's HTML with (the
 * same blocks the highlight resolves `b<index>` against); a web page from its main content.
 */
export function extract(doc: Document, request: ReadAloudExtractRequest): ReadAloudExtraction {
  const article = readerArticle(doc)
  const root = article ?? doc.body ?? doc.documentElement
  const lang = documentLanguage(doc)
  let blocks: DomBlock[]
  if (request.from === 'selection') {
    blocks = selectionBlocks(doc, root, lang, { then: request.then, keep: request.keep })
  } else if (article) {
    blocks = readerBlocks(article, lang)
  } else {
    const all = walkBlocks(root, lang, { skipFurniture: true, visibleOnly: true })
    blocks = request.keep && request.keep.length > 0 ? keptBlocks(all, request.keep) : all
  }
  return {
    requestId: request.requestId,
    title: doc.title || '',
    lang,
    blocks: blocks.map((block, index) => extractedBlock(block, index, root))
  }
}

function extractedBlock(block: DomBlock, index: number, root: Element): ReadAloudExtractedBlock {
  const model = toReadAloudBlock(block, index)
  const at: ReadAloudBlockPosition = {
    path: pathOf(block.ref, root),
    run: block.run,
    offset: block.offset ?? 0
  }
  return { ...model, at }
}

/** The document's language: `<html lang>`, else the content-language meta, else ''. */
export function documentLanguage(doc: Document): string {
  const html = doc.documentElement?.getAttribute('lang')
  const fromRoot = normalizeLanguageTag(html)
  if (fromRoot) return fromRoot
  const meta = doc.querySelector('meta[http-equiv="content-language" i]')?.getAttribute('content')
  return normalizeLanguageTag(meta?.split(',')[0] ?? '')
}

/** The `zen://reader` document's `<article>`; null in any other page. */
export function readerArticle(doc: Document): Element | null {
  const url = doc.location?.href ?? ''
  if (!url.startsWith('zen://reader')) return null
  return doc.querySelector('main > article') ?? doc.querySelector('article')
}

interface WalkOptions {
  /** Leave out `nav`, `footer`, `aside`, `header` and the landmark roles (the heuristic main text). */
  skipFurniture?: boolean
  /** Leave out elements the page hides (`display: none`, `visibility: hidden`, `hidden`, `aria-hidden`). */
  visibleOnly?: boolean
}

/**
 * The blocks of `root`'s content, in document order, by the collector's rules (text lands in
 * its nearest block ancestor; a nested block splits its parent's runs). Every block keeps the
 * text nodes it came from, for the highlight's ranges.
 */
export function walkBlocks(root: Element, docLang: string, options: WalkOptions = {}): DomBlock[] {
  const collector = new BlockCollector<Element, Text>(docLang, root, true)
  const view = root.ownerDocument.defaultView
  const styles = options.visibleOnly && view ? view : null
  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      collector.text((node as Text).data, node as Text)
      return
    }
    if (node.nodeType !== 1) return
    const el = node as Element
    if (isMark(el)) return
    const tag = el.tagName.toLowerCase()
    if (tag === 'br') {
      collector.text(' ')
      return
    }
    const skip =
      READ_ALOUD_SKIP_TAGS.has(tag) ||
      (options.visibleOnly && isHidden(el, styles)) ||
      (options.skipFurniture && isFurniture(el, tag))
    collector.open(tag, { lang: el.getAttribute('lang'), skip }, el)
    if (!skip) for (const child of childNodesOf(el)) visit(child)
    collector.close()
  }
  for (const child of childNodesOf(root)) visit(child)
  return collector.finish()
}

function childNodesOf(el: Element): Node[] {
  return Array.from(el.childNodes)
}

function isHidden(el: Element, view: (Window & typeof globalThis) | null): boolean {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true
  if (!view) return false
  try {
    const style = view.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return true
  } catch {
    /* a detached element: nothing to say */
  }
  return false
}

function isFurniture(el: Element, tag: string): boolean {
  if (FURNITURE_TAGS.has(tag)) return true
  const role = el.getAttribute('role')
  return role !== null && FURNITURE_ROLES.has(role.trim().toLowerCase())
}

/**
 * The page's blocks that Readability kept, by their text (`keep`: the article's block texts),
 * when they cover enough of the article to trust; else every block (the heuristic walk).
 */
export function keptBlocks(all: DomBlock[], keep: readonly string[]): DomBlock[] {
  const wanted = new Map<string, number>()
  let total = 0
  for (const text of keep) {
    const key = collapseWhitespace(text)
    if (!key) continue
    wanted.set(key, (wanted.get(key) ?? 0) + 1)
    total += key.length
  }
  const kept: DomBlock[] = []
  let covered = 0
  for (const block of all) {
    const count = wanted.get(block.text)
    if (!count) continue
    wanted.set(block.text, count - 1)
    kept.push(block)
    covered += block.text.length
  }
  return total > 0 && covered / total >= MIN_READABILITY_COVERAGE ? kept : all
}

export interface SelectionOptions {
  /** `document`: the document's blocks after the selection follow it (EDGE-11's "read on"). */
  then?: 'document'
  /** Readability's block texts, when the core has them: the continuation keeps to the main content. */
  keep?: readonly string[] | null
}

/**
 * The selection's text as blocks: the blocks of the document that intersect the selection, in
 * order, the first cut to where the selection starts (its `offset` says where in the run) and
 * the last to where it ends. With `then: 'document'` the rest of the document follows: what
 * remains of the last block after the selection's end (from that offset), then every block
 * after it – `keep`'s when they are given and cover enough of the page – so nothing selected is
 * read twice and nothing after it is left out.
 */
export function selectionBlocks(
  doc: Document,
  root: Element,
  docLang: string,
  options: SelectionOptions = {}
): DomBlock[] {
  const selection = doc.getSelection?.()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return []
  const range = selection.getRangeAt(0)
  const all = walkBlocks(root, docLang, { visibleOnly: true })
  const out: DomBlock[] = []
  let lastIndex = -1
  for (let i = 0; i < all.length; i++) {
    const block = all[i]
    const pieces = block.pieces ?? []
    if (pieces.some((piece) => range.intersectsNode(piece.node))) {
      out.push(block)
      lastIndex = i
    }
  }
  if (out.length === 0) return out
  const last = out[out.length - 1]
  const end = offsetInBlock(last, range.endContainer, range.endOffset)
  let remainder: DomBlock | null = null
  if (end < last.text.length) {
    const text = last.text.slice(0, end).trimEnd()
    if (text) out[out.length - 1] = { ...last, text }
    else out.pop()
    const rest = last.text.slice(end)
    const restText = rest.trimStart()
    if (restText)
      remainder = { ...last, text: restText, offset: end + (rest.length - restText.length) }
  }
  const first = out[0]
  if (first) {
    const start = offsetInBlock(first, range.startContainer, range.startOffset)
    if (start > 0) {
      const rest = first.text.slice(start)
      const text = rest.trimStart()
      if (text) out[0] = { ...first, text, offset: start + (rest.length - text.length) }
      else out.shift()
    }
  }
  if (options.then !== 'document') return out
  if (remainder) out.push(remainder)
  const following = all.slice(lastIndex + 1)
  const keep = options.keep
  if (keep && keep.length > 0) {
    // Readability's blocks stand only when they cover the page as a whole, as for a top start.
    const kept = keptBlocks(all, keep)
    const wanted = kept !== all ? new Set(kept) : null
    for (const block of following) if (!wanted || wanted.has(block)) out.push(block)
  } else {
    for (const block of following) out.push(block)
  }
  return out
}

/**
 * Where a DOM position falls in a block's collapsed text: the pieces before it, plus the offset
 * within the piece it is in, mapped through the whitespace collapse.
 */
function offsetInBlock(block: DomBlock, container: Node, offset: number): number {
  const pieces = block.pieces ?? []
  const index = pieces.findIndex((piece) => piece.node === container)
  let raw = 0
  if (index !== -1) {
    for (let i = 0; i < index; i++) raw += pieces[i].text.length
    raw += Math.min(offset, pieces[index].text.length)
  } else {
    for (const piece of pieces) {
      if (startsAfter(container, offset, piece.node)) break
      raw += piece.text.length
    }
  }
  return collapsedOffset(pieces, raw)
}

/** Whether `node` begins at or after the boundary (`container`, `offset`) in document order. */
function startsAfter(container: Node, offset: number, node: Node): boolean {
  if (container.contains(node)) {
    let child: Node = node
    while (child.parentNode && child.parentNode !== container) child = child.parentNode
    return Array.prototype.indexOf.call(container.childNodes, child) >= offset
  }
  return Boolean(container.compareDocumentPosition(node) & 4)
}

/** The offset in the collapsed text of a raw offset into the concatenated pieces. */
function collapsedOffset(pieces: BlockPiece<Text>[], rawOffset: number): number {
  const raw = pieces.map((p) => p.text).join('')
  return collapsedLength(raw.slice(0, rawOffset), raw)
}

/**
 * How many characters of the collapsed text `prefix` accounts for: leading whitespace is gone,
 * runs of whitespace are one space (a trailing run counts only when text follows in `whole`).
 */
function collapsedLength(prefix: string, whole: string): number {
  const collapsed = prefix.replace(/^\s+/, '').replace(/\s+/g, ' ')
  if (/\s$/.test(collapsed)) {
    const rest = whole.slice(prefix.length)
    return /^\s*$/.test(rest) ? collapsed.length - 1 : collapsed.length
  }
  return collapsed.length
}

/**
 * The attribute of the elements the reader extras add to the text (`readerExtras.ts`: syllable
 * marks, the line-focus masks). They hold no text of the page and the walk, the paths and the
 * ranges look past them, so a page's blocks and positions stand while the marks come and go.
 */
export const READ_ALOUD_MARK_ATTRIBUTE = 'data-zen-mark'

export function isMark(el: Element): boolean {
  return el.hasAttribute(READ_ALOUD_MARK_ATTRIBUTE)
}

/** An element's children without the extras' marks. */
function childrenOf(el: Element): Element[] {
  const out: Element[] = []
  for (const child of Array.from(el.children)) if (!isMark(child)) out.push(child)
  return out
}

/** The `children` indices from `root` down to `el` (`[]` for the root itself); marks do not count. */
export function pathOf(el: Element, root: Element): number[] {
  const path: number[] = []
  let node: Element | null = el
  while (node && node !== root) {
    const parent: Element | null = node.parentElement
    if (!parent) break
    path.unshift(childrenOf(parent).indexOf(node))
    node = parent
  }
  return path
}

/** The element at a `children` path from `root`; null when the document changed under it. */
export function elementAt(root: Element, path: readonly number[]): Element | null {
  let node: Element = root
  for (const index of path) {
    const next = childrenOf(node)[index]
    if (!next) return null
    node = next
  }
  return node
}

// ---------------------------------------------------------------------------
// The highlight
// ---------------------------------------------------------------------------

interface HighlightRegistry {
  set(name: string, highlight: unknown): unknown
  delete(name: string): boolean
  get(name: string): unknown
}

interface HighlightApi {
  Highlight: new (...ranges: Range[]) => { add(range: Range): void; clear(): void }
  registry: HighlightRegistry
}

function highlightApi(doc: Document): HighlightApi | null {
  const view = doc.defaultView as
    | (Window & { Highlight?: HighlightApi['Highlight']; CSS?: { highlights?: HighlightRegistry } })
    | null
  const Highlight = view?.Highlight
  const registry = view?.CSS?.highlights
  if (typeof Highlight !== 'function' || !registry) return null
  return { Highlight, registry }
}

/**
 * The blocks of the reader document's article, walked once and kept until the article's DOM
 * changes (the extras' syllable marks split its text nodes; a mutation drops the cache).
 */
let readerBlocksCache: { article: Element; blocks: DomBlock[] } | null = null
let readerObserved: { article: Element; observer: MutationObserver } | null = null

export function readerBlocks(article: Element, lang: string): DomBlock[] {
  if (readerBlocksCache && readerBlocksCache.article === article) return readerBlocksCache.blocks
  const blocks = walkBlocks(article, lang)
  readerBlocksCache = { article, blocks }
  if (readerObserved?.article !== article) {
    readerObserved?.observer.disconnect()
    readerObserved = null
    const view = article.ownerDocument.defaultView
    if (view && typeof view.MutationObserver === 'function') {
      const observer = new view.MutationObserver(() => {
        readerBlocksCache = null
      })
      observer.observe(article, { childList: true, characterData: true, subtree: true })
      readerObserved = { article, observer }
    }
  }
  return blocks
}

/** Painted last, so a repeat of the same message does not rebuild and re-scroll. */
let lastPainted = ''

/** Who follows the sentence being read (the reader extras' line focus): its range, null when the highlight clears. */
const sentenceListeners: Array<(range: Range | null) => void> = []

export function onReadAloudSentence(listener: (range: Range | null) => void): void {
  sentenceListeners.push(listener)
}

function announceSentence(range: Range | null): void {
  for (const listener of sentenceListeners) listener(range)
}

/** `readAloud.highlight`: paint (or clear) the sentence and the word. */
export function paintHighlight(doc: Document, message: ReadAloudHighlightMessage): void {
  const api = highlightApi(doc)
  if (message.mode === 'off') {
    api?.registry.delete(READ_ALOUD_SENTENCE_HIGHLIGHT)
    api?.registry.delete(READ_ALOUD_WORD_HIGHLIGHT)
    lastPainted = ''
    announceSentence(null)
    return
  }
  const block = locateBlock(doc, message)
  if (!block) return
  const sentence = rangeFor(doc, block, message.sentence.start, message.sentence.end)
  const key = `${message.blockId}:${message.sentence.start}:${message.sentence.end}`
  if (key !== lastPainted) announceSentence(sentence)
  if (!api) {
    if (sentence && key !== lastPainted) {
      lastPainted = key
      scrollIntoView(doc, sentence)
    }
    return
  }
  if (sentence && (message.mode === 'sentence' || message.mode === 'both')) {
    api.registry.set(READ_ALOUD_SENTENCE_HIGHLIGHT, new api.Highlight(sentence))
  } else {
    api.registry.delete(READ_ALOUD_SENTENCE_HIGHLIGHT)
  }
  const word = message.word
  if (word && (message.mode === 'word' || message.mode === 'both')) {
    const range = rangeFor(
      doc,
      block,
      message.sentence.start + word.start,
      message.sentence.start + word.end
    )
    if (range) api.registry.set(READ_ALOUD_WORD_HIGHLIGHT, new api.Highlight(range))
    else api.registry.delete(READ_ALOUD_WORD_HIGHLIGHT)
  } else {
    api.registry.delete(READ_ALOUD_WORD_HIGHLIGHT)
  }
  if (sentence && key !== lastPainted) {
    lastPainted = key
    scrollIntoView(doc, sentence)
  }
}

/** The block a highlight names: by its position in a page, by its index in the reader article. */
function locateBlock(doc: Document, message: ReadAloudHighlightMessage): DomBlock | null {
  const lang = documentLanguage(doc)
  const article = readerArticle(doc)
  if (article && !message.at) {
    const index = Number(/^b(\d+)$/.exec(message.blockId)?.[1])
    if (!Number.isInteger(index)) return null
    return readerBlocks(article, lang)[index] ?? null
  }
  if (!message.at) return null
  const root = article ?? doc.body ?? doc.documentElement
  const element = elementAt(root, message.at.path)
  if (!element) return null
  const blocks = article ? readerBlocks(article, lang) : walkBlocks(root, lang)
  const runs = blocks.filter((block) => block.ref === element)
  const block = runs[message.at.run] ?? runs.find((b) => b.run === message.at?.run) ?? null
  if (!block) return null
  const offset = message.at.offset
  return offset > 0 ? { ...block, text: block.text.slice(offset), offset } : block
}

/**
 * A Range over the block's text from `start` to `end` (offsets in its collapsed text): the
 * collapsed offsets are mapped back onto the raw text of the block's pieces.
 */
export function rangeFor(doc: Document, block: DomBlock, start: number, end: number): Range | null {
  const pieces = block.pieces ?? []
  if (pieces.length === 0 || end <= start) return null
  const base = block.offset ?? 0
  const from = rawPosition(pieces, start + base, false)
  const to = rawPosition(pieces, end + base, true)
  if (!from || !to) return null
  try {
    const range = doc.createRange()
    range.setStart(from.node, from.offset)
    range.setEnd(to.node, to.offset)
    return range.collapsed ? null : range
  } catch {
    return null
  }
}

/**
 * The text node and offset where the collapsed offset `target` falls: the raw text is walked
 * with the collapse's rules (leading whitespace dropped, a run of whitespace one character).
 * `atEnd` places a boundary that lands on a whitespace run after the run's first character
 * rather than before it, so a word's range does not swallow the space that follows.
 */
function rawPosition(
  pieces: BlockPiece<Text>[],
  target: number,
  atEnd: boolean
): { node: Text; offset: number } | null {
  let collapsed = 0
  let started = false
  let inSpace = false
  let last: { node: Text; offset: number } | null = null
  for (const piece of pieces) {
    const text = piece.text
    for (let i = 0; i < text.length; i++) {
      const ws = /\s/.test(text[i])
      if (ws) {
        if (!started) continue
        if (!inSpace) {
          if (!atEnd && collapsed === target) return { node: piece.node, offset: i }
          if (atEnd && collapsed === target) return last ?? { node: piece.node, offset: i }
          inSpace = true
          collapsed++
        }
        continue
      }
      if (collapsed === target) return { node: piece.node, offset: i }
      started = true
      inSpace = false
      collapsed++
      last = { node: piece.node, offset: i + 1 }
      if (atEnd && collapsed === target) return last
    }
  }
  if (collapsed === target && last) return last
  return null
}

/** Where an off-screen sentence lands when the view scrolls to it: this far down the view. */
const FOLLOW_ANCHOR = 0.3

/**
 * Chrome's follow: the sentence scrolls into view when it is off screen, by its own rect (a
 * long paragraph's element would centre the paragraph, not the sentence in it), landing in the
 * upper part of the view with the text after it below; in the reader's column that holds at
 * every width setting. A document that does not scroll itself (a page with its text in a
 * scrolling pane) scrolls the sentence's element instead.
 */
function scrollIntoView(doc: Document, range: Range): void {
  const view = doc.defaultView
  if (!view) return
  let rect: DOMRect
  try {
    rect = range.getBoundingClientRect()
  } catch {
    return
  }
  if (rect.width === 0 && rect.height === 0) return
  const height = view.innerHeight || doc.documentElement.clientHeight
  if (rect.top >= 0 && rect.bottom <= height) return
  const scroller = doc.scrollingElement ?? doc.documentElement
  const windowScrolls = scroller.scrollHeight > scroller.clientHeight + 1
  const container = range.startContainer.parentElement
  if (!windowScrolls && container && typeof container.scrollIntoView === 'function') {
    try {
      container.scrollIntoView({ block: 'center', behavior: 'smooth' })
      return
    } catch {
      /* fall through */
    }
  }
  view.scrollBy({ top: rect.top - height * FOLLOW_ANCHOR, behavior: 'smooth' })
}
