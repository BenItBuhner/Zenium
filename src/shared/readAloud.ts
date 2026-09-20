/**
 * Read aloud, the pure model (CT-12 / CT-13; Chrome's "Listen to this page" and Reading mode's
 * read aloud): the text as blocks and sentences, the playback state the UIs render, the voices
 * and the setting, the rate ladder, and the messages between the browser and the page script.
 * Nothing here touches a host, a DOM or a speech engine; `core/readAloud.ts` drives the session
 * and `shared/readAloudScript.ts` walks and paints a document.
 */

export type ReadAloudSource = 'page' | 'reader' | 'selection'

export type ReadAloudBlockKind =
  'heading' | 'paragraph' | 'list-item' | 'quote' | 'caption' | 'other'

/** One block of the text: a paragraph, a heading, a list item; `lang` when it differs from the document's. */
export interface ReadAloudBlock {
  id: string
  kind: ReadAloudBlockKind
  text: string
  lang?: string
}

/** One sentence, as the walker cut it: `start` / `end` are offsets in its block's text. */
export interface ReadAloudSentence {
  blockId: string
  /** Position in `ReadAloudText.sentences`. */
  index: number
  start: number
  end: number
  text: string
}

export interface ReadAloudText {
  source: ReadAloudSource
  title: string
  /** The document's language (BCP-47), '' when unknown. */
  lang: string
  blocks: ReadAloudBlock[]
  sentences: ReadAloudSentence[]
}

export type ReadAloudStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'

export type ReadAloudHighlightMode = 'sentence' | 'word' | 'both' | 'off'

/** The one session's playback state (`UIState.readAloud`; null without a session). */
export interface ReadAloudState {
  tabId: string
  status: ReadAloudStatus
  source: ReadAloudSource
  title: string
  lang: string
  /** Into `ReadAloudText.sentences`; -1 before the first. */
  sentenceIndex: number
  sentenceCount: number
  /** The word being spoken, as offsets within the current sentence's text; null between words or without word events. */
  word: { start: number; end: number } | null
  /** 0.5–4 (Chrome's ladder: `READ_ALOUD_RATES`). */
  rate: number
  /** The voice in use; null while resolving, or when the host has none. */
  voiceId: string | null
  highlight: ReadAloudHighlightMode
  /** `no-voice`, `no-text`, or the host's message. */
  error?: string
}

export interface ReadAloudVoice {
  id: string
  name: string
  /** BCP-47 tag as the engine spells it (`en-GB`). */
  lang: string
  /** Synthesised on the device (no network). */
  local: boolean
  quality?: 'low' | 'normal' | 'high'
  /** The engine's own default voice (the flag `speechSynthesis` and `TextToSpeech` carry); hosts that cannot tell leave it out. */
  default?: boolean
}

export interface ReadAloudSettings {
  rate: number
  /** The user's voice per language tag (`setVoice` writes the current text's language). */
  voiceByLanguage: Record<string, string>
  highlight: ReadAloudHighlightMode
}

/** Chrome's speed ladder (Reading mode's menu and Listen to this page's speed control). */
export const READ_ALOUD_RATES: readonly number[] = [0.5, 0.8, 1, 1.2, 1.5, 2, 3, 4]
export const READ_ALOUD_MIN_RATE = 0.5
export const READ_ALOUD_MAX_RATE = 4

export const READ_ALOUD_HIGHLIGHT_MODES: readonly ReadAloudHighlightMode[] = [
  'sentence',
  'word',
  'both',
  'off'
]

export const DEFAULT_READ_ALOUD_SETTINGS: ReadAloudSettings = {
  rate: 1,
  voiceByLanguage: {},
  highlight: 'both'
}

/** A rate from anywhere comes out within the ladder's range (two decimals); the default for junk. */
export function sanitizeReadAloudRate(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_READ_ALOUD_SETTINGS.rate
  const clamped = Math.max(READ_ALOUD_MIN_RATE, Math.min(READ_ALOUD_MAX_RATE, raw))
  return Math.round(clamped * 100) / 100
}

/** The next step up (`direction` > 0) or down the ladder from `current`; the ends are sticky. */
export function stepReadAloudRate(current: number, direction: number): number {
  const rates = READ_ALOUD_RATES
  const rate = sanitizeReadAloudRate(current)
  if (direction > 0) return rates.find((r) => r > rate + 1e-9) ?? rates[rates.length - 1]
  if (direction < 0) return [...rates].reverse().find((r) => r < rate - 1e-9) ?? rates[0]
  return rate
}

/** Stored settings from any version come out complete and valid. */
export function sanitizeReadAloudSettings(raw: unknown): ReadAloudSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ReadAloudSettings>
  const voiceByLanguage: Record<string, string> = {}
  if (r.voiceByLanguage && typeof r.voiceByLanguage === 'object') {
    for (const [lang, voice] of Object.entries(r.voiceByLanguage)) {
      const key = normalizeLanguageTag(lang)
      if (key && typeof voice === 'string' && voice) voiceByLanguage[key] = voice
    }
  }
  return {
    rate: sanitizeReadAloudRate(r.rate),
    voiceByLanguage,
    highlight: READ_ALOUD_HIGHLIGHT_MODES.includes(r.highlight as ReadAloudHighlightMode)
      ? (r.highlight as ReadAloudHighlightMode)
      : DEFAULT_READ_ALOUD_SETTINGS.highlight
  }
}

/**
 * Where `readAloud.start` begins: the top, the selection (`selection` reads it alone;
 * `selection-on` reads it and then the rest of the document after it, EDGE-11), the reader
 * article, or one sentence.
 */
export type ReadAloudStartFrom =
  | 'top'
  | 'selection'
  | 'selection-on'
  | 'reader'
  | { blockId: string; sentenceIndex: number }

/** What the `readAloud.voices` query answers: the list and the per-language default from it. */
export interface ReadAloudVoicesResult {
  voices: ReadAloudVoice[]
  byLanguage: Record<string, string>
}

// ---------------------------------------------------------------------------
// Languages and voices
// ---------------------------------------------------------------------------

/** `en_US` / `EN-us` → `en-us`; '' for anything that is not a tag. */
export function normalizeLanguageTag(tag: unknown): string {
  if (typeof tag !== 'string') return ''
  const clean = tag.trim().toLowerCase().replace(/_/g, '-')
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(clean) ? clean : ''
}

/** The primary subtag: `en` for `en-GB`. */
export function baseLanguage(tag: string): string {
  return normalizeLanguageTag(tag).split('-')[0] ?? ''
}

/**
 * The voice for a language (contract 2.4): the user's choice for the tag (or its base language)
 * when that voice still exists; else the engine's default voice for the language, or the first
 * listed for the exact tag; else the first local voice of the same base language; else the first
 * remote one. Null when the language has no voice at all.
 */
export function voiceForLanguage(
  voices: readonly ReadAloudVoice[],
  lang: string,
  preferred: Record<string, string> = {}
): string | null {
  const wanted = normalizeLanguageTag(lang)
  if (!wanted) return null
  const base = baseLanguage(wanted)
  const chosen = preferred[wanted] ?? preferred[base]
  if (chosen && voices.some((v) => v.id === chosen)) return chosen
  const exact = voices.filter((v) => normalizeLanguageTag(v.lang) === wanted)
  const exactDefault = exact.find((v) => v.default)
  if (exactDefault) return exactDefault.id
  if (exact[0]) return exact[0].id
  const same = voices.filter((v) => baseLanguage(v.lang) === base)
  const sameDefault = same.find((v) => v.default && v.local)
  if (sameDefault) return sameDefault.id
  const local = same.find((v) => v.local)
  if (local) return local.id
  return same[0]?.id ?? null
}

/**
 * The voice a text speaks with: the language's own (`voiceForLanguage`), else the UI language's
 * default, else whatever the engine offers first. `fallback` says the language itself had none;
 * `voiceId` is null only when the engine has no voice at all (`error: 'no-voice'`).
 */
export function resolveReadAloudVoice(
  voices: readonly ReadAloudVoice[],
  lang: string,
  preferred: Record<string, string>,
  uiLang: string
): { voiceId: string | null; fallback: boolean } {
  const own = voiceForLanguage(voices, lang, preferred)
  if (own) return { voiceId: own, fallback: false }
  const ui = voiceForLanguage(voices, uiLang, preferred)
  if (ui) return { voiceId: ui, fallback: true }
  const engineDefault = voices.find((v) => v.default) ?? voices[0]
  return { voiceId: engineDefault?.id ?? null, fallback: true }
}

/** The per-language default for every language the list speaks (`readAloud.voices`). */
export function voicesByLanguage(
  voices: readonly ReadAloudVoice[],
  preferred: Record<string, string>,
  extraLanguages: readonly string[] = []
): Record<string, string> {
  const out: Record<string, string> = {}
  const languages = new Set<string>()
  for (const voice of voices) {
    const tag = normalizeLanguageTag(voice.lang)
    if (!tag) continue
    languages.add(tag)
    languages.add(baseLanguage(tag))
  }
  for (const lang of extraLanguages) {
    const tag = normalizeLanguageTag(lang)
    if (tag) languages.add(tag)
  }
  for (const lang of [...languages].sort()) {
    const voice = voiceForLanguage(voices, lang, preferred)
    if (voice) out[lang] = voice
  }
  return out
}

// ---------------------------------------------------------------------------
// The sentence walker
// ---------------------------------------------------------------------------

interface SentenceSegmenter {
  segment(text: string): Iterable<{ segment: string; index: number }>
}

const segmenters = new Map<string, SentenceSegmenter | null>()

/** `Intl.Segmenter` for the language (Chromium 152 and the WebView have it), or null without one. */
function segmenterFor(lang: string): SentenceSegmenter | null {
  const key = normalizeLanguageTag(lang) || 'und'
  const cached = segmenters.get(key)
  if (cached !== undefined) return cached
  let segmenter: SentenceSegmenter | null = null
  const intl = (globalThis as { Intl?: { Segmenter?: unknown } }).Intl
  const Segmenter = intl?.Segmenter as
    | (new (locale: string | undefined, options: { granularity: 'sentence' }) => SentenceSegmenter)
    | undefined
  if (typeof Segmenter === 'function') {
    try {
      segmenter = new Segmenter(key === 'und' ? undefined : key, { granularity: 'sentence' })
    } catch {
      try {
        segmenter = new Segmenter(undefined, { granularity: 'sentence' })
      } catch {
        segmenter = null
      }
    }
  }
  segmenters.set(key, segmenter)
  return segmenter
}

/** Terminal punctuation (with closing quotes and brackets) followed by space, or a CJK full stop. */
const FALLBACK_BOUNDARY = /[.!?…]+["'”’»)\]]*(?=\s)|[。！？]+["'”’»)\]]*/g

/**
 * The sentence spans of `text` by punctuation alone, for a runtime without `Intl.Segmenter`:
 * a boundary after `.`, `!`, `?` or `…` (closing quotes included) that a space follows, and
 * after the CJK terminators, which take no space.
 */
export function splitSentencesFallback(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let start = 0
  FALLBACK_BOUNDARY.lastIndex = 0
  for (let match = FALLBACK_BOUNDARY.exec(text); match; match = FALLBACK_BOUNDARY.exec(text)) {
    const end = match.index + match[0].length
    spans.push([start, end])
    start = end
  }
  if (start < text.length) spans.push([start, text.length])
  return spans
}

/** Spans trimmed of their surrounding whitespace; empty ones dropped. */
function trimSpans(text: string, spans: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const [from, to] of spans) {
    let start = from
    let end = to
    while (start < end && /\s/.test(text[start])) start++
    while (end > start && /\s/.test(text[end - 1])) end--
    if (end > start) out.push([start, end])
  }
  return out
}

/** The sentence spans of one block's text in `lang`. */
export function sentenceSpans(text: string, lang: string): Array<[number, number]> {
  const segmenter = segmenterFor(lang)
  if (!segmenter) return trimSpans(text, splitSentencesFallback(text))
  const spans: Array<[number, number]> = []
  for (const { segment, index } of segmenter.segment(text)) {
    spans.push([index, index + segment.length])
  }
  return trimSpans(text, spans)
}

/**
 * Cut the blocks into sentences (one utterance each). `Intl.Segmenter` with the block's own
 * language (`lang=` attributes) or the document's, a punctuation fallback without it; headings
 * and list items are one sentence each; empty and whitespace-only blocks are dropped.
 */
export function segmentSentences(
  blocks: readonly ReadAloudBlock[],
  lang: string
): ReadAloudSentence[] {
  const sentences: ReadAloudSentence[] = []
  for (const block of blocks) {
    if (!block.text.trim()) continue
    const spans =
      block.kind === 'heading' || block.kind === 'list-item'
        ? trimSpans(block.text, [[0, block.text.length]])
        : sentenceSpans(block.text, block.lang ?? lang)
    for (const [start, end] of spans) {
      sentences.push({
        blockId: block.id,
        index: sentences.length,
        start,
        end,
        text: block.text.slice(start, end)
      })
    }
  }
  return sentences
}

// ---------------------------------------------------------------------------
// Blocks: the walk shared by the core (the reader's article HTML) and the page script (the DOM)
// ---------------------------------------------------------------------------

/** Elements whose content starts and ends a block of text (HTML's flow content, roughly). */
export const READ_ALOUD_BLOCK_TAGS: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'caption',
  'center',
  'dd',
  'details',
  'dialog',
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
  'head',
  'header',
  'hgroup',
  'hr',
  'html',
  'legend',
  'li',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
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

/** Elements whose content is never read: code, media, controls, annotations. */
export const READ_ALOUD_SKIP_TAGS: ReadonlySet<string> = new Set([
  'area',
  'audio',
  'base',
  'button',
  'canvas',
  'datalist',
  'embed',
  'frame',
  'frameset',
  'head',
  'iframe',
  'img',
  'input',
  'link',
  'map',
  'math',
  'meta',
  'meter',
  'noscript',
  'object',
  'option',
  'picture',
  'progress',
  'rp',
  'rt',
  'script',
  'select',
  'source',
  'style',
  'svg',
  'template',
  'textarea',
  'title',
  'track',
  'video'
])

/** HTML's void elements (no content, no end tag). */
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

/** Elements whose content is raw text up to their end tag. */
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(['script', 'style', 'textarea', 'title', 'xmp'])

/** The kinds a tag gives its text; a block of a generic container is a paragraph. */
const SPECIFIC_KINDS: Record<string, ReadAloudBlockKind> = {
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  li: 'list-item',
  blockquote: 'quote',
  figcaption: 'caption',
  caption: 'caption'
}

const OTHER_KIND_TAGS: ReadonlySet<string> = new Set([
  'pre',
  'td',
  'th',
  'dt',
  'dd',
  'table',
  'tr',
  'summary',
  'details',
  'address',
  'legend'
])

/** What an emitter says about an element it opens. */
export interface BlockFrameAttributes {
  /** The element's own `lang` attribute (null / '' for none; inherited otherwise). */
  lang?: string | null
  /** Ignore the element and everything in it. */
  skip?: boolean
  /** Walk the element's children but ignore the text directly inside it. */
  ownTextSkipped?: boolean
}

/** One text node's contribution to a block, in document order (for the highlight's ranges). */
export interface BlockPiece<Node> {
  node: Node
  text: string
}

/** A block as the collector emits it: which frame's text it is and which run of that frame. */
export interface CollectedBlock<Ref, Node = unknown> {
  kind: ReadAloudBlockKind
  text: string
  lang?: string
  /** The element whose direct (inline) content this is: the nearest block ancestor of the text. */
  ref: Ref
  /** Which of that element's runs of inline content (a nested block splits them). */
  run: number
  /** The raw text pieces the block was collapsed from (when the collector tracks them). */
  pieces?: BlockPiece<Node>[]
}

interface Frame<Ref, Node> {
  tag: string
  isBlock: boolean
  skip: boolean
  ownTextSkipped: boolean
  lang: string
  ref: Ref
  buffer: string
  pieces: BlockPiece<Node>[]
  runs: number
}

/** Runs of whitespace (`&nbsp;` included) become one space; the ends are trimmed. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Turns a document's element / text events into blocks: text lands in its nearest block
 * ancestor's buffer; a nested block flushes what came before it as a run of its own; a block's
 * end flushes its last run. Both the core's HTML tokenizer and the page script's DOM walk feed
 * one of these, so the reader's article and the reader document agree on every block.
 */
export class BlockCollector<Ref, Node = unknown> {
  private readonly stack: Frame<Ref, Node>[] = []
  readonly blocks: CollectedBlock<Ref, Node>[] = []
  private readonly docLang: string

  constructor(
    docLang: string,
    rootRef: Ref,
    private readonly trackPieces = false
  ) {
    this.docLang = normalizeLanguageTag(docLang)
    this.stack.push({
      tag: '#root',
      isBlock: true,
      skip: false,
      ownTextSkipped: false,
      lang: this.docLang,
      ref: rootRef,
      buffer: '',
      pieces: [],
      runs: 0
    })
  }

  open(tag: string, attributes: BlockFrameAttributes, ref: Ref): void {
    const name = tag.toLowerCase()
    const parent = this.stack[this.stack.length - 1]
    const isBlock = READ_ALOUD_BLOCK_TAGS.has(name)
    if (isBlock) this.flush(this.nearestBlock())
    const own = normalizeLanguageTag(attributes.lang ?? '')
    this.stack.push({
      tag: name,
      isBlock,
      skip: parent.skip || Boolean(attributes.skip),
      ownTextSkipped: Boolean(attributes.ownTextSkipped),
      lang: own || parent.lang,
      ref,
      buffer: '',
      pieces: [],
      runs: 0
    })
  }

  /** A text node's text (`<br>` is a space). */
  text(text: string, node?: Node): void {
    if (!text) return
    const top = this.stack[this.stack.length - 1]
    if (top.skip || top.ownTextSkipped) return
    const frame = this.nearestBlock()
    frame.buffer += text
    if (this.trackPieces && node !== undefined) frame.pieces.push({ node, text })
  }

  close(): void {
    if (this.stack.length <= 1) return
    const frame = this.stack[this.stack.length - 1]
    if (frame.isBlock) this.flush(frame)
    this.stack.pop()
  }

  /** The tag of the innermost open element (`#root` at the top). */
  get currentTag(): string {
    return this.stack[this.stack.length - 1].tag
  }

  /** Whether `tag` is open somewhere on the stack (for implied end tags). */
  hasOpen(tag: string): boolean {
    return this.stack.some((f) => f.tag === tag)
  }

  /** Close every element up to and including the innermost `tag`; nothing when it is not open. */
  closeThrough(tag: string): void {
    if (!this.hasOpen(tag)) return
    while (this.stack.length > 1) {
      const name = this.currentTag
      this.close()
      if (name === tag) return
    }
  }

  /** Close everything still open and return the blocks. */
  finish(): CollectedBlock<Ref, Node>[] {
    while (this.stack.length > 1) this.close()
    this.flush(this.stack[0])
    return this.blocks
  }

  private nearestBlock(): Frame<Ref, Node> {
    for (let i = this.stack.length - 1; i >= 0; i--) if (this.stack[i].isBlock) return this.stack[i]
    return this.stack[0]
  }

  private flush(frame: Frame<Ref, Node>): void {
    const raw = frame.buffer
    const pieces = frame.pieces
    frame.buffer = ''
    frame.pieces = []
    const text = collapseWhitespace(raw)
    if (!text) return
    const block: CollectedBlock<Ref, Node> = {
      kind: this.kindOf(frame),
      text,
      ref: frame.ref,
      run: frame.runs++
    }
    if (frame.lang && frame.lang !== this.docLang) block.lang = frame.lang
    if (this.trackPieces) block.pieces = pieces
    this.blocks.push(block)
  }

  /** The first specific kind walking outward from the frame; else the frame's own generic kind. */
  private kindOf(frame: Frame<Ref, Node>): ReadAloudBlockKind {
    const at = this.stack.indexOf(frame)
    for (let i = at; i >= 0; i--) {
      const specific = SPECIFIC_KINDS[this.stack[i].tag]
      if (specific) return specific
    }
    return OTHER_KIND_TAGS.has(frame.tag) ? 'other' : 'paragraph'
  }
}

// ---------------------------------------------------------------------------
// The reader's article HTML → blocks (no DOM: a small tokenizer over well-formed HTML)
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  shy: '',
  zwj: '',
  zwnj: '',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  sbquo: '\u201a',
  bdquo: '\u201e',
  laquo: '\u00ab',
  raquo: '\u00bb',
  lsaquo: '\u2039',
  rsaquo: '\u203a',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  deg: '\u00b0',
  middot: '\u00b7',
  bull: '\u2022',
  times: '\u00d7',
  divide: '\u00f7',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  sect: '\u00a7',
  para: '\u00b6',
  frac12: '\u00bd',
  frac14: '\u00bc',
  frac34: '\u00be',
  plusmn: '\u00b1',
  micro: '\u00b5',
  prime: '\u2032',
  Prime: '\u2033',
  larr: '\u2190',
  rarr: '\u2192',
  uarr: '\u2191',
  darr: '\u2193',
  eacute: '\u00e9',
  egrave: '\u00e8',
  agrave: '\u00e0',
  aacute: '\u00e1',
  ccedil: '\u00e7',
  ntilde: '\u00f1',
  ouml: '\u00f6',
  uuml: '\u00fc',
  auml: '\u00e4',
  szlig: '\u00df',
  Eacute: '\u00c9',
  Auml: '\u00c4',
  Ouml: '\u00d6',
  Uuml: '\u00dc'
}

/** Character references decoded; unknown named ones stay as written. */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()]
    return named !== undefined ? named : whole
  })
}

const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  ATTRIBUTE.lastIndex = 0
  for (let m = ATTRIBUTE.exec(source); m; m = ATTRIBUTE.exec(source)) {
    const name = m[1].toLowerCase()
    if (name in attributes) continue
    attributes[name] = decodeHtmlEntities(m[2] ?? m[3] ?? m[4] ?? '')
  }
  return attributes
}

/** Start tags that close an open `<p>` (HTML's implied end tags), for markup that leaves them out. */
const CLOSES_P: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'dialog',
  'div',
  'dl',
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
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul'
])

/**
 * The blocks of an article's HTML (`ReaderArticle.content`, sanitised, as Readability serialised
 * it): the same walk the page script does over the rendered `<article>`, so a block's id (`b0`,
 * `b1`, …) names the same element in the reader document. Tolerates the common omissions
 * (`<p>` and `<li>` without end tags, stray end tags).
 */
export function blocksFromHtml(html: string, docLang: string): ReadAloudBlock[] {
  const collector = new BlockCollector<number>(docLang, -1)
  let elementIndex = 0
  const n = html.length
  let i = 0
  while (i < n) {
    if (html[i] !== '<') {
      const next = html.indexOf('<', i)
      const end = next === -1 ? n : next
      collector.text(decodeHtmlEntities(html.slice(i, end)))
      i = end
      continue
    }
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4)
      i = end === -1 ? n : end + 3
      continue
    }
    if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      const end = html.indexOf('>', i)
      i = end === -1 ? n : end + 1
      continue
    }
    if (html.startsWith('</', i)) {
      const m = /^<\/([a-zA-Z][\w:-]*)\s*>/.exec(html.slice(i, i + 64))
      if (!m) {
        i += 2
        continue
      }
      collector.closeThrough(m[1].toLowerCase())
      i += m[0].length
      continue
    }
    const m = /^<([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/.exec(html.slice(i))
    if (!m) {
      collector.text('<')
      i++
      continue
    }
    const tag = m[1].toLowerCase()
    const attributes = parseAttributes(m[2])
    i += m[0].length
    if (tag === 'br') {
      collector.text(' ')
      continue
    }
    if (tag === 'p' || CLOSES_P.has(tag)) {
      if (collector.currentTag === 'p') collector.close()
    }
    if (tag === 'li' && collector.currentTag === 'li') collector.close()
    if (
      (tag === 'dt' || tag === 'dd') &&
      (collector.currentTag === 'dt' || collector.currentTag === 'dd')
    )
      collector.close()
    if (
      (tag === 'td' || tag === 'th') &&
      (collector.currentTag === 'td' || collector.currentTag === 'th')
    )
      collector.close()
    if (tag === 'tr' && collector.currentTag !== 'tr') {
      if (collector.currentTag === 'td' || collector.currentTag === 'th') collector.close()
      if (collector.currentTag === 'tr') collector.close()
    }
    collector.open(
      tag,
      {
        lang: attributes.lang ?? null,
        skip:
          READ_ALOUD_SKIP_TAGS.has(tag) ||
          'hidden' in attributes ||
          attributes['aria-hidden'] === 'true'
      },
      elementIndex++
    )
    if (VOID_TAGS.has(tag) || m[3] === '/') {
      collector.close()
      continue
    }
    if (RAW_TEXT_TAGS.has(tag)) {
      const close = html.toLowerCase().indexOf(`</${tag}`, i)
      i = close === -1 ? n : close
      continue
    }
  }
  return collector.finish().map((block, index) => toReadAloudBlock(block, index))
}

/** A collected block as the model's block, with its id from its position. */
export function toReadAloudBlock<Ref, Node>(
  block: CollectedBlock<Ref, Node>,
  index: number
): ReadAloudBlock {
  const out: ReadAloudBlock = { id: `b${index}`, kind: block.kind, text: block.text }
  if (block.lang) out.lang = block.lang
  return out
}

// ---------------------------------------------------------------------------
// The page protocol
// ---------------------------------------------------------------------------

/** The Custom Highlight API names the page script paints under (`::highlight(name)`). */
export const READ_ALOUD_SENTENCE_HIGHLIGHT = 'zenium-read-sentence'
export const READ_ALOUD_WORD_HIGHLIGHT = 'zenium-read-word'

/** The highlight's own style, inserted into web pages for the session (the reader page styles it itself). */
export const READ_ALOUD_HIGHLIGHT_CSS = `::highlight(${READ_ALOUD_SENTENCE_HIGHLIGHT}) { background-color: rgba(255, 214, 10, 0.32); }
::highlight(${READ_ALOUD_WORD_HIGHLIGHT}) { background-color: rgba(255, 149, 0, 0.6); }`

/**
 * Where a block's text lives in the page: the element path from the root (`children` indices,
 * `[]` for the root element itself), which run of that element's own inline content, and the
 * offset in that run's collapsed text where the block's text begins (a selection's first block).
 */
export interface ReadAloudBlockPosition {
  path: number[]
  run: number
  offset: number
}

/** A block the page script extracted, with where its text is for the highlight. */
export interface ReadAloudExtractedBlock extends ReadAloudBlock {
  at: ReadAloudBlockPosition
}

/** What the page script answers `readAloud.extract` with (the `readAloud` page message). */
export interface ReadAloudExtraction {
  requestId: string
  title: string
  lang: string
  blocks: ReadAloudExtractedBlock[]
}

/**
 * Browser → page: extract the text to read. `keep` carries the texts of the blocks Readability
 * kept (the article's main content) when the page is readerable and the core ran it; the page
 * script keeps the blocks of its own walk whose text matches, so the highlight has their nodes.
 * `from: 'selection'` with `then: 'document'` (EDGE-11) answers the selection's blocks first and
 * then the document's after them: the rest of the selection's last block from where the
 * selection ends, then every block that follows it (`keep`'s when it is given and trusted),
 * each once; without `then` the selection alone is answered.
 */
export interface ReadAloudExtractRequest {
  type: 'readAloud'
  action: 'extract'
  requestId: string
  from: 'top' | 'selection'
  then?: 'document'
  keep?: string[] | null
}

/**
 * Browser → page: paint the sentence and the word being spoken (`mode: 'off'` clears). `at` is
 * the block's position for a page's blocks; the reader document resolves `blockId` itself (its
 * `<article>` walked by the same rules, `b<index>`).
 */
export interface ReadAloudHighlightMessage {
  type: 'readAloud'
  action: 'highlight'
  tabId: string
  blockId: string
  at?: ReadAloudBlockPosition | null
  sentence: { start: number; end: number }
  word: { start: number; end: number } | null
  mode: ReadAloudHighlightMode
}

export type ReadAloudHostMessage = ReadAloudExtractRequest | ReadAloudHighlightMessage

/** The extraction as it came off the wire, checked field by field; null when it is not one. */
export function readAloudExtractionOf(raw: unknown): ReadAloudExtraction | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<ReadAloudExtraction>
  if (typeof r.requestId !== 'string' || !Array.isArray(r.blocks)) return null
  const blocks: ReadAloudExtractedBlock[] = []
  for (const entry of r.blocks) {
    if (!entry || typeof entry !== 'object') continue
    const b = entry as Partial<ReadAloudExtractedBlock>
    if (typeof b.id !== 'string' || typeof b.text !== 'string') continue
    const at = b.at
    if (
      !at ||
      typeof at !== 'object' ||
      !Array.isArray(at.path) ||
      !at.path.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0) ||
      typeof at.run !== 'number' ||
      typeof at.offset !== 'number'
    )
      continue
    const kind: ReadAloudBlockKind = (
      ['heading', 'paragraph', 'list-item', 'quote', 'caption', 'other'] as const
    ).includes(b.kind as ReadAloudBlockKind)
      ? (b.kind as ReadAloudBlockKind)
      : 'paragraph'
    const block: ReadAloudExtractedBlock = {
      id: b.id,
      kind,
      text: b.text,
      at: {
        path: at.path.slice(0, 64),
        run: Math.max(0, Math.floor(at.run)),
        offset: Math.max(0, Math.floor(at.offset))
      }
    }
    const lang = normalizeLanguageTag(b.lang)
    if (lang) block.lang = lang
    blocks.push(block)
  }
  return {
    requestId: r.requestId,
    title: typeof r.title === 'string' ? r.title : '',
    lang: normalizeLanguageTag(r.lang),
    blocks
  }
}
