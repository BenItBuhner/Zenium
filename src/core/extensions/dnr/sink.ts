/**
 * What the translator hands to Zenium's request-blocking engine, and what comes back.
 *
 * The types below are a structural mirror of the engine's rule contract in
 * `src/core/blocking/rules.ts`. Each `Engine*` type is assignable to (and from) its upstream
 * namesake (`src/core/blocking/__tests__/engine.test.ts` feeds a `RuleEngine` as a `RuleSink`),
 * so this file can become re-exports without anything else in `dnr/` changing; the priority
 * constants already come from the engine's contract:
 *
 * | here                        | `src/core/blocking/rules.ts`                          |
 * | --------------------------- | ----------------------------------------------------- |
 * | `EngineRuleSet`             | `RuleSet`                                             |
 * | `EngineRule` / `*Action` / `*Condition` | `Rule` / `RuleAction` / `RuleCondition`   |
 * | `EngineRuleSetAttribution`  | `RuleSetAttribution`                                  |
 * | `EngineRequestContext`      | `RequestContext`                                      |
 * | `EngineDecision` / `EngineDecisionMatch` | `Decision` / `DecisionMatch`             |
 * | `RuleSink`                  | `Pick<BlockingEngine, 'setRuleSet' \| 'removeRuleSet'>` |
 * | `ENGINE_DNR_PRIORITY`       | `RULE_SET_PRIORITY.dnr`                               |
 *
 * `redirect.transform` is the one field the engine does not know: an optional extra the
 * translator records for it (`matcher.ts` has the reference `applyUrlTransform`).
 *
 * Engine semantics the translator relies on (from the engine's module doc):
 *
 * - Sets are independent; `setRuleSet` with an existing id replaces that set only.
 * - The winning rule has the highest effective priority: the set's `priority` first, the rule's
 *   `priority` (default 1) second. Among equal priorities `allow` > `allowAllRequests` > `block`
 *   > `upgradeScheme` > `redirect`; `modifyHeaders` rules apply when nothing blocked or
 *   redirected and no allow rule of equal or higher priority matched.
 * - `allowAllRequests` rules are also matched against the request's document (`documentUrl`,
 *   falling back to `initiator`), so a matched document allows everything under it.
 * - `RULE_SET_PRIORITY.dnr` (2000) is the band reserved for extension rule sets, `DNR_BAND_SIZE`
 *   (1000) integer slots wide, and it sits above every band of Zenium's own sets: the global
 *   switch and the per-site exceptions do not switch an extension's rules off.
 */
import { DNR_BAND_SIZE, RULE_SET_PRIORITY } from '../../blocking/rules'

/** Resource types as named by `chrome.declarativeNetRequest.ResourceType`. */
export type EngineResourceType =
  | 'main_frame'
  | 'sub_frame'
  | 'stylesheet'
  | 'script'
  | 'image'
  | 'font'
  | 'object'
  | 'xmlhttprequest'
  | 'ping'
  | 'csp_report'
  | 'media'
  | 'websocket'
  | 'webtransport'
  | 'webbundle'
  | 'other'

export type EngineRuleActionType =
  'block' | 'allow' | 'allowAllRequests' | 'redirect' | 'upgradeScheme' | 'modifyHeaders'

export interface EngineHeaderOp {
  header: string
  operation: 'append' | 'set' | 'remove'
  value?: string
}

/** Chrome's `URLTransform`, carried for the engine (it does not apply transforms yet). */
export interface EngineUrlTransform {
  scheme?: string
  host?: string
  port?: string
  path?: string
  query?: string
  queryTransform?: {
    removeParams?: string[]
    addOrReplaceParams?: { key: string; value: string; replaceOnly?: boolean }[]
  }
  fragment?: string
  username?: string
  password?: string
}

export interface EngineRuleAction {
  type: EngineRuleActionType
  /** `redirect`: a fixed URL or a substitution for `condition.regexFilter` (`\1` style groups). */
  redirect?: { url?: string; regexSubstitution?: string; transform?: EngineUrlTransform }
  requestHeaders?: EngineHeaderOp[]
  responseHeaders?: EngineHeaderOp[]
}

export interface EngineRuleCondition {
  urlFilter?: string
  regexFilter?: string
  isUrlFilterCaseSensitive?: boolean
  initiatorDomains?: string[]
  excludedInitiatorDomains?: string[]
  requestDomains?: string[]
  excludedRequestDomains?: string[]
  topDomains?: string[]
  excludedTopDomains?: string[]
  resourceTypes?: EngineResourceType[]
  excludedResourceTypes?: EngineResourceType[]
  /** HTTP methods in lowercase (`get`, `post`, ...). */
  requestMethods?: string[]
  excludedRequestMethods?: string[]
  domainType?: 'firstParty' | 'thirdParty'
  tabIds?: number[]
  excludedTabIds?: number[]
}

/** A rule shaped after `chrome.declarativeNetRequest.Rule`. */
export interface EngineRule {
  id: number
  priority?: number
  action: EngineRuleAction
  condition: EngineRuleCondition
}

/** Who a set comes from, as the blocking settings show it. */
export interface EngineRuleSetAttribution {
  name: string
  url: string
  /** Empty when unknown, as the engine's own custom lists do. */
  licence: string
}

export interface EngineRuleSet {
  /** Stable id; see `engineSetId`. */
  id: string
  source: 'dnr'
  /** Sets with a higher priority win over sets with a lower one. */
  priority: number
  enabled: boolean
  rules?: EngineRule[]
  /** The extension's version. */
  version?: string
  /** When the set was (re)built, ms since the epoch. */
  updatedAt?: number
  /** The extension and ruleset the set came from; see `dnrAttribution`. */
  attribution?: EngineRuleSetAttribution
  /**
   * Session partitions the set applies to (the engine's `RuleSet.partitions`). The translator
   * leaves it out; the host's sink scopes each set to the sessions its extension is loaded into.
   */
  partitions?: string[]
}

/** The engine's `RULE_SET_PRIORITY.dnr`: the base of the band extension rule sets live in. */
export const ENGINE_DNR_PRIORITY: number = RULE_SET_PRIORITY.dnr

/** Number of integer priorities in the band (the engine's `DNR_BAND_SIZE`). */
export const ENGINE_DNR_BAND_SIZE: number = DNR_BAND_SIZE

/**
 * Where translated rule sets go. `RuleEngine` from `src/core/blocking/engine.ts` implements
 * this directly; host adapters that batch or forward over IPC may return promises.
 */
export interface RuleSink {
  setRuleSet(set: EngineRuleSet): void | Promise<void>
  removeRuleSet(id: string): void | Promise<void>
}

/** One request as the engine sees it (`RequestContext`). */
export interface EngineRequestContext {
  url: string
  type: EngineResourceType
  /** Origin (or URL) of the frame that initiated the request, when known. */
  initiator?: string
  /** URL of the top-level document of the tab; absent for main-frame navigations. */
  documentUrl?: string
  /** Uppercase HTTP method (`GET`). */
  method: string
  /** Precomputed by the host when it knows; otherwise derived from `url` and `initiator`. */
  isThirdParty?: boolean
  /** The host's tab id; its decimal part is what `tabIds` conditions compare against. */
  tabId?: string
  frameId?: number
  partition?: string
  isPrivate?: boolean
}

export type EngineDecisionAction = 'allow' | 'block' | 'redirect' | 'upgrade' | 'modifyHeaders'

export interface EngineDecisionMatch {
  setId: string
  ruleId?: number
  /** The raw filter line for text matches. */
  filter?: string
}

/** What the engine decided for a request (`Decision`). */
export interface EngineDecision {
  action: EngineDecisionAction
  redirectUrl?: string
  requestHeaders?: EngineHeaderOp[]
  responseHeaders?: EngineHeaderOp[]
  /** What decided; absent for the default allow. */
  matched?: EngineDecisionMatch
}

// ---------------------------------------------------------------------------------------------
// Set ids

const SET_ID_PREFIX = 'ext:'

export type EngineSetKind =
  { kind: 'static'; rulesetId: string } | { kind: 'dynamic' } | { kind: 'session' }

/**
 * Engine set id for one of an extension's rulesets: `ext:<id>:static:<rulesetId>`,
 * `ext:<id>:_dynamic` or `ext:<id>:_session`. Extension ids are 32 lowercase letters, so the
 * second `:` always ends the extension id.
 */
export function engineSetId(extensionId: string, set: EngineSetKind): string {
  switch (set.kind) {
    case 'static':
      return `${SET_ID_PREFIX}${extensionId}:static:${set.rulesetId}`
    case 'dynamic':
      return `${SET_ID_PREFIX}${extensionId}:_dynamic`
    case 'session':
      return `${SET_ID_PREFIX}${extensionId}:_session`
  }
}

export interface ParsedEngineSetId {
  extensionId: string
  set: EngineSetKind
  /** The id `getMatchedRules` reports: the manifest ruleset id, `_dynamic` or `_session`. */
  rulesetId: string
}

/** Inverse of `engineSetId`, for hosts routing an engine decision back to `recordMatch`. */
export function parseEngineSetId(id: string): ParsedEngineSetId | undefined {
  if (!id.startsWith(SET_ID_PREFIX)) return undefined
  const rest = id.slice(SET_ID_PREFIX.length)
  const colon = rest.indexOf(':')
  if (colon <= 0) return undefined
  const extensionId = rest.slice(0, colon)
  const tail = rest.slice(colon + 1)
  if (tail === '_dynamic') return { extensionId, set: { kind: 'dynamic' }, rulesetId: '_dynamic' }
  if (tail === '_session') return { extensionId, set: { kind: 'session' }, rulesetId: '_session' }
  if (tail.startsWith('static:') && tail.length > 'static:'.length) {
    const rulesetId = tail.slice('static:'.length)
    return { extensionId, set: { kind: 'static', rulesetId }, rulesetId }
  }
  return undefined
}

/** The extension rule an engine decision came from; undefined for decisions by other sets. */
export interface RoutedDecision {
  extensionId: string
  ruleId: number
  /** Public ruleset id, as `getMatchedRules` reports it. */
  rulesetId: string
}

/**
 * Which extension rule decided a request, for hosts that feed engine decisions into
 * `DnrState.recordMatch` (matched-rule log, action counts, `onRuleMatchedDebug`).
 */
export function routeDecision(decision: EngineDecision): RoutedDecision | undefined {
  const matched = decision.matched
  if (!matched || matched.ruleId === undefined) return undefined
  const parsed = parseEngineSetId(matched.setId)
  if (!parsed) return undefined
  return { extensionId: parsed.extensionId, ruleId: matched.ruleId, rulesetId: parsed.rulesetId }
}

// ---------------------------------------------------------------------------------------------
// Attribution

export interface DnrAttributionSource {
  extensionId: string
  /** The extension's display name; the id stands in when unknown. */
  name?: string
  /** Static rulesets: the ruleset file's path inside the extension. */
  path?: string
}

/**
 * Attribution for one of an extension's sets: the name says which extension and which kind of
 * ruleset, the URL is the ruleset file inside the extension (`chrome-extension://<id>/<path>`)
 * or the extension root for the dynamic and session sets.
 */
export function dnrAttribution(
  source: DnrAttributionSource,
  set: EngineSetKind
): EngineRuleSetAttribution {
  const name = source.name ?? source.extensionId
  const root = `chrome-extension://${source.extensionId}/`
  switch (set.kind) {
    case 'static':
      return {
        name: `${name}: ruleset ${set.rulesetId}`,
        url: source.path === undefined ? root : new URL(source.path, root).href,
        licence: ''
      }
    case 'dynamic':
      return { name: `${name}: dynamic rules`, url: root, licence: '' }
    case 'session':
      return { name: `${name}: session rules`, url: root, licence: '' }
  }
}
