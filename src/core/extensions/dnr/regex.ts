/**
 * A conservative model of what RE2 accepts for `regexFilter`, mirroring how Chrome compiles the
 * expression (`extensions/browser/api/declarative_net_request/utils.cc` `CreateRE2Options`):
 * Latin-1 encoding, Perl-like syntax (`RE2::Options` defaults: non-POSIX, one-line, Perl classes,
 * `\b`, non-greedy operators, Unicode groups), case folding unless the rule is case sensitive,
 * captures only when a `regexSubstitution` needs them, and a 2 KB memory budget.
 *
 * The syntax checker is a port of the relevant parts of RE2's `parse.cc` (checked against the
 * `main` branch on 2026-09-17): it rejects exactly the constructs RE2 rejects (lookaround,
 * backreferences, possessive and stacked repetition, unknown escapes, bad classes, out-of-range
 * counted repetition, invalid Perl flags) and accepts the rest.
 *
 * The memory check reproduces RE2's instruction budget. `RE2::Init` compiles the forward program
 * with `max_mem * 2 / 3` bytes, and `Compiler::Setup` allows `(max_mem - sizeof(Prog)) /
 * sizeof(Prog::Inst)` instructions, which for 2 KB, a 432 byte `Prog` and 8 byte instructions is
 * 116 (`re2/compile.cc`, `re2/re2.cc`). The estimator walks the same pipeline RE2 does (parser
 * simplifications, alternation factoring, `Simplify()`, `Compiler`) so the count matches RE2's
 * for the constructs extensions use; it was calibrated against RE2 itself on 650 rules from
 * published extensions plus synthetic cases (see the dnr-translator report).
 */

export type UnsupportedRegexReason = 'syntaxError' | 'memoryLimitExceeded'

export interface RegexCheckOptions {
  /** Chrome's `isRegexSupported` defaults to true; rules default to false. */
  isCaseSensitive?: boolean
  /** True when a `regexSubstitution` will use capture groups. */
  requireCapturing?: boolean
}

export type RegexCheckResult =
  | { isSupported: true; captureCount: number; instructions: number }
  | { isSupported: false; reason: UnsupportedRegexReason; message: string }

/** RE2's 2 KB budget expressed as the compiled instruction limit it implies. */
export const RE2_MAX_MEMORY_BYTES = 2 * 1024
const RE2_SIZEOF_PROG = 432
const RE2_SIZEOF_INST = 8
export const RE2_MAX_INSTRUCTIONS = Math.floor(
  (Math.floor((RE2_MAX_MEMORY_BYTES * 2) / 3) - RE2_SIZEOF_PROG) / RE2_SIZEOF_INST
)

/** RE2's `maximum_repeat_count`. */
const MAX_REPEAT = 1000
const RUNE_MAX = 0xff

export class RegexSyntaxError extends Error {
  constructor(
    readonly code: string,
    readonly arg: string
  ) {
    super(`${code}: ${arg}`)
    this.name = 'RegexSyntaxError'
  }
}

// ---------------------------------------------------------------------------------------------
// Character classes: sorted, non-overlapping, non-adjacent inclusive ranges over 0..0x10FFFF.

type Range = [lo: number, hi: number]

class CharClassBuilder {
  ranges: Range[] = []

  addRange(lo: number, hi: number): void {
    if (lo > hi) return
    const out: Range[] = []
    let i = 0
    while (i < this.ranges.length && this.ranges[i]![1] < lo - 1) out.push(this.ranges[i++]!)
    let nlo = lo
    let nhi = hi
    while (i < this.ranges.length && this.ranges[i]![0] <= hi + 1) {
      nlo = Math.min(nlo, this.ranges[i]![0])
      nhi = Math.max(nhi, this.ranges[i]![1])
      i++
    }
    out.push([nlo, nhi])
    while (i < this.ranges.length) out.push(this.ranges[i++]!)
    this.ranges = out
  }

  addClass(other: CharClassBuilder): void {
    for (const [lo, hi] of other.ranges) this.addRange(lo, hi)
  }

  /** RE2 `AddRangeFlags`: fold ASCII case when the FoldCase flag is on (Latin-1 folding). */
  addRangeFlags(lo: number, hi: number, foldCase: boolean): void {
    if (!foldCase) {
      this.addRange(lo, hi)
      return
    }
    this.addRange(lo, hi)
    const a = Math.max(lo, 0x41)
    const z = Math.min(hi, 0x5a)
    if (a <= z) this.addRange(a + 0x20, z + 0x20)
    const la = Math.max(lo, 0x61)
    const lz = Math.min(hi, 0x7a)
    if (la <= lz) this.addRange(la - 0x20, lz - 0x20)
  }

  negate(): void {
    const out: Range[] = []
    let next = 0
    for (const [lo, hi] of this.ranges) {
      if (next < lo) out.push([next, lo - 1])
      next = hi + 1
    }
    if (next <= 0x10ffff) out.push([next, 0x10ffff])
    this.ranges = out
  }

  removeAbove(max: number): void {
    const out: Range[] = []
    for (const [lo, hi] of this.ranges) {
      if (lo > max) break
      out.push([lo, Math.min(hi, max)])
    }
    this.ranges = out
  }

  contains(r: number): boolean {
    return this.ranges.some(([lo, hi]) => lo <= r && r <= hi)
  }

  size(): number {
    let n = 0
    for (const [lo, hi] of this.ranges) n += hi - lo + 1
    return n
  }

  /** RE2 `CharClass::FoldsASCII`: every ASCII letter is present in both cases or neither. */
  foldsAscii(): boolean {
    for (let c = 0x41; c <= 0x5a; c++)
      if (this.contains(c) !== this.contains(c + 0x20)) return false
    return true
  }

  clone(): CharClassBuilder {
    const c = new CharClassBuilder()
    c.ranges = this.ranges.map(([lo, hi]) => [lo, hi])
    return c
  }
}

interface UGroup {
  sign: 1 | -1
  ranges: Range[]
}

const PERL_GROUPS: Record<string, UGroup> = {
  '\\d': { sign: 1, ranges: [[0x30, 0x39]] },
  '\\D': { sign: -1, ranges: [[0x30, 0x39]] },
  '\\s': {
    sign: 1,
    ranges: [
      [0x09, 0x0a],
      [0x0c, 0x0d],
      [0x20, 0x20]
    ]
  },
  '\\S': {
    sign: -1,
    ranges: [
      [0x09, 0x0a],
      [0x0c, 0x0d],
      [0x20, 0x20]
    ]
  },
  '\\w': {
    sign: 1,
    ranges: [
      [0x30, 0x39],
      [0x41, 0x5a],
      [0x5f, 0x5f],
      [0x61, 0x7a]
    ]
  },
  '\\W': {
    sign: -1,
    ranges: [
      [0x30, 0x39],
      [0x41, 0x5a],
      [0x5f, 0x5f],
      [0x61, 0x7a]
    ]
  }
}

const POSIX_RANGES: Record<string, Range[]> = {
  alnum: [
    [0x30, 0x39],
    [0x41, 0x5a],
    [0x61, 0x7a]
  ],
  alpha: [
    [0x41, 0x5a],
    [0x61, 0x7a]
  ],
  ascii: [[0x00, 0x7f]],
  blank: [
    [0x09, 0x09],
    [0x20, 0x20]
  ],
  cntrl: [
    [0x00, 0x1f],
    [0x7f, 0x7f]
  ],
  digit: [[0x30, 0x39]],
  graph: [[0x21, 0x7e]],
  lower: [[0x61, 0x7a]],
  print: [[0x20, 0x7e]],
  punct: [
    [0x21, 0x2f],
    [0x3a, 0x40],
    [0x5b, 0x60],
    [0x7b, 0x7e]
  ],
  space: [
    [0x09, 0x0d],
    [0x20, 0x20]
  ],
  upper: [[0x41, 0x5a]],
  word: [
    [0x30, 0x39],
    [0x41, 0x5a],
    [0x5f, 0x5f],
    [0x61, 0x7a]
  ],
  xdigit: [
    [0x30, 0x39],
    [0x41, 0x46],
    [0x61, 0x66]
  ]
}

/** Names RE2 accepts in `\p{...}` (`re2/unicode_groups.cc` plus the synthetic `Any`). */
const UNICODE_GENERAL_CATEGORIES = new Set(
  'C Cc Cf Co Cs L Ll Lm Lo Lt Lu M Mc Me Mn N Nd Nl No P Pc Pd Pe Pf Pi Po Ps S Sc Sk Sm So Z Zl Zp Zs'.split(
    ' '
  )
)
const UNICODE_SCRIPTS = new Set(
  (
    'Adlam Ahom Anatolian_Hieroglyphs Arabic Armenian Avestan Balinese Bamum Bassa_Vah Batak Bengali ' +
    'Bhaiksuki Bopomofo Brahmi Braille Buginese Buhid Canadian_Aboriginal Carian Caucasian_Albanian ' +
    'Chakma Cham Cherokee Chorasmian Common Coptic Cuneiform Cypriot Cypro_Minoan Cyrillic Deseret ' +
    'Devanagari Dives_Akuru Dogra Duployan Egyptian_Hieroglyphs Elbasan Elymaic Ethiopic Georgian ' +
    'Glagolitic Gothic Grantha Greek Gujarati Gunjala_Gondi Gurmukhi Han Hangul Hanifi_Rohingya Hanunoo ' +
    'Hatran Hebrew Hiragana Imperial_Aramaic Inherited Inscriptional_Pahlavi Inscriptional_Parthian ' +
    'Javanese Kaithi Kannada Katakana Kawi Kayah_Li Kharoshthi Khitan_Small_Script Khmer Khojki ' +
    'Khudawadi Lao Latin Lepcha Limbu Linear_A Linear_B Lisu Lycian Lydian Mahajani Makasar Malayalam ' +
    'Mandaic Manichaean Marchen Masaram_Gondi Medefaidrin Meetei_Mayek Mende_Kikakui Meroitic_Cursive ' +
    'Meroitic_Hieroglyphs Miao Modi Mongolian Mro Multani Myanmar Nabataean Nag_Mundari Nandinagari ' +
    'New_Tai_Lue Newa Nko Nushu Nyiakeng_Puachue_Hmong Ogham Ol_Chiki Old_Hungarian Old_Italic ' +
    'Old_North_Arabian Old_Permic Old_Persian Old_Sogdian Old_South_Arabian Old_Turkic Old_Uyghur Oriya ' +
    'Osage Osmanya Pahawh_Hmong Palmyrene Pau_Cin_Hau Phags_Pa Phoenician Psalter_Pahlavi Rejang Runic ' +
    'Samaritan Saurashtra Sharada Shavian Siddham SignWriting Sinhala Sogdian Sora_Sompeng Soyombo ' +
    'Sundanese Syloti_Nagri Syriac Tagalog Tagbanwa Tai_Le Tai_Tham Tai_Viet Takri Tamil Tangsa Tangut ' +
    'Telugu Thaana Thai Tibetan Tifinagh Tirhuta Toto Ugaritic Vai Vithkuqi Wancho Warang_Citi Yezidi Yi ' +
    'Zanabazar_Square'
  ).split(' ')
)

const unicodeGroupCache = new Map<string, Range[] | null>()

/**
 * Latin-1 ranges of an RE2 Unicode group, computed with the JavaScript engine's own property
 * escapes. Only code points up to 0xFF matter because RE2 clips classes to the Latin-1 rune range.
 */
function lookupUnicodeGroup(name: string): Range[] | null {
  const cached = unicodeGroupCache.get(name)
  if (cached !== undefined) return cached
  let ranges: Range[] | null = null
  if (name === 'Any') {
    ranges = [[0, 0x10ffff]]
  } else if (UNICODE_GENERAL_CATEGORIES.has(name) || UNICODE_SCRIPTS.has(name)) {
    const property = UNICODE_SCRIPTS.has(name) ? `Script=${name}` : name
    let test: RegExp | null = null
    try {
      test = new RegExp(`^\\p{${property}}$`, 'u')
    } catch {
      test = null
    }
    if (test) {
      const found = new CharClassBuilder()
      for (let c = 0; c <= RUNE_MAX; c++)
        if (test.test(String.fromCodePoint(c))) found.addRange(c, c)
      ranges = found.ranges
    }
  }
  unicodeGroupCache.set(name, ranges)
  return ranges
}

function addUGroup(cc: CharClassBuilder, group: UGroup, sign: 1 | -1, foldCase: boolean): void {
  if (sign === 1) {
    for (const [lo, hi] of group.ranges) cc.addRangeFlags(lo, hi, foldCase)
    return
  }
  if (foldCase) {
    const positive = new CharClassBuilder()
    addUGroup(positive, group, 1, foldCase)
    positive.negate()
    cc.addClass(positive)
    return
  }
  let next = 0
  for (const [lo, hi] of group.ranges) {
    if (next < lo) cc.addRangeFlags(next, lo - 1, foldCase)
    next = hi + 1
  }
  if (next <= 0x10ffff) cc.addRangeFlags(next, 0x10ffff, foldCase)
}

// ---------------------------------------------------------------------------------------------
// Regexp AST, mirroring RE2's `Regexp` ops.

type Node =
  | { op: 'noMatch' }
  | { op: 'emptyMatch' }
  | { op: 'literal'; rune: number; fold: boolean }
  | { op: 'literalString'; runes: number[]; fold: boolean }
  | { op: 'charClass'; ranges: Range[] }
  | { op: 'anyChar' }
  | { op: 'anyByte' }
  | { op: 'beginLine' }
  | { op: 'endLine' }
  | { op: 'beginText' }
  | { op: 'endText' }
  | { op: 'wordBoundary' }
  | { op: 'noWordBoundary' }
  | { op: 'capture'; sub: Node; cap: number }
  | { op: 'star' | 'plus' | 'quest'; sub: Node; nonGreedy: boolean; pf: number }
  | { op: 'repeat'; sub: Node; min: number; max: number; nonGreedy: boolean; pf: number }
  | { op: 'concat' | 'alternate'; subs: Node[] }

type RepeatOp = 'star' | 'plus' | 'quest'

const EMPTY_MATCH: Node = { op: 'emptyMatch' }

function isEmptyWidthOp(n: Node): boolean {
  return (
    n.op === 'beginLine' ||
    n.op === 'endLine' ||
    n.op === 'beginText' ||
    n.op === 'endText' ||
    n.op === 'wordBoundary' ||
    n.op === 'noWordBoundary'
  )
}

function nodesEqual(a: Node, b: Node): boolean {
  if (a.op !== b.op) return false
  switch (a.op) {
    case 'literal':
      return a.rune === (b as typeof a).rune && a.fold === (b as typeof a).fold
    case 'literalString': {
      const o = b as typeof a
      return (
        a.fold === o.fold &&
        a.runes.length === o.runes.length &&
        a.runes.every((r, i) => r === o.runes[i])
      )
    }
    case 'charClass': {
      const o = b as typeof a
      return (
        a.ranges.length === o.ranges.length &&
        a.ranges.every((r, i) => r[0] === o.ranges[i]![0] && r[1] === o.ranges[i]![1])
      )
    }
    case 'capture':
      return a.cap === (b as typeof a).cap && nodesEqual(a.sub, (b as typeof a).sub)
    case 'star':
    case 'plus':
    case 'quest':
      return a.nonGreedy === (b as typeof a).nonGreedy && nodesEqual(a.sub, (b as typeof a).sub)
    case 'repeat': {
      const o = b as typeof a
      return (
        a.min === o.min &&
        a.max === o.max &&
        a.nonGreedy === o.nonGreedy &&
        nodesEqual(a.sub, o.sub)
      )
    }
    case 'concat':
    case 'alternate': {
      const o = b as typeof a
      return a.subs.length === o.subs.length && a.subs.every((s, i) => nodesEqual(s, o.subs[i]!))
    }
    default:
      return true
  }
}

function charClassNode(cc: CharClassBuilder): Node {
  return { op: 'charClass', ranges: cc.ranges.map(([lo, hi]) => [lo, hi]) }
}

function concat(subs: Node[]): Node {
  if (subs.length === 1) return subs[0]!
  if (subs.length === 0) return EMPTY_MATCH
  return { op: 'concat', subs }
}

function alternateNoFactor(subs: Node[]): Node {
  if (subs.length === 1) return subs[0]!
  if (subs.length === 0) return { op: 'noMatch' }
  return { op: 'alternate', subs }
}

// ---------------------------------------------------------------------------------------------
// Alternation factoring (RE2 `FactorAlternation`, rounds 1-3).

function leadingString(re: Node): { runes: number[]; fold: boolean } | null {
  let n = re
  while (n.op === 'concat' && n.subs.length > 0) n = n.subs[0]!
  if (n.op === 'literal') return { runes: [n.rune], fold: n.fold }
  if (n.op === 'literalString') return { runes: n.runes, fold: n.fold }
  return null
}

/** Flags RE2 compares in round 1: the leading node's FoldCase bit (Latin1 is always set here). */
function leadingStringFlags(re: Node): boolean | null {
  let n = re
  while (n.op === 'concat' && n.subs.length > 0) n = n.subs[0]!
  if (n.op === 'literal' || n.op === 'literalString') return n.fold
  return null
}

function removeLeadingString(re: Node, n: number): Node {
  if (re.op === 'concat') {
    const first = removeLeadingString(re.subs[0]!, n)
    if (first.op === 'emptyMatch') {
      const rest = re.subs.slice(1)
      if (rest.length === 0) return EMPTY_MATCH
      if (rest.length === 1) return rest[0]!
      return { op: 'concat', subs: rest }
    }
    return { op: 'concat', subs: [first, ...re.subs.slice(1)] }
  }
  if (re.op === 'literal') return EMPTY_MATCH
  if (re.op === 'literalString') {
    if (n >= re.runes.length) return EMPTY_MATCH
    if (n === re.runes.length - 1)
      return { op: 'literal', rune: re.runes[re.runes.length - 1]!, fold: re.fold }
    return { op: 'literalString', runes: re.runes.slice(n), fold: re.fold }
  }
  return re
}

function leadingRegexp(re: Node): Node | null {
  if (re.op === 'emptyMatch') return null
  if (re.op === 'concat' && re.subs.length >= 2) {
    const first = re.subs[0]!
    return first.op === 'emptyMatch' ? null : first
  }
  return re
}

function removeLeadingRegexp(re: Node): Node {
  if (re.op === 'emptyMatch') return re
  if (re.op === 'concat' && re.subs.length >= 2) {
    if (re.subs[0]!.op === 'emptyMatch') return re
    const rest = re.subs.slice(1)
    return rest.length === 1 ? rest[0]! : { op: 'concat', subs: rest }
  }
  return EMPTY_MATCH
}

function isRound2Prefix(first: Node): boolean {
  switch (first.op) {
    case 'beginLine':
    case 'endLine':
    case 'wordBoundary':
    case 'noWordBoundary':
    case 'beginText':
    case 'endText':
    case 'charClass':
    case 'anyChar':
    case 'anyByte':
      return true
    case 'repeat':
      return (
        first.min === first.max &&
        (first.sub.op === 'literal' ||
          first.sub.op === 'charClass' ||
          first.sub.op === 'anyChar' ||
          first.sub.op === 'anyByte')
      )
    default:
      return false
  }
}

function factorAlternation(input: Node[]): Node[] {
  // Round 1: common literal prefixes.
  let subs = input
  let out: Node[] = []
  let start = 0
  let prefix: number[] = []
  let prefixFold: boolean | null = null
  const flushRound1 = (end: number): void => {
    if (end - start >= 2) {
      const suffixes = subs.slice(start, end).map((s) => removeLeadingString(s, prefix.length))
      const factored = factorAlternation(suffixes)
      const prefixNode: Node =
        prefix.length === 1
          ? { op: 'literal', rune: prefix[0]!, fold: prefixFold === true }
          : { op: 'literalString', runes: prefix.slice(), fold: prefixFold === true }
      out.push({ op: 'concat', subs: [prefixNode, alternateNoFactor(factored)] })
    } else {
      for (let j = start; j < end; j++) out.push(subs[j]!)
    }
  }
  for (let i = 0; i <= subs.length; i++) {
    if (i < subs.length) {
      const ls = leadingString(subs[i]!)
      const fold = leadingStringFlags(subs[i]!)
      if (i > start && fold !== null && fold === prefixFold && ls) {
        let same = 0
        while (same < prefix.length && same < ls.runes.length && prefix[same] === ls.runes[same])
          same++
        if (same > 0) {
          prefix = prefix.slice(0, same)
          continue
        }
      }
    }
    flushRound1(i)
    if (i < subs.length) {
      start = i
      const ls = leadingString(subs[i]!)
      prefix = ls ? ls.runes.slice() : []
      prefixFold = leadingStringFlags(subs[i]!)
    }
  }
  subs = out

  // Round 2: common leading regexps of restricted shapes.
  out = []
  start = 0
  let first: Node | null = null
  const flushRound2 = (end: number): void => {
    if (end - start >= 2 && first) {
      const suffixes = subs.slice(start, end).map(removeLeadingRegexp)
      const factored = factorAlternation(suffixes)
      out.push({ op: 'concat', subs: [first, alternateNoFactor(factored)] })
    } else {
      for (let j = start; j < end; j++) out.push(subs[j]!)
    }
  }
  for (let i = 0; i <= subs.length; i++) {
    if (i < subs.length) {
      const firstI = leadingRegexp(subs[i]!)
      if (i > start && first && firstI && isRound2Prefix(first) && nodesEqual(first, firstI))
        continue
    }
    flushRound2(i)
    if (i < subs.length) {
      start = i
      first = leadingRegexp(subs[i]!)
    }
  }
  subs = out

  // Round 3: merge runs of single characters and classes into one class.
  out = []
  start = 0
  const isCharLike = (n: Node): boolean => n.op === 'literal' || n.op === 'charClass'
  const flushRound3 = (end: number): void => {
    if (end - start >= 2) {
      const cc = new CharClassBuilder()
      for (let j = start; j < end; j++) {
        const re = subs[j]!
        if (re.op === 'charClass') for (const [lo, hi] of re.ranges) cc.addRange(lo, hi)
        else if (re.op === 'literal') cc.addRangeFlags(re.rune, re.rune, re.fold)
      }
      out.push(charClassNode(cc))
    } else {
      for (let j = start; j < end; j++) out.push(subs[j]!)
    }
  }
  for (let i = 0; i <= subs.length; i++) {
    if (i < subs.length && i > start && isCharLike(subs[start]!) && isCharLike(subs[i]!)) continue
    flushRound3(i)
    if (i < subs.length) start = i
  }
  return out
}

function alternate(subs: Node[]): Node {
  if (subs.length === 1) return subs[0]!
  if (subs.length === 0) return { op: 'noMatch' }
  const factored = factorAlternation(subs)
  return alternateNoFactor(factored)
}

// ---------------------------------------------------------------------------------------------
// Parser (port of RE2 `Regexp::ParseState`).

interface Flags {
  foldCase: boolean
  nonGreedy: boolean
  dotNL: boolean
  oneLine: boolean
  neverCapture: boolean
}

/**
 * The parse flags that can differ between two nodes of one pattern (`(?i)`, `(?U)`, `(?s)`,
 * `(?m)`), packed so repeat nodes can be compared the way RE2 compares `parse_flags()` when it
 * squashes nested repetition.
 */
const PF_FOLD = 1
const PF_NONGREEDY = 2
const PF_DOTNL = 4
const PF_MULTILINE = 8

function parseFlagsKey(f: Flags): number {
  return (
    (f.foldCase ? PF_FOLD : 0) |
    (f.nonGreedy ? PF_NONGREEDY : 0) |
    (f.dotNL ? PF_DOTNL : 0) |
    (f.oneLine ? 0 : PF_MULTILINE)
  )
}

type StackEntry =
  | { kind: 'node'; node: Node }
  | { kind: 'leftParen'; cap: number; name: string | null; flags: Flags }
  | { kind: 'verticalBar' }

const CAPTURE_NAME = /^[\p{Lu}\p{Ll}\p{Lt}\p{Lm}\p{Lo}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]+$/u

class Parser {
  private readonly stack: StackEntry[] = []
  private flags: Flags
  private ncap = 0
  private readonly t: number[]
  private pos = 0

  constructor(input: number[], flags: Flags) {
    this.t = input
    this.flags = { ...flags }
  }

  get captureCount(): number {
    return this.ncap
  }

  private fail(code: string, arg: string): never {
    throw new RegexSyntaxError(code, arg)
  }

  private text(from: number, to: number): string {
    return String.fromCharCode(...this.t.slice(from, Math.min(to, this.t.length)))
  }

  private peek(offset = 0): number {
    return this.t[this.pos + offset] ?? -1
  }

  private remaining(): number {
    return this.t.length - this.pos
  }

  // -- stack helpers ------------------------------------------------------------------------

  private top(): StackEntry | undefined {
    return this.stack[this.stack.length - 1]
  }

  private pushNode(node: Node): void {
    // RE2 `PushRegexp`: single-rune classes become literals, [Aa] pairs fold-case literals.
    if (node.op === 'charClass') {
      const cc = new CharClassBuilder()
      cc.ranges = node.ranges.map(([lo, hi]) => [lo, hi])
      cc.removeAbove(RUNE_MAX)
      if (cc.size() === 1) {
        node = { op: 'literal', rune: cc.ranges[0]![0], fold: this.flags.foldCase }
      } else if (cc.size() === 2) {
        const r = cc.ranges[0]![0]
        if (r >= 0x41 && r <= 0x5a && cc.contains(r + 0x20))
          node = { op: 'literal', rune: r + 0x20, fold: true }
        else node = charClassNode(cc)
      } else {
        node = charClassNode(cc)
      }
    }
    this.maybeConcatString(-1, false)
    this.stack.push({ kind: 'node', node })
  }

  /**
   * RE2 `MaybeConcatString`: merge the two literal nodes on top of the stack into one string;
   * when `r >= 0` the top literal is then replaced by `r` (the caller is pushing a new literal).
   */
  private maybeConcatString(r: number, fold: boolean): boolean {
    const n = this.stack.length
    if (n < 2) return false
    const e1 = this.stack[n - 1]!
    const e2 = this.stack[n - 2]!
    if (e1.kind !== 'node' || e2.kind !== 'node') return false
    const re1 = e1.node
    const re2 = e2.node
    if (re1.op !== 'literal' && re1.op !== 'literalString') return false
    if (re2.op !== 'literal' && re2.op !== 'literalString') return false
    if (re1.fold !== re2.fold) return false
    const runes = re2.op === 'literal' ? [re2.rune] : re2.runes.slice()
    if (re1.op === 'literal') runes.push(re1.rune)
    else runes.push(...re1.runes)
    e2.node = { op: 'literalString', runes, fold: re2.fold }
    if (r >= 0) {
      e1.node = { op: 'literal', rune: r, fold }
      return true
    }
    this.stack.pop()
    return false
  }

  /**
   * RE2 `PushLiteral` (Latin-1): a case-folded ASCII letter becomes the class `[Aa]`, which
   * `pushNode` collapses back into a fold-case literal. Every other literal carries the parser's
   * current FoldCase flag, so in case-insensitive mode `:` and `a` merge into one string.
   */
  private pushLiteral(r: number): void {
    if (this.flags.foldCase && ((r >= 0x41 && r <= 0x5a) || (r >= 0x61 && r <= 0x7a))) {
      const cc = new CharClassBuilder()
      cc.addRangeFlags(r, r, true)
      this.pushNode(charClassNode(cc))
      return
    }
    if (this.maybeConcatString(r, this.flags.foldCase)) return
    this.pushNode({ op: 'literal', rune: r, fold: this.flags.foldCase })
  }

  private pushSimpleOp(op: Node['op']): void {
    this.pushNode({ op } as Node)
  }

  private pushDot(): void {
    if (this.flags.dotNL) {
      this.pushSimpleOp('anyChar')
      return
    }
    const cc = new CharClassBuilder()
    cc.addRange(0, 0x09)
    cc.addRange(0x0b, RUNE_MAX)
    this.pushNode(charClassNode(cc))
  }

  private pushRepeatOp(op: RepeatOp, opText: string, nonGreedy: boolean): void {
    const top = this.top()
    if (!top || top.kind !== 'node') this.fail('missing argument to repetition operator', opText)
    const pf = parseFlagsKey(this.flags) ^ (nonGreedy ? PF_NONGREEDY : 0)
    const sub = top.node
    // Squash ** to *, ++ to +, ?? to ?; and *+, *?, +*, +?, ?* and ?+ to * (same flags only).
    if ((sub.op === 'star' || sub.op === 'plus' || sub.op === 'quest') && sub.pf === pf) {
      if (sub.op === op) return
      top.node = { op: 'star', sub: sub.sub, nonGreedy: sub.nonGreedy, pf }
      return
    }
    top.node = { op, sub, nonGreedy: (pf & PF_NONGREEDY) !== 0, pf }
  }

  private pushRepetition(min: number, max: number, opText: string, nonGreedy: boolean): void {
    if ((max !== -1 && max < min) || min > MAX_REPEAT || max > MAX_REPEAT) {
      this.fail('bad repetition operator', opText)
    }
    const top = this.top()
    if (!top || top.kind !== 'node') this.fail('missing argument to repetition operator', opText)
    const pf = parseFlagsKey(this.flags) ^ (nonGreedy ? PF_NONGREEDY : 0)
    const node: Node = {
      op: 'repeat',
      sub: top.node,
      min,
      max,
      nonGreedy: (pf & PF_NONGREEDY) !== 0,
      pf
    }
    top.node = node
    if (min >= 2 || max >= 2) {
      // RE2 `RepetitionWalker`: the product of nested repeat counts must stay within the limit.
      const walk = (n: Node, budget: number): number => {
        let arg = budget
        if (n.op === 'repeat') {
          const m = n.max < 0 ? n.min : n.max
          if (m > 0) arg = Math.floor(arg / m)
        }
        let result = arg
        const children = 'subs' in n ? n.subs : 'sub' in n ? [n.sub] : []
        for (const child of children) result = Math.min(result, walk(child, arg))
        return result
      }
      if (walk(node, MAX_REPEAT) === 0) this.fail('bad repetition operator', opText)
    }
  }

  private doLeftParen(name: string | null): void {
    this.maybeConcatString(-1, false)
    this.stack.push({ kind: 'leftParen', cap: ++this.ncap, name, flags: { ...this.flags } })
  }

  private doLeftParenNoCapture(): void {
    this.maybeConcatString(-1, false)
    this.stack.push({ kind: 'leftParen', cap: -1, name: null, flags: { ...this.flags } })
  }

  /** Collapse the nodes above the nearest marker into one concat / alternate node. */
  private doCollapse(op: 'concat' | 'alternate'): void {
    const items: Node[] = []
    while (this.stack.length > 0) {
      const top = this.top()!
      if (top.kind !== 'node') break
      items.unshift(top.node)
      this.stack.pop()
    }
    const flat: Node[] = []
    for (const n of items) {
      if (n.op === op) flat.push(...n.subs)
      else flat.push(n)
    }
    const node = op === 'concat' ? concat(flat) : alternate(flat)
    this.stack.push({ kind: 'node', node })
  }

  private doConcatenation(): void {
    const top = this.top()
    if (!top || top.kind !== 'node') this.stack.push({ kind: 'node', node: EMPTY_MATCH })
    this.maybeConcatString(-1, false)
    this.doCollapse('concat')
  }

  private doVerticalBar(): void {
    this.maybeConcatString(-1, false)
    this.doConcatenation()
    const n = this.stack.length
    const r1 = this.stack[n - 1]
    const r2 = this.stack[n - 2]
    if (r1 && r1.kind === 'node' && r2 && r2.kind === 'verticalBar') {
      const r3 = this.stack[n - 3]
      if (r3 && r3.kind === 'node' && (r1.node.op === 'anyChar' || r3.node.op === 'anyChar')) {
        const charLike = (x: Node): boolean =>
          x.op === 'literal' || x.op === 'charClass' || x.op === 'anyChar'
        if (r3.node.op === 'anyChar' && charLike(r1.node)) {
          this.stack.pop()
          return
        }
        if (r1.node.op === 'anyChar' && charLike(r3.node)) {
          // Drop r3 and keep the bar on top: ... r3 | r1 -> ... r1 |
          this.stack.splice(n - 3, 1)
          this.stack[n - 3] = r1
          this.stack[n - 2] = r2
          return
        }
      }
      // Swap so the bar stays on top: ... r1 | -> ... | r1
      this.stack[n - 2] = r1
      this.stack[n - 1] = r2
      return
    }
    this.stack.push({ kind: 'verticalBar' })
  }

  private doAlternation(): void {
    this.doVerticalBar()
    // The bar is on top; remove it, then collapse the alternatives.
    this.stack.pop()
    this.doCollapse('alternate')
  }

  private doRightParen(): void {
    this.doAlternation()
    const n = this.stack.length
    const r1 = this.stack[n - 1]
    const r2 = this.stack[n - 2]
    if (!r1 || r1.kind !== 'node' || !r2 || r2.kind !== 'leftParen') {
      this.fail('unexpected )', this.text(0, this.t.length))
    }
    this.stack.length = n - 2
    this.flags = { ...r2.flags }
    const node: Node = r2.cap > 0 ? { op: 'capture', sub: r1.node, cap: r2.cap } : r1.node
    this.pushNode(node)
  }

  private doFinish(): Node {
    this.doAlternation()
    if (this.stack.length !== 1) this.fail('missing )', this.text(0, this.t.length))
    const top = this.top()!
    if (top.kind !== 'node') this.fail('missing )', this.text(0, this.t.length))
    return top.node
  }

  // -- lexing helpers -----------------------------------------------------------------------

  private parseInteger(): number | null {
    const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39
    if (!isDigit(this.peek())) return null
    if (this.peek() === 0x30 && isDigit(this.peek(1))) return null
    let n = 0
    while (isDigit(this.peek())) {
      if (n >= 100000000) return null
      n = n * 10 + (this.peek() - 0x30)
      this.pos++
    }
    return n
  }

  /** RE2 `MaybeParseRepetition`; leaves `pos` untouched when the brace is a literal. */
  private maybeParseRepetition(): { lo: number; hi: number } | null {
    const save = this.pos
    const restore = (): null => {
      this.pos = save
      return null
    }
    if (this.peek() !== 0x7b) return null
    this.pos++
    const lo = this.parseInteger()
    if (lo === null || this.remaining() === 0) return restore()
    let hi: number
    if (this.peek() === 0x2c) {
      this.pos++
      if (this.remaining() === 0) return restore()
      if (this.peek() === 0x7d) hi = -1
      else {
        const parsed = this.parseInteger()
        if (parsed === null) return restore()
        hi = parsed
      }
    } else {
      hi = lo
    }
    if (this.peek() !== 0x7d) return restore()
    this.pos++
    return { lo, hi }
  }

  private static isHex(c: number): boolean {
    return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)
  }

  private static unHex(c: number): number {
    if (c >= 0x30 && c <= 0x39) return c - 0x30
    if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10
    return c - 0x61 + 10
  }

  /** RE2 `ParseEscape`: `pos` is at the backslash. */
  private parseEscape(): number {
    const begin = this.pos
    if (this.remaining() === 1) this.fail('trailing \\', '')
    this.pos++
    const c = this.t[this.pos++]!
    const bad = (): never => this.fail('invalid escape sequence', this.text(begin, this.pos))
    const isOctal = (x: number): boolean => x >= 0x30 && x <= 0x37
    if (c >= 0x31 && c <= 0x37) {
      // A single non-zero digit would be a backreference, which RE2 does not support.
      if (!isOctal(this.peek())) bad()
    }
    if (c >= 0x30 && c <= 0x37) {
      let code = c - 0x30
      if (isOctal(this.peek())) {
        code = code * 8 + (this.t[this.pos++]! - 0x30)
        if (isOctal(this.peek())) code = code * 8 + (this.t[this.pos++]! - 0x30)
      }
      if (code > RUNE_MAX) bad()
      return code
    }
    switch (c) {
      case 0x78: {
        // \x
        if (this.remaining() === 0) bad()
        const c1 = this.t[this.pos++]!
        if (c1 === 0x7b) {
          let nhex = 0
          let code = 0
          for (;;) {
            if (this.remaining() === 0) bad()
            const d = this.t[this.pos++]!
            if (d === 0x7d) break
            if (!Parser.isHex(d)) bad()
            nhex++
            code = code * 16 + Parser.unHex(d)
            if (code > RUNE_MAX) bad()
          }
          if (nhex === 0) bad()
          return code
        }
        if (this.remaining() === 0) bad()
        const c2 = this.t[this.pos++]!
        if (!Parser.isHex(c1) || !Parser.isHex(c2)) bad()
        return Parser.unHex(c1) * 16 + Parser.unHex(c2)
      }
      case 0x6e:
        return 0x0a
      case 0x72:
        return 0x0d
      case 0x74:
        return 0x09
      case 0x61:
        return 0x07
      case 0x66:
        return 0x0c
      case 0x76:
        return 0x0b
      default:
        if (
          c < 0x80 &&
          !((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a))
        )
          return c
        return bad()
    }
  }

  /** `\d`-style class escape at `pos`, or null. */
  private maybePerlClassEscape(): UGroup | null {
    if (this.remaining() < 2 || this.peek() !== 0x5c) return null
    const g = PERL_GROUPS[this.text(this.pos, this.pos + 2)]
    if (!g) return null
    this.pos += 2
    return g
  }

  /** `\p{Name}` / `\pL` at `pos`; returns null when not a Unicode group escape. */
  private maybeUnicodeGroup(cc: CharClassBuilder): boolean {
    if (this.remaining() < 2 || this.peek() !== 0x5c) return false
    const c = this.peek(1)
    if (c !== 0x70 && c !== 0x50) return false
    const seqStart = this.pos
    let sign: 1 | -1 = c === 0x50 ? -1 : 1
    this.pos += 2
    if (this.remaining() === 0)
      this.fail('invalid character class range', this.text(seqStart, this.pos))
    let name: string
    if (this.peek() !== 0x7b) {
      name = String.fromCharCode(this.t[this.pos++]!)
    } else {
      const end = this.t.indexOf(0x7d, this.pos)
      if (end < 0) this.fail('invalid character class range', this.text(seqStart, this.t.length))
      name = this.text(this.pos + 1, end)
      this.pos = end + 1
    }
    if (name.startsWith('^')) {
      sign = sign === 1 ? -1 : 1
      name = name.slice(1)
    }
    const ranges = lookupUnicodeGroup(name)
    if (!ranges) this.fail('invalid character class range', this.text(seqStart, this.pos))
    addUGroup(cc, { sign: 1, ranges }, sign, this.flags.foldCase)
    return true
  }

  private parseClassChar(wholeClassStart: number): number {
    if (this.remaining() === 0)
      this.fail('missing closing ]', this.text(wholeClassStart, this.t.length))
    if (this.peek() === 0x5c) return this.parseEscape()
    return this.t[this.pos++]!
  }

  private parseCharClass(): Node {
    const start = this.pos
    this.pos++ // '['
    const cc = new CharClassBuilder()
    let negated = false
    if (this.peek() === 0x5e) {
      this.pos++
      negated = true
    }
    let first = true
    while (this.remaining() > 0 && (this.peek() !== 0x5d || first)) {
      first = false
      if (this.remaining() > 2 && this.peek() === 0x5b && this.peek(1) === 0x3a) {
        const close = this.text(this.pos, this.t.length).indexOf(':]', 2)
        if (close >= 0) {
          const name = this.text(this.pos + 2, this.pos + close)
          const negatedName = name.startsWith('^')
          const ranges = POSIX_RANGES[negatedName ? name.slice(1) : name]
          if (!ranges)
            this.fail('invalid character class range', this.text(this.pos, this.pos + close + 2))
          this.pos += close + 2
          addUGroup(cc, { sign: 1, ranges }, negatedName ? -1 : 1, this.flags.foldCase)
          continue
        }
      }
      if (this.remaining() > 2 && this.maybeUnicodeGroup(cc)) continue
      const perl = this.maybePerlClassEscape()
      if (perl) {
        addUGroup(cc, perl, perl.sign, this.flags.foldCase)
        continue
      }
      const rangeStart = this.pos
      const lo = this.parseClassChar(start)
      let hi = lo
      if (this.remaining() >= 2 && this.peek() === 0x2d && this.peek(1) !== 0x5d) {
        this.pos++
        hi = this.parseClassChar(start)
        if (hi < lo) this.fail('invalid character class range', this.text(rangeStart, this.pos))
      }
      cc.addRangeFlags(lo, hi, this.flags.foldCase)
    }
    if (this.remaining() === 0) this.fail('missing closing ]', this.text(start, this.t.length))
    this.pos++ // ']'
    if (negated) cc.negate()
    return charClassNode(cc)
  }

  private parsePerlFlags(): void {
    // pos at "(?"
    const start = this.pos
    const c2 = this.peek(2)
    const c3 = this.peek(3)
    if (
      (this.remaining() > 3 && (c2 === 0x3d || c2 === 0x21)) ||
      (this.remaining() > 4 && c2 === 0x3c && (c3 === 0x3d || c3 === 0x21))
    ) {
      this.fail(
        'invalid or unsupported Perl syntax',
        this.text(start, start + (c2 === 0x3c ? 4 : 3))
      )
    }
    if (
      (this.remaining() > 4 && c2 === 0x50 && c3 === 0x3c) ||
      (this.remaining() > 3 && c2 === 0x3c)
    ) {
      const begin = c2 === 0x50 ? 4 : 3
      const end = this.t.indexOf(0x3e, this.pos + begin)
      if (end < 0) this.fail('invalid named capture group', this.text(start, this.t.length))
      const name = this.text(this.pos + begin, end)
      if (!CAPTURE_NAME.test(name))
        this.fail('invalid named capture group', this.text(start, end + 1))
      this.doLeftParen(name)
      this.pos = end + 1
      return
    }
    this.pos += 2
    let negated = false
    let sawFlags = false
    const nflags = { ...this.flags }
    for (let done = false; !done;) {
      if (this.remaining() === 0)
        this.fail('invalid or unsupported Perl syntax', this.text(start, this.pos))
      const c = this.t[this.pos++]!
      switch (c) {
        case 0x69: // i
          sawFlags = true
          nflags.foldCase = !negated
          break
        case 0x6d: // m: opposite of RE2's OneLine
          sawFlags = true
          nflags.oneLine = negated
          break
        case 0x73: // s
          sawFlags = true
          nflags.dotNL = !negated
          break
        case 0x55: // U
          sawFlags = true
          nflags.nonGreedy = !negated
          break
        case 0x2d: // -
          if (negated) this.fail('invalid or unsupported Perl syntax', this.text(start, this.pos))
          negated = true
          sawFlags = false
          break
        case 0x3a: // :
          this.doLeftParenNoCapture()
          done = true
          break
        case 0x29: // )
          done = true
          break
        default:
          this.fail('invalid or unsupported Perl syntax', this.text(start, this.pos))
      }
    }
    if (negated && !sawFlags)
      this.fail('invalid or unsupported Perl syntax', this.text(start, this.pos))
    this.flags = nflags
  }

  parse(): Node {
    let lastUnary = -1
    while (this.remaining() > 0) {
      let isUnary = -1
      const c = this.peek()
      switch (c) {
        case 0x28: {
          // (
          if (this.peek(1) === 0x3f) {
            this.parsePerlFlags()
            break
          }
          if (this.flags.neverCapture) this.doLeftParenNoCapture()
          else this.doLeftParen(null)
          this.pos++
          break
        }
        case 0x7c: // |
          this.doVerticalBar()
          this.pos++
          break
        case 0x29: // )
          this.doRightParen()
          this.pos++
          break
        case 0x5e: // ^
          this.pushSimpleOp(this.flags.oneLine ? 'beginText' : 'beginLine')
          this.pos++
          break
        case 0x24: // $
          this.pushSimpleOp(this.flags.oneLine ? 'endText' : 'endLine')
          this.pos++
          break
        case 0x2e: // .
          this.pushDot()
          this.pos++
          break
        case 0x5b: // [
          this.pushNode(this.parseCharClass())
          break
        case 0x2a:
        case 0x2b:
        case 0x3f: {
          // * + ?
          const op: RepeatOp = c === 0x2a ? 'star' : c === 0x2b ? 'plus' : 'quest'
          const opStart = this.pos
          this.pos++
          let nonGreedy = false
          if (this.peek() === 0x3f) {
            nonGreedy = true
            this.pos++
          }
          if (lastUnary >= 0) this.fail('bad repetition operator', this.text(lastUnary, this.pos))
          this.pushRepeatOp(op, this.text(opStart, this.pos), nonGreedy)
          isUnary = opStart
          break
        }
        case 0x7b: {
          // {
          const opStart = this.pos
          const rep = this.maybeParseRepetition()
          if (!rep) {
            this.pushLiteral(0x7b)
            this.pos++
            break
          }
          let nonGreedy = false
          if (this.peek() === 0x3f) {
            nonGreedy = true
            this.pos++
          }
          if (lastUnary >= 0) this.fail('bad repetition operator', this.text(lastUnary, this.pos))
          this.pushRepetition(rep.lo, rep.hi, this.text(opStart, this.pos), nonGreedy)
          isUnary = opStart
          break
        }
        case 0x5c: {
          // backslash
          const c1 = this.peek(1)
          if (c1 === 0x62 || c1 === 0x42) {
            this.pushSimpleOp(c1 === 0x62 ? 'wordBoundary' : 'noWordBoundary')
            this.pos += 2
            break
          }
          if (c1 === 0x41) {
            this.pushSimpleOp('beginText')
            this.pos += 2
            break
          }
          if (c1 === 0x7a) {
            this.pushSimpleOp('endText')
            this.pos += 2
            break
          }
          if (c1 === 0x43) {
            this.pushSimpleOp('anyByte')
            this.pos += 2
            break
          }
          if (c1 === 0x51) {
            // \Q ... \E
            this.pos += 2
            while (this.remaining() > 0) {
              if (this.remaining() >= 2 && this.peek() === 0x5c && this.peek(1) === 0x45) {
                this.pos += 2
                break
              }
              this.pushLiteral(this.t[this.pos++]!)
            }
            break
          }
          if (c1 === 0x70 || c1 === 0x50) {
            const cc = new CharClassBuilder()
            if (this.maybeUnicodeGroup(cc)) {
              this.pushNode(charClassNode(cc))
              break
            }
          }
          const perl = this.maybePerlClassEscape()
          if (perl) {
            const cc = new CharClassBuilder()
            addUGroup(cc, perl, perl.sign, this.flags.foldCase)
            this.pushNode(charClassNode(cc))
            break
          }
          this.pushLiteral(this.parseEscape())
          break
        }
        default:
          this.pushLiteral(c)
          this.pos++
      }
      lastUnary = isUnary
    }
    return this.doFinish()
  }
}

// ---------------------------------------------------------------------------------------------
// Simplify (RE2 `simplify.cc`: CoalesceWalker then SimplifyWalker).

function canCoalesce(r1: Node, r2: Node): boolean {
  if (
    !('sub' in r1) ||
    (r1.op !== 'star' && r1.op !== 'plus' && r1.op !== 'quest' && r1.op !== 'repeat')
  )
    return false
  const s = r1.sub
  if (s.op !== 'literal' && s.op !== 'charClass' && s.op !== 'anyChar' && s.op !== 'anyByte')
    return false
  if (
    (r2.op === 'star' || r2.op === 'plus' || r2.op === 'quest' || r2.op === 'repeat') &&
    nodesEqual(s, r2.sub) &&
    r1.nonGreedy === r2.nonGreedy
  ) {
    return true
  }
  if (nodesEqual(s, r2)) return true
  if (
    s.op === 'literal' &&
    r2.op === 'literalString' &&
    r2.runes[0] === s.rune &&
    s.fold === r2.fold
  )
    return true
  return false
}

function doCoalesce(r1: Node, r2: Node): [Node, Node] {
  if (!('sub' in r1) || r1.op === 'capture') return [r1, r2]
  let min: number
  let max: number
  switch (r1.op) {
    case 'star':
      min = 0
      max = -1
      break
    case 'plus':
      min = 1
      max = -1
      break
    case 'quest':
      min = 0
      max = 1
      break
    default:
      min = r1.min
      max = r1.max
  }
  const { nonGreedy, pf } = r1
  const make = (): Node => ({ op: 'repeat', sub: r1.sub, min, max, nonGreedy, pf })
  switch (r2.op) {
    case 'star':
      max = -1
      return [EMPTY_MATCH, make()]
    case 'plus':
      min++
      max = -1
      return [EMPTY_MATCH, make()]
    case 'quest':
      if (max !== -1) max++
      return [EMPTY_MATCH, make()]
    case 'repeat':
      min += r2.min
      if (r2.max === -1) max = -1
      else if (max !== -1) max += r2.max
      return [EMPTY_MATCH, make()]
    case 'literal':
    case 'charClass':
    case 'anyChar':
    case 'anyByte':
      min++
      if (max !== -1) max++
      return [EMPTY_MATCH, make()]
    case 'literalString': {
      const r = (r1.sub as { rune: number }).rune
      let n = 1
      while (n < r2.runes.length && r2.runes[n] === r) n++
      min += n
      if (max !== -1) max += n
      if (n === r2.runes.length) return [EMPTY_MATCH, make()]
      const rest = r2.runes.slice(n)
      const restNode: Node =
        rest.length === 1
          ? { op: 'literal', rune: rest[0]!, fold: r2.fold }
          : { op: 'literalString', runes: rest, fold: r2.fold }
      return [make(), restNode]
    }
    default:
      return [r1, r2]
  }
}

function coalesce(re: Node): Node {
  if (!('subs' in re) && !('sub' in re)) return re
  if ('sub' in re) return { ...re, sub: coalesce(re.sub) } as Node
  const children = re.subs.map(coalesce)
  if (re.op !== 'concat') return { op: re.op, subs: children }
  let can = false
  for (let i = 0; i + 1 < children.length; i++)
    if (canCoalesce(children[i]!, children[i + 1]!)) can = true
  if (!can) return { op: 'concat', subs: children }
  for (let i = 0; i + 1 < children.length; i++) {
    if (canCoalesce(children[i]!, children[i + 1]!)) {
      const [a, b] = doCoalesce(children[i]!, children[i + 1]!)
      children[i] = a
      children[i + 1] = b
    }
  }
  return { op: 'concat', subs: children.filter((c) => c.op !== 'emptyMatch') }
}

/**
 * RE2 `Regexp::StarPlusOrQuest`: `x**`, `x++`, `x??` collapse to one operator and any mixed pair
 * collapses to `x*`, provided both carry the same parse flags.
 */
function starPlusOrQuest(op: RepeatOp, sub: Node, pf: number): Node {
  if ((sub.op === 'star' || sub.op === 'plus' || sub.op === 'quest') && sub.pf === pf) {
    if (sub.op === op || sub.op === 'star') return sub
    return { op: 'star', sub: sub.sub, nonGreedy: sub.nonGreedy, pf }
  }
  return { op, sub, nonGreedy: (pf & PF_NONGREEDY) !== 0, pf }
}

function simplifyRepeat(re: Node, min: number, max: number, pf: number): Node {
  if (
    isEmptyWidthOp(re) ||
    ((re.op === 'concat' || re.op === 'alternate') && re.subs.every(isEmptyWidthOp))
  ) {
    min = Math.min(min, 1)
    max = Math.min(max, 1)
  }
  if (max === -1) {
    if (min === 0) return starPlusOrQuest('star', re, pf)
    if (min === 1) return starPlusOrQuest('plus', re, pf)
    const subs: Node[] = []
    for (let i = 0; i < min - 1; i++) subs.push(re)
    subs.push(starPlusOrQuest('plus', re, pf))
    return { op: 'concat', subs }
  }
  if (min === 0 && max === 0) return EMPTY_MATCH
  if (min === 1 && max === 1) return re
  let nre: Node | null = null
  if (min > 0) {
    const subs: Node[] = []
    for (let i = 0; i < min; i++) subs.push(re)
    nre = subs.length === 1 ? subs[0]! : { op: 'concat', subs }
  }
  if (max > min) {
    let suf: Node = starPlusOrQuest('quest', re, pf)
    for (let i = min + 1; i < max; i++)
      suf = starPlusOrQuest('quest', { op: 'concat', subs: [re, suf] }, pf)
    nre = nre === null ? suf : { op: 'concat', subs: [nre, suf] }
  }
  return nre ?? { op: 'noMatch' }
}

/** RE2 `SimplifyWalker`; returns the input node itself when nothing below it changed. */
function simplify(re: Node): Node {
  switch (re.op) {
    case 'concat':
    case 'alternate': {
      const subs = re.subs.map(simplify)
      if (subs.every((s, i) => s === re.subs[i])) return re
      return { op: re.op, subs }
    }
    case 'capture': {
      const sub = simplify(re.sub)
      return sub === re.sub ? re : { op: 'capture', sub, cap: re.cap }
    }
    case 'star':
    case 'plus':
    case 'quest': {
      const sub = simplify(re.sub)
      if (sub.op === 'emptyMatch') return sub
      if (sub === re.sub) return re
      // Idempotent when the (changed) child is the same operator with the same flags.
      if (sub.op === re.op && sub.pf === re.pf) return sub
      return { op: re.op, sub, nonGreedy: re.nonGreedy, pf: re.pf }
    }
    case 'repeat': {
      const sub = simplify(re.sub)
      if (sub.op === 'emptyMatch') return sub
      return simplifyRepeat(sub, re.min, re.max, re.pf)
    }
    case 'charClass': {
      // `CharClass::full()` means every Unicode rune; Latin-1 classes were clipped to 0xFF by
      // `pushNode`, so this only fires for classes built by the simplifier itself.
      if (re.ranges.length === 0) return { op: 'noMatch' }
      if (re.ranges.length === 1 && re.ranges[0]![0] === 0 && re.ranges[0]![1] >= 0x10ffff)
        return { op: 'anyChar' }
      return re
    }
    default:
      return re
  }
}

// ---------------------------------------------------------------------------------------------
// Compile (RE2 `Compiler`): count the instructions the Latin-1 program would need.

interface Frag {
  insts: number
  nullable: boolean
  noMatch: boolean
}

function frag(insts: number, nullable: boolean, noMatch = false): Frag {
  return { insts, nullable, noMatch }
}

function compileCharClass(ranges: Range[]): Frag {
  const cc = new CharClassBuilder()
  cc.ranges = ranges.map(([lo, hi]) => [lo, hi])
  const foldAscii = cc.foldsAscii()
  let count = 0
  for (const [lo, hi] of ranges) {
    if (lo > RUNE_MAX) continue
    if (foldAscii && lo >= 0x41 && hi <= 0x5a) continue
    count++
  }
  if (count === 0) return frag(0, false, true)
  return frag(count + (count - 1), false)
}

function compile(re: Node): Frag {
  switch (re.op) {
    case 'noMatch':
      return frag(0, false, true)
    case 'emptyMatch':
      return frag(1, true)
    case 'literal':
      return frag(1, false)
    case 'literalString':
      return re.runes.length === 0 ? frag(1, true) : frag(re.runes.length, false)
    case 'charClass':
      return compileCharClass(re.ranges)
    case 'anyChar':
    case 'anyByte':
      return frag(1, false)
    case 'beginLine':
    case 'endLine':
    case 'beginText':
    case 'endText':
    case 'wordBoundary':
    case 'noWordBoundary':
      return frag(1, true)
    case 'capture': {
      const sub = compile(re.sub)
      if (re.cap < 0) return sub
      if (sub.noMatch) return frag(sub.insts, false, true)
      return frag(sub.insts + 2, sub.nullable)
    }
    case 'star': {
      const sub = compile(re.sub)
      // A nullable body compiles as (a+)? to keep priorities right: two Alt instructions.
      if (sub.nullable) return frag(sub.insts + 2, true)
      return frag(sub.insts + 1, true, false)
    }
    case 'plus': {
      const sub = compile(re.sub)
      return frag(sub.insts + 1, sub.nullable, sub.noMatch)
    }
    case 'quest': {
      const sub = compile(re.sub)
      if (sub.noMatch) return frag(sub.insts + 1, true)
      return frag(sub.insts + 1, true)
    }
    case 'concat': {
      let insts = 0
      let nullable = true
      let noMatch = false
      for (const s of re.subs) {
        const f = compile(s)
        insts += f.insts
        nullable = nullable && f.nullable
        noMatch = noMatch || f.noMatch
      }
      return frag(insts, nullable, noMatch)
    }
    case 'alternate': {
      let insts = 0
      let nullable = false
      let live = 0
      for (const s of re.subs) {
        const f = compile(s)
        insts += f.insts
        if (!f.noMatch) {
          live++
          nullable = nullable || f.nullable
        }
      }
      if (live === 0) return frag(insts, false, true)
      return frag(insts + (live - 1), nullable)
    }
    case 'repeat':
      // Removed by simplify(); treat like the expanded form if ever reached.
      return compile(simplifyRepeat(re.sub, re.min, re.max, re.pf))
  }
}

/** RE2 `IsAnchorStart`: strip a leading `^` (depth-limited), replacing it with an empty string. */
function stripAnchorStart(re: Node, depth = 0): Node | null {
  if (depth >= 4) return null
  switch (re.op) {
    case 'concat': {
      if (re.subs.length === 0) return null
      const first = stripAnchorStart(re.subs[0]!, depth + 1)
      if (!first) return null
      return { op: 'concat', subs: [first, ...re.subs.slice(1)] }
    }
    case 'capture': {
      const sub = stripAnchorStart(re.sub, depth + 1)
      return sub ? { op: 'capture', sub, cap: re.cap } : null
    }
    case 'beginText':
      return { op: 'literalString', runes: [], fold: false }
    default:
      return null
  }
}

function stripAnchorEnd(re: Node, depth = 0): Node | null {
  if (depth >= 4) return null
  switch (re.op) {
    case 'concat': {
      if (re.subs.length === 0) return null
      const last = stripAnchorEnd(re.subs[re.subs.length - 1]!, depth + 1)
      if (!last) return null
      return { op: 'concat', subs: [...re.subs.slice(0, -1), last] }
    }
    case 'capture': {
      const sub = stripAnchorEnd(re.sub, depth + 1)
      return sub ? { op: 'capture', sub, cap: re.cap } : null
    }
    case 'endText':
      return { op: 'literalString', runes: [], fold: false }
    default:
      return null
  }
}

/**
 * RE2 `RequiredPrefix`: `^literal...` patterns match the literal with a prefix accelerator and
 * compile only the remainder, which is then unanchored.
 */
function splitRequiredPrefix(re: Node): Node {
  if (re.op !== 'concat') return re
  let i = 0
  while (i < re.subs.length && re.subs[i]!.op === 'beginText') i++
  if (i === 0 || i >= re.subs.length) return re
  const lit = re.subs[i]!
  if (lit.op !== 'literal' && lit.op !== 'literalString') return re
  const rest = re.subs.slice(i + 1)
  if (rest.length === 0) return EMPTY_MATCH
  return concat(rest)
}

function countNodes(re: Node): number {
  let n = 1
  if ('subs' in re) for (const s of re.subs) n += countNodes(s)
  else if ('sub' in re) n += countNodes(re.sub)
  return n
}

/**
 * The compiled size of the forward program, or `Infinity` when RE2's compiler would give up
 * before finishing (`WalkExponential` visits at most `2 * max_ninst` nodes).
 */
function countInstructions(root: Node): number {
  let re = splitRequiredPrefix(root)
  re = simplify(coalesce(re))
  const anchoredStart = stripAnchorStart(re)
  if (anchoredStart) re = anchoredStart
  const anchoredEnd = stripAnchorEnd(re)
  if (anchoredEnd) re = anchoredEnd
  if (countNodes(re) > 2 * RE2_MAX_INSTRUCTIONS) return Infinity
  const body = compile(re)
  // Fail instruction, the body, the Match instruction, and the `.*?` loop of the unanchored
  // entry point (a ByteRange plus an Alt).
  let total = 1 + body.insts + 1
  if (!anchoredStart) total += 2
  return total
}

function toLatin1Runes(pattern: string): number[] {
  const bytes = new TextEncoder().encode(pattern)
  return Array.from(bytes)
}

/** Parse under Chrome's options; throws `RegexSyntaxError` for anything RE2 rejects. */
function parseRE2(
  pattern: string,
  options: RegexCheckOptions
): { root: Node; captureCount: number } {
  const parser = new Parser(toLatin1Runes(pattern), {
    foldCase: !(options.isCaseSensitive ?? false),
    nonGreedy: false,
    dotNL: false,
    oneLine: true,
    neverCapture: !(options.requireCapturing ?? false)
  })
  const root = parser.parse()
  return { root, captureCount: parser.captureCount }
}

/**
 * Mirrors `chrome.declarativeNetRequest.isRegexSupported` for the given options. Note Chrome's
 * API defaults `isCaseSensitive` to true while rules default to case-insensitive matching.
 */
export function checkRegex(pattern: string, options: RegexCheckOptions = {}): RegexCheckResult {
  let parsed: { root: Node; captureCount: number }
  try {
    parsed = parseRE2(pattern, options)
  } catch (error) {
    if (error instanceof RegexSyntaxError)
      return { isSupported: false, reason: 'syntaxError', message: error.message }
    throw error
  }
  const instructions = countInstructions(parsed.root)
  if (instructions > RE2_MAX_INSTRUCTIONS) {
    return {
      isSupported: false,
      reason: 'memoryLimitExceeded',
      message: 'pattern too large - compile failed'
    }
  }
  return { isSupported: true, captureCount: parsed.captureCount, instructions }
}

/**
 * RE2 `CheckRewriteString`: `\0`-`\9` reference groups, `\\` is a literal backslash, anything
 * else after a backslash is an error, as is referencing a group the pattern does not have.
 */
export function checkRegexSubstitution(substitution: string, captureCount: number): boolean {
  let maxToken = -1
  for (let i = 0; i < substitution.length; i++) {
    if (substitution[i] !== '\\') continue
    i++
    if (i >= substitution.length) return false
    const c = substitution[i]!
    if (c === '\\') continue
    if (c < '0' || c > '9') return false
    maxToken = Math.max(maxToken, Number(c))
  }
  return maxToken <= captureCount
}

/**
 * Compile a supported RE2 pattern into a JavaScript `RegExp` for the reference matcher. Only
 * the syntax RE2 and JavaScript share differently needs translation: `\A`/`\z`, `\C`, `\Q..\E`,
 * POSIX classes, Unicode groups and octal escapes; everything else is passed through.
 */
export function toJavaScriptRegExp(pattern: string, caseSensitive: boolean): RegExp {
  const out: string[] = []
  const flags = caseSensitive ? 's' : 'is'
  let i = 0
  let inClass = false
  const posix: Record<string, string> = {
    alnum: '0-9A-Za-z',
    alpha: 'A-Za-z',
    ascii: '\\x00-\\x7f',
    blank: '\\t ',
    cntrl: '\\x00-\\x1f\\x7f',
    digit: '0-9',
    graph: '!-~',
    lower: 'a-z',
    print: ' -~',
    punct: '!-\\/:-@\\[-`{-~',
    space: '\\t-\\r ',
    upper: 'A-Z',
    word: '0-9A-Za-z_',
    xdigit: '0-9A-Fa-f'
  }
  while (i < pattern.length) {
    const c = pattern[i]!
    if (c === '\\' && i + 1 < pattern.length) {
      const n = pattern[i + 1]!
      if (!inClass && n === 'A') {
        out.push('^')
        i += 2
        continue
      }
      if (!inClass && n === 'z') {
        out.push('$')
        i += 2
        continue
      }
      if (!inClass && n === 'C') {
        out.push('[\\s\\S]')
        i += 2
        continue
      }
      if (!inClass && n === 'Q') {
        const end = pattern.indexOf('\\E', i + 2)
        const literal = end < 0 ? pattern.slice(i + 2) : pattern.slice(i + 2, end)
        out.push(literal.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
        i = end < 0 ? pattern.length : end + 2
        continue
      }
      if (n === 'p' || n === 'P') {
        const m = /^\\[pP](\{[^}]*\}|.)/.exec(pattern.slice(i))
        if (m) {
          let name = m[1]!.startsWith('{') ? m[1]!.slice(1, -1) : m[1]!
          let negated = n === 'P'
          if (name.startsWith('^')) {
            negated = !negated
            name = name.slice(1)
          }
          const ranges = lookupUnicodeGroup(name) ?? []
          const body = ranges
            .map(([lo, hi]) =>
              lo === hi ? escapeClassChar(lo) : `${escapeClassChar(lo)}-${escapeClassChar(hi)}`
            )
            .join('')
          out.push(inClass ? body : `[${negated ? '^' : ''}${body}]`)
          i += m[0].length
          continue
        }
      }
      if (/[0-7]/.test(n)) {
        const m = /^\\([0-7]{1,3})/.exec(pattern.slice(i))!
        out.push(escapeClassChar(parseInt(m[1]!, 8)))
        i += m[0].length
        continue
      }
      if (n === 'a') {
        out.push('\\x07')
        i += 2
        continue
      }
      if (n === 'x' && pattern[i + 2] === '{') {
        const end = pattern.indexOf('}', i + 3)
        out.push(escapeClassChar(parseInt(pattern.slice(i + 3, end), 16)))
        i = end + 1
        continue
      }
      out.push(c + n)
      i += 2
      continue
    }
    if (inClass && c === '[' && pattern[i + 1] === ':') {
      const close = pattern.indexOf(':]', i + 2)
      if (close >= 0) {
        let name = pattern.slice(i + 2, close)
        const negated = name.startsWith('^')
        if (negated) name = name.slice(1)
        const body = posix[name]
        if (body !== undefined) {
          // Negated POSIX classes inside a bracket expression have no direct JavaScript form;
          // approximate with the complement over Latin-1.
          if (negated) {
            const cc = new CharClassBuilder()
            for (const [lo, hi] of POSIX_RANGES[name]!) cc.addRange(lo, hi)
            cc.negate()
            cc.removeAbove(RUNE_MAX)
            out.push(
              cc.ranges
                .map(([lo, hi]) =>
                  lo === hi ? escapeClassChar(lo) : `${escapeClassChar(lo)}-${escapeClassChar(hi)}`
                )
                .join('')
            )
          } else {
            out.push(body)
          }
          i = close + 2
          continue
        }
      }
    }
    if (c === '[' && !inClass) {
      inClass = true
      out.push(c)
      i++
      if (pattern[i] === '^') {
        out.push('^')
        i++
      }
      if (pattern[i] === ']') {
        out.push('\\]')
        i++
      }
      continue
    }
    if (c === ']' && inClass) inClass = false
    if (c === '(' && pattern[i + 1] === '?' && pattern[i + 2] === 'P' && pattern[i + 3] === '<') {
      out.push('(?<')
      i += 4
      continue
    }
    out.push(c)
    i++
  }
  return new RegExp(out.join(''), flags)
}

function escapeClassChar(code: number): string {
  return `\\x${code.toString(16).padStart(2, '0')}`
}
