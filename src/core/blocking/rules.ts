/**
 * The request-blocking rule contract shared by every consumer of Zenium's blocking engine: the
 * filter-list updater, the user's own filters, per-site exceptions, the global switch and – the
 * reason this file is shaped the way it is – a `chrome.declarativeNetRequest` translator.
 *
 * ## Rule sets
 *
 * Everything the engine knows is a {@link RuleSet}. A set carries either structured
 * {@link Rule}s (the shape of `chrome.declarativeNetRequest.Rule`, so a translator is a near
 * identity) or `filterText` in ABP / uBlock Origin filter syntax, or both. Sets are independent:
 * replacing one (`setRuleSet` with the same `id`) or removing it never touches the others.
 *
 * ## Conflict resolution (declarativeNetRequest semantics)
 *
 * 1. The rule with the highest effective priority wins. Effective priority is the set's
 *    `priority` first and the rule's `priority` (default 1) second.
 * 2. Among rules of equal priority the order is `allow` > `allowAllRequests` > `block` >
 *    `upgradeScheme` > `redirect`.
 * 3. `allowAllRequests` matched by a frame's document (main_frame / sub_frame) allows every
 *    request made from that document, so per-site exceptions are `allowAllRequests` rules on
 *    `requestDomains` with `resourceTypes: ['main_frame', 'sub_frame']`.
 * 4. `modifyHeaders` rules apply whenever the request is neither blocked nor redirected, unless
 *    an `allow` / `allowAllRequests` rule of equal or higher priority matched.
 * 5. Filter text is matched by the platform's text matcher (Ghostery's engine on desktop, the
 *    Kotlin matcher on Android); its result takes part in the resolution above at the set's
 *    priority, with uBlock's `@@` exceptions and `$important` resolved inside the text matcher.
 *
 * ## Persistence and hand-over
 *
 * The engine serialises its sets as JSON in the profile: `blocking/index.json` lists every set
 * (structured rules inline, `filterText` replaced by `hasFilterText`) and `blocking/<id>.json`
 * holds the full set including its text. The Kotlin engine on Android reads exactly these files,
 * so a translator that calls `setRuleSet` in the core protects both platforms.
 */

/** Resource types as named by `chrome.declarativeNetRequest.ResourceType`. */
export type ResourceType =
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

export const RESOURCE_TYPES: readonly ResourceType[] = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other'
]

export type RuleActionType =
  | 'block'
  | 'allow'
  | 'allowAllRequests'
  | 'redirect'
  | 'upgradeScheme'
  | 'modifyHeaders'

export type HeaderOperation = 'append' | 'set' | 'remove'

/** One header edit (`chrome.declarativeNetRequest.ModifyHeaderInfo`). */
export interface HeaderOp {
  header: string
  operation: HeaderOperation
  /** Required for `append` and `set`; ignored for `remove`. */
  value?: string
}

export interface RuleAction {
  type: RuleActionType
  /** `redirect`: a fixed URL or a substitution for `condition.regexFilter` (`\1` style groups). */
  redirect?: { url?: string; regexSubstitution?: string }
  /** `modifyHeaders`: edits applied before the request is sent. */
  requestHeaders?: HeaderOp[]
  /** `modifyHeaders`: edits applied to the response. */
  responseHeaders?: HeaderOp[]
}

export type DomainType = 'firstParty' | 'thirdParty'

/**
 * `chrome.declarativeNetRequest.RuleCondition`. Domain lists match the domain and its
 * subdomains; an empty condition matches every request.
 */
export interface RuleCondition {
  /**
   * URL pattern with declarativeNetRequest anchors: `||` = start of a (sub)domain, `|` = start
   * or end of the URL, `^` = separator (anything but a letter, digit, `_`, `-`, `.`, `%`, or the
   * end), `*` = any run of characters. ASCII only (punycode for IDN hosts).
   */
  urlFilter?: string
  /** RE2-compatible regular expression tested against the whole URL (exclusive with `urlFilter`). */
  regexFilter?: string
  /** Default false, as in Chrome 118+. */
  isUrlFilterCaseSensitive?: boolean
  initiatorDomains?: string[]
  excludedInitiatorDomains?: string[]
  requestDomains?: string[]
  excludedRequestDomains?: string[]
  resourceTypes?: ResourceType[]
  excludedResourceTypes?: ResourceType[]
  /** HTTP methods in lowercase (`get`, `post`, …). */
  requestMethods?: string[]
  excludedRequestMethods?: string[]
  domainType?: DomainType
  /** Numeric tab ids compared against the decimal part of the host's tab id. */
  tabIds?: number[]
  excludedTabIds?: number[]
}

/** A rule shaped after `chrome.declarativeNetRequest.Rule`. */
export interface Rule {
  /** Unique within its rule set, ≥ 1. */
  id: number
  /** ≥ 1; defaults to 1. Compared only within a set's priority band. */
  priority?: number
  action: RuleAction
  condition: RuleCondition
}

export type RuleSetSource = 'filter-list' | 'dnr' | 'builtin' | 'user'

export interface RuleSetAttribution {
  name: string
  url: string
  licence: string
}

export interface RuleSet {
  /** Stable id; also the file name under `blocking/`. Builtin ids start with `builtin:`. */
  id: string
  source: RuleSetSource
  /** Sets with a higher priority win over sets with a lower one (see the module doc). */
  priority: number
  enabled: boolean
  /** Structured rules (declarativeNetRequest shape). */
  rules?: Rule[]
  /** ABP / uBlock Origin filter syntax, one filter per line. */
  filterText?: string
  /** List version (`! Version:` header) or a translator's manifest version. */
  version?: string
  /** When the content was last refreshed (ms since epoch). */
  updatedAt?: number
  attribution?: RuleSetAttribution
}

/** What `listRuleSets` returns: a set without its payload plus counts. */
export interface RuleSetSummary {
  id: string
  source: RuleSetSource
  priority: number
  enabled: boolean
  version?: string
  updatedAt?: number
  attribution?: RuleSetAttribution
  /** Structured rules in the set. */
  ruleCount: number
  /** Network filters in `filterText` (comments and cosmetic filters excluded). */
  filterCount: number
  /** The set has filter text on disk (`blocking/<id>.json`). */
  hasFilterText: boolean
}

/** One request as the engine sees it. */
export interface RequestContext {
  url: string
  type: ResourceType
  /** Origin (or URL) of the frame that initiated the request, when known. */
  initiator?: string
  /**
   * URL of the top-level document of the tab the request belongs to. `allowAllRequests` rules
   * (per-site exceptions) are matched against it, so a site the user excepted stays excepted
   * inside nested frames. Absent for main-frame navigations.
   */
  documentUrl?: string
  /** Uppercase HTTP method (`GET`). */
  method: string
  /** Precomputed by the host when it knows; otherwise derived from `url` vs `initiator`. */
  isThirdParty?: boolean
  tabId?: string
  frameId?: number
  /** Session partition / container id the request runs in. */
  partition?: string
  isPrivate?: boolean
}

export type DecisionAction = 'allow' | 'block' | 'redirect' | 'upgrade' | 'modifyHeaders'

export interface DecisionMatch {
  setId: string
  ruleId?: number
  /** The raw filter line for text matches. */
  filter?: string
}

export interface Decision {
  action: DecisionAction
  redirectUrl?: string
  requestHeaders?: HeaderOp[]
  responseHeaders?: HeaderOp[]
  /** What decided; absent for the default `allow`. */
  matched?: DecisionMatch
}

export const ALLOW: Decision = Object.freeze({ action: 'allow' }) as Decision

/**
 * Notification about a set that changed. For `set` changes the full set rides along (with its
 * `filterText` when the caller supplied it) so hosts can rebuild a text matcher, plus the
 * engine's summary of it. `persisted` marks a set whose text is already on disk (startup,
 * bundled snapshots, enable / disable flips): the store keeps its file bookkeeping and hosts
 * read the text back from `blocking/` instead of from the change.
 */
export interface RuleSetChange {
  kind: 'set' | 'remove'
  id: string
  set?: RuleSet
  summary?: RuleSetSummary
  persisted?: boolean
}

export type RuleSetListener = (change: RuleSetChange) => void

/**
 * The engine every consumer talks to. `decide` is synchronous and fast enough to sit in a
 * network hook (microseconds for structured rules; the text matcher is token indexed).
 */
export interface BlockingEngine {
  /** Add or replace a rule set (matched by `id`). */
  setRuleSet(set: RuleSet): void
  removeRuleSet(id: string): void
  listRuleSets(): RuleSetSummary[]
  decide(ctx: RequestContext): Decision
  /** Subscribe to set changes; returns the unsubscribe function. */
  subscribe(listener: RuleSetListener): () => void
}

// ---------------------------------------------------------------------------
// Well-known sets and priorities
// ---------------------------------------------------------------------------

/** Rule sets the core itself maintains. */
export const BUILTIN_RULE_SETS = {
  /** An `allow` on everything while blocking is off. */
  globalOff: 'builtin:global-off',
  /** `allowAllRequests` for every site the user excepted. */
  siteExceptions: 'builtin:site-exceptions'
} as const

/** Priority bands. Consumers pick a value inside their band. */
export const RULE_SET_PRIORITY = {
  /** Subscribed filter lists (EasyList, …). */
  filterList: 1,
  /** Rule sets translated from extensions' declarativeNetRequest rules. */
  dnr: 5,
  /** The user's own filters. */
  user: 10,
  /** Per-site exceptions. */
  siteExceptions: 900,
  /** The global off switch. */
  globalOff: 1000
} as const

export const USER_RULE_SET_ID = 'user'
