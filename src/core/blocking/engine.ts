import {
  ALLOW,
  RULE_SET_PRIORITY,
  type BlockingEngine,
  type Decision,
  type HeaderOp,
  type RequestContext,
  type ResourceType,
  type Rule,
  type RuleSet,
  type RuleSetChange,
  type RuleSetListener,
  type RuleSetSummary
} from './rules'
import { domainOf, hostnameOf, isThirdParty } from './domain'
import { isNonUniqueHost } from '../../shared/nonUniqueHost'
import {
  applyRegexSubstitution,
  compileRegexFilter,
  compileUrlFilter,
  type UrlPredicate
} from './urlFilter'
import { countNetworkFilters } from './lists'
import {
  EVERY_URL,
  RuleIndex,
  RuleIndexBuilder,
  hasDomainOf,
  hostSuffixes,
  regexSelector,
  tokenize,
  urlFilterSelector,
  type IndexLookup,
  type UrlSelector
} from './ruleIndex'

/**
 * What the platform's filter-text matcher answers for a request. `allow` means an exception
 * filter (`@@`) matched; `null` means no filter matched at all.
 */
export interface TextMatch {
  action: 'block' | 'allow' | 'redirect'
  redirectUrl?: string
  /** The raw filter line, when the matcher keeps it. */
  filter?: string
}

/**
 * Matches `filterText` of the enabled text sets. Desktop plugs in Ghostery's engine; Android
 * has none (its Kotlin engine reads the same sets from disk and decides natively).
 */
export interface TextMatcher {
  match(ctx: RequestContext): TextMatch | null
}

/** Set id reported for text matches (the matcher works on all enabled text sets at once). */
export const TEXT_MATCH_SET_ID = 'filter-text'

interface CompiledRule {
  setId: string
  effective: number
  rank: number
  rule: Rule
  /**
   * The rule's index in its set's `compiled` (resolution order: a stable sort of the set's own
   * order by effective priority, then rank). On a full tie – equal effective priority and rank –
   * the lower position wins, which is the rule the linear scan meets first; the index visits
   * rules in bucket order and needs this to agree with it (and with the Kotlin engine).
   */
  position: number
  /** `allowAllRequests`: kept apart by the index, matched against the document too. */
  allowAll: boolean
  /** How the index finds the rule from a URL (`ruleIndex.ts`). */
  selector: UrlSelector
  /** The last `decide` that visited the rule through an index (a rule under several buckets is visited once). */
  seen: number
  url: UrlPredicate | null
  regex: RegExp | null
  initiatorDomains: Set<string> | null
  excludedInitiatorDomains: Set<string> | null
  requestDomains: Set<string> | null
  excludedRequestDomains: Set<string> | null
  excludedNonUniqueHosts: boolean
  resourceTypes: Set<ResourceType> | null
  excludedResourceTypes: Set<ResourceType> | null
  methods: Set<string> | null
  excludedMethods: Set<string> | null
  domainType: 'firstParty' | 'thirdParty' | null
  tabIds: Set<string> | null
  excludedTabIds: Set<string> | null
}

interface StoredSet {
  summary: RuleSetSummary
  rules: Rule[]
  /** In resolution order; what `decideLinear` scans and `index` is built from. */
  compiled: CompiledRule[]
  /** The set's index, or null while a large set's is still to be built (`decide` scans it then). */
  index: RuleIndex<CompiledRule> | null
}

/**
 * A matching rule's claim. `order` is where the linear scan would have met it – the set's place
 * among the ordered sets above the rule's `position` – and breaks a full tie the way the scan
 * does: the first met wins. A filter-text match is met after every structured rule (`Infinity`).
 */
interface Candidate {
  effective: number
  rank: number
  order: number
  decision: Decision
}

/** A `modifyHeaders` rule that matched, with where the scan meets it. */
interface HeaderCandidate {
  rule: CompiledRule
  order: number
}

/** `order` of a rule: `setIndex` above `position` (positions stay below 2^32). */
const ORDER_BASE = 0x100000000

/**
 * Sets with at most this many rules are indexed on the spot; larger ones (an extension's static
 * ruleset) keep answering through the linear scan while their index is built in slices on later
 * ticks and swapped in (`buildIndexes` finishes every pending one now).
 */
const INDEX_INLINE_LIMIT = 2_000
/** Milliseconds of index building per slice; decisions run in between. */
const INDEX_SLICE_MS = 4
/** Rules the builder advances between clock checks. */
const INDEX_STEP_RULES = 256

const now: () => number =
  typeof performance !== 'undefined' ? () => performance.now() : () => Date.now()

/** A pending index build for the set as it was when the build was queued. */
interface IndexJob {
  stored: StoredSet
  builder: RuleIndexBuilder<CompiledRule>
}

/** Tie-break order inside one priority: allow > allowAllRequests > block > upgradeScheme > redirect. */
const RANK: Record<string, number> = {
  allow: 5,
  allowAllRequests: 4,
  block: 3,
  upgradeScheme: 2,
  redirect: 1,
  modifyHeaders: 0
}

const RULE_PRIORITY_BITS = 20
const RULE_PRIORITY_MAX = (1 << RULE_PRIORITY_BITS) - 1

function effectivePriority(setPriority: number, rulePriority: number | undefined): number {
  const rp = Math.min(Math.max(1, Math.floor(rulePriority ?? 1)), RULE_PRIORITY_MAX)
  return setPriority * (RULE_PRIORITY_MAX + 1) + rp
}

const TEXT_EFFECTIVE = effectivePriority(RULE_SET_PRIORITY.filterList, 1)

function lower(list: string[] | undefined): Set<string> | null {
  return list && list.length > 0 ? new Set(list.map((d) => d.toLowerCase())) : null
}

function set<T>(list: T[] | undefined): Set<T> | null {
  return list && list.length > 0 ? new Set(list) : null
}

function compileRule(setId: string, setPriority: number, rule: Rule): CompiledRule | null {
  const c = rule.condition ?? {}
  const caseSensitive = c.isUrlFilterCaseSensitive === true
  let url: UrlPredicate | null = null
  let regex: RegExp | null = null
  let selector: UrlSelector = EVERY_URL
  if (c.regexFilter !== undefined) {
    regex = compileRegexFilter(c.regexFilter, caseSensitive)
    if (!regex) return null
    selector = regexSelector(c.regexFilter)
  } else if (c.urlFilter) {
    url = compileUrlFilter(c.urlFilter, caseSensitive)
    selector = urlFilterSelector(c.urlFilter, caseSensitive)
  }
  return {
    setId,
    effective: effectivePriority(setPriority, rule.priority),
    rank: RANK[rule.action.type] ?? 0,
    rule,
    position: -1,
    allowAll: rule.action.type === 'allowAllRequests',
    selector,
    seen: 0,
    url,
    regex,
    initiatorDomains: lower(c.initiatorDomains),
    excludedInitiatorDomains: lower(c.excludedInitiatorDomains),
    requestDomains: lower(c.requestDomains),
    excludedRequestDomains: lower(c.excludedRequestDomains),
    excludedNonUniqueHosts: c.excludedNonUniqueHosts === true,
    resourceTypes: set(c.resourceTypes),
    excludedResourceTypes: set(c.excludedResourceTypes),
    methods: c.requestMethods ? new Set(c.requestMethods.map((m) => m.toLowerCase())) : null,
    excludedMethods: c.excludedRequestMethods
      ? new Set(c.excludedRequestMethods.map((m) => m.toLowerCase()))
      : null,
    domainType: c.domainType ?? null,
    tabIds: c.tabIds ? new Set(c.tabIds.map(String)) : null,
    excludedTabIds: c.excludedTabIds ? new Set(c.excludedTabIds.map(String)) : null
  }
}

/** Request facts computed once per `decide` call; also what the indexes are walked with. */
class Facts implements IndexLookup {
  readonly url: string
  readonly type: ResourceType
  readonly host: string
  readonly initiatorHost: string
  readonly method: string
  readonly thirdParty: boolean
  readonly tabId: string | undefined
  /** The host and its parent domains: what a domain condition is looked up by. */
  readonly hostSuffixes: string[]
  readonly initiatorSuffixes: string[]
  private urlTokens: number[] | null = null

  constructor(ctx: RequestContext) {
    const initiator = ctx.initiator ?? ctx.documentUrl
    this.url = ctx.url
    this.type = ctx.type
    this.host = hostnameOf(ctx.url) ?? ''
    this.initiatorHost = initiator ? (hostnameOf(initiator) ?? '') : ''
    this.method = (ctx.method || 'GET').toLowerCase()
    this.thirdParty = ctx.isThirdParty ?? isThirdParty(ctx.url, initiator)
    this.tabId = tabIdFact(ctx)
    this.hostSuffixes = hostSuffixes(this.host)
    this.initiatorSuffixes = this.initiatorHost ? hostSuffixes(this.initiatorHost) : []
  }

  /** Tokens of the lowercased URL, for the token buckets; computed on first use. */
  tokens(): number[] {
    return (this.urlTokens ??= tokenize(this.url.toLowerCase()))
  }
}

/**
 * `hostMatchesDomain(host, d)` for some `d` of a set, as a membership test over the host's
 * suffixes: a list of tens of thousands of domains (uBlock Origin Lite folds whole hosts files
 * into one rule's `requestDomains`) costs as many lookups as the host has labels.
 */
function matchesDomains(
  suffixes: readonly string[],
  include: Set<string> | null,
  exclude: Set<string> | null
): boolean {
  if (exclude && hasDomainOf(suffixes, exclude)) return false
  if (include) return hasDomainOf(suffixes, include)
  return true
}

function ruleMatches(r: CompiledRule, ctx: RequestContext, f: Facts): boolean {
  if (r.resourceTypes && !r.resourceTypes.has(ctx.type)) return false
  if (r.excludedResourceTypes && r.excludedResourceTypes.has(ctx.type)) return false
  if (r.methods && !r.methods.has(f.method)) return false
  if (r.excludedMethods && r.excludedMethods.has(f.method)) return false
  if (r.domainType === 'thirdParty' && !f.thirdParty) return false
  if (r.domainType === 'firstParty' && f.thirdParty) return false
  if (r.tabIds && (f.tabId === undefined || !r.tabIds.has(f.tabId))) return false
  if (r.excludedTabIds && f.tabId !== undefined && r.excludedTabIds.has(f.tabId)) return false
  if (!matchesDomains(f.hostSuffixes, r.requestDomains, r.excludedRequestDomains)) return false
  if (r.excludedNonUniqueHosts && isNonUniqueHost(f.host)) return false
  if (r.initiatorDomains || r.excludedInitiatorDomains) {
    if (r.initiatorDomains && !f.initiatorHost) return false
    if (!matchesDomains(f.initiatorSuffixes, r.initiatorDomains, r.excludedInitiatorDomains))
      return false
  }
  if (r.regex) return r.regex.test(f.url)
  if (r.url) return r.url(f.url)
  return true
}

function factsFor(ctx: RequestContext): Facts {
  return new Facts(ctx)
}

/**
 * Whether the URL's authority carries user information (`https://user@host/`): the desktop's
 * `||host^` matcher is a regular expression over the URL that can meet the pattern in that part
 * too, while the index looks the request host up. Such URLs, rare in what a request hook sees,
 * take the linear scan.
 */
function hasUserInfo(url: string): boolean {
  const at = url.indexOf('@')
  if (at === -1) return false
  let start = url.indexOf('://')
  if (start === -1) return false
  start += 3
  for (let i = start; i < url.length; i++) {
    const c = url.charCodeAt(i)
    if (c === 47 || c === 63 || c === 35) return false // '/', '?', '#' end the authority
    if (c === 64) return true
  }
  return false
}

/**
 * What `tabIds` conditions compare against: the engine-level tab id when the host supplies one
 * (Electron's `webContents.id`, which is the Chrome tab id extensions see), otherwise the
 * decimal part of the host's own tab id.
 */
function tabIdFact(ctx: RequestContext): string | undefined {
  if (ctx.chromeTabId !== undefined) return String(ctx.chromeTabId)
  return ctx.tabId === undefined ? undefined : String(ctx.tabId).replace(/^\D+/, '')
}

/**
 * The navigation request of the document a request belongs to, which is what `allowAllRequests`
 * rules are matched against (Chrome allows the whole frame hierarchy under a matched document).
 * Main-frame navigations have no enclosing document.
 */
function frameContext(ctx: RequestContext): RequestContext | null {
  if (ctx.type === 'main_frame') return null
  const url = ctx.documentUrl ?? ctx.initiator
  if (!url) return null
  return {
    url,
    type: 'main_frame',
    method: 'GET',
    isThirdParty: false,
    tabId: ctx.tabId,
    chromeTabId: ctx.chromeTabId,
    partition: ctx.partition,
    isPrivate: ctx.isPrivate
  }
}

/**
 * Whether a set scoped to `partitions` applies to a request from `partition`. An unscoped set
 * applies everywhere; a scoped one only where the request's partition is known and listed.
 */
export function appliesToPartition(
  partitions: readonly string[] | undefined,
  partition: string | undefined
): boolean {
  if (!partitions) return true
  return partition !== undefined && partitions.includes(partition)
}

function samePartitions(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined
): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function decisionFor(r: CompiledRule, f: Facts): Decision | null {
  const matched = { setId: r.setId, ruleId: r.rule.id }
  switch (r.rule.action.type) {
    case 'allow':
    case 'allowAllRequests':
      return { action: 'allow', matched }
    case 'block':
      return { action: 'block', matched }
    case 'upgradeScheme':
      if (!/^http:\/\//i.test(f.url)) return null
      return { action: 'upgrade', redirectUrl: `https://${f.url.slice(7)}`, matched }
    case 'redirect': {
      const redirect = r.rule.action.redirect
      let target: string | null = null
      if (redirect?.url) target = redirect.url
      else if (redirect?.regexSubstitution && r.regex)
        target = applyRegexSubstitution(r.regex, f.url, redirect.regexSubstitution)
      if (!target || target === f.url) return null
      return { action: 'redirect', redirectUrl: target, matched }
    }
    default:
      return null
  }
}

/** The priority band (the set priority) an effective priority belongs to. */
function bandOf(effective: number): number {
  return Math.floor(effective / (RULE_PRIORITY_MAX + 1))
}

/**
 * Whether a claim beats `best`: higher effective priority, then higher rank, then the lower
 * `order` – the rule the linear scan meets first. The scan itself meets rules in `order`, so
 * for it the last clause never fires; the index reaches them in bucket order and needs it.
 */
function better(effective: number, rank: number, order: number, best: Candidate): boolean {
  if (effective !== best.effective) return effective > best.effective
  if (rank !== best.rank) return rank > best.rank
  return order < best.order
}

/**
 * One `decide` in progress: the winner so far and the `modifyHeaders` rules met, fed by either
 * path (the indexed lookup or the linear scan) in whatever order it reaches the rules.
 */
class Resolution {
  best: Candidate | null = null
  readonly headers: HeaderCandidate[] = []
  private frameCtx: RequestContext | null | undefined
  private frameFacts: Facts | null = null

  constructor(
    private readonly ctx: RequestContext,
    readonly facts: Facts
  ) {}

  /**
   * Whether the rule matches the request – or, for `allowAllRequests`, the document the request
   * belongs to (everything under an excepted document is allowed).
   */
  matches(r: CompiledRule): boolean {
    if (ruleMatches(r, this.ctx, this.facts)) return true
    if (!r.allowAll) return false
    if (this.frameCtx === undefined) {
      this.frameCtx = frameContext(this.ctx)
      this.frameFacts = this.frameCtx ? factsFor(this.frameCtx) : null
    }
    return (
      this.frameCtx !== null &&
      this.frameFacts !== null &&
      ruleMatches(r, this.frameCtx, this.frameFacts)
    )
  }

  /** A rule that matched, met at `order`. */
  claim(r: CompiledRule, order: number): void {
    if (r.rule.action.type === 'modifyHeaders') {
      this.headers.push({ rule: r, order })
      return
    }
    const decision = decisionFor(r, this.facts)
    if (!decision) return
    if (!this.best || better(r.effective, r.rank, order, this.best))
      this.best = { effective: r.effective, rank: r.rank, order, decision }
  }

  /** Whether `set` can still change the outcome: a lower band cannot beat a definitive winner. */
  worthScanning(set: StoredSet): boolean {
    return !this.best || set.summary.priority >= bandOf(this.best.effective)
  }
}

/**
 * The blocking engine: structured rules evaluated with declarativeNetRequest semantics plus an
 * optional platform text matcher for ABP filter lists (see `rules.ts` for the contract).
 *
 * Pure and synchronous. Persistence is a subscriber (`RuleSetStore`), so the engine never holds
 * on to filter text: `setRuleSet` compiles, notifies listeners (who see the text once) and keeps
 * only the summary.
 *
 * Decisions go through a per-set {@link RuleIndex} (`decide`); the linear scan of every rule is
 * kept as `decideLinear`, the reference the index is tested against. Indexes are only built on
 * an engine that decides – the first `decide` turns them on – so a host whose native engine
 * decides (Android) compiles and persists sets without paying for them. A small set is indexed
 * as it is set; a large one answers through the scan while its index is built in slices between
 * decisions, then swapped in.
 */
export class RuleEngine implements BlockingEngine {
  private readonly sets = new Map<string, StoredSet>()
  /** Sets ordered by priority (highest first), rebuilt lazily. */
  private ordered: StoredSet[] | null = null
  private textMatcher: TextMatcher | null = null
  private readonly listeners = new Set<RuleSetListener>()
  /** Whether sets get indexes: on from the first `decide`. */
  private indexing = false
  private readonly indexJobs: IndexJob[] = []
  private indexTimer: ReturnType<typeof setTimeout> | null = null
  /** Stamp of the current `decide`, marking the rules the index has visited for it. */
  private stamp = 0

  /**
   * Add or replace a set. `options.persisted` registers a set whose text already lives on disk
   * (startup, bundled snapshots) without re-writing it.
   */
  setRuleSet(
    input: RuleSet,
    options: { persisted?: boolean; filterCount?: number; hasFilterText?: boolean } = {}
  ): void {
    const rules = Array.isArray(input.rules) ? input.rules : []
    const compiled: CompiledRule[] = []
    for (const rule of rules) {
      const c = compileRule(input.id, input.priority, rule)
      if (c) compiled.push(c)
    }
    compiled.sort((a, b) => b.effective - a.effective || b.rank - a.rank)
    compiled.forEach((c, i) => {
      c.position = i
    })
    const hasFilterText =
      input.filterText !== undefined ? input.filterText.length > 0 : Boolean(options.hasFilterText)
    const filterCount =
      input.filterText !== undefined
        ? countNetworkFilters(input.filterText)
        : (options.filterCount ?? 0)
    const summary: RuleSetSummary = {
      id: input.id,
      source: input.source,
      priority: input.priority,
      enabled: input.enabled,
      ruleCount: compiled.length,
      filterCount,
      hasFilterText
    }
    if (input.version !== undefined) summary.version = input.version
    if (input.updatedAt !== undefined) summary.updatedAt = input.updatedAt
    if (input.attribution) summary.attribution = { ...input.attribution }
    if (input.partitions) summary.partitions = [...input.partitions]
    const stored: StoredSet = { summary, rules, compiled, index: null }
    this.sets.set(input.id, stored)
    this.ordered = null
    if (this.indexing) this.indexSet(stored)
    this.notify({
      kind: 'set',
      id: input.id,
      set: input,
      summary: { ...summary },
      persisted: options.persisted === true
    })
  }

  removeRuleSet(id: string): void {
    if (!this.sets.delete(id)) return
    this.ordered = null
    this.notify({ kind: 'remove', id })
  }

  /**
   * Finish every pending index build now. Tests call it to decide through the indexes of large
   * sets deterministically; a host may before it measures.
   */
  buildIndexes(): void {
    if (!this.indexing) this.startIndexing()
    while (this.indexJobs.length > 0) this.advanceIndexJob(Infinity)
    if (this.indexTimer !== null) {
      clearTimeout(this.indexTimer)
      this.indexTimer = null
    }
  }

  /** How the rules of a set are indexed, for tests and diagnostics; undefined until it is indexed. */
  indexOf(id: string): RuleIndex<CompiledRule> | null | undefined {
    const stored = this.sets.get(id)
    return stored ? stored.index : undefined
  }

  /** Turn indexing on: every set gets an index, small ones now and large ones in slices. */
  private startIndexing(): void {
    this.indexing = true
    for (const stored of this.sets.values()) if (!stored.index) this.indexSet(stored)
  }

  private indexSet(stored: StoredSet): void {
    if (stored.compiled.length <= INDEX_INLINE_LIMIT) {
      stored.index = RuleIndex.build(stored.compiled)
      return
    }
    this.indexJobs.push({ stored, builder: new RuleIndexBuilder(stored.compiled) })
    this.scheduleIndexSlice()
  }

  private scheduleIndexSlice(): void {
    if (this.indexTimer !== null) return
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null
      this.indexSlice()
    }, 0)
  }

  /** Build for `INDEX_SLICE_MS`, then hand the tick back and continue on the next one. */
  private indexSlice(): void {
    const deadline = now() + INDEX_SLICE_MS
    while (this.indexJobs.length > 0) {
      this.advanceIndexJob(INDEX_STEP_RULES)
      if (this.indexJobs.length > 0 && now() >= deadline) {
        this.scheduleIndexSlice()
        return
      }
    }
  }

  /** Advance the first pending build by `work` rules; drop it if its set was replaced meanwhile. */
  private advanceIndexJob(work: number): void {
    const job = this.indexJobs[0]
    if (this.sets.get(job.stored.summary.id) !== job.stored) {
      this.indexJobs.shift()
      return
    }
    if (job.builder.step(work)) {
      job.stored.index = job.builder.result
      this.indexJobs.shift()
    }
  }

  listRuleSets(): RuleSetSummary[] {
    return this.orderedSets().map((s) => ({ ...s.summary }))
  }

  /** The structured rules of a set (for persistence and hosts that compile them to text). */
  rulesOf(id: string): Rule[] | undefined {
    return this.sets.get(id)?.rules
  }

  has(id: string): boolean {
    return this.sets.has(id)
  }

  /** Enable or disable a set without re-sending its content. */
  setEnabled(id: string, enabled: boolean): void {
    const stored = this.sets.get(id)
    if (!stored || stored.summary.enabled === enabled) return
    stored.summary.enabled = enabled
    this.notify({
      kind: 'set',
      id,
      set: this.toRuleSet(stored),
      summary: { ...stored.summary },
      persisted: true
    })
  }

  /**
   * Re-scope a set to other partitions (`undefined` for every partition) without re-sending
   * its content: an extension was loaded into, or unloaded from, a session.
   */
  setPartitions(id: string, partitions: readonly string[] | undefined): void {
    const stored = this.sets.get(id)
    if (!stored || samePartitions(stored.summary.partitions, partitions)) return
    if (partitions) stored.summary.partitions = [...partitions]
    else delete stored.summary.partitions
    this.notify({
      kind: 'set',
      id,
      set: this.toRuleSet(stored),
      summary: { ...stored.summary },
      persisted: true
    })
  }

  /** Refresh a set's metadata (version, timestamp, attribution) without touching its content. */
  setMetadata(id: string, patch: Pick<RuleSet, 'version' | 'updatedAt' | 'attribution'>): void {
    const stored = this.sets.get(id)
    if (!stored) return
    if (patch.version !== undefined) stored.summary.version = patch.version
    if (patch.updatedAt !== undefined) stored.summary.updatedAt = patch.updatedAt
    if (patch.attribution) stored.summary.attribution = { ...patch.attribution }
    this.notify({
      kind: 'set',
      id,
      set: this.toRuleSet(stored),
      summary: { ...stored.summary },
      persisted: true
    })
  }

  summary(id: string): RuleSetSummary | undefined {
    const stored = this.sets.get(id)
    return stored ? { ...stored.summary } : undefined
  }

  /** Install (or clear) the platform's matcher for `filterText` sets. */
  setTextMatcher(matcher: TextMatcher | null): void {
    this.textMatcher = matcher
  }

  /** Ids of enabled sets that have filter text, highest priority first. */
  enabledTextSets(): RuleSetSummary[] {
    return this.orderedSets()
      .filter((s) => s.summary.enabled && s.summary.hasFilterText)
      .map((s) => s.summary)
  }

  subscribe(listener: RuleSetListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Decide a request through the sets' indexes: each enabled set that applies, highest priority
   * first, contributes the rules its index finds for the request, and the claim with the highest
   * effective priority, then rank, then the earliest position wins – the same rule as
   * {@link decideLinear}. A set whose index is not built yet is scanned.
   */
  decide(ctx: RequestContext): Decision {
    if (!this.indexing) this.startIndexing()
    // The `||host^` matcher can meet its host in the user information of a URL, where the index
    // does not look: such requests (which Chromium's network stack does not make) are scanned.
    if (hasUserInfo(ctx.url)) return this.decideLinear(ctx)
    const resolution = new Resolution(ctx, factsFor(ctx))
    const stamp = ++this.stamp
    const ordered = this.orderedSets()
    for (let i = 0; i < ordered.length; i++) {
      const stored = ordered[i]
      if (!stored.summary.enabled || stored.compiled.length === 0) continue
      if (!appliesToPartition(stored.summary.partitions, ctx.partition)) continue
      if (!resolution.worthScanning(stored)) break
      const index = stored.index
      if (!index) {
        this.scanSet(stored, i, resolution)
        continue
      }
      const base = i * ORDER_BASE
      for (const r of index.allowAll)
        if (resolution.matches(r)) resolution.claim(r, base + r.position)
      index.forEachCandidate(resolution.facts, (r) => {
        if (r.seen === stamp) return
        r.seen = stamp
        if (resolution.matches(r)) resolution.claim(r, base + r.position)
      })
    }
    return this.conclude(ctx, resolution)
  }

  /**
   * The reference decision: every rule of every applicable set tested in order. What `decide`
   * must agree with, rule for rule; slower by the size of the sets.
   */
  decideLinear(ctx: RequestContext): Decision {
    const resolution = new Resolution(ctx, factsFor(ctx))
    const ordered = this.orderedSets()
    for (let i = 0; i < ordered.length; i++) {
      const stored = ordered[i]
      if (!stored.summary.enabled || stored.compiled.length === 0) continue
      if (!appliesToPartition(stored.summary.partitions, ctx.partition)) continue
      if (!resolution.worthScanning(stored)) break
      this.scanSet(stored, i, resolution)
    }
    return this.conclude(ctx, resolution)
  }

  private scanSet(stored: StoredSet, setIndex: number, resolution: Resolution): void {
    const base = setIndex * ORDER_BASE
    for (const r of stored.compiled)
      if (resolution.matches(r)) resolution.claim(r, base + r.position)
  }

  /** Weigh the text matcher's answer against the structured claims and apply header rules. */
  private conclude(ctx: RequestContext, resolution: Resolution): Decision {
    let best = resolution.best
    if (
      this.textMatcher &&
      !(best && best.decision.action === 'allow' && best.effective >= TEXT_EFFECTIVE) &&
      (!best || best.effective <= TEXT_EFFECTIVE)
    ) {
      const text = this.textMatcher.match(ctx)
      if (text) {
        const decision: Decision =
          text.action === 'redirect' && text.redirectUrl
            ? { action: 'redirect', redirectUrl: text.redirectUrl }
            : { action: text.action === 'allow' ? 'allow' : 'block' }
        decision.matched = { setId: TEXT_MATCH_SET_ID, filter: text.filter }
        const rank = RANK[text.action] ?? 0
        // Met after every structured rule: a structured rule it ties with wins.
        if (!best || better(TEXT_EFFECTIVE, rank, Infinity, best))
          best = { effective: TEXT_EFFECTIVE, rank, order: Infinity, decision }
      }
    }

    if (best && best.decision.action !== 'allow') return best.decision

    const allowEffective = best ? best.effective : -1
    const applicable = resolution.headers.filter((h) => h.rule.effective > allowEffective)
    if (applicable.length === 0) return best ? best.decision : ALLOW
    applicable.sort((a, b) => b.rule.effective - a.rule.effective || a.order - b.order)
    const requestHeaders: HeaderOp[] = []
    const responseHeaders: HeaderOp[] = []
    for (const { rule: r } of applicable) {
      if (r.rule.action.requestHeaders) requestHeaders.push(...r.rule.action.requestHeaders)
      if (r.rule.action.responseHeaders) responseHeaders.push(...r.rule.action.responseHeaders)
    }
    const first = applicable[0].rule
    return {
      action: 'modifyHeaders',
      requestHeaders,
      responseHeaders,
      matched: { setId: first.setId, ruleId: first.rule.id }
    }
  }

  private orderedSets(): StoredSet[] {
    if (!this.ordered) {
      this.ordered = [...this.sets.values()].sort(
        (a, b) =>
          b.summary.priority - a.summary.priority || a.summary.id.localeCompare(b.summary.id)
      )
    }
    return this.ordered
  }

  private toRuleSet(stored: StoredSet): RuleSet {
    const s = stored.summary
    const out: RuleSet = {
      id: s.id,
      source: s.source,
      priority: s.priority,
      enabled: s.enabled,
      rules: stored.rules
    }
    if (s.version !== undefined) out.version = s.version
    if (s.updatedAt !== undefined) out.updatedAt = s.updatedAt
    if (s.attribution) out.attribution = s.attribution
    if (s.partitions) out.partitions = [...s.partitions]
    return out
  }

  private notify(change: RuleSetChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change)
      } catch (error) {
        console.error('[zenium] blocking listener failed', error)
      }
    }
  }
}

/** Effective priority of a filter-text match, exported for tests. */
export const TEXT_MATCH_EFFECTIVE_PRIORITY = TEXT_EFFECTIVE

/** Resource type of a request as Chromium's webRequest / Electron names it. */
export function resourceTypeFromElectron(type: string): ResourceType {
  switch (type) {
    case 'mainFrame':
    case 'main_frame':
      return 'main_frame'
    case 'subFrame':
    case 'sub_frame':
      return 'sub_frame'
    case 'stylesheet':
      return 'stylesheet'
    case 'script':
      return 'script'
    case 'image':
      return 'image'
    case 'font':
      return 'font'
    case 'object':
      return 'object'
    case 'xhr':
    case 'xmlhttprequest':
      return 'xmlhttprequest'
    case 'ping':
      return 'ping'
    case 'cspReport':
    case 'csp_report':
      return 'csp_report'
    case 'media':
      return 'media'
    case 'webSocket':
    case 'websocket':
      return 'websocket'
    case 'webtransport':
      return 'webtransport'
    case 'webbundle':
      return 'webbundle'
    default:
      return 'other'
  }
}

/** Convenience for hosts: the registrable domain of a document for per-site lookups. */
export { domainOf }
