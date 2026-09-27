/**
 * One rule set's structured rules compiled into a struct-of-arrays table: every field the matcher
 * reads is a typed array over the rows, a row is a rule, and what a row cannot hold in a number
 * – a domain list, a method or tab id set, a header condition, a regular expression, a filter
 * string – sits in a side table the row points into with an `Int32Array` of ids. Nothing is
 * allocated per rule on the hot path: `RuleEngine` reads rows by index through the accessors
 * here, the {@link RowIndex} files row numbers in its buckets, and a matched row reaches back to
 * its `Rule` (`ruleOf`) only when a decision is being built.
 *
 * Rows are in resolution order – a stable sort of the set's own order by effective priority,
 * then rank – so a row's index is its `position`: on a full tie the lower row wins, which is the
 * rule the linear scan meets first and what the index's bucket-order visit needs (and what the
 * Kotlin engine does).
 *
 * The strings a row needs (its `urlFilter`, the hostname of a `||host^` selector) are interned
 * once per set in `strings`; a filter is the rule's own string object, so the table adds a
 * reference, not a copy. Domain lists are content-deduplicated – two rules with the same list
 * share one entry – and held in one of the forms of {@link DomainListForm} (sorted arrays by
 * default). `urlFilter` patterns that need a regular expression are compiled the first
 * time their row is a candidate and kept per row; `regexFilter` expressions are compiled when the
 * table is built (their validity decides whether the rule exists at all).
 *
 * The table is built from the set's own `Rule[]` – the rules `setRuleSet` received, which the
 * engine keeps for persistence – and holds nothing else of the caller's.
 */
import { compileHeaderConditions } from './headerCondition'
import {
  EVERY_URL,
  SELECTOR,
  regexSelector,
  typeMask,
  urlFilterSelector,
  type IndexSource,
  type UrlSelector
} from './ruleIndex'
import type { HeaderCondition, Rule } from './rules'
import { compileRegexFilter, urlFilterToRegExpSource } from './urlFilter'

// -------------------------------------------------------------------------------------------
// Codes
// -------------------------------------------------------------------------------------------

/** `Rule.action.type` as a row code. */
export const ACTION = {
  other: 0,
  block: 1,
  allow: 2,
  allowAllRequests: 3,
  redirect: 4,
  upgradeScheme: 5,
  modifyHeaders: 6
} as const

const ACTION_CODES: Record<string, number> = {
  block: ACTION.block,
  allow: ACTION.allow,
  allowAllRequests: ACTION.allowAllRequests,
  redirect: ACTION.redirect,
  upgradeScheme: ACTION.upgradeScheme,
  modifyHeaders: ACTION.modifyHeaders
}

/**
 * Tie-break order inside one priority, by `ACTION` code: allow > allowAllRequests > block >
 * upgradeScheme > redirect > modifyHeaders (and unknown types).
 */
const ACTION_RANK = Uint8Array.of(0, 3, 5, 4, 1, 2, 0)

/** Row flags (`flags`). */
export const FLAG = {
  allowAll: 1,
  headerStage: 2,
  excludedNonUniqueHosts: 4,
  firstParty: 8,
  thirdParty: 16,
  caseSensitive: 32
} as const

/** How a row tests the URL (`urlKind`). */
export const URL_KIND = {
  /** No `urlFilter` and no `regexFilter`: every URL. */
  none: 0,
  /** A plain substring (no anchors, no wildcards), compared without regard to case. */
  plain: 1,
  /** A plain substring compared case-sensitively. */
  plainCaseSensitive: 2,
  /** A `urlFilter` with anchors or wildcards: a regular expression, compiled on first use. */
  pattern: 3,
  /** A `regexFilter`, compiled when the table is built. */
  regex: 4
} as const

const RULE_PRIORITY_BITS = 20
const RULE_PRIORITY_MAX = (1 << RULE_PRIORITY_BITS) - 1

/** A rule's priority clamped to what the effective priority holds. */
function rulePriority(priority: number | undefined): number {
  return Math.min(Math.max(1, Math.floor(priority ?? 1)), RULE_PRIORITY_MAX)
}

/** The set's priority band times the rule's priority: what claims are compared by. */
export function effectivePriority(setPriority: number, priority: number | undefined): number {
  return setPriority * (RULE_PRIORITY_MAX + 1) + rulePriority(priority)
}

/** The priority band (the set priority) an effective priority belongs to. */
export function bandOf(effective: number): number {
  return Math.floor(effective / (RULE_PRIORITY_MAX + 1))
}

/** The rank of an action type name (unknown types rank lowest, like `modifyHeaders`). */
export function rankOf(actionType: string): number {
  return ACTION_RANK[ACTION_CODES[actionType] ?? ACTION.other]!
}

// -------------------------------------------------------------------------------------------
// Domain lists
// -------------------------------------------------------------------------------------------

/**
 * One domain condition list (`requestDomains`, `initiatorDomains`, …) of a set: lowercase
 * domains, looked up by a host's suffixes. `hostMatchesDomain(host, d)` for some `d` of the list
 * is a membership test over the host's suffixes: a list of tens of thousands of domains (uBlock
 * Origin Lite folds whole hosts files into one rule's `requestDomains`) costs as many lookups as
 * the host has labels.
 */
export interface DomainList {
  readonly size: number
  has(domain: string): boolean
  /** Whether one of the host's suffixes (`hostSuffixes`) is in the list. */
  hasAny(suffixes: readonly string[]): boolean
  /** The domains, for the index to file a rule under each (small lists only). */
  domains(): Iterable<string>
}

/**
 * The in-memory form of a set's domain lists. Every form answers the same membership questions;
 * they differ in what they cost per listed domain next to the `Rule[]` the engine keeps anyway
 * (whose strings, already lowercase, `toLowerCase()` hands back as the same objects):
 *
 * - `set`: a `Set` per list – what `compileRule` held before the table (~26 bytes of table per
 *   entry on V8, the strings shared with the rules).
 * - `sorted`: a sorted array of the strings per list, binary search – 8 bytes per entry, the
 *   strings shared; the twin of the Kotlin engine's `SortedDomainSet`. The default.
 * - `blob`: ONE sorted UTF-8 byte blob per set with an offsets array, binary search on the bytes
 *   – no string objects of its own (~4 bytes of offsets plus the characters per entry), but the
 *   characters are a second copy while the rules' strings are retained; the form for an engine
 *   that lets the `Rule[]` go.
 */
export type DomainListForm = 'set' | 'sorted' | 'blob'

/** Every form, for a measurement to try each. */
export const DOMAIN_LIST_FORMS: readonly DomainListForm[] = ['set', 'sorted', 'blob']

/** A list as a `Set` of its strings. */
export class SetDomainList implements DomainList {
  constructor(private readonly set: ReadonlySet<string>) {}

  get size(): number {
    return this.set.size
  }

  has(domain: string): boolean {
    return this.set.has(domain)
  }

  hasAny(suffixes: readonly string[]): boolean {
    for (let i = 0; i < suffixes.length; i++) if (this.set.has(suffixes[i]!)) return true
    return false
  }

  domains(): Iterable<string> {
    return this.set
  }
}

/** A list as a sorted array of its distinct strings, searched by bisection. */
export class SortedDomainList implements DomainList {
  /** @param sorted Distinct, in code unit order (`Array.prototype.sort` without a comparator). */
  constructor(private readonly sorted: readonly string[]) {}

  get size(): number {
    return this.sorted.length
  }

  has(domain: string): boolean {
    const sorted = this.sorted
    let low = 0
    let high = sorted.length - 1
    while (low <= high) {
      const mid = (low + high) >>> 1
      const entry = sorted[mid]!
      if (entry < domain) low = mid + 1
      else if (entry > domain) high = mid - 1
      else return true
    }
    return false
  }

  hasAny(suffixes: readonly string[]): boolean {
    for (let i = 0; i < suffixes.length; i++) if (this.has(suffixes[i]!)) return true
    return false
  }

  domains(): Iterable<string> {
    return this.sorted
  }
}

/**
 * One set's domain lists as one UTF-8 byte blob: entry `k` is `bytes[offsets[k], offsets[k + 1])`,
 * each list a run of consecutive entries in byte order. A key is compared to an entry byte by
 * byte – its characters directly when it is ASCII (every domain a rule may name is), its UTF-8
 * encoding otherwise.
 */
export class DomainBlob {
  private constructor(
    readonly bytes: Uint8Array,
    readonly offsets: Int32Array
  ) {}

  /** Lay `lists` (each already lowercase) out as one blob; `ranges[i]` is list `i`'s first entry and count. */
  static build(lists: readonly (readonly string[])[]): {
    blob: DomainBlob
    ranges: readonly [first: number, count: number][]
  } {
    const encoder = new TextEncoder()
    const encoded: Uint8Array[][] = []
    const ranges: [number, number][] = []
    let entries = 0
    let total = 0
    for (const list of lists) {
      const distinct = [...new Set(list)]
      const parts = distinct.map((domain) => encoder.encode(domain))
      parts.sort(compareBytes)
      encoded.push(parts)
      ranges.push([entries, parts.length])
      entries += parts.length
      for (const part of parts) total += part.length
    }
    const bytes = new Uint8Array(total)
    const offsets = new Int32Array(entries + 1)
    let at = 0
    let entry = 0
    for (const parts of encoded) {
      for (const part of parts) {
        offsets[entry++] = at
        bytes.set(part, at)
        at += part.length
      }
    }
    offsets[entries] = at
    return { blob: new DomainBlob(bytes, offsets), ranges }
  }

  /** How many entries the blob holds. */
  get size(): number {
    return this.offsets.length - 1
  }

  /** Entry `entry` compared to `key` as UTF-8: negative, zero or positive. */
  compare(entry: number, key: string): number {
    return isAscii(key)
      ? this.compareAscii(entry, key)
      : this.compareBytes(entry, new TextEncoder().encode(key))
  }

  /** `compare` for a key known to be ASCII: its code units are its bytes. */
  private compareAscii(entry: number, key: string): number {
    const bytes = this.bytes
    const start = this.offsets[entry]!
    const length = this.offsets[entry + 1]! - start
    const n = Math.min(length, key.length)
    for (let i = 0; i < n; i++) {
      const d = bytes[start + i]! - key.charCodeAt(i)
      if (d !== 0) return d
    }
    return length - key.length
  }

  /** `compare` for an encoded key. */
  private compareBytes(entry: number, key: Uint8Array): number {
    const bytes = this.bytes
    const start = this.offsets[entry]!
    const length = this.offsets[entry + 1]! - start
    const n = Math.min(length, key.length)
    for (let i = 0; i < n; i++) {
      const d = bytes[start + i]! - key[i]!
      if (d !== 0) return d
    }
    return length - key.length
  }

  /** Whether `key` is one of the entries `[first, first + count)`, by bisection. */
  contains(first: number, count: number, key: string): boolean {
    // Decided once per search, not per probe: a host's labels are ASCII (punycode) in practice.
    const encoded = isAscii(key) ? null : new TextEncoder().encode(key)
    let low = first
    let high = first + count - 1
    while (low <= high) {
      const mid = (low + high) >>> 1
      const d = encoded === null ? this.compareAscii(mid, key) : this.compareBytes(mid, encoded)
      if (d < 0) low = mid + 1
      else if (d > 0) high = mid - 1
      else return true
    }
    return false
  }

  /** Entry `entry` decoded. */
  entry(entry: number): string {
    return new TextDecoder().decode(
      this.bytes.subarray(this.offsets[entry]!, this.offsets[entry + 1]!)
    )
  }
}

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) return false
  return true
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!
    if (d !== 0) return d
  }
  return a.length - b.length
}

/** One list as a run of entries of its set's {@link DomainBlob}. */
export class BlobDomainList implements DomainList {
  constructor(
    private readonly blob: DomainBlob,
    private readonly first: number,
    readonly size: number
  ) {}

  has(domain: string): boolean {
    return this.blob.contains(this.first, this.size, domain)
  }

  hasAny(suffixes: readonly string[]): boolean {
    for (let i = 0; i < suffixes.length; i++)
      if (this.blob.contains(this.first, this.size, suffixes[i]!)) return true
    return false
  }

  /** Decoded from the blob: new strings, for the index to file a rule under. */
  *domains(): Iterable<string> {
    for (let k = 0; k < this.size; k++) yield this.blob.entry(this.first + k)
  }
}

function lowerAll(list: readonly string[]): string[] {
  const out = new Array<string>(list.length)
  for (let i = 0; i < list.length; i++) out[i] = list[i]!.toLowerCase()
  return out
}

/** `list` without duplicates, in code unit order, in an array of exactly that length. */
function distinctSorted(list: readonly string[]): string[] {
  const distinct = new Set(list)
  const out = new Array<string>(distinct.size)
  let i = 0
  for (const domain of distinct) out[i++] = domain
  return out.sort()
}

/** The set's distinct lists (each lowercase) in `form`, in the same order. */
function domainListsIn(lists: readonly (readonly string[])[], form: DomainListForm): DomainList[] {
  switch (form) {
    case 'set':
      return lists.map((list) => new SetDomainList(new Set(list)))
    case 'sorted':
      return lists.map((list) => new SortedDomainList(distinctSorted(list)))
    case 'blob': {
      const { blob, ranges } = DomainBlob.build(lists)
      return ranges.map(([first, count]) => new BlobDomainList(blob, first, count))
    }
  }
}

/** What {@link RuleTable.build} may be told. */
export interface RuleTableOptions {
  /** The in-memory form of the domain lists; {@link DEFAULT_DOMAIN_LIST_FORM} when omitted. */
  readonly domainLists?: DomainListForm
}

/** The form the engine builds its tables with. */
export const DEFAULT_DOMAIN_LIST_FORM: DomainListForm = 'sorted'

// -------------------------------------------------------------------------------------------
// The table
// -------------------------------------------------------------------------------------------

type HeaderConditions = NonNullable<ReturnType<typeof compileHeaderConditions>>

/** What a row's URL test reads of a request: the URL, and its lowercase form computed once. */
export interface UrlFacts {
  readonly url: string
  lowerUrl(): string
}

/** Builder scratch: an intern table. */
class Interner<T> {
  readonly values: T[] = []
  private readonly ids = new Map<string, number>()

  /** The id of `value` under `key`, adding it when new. */
  intern(key: string, value: () => T): number {
    let id = this.ids.get(key)
    if (id === undefined) {
      id = this.values.length
      this.ids.set(key, id)
      this.values.push(value())
    }
    return id
  }
}

interface Row {
  source: number
  priority: number
  rank: number
}

/** A rule fails to compile only when its `regexFilter` is not a valid expression. */
function compiles(rule: Rule): boolean {
  // Read here so a malformed rule (no `action`) fails at `setRuleSet`, as it always has, and
  // not at the first decision.
  void rule.action.type
  const c = rule.condition ?? {}
  if (c.regexFilter === undefined) return true
  return compileRegexFilter(c.regexFilter, c.isUrlFilterCaseSensitive === true) !== null
}

/**
 * How many of `rules` compile (the set's `ruleCount`), without building the table: all a host
 * that never decides in JavaScript (Android) pays at `setRuleSet`.
 */
export function compilableCount(rules: readonly Rule[]): number {
  let count = 0
  for (const rule of rules) if (compiles(rule)) count++
  return count
}

export class RuleTable implements IndexSource {
  /** Rows. */
  readonly size: number
  /** The set priority's band: `effectiveOf(row) = band + priority[row]`. */
  private readonly band: number

  // Per-row columns -------------------------------------------------------------------------
  /** Index of the row's rule in the set's `rules`. */
  readonly source: Int32Array
  /** The rule's priority, clamped. */
  readonly priority: Uint32Array
  /** `ACTION` code. */
  readonly action: Uint8Array
  /** `FLAG` bits. */
  readonly flags: Uint8Array
  /** `resourceTypes` mask; 0 for every type. */
  readonly types: Uint16Array
  /** `excludedResourceTypes` mask; 0 for none. */
  readonly excludedTypes: Uint16Array
  /** `URL_KIND` code. */
  readonly urlKind: Uint8Array
  /** Id in `strings` of the row's `urlFilter` (lowercased when compared so) or `regexFilter`; -1 for none. */
  readonly urlText: Int32Array
  /** `SELECTOR` code. */
  readonly selector: Uint8Array
  /** Id in `strings` of a hostname selector's host; -1 for none. */
  readonly hostname: Int32Array
  /** Token selectors as a CSR: the tokens of row `i` are `tokens[tokenStart[i] .. tokenStart[i + 1])`. */
  readonly tokenStart: Int32Array
  readonly tokens: Int32Array
  /** Ids in `domainLists`; -1 for none. */
  readonly requestDomains: Int32Array
  readonly excludedRequestDomains: Int32Array
  readonly initiatorDomains: Int32Array
  readonly excludedInitiatorDomains: Int32Array
  readonly topDomains: Int32Array
  readonly excludedTopDomains: Int32Array
  /** Ids in `stringSets`; -1 for none. */
  readonly methods: Int32Array
  readonly excludedMethods: Int32Array
  readonly tabIds: Int32Array
  readonly excludedTabIds: Int32Array
  /** Ids in `headerConditions`; -1 for none. */
  readonly responseHeaders: Int32Array
  readonly excludedResponseHeaders: Int32Array
  /** The last `decide` that visited the row through an index (a row under several buckets is visited once). */
  readonly seen: Uint32Array

  // Side tables -----------------------------------------------------------------------------
  readonly strings: readonly string[]
  readonly domainLists: readonly DomainList[]
  readonly stringSets: readonly ReadonlySet<string>[]
  readonly headerConditions: readonly HeaderConditions[]
  /** Per row: the compiled `regexFilter`, or the `urlFilter` pattern once compiled; null until then. */
  private readonly regexes: (RegExp | null)[]

  private constructor(
    readonly setId: string,
    setPriority: number,
    private readonly rules: readonly Rule[],
    rows: readonly Row[],
    listForm: DomainListForm
  ) {
    const n = rows.length
    this.size = n
    this.band = setPriority * (RULE_PRIORITY_MAX + 1)
    this.source = new Int32Array(n)
    this.priority = new Uint32Array(n)
    this.action = new Uint8Array(n)
    this.flags = new Uint8Array(n)
    this.types = new Uint16Array(n)
    this.excludedTypes = new Uint16Array(n)
    this.urlKind = new Uint8Array(n)
    this.urlText = new Int32Array(n).fill(-1)
    this.selector = new Uint8Array(n)
    this.hostname = new Int32Array(n).fill(-1)
    this.tokenStart = new Int32Array(n + 1)
    this.requestDomains = new Int32Array(n).fill(-1)
    this.excludedRequestDomains = new Int32Array(n).fill(-1)
    this.initiatorDomains = new Int32Array(n).fill(-1)
    this.excludedInitiatorDomains = new Int32Array(n).fill(-1)
    this.topDomains = new Int32Array(n).fill(-1)
    this.excludedTopDomains = new Int32Array(n).fill(-1)
    this.methods = new Int32Array(n).fill(-1)
    this.excludedMethods = new Int32Array(n).fill(-1)
    this.tabIds = new Int32Array(n).fill(-1)
    this.excludedTabIds = new Int32Array(n).fill(-1)
    this.responseHeaders = new Int32Array(n).fill(-1)
    this.excludedResponseHeaders = new Int32Array(n).fill(-1)
    this.seen = new Uint32Array(n)
    this.regexes = new Array<RegExp | null>(n).fill(null)

    const strings = new Interner<string>()
    // The lists are collected first and given their form at the end: the blob form lays every
    // list of the set out together.
    const domainLists = new Interner<readonly string[]>()
    const stringSets = new Interner<ReadonlySet<string>>()
    const headerConditions = new Interner<HeaderConditions>()
    const tokenRuns: number[] = []
    const domainList = (list: readonly string[] | undefined): number => {
      if (!list || list.length === 0) return -1
      const lowered = lowerAll(list)
      return domainLists.intern(lowered.join('\n'), () => lowered)
    }
    const stringSet = (list: readonly string[] | undefined, lower: boolean): number => {
      if (!list) return -1
      const values = lower ? lowerAll(list) : list
      return stringSets.intern([...values].sort().join('\n'), () => new Set(values))
    }
    const headers = (conditions: HeaderCondition[] | undefined): number => {
      const compiled = compileHeaderConditions(conditions)
      if (!compiled) return -1
      return headerConditions.intern(JSON.stringify(conditions), () => compiled)
    }

    for (let i = 0; i < n; i++) {
      const row = rows[i]!
      const rule = rules[row.source]!
      const c = rule.condition ?? {}
      this.source[i] = row.source
      this.priority[i] = row.priority
      this.action[i] = ACTION_CODES[rule.action.type] ?? ACTION.other
      const caseSensitive = c.isUrlFilterCaseSensitive === true
      let flags = 0
      if (rule.action.type === 'allowAllRequests') flags |= FLAG.allowAll
      if ((c.responseHeaders?.length ?? 0) > 0 || (c.excludedResponseHeaders?.length ?? 0) > 0)
        flags |= FLAG.headerStage
      if (c.excludedNonUniqueHosts === true) flags |= FLAG.excludedNonUniqueHosts
      if (c.domainType === 'firstParty') flags |= FLAG.firstParty
      else if (c.domainType === 'thirdParty') flags |= FLAG.thirdParty
      if (caseSensitive) flags |= FLAG.caseSensitive
      this.flags[i] = flags
      this.types[i] = c.resourceTypes && c.resourceTypes.length > 0 ? typeMask(c.resourceTypes) : 0
      this.excludedTypes[i] =
        c.excludedResourceTypes && c.excludedResourceTypes.length > 0
          ? typeMask(c.excludedResourceTypes)
          : 0

      let selector: UrlSelector = EVERY_URL
      if (c.regexFilter !== undefined) {
        const source = c.regexFilter
        this.urlKind[i] = URL_KIND.regex
        this.urlText[i] = strings.intern(source, () => source)
        // Only rules whose expression compiles have rows (`compiles`).
        this.regexes[i] = compileRegexFilter(source, caseSensitive)
        selector = regexSelector(source)
      } else if (c.urlFilter) {
        const filter = c.urlFilter
        if (!/[|^*]/.test(filter)) {
          if (caseSensitive) {
            this.urlKind[i] = URL_KIND.plainCaseSensitive
            this.urlText[i] = strings.intern(filter, () => filter)
          } else {
            this.urlKind[i] = URL_KIND.plain
            const needle = filter.toLowerCase()
            this.urlText[i] = strings.intern(needle, () => needle)
          }
        } else {
          this.urlKind[i] = URL_KIND.pattern
          this.urlText[i] = strings.intern(filter, () => filter)
        }
        selector = urlFilterSelector(filter, caseSensitive)
      }
      this.tokenStart[i] = tokenRuns.length
      if (selector.kind === 'hostname') {
        this.selector[i] = SELECTOR.hostname
        const host = selector.hostname
        this.hostname[i] = strings.intern(host, () => host)
      } else if (selector.kind === 'tokens' && selector.tokens.length > 0) {
        this.selector[i] = SELECTOR.tokens
        for (const t of selector.tokens) tokenRuns.push(t)
      }

      this.requestDomains[i] = domainList(c.requestDomains)
      this.excludedRequestDomains[i] = domainList(c.excludedRequestDomains)
      this.initiatorDomains[i] = domainList(c.initiatorDomains)
      this.excludedInitiatorDomains[i] = domainList(c.excludedInitiatorDomains)
      this.topDomains[i] = domainList(c.topDomains)
      this.excludedTopDomains[i] = domainList(c.excludedTopDomains)
      this.methods[i] = stringSet(c.requestMethods, true)
      this.excludedMethods[i] = stringSet(c.excludedRequestMethods, true)
      this.tabIds[i] = stringSet(c.tabIds?.map(String), false)
      this.excludedTabIds[i] = stringSet(c.excludedTabIds?.map(String), false)
      this.responseHeaders[i] = headers(c.responseHeaders)
      this.excludedResponseHeaders[i] = headers(c.excludedResponseHeaders)
    }
    this.tokenStart[n] = tokenRuns.length
    this.tokens = Int32Array.from(tokenRuns)
    this.strings = strings.values
    this.domainLists = domainListsIn(domainLists.values, listForm)
    this.stringSets = stringSets.values
    this.headerConditions = headerConditions.values
  }

  /**
   * Compile `rules` of the set `setId` at `setPriority`. Rules whose `regexFilter` does not
   * compile get no row (`compilableCount` agrees).
   */
  static build(
    setId: string,
    setPriority: number,
    rules: readonly Rule[],
    options: RuleTableOptions = {}
  ): RuleTable {
    const rows: Row[] = []
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]!
      if (!compiles(rule)) continue
      rows.push({
        source: i,
        priority: rulePriority(rule.priority),
        rank: rankOf(rule.action.type)
      })
    }
    // Stable: equal rows keep the set's own order (`Array.prototype.sort` is stable).
    rows.sort((a, b) => b.priority - a.priority || b.rank - a.rank)
    return new RuleTable(
      setId,
      setPriority,
      rules,
      rows,
      options.domainLists ?? DEFAULT_DOMAIN_LIST_FORM
    )
  }

  /** The rule a row compiled from. */
  ruleOf(row: number): Rule {
    return this.rules[this.source[row]!]!
  }

  /** The row's effective priority: the set's band plus the rule's priority. */
  effectiveOf(row: number): number {
    return this.band + this.priority[row]!
  }

  /** The row's rank inside its priority (`ACTION_RANK`). */
  rankOf(row: number): number {
    return ACTION_RANK[this.action[row]!]!
  }

  /** The row's `regexFilter` expression; null for a row without one. */
  regexFilterOf(row: number): RegExp | null {
    return this.urlKind[row] === URL_KIND.regex ? this.regexes[row]! : null
  }

  /** Whether the row's URL condition accepts the request's URL. */
  urlMatches(row: number, f: UrlFacts): boolean {
    switch (this.urlKind[row]) {
      case URL_KIND.none:
        return true
      case URL_KIND.plain:
        return f.lowerUrl().includes(this.strings[this.urlText[row]!]!)
      case URL_KIND.plainCaseSensitive:
        return f.url.includes(this.strings[this.urlText[row]!]!)
      case URL_KIND.pattern: {
        let regex = this.regexes[row]
        if (regex === null) {
          regex = new RegExp(
            urlFilterToRegExpSource(this.strings[this.urlText[row]!]!),
            (this.flags[row]! & FLAG.caseSensitive) !== 0 ? '' : 'i'
          )
          this.regexes[row] = regex
        }
        return regex.test(f.url)
      }
      default:
        return this.regexes[row]!.test(f.url)
    }
  }

  /**
   * `hostMatchesDomain(host, d)` for some `d` of the include list and none of the exclude list,
   * as membership tests over the host's suffixes; no include list accepts every host.
   */
  matchesDomains(suffixes: readonly string[], include: number, exclude: number): boolean {
    if (exclude >= 0 && this.domainLists[exclude]!.hasAny(suffixes)) return false
    if (include >= 0) return this.domainLists[include]!.hasAny(suffixes)
    return true
  }

  /** The string set a row's id points to, or null. */
  stringSetOf(id: number): ReadonlySet<string> | null {
    return id < 0 ? null : this.stringSets[id]!
  }

  /** The header conditions a row's id points to, or null. */
  headerConditionsOf(id: number): HeaderConditions | null {
    return id < 0 ? null : this.headerConditions[id]!
  }

  // IndexSource -----------------------------------------------------------------------------

  isAllowAll(row: number): boolean {
    return (this.flags[row]! & FLAG.allowAll) !== 0
  }

  selectorKind(row: number): number {
    return this.selector[row]!
  }

  hostnameOf(row: number): string {
    return this.strings[this.hostname[row]!]!
  }

  tokensOf(row: number): ArrayLike<number> {
    return this.tokens.subarray(this.tokenStart[row]!, this.tokenStart[row + 1]!)
  }

  typeMaskOf(row: number): number {
    return this.types[row]!
  }

  requestDomainsOf(row: number): Iterable<string> | null {
    const id = this.requestDomains[row]!
    return id < 0 ? null : this.domainLists[id]!.domains()
  }

  requestDomainCount(row: number): number {
    const id = this.requestDomains[row]!
    return id < 0 ? 0 : this.domainLists[id]!.size
  }

  initiatorDomainsOf(row: number): Iterable<string> | null {
    const id = this.initiatorDomains[row]!
    return id < 0 ? null : this.domainLists[id]!.domains()
  }

  requestDomainsHasAny(row: number, suffixes: readonly string[]): boolean {
    const id = this.requestDomains[row]!
    return id >= 0 && this.domainLists[id]!.hasAny(suffixes)
  }
}
