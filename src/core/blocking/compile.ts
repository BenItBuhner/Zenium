/**
 * Structured (declarativeNetRequest-shaped) rules → ABP / uBlock Origin filter text, for
 * matchers that only take text. The mapping is lossy where the two languages differ; every rule
 * that cannot be expressed faithfully is reported so the caller can keep it on the structured
 * path (which `RuleEngine` evaluates natively) or drop it knowingly.
 */
import type { ResourceType, Rule, RuleSet } from './rules'

export interface UnsupportedRule {
  ruleId: number
  reason: string
}

export interface CompiledFilters {
  /** One ABP filter per line; a rule with several `requestDomains` expands to several lines. */
  filterText: string
  /** Rules (or parts of rules) the filter syntax cannot carry. */
  unsupported: UnsupportedRule[]
}

/** DNR resource types → ABP type options. Types without an ABP equivalent are absent. */
const TYPE_OPTION: Partial<Record<ResourceType, string>> = {
  main_frame: 'document',
  sub_frame: 'subdocument',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xmlhttprequest: 'xmlhttprequest',
  ping: 'ping',
  media: 'media',
  websocket: 'websocket',
  other: 'other',
  csp_report: 'other'
}

function domainList(list: string[] | undefined, negate: boolean): string[] {
  return (list ?? []).map((d) => `${negate ? '~' : ''}${d.toLowerCase()}`)
}

/** Compile one rule; returns the filter lines and the reasons it could not be compiled (if any). */
export function compileRule(rule: Rule): { filters: string[]; unsupported: string[] } {
  const unsupported: string[] = []
  const c = rule.condition ?? {}
  const a = rule.action
  const options: string[] = []
  let prefix = ''

  switch (a.type) {
    case 'block':
      break
    case 'allow':
      prefix = '@@'
      break
    case 'allowAllRequests':
      prefix = '@@'
      // An allowAllRequests rule matches the frame request and whitelists everything under it,
      // which is what `$document` does for exception filters.
      if (!c.resourceTypes || c.resourceTypes.some((t) => t === 'main_frame'))
        options.push('document')
      if (c.resourceTypes?.some((t) => t === 'sub_frame')) options.push('subdocument')
      break
    case 'upgradeScheme':
      return { filters: [], unsupported: ['upgradeScheme has no filter-text equivalent'] }
    case 'redirect':
      return {
        filters: [],
        unsupported: [
          'redirect to an arbitrary URL has no filter-text equivalent ($redirect= names a bundled resource)'
        ]
      }
    case 'modifyHeaders':
      return { filters: [], unsupported: ['modifyHeaders has no filter-text equivalent'] }
    default:
      return {
        filters: [],
        unsupported: [`unknown action ${String((a as { type: unknown }).type)}`]
      }
  }

  if (a.type !== 'allowAllRequests') {
    if (c.resourceTypes && c.resourceTypes.length > 0) {
      const mapped = new Set<string>()
      for (const t of c.resourceTypes) {
        const opt = TYPE_OPTION[t]
        if (opt) mapped.add(opt)
        else
          unsupported.push(
            `resource type ${t} is not expressible; the filter is narrower than the rule`
          )
      }
      if (mapped.size === 0)
        return { filters: [], unsupported: [...unsupported, 'no expressible resource types'] }
      options.push(...mapped)
    }
    if (c.excludedResourceTypes && c.excludedResourceTypes.length > 0) {
      for (const t of c.excludedResourceTypes) {
        const opt = TYPE_OPTION[t]
        if (opt) options.push(`~${opt}`)
      }
    }
  }

  if (c.domainType === 'thirdParty') options.push('third-party')
  else if (c.domainType === 'firstParty') options.push('~third-party')

  const initiators = [
    ...domainList(c.initiatorDomains, false),
    ...domainList(c.excludedInitiatorDomains, true)
  ]
  if (initiators.length > 0) options.push(`domain=${initiators.join('|')}`)

  if (c.requestMethods && c.requestMethods.length > 0)
    options.push(`method=${c.requestMethods.map((m) => m.toLowerCase()).join('|')}`)
  if (c.excludedRequestMethods && c.excludedRequestMethods.length > 0)
    options.push(`method=${c.excludedRequestMethods.map((m) => `~${m.toLowerCase()}`).join('|')}`)

  if (c.isUrlFilterCaseSensitive) options.push('match-case')
  if (c.tabIds || c.excludedTabIds)
    unsupported.push('tabIds cannot be expressed; the filter applies to every tab')
  if (c.excludedRequestDomains && c.excludedRequestDomains.length > 0)
    unsupported.push(
      'excludedRequestDomains cannot be expressed; the filter is broader than the rule'
    )
  if (
    (c.topDomains && c.topDomains.length > 0) ||
    (c.excludedTopDomains && c.excludedTopDomains.length > 0)
  )
    unsupported.push('topDomains cannot be expressed; the filter is broader than the rule')
  if (
    (c.responseHeaders && c.responseHeaders.length > 0) ||
    (c.excludedResponseHeaders && c.excludedResponseHeaders.length > 0)
  )
    unsupported.push(
      'response header conditions cannot be expressed; the filter is broader than the rule'
    )
  if (c.excludedNonUniqueHosts)
    unsupported.push(
      'excludedNonUniqueHosts cannot be expressed; the filter is broader than the rule'
    )
  if ((rule.priority ?? 1) > 1)
    unsupported.push('rule priority is flattened (filter text has none)')

  let patterns: string[]
  if (c.regexFilter !== undefined) {
    patterns = [`/${c.regexFilter}/`]
    if (c.requestDomains && c.requestDomains.length > 0)
      unsupported.push(
        'requestDomains with regexFilter cannot be expressed; the filter is broader than the rule'
      )
  } else if (c.urlFilter) {
    patterns = [c.urlFilter]
    if (c.requestDomains && c.requestDomains.length > 0)
      unsupported.push(
        'requestDomains with urlFilter cannot be expressed; the filter is broader than the rule'
      )
  } else if (c.requestDomains && c.requestDomains.length > 0) {
    patterns = c.requestDomains.map((d) => `||${d.toLowerCase()}^`)
  } else {
    patterns = ['*']
  }

  const suffix = options.length > 0 ? `$${options.join(',')}` : ''
  return { filters: patterns.map((p) => `${prefix}${p}${suffix}`), unsupported }
}

/** Compile every structured rule of a set (its `filterText`, if any, is passed through first). */
export function compileRuleSet(set: RuleSet): CompiledFilters {
  const lines: string[] = []
  const unsupported: UnsupportedRule[] = []
  if (set.filterText) lines.push(set.filterText.replace(/\r\n?/g, '\n').replace(/\n+$/, ''))
  for (const rule of set.rules ?? []) {
    const result = compileRule(rule)
    lines.push(...result.filters)
    for (const reason of result.unsupported) unsupported.push({ ruleId: rule.id, reason })
  }
  return { filterText: lines.join('\n'), unsupported }
}
