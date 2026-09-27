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
import { indexReceivedHeaders, matchesHeaderStage, type ReceivedHeaders } from './headerCondition'
import { isNonUniqueHost } from '../../shared/nonUniqueHost'
import { isExtensionPageUrl } from '../extensions/runtime/extensionUrls'
import { applyRegexSubstitution } from './urlFilter'
import { countNetworkFilters } from './lists'
import {
  RowIndex,
  RowIndexBuilder,
  hostSuffixes,
  tokenize,
  typeBit,
  type IndexLookup
} from './ruleIndex'
import {
  ACTION,
  FLAG,
  RuleTable,
  bandOf,
  compilableCount,
  effectivePriority,
  rankOf,
  type UrlFacts
} from './ruleTable'

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

interface StoredSet {
  summary: RuleSetSummary
  rules: Rule[]
  /**
   * The rules compiled as a struct-of-arrays table (`ruleTable.ts`), in resolution order: what
   * `decideLinear` scans and `index` is built from. Built by the first decision that reads the
   * set (or by `setRuleSet` once the engine indexes), so a host whose native engine decides
   * (Android) never holds one: after `setRuleSet` it keeps the `rules` and the summary alone.
   */
  table: RuleTable | null
  /** The set's index, or null while a large set's is still to be built (`decide` scans it then). */
  index: RowIndex | null
}

/**
 * A matching rule's claim. `order` is where the linear scan would have met it – the set's place
 * among the ordered sets above the rule's row – and breaks a full tie the way the scan does: the
 * first met wins. A filter-text match is met after every structured rule (`Infinity`).
 */
interface Candidate {
  effective: number
  rank: number
  order: number
  decision: Decision
}

/** A `modifyHeaders` rule that matched – a row of a table – with where the scan meets it. */
interface HeaderCandidate {
  table: RuleTable
  row: number
  effective: number
  order: number
}

/** `order` of a rule: `setIndex` above its row (rows stay below 2^32). */
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
  builder: RowIndexBuilder
}

const TEXT_EFFECTIVE = effectivePriority(RULE_SET_PRIORITY.filterList, 1)

/** Request facts computed once per `decide` call; also what the indexes are walked with. */
class Facts implements IndexLookup, UrlFacts {
  readonly url: string
  readonly type: ResourceType
  /** `typeBit(type)`: what a row's type masks are tested with. */
  readonly typeBit: number
  readonly host: string
  readonly initiatorHost: string
  /**
   * Host of the top-level document (Chrome's `top_level_frame_or_initiator_host`): a main-frame
   * navigation's own host, else the document's, else the initiator's; '' when unknown.
   */
  readonly topHost: string
  readonly method: string
  readonly thirdParty: boolean
  readonly tabId: string | undefined
  /** The host and its parent domains: what a domain condition is looked up by. */
  readonly hostSuffixes: string[]
  readonly initiatorSuffixes: string[]
  readonly topSuffixes: string[]
  /** The received headers, indexed; null at the request stage. */
  readonly headers: ReceivedHeaders | null
  private lowered: string | null = null
  private urlTokens: number[] | null = null

  constructor(ctx: RequestContext) {
    const initiator = ctx.initiator ?? ctx.documentUrl
    const top = ctx.type === 'main_frame' ? ctx.url : (ctx.documentUrl ?? ctx.initiator)
    this.url = ctx.url
    this.type = ctx.type
    this.typeBit = typeBit(ctx.type)
    this.host = hostnameOf(ctx.url) ?? ''
    this.initiatorHost = initiator ? (hostnameOf(initiator) ?? '') : ''
    this.topHost = top ? (hostnameOf(top) ?? '') : ''
    this.method = (ctx.method || 'GET').toLowerCase()
    this.thirdParty = ctx.isThirdParty ?? isThirdParty(ctx.url, initiator)
    this.tabId = tabIdFact(ctx)
    this.hostSuffixes = hostSuffixes(this.host)
    this.initiatorSuffixes = this.initiatorHost ? hostSuffixes(this.initiatorHost) : []
    this.topSuffixes = this.topHost ? hostSuffixes(this.topHost) : []
    this.headers = ctx.responseHeaders ? indexReceivedHeaders(ctx.responseHeaders) : null
  }

  /** The URL lowercased, once per request: what plain `urlFilter` substrings are looked for in. */
  lowerUrl(): string {
    return (this.lowered ??= this.url.toLowerCase())
  }

  /** Tokens of the lowercased URL, for the token buckets; computed on first use. */
  tokens(): number[] {
    return (this.urlTokens ??= tokenize(this.lowerUrl()))
  }
}

/** Whether row `row` of `t` matches the request `f` describes (every condition but the header stage's). */
function ruleMatches(t: RuleTable, row: number, f: Facts): boolean {
  const types = t.types[row]!
  if (types !== 0 && (types & f.typeBit) === 0) return false
  const excludedTypes = t.excludedTypes[row]!
  if (excludedTypes !== 0 && (excludedTypes & f.typeBit) !== 0) return false
  const methods = t.methods[row]!
  if (methods >= 0 && !t.stringSets[methods]!.has(f.method)) return false
  const excludedMethods = t.excludedMethods[row]!
  if (excludedMethods >= 0 && t.stringSets[excludedMethods]!.has(f.method)) return false
  const flags = t.flags[row]!
  if ((flags & FLAG.thirdParty) !== 0 && !f.thirdParty) return false
  if ((flags & FLAG.firstParty) !== 0 && f.thirdParty) return false
  const tabIds = t.tabIds[row]!
  if (tabIds >= 0 && (f.tabId === undefined || !t.stringSets[tabIds]!.has(f.tabId))) return false
  const excludedTabIds = t.excludedTabIds[row]!
  if (excludedTabIds >= 0 && f.tabId !== undefined && t.stringSets[excludedTabIds]!.has(f.tabId))
    return false
  if (!t.matchesDomains(f.hostSuffixes, t.requestDomains[row]!, t.excludedRequestDomains[row]!))
    return false
  if ((flags & FLAG.excludedNonUniqueHosts) !== 0 && isNonUniqueHost(f.host)) return false
  const initiatorDomains = t.initiatorDomains[row]!
  const excludedInitiatorDomains = t.excludedInitiatorDomains[row]!
  if (initiatorDomains >= 0 || excludedInitiatorDomains >= 0) {
    if (initiatorDomains >= 0 && !f.initiatorHost) return false
    if (!t.matchesDomains(f.initiatorSuffixes, initiatorDomains, excludedInitiatorDomains))
      return false
  }
  const topDomains = t.topDomains[row]!
  const excludedTopDomains = t.excludedTopDomains[row]!
  if (topDomains >= 0 || excludedTopDomains >= 0) {
    if (topDomains >= 0 && !f.topHost) return false
    if (!t.matchesDomains(f.topSuffixes, topDomains, excludedTopDomains)) return false
  }
  return t.urlMatches(row, f)
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

function decisionFor(t: RuleTable, row: number, f: Facts): Decision | null {
  const rule = t.ruleOf(row)
  const matched = { setId: t.setId, ruleId: rule.id }
  switch (t.action[row]) {
    case ACTION.allow:
    case ACTION.allowAllRequests:
      return { action: 'allow', matched }
    case ACTION.block:
      return { action: 'block', matched }
    case ACTION.upgradeScheme:
      if (!/^http:\/\//i.test(f.url)) return null
      return { action: 'upgrade', redirectUrl: `https://${f.url.slice(7)}`, matched }
    case ACTION.redirect: {
      const redirect = rule.action.redirect
      let target: string | null = null
      if (redirect?.url) target = redirect.url
      else if (redirect?.regexSubstitution) {
        const regex = t.regexFilterOf(row)
        if (regex) target = applyRegexSubstitution(regex, f.url, redirect.regexSubstitution)
      }
      if (!target || target === f.url) return null
      return { action: 'redirect', redirectUrl: target, matched }
    }
    default:
      return null
  }
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
 *
 * Rules with response header conditions (`headerStage`) are kept apart: without received
 * headers (the request stage) a matching one only raises `lateEffective`, the strongest such
 * rule whose other conditions passed; with them (the headers-received stage) its header
 * conditions are tested too and it claims as `bestLate` / `lateHeaders`, which `conclude` merges
 * with the request stage's claims.
 */
class Resolution {
  best: Candidate | null = null
  readonly headers: HeaderCandidate[] = []
  /** The header stage's winner and header edits (only with received headers). */
  bestLate: Candidate | null = null
  readonly lateHeaders: HeaderCandidate[] = []
  /** Request stage: the strongest header-conditioned rule whose other conditions passed. */
  lateEffective = -1
  private frameCtx: RequestContext | null | undefined
  private frameFacts: Facts | null = null

  constructor(
    private readonly ctx: RequestContext,
    readonly facts: Facts
  ) {}

  /**
   * Whether the rule matches the request – or, for `allowAllRequests`, the document the request
   * belongs to (everything under an excepted document is allowed). The document's headers are
   * not at hand, so a header-conditioned `allowAllRequests` only matches the frame request.
   */
  matches(t: RuleTable, row: number): boolean {
    if (ruleMatches(t, row, this.facts)) return true
    const flags = t.flags[row]!
    if ((flags & FLAG.allowAll) === 0 || (flags & FLAG.headerStage) !== 0) return false
    if (this.frameCtx === undefined) {
      this.frameCtx = frameContext(this.ctx)
      this.frameFacts = this.frameCtx ? factsFor(this.frameCtx) : null
    }
    return this.frameFacts !== null && ruleMatches(t, row, this.frameFacts)
  }

  /** A rule that matched – row `row` of `t` – met at `order`. */
  claim(t: RuleTable, row: number, order: number): void {
    const effective = t.effectiveOf(row)
    const headerStage = (t.flags[row]! & FLAG.headerStage) !== 0
    if (headerStage) {
      if (!this.facts.headers) {
        this.lateEffective = Math.max(this.lateEffective, effective)
        return
      }
      if (
        !matchesHeaderStage(
          this.facts.headers,
          t.headerConditionsOf(t.responseHeaders[row]!),
          t.headerConditionsOf(t.excludedResponseHeaders[row]!)
        )
      )
        return
    }
    if (t.action[row] === ACTION.modifyHeaders) {
      ;(headerStage ? this.lateHeaders : this.headers).push({ table: t, row, effective, order })
      return
    }
    const decision = decisionFor(t, row, this.facts)
    if (!decision) return
    const rank = t.rankOf(row)
    const candidate = { effective, rank, order, decision }
    if (headerStage) {
      if (!this.bestLate || better(effective, rank, order, this.bestLate)) this.bestLate = candidate
    } else if (!this.best || better(effective, rank, order, this.best)) this.best = candidate
  }

  /**
   * Whether `set` can still change the outcome: a lower band cannot beat a definitive winner
   * (nor, when that winner is an allow, get past the cap it puts on both stages' header rules).
   */
  worthScanning(set: StoredSet): boolean {
    return !this.best || set.summary.priority >= bandOf(this.best.effective)
  }
}

/**
 * The `modifyHeaders` decision of `applicable` (already capped), highest effective priority
 * first and, within one, in the order the scan meets them; `otherwise` when none is left.
 */
function composeHeaderEdits(applicable: HeaderCandidate[], otherwise: Decision): Decision {
  if (applicable.length === 0) return otherwise
  applicable.sort((a, b) => b.effective - a.effective || a.order - b.order)
  const requestHeaders: HeaderOp[] = []
  const responseHeaders: HeaderOp[] = []
  for (const { table, row } of applicable) {
    const action = table.ruleOf(row).action
    // A header-conditioned rule decides once the request is out, so it can only edit the
    // response (Chrome refuses its `requestHeaders` at parse:
    // ERROR_RESPONSE_HEADER_RULE_CANNOT_MODIFY_REQUEST_HEADERS); a set written by hand gets the
    // same treatment here.
    if (action.requestHeaders && (table.flags[row]! & FLAG.headerStage) === 0)
      requestHeaders.push(...action.requestHeaders)
    if (action.responseHeaders) responseHeaders.push(...action.responseHeaders)
  }
  const first = applicable[0]!
  return {
    action: 'modifyHeaders',
    requestHeaders,
    responseHeaders,
    matched: { setId: first.table.setId, ruleId: first.table.ruleOf(first.row).id }
  }
}

/** Every row of `table` (the set at `setIndex` among the ordered sets) tested in order. */
function scanTable(table: RuleTable, setIndex: number, resolution: Resolution): void {
  const base = setIndex * ORDER_BASE
  for (let row = 0; row < table.size; row++)
    if (resolution.matches(table, row)) resolution.claim(table, row, base + row)
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
    // Counted, not compiled: the table is built by the first decision that needs it.
    const ruleCount = compilableCount(rules)
    const hasFilterText =
      input.filterText !== undefined ? input.filterText.length > 0 : Boolean(options.hasFilterText)
    // A caller that prepared the text (`prepareListText`, in the background worker) knows the
    // count; the megabytes are not scanned again for it.
    const filterCount =
      options.filterCount ??
      (input.filterText !== undefined ? countNetworkFilters(input.filterText) : 0)
    const summary: RuleSetSummary = {
      id: input.id,
      source: input.source,
      priority: input.priority,
      enabled: input.enabled,
      ruleCount,
      filterCount,
      hasFilterText
    }
    if (input.version !== undefined) summary.version = input.version
    if (input.updatedAt !== undefined) summary.updatedAt = input.updatedAt
    if (input.attribution) summary.attribution = { ...input.attribution }
    if (input.partitions) summary.partitions = [...input.partitions]
    const stored: StoredSet = { summary, rules, table: null, index: null }
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
  indexOf(id: string): RowIndex | null | undefined {
    const stored = this.sets.get(id)
    return stored ? stored.index : undefined
  }

  /**
   * The set's compiled table, for tests and diagnostics: null until a decision (or the engine's
   * indexing) has built it – on a host that never decides in JavaScript, never.
   */
  tableOf(id: string): RuleTable | null | undefined {
    const stored = this.sets.get(id)
    return stored ? stored.table : undefined
  }

  /** The set's table, built now if it is not yet. */
  private table(stored: StoredSet): RuleTable {
    return (stored.table ??= RuleTable.build(
      stored.summary.id,
      stored.summary.priority,
      stored.rules
    ))
  }

  /** Turn indexing on: every set gets an index, small ones now and large ones in slices. */
  private startIndexing(): void {
    this.indexing = true
    for (const stored of this.sets.values()) if (!stored.index) this.indexSet(stored)
  }

  private indexSet(stored: StoredSet): void {
    const table = this.table(stored)
    if (table.size <= INDEX_INLINE_LIMIT) {
      stored.index = RowIndex.build(table)
      return
    }
    this.indexJobs.push({ stored, builder: new RowIndexBuilder(table) })
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
   *
   * Without `ctx.responseHeaders` this is the request stage: rules with response header
   * conditions are left aside (a decision whose other conditions such a rule passed carries
   * `needsHeaders`). With them it is the headers-received stage: those rules are evaluated too
   * and the two stages merge as Chrome's `RulesetManager` merges them – a request-stage allow
   * caps the header stage, a header-stage allow caps the request stage's header edits, a
   * header-stage block or redirect wins over header edits of either stage, and the
   * `modifyHeaders` rules of both stages apply together, highest priority first.
   *
   * A request for an extension's own page – `chrome-extension://<id>/…`, or the origin the
   * Android runtime serves it on – is allowed before any rule is looked at, as Chrome's
   * `RulesetManager` never evaluates its rules against an extension's pages (contract 1.11).
   * Only the request's URL is read: a request an extension page makes to the web is evaluated
   * like any other, and a redirect whose target is an extension page still fires.
   */
  decide(ctx: RequestContext): Decision {
    if (isExtensionPageUrl(ctx.url)) return ALLOW
    if (!this.indexing) this.startIndexing()
    // The `||host^` matcher can meet its host in the user information of a URL, where the index
    // does not look: such requests (which Chromium's network stack does not make) are scanned.
    if (hasUserInfo(ctx.url)) return this.decideLinear(ctx)
    const resolution = new Resolution(ctx, factsFor(ctx))
    const stamp = this.nextStamp()
    const ordered = this.orderedSets()
    for (let i = 0; i < ordered.length; i++) {
      const stored = ordered[i]!
      if (!stored.summary.enabled || stored.summary.ruleCount === 0) continue
      if (!appliesToPartition(stored.summary.partitions, ctx.partition)) continue
      if (!resolution.worthScanning(stored)) break
      const table = this.table(stored)
      const index = stored.index
      if (!index) {
        scanTable(table, i, resolution)
        continue
      }
      const base = i * ORDER_BASE
      const allowAll = index.allowAll
      for (let k = 0; k < allowAll.length; k++) {
        const row = allowAll[k]!
        if (resolution.matches(table, row)) resolution.claim(table, row, base + row)
      }
      const seen = table.seen
      index.forEachCandidate(resolution.facts, (row) => {
        if (seen[row] === stamp) return
        seen[row] = stamp
        if (resolution.matches(table, row)) resolution.claim(table, row, base + row)
      })
    }
    return this.conclude(ctx, resolution)
  }

  /**
   * The stamp of the next `decide`. Stamps live in each table's `seen` column (32 bits): when
   * they run out, every column is cleared and they start over.
   */
  private nextStamp(): number {
    if (this.stamp === 0xffffffff) {
      this.stamp = 0
      for (const stored of this.sets.values()) stored.table?.seen.fill(0)
    }
    return ++this.stamp
  }

  /**
   * The reference decision: every rule of every applicable set tested in order. What `decide`
   * must agree with, rule for rule; slower by the size of the sets.
   */
  decideLinear(ctx: RequestContext): Decision {
    if (isExtensionPageUrl(ctx.url)) return ALLOW
    const resolution = new Resolution(ctx, factsFor(ctx))
    const ordered = this.orderedSets()
    for (let i = 0; i < ordered.length; i++) {
      const stored = ordered[i]!
      if (!stored.summary.enabled || stored.summary.ruleCount === 0) continue
      if (!appliesToPartition(stored.summary.partitions, ctx.partition)) continue
      if (!resolution.worthScanning(stored)) break
      scanTable(this.table(stored), i, resolution)
    }
    return this.conclude(ctx, resolution)
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
        const rank = rankOf(text.action)
        // Met after every structured rule: a structured rule it ties with wins.
        if (!best || better(TEXT_EFFECTIVE, rank, Infinity, best))
          best = { effective: TEXT_EFFECTIVE, rank, order: Infinity, decision }
      }
    }

    if (best && best.decision.action !== 'allow') return best.decision

    // The request stage's allow caps everything the header stage found.
    const allowEffective = best ? best.effective : -1
    if (resolution.facts.headers === null) {
      const decision = composeHeaderEdits(
        resolution.headers.filter((h) => h.effective > allowEffective),
        best?.decision ?? ALLOW
      )
      // A second round is only worth it when a header rule could beat the request stage's allow.
      return resolution.lateEffective > allowEffective
        ? { ...decision, needsHeaders: true }
        : decision
    }
    let bestLate = resolution.bestLate
    if (bestLate && bestLate.effective <= allowEffective) bestLate = null
    if (bestLate && bestLate.decision.action !== 'allow') return bestLate.decision
    // A header-stage allow caps the request stage's header edits (Chrome keeps the ones of equal
    // or higher priority) and its own stage's (strictly higher).
    const lateAllowEffective = bestLate ? bestLate.effective : -1
    const applicable = [
      ...resolution.headers.filter(
        (h) => h.effective > allowEffective && h.effective >= lateAllowEffective
      ),
      ...resolution.lateHeaders.filter(
        (h) => h.effective > Math.max(allowEffective, lateAllowEffective)
      )
    ]
    return composeHeaderEdits(applicable, bestLate?.decision ?? best?.decision ?? ALLOW)
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
