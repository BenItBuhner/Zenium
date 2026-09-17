/**
 * Reference matcher for declarativeNetRequest rules: `testMatchOutcome`, tests, and a spec for
 * the blocking engine. It reproduces the matching semantics of Chromium's url_pattern_index and
 * declarativeNetRequest matchers (checked against `main` on 2026-09-17):
 *
 * - `components/url_pattern_index/url_pattern.cc` (`urlFilter` matching: anchors, wildcards, the
 *   `^` separator placeholder, case handling)
 * - `components/url_pattern_index/fuzzy_pattern_matching.h` (`IsSeparator`)
 * - `components/url_pattern_index/url_pattern_index.cc` (`DoesHostMatchDomainLists`: the longest
 *   matching domain decides between the included and excluded lists)
 * - `extensions/browser/api/declarative_net_request/request_params.cc` (request method mapping,
 *   third-party computation, tab ids, top-level domains, response header conditions)
 * - `extensions/browser/api/declarative_net_request/composite_matcher.cc` and
 *   `declarative_net_request_api.cc` (`testMatchOutcome`): how the winning action and the
 *   modifyHeaders actions are selected across an extension's rulesets
 *
 * Approximations, by design (the engine does the real matching): first versus third party uses a
 * registrable-domain heuristic instead of the Public Suffix List, `allowAllRequests` is only
 * matched against the frame request itself because a stateless matcher has no frame tree, and a
 * redirect rule whose target cannot be computed (or equals the request URL) is treated as not
 * matching instead of silencing the rest of its index the way Chrome's per-index lookup does.
 *
 * `toEngineRequest` / `fromEngineRequest` convert between `testMatchOutcome`'s request and the
 * engine's `RequestContext`, and `decisionOf` expresses an outcome as the engine's `Decision`,
 * so the same request can be put to both and the answers compared.
 */
import {
  REQUEST_METHOD_NON_HTTP,
  elementTypeBit,
  requestMethodBit,
  compileRule,
  type AnchorType,
  type CompiledRule,
  type HeaderInfo,
  type QueryTransform,
  type RequestMethod,
  type ResourceType,
  type RulesetSource,
  type URLTransform
} from './rules'
import { toJavaScriptRegExp } from './regex'
import { DYNAMIC_RULESET_ID, SESSION_RULESET_ID } from './limits'
import {
  engineSetId,
  type EngineDecision,
  type EngineHeaderOp,
  type EngineRequestContext,
  type EngineSetKind
} from './sink'

export interface MatchRequest {
  url: string
  /** Origin (or URL) of the document making the request; absent for browser-initiated ones. */
  initiator?: string
  /** Defaults to `get`, like `testMatchOutcome`. */
  method?: RequestMethod | string
  type: ResourceType
  /** Defaults to -1 (no tab). */
  tabId?: number
  /** URL of the top-level frame, for `topDomains`; Chrome falls back to the initiator. */
  topUrl?: string
  /** Response headers, which enable the headers-received stage (`responseHeaders` conditions). */
  responseHeaders?: Record<string, string[]>
}

/** The engine's view of a `testMatchOutcome` request. */
export function toEngineRequest(request: MatchRequest): EngineRequestContext {
  const out: EngineRequestContext = {
    url: request.url,
    type: request.type,
    method: (request.method ?? 'get').toUpperCase()
  }
  if (request.initiator !== undefined) out.initiator = request.initiator
  if (request.topUrl !== undefined) out.documentUrl = request.topUrl
  if (request.tabId !== undefined && request.tabId >= 0) out.tabId = String(request.tabId)
  return out
}

/** A request the engine saw, as the reference matcher evaluates it. */
export function fromEngineRequest(ctx: EngineRequestContext): MatchRequest {
  const out: MatchRequest = { url: ctx.url, type: ctx.type, method: ctx.method.toLowerCase() }
  if (ctx.initiator !== undefined) out.initiator = ctx.initiator
  if (ctx.documentUrl !== undefined) out.topUrl = ctx.documentUrl
  if (ctx.tabId !== undefined) {
    // Like the engine, compare the decimal part of the host's tab id.
    const digits = ctx.tabId.replace(/^\D+/, '')
    out.tabId = /^\d+$/.test(digits) ? Number(digits) : -1
  }
  return out
}

export interface MatchedRule {
  ruleId: number
  rulesetId: string
}

/** A ruleset as the matcher sees it: compiled rules plus the ids `getMatchedRules` reports. */
export interface MatcherRuleset {
  /** Public id: the manifest ruleset id, `_dynamic` or `_session`. */
  id: string
  source: RulesetSource
  /** Static rulesets: position in `rule_resources`, which decides ties (see `rulesetRank`). */
  manifestIndex?: number
  rules: readonly CompiledRule[]
  /** Static rulesets: rules disabled with `updateStaticRules`. */
  disabledRuleIds?: ReadonlySet<number>
}

// ---------------------------------------------------------------------------------------------
// URL canonicalisation

interface ParsedUrl {
  url: URL
  spec: string
  lowerSpec: string
  hostBegin: number
  hostEnd: number
  host: string
}

function parseUrl(input: string): ParsedUrl | undefined {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return undefined
  }
  const spec = url.href
  let hostBegin = 0
  let hostEnd = 0
  if (url.hostname !== '' && spec.startsWith(`${url.protocol}//`)) {
    hostBegin = url.protocol.length + 2
    if (url.username !== '' || url.password !== '') {
      hostBegin += url.username.length + (url.password !== '' ? 1 + url.password.length : 0) + 1
    }
    hostEnd = hostBegin + url.hostname.length
  }
  return { url, spec, lowerSpec: spec.toLowerCase(), hostBegin, hostEnd, host: url.hostname }
}

/** `url::Origin::Create(GURL)`: the host of a URL, or undefined for opaque origins. */
function originHost(input: string | undefined): string | undefined {
  if (input === undefined) return undefined
  try {
    const url = new URL(input)
    if (url.protocol === 'data:' || (url.protocol === 'blob:' && url.origin === 'null')) {
      return undefined
    }
    return url.hostname === '' ? undefined : url.hostname
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------------------------
// urlFilter matching (url_pattern.cc)

/** `IsSeparator`: any ASCII character other than letters, digits, `_`, `-`, `.` and `%`. */
export function isSeparator(c: string): boolean {
  const code = c.charCodeAt(0)
  if (code > 0x7f) return false
  if (code >= 0x30 && code <= 0x39) return false
  if ((code | 0x20) >= 0x61 && (code | 0x20) <= 0x7a) return false
  return c !== '_' && c !== '-' && c !== '.' && c !== '%'
}

function fuzzyEqualsAt(text: string, position: number, subpattern: string): boolean {
  for (let i = 0; i < subpattern.length; i++) {
    const p = subpattern[i]!
    const t = text[position + i]!
    if (p === '^' ? !isSeparator(t) : p !== t) return false
  }
  return true
}

function startsWithFuzzy(text: string, subpattern: string): boolean {
  return text.length >= subpattern.length && fuzzyEqualsAt(text, 0, subpattern)
}

function endsWithFuzzy(text: string, subpattern: string): boolean {
  return (
    text.length >= subpattern.length &&
    fuzzyEqualsAt(text, text.length - subpattern.length, subpattern)
  )
}

function findFuzzy(text: string, subpattern: string, from = 0): number {
  if (!subpattern.includes('^')) return text.indexOf(subpattern, from)
  for (let position = from; position + subpattern.length <= text.length; position++) {
    if (fuzzyEqualsAt(text, position, subpattern)) return position
  }
  return -1
}

function isSubdomainAnchored(
  url: string,
  hostBegin: number,
  hostEnd: number,
  position: number
): boolean {
  return (
    position === hostBegin ||
    (position > hostBegin && position <= hostEnd && url[position - 1] === '.')
  )
}

function findSubdomainAnchoredSubpattern(
  url: string,
  hostBegin: number,
  hostEnd: number,
  subpattern: string
): number {
  const candidate = url.slice(0, hostEnd + subpattern.length)
  const urlHost = url.slice(0, hostEnd)
  for (let position = hostBegin; position <= hostEnd; position++) {
    position = findFuzzy(candidate, subpattern, position)
    if (position < 0 || isSubdomainAnchored(url, hostBegin, hostEnd, position)) return position
    position = urlHost.indexOf('.', position)
    if (position < 0) break
  }
  return -1
}

function matchesLastSubpatternInternal(
  anchorLeft: AnchorType,
  anchorRight: AnchorType,
  text: string,
  hostBegin: number,
  hostEnd: number,
  subpattern: string
): boolean {
  const hasHost = hostEnd > hostBegin
  if (anchorLeft === 'none' && anchorRight === 'none') return findFuzzy(text, subpattern) >= 0
  if (anchorLeft === 'none') return endsWithFuzzy(text, subpattern)
  if (anchorLeft === 'boundary' && anchorRight === 'none') return startsWithFuzzy(text, subpattern)
  if (anchorLeft === 'boundary') {
    return text.length === subpattern.length && startsWithFuzzy(text, subpattern)
  }
  if (anchorRight === 'none') {
    return hasHost && findSubdomainAnchoredSubpattern(text, hostBegin, hostEnd, subpattern) >= 0
  }
  return (
    hasHost &&
    text.length >= subpattern.length &&
    isSubdomainAnchored(text, hostBegin, hostEnd, text.length - subpattern.length) &&
    endsWithFuzzy(text, subpattern)
  )
}

function matchesLastSubpattern(
  anchorLeft: AnchorType,
  anchorRight: AnchorType,
  text: string,
  hostBegin: number,
  hostEnd: number,
  subpattern: string
): boolean {
  if (
    matchesLastSubpatternInternal(anchorLeft, anchorRight, text, hostBegin, hostEnd, subpattern)
  ) {
    return true
  }
  // A trailing separator placeholder also matches the end of the text.
  if (subpattern.endsWith('^')) {
    return matchesLastSubpatternInternal(
      anchorLeft,
      'boundary',
      text,
      hostBegin,
      hostEnd,
      subpattern.slice(0, -1)
    )
  }
  return false
}

/** `IsCaseSensitiveMatch`: match an already case-normalised pattern against a URL spec. */
function matchesPattern(
  pattern: string,
  anchorLeftIn: AnchorType,
  anchorRightIn: AnchorType,
  spec: string,
  hostBegin: number,
  hostEnd: number
): boolean {
  let anchorLeft = anchorLeftIn
  let anchorRight = anchorRightIn
  if (pattern !== '') {
    if (pattern.startsWith('*')) anchorLeft = 'none'
    if (pattern.endsWith('*')) anchorRight = 'none'
  }
  const subpatterns = pattern.split('*').filter((s) => s !== '')
  if (subpatterns.length === 0) return anchorLeft === 'none' || anchorRight === 'none'
  if (subpatterns.length === 1) {
    return matchesLastSubpattern(anchorLeft, anchorRight, spec, hostBegin, hostEnd, subpatterns[0]!)
  }

  let text = spec
  let first = 0
  if (anchorLeft === 'boundary') {
    if (!startsWithFuzzy(spec, subpatterns[0]!)) return false
    text = spec.slice(subpatterns[0]!.length)
    first = 1
  } else if (anchorLeft === 'subdomain') {
    if (hostEnd <= hostBegin) return false
    const begin = findSubdomainAnchoredSubpattern(spec, hostBegin, hostEnd, subpatterns[0]!)
    if (begin < 0) return false
    text = spec.slice(begin + subpatterns[0]!.length)
    first = 1
  }
  for (let i = first; i < subpatterns.length - 1; i++) {
    const position = findFuzzy(text, subpatterns[i]!)
    if (position < 0) return false
    text = text.slice(position + subpatterns[i]!.length)
  }
  return matchesLastSubpattern(
    'none',
    anchorRight,
    text,
    0,
    0,
    subpatterns[subpatterns.length - 1]!
  )
}

/**
 * Does `url` match a `urlFilter` as Chrome would? The filter uses Chrome's grammar: `*` for any
 * run of characters, `^` for a separator or the end of the URL, `|` anchors at the start or end,
 * `||` anchors at the start of a (sub)domain. Matching is case-insensitive unless requested.
 */
export function matchesUrlFilter(url: string, filter: string, caseSensitive = false): boolean {
  const result = compileRule(
    {
      id: 1,
      action: { type: 'block' },
      condition: { urlFilter: filter, isUrlFilterCaseSensitive: caseSensitive }
    },
    { source: 'static' }
  )
  if (!result.ok) return false
  const parsed = parseUrl(url)
  if (!parsed) return false
  return matchesUrlPattern(result.compiled, parsed)
}

function matchesUrlPattern(rule: CompiledRule, parsed: ParsedUrl): boolean {
  if (rule.urlPatternType === 'regexp') {
    return regexFor(rule).test(parsed.spec)
  }
  const spec = rule.isCaseSensitive ? parsed.spec : parsed.lowerSpec
  return matchesPattern(
    rule.urlPattern,
    rule.anchorLeft,
    rule.anchorRight,
    spec,
    parsed.hostBegin,
    parsed.hostEnd
  )
}

const regexCache = new WeakMap<CompiledRule, RegExp>()

function regexFor(rule: CompiledRule): RegExp {
  let regex = regexCache.get(rule)
  if (!regex) {
    regex = toJavaScriptRegExp(rule.urlPattern, rule.isCaseSensitive)
    regexCache.set(rule, regex)
  }
  return regex
}

// ---------------------------------------------------------------------------------------------
// Domain conditions (url_pattern_index.cc)

/** `url::DomainIs`: `host` equals `domain` or is a subdomain of it. */
export function domainIs(hostIn: string, domain: string): boolean {
  if (hostIn === '' || domain === '') return false
  let host = hostIn
  if (host.endsWith('.') && !domain.endsWith('.')) host = host.slice(0, -1)
  if (host.length < domain.length) return false
  if (!host.endsWith(domain)) return false
  if (!domain.startsWith('.') && host.length > domain.length) {
    return host[host.length - domain.length - 1] === '.'
  }
  return true
}

/** `CompareDomains`: longer domains first, then lexicographic, so the longest match is found first. */
export function compareDomains(left: string, right: string): number {
  if (left.length !== right.length) return left.length > right.length ? -1 : 1
  return left < right ? -1 : left > right ? 1 : 0
}

function longestMatchingDomain(hostIn: string, domains: readonly string[]): number {
  if (hostIn === '') return 0
  let host = hostIn
  while (host.length > 1 && host.endsWith('.')) host = host.slice(0, -1)
  let longest = 0
  for (const domain of domains) {
    if (domain.length > longest && domainIs(host, domain)) longest = domain.length
  }
  return longest
}

/**
 * `DoesHostMatchDomainLists`: with an included list the host must match one of its entries, and
 * the longest matching excluded entry must be shorter than the longest matching included entry.
 */
export function hostMatchesDomainLists(
  host: string,
  included: readonly string[],
  excluded: readonly string[]
): boolean {
  let longestIncluded = 1
  if (included.length > 0) longestIncluded = longestMatchingDomain(host, included)
  if (longestIncluded > 0 && excluded.length > 0) {
    return longestMatchingDomain(host, excluded) < longestIncluded
  }
  return longestIncluded > 0
}

// ---------------------------------------------------------------------------------------------
// First versus third party (approximate: registrable domain heuristic, not the PSL)

/**
 * Second-level suffixes under which registrations happen one label deeper; the common subset
 * of the Public Suffix List that matters for the sites extensions target. Anything else is
 * treated as a one-label suffix. Approximate by design.
 */
const SECOND_LEVEL_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'me.uk',
  'net.uk',
  'ltd.uk',
  'plc.uk',
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'co.nz',
  'net.nz',
  'org.nz',
  'co.jp',
  'ne.jp',
  'or.jp',
  'ac.jp',
  'go.jp',
  'co.kr',
  'or.kr',
  'co.in',
  'net.in',
  'org.in',
  'co.za',
  'org.za',
  'com.br',
  'net.br',
  'org.br',
  'com.mx',
  'com.ar',
  'com.cn',
  'net.cn',
  'org.cn',
  'com.tw',
  'com.hk',
  'com.sg',
  'com.tr',
  'com.ua',
  'com.pl',
  'co.il',
  'co.id',
  'com.my',
  'com.ph',
  'com.vn',
  'com.pk',
  'com.eg',
  'com.sa',
  'co.th',
  'github.io',
  'gitlab.io',
  'herokuapp.com',
  'appspot.com',
  'blogspot.com',
  'cloudfront.net',
  'azurewebsites.net',
  'web.app',
  'firebaseapp.com',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'workers.dev'
])

function isIpLiteral(host: string): boolean {
  return host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
}

/** The registrable domain (eTLD+1) of a host by heuristic; the host itself when it has none. */
export function registrableDomain(hostIn: string): string {
  const host = hostIn.toLowerCase().replace(/\.+$/, '')
  if (host === '' || isIpLiteral(host)) return host
  const labels = host.split('.')
  if (labels.length <= 2) return host
  const lastTwo = labels.slice(-2).join('.')
  const keep = SECOND_LEVEL_SUFFIXES.has(lastTwo) ? 3 : 2
  return labels.slice(-keep).join('.')
}

/** `IsThirdPartyRequest`: requests without a (non-opaque) initiator are third party. */
export function isThirdParty(url: ParsedUrl, initiatorHost: string | undefined): boolean {
  if (initiatorHost === undefined) return true
  return registrableDomain(url.host) !== registrableDomain(initiatorHost)
}

// ---------------------------------------------------------------------------------------------
// Request evaluation

interface EvaluatedRequest {
  url: ParsedUrl
  initiatorHost: string | undefined
  topHost: string
  elementType: number
  method: number
  isThirdParty: boolean
  tabId: number
  responseHeaders: Map<string, string[]> | undefined
}

function requestMethodMask(url: URL, method: string | undefined): number {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return REQUEST_METHOD_NON_HTTP
  const normalized = (method ?? 'get').toLowerCase()
  const known = ['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put']
  return requestMethodBit(known.includes(normalized) ? (normalized as RequestMethod) : 'other')
}

function evaluateRequest(request: MatchRequest): EvaluatedRequest | undefined {
  const url = parseUrl(request.url)
  if (!url) return undefined
  const initiatorHost = originHost(request.initiator)
  const topHost = originHost(request.topUrl) ?? initiatorHost ?? ''
  let responseHeaders: Map<string, string[]> | undefined
  if (request.responseHeaders) {
    responseHeaders = new Map()
    for (const [name, values] of Object.entries(request.responseHeaders)) {
      const key = name.toLowerCase()
      responseHeaders.set(key, [...(responseHeaders.get(key) ?? []), ...values])
    }
  }
  return {
    url,
    initiatorHost,
    topHost,
    elementType: elementTypeBit(request.type),
    method: requestMethodMask(url.url, request.method),
    isThirdParty: isThirdParty(url, initiatorHost),
    tabId: request.tabId ?? -1,
    responseHeaders
  }
}

/** `base::MatchPattern`: `*` matches any run, `?` zero or one character, `\` escapes. */
function matchesGlob(text: string, pattern: string): boolean {
  const memo = new Map<string, boolean>()
  const go = (ti: number, pi: number): boolean => {
    const key = `${ti},${pi}`
    const cached = memo.get(key)
    if (cached !== undefined) return cached
    let result: boolean
    if (pi === pattern.length) result = ti === text.length
    else {
      const p = pattern[pi]!
      if (p === '*') {
        result = false
        for (let skip = 0; ti + skip <= text.length && !result; skip++)
          result = go(ti + skip, pi + 1)
      } else if (p === '?') {
        result = go(ti, pi + 1) || (ti < text.length && go(ti + 1, pi + 1))
      } else {
        const literal = p === '\\' && pi + 1 < pattern.length ? pattern[pi + 1]! : p
        const next = p === '\\' && pi + 1 < pattern.length ? pi + 2 : pi + 1
        result = ti < text.length && text[ti] === literal && go(ti + 1, next)
      }
    }
    memo.set(key, result)
    return result
  }
  return go(0, 0)
}

function hasHeaderValue(headers: Map<string, string[]>, name: string, pattern: string): boolean {
  const values = headers.get(name.toLowerCase()) ?? []
  const lowered = pattern.toLowerCase()
  return values.some((value) => matchesGlob(value.toLowerCase(), lowered))
}

/** `MatchesHeaderConditions`: at least one condition matches. */
function matchesHeaderConditions(
  headers: Map<string, string[]>,
  conditions: readonly HeaderInfo[]
): boolean {
  for (const condition of conditions) {
    if (!headers.has(condition.header.toLowerCase())) continue
    if (condition.values === undefined && condition.excludedValues === undefined) return true
    const has = (value: string): boolean => hasHeaderValue(headers, condition.header, value)
    if (condition.excludedValues?.some(has)) continue
    if (condition.values === undefined || condition.values.some(has)) return true
  }
  return false
}

function hasResponseHeaderConditions(rule: CompiledRule): boolean {
  return rule.responseHeaders.length > 0 || rule.excludedResponseHeaders.length > 0
}

function isUpgradeable(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'ftp:'
}

/** Does one compiled rule match the request? Ignores the rule's action except for `upgradeScheme`. */
export function matchesRule(rule: CompiledRule, evaluated: EvaluatedRequest): boolean {
  if ((rule.elementTypes & evaluated.elementType) === 0) return false
  if ((rule.requestMethods & evaluated.method) === 0) return false
  if (rule.domainType === 'firstParty' && evaluated.isThirdParty) return false
  if (rule.domainType === 'thirdParty' && !evaluated.isThirdParty) return false
  if (rule.actionType === 'upgradeScheme' && !isUpgradeable(evaluated.url.url)) return false
  if (
    !hostMatchesDomainLists(evaluated.url.host, rule.requestDomains, rule.excludedRequestDomains)
  ) {
    return false
  }
  if (evaluated.initiatorHost === undefined) {
    // Opaque initiators only match generic rules (no included initiator domains).
    if (rule.initiatorDomains.length > 0) return false
  } else if (
    !hostMatchesDomainLists(
      evaluated.initiatorHost,
      rule.initiatorDomains,
      rule.excludedInitiatorDomains
    )
  ) {
    return false
  }
  if (rule.tabIds.size > 0 && !rule.tabIds.has(evaluated.tabId)) return false
  if (rule.excludedTabIds.has(evaluated.tabId)) return false
  if (!hostMatchesDomainLists(evaluated.topHost, rule.topDomains, rule.excludedTopDomains)) {
    return false
  }
  if (evaluated.responseHeaders) {
    if (
      rule.excludedResponseHeaders.length > 0 &&
      matchesHeaderConditions(evaluated.responseHeaders, rule.excludedResponseHeaders)
    ) {
      return false
    }
    if (
      rule.responseHeaders.length > 0 &&
      !matchesHeaderConditions(evaluated.responseHeaders, rule.responseHeaders)
    ) {
      return false
    }
  }
  return matchesUrlPattern(rule, evaluated.url)
}

// ---------------------------------------------------------------------------------------------
// Redirect targets (ruleset_matcher_base.cc)

/**
 * RE2's rewrite syntax after `regex` matched `url`: `\0` is the whole match, `\1` to `\9` the
 * capture groups (empty when the group did not take part), `\\` a backslash. Undefined when the
 * expression does not match.
 */
export function applyRegexSubstitution(
  regex: RegExp,
  url: string,
  substitution: string
): string | undefined {
  const match = regex.exec(url)
  if (!match) return undefined
  let out = ''
  for (let i = 0; i < substitution.length; i++) {
    const c = substitution[i]!
    if (c !== '\\' || i + 1 >= substitution.length) {
      out += c
      continue
    }
    const next = substitution[++i]!
    if (next >= '0' && next <= '9') out += match[Number(next)] ?? ''
    else out += next
  }
  return out
}

/** `base::EscapeQueryParamValue(value, use_plus = true)`, as applied to transform params. */
function escapeQueryParam(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, '+')
    .replace(/[!'()*]/g, (c) => {
      return `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    })
}

/**
 * `queryTransform`: drop `removeParams`, replace the first occurrence of each
 * `addOrReplaceParams` key, then append the keys that were missing unless `replaceOnly`.
 * Keys and values are compared and written in escaped form, as Chrome does.
 */
function applyQueryTransform(search: string, transform: QueryTransform): string {
  const remove = new Set((transform.removeParams ?? []).map(escapeQueryParam))
  const pending = new Map<string, { value: string; replaceOnly: boolean }>()
  for (const param of transform.addOrReplaceParams ?? []) {
    pending.set(escapeQueryParam(param.key), {
      value: escapeQueryParam(param.value),
      replaceOnly: param.replaceOnly === true
    })
  }
  const pieces: string[] = []
  const query = search.startsWith('?') ? search.slice(1) : search
  for (const piece of query.split('&')) {
    if (piece === '') continue
    const equals = piece.indexOf('=')
    const key = equals < 0 ? piece : piece.slice(0, equals)
    if (remove.has(key)) continue
    const replacement = pending.get(key)
    if (replacement) {
      pieces.push(`${key}=${replacement.value}`)
      pending.delete(key)
      continue
    }
    pieces.push(piece)
  }
  for (const [key, param] of pending) {
    if (!param.replaceOnly) pieces.push(`${key}=${param.value}`)
  }
  return pieces.length === 0 ? '' : `?${pieces.join('&')}`
}

/**
 * `GetRedirectURLFromTransform`: replace the components a `redirect.transform` names. An empty
 * `port`, `path`, `query` or `fragment` clears that component. Undefined when the result is not
 * a valid URL.
 */
export function applyUrlTransform(url: string, transform: URLTransform): string | undefined {
  const parsed = parseUrl(url)
  if (!parsed) return undefined
  const source = parsed.url
  const scheme = transform.scheme ?? source.protocol.slice(0, -1)
  const host = transform.host ?? source.hostname
  const port = transform.port ?? source.port
  const path = transform.path ?? source.pathname
  let query = source.search
  if (transform.query !== undefined) query = transform.query
  else if (transform.queryTransform)
    query = applyQueryTransform(source.search, transform.queryTransform)
  const fragment = transform.fragment ?? source.hash
  const username = transform.username ?? source.username
  const password = transform.password ?? source.password
  let authority = ''
  if (username !== '' || password !== '') {
    authority = `${username}${password === '' ? '' : `:${password}`}@`
  }
  if (host === '') return undefined
  const spec = `${scheme}://${authority}${host}${port === '' ? '' : `:${port}`}${path}${query}${fragment}`
  try {
    return new URL(spec).href
  } catch {
    return undefined
  }
}

/** `upgradeScheme`: http and ftp requests move to https, everything else stays. */
function upgradedUrl(url: URL): string | undefined {
  if (!isUpgradeable(url)) return undefined
  return `https:${url.href.slice(url.protocol.length)}`
}

/**
 * The URL a redirect rule sends the request to, or undefined when the rule cannot redirect it:
 * the substitution or transform produced an invalid URL, or the target is the request itself.
 */
export function redirectTargetFor(rule: CompiledRule, url: string): string | undefined {
  const parsed = parseUrl(url)
  if (!parsed) return undefined
  let target: string | undefined
  if (rule.redirectUrl !== undefined) target = rule.redirectUrl
  else if (rule.regexSubstitution !== undefined) {
    const substituted = applyRegexSubstitution(regexFor(rule), parsed.spec, rule.regexSubstitution)
    target = substituted === undefined ? undefined : parseUrl(substituted)?.spec
  } else if (rule.urlTransform !== undefined) {
    target = applyUrlTransform(parsed.spec, rule.urlTransform)
  }
  if (target === undefined || target === parsed.spec) return undefined
  return target
}

// ---------------------------------------------------------------------------------------------
// Precedence across an extension's rulesets

/**
 * Chromium's internal `RulesetID`, which breaks ties between rulesets whose winning rules have
 * equal priority and action type (`RequestAction::operator<` compares `index_priority`, then
 * `ruleset_id`, then `rule_id`; the greater wins). Static rulesets get ids from 1 in manifest
 * order (`kMinValidStaticRulesetID`), the dynamic ruleset is 0 (`kDynamicRulesetID`) and the
 * session ruleset -1 (`kSessionRulesetID`), so at a full tie a static rule beats a dynamic rule,
 * which beats a session rule.
 */
export function rulesetRank(source: RulesetSource, manifestIndex = 0): number {
  switch (source) {
    case 'static':
      return 1 + manifestIndex
    case 'dynamic':
      return 0
    case 'session':
      return -1
  }
}

export interface RuleMatch {
  rule: CompiledRule
  ruleset: MatcherRuleset
  /** `redirect` and `upgradeScheme` rules: where the request goes. */
  redirectUrl?: string
}

/** Chrome's `RequestAction` ordering: index priority, then ruleset, then rule id; higher wins. */
export function compareMatches(a: RuleMatch, b: RuleMatch): number {
  if (a.rule.indexPriority !== b.rule.indexPriority) {
    return a.rule.indexPriority - b.rule.indexPriority
  }
  const rank =
    rulesetRank(a.ruleset.source, a.ruleset.manifestIndex) -
    rulesetRank(b.ruleset.source, b.ruleset.manifestIndex)
  if (rank !== 0) return rank
  return a.rule.id - b.rule.id
}

function isAllow(match: RuleMatch): boolean {
  return match.rule.actionType === 'allow' || match.rule.actionType === 'allowAllRequests'
}

function isIntercepting(match: RuleMatch): boolean {
  const type = match.rule.actionType
  return type === 'block' || type === 'redirect' || type === 'upgradeScheme'
}

interface StageResult {
  /** Highest priority allow action seen so far (carried into the next stage). */
  maxAllow: RuleMatch | undefined
  actions: RuleMatch[]
}

/**
 * `CompositeMatcher::GetAction` + `GetModifyHeadersActions` for one stage, mirroring
 * `DeclarativeNetRequestTestMatchOutcomeFunction::GetActions`: either no action, one action of
 * any type, or a list of modifyHeaders actions above the winning allow rule.
 */
function evaluateStage(
  rulesets: readonly MatcherRuleset[],
  evaluated: EvaluatedRequest,
  headersStage: boolean,
  previousAllow: RuleMatch | undefined
): StageResult {
  let final = previousAllow
  let maxAllow = previousAllow
  const modifyHeaders: RuleMatch[] = []
  for (const ruleset of rulesets) {
    let best: RuleMatch | undefined
    for (const rule of ruleset.rules) {
      if (hasResponseHeaderConditions(rule) !== headersStage) continue
      if (ruleset.disabledRuleIds?.has(rule.id)) continue
      if (!matchesRule(rule, evaluated)) continue
      const match: RuleMatch = { rule, ruleset }
      if (rule.actionType === 'modifyHeaders') {
        modifyHeaders.push(match)
        continue
      }
      if (rule.actionType === 'redirect') {
        const target = redirectTargetFor(rule, evaluated.url.spec)
        if (target === undefined) continue
        match.redirectUrl = target
      } else if (rule.actionType === 'upgradeScheme') {
        match.redirectUrl = upgradedUrl(evaluated.url.url)
      }
      if (!best || compareMatches(match, best) > 0) best = match
    }
    if (!best) continue
    if (maxAllow && best.rule.indexPriority <= maxAllow.rule.indexPriority) continue
    if (isAllow(best)) maxAllow = best
    if (!final || compareMatches(best, final) > 0) final = best
  }

  if (final && !isAllow(final)) return { maxAllow, actions: [final] }

  const minPriority = maxAllow?.rule.indexPriority ?? 0
  const applicable = modifyHeaders
    .filter((match) => match.rule.indexPriority > minPriority)
    .sort((a, b) => compareMatches(b, a))
  if (applicable.length > 0) return { maxAllow, actions: applicable }
  return { maxAllow, actions: final ? [final] : [] }
}

export interface MatchOutcome {
  /** Rules that decide the request, in the order `testMatchOutcome` reports them. */
  matches: RuleMatch[]
  matchedRules: MatchedRule[]
}

/**
 * Evaluate a request against an extension's rulesets the way `testMatchOutcome` does: the
 * before-request stage first, then (when response headers are given) the headers-received stage,
 * merged as Chrome merges them. Returns undefined when the request URL is invalid.
 */
export function matchRequest(
  rulesets: readonly MatcherRuleset[],
  request: MatchRequest
): MatchOutcome | undefined {
  const evaluated = evaluateRequest(request)
  if (!evaluated) return undefined
  const before = evaluateStage(rulesets, evaluated, false, undefined)
  let actions: RuleMatch[]
  if (!evaluated.responseHeaders || (before.actions[0] && isIntercepting(before.actions[0]))) {
    actions = before.actions
  } else {
    const headers = evaluateStage(rulesets, evaluated, true, before.maxAllow)
    const headersAllowPriority =
      headers.actions[0] && isAllow(headers.actions[0]) ? headers.actions[0].rule.indexPriority : 0
    const beforeActions = before.actions.filter(
      (match) => match.rule.indexPriority >= headersAllowPriority
    )
    if (beforeActions.length === 0 || (headers.actions[0] && isIntercepting(headers.actions[0]))) {
      actions = headers.actions
    } else if (headers.actions.length === 0) {
      actions = beforeActions
    } else if (isAllow(beforeActions[0]!)) {
      actions = headers.actions
    } else if (isAllow(headers.actions[0]!)) {
      actions = beforeActions
    } else {
      actions = [...beforeActions, ...headers.actions].sort((a, b) => compareMatches(b, a))
    }
  }
  return {
    matches: actions,
    matchedRules: actions.map((match) => ({ ruleId: match.rule.id, rulesetId: match.ruleset.id }))
  }
}

/** Public ruleset id for a source, as `getMatchedRules` and `testMatchOutcome` report it. */
export function publicRulesetId(source: RulesetSource, staticId?: string): string {
  if (source === 'dynamic') return DYNAMIC_RULESET_ID
  if (source === 'session') return SESSION_RULESET_ID
  return staticId ?? ''
}

function engineSetKindOf(ruleset: MatcherRuleset): EngineSetKind {
  switch (ruleset.source) {
    case 'static':
      return { kind: 'static', rulesetId: ruleset.id }
    case 'dynamic':
      return { kind: 'dynamic' }
    case 'session':
      return { kind: 'session' }
  }
}

function headerOps(ops: CompiledRule['requestHeadersToModify']): EngineHeaderOp[] {
  return ops.map((op) =>
    op.value === undefined
      ? { header: op.header, operation: op.operation }
      : { header: op.header, operation: op.operation, value: op.value }
  )
}

/**
 * An outcome as the engine would report it for the same extension: `matched.setId` is the
 * engine set id when `extensionId` is given (`engineSetId`), the public ruleset id otherwise.
 * No matching rule is the engine's default allow without `matched`.
 */
export function decisionOf(outcome: MatchOutcome, extensionId?: string): EngineDecision {
  const first = outcome.matches[0]
  if (!first) return { action: 'allow' }
  const setIdOf = (ruleset: MatcherRuleset): string =>
    extensionId === undefined ? ruleset.id : engineSetId(extensionId, engineSetKindOf(ruleset))
  const matched = { setId: setIdOf(first.ruleset), ruleId: first.rule.id }
  switch (first.rule.actionType) {
    case 'allow':
    case 'allowAllRequests':
      return { action: 'allow', matched }
    case 'block':
      return { action: 'block', matched }
    case 'upgradeScheme':
      return first.redirectUrl === undefined
        ? { action: 'allow', matched }
        : { action: 'upgrade', redirectUrl: first.redirectUrl, matched }
    case 'redirect':
      return first.redirectUrl === undefined
        ? { action: 'allow', matched }
        : { action: 'redirect', redirectUrl: first.redirectUrl, matched }
    case 'modifyHeaders': {
      const requestHeaders: EngineHeaderOp[] = []
      const responseHeaders: EngineHeaderOp[] = []
      for (const match of outcome.matches) {
        if (match.rule.actionType !== 'modifyHeaders') continue
        requestHeaders.push(...headerOps(match.rule.requestHeadersToModify))
        responseHeaders.push(...headerOps(match.rule.responseHeadersToModify))
      }
      return { action: 'modifyHeaders', requestHeaders, responseHeaders, matched }
    }
  }
}
