/**
 * What the translator hands to Zenium's request-blocking engine.
 *
 * The types below are a structural mirror of the engine's rule contract in
 * `src/core/blocking/rules.ts` on the services branch (`cursor/services-blocking-24d1`, commit
 * 9cbba7f): `EngineRuleSet` is assignable to the engine's `RuleSet`, `EngineRule` to its `Rule`,
 * and the engine's `RuleEngine` satisfies `RuleSink`, so once that branch lands on `main` this
 * file shrinks to re-exports and nothing else in `dnr/` changes. Fields the engine does not know
 * yet (`redirect.transform`) are optional extras the translator records for it.
 *
 * Engine semantics the translator relies on (from the engine's module doc):
 *
 * - Sets are independent; `setRuleSet` with an existing id replaces that set only.
 * - The winning rule has the highest effective priority: the set's `priority` first, the rule's
 *   `priority` (default 1) second. Among equal priorities `allow` > `allowAllRequests` > `block`
 *   > `upgradeScheme` > `redirect`; `modifyHeaders` rules apply when nothing blocked or
 *   redirected and no allow rule of equal or higher priority matched.
 * - `RULE_SET_PRIORITY.dnr` (5) is the band reserved for extension rule sets; the next band
 *   (`user`, 10) starts five above it.
 */

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
  | 'block'
  | 'allow'
  | 'allowAllRequests'
  | 'redirect'
  | 'upgradeScheme'
  | 'modifyHeaders'

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
}

/** The engine's `RULE_SET_PRIORITY.dnr`: the base of the band extension rule sets live in. */
export const ENGINE_DNR_PRIORITY = 5

/** Number of integer priorities in the band before the next consumer's band (`user`, 10). */
export const ENGINE_DNR_BAND_SIZE = 5

/**
 * Where translated rule sets go. `RuleEngine` from `src/core/blocking/engine.ts` implements
 * this directly; host adapters that batch or forward over IPC may return promises.
 */
export interface RuleSink {
  setRuleSet(set: EngineRuleSet): void | Promise<void>
  removeRuleSet(id: string): void | Promise<void>
}

// ---------------------------------------------------------------------------------------------
// Set ids

const SET_ID_PREFIX = 'ext:'

export type EngineSetKind =
  | { kind: 'static'; rulesetId: string }
  | { kind: 'dynamic' }
  | { kind: 'session' }

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
