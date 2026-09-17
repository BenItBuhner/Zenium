/**
 * Per-extension declarativeNetRequest state: which static rulesets are enabled, the dynamic and
 * session rules, per-rule disabling inside static rulesets, the action-count badge preference and
 * the matched-rule log behind `getMatchedRules`. Platform-agnostic: every effect goes through an
 * injected `DnrStateIO` (read a packaged file, load and save the persisted record, the clock,
 * tab validity), so the Electron host and the Android host wire the same class.
 *
 * Behaviour and error messages follow Chromium `main` (checked 2026-09-17):
 *
 * - `rules_monitor_service.cc`: `OnExtensionLoaded` (persisted enabled set or manifest defaults;
 *   rulesets over the static rule budget are skipped in manifest order with a warning),
 *   `UpdateEnabledStaticRulesetsInternal` (check order: load, 50 rulesets, regex rules, rule
 *   budget), `UpdateSessionRulesInternal` and `file_sequence_helper.cc` (`GetNewDynamicRules`:
 *   remove, add, then rule / unsafe / regex counts before indexing).
 * - `declarative_net_request_api.cc`: id validation, enable beating disable, `getMatchedRules`
 *   permissions and quota, `setExtensionActionOptions`.
 * - `prefs_helper.cc` (`UpdateDisabledStaticRules`), `action_tracker.cc` (matched rules live
 *   with their tab and move to the unknown tab for five more minutes when it navigates or closes).
 * - `quota_service.cc` (`TimedLimit`): a fixed window opened by the first call.
 */
import type { ManifestRuleResource } from '../manifest'
import {
  DYNAMIC_RULESET_ID,
  GETMATCHEDRULES_QUOTA_INTERVAL,
  GUARANTEED_MINIMUM_STATIC_RULES,
  MATCHED_RULE_LIFESPAN_MS,
  MAX_DISABLED_STATIC_RULES,
  MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL,
  MAX_NUMBER_OF_DYNAMIC_RULES,
  MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
  MAX_NUMBER_OF_REGEX_RULES,
  MAX_NUMBER_OF_SESSION_RULES,
  MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES,
  MAX_NUMBER_OF_UNSAFE_SESSION_RULES,
  MAX_STATIC_RULES_PER_PROFILE,
  SESSION_RULESET_ID,
  isRuleSafe
} from './limits'
import {
  compileRule,
  formatParseError,
  parseRuleset,
  readRule,
  RuleSchemaError,
  type CompiledRule,
  type ParseRulesetResult,
  type Rule,
  type RuleActionType,
  type RulesetSource
} from './rules'
import type { MatcherRuleset } from './matcher'
import type { TranslateExtension, TranslateRuleset } from './translate'

// ---------------------------------------------------------------------------------------------
// Chrome's messages (extensions/browser/api/declarative_net_request/constants.cc and
// extensions/browser/api/constants.h)

export const ERROR_INVALID_RULESET_ID = 'Invalid ruleset id: *.'
export const ERROR_ENABLED_RULESETS_RULE_COUNT_EXCEEDED =
  'The set of enabled rulesets exceeds the rule count limit.'
export const ERROR_ENABLED_RULESETS_REGEX_RULE_COUNT_EXCEEDED =
  'The set of enabled rulesets exceeds the regular expression rule count limit.'
export const ERROR_ENABLED_RULESET_COUNT_EXCEEDED =
  'The number of enabled static rulesets exceeds the enabled ruleset count limit.'
export const ERROR_INTERNAL_UPDATING_ENABLED_RULESETS = 'Internal error.'
export const ERROR_DISABLED_STATIC_RULE_COUNT_EXCEEDED =
  'The number of disabled static rules exceeds the disabled rule count limit.'
export const ERROR_DYNAMIC_RULE_COUNT_EXCEEDED = 'Dynamic rule count exceeded.'
export const ERROR_DYNAMIC_UNSAFE_RULE_COUNT_EXCEEDED = 'Dynamic unsafe rule count exceeded.'
export const ERROR_DYNAMIC_REGEX_RULE_COUNT_EXCEEDED = 'Dynamic rule count for regex rules exceeded.'
export const ERROR_SESSION_RULE_COUNT_EXCEEDED = 'Session rule count exceeded.'
export const ERROR_SESSION_UNSAFE_RULE_COUNT_EXCEEDED = 'Session unsafe rule count exceeded.'
export const ERROR_SESSION_REGEX_RULE_COUNT_EXCEEDED = 'Session rule count for regex rules exceeded.'
export const ERROR_INCREMENT_WITHOUT_BADGE_TEXT =
  'Cannot increment action count unless displaying action count as badge text.'
export const ERROR_GET_MATCHED_RULES_MISSING_PERMISSIONS =
  'The extension must have the declarativeNetRequestFeedback permission or have activeTab ' +
  'granted for the specified tab ID in order to call this function.'
export const ERROR_TAB_NOT_FOUND = 'No tab with id: *.'
export const ERROR_OVER_QUOTA = 'This request exceeds the MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL quota.'
export const WARNING_RULESET_FAILED_TO_LOAD = 'Failed to load some of the declarativeNetRequest rulesets.'
export const WARNING_ENABLED_RULE_COUNT_EXCEEDED =
  'The number of enabled rules exceeds the API limits. Some rulesets will be ignored.'
export const WARNING_ENABLED_REGEX_RULE_COUNT_EXCEEDED =
  'The number of enabled regular expression rules exceeds the API limits. Some rulesets will be ignored.'

/** `ErrorUtils::FormatErrorMessage`: each `*` takes the next argument. */
export function formatMessage(template: string, ...args: (string | number)[]): string {
  let index = 0
  return template.replace(/\*/g, () => String(args[index++] ?? '*'))
}

/** `extension_misc::kUnknownTabId`: requests not associated with a tab. */
export const UNKNOWN_TAB_ID = -1

// ---------------------------------------------------------------------------------------------
// Inputs

export interface DnrExtensionInfo {
  id: string
  /** Display name, for the attribution of the extension's rule sets in the blocking settings. */
  name?: string
  version?: string
  /** `declarative_net_request.rule_resources` from the (validated) manifest. */
  ruleResources?: readonly ManifestRuleResource[]
  /**
   * Granted API permissions: `declarativeNetRequestFeedback` unlocks `getMatchedRules` and the
   * matched-rule log, `activeTab` does the same per tab; `declarativeNetRequestWithHostAccess`
   * is recorded for the host (redirect and modifyHeaders rules need host access in Chrome).
   */
  permissions?: readonly string[]
  /** Unpacked extensions get `onRuleMatchedDebug` and `testMatchOutcome`, like in Chrome. */
  isUnpacked?: boolean
}

/** The record the host persists per extension (one JSON document). */
export interface DnrPersistedState {
  version: 1
  /** Manifest ruleset ids the extension wants enabled; set from the manifest on first load. */
  enabledStaticRulesetIds: string[]
  /** `updateStaticRules` disabled ids per manifest ruleset id. */
  disabledStaticRuleIds: Record<string, number[]>
  dynamicRules: Rule[]
  displayActionCountAsBadgeText: boolean
}

/**
 * Chrome's `GlobalRulesTracker`: static rules above an extension's guaranteed minimum come out
 * of a per-profile pool shared by all extensions. Hosts share one instance between states.
 */
export interface GlobalStaticRulePool {
  /** Rules this extension may still take from the pool (its own allocation included). */
  available(extensionId: string): number
  /** Record the extension's enabled static rule count; false when the pool cannot cover it. */
  update(extensionId: string, enabledStaticRuleCount: number): boolean
  release(extensionId: string): void
}

export function createGlobalStaticRulePool(
  limit = MAX_STATIC_RULES_PER_PROFILE,
  guaranteedMinimum = GUARANTEED_MINIMUM_STATIC_RULES
): GlobalStaticRulePool {
  const allocations = new Map<string, number>()
  const total = (): number => [...allocations.values()].reduce((sum, n) => sum + n, 0)
  return {
    available(extensionId) {
      return limit - total() + (allocations.get(extensionId) ?? 0)
    },
    update(extensionId, enabledStaticRuleCount) {
      const allocation = Math.max(0, enabledStaticRuleCount - guaranteedMinimum)
      const others = total() - (allocations.get(extensionId) ?? 0)
      if (others + allocation > limit) return false
      if (allocation === 0) allocations.delete(extensionId)
      else allocations.set(extensionId, allocation)
      return true
    },
    release(extensionId) {
      allocations.delete(extensionId)
    }
  }
}

export interface DnrStateIO {
  /** Read a file of the extension package by its manifest-relative path. */
  readFile(path: string): Promise<string>
  /** The persisted record, or undefined on first load after install. */
  loadState(): Promise<DnrPersistedState | undefined>
  saveState(state: DnrPersistedState): Promise<void>
  /** Milliseconds since the epoch; defaults to `Date.now`. */
  now?: () => number
  /** Origin `redirect.extensionPath` resolves against; defaults to `chrome-extension://<id>/`. */
  extensionBaseUrl?: (extensionId: string) => string
  /** Chrome rejects tab ids that name no open tab; defaults to accepting every id. */
  isValidTabId?: (tabId: number) => boolean
  /** Whether `activeTab` is currently granted for a tab; defaults to false. */
  hasActiveTabAccess?: (tabId: number) => boolean
  /** Shared across extensions; defaults to a pool private to this state. */
  globalStaticRulePool?: GlobalStaticRulePool
  /** Badge integration hook: the action count of a tab changed. */
  onActionCount?: (tabId: number, count: number) => void
  /** Install-style warnings Chrome would surface on chrome://extensions. */
  warn?: (message: string) => void
}

// ---------------------------------------------------------------------------------------------
// API argument and result shapes (chrome.declarativeNetRequest)

export interface UpdateRulesetOptions {
  disableRulesetIds?: string[]
  enableRulesetIds?: string[]
}

export interface UpdateRuleOptions {
  removeRuleIds?: number[]
  /** Raw rule JSON as passed by the extension; validated here. */
  addRules?: unknown[]
}

export interface UpdateStaticRulesOptions {
  rulesetId: string
  disableRuleIds?: number[]
  enableRuleIds?: number[]
}

export interface GetRulesFilter {
  ruleIds?: number[]
}

export interface GetDisabledRuleIdsOptions {
  rulesetId: string
}

export interface TabActionCountUpdate {
  tabId: number
  increment: number
}

export interface ExtensionActionOptions {
  displayActionCountAsBadgeText?: boolean
  tabUpdate?: TabActionCountUpdate
}

export interface MatchedRulesFilter {
  tabId?: number
  minTimeStamp?: number
}

export interface MatchedRule {
  ruleId: number
  rulesetId: string
}

export interface MatchedRuleInfo {
  rule: MatchedRule
  tabId: number
  timeStamp: number
}

export interface RulesMatchedDetails {
  rulesMatchedInfo: MatchedRuleInfo[]
}

/** `chrome.declarativeNetRequest.RequestDetails`, as the host knows it. */
export interface RequestDetails {
  requestId: string
  url: string
  initiator?: string
  method: string
  frameId: number
  parentFrameId: number
  documentId?: string
  parentDocumentId?: string
  frameType?: 'outermost_frame' | 'fenced_frame' | 'sub_frame'
  documentLifecycle?: 'prerender' | 'active' | 'cached' | 'pending_deletion'
  tabId: number
  type: string
}

export interface MatchedRuleInfoDebug {
  rule: MatchedRule
  request: RequestDetails
}

/** What the host reports when the engine applied one of this extension's rules. */
export interface MatchRecord {
  ruleId: number
  /** Public ruleset id: the manifest id, `_dynamic` or `_session`. */
  rulesetId: string
  /** Tab of the request; `UNKNOWN_TAB_ID` when there is none. */
  tabId: number
  /** Drives the action count: allow rules do not count. Defaults to a counted action. */
  actionType?: RuleActionType
  timestamp?: number
  /** Enables `onRuleMatchedDebug` for the match. */
  request?: RequestDetails
}

export interface RuleCounts {
  rules: number
  unsafeRules: number
  regexRules: number
}

// ---------------------------------------------------------------------------------------------
// Internals

interface StaticRuleset {
  resource: ManifestRuleResource
  manifestIndex: number
  /** Parsed lazily; undefined until read, null when the file could not be read or parsed. */
  parsed?: ParseRulesetResult | null
}

interface RuleList {
  rules: Rule[]
  compiled: CompiledRule[]
}

interface TrackedMatch {
  ruleId: number
  rulesetId: string
  timestamp: number
}

/** `QuotaService::TimedLimit` with a singleton bucket. */
class TimedQuota {
  private expiration = -Infinity
  private tokens = 0

  constructor(
    private readonly limit: number,
    private readonly intervalMs: number
  ) {}

  take(now: number): boolean {
    if (now > this.expiration) {
      this.expiration = now + this.intervalMs
      this.tokens = this.limit
    }
    this.tokens -= 1
    return this.tokens >= 0
  }
}

function counts(rules: readonly Rule[]): RuleCounts {
  let unsafeRules = 0
  let regexRules = 0
  for (const rule of rules) {
    if (!isRuleSafe(rule)) unsafeRules++
    if (rule.condition.regexFilter !== undefined) regexRules++
  }
  return { rules: rules.length, unsafeRules, regexRules }
}

function compiledCounts(rules: readonly CompiledRule[]): RuleCounts {
  return counts(rules.map((r) => r.rule))
}

function cloneRule(rule: Rule): Rule {
  return JSON.parse(JSON.stringify(rule)) as Rule
}

export type DnrChangeKind = 'static' | 'dynamic' | 'session'

/**
 * One extension's declarativeNetRequest state. Construct, `load()`, then call the API methods;
 * subscribe with `onChange` to feed the translator (`translateInput()`) and use
 * `matcherRulesets()` for `testMatchOutcome`.
 */
export class DnrState {
  readonly extensionId: string
  private readonly statics = new Map<string, StaticRuleset>()
  /** Manifest ruleset ids in manifest order. */
  private readonly manifestOrder: string[] = []
  private enabledIntent = new Set<string>()
  /** Static rulesets actually active (enabled and within budget), in manifest order. */
  private loadedStatics: string[] = []
  private disabledRuleIds = new Map<string, Set<number>>()
  private dynamic: RuleList = { rules: [], compiled: [] }
  private session: RuleList = { rules: [], compiled: [] }
  private displayActionCountAsBadgeText = false
  private readonly matches = new Map<number, TrackedMatch[]>()
  private readonly actionCounts = new Map<number, number>()
  private readonly quota = new TimedQuota(
    MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL,
    GETMATCHEDRULES_QUOTA_INTERVAL * 60 * 1000
  )
  private readonly changeListeners = new Set<(kind: DnrChangeKind) => void>()
  private readonly debugListeners = new Set<(info: MatchedRuleInfoDebug) => void>()
  private readonly pool: GlobalStaticRulePool
  private loaded: Promise<void> | undefined
  /** Warnings from the last load, in Chrome's wording. */
  readonly warnings: string[] = []

  constructor(
    readonly extension: DnrExtensionInfo,
    private readonly io: DnrStateIO
  ) {
    this.extensionId = extension.id
    this.pool = io.globalStaticRulePool ?? createGlobalStaticRulePool()
    for (const [index, resource] of (extension.ruleResources ?? []).entries()) {
      this.statics.set(resource.id, { resource, manifestIndex: index })
      this.manifestOrder.push(resource.id)
    }
  }

  // ---- permissions ------------------------------------------------------------------------

  hasPermission(name: string): boolean {
    return this.extension.permissions?.includes(name) ?? false
  }

  /** `HasDNRFeedbackPermission`: the feedback permission, or activeTab granted for the tab. */
  canGetMatchedRules(tabId: number | undefined): boolean {
    if (this.hasPermission('declarativeNetRequestFeedback')) return true
    if (tabId === undefined || tabId === UNKNOWN_TAB_ID) return false
    return this.hasPermission('activeTab') && (this.io.hasActiveTabAccess?.(tabId) ?? false)
  }

  // ---- lifecycle ------------------------------------------------------------------------

  /** Read the persisted record (or seed it from the manifest) and load the enabled rulesets. */
  load(): Promise<void> {
    this.loaded ??= this.loadInternal()
    return this.loaded
  }

  private async loadInternal(): Promise<void> {
    const persisted = await this.io.loadState()
    if (persisted) {
      this.enabledIntent = new Set(
        persisted.enabledStaticRulesetIds.filter((id) => this.statics.has(id))
      )
      for (const [id, ids] of Object.entries(persisted.disabledStaticRuleIds)) {
        if (this.statics.has(id) && ids.length > 0) this.disabledRuleIds.set(id, new Set(ids))
      }
      this.displayActionCountAsBadgeText = persisted.displayActionCountAsBadgeText
      this.dynamic = this.compileExisting(persisted.dynamicRules, 'dynamic')
    } else {
      this.enabledIntent = new Set(
        this.manifestOrder.filter((id) => this.statics.get(id)!.resource.enabled)
      )
      await this.persist()
    }
    await this.activateStatics()
  }

  /** Previously accepted rules are re-compiled leniently: a rule that fails now is dropped. */
  private compileExisting(rules: readonly Rule[], source: RulesetSource): RuleList {
    const out: RuleList = { rules: [], compiled: [] }
    for (const rule of rules) {
      const result = compileRule(rule, this.compileOptions(source))
      if (!result.ok) continue
      out.rules.push(rule)
      out.compiled.push(result.compiled)
    }
    return out
  }

  private compileOptions(source: RulesetSource): {
    source: RulesetSource
    extensionBaseUrl: string
  } {
    return {
      source,
      extensionBaseUrl:
        this.io.extensionBaseUrl?.(this.extensionId) ?? `chrome-extension://${this.extensionId}/`
    }
  }

  private async readStatic(id: string): Promise<ParseRulesetResult | null> {
    const ruleset = this.statics.get(id)!
    if (ruleset.parsed !== undefined) return ruleset.parsed
    let parsed: ParseRulesetResult | null
    try {
      const json = await this.io.readFile(ruleset.resource.path)
      const result = parseRuleset(json, { ...this.compileOptions('static'), rulesetId: id })
      parsed = result.rejected ? null : result
    } catch {
      parsed = null
    }
    ruleset.parsed = parsed
    return parsed
  }

  /**
   * `OnInitialRulesetsLoadedFromDisk`: load the enabled rulesets in manifest order, skipping
   * the ones that would exceed the static rule budget or the regex rule limit.
   */
  private async activateStatics(): Promise<void> {
    this.warnings.length = 0
    const budget = GUARANTEED_MINIMUM_STATIC_RULES + this.pool.available(this.extensionId)
    const loaded: string[] = []
    let ruleCount = 0
    let regexCount = 0
    let failed = false
    let overBudget = false
    let overRegex = false
    for (const id of this.manifestOrder) {
      if (!this.enabledIntent.has(id)) continue
      const parsed = await this.readStatic(id)
      if (!parsed) {
        failed = true
        continue
      }
      if (ruleCount + parsed.compiled.length > budget) {
        overBudget = true
        continue
      }
      if (regexCount + parsed.regexRuleCount > MAX_NUMBER_OF_REGEX_RULES) {
        overRegex = true
        continue
      }
      ruleCount += parsed.compiled.length
      regexCount += parsed.regexRuleCount
      loaded.push(id)
    }
    if (failed) this.warn(WARNING_RULESET_FAILED_TO_LOAD)
    if (overBudget) this.warn(WARNING_ENABLED_RULE_COUNT_EXCEEDED)
    if (overRegex) this.warn(WARNING_ENABLED_REGEX_RULE_COUNT_EXCEEDED)
    this.pool.update(this.extensionId, ruleCount)
    this.loadedStatics = loaded
    this.notify('static')
  }

  private warn(message: string): void {
    this.warnings.push(message)
    this.io.warn?.(message)
  }

  private async persist(): Promise<void> {
    const disabled: Record<string, number[]> = {}
    for (const [id, ids] of this.disabledRuleIds) {
      if (ids.size > 0) disabled[id] = [...ids].sort((a, b) => a - b)
    }
    await this.io.saveState({
      version: 1,
      enabledStaticRulesetIds: this.manifestOrder.filter((id) => this.enabledIntent.has(id)),
      disabledStaticRuleIds: disabled,
      dynamicRules: this.dynamic.rules.map(cloneRule),
      displayActionCountAsBadgeText: this.displayActionCountAsBadgeText
    })
  }

  /** The extension is being uninstalled: give its pool allocation back. */
  dispose(): void {
    this.pool.release(this.extensionId)
    this.changeListeners.clear()
    this.debugListeners.clear()
  }

  // ---- change notification -----------------------------------------------------------------

  onChange(listener: (kind: DnrChangeKind) => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  private notify(kind: DnrChangeKind): void {
    for (const listener of [...this.changeListeners]) listener(kind)
  }

  // ---- views for the translator and the matcher --------------------------------------------

  private enabledStaticRulesets(): { id: string; ruleset: StaticRuleset; parsed: ParseRulesetResult }[] {
    const out: { id: string; ruleset: StaticRuleset; parsed: ParseRulesetResult }[] = []
    for (const id of this.loadedStatics) {
      const ruleset = this.statics.get(id)!
      if (ruleset.parsed) out.push({ id, ruleset, parsed: ruleset.parsed })
    }
    return out
  }

  /** Everything the translator needs for this extension. */
  translateInput(installRank?: number): TranslateExtension {
    const rulesets: TranslateRuleset[] = this.enabledStaticRulesets().map(
      ({ id, ruleset, parsed }) => ({
        source: 'static',
        rulesetId: id,
        path: ruleset.resource.path,
        manifestIndex: ruleset.manifestIndex,
        rules: parsed.compiled,
        disabledRuleIds: this.disabledRuleIds.get(id)
      })
    )
    if (this.dynamic.compiled.length > 0) {
      rulesets.push({ source: 'dynamic', rules: this.dynamic.compiled })
    }
    if (this.session.compiled.length > 0) {
      rulesets.push({ source: 'session', rules: this.session.compiled })
    }
    const input: TranslateExtension = { extensionId: this.extensionId, rulesets }
    if (this.extension.name !== undefined) input.name = this.extension.name
    if (this.extension.version !== undefined) input.version = this.extension.version
    if (installRank !== undefined) input.installRank = installRank
    return input
  }

  /** The rulesets as the reference matcher evaluates them (`testMatchOutcome`). */
  matcherRulesets(): MatcherRuleset[] {
    const out: MatcherRuleset[] = this.enabledStaticRulesets().map(({ id, ruleset, parsed }) => ({
      id,
      source: 'static',
      manifestIndex: ruleset.manifestIndex,
      rules: parsed.compiled,
      disabledRuleIds: this.disabledRuleIds.get(id)
    }))
    out.push({ id: DYNAMIC_RULESET_ID, source: 'dynamic', rules: this.dynamic.compiled })
    out.push({ id: SESSION_RULESET_ID, source: 'session', rules: this.session.compiled })
    return out
  }

  // ---- static rulesets -----------------------------------------------------------------------

  private requireStaticId(id: string): StaticRuleset {
    const ruleset = this.statics.get(id)
    if (!ruleset) throw new Error(formatMessage(ERROR_INVALID_RULESET_ID, id))
    return ruleset
  }

  async updateEnabledRulesets(options: UpdateRulesetOptions): Promise<void> {
    await this.load()
    const toEnable = new Set<string>()
    for (const id of options.enableRulesetIds ?? []) {
      this.requireStaticId(id)
      toEnable.add(id)
    }
    const toDisable = new Set<string>()
    for (const id of options.disableRulesetIds ?? []) {
      this.requireStaticId(id)
      if (!toEnable.has(id)) toDisable.add(id)
    }
    if (toEnable.size === 0 && toDisable.size === 0) return

    const next = this.manifestOrder.filter(
      (id) => toEnable.has(id) || (this.loadedStatics.includes(id) && !toDisable.has(id))
    )
    let ruleCount = 0
    let regexCount = 0
    for (const id of next) {
      const parsed = await this.readStatic(id)
      if (!parsed) throw new Error(ERROR_INTERNAL_UPDATING_ENABLED_RULESETS)
      ruleCount += parsed.compiled.length
      regexCount += parsed.regexRuleCount
    }
    if (next.length > MAX_NUMBER_OF_ENABLED_STATIC_RULESETS) {
      throw new Error(ERROR_ENABLED_RULESET_COUNT_EXCEEDED)
    }
    if (regexCount > MAX_NUMBER_OF_REGEX_RULES) {
      throw new Error(ERROR_ENABLED_RULESETS_REGEX_RULE_COUNT_EXCEEDED)
    }
    if (!this.pool.update(this.extensionId, ruleCount)) {
      throw new Error(ERROR_ENABLED_RULESETS_RULE_COUNT_EXCEEDED)
    }
    this.loadedStatics = next
    this.enabledIntent = new Set(next)
    await this.persist()
    this.notify('static')
  }

  async getEnabledRulesets(): Promise<string[]> {
    await this.load()
    return [...this.loadedStatics]
  }

  /** Enabled static rules across the loaded rulesets. */
  enabledStaticRuleCount(): number {
    let count = 0
    for (const { parsed } of this.enabledStaticRulesets()) count += parsed.compiled.length
    return count
  }

  async getAvailableStaticRuleCount(): Promise<number> {
    await this.load()
    const enabled = this.enabledStaticRuleCount()
    const available = this.pool.available(this.extensionId)
    if (enabled < GUARANTEED_MINIMUM_STATIC_RULES) {
      return GUARANTEED_MINIMUM_STATIC_RULES - enabled + available
    }
    return available - (enabled - GUARANTEED_MINIMUM_STATIC_RULES)
  }

  async updateStaticRules(options: UpdateStaticRulesOptions): Promise<void> {
    await this.load()
    this.requireStaticId(options.rulesetId)
    const before = this.disabledRuleIds.get(options.rulesetId) ?? new Set<number>()
    const after = new Set(before)
    for (const id of options.enableRuleIds ?? []) after.delete(id)
    for (const id of options.disableRuleIds ?? []) after.add(id)
    let changed = after.size !== before.size
    if (!changed) for (const id of after) if (!before.has(id)) changed = true
    if (!changed) return
    let total = after.size
    for (const [id, ids] of this.disabledRuleIds) if (id !== options.rulesetId) total += ids.size
    if (total > MAX_DISABLED_STATIC_RULES) {
      throw new Error(ERROR_DISABLED_STATIC_RULE_COUNT_EXCEEDED)
    }
    if (after.size === 0) this.disabledRuleIds.delete(options.rulesetId)
    else this.disabledRuleIds.set(options.rulesetId, after)
    await this.persist()
    if (this.loadedStatics.includes(options.rulesetId)) this.notify('static')
  }

  async getDisabledRuleIds(options: GetDisabledRuleIdsOptions): Promise<number[]> {
    await this.load()
    this.requireStaticId(options.rulesetId)
    return [...(this.disabledRuleIds.get(options.rulesetId) ?? [])].sort((a, b) => a - b)
  }

  // ---- dynamic and session rules -----------------------------------------------------------

  async updateDynamicRules(options: UpdateRuleOptions): Promise<void> {
    await this.load()
    const next = this.buildRuleList(this.dynamic, options, 'dynamic', {
      rules: MAX_NUMBER_OF_DYNAMIC_RULES,
      unsafeRules: MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES,
      regexRules: MAX_NUMBER_OF_REGEX_RULES - compiledCounts(this.session.compiled).regexRules
    })
    const previous = this.dynamic
    this.dynamic = next
    try {
      await this.persist()
    } catch (error) {
      this.dynamic = previous
      throw error
    }
    this.notify('dynamic')
  }

  async updateSessionRules(options: UpdateRuleOptions): Promise<void> {
    await this.load()
    this.session = this.buildRuleList(this.session, options, 'session', {
      rules: MAX_NUMBER_OF_SESSION_RULES,
      unsafeRules: MAX_NUMBER_OF_UNSAFE_SESSION_RULES,
      regexRules: MAX_NUMBER_OF_REGEX_RULES - compiledCounts(this.dynamic.compiled).regexRules
    })
    this.notify('session')
  }

  /**
   * `GetNewDynamicRules` / `UpdateSessionRulesInternal`: schema-validate the additions (the JS
   * binding does this first in Chrome), drop the removed ids, append, check the counts, then
   * index every rule in order so duplicate ids and semantic errors surface as Chrome reports them.
   */
  private buildRuleList(
    current: RuleList,
    options: UpdateRuleOptions,
    source: 'dynamic' | 'session',
    limits: RuleCounts
  ): RuleList {
    const additions: Rule[] = []
    for (const [index, value] of (options.addRules ?? []).entries()) {
      try {
        additions.push(readRule(value, 'binding'))
      } catch (error) {
        if (error instanceof RuleSchemaError) {
          throw new Error(`Error at index ${index}: ${error.message}`)
        }
        throw error
      }
    }
    const removed = new Set(options.removeRuleIds ?? [])
    const kept: { rule: Rule; compiled: CompiledRule }[] = []
    for (const [index, rule] of current.rules.entries()) {
      if (!removed.has(rule.id)) kept.push({ rule, compiled: current.compiled[index]! })
    }
    const combined = [...kept.map((k) => k.rule), ...additions]
    const total = counts(combined)
    const dynamic = source === 'dynamic'
    if (total.rules > limits.rules) {
      throw new Error(dynamic ? ERROR_DYNAMIC_RULE_COUNT_EXCEEDED : ERROR_SESSION_RULE_COUNT_EXCEEDED)
    }
    if (total.unsafeRules > limits.unsafeRules) {
      throw new Error(
        dynamic ? ERROR_DYNAMIC_UNSAFE_RULE_COUNT_EXCEEDED : ERROR_SESSION_UNSAFE_RULE_COUNT_EXCEEDED
      )
    }
    if (total.regexRules > limits.regexRules) {
      throw new Error(
        dynamic ? ERROR_DYNAMIC_REGEX_RULE_COUNT_EXCEEDED : ERROR_SESSION_REGEX_RULE_COUNT_EXCEEDED
      )
    }
    const ids = new Set<number>()
    const next: RuleList = { rules: [], compiled: [] }
    for (const { rule, compiled } of kept) {
      ids.add(rule.id)
      next.rules.push(rule)
      next.compiled.push(compiled)
    }
    for (const rule of additions) {
      if (ids.has(rule.id)) throw new Error(formatParseError('ERROR_DUPLICATE_IDS', rule.id))
      ids.add(rule.id)
      const result = compileRule(rule, this.compileOptions(source))
      if (!result.ok) throw new Error(result.message)
      next.rules.push(rule)
      next.compiled.push(result.compiled)
    }
    return next
  }

  async getDynamicRules(filter?: GetRulesFilter): Promise<Rule[]> {
    await this.load()
    return filterRules(this.dynamic.rules, filter)
  }

  async getSessionRules(filter?: GetRulesFilter): Promise<Rule[]> {
    await this.load()
    return filterRules(this.session.rules, filter)
  }

  ruleCounts(): { static: RuleCounts; dynamic: RuleCounts; session: RuleCounts } {
    const staticRules = this.enabledStaticRulesets().flatMap(({ parsed }) => parsed.compiled)
    return {
      static: compiledCounts(staticRules),
      dynamic: compiledCounts(this.dynamic.compiled),
      session: compiledCounts(this.session.compiled)
    }
  }

  // ---- action count ------------------------------------------------------------------------

  private now(): number {
    return this.io.now?.() ?? Date.now()
  }

  private isValidTabId(tabId: number): boolean {
    return this.io.isValidTabId?.(tabId) ?? true
  }

  async setExtensionActionOptions(options: ExtensionActionOptions): Promise<void> {
    await this.load()
    if (
      options.displayActionCountAsBadgeText !== undefined &&
      options.displayActionCountAsBadgeText !== this.displayActionCountAsBadgeText
    ) {
      this.displayActionCountAsBadgeText = options.displayActionCountAsBadgeText
      await this.persist()
      if (this.displayActionCountAsBadgeText) {
        for (const [tabId, count] of this.actionCounts) this.io.onActionCount?.(tabId, count)
      } else {
        for (const tabId of this.actionCounts.keys()) this.io.onActionCount?.(tabId, 0)
      }
    }
    if (options.tabUpdate) {
      if (!this.displayActionCountAsBadgeText) throw new Error(ERROR_INCREMENT_WITHOUT_BADGE_TEXT)
      const { tabId, increment } = options.tabUpdate
      if (!this.isValidTabId(tabId)) throw new Error(formatMessage(ERROR_TAB_NOT_FOUND, tabId))
      this.setActionCount(tabId, Math.max(0, (this.actionCounts.get(tabId) ?? 0) + increment))
    }
  }

  /** Whether the badge should show the action count (`setExtensionActionOptions`). */
  displaysActionCountAsBadgeText(): boolean {
    return this.displayActionCountAsBadgeText
  }

  actionCount(tabId: number): number {
    return this.actionCounts.get(tabId) ?? 0
  }

  private setActionCount(tabId: number, count: number): void {
    if ((this.actionCounts.get(tabId) ?? 0) === count) return
    this.actionCounts.set(tabId, count)
    if (this.displayActionCountAsBadgeText) this.io.onActionCount?.(tabId, count)
  }

  // ---- matched rules -----------------------------------------------------------------------

  /** `ActionTracker::OnRuleMatched`, called by the host for every applied rule. */
  recordMatch(match: MatchRecord): void {
    const tabId = this.isValidTabId(match.tabId) ? match.tabId : UNKNOWN_TAB_ID
    const timestamp = match.timestamp ?? this.now()
    if (match.request && this.extension.isUnpacked && this.debugListeners.size > 0) {
      const info: MatchedRuleInfoDebug = {
        rule: { ruleId: match.ruleId, rulesetId: match.rulesetId },
        request: { ...match.request, tabId }
      }
      for (const listener of [...this.debugListeners]) listener(info)
    }
    const record =
      this.hasPermission('declarativeNetRequestFeedback') ||
      (tabId !== UNKNOWN_TAB_ID && this.hasPermission('activeTab'))
    if (record) {
      let list = this.matches.get(tabId)
      if (!list) {
        list = []
        this.matches.set(tabId, list)
      }
      list.push({ ruleId: match.ruleId, rulesetId: match.rulesetId, timestamp })
    }
    const counted =
      tabId !== UNKNOWN_TAB_ID &&
      match.actionType !== 'allow' &&
      match.actionType !== 'allowAllRequests'
    if (counted) this.setActionCount(tabId, (this.actionCounts.get(tabId) ?? 0) + 1)
  }

  /** `onRuleMatchedDebug` source; fires only for unpacked extensions. */
  onRuleMatchedDebug(listener: (info: MatchedRuleInfoDebug) => void): () => void {
    this.debugListeners.add(listener)
    return () => {
      this.debugListeners.delete(listener)
    }
  }

  /** A tab committed a new document: its matches now belong to no tab and its count restarts. */
  onTabNavigated(tabId: number): void {
    this.transferToUnknownTab(tabId)
    this.setActionCount(tabId, 0)
  }

  /** A tab closed. */
  onTabRemoved(tabId: number): void {
    this.transferToUnknownTab(tabId)
    this.actionCounts.delete(tabId)
  }

  private transferToUnknownTab(tabId: number): void {
    if (tabId === UNKNOWN_TAB_ID) return
    const list = this.matches.get(tabId)
    if (!list) return
    this.matches.delete(tabId)
    const unknown = this.matches.get(UNKNOWN_TAB_ID) ?? []
    unknown.push(...list)
    this.matches.set(UNKNOWN_TAB_ID, unknown)
  }

  /** `TrimRulesFromNonActiveTabs`: matches without a tab live five minutes. */
  private trimUnknownTabMatches(now: number): void {
    const list = this.matches.get(UNKNOWN_TAB_ID)
    if (!list) return
    const kept = list.filter((match) => match.timestamp > now - MATCHED_RULE_LIFESPAN_MS)
    if (kept.length === 0) this.matches.delete(UNKNOWN_TAB_ID)
    else this.matches.set(UNKNOWN_TAB_ID, kept)
  }

  /**
   * `getMatchedRules`. `options.userGesture` skips the quota like Chrome does for calls made in
   * response to a user gesture.
   */
  async getMatchedRules(
    filter?: MatchedRulesFilter,
    options: { userGesture?: boolean } = {}
  ): Promise<RulesMatchedDetails> {
    await this.load()
    const tabId = filter?.tabId
    if (tabId !== undefined && tabId !== UNKNOWN_TAB_ID && !this.isValidTabId(tabId)) {
      throw new Error(formatMessage(ERROR_TAB_NOT_FOUND, tabId))
    }
    if (!this.canGetMatchedRules(tabId)) throw new Error(ERROR_GET_MATCHED_RULES_MISSING_PERMISSIONS)
    const now = this.now()
    if (!options.userGesture && !this.quota.take(now)) throw new Error(ERROR_OVER_QUOTA)
    this.trimUnknownTabMatches(now)
    const minTimeStamp = filter?.minTimeStamp ?? -Infinity
    const rulesMatchedInfo: MatchedRuleInfo[] = []
    const add = (list: TrackedMatch[], listTabId: number): void => {
      for (const match of list) {
        if (match.timestamp < minTimeStamp) continue
        rulesMatchedInfo.push({
          rule: { ruleId: match.ruleId, rulesetId: match.rulesetId },
          tabId: listTabId,
          timeStamp: match.timestamp
        })
      }
    }
    if (tabId !== undefined) {
      add(this.matches.get(tabId) ?? [], tabId)
    } else {
      for (const [listTabId, list] of this.matches) add(list, listTabId)
    }
    return { rulesMatchedInfo }
  }
}

function filterRules(rules: readonly Rule[], filter: GetRulesFilter | undefined): Rule[] {
  const ids = filter?.ruleIds ? new Set(filter.ruleIds) : undefined
  return rules.filter((rule) => !ids || ids.has(rule.id)).map(cloneRule)
}
