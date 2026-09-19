import type { RegexOptions, TestMatchRequestDetails } from './api'
import type { RequestMethod, ResourceType } from './rules'
import type { EngineDecision } from './sink'
import type {
  ExtensionActionOptions,
  GetRulesFilter,
  MatchRecord,
  MatchedRulesFilter,
  UpdateRuleOptions,
  UpdateRulesetOptions,
  UpdateStaticRulesOptions
} from './state'

/**
 * The argument shapes of `chrome.declarativeNetRequest` calls as an extension's context sends
 * them over a host's bridge (plain JSON, `unknown` to the host). The state validates rules and
 * ids; these settle the container types and reject the malformed with Chrome's messages. Both
 * hosts route their `declarativeNetRequest` handlers through them; a host wraps whatever they
 * throw into its own API error (the desktop's `ApiError`, the Android bridge's rejection), so
 * they throw plain errors.
 */

function record(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Invalid options.')
  }
  return raw as Record<string, unknown>
}

function integerList(raw: unknown, name: string): number[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new Error(`Invalid value for '${name}'.`)
  const out: number[] = []
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new Error(`Invalid value for '${name}'.`)
    }
    out.push(value)
  }
  return out
}

function stringList(raw: unknown, name: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new Error(`Invalid value for '${name}'.`)
  const out: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string') throw new Error(`Invalid value for '${name}'.`)
    out.push(value)
  }
  return out
}

/** `updateDynamicRules` / `updateSessionRules` options. */
export function ruleUpdate(raw: unknown): UpdateRuleOptions {
  const options = record(raw)
  const out: UpdateRuleOptions = {}
  const remove = integerList(options.removeRuleIds, 'removeRuleIds')
  if (remove) out.removeRuleIds = remove
  if (options.addRules !== undefined && options.addRules !== null) {
    if (!Array.isArray(options.addRules)) throw new Error("Invalid value for 'addRules'.")
    out.addRules = options.addRules as unknown[]
  }
  return out
}

/** `getDynamicRules` / `getSessionRules` filter. */
export function rulesFilter(raw: unknown): GetRulesFilter | undefined {
  if (raw === undefined || raw === null) return undefined
  const out: GetRulesFilter = {}
  const ids = integerList(record(raw).ruleIds, 'ruleIds')
  if (ids) out.ruleIds = ids
  return out
}

/** `updateEnabledRulesets` options. */
export function rulesetUpdate(raw: unknown): UpdateRulesetOptions {
  const options = record(raw)
  const out: UpdateRulesetOptions = {}
  const disable = stringList(options.disableRulesetIds, 'disableRulesetIds')
  if (disable) out.disableRulesetIds = disable
  const enable = stringList(options.enableRulesetIds, 'enableRulesetIds')
  if (enable) out.enableRulesetIds = enable
  return out
}

/** `updateStaticRules` options (`getDisabledRuleIds` takes the `rulesetId` of it). */
export function staticOptions(raw: unknown): UpdateStaticRulesOptions {
  const options = record(raw)
  if (typeof options.rulesetId !== 'string') {
    throw new Error("Missing required property 'rulesetId'.")
  }
  const out: UpdateStaticRulesOptions = { rulesetId: options.rulesetId }
  const disable = integerList(options.disableRuleIds, 'disableRuleIds')
  if (disable) out.disableRuleIds = disable
  const enable = integerList(options.enableRuleIds, 'enableRuleIds')
  if (enable) out.enableRuleIds = enable
  return out
}

/** `getMatchedRules` filter. */
export function matchedFilter(raw: unknown): MatchedRulesFilter | undefined {
  if (raw === undefined || raw === null) return undefined
  const options = record(raw)
  const out: MatchedRulesFilter = {}
  if (options.tabId !== undefined && options.tabId !== null) {
    if (typeof options.tabId !== 'number' || !Number.isInteger(options.tabId)) {
      throw new Error("Invalid value for 'tabId'.")
    }
    out.tabId = options.tabId
  }
  if (options.minTimeStamp !== undefined && options.minTimeStamp !== null) {
    if (typeof options.minTimeStamp !== 'number') {
      throw new Error("Invalid value for 'minTimeStamp'.")
    }
    out.minTimeStamp = options.minTimeStamp
  }
  return out
}

/** `setExtensionActionOptions` options. */
export function actionOptions(raw: unknown): ExtensionActionOptions {
  const options = record(raw)
  const out: ExtensionActionOptions = {}
  if (options.displayActionCountAsBadgeText !== undefined) {
    if (typeof options.displayActionCountAsBadgeText !== 'boolean') {
      throw new Error("Invalid value for 'displayActionCountAsBadgeText'.")
    }
    out.displayActionCountAsBadgeText = options.displayActionCountAsBadgeText
  }
  if (options.tabUpdate !== undefined && options.tabUpdate !== null) {
    const update = record(options.tabUpdate)
    if (
      typeof update.tabId !== 'number' ||
      !Number.isInteger(update.tabId) ||
      typeof update.increment !== 'number' ||
      !Number.isInteger(update.increment)
    ) {
      throw new Error("Invalid value for 'tabUpdate'.")
    }
    out.tabUpdate = { tabId: update.tabId, increment: update.increment }
  }
  return out
}

/** `isRegexSupported` options. */
export function regexOptions(raw: unknown): RegexOptions {
  const options = record(raw)
  if (typeof options.regex !== 'string') throw new Error("Missing required property 'regex'.")
  const out: RegexOptions = { regex: options.regex }
  if (typeof options.isCaseSensitive === 'boolean') out.isCaseSensitive = options.isCaseSensitive
  if (typeof options.requireCapturing === 'boolean') out.requireCapturing = options.requireCapturing
  return out
}

/** `testMatchOutcome` request details. */
export function testRequest(raw: unknown): TestMatchRequestDetails {
  const options = record(raw)
  if (typeof options.url !== 'string') throw new Error("Missing required property 'url'.")
  if (typeof options.type !== 'string') throw new Error("Missing required property 'type'.")
  const out: TestMatchRequestDetails = { url: options.url, type: options.type as ResourceType }
  if (typeof options.initiator === 'string') out.initiator = options.initiator
  if (typeof options.method === 'string') out.method = options.method as RequestMethod
  if (typeof options.tabId === 'number') out.tabId = options.tabId
  if (typeof options.responseHeaders === 'object' && options.responseHeaders !== null) {
    out.responseHeaders = options.responseHeaders as TestMatchRequestDetails['responseHeaders']
  }
  return out
}

/**
 * The rule action an engine decision stands for, in `chrome.declarativeNetRequest.RuleActionType`
 * terms (what `recordMatch` logs and `onRuleMatchedDebug` reports).
 */
export function matchedActionType(
  decision: Pick<EngineDecision, 'action'>
): NonNullable<MatchRecord['actionType']> {
  switch (decision.action) {
    case 'block':
      return 'block'
    case 'redirect':
      return 'redirect'
    case 'upgrade':
      return 'upgradeScheme'
    case 'modifyHeaders':
      return 'modifyHeaders'
    case 'allow':
      return 'allow'
  }
}
