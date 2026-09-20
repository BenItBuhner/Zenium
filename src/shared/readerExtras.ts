import {
  LINE_FOCUS_MASK_CLASS,
  READER_LINE_FOCUS,
  READER_LINE_FOCUS_ATTRIBUTE,
  READER_SYLLABLES_ATTRIBUTE,
  SYLLABLE_MARK_CLASS,
  type ReaderLineFocus
} from './reader'
import {
  READ_ALOUD_MARK_ATTRIBUTE,
  documentLanguage,
  isMark,
  onReadAloudSentence,
  readerArticle
} from './readAloudScript'
import { baseLanguage } from './readAloud'

/**
 * The reader document's immersive-reader extras (EDGE-13; Edge's Immersive Reader "Reading
 * preferences" and "Grammar tools"), the DOM half: line focus – a dimmed mask over everything but
 * a band of one, three or five lines, following the read-aloud sentence while it plays and the
 * click or the arrow keys otherwise – and syllables, hyphenation points marked inside words by an
 * English heuristic (`syllableBoundaries`). Text spacing is the reader stylesheet's alone
 * (`data-spacing` on the root). The reader page's own script renders the saved settings as
 * `data-line-focus` / `data-syllables` / `data-spacing` on its root (`core/readerPage.ts`); this
 * module, installed by the page script in `zen://reader` documents on both platforms, watches
 * those attributes and does the DOM work. Nothing here runs in a web page.
 *
 * The marks it adds carry `data-zen-mark` (`READ_ALOUD_MARK_ATTRIBUTE`): the read-aloud walk,
 * paths and ranges look past them, so a running session's blocks and positions stand while the
 * marks come and go. Syllable marks are empty spans (the dot is generated content), so the text
 * the engine speaks, a selection copies or a search matches is the article's own.
 */

/** Where the focus band's current line sits when nothing placed it: this far down the view. */
export const LINE_FOCUS_REST = 0.4
/** The band's current line stays between these (of the view's height) as the keys step it; past them the page scrolls. */
const LINE_FOCUS_LOW = 0.2
const LINE_FOCUS_HIGH = 0.68

// ---------------------------------------------------------------------------
// Syllables: the English heuristic
// ---------------------------------------------------------------------------

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u'])
/** Two letters that spell one consonant sound: never split; a syllable starts with them. */
const DIGRAPHS = new Set(['ch', 'sh', 'th', 'ph', 'wh'])
/** Consonant blends a syllable starts with: never split, the boundary goes before them. */
const BLENDS = new Set([
  'bl',
  'br',
  'cl',
  'cr',
  'dr',
  'fl',
  'fr',
  'gl',
  'gr',
  'pl',
  'pr',
  'sc',
  'sk',
  'sl',
  'sm',
  'sn',
  'sp',
  'st',
  'sw',
  'tr',
  'tw',
  'scr',
  'spl',
  'spr',
  'str',
  'squ',
  'thr',
  'shr',
  'chr',
  'phr',
  'sch'
])
/** Words shorter than this are one syllable to the marker. */
const MIN_WORD_LENGTH = 4

/**
 * Where a syllable boundary falls in the consonant cluster between two vowel cores
 * (`[start, end)` in the word): one consonant goes with the next core (`ba-sic`; `x` stays,
 * `ex-it`); two split in the middle (`bet-ter`) unless they are a digraph, which starts the next
 * syllable (`fa-ther`), or `ck`, which ends the first (`pock-et`); three or more keep a leading
 * `ck` or digraph with the first (`quick-ly`, `ath-lete`) and a trailing blend or digraph with
 * the next (`mon-ster`, `in-stru-ment`, `wat-cher`), else split before the last (`hand-some`).
 */
function clusterBoundary(cluster: string, start: number, end: number): number {
  if (cluster.length === 1) return cluster === 'x' ? end : start
  if (cluster.length === 2) {
    if (DIGRAPHS.has(cluster)) return start
    if (cluster === 'ck') return end
    return start + 1
  }
  if (cluster.startsWith('ck') || DIGRAPHS.has(cluster.slice(0, 2))) return start + 2
  if (BLENDS.has(cluster.slice(-3))) return end - 3
  if (BLENDS.has(cluster.slice(-2)) || DIGRAPHS.has(cluster.slice(-2))) return end - 2
  return end - 1
}

/** Whether the letter at `i` sounds as a vowel: a, e, i, o, u; `y` after a consonant; not the `u` of `qu`. */
function isVowelAt(word: string, i: number): boolean {
  const c = word[i]
  if (c === 'u' && i > 0 && word[i - 1] === 'q') return false
  if (VOWELS.has(c)) return true
  if (c === 'y') return i > 0 && !VOWELS.has(word[i - 1])
  return false
}

/**
 * The syllable boundaries of an English word (offsets into `word` where one syllable ends and
 * the next begins), by the classroom rules: the vowel groups are the syllables' cores (a final
 * silent `e` is none – `make` – unless it is consonant + `le`, `ta-ble`; `-es` counts after a
 * sibilant, `box-es`, and `-ed` after `t` / `d`, `want-ed`); between two cores one consonant goes
 * with the next (`ba-sic`, `x` with the first: `ex-it`), a digraph stays whole and goes with the
 * next (`fa-ther`), two or more split after the first (`bet-ter`, `mon-ster`), and consonant +
 * `le` takes the consonant (`lit-tle`); a final `-ing` after a consonant keeps the stem whole
 * (`read-ing`, `walk-ing`; a doubled consonant splits, `run-ning`). Adjacent vowels are one core
 * (`cre-ate`, `li-on` and `go-ing` are missed) and a silent `e` inside a word is a core
 * (`hope-ful` comes out `ho-pe-ful`). Words with anything but ASCII letters, or shorter than
 * four letters, get none.
 */
export function syllableBoundaries(word: string): number[] {
  if (word.length < MIN_WORD_LENGTH || !/^[A-Za-z]+$/.test(word)) return []
  const w = word.toLowerCase()
  const groups: Array<[number, number]> = []
  for (let i = 0; i < w.length; i++) {
    if (!isVowelAt(w, i)) continue
    const last = groups[groups.length - 1]
    if (last && last[1] === i) last[1] = i + 1
    else groups.push([i, i + 1])
  }
  if (groups.length < 2) return []
  const last = groups[groups.length - 1]
  const n = w.length
  /** The last core is a consonant + `le` ending (`ta-ble`): the boundary goes before that consonant. */
  let finalLe = false
  /** The last core is a sounded `-es` / `-ed` ending (`box-es`, `want-ed`): the boundary goes before its `e`. */
  let finalEnding = false
  /** The last core is `-ing` after a consonant (`read-ing`, `walk-ing`): the consonants stay with the stem, a doubled one splits (`run-ning`). */
  let finalIng = false
  if (w.endsWith('ing') && n >= 5 && last[0] === n - 3 && !isVowelAt(w, n - 4)) {
    finalIng = true
  } else if (last[1] === n && last[1] - last[0] === 1 && w[n - 1] === 'e' && !isVowelAt(w, n - 2)) {
    // A single final `e` after a consonant: silent, unless the word ends consonant + `le`.
    if (w[n - 2] === 'l' && !isVowelAt(w, n - 3)) finalLe = true
    else groups.pop()
  } else if (last[1] === n - 1 && last[1] - last[0] === 1 && w[n - 2] === 'e') {
    const before = w[n - 3]
    if (w[n - 1] === 's') {
      // `-es`: a syllable after a sibilant (`box-es`, `fac-es`), silent otherwise (`makes`).
      const sibilant =
        'sxzcg'.includes(before) || w.slice(n - 4, n - 2) === 'ch' || w.slice(n - 4, n - 2) === 'sh'
      if (sibilant) finalEnding = true
      else groups.pop()
    } else if (w[n - 1] === 'd') {
      // `-ed`: a syllable after `t` / `d` (`want-ed`); `-red` after another consonant is a
      // syllable the cluster rule places (`hun-dred`, `sa-cred`); silent otherwise (`walked`,
      // `cared`, `stirred`).
      if (before === 't' || before === 'd') finalEnding = true
      else if (!(before === 'r' && n >= 5 && !isVowelAt(w, n - 4) && w[n - 4] !== 'r')) groups.pop()
    }
  }
  if (groups.length < 2) return []
  const boundaries: number[] = []
  for (let g = 1; g < groups.length; g++) {
    const clusterStart = groups[g - 1][1]
    const clusterEnd = groups[g][0]
    const cluster = w.slice(clusterStart, clusterEnd)
    if (cluster.length === 0) continue
    const lastCore = g === groups.length - 1
    let boundary: number
    if (lastCore && finalLe && cluster.length >= 2) boundary = clusterEnd - 2
    else if (lastCore && finalEnding) boundary = clusterEnd
    else if (lastCore && finalIng) {
      boundary = cluster.length === 2 && cluster[0] === cluster[1] ? clusterStart + 1 : clusterEnd
    } else boundary = clusterBoundary(cluster, clusterStart, clusterEnd)
    if (boundary > 0 && boundary < n) boundaries.push(boundary)
  }
  return boundaries
}

interface WordSegmenter {
  segment(text: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }>
}

let wordSegmenter: WordSegmenter | null | undefined

/** `Intl.Segmenter` at word granularity, or null without one (a regex over letters stands in). */
function segmenter(): WordSegmenter | null {
  if (wordSegmenter !== undefined) return wordSegmenter
  wordSegmenter = null
  const Segmenter = (globalThis as { Intl?: { Segmenter?: unknown } }).Intl?.Segmenter as
    | (new (locale: string | undefined, options: { granularity: 'word' }) => WordSegmenter)
    | undefined
  if (typeof Segmenter === 'function') {
    try {
      wordSegmenter = new Segmenter('en', { granularity: 'word' })
    } catch {
      wordSegmenter = null
    }
  }
  return wordSegmenter
}

/** The words of `text` as [start, end) spans. */
function wordSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const seg = segmenter()
  if (seg) {
    for (const { segment, index, isWordLike } of seg.segment(text)) {
      if (isWordLike) spans.push([index, index + segment.length])
    }
    return spans
  }
  const re = /[A-Za-z]+/g
  for (let m = re.exec(text); m; m = re.exec(text)) spans.push([m.index, m.index + m[0].length])
  return spans
}

/** The syllable boundaries of every word in `text`, as offsets into `text`. */
export function textSyllableBoundaries(text: string): number[] {
  const out: number[] = []
  for (const [start, end] of wordSpans(text)) {
    for (const b of syllableBoundaries(text.slice(start, end))) out.push(start + b)
  }
  return out
}

/** Elements whose text keeps its letters as written: code and its kin, and what read aloud skips. */
const UNMARKED_TAGS: ReadonlySet<string> = new Set([
  'pre',
  'code',
  'kbd',
  'samp',
  'var',
  'tt',
  'script',
  'style',
  'textarea',
  'math',
  'svg',
  'input',
  'select',
  'button',
  'noscript',
  'template'
])

/** Whether syllables are marked in this language: the heuristic is English's (unknown passes). */
export function marksLanguage(lang: string): boolean {
  const base = baseLanguage(lang)
  return base === '' || base === 'en'
}

/** Whether a text node's words take marks: not code, not another language, not inside a mark. */
function markable(node: Text, docLang: string): boolean {
  let el: Element | null = node.parentElement
  let lang: string | null = null
  while (el) {
    if (isMark(el)) return false
    if (UNMARKED_TAGS.has(el.tagName.toLowerCase())) return false
    if (lang === null) lang = el.getAttribute('lang')
    el = el.parentElement
  }
  return marksLanguage(lang || docLang)
}

/**
 * Mark the syllable boundaries in `article`'s words: each text node with any is split at them
 * with an empty mark span (`SYLLABLE_MARK_CLASS`, `data-zen-mark="syllable"`) between the
 * parts, so the text stays the same and only the dots show. Idempotent; the count of marks added.
 */
export function markSyllables(article: Element, docLang: string): number {
  const doc = article.ownerDocument
  const nodes: Text[] = []
  const walker = doc.createTreeWalker(article, 4 /* NodeFilter.SHOW_TEXT */)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  let count = 0
  for (const node of nodes) {
    if (!node.parentNode || !markable(node, docLang)) continue
    const text = node.data
    const boundaries = textSyllableBoundaries(text)
    if (boundaries.length === 0) continue
    const fragment = doc.createDocumentFragment()
    let at = 0
    for (const boundary of boundaries) {
      fragment.appendChild(doc.createTextNode(text.slice(at, boundary)))
      const mark = doc.createElement('span')
      mark.className = SYLLABLE_MARK_CLASS
      mark.setAttribute(READ_ALOUD_MARK_ATTRIBUTE, 'syllable')
      mark.setAttribute('aria-hidden', 'true')
      fragment.appendChild(mark)
      at = boundary
      count++
    }
    fragment.appendChild(doc.createTextNode(text.slice(at)))
    node.parentNode.replaceChild(fragment, node)
  }
  return count
}

/** Take every syllable mark out of `article` and join the text back into whole nodes. */
export function unmarkSyllables(article: Element): void {
  const marks = article.querySelectorAll(`[${READ_ALOUD_MARK_ATTRIBUTE}="syllable"]`)
  if (marks.length === 0) return
  for (const mark of Array.from(marks)) mark.remove()
  article.normalize()
}

// ---------------------------------------------------------------------------
// Line focus
// ---------------------------------------------------------------------------

/** Where the band stands: the view-relative top of its current line and that line's height. */
interface Placement {
  lineTop: number
  lineHeight: number
}

/**
 * The dimmed mask over everything but a band of `lines` lines. The band is fixed in the view;
 * the text scrolls under it. Its current line is the read-aloud sentence's first line while one
 * is being read (`follow`), the line clicked (`caretRangeFromPoint`), or where the arrow keys
 * stepped it; at rest it sits `LINE_FOCUS_REST` down the view. With three or five lines the
 * current line is the band's middle one.
 */
export class LineFocus {
  private lines: ReaderLineFocus = 0
  private masks: { top: HTMLElement; bottom: HTMLElement } | null = null
  private followRange: Range | null = null
  private anchor: Placement | null = null
  private frame: number | null = null
  private readonly onScroll = (): void => this.schedule()
  private readonly onClick = (e: MouseEvent): void => this.clicked(e)
  private readonly onKey = (e: KeyboardEvent): void => this.keyed(e)

  constructor(
    private readonly doc: Document,
    private readonly article: Element
  ) {}

  /** The band's line count, 0 for off (the masks go). */
  setLines(lines: ReaderLineFocus): void {
    if (lines === this.lines) return
    this.lines = lines
    if (lines === 0) {
      this.detach()
      return
    }
    this.attach()
    this.place()
  }

  get active(): boolean {
    return this.lines > 0
  }

  /** The sentence being read (its range), or null when reading stopped: the band follows it. */
  follow(range: Range | null): void {
    this.followRange = range
    if (range) this.anchor = null
    if (this.active) this.place()
  }

  /**
   * The document's typography changed under the band (text spacing, size, font or column
   * width from the preferences): the line height it was measured with is stale, so a band
   * anchored by a click takes the article's line height again and every band is placed again.
   * Without it a five-line band set at normal spacing stayed four lines tall at wider spacing
   * until the next scroll (the Android record).
   */
  relayout(): void {
    if (!this.active) return
    if (this.anchor) this.anchor = { lineTop: this.anchor.lineTop, lineHeight: this.defaultLineHeight() }
    this.place()
  }

  /** The band's edges in view coordinates (for tests and the proof); null when off. */
  band(): { top: number; bottom: number } | null {
    if (!this.masks) return null
    const top = parseFloat(this.masks.top.style.height) || 0
    const bottom = parseFloat(this.masks.bottom.style.top) || 0
    return { top, bottom }
  }

  private attach(): void {
    if (this.masks) return
    const make = (edge: 'top' | 'bottom'): HTMLElement => {
      const el = this.doc.createElement('div')
      el.className = LINE_FOCUS_MASK_CLASS
      el.setAttribute(READ_ALOUD_MARK_ATTRIBUTE, 'focus')
      el.setAttribute('data-edge', edge)
      el.setAttribute('aria-hidden', 'true')
      el.style.position = 'fixed'
      el.style.left = '0'
      el.style.right = '0'
      el.style.pointerEvents = 'none'
      if (edge === 'top') el.style.top = '0'
      else el.style.bottom = '0'
      return el
    }
    this.masks = { top: make('top'), bottom: make('bottom') }
    const body = this.doc.body ?? this.doc.documentElement
    body.appendChild(this.masks.top)
    body.appendChild(this.masks.bottom)
    const view = this.doc.defaultView
    view?.addEventListener('scroll', this.onScroll, { passive: true })
    view?.addEventListener('resize', this.onScroll)
    this.doc.addEventListener('click', this.onClick)
    this.doc.addEventListener('keydown', this.onKey)
  }

  private detach(): void {
    if (!this.masks) return
    this.masks.top.remove()
    this.masks.bottom.remove()
    this.masks = null
    const view = this.doc.defaultView
    view?.removeEventListener('scroll', this.onScroll)
    view?.removeEventListener('resize', this.onScroll)
    this.doc.removeEventListener('click', this.onClick)
    this.doc.removeEventListener('keydown', this.onKey)
    if (this.frame !== null && view) view.cancelAnimationFrame(this.frame)
    this.frame = null
  }

  private schedule(): void {
    const view = this.doc.defaultView
    if (!view || this.frame !== null) return
    this.frame = view.requestAnimationFrame(() => {
      this.frame = null
      this.place()
    })
  }

  private viewHeight(): number {
    const view = this.doc.defaultView
    return view?.innerHeight || this.doc.documentElement.clientHeight || 0
  }

  /** The article's own line height (the body text's), for a band nothing has placed on a line. */
  private defaultLineHeight(): number {
    const view = this.doc.defaultView
    if (!view) return 30
    try {
      const style = view.getComputedStyle(this.article)
      const lineHeight = parseFloat(style.lineHeight)
      if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight
      const fontSize = parseFloat(style.fontSize)
      if (Number.isFinite(fontSize) && fontSize > 0) return fontSize * 1.65
    } catch {
      /* no layout here */
    }
    return 30
  }

  /**
   * The first line of a range: its top and height in the view, or null when it has no box. A
   * range's first client rect is its text fragment's box (the font's content area), shorter than
   * the line it sits in; the line is the text's computed line height, the fragment centred in it.
   */
  private lineOf(range: Range): Placement | null {
    try {
      const rects = range.getClientRects()
      const rect = rects.length > 0 ? rects[0] : range.getBoundingClientRect()
      if (!rect || rect.height <= 0) return null
      const lineHeight = Math.max(rect.height, this.lineHeightAt(range.startContainer))
      return { lineTop: rect.top - (lineHeight - rect.height) / 2, lineHeight }
    } catch {
      return null
    }
  }

  /** The computed line height of the text at `node` (its nearest element's), or 0 when unknown. */
  private lineHeightAt(node: Node): number {
    const view = this.doc.defaultView
    if (!view) return 0
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement
    if (!el) return 0
    try {
      const lineHeight = parseFloat(view.getComputedStyle(el).lineHeight)
      return Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 0
    } catch {
      return 0
    }
  }

  private placement(): Placement {
    if (this.followRange) {
      const line = this.lineOf(this.followRange)
      if (line) return line
    }
    if (this.anchor) return this.anchor
    const lineHeight = this.defaultLineHeight()
    return { lineTop: Math.round(this.viewHeight() * LINE_FOCUS_REST), lineHeight }
  }

  private place(): void {
    if (!this.masks || this.lines === 0) return
    const { lineTop, lineHeight } = this.placement()
    const above = Math.floor((this.lines - 1) / 2)
    const bandTop = Math.max(0, Math.round(lineTop - above * lineHeight))
    const bandBottom = Math.max(
      bandTop,
      Math.round(lineTop - above * lineHeight + this.lines * lineHeight)
    )
    this.masks.top.style.height = `${bandTop}px`
    this.masks.bottom.style.top = `${bandBottom}px`
  }

  /** A click on the text puts the current line where it landed. */
  private clicked(e: MouseEvent): void {
    if (e.defaultPrevented || e.button !== 0) return
    const target = e.target as Element | null
    if (!target || !this.article.contains(target)) return
    const doc = this.doc as Document & {
      caretRangeFromPoint?(x: number, y: number): Range | null
      caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null
    }
    let range: Range | null = null
    try {
      if (typeof doc.caretRangeFromPoint === 'function') {
        range = doc.caretRangeFromPoint(e.clientX, e.clientY)
      } else if (typeof doc.caretPositionFromPoint === 'function') {
        const position = doc.caretPositionFromPoint(e.clientX, e.clientY)
        if (position) {
          range = doc.createRange()
          range.setStart(position.offsetNode, position.offset)
          range.setEnd(position.offsetNode, position.offset)
        }
      }
    } catch {
      range = null
    }
    const line = range ? this.lineOf(range) : null
    this.anchor = line ?? { lineTop: e.clientY, lineHeight: this.defaultLineHeight() }
    this.followRange = null
    this.place()
  }

  /**
   * The arrow keys step the current line: the band moves a line within the middle of the view
   * and the page scrolls a line once it would leave it, so a reader steps through the text.
   */
  private keyed(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const active = this.doc.activeElement as HTMLElement | null
    if (active && (active.isContentEditable || /^(input|textarea|select)$/i.test(active.tagName)))
      return
    e.preventDefault()
    const direction = e.key === 'ArrowDown' ? 1 : -1
    const current = this.placement()
    this.followRange = null
    const height = this.viewHeight()
    const next = current.lineTop + direction * current.lineHeight
    const view = this.doc.defaultView
    if (
      view &&
      ((direction > 0 && next > height * LINE_FOCUS_HIGH) ||
        (direction < 0 && next < height * LINE_FOCUS_LOW))
    ) {
      view.scrollBy({ top: direction * current.lineHeight, behavior: 'auto' })
      this.anchor = current
    } else {
      this.anchor = { lineTop: next, lineHeight: current.lineHeight }
    }
    this.place()
  }
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/** The root attributes that are the extras' own (a change to any other is a typography change). */
const EXTRAS_ATTRIBUTES: ReadonlySet<string> = new Set([
  READER_LINE_FOCUS_ATTRIBUTE,
  READER_SYLLABLES_ATTRIBUTE
])

/** The extras' state as the reader root's attributes say it. */
export function extrasOf(root: Element): { lineFocus: ReaderLineFocus; syllables: boolean } {
  const raw = Number(root.getAttribute(READER_LINE_FOCUS_ATTRIBUTE))
  const lineFocus = READER_LINE_FOCUS.includes(raw as ReaderLineFocus)
    ? (raw as ReaderLineFocus)
    : 0
  return { lineFocus, syllables: root.getAttribute(READER_SYLLABLES_ATTRIBUTE) === 'true' }
}

export interface ReaderExtras {
  lineFocus: LineFocus
  /** Apply the root's attributes now (the observer does it on change). */
  apply(): void
  /** Whether syllables are marked. */
  readonly syllablesOn: boolean
}

/**
 * Install the extras in a reader document: the root's attributes applied now and on every
 * change, the line-focus band following read aloud's sentence. Null in any other document.
 */
export function installReaderExtras(doc: Document): ReaderExtras | null {
  const article = readerArticle(doc)
  if (!article) return null
  const root = doc.documentElement
  const lang = documentLanguage(doc)
  const lineFocus = new LineFocus(doc, article)
  let syllablesOn = false
  const apply = (): void => {
    const wanted = extrasOf(root)
    lineFocus.setLines(wanted.lineFocus)
    if (wanted.syllables !== syllablesOn) {
      syllablesOn = wanted.syllables
      if (syllablesOn) markSyllables(article, lang)
      else unmarkSyllables(article)
    }
  }
  const view = doc.defaultView
  if (view && typeof view.MutationObserver === 'function') {
    // Every attribute of the root, not just the extras' two: the reader script renders each
    // preference there (the theme, font, size, width and spacing), and the ones that change the
    // text's line height move the band's lines under it.
    new view.MutationObserver((records) => {
      apply()
      if (records.some((r) => !EXTRAS_ATTRIBUTES.has(r.attributeName ?? ''))) lineFocus.relayout()
    }).observe(root, { attributes: true })
  }
  onReadAloudSentence((range) => lineFocus.follow(range))
  apply()
  return {
    lineFocus,
    apply,
    get syllablesOn() {
      return syllablesOn
    }
  }
}

/** The page script's entry: install once the document has its article (it may be installed at document start). */
export function installReaderExtrasWhenReady(doc: Document): void {
  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', () => installReaderExtras(doc), { once: true })
  } else {
    installReaderExtras(doc)
  }
}
