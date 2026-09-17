/**
 * The extension-facing `chrome.declarativeNetRequest` surface, as a plain object of async
 * functions bound to one extension's `DnrState`, plus the constants, `isRegexSupported`,
 * `testMatchOutcome` and the `onRuleMatchedDebug` event. The desktop IPC layer and the Android
 * shim expose it to the extension 1:1; every method rejects with Chrome's error message, so
 * hosts can surface it as `chrome.runtime.lastError` unchanged.
 *
 * Availability follows Chrome's feature file (`_api_features.json`): `testMatchOutcome` and
 * `onRuleMatchedDebug` exist only for unpacked extensions, and the event additionally needs the
 * `declarativeNetRequestFeedback` permission.
 */
import { DNR_CONSTANTS, type DnrConstants } from './limits'
import { checkRegex } from './regex'
import {
  isValidHeaderName,
  RESOURCE_TYPES,
  type RequestMethod,
  type ResourceType,
  type Rule
} from './rules'
import { matchRequest, type MatchRequest } from './matcher'
import {
  UNKNOWN_TAB_ID,
  type DnrState,
  type ExtensionActionOptions,
  type GetDisabledRuleIdsOptions,
  type GetRulesFilter,
  type MatchedRule,
  type MatchedRuleInfoDebug,
  type MatchedRulesFilter,
  type RulesMatchedDetails,
  type UpdateRuleOptions,
  type UpdateRulesetOptions,
  type UpdateStaticRulesOptions
} from './state'

// Chrome's messages (extensions/browser/api/declarative_net_request/constants.cc).
export const ERROR_INVALID_TEST_URL = 'Invalid test request URL.'
export const ERROR_INVALID_TEST_INITIATOR = 'Invalid test request initiator.'
export const ERROR_INVALID_TEST_TAB_ID = 'Invalid test request tab ID.'
export const ERROR_INVALID_TEST_TOP_URL = 'Invalid test request top URL.'
export const ERROR_INVALID_RESPONSE_HEADER_OBJECT =
  'Values for header "*" must be specified as a list.'
export const ERROR_INVALID_RESPONSE_HEADER_NAME = 'Invalid header name "*".'
export const ERROR_INVALID_RESPONSE_HEADER_VALUE = 'Invalid header value for header "*".'

export interface RegexOptions {
  regex: string
  /** Defaults to true, unlike rules. */
  isCaseSensitive?: boolean
  requireCapturing?: boolean
}

export interface IsRegexSupportedResult {
  isSupported: boolean
  reason?: 'syntaxError' | 'memoryLimitExceeded'
}

export interface TestMatchRequestDetails {
  url: string
  initiator?: string
  method?: RequestMethod
  type: ResourceType
  tabId?: number
  /** Top-level frame URL for `topDomains`; undocumented in Chrome but accepted. */
  topUrl?: string
  responseHeaders?: Record<string, unknown>
}

export interface TestMatchOutcomeResult {
  matchedRules: MatchedRule[]
}

/** A `chrome.events.Event`-shaped listener registry. */
export interface DnrEvent<T> {
  addListener(listener: (info: T) => void): void
  removeListener(listener: (info: T) => void): void
  hasListener(listener: (info: T) => void): boolean
  hasListeners(): boolean
}

export interface DeclarativeNetRequestApi extends DnrConstants {
  updateDynamicRules(options: UpdateRuleOptions): Promise<void>
  getDynamicRules(filter?: GetRulesFilter): Promise<Rule[]>
  updateSessionRules(options: UpdateRuleOptions): Promise<void>
  getSessionRules(filter?: GetRulesFilter): Promise<Rule[]>
  updateEnabledRulesets(options: UpdateRulesetOptions): Promise<void>
  getEnabledRulesets(): Promise<string[]>
  updateStaticRules(options: UpdateStaticRulesOptions): Promise<void>
  getDisabledRuleIds(options: GetDisabledRuleIdsOptions): Promise<number[]>
  getAvailableStaticRuleCount(): Promise<number>
  getMatchedRules(filter?: MatchedRulesFilter): Promise<RulesMatchedDetails>
  setExtensionActionOptions(options: ExtensionActionOptions): Promise<void>
  isRegexSupported(options: RegexOptions): Promise<IsRegexSupportedResult>
  /** Unpacked extensions only. */
  testMatchOutcome?(request: TestMatchRequestDetails): Promise<TestMatchOutcomeResult>
  /** Unpacked extensions with the `declarativeNetRequestFeedback` permission only. */
  onRuleMatchedDebug?: DnrEvent<MatchedRuleInfoDebug>
}

/** `chrome.declarativeNetRequest.isRegexSupported`, synchronous under the hood. */
export function isRegexSupported(options: RegexOptions): IsRegexSupportedResult {
  const result = checkRegex(options.regex, {
    isCaseSensitive: options.isCaseSensitive ?? true,
    requireCapturing: options.requireCapturing ?? false
  })
  return result.isSupported ? { isSupported: true } : { isSupported: false, reason: result.reason }
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

function format(template: string, arg: string): string {
  return template.replace('*', arg)
}

/** Validate `testMatchOutcome` arguments the way Chrome does and build the matcher request. */
export function toMatchRequest(request: TestMatchRequestDetails): MatchRequest {
  if (!isValidUrl(request.url)) throw new Error(ERROR_INVALID_TEST_URL)
  if (request.initiator !== undefined && !isValidUrl(request.initiator)) {
    throw new Error(ERROR_INVALID_TEST_INITIATOR)
  }
  const tabId = request.tabId ?? UNKNOWN_TAB_ID
  if (tabId < UNKNOWN_TAB_ID) throw new Error(ERROR_INVALID_TEST_TAB_ID)
  if (request.topUrl !== undefined && !isValidUrl(request.topUrl)) {
    throw new Error(ERROR_INVALID_TEST_TOP_URL)
  }
  if (!RESOURCE_TYPES.includes(request.type)) {
    throw new TypeError(`Invalid resource type: ${String(request.type)}`)
  }
  const out: MatchRequest = { url: request.url, type: request.type, tabId }
  if (request.initiator !== undefined) out.initiator = request.initiator
  if (request.method !== undefined) out.method = request.method
  if (request.topUrl !== undefined) out.topUrl = request.topUrl
  if (request.responseHeaders !== undefined) {
    const headers: Record<string, string[]> = {}
    for (const [name, values] of Object.entries(request.responseHeaders)) {
      if (!isValidHeaderName(name))
        throw new Error(format(ERROR_INVALID_RESPONSE_HEADER_NAME, name))
      if (!Array.isArray(values))
        throw new Error(format(ERROR_INVALID_RESPONSE_HEADER_OBJECT, name))
      const list: string[] = []
      for (const value of values) {
        if (typeof value !== 'string' || /[\r\n\0]/.test(value)) {
          throw new Error(format(ERROR_INVALID_RESPONSE_HEADER_VALUE, name))
        }
        list.push(value)
      }
      headers[name] = list
    }
    out.responseHeaders = headers
  }
  return out
}

/** `chrome.declarativeNetRequest.testMatchOutcome` against the extension's rulesets. */
export function testMatchOutcome(
  state: DnrState,
  request: TestMatchRequestDetails
): TestMatchOutcomeResult {
  const matchRequestDetails = toMatchRequest(request)
  const outcome = matchRequest(state.matcherRulesets(), matchRequestDetails)
  return { matchedRules: outcome?.matchedRules ?? [] }
}

function createEvent<T>(subscribe: (listener: (info: T) => void) => () => void): DnrEvent<T> {
  const unsubscribes = new Map<(info: T) => void, () => void>()
  return {
    addListener(listener) {
      if (unsubscribes.has(listener)) return
      unsubscribes.set(listener, subscribe(listener))
    },
    removeListener(listener) {
      unsubscribes.get(listener)?.()
      unsubscribes.delete(listener)
    },
    hasListener(listener) {
      return unsubscribes.has(listener)
    },
    hasListeners() {
      return unsubscribes.size > 0
    }
  }
}

/**
 * Bind the API to a state. Methods are plain properties so a host can spread them into an IPC
 * table or a `chrome` shim without losing `this`.
 */
export function createDeclarativeNetRequestApi(state: DnrState): DeclarativeNetRequestApi {
  const api: DeclarativeNetRequestApi = {
    ...DNR_CONSTANTS,
    updateDynamicRules: (options) => state.updateDynamicRules(options),
    getDynamicRules: (filter) => state.getDynamicRules(filter),
    updateSessionRules: (options) => state.updateSessionRules(options),
    getSessionRules: (filter) => state.getSessionRules(filter),
    updateEnabledRulesets: (options) => state.updateEnabledRulesets(options),
    getEnabledRulesets: () => state.getEnabledRulesets(),
    updateStaticRules: (options) => state.updateStaticRules(options),
    getDisabledRuleIds: (options) => state.getDisabledRuleIds(options),
    getAvailableStaticRuleCount: () => state.getAvailableStaticRuleCount(),
    getMatchedRules: (filter) => state.getMatchedRules(filter),
    setExtensionActionOptions: (options) => state.setExtensionActionOptions(options),
    isRegexSupported: async (options) => isRegexSupported(options)
  }
  if (state.extension.isUnpacked) {
    api.testMatchOutcome = async (request) => {
      await state.load()
      return testMatchOutcome(state, request)
    }
    if (state.hasPermission('declarativeNetRequestFeedback')) {
      api.onRuleMatchedDebug = createEvent((listener) => state.onRuleMatchedDebug(listener))
    }
  }
  return api
}
