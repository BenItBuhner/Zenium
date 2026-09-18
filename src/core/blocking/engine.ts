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
import { domainOf, hostMatchesDomain, hostnameOf, isThirdParty } from './domain'
import {
  compileHeaderConditions,
  indexReceivedHeaders,
  matchesHeaderStage,
  type ReceivedHeaders
} from './headerCondition'
import { isNonUniqueHost } from '../../shared/nonUniqueHost'
import {
  applyRegexSubstitution,
  compileRegexFilter,
  compileUrlFilter,
  type UrlPredicate
} from './urlFilter'
import { countNetworkFilters } from './lists'

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
  url: UrlPredicate | null
  regex: RegExp | null
  initiatorDomains: string[] | null
  excludedInitiatorDomains: string[] | null
  requestDomains: string[] | null
  excludedRequestDomains: string[] | null
  topDomains: string[] | null
  excludedTopDomains: string[] | null
  excludedNonUniqueHosts: boolean
  resourceTypes: Set<ResourceType> | null
  excludedResourceTypes: Set<ResourceType> | null
  methods: Set<string> | null
  excludedMethods: Set<string> | null
  domainType: 'firstParty' | 'thirdParty' | null
  tabIds: Set<string> | null
  excludedTabIds: Set<string> | null
  responseHeaders: ReturnType<typeof compileHeaderConditions>
  excludedResponseHeaders: ReturnType<typeof compileHeaderConditions>
  /** The rule is decided at the headers-received stage (it has a header condition). */
  headerStage: boolean
}

interface StoredSet {
  summary: RuleSetSummary
  rules: Rule[]
  compiled: CompiledRule[]
}

interface Candidate {
  effective: number
  rank: number
  decision: Decision
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

function lower(list: string[] | undefined): string[] | null {
  return list && list.length > 0 ? list.map((d) => d.toLowerCase()) : null
}

function set<T>(list: T[] | undefined): Set<T> | null {
  return list && list.length > 0 ? new Set(list) : null
}

function compileRule(setId: string, setPriority: number, rule: Rule): CompiledRule | null {
  const c = rule.condition ?? {}
  const caseSensitive = c.isUrlFilterCaseSensitive === true
  let url: UrlPredicate | null = null
  let regex: RegExp | null = null
  if (c.regexFilter !== undefined) {
    regex = compileRegexFilter(c.regexFilter, caseSensitive)
    if (!regex) return null
  } else if (c.urlFilter) {
    url = compileUrlFilter(c.urlFilter, caseSensitive)
  }
  return {
    setId,
    effective: effectivePriority(setPriority, rule.priority),
    rank: RANK[rule.action.type] ?? 0,
    rule,
    url,
    regex,
    initiatorDomains: lower(c.initiatorDomains),
    excludedInitiatorDomains: lower(c.excludedInitiatorDomains),
    requestDomains: lower(c.requestDomains),
    excludedRequestDomains: lower(c.excludedRequestDomains),
    topDomains: lower(c.topDomains),
    excludedTopDomains: lower(c.excludedTopDomains),
    excludedNonUniqueHosts: c.excludedNonUniqueHosts === true,
    resourceTypes: set(c.resourceTypes),
    excludedResourceTypes: set(c.excludedResourceTypes),
    methods: c.requestMethods ? new Set(c.requestMethods.map((m) => m.toLowerCase())) : null,
    excludedMethods: c.excludedRequestMethods
      ? new Set(c.excludedRequestMethods.map((m) => m.toLowerCase()))
      : null,
    domainType: c.domainType ?? null,
    tabIds: c.tabIds ? new Set(c.tabIds.map(String)) : null,
    excludedTabIds: c.excludedTabIds ? new Set(c.excludedTabIds.map(String)) : null,
    responseHeaders: compileHeaderConditions(c.responseHeaders),
    excludedResponseHeaders: compileHeaderConditions(c.excludedResponseHeaders),
    headerStage:
      (c.responseHeaders?.length ?? 0) > 0 || (c.excludedResponseHeaders?.length ?? 0) > 0
  }
}

/** Request facts computed once per `decide` call. */
interface Facts {
  url: string
  host: string
  initiatorHost: string
  /** Host of the top-level document, else of the initiator (Chrome's fallback); '' when unknown. */
  topHost: string
  method: string
  thirdParty: boolean
  tabId: string | undefined
  /** The received headers, indexed; null at the request stage. */
  headers: ReceivedHeaders | null
}

function matchesDomains(host: string, include: string[] | null, exclude: string[] | null): boolean {
  if (exclude && exclude.some((d) => hostMatchesDomain(host, d))) return false
  if (include) return include.some((d) => hostMatchesDomain(host, d))
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
  if (!matchesDomains(f.host, r.requestDomains, r.excludedRequestDomains)) return false
  if (r.excludedNonUniqueHosts && isNonUniqueHost(f.host)) return false
  if (r.initiatorDomains || r.excludedInitiatorDomains) {
    if (r.initiatorDomains && !f.initiatorHost) return false
    if (!matchesDomains(f.initiatorHost, r.initiatorDomains, r.excludedInitiatorDomains))
      return false
  }
  if (r.topDomains || r.excludedTopDomains) {
    if (r.topDomains && !f.topHost) return false
    if (!matchesDomains(f.topHost, r.topDomains, r.excludedTopDomains)) return false
  }
  if (r.regex) return r.regex.test(f.url)
  if (r.url) return r.url(f.url)
  return true
}

function factsFor(ctx: RequestContext): Facts {
  const initiator = ctx.initiator ?? ctx.documentUrl
  const top = ctx.documentUrl ?? ctx.initiator
  return {
    url: ctx.url,
    host: hostnameOf(ctx.url) ?? '',
    initiatorHost: initiator ? (hostnameOf(initiator) ?? '') : '',
    topHost: top ? (hostnameOf(top) ?? '') : '',
    method: (ctx.method || 'GET').toLowerCase(),
    thirdParty: ctx.isThirdParty ?? isThirdParty(ctx.url, initiator),
    tabId: tabIdFact(ctx),
    headers: ctx.responseHeaders ? indexReceivedHeaders(ctx.responseHeaders) : null
  }
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

/** Higher effective priority wins; inside one, the action rank (allow beats block, …). */
function beats(candidate: Candidate, best: Candidate | null): boolean {
  return (
    !best ||
    candidate.effective > best.effective ||
    (candidate.effective === best.effective && candidate.rank > best.rank)
  )
}

/**
 * The `modifyHeaders` decision of the header rules above `allowEffective`, highest priority
 * first; `otherwise` (the allow that capped them, or the default) when none is left.
 */
function composeHeaderEdits(
  headerRules: readonly CompiledRule[],
  allowEffective: number,
  otherwise: Decision
): Decision {
  const applicable = headerRules.filter((r) => r.effective > allowEffective)
  if (applicable.length === 0) return otherwise
  applicable.sort((a, b) => b.effective - a.effective)
  const requestHeaders: HeaderOp[] = []
  const responseHeaders: HeaderOp[] = []
  for (const r of applicable) {
    if (r.rule.action.requestHeaders) requestHeaders.push(...r.rule.action.requestHeaders)
    if (r.rule.action.responseHeaders) responseHeaders.push(...r.rule.action.responseHeaders)
  }
  const first = applicable[0]
  return {
    action: 'modifyHeaders',
    requestHeaders,
    responseHeaders,
    matched: { setId: first.setId, ruleId: first.rule.id }
  }
}

/**
 * The blocking engine: structured rules evaluated with declarativeNetRequest semantics plus an
 * optional platform text matcher for ABP filter lists (see `rules.ts` for the contract).
 *
 * Pure and synchronous. Persistence is a subscriber (`RuleSetStore`), so the engine never holds
 * on to filter text: `setRuleSet` compiles, notifies listeners (who see the text once) and keeps
 * only the summary.
 */
export class RuleEngine implements BlockingEngine {
  private readonly sets = new Map<string, StoredSet>()
  /** Sets ordered by priority (highest first), rebuilt lazily. */
  private ordered: StoredSet[] | null = null
  private textMatcher: TextMatcher | null = null
  private readonly listeners = new Set<RuleSetListener>()

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
    this.sets.set(input.id, { summary, rules, compiled })
    this.ordered = null
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
   * Decide a request. Without `ctx.responseHeaders` this is the request stage: rules with
   * response header conditions are left aside (a decision whose other conditions such a rule
   * passed carries `needsHeaders`). With them it is the headers-received stage: those rules are
   * evaluated too and the two stages merge as Chrome's `RulesetManager` merges them – a request
   * -stage allow caps the header stage, a header-stage allow caps the request stage's header
   * edits, a header-stage block or redirect wins over header edits of either stage, and the
   * `modifyHeaders` rules of both stages apply together, highest priority first.
   */
  decide(ctx: RequestContext): Decision {
    const f = factsFor(ctx)
    const headersStage = f.headers !== null
    let frameCtx: RequestContext | null | undefined
    let frameFacts: Facts | null = null
    // Request-stage winner (intercepting or allow) and header edits; then the header stage's.
    let best: Candidate | null = null
    const headerRules: CompiledRule[] = []
    let bestLate: Candidate | null = null
    const lateHeaderRules: CompiledRule[] = []
    // Request stage: the strongest header-conditioned rule whose other conditions passed.
    let lateEffective = -1

    for (const stored of this.orderedSets()) {
      if (!stored.summary.enabled || stored.compiled.length === 0) continue
      if (!appliesToPartition(stored.summary.partitions, ctx.partition)) continue
      // Lower bands cannot beat a definitive winner from a higher band.
      if (best && stored.summary.priority < Math.floor(best.effective / (RULE_PRIORITY_MAX + 1)))
        break
      for (const r of stored.compiled) {
        const type = r.rule.action.type
        // `allowAllRequests` matches the frame request itself or the document the request
        // belongs to (everything under an excepted document is allowed). The document's headers
        // are not at hand, so a header-conditioned one only matches the frame request itself.
        let hit = ruleMatches(r, ctx, f)
        if (!hit && type === 'allowAllRequests' && !r.headerStage) {
          if (frameCtx === undefined) {
            frameCtx = frameContext(ctx)
            frameFacts = frameCtx ? factsFor(frameCtx) : null
          }
          hit = frameCtx !== null && frameFacts !== null && ruleMatches(r, frameCtx, frameFacts)
        }
        if (!hit) continue
        if (r.headerStage) {
          if (!f.headers) {
            lateEffective = Math.max(lateEffective, r.effective)
            continue
          }
          if (!matchesHeaderStage(f.headers, r.responseHeaders, r.excludedResponseHeaders)) continue
        }
        if (type === 'modifyHeaders') {
          if (r.headerStage) lateHeaderRules.push(r)
          else headerRules.push(r)
          continue
        }
        const decision = decisionFor(r, f)
        if (!decision) continue
        const candidate = { effective: r.effective, rank: r.rank, decision }
        if (r.headerStage) {
          if (beats(candidate, bestLate)) bestLate = candidate
        } else if (beats(candidate, best)) best = candidate
      }
    }

    if (
      this.textMatcher &&
      !(best && best.decision.action === 'allow' && best.effective >= TEXT_EFFECTIVE)
    ) {
      if (!best || best.effective <= TEXT_EFFECTIVE) {
        const text = this.textMatcher.match(ctx)
        if (text) {
          const decision: Decision =
            text.action === 'redirect' && text.redirectUrl
              ? { action: 'redirect', redirectUrl: text.redirectUrl }
              : { action: text.action === 'allow' ? 'allow' : 'block' }
          decision.matched = { setId: TEXT_MATCH_SET_ID, filter: text.filter }
          const rank = RANK[text.action] ?? 0
          const candidate = { effective: TEXT_EFFECTIVE, rank, decision }
          if (beats(candidate, best)) best = candidate
        }
      }
    }

    if (best && best.decision.action !== 'allow') return best.decision

    // The request stage's allow caps everything the header stage found.
    const allowEffective = best ? best.effective : -1
    if (!headersStage) {
      const decision = composeHeaderEdits(headerRules, allowEffective, best?.decision ?? ALLOW)
      // A second round is only worth it when a header rule could beat the request stage's allow.
      return lateEffective > allowEffective ? { ...decision, needsHeaders: true } : decision
    }
    if (bestLate && bestLate.effective <= allowEffective) bestLate = null
    if (bestLate && bestLate.decision.action !== 'allow') return bestLate.decision
    // A header-stage allow caps the request stage's header edits (Chrome keeps the ones of equal
    // or higher priority) and its own stage's (strictly higher).
    const lateAllowEffective = bestLate ? bestLate.effective : -1
    const applicable = [
      ...headerRules.filter(
        (r) => r.effective > allowEffective && r.effective >= lateAllowEffective
      ),
      ...lateHeaderRules.filter((r) => r.effective > Math.max(allowEffective, lateAllowEffective))
    ]
    return composeHeaderEdits(applicable, -1, bestLate?.decision ?? best?.decision ?? ALLOW)
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
