/**
 * The per-site content rules the hosts enforce at the load path, as one document the core
 * pushes (`TabViewHost.setContentRules`) and a pure resolver both hosts read it with: the
 * Android host mirrors it in Kotlin (`ContentRules.kt`, the twin of this file) as the FALLBACK
 * for a navigation the core could not be asked about; the desktop asks the core directly (the
 * core is in its process) and reads this only for the page-world guards.
 *
 * The decision itself is the core's (`PermissionService.resolve`: an extension's rule over the
 * user's answers over the defaults). The pushed document holds only what the store knows –
 * the defaults and the sites – and can never carry an extension's rule, which is a function of
 * the URL; so the Android host asks the core per navigation (`ContentRulesService.resolveAll`)
 * and gets every row's effective answer at once (`ResolvedContentRules`), reads that first, and
 * falls back to this document where no answer could be had (`ContentRules.kt`).
 *
 * Only the rows whose answer a host needs synchronously per navigation or per document are in
 * it. The rows the request engine or the downloads service enforce (`pdf`, `automatic-downloads`,
 * `on-device-site-data`) ask the core as they go.
 */
import { FILE_SITE, type ContentDecision } from './contentSettings'

/** The rows the document carries, in the catalogue's order. */
export const CONTENT_RULE_IDS = [
  'images',
  'javascript',
  'insecure-content',
  'sensors',
  'third-party-sign-in',
  'payment-handler'
] as const

export type ContentRuleId = (typeof CONTENT_RULE_IDS)[number]

/**
 * The rows a page-world guard enforces (`contentGuards.ts`): the engine of neither host has a
 * switch for them, so a blocked site's document gets the API refused at document start.
 */
export const GUARDED_CONTENT_RULES: readonly ContentRuleId[] = [
  'sensors',
  'third-party-sign-in',
  'payment-handler'
]

export interface ContentRule {
  /** What sites without a decision of their own get (the user's default, else the catalogue's). */
  default: ContentDecision
  /** The sites with an answer of their own, keyed by permission origin (`https://example.com`). */
  sites: Record<string, ContentDecision>
}

export type ContentRules = Record<ContentRuleId, ContentRule>

export const EMPTY_CONTENT_RULES: ContentRules = {
  images: { default: 'allow', sites: {} },
  javascript: { default: 'allow', sites: {} },
  'insecure-content': { default: 'deny', sites: {} },
  sensors: { default: 'allow', sites: {} },
  'third-party-sign-in': { default: 'allow', sites: {} },
  'payment-handler': { default: 'allow', sites: {} }
}

export function isContentRuleId(id: string): id is ContentRuleId {
  return (CONTENT_RULE_IDS as readonly string[]).includes(id)
}

/**
 * The site a page's rules are read for: its origin, `file://` for every local file (as the
 * permission store keys them, `permissionSite`), null for a page without one (`zen://`,
 * `about:blank`, `data:`), which gets the row's default and is never remembered.
 */
export function contentRuleSite(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') return FILE_SITE
    return parsed.origin && parsed.origin !== 'null' ? parsed.origin : null
  } catch {
    return null
  }
}

/**
 * The decision for `id` at `url`: the site's own, else the row's default. One map lookup by
 * origin – what a host pays per navigation (and the desktop's request handlers per request).
 */
export function contentRuleFor(
  rules: ContentRules,
  id: ContentRuleId,
  url: string
): ContentDecision {
  const rule = rules[id]
  if (!rule) return EMPTY_CONTENT_RULES[id].default
  const site = contentRuleSite(url)
  return (site && rule.sites[site]) || rule.default
}

/** Whether `id` is allowed at `url` – the reading every enforcement point makes. */
export function contentAllowed(rules: ContentRules, id: ContentRuleId, url: string): boolean {
  return contentRuleFor(rules, id, url) === 'allow'
}

/**
 * The guarded rows a document at `url` is refused, for `installContentGuards`. A page without a
 * site (`zen://`, `about:blank`) is refused nothing but what the row's default refuses.
 */
export function blockedGuardsFor(rules: ContentRules, url: string): ContentRuleId[] {
  return GUARDED_CONTENT_RULES.filter((id) => !contentAllowed(rules, id, url))
}

/**
 * The core's answer for one page, every row's effective decision at its URL
 * (`ContentRulesService.resolveAll`; true = allowed): what the Android host asks for per
 * navigation and remembers by site until the rules change.
 */
export type ResolvedContentRules = Record<ContentRuleId, boolean>

/**
 * A resolved answer as a document-start script gets it (`window.__zenResolvedRules`), tagged
 * with the site it was resolved for: the start script is registered per navigation, and a
 * document the navigation did not announce (a form's POST, a history step) must not read the
 * previous site's answer – it falls back to the pushed rules.
 */
export interface ResolvedContentRulesFor {
  site: string
  allowed: Partial<ResolvedContentRules>
}

/**
 * The guarded rows a document at `url` is refused, the resolved answer first: a row the core
 * answered for this document's own site decides; any other row (an answer for another site,
 * a row missing from it, no answer at all) is read from the pushed rules, as `blockedGuardsFor`.
 */
export function blockedGuardsWith(
  rules: ContentRules,
  resolved: ResolvedContentRulesFor | null | undefined,
  url: string
): ContentRuleId[] {
  const site = contentRuleSite(url)
  const answer =
    resolved && site && resolved.site === site && isRecord(resolved.allowed)
      ? resolved.allowed
      : null
  return GUARDED_CONTENT_RULES.filter((id) => {
    const value = answer ? answer[id] : undefined
    return typeof value === 'boolean' ? !value : !contentAllowed(rules, id, url)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Read a pushed or mirrored document back into shape (anything malformed gets the defaults). */
export function sanitizeContentRules(input: unknown): ContentRules {
  const raw = (input ?? {}) as Record<string, unknown>
  const out = { ...EMPTY_CONTENT_RULES }
  for (const id of CONTENT_RULE_IDS) {
    const rule = raw[id] as { default?: unknown; sites?: unknown } | undefined
    const fallback = EMPTY_CONTENT_RULES[id]
    const sites: Record<string, ContentDecision> = {}
    if (rule && typeof rule.sites === 'object' && rule.sites !== null)
      for (const [site, decision] of Object.entries(rule.sites as Record<string, unknown>))
        if (isDecision(decision) && site) sites[site] = decision
    out[id] = {
      default: rule && isDecision(rule.default) ? rule.default : fallback.default,
      sites
    }
  }
  return out
}

function isDecision(value: unknown): value is ContentDecision {
  return value === 'allow' || value === 'deny'
}
