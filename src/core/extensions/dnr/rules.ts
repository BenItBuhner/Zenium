/**
 * Chrome's declarativeNetRequest rule model and its validation, mirrored from Chromium `main`
 * (checked 2026-09-17):
 *
 * - `extensions/common/api/declarative_net_request.webidl` (the rule dictionaries and enums)
 * - `extensions/browser/api/declarative_net_request/indexed_rule.cc` (`CreateIndexedRule`, the
 *   semantic checks in the order Chrome runs them, and the `urlFilter` grammar)
 * - `extensions/browser/api/declarative_net_request/utils.cc` (`GetParseError`, the messages)
 * - `extensions/browser/api/declarative_net_request/ruleset_source.cc` (`IndexRules`) and
 *   `file_backed_ruleset_source.cc` (`ParseRulesFromJSON`): which failures skip a rule and which
 *   reject the whole ruleset for each rule source
 *
 * Chrome validates a rule in two layers. The schema layer (generated from the WebIDL) checks
 * shapes: static rulesets skip a rule that fails it and record an install warning, while dynamic
 * and session rules fail synchronously in the JS binding. The semantic layer (`CreateIndexedRule`)
 * runs on well-formed rules: dynamic and session updates reject the whole update on the first
 * error; for static rulesets Chrome fails the install on these at install time but silently
 * skips the rule when it re-indexes at load time (`kNone` parse flags). `parseRuleset` models the
 * load-time behaviour for static rulesets and reports the install-time severity on each issue.
 */
import { checkRegex, checkRegexSubstitution } from './regex'
import { MAX_NUMBER_OF_REGEX_RULES, MAX_RULES_PER_STATIC_RULESET } from './limits'

// ---------------------------------------------------------------------------------------------
// Rule model

export const RESOURCE_TYPES = [
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
] as const
export type ResourceType = (typeof RESOURCE_TYPES)[number]

export const REQUEST_METHODS = [
  'connect',
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
  'other'
] as const
export type RequestMethod = (typeof REQUEST_METHODS)[number]

export const DOMAIN_TYPES = ['firstParty', 'thirdParty'] as const
export type DomainType = (typeof DOMAIN_TYPES)[number]

export const HEADER_OPERATIONS = ['append', 'set', 'remove'] as const
export type HeaderOperation = (typeof HEADER_OPERATIONS)[number]

export const RULE_ACTION_TYPES = [
  'block',
  'redirect',
  'allow',
  'upgradeScheme',
  'modifyHeaders',
  'allowAllRequests'
] as const
export type RuleActionType = (typeof RULE_ACTION_TYPES)[number]

export interface QueryKeyValue {
  key: string
  value: string
  replaceOnly?: boolean
}

export interface QueryTransform {
  removeParams?: string[]
  addOrReplaceParams?: QueryKeyValue[]
}

export interface URLTransform {
  scheme?: string
  host?: string
  port?: string
  path?: string
  query?: string
  queryTransform?: QueryTransform
  fragment?: string
  username?: string
  password?: string
}

export interface Redirect {
  extensionPath?: string
  transform?: URLTransform
  url?: string
  regexSubstitution?: string
}

/** A response header condition (Chrome 128+). */
export interface HeaderInfo {
  header: string
  values?: string[]
  excludedValues?: string[]
}

export interface HeaderRegexOptions {
  matchAll?: boolean
}

export interface ModifyHeaderInfo {
  header: string
  operation: HeaderOperation
  value?: string
  /** Undocumented in Chrome (`[nodoc]`), accepted and validated like Chrome does. */
  regexFilter?: string
  regexSubstitution?: string
  regexOptions?: HeaderRegexOptions
}

export interface RuleAction {
  type: RuleActionType
  redirect?: Redirect
  requestHeaders?: ModifyHeaderInfo[]
  responseHeaders?: ModifyHeaderInfo[]
}

export interface RuleCondition {
  urlFilter?: string
  regexFilter?: string
  /** Defaults to false (case-insensitive) since Chrome 118. */
  isUrlFilterCaseSensitive?: boolean
  initiatorDomains?: string[]
  excludedInitiatorDomains?: string[]
  requestDomains?: string[]
  excludedRequestDomains?: string[]
  topDomains?: string[]
  excludedTopDomains?: string[]
  /** Deprecated alias of `initiatorDomains`. */
  domains?: string[]
  /** Deprecated alias of `excludedInitiatorDomains`. */
  excludedDomains?: string[]
  resourceTypes?: ResourceType[]
  excludedResourceTypes?: ResourceType[]
  requestMethods?: RequestMethod[]
  excludedRequestMethods?: RequestMethod[]
  domainType?: DomainType
  /** Session rules only. */
  tabIds?: number[]
  excludedTabIds?: number[]
  responseHeaders?: HeaderInfo[]
  excludedResponseHeaders?: HeaderInfo[]
}

export interface Rule {
  id: number
  priority?: number
  condition: RuleCondition
  action: RuleAction
}

export type RulesetSource = 'static' | 'dynamic' | 'session'

/** `kMinValidID`, `kMinValidPriority`, `kDefaultPriority` (common/api/declarative_net_request). */
export const MIN_VALID_RULE_ID = 1
export const MIN_VALID_PRIORITY = 1
export const DEFAULT_PRIORITY = 1

// ---------------------------------------------------------------------------------------------
// Bitmasks shared with the matcher

const ELEMENT_TYPE_BIT: Readonly<Record<ResourceType, number>> = Object.fromEntries(
  RESOURCE_TYPES.map((type, index) => [type, 1 << index])
) as Record<ResourceType, number>

export const ELEMENT_TYPES_ANY = (1 << RESOURCE_TYPES.length) - 1

/** Chrome matches every type but `main_frame` when a rule names no resource types. */
export const ELEMENT_TYPES_DEFAULT = ELEMENT_TYPES_ANY & ~ELEMENT_TYPE_BIT.main_frame

export function elementTypeBit(type: ResourceType): number {
  return ELEMENT_TYPE_BIT[type]
}

const REQUEST_METHOD_BIT: Readonly<Record<RequestMethod, number>> = Object.fromEntries(
  REQUEST_METHODS.map((method, index) => [method, 1 << index])
) as Record<RequestMethod, number>

/** Requests over non-HTTP(S) schemes carry no method; Chrome gives them their own bit. */
export const REQUEST_METHOD_NON_HTTP = 1 << REQUEST_METHODS.length
export const REQUEST_METHODS_ANY = (1 << (REQUEST_METHODS.length + 1)) - 1

export function requestMethodBit(method: RequestMethod): number {
  return REQUEST_METHOD_BIT[method]
}

// ---------------------------------------------------------------------------------------------
// Schema layer

/**
 * `'file'` mirrors the C++ `Rule::FromValue` used for rule files (unknown keys ignored, null is a
 * type error); `'binding'` mirrors the renderer argument validation used for `updateDynamicRules`
 * and `updateSessionRules` (unknown keys rejected, null and undefined mean absent).
 */
export type SchemaStyle = 'file' | 'binding'

type FieldSpec =
  | { kind: 'integer'; required?: boolean }
  | { kind: 'string'; required?: boolean }
  | { kind: 'boolean'; required?: boolean }
  | { kind: 'enum'; values: readonly string[]; required?: boolean }
  | { kind: 'list'; item: FieldSpec; required?: boolean }
  | { kind: 'object'; shape: Shape; required?: boolean }

type Shape = Readonly<Record<string, FieldSpec>>

const STRING_LIST: FieldSpec = { kind: 'list', item: { kind: 'string' } }

const QUERY_KEY_VALUE_SHAPE: Shape = {
  key: { kind: 'string', required: true },
  value: { kind: 'string', required: true },
  replaceOnly: { kind: 'boolean' }
}

const URL_TRANSFORM_SHAPE: Shape = {
  scheme: { kind: 'string' },
  host: { kind: 'string' },
  port: { kind: 'string' },
  path: { kind: 'string' },
  query: { kind: 'string' },
  queryTransform: {
    kind: 'object',
    shape: {
      removeParams: STRING_LIST,
      addOrReplaceParams: { kind: 'list', item: { kind: 'object', shape: QUERY_KEY_VALUE_SHAPE } }
    }
  },
  fragment: { kind: 'string' },
  username: { kind: 'string' },
  password: { kind: 'string' }
}

const HEADER_INFO_SHAPE: Shape = {
  header: { kind: 'string', required: true },
  values: STRING_LIST,
  excludedValues: STRING_LIST
}

const MODIFY_HEADER_INFO_SHAPE: Shape = {
  header: { kind: 'string', required: true },
  operation: { kind: 'enum', values: HEADER_OPERATIONS, required: true },
  value: { kind: 'string' },
  regexFilter: { kind: 'string' },
  regexSubstitution: { kind: 'string' },
  regexOptions: { kind: 'object', shape: { matchAll: { kind: 'boolean' } } }
}

const REDIRECT_SHAPE: Shape = {
  extensionPath: { kind: 'string' },
  transform: { kind: 'object', shape: URL_TRANSFORM_SHAPE },
  url: { kind: 'string' },
  regexSubstitution: { kind: 'string' }
}

const RULE_SHAPE: Shape = {
  id: { kind: 'integer', required: true },
  priority: { kind: 'integer' },
  condition: {
    kind: 'object',
    required: true,
    shape: {
      urlFilter: { kind: 'string' },
      regexFilter: { kind: 'string' },
      isUrlFilterCaseSensitive: { kind: 'boolean' },
      initiatorDomains: STRING_LIST,
      excludedInitiatorDomains: STRING_LIST,
      requestDomains: STRING_LIST,
      excludedRequestDomains: STRING_LIST,
      topDomains: STRING_LIST,
      excludedTopDomains: STRING_LIST,
      domains: STRING_LIST,
      excludedDomains: STRING_LIST,
      resourceTypes: { kind: 'list', item: { kind: 'enum', values: RESOURCE_TYPES } },
      excludedResourceTypes: { kind: 'list', item: { kind: 'enum', values: RESOURCE_TYPES } },
      requestMethods: { kind: 'list', item: { kind: 'enum', values: REQUEST_METHODS } },
      excludedRequestMethods: { kind: 'list', item: { kind: 'enum', values: REQUEST_METHODS } },
      domainType: { kind: 'enum', values: DOMAIN_TYPES },
      tabIds: { kind: 'list', item: { kind: 'integer' } },
      excludedTabIds: { kind: 'list', item: { kind: 'integer' } },
      responseHeaders: { kind: 'list', item: { kind: 'object', shape: HEADER_INFO_SHAPE } },
      excludedResponseHeaders: { kind: 'list', item: { kind: 'object', shape: HEADER_INFO_SHAPE } }
    }
  },
  action: {
    kind: 'object',
    required: true,
    shape: {
      type: { kind: 'enum', values: RULE_ACTION_TYPES, required: true },
      redirect: { kind: 'object', shape: REDIRECT_SHAPE },
      requestHeaders: { kind: 'list', item: { kind: 'object', shape: MODIFY_HEADER_INFO_SHAPE } },
      responseHeaders: { kind: 'list', item: { kind: 'object', shape: MODIFY_HEADER_INFO_SHAPE } }
    }
  }
}

export class RuleSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuleSchemaError'
  }
}

/** `base::Value` type names used by the generated `FromValue` code. */
function fileTypeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'list'
  switch (typeof value) {
    case 'boolean':
      return 'boolean'
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number'
    case 'string':
      return 'string'
    case 'object':
      return 'dictionary'
    default:
      return 'null'
  }
}

/** V8 type names used by the renderer bindings' `GetV8ValueTypeString`. */
function bindingTypeName(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  const type = typeof value
  if (type === 'bigint' || type === 'symbol') return 'object'
  return type
}

function expectedName(spec: FieldSpec, style: SchemaStyle): string {
  switch (spec.kind) {
    case 'integer':
      return 'integer'
    case 'string':
    case 'enum':
      return 'string'
    case 'boolean':
      return 'boolean'
    case 'list':
      return style === 'file' ? 'list' : 'array'
    case 'object':
      return style === 'file' ? 'dictionary' : 'object'
  }
}

function matchesKind(spec: FieldSpec, value: unknown): boolean {
  switch (spec.kind) {
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'string':
    case 'enum':
      return typeof value === 'string'
    case 'boolean':
      return typeof value === 'boolean'
    case 'list':
      return Array.isArray(value)
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
  }
}

function readFileValue(spec: FieldSpec, value: unknown, key: string): unknown {
  if (!matchesKind(spec, value)) {
    if (spec.kind === 'object' && key === '') {
      throw new RuleSchemaError(`expected dictionary, got ${fileTypeName(value)}`)
    }
    throw new RuleSchemaError(
      `'${key}': expected ${expectedName(spec, 'file')}, got ${fileTypeName(value)}`
    )
  }
  switch (spec.kind) {
    case 'enum':
      if (!spec.values.includes(value as string)) {
        const expected = spec.values.map((v) => `"${v}"`).join(' or ')
        throw new RuleSchemaError(`'${key}': expected ${expected}, got "${value as string}"`)
      }
      return value
    case 'list': {
      const out: unknown[] = []
      for (const item of value as unknown[]) {
        try {
          out.push(readFileValue(spec.item, item, key))
        } catch (error) {
          if (error instanceof RuleSchemaError) {
            throw new RuleSchemaError(`unable to populate array '${key}'`)
          }
          throw error
        }
      }
      return out
    }
    case 'object': {
      const source = value as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const [name, field] of Object.entries(spec.shape)) {
        if (Object.prototype.hasOwnProperty.call(source, name) && source[name] !== undefined) {
          out[name] = readFileValue(field, source[name], name)
        } else if (field.required) {
          throw new RuleSchemaError(`'${name}' is required`)
        }
      }
      return out
    }
    default:
      return value
  }
}

function readBindingValue(spec: FieldSpec, value: unknown): unknown {
  if (!matchesKind(spec, value)) {
    throw new RuleSchemaError(
      `Invalid type: expected ${expectedName(spec, 'binding')}, found ${bindingTypeName(value)}.`
    )
  }
  switch (spec.kind) {
    case 'enum':
      if (!spec.values.includes(value as string)) {
        throw new RuleSchemaError(`Value must be one of ${spec.values.join(', ')}.`)
      }
      return value
    case 'list': {
      const out: unknown[] = []
      const list = value as unknown[]
      for (let index = 0; index < list.length; index++) {
        try {
          out.push(readBindingValue(spec.item, list[index]))
        } catch (error) {
          if (error instanceof RuleSchemaError) {
            throw new RuleSchemaError(`Error at index ${index}: ${error.message}`)
          }
          throw error
        }
      }
      return out
    }
    case 'object': {
      const source = value as Record<string, unknown>
      const out: Record<string, unknown> = {}
      // The bindings keep the schema's properties in a std::map, so they are checked in
      // alphabetical order, before any unexpected property is reported.
      for (const name of Object.keys(spec.shape).sort()) {
        const field = spec.shape[name]!
        const item = source[name]
        if (item === undefined || item === null) {
          if (field.required) throw new RuleSchemaError(`Missing required property '${name}'.`)
          continue
        }
        try {
          out[name] = readBindingValue(field, item)
        } catch (error) {
          if (error instanceof RuleSchemaError) {
            throw new RuleSchemaError(`Error at property '${name}': ${error.message}`)
          }
          throw error
        }
      }
      for (const name of Object.keys(source)) {
        if (!(name in spec.shape)) throw new RuleSchemaError(`Unexpected property: '${name}'.`)
      }
      return out
    }
    default:
      return value
  }
}

/**
 * Check one JSON value against the `Rule` schema and return a copy holding only known keys.
 * Throws `RuleSchemaError` with Chrome's message for the given style.
 */
export function readRule(value: unknown, style: SchemaStyle = 'file'): Rule {
  const spec: FieldSpec = { kind: 'object', shape: RULE_SHAPE, required: true }
  const rule = style === 'file' ? readFileValue(spec, value, '') : readBindingValue(spec, value)
  return rule as Rule
}

// ---------------------------------------------------------------------------------------------
// Semantic layer (Chrome's `ParseResult`)

export type RuleParseCode =
  | 'ERROR_REQUEST_METHOD_DUPLICATED'
  | 'ERROR_RESOURCE_TYPE_DUPLICATED'
  | 'ERROR_INVALID_RULE_ID'
  | 'ERROR_INVALID_RULE_PRIORITY'
  | 'ERROR_NO_APPLICABLE_RESOURCE_TYPES'
  | 'ERROR_EMPTY_DOMAINS_LIST'
  | 'ERROR_EMPTY_INITIATOR_DOMAINS_LIST'
  | 'ERROR_EMPTY_REQUEST_DOMAINS_LIST'
  | 'ERROR_EMPTY_TOP_DOMAINS_LIST'
  | 'ERROR_DOMAINS_AND_INITIATOR_DOMAINS_BOTH_SPECIFIED'
  | 'ERROR_EXCLUDED_DOMAINS_AND_EXCLUDED_INITIATOR_DOMAINS_BOTH_SPECIFIED'
  | 'ERROR_EMPTY_RESOURCE_TYPES_LIST'
  | 'ERROR_EMPTY_REQUEST_METHODS_LIST'
  | 'ERROR_EMPTY_URL_FILTER'
  | 'ERROR_INVALID_REDIRECT_URL'
  | 'ERROR_DUPLICATE_IDS'
  | 'ERROR_NON_ASCII_URL_FILTER'
  | 'ERROR_NON_ASCII_DOMAIN'
  | 'ERROR_NON_ASCII_EXCLUDED_DOMAIN'
  | 'ERROR_NON_ASCII_INITIATOR_DOMAIN'
  | 'ERROR_NON_ASCII_EXCLUDED_INITIATOR_DOMAIN'
  | 'ERROR_NON_ASCII_REQUEST_DOMAIN'
  | 'ERROR_NON_ASCII_EXCLUDED_REQUEST_DOMAIN'
  | 'ERROR_NON_ASCII_TOP_DOMAIN'
  | 'ERROR_NON_ASCII_EXCLUDED_TOP_DOMAIN'
  | 'ERROR_INVALID_URL_FILTER'
  | 'ERROR_INVALID_REDIRECT'
  | 'ERROR_INVALID_EXTENSION_PATH'
  | 'ERROR_INVALID_TRANSFORM_SCHEME'
  | 'ERROR_INVALID_TRANSFORM_PORT'
  | 'ERROR_INVALID_TRANSFORM_QUERY'
  | 'ERROR_INVALID_TRANSFORM_FRAGMENT'
  | 'ERROR_QUERY_AND_TRANSFORM_BOTH_SPECIFIED'
  | 'ERROR_JAVASCRIPT_REDIRECT'
  | 'ERROR_EMPTY_REGEX_FILTER'
  | 'ERROR_NON_ASCII_REGEX_FILTER'
  | 'ERROR_INVALID_REGEX_FILTER'
  | 'ERROR_REGEX_TOO_LARGE'
  | 'ERROR_NO_HEADERS_TO_MODIFY_SPECIFIED'
  | 'ERROR_EMPTY_MODIFY_REQUEST_HEADERS_LIST'
  | 'ERROR_EMPTY_MODIFY_RESPONSE_HEADERS_LIST'
  | 'ERROR_INVALID_HEADER_TO_MODIFY_NAME'
  | 'ERROR_INVALID_HEADER_TO_MODIFY_VALUE'
  | 'ERROR_HEADER_VALUE_NOT_SPECIFIED'
  | 'ERROR_HEADER_VALUE_PRESENT'
  | 'ERROR_APPEND_INVALID_REQUEST_HEADER'
  | 'ERROR_MULTIPLE_FILTERS_SPECIFIED'
  | 'ERROR_REGEX_SUBSTITUTION_WITHOUT_FILTER'
  | 'ERROR_INVALID_REGEX_SUBSTITUTION'
  | 'ERROR_INVALID_ALLOW_ALL_REQUESTS_RESOURCE_TYPE'
  | 'ERROR_EMPTY_TAB_IDS_LIST'
  | 'ERROR_TAB_IDS_ON_NON_SESSION_RULE'
  | 'ERROR_TAB_ID_DUPLICATED'
  | 'ERROR_EMPTY_RESPONSE_HEADER_MATCHING_LIST'
  | 'ERROR_EMPTY_EXCLUDED_RESPONSE_HEADER_MATCHING_LIST'
  | 'ERROR_INVALID_MATCHING_RESPONSE_HEADER_NAME'
  | 'ERROR_INVALID_MATCHING_EXCLUDED_RESPONSE_HEADER_NAME'
  | 'ERROR_INVALID_MATCHING_RESPONSE_HEADER_VALUE'
  | 'ERROR_MATCHING_RESPONSE_HEADER_DUPLICATED'
  | 'ERROR_RESPONSE_HEADER_RULE_CANNOT_MODIFY_REQUEST_HEADERS'

/** `kAllowedTransformSchemes`. */
export const ALLOWED_TRANSFORM_SCHEMES = ['http', 'https', 'ftp', 'chrome-extension'] as const

/** `kDNRRequestHeaderAppendAllowList`: request headers an `append` operation may target. */
export const REQUEST_HEADER_APPEND_ALLOWLIST: ReadonlySet<string> = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'access-control-request-headers',
  'cache-control',
  'connection',
  'content-language',
  'cookie',
  'forwarded',
  'if-match',
  'if-none-match',
  'keep-alive',
  'range',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
  'want-digest',
  'x-forwarded-for'
])

const REGEX_TOO_LARGE_MESSAGE =
  'was skipped as the "regexFilter" value exceeded the 2KB memory limit when compiled. ' +
  'Learn more: https://developer.chrome.com/docs/extensions/reference/api/' +
  'declarativeNetRequest#regex-rules'

/** `GetParseError`: Chrome's message for a semantic error on the rule with the given id. */
export function formatParseError(code: RuleParseCode, ruleId: number): string {
  const p = `Rule with id ${ruleId}`
  const emptyList = (key: string): string =>
    `${p} cannot have an empty list as the value for ${key} key.`
  const emptyKey = (key: string): string => `${p} cannot have an empty value for ${key} key.`
  const nonAscii = (key: string): string =>
    `${p} cannot have non-ascii characters as part of "${key}" key.`
  const invalidKey = (key: string): string =>
    `${p} specifies an incorrect value for the "${key}" key.`
  const deprecated = (key: string, use: string): string =>
    `${p} cannot use deprecated field "${key}". Use "${use}" instead.`
  switch (code) {
    case 'ERROR_REQUEST_METHOD_DUPLICATED':
      return `${p} includes and excludes the same request method.`
    case 'ERROR_RESOURCE_TYPE_DUPLICATED':
      return `${p} includes and excludes the same resource.`
    case 'ERROR_INVALID_RULE_ID':
      return `${p} has an invalid value for id key. This should be greater than or equal to ${MIN_VALID_RULE_ID}.`
    case 'ERROR_INVALID_RULE_PRIORITY':
      return `${p} has an invalid value for priority key. This should be greater than or equal to ${MIN_VALID_PRIORITY}.`
    case 'ERROR_NO_APPLICABLE_RESOURCE_TYPES':
      return `${p} is not applicable to any resource type.`
    case 'ERROR_EMPTY_DOMAINS_LIST':
      return emptyList('domains')
    case 'ERROR_EMPTY_INITIATOR_DOMAINS_LIST':
      return emptyList('initiatorDomains')
    case 'ERROR_EMPTY_REQUEST_DOMAINS_LIST':
      return emptyList('requestDomains')
    case 'ERROR_EMPTY_TOP_DOMAINS_LIST':
      return emptyList('topDomains')
    case 'ERROR_DOMAINS_AND_INITIATOR_DOMAINS_BOTH_SPECIFIED':
      return deprecated('domains', 'initiatorDomains')
    case 'ERROR_EXCLUDED_DOMAINS_AND_EXCLUDED_INITIATOR_DOMAINS_BOTH_SPECIFIED':
      return deprecated('excludedDomains', 'excludedInitiatorDomains')
    case 'ERROR_EMPTY_RESOURCE_TYPES_LIST':
      return emptyList('resourceTypes')
    case 'ERROR_EMPTY_REQUEST_METHODS_LIST':
      return emptyList('requestMethods')
    case 'ERROR_EMPTY_URL_FILTER':
      return emptyKey('urlFilter')
    case 'ERROR_INVALID_REDIRECT_URL':
      return `${p} does not provide a valid URL for action.redirect.url key.`
    case 'ERROR_DUPLICATE_IDS':
      return `${p} does not have a unique ID.`
    case 'ERROR_NON_ASCII_URL_FILTER':
      return nonAscii('urlFilter')
    case 'ERROR_NON_ASCII_DOMAIN':
      return nonAscii('domains')
    case 'ERROR_NON_ASCII_EXCLUDED_DOMAIN':
      return nonAscii('excludedDomains')
    case 'ERROR_NON_ASCII_INITIATOR_DOMAIN':
      return nonAscii('initiatorDomains')
    case 'ERROR_NON_ASCII_EXCLUDED_INITIATOR_DOMAIN':
      return nonAscii('excludedInitiatorDomains')
    case 'ERROR_NON_ASCII_REQUEST_DOMAIN':
      return nonAscii('requestDomains')
    case 'ERROR_NON_ASCII_EXCLUDED_REQUEST_DOMAIN':
      return nonAscii('excludedRequestDomains')
    case 'ERROR_NON_ASCII_TOP_DOMAIN':
      return nonAscii('topDomains')
    case 'ERROR_NON_ASCII_EXCLUDED_TOP_DOMAIN':
      return nonAscii('excludedTopDomains')
    case 'ERROR_INVALID_URL_FILTER':
      return invalidKey('urlFilter')
    case 'ERROR_INVALID_REDIRECT':
      return invalidKey('action.redirect')
    case 'ERROR_INVALID_EXTENSION_PATH':
      return invalidKey('action.redirect.extensionPath')
    case 'ERROR_INVALID_TRANSFORM_SCHEME':
      return `${p} specifies an incorrect value for the "action.redirect.transform.scheme" key. Allowed values are: [${ALLOWED_TRANSFORM_SCHEMES.join(', ')}].`
    case 'ERROR_INVALID_TRANSFORM_PORT':
      return invalidKey('action.redirect.transform.port')
    case 'ERROR_INVALID_TRANSFORM_QUERY':
      return invalidKey('action.redirect.transform.query')
    case 'ERROR_INVALID_TRANSFORM_FRAGMENT':
      return invalidKey('action.redirect.transform.fragment')
    case 'ERROR_QUERY_AND_TRANSFORM_BOTH_SPECIFIED':
      return `${p} cannot specify both "action.redirect.transform.query" and "action.redirect.transform.queryTransform" keys.`
    case 'ERROR_JAVASCRIPT_REDIRECT':
      return `${p} specifies an incorrect value for the "action.redirect.url" key. Redirects to javascript urls are not supported.`
    case 'ERROR_EMPTY_REGEX_FILTER':
      return emptyKey('regexFilter')
    case 'ERROR_NON_ASCII_REGEX_FILTER':
      return nonAscii('regexFilter')
    case 'ERROR_INVALID_REGEX_FILTER':
      return invalidKey('regexFilter')
    case 'ERROR_REGEX_TOO_LARGE':
      return `${p} ${REGEX_TOO_LARGE_MESSAGE}`
    case 'ERROR_NO_HEADERS_TO_MODIFY_SPECIFIED':
      return `${p} does not specify a value for "action.requestHeaders" or "action.responseHeaders" key. At least one of these keys must be specified with a non-empty list.`
    case 'ERROR_EMPTY_MODIFY_REQUEST_HEADERS_LIST':
      return emptyList('action.requestHeaders')
    case 'ERROR_EMPTY_MODIFY_RESPONSE_HEADERS_LIST':
      return emptyList('action.responseHeaders')
    case 'ERROR_INVALID_HEADER_TO_MODIFY_NAME':
      return `${p} must specify a valid header name to be modified.`
    case 'ERROR_INVALID_HEADER_TO_MODIFY_VALUE':
      return `${p} must provide a valid header value to be appended/set.`
    case 'ERROR_HEADER_VALUE_NOT_SPECIFIED':
      return `${p} must provide a value for a header to be appended/set.`
    case 'ERROR_HEADER_VALUE_PRESENT':
      return `${p} must not provide a header value for a header to be removed.`
    case 'ERROR_APPEND_INVALID_REQUEST_HEADER':
      return `${p} specifies an invalid request header to be appended. Only standard HTTP request headers that can specify multiple values for a single entry are supported.`
    case 'ERROR_MULTIPLE_FILTERS_SPECIFIED':
      return `${p} can only specify one of "urlFilter" or "regexFilter" keys.`
    case 'ERROR_REGEX_SUBSTITUTION_WITHOUT_FILTER':
      return `${p} can't specify the "regexSubstitution" key without specifying the "regexFilter" key.`
    case 'ERROR_INVALID_REGEX_SUBSTITUTION':
      return invalidKey('action.redirect.regexSubstitution')
    case 'ERROR_INVALID_ALLOW_ALL_REQUESTS_RESOURCE_TYPE':
      return `${p} is an "allowAllRequests" rule and must specify the "resourceTypes" key. It may only include the "main_frame" and "sub_frame" resource types.`
    case 'ERROR_EMPTY_TAB_IDS_LIST':
      return emptyList('tabIds')
    case 'ERROR_TAB_IDS_ON_NON_SESSION_RULE':
      return `${p} specifies a value for "tabIds" or "excludedTabIds" key. These are only supported for session-scoped rules.`
    case 'ERROR_TAB_ID_DUPLICATED':
      return `${p} includes and excludes the same tab ID.`
    case 'ERROR_EMPTY_RESPONSE_HEADER_MATCHING_LIST':
      return emptyList('condition.responseHeaders')
    case 'ERROR_EMPTY_EXCLUDED_RESPONSE_HEADER_MATCHING_LIST':
      return emptyList('condition.excludedResponseHeaders')
    case 'ERROR_INVALID_MATCHING_RESPONSE_HEADER_NAME':
      return `${p} must specify a valid header name for "condition.responseHeaders" key`
    case 'ERROR_INVALID_MATCHING_EXCLUDED_RESPONSE_HEADER_NAME':
      return `${p} must specify a valid header name for "condition.excludedResponseHeaders" key`
    case 'ERROR_INVALID_MATCHING_RESPONSE_HEADER_VALUE':
      return `${p} must specify a valid header value for "condition.responseHeaders" key`
    case 'ERROR_MATCHING_RESPONSE_HEADER_DUPLICATED':
      return `${p} includes and excludes the same response header.`
    case 'ERROR_RESPONSE_HEADER_RULE_CANNOT_MODIFY_REQUEST_HEADERS':
      return `${p} which matches on response headers cannot modify request headers.`
  }
}

export class RuleParseError extends Error {
  constructor(
    readonly code: RuleParseCode,
    readonly ruleId: number
  ) {
    super(formatParseError(code, ruleId))
    this.name = 'RuleParseError'
  }
}

export type UrlPatternType = 'substring' | 'wildcarded' | 'regexp'
export type AnchorType = 'none' | 'boundary' | 'subdomain'

/**
 * The normalised form Chrome indexes (`IndexedRule`): what the matcher and the translator work
 * from. Domains are lower-cased, case-insensitive `urlFilter`s are lower-cased, the resource type
 * and request method conditions are resolved to bitmasks and the redirect target is resolved.
 */
export interface CompiledRule {
  id: number
  /** Effective rule priority (`priority` or 1). */
  priority: number
  /** `(priority << 8) | actionTypePriority`: Chrome compares rules on this. */
  indexPriority: number
  actionType: RuleActionType
  isCaseSensitive: boolean
  urlPatternType: UrlPatternType
  /** Lower-cased unless case sensitive; for regexp rules the original pattern. */
  urlPattern: string
  anchorLeft: AnchorType
  anchorRight: AnchorType
  elementTypes: number
  requestMethods: number
  domainType?: DomainType
  initiatorDomains: string[]
  excludedInitiatorDomains: string[]
  requestDomains: string[]
  excludedRequestDomains: string[]
  topDomains: string[]
  excludedTopDomains: string[]
  tabIds: ReadonlySet<number>
  excludedTabIds: ReadonlySet<number>
  responseHeaders: HeaderInfo[]
  excludedResponseHeaders: HeaderInfo[]
  /** Absolute redirect target for `redirect.url` and `redirect.extensionPath`. */
  redirectUrl?: string
  urlTransform?: URLTransform
  regexSubstitution?: string
  requestHeadersToModify: ModifyHeaderInfo[]
  responseHeadersToModify: ModifyHeaderInfo[]
  /** Capture groups the regex defines, for `regexSubstitution`. */
  regexCaptureCount: number
  /** The rule as written, for `getDynamicRules` and the engine's DNR-shaped rule sets. */
  rule: Rule
}

export interface CompileRuleOptions {
  source: RulesetSource
  /**
   * Origin `redirect.extensionPath` resolves against, for example `chrome-extension://<id>/`.
   * Defaults to a placeholder origin so parsing does not depend on the host.
   */
  extensionBaseUrl?: string
}

export type CompileRuleResult =
  { ok: true; compiled: CompiledRule } | { ok: false; code: RuleParseCode; message: string }

/** `GetActionTypePriority`: among rules of equal `priority` this decides. */
export function actionTypePriority(type: RuleActionType): number {
  switch (type) {
    case 'allow':
      return 5
    case 'allowAllRequests':
      return 4
    case 'block':
      return 3
    case 'upgradeScheme':
      return 2
    case 'redirect':
      return 1
    case 'modifyHeaders':
      return 0
  }
}

/** `ComputeIndexedRulePriority`: `(priority << 8) | actionTypePriority` without 32-bit overflow. */
export function indexedRulePriority(priority: number, type: RuleActionType): number {
  return priority * 256 + actionTypePriority(type)
}

// eslint-disable-next-line no-control-regex
const ASCII = /^[\x00-\x7f]*$/

function isAscii(text: string): boolean {
  return ASCII.test(text)
}

/** `net::HttpUtil::IsValidHeaderName`: a non-empty RFC 7230 token. */
export function isValidHeaderName(name: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
}

/** `net::HttpUtil::IsValidHeaderValue`: anything without NUL, CR or LF. */
export function isValidHeaderValue(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[\x00\r\n]/.test(value)
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

function urlScheme(url: string): string | undefined {
  try {
    return new URL(url).protocol.slice(0, -1)
  } catch {
    return undefined
  }
}

const PLACEHOLDER_EXTENSION_BASE_URL = 'chrome-extension://extension/'

class Compiler {
  private readonly out: Partial<CompiledRule> & Pick<CompiledRule, 'id'>

  constructor(
    private readonly rule: Rule,
    private readonly options: CompileRuleOptions
  ) {
    this.out = { id: rule.id }
  }

  private fail(code: RuleParseCode): never {
    throw new RuleParseError(code, this.rule.id)
  }

  compile(): CompiledRule {
    const rule = this.rule
    const condition = rule.condition
    const action = rule.action

    if (rule.id < MIN_VALID_RULE_ID) this.fail('ERROR_INVALID_RULE_ID')
    const priority = rule.priority ?? DEFAULT_PRIORITY
    if (priority < MIN_VALID_PRIORITY) this.fail('ERROR_INVALID_RULE_PRIORITY')

    if (action.type === 'redirect') {
      if (!action.redirect) this.fail('ERROR_INVALID_REDIRECT')
      this.parseRedirect(action.redirect)
    }

    if (condition.domains?.length === 0) this.fail('ERROR_EMPTY_DOMAINS_LIST')
    if (condition.initiatorDomains?.length === 0) this.fail('ERROR_EMPTY_INITIATOR_DOMAINS_LIST')
    if (condition.requestDomains?.length === 0) this.fail('ERROR_EMPTY_REQUEST_DOMAINS_LIST')
    if (condition.topDomains?.length === 0) this.fail('ERROR_EMPTY_TOP_DOMAINS_LIST')
    if (condition.resourceTypes?.length === 0) this.fail('ERROR_EMPTY_RESOURCE_TYPES_LIST')
    if (condition.requestMethods?.length === 0) this.fail('ERROR_EMPTY_REQUEST_METHODS_LIST')
    if (condition.tabIds?.length === 0) this.fail('ERROR_EMPTY_TAB_IDS_LIST')

    if (this.options.source !== 'session' && (condition.tabIds || condition.excludedTabIds)) {
      this.fail('ERROR_TAB_IDS_ON_NON_SESSION_RULE')
    }

    if (condition.urlFilter !== undefined && condition.regexFilter !== undefined) {
      this.fail('ERROR_MULTIPLE_FILTERS_SPECIFIED')
    }

    const isCaseSensitive = condition.isUrlFilterCaseSensitive ?? false
    this.out.regexCaptureCount = this.validateRegex(
      isCaseSensitive,
      condition.regexFilter,
      this.out.regexSubstitution
    )

    if (condition.urlFilter !== undefined) {
      if (condition.urlFilter === '') this.fail('ERROR_EMPTY_URL_FILTER')
      if (!isAscii(condition.urlFilter)) this.fail('ERROR_NON_ASCII_URL_FILTER')
    }

    this.out.actionType = action.type
    this.out.priority = priority
    this.out.indexPriority = indexedRulePriority(priority, action.type)
    this.out.isCaseSensitive = isCaseSensitive
    this.out.domainType = condition.domainType

    this.out.requestMethods = this.computeRequestMethods()
    this.out.elementTypes = this.computeElementTypes()

    if (condition.domains && condition.initiatorDomains) {
      this.fail('ERROR_DOMAINS_AND_INITIATOR_DOMAINS_BOTH_SPECIFIED')
    }
    if (condition.excludedDomains && condition.excludedInitiatorDomains) {
      this.fail('ERROR_EXCLUDED_DOMAINS_AND_EXCLUDED_INITIATOR_DOMAINS_BOTH_SPECIFIED')
    }

    this.out.initiatorDomains = []
    this.out.excludedInitiatorDomains = []
    if (condition.domains) {
      this.out.initiatorDomains = this.canonicalizeDomains(
        condition.domains,
        'ERROR_NON_ASCII_DOMAIN'
      )
    }
    if (condition.initiatorDomains) {
      this.out.initiatorDomains = this.canonicalizeDomains(
        condition.initiatorDomains,
        'ERROR_NON_ASCII_INITIATOR_DOMAIN'
      )
    }
    if (condition.excludedDomains) {
      this.out.excludedInitiatorDomains = this.canonicalizeDomains(
        condition.excludedDomains,
        'ERROR_NON_ASCII_EXCLUDED_DOMAIN'
      )
    }
    if (condition.excludedInitiatorDomains) {
      this.out.excludedInitiatorDomains = this.canonicalizeDomains(
        condition.excludedInitiatorDomains,
        'ERROR_NON_ASCII_EXCLUDED_INITIATOR_DOMAIN'
      )
    }
    this.out.requestDomains = this.canonicalizeDomains(
      condition.requestDomains ?? [],
      'ERROR_NON_ASCII_REQUEST_DOMAIN'
    )
    this.out.excludedRequestDomains = this.canonicalizeDomains(
      condition.excludedRequestDomains ?? [],
      'ERROR_NON_ASCII_EXCLUDED_REQUEST_DOMAIN'
    )
    this.out.topDomains = this.canonicalizeDomains(
      condition.topDomains ?? [],
      'ERROR_NON_ASCII_TOP_DOMAIN'
    )
    this.out.excludedTopDomains = this.canonicalizeDomains(
      condition.excludedTopDomains ?? [],
      'ERROR_NON_ASCII_EXCLUDED_TOP_DOMAIN'
    )

    const tabIds = new Set(condition.tabIds ?? [])
    let excludedTabIds = new Set(condition.excludedTabIds ?? [])
    for (const id of tabIds) if (excludedTabIds.has(id)) this.fail('ERROR_TAB_ID_DUPLICATED')
    if (tabIds.size > 0 && excludedTabIds.size > 0) excludedTabIds = new Set()
    this.out.tabIds = tabIds
    this.out.excludedTabIds = excludedTabIds

    this.out.responseHeaders = []
    this.out.excludedResponseHeaders = []
    if (condition.responseHeaders) {
      if (condition.responseHeaders.length === 0) {
        this.fail('ERROR_EMPTY_RESPONSE_HEADER_MATCHING_LIST')
      }
      this.out.responseHeaders = condition.responseHeaders
    }
    if (condition.excludedResponseHeaders) {
      if (condition.excludedResponseHeaders.length === 0) {
        this.fail('ERROR_EMPTY_EXCLUDED_RESPONSE_HEADER_MATCHING_LIST')
      }
      this.out.excludedResponseHeaders = condition.excludedResponseHeaders
    }
    this.validateResponseHeadersForMatching()

    if (condition.regexFilter !== undefined) {
      this.out.urlPatternType = 'regexp'
      this.out.urlPattern = condition.regexFilter
      this.out.anchorLeft = 'none'
      this.out.anchorRight = 'none'
    } else {
      this.parseUrlFilter(condition.urlFilter ?? '')
    }

    // url_pattern_index cannot index a domain anchor followed by a wildcard ("||*xyz").
    if (this.out.anchorLeft === 'subdomain' && this.out.urlPattern!.startsWith('*')) {
      this.fail('ERROR_INVALID_URL_FILTER')
    }

    if (!isCaseSensitive && this.out.urlPatternType !== 'regexp') {
      this.out.urlPattern = this.out.urlPattern!.toLowerCase()
    }

    this.out.requestHeadersToModify = []
    this.out.responseHeadersToModify = []
    if (action.type === 'modifyHeaders') {
      if (!action.requestHeaders && !action.responseHeaders) {
        this.fail('ERROR_NO_HEADERS_TO_MODIFY_SPECIFIED')
      }
      if (action.requestHeaders) {
        if (this.out.responseHeaders.length > 0 || this.out.excludedResponseHeaders.length > 0) {
          this.fail('ERROR_RESPONSE_HEADER_RULE_CANNOT_MODIFY_REQUEST_HEADERS')
        }
        this.out.requestHeadersToModify = action.requestHeaders.map(populateRegexOptions)
        this.validateHeadersForModification(this.out.requestHeadersToModify, true)
      }
      if (action.responseHeaders) {
        this.out.responseHeadersToModify = action.responseHeaders.map(populateRegexOptions)
        this.validateHeadersForModification(this.out.responseHeadersToModify, false)
      }
    }

    this.out.rule = rule
    return this.out as CompiledRule
  }

  private parseRedirect(redirect: Redirect): void {
    if (redirect.url !== undefined) {
      if (!isValidUrl(redirect.url)) this.fail('ERROR_INVALID_REDIRECT_URL')
      if (urlScheme(redirect.url) === 'javascript') this.fail('ERROR_JAVASCRIPT_REDIRECT')
      this.out.redirectUrl = redirect.url
      return
    }
    if (redirect.extensionPath !== undefined) {
      if (!redirect.extensionPath.startsWith('/')) this.fail('ERROR_INVALID_EXTENSION_PATH')
      const base = this.options.extensionBaseUrl ?? PLACEHOLDER_EXTENSION_BASE_URL
      try {
        this.out.redirectUrl = new URL(redirect.extensionPath, base).href
      } catch {
        this.fail('ERROR_INVALID_EXTENSION_PATH')
      }
      return
    }
    if (redirect.transform !== undefined) {
      this.out.urlTransform = redirect.transform
      this.validateTransform(redirect.transform)
      return
    }
    if (redirect.regexSubstitution !== undefined) {
      if (redirect.regexSubstitution === '') this.fail('ERROR_INVALID_REGEX_SUBSTITUTION')
      this.out.regexSubstitution = redirect.regexSubstitution
      return
    }
    this.fail('ERROR_INVALID_REDIRECT')
  }

  private validateTransform(transform: URLTransform): void {
    if (
      transform.scheme !== undefined &&
      !(ALLOWED_TRANSFORM_SCHEMES as readonly string[]).includes(transform.scheme)
    ) {
      this.fail('ERROR_INVALID_TRANSFORM_SCHEME')
    }
    if (transform.port !== undefined && transform.port !== '') {
      if (!/^\d+$/.test(transform.port) || Number(transform.port) > 65535) {
        this.fail('ERROR_INVALID_TRANSFORM_PORT')
      }
    }
    if (transform.query && !transform.query.startsWith('?')) {
      this.fail('ERROR_INVALID_TRANSFORM_QUERY')
    }
    if (transform.fragment && !transform.fragment.startsWith('#')) {
      this.fail('ERROR_INVALID_TRANSFORM_FRAGMENT')
    }
    if (transform.query !== undefined && transform.queryTransform !== undefined) {
      this.fail('ERROR_QUERY_AND_TRANSFORM_BOTH_SPECIFIED')
    }
  }

  /** `ValidateRegex`; returns the capture count of a valid filter (0 without one). */
  private validateRegex(
    isCaseSensitive: boolean,
    regexFilter: string | undefined,
    regexSubstitution: string | undefined
  ): number {
    if (regexFilter === undefined) {
      if (regexSubstitution !== undefined) this.fail('ERROR_REGEX_SUBSTITUTION_WITHOUT_FILTER')
      return 0
    }
    if (regexFilter === '') this.fail('ERROR_EMPTY_REGEX_FILTER')
    if (!isAscii(regexFilter)) this.fail('ERROR_NON_ASCII_REGEX_FILTER')
    const requireCapturing = regexSubstitution !== undefined
    const result = checkRegex(regexFilter, { isCaseSensitive, requireCapturing })
    if (!result.isSupported) {
      this.fail(
        result.reason === 'memoryLimitExceeded'
          ? 'ERROR_REGEX_TOO_LARGE'
          : 'ERROR_INVALID_REGEX_FILTER'
      )
    }
    if (
      regexSubstitution !== undefined &&
      !checkRegexSubstitution(regexSubstitution, result.captureCount)
    ) {
      this.fail('ERROR_INVALID_REGEX_SUBSTITUTION')
    }
    return result.captureCount
  }

  private computeRequestMethods(): number {
    const include = methodsMask(this.rule.condition.requestMethods)
    const exclude = methodsMask(this.rule.condition.excludedRequestMethods)
    if (include & exclude) this.fail('ERROR_REQUEST_METHOD_DUPLICATED')
    if (include !== 0) return include
    if (exclude !== 0) return REQUEST_METHODS_ANY & ~exclude
    return REQUEST_METHODS_ANY
  }

  private computeElementTypes(): number {
    const include = elementTypesMask(this.rule.condition.resourceTypes)
    const exclude = elementTypesMask(this.rule.condition.excludedResourceTypes)
    if (exclude === ELEMENT_TYPES_ANY) this.fail('ERROR_NO_APPLICABLE_RESOURCE_TYPES')
    if (include & exclude) this.fail('ERROR_RESOURCE_TYPE_DUPLICATED')
    if (this.rule.action.type === 'allowAllRequests') {
      const frames = ELEMENT_TYPE_BIT.main_frame | ELEMENT_TYPE_BIT.sub_frame
      if (include === 0 || (frames | include) !== frames) {
        this.fail('ERROR_INVALID_ALLOW_ALL_REQUESTS_RESOURCE_TYPE')
      }
    }
    if (include !== 0) return include
    if (exclude !== 0) return ELEMENT_TYPES_ANY & ~exclude
    return ELEMENT_TYPES_DEFAULT
  }

  private canonicalizeDomains(domains: readonly string[], code: RuleParseCode): string[] {
    const out: string[] = []
    for (const domain of domains) {
      if (!isAscii(domain)) this.fail(code)
      out.push(domain.toLowerCase())
    }
    return out
  }

  private validateResponseHeadersForMatching(): void {
    const names = new Set<string>()
    for (const info of this.out.responseHeaders!) {
      if (!isValidHeaderName(info.header)) this.fail('ERROR_INVALID_MATCHING_RESPONSE_HEADER_NAME')
      this.validateMatchingHeaderValues(info)
      names.add(info.header)
    }
    for (const info of this.out.excludedResponseHeaders!) {
      if (!isValidHeaderName(info.header)) {
        this.fail('ERROR_INVALID_MATCHING_EXCLUDED_RESPONSE_HEADER_NAME')
      }
      this.validateMatchingHeaderValues(info)
      if (
        info.values === undefined &&
        info.excludedValues === undefined &&
        names.has(info.header)
      ) {
        this.fail('ERROR_MATCHING_RESPONSE_HEADER_DUPLICATED')
      }
    }
  }

  private validateMatchingHeaderValues(info: HeaderInfo): void {
    const valid = (values: string[] | undefined): boolean =>
      values === undefined || values.every(isValidHeaderValue)
    if (!valid(info.values) || !valid(info.excludedValues)) {
      this.fail('ERROR_INVALID_MATCHING_RESPONSE_HEADER_VALUE')
    }
  }

  private validateHeadersForModification(
    headers: ModifyHeaderInfo[],
    areRequestHeaders: boolean
  ): void {
    if (headers.length === 0) {
      this.fail(
        areRequestHeaders
          ? 'ERROR_EMPTY_MODIFY_REQUEST_HEADERS_LIST'
          : 'ERROR_EMPTY_MODIFY_RESPONSE_HEADERS_LIST'
      )
    }
    for (const info of headers) {
      if (!isValidHeaderName(info.header)) this.fail('ERROR_INVALID_HEADER_TO_MODIFY_NAME')
      if (
        areRequestHeaders &&
        info.operation === 'append' &&
        !REQUEST_HEADER_APPEND_ALLOWLIST.has(info.header.toLowerCase())
      ) {
        this.fail('ERROR_APPEND_INVALID_REQUEST_HEADER')
      }
      if (info.value !== undefined) {
        if (!isValidHeaderValue(info.value)) this.fail('ERROR_INVALID_HEADER_TO_MODIFY_VALUE')
        if (info.operation === 'remove') this.fail('ERROR_HEADER_VALUE_PRESENT')
      } else if (info.operation === 'append' || info.operation === 'set') {
        this.fail('ERROR_HEADER_VALUE_NOT_SPECIFIED')
      }
      this.validateRegex(false, info.regexFilter, info.regexSubstitution)
    }
  }

  /** `UrlFilterParser`: `|`/`||` left anchors, the pattern, and a trailing `|` right anchor. */
  private parseUrlFilter(filter: string): void {
    let index = 0
    let anchorLeft: AnchorType = 'none'
    if (filter[index] === '|') {
      index++
      anchorLeft = 'boundary'
      if (filter[index] === '|') {
        index++
        anchorLeft = 'subdomain'
      }
    }
    const isAtRightAnchor = (): boolean =>
      filter[index] === '|' && index > 0 && index + 1 === filter.length
    let type: UrlPatternType = 'substring'
    const start = index
    while (index < filter.length && !isAtRightAnchor()) {
      const c = filter[index]
      if (c === '^' || c === '*') type = 'wildcarded'
      index++
    }
    const pattern = filter.slice(start, index)
    let anchorRight: AnchorType = 'none'
    if (isAtRightAnchor()) anchorRight = 'boundary'
    this.out.urlPatternType = type
    this.out.urlPattern = pattern
    this.out.anchorLeft = anchorLeft
    this.out.anchorRight = anchorRight
  }
}

function populateRegexOptions(info: ModifyHeaderInfo): ModifyHeaderInfo {
  if (!info.regexOptions) return info
  return { ...info, regexOptions: { matchAll: info.regexOptions.matchAll ?? false } }
}

function methodsMask(methods: readonly RequestMethod[] | undefined): number {
  let mask = 0
  for (const method of methods ?? []) mask |= REQUEST_METHOD_BIT[method]
  return mask
}

function elementTypesMask(types: readonly ResourceType[] | undefined): number {
  let mask = 0
  for (const type of types ?? []) mask |= ELEMENT_TYPE_BIT[type]
  return mask
}

/**
 * `IndexedRule::CreateIndexedRule`: run Chrome's semantic checks in Chrome's order on a rule that
 * already passed the schema, and produce the normalised form.
 */
export function compileRule(rule: Rule, options: CompileRuleOptions): CompileRuleResult {
  try {
    return { ok: true, compiled: new Compiler(rule, options).compile() }
  } catch (error) {
    if (error instanceof RuleParseError) {
      return { ok: false, code: error.code, message: error.message }
    }
    throw error
  }
}

// ---------------------------------------------------------------------------------------------
// Rulesets

export interface RuleParseIssue {
  /** Missing when the issue is not about one rule (bad JSON, ruleset too large). */
  ruleId?: number
  message: string
  /**
   * `'warning'`: Chrome skips the rule and records an install warning. `'error'`: Chrome rejects
   * the update (dynamic, session) or fails the install (static, at install time).
   */
  severity: 'warning' | 'error'
  code?: RuleParseCode | 'SCHEMA' | 'RULE_COUNT_EXCEEDED' | 'REGEX_RULE_COUNT_EXCEEDED'
}

export interface ParseRulesetOptions extends CompileRuleOptions {
  /** Manifest ruleset id, used in the ruleset-level messages of static rulesets. */
  rulesetId?: string
  /**
   * How many rules the ruleset may hold before Chrome truncates (static) or rejects (dynamic,
   * session). Defaults to Chrome's indexing limit for static rulesets; dynamic and session limits
   * are enforced by the state machine, which knows the existing rules.
   */
  ruleLimit?: number
}

export interface ParseRulesetResult {
  /** The rules Chrome would index, in file order. Empty when `rejected`. */
  rules: Rule[]
  compiled: CompiledRule[]
  /** One entry per skipped rule (static) or the single rejecting error (dynamic, session). */
  errors: RuleParseIssue[]
  /** True when Chrome would not index anything from this input. */
  rejected: boolean
  regexRuleCount: number
}

export const RULES_FILE_NOT_A_LIST = 'Rules file must contain a list.'
export const RULE_COUNT_EXCEEDED_WARNING = 'Rule count exceeded. Some rules were ignored.'
export const REGEX_RULE_COUNT_EXCEEDED_WARNING =
  'Regular expression rule count exceeded. Some rules were ignored.'

function indexingLimitExceeded(rulesetId: string | undefined): string {
  return `Ruleset with id ${rulesetId ?? '?'} exceeds the indexing rule limit and will be ignored.`
}

function ruleLocation(value: unknown, index: number): string {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const id = (value as { id?: unknown }).id
    if (typeof id === 'number' && Number.isInteger(id)) return `id ${id}`
  }
  return `index ${index + 1}`
}

/**
 * Parse a rules file (static) or an `addRules` list (dynamic, session) the way Chrome does.
 *
 * Static rulesets: JSON that is not a list, or more rules than the indexing limit, reject the
 * whole ruleset; a rule that fails the schema, exceeds the regex rule budget, or exceeds the 2 KB
 * regex memory limit is skipped with a warning; a rule with a duplicate id or a semantic error is
 * skipped and reported with `severity: 'error'` (Chrome would have failed the install).
 *
 * Dynamic and session rules: the first schema or semantic error rejects the whole list, with
 * Chrome's message. Rule count and unsafe/regex quotas are the state machine's job.
 */
export function parseRuleset(
  json: string | unknown,
  options: ParseRulesetOptions
): ParseRulesetResult {
  const reject = (
    message: string,
    ruleId?: number,
    code?: RuleParseIssue['code']
  ): ParseRulesetResult => ({
    rules: [],
    compiled: [],
    errors: [{ ruleId, message, severity: 'error', code }],
    rejected: true,
    regexRuleCount: 0
  })

  let value: unknown = json
  if (typeof json === 'string') {
    try {
      value = JSON.parse(json)
    } catch (error) {
      return reject(error instanceof Error ? error.message : String(error))
    }
  }
  if (!Array.isArray(value)) return reject(RULES_FILE_NOT_A_LIST)

  const isStatic = options.source === 'static'
  const style: SchemaStyle = isStatic ? 'file' : 'binding'
  const ruleLimit = options.ruleLimit ?? (isStatic ? MAX_RULES_PER_STATIC_RULESET : Infinity)
  if (isStatic && value.length > ruleLimit) {
    return reject(indexingLimitExceeded(options.rulesetId))
  }

  const errors: RuleParseIssue[] = []
  const wellFormed: Rule[] = []
  let regexRuleCount = 0
  let regexBudgetExceeded = false
  for (let index = 0; index < value.length; index++) {
    let rule: Rule
    try {
      rule = readRule(value[index], style)
    } catch (error) {
      if (!(error instanceof RuleSchemaError)) throw error
      if (!isStatic) return reject(`Error at index ${index}: ${error.message}`, undefined, 'SCHEMA')
      errors.push({
        message: `Rule with ${ruleLocation(value[index], index)} couldn't be parsed. Parse error: ${error.message}.`,
        severity: 'warning',
        code: 'SCHEMA'
      })
      continue
    }
    if (wellFormed.length === ruleLimit) {
      errors.push({
        message: RULE_COUNT_EXCEEDED_WARNING,
        severity: 'warning',
        code: 'RULE_COUNT_EXCEEDED'
      })
      break
    }
    if (isStatic && rule.condition.regexFilter !== undefined) {
      if (++regexRuleCount > MAX_NUMBER_OF_REGEX_RULES) {
        if (!regexBudgetExceeded) {
          regexBudgetExceeded = true
          errors.push({
            message: REGEX_RULE_COUNT_EXCEEDED_WARNING,
            severity: 'warning',
            code: 'REGEX_RULE_COUNT_EXCEEDED'
          })
        }
        continue
      }
    }
    wellFormed.push(rule)
  }

  // IndexRules: unique ids, then CreateIndexedRule on each.
  const rules: Rule[] = []
  const compiled: CompiledRule[] = []
  const ids = new Set<number>()
  let indexedRegexRules = 0
  for (const rule of wellFormed) {
    if (ids.has(rule.id)) {
      const message = formatParseError('ERROR_DUPLICATE_IDS', rule.id)
      if (!isStatic) return reject(message, rule.id, 'ERROR_DUPLICATE_IDS')
      errors.push({ ruleId: rule.id, message, severity: 'error', code: 'ERROR_DUPLICATE_IDS' })
      continue
    }
    ids.add(rule.id)
    const result = compileRule(rule, options)
    if (!result.ok) {
      // New dynamic rules whose regex is too large are errors too (file_sequence_helper.cc), and
      // session rules use kRaiseErrorOnLargeRegexRules.
      if (!isStatic) return reject(result.message, rule.id, result.code)
      const severity = result.code === 'ERROR_REGEX_TOO_LARGE' ? 'warning' : 'error'
      errors.push({ ruleId: rule.id, message: result.message, severity, code: result.code })
      continue
    }
    rules.push(rule)
    compiled.push(result.compiled)
    if (result.compiled.urlPatternType === 'regexp') indexedRegexRules++
  }

  return { rules, compiled, errors, rejected: false, regexRuleCount: indexedRegexRules }
}
