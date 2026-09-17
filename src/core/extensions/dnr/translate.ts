/**
 * Translate an extension's declarativeNetRequest rulesets into rule sets for Zenium's blocking
 * engine (`sink.ts`). Extension DNR never gets its own network hook on either platform: the
 * engine owns the single `webRequest` hook per session and these sets are how extensions take
 * part in it.
 *
 * ## Precedence, and how it maps onto the engine
 *
 * Chrome resolves a request in two steps (`composite_matcher.cc`, `ruleset_manager.cc`):
 *
 * 1. Within an extension, across all of its rulesets: the highest rule `priority` wins; among
 *    equal priorities the action type decides (`allow` > `allowAllRequests` > `block` >
 *    `upgradeScheme` > `redirect`); a full tie goes to the ruleset with the greater internal id
 *    (static rulesets in manifest order, then dynamic, then session) and then to the greater rule
 *    id. `modifyHeaders` rules with a priority above the winning allow rule all apply, highest
 *    priority first.
 * 2. Across extensions: `block` beats `redirect`/`upgradeScheme`, which beat `allow`; a tie goes
 *    to the more recently installed extension.
 *
 * The engine picks one global winner by (set priority, rule priority, action rank). Every set of
 * one extension therefore gets the same set priority, so step 1 is reproduced exactly except for
 * the cross-ruleset full tie, which the engine resolves by set id order. Step 2 is approximated
 * by giving more recently installed extensions a higher set priority inside the engine's DNR
 * band: the newest extension's rules beat every rule of older extensions. The band has
 * `ENGINE_DNR_BAND_SIZE` integer slots, so only the four most recently installed extensions are
 * strictly ordered and everything older shares the lowest slot. Chrome's class-first rule
 * (another extension's `block` beats this extension's `allow`) cannot be expressed in the
 * engine's model; see the dnr-translator report for the engine changes that would close both gaps.
 *
 * Rules the engine cannot evaluate yet are left out of the set and reported: response header
 * conditions (they need a headers-received stage) and `topDomains`. `redirect.transform` rules
 * are emitted with the transform carried along; until the engine applies transforms they decide
 * nothing.
 */
import {
  ENGINE_DNR_BAND_SIZE,
  ENGINE_DNR_PRIORITY,
  engineSetId,
  type EngineRule,
  type EngineRuleAction,
  type EngineRuleCondition,
  type EngineRuleSet,
  type RuleSink
} from './sink'
import { actionTypePriority, type CompiledRule, type ModifyHeaderInfo, type RulesetSource } from './rules'

/** One ruleset of an extension, as the state machine hands it over. */
export interface TranslateRuleset {
  source: RulesetSource
  /** Static rulesets: the manifest ruleset id. */
  rulesetId?: string
  /** Static rulesets: position in `rule_resources`, for Chrome's tie-break. */
  manifestIndex?: number
  rules: readonly CompiledRule[]
  /** Static rulesets: rules disabled through `updateStaticRules`. */
  disabledRuleIds?: ReadonlySet<number>
}

export interface TranslateExtension {
  extensionId: string
  version?: string
  /** Enabled static rulesets, the dynamic ruleset and the session ruleset, in any order. */
  rulesets: readonly TranslateRuleset[]
  /**
   * Position among the installed extensions that use declarativeNetRequest, 0 for the most
   * recently installed. Defaults to the oldest slot.
   */
  installRank?: number
}

export type SkipReason = 'responseHeaderCondition' | 'topDomains'

export interface SkippedRule {
  ruleId: number
  reason: SkipReason
}

export interface RulesetTranslation {
  set: EngineRuleSet
  /** Rules left out because the engine has no way to evaluate them. */
  skipped: SkippedRule[]
  /** Rules emitted with a `redirect.transform` the engine does not apply yet. */
  transforms: number[]
}

export interface TranslateOptions {
  /** Clock for `updatedAt`; omit to leave the timestamp out (deterministic output). */
  now?: () => number
}

/** Set priority for an extension's rule sets, from its install rank (0 = newest). */
export function enginePriorityForRank(installRank: number | undefined): number {
  const rank = installRank === undefined ? Infinity : Math.max(0, Math.floor(installRank))
  const slot = Math.max(0, ENGINE_DNR_BAND_SIZE - 1 - rank)
  return ENGINE_DNR_PRIORITY + slot
}

function headerOps(ops: readonly ModifyHeaderInfo[]): EngineRuleAction['requestHeaders'] {
  return ops.map((op) =>
    op.value === undefined
      ? { header: op.header, operation: op.operation }
      : { header: op.header, operation: op.operation, value: op.value }
  )
}

function translateAction(rule: CompiledRule): EngineRuleAction {
  const action: EngineRuleAction = { type: rule.actionType }
  if (rule.actionType === 'redirect') {
    const redirect: NonNullable<EngineRuleAction['redirect']> = {}
    if (rule.redirectUrl !== undefined) redirect.url = rule.redirectUrl
    if (rule.regexSubstitution !== undefined) redirect.regexSubstitution = rule.regexSubstitution
    if (rule.urlTransform !== undefined) redirect.transform = rule.urlTransform
    action.redirect = redirect
  } else if (rule.actionType === 'modifyHeaders') {
    if (rule.requestHeadersToModify.length > 0) {
      action.requestHeaders = headerOps(rule.requestHeadersToModify)
    }
    if (rule.responseHeadersToModify.length > 0) {
      action.responseHeaders = headerOps(rule.responseHeadersToModify)
    }
  }
  return action
}

function list<T>(values: readonly T[] | undefined): T[] | undefined {
  return values && values.length > 0 ? [...values] : undefined
}

function translateCondition(rule: CompiledRule): EngineRuleCondition {
  const source = rule.rule.condition
  const condition: EngineRuleCondition = {}
  if (source.regexFilter !== undefined) condition.regexFilter = source.regexFilter
  else if (source.urlFilter !== undefined && source.urlFilter !== '') {
    condition.urlFilter = source.urlFilter
  }
  if (rule.isCaseSensitive) condition.isUrlFilterCaseSensitive = true
  const initiatorDomains = list(rule.initiatorDomains)
  const excludedInitiatorDomains = list(rule.excludedInitiatorDomains)
  const requestDomains = list(rule.requestDomains)
  const excludedRequestDomains = list(rule.excludedRequestDomains)
  if (initiatorDomains) condition.initiatorDomains = initiatorDomains
  if (excludedInitiatorDomains) condition.excludedInitiatorDomains = excludedInitiatorDomains
  if (requestDomains) condition.requestDomains = requestDomains
  if (excludedRequestDomains) condition.excludedRequestDomains = excludedRequestDomains
  const resourceTypes = list(source.resourceTypes)
  const excludedResourceTypes = list(source.excludedResourceTypes)
  if (resourceTypes) condition.resourceTypes = resourceTypes
  if (excludedResourceTypes) condition.excludedResourceTypes = excludedResourceTypes
  const requestMethods = list(source.requestMethods)
  const excludedRequestMethods = list(source.excludedRequestMethods)
  if (requestMethods) condition.requestMethods = requestMethods
  if (excludedRequestMethods) condition.excludedRequestMethods = excludedRequestMethods
  if (rule.domainType !== undefined) condition.domainType = rule.domainType
  if (rule.tabIds.size > 0) condition.tabIds = [...rule.tabIds]
  if (rule.excludedTabIds.size > 0) condition.excludedTabIds = [...rule.excludedTabIds]
  return condition
}

/** Translate one compiled rule; undefined when the engine cannot evaluate it. */
export function translateRule(rule: CompiledRule): EngineRule | SkippedRule {
  if (rule.responseHeaders.length > 0 || rule.excludedResponseHeaders.length > 0) {
    return { ruleId: rule.id, reason: 'responseHeaderCondition' }
  }
  if (rule.topDomains.length > 0 || rule.excludedTopDomains.length > 0) {
    return { ruleId: rule.id, reason: 'topDomains' }
  }
  const out: EngineRule = {
    id: rule.id,
    action: translateAction(rule),
    condition: translateCondition(rule)
  }
  if (rule.priority !== 1) out.priority = rule.priority
  return out
}

function isSkipped(value: EngineRule | SkippedRule): value is SkippedRule {
  return 'reason' in value
}

/**
 * Chrome's order at equal priority: action type, then the greater rule id. The engine keeps
 * the emitted order among rules it considers equal, so emitting in this order reproduces the
 * tie-break inside a set.
 */
export function compareForEmission(a: CompiledRule, b: CompiledRule): number {
  if (a.priority !== b.priority) return b.priority - a.priority
  const rank = actionTypePriority(b.actionType) - actionTypePriority(a.actionType)
  if (rank !== 0) return rank
  return b.id - a.id
}

function setKindOf(ruleset: TranslateRuleset): Parameters<typeof engineSetId>[1] {
  switch (ruleset.source) {
    case 'static':
      return { kind: 'static', rulesetId: ruleset.rulesetId ?? '' }
    case 'dynamic':
      return { kind: 'dynamic' }
    case 'session':
      return { kind: 'session' }
  }
}

/** Build the engine set for one ruleset of an extension. Pure: same input, same output. */
export function translateRuleset(
  extension: TranslateExtension,
  ruleset: TranslateRuleset,
  options: TranslateOptions = {}
): RulesetTranslation {
  const skipped: SkippedRule[] = []
  const transforms: number[] = []
  const rules: EngineRule[] = []
  const ordered = [...ruleset.rules].sort(compareForEmission)
  for (const compiled of ordered) {
    if (ruleset.disabledRuleIds?.has(compiled.id)) continue
    const translated = translateRule(compiled)
    if (isSkipped(translated)) {
      skipped.push(translated)
      continue
    }
    if (translated.action.redirect?.transform) transforms.push(compiled.id)
    rules.push(translated)
  }
  const set: EngineRuleSet = {
    id: engineSetId(extension.extensionId, setKindOf(ruleset)),
    source: 'dnr',
    priority: enginePriorityForRank(extension.installRank),
    enabled: true,
    rules
  }
  if (extension.version !== undefined) set.version = extension.version
  if (options.now) set.updatedAt = options.now()
  return { set, skipped, transforms }
}

/** Every set an extension should have in the engine right now (empty rulesets produce none). */
export function translateExtension(
  extension: TranslateExtension,
  options: TranslateOptions = {}
): RulesetTranslation[] {
  const out: RulesetTranslation[] = []
  for (const ruleset of extension.rulesets) {
    const translation = translateRuleset(extension, ruleset, options)
    if (translation.set.rules && translation.set.rules.length > 0) out.push(translation)
  }
  return out
}

export interface ExtensionTranslationReport {
  extensionId: string
  /** Set ids sent to the sink by this sync. */
  updated: string[]
  /** Set ids removed from the sink by this sync. */
  removed: string[]
  skipped: SkippedRule[]
  transforms: number[]
}

interface EmittedSet {
  rules: readonly CompiledRule[]
  disabledRuleIds: ReadonlySet<number> | undefined
  priority: number
  version: string | undefined
}

/**
 * Keeps the engine in step with any number of extensions: `sync` emits the sets that changed,
 * removes the ones that disappeared, and re-emits every set of an extension whose install rank
 * moved. Unchanged sets (same rule array, same disabled ids, same priority) are not re-sent.
 */
export class DnrTranslator {
  private readonly emitted = new Map<string, Map<string, EmittedSet>>()
  private readonly inputs = new Map<string, TranslateExtension>()

  constructor(
    private readonly sink: RuleSink,
    private readonly options: TranslateOptions = {}
  ) {}

  /** Extensions currently mirrored into the sink. */
  extensionIds(): string[] {
    return [...this.inputs.keys()]
  }

  async sync(extension: TranslateExtension): Promise<ExtensionTranslationReport> {
    const previous = this.inputs.get(extension.extensionId)
    const input: TranslateExtension = {
      ...extension,
      installRank: extension.installRank ?? previous?.installRank
    }
    this.inputs.set(input.extensionId, input)
    return this.emit(input)
  }

  /** Forget an extension and remove all of its sets. */
  async remove(extensionId: string): Promise<string[]> {
    this.inputs.delete(extensionId)
    const sets = this.emitted.get(extensionId)
    this.emitted.delete(extensionId)
    const removed = sets ? [...sets.keys()] : []
    for (const id of removed) await this.sink.removeRuleSet(id)
    return removed
  }

  /**
   * Record the install order of the extensions that use declarativeNetRequest, most recently
   * installed first; sets whose priority changes are re-emitted.
   */
  async setInstallOrder(extensionIdsNewestFirst: readonly string[]): Promise<void> {
    for (const [extensionId, input] of this.inputs) {
      const rank = extensionIdsNewestFirst.indexOf(extensionId)
      const installRank = rank < 0 ? undefined : rank
      if (installRank === input.installRank) continue
      const updated: TranslateExtension = { ...input, installRank }
      this.inputs.set(extensionId, updated)
      await this.emit(updated)
    }
  }

  private async emit(input: TranslateExtension): Promise<ExtensionTranslationReport> {
    const translations = translateExtension(input, this.options)
    let emitted = this.emitted.get(input.extensionId)
    if (!emitted) {
      emitted = new Map()
      this.emitted.set(input.extensionId, emitted)
    }
    const report: ExtensionTranslationReport = {
      extensionId: input.extensionId,
      updated: [],
      removed: [],
      skipped: [],
      transforms: []
    }
    const wanted = new Set<string>()
    for (const ruleset of input.rulesets) {
      const setId = engineSetId(input.extensionId, setKindOf(ruleset))
      const translation = translations.find((t) => t.set.id === setId)
      if (!translation) continue
      wanted.add(setId)
      report.skipped.push(...translation.skipped)
      report.transforms.push(...translation.transforms)
      const before = emitted.get(setId)
      const next: EmittedSet = {
        rules: ruleset.rules,
        disabledRuleIds: ruleset.disabledRuleIds,
        priority: translation.set.priority,
        version: input.version
      }
      if (before && sameEmission(before, next)) continue
      await this.sink.setRuleSet(translation.set)
      emitted.set(setId, next)
      report.updated.push(setId)
    }
    for (const setId of [...emitted.keys()]) {
      if (wanted.has(setId)) continue
      await this.sink.removeRuleSet(setId)
      emitted.delete(setId)
      report.removed.push(setId)
    }
    return report
  }
}

function sameEmission(a: EmittedSet, b: EmittedSet): boolean {
  if (a.rules !== b.rules || a.priority !== b.priority || a.version !== b.version) return false
  if (a.disabledRuleIds === b.disabledRuleIds) return true
  if (!a.disabledRuleIds || !b.disabledRuleIds) {
    return (a.disabledRuleIds?.size ?? 0) === 0 && (b.disabledRuleIds?.size ?? 0) === 0
  }
  if (a.disabledRuleIds.size !== b.disabledRuleIds.size) return false
  for (const id of a.disabledRuleIds) if (!b.disabledRuleIds.has(id)) return false
  return true
}
