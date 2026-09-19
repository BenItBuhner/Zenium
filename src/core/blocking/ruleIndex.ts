/**
 * The lookup structure behind `RuleEngine.decide`: one rule set's compiled rules indexed so a
 * request visits the few that may match it instead of every one. The TypeScript twin of the
 * Kotlin engine's `RuleIndex.kt` (same buckets, same tokenizer, same conservative rules about
 * what may be indexed), so the two engines visit the same candidates and, with the resolution
 * in `engine.ts`, return the same rule.
 *
 * Buckets, in the order a request walks them:
 *
 * - `hosts`: `||host^` rules under `host`, and rules whose only URL selector is `requestDomains`
 *   under each domain. A request looks up every label suffix of its host (`a.b.example` →
 *   `a.b.example`, `b.example`, `example`), which is exactly the set of domains
 *   `hostMatchesDomain` accepts.
 * - `initiators`: rules whose only selector is `initiatorDomains`, under each domain; walked with
 *   the initiator host's suffixes.
 * - token buckets: every other rule with a `urlFilter` or `regexFilter` that yields at least one
 *   *complete* literal token (a run of `[a-z0-9]` the pattern bounds on both sides, see
 *   {@link urlFilterSelector} and {@link regexRequiredTokens}), under its rarest token in the
 *   set. A request looks up every token of its lowercased URL.
 * - wildcard groups: rules with nothing to index them by (`*`, no filter, a regex without a safe
 *   token), grouped by their `resourceTypes` so a group of main-frame-only rules costs an image
 *   request nothing.
 *
 * `allowAllRequests` rules are kept apart (`allowAll`): they match the request's document as well
 * as the request, which the request's tokens say nothing about.
 *
 * The index is a superset filter: every rule it visits is still put through the full condition
 * test, and a rule that may match is never left out. A rule under several suffixes or tokens is
 * visited more than once; the engine deduplicates.
 */
import type { ResourceType } from './rules'

// -------------------------------------------------------------------------------------------
// Tokens
// -------------------------------------------------------------------------------------------

/** `[a-z0-9]` – the tokenizer's alphabet over lowercased text; everything else is a boundary. */
function isTokenCode(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57)
}

/** djb2 over `s[start, end)`, wrapped to 32 bits like the Kotlin `Tokens.hash`. */
export function hashToken(s: string, start: number, end: number): number {
  let h = 5381
  for (let i = start; i < end; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return h
}

/** Hashes of every token of `lower` (lowercased input). */
export function tokenize(lower: string): number[] {
  const out: number[] = []
  const n = lower.length
  let i = 0
  while (i < n) {
    if (!isTokenCode(lower.charCodeAt(i))) {
      i++
      continue
    }
    const start = i
    while (i < n && isTokenCode(lower.charCodeAt(i))) i++
    out.push(hashToken(lower, start, i))
  }
  return out
}

// -------------------------------------------------------------------------------------------
// What a rule selects URLs by
// -------------------------------------------------------------------------------------------

/**
 * How the index may find a rule from a request URL.
 *
 * - `every`: the rule's pattern (if any) says nothing usable – no `urlFilter`, `*`, or a regular
 *   expression without a token every match contains; the rule is found by its domains or sits in
 *   the wildcard list.
 * - `hostname`: `||host^` – found under the request host's suffixes.
 * - `tokens`: literal tokens every matching URL contains, as hashes; empty behaves like `every`.
 */
export type UrlSelector =
  | { readonly kind: 'every' }
  | { readonly kind: 'hostname'; readonly hostname: string }
  | { readonly kind: 'tokens'; readonly tokens: readonly number[] }

export const EVERY_URL: UrlSelector = { kind: 'every' }

const STAR = 42

function isHostCode(code: number): boolean {
  return isTokenCode(code) || code === 46 || code === 45 // . -
}

/**
 * The selector of a `urlFilter` (ABP pattern syntax: `||` / `|` anchors, `^` separator, `*`
 * wildcard, everything else literal). Mirrors `UrlPattern.parse` + `tokens()` in Kotlin, with one
 * difference forced by the desktop matcher: `||host` *without* a trailing `^` is a prefix match
 * there (`||host` matches `hostile.example`), so only `||host^` goes under the hostname; a bare
 * `||host` is indexed by its tokens like any other pattern.
 *
 * Tokens are the `[a-z0-9]` runs of the lowercased pattern bounded on both sides by something the
 * pattern guarantees is in the URL right there: a literal non-token character, a `^`, or an
 * anchor. A run next to `*`, or at an unanchored end, may continue in the URL and is not one.
 */
export function urlFilterSelector(filter: string, caseSensitive: boolean): UrlSelector {
  let text = filter
  let host = false
  let left = false
  let right = false
  if (text.startsWith('||')) {
    host = true
    text = text.slice(2)
  } else if (text.startsWith('|')) {
    left = true
    text = text.slice(1)
  }
  if (text.endsWith('|')) {
    right = true
    text = text.slice(0, -1)
  }
  // A wildcard at either end means nothing, and takes the anchor's promise with it (`|*foo`
  // matches `xfoo`).
  while (!host && text.startsWith('*')) {
    text = text.slice(1)
    left = false
  }
  while (text.endsWith('*')) {
    text = text.slice(0, -1)
    right = false
  }
  if (!caseSensitive) text = text.toLowerCase()
  if (text.length === 0 && !host) return EVERY_URL
  if (host) {
    let i = 0
    while (i < text.length && isHostCode(text.charCodeAt(i))) i++
    const hostPart = text.slice(0, i)
    const rest = text.slice(i)
    const pureHost =
      hostPart.length > 0 &&
      !hostPart.startsWith('.') &&
      !hostPart.endsWith('.') &&
      !hostPart.includes('..') &&
      (rest === '^' || (rest === '' && right))
    if (pureHost) return { kind: 'hostname', hostname: hostPart }
  }
  const full = text.toLowerCase()
  const tokens: number[] = []
  const n = full.length
  let i = 0
  while (i < n) {
    if (!isTokenCode(full.charCodeAt(i))) {
      i++
      continue
    }
    const start = i
    while (i < n && isTokenCode(full.charCodeAt(i))) i++
    const boundedLeft = start === 0 ? left || host : full.charCodeAt(start - 1) !== STAR
    const boundedRight = i === n ? right : full.charCodeAt(i) !== STAR
    if (boundedLeft && boundedRight) tokens.push(hashToken(full, start, i))
  }
  return tokens.length === 0 ? EVERY_URL : { kind: 'tokens', tokens }
}

// -------------------------------------------------------------------------------------------
// Tokens a regular expression vouches for
// -------------------------------------------------------------------------------------------

function isAlnumCode(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57)
}

/** An unescaped character outside classes that the expression matches literally and the tokenizer does not count. */
function isLiteralSeparator(c: string): boolean {
  return !isAlnumCode(c.charCodeAt(0)) && !'\\.^$|?*+()[]{}'.includes(c)
}

interface RequiredRun {
  text: string
  boundedLeft: boolean
  boundedRight: boolean
}

/**
 * The alphanumeric runs (3+ characters) every match of `source` must contain: at group depth 0,
 * outside character classes, not shortened by a quantifier, not in a top-level alternation
 * (null then). Each run records whether what the expression puts right before and after it is
 * certainly a token boundary in the URL: an anchor, or a character matched literally that is
 * not alphanumeric (`\.`, `/`, `=`, `-`, …) and not made optional by a quantifier after it.
 * The port of `UrlPattern.requiredRuns` in Kotlin.
 */
function requiredRuns(source: string): RequiredRun[] | null {
  const out: RequiredRun[] = []
  let depth = 0
  let inClass = false
  let i = 0
  let runStart = -1
  let runBoundedLeft = false
  // Whether the last thing scanned certainly ends at a token boundary.
  let boundary = false
  const endRun = (end: number, boundedRight: boolean): void => {
    if (runStart === -1) return
    if (end - runStart >= 3)
      out.push({ text: source.slice(runStart, end), boundedLeft: runBoundedLeft, boundedRight })
    runStart = -1
  }
  // Whether the element starting at `at` is certainly a token boundary: `$`, an escaped
  // non-alphanumeric character, or an unescaped literal separator – and not made optional by
  // the quantifier after it (`/?`, `\.?`, `/*`, `/{0,1}`: the URL may run straight on, `/ads/?`
  // matches `/adsx`). `+` keeps at least one, so it keeps the boundary; any `{n,m}` is taken as
  // optional rather than read.
  const boundaryAt = (at: number): boolean => {
    if (at >= source.length) return false
    const c = source[at]
    let separator: boolean
    if (c === '$') separator = true
    else if (c === '\\')
      separator = at + 1 < source.length && !isAlnumCode(source.charCodeAt(at + 1))
    else separator = isLiteralSeparator(c)
    if (!separator) return false
    const next = at + (c === '\\' ? 2 : 1)
    return next >= source.length || !'?*{'.includes(source[next])
  }
  while (i < source.length) {
    const c = source[i]
    if (inClass) {
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === ']') {
        inClass = false
        boundary = false
      }
      i++
      continue
    }
    if (c === '\\') {
      const separator = boundaryAt(i)
      endRun(i, separator)
      boundary = separator
      i += 2
      continue
    }
    switch (c) {
      case '[':
        endRun(i, false)
        inClass = true
        boundary = false
        break
      case '(':
        endRun(i, false)
        depth++
        boundary = false
        break
      case ')':
        endRun(i, false)
        depth--
        boundary = false
        break
      // A quantifier shortens the run it follows by the character it quantifies, which the URL may repeat.
      case '?':
      case '*':
      case '+':
        endRun(i - 1, false)
        boundary = false
        break
      case '{': {
        // `{n,m}`: its digits are a count, not text of the URL.
        endRun(i - 1, false)
        boundary = false
        const close = source.indexOf('}', i)
        i = close === -1 ? source.length : close + 1
        continue
      }
      case '|':
        endRun(i, false)
        if (depth === 0) return null
        boundary = false
        break
      case '^':
        endRun(i, false)
        boundary = true
        break
      case '$':
        endRun(i, boundaryAt(i))
        boundary = false
        break
      default: {
        const alnum = isAlnumCode(c.charCodeAt(0))
        if (alnum && depth === 0) {
          if (runStart === -1) {
            runStart = i
            runBoundedLeft = boundary
          }
        } else {
          endRun(i, boundaryAt(i))
          boundary = !alnum && isLiteralSeparator(c)
        }
      }
    }
    i++
  }
  endRun(source.length, false)
  return out
}

/**
 * The complete URL tokens every match of the regular expression `source` contains, lowercased
 * for the index over the lowercased URL: the runs of {@link requiredRuns} bounded on both sides.
 * Null when the expression vouches for none (`regexRequiredTokens('/ads/?')` is null: the URL
 * `/adsx` matches and its token is longer). The port of `UrlPattern.requiredTokensOf`.
 */
export function regexRequiredTokens(source: string): string[] | null {
  const runs = requiredRuns(source)
  if (!runs) return null
  const out = runs.filter((r) => r.boundedLeft && r.boundedRight).map((r) => r.text.toLowerCase())
  return out.length > 0 ? out : null
}

/** The selector of a `regexFilter`: its required tokens, or `every` when it has none. */
export function regexSelector(source: string): UrlSelector {
  const required = regexRequiredTokens(source)
  if (!required) return EVERY_URL
  return { kind: 'tokens', tokens: required.map((t) => hashToken(t, 0, t.length)) }
}

// -------------------------------------------------------------------------------------------
// Host suffixes
// -------------------------------------------------------------------------------------------

/**
 * The host and every suffix of it that starts after a `.` (`a.b.example` → `a.b.example`,
 * `b.example`, `example`): exactly the domains `hostMatchesDomain(host, d)` accepts, so a
 * membership test over these replaces a scan of a rule's domain list. The empty host yields
 * `['']`.
 */
export function hostSuffixes(host: string): string[] {
  const out = [host]
  let dot = host.indexOf('.')
  while (dot !== -1) {
    out.push(host.slice(dot + 1))
    dot = host.indexOf('.', dot + 1)
  }
  return out
}

/** Whether one of `suffixes` is in `domains`. */
export function hasDomainOf(suffixes: readonly string[], domains: ReadonlySet<string>): boolean {
  for (const key of suffixes) if (domains.has(key)) return true
  return false
}

// -------------------------------------------------------------------------------------------
// The index
// -------------------------------------------------------------------------------------------

/** What the index reads of a compiled rule. */
export interface IndexedRule {
  /** `allowAllRequests`: kept apart, matched against the document as well as the request. */
  readonly allowAll: boolean
  readonly requestDomains: ReadonlySet<string> | null
  readonly initiatorDomains: ReadonlySet<string> | null
  readonly resourceTypes: ReadonlySet<ResourceType> | null
  readonly selector: UrlSelector
}

/** The request facts a lookup walks the buckets with. */
export interface IndexLookup {
  readonly type: ResourceType
  /** `hostSuffixes` of the request host. */
  readonly hostSuffixes: readonly string[]
  /** `hostSuffixes` of the initiator host; empty when the request has none. */
  readonly initiatorSuffixes: readonly string[]
  /** Tokens of the lowercased URL; computed on first use. */
  tokens(): readonly number[]
}

interface TypeGroup<R> {
  types: ReadonlySet<ResourceType> | null
  rules: R[]
}

/** hostname → one rule, or the rules under it (most hostnames carry one). */
type HostMap<R> = Map<string, R | R[]>

function addUnder<R>(map: HostMap<R>, key: string, rule: R): void {
  const existing = map.get(key)
  if (existing === undefined) map.set(key, rule)
  else if (Array.isArray(existing)) existing.push(rule)
  else map.set(key, [existing, rule])
}

function visitUnder<R>(map: HostMap<R>, key: string, visit: (rule: R) => void): void {
  const hit = map.get(key)
  if (hit === undefined) return
  if (Array.isArray(hit)) for (const rule of hit) visit(rule)
  else visit(hit)
}

/**
 * Builds a {@link RuleIndex} a few rules at a time, so a large set (an extension's static
 * ruleset) is indexed between decisions instead of ahead of them: the engine calls {@link step}
 * with a budget in rules until it answers true, then swaps {@link result} in. Two passes: every
 * rule is classified (hostname, domains, token candidate, wildcard) while the token histogram
 * is counted, then each token candidate goes under its rarest token.
 */
export class RuleIndexBuilder<R extends IndexedRule> {
  private cursor = 0
  private phase: 'classify' | 'bucket' | 'done' = 'classify'
  private readonly hosts: HostMap<R> = new Map()
  private readonly initiators: HostMap<R> = new Map()
  private readonly buckets = new Map<number, R[]>()
  private readonly allowAll: R[] = []
  private readonly tokenCandidates: R[] = []
  private readonly loose: R[] = []
  private readonly histogram = new Map<number, number>()
  private built: RuleIndex<R> | null = null

  constructor(private readonly rules: readonly R[]) {}

  /** Advances the build by up to `work` rules; true once the index is complete. */
  step(work: number): boolean {
    let budget = work
    while (budget > 0) {
      if (this.phase === 'classify') {
        if (this.cursor < this.rules.length) {
          this.classify(this.rules[this.cursor++])
          budget--
        } else {
          this.phase = 'bucket'
          this.cursor = 0
        }
      } else if (this.phase === 'bucket') {
        if (this.cursor < this.tokenCandidates.length) {
          this.bucket(this.tokenCandidates[this.cursor++])
          budget--
        } else {
          this.finish()
          return true
        }
      } else {
        return true
      }
    }
    return this.phase === 'done'
  }

  /** The index, once {@link step} has answered true. */
  get result(): RuleIndex<R> | null {
    return this.built
  }

  private classify(rule: R): void {
    if (rule.allowAll) {
      this.allowAll.push(rule)
      return
    }
    const selector = rule.selector
    if (selector.kind === 'hostname') addUnder(this.hosts, selector.hostname, rule)
    else if (selector.kind === 'tokens' && selector.tokens.length > 0) {
      this.tokenCandidates.push(rule)
      for (const t of selector.tokens) this.histogram.set(t, (this.histogram.get(t) ?? 0) + 1)
    } else this.byDomainsOrLoose(rule)
  }

  /** The rule goes under the rarest of its tokens in this set. */
  private bucket(rule: R): void {
    if (rule.selector.kind !== 'tokens') return
    const tokens = rule.selector.tokens
    let best = tokens[0]
    let bestCount = this.histogram.get(best) ?? 0
    for (const t of tokens) {
      const count = this.histogram.get(t) ?? 0
      if (count < bestCount) {
        best = t
        bestCount = count
      }
    }
    const bucket = this.buckets.get(best)
    if (bucket) bucket.push(rule)
    else this.buckets.set(best, [rule])
  }

  /**
   * A rule without a usable URL token: under each of its request domains, else under each of
   * its initiator domains (a rule that names the sites it applies on can only meet requests of
   * their documents), else in the wildcard list.
   */
  private byDomainsOrLoose(rule: R): void {
    if (rule.requestDomains)
      for (const domain of rule.requestDomains) addUnder(this.hosts, domain, rule)
    else if (rule.initiatorDomains)
      for (const site of rule.initiatorDomains) addUnder(this.initiators, site, rule)
    else this.loose.push(rule)
  }

  private finish(): void {
    const groups = new Map<string, TypeGroup<R>>()
    for (const rule of this.loose) {
      const key = rule.resourceTypes ? [...rule.resourceTypes].sort().join(',') : ''
      const group = groups.get(key)
      if (group) group.rules.push(rule)
      else groups.set(key, { types: rule.resourceTypes, rules: [rule] })
    }
    this.built = new RuleIndex(
      this.hosts,
      this.initiators,
      this.buckets,
      [...groups.values()],
      this.allowAll,
      this.tokenCandidates.length
    )
    this.phase = 'done'
  }
}

export class RuleIndex<R extends IndexedRule> {
  /** @internal Built by {@link RuleIndexBuilder}; use {@link RuleIndex.build} for a whole set at once. */
  constructor(
    /** hostname → rule or rules. */
    private readonly hosts: HostMap<R>,
    /** initiator domain → rule or rules, for rules whose only selector is `initiatorDomains`. */
    private readonly initiators: HostMap<R>,
    /** token hash → rules whose rarest token it is. */
    private readonly buckets: Map<number, R[]>,
    /** Rules with nothing to index them by, one group per distinct `resourceTypes`. */
    private readonly wildcard: readonly TypeGroup<R>[],
    /** `allowAllRequests` rules, in the set's order. */
    readonly allowAll: readonly R[],
    /** Rules indexed by a token (the rest sit under a hostname or in the wildcard list). */
    readonly tokenIndexedCount: number
  ) {}

  /** Index `rules` now, in one go. */
  static build<R extends IndexedRule>(rules: readonly R[]): RuleIndex<R> {
    const builder = new RuleIndexBuilder(rules)
    builder.step(Infinity)
    const built = builder.result
    if (!built) throw new Error('rule index build did not finish')
    return built
  }

  /** Rules that had no hostname, site or token to index them by (tested for every request of their types). */
  get wildcardCount(): number {
    return this.wildcard.reduce((n, g) => n + g.rules.length, 0)
  }

  /** Hostnames the map indexes (`||host^` rules and `requestDomains` entries). */
  get hostCount(): number {
    return this.hosts.size
  }

  /** Initiator domains the second map indexes. */
  get initiatorCount(): number {
    return this.initiators.size
  }

  /**
   * Visit every rule that may match the request (other than `allowAllRequests` rules): a rule
   * under several of the host's suffixes or several tokens is visited more than once.
   */
  forEachCandidate(lookup: IndexLookup, visit: (rule: R) => void): void {
    if (this.hosts.size > 0)
      for (const key of lookup.hostSuffixes) visitUnder(this.hosts, key, visit)
    if (this.initiators.size > 0)
      for (const key of lookup.initiatorSuffixes) visitUnder(this.initiators, key, visit)
    if (this.buckets.size > 0) {
      for (const t of lookup.tokens()) {
        const bucket = this.buckets.get(t)
        if (bucket) for (const rule of bucket) visit(rule)
      }
    }
    for (const group of this.wildcard) {
      if (group.types && !group.types.has(lookup.type)) continue
      for (const rule of group.rules) visit(rule)
    }
  }
}
