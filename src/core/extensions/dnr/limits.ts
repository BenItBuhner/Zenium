/**
 * Chrome's declarativeNetRequest constants and the "safe rule" classification. Every value below
 * was checked against the Chromium `main` branch on 2026-09-17:
 *
 * - `extensions/common/api/declarative_net_request.webidl` (the `DeclarativeNetRequest` interface
 *   constants, which are what `chrome.declarativeNetRequest.MAX_*` expose to extensions)
 * - `extensions/browser/api/declarative_net_request/constants.h` (internal limits:
 *   `kMaxStaticRulesPerProfile`, `kMaxDisabledStaticRules`, `kRegexMaxMemKb`)
 * - `extensions/browser/api/declarative_net_request/utils.cc` (`IsRuleSafe`)
 * - `extensions/browser/api/declarative_net_request/action_tracker.h`
 *   (`kNonActiveTabRuleLifespan`)
 * - `extensions/browser/api/declarative_net_request/file_backed_ruleset_source.cc`
 *   (`kMaxUnparsedRulesWarnings`)
 *
 * The public constants are also documented at
 * https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#properties
 */
import type { Rule, RuleActionType } from './rules'

/** Static rules every extension may enable regardless of what other extensions use. */
export const GUARANTEED_MINIMUM_STATIC_RULES = 30000

/** Legacy alias kept for extensions that still read it; Chrome marks it deprecated. */
export const MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES = 5000

export const MAX_NUMBER_OF_DYNAMIC_RULES = 30000
export const MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES = 5000
export const MAX_NUMBER_OF_SESSION_RULES = 5000
export const MAX_NUMBER_OF_UNSAFE_SESSION_RULES = 5000

/** `getMatchedRules` quota: `MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL` calls per interval (minutes). */
export const GETMATCHEDRULES_QUOTA_INTERVAL = 10
export const MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL = 20

/** Regex rules an extension may have enabled across all of its rulesets. */
export const MAX_NUMBER_OF_REGEX_RULES = 1000

export const MAX_NUMBER_OF_STATIC_RULESETS = 100
export const MAX_NUMBER_OF_ENABLED_STATIC_RULESETS = 50

export const DYNAMIC_RULESET_ID = '_dynamic'
export const SESSION_RULESET_ID = '_session'

/**
 * Internal (not exposed on `chrome.declarativeNetRequest`): the global pool of static rules shared
 * by all extensions of a profile on top of each extension's guaranteed minimum
 * (`constants.h` `kMaxStaticRulesPerProfile`).
 */
export const MAX_STATIC_RULES_PER_PROFILE = 300000

/**
 * Internal: the largest static ruleset Chrome will index at all. Bigger rulesets are ignored at
 * install time with a warning because they could never be enabled (`GetMaximumRulesPerRuleset`).
 */
export const MAX_RULES_PER_STATIC_RULESET =
  GUARANTEED_MINIMUM_STATIC_RULES + MAX_STATIC_RULES_PER_PROFILE

/** Internal: rules an extension may disable with `updateStaticRules` (`kMaxDisabledStaticRules`). */
export const MAX_DISABLED_STATIC_RULES = 5000

/** Internal: memory RE2 may use per compiled `regexFilter` (`kRegexMaxMemKb`). */
export const REGEX_MAX_MEMORY_BYTES = 2 * 1024

/** Internal: matched rules of closed tabs are kept this long (`kNonActiveTabRuleLifespan`). */
export const MATCHED_RULE_LIFESPAN_MS = 5 * 60 * 1000

/** Internal: install warnings per ruleset before Chrome collapses the rest into one line. */
export const MAX_UNPARSED_RULE_WARNINGS = 5

export const DNR_CONSTANTS = Object.freeze({
  GUARANTEED_MINIMUM_STATIC_RULES,
  MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES,
  MAX_NUMBER_OF_DYNAMIC_RULES,
  MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES,
  MAX_NUMBER_OF_SESSION_RULES,
  MAX_NUMBER_OF_UNSAFE_SESSION_RULES,
  GETMATCHEDRULES_QUOTA_INTERVAL,
  MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL,
  MAX_NUMBER_OF_REGEX_RULES,
  MAX_NUMBER_OF_STATIC_RULESETS,
  MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
  DYNAMIC_RULESET_ID,
  SESSION_RULESET_ID
})

export type DnrConstants = typeof DNR_CONSTANTS

const SAFE_ACTION_TYPES: ReadonlySet<RuleActionType> = new Set<RuleActionType>([
  'block',
  'allow',
  'allowAllRequests',
  'upgradeScheme'
])

/**
 * Chrome's `IsRuleSafe`: block, allow, allowAllRequests and upgradeScheme are "safe"; redirect and
 * modifyHeaders are not and count against `MAX_NUMBER_OF_UNSAFE_*_RULES`.
 */
export function isRuleSafe(rule: Pick<Rule, 'action'>): boolean {
  return SAFE_ACTION_TYPES.has(rule.action.type)
}

export function countUnsafeRules(rules: readonly Pick<Rule, 'action'>[]): number {
  let count = 0
  for (const rule of rules) if (!isRuleSafe(rule)) count++
  return count
}

export function countRegexRules(rules: readonly Pick<Rule, 'condition'>[]): number {
  let count = 0
  for (const rule of rules) if (rule.condition.regexFilter !== undefined) count++
  return count
}
