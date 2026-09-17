/**
 * declarativeNetRequest: the rule model, the translation from Chrome's rule JSON and a reference
 * matcher. The host that sits on the network path (Kotlin's `shouldInterceptRequest`, later the
 * shared request-blocking engine) consumes `NetRule[]` and answers per request; this module is
 * the single definition of what a rule means, so the engines only have to agree with these tests.
 */
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

export type RuleActionType =
  'block' | 'allow' | 'allowAllRequests' | 'upgradeScheme' | 'redirect' | 'modifyHeaders'

export interface NetRule {
  id: number
  priority: number
  action: RuleActionType
  /** `redirect.url` / `redirect.extensionPath` (already absolute on the extension origin) when redirecting. */
  redirectUrl: string | null
  urlFilter: string | null
  regexFilter: string | null
  caseSensitive: boolean
  requestDomains: string[]
  excludedRequestDomains: string[]
  initiatorDomains: string[]
  excludedInitiatorDomains: string[]
  resourceTypes: ResourceType[]
  excludedResourceTypes: ResourceType[]
  requestMethods: string[]
  excludedRequestMethods: string[]
  domainType: 'firstParty' | 'thirdParty' | null
}

export interface NetRequest {
  url: string
  /** Origin URL of the frame that issued the request (null for main-frame navigations). */
  initiator: string | null
  type: ResourceType
  method: string
}

export type NetDecision =
  { action: 'allow' | 'block' | 'upgradeScheme' } | { action: 'redirect'; url: string }

const RESOURCE_TYPES: ResourceType[] = [
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function resourceTypes(value: unknown): ResourceType[] {
  return strings(value).filter((t): t is ResourceType => (RESOURCE_TYPES as string[]).includes(t))
}

/** Translate one Chrome rule (`declarativeNetRequest.Rule`) into the shared model; null when malformed. */
export function normalizeRule(raw: unknown, extensionOrigin: string): NetRule | null {
  if (
    !isRecord(raw) ||
    typeof raw.id !== 'number' ||
    !isRecord(raw.action) ||
    !isRecord(raw.condition)
  )
    return null
  const type = raw.action.type
  if (
    typeof type !== 'string' ||
    !['block', 'allow', 'allowAllRequests', 'upgradeScheme', 'redirect', 'modifyHeaders'].includes(
      type
    )
  )
    return null
  const condition = raw.condition
  let redirectUrl: string | null = null
  if (type === 'redirect' && isRecord(raw.action.redirect)) {
    const redirect = raw.action.redirect
    if (typeof redirect.url === 'string') redirectUrl = redirect.url
    else if (typeof redirect.extensionPath === 'string')
      redirectUrl = extensionOrigin + redirect.extensionPath
    // `transform` and `regexSubstitution` are not modelled yet.
  }
  return {
    id: raw.id,
    priority: typeof raw.priority === 'number' ? raw.priority : 1,
    action: type as RuleActionType,
    redirectUrl,
    urlFilter: typeof condition.urlFilter === 'string' ? condition.urlFilter : null,
    regexFilter: typeof condition.regexFilter === 'string' ? condition.regexFilter : null,
    caseSensitive: condition.isUrlFilterCaseSensitive === true,
    requestDomains: strings(condition.requestDomains).map((d) => d.toLowerCase()),
    excludedRequestDomains: strings(condition.excludedRequestDomains).map((d) => d.toLowerCase()),
    initiatorDomains: strings(condition.initiatorDomains ?? condition.domains).map((d) =>
      d.toLowerCase()
    ),
    excludedInitiatorDomains: strings(
      condition.excludedInitiatorDomains ?? condition.excludedDomains
    ).map((d) => d.toLowerCase()),
    resourceTypes: resourceTypes(condition.resourceTypes),
    excludedResourceTypes: resourceTypes(condition.excludedResourceTypes),
    requestMethods: strings(condition.requestMethods).map((m) => m.toLowerCase()),
    excludedRequestMethods: strings(condition.excludedRequestMethods).map((m) => m.toLowerCase()),
    domainType:
      condition.domainType === 'firstParty' || condition.domainType === 'thirdParty'
        ? condition.domainType
        : null
  }
}

/** A whole ruleset file (`[Rule, ...]`); malformed entries are skipped. */
export function normalizeRuleset(raw: unknown, extensionOrigin: string): NetRule[] {
  if (!Array.isArray(raw)) return []
  const out: NetRule[] = []
  for (const entry of raw) {
    const rule = normalizeRule(entry, extensionOrigin)
    if (rule) out.push(rule)
  }
  return out
}

/**
 * Chrome's `urlFilter` syntax → RegExp: `*` any run, `^` a separator (anything but
 * letters, digits, `_ - . %`, or the end), `||` the start of a (sub)domain, `|` the start or the
 * end of the URL.
 */
export function urlFilterToRegExp(filter: string, caseSensitive: boolean): RegExp {
  let source = ''
  let body = filter
  let anchoredStart = false
  let anchoredEnd = false
  if (body.startsWith('||')) {
    source += '^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^/?#]*\\.)?'
    body = body.slice(2)
  } else if (body.startsWith('|')) {
    anchoredStart = true
    body = body.slice(1)
  }
  if (body.endsWith('|')) {
    anchoredEnd = true
    body = body.slice(0, -1)
  }
  if (anchoredStart) source += '^'
  for (const ch of body) {
    if (ch === '*') source += '.*'
    else if (ch === '^') source += '(?:[^a-zA-Z0-9_\\-.%]|$)'
    else source += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  }
  if (anchoredEnd) source += '$'
  return new RegExp(source, caseSensitive ? '' : 'i')
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** `host` is `domain` or a subdomain of it. */
export function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith('.' + domain)
}

function anyDomainMatches(host: string, domains: string[]): boolean {
  return domains.some((d) => domainMatches(host, d))
}

/** Approximate registrable domain: the last two labels (good enough for first/third-party checks). */
export function registrableDomain(host: string): string {
  const labels = host.split('.')
  return labels.length <= 2 ? host : labels.slice(-2).join('.')
}

/** Whether `rule`'s condition matches `request`, following declarativeNetRequest semantics. */
export function ruleMatches(rule: NetRule, request: NetRequest): boolean {
  if (rule.resourceTypes.length > 0) {
    if (!rule.resourceTypes.includes(request.type)) return false
  } else if (rule.excludedResourceTypes.length > 0) {
    if (rule.excludedResourceTypes.includes(request.type)) return false
  } else if (request.type === 'main_frame') {
    // Rules without a resource type filter never match main-frame navigations.
    return false
  }
  const method = request.method.toLowerCase()
  if (rule.requestMethods.length > 0 && !rule.requestMethods.includes(method)) return false
  if (rule.excludedRequestMethods.includes(method)) return false
  const host = hostOf(request.url)
  if (rule.requestDomains.length > 0 && !anyDomainMatches(host, rule.requestDomains)) return false
  if (rule.excludedRequestDomains.length > 0 && anyDomainMatches(host, rule.excludedRequestDomains))
    return false
  const initiatorHost = request.initiator ? hostOf(request.initiator) : ''
  if (rule.initiatorDomains.length > 0 && !anyDomainMatches(initiatorHost, rule.initiatorDomains))
    return false
  if (
    rule.excludedInitiatorDomains.length > 0 &&
    anyDomainMatches(initiatorHost, rule.excludedInitiatorDomains)
  )
    return false
  if (rule.domainType) {
    const firstParty =
      initiatorHost !== '' && registrableDomain(initiatorHost) === registrableDomain(host)
    if (rule.domainType === 'firstParty' && !firstParty) return false
    if (rule.domainType === 'thirdParty' && firstParty) return false
  }
  if (
    rule.urlFilter !== null &&
    !urlFilterToRegExp(rule.urlFilter, rule.caseSensitive).test(request.url)
  )
    return false
  if (rule.regexFilter !== null) {
    try {
      if (!new RegExp(rule.regexFilter, rule.caseSensitive ? '' : 'i').test(request.url))
        return false
    } catch {
      return false
    }
  }
  return true
}

const ACTION_RANK: Record<RuleActionType, number> = {
  allow: 5,
  allowAllRequests: 4,
  block: 3,
  upgradeScheme: 2,
  redirect: 1,
  modifyHeaders: 0
}

/**
 * The decision for one request across the rules of one extension: the matching rule with the
 * highest priority wins, ties broken by action precedence (allow > allowAllRequests > block >
 * upgradeScheme > redirect). `modifyHeaders` rules never decide the outcome here.
 */
export function decide(rules: NetRule[], request: NetRequest): NetDecision | null {
  let best: NetRule | null = null
  for (const rule of rules) {
    if (rule.action === 'modifyHeaders') continue
    if (!ruleMatches(rule, request)) continue
    if (
      !best ||
      rule.priority > best.priority ||
      (rule.priority === best.priority && ACTION_RANK[rule.action] > ACTION_RANK[best.action])
    )
      best = rule
  }
  if (!best) return null
  switch (best.action) {
    case 'allow':
    case 'allowAllRequests':
      return { action: 'allow' }
    case 'block':
      return { action: 'block' }
    case 'upgradeScheme':
      return { action: 'upgradeScheme' }
    case 'redirect':
      return best.redirectUrl ? { action: 'redirect', url: best.redirectUrl } : null
    case 'modifyHeaders':
      return null
  }
}

/** Map a `WebResourceRequest`-level guess of the resource type from URL and headers. */
export function guessResourceType(
  url: string,
  accept: string | null,
  isMainFrame: boolean,
  isSubFrame: boolean
): ResourceType {
  if (isMainFrame) return 'main_frame'
  if (isSubFrame) return 'sub_frame'
  const a = (accept ?? '').toLowerCase()
  if (a.startsWith('text/css')) return 'stylesheet'
  if (a.startsWith('image/')) return 'image'
  if (a.includes('video/') || a.includes('audio/')) return 'media'
  if (a.includes('font') || /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(url)) return 'font'
  if (/\.(js|mjs)(\?|$)/i.test(url)) return 'script'
  if (/\.(css)(\?|$)/i.test(url)) return 'stylesheet'
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)(\?|$)/i.test(url)) return 'image'
  if (/\.(mp4|webm|m4s|mp3|ogg|m3u8|ts)(\?|$)/i.test(url)) return 'media'
  if (a === '*/*' || a.includes('application/json')) return 'xmlhttprequest'
  return 'other'
}
