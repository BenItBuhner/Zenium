import { decodeHtmlEntities } from '../../shared/readAloud'

/**
 * The reader article's HTML (`ReaderArticle.content`: sanitised, as Readability serialised it)
 * split into the units the engine translates (CT-36) – the units the page runtime
 * (`shared/translateScript.ts`) makes of a web page, by the same rules: the inline content of
 * every block (a paragraph, a heading, a list item, a cell) and every run of inline siblings
 * between block children, serialised the same way (inline elements as `<span data-zt="n">`,
 * opaque ones – code, images, no-translate spans – as `<img data-zt="n">`, `<br>`s as
 * `<br data-zt="n">`) so Bergamot's HTML mode sees the shape it is tuned for, and rebuilt from
 * its answer with the article's own tags, nothing of the answer's markup taken over. No DOM
 * anywhere: the core runs where there is none (Electron's main process), so the article is
 * scanned as text, tolerant of the omissions Readability's output has (`<p>` and `<li>` without
 * end tags, stray end tags).
 */

/** One translatable run of the article. */
export interface ArticleUnit {
  /** The unit's index in `ArticleSplit.units`, its `data-zu` in the rendered document. */
  id: number
  /** The run as the article has it (what the document shows untranslated). */
  html: string
  /** The run as the engine takes it: text, and inline elements as `data-zt` markers. */
  source: string
  /** The run's text, whitespace collapsed (the language sample). */
  text: string
  /** The inline elements of the run, by `data-zt` index. */
  inlines: ArticleInline[]
}

export interface ArticleInline {
  /** The start tag as written (`<a href="…">`), or the whole element when opaque. */
  open: string
  /** The end tag as written (`</a>`); '' for an opaque element and for one the source left unclosed. */
  close: string
  /** The `data-zt` index of the inline element this one sits in, -1 at the run's top. */
  parent: number
  /** Kept verbatim: the engine sees a token, the rebuild puts the element back whole. */
  opaque: boolean
  /** Whitespace stood right before / right after the element in the source. */
  spaced: [boolean, boolean]
}

export interface ArticleSplit {
  /** The article in pieces: literal HTML between the units, and a unit's id where its run stood. */
  parts: (string | number)[]
  units: ArticleUnit[]
}

/** The tags whose element is a block (a unit boundary); everything else is inline. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'button',
  'caption',
  'center',
  'col',
  'colgroup',
  'dd',
  'details',
  'dialog',
  'dir',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'legend',
  'li',
  'main',
  'menu',
  'nav',
  'ol',
  'optgroup',
  'option',
  'p',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul'
])

/** Blocks whose subtree never holds prose to translate: kept as written, a unit boundary. */
const SKIP_BLOCK_TAGS: ReadonlySet<string> = new Set([
  'meta',
  'noscript',
  'pre',
  'script',
  'style',
  'template',
  'title'
])

/** Inline elements kept whole (the engine sees a token): code, images, media, and no-translate spans. */
const OPAQUE_TAGS: ReadonlySet<string> = new Set([
  'audio',
  'br',
  'canvas',
  'code',
  'embed',
  'iframe',
  'img',
  'input',
  'kbd',
  'math',
  'object',
  'picture',
  'samp',
  'select',
  'svg',
  'textarea',
  'var',
  'video',
  'wbr'
])

const VOID_TAGS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
])

const LETTER = /\p{L}/u
const START_TAG = /^<([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/
const END_TAG = /^<\/([a-zA-Z][\w:-]*)\s*>/

/** `translate="no"` or Google's `notranslate` class on a start tag's attributes. */
function noTranslate(attributes: string): boolean {
  return (
    /\stranslate\s*=\s*(?:"\s*no\s*"|'\s*no\s*'|no\b)/i.test(attributes) ||
    /\sclass\s*=\s*(?:"[^"]*\bnotranslate\b[^"]*"|'[^']*\bnotranslate\b[^']*')/i.test(attributes)
  )
}

/**
 * Where the element opened at `start` (its start tag already read, `from` right after it) ends:
 * the index after its end tag, or the text's end. Nested elements of the same name are counted;
 * void and self-closed tags are not.
 */
function elementEnd(html: string, from: number, tag: string): number {
  const lower = html.toLowerCase()
  let depth = 1
  let i = from
  while (i < html.length) {
    const lt = lower.indexOf('<', i)
    if (lt === -1) return html.length
    if (lower.startsWith(`</${tag}`, lt)) {
      const gt = lower.indexOf('>', lt)
      const end = gt === -1 ? html.length : gt + 1
      if (--depth === 0) return end
      i = end
      continue
    }
    if (lower.startsWith(`<${tag}`, lt) && !/[\w:-]/.test(lower[lt + 1 + tag.length] ?? '')) {
      const gt = lower.indexOf('>', lt)
      const end = gt === -1 ? html.length : gt + 1
      if (!VOID_TAGS.has(tag) && lower[end - 2] !== '/') depth++
      i = end
      continue
    }
    i = lt + 1
  }
  return html.length
}

/** A run of inline content being read: the article's own text of it, the engine's, its inlines. */
class Run {
  html = ''
  source = ''
  text = ''
  /** Text outside opaque elements has a letter: worth translating (`hiddenInlineOnly` in the runtime). */
  letters = false
  readonly inlines: ArticleInline[] = []
  /** The open (non-opaque) inline elements, innermost last, by `data-zt` index. */
  readonly open: { index: number; tag: string }[] = []

  get depth(): number {
    return this.open.length
  }

  private get parent(): number {
    return this.open.length > 0 ? this.open[this.open.length - 1].index : -1
  }

  addText(raw: string): void {
    this.html += raw
    this.source += raw
    const decoded = decodeHtmlEntities(raw)
    this.text += decoded
    if (!this.letters && LETTER.test(decoded)) this.letters = true
  }

  /** A comment or a stray tag: kept where it stood, unseen by the engine. */
  addRaw(raw: string): void {
    this.html += raw
  }

  openInline(tag: string, start: string): void {
    const index = this.inlines.length
    this.inlines.push({
      open: start,
      close: '',
      parent: this.parent,
      opaque: false,
      spaced: [/\s$/.test(this.text), false]
    })
    this.open.push({ index, tag })
    this.html += start
    this.source += `<span data-zt="${index}">`
  }

  closeInline(end: string, after: string): void {
    const top = this.open.pop()
    if (!top) return
    const inline = this.inlines[top.index]
    inline.close = end
    inline.spaced = [inline.spaced[0], /^\s/.test(after)]
    this.html += end
    this.source += '</span>'
  }

  /** Whether an end tag for `tag` closes an inline of this run (implied closes in between). */
  closes(tag: string): boolean {
    return this.open.some((entry) => entry.tag === tag)
  }

  addOpaque(tag: string, whole: string, after: string): void {
    const index = this.inlines.length
    this.inlines.push({
      open: whole,
      close: '',
      parent: this.parent,
      opaque: true,
      spaced: [/\s$/.test(this.text), /^\s/.test(after)]
    })
    this.html += whole
    this.source += tag === 'br' ? `<br data-zt="${index}">` : `<img data-zt="${index}">`
    // The engine's token stands for the element; its text (a code span's) is not the run's prose.
    this.text += ' '
  }

  /** Everything still open when the run ends: the source left it to the block's end tag. */
  closeAll(): void {
    while (this.open.length > 0) {
      this.open.pop()
      this.source += '</span>'
    }
  }
}

/**
 * Split the article into its translatable units and the literal HTML around them. Runs that hold
 * no letters outside opaque elements (whitespace between blocks, an image alone, a code line) stay
 * literal.
 */
export function splitArticleHtml(html: string): ArticleSplit {
  const parts: (string | number)[] = []
  const units: ArticleUnit[] = []
  let literal = ''
  /** The run being read (in a holder: the closures below assign it). */
  const reading: { run: Run | null } = { run: null }
  /** The open block elements (tag names), for the implied end tags. */
  const blocks: string[] = []

  const flushLiteral = (): void => {
    if (literal) parts.push(literal)
    literal = ''
  }
  const endRun = (): void => {
    const run = reading.run
    if (!run) return
    run.closeAll()
    if (run.letters) {
      flushLiteral()
      const id = units.length
      units.push({
        id,
        html: run.html,
        source: run.source,
        text: run.text.replace(/\s+/g, ' ').trim(),
        inlines: run.inlines
      })
      parts.push(id)
    } else {
      literal += run.html
    }
    reading.run = null
  }
  const currentRun = (): Run => (reading.run ??= new Run())

  const n = html.length
  let i = 0
  while (i < n) {
    if (html[i] !== '<') {
      const next = html.indexOf('<', i)
      const end = next === -1 ? n : next
      currentRun().addText(html.slice(i, end))
      i = end
      continue
    }
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4)
      const stop = end === -1 ? n : end + 3
      if (reading.run) reading.run.addRaw(html.slice(i, stop))
      else literal += html.slice(i, stop)
      i = stop
      continue
    }
    if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      const end = html.indexOf('>', i)
      const stop = end === -1 ? n : end + 1
      literal += html.slice(i, stop)
      i = stop
      continue
    }
    if (html.startsWith('</', i)) {
      const m = END_TAG.exec(html.slice(i, i + 64))
      if (!m) {
        currentRun().addText('<')
        i++
        continue
      }
      const tag = m[1].toLowerCase()
      const end = i + m[0].length
      const run = reading.run
      if (run && run.closes(tag)) {
        // Inlines left open inside it close with it (the browser's implied end tags).
        while (run.open.length > 0 && run.open[run.open.length - 1].tag !== tag)
          run.closeInline('', html.slice(end, end + 1))
        run.closeInline(m[0], html.slice(end, end + 1))
      } else if (blocks.includes(tag)) {
        endRun()
        while (blocks.length > 0 && blocks.pop() !== tag) {
          /* the blocks left open inside it close with it */
        }
        literal += m[0]
      } else if (run) {
        run.addRaw(m[0])
      } else {
        literal += m[0]
      }
      i = end
      continue
    }
    const m = START_TAG.exec(html.slice(i))
    if (!m) {
      currentRun().addText('<')
      i++
      continue
    }
    const tag = m[1].toLowerCase()
    const start = m[0]
    const selfClosed = m[3] === '/' || VOID_TAGS.has(tag)
    const afterStart = i + start.length
    const excluded = noTranslate(m[2])
    const block = BLOCK_TAGS.has(tag) || SKIP_BLOCK_TAGS.has(tag)

    // A block inside an inline element of the run (`<a><div>…</div></a>`) is part of the run, as
    // the runtime serialises it; only a block at the run's own level is a boundary.
    if (block && !(reading.run && reading.run.depth > 0)) {
      endRun()
      // A start tag that implies the end of the open `<p>` (or `<li>`, `<dt>`/`<dd>`, cells).
      const top = blocks[blocks.length - 1]
      if (
        top === 'p' &&
        tag !== 'p' &&
        BLOCK_TAGS.has(tag) &&
        !['col', 'colgroup', 'caption', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th'].includes(tag)
      )
        blocks.pop()
      if (top === 'p' && tag === 'p') blocks.pop()
      if ((tag === 'li' && top === 'li') || (tag === 'tr' && top === 'tr')) blocks.pop()
      if ((tag === 'dt' || tag === 'dd') && (top === 'dt' || top === 'dd')) blocks.pop()
      if ((tag === 'td' || tag === 'th') && (top === 'td' || top === 'th')) blocks.pop()
      if (selfClosed) {
        literal += start
        i = afterStart
        continue
      }
      if (SKIP_BLOCK_TAGS.has(tag) || excluded) {
        // The whole element as written: nothing inside it is prose to translate.
        const stop = elementEnd(html, afterStart, tag)
        literal += html.slice(i, stop)
        i = stop
        continue
      }
      literal += start
      blocks.push(tag)
      i = afterStart
      continue
    }

    // Inline: part of the run at hand (or the start of one).
    const current = currentRun()
    if (OPAQUE_TAGS.has(tag) || SKIP_BLOCK_TAGS.has(tag) || excluded) {
      const stop = selfClosed ? afterStart : elementEnd(html, afterStart, tag)
      current.addOpaque(tag, html.slice(i, stop), html.slice(stop, stop + 1))
      i = stop
      continue
    }
    if (selfClosed) {
      // A void element (`<hr>` inside a link) or a self-closed one: a token, nothing to translate in it.
      current.addOpaque(tag, start, html.slice(afterStart, afterStart + 1))
      i = afterStart
      continue
    }
    current.openInline(tag, start)
    i = afterStart
  }
  endRun()
  flushLiteral()
  return { parts, units }
}

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

type Piece = { text: string } | { inline: number; children: Piece[] }

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** A letter or digit in a script that separates words with spaces (`respaceOpaque` in the runtime). */
function wordChar(text: string, last: boolean): boolean {
  const ch = last ? text.slice(-1) : text.slice(0, 1)
  return (
    /[\p{L}\p{N}]/u.test(ch) &&
    !/[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u.test(
      ch
    )
  )
}

/**
 * The engine's answer for a unit turned back into the article's HTML: its text (re-escaped) and,
 * where it kept the markers, the unit's own inline elements with their attributes, opaque ones
 * whole. Markup of the answer's own is dropped, its text kept; an inline element the answer lost
 * goes back where it was (into its parent when that was placed, else at the end), so nothing of
 * the article vanishes; an opaque element the engine pressed against a word gets its space back.
 */
export function rebuildUnitHtml(unit: ArticleUnit, translated: string): string {
  const top: Piece[] = []
  const stack: Piece[][] = [top]
  const placed = new Set<number>()
  const nodes = new Map<number, Piece[]>()
  const n = translated.length
  let i = 0
  const pushText = (raw: string): void => {
    const list = stack[stack.length - 1]
    const last = list[list.length - 1]
    const text = decodeHtmlEntities(raw)
    if (last && 'text' in last) last.text += text
    else list.push({ text })
  }
  while (i < n) {
    if (translated[i] !== '<') {
      const next = translated.indexOf('<', i)
      const end = next === -1 ? n : next
      pushText(translated.slice(i, end))
      i = end
      continue
    }
    if (translated.startsWith('</', i)) {
      const m = END_TAG.exec(translated.slice(i, i + 64))
      if (!m) {
        pushText('<')
        i++
        continue
      }
      // Only our own spans nest; any other end tag is the answer's own markup, dropped.
      if (m[1].toLowerCase() === 'span' && stack.length > 1) stack.pop()
      i += m[0].length
      continue
    }
    const m = START_TAG.exec(translated.slice(i))
    if (!m) {
      pushText('<')
      i++
      continue
    }
    i += m[0].length
    const tag = m[1].toLowerCase()
    const zt = /\sdata-zt\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/.exec(m[2])
    const index = zt ? Number(zt[1] ?? zt[2] ?? zt[3]) : NaN
    const inline = Number.isInteger(index) ? unit.inlines[index] : undefined
    if (!inline || placed.has(index)) {
      // The answer's own element (or a marker used twice): its content stays, it does not.
      if (tag === 'span' && m[3] !== '/') stack.push(stack[stack.length - 1])
      continue
    }
    placed.add(index)
    const list = stack[stack.length - 1]
    if (inline.opaque || tag !== 'span' || m[3] === '/') {
      list.push({ inline: index, children: [] })
      continue
    }
    const children: Piece[] = []
    list.push({ inline: index, children })
    nodes.set(index, children)
    stack.push(children)
  }
  // Nothing may vanish: the inline elements the answer dropped go back where they were.
  for (let index = 0; index < unit.inlines.length; index++) {
    if (placed.has(index)) continue
    const parent = unit.inlines[index].parent
    const into = parent >= 0 ? nodes.get(parent) : top
    const children: Piece[] = []
    ;(into ?? top).push({ inline: index, children })
    nodes.set(index, children)
    placed.add(index)
  }
  return serializePieces(top, unit)
}

function serializePieces(pieces: Piece[], unit: ArticleUnit): string {
  respaceOpaque(pieces, unit)
  let out = ''
  for (const piece of pieces) {
    if ('text' in piece) {
      out += escapeText(piece.text)
      continue
    }
    const inline = unit.inlines[piece.inline]
    if (inline.opaque) out += inline.open
    else out += inline.open + serializePieces(piece.children, unit) + inline.close
  }
  return out
}

/**
 * The engine keeps opaque elements as tokens and tends to drop the whitespace around them: where
 * the source had a space on a side and the answer puts a word directly against the element, the
 * space goes back.
 */
function respaceOpaque(pieces: Piece[], unit: ArticleUnit): void {
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]
    if ('text' in piece) continue
    const inline = unit.inlines[piece.inline]
    if (!inline.opaque || /^<br\b/i.test(inline.open)) continue
    const [before, after] = inline.spaced
    const prev = pieces[i - 1]
    const next = pieces[i + 1]
    if (before && prev && 'text' in prev && wordChar(prev.text, true)) prev.text += ' '
    if (after && next && 'text' in next && wordChar(next.text, false)) next.text = ` ${next.text}`
  }
}

/**
 * The article's HTML for the document: the literal parts as written and every unit wrapped as
 * `<span data-zu="id">` around what it shows now (`shown(id)`: the translation where one stands,
 * else the run as written), so the core can swap a unit's content in the open document.
 */
export function renderArticleHtml(split: ArticleSplit, shown: (id: number) => string): string {
  let out = ''
  for (const part of split.parts) {
    if (typeof part === 'string') out += part
    else out += `<span data-zu="${part}">${shown(part)}</span>`
  }
  return out
}

/** The article's text for the language sample: the units' text in order, up to `maxChars`. */
export function articleSampleText(split: ArticleSplit, maxChars: number): string {
  let out = ''
  for (const unit of split.units) {
    if (out.length >= maxChars) break
    out += (out ? ' ' : '') + unit.text
  }
  return out.slice(0, maxChars)
}
